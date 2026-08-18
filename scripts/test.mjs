/* Tests.

   Two halves:
     - pure logic (globs, .gitattributes, estimator, rollups, treemap layout)
     - DOM behaviour against a trimmed capture of a real GitHub page, so that
       the day GitHub reshuffles its markup, this fails instead of the bars
       silently vanishing.

   Usage: node scripts/test.mjs
   Refresh the DOM fixture with: node scripts/capture-fixture.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'tree-page.html');
const FIXTURE_URL = 'https://github.com/sindresorhus/got/tree/main/source';

let passed = 0;
let skipped = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertClose(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg || 'not close'}: expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

/* ------------------------------------------------------- environment setup */

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (_) {
  console.log('jsdom not installed — skipping DOM tests (npm install)\n');
}

/* The content scripts read `document`, `location` and `chrome` as globals, so
   install a page before loading them. */
let currentDom = null;

function installDom(html, url) {
  if (!JSDOM) return null;
  const dom = new JSDOM(html, { url });
  currentDom = dom;
  const w = dom.window;
  for (const key of ['window', 'document', 'MutationObserver', 'Node', 'CSS', 'getComputedStyle']) {
    globalThis[key] = w[key];
  }
  // A getter, so jsdom's reconfigure() (which is how we simulate GitHub's
  // client-side navigation) is visible to the content scripts.
  Object.defineProperty(globalThis, 'location', {
    get: () => currentDom.window.location,
    configurable: true,
  });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  return dom;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {} },
  },
  runtime: { sendMessage() {}, lastError: null },
};

const fixtureHtml = fs.existsSync(FIXTURE) ? fs.readFileSync(FIXTURE, 'utf8') : null;
if (JSDOM && !fixtureHtml) {
  console.log(`fixture missing (${path.relative(ROOT, FIXTURE)}) — skipping DOM tests\n`);
}
const domReady = !!(JSDOM && fixtureHtml);

if (domReady) installDom(fixtureHtml, FIXTURE_URL);

function load(rel) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
}

for (const file of [
  'src/lib/namespace.js',
  'src/lib/patterns.js',
  'src/lib/settings.js',
  'src/content/util.js',
  'src/content/page.js',
  'src/content/store.js',
  'src/content/inline.js',
  'src/content/treemap.js',
]) {
  load(file);
}

const { patterns, store, treemap, page, inline, settings } = globalThis.GHL;

function domCheck(name, fn) {
  if (!domReady) { skipped++; return; }
  check(name, fn);
}

/* ---------------------------------------------------------------- globs */

check('glob: ** matches nested and root', () => {
  const re = patterns.globToRegExp('**/*.min.js');
  assert(re.test('a/b/c.min.js'), 'nested should match');
  assert(re.test('c.min.js'), 'root should match');
  assert(!re.test('c.js'), 'plain .js should not match');
});

check('glob: **/dir/** matches at any depth', () => {
  const re = patterns.globToRegExp('**/node_modules/**');
  assert(re.test('node_modules/left-pad/index.js'), 'root node_modules');
  assert(re.test('packages/app/node_modules/x/y.js'), 'nested node_modules');
  assert(!re.test('src/node_modules_helper.js'), 'partial name should not match');
});

check('glob: * does not cross a slash', () => {
  const re = patterns.globToRegExp('src/*.ts');
  assert(re.test('src/api.ts'), 'direct child');
  assert(!re.test('src/lib/api.ts'), 'grandchild should not match');
});

check('glob: regex metacharacters are escaped', () => {
  const re = patterns.globToRegExp('**/a+b(1).js');
  assert(re.test('x/a+b(1).js'), 'literal match');
  assert(!re.test('x/aab1.js'), 'should not behave as regex');
});

check('compileExcludes: skips blanks and comments', () => {
  const isExcluded = patterns.compileExcludes(['', '  ', '# comment', '**/*.snap']);
  assert(isExcluded('a/b.snap'), 'snap excluded');
  assert(!isExcluded('a/b.ts'), 'ts not excluded');
});

check('defaults exclude lockfiles and vendored trees', () => {
  const isExcluded = patterns.compileExcludes(patterns.DEFAULT_EXCLUDES);
  for (const p of ['package-lock.json', 'a/b/yarn.lock', 'vendor/x/y.go', 'dist/main.min.js']) {
    assert(isExcluded(p), `${p} should be excluded`);
  }
  for (const p of ['src/api.ts', 'README.md', 'lib/dist-helper.ts']) {
    assert(!isExcluded(p), `${p} should not be excluded`);
  }
});

