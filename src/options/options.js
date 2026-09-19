'use strict';

const GHL = globalThis.GHL;
const t = GHL.i18n.t;

const $ = (id) => document.getElementById(id);

const CHECKBOXES = [
  'showInlineBars',
  'showTreemapButton',
  'excludeGenerated',
  'respectGitattributes',
];
const NUMBERS = ['warnLines', 'dangerLines', 'maxExactFetch', 'concurrency'];
// A threshold of zero would put every file past it, so zero is not an answer —
// unlike a fetch limit of zero, which is a way of saying "fetch nothing".
const LEAST = { warnLines: 1, dangerLines: 1, concurrency: 1, maxExactFetch: 0 };
const SELECTS = ['locale'];

function setStatus(node, text, tone) {
  node.textContent = text;
  node.dataset.tone = tone || 'idle';
}

function flash(text, tone) {
  setStatus($('save-status'), text, tone);
  setTimeout(() => setStatus($('save-status'), '', 'idle'), 2500);
}

/* ------------------------------------------------------------------ tokens */

function addTokenRow(entry) {
  const row = GHL.i18n.applyDom($('token-row-template').content.firstElementChild.cloneNode(true));
  row.dataset.id = entry.id || GHL.settings.newId();
  row.querySelector('.token-label').value = entry.label || '';
  row.querySelector('.token-value').value = entry.token || '';
  row.querySelector('.token-owners').value = (entry.owners || []).join(', ');

  row.querySelector('.token-remove').addEventListener('click', () => {
    row.remove();
    ensureOneRow();
    ensureDefaultChecked();
    saveNow();
  });
  row.querySelector('.token-verify').addEventListener('click', () => verifyRow(row));

  $('token-list').appendChild(row);
  return row;
}

function tokenRows() {
  return [...$('token-list').querySelectorAll('.token-row')];
}

function ensureOneRow() {
  if (!tokenRows().length) addTokenRow({});
}

/* Keep exactly one default selected, so a saved config is never ambiguous. */
function ensureDefaultChecked() {
  const rows = tokenRows();
  if (!rows.length) return;
  if (rows.some((r) => r.querySelector('.token-default').checked)) return;
  rows[0].querySelector('.token-default').checked = true;
}

function collectTokens() {
  const tokens = [];
  let defaultTokenId = '';

  for (const row of tokenRows()) {
    const token = row.querySelector('.token-value').value.trim();
    const label = row.querySelector('.token-label').value.trim();
    const owners = row.querySelector('.token-owners').value
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

    // An empty row is how you delete one; keep it only if it has a token.
    if (!token) continue;

    const id = row.dataset.id;
    tokens.push({ id, label, token, owners });
    if (row.querySelector('.token-default').checked) defaultTokenId = id;
  }

  return { tokens, defaultTokenId };
}

async function ghGet(path, headers) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  return {
    ok: res.ok,
    status: res.status,
    limit: res.headers.get('x-ratelimit-limit'),
    remaining: res.headers.get('x-ratelimit-remaining'),
    // Classic tokens report their scopes here. Fine-grained tokens do not send
    // the header at all, which is how the two are told apart.
    scopes: res.headers.get('x-oauth-scopes'),
    body: res.ok ? await res.json().catch(() => null) : null,
  };
}

/* Classic tokens have no read-only scope for repository contents: `repo` and
   `public_repo` both grant write. Worth saying out loud, because this extension
   only ever reads. */
const WRITE_SCOPES = new Set(['repo', 'public_repo', 'delete_repo', 'repo:invite', 'workflow']);

function writeGranting(scopeHeader) {
  if (!scopeHeader) return null; // fine-grained: no scope header
  return scopeHeader
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && (WRITE_SCOPES.has(s) || s.startsWith('write:') || s.startsWith('admin:')));
}

/* Asks GitHub which owners this token can actually reach, so the routing
   configures itself.

   The owners come from the repositories the token can see, not from whoever
   issued it. A fine-grained token is scoped to a single resource owner, so one
   made for an organization is issued by you but can only see that org — filling
   in your own username there would route your personal repos to a token that
   cannot read them. */
