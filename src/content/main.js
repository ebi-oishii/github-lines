/* Entry point. Watches for navigation and for GitHub re-rendering the file
   list out from under us, and keeps the injected UI in sync. */
(function (GHL) {
  'use strict';

  const { util } = GHL;

  let current = null;   // { key, ctx, handle, state }
  let observer = null;

  function contextKey(ctx) {
    return `${ctx.owner}/${ctx.repo}@${ctx.oid}#${ctx.path}`;
  }

  const handlers = {
    onTreemap() {
      if (current && current.state && current.state.index) {
        GHL.treemap.open(current.state);
      }
    },
    /* The one fetch button does whatever the Lines | Size toggle says. */
    onFetch() {
      // What a press does is the store's to decide — the button's label reads
      // the same answer, so the two cannot drift apart.
      if (current && current.handle) current.handle.fetch();
    },
    onMetric(metric) {
      if (current && current.handle) current.handle.setMetric(metric);
    },
    onRows(paths) {
      if (current && current.handle) current.handle.setRows(paths);
    },
    onPick(path, checked) {
      if (current && current.handle) current.handle.setSelected(path, checked);
    },
    onPickAll(checked, keys) {
      if (current && current.handle) current.handle.setAllSelected(checked, keys);
    },
  };

  function teardown() {
    if (current && current.handle) current.handle.cancel();
    current = null;
    GHL.inline.clearRows();
    GHL.inline.removeSummary();
    GHL.treemap.close();
  }

  /* Render with the mutation observer detached, so our own DOM writes do not
     feed straight back into the observer and loop forever. */
  function guardedRender(state) {
    if (observer) observer.disconnect();
    try {
      GHL.inline.render(state, handlers);
      GHL.treemap.update(state);
    } finally {
      requestAnimationFrame(() => {
        if (observer) observer.observe(document.body, { childList: true, subtree: true });
      });
    }
  }

  function startLoad(ctx, key) {
    teardown();
    const entry = { key, ctx, handle: null, state: null };
    current = entry;
    entry.handle = GHL.store.load(ctx, (state) => {
      if (current !== entry) return;
      entry.state = state;
      guardedRender(state);
    });
  }

  function tick() {
    const ctx = GHL.page.getContext();
    const hasList = !!GHL.page.findListContainer();

    if (!ctx || !ctx.isTree || !hasList) {
      if (current) teardown();
      return;
    }

    const key = contextKey(ctx);
    if (!current || current.key !== key) {
      startLoad(ctx, key);
      return;
    }
    if (current.state) guardedRender(current.state);
  }

  const scheduleTick = util.debounce(tick, 200);

  /* Settings the drawn picture reads but the fetched one does not. */
  const DRAWN_ONLY = new Set(['warnLines', 'dangerLines', 'showInlineBars', 'showTreemapButton']);
  let known = null; // the settings the view on screen was drawn with

  function boot() {
    observer = new MutationObserver(scheduleTick);
    observer.observe(document.body, { childList: true, subtree: true });

    util.onNavigate(() => {
      /* The new file list is not in the DOM yet at navigation time — but
         GitHub dispatches its navigation events more than once, and for the
         view already on screen. Tearing down then would cancel a fetch in
         flight and lose which rows were ticked, so the context decides. */
      const ctx = GHL.page.getContext();
      if (!current || !ctx || current.key !== contextKey(ctx)) teardown();
      setTimeout(tick, 60);
      setTimeout(tick, 400);
    });

    /* A settings change. Thresholds and what is shown only change how the
       picture is drawn, so the view takes them where it stands: the options
       page saves as the reader types, and tearing down on each keystroke would
       cancel a fetch in flight and lose which rows were ticked. Anything else —
       what is fetched, which token, which language — needs the view built
       again, with the catalogue in before anything is drawn. */
    GHL.settings.onChange((next) => {
      const previous = known;
      known = next;
      const changed = previous
        ? Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(previous[k]))
        : null;
      if (changed && !changed.length) return;
      if (changed && current && current.handle && changed.every((k) => DRAWN_ONLY.has(k))) {
        current.handle.setSettings(next);
        return;
      }
      const ctx = current && current.ctx;
      teardown();
      GHL.i18n.load().then(() => { if (ctx) tick(); });
    });
    GHL.settings.get().then((s) => { if (!known) known = s; });

    // The React file list can mount after document_idle.
    tick();
    setTimeout(tick, 300);
    setTimeout(tick, 1000);
  }

  /* Nothing is drawn before the catalogue is settled, so no label is ever
     painted in one language and replaced in another. */
  const start = () => GHL.i18n.ready().then(boot);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(globalThis.GHL);
