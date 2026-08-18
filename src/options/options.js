'use strict';

const GHL = globalThis.GHL;

const $ = (id) => document.getElementById(id);

const CHECKBOXES = [
  'showInlineBars',
  'showTreemapButton',
  'fetchExactLines',
  'excludeGenerated',
  'respectGitattributes',
];
const NUMBERS = ['warnLines', 'dangerLines', 'maxExactFetch', 'concurrency'];

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
  const row = $('token-row-template').content.firstElementChild.cloneNode(true);
  row.dataset.id = entry.id || GHL.settings.newId();
  row.querySelector('.token-label').value = entry.label || '';
  row.querySelector('.token-value').value = entry.token || '';
  row.querySelector('.token-owners').value = (entry.owners || []).join(', ');

  row.querySelector('.token-remove').addEventListener('click', () => {
    row.remove();
    ensureOneRow();
    ensureDefaultChecked();
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

/* Asks GitHub who this token is, and which owners it can reach, so the routing
   configures itself. Costs two API requests. */
async function verifyRow(row) {
  const status = row.querySelector('.token-status');
  const token = row.querySelector('.token-value').value.trim();

  setStatus(status, '確認中…', 'idle');

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch('https://api.github.com/user', { headers });
    const limit = res.headers.get('x-ratelimit-limit');
    const remaining = res.headers.get('x-ratelimit-remaining');

    if (!token) {
      setStatus(status, 'トークンが未入力です', 'error');
      return;
    }
    if (res.status === 401) {
      setStatus(status, 'トークンが無効です', 'error');
      return;
    }
    if (!res.ok) {
      setStatus(status, `確認に失敗しました (HTTP ${res.status})`, 'error');
      return;
    }

    const user = await res.json();
    const owners = new Set(
      row.querySelector('.token-owners').value.split(',').map((o) => o.trim()).filter(Boolean)
    );
    if (user.login) owners.add(user.login);

    // Organizations are best-effort: a fine-grained token may not be allowed to
    // list them, which is not a failure.
    let orgNote = '';
    try {
      const orgRes = await fetch('https://api.github.com/user/orgs?per_page=100', { headers });
      if (orgRes.ok) {
        const orgs = await orgRes.json();
        for (const org of orgs) if (org.login) owners.add(org.login);
        orgNote = orgs.length ? ` / org ${orgs.length} 件` : '';
      } else {
        orgNote = ' / org は取得不可（手動で追記してください）';
      }
    } catch (_) {
      orgNote = ' / org は取得不可';
    }

    row.querySelector('.token-owners').value = [...owners].join(', ');
    if (!row.querySelector('.token-label').value.trim() && user.login) {
      row.querySelector('.token-label').value = user.login;
    }

    setStatus(
      status,
      `${user.login} として有効 — 残り ${remaining}/${limit} 回/時${orgNote}`,
      'ok'
    );
  } catch (e) {
    setStatus(status, `確認に失敗しました: ${e.message}`, 'error');
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
  $('excludePatterns').value = (s.excludePatterns || []).join('\n');
}

function collect() {
  const patch = collectTokens();

  for (const id of CHECKBOXES) patch[id] = $(id).checked;
  for (const id of NUMBERS) {
    const n = Number($(id).value);
    if (Number.isFinite(n) && n >= 0) patch[id] = n;
  }
  patch.concurrency = Math.min(16, Math.max(1, patch.concurrency || 8));
  patch.excludePatterns = $('excludePatterns').value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (patch.dangerLines < patch.warnLines) {
    // Swapping is friendlier than rejecting; the intent is obvious.
    [patch.warnLines, patch.dangerLines] = [patch.dangerLines, patch.warnLines];
  }
  return patch;
}

async function save() {
  const patch = collect();
  await GHL.settings.set(patch);
  await fill();
  const n = patch.tokens.length;
  flash(n ? `保存しました（トークン ${n} 件）` : '保存しました（トークンなし）', 'ok');
}

async function refreshCacheStats() {
  const res = await chrome.runtime.sendMessage({ type: 'CACHE_STATS' });
  if (res && res.ok) {
    $('cache-stats').textContent =
      `行数 ${res.lines.toLocaleString()} 件 / ツリー ${res.trees} 件 / テキスト ${res.texts} 件`;
  } else {
    $('cache-stats').textContent = 'キャッシュ情報を取得できませんでした';
  }
}

async function clearCache() {
  await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  await refreshCacheStats();
  flash('キャッシュを削除しました', 'ok');
}

async function reset() {
  await GHL.settings.reset();
  await fill();
  flash('初期設定に戻しました', 'ok');
}

$('add-token').addEventListener('click', () => {
  addTokenRow({});
  ensureDefaultChecked();
});
$('save').addEventListener('click', save);
$('reset').addEventListener('click', reset);
$('clear-cache').addEventListener('click', clearCache);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

fill();
refreshCacheStats();