async function verifyRow(row) {
  const status = row.querySelector('.token-status');
  const token = row.querySelector('.token-value').value.trim();

  if (!token) {
    setStatus(status, t('tokenEmpty'), 'error');
    return;
  }

  setStatus(status, t('verifying'), 'idle');

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
  };

  try {
    const user = await ghGet('/user', headers);
    if (user.status === 401) {
      setStatus(status, t('tokenInvalid'), 'error');
      return;
    }
    if (!user.ok) {
      setStatus(status, t('verifyHttp', user.status), 'error');
      return;
    }

    const login = user.body && user.body.login;
    const owners = new Set(
      row.querySelector('.token-owners').value.split(',').map((o) => o.trim()).filter(Boolean)
    );

    // What the token can actually see.
    const repos = await ghGet('/user/repos?per_page=100&sort=pushed', headers);
    const discovered = new Set();
    if (repos.ok && Array.isArray(repos.body)) {
      for (const repo of repos.body) {
        if (repo.owner && repo.owner.login) discovered.add(repo.owner.login);
      }
    }

    // Organizations are best-effort: a fine-grained token is usually not
    // allowed to list them, which is not a failure.
    const orgs = await ghGet('/user/orgs?per_page=100', headers);
    if (orgs.ok && Array.isArray(orgs.body)) {
      for (const org of orgs.body) if (org.login) discovered.add(org.login);
    }

    // Only fall back to the issuing account if nothing else turned up — for an
    // org-scoped token that would be the wrong answer.
    if (!discovered.size && login) discovered.add(login);
    for (const owner of discovered) owners.add(owner);

    row.querySelector('.token-owners').value = [...owners].join(', ');
    if (!row.querySelector('.token-label').value.trim()) {
      row.querySelector('.token-label').value = [...discovered][0] || login || '';
    }
    saveNow(); // filled in by us, so nothing fired an input event

    const found = [...discovered];
    const shown = found.slice(0, 4).join(', ');
    const summary = found.length
      ? t('ownersFound', found.length > 4 ? t('ownersMore', shown, found.length - 4) : shown)
      : t('ownersNone');

    const writable = writeGranting(user.scopes);
    let kindNote = '';
    let tone = found.length ? 'ok' : 'error';
    if (writable === null) {
      kindNote = ' / fine-grained';
    } else if (writable.length) {
      kindNote = t('tokenWritable', writable.join(', '));
      if (tone === 'ok') tone = 'warn';
    } else {
      kindNote = t('tokenClassic');
    }

    setStatus(status, t('verifyOk', login, summary, user.remaining, user.limit, kindNote), tone);
  } catch (e) {
    setStatus(status, t('verifyFailed', e.message), 'error');
  }
}

/* ------------------------------------------------------------------- form */

async function fill() {
  const s = await GHL.settings.get();

  $('token-list').textContent = '';
  for (const entry of s.tokens) {
    const row = addTokenRow(entry);
    if (entry.id === s.defaultTokenId) row.querySelector('.token-default').checked = true;
  }
  ensureOneRow();
  ensureDefaultChecked();

  for (const id of CHECKBOXES) $(id).checked = !!s[id];
  for (const id of NUMBERS) $(id).value = s[id];
  for (const id of SELECTS) $(id).value = s[id] || '';

  const mode = document.querySelector(`input[name="exactLinesMode"][value="${s.exactLinesMode}"]`)
    || document.querySelector('input[name="exactLinesMode"][value="auto"]');
  mode.checked = true;

  $('excludePatterns').value = (s.excludePatterns || []).join('\n');
}