/* -------------------------------------------------------- binary / ext */

check('extOf handles dotfiles and extensionless names', () => {
  assertEqual(patterns.extOf('src/api.ts'), 'ts');
  assertEqual(patterns.extOf('Dockerfile'), 'dockerfile');
  assertEqual(patterns.extOf('a/b/.gitignore'), '.gitignore');
  assertEqual(patterns.extOf('archive.tar.gz'), 'gz');
});

check('isBinary flags assets, not code', () => {
  assert(patterns.isBinary('img/logo.png'));
  assert(patterns.isBinary('fonts/Inter.woff2'));
  assert(!patterns.isBinary('src/logo.tsx'));
});

/* --------------------------------------------------------- gitattributes */

check('gitattributes: linguist-generated is honoured', () => {
  const rules = patterns.parseGitattributes('*.min.js linguist-generated=true\n', '');
  const flagged = patterns.makeLinguistMatcher(rules);
  assert(flagged('dist/app.min.js'), 'basename pattern matches at depth');
  assert(flagged('app.min.js'), 'and at root');
  assert(!flagged('app.js'), 'unrelated file untouched');
});

check('gitattributes: bare attribute means true, negation means false', () => {
  const rules = patterns.parseGitattributes(
    'generated/** linguist-generated\ngenerated/keep.ts -linguist-generated\n', ''
  );
  const flagged = patterns.makeLinguistMatcher(rules);
  assert(flagged('generated/a.ts'), 'bare attribute is true');
  assert(!flagged('generated/keep.ts'), 'later negating rule wins');
});

check('gitattributes: anchored patterns respect the file location', () => {
  const rules = patterns.parseGitattributes('api/*.go linguist-generated=true\n', 'server');
  const flagged = patterns.makeLinguistMatcher(rules);
  assert(flagged('server/api/gen.go'), 'anchored under the .gitattributes dir');
  assert(!flagged('api/gen.go'), 'not matched outside that dir');
});

check('gitattributes: comments and attribute-less lines are ignored', () => {
  const rules = patterns.parseGitattributes('# comment\n*.ts text\n*.bin binary\n', '');
  assertEqual(rules.length, 0, 'no linguist attributes present');
});

/* ------------------------------------------------------------- estimator */

check('ratio learner falls back to the per-language table', () => {
  const learner = patterns.createRatioLearner();
  assertEqual(learner.estimate('src/a.ts', 3300), 100); // ts defaults to 33 b/line
});

check('ratio learner adapts once it has evidence', () => {
  const learner = patterns.createRatioLearner();
  learner.observe('src/a.ts', 1000, 100); // this repo really runs 10 bytes/line
  assertEqual(learner.estimate('src/b.ts', 1000), 100, 'learned ratio applied');
  assertEqual(learner.estimate('src/b.py', 3000), 100, 'py still uses the table');
});

check('ratio learner ignores samples too small to be evidence', () => {
  const learner = patterns.createRatioLearner();
  learner.observe('src/a.ts', 1000, 2);
  assertEqual(learner.estimate('src/b.ts', 3300), 100, 'still the default 33 b/l');
});

/* -------------------------------------------------------- tree + rollup */

function sampleTree() {
  return store.buildTree([
    { path: 'src', type: 'dir' },
    { path: 'src/api.ts', type: 'file', size: 3300, sha: 'a' },
    { path: 'src/util.ts', type: 'file', size: 1650, sha: 'b' },
    { path: 'src/ui/Button.tsx', type: 'file', size: 990, sha: 'c' },
    { path: 'logo.png', type: 'file', size: 50000, sha: 'd' },
    { path: 'README.md', type: 'file', size: 460, sha: 'e' },
  ]);
}

check('buildTree creates implicit parent directories', () => {
  const { index } = sampleTree();
  assert(index.has('src'), 'explicit dir');
  assert(index.has('src/ui'), 'implicit dir from a nested file path');
  assertEqual(index.get('src/ui').type, 'dir');
  assertEqual(index.get('src/ui/Button.tsx').name, 'Button.tsx');
});

