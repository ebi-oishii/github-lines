/* Settings, stored in chrome.storage.local.

   `local` rather than `sync` on purpose: the PAT would otherwise be pushed to
   the user's Google account and to every machine they sign into. */
(function (GHL) {
  'use strict';

  const DEFAULTS = {
    token: '',

    // Colour thresholds for a single file, in lines.
    warnLines: 500,
    dangerLines: 800,

    showInlineBars: true,
    showTreemapButton: true,

    // Exclusions
    excludeGenerated: true,
    respectGitattributes: true,
    excludePatterns: GHL.patterns.DEFAULT_EXCLUDES.slice(),

    // Exact line counting
    fetchExactLines: true,
    maxExactFetch: 300,   // per directory view
    concurrency: 8,
    maxBlobBytes: 2 * 1024 * 1024, // above this, keep the estimate
  };

  const KEY = 'settings';

  let cache = null;

  async function get() {
    if (cache) return cache;
    const stored = await chrome.storage.local.get(KEY);
    cache = Object.assign({}, DEFAULTS, stored[KEY] || {});
    // A user who empties the pattern box should get an empty list, not the
    // defaults back — but a missing key should still fall back.
    if (!Array.isArray(cache.excludePatterns)) {
      cache.excludePatterns = DEFAULTS.excludePatterns.slice();
    }
    return cache;
  }

  async function set(patch) {
    const current = await get();
    const next = Object.assign({}, current, patch);
    cache = next;
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  async function reset() {
    cache = null;
    await chrome.storage.local.remove(KEY);
    return get();
  }

  /* The listener is registered once at load in every context — including the
     service worker, which has no reason to subscribe but must not go on using a
     stale token after the user saves a new one. */
  const subscribers = [];

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    cache = Object.assign({}, DEFAULTS, changes[KEY].newValue || {});
    if (!Array.isArray(cache.excludePatterns)) {
      cache.excludePatterns = DEFAULTS.excludePatterns.slice();
    }
    for (const cb of subscribers) cb(cache);
  });

  function onChange(cb) {
    subscribers.push(cb);
  }

  GHL.settings = { DEFAULTS, KEY, get, set, reset, onChange };
})(globalThis.GHL);
