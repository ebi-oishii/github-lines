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
  // jsdom lays nothing out. Table cells report a height, since the column head
  // asks for one — unless the row is marked collapsed, as GitHub's repository
  // root renders its header row.
  w.HTMLTableCellElement.prototype.getBoundingClientRect = function () {
    const collapsed = this.closest('thead')?.hasAttribute('data-test-collapsed');
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: collapsed ? 0 : 100, height: collapsed ? 0 : 40 };
  };
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

/* The catalogue the extension would resolve to. Tests run against the default
   locale, and assert through `msg()` rather than against literal text, so they
   say what the UI means instead of what one translation of it reads. */
const MESSAGES = JSON.parse(
  fs.readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8')
);

globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {} },
  },
  runtime: { sendMessage() {}, lastError: null },
  i18n: {
    getMessage(key, subs) {
      const entry = MESSAGES[key];
      if (!entry) return '';
      const list = Array.isArray(subs) ? subs : (subs === undefined ? [] : [subs]);
      return entry.message.replace(/\$(\d)/g, (_, i) => list[Number(i) - 1] ?? '');
    },
  },
};

const msg = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));

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
  'src/lib/i18n.js',
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

check('rollup carries the largest file up the tree', () => {
  const { root, index } = store.buildTree([
    { path: 'a/small.ts', type: 'file', size: 100, sha: 's1' },
    { path: 'a/deep/big.ts', type: 'file', size: 100, sha: 's2' },
    { path: 'b/mid.ts', type: 'file', size: 100, sha: 's3' },
    { path: 'b/blob.png', type: 'file', size: 100, sha: 's4' },
  ]);
  index.get('a/small.ts').lines = 40;
  index.get('a/deep/big.ts').lines = 900;
  index.get('b/mid.ts').lines = 120;
  index.get('b/blob.png').lines = 5000;
  index.get('b/blob.png').excluded = true;
  store.rollup(root);

  assertEqual(index.get('a').maxFile, 900, 'a directory reports its worst descendant, however deep');
  assertEqual(index.get('a/deep').maxFile, 900, 'including the one that holds it');
  assertEqual(index.get('b').maxFile, 120, 'an excluded file is not a file for this purpose');
  assertEqual(root.maxFile, 900, 'and the root sees the worst of all');
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

/* ------------------------------------------------------------ catalogues */

/* The two catalogues are edited by hand and read by Chrome, which fails
   silently: a missing key renders as an empty string, and a placeholder that
   one locale has and the other does not drops a number out of a sentence in
   just that language. */

const LOCALES = ['en', 'ja'];
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [
  l, JSON.parse(fs.readFileSync(path.join(ROOT, `_locales/${l}/messages.json`), 'utf8')),
]));

const placeholdersIn = (s) => [...new Set((s.match(/\$\d/g) || []))].sort().join(',');

check('every locale carries the same keys', () => {
  const [a, b] = LOCALES;
  const missing = Object.keys(CATALOGUES[a]).filter((k) => !CATALOGUES[b][k]);
  const extra = Object.keys(CATALOGUES[b]).filter((k) => !CATALOGUES[a][k]);
  assertEqual(missing.join(', '), '', `keys missing from ${b}`);
  assertEqual(extra.join(', '), '', `keys missing from ${a}`);
});

check('no message is empty, and the placeholders line up across locales', () => {
  for (const [key, entry] of Object.entries(CATALOGUES.en)) {
    assert(entry.message.trim().length > 0, `${key} is empty in en`);
    const other = CATALOGUES.ja[key];
    assert(other && other.message.trim().length > 0, `${key} is empty in ja`);
    assertEqual(placeholdersIn(other.message), placeholdersIn(entry.message),
      `${key} takes different substitutions in ja`);
  }
});