check('rollup sums descendants and excludes binaries', () => {
  const { root, index } = sampleTree();
  const learner = patterns.createRatioLearner();
  const isExcluded = patterns.compileExcludes(patterns.DEFAULT_EXCLUDES);

  for (const node of index.values()) {
    if (node.type !== 'file') continue;
    node.binary = patterns.isBinary(node.path);
    node.excluded = node.binary || isExcluded(node.path);
    node.lines = node.excluded ? 0 : learner.estimate(node.path, node.size);
  }
  store.rollup(root);

  assertEqual(index.get('src/api.ts').lines, 100, 'api.ts estimate');
  assertEqual(index.get('src/util.ts').lines, 50, 'util.ts estimate');
  assertEqual(index.get('src/ui').total, 30, 'nested dir total');
  assertEqual(index.get('src').total, 180, 'src total includes nested dir');
  assertEqual(index.get('logo.png').total, 0, 'binary contributes nothing');
  assertEqual(index.get('logo.png').fileCount, 0, 'binary not counted as a file');
  assertEqual(root.fileCount, 4, 'four countable files');
  assertEqual(root.total, 190, 'root total = src(180) + README(10)');
});

check('allExact is false until every descendant is exact', () => {
  const { root, index } = sampleTree();
  for (const node of index.values()) {
    if (node.type === 'file') { node.excluded = false; node.lines = 10; node.exact = true; }
  }
  index.get('src/ui/Button.tsx').exact = false;
  store.rollup(root);

  assertEqual(index.get('src/ui').allExact, false, 'dir holding the estimate');
  assertEqual(index.get('src').allExact, false, 'propagates upward');
  assertEqual(root.allExact, false, 'reaches the root');

  index.get('src/ui/Button.tsx').exact = true;
  store.rollup(root);
  assertEqual(root.allExact, true, 'clears once everything is exact');
});

/* ----------------------------------------------------------- treemap */

const RECT = { x: 0, y: 0, w: 800, h: 500 };

function layoutOf(values) {
  const items = values.map((v, i) => ({ node: { name: `n${i}`, total: v }, value: v }));
  return treemap.squarify(items, RECT);
}

check('squarify places every item', () => {
  assertEqual(layoutOf([500, 300, 200, 100, 60, 40, 20, 10]).length, 8);
});

check('squarify conserves area', () => {
  const values = [500, 300, 200, 100, 60, 40, 20, 10];
  const placed = layoutOf(values);
  const total = values.reduce((s, v) => s + v, 0);
  const rectArea = RECT.w * RECT.h;

  assertClose(placed.reduce((s, p) => s + p.w * p.h, 0), rectArea, 1, 'total area fills the rect');
  for (const p of placed) {
    const expected = (p.node.total / total) * rectArea;
    assertClose(p.w * p.h, expected, expected * 0.001, `area for ${p.node.name}`);
  }
});

check('squarify keeps every tile inside the rect', () => {
  for (const p of layoutOf([500, 300, 200, 100, 60, 40, 20, 10])) {
    assert(p.x >= -0.001 && p.y >= -0.001, `${p.node.name} starts inside`);
    assert(p.x + p.w <= RECT.w + 0.001, `${p.node.name} right edge inside`);
    assert(p.y + p.h <= RECT.h + 0.001, `${p.node.name} bottom edge inside`);
    assert(p.w > 0 && p.h > 0, `${p.node.name} has positive size`);
  }
});

check('squarify produces no overlaps', () => {
  const placed = layoutOf([500, 300, 200, 100, 60, 40, 20, 10]);
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert(ox <= 0.001 || oy <= 0.001, `${a.node.name} overlaps ${b.node.name}`);
    }
  }
});

check('squarify beats naive slicing on aspect ratio', () => {
  const placed = layoutOf(new Array(40).fill(10));
  const worst = Math.max(...placed.map((p) => Math.max(p.w / p.h, p.h / p.w)));
  assert(worst < 4, `worst aspect ratio should stay usable, got ${worst.toFixed(2)}`);
});

check('squarify handles the degenerate cases', () => {
  assertEqual(treemap.squarify([], RECT).length, 0, 'no items');
  assertEqual(treemap.squarify([{ node: {}, value: 0 }], RECT).length, 0, 'zero total');
  assertEqual(
    treemap.squarify([{ node: {}, value: 5 }], { x: 0, y: 0, w: 0, h: 100 }).length, 0,
    'zero-width rect'
  );
  assertEqual(treemap.squarify([{ node: { name: 'solo' }, value: 5 }], RECT).length, 1, 'single item');
});

check('squarify respects a rect origin offset', () => {
  const rect = { x: 100, y: 50, w: 200, h: 120 };
  const placed = treemap.squarify(
    [3, 2, 1].map((v, i) => ({ node: { name: `n${i}` }, value: v })), rect
  );
  for (const p of placed) {
    assert(p.x >= rect.x - 0.001 && p.x + p.w <= rect.x + rect.w + 0.001, 'x within offset rect');
    assert(p.y >= rect.y - 0.001 && p.y + p.h <= rect.y + rect.h + 0.001, 'y within offset rect');
  }
});

