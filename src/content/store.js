/* Data orchestration.

   The hybrid strategy, in order:
     1. One recursive tree request gives every file's byte size  -> estimate
        lines per file and paint immediately.
     2. Read the repo's .gitattributes and drop linguist-generated/vendored
        files, then repaint.
     3. Probe the cache in bulk for exact counts we already know, repaint.
     4. Fetch the remaining blobs (bounded, largest-first) and replace estimates
        with real counts as they land, learning the repo's real bytes-per-line
        ratio so that the still-estimated files converge too. */
(function (GHL) {
  'use strict';

  const { util, patterns } = GHL;

  const CACHE_PROBE_LIMIT = 5000;

  /* Conditions where continuing would just produce more failures — and, for the
     rate-limit ones, would be exactly the behaviour GitHub asks clients not to
     exhibit. Abandon the remaining queue and report it. */
  const FATAL_ERRORS = new Set([
    'rate_limit',
    'secondary_rate_limit',
    'throttled',
    'bad_token',
  ]);

  function makeDir(name, path) {
    return { name, path, type: 'dir', children: new Map(), size: 0 };
  }

  function buildTree(entries) {
    const root = makeDir('', '');
    const index = new Map([['', root]]);

    function ensureDir(path) {
      let node = index.get(path);
      if (node) return node;
      const slash = path.lastIndexOf('/');
      const parent = ensureDir(slash === -1 ? '' : path.slice(0, slash));
      node = makeDir(path.slice(slash + 1), path);
      parent.children.set(node.name, node);
      index.set(path, node);
      return node;
    }

    for (const e of entries) {
      if (e.type === 'dir') { ensureDir(e.path); continue; }
      const slash = e.path.lastIndexOf('/');
      const parent = ensureDir(slash === -1 ? '' : e.path.slice(0, slash));
      const leaf = {
        name: e.path.slice(slash + 1),
        path: e.path,
        type: 'file',
        size: e.size || 0,
        sha: e.sha,
        lines: 0,
        exact: false,
        excluded: false,
        binary: false,
      };
      parent.children.set(leaf.name, leaf);
      index.set(leaf.path, leaf);
    }

    return { root, index };
  }

  function classify(index, isExcluded, isLinguist) {
    for (const node of index.values()) {
      if (node.type !== 'file') continue;
      node.binary = patterns.isBinary(node.path);
      node.excluded = node.binary || isExcluded(node.path) || isLinguist(node.path);
    }
  }

  function applyEstimates(index, learner) {
    for (const node of index.values()) {
      if (node.type !== 'file' || node.exact) continue;
      node.lines = node.excluded ? 0 : learner.estimate(node.path, node.size);
    }
  }

  /* Depth-first sum. `allExact` lets the UI mark a number as approximate. */
  function rollup(node) {
    if (node.type === 'file') {
      node.total = node.excluded ? 0 : node.lines;
      node.bytes = node.excluded ? 0 : node.size;
      node.fileCount = node.excluded ? 0 : 1;
      node.allExact = node.excluded || node.exact;
      return;
    }
    let total = 0;
    let bytes = 0;
    let fileCount = 0;
    let allExact = true;
    for (const child of node.children.values()) {
      rollup(child);
      total += child.total;
      bytes += child.bytes;
      fileCount += child.fileCount;
      if (!child.allExact) allExact = false;
    }
    node.total = total;
    node.bytes = bytes;
    node.fileCount = fileCount;
    node.allExact = allExact;
  }

  function collectFiles(node, out) {
    out = out || [];
    if (!node) return out;
    if (node.type === 'file') { out.push(node); return out; }
    for (const child of node.children.values()) collectFiles(child, out);
    return out;
  }

  function fetchable(node, maxBytes) {
    return !node.excluded && !node.exact && node.size > 0 && node.size <= maxBytes;
  }

  async function loadGitattributes(ctx, index, settings) {
    if (!settings.respectGitattributes) return [];

    const files = [];
    for (const node of index.values()) {
      if (node.type === 'file' && node.name === '.gitattributes') files.push(node);
    }
    if (!files.length) return [];

    // Root first, so deeper files' rules take precedence.
    files.sort((a, b) => a.path.split('/').length - b.path.split('/').length);

    const rules = [];
    for (const node of files.slice(0, 20)) {
      const res = await util.send({
        type: 'BLOB_TEXT', owner: ctx.owner, repo: ctx.repo, sha: node.sha,
      });
      if (!res.ok) continue;
      const slash = node.path.lastIndexOf('/');
      const baseDir = slash === -1 ? '' : node.path.slice(0, slash);
      rules.push(...patterns.parseGitattributes(res.text, baseDir));
    }
    return rules;
  }

  /* Returns a handle: { cancel() }. `onUpdate(state)` fires repeatedly as the
     picture sharpens; it is throttled except for the phase transitions. */
  function load(ctx, onUpdate) {
    let cancelled = false;

    const state = {
      ctx,
      status: 'loading',   // loading | estimated | refining | ready | error
      error: null,
      warning: null,
      truncated: false,
      root: null,
      index: null,
      learner: patterns.createRatioLearner(),
      progress: { done: 0, total: 0 },
      settings: null,
    };

    const emitNow = () => { if (!cancelled) onUpdate(state); };
    const emit = util.throttle(emitNow, 140);

    (async () => {
      const settings = await GHL.settings.get();
      state.settings = settings;
      if (cancelled) return;
      // Paint the strip before the network call, so a slow or wedged request is
      // visible as "loading" rather than as a blank page.
      emitNow();

      const res = await util.send(
        { type: 'TREE', owner: ctx.owner, repo: ctx.repo, oid: ctx.oid },
        { timeoutMs: 45000 } // a monorepo's recursive tree can be several MB
      );
      if (cancelled) return;

      if (!res.ok) {
        state.status = 'error';
        state.error = res;
        emitNow();
        return;
      }

      let entries = res.entries;
      state.truncated = res.truncated;

      // Very large repos come back truncated. Top up with a non-recursive
      // listing of the directory actually on screen so at least those rows are
      // real; nested directory totals stay incomplete and are flagged as such.
      if (res.truncated) {
        const dirRes = await util.send({
          type: 'TREE', owner: ctx.owner, repo: ctx.repo, oid: ctx.oid,
          recursive: false, path: ctx.path,
        });
        if (cancelled) return;
        if (dirRes.ok) {
          const prefix = ctx.path ? `${ctx.path}/` : '';
          const known = new Set(entries.map((e) => e.path));
          for (const e of dirRes.entries) {
            const full = prefix + e.path;
            if (!known.has(full)) entries = entries.concat([{ ...e, path: full }]);
          }
        }
      }

      const built = buildTree(entries);
      state.root = built.root;
      state.index = built.index;

      const isExcluded = settings.excludeGenerated
        ? patterns.compileExcludes(settings.excludePatterns)
        : () => false;

      classify(state.index, isExcluded, () => false);
      applyEstimates(state.index, state.learner);
      rollup(state.root);
      state.status = 'estimated';
      emitNow();

      // --- linguist attributes -----------------------------------------
      const rules = await loadGitattributes(ctx, state.index, settings);
      if (cancelled) return;
      if (rules.length) {
        classify(state.index, isExcluded, patterns.makeLinguistMatcher(rules));
        applyEstimates(state.index, state.learner);
        rollup(state.root);
        emitNow();
      }

      if (!settings.fetchExactLines) {
        state.status = 'ready';
        emitNow();
        return;
      }

      // --- exact counts ---------------------------------------------------
      const dirNode = state.index.get(ctx.path) || state.root;
      const subtree = collectFiles(dirNode).filter((n) => !n.excluded && n.size > 0);
      subtree.sort((a, b) => b.size - a.size);

      // Everything we already know, in one round trip.
      const probe = subtree.slice(0, CACHE_PROBE_LIMIT).map((n) => n.sha);
      if (probe.length) {
        const cached = await util.send({ type: 'CACHED_LINES', shas: probe });
        if (cancelled) return;
        if (cached.ok) {
          let hits = 0;
          for (const node of subtree) {
            const lines = cached.lines[node.sha];
            if (lines === undefined) continue;
            node.lines = lines;
            node.exact = true;
            state.learner.observe(node.path, node.size, lines);
            hits++;
          }
          if (hits) {
            applyEstimates(state.index, state.learner);
            rollup(state.root);
            emitNow();
          }
        }
      }

      // Direct children of the visible directory matter most — those are the
      // rows the user is comparing right now.
      const directChildren = new Set(
        [...dirNode.children.values()].filter((n) => n.type === 'file').map((n) => n.path)
      );
      const queue = subtree
        .filter((n) => fetchable(n, settings.maxBlobBytes))
        .sort((a, b) => {
          const ad = directChildren.has(a.path) ? 0 : 1;
          const bd = directChildren.has(b.path) ? 0 : 1;
          return ad - bd || b.size - a.size;
        })
        .slice(0, settings.maxExactFetch);

      if (!queue.length) {
        state.status = 'ready';
        emitNow();
        return;
      }

      state.status = 'refining';
      state.progress = { done: 0, total: queue.length };
      emitNow();

      let stopped = false;
      const tasks = queue.map((node) => async () => {
        if (cancelled || stopped) return null;
        const r = await util.send({
          type: 'LINES', owner: ctx.owner, repo: ctx.repo, sha: node.sha, size: node.size,
        });
        if (!r.ok) {
          // Running out of quota mid-scan is expected on an unauthenticated
          // install; stop rather than burning the rest of the queue on 403s.
          if (FATAL_ERRORS.has(r.error)) {
            stopped = true;
            state.warning = r;
          }
          return null;
        }
        node.lines = r.lines;
        node.exact = true;
        state.learner.observe(node.path, node.size, r.lines);
        return r;
      });

      await util.pool(tasks, settings.concurrency, () => {
        if (cancelled) return;
        state.progress.done++;
        applyEstimates(state.index, state.learner);
        rollup(state.root);
        emit();
      });

      if (cancelled) return;
      state.status = 'ready';
      emitNow();
    })().catch((err) => {
      if (cancelled) return;
      state.status = 'error';
      state.error = { error: 'exception', message: String(err && err.message || err) };
      emitNow();
    });

    return { cancel() { cancelled = true; } };
  }

  GHL.store = { load, collectFiles, rollup, buildTree };
})(globalThis.GHL);