function collect() {
  const patch = collectTokens();

  for (const id of CHECKBOXES) patch[id] = $(id).checked;
  for (const id of SELECTS) patch[id] = $(id).value;

  const mode = document.querySelector('input[name="exactLinesMode"]:checked');
  if (mode) patch.exactLinesMode = mode.value;
  for (const id of NUMBERS) {
    // An emptied field is someone mid-edit, not a zero — and `Number('')` is 0,
    // which would autosave a threshold of nothing and colour every file. A
    // typed-out zero says the same thing, so it is held to the same floor.
    const raw = $(id).value.trim();
    /* All four are counts, so a typed fraction is rounded: one reaching the
       fetch pool is an array of fractional length. Below the floor is not a
       setting — a threshold of zero puts every file past it — and is left
       unsaved, so what was in effect stays in effect. */
    const n = Math.round(Number(raw));
    if (raw && Number.isFinite(n) && n >= LEAST[id]) patch[id] = n;
  }
  if (patch.concurrency !== undefined) {
    patch.concurrency = Math.min(16, patch.concurrency);
  }
  if (patch.dangerLines < patch.warnLines) {
    // Swapping is friendlier than rejecting; the intent is obvious.
    [patch.warnLines, patch.dangerLines] = [patch.dangerLines, patch.warnLines];
  }
  patch.excludePatterns = $('excludePatterns').value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return patch;
}

/* Saving is automatic: there is no button to forget. Typing is debounced into
   one write; anything discrete — a checkbox, a radio, leaving a field — writes
   at once, so closing the page never loses the last edit.

   What is deliberately missing is a re-render. Reading the form back would
   move the cursor out from under whoever is typing, and the form is already
   what was just saved. */
const WRITE_DELAY = 400;
let pendingWrite = null;

function scheduleSave() {
  clearTimeout(pendingWrite);
  pendingWrite = setTimeout(saveNow, WRITE_DELAY);
}

async function saveNow() {
  clearTimeout(pendingWrite);
  pendingWrite = null;
  await GHL.settings.set(collect());
  flash(t('saved'), 'ok');
}

async function refreshCacheStats() {
  const res = await chrome.runtime.sendMessage({ type: 'CACHE_STATS' });
  if (res && res.ok) {
    $('cache-stats').textContent =
      t('cacheStats', res.lines.toLocaleString(), res.trees, res.texts);
  } else {
    $('cache-stats').textContent = t('cacheStatsFailed');
  }
}

async function clearCache() {
  await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  await refreshCacheStats();
  flash(t('cacheCleared'), 'ok');
}

async function reset() {
  clearTimeout(pendingWrite);
  pendingWrite = null;
  await GHL.settings.reset();
  await fill();
  flash(t('resetDone'), 'ok');
}

$('add-token').addEventListener('click', () => {
  addTokenRow({});
  ensureDefaultChecked();
});
/* Restoring the defaults is the only thing on this page that cannot be undone
   — the saved tokens go with it — so it is the only thing that asks first. */
$('reset').addEventListener('click', () => $('reset-confirm').showModal());
$('reset-cancel').addEventListener('click', () => $('reset-confirm').close());
$('reset-go').addEventListener('click', async () => {
  $('reset-confirm').close();
  await reset();
});
$('clear-cache').addEventListener('click', clearCache);

/* Every other setting takes effect without redrawing this page; a new language
   changes every label on it, so the page comes back in it. */
$('locale').addEventListener('change', async () => {
  await saveNow();
  location.reload();
});

document.addEventListener('input', (e) => {
  /* Numbers are saved when the field is done with, not as they are typed: "1"
     on the way to "1200" is a real setting for 400 ms — it reaches every open
     tab, and can be taken for a threshold on the wrong side of the other. */
  if (e.target && NUMBERS.includes(e.target.id)) return;
  scheduleSave();
});
document.addEventListener('change', saveNow);

// Ctrl/Cmd-S is muscle memory; honour it by flushing rather than by ignoring it.
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    saveNow();
  }
});

// A page closing or backgrounding takes its timers with it.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  /* Leaving the page is being done with the field. Blurring it fires the same
     `change` that tabbing away would, which is what saves a number. */
  const field = document.activeElement;
  if (field && NUMBERS.includes(field.id)) field.blur();
  if (pendingWrite) saveNow();
});

(async () => {
  await GHL.i18n.ready();
  GHL.i18n.applyDom();
  document.documentElement.lang = t('lang');
  await fill();
  refreshCacheStats();
})();
