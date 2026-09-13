/* Data orchestration. Manual/off initially read local caches only. A manual
   click or auto mode loads the tree, attributes and then file contents.
   Unknown counts never contribute to displayed totals or proportions. */
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
        size: e.size ?? null,
        sha: e.sha,
        lines: 0,
        exact: e.size === 0,
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

  /* Only exact counts contribute. allExact also requires complete metadata. */
  function rollup(node) {
    if (node.type === 'file') {
      node.total = node.excluded || !node.exact ? 0 : node.lines;
      node.bytes = node.excluded ? 0 : node.size;
      node.fileCount = node.excluded ? 0 : 1;
      node.allExact = node.excluded || (node.exact && !node.incomplete);
      node.exactCount = !node.excluded && node.allExact ? 1 : 0;
      return;
    }
    let total = 0;
    let bytes = 0;
    let fileCount = 0;
    let exactCount = 0;
    let allExact = !node.incomplete;
    for (const child of node.children.values()) {
      rollup(child);
      total += child.total;
      bytes += child.bytes;
      fileCount += child.fileCount;
      exactCount += child.exactCount;
      if (!child.allExact) allExact = false;
    }
    node.total = total;
    node.bytes = bytes;
    node.fileCount = fileCount;
    node.exactCount = exactCount;
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

  async function loadGitattributes(ctx, index, settings, cacheOnly, isCancelled) {
    if (!settings.respectGitattributes) return { rules: [], complete: true };

    const files = [];
    for (const node of index.values()) {
      if (node.type === 'file' && node.name === '.gitattributes') files.push(node);
    }
    if (!files.length) return { rules: [], complete: true };

    // Root first, so deeper files' rules take precedence.
    files.sort((a, b) => a.path.split('/').length - b.path.split('/').length);

    const rules = [];
    let complete = files.length <= 20;
    let error = files.length > 20 ? { error: 'attributes_limit' } : null;
    for (const node of files.slice(0, 20)) {
      if (isCancelled()) return { rules, complete: false };
      const res = await util.send({
        type: 'BLOB_TEXT', owner: ctx.owner, repo: ctx.repo, sha: node.sha, cacheOnly,
      });
      if (!res.ok) {
        complete = false;
        if (res.error !== 'cache_miss') error = res;
        if (FATAL_ERRORS.has(res.error)) break;
        continue;
      }
      const slash = node.path.lastIndexOf('/');
      const baseDir = slash === -1 ? '' : node.path.slice(0, slash);
      rules.push(...patterns.parseGitattributes(res.text, baseDir));
    }
    return { rules, complete, error };
  }

  /* Returns a handle: { cancel() }. `onUpdate(state)` fires repeatedly as the
     picture sharpens; it is throttled except for the phase transitions. */
  function load(ctx, onUpdate) {
    let cancelled = false;

    const state = {
      ctx,
      // loading | pending | refining | ready | error
      status: 'loading',
      error: null,
      warning: null,
      truncated: false,
      root: null,
      index: null,
      progress: { done: 0, total: 0 },
      pending: 0,          // files a manual fetch would request
      needsMetadata: true,
      settings: null,
    };

    const emitNow = () => { if (!cancelled) onUpdate(state); };
    const emit = util.throttle(emitNow, 140);

    let queue = [];        // files still worth fetching
    let running = null;    // in-flight exact pass, so a double click is harmless

    function refresh() {
      rollup(state.root);
    }

    /* Fills in everything already in the cache. Costs no API requests, so it
       runs even when exact counts are switched off. */
    async function applyCached(files) {
      const shas = files.slice(0, CACHE_PROBE_LIMIT).map((n) => n.sha);
      if (!shas.length) return;

      const cached = await util.send({ type: 'CACHED_LINES', shas });
      if (cancelled || !cached.ok) return;

      let hits = 0;
      for (const node of files) {
        const lines = cached.lines[node.sha];
        if (lines === undefined) continue;
        node.lines = lines;
        node.exact = true;
        hits++;
      }
      if (hits) {
        refresh();
        emitNow();
      }
    }

    async function runExactPass() {
      const settings = state.settings;
      const todo = queue.filter((n) => !n.exact).slice(0, settings.maxExactFetch);
      if (!todo.length) {
        state.pending = 0;
        state.status = 'ready';
        emitNow();
        return;
      }

      state.status = 'refining';
      state.warning = null;
      state.progress = { done: 0, total: todo.length };
      emitNow();

      let stopped = false;
      const tasks = todo.map((node) => async () => {
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
        return r;
      });

      await util.pool(tasks, settings.concurrency, () => {
        if (cancelled) return;
        state.progress.done++;
        refresh();
        emit();
      });

      if (cancelled) return;

      const remaining = queue.filter((n) => !n.exact).length;
      state.pending = Math.min(remaining, settings.maxExactFetch);
      // In manual mode, leaving the button up lets the user retry whatever the
      // rate limit cut short.
      state.status = settings.exactLinesMode === 'manual' && remaining ? 'pending' : 'ready';
      emitNow();
    }

    async function prepare(cacheOnly) {
      const settings = state.settings;
      state.status = 'loading';
      state.error = null;
      state.warning = null;
      emitNow();

      const res = await util.send(
        { type: 'TREE', owner: ctx.owner, repo: ctx.repo, oid: ctx.oid, cacheOnly },
        { timeoutMs: 45000 } // a monorepo's recursive tree can be several MB
      );
      if (cancelled) return;

      if (!res.ok) {
        state.status = res.error === 'cache_miss'
          ? (settings.exactLinesMode === 'manual' ? 'pending' : 'ready') : 'error';
        state.error = res.error === 'cache_miss' ? null : res;
        emitNow();
        return false;
      }

      let entries = res.entries;
      let missingDirectory = false;
      state.truncated = res.truncated;

      // Very large repos come back truncated. Top up with a non-recursive
      // listing of the directory actually on screen so at least those rows are
      // real; directory totals remain unknown because descendants are missing.
      if (res.truncated) {
        const dirRes = await util.send({
          type: 'TREE', owner: ctx.owner, repo: ctx.repo, oid: ctx.oid,
          recursive: false, path: ctx.path, cacheOnly,
        });
        if (cancelled) return;
        if (dirRes.ok) {
          const prefix = ctx.path ? `${ctx.path}/` : '';
          const known = new Set(entries.map((e) => e.path));
          for (const e of dirRes.entries) {
            const full = prefix + e.path;
            if (!known.has(full)) entries = entries.concat([{ ...e, path: full }]);
          }
        } else {
          missingDirectory = true;
        }
      }

      const built = buildTree(entries);
      state.root = built.root;
      state.index = built.index;

      const isExcluded = settings.excludeGenerated
        ? patterns.compileExcludes(settings.excludePatterns)
        : () => false;

      // --- linguist attributes -----------------------------------------
      const attributes = await loadGitattributes(ctx, state.index, settings, cacheOnly, () => cancelled);
      if (cancelled) return;
      classify(state.index, isExcluded, patterns.makeLinguistMatcher(attributes.rules));
      // A partial tree cannot establish every descendant or attribute rule.
      for (const node of state.index.values()) {
        node.incomplete = !attributes.complete || (node.type === 'dir' && state.truncated);
      }
      state.needsMetadata = !attributes.complete || missingDirectory;
      refresh();
      if (!attributes.complete) {
        state.warning = attributes.error;
        state.status = settings.exactLinesMode === 'manual' ? 'pending' : 'ready';
        emitNow();
        return false;
      }

      // --- exact counts ---------------------------------------------------
      const dirNode = state.index.get(ctx.path) || state.root;
      const subtree = collectFiles(dirNode).filter((n) => !n.excluded && n.size > 0);
      subtree.sort((a, b) => b.size - a.size);

      await applyCached(subtree);
      if (cancelled) return;

      // Direct children of the visible directory matter most — those are the
      // rows the user is comparing right now.
      const directChildren = new Set(
        [...dirNode.children.values()].filter((n) => n.type === 'file').map((n) => n.path)
      );
      queue = subtree
        .filter((n) => fetchable(n, settings.maxBlobBytes))
        .sort((a, b) => {
          const ad = directChildren.has(a.path) ? 0 : 1;
          const bd = directChildren.has(b.path) ? 0 : 1;
          return ad - bd || b.size - a.size;
        });

      state.pending = Math.min(queue.length, settings.maxExactFetch);

      if (settings.exactLinesMode === 'off' || (!queue.length && !state.needsMetadata)) {
        state.pending = 0;
        state.status = 'ready';
        emitNow();
        return true;
      }

      if (cacheOnly) {
        state.status = 'pending';
        emitNow();
        return true;
      }

      return true;
    }

    function reportError(err) {
      if (cancelled) return;
      state.status = 'error';
      state.error = { error: 'exception', message: String(err && err.message || err) };
      emitNow();
    }

    running = (async () => {
      state.settings = await GHL.settings.get();
      if (cancelled) return;
      const auto = state.settings.exactLinesMode === 'auto';
      if (await prepare(!auto) && auto && !cancelled) await runExactPass();
    })().catch(reportError).finally(() => { running = null; });

    return {
      cancel() { cancelled = true; },
      /* The click authorizes metadata as well as one batch of file contents. */
      fetchExact() {
        if (cancelled || running || state.settings.exactLinesMode !== 'manual') return running;
        running = (async () => {
          if (state.needsMetadata && !(await prepare(false))) return;
          if (!cancelled) await runExactPass();
        })()
          .catch(reportError)
          .finally(() => { running = null; });
        return running;
      },
    };
  }

  GHL.store = { load, collectFiles, rollup, buildTree };
})(globalThis.GHL);