/* ------------------------------------------------------------ multi-token */

/* A token issued by one account cannot read another account's private
   repositories, so which token to use is decided per repository owner. */

check('settings: a legacy single token becomes the first entry', () => {
  const s = settings.normalise({ token: 'ghp_legacy', warnLines: 400 });
  assertEqual(s.tokens.length, 1);
  assertEqual(s.tokens[0].token, 'ghp_legacy');
  assertEqual(s.defaultTokenId, s.tokens[0].id, 'and becomes the default');
  assertEqual(s.warnLines, 400, 'other settings survive');
  assertEqual(s.token, undefined, 'the old field is dropped');
});

check('settings: migration does not duplicate an already-migrated token', () => {
  const once = settings.normalise({ token: 'ghp_a' });
  const twice = settings.normalise({ token: 'ghp_a', tokens: once.tokens });
  assertEqual(twice.tokens.length, 1);
});

check('settings: tokens are given ids and trimmed', () => {
  const s = settings.normalise({ tokens: [{ token: '  ghp_x  ', owners: [' me ', ''] }] });
  assertEqual(s.tokens[0].token, 'ghp_x');
  assert(s.tokens[0].id, 'an id is assigned');
  assertEqual(s.tokens[0].owners.join(','), 'me', 'blank owners dropped');
});

check('settings: a dangling defaultTokenId falls back to the first token', () => {
  const s = settings.normalise({
    tokens: [{ id: 'a', token: 'ghp_a' }, { id: 'b', token: 'ghp_b' }],
    defaultTokenId: 'deleted',
  });
  assertEqual(s.defaultTokenId, 'a');
});

function twoAccounts() {
  return settings.normalise({
    tokens: [
      { id: 'personal', label: '個人', token: 'ghp_personal', owners: ['ebi-oishii'] },
      { id: 'work', label: '仕事', token: 'ghp_work', owners: ['Acme-Corp', 'acme-labs'] },
    ],
    defaultTokenId: 'personal',
  });
}

check('tokenForOwner: routes by owner', () => {
  const s = twoAccounts();
  assertEqual(settings.tokenForOwner(s, 'ebi-oishii').id, 'personal');
  assertEqual(settings.tokenForOwner(s, 'acme-labs').id, 'work');
});

check('tokenForOwner: owner matching ignores case', () => {
  const s = twoAccounts();
  assertEqual(settings.tokenForOwner(s, 'acme-corp').id, 'work', 'lowercased URL owner');
  assertEqual(settings.tokenForOwner(s, 'EBI-OISHII').id, 'personal');
});

check('tokenForOwner: an unknown owner gets the default', () => {
  const s = twoAccounts();
  assertEqual(settings.tokenForOwner(s, 'sindresorhus').id, 'personal');

  s.defaultTokenId = 'work';
  assertEqual(settings.tokenForOwner(s, 'sindresorhus').id, 'work', 'follows the default');
});

check('tokenForOwner: falls back to the first usable token', () => {
  const s = settings.normalise({
    tokens: [{ id: 'a', token: '' }, { id: 'b', token: 'ghp_b' }],
  });
  assertEqual(settings.tokenForOwner(s, 'whoever').id, 'b', 'blank tokens are skipped');
});

check('tokenForOwner: no tokens means anonymous', () => {
  assertEqual(settings.tokenForOwner(settings.normalise({}), 'anyone'), null);
  assertEqual(settings.tokenForOwner(settings.normalise({ tokens: [{ token: '' }] }), 'x'), null);
});

check('tokenForOwner: the same owner always gets the same token', () => {
  // Deterministic on purpose: rotating tokens to stretch the rate limit is
  // exactly what GitHub's terms prohibit.
  const s = twoAccounts();
  const picks = new Set();
  for (let i = 0; i < 20; i++) picks.add(settings.tokenForOwner(s, 'sindresorhus').id);
  assertEqual(picks.size, 1, 'no rotation');
});

/* ---------------------------------------------------------------- transport */

/* An MV3 service worker gets terminated when idle, and one killed mid-request
   can leave sendMessage's callback hanging forever. Left unbounded that shows
   up as a permanently blank page, so the wait must always end. */

const realSend = globalThis.GHL.util.send;

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

await checkAsync('send gives up when the worker never answers', async () => {
  globalThis.chrome.runtime.sendMessage = () => {}; // callback never fires
  const res = await realSend({ type: 'PING' }, { timeoutMs: 40, retries: 0 });
  assertEqual(res.ok, false);
  assertEqual(res.error, 'timeout');
});