check('every key the extension asks for exists', () => {
  const sources = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(js|html)$/.test(name)) sources.push(full);
    }
  })(path.join(ROOT, 'src'));
  sources.push(path.join(ROOT, 'manifest.json'));

  const asked = new Map(); // key -> where it was asked for
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    const where = path.relative(ROOT, file);
    for (const [, key] of text.matchAll(/\bt\('([A-Za-z][\w]*)'/g)) asked.set(key, where);
    for (const [, key] of text.matchAll(/\bcount\('([A-Za-z][\w]*)'/g)) {
      asked.set(key, where);
      asked.set(`${key}One`, where); // count() declines by appending One
    }
    for (const [, key] of text.matchAll(/data-i18n(?:-\w+)?="([A-Za-z][\w]*)"/g)) asked.set(key, where);
    for (const [, key] of text.matchAll(/__MSG_([A-Za-z][\w]*)__/g)) asked.set(key, where);
  }

  assert(asked.size > 40, `the scan found the call sites (${asked.size})`);
  const unknown = [...asked].filter(([key]) => !CATALOGUES.en[key])
    .map(([key, where]) => `${key} (${where})`);
  assertEqual(unknown.join(', '), '', 'keys asked for but not in the catalogue');
});

/* --------------------------------------------------------- colour ramp */

/* The light-theme tokens the ramp falls back to, as hues. */
const HUE_OK = 212.4;
const HUE_WARN = 42.4;
const HUE_DANGER = 355.8;
const THRESHOLDS = { warnLines: 500, dangerLines: 800 };

