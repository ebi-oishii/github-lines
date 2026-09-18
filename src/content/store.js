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
        /* Nothing fetches a zero-byte file — every path that could filters on
           `size > 0` — so if it were not exact here it would sit at its
           estimate forever, and hold the whole directory's `~` with it. */
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

  function applyEstimates(index, learner) {
    for (const node of index.values()) {
      if (node.type !== 'file' || node.exact) continue;
      node.lines = node.excluded ? 0 : learner.estimate(node.path, node.size);
    }
  }

  /* Depth-first sum. `allExact` lets the UI mark a number as approximate, and
     `maxFile` — the largest file anywhere below — is what a directory's colour
     is about: whether there is something bloated in there. */
  function rollup(node) {
    if (node.type === 'file') {
      node.total = node.excluded ? 0 : node.lines;
      node.bytes = node.excluded ? 0 : node.size;
      node.fileCount = node.excluded ? 0 : 1;
      node.allExact = node.excluded || node.exact;
      node.maxFile = node.total;
      node.maxFileBytes = node.bytes;
      return;
    }
    let total = 0;
    let bytes = 0;
    let fileCount = 0;
    let allExact = true;
    let maxFile = 0;
    let maxFileBytes = 0;
    for (const child of node.children.values()) {
      rollup(child);
      total += child.total;
      bytes += child.bytes;
      fileCount += child.fileCount;
      if (!child.allExact) allExact = false;
      if (child.maxFile > maxFile) maxFile = child.maxFile;
      if (child.maxFileBytes > maxFileBytes) maxFileBytes = child.maxFileBytes;
    }
    node.total = total;
    node.bytes = bytes;
    node.fileCount = fileCount;
    node.allExact = allExact;
    node.maxFile = maxFile;
    node.maxFileBytes = maxFileBytes;
  }

  /* The node for the directory on screen, or null when what came back does not
     contain it. The repository root is not a stand-in: totals for the wrong
     directory are worse than no totals. */
  function dirNodeOf(state) {
    if (!state.index) return null;
    return state.index.get(state.ctx.path) || (state.ctx.path ? null : state.root);
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

  /* Returns `{ rules, complete }`. Incomplete means some rule could not be
     read, so files this repository declares generated are about to be counted
     as if they were not — worth saying, and worth reading again when the reader
     next asks for anything. */
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
    // Being over the cap is not an unread rule — reading again would stop at
    // the same twenty. It is worth saying, and nothing to come back for.
    let complete = true;
    let error = files.length > 20 ? { error: 'attributes_limit' } : null;

    for (const node of files.slice(0, 20)) {
      if (isCancelled()) return { rules, complete: false, error };
      const res = await util.send({
        type: 'BLOB_TEXT', owner: ctx.owner, repo: ctx.repo, sha: node.sha, cacheOnly,
      });
      if (!res.ok) {
        complete = false;
        // Not being in the cache is not a failure to report — it is what a
        // cache-only pass is for. Anything else is.
        if (res.error !== 'not_cached') error = res;
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
      // loading | idle | estimated | pending | refining | ready | error
      //   idle    = manual mode, nothing fetched yet, waiting for the estimate button
      //   pending = manual mode, waiting for the user to ask for exact counts
      status: 'loading',
      error: null,
      warning: null,      // what the counting pass ran into
      metaWarning: null,  // what the tree pass could not read; outlives the counts
      truncated: false,
      root: null,
      index: null,
      learner: patterns.createRatioLearner(),
      progress: { done: 0, total: 0 },
      metric: 'lines',     // what the UI measures by: 'lines' | 'bytes'
      /* What pressing the fetch button would do now: 'tree' | 'counts' | null.
         The one place that decides it — the label, the click and the pass that
         runs all read this, so they cannot disagree. */
      press: null,
      /* Something the view is built on could not be read, and reading again
         could fix it: an exclusion rule, or the listing of a truncated tree's
         directory. A press re-reads it rather than counting on a picture known
         to be wrong. Recomputed by every pass. */
      needsMetadata: false,
      // The directory on screen is not in what came back. Recomputed likewise.
      missingDirectory: false,
      pending: 0,          // files a manual fetch would request
      rate: null,          // what is left of the API budget, once anything is spent
      pickable: new Map(), // row path -> files still to fetch under it (manual mode's checkboxes)
      deselected: new Set(), // row paths the user has unticked
      settings: null,
    };

    /* Manual mode only: nothing else has a button. From nothing, an error or
       something unread, a press reads the tree; with the tree in, only the
       lines reading has anything left to fetch, since sizes came with it. */
    function pressOf() {
      if (!state.settings || state.settings.exactLinesMode !== 'manual') return null;
      if (state.status === 'idle' || state.status === 'error'
        || state.needsMetadata || !state.index) return 'tree';
      if (state.metric !== 'lines') return null;
      return remaining().length ? 'counts' : null;
    }

    const emitNow = () => {
      if (cancelled) return;
      state.press = pressOf();
      onUpdate(state);
    };
    const emit = util.throttle(emitNow, 140);

    let candidates = [];   // fetchable files under the visible directory, largest-first
    let running = null;    // in-flight exact pass, so a double click is harmless

    /* Manual mode's checkboxes sit on the rows on screen, so a file is keyed by
       the row it appears under. Which paths those rows have is the UI's to know:
       GitHub folds a chain of single-child directories into one row, so a row is
       not always one segment below the directory being shown. Until the UI has
       said (`setRows`), fall back to that assumption, which is right for every
       row that was not folded. */
    let rowPaths = [];

    function rowKey(path) {
      for (const row of rowPaths) {
        if (path === row || path.startsWith(`${row}/`)) return row;
      }
      const rest = ctx.path ? path.slice(ctx.path.length + 1) : path;
      const slash = rest.indexOf('/');
      if (slash === -1) return path;
      return (ctx.path ? `${ctx.path}/` : '') + rest.slice(0, slash);
    }

    function remaining() {
      return candidates.filter((n) => !n.exact);
    }

    /* What pressing the button fetches: the files under ticked rows, within
       the per-view limit. Unticking a row frees its share of that limit. */
    function selectedQueue() {
      return remaining()
        .filter((n) => !state.deselected.has(rowKey(n.path)))
        .slice(0, state.settings.maxExactFetch);
    }

    /* Recomputes the button count and the per-row counts. In manual mode the
       button stays up while anything is left — whatever a rate limit cut
       short, the batch beyond the limit, or the unticked rows. */
    function settle() {
      const left = remaining();
      state.pickable = new Map();
      for (const n of left) {
        const key = rowKey(n.path);
        state.pickable.set(key, (state.pickable.get(key) || 0) + 1);
      }
      state.pending = selectedQueue().length;
      state.status = state.settings.exactLinesMode === 'manual' && left.length ? 'pending' : 'ready';
      state.press = pressOf();
    }

    function reselect(mutate) {
      if (cancelled) return;
      mutate();
      // Mid-fetch, the counts are settled when the pass finishes; the view
      // still follows the checkbox at once.
      if (state.status === 'pending') settle();
      emitNow();
    }

    function refresh() {
      applyEstimates(state.index, state.learner);
      rollup(state.root);
    }

    /* The budget is the service worker's to know — it reads it off the response
       headers. Asking costs no request, so it is asked after anything that
       spends one. */
    async function refreshRate() {
      const res = await util.send({ type: 'RATE', owner: ctx.owner });
      if (cancelled || !res || !res.ok || res.limit == null) return;
      state.rate = res;
      emitNow();
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
        state.learner.observe(node.path, node.size, lines);
        hits++;
      }
      if (hits) {
        refresh();
        emitNow();
      }
    }

    async function runExactPass() {
      const settings = state.settings;
      const todo = selectedQueue();
      if (!todo.length) {
        settle();
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
        state.learner.observe(node.path, node.size, r.lines);
        return r;
      });

      await util.pool(tasks, settings.concurrency, () => {
        if (cancelled) return;
        state.progress.done++;
        refresh();
        emit();
      });

      if (cancelled) return;

      settle();
      emitNow();
      refreshRate();
    }

    /* Everything from the tree request on: one API request, then estimates,
       then exact counts — in automatic mode, or when manual mode's fetch button
       was pressed on the lines reading straight away (`thenExact`). With `cacheOnly` nothing is
       requested: a commit seen before comes back from the cache and shows,
       anything else leaves the view idle. */
    async function loadTree(thenExact, cacheOnly) {
      const settings = state.settings;
      // Paint the strip before the network call, so a slow or wedged request is
      // visible as "loading" rather than as a blank page. Whatever went wrong
      // last time is being tried again, so it is no longer what is on screen.
      state.status = 'loading';
      state.error = null;
      state.warning = null;
      state.metaWarning = null;
      state.needsMetadata = false;
      state.missingDirectory = false;
      emitNow();

      const res = await util.send(
        { type: 'TREE', owner: ctx.owner, repo: ctx.repo, oid: ctx.oid, cacheOnly },
        { timeoutMs: 45000 } // a monorepo's recursive tree can be several MB
      );
      if (cancelled) return;

      if (!res.ok && res.error === 'not_cached') {
        state.status = 'idle';
        emitNow();
        return;
      }
      if (!res.ok) {
        state.status = 'error';
        state.error = res;
        emitNow();
        return;
      }

      let entries = res.entries;
      state.truncated = res.truncated;
      // A directory the truncated tree left out, which asking again could fill
      // in — unlike a directory that is simply not in the repository.
      let unreadDirectory = false;

      // Very large repos come back truncated. Top up with a non-recursive
      // listing of the directory actually on screen so at least those rows are
      // real; nested directory totals stay incomplete and are flagged as such.
      if (res.truncated) {
        const dirRes = await util.send({
          type: 'TREE', owner: ctx.owner, repo: ctx.repo, oid: ctx.oid,
          recursive: false, path: ctx.path, cacheOnly,
        });
        if (cancelled) return;
        if (dirRes.ok) {
          const prefix = ctx.path ? `${ctx.path}/` : '';
          const known = new Set(entries.map((e) => e.path));
          const extra = [];
          for (const e of dirRes.entries) {
            const full = prefix + e.path;
            if (!known.has(full)) extra.push({ ...e, path: full });
          }
          if (extra.length) entries = entries.concat(extra);
        } else {
          // Without it, nothing describes the directory on screen.
          unreadDirectory = true;
        }
      }

      const built = buildTree(entries);
      state.root = built.root;
      state.index = built.index;
      if (!res.cached) refreshRate();

      const isExcluded = settings.excludeGenerated
        ? patterns.compileExcludes(settings.excludePatterns)
        : () => false;

      classify(state.index, isExcluded, () => false);
      refresh();
      state.status = 'estimated';
      emitNow();

      // --- linguist attributes -----------------------------------------
      const attributes = await loadGitattributes(ctx, state.index, settings, cacheOnly, () => cancelled);
      if (cancelled) return;
      if (attributes.rules.length) {
        classify(state.index, isExcluded, patterns.makeLinguistMatcher(attributes.rules));
        refresh();
      }
      state.needsMetadata = !attributes.complete || unreadDirectory;
      state.metaWarning = attributes.error;
      emitNow();

      // --- exact counts ---------------------------------------------------
      const dirNode = dirNodeOf(state);
      state.missingDirectory = !dirNode;
      if (!dirNode) {
        // Nothing on screen to count. Saying so beats counting the repository.
        candidates = [];
        state.pending = 0;
        state.status = 'ready';
        emitNow();
        return;
      }
      const subtree = collectFiles(dirNode).filter((n) => !n.excluded && n.size > 0);
      subtree.sort((a, b) => b.size - a.size);

      await applyCached(subtree);
      if (cancelled) return;

      // Direct children of the visible directory matter most — those are the
      // rows the user is comparing right now.
      const directChildren = new Set(
        [...dirNode.children.values()].filter((n) => n.type === 'file').map((n) => n.path)
      );
      candidates = subtree
        .filter((n) => fetchable(n, settings.maxBlobBytes))
        .sort((a, b) => {
          const ad = directChildren.has(a.path) ? 0 : 1;
          const bd = directChildren.has(b.path) ? 0 : 1;
          return ad - bd || b.size - a.size;
        });

      if (settings.exactLinesMode === 'off' || !candidates.length || !settings.maxExactFetch) {
        state.pending = 0;
        state.status = 'ready';
        emitNow();
        return;
      }

      if (settings.exactLinesMode === 'manual' && !thenExact) {
        settle();
        emitNow();
        return;
      }

      await runExactPass();
    }

    function fail(err) {
      if (cancelled) return;
      state.status = 'error';
      state.error = { error: 'exception', message: String(err && err.message || err) };
      emitNow();
    }

    (async () => {
      state.settings = await GHL.settings.get();
      if (cancelled) return;
      refreshRate();
      // Manual mode requests nothing until asked — but what the cache already
      // holds for this commit shows at once, since that costs nothing.
      await loadTree(false, state.settings.exactLinesMode === 'manual');
    })().catch(fail);

    return {
      cancel() { cancelled = true; },
      /* The fetch button, whatever it currently says. What a press does is
         `state.press`, decided in one place and read by the label too, so the
         button cannot promise one thing and do another. Safe to call
         repeatedly. */
      fetch() {
        if (cancelled || running) return running;
        const press = state.press;
        if (!press) return null;
        // On the lines reading a press goes all the way to the counts; on
        // sizes the tree is the whole job.
        const pass = press === 'tree'
          ? loadTree(state.metric === 'lines', false)
          : runExactPass();
        running = pass
          .catch((err) => {
            state.warning = { error: 'exception', message: String(err && err.message || err) };
            emitNow();
          })
          .finally(() => { running = null; });
        return running;
      },
      /* The rows on screen, longest first so the deepest one wins. Called from
         the render pass, which is why it settles without emitting: the pass
         that called it goes on to read what it settled. */
      setRows(paths) {
        const next = [...paths].sort((a, b) => b.length - a.length);
        if (next.length === rowPaths.length && next.every((p, i) => p === rowPaths[i])) return;
        rowPaths = next;
        if (state.index && (state.status === 'pending' || state.status === 'ready')) settle();
      },
      /* Which quantity the UI shows. Costs nothing: both come from what is
         already loaded. */
      setMetric(metric) {
        if (cancelled || (metric !== 'lines' && metric !== 'bytes')) return;
        state.metric = metric;
        emitNow();
      },
      /* Manual mode: tick or untick a row. A directory row stands for every
         file under it. */
      setSelected(path, on) {
        reselect(() => {
          if (on) state.deselected.delete(path); else state.deselected.add(path);
        });
      },
      /* Manual mode: tick or untick every row on screen at once. Before the
         tree the UI says which rows those are. */
      setAllSelected(on, keys) {
        reselect(() => {
          if (on) state.deselected.clear();
          else for (const key of (keys && keys.length ? keys : state.pickable.keys())) state.deselected.add(key);
        });
      },
    };
  }

  GHL.store = { load, dirNodeOf, collectFiles, rollup, buildTree };
})(globalThis.GHL);