await checkAsync('send retries once, since the first wake-up often fails', async () => {
  let calls = 0;
  globalThis.chrome.runtime.sendMessage = (_msg, cb) => {
    calls++;
    if (calls === 1) return; // worker asleep: no answer
    cb({ ok: true, entries: [] });
  };
  const res = await realSend({ type: 'TREE' }, { timeoutMs: 40, retries: 1 });
  assertEqual(calls, 2, 'retried exactly once');
  assertEqual(res.ok, true, 'the retry succeeded');
});

await checkAsync('send does not retry a real error answer', async () => {
  let calls = 0;
  globalThis.chrome.runtime.sendMessage = (_msg, cb) => {
    calls++;
    cb({ ok: false, error: 'rate_limit' });
  };
  const res = await realSend({ type: 'TREE' }, { timeoutMs: 40, retries: 2 });
  assertEqual(calls, 1, 'a definite answer is not retried');
  assertEqual(res.error, 'rate_limit');
});

await checkAsync('send survives a torn-down extension context', async () => {
  globalThis.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated'); };
  const res = await realSend({ type: 'PING' }, { timeoutMs: 40, retries: 0 });
  assertEqual(res.error, 'invalidated');
});

globalThis.chrome.runtime.sendMessage = () => {};

/* ------------------------------------------------------------ DOM tests */

domCheck('getContext reads repo, ref and OID from the embedded payload', () => {
  installDom(fixtureHtml, FIXTURE_URL);
  const ctx = page.getContext();
  assert(ctx, 'context should be found');
  assertEqual(ctx.owner, 'sindresorhus');
  assertEqual(ctx.repo, 'got');
  assertEqual(ctx.ref, 'main');
  assertEqual(ctx.path, 'source', 'path of the directory on screen');
  assertEqual(ctx.isTree, true);
  assertEqual(ctx.source, 'payload');
  assert(/^[0-9a-f]{40}$/.test(ctx.oid), `oid should be a commit SHA, got ${ctx.oid}`);
  assertEqual(ctx.immutable, true, 'a SHA makes the tree cacheable');
});

domCheck('getContext falls back to meta tags when the payload is gone', () => {
  const stripped = fixtureHtml.replace(
    /<script type="application\/json" data-target="react-app.embeddedData">[\s\S]*?<\/script>/,
    ''
  );
  installDom(stripped, FIXTURE_URL);
  const ctx = page.getContext();
  assert(ctx, 'context should still be found');
  assertEqual(ctx.source, 'dom', 'used the meta/ref-selector fallback');
  assertEqual(ctx.owner, 'sindresorhus');
  assertEqual(ctx.repo, 'got');
  assertEqual(ctx.ref, 'main', 'ref read from the branch picker');
  assertEqual(ctx.path, 'source', 'path derived from the URL minus the ref');
  assertEqual(ctx.immutable, false, 'a branch name must not be cached');
});

domCheck('getContext falls back to the URL when the page tells us nothing', () => {
  installDom('<!doctype html><html><body></body></html>', FIXTURE_URL);
  const ctx = page.getContext();
  assert(ctx, 'context should still be found');
  assertEqual(ctx.source, 'url');
  assertEqual(ctx.owner, 'sindresorhus');
  assertEqual(ctx.repo, 'got');
  assertEqual(ctx.ref, 'main');
  assertEqual(ctx.path, 'source');
});

domCheck('getContext resolves a slashed ref without eating the path', () => {
  const stripped = fixtureHtml
    .replace(/<script type="application\/json" data-target="react-app.embeddedData">[\s\S]*?<\/script>/, '')
    .replace('aria-label="main branch"', 'aria-label="feature/big-refactor branch"');
  installDom(stripped, 'https://github.com/sindresorhus/got/tree/feature/big-refactor/source/core');
  const ctx = page.getContext();
  assertEqual(ctx.ref, 'feature/big-refactor', 'multi-segment ref');
  assertEqual(ctx.path, 'source/core', 'path is what remains after the ref');
});

domCheck('getContext ignores non-code pages', () => {
  installDom(fixtureHtml, 'https://github.com/sindresorhus/got/issues/123');
  assertEqual(page.getContext(), null, 'issues page is not a file listing');
});

domCheck('findListContainer and findSummaryAnchor locate the table', () => {
  installDom(fixtureHtml, FIXTURE_URL);
  const table = page.findListContainer();
  assert(table, 'file table found');
  assertEqual(table.tagName, 'TABLE');
  const anchor = page.findSummaryAnchor();
  assert(anchor, 'summary anchor found');
  assert(anchor.hasAttribute('data-hpc'), 'anchors onto the file-list wrapper');
  assert(anchor.contains(table), 'wrapper contains the table');
});