function hueOf(colour) {
  const m = /^hsl\(([\d.]+) /.exec(colour);
  if (!m) throw new Error(`not an hsl colour: ${colour}`);
  return Number(m[1]);
}

function lightnessOf(colour) {
  const m = /^hsl\([\d.]+ [\d.]+% ([\d.]+)%/.exec(colour);
  if (!m) throw new Error(`not an hsl colour: ${colour}`);
  return Number(m[1]);
}

function near(a, b, tol, what) {
  assert(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);
}

check('the ramp lands on the tokens at zero and at each threshold', () => {
  near(hueOf(inline.lineColor(0, THRESHOLDS)), HUE_OK, 1, 'zero lines');
  near(hueOf(inline.lineColor(500, THRESHOLDS)), HUE_WARN, 1, 'the warn threshold');
  near(hueOf(inline.lineColor(800, THRESHOLDS)), HUE_DANGER, 1, 'the danger threshold');
});

check('the ramp is continuous between them and clamps above', () => {
  const mid = hueOf(inline.lineColor(250, THRESHOLDS));
  assert(mid < HUE_OK && mid > HUE_WARN, `half way to the warn threshold sits between the two hues (got ${mid})`);
  const late = hueOf(inline.lineColor(650, THRESHOLDS));
  assert(late < HUE_WARN, `past it the ramp keeps descending towards red (got ${late})`);
  assertEqual(inline.lineColor(5000, THRESHOLDS), inline.lineColor(800, THRESHOLDS),
    'everything past the danger threshold is the same red');
});

check('the ramp follows the configured thresholds', () => {
  const tight = { warnLines: 50, dangerLines: 80 };
  near(hueOf(inline.lineColor(50, tight)), HUE_WARN, 1, 'a warn threshold of 50 lines');
  assertEqual(inline.lineColor(80, tight), inline.lineColor(800, THRESHOLDS), 'danger is the same red either way');
  // Thresholds the wrong way round must not divide by zero or go backwards.
  const inverted = { warnLines: 900, dangerLines: 100 };
  assert(/^hsl\(/.test(inline.lineColor(500, inverted)), 'an inverted pair still yields a colour');
});

check('lineColor carries an alpha, and rampStops spans the ramp', () => {
  assert(/ \/ 0.55\)$/.test(inline.lineColor(100, THRESHOLDS, 0.55)), 'alpha is passed through');
  const stops = inline.rampStops(THRESHOLDS, 4);
  assertEqual(stops.length, 5, 'one stop more than the steps asked for');
  assert(stops[0].endsWith(' 0%') && stops[4].endsWith(' 100%'), 'running end to end');
  near(hueOf(stops[0]), HUE_OK, 1, 'the first stop');
  near(hueOf(stops[4]), HUE_DANGER, 1, 'the last stop');
});

check('directories ramp in violet, on the largest file inside them', () => {
  const none = inline.dirColor(0, THRESHOLDS);
  const some = inline.dirColor(500, THRESHOLDS);
  const bad = inline.dirColor(800, THRESHOLDS);

  for (const [colour, what] of [[none, 'empty'], [some, 'at warn'], [bad, 'at danger']]) {
    const h = hueOf(colour);
    assert(h > 240 && h < 290, `a directory stays violet, never a file's hue (${what}: ${h})`);
  }
  // Light theme: deeper as the worst file grows. The dark tokens run the other
  // way, which is why the direction is not what is asserted — the distance is.
  assert(lightnessOf(none) > lightnessOf(some) && lightnessOf(some) > lightnessOf(bad),
    'and deepens with it');
  assertEqual(inline.dirColor(99999, THRESHOLDS), bad, 'past danger every directory is the same');
  assertEqual(inline.dirColor(500, THRESHOLDS), inline.dirColor(50, { warnLines: 50, dangerLines: 80 }),
    'the thresholds place it, so a tighter pair shifts the same colour earlier');
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

check('settings: the exact-lines boolean migrates, and only it', () => {
  assertEqual(settings.normalise({ fetchExactLines: false }).exactLinesMode, 'off');
  assertEqual(settings.normalise({ fetchExactLines: true }).exactLinesMode, 'auto',
    'someone who had it on keeps the fetching they had');
  assertEqual(settings.normalise({ fetchExactLines: false }).fetchExactLines, undefined,
    'the old field is dropped');

  // A config carrying neither key is a new install, not a migration.
  assertEqual(settings.normalise({}).exactLinesMode, 'manual', 'never configured');
  assertEqual(settings.normalise(undefined).exactLinesMode, 'manual', 'nothing stored at all');
});

check('settings: an unknown exact-lines mode falls back to the default', () => {
  assertEqual(settings.normalise({ exactLinesMode: 'nonsense' }).exactLinesMode, 'manual');
  for (const mode of ['auto', 'manual', 'off']) {
    assertEqual(settings.normalise({ exactLinesMode: mode }).exactLinesMode, mode);
  }
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
  inline.render(state, {});

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
  for (let i = 0; i < 3; i++) inline.render(state, {});

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

  inline.render({ ctx, settings: settings.DEFAULTS, status: 'ready', root, index, progress: { done: 0, total: 0 } }, {});
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
let stubTreeCached = false; // whether a cache-only TREE probe hits

function stubTransport({ treeDelayMs = 0 } = {}) {
  const calls = [];
  transportCalls = calls;
  globalThis.GHL.util.send = async (msg) => {
    calls.push(msg);
    switch (msg.type) {
      case 'TREE':
        if (msg.cacheOnly && !stubTreeCached) return { ok: false, error: 'not_cached' };
        if (treeDelayMs) await sleep(treeDelayMs);
        return { ok: true, entries: STUB_TREE, truncated: false };
      case 'CACHED_LINES':
        return { ok: true, lines: {} };
      case 'LOCALE': {
        const file = path.join(ROOT, `_locales/${msg.locale}/messages.json`);
        if (!fs.existsSync(file)) return { ok: false, error: 'unknown_locale' };
        return { ok: true, messages: JSON.parse(fs.readFileSync(file, 'utf8')) };
      }
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

/* These are about the render path, so they run in the mode that fetches
   without being asked. Manual — the default, and what most of the rest of this
   file exercises — comes after them. */
await domCheckAsync('the strip shows up while the tree is still in flight', async () => {
  installDom(fixtureHtml, FIXTURE_URL);
  stubTransport({ treeDelayMs: 700 });
  await settings.set({ exactLinesMode: 'auto' });
  load('src/content/main.js');

  await waitFor(() => document.getElementById(inline.SUMMARY_ID), 3000, 'summary strip');
  assertEqual(renderedPaths().length, 0, 'no bars yet — the tree has not arrived');

  const status = document.querySelector('.ghl-summary-status').textContent;
  assertEqual(status, msg('statusLoading'), 'the status reports loading');
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

const fetchButton = () => document.querySelector('[data-ghl-action="fetch"]');
const metricButton = (key) => document.querySelector(`[data-ghl-metric="${key}"]`);
/* TREE requests that would hit the API — manual mode's cache-only probes do not count. */
const treeFetches = (calls) => calls.filter((c) => c.type === 'TREE' && !c.cacheOnly);

/* Manual mode from idle: fetch the tree via the size reading of the button,
   then flip the toggle back to lines so the count button is on offer. */
async function loadTreeViaSizes() {
  await waitFor(() => { const b = fetchButton(); return b && !b.hidden; }, 6000, 'the fetch button');
  metricButton('bytes').click();
  await waitFor(() => fetchButton().textContent === msg('fetchSizes'), 3000, 'the button to offer sizes');
  fetchButton().click();
  await waitFor(() => renderedPaths().length > 0, 6000, 'the tree');
  metricButton('lines').click();
}

const rowPick = (path) => document.querySelector(`.ghl-row-pick[data-ghl-path="${path}"]`);

function tick(path, on) {
  const pick = rowPick(path);
  pick.checked = on;
  pick.dispatchEvent(new currentDom.window.Event('change', { bubbles: true }));
}

await domCheckAsync('manual mode fetches nothing — not even the tree — until asked', async () => {
  await settings.set({ exactLinesMode: 'manual' });
  assertEqual(settings.DEFAULTS.exactLinesMode, 'manual', 'which is what a new install gets');
  const before = transportCalls.length;

  navigateDom(currentDom, 'source/core', [{ name: 'options.ts', type: 'file' }]);
  await waitFor(() => { const b = fetchButton(); return b && !b.hidden; }, 6000, 'the fetch button');

  assertEqual(treeFetches(transportCalls.slice(before)).length, 0, 'no tree request on open');
  assert(transportCalls.slice(before).some((c) => c.type === 'TREE' && c.cacheOnly), 'only the cache was asked');
  assertEqual(renderedPaths().length, 0, 'no bars yet');
  const idlePicks = [...document.querySelectorAll('.ghl-row-pick[data-pick="on"]')];
  assertEqual(new Set(idlePicks.map((p) => p.dataset.ghlPath)).size, 1, 'the row already has its checkbox');
  assert(idlePicks.every((p) => p.checked), 'ticked by default');
  const host = idlePicks[0].parentElement;
  assert(host.firstElementChild === idlePicks[0], 'the checkbox leads the name cell');
  const heads = [...document.querySelectorAll('.ghl-col-head')];
  assertEqual(heads.length, 2, 'one head per "Name" header cell (small and large screen)');
  const head = heads[0];
  assert(head.parentElement.tagName === 'TH' && /^Name$/.test(head.parentElement.textContent.trim()) &&
    head.parentElement.firstChild === head, 'the icon heads the column from the "Name" header cell');
  assert(head.querySelector('.ghl-icon svg'), 'and it is the extension icon');
  const headAll = head.querySelector('[data-ghl-action="pick-all"]');
  assert(headAll && headAll.checked && !headAll.indeterminate, 'with the all-rows checkbox under it, ticked');
  assert(document.querySelector('.ghl-pick-all').hidden, "the strip's fallback all-rows toggle stays hidden while the head has one");
  assert(!document.querySelector('.ghl-metric').hidden, 'the metric toggle is up, saying what the button fetches');
  assertEqual(metricButton('lines').getAttribute('aria-pressed'), 'true', 'it opens on lines');
  assertEqual(fetchButton().textContent, msg('fetchLines'), 'the button reads the toggle');
  assert(fetchButton().classList.contains('ghl-btn-primary') && !fetchButton().disabled, 'primary for lines');
  assert(!/\d/.test(fetchButton().textContent), `no count before the tree is known (${fetchButton().textContent})`);

  metricButton('bytes').click();
  await waitFor(() => fetchButton().textContent === msg('fetchSizes'), 3000, 'the button to follow the toggle');
  assert(!fetchButton().classList.contains('ghl-btn-primary'), 'plain for sizes');
  const status = document.querySelector('.ghl-summary-status').textContent;
  assertEqual(status, msg('statusIdle'), 'the status says nothing has been fetched');
});

await domCheckAsync('pressing the size button fetches the tree and shows sizes', async () => {
  const before = transportCalls.length;
  fetchButton().click();
  // The strip must not blink while the tree is in flight: same controls, same places.
  assert(!document.querySelector('.ghl-metric').hidden, 'the toggle stays up while loading');
  assert(!fetchButton().hidden && fetchButton().textContent === msg('fetchBusy'),
    `the button reads as busy (${fetchButton().textContent})`);
  assert(document.querySelectorAll('.ghl-col-head').length === 2, 'the column head stays');
  await waitFor(
    () => renderedPaths().includes('source/core/options.ts'),
    6000,
    'bars for the new directory'
  );

  assertEqual(treeFetches(transportCalls.slice(before)).length, 1, 'exactly one tree request');
  const fetched = transportCalls.slice(before).filter((c) => c.type === 'LINES');
  assertEqual(fetched.length, 0, 'no line counts fetched without being asked');
  assert(!fetchButton().hidden && fetchButton().disabled && fetchButton().textContent === msg('fetchDone'),
    `nothing left to fetch for sizes: the button stays put, disabled, as done (${fetchButton().textContent})`);

  const cell = document.querySelector('.ghl-cell[data-ghl-path="source/core/options.ts"]');
  assertEqual(cell.querySelector('.ghl-num').textContent, '117.2 KB', 'the row shows its size');
  assertEqual(cell.dataset.severity, 'ok', 'no threshold colouring on sizes');
  assertEqual(cell.querySelector('.ghl-bar-fill').style.background, '',
    'and no ramp either — bytes have no thresholds to ramp between');
  assertEqual(metricButton('bytes').getAttribute('aria-pressed'), 'true', 'the toggle says size');
  const stats = document.querySelector('.ghl-summary-stats').textContent;
  assert(/117\.2 KB/.test(stats), `the strip totals in bytes too (${stats})`);
});

await domCheckAsync('flipping the toggle to lines shows estimates and offers the count button, fetching nothing', async () => {
  const before = transportCalls.length;
  metricButton('lines').click();
  await waitFor(
    () => {
      const cell = document.querySelector('.ghl-cell[data-ghl-path="source/core/options.ts"]');
      return cell && cell.querySelector('.ghl-num').textContent.startsWith('~');
    },
    3000,
    'the estimate to show'
  );
  assertEqual(metricButton('lines').getAttribute('aria-pressed'), 'true', 'the toggle says lines');
  assertEqual(transportCalls.length, before, 'switching the view fetches nothing');
  const bar = document.querySelector('.ghl-cell[data-ghl-path="source/core/options.ts"] .ghl-bar-fill');
  assert(/^(hsl|rgb)a?\(/.test(bar.style.background), `the bar takes its colour from the ramp (${bar.style.background})`);
  const dirBar = document.querySelector('.ghl-cell[data-state="dir"] .ghl-bar-fill');
  if (dirBar) assert(/^(hsl|rgb)a?\(/.test(dirBar.style.background), 'directories are coloured too');

  const button = fetchButton();
  assert(button && !button.hidden, 'the fetch button is offered');
  assertEqual(button.textContent, msg('fetchLinesCount', 1), 'the button is labelled with what it will fetch');
});

await domCheckAsync('pressing the button fetches, and the estimate becomes exact', async () => {
  const before = transportCalls.length;
  document.querySelector('[data-ghl-action="fetch"]').click();

  await waitFor(
    () => {
      const cell = document.querySelector('.ghl-cell[data-ghl-path="source/core/options.ts"]');
      return cell && !cell.querySelector('.ghl-num').textContent.startsWith('~');
    },
    6000,
    'the estimate to be replaced'
  );

  const fetched = transportCalls.slice(before).filter((c) => c.type === 'LINES');
  assertEqual(fetched.length, 1, 'exactly the queued file was fetched');

  const button = document.querySelector('[data-ghl-action="fetch"]');
  assert(!button.hidden && button.disabled && button.textContent === msg('fetchDone'),
    `the button stays put, disabled, as done (${button.textContent})`);
  const pick = rowPick('source/core/options.ts');
  assert(pick && pick.dataset.pick === 'on' && !pick.disabled && pick.checked, 'the checkbox stays, live');
  const headAll = document.querySelector('.ghl-col-head [data-ghl-action="pick-all"]');
  assert(headAll && !headAll.disabled && headAll.checked, 'so does the column head');
});

await domCheckAsync('rows unticked before anything is fetched are left out of a cold-start fetch', async () => {
  const before = transportCalls.length;
  navigateDom(currentDom, 'source/as-promise', [
    { name: 'index.ts', type: 'file' },
    { name: 'types.ts', type: 'file' },
  ]);
  await waitFor(() => { const b = fetchButton(); return b && !b.hidden; }, 6000, 'the fetch button');
  await waitFor(() => rowPick('source/as-promise/types.ts'), 3000, 'idle checkboxes');
  assertEqual(fetchButton().textContent, msg('fetchLines'), 'a fresh view opens on lines');

  tick('source/as-promise/types.ts', false);
  await waitFor(() => document.querySelector('.ghl-col-head [data-ghl-action="pick-all"]').indeterminate, 3000, 'the all-rows box to go indeterminate');
  fetchButton().click();

  await waitFor(
    () => {
      const cell = document.querySelector('.ghl-cell[data-ghl-path="source/as-promise/index.ts"] .ghl-num');
      return cell && /^\d/.test(cell.textContent);
    },
    6000,
    'an exact count without a separate sizes step'
  );
  assertEqual(treeFetches(transportCalls.slice(before)).length, 1, 'one tree request');
  assertEqual(
    transportCalls.slice(before).filter((c) => c.type === 'LINES').map((c) => c.sha).join(' '),
    'sha-ap-index',
    'only the ticked file was fetched'
  );
  assert(!fetchButton().hidden && fetchButton().disabled, 'the unticked leftover keeps the button up, disabled');
  assertEqual(metricButton('lines').getAttribute('aria-pressed'), 'true', 'asking for counts shows counts');
  assert(document.querySelector('.ghl-col-head'), 'the column head stays while checkboxes are offered');
});

await domCheckAsync('manual mode puts a ticked checkbox on every row with something to fetch', async () => {
  navigateDom(currentDom, 'source', [
    { name: 'as-promise', type: 'dir' },
    { name: 'core', type: 'dir' },
    { name: 'create.ts', type: 'file' },
    { name: 'index.ts', type: 'file' },
    { name: 'types.ts', type: 'file' },
  ]);
  await loadTreeViaSizes();
  await waitFor(
    () => fetchButton() && !fetchButton().hidden && renderedPaths().includes('source/create.ts'),
    6000,
    'the fetch button for the parent directory'
  );

  assert(/6/.test(fetchButton().textContent),
    `the count covers files in subdirectories too (${fetchButton().textContent})`);

  const picked = [...document.querySelectorAll('.ghl-row-pick[data-pick="on"]')];
  assertEqual(new Set(picked.map((p) => p.dataset.ghlPath)).size, 5, 'every row offers a checkbox');
  assert(picked.every((p) => p.checked), 'all ticked by default');
});

await domCheckAsync('unticking a row takes its files out of the count', async () => {
  tick('source/core', false);
  await waitFor(() => /5/.test(fetchButton().textContent), 3000, "the directory's file leaving the count");
  assert(
    [...document.querySelectorAll('.ghl-row-pick[data-ghl-path="source/core"]')].every((p) => !p.checked),
    'both name cells of the row show it unticked'
  );
  assertEqual(document.querySelector('.ghl-cell[data-ghl-path="source/core"]').dataset.state, 'off',
    'the unticked row loses its bar and number');
  assert(document.querySelector('.ghl-summary-stats').textContent.includes(msg('unitFiles', 5)),
    `the strip counts only the ticked rows (${document.querySelector('.ghl-summary-stats').textContent})`);

  tick('source/create.ts', false);
  await waitFor(() => /4/.test(fetchButton().textContent), 3000, 'the file leaving the count');
  assert(document.querySelector('.ghl-summary-stats').textContent.includes(msg('unitFiles', 4)),
    'and follows the second untick');
});

await domCheckAsync('pressing the button fetches only the ticked rows', async () => {
  const before = transportCalls.length;
  fetchButton().click();
  await waitFor(
    () => transportCalls.slice(before).filter((c) => c.type === 'LINES').length >= 4 &&
      fetchButton().textContent !== msg('fetchBusy'),
    6000,
    'the fetch to finish'
  );

  const fetched = transportCalls.slice(before).filter((c) => c.type === 'LINES').map((c) => c.sha).sort();
  assertEqual(fetched.join(' '), 'sha-ap-index sha-ap-types sha-index sha-types',
    'nothing from core/ or create.ts was requested');

  const button = fetchButton();
  assert(!button.hidden && button.disabled && /0/.test(button.textContent),
    `the button stays for the unticked leftovers, disabled with nothing picked (${button.textContent})`);
  const done = rowPick('source/index.ts');
  assert(done.dataset.pick === 'on' && !done.disabled && done.checked, 'a fetched row keeps its checkbox, live');
  const stats = document.querySelector('.ghl-summary-stats').textContent;
  assert(stats.startsWith(msg('unitLines', '763')) && stats.includes(msg('unitFiles', 4)),
    `the total is over the ticked rows only, and exact (${stats})`);

  tick('source/core', true);
  await waitFor(() => !fetchButton().disabled, 3000, 'the button to re-enable');
  assert(/1/.test(fetchButton().textContent), `re-ticking brings its file back (${fetchButton().textContent})`);
});

await domCheckAsync("the column head's checkbox ticks or unticks every row at once", async () => {
  const all = document.querySelector('.ghl-col-head [data-ghl-action="pick-all"]');
  assert(all, 'the all-rows checkbox is offered');
  assert(all.indeterminate && !all.checked, 'a mixed selection shows as indeterminate');

  all.click();
  await waitFor(() => /2/.test(fetchButton().textContent), 3000, 'every leftover row to be ticked');
  assert(all.checked && !all.indeterminate, 'fully ticked');

  all.click();
  await waitFor(() => fetchButton().disabled, 3000, 'the button to disable with nothing ticked');
  assert(!all.checked && !all.indeterminate, 'fully unticked');
  assert(
    [...document.querySelectorAll('.ghl-row-pick[data-pick="on"]')].every((p) => !p.checked),
    'every row follows'
  );
  assertEqual(document.querySelectorAll('.ghl-cell[data-state="off"]').length, 10, 'and every bar is gone (two cells a row)');

  all.click();
  await waitFor(() => /2/.test(fetchButton().textContent), 3000, 'back to all ticked');
});

await domCheckAsync('on the repository root, where the header row has no height, the head moves to the latest-commit box', async () => {
  const table = document.querySelector('table[aria-labelledby="folders-and-files"]');
  table.tHead.setAttribute('data-test-collapsed', '');
  const box = document.createElement('div');
  box.setAttribute('data-testid', 'latest-commit');
  box.innerHTML = '<div class="avatar">author</div>';
  table.parentElement.insertBefore(box, table);

  tick('source/core', false);
  await waitFor(() => box.firstElementChild?.classList.contains('ghl-col-head'), 3000, 'the head to move into the box');
  assertEqual(document.querySelectorAll('.ghl-col-head').length, 1, 'and to leave the header cells');
  assert(document.querySelector('#ghl-summary .ghl-pick-all').hidden, "the strip's copy stays hidden");
  assert(box.querySelector('[data-ghl-action="pick-all"]').indeterminate, 'mirroring the rows');

  box.remove();
  table.tHead.removeAttribute('data-test-collapsed');
  tick('source/core', true);
  await waitFor(() => document.querySelectorAll('thead th > .ghl-col-head').length === 2, 3000, 'the head to return to the header cells');
});

await domCheckAsync('without a table header the all-rows checkbox falls back to the strip', async () => {
  document.querySelector('table[aria-labelledby="folders-and-files"] thead').remove();
  tick('source/core', false);
  await waitFor(() => !document.querySelector('.ghl-col-head'), 3000, 'the head to go');
  const strip = document.querySelector('#ghl-summary .ghl-pick-all');
  assert(!strip.hidden, "the strip's copy shows");
  const box = strip.querySelector('[data-ghl-action="pick-all"]');
  assert(box.indeterminate, 'and mirrors the rows');
  box.click();
  await waitFor(() => /2/.test(fetchButton().textContent), 3000, 'it drives the rows too');
});

await domCheckAsync('a commit already in the cache shows in manual mode without a press', async () => {
  stubTreeCached = true;
  const before = transportCalls.length;
  navigateDom(currentDom, 'source/core', [{ name: 'options.ts', type: 'file' }]);
  await waitFor(() => renderedPaths().includes('source/core/options.ts'), 6000, 'bars without pressing anything');

  const trees = transportCalls.slice(before).filter((c) => c.type === 'TREE');
  assert(trees.length >= 1 && trees.every((c) => c.cacheOnly), 'the tree was only ever asked for from the cache');
  assertEqual(transportCalls.slice(before).filter((c) => c.type === 'LINES').length, 0, 'and no counts were fetched');
  assertEqual(fetchButton().textContent, msg('fetchLinesCount', 1),
    'the count button is on offer for what is not cached');
  stubTreeCached = false;
});

await domCheckAsync('a pinned locale replaces every label, and clearing it hands them back', async () => {
  const ja = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/ja/messages.json'), 'utf8'));

  await settings.set({ locale: 'ja' });
  await GHL.i18n.load();
  assertEqual(inline.METRICS.lines.label, ja.metricLines.message, 'the metric toggle speaks the chosen language');
  assertEqual(GHL.t('fetchLinesCount', 3), ja.fetchLinesCount.message.replace('$1', '3'),
    'and so do the substituted ones');

  await settings.set({ locale: '' });
  await GHL.i18n.load();
  assertEqual(inline.METRICS.lines.label, msg('metricLines'), 'clearing it follows the browser again');

  await settings.set({ locale: 'kl' });
  assertEqual((await settings.get()).locale, '', 'a locale with no catalogue is not a setting');
});

await domCheckAsync('off mode never fetches and offers no button', async () => {
  await settings.set({ exactLinesMode: 'off' });
  const before = transportCalls.length;

  navigateDom(currentDom, 'source/as-promise', [
    { name: 'index.ts', type: 'file' },
    { name: 'types.ts', type: 'file' },
  ]);
  await waitFor(
    () => renderedPaths().some((p) => p.startsWith('source/as-promise/')),
    6000,
    'bars for the new directory'
  );

  const fetched = transportCalls.slice(before).filter((c) => c.type === 'LINES');
  assertEqual(fetched.length, 0, 'nothing fetched');
  assert(document.querySelector('[data-ghl-action="fetch"]').hidden, 'no button offered');
  assert(!document.querySelector('.ghl-col-head'), 'no column head without checkboxes');
  assert(!document.querySelector('.ghl-row-pick:not([data-pick="none"])'), 'no checkboxes outside manual mode');

  await settings.set({ exactLinesMode: 'auto' });
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
