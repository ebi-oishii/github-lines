/* Settings, stored in chrome.storage.local.

   `local` rather than `sync` on purpose: tokens would otherwise be pushed to
   the user's Google account and to every machine they sign into. */
(function (GHL) {
  'use strict';

  const DEFAULTS = {
    /* [{ id, label, token, owners: [] }]
       `owners` are the GitHub users/orgs this token is for. A token from one
       account cannot read another account's private repositories, so which one
       to use is decided per repository owner. */
    tokens: [],
    defaultTokenId: '',

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

  function newId() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  }

  function normaliseToken(raw) {
    return {
      id: raw.id || newId(),
      label: typeof raw.label === 'string' ? raw.label : '',
      token: typeof raw.token === 'string' ? raw.token.trim() : '',
      owners: Array.isArray(raw.owners)
        ? raw.owners.map((o) => String(o).trim()).filter(Boolean)
        : [],
    };
  }

  /* Accepts anything previously written, including the pre-multi-account shape
     where a single `token` string lived at the top level. */
  function normalise(stored) {
    const s = Object.assign({}, DEFAULTS, stored || {});

    s.tokens = Array.isArray(s.tokens) ? s.tokens.map(normaliseToken) : [];

    // Migration: a single top-level token becomes the first entry.
    const legacy = stored && typeof stored.token === 'string' ? stored.token.trim() : '';
    if (legacy && !s.tokens.some((t) => t.token === legacy)) {
      s.tokens.unshift(normaliseToken({ label: '既定', token: legacy }));
    }
    delete s.token;

    if (!s.tokens.some((t) => t.id === s.defaultTokenId)) {
      s.defaultTokenId = s.tokens.length ? s.tokens[0].id : '';
    }

    // An emptied pattern box means "no patterns", but a missing key means
    // "never configured" and should fall back to the defaults.
    if (!Array.isArray(s.excludePatterns)) {
      s.excludePatterns = DEFAULTS.excludePatterns.slice();
    }

    return s;
  }

  /* Which token to use for a repository owner.

     Deliberately deterministic per owner. Rotating through tokens to stretch
     the rate limit is not something this should ever do — see
     docs/api-usage-and-terms.md. */
  function tokenForOwner(settings, owner) {
    const usable = (settings.tokens || []).filter((t) => t.token);
    if (!usable.length) return null;

    const lower = String(owner || '').toLowerCase();
    if (lower) {
      const scoped = usable.find((t) =>
        t.owners.some((o) => o.toLowerCase() === lower)
      );
      if (scoped) return scoped;
    }

    return usable.find((t) => t.id === settings.defaultTokenId) || usable[0];
  }

  let cache = null;

  async function get() {
    if (cache) return cache;
    const stored = await chrome.storage.local.get(KEY);
    cache = normalise(stored[KEY]);
    return cache;
  }

  async function set(patch) {
    const current = await get();
    cache = normalise(Object.assign({}, current, patch));
    await chrome.storage.local.set({ [KEY]: cache });
    return cache;
  }

  async function reset() {
    cache = null;
    await chrome.storage.local.remove(KEY);
    return get();
  }

  /* Registered once at load in every context — including the service worker,
     which has no reason to subscribe but must not go on using a stale token
     after the user saves a new one. */
  const subscribers = [];

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    cache = normalise(changes[KEY].newValue);
    for (const cb of subscribers) cb(cache);
  });

  function onChange(cb) {
    subscribers.push(cb);
  }

  GHL.settings = {
    DEFAULTS, KEY,
    get, set, reset, onChange,
    normalise, normaliseToken, tokenForOwner, newId,
  };
})(globalThis.GHL);