domCheck('findRows returns real entries with both responsive name cells', () => {
  installDom(fixtureHtml, FIXTURE_URL);
  const ctx = page.getContext();
  const rows = page.findRows(ctx);

  assert(rows.length > 0, 'found some rows');
  for (const row of rows) {
    assertEqual(
      row.hosts.length, 2,
      `${row.name}: expected a small-screen and a large-screen name cell`
    );
    assert(row.path.startsWith('source/'), `${row.name}: path is prefixed with the directory`);
    assert(['dir', 'file'].includes(row.type), `${row.name}: has a type`);
    assert(!row.name.includes('/'), `${row.name}: bare entry name`);
  }
  assert(rows.some((r) => r.type === 'dir'), 'at least one directory');
  assert(rows.some((r) => r.type === 'file'), 'at least one file');
  assert(!rows.some((r) => r.name === '..'), 'the go-to-parent row is skipped');

  const names = rows.map((r) => r.name);
  assertEqual(new Set(names).size, names.length, 'no duplicate rows');
});

domCheck('render injects an aligned bar into every name cell', () => {
  installDom(fixtureHtml, FIXTURE_URL);
  const ctx = page.getContext();
  const rows = page.findRows(ctx);

  // Build a tree matching the fixture, with one obviously bloated file.
  const biggest = rows.find((r) => r.type === 'file');
  const entries = rows.map((r) => ({
    path: r.type === 'dir' ? `${r.path}/index.ts` : r.path,
    type: 'file',
    size: r === biggest ? 40000 : 2000,
    sha: `sha-${r.name}`,
  }));
  const { root, index } = store.buildTree(entries);
  for (const node of index.values()) {
    if (node.type === 'file') node.lines = Math.round(node.size / 32);
  }
  store.rollup(root);

  const state = {
    ctx,
    settings: settings.DEFAULTS,
    status: 'ready',
    root,
    index,
    progress: { done: 0, total: 0 },
  };
  inline.render(state, () => {});

  for (const row of page.findRows(ctx)) {
    const cells = row.el.querySelectorAll('.ghl-cell');
    assertEqual(cells.length, 2, `${row.name}: one bar per responsive name cell`);
    for (const cell of cells) {
      assertEqual(cell.dataset.ghlPath, row.path, 'cell is tagged with its path');
      assert(cell.querySelector('.ghl-bar-fill'), 'cell has a bar');
      assert(cell.querySelector('.ghl-num').textContent.length > 0, 'cell shows a number');
    }
  }

  const bloated = document.querySelector(`.ghl-cell[data-ghl-path="${biggest.path}"]`);
  assertEqual(bloated.dataset.severity, 'danger', 'the 1,250-line file is flagged red');
  // The browser normalises the percentage string, so compare the number.
  assertClose(
    parseFloat(bloated.querySelector('.ghl-bar-fill').style.width), 100, 0.01,
    'largest item fills the bar'
  );

  const summary = document.getElementById(inline.SUMMARY_ID);
  assert(summary, 'summary strip inserted');
  assertEqual(
    summary.nextElementSibling, page.findSummaryAnchor(),
    'summary sits directly above the file list'
  );
  assert(summary.querySelector('.ghl-stack').children.length > 0, 'stacked proportion bar drawn');
});

domCheck('render is idempotent — repeated passes do not duplicate bars', () => {
  installDom(fixtureHtml, FIXTURE_URL);
  const ctx = page.getContext();
  const rows = page.findRows(ctx);
  const { root, index } = store.buildTree(
    rows.map((r) => ({
      path: r.type === 'dir' ? `${r.path}/index.ts` : r.path,
      type: 'file', size: 2000, sha: `sha-${r.name}`,
    }))
  );
  for (const node of index.values()) if (node.type === 'file') node.lines = 60;
  store.rollup(root);

  const state = { ctx, settings: settings.DEFAULTS, status: 'ready', root, index, progress: { done: 0, total: 0 } };
  for (let i = 0; i < 3; i++) inline.render(state, () => {});

  assertEqual(
    document.querySelectorAll('.ghl-cell').length, rows.length * 2,
    'still exactly two cells per row'
  );
  assertEqual(document.querySelectorAll(`#${inline.SUMMARY_ID}`).length, 1, 'one summary strip');
});

