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
      if (!current || !current.handle) return;
      const s = current.state;
      if (s && s.status === 'idle' && s.metric === 'bytes') current.handle.fetchSizes();
      else current.handle.fetchExact();
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

    // A changed locale means a different catalogue, which has to be in before
    // anything is drawn again.
    GHL.settings.onChange(() => {
      const ctx = current && current.ctx;
      teardown();
      GHL.i18n.load().then(() => { if (ctx) tick(); });
    });

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
