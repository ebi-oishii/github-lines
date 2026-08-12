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

async function fill() {
  const s = await GHL.settings.get();
  $('token').value = s.token || '';
  for (const id of CHECKBOXES) $(id).checked = !!s[id];
  for (const id of NUMBERS) $(id).value = s[id];
  $('excludePatterns').value = (s.excludePatterns || []).join('\n');
}

function collect() {
  const patch = { token: $('token').value.trim() };
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
  await GHL.settings.set(collect());
  await fill();
  setStatus($('save-status'), '保存しました', 'ok');
  setTimeout(() => setStatus($('save-status'), '', 'idle'), 2500);
}

async function verify() {
  const status = $('token-status');
  const token = $('token').value.trim();

  setStatus(status, '確認中…', 'idle');

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch('https://api.github.com/rate_limit', { headers });
    const limit = res.headers.get('x-ratelimit-limit');
    const remaining = res.headers.get('x-ratelimit-remaining');

    if (res.status === 401) {
      setStatus(status, 'トークンが無効です', 'error');
      return;
    }
    if (!res.ok) {
      setStatus(status, `確認に失敗しました (HTTP ${res.status})`, 'error');
      return;
    }
    if (!token) {
      setStatus(status, `未認証で動作します — 残り ${remaining}/${limit} 回/時`, 'idle');
      return;
    }
    setStatus(status, `有効です — 残り ${remaining}/${limit} 回/時`, 'ok');
  } catch (e) {
    setStatus(status, `確認に失敗しました: ${e.message}`, 'error');
  }
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
  setStatus($('save-status'), 'キャッシュを削除しました', 'ok');
  setTimeout(() => setStatus($('save-status'), '', 'idle'), 2500);
}

async function reset() {
  await GHL.settings.reset();
  await fill();
  setStatus($('save-status'), '初期設定に戻しました', 'ok');
  setTimeout(() => setStatus($('save-status'), '', 'idle'), 2500);
}

$('save').addEventListener('click', save);
$('reset').addEventListener('click', reset);
$('verify').addEventListener('click', verify);
$('clear-cache').addEventListener('click', clearCache);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

fill();
refreshCacheStats();