domCheck('clearRows and removeSummary leave the page clean', () => {
  installDom(fixtureHtml, FIXTURE_URL);
  const ctx = page.getContext();
  const rows = page.findRows(ctx);
  const { root, index } = store.buildTree(
    rows.map((r) => ({ path: r.type === 'dir' ? `${r.path}/i.ts` : r.path, type: 'file', size: 2000, sha: r.name }))
  );
  for (const node of index.values()) if (node.type === 'file') node.lines = 60;
  store.rollup(root);

  inline.render({ ctx, settings: settings.DEFAULTS, status: 'ready', root, index, progress: { done: 0, total: 0 } }, () => {});
  assert(document.querySelectorAll('.ghl-cell').length > 0, 'cells were injected');

  inline.clearRows();
  inline.removeSummary();
  assertEqual(document.querySelectorAll('.ghl-cell').length, 0, 'no cells left');
  assertEqual(document.querySelectorAll(`#${inline.SUMMARY_ID}`).length, 0, 'no summary left');
});

/* ------------------------------------------- client-side navigation (main) */

/* GitHub navigates without a page load, so the whole UI has to tear down and
   rebuild against a DOM that React swapped out underneath us. That path is the
   easiest thing to get wrong and the hardest to see failing, so drive it here
   with a stubbed transport instead of the live API. */

