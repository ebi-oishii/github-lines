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

  function openTreemap() {
    if (current && current.state && current.state.index) {
      GHL.treemap.open(current.state);
    }
  }

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
      GHL.inline.render(state, openTreemap);
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
      // The new file list is not in the DOM yet at navigation time.
      teardown();
      setTimeout(tick, 60);
      setTimeout(tick, 400);
    });

    GHL.settings.onChange(() => {
      const ctx = current && current.ctx;
      teardown();
      if (ctx) setTimeout(tick, 0);
    });

    // The React file list can mount after document_idle.
    tick();
    setTimeout(tick, 300);
    setTimeout(tick, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(globalThis.GHL);
