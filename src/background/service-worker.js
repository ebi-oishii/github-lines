/* Service worker: the only place that talks to the GitHub API.

   Content scripts on github.com cannot fetch api.github.com directly — in MV3 a
   content script's fetch is subject to the *page's* CORS rules, not the
   extension's host permissions. So every request is proxied through here.

   This is also where the cache lives. Keeping it in the worker means it uses
   the extension's own IndexedDB rather than polluting github.com's origin
   storage, and it survives navigation. */
'use strict';

importScripts('../lib/namespace.js', '../lib/patterns.js', '../lib/settings.js');

const GHL = globalThis.GHL;
const API = 'https://api.github.com';

const DB_NAME = 'github-lines';
const DB_VERSION = 2;
const TREE_CACHE_LIMIT = 40;
const MAX_CACHED_TEXT = 256 * 1024;

/* Collapses concurrent identical requests onto one promise.

   GitHub fires its navigation events after our first render pass, so a page
   load tears the UI down and starts a second load while the first one's tree
   request is still in the air. Both would miss the cache and both would fetch
   several megabytes. */
const inflight = new Map();

function dedupe(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/* ------------------------------------------------------------------ cache */

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        // Keyed by blob SHA. Git blob SHAs are content hashes, so an entry is
        // valid forever and across repos — no invalidation needed.
        if (!d.objectStoreNames.contains('lines')) {
          d.createObjectStore('lines', { keyPath: 'sha' });
        }
        // Keyed by commit OID, likewise immutable.
        if (!d.objectStoreNames.contains('trees')) {
          d.createObjectStore('trees', { keyPath: 'key' });
        }
        // Raw blob text, for .gitattributes. Also SHA-keyed, also permanent.
        if (!d.objectStoreNames.contains('texts')) {
          d.createObjectStore('texts', { keyPath: 'sha' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(store, key) {
  const d = await db();
  return idbReq(d.transaction(store, 'readonly').objectStore(store).get(key));
}

async function idbPut(store, value) {
  const d = await db();
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetMany(store, keys) {
  const d = await db();
  const tx = d.transaction(store, 'readonly');
  const os = tx.objectStore(store);
  return Promise.all(keys.map((k) => idbReq(os.get(k))));
}

/* Trees can be several MB each. Keep only the most recent handful. */
async function pruneTrees() {
  const d = await db();
  const tx = d.transaction('trees', 'readwrite');
  const os = tx.objectStore('trees');
  const all = await idbReq(os.getAll());
  if (all.length <= TREE_CACHE_LIMIT) return;
  all.sort((a, b) => a.ts - b.ts);
  for (const row of all.slice(0, all.length - TREE_CACHE_LIMIT)) {
    os.delete(row.key);
  }
}

/* ------------------------------------------------------------- rate limit */

const rate = { limit: null, remaining: null, reset: null, authenticated: false };

function noteRate(res) {
  const limit = res.headers.get('x-ratelimit-limit');
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (limit != null) rate.limit = Number(limit);
  if (remaining != null) rate.remaining = Number(remaining);
  if (reset != null) rate.reset = Number(reset) * 1000;
}

/* Self-throttling.

   GitHub documents a secondary rate limit of 900 points per minute for REST
   GETs (1 point each) and no more than 100 concurrent requests, and asks
   clients to stop entirely when a response carries `retry-after`. Concurrency
   is already capped at 8 by the content script; this keeps the per-minute count
   comfortably under the documented ceiling and enforces the pause. */
const RATE_WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 600;      // two thirds of the documented 900
const MAX_SLOT_WAIT_MS = 15_000; // rather report "throttled" than hang the UI

const recentRequests = [];
let pausedUntil = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pauseUntil(timestamp) {
  if (timestamp > pausedUntil) pausedUntil = timestamp;
}

/* Resolves once it is our turn, or false if that would take too long. */
async function acquireSlot() {
  const deadline = Date.now() + MAX_SLOT_WAIT_MS;

  for (;;) {
    const now = Date.now();

    if (now < pausedUntil) {
      if (pausedUntil > deadline) return false;
      await sleep(Math.min(1000, pausedUntil - now));
      continue;
    }

    while (recentRequests.length && now - recentRequests[0] > RATE_WINDOW_MS) {
      recentRequests.shift();
    }
    if (recentRequests.length < MAX_PER_WINDOW) {
      recentRequests.push(now);
      return true;
    }

    const freesAt = recentRequests[0] + RATE_WINDOW_MS;
    if (freesAt > deadline) return false;
    await sleep(Math.max(50, freesAt - now));
  }
}

/* ------------------------------------------------------------------ fetch */

async function token() {
  const s = await GHL.settings.get();
  return (s.token || '').trim();
}

function fail(code, extra) {
  const err = new Error(code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

async function ghFetch(path, { accept = 'application/vnd.github+json' } = {}) {
  if (!(await acquireSlot())) {
    throw fail('throttled', { reset: pausedUntil, authenticated: rate.authenticated });
  }

  const tok = await token();
  rate.authenticated = !!tok;

  const headers = {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (tok) headers.Authorization = `Bearer ${tok}`;

  const res = await fetch(API + path, { headers });
  noteRate(res);

  if (res.ok) return res;

  let detail = '';
  try { detail = (await res.json()).message || ''; } catch (_) { /* not json */ }

  // Secondary rate limit. GitHub's guidance: honour retry-after if present,
  // otherwise back off for at least a minute. Either way, stop sending.
  const retryAfter = Number(res.headers.get('retry-after'));
  const isSecondary =
    (res.status === 403 || res.status === 429) &&
    (retryAfter > 0 || /secondary rate limit/i.test(detail));

  if (isSecondary) {
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 60_000;
    pauseUntil(Date.now() + waitMs);
    throw fail('secondary_rate_limit', { reset: pausedUntil, authenticated: rate.authenticated });
  }

  // Primary rate limit: nothing will succeed until the window resets, so stop
  // rather than spending the next minute collecting 403s.
  if ((res.status === 403 || res.status === 429) && rate.remaining === 0) {
    if (rate.reset) pauseUntil(rate.reset);
    throw fail('rate_limit', { reset: rate.reset, authenticated: rate.authenticated });
  }

  if (res.status === 401) throw fail('bad_token');
  if (res.status === 404) throw fail('not_found', { authenticated: rate.authenticated });

  const err = fail(`http_${res.status}`);
  err.message = detail || err.message;
  throw err;
}

/* -------------------------------------------------------------- handlers */

const SHA_RE = /^[0-9a-f]{40}$/i;

/* `application/vnd.github.sha` makes this the cheapest possible request: the
   response body is just the commit SHA. */
async function resolveRef({ owner, repo, ref }) {
  const res = await ghFetch(`/repos/${owner}/${repo}/commits/${ref}`, {
    accept: 'application/vnd.github.sha',
  });
  return (await res.text()).trim();
}

async function fetchTree(owner, repo, target, recursive) {
  const res = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${target}${recursive ? '?recursive=1' : ''}`
  );
  const json = await res.json();
  return {
    entries: (json.tree || []).map((e) => ({
      path: e.path,
      type: e.type === 'tree' ? 'dir' : 'file',
      size: e.size || 0,
      sha: e.sha,
    })),
    truncated: !!json.truncated,
  };
}

function getTree(msg) {
  const { owner, repo, oid, recursive = true, path = '' } = msg;
  return dedupe(`tree:${owner}/${repo}@${oid}:${recursive ? 'r' : path}`, () => loadTree(msg));
}

async function loadTree({ owner, repo, oid, recursive = true, path = '' }) {
  let sha = oid;
  let immutable = SHA_RE.test(sha);
  const keyFor = (s) => `${owner}/${repo}@${s}${recursive ? ':r' : ':' + path}`;

  // Only a commit SHA is safe to cache: a branch name moves, and a stale tree
  // would keep showing yesterday's file sizes forever.
  if (immutable) {
    const hit = await idbGet('trees', keyFor(sha));
    if (hit) return { ok: true, entries: hit.entries, truncated: hit.truncated, cached: true };
  }

  // Slashes must survive; only the individual segments get escaped.
  const suffix = recursive || !path
    ? ''
    : ':' + path.split('/').map(encodeURIComponent).join('/');

  let result;
  try {
    result = await fetchTree(owner, repo, sha + suffix, recursive);
  } catch (err) {
    // The trees endpoint takes a single path segment, so a branch named
    // `feature/foo` 404s. Resolve it to a commit SHA and retry.
    if (err.code !== 'not_found' || immutable) throw err;

    sha = await resolveRef({ owner, repo, ref: oid });
    immutable = SHA_RE.test(sha);
    if (immutable) {
      const hit = await idbGet('trees', keyFor(sha));
      if (hit) return { ok: true, entries: hit.entries, truncated: hit.truncated, cached: true };
    }
    result = await fetchTree(owner, repo, sha + suffix, recursive);
  }

  if (immutable) {
    await idbPut('trees', {
      key: keyFor(sha), entries: result.entries, truncated: result.truncated, ts: Date.now(),
    });
    pruneTrees().catch(() => {});
  }

  return { ok: true, entries: result.entries, truncated: result.truncated, cached: false, oid: sha };
}

function countLines(text) {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  // A file not ending in a newline still has one more line of content.
  if (text.charCodeAt(text.length - 1) !== 10) n++;
  return n;
}

async function fetchBlobText({ owner, repo, sha }) {
  const res = await ghFetch(`/repos/${owner}/${repo}/git/blobs/${sha}`, {
    accept: 'application/vnd.github.raw',
  });
  return res.text();
}

/* Used for .gitattributes, which is read on every directory view. Cached by
   SHA like everything else, so it costs one request per repository, ever. */
function getBlobText(msg) {
  return dedupe(`text:${msg.sha}`, async () => {
    const hit = await idbGet('texts', msg.sha);
    if (hit) return { ok: true, text: hit.text, cached: true };

    const text = await fetchBlobText(msg);
    if (text.length <= MAX_CACHED_TEXT) {
      await idbPut('texts', { sha: msg.sha, text, ts: Date.now() });
    }
    return { ok: true, text, cached: false };
  });
}

function getLines(msg) {
  return dedupe(`lines:${msg.sha}`, () => loadLines(msg));
}

async function loadLines({ owner, repo, sha, size }) {
  const hit = await idbGet('lines', sha);
  if (hit) return { ok: true, lines: hit.lines, cached: true };

  const text = await fetchBlobText({ owner, repo, sha });
  const lines = countLines(text);
  await idbPut('lines', { sha, lines, bytes: size || text.length, ts: Date.now() });
  return { ok: true, lines, cached: false };
}

/* Bulk cache probe — lets the content script paint every already-known exact
   count on the first frame instead of re-requesting them one by one. */
async function getCachedLines({ shas }) {
  const rows = await idbGetMany('lines', shas);
  const out = {};
  rows.forEach((row, i) => {
    if (row) out[shas[i]] = row.lines;
  });
  return { ok: true, lines: out };
}

const STORES = ['lines', 'trees', 'texts'];

async function clearCache() {
  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction(STORES, 'readwrite');
    for (const name of STORES) tx.objectStore(name).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return { ok: true };
}

async function cacheStats() {
  const d = await db();
  const tx = d.transaction(STORES, 'readonly');
  const [lines, trees, texts] = await Promise.all(
    STORES.map((name) => idbReq(tx.objectStore(name).count()))
  );
  return { ok: true, lines, trees, texts };
}

const HANDLERS = {
  TREE: getTree,
  LINES: getLines,
  CACHED_LINES: getCachedLines,
  BLOB_TEXT: getBlobText,
  RATE: async () => ({ ok: true, rate }),
  CLEAR_CACHE: clearCache,
  CACHE_STATS: cacheStats,
  PING: async () => ({ ok: true }),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg && msg.type];
  if (!handler) return false;

  handler(msg).then(sendResponse, (err) => {
    sendResponse({
      ok: false,
      error: err.code || 'error',
      message: err.message || String(err),
      reset: err.reset,
      authenticated: err.authenticated,
    });
  });
  return true; // async response
});