async function domCheckAsync(name, fn) {
  if (!domReady) { skipped++; return; }
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

const STUB_TREE = [
  { path: 'source', type: 'dir' },
  { path: 'source/create.ts', type: 'file', size: 13000, sha: 'sha-create' },
  { path: 'source/index.ts', type: 'file', size: 900, sha: 'sha-index' },
  { path: 'source/types.ts', type: 'file', size: 11000, sha: 'sha-types' },
  { path: 'source/as-promise', type: 'dir' },
  { path: 'source/as-promise/index.ts', type: 'file', size: 10000, sha: 'sha-ap-index' },
  { path: 'source/as-promise/types.ts', type: 'file', size: 1000, sha: 'sha-ap-types' },
  { path: 'source/core', type: 'dir' },
  { path: 'source/core/options.ts', type: 'file', size: 120000, sha: 'sha-options' },
];

let transportCalls = [];

function stubTransport({ treeDelayMs = 0 } = {}) {
  const calls = [];
  transportCalls = calls;
  globalThis.GHL.util.send = async (msg) => {
    calls.push(msg);
    switch (msg.type) {
      case 'TREE':
        if (treeDelayMs) await sleep(treeDelayMs);
        return { ok: true, entries: STUB_TREE, truncated: false };
      case 'CACHED_LINES':
        return { ok: true, lines: {} };
      case 'LINES': {
        const entry = STUB_TREE.find((e) => e.sha === msg.sha);
        return { ok: true, lines: Math.round((entry ? entry.size : 0) / 30) };
      }
      default:
        return { ok: false, error: 'not_found' };
    }
  };
  return calls;
}

/* Navigates the page the way GitHub's router actually does: new URL, new rows,
   same document — and, crucially, the embedded payload is left untouched. It
   still describes the directory the page was first loaded with. Anything that
   reads the current directory out of that payload will silently label the new
   rows with the old directory's paths. */
function navigateDom(dom, dirPath, entries) {
  const doc = dom.window.document;

  const tbody = doc.querySelector('table[aria-labelledby="folders-and-files"] tbody');
  tbody.textContent = '';

  for (const entry of entries) {
    const kind = entry.type === 'dir' ? 'tree' : 'blob';
    const href = `/sindresorhus/got/${kind}/main/${dirPath}/${entry.name}`;
    const cell = (klass) => `
      <td class="${klass}">
        <div class="react-directory-filename-column">
          <div class="overflow-hidden"><div class="react-directory-filename-cell">
            <div class="react-directory-truncate">
              <a title="${entry.name}" class="Link--primary" href="${href}">${entry.name}</a>
            </div>
          </div></div>
        </div>
      </td>`;
    const tr = doc.createElement('tr');
    tr.className = 'react-directory-row';
    tr.innerHTML =
      cell('react-directory-row-name-cell-small-screen') +
      cell('react-directory-row-name-cell-large-screen') +
      '<td class="react-directory-row-commit-cell"></td><td></td>';
    tbody.appendChild(tr);
  }

  dom.reconfigure({ url: `https://github.com/sindresorhus/got/tree/main/${dirPath}` });
  doc.dispatchEvent(new dom.window.Event('soft-nav:end'));
}

function renderedPaths() {
  return [...new Set(
    [...document.querySelectorAll('.ghl-cell[data-ghl-path]')].map((c) => c.dataset.ghlPath)
  )].sort();
}

await domCheckAsync('the strip shows up while the tree is still in flight', async () => {
  installDom(fixtureHtml, FIXTURE_URL);
  stubTransport({ treeDelayMs: 700 });
  load('src/content/main.js');

  await waitFor(() => document.getElementById(inline.SUMMARY_ID), 3000, 'summary strip');
  assertEqual(renderedPaths().length, 0, 'no bars yet — the tree has not arrived');

  const status = document.querySelector('.ghl-summary-status').textContent;
  assert(/読み込み中/.test(status), `status should report loading, got "${status}"`);
  assert(
    document.querySelector('[data-ghl-action="treemap"]').disabled,
    'treemap button is disabled until there is data'
  );
});

await domCheckAsync('main paints the directory it lands on', async () => {
  await waitFor(() => renderedPaths().length > 0, 6000, 'bars on first paint');

  const paths = renderedPaths();
  assert(paths.includes('source/create.ts'), `expected source/create.ts, got ${paths}`);
  assert(paths.includes('source/core'), 'directories get bars too');
  assert(document.getElementById(inline.SUMMARY_ID), 'summary strip present');
});

await domCheckAsync('the tree is requested by commit SHA, so a new commit refetches', async () => {
  const tree = transportCalls.find((c) => c.type === 'TREE');
  assert(tree, 'a tree request was made');
  assert(
    /^[0-9a-f]{40}$/.test(tree.oid),
    `the tree must be keyed to a commit, not a branch name (got ${tree.oid})`
  );
});

await domCheckAsync('a different commit produces a different context', async () => {
  const other = 'a'.repeat(40);
  const swapped = fixtureHtml.replace(/e3924aa1e53a6ca3eb93a43618ce532442a89b40/g, other);
  const saved = currentDom;

  installDom(swapped, FIXTURE_URL);
  const ctx = page.getContext();
  assertEqual(ctx.oid, other, 'the OID follows the page, so a push changes the cache key');
  assertEqual(ctx.immutable, true, 'still cacheable');

  // Restore the document main.js is bound to before the navigation tests run.
  currentDom = saved;
  globalThis.window = saved.window;
  globalThis.document = saved.window.document;
});

await domCheckAsync('bars re-render after client-side navigation into a subdirectory', async () => {
  navigateDom(currentDom, 'source/as-promise', [
    { name: 'index.ts', type: 'file' },
    { name: 'types.ts', type: 'file' },
  ]);

  await waitFor(
    () => renderedPaths().some((p) => p.startsWith('source/as-promise/')),
    6000,
    'bars for the new directory'
  );

  const paths = renderedPaths();
  assert(
    paths.every((p) => p.startsWith('source/as-promise/')),
    `only the new directory's rows should be marked, got ${paths}`
  );
  assertEqual(paths.length, 2, 'both entries got a bar');
  assertEqual(
    document.querySelectorAll(`#${inline.SUMMARY_ID}`).length, 1,
    'exactly one summary strip after navigating'
  );
});

await domCheckAsync('navigating back up rebuilds the parent view', async () => {
  navigateDom(currentDom, 'source', [
    { name: 'as-promise', type: 'dir' },
    { name: 'core', type: 'dir' },
    { name: 'create.ts', type: 'file' },
    { name: 'index.ts', type: 'file' },
    { name: 'types.ts', type: 'file' },
  ]);

  await waitFor(
    () => renderedPaths().includes('source/create.ts'),
    6000,
    'bars for the parent directory'
  );

  const paths = renderedPaths();
  assertEqual(paths.length, 5, `all five rows painted, got ${paths}`);
  assert(!paths.some((p) => p.startsWith('source/as-promise/')), 'stale child rows are gone');
});

await domCheckAsync('leaving the file list tears the UI down', async () => {
  currentDom.reconfigure({ url: 'https://github.com/sindresorhus/got/issues' });
  currentDom.window.document.dispatchEvent(new currentDom.window.Event('soft-nav:end'));

  await waitFor(() => renderedPaths().length === 0, 5000, 'bars to be removed');
  assertEqual(
    document.querySelectorAll(`#${inline.SUMMARY_ID}`).length, 0,
    'summary strip removed too'
  );
});

/* ---------------------------------------------------------------- report */

for (const f of failures) console.error(`FAIL  ${f.name}\n      ${f.message}`);
console.log(
  `\n${passed} passed, ${failures.length} failed` + (skipped ? `, ${skipped} skipped` : '')
);
process.exit(failures.length ? 1 : 0);
