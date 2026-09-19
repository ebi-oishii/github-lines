/* End-to-end smoke test: loads the unpacked extension into a real Chrome,
   opens a GitHub directory, and checks that bars and the treemap actually
   render. Unlike scripts/test.mjs this exercises the service worker, the
   GitHub API calls and the CSS.

   Costs roughly 30 GitHub API requests per run — half the unauthenticated
   hourly budget — so either run it sparingly or export a token:

     GITHUB_TOKEN=$(gh auth token) node scripts/smoke.mjs

   With a token it also configures a second, invalid token as the default, so a
   regression in per-owner token routing fails the run.

   Usage: node scripts/smoke.mjs [url]
          node scripts/smoke.mjs --headed   (watch it happen)
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'tests', 'screenshots');
const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const MANUAL = args.includes('--manual'); // exercise the press-a-button mode
const TARGET_URL = args.find((a) => a.startsWith('http')) ||
  'https://github.com/sindresorhus/got/tree/main/source';

const CHROME_CANDIDATES = [
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1229/chrome-mac-arm64',
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  ),
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('No Chrome found. Install Chrome or Playwright browsers.');
  return hit;
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghl-smoke-'));
fs.mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
let skips = 0;

function assert(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
}

function assertDocLang(lang) {
  assert(lang === msg('lang'), `the options page declares its language (${lang})`);
}

function skip(name) {
  console.log(`skip  ${name}`);
  skips++;
}

/* Chrome resolves the catalogue from its own UI language — which it takes from
   the OS, not from a flag — so the run asks the extension which one it landed
   on and asserts through that. Otherwise every check here would be testing one
   translation, and would fail on a machine set to the other. */
let MESSAGES = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));
const msg = (key, ...subs) =>
  (MESSAGES[key] ? MESSAGES[key].message : key).replace(/\$(\d)/g, (_, i) => subs[Number(i) - 1] ?? '');

/* Still working on it — none of these is a resting state. The trailing
   placeholders are trimmed off, leaving a prefix to match on. */
const busyPrefixes = () => ['fetchBusy', 'statusLoading', 'statusEstimating', 'statusRefining']
  .map((key) => msg(key, '', '').replace(/[\s/…]+$/, '').trim())
  .filter(Boolean);

const RATE_LIMITED = /rate limit|レート制限/i;

const context = await chromium.launchPersistentContext(profile, {
  executablePath: findChrome(),
  headless: !HEADED,
  viewport: { width: 1440, height: 950 },
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const page = context.pages()[0] || (await context.newPage());
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;

  // Which catalogue the extension resolved to, asked of the extension itself.
  const locale = await worker.evaluate(() => chrome.i18n.getMessage('lang'));
  if (locale && locale !== 'en') {
    MESSAGES = JSON.parse(fs.readFileSync(path.join(ROOT, `_locales/${locale}/messages.json`), 'utf8'));
  }
  console.log(`extension locale: ${locale}`);

  // The catalogue's own wording for "still working", for the waits below.
  await context.addInitScript(([busy, verifying]) => {
    window.__ghlBusy = busy;
    window.__ghlVerifying = verifying;
  }, [busyPrefixes(), msg('verifying')]);

  // Feed the extension a token if one is in the environment, by driving its own
  // options page — the same path a user takes.
  //
  // Two tokens are configured on purpose: the real one scoped to the owner
  // under test, and a deliberately invalid one as the default. If per-owner
  // routing regresses, the run picks the invalid default and fails loudly
  // instead of quietly passing.
  if (process.env.GITHUB_TOKEN) {
    const owner = new URL(TARGET_URL).pathname.split('/').filter(Boolean)[0];

    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await page.fill('.token-row:nth-child(1) .token-value', process.env.GITHUB_TOKEN);

    // Owner auto-discovery: asks GitHub which owners this token can reach.
    await page.click('.token-row:nth-child(1) .token-verify');
    await page.waitForFunction(
      () => {
        const s = document.querySelector('.token-row:nth-child(1) .token-status');
        return s && s.textContent && s.textContent !== window.__ghlVerifying;
      },
      null, { timeout: 20000 }
    );
    const verdict = await page.$eval('.token-row:nth-child(1) .token-status', (n) => `${n.dataset.tone}|${n.textContent}`);
    const discovered = await page.$eval('.token-row:nth-child(1) .token-owners', (n) => n.value);
    const autoLabel = await page.$eval('.token-row:nth-child(1) .token-label', (n) => n.value);

    // The tone is the verdict: `ok` (or `warn`, for a write-capable token)
    // means it identified the account behind the token.
    assert(/^(ok|warn)\|\S/.test(verdict), `verify identified the token (${verdict.split('|')[0]})`);
    assert(discovered.trim().length > 0, `owners were auto-filled (${discovered})`);
    assert(autoLabel.trim().length > 0, `label was auto-filled (${autoLabel})`);

    // Now point it at the repo under test so routing can be exercised.
    await page.fill('.token-row:nth-child(1) .token-owners', owner);
    await page.fill('.token-row:nth-child(1) .token-label', 'scoped');

    await page.click('#add-token');
    await page.fill('.token-row:nth-child(2) .token-value', 'not-a-real-token-routing-probe');
    await page.fill('.token-row:nth-child(2) .token-label', 'bad-default');
    await page.check('.token-row:nth-child(2) .token-default');

    // No Save button: the page writes as you go. Blur the last field so the
    // pending write lands, then wait for it to say so.
    await page.click('h1');
    await page.waitForFunction(() => document.querySelector('#save-status')?.dataset.tone === 'ok');

    const saved = await page.$eval('#save-status', (n) => n.textContent);
    assert(saved === msg('saved'), `the page saved on its own (${saved})`);

    // Every label on the options page comes from the catalogue; a key that is
    // missing or misspelt renders as an empty element rather than failing.
    const blank = await page.$$eval('[data-i18n], [data-i18n-html]', (nodes) =>
      nodes.filter((n) => !n.textContent.trim())
        .map((n) => n.getAttribute('data-i18n') || n.getAttribute('data-i18n-html'))
    );
    assert(blank.length === 0, `every label on the options page resolved${blank.length ? `: ${blank.join(', ')} did not` : ''}`);
    assertDocLang(await page.$eval('html', (n) => n.lang));
    await page.reload();
    assert(
      (await page.$$('.token-row')).length === 2,
      'both tokens are there after a reload, so the write really landed'
    );
    console.log(`configured 2 tokens — real one scoped to "${owner}", invalid one as default\n`);
  }

  /* The mode is what a run is about, so it is pinned either way — manual is the
     default now, and an automatic run that did not say so would sit waiting for
     bars that are never fetched. Checking a radio that is already checked fires
     nothing, and the page only writes on a change, so there is nothing to wait
     for in that case. */
  const wantedMode = MANUAL ? 'manual' : 'auto';
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  const modeAlready = await page.$eval(
    `input[name="exactLinesMode"][value="${wantedMode}"]`, (n) => n.checked
  );
  if (!modeAlready) {
    await page.check(`input[name="exactLinesMode"][value="${wantedMode}"]`);
    await page.click('h1');
    await page.waitForFunction(() => document.querySelector('#save-status')?.dataset.tone === 'ok');
  }
  console.log(`mode: ${wantedMode}${modeAlready ? ' (already set)' : ''}`);

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // Every API request costs rate limit, so the same URL must never be fetched
  // twice: caching and in-flight de-duplication should both prevent it.
  // Service-worker requests only surface on the context, not the page.
  const apiRequests = [];
  context.on('request', (req) => {
    const url = req.url();
    // /_private/browser/stats is github.com's own telemetry, not ours.
    if (url.startsWith('https://api.github.com/') && !url.includes('/_private/')) {
      apiRequests.push({ url, method: req.method() });
    }
  });

  console.log(`opening ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

  // Manual mode fetches nothing until asked. Flip the toggle to sizes, press
  // the button, check the sizes it shows, then flip back to lines for the
  // checks below.
  if (MANUAL) {
    await page.waitForSelector('#ghl-summary [data-ghl-action="fetch"]:visible', { timeout: 30000 });
    /* Manual mode spends nothing of the budget before it is asked to. The
       `/rate_limit` question is not spending: GitHub does not count it against
       the limit it reports, and it is what lets the strip say what is left. */
    const spentBefore = apiRequests.filter((r) => !r.url.includes('/rate_limit'));
    assert(spentBefore.length === 0, `nothing is charged before the button is pressed (${spentBefore.length})`);
    const opening = await page.$eval('#ghl-summary [data-ghl-action="fetch"]', (b) => b.textContent);
    assert(opening === msg('fetchLines'), `the toggle opens on lines (${opening})`);
    await page.click('#ghl-summary [data-ghl-metric="bytes"]');
    const label = await page.$eval('#ghl-summary [data-ghl-action="fetch"]', (b) => b.textContent);
    assert(label === msg('fetchSizes'), `the button follows the toggle (${label})`);
    // The segmented control's thumb slides under the size half, on the right.
    await page.waitForTimeout(250);
    const thumb = await page.$eval('#ghl-summary .ghl-metric', (n) => getComputedStyle(n, '::before').transform);
    assert(/matrix\(1, 0, 0, 1, \d+, 0\)/.test(thumb) && !/, 0, 0\)$/.test(thumb), `the thumb sits under the size half (${thumb})`);
    const idlePicks = await page.$$eval('.ghl-row-pick[data-pick="on"]', (ps) =>
      ps.filter((p) => p.offsetParent !== null).length
    );
    assert(idlePicks > 0, `checkboxes are up before anything is fetched (${idlePicks} visible)`);
    // The budget is readable before anything has been spent, which is when
    // knowing it matters most.
    const idleRate = await page.waitForSelector('#ghl-summary .ghl-rate-value', { timeout: 15000 })
      .then((n) => n.textContent(), () => '');
    assert(/\d[\d,]*\s*\/\s*[\d,]+/.test(idleRate), `the budget shows on an untouched view (${idleRate})`);
    const head = await page.waitForSelector('thead th > .ghl-col-head:visible', { timeout: 15000 }).catch(() => null);
    assert(!!head, 'the icon heads the checkbox column from the "Name" header cell');
    assert(!!(await page.$('.ghl-col-head [data-ghl-action="pick-all"]:visible')), 'with the all-rows checkbox under it');
    await page.screenshot({ path: path.join(OUT_DIR, 'manual-idle.png'), fullPage: false });
    await page.click('#ghl-summary [data-ghl-action="fetch"]');
    await page.waitForSelector('.ghl-cell', { state: 'attached', timeout: 30000 });
    const sizes = await page.$$eval('.ghl-cell[data-ghl-path] .ghl-num', (ns) =>
      ns.filter((n) => n.offsetParent !== null).map((n) => n.textContent)
    );
    assert(
      sizes.length > 0 && sizes.every((t) => /\d [KM]?B$/.test(t) || /generated|binary/.test(t)),
      `rows show sizes after the size fetch (${sizes.slice(0, 3).join(', ')})`
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'manual-sizes.png'), fullPage: false });
    await page.click('#ghl-summary [data-ghl-metric="lines"]');
    await page.waitForTimeout(250); // let the thumb finish sliding before the screenshots below
  }

  // Each row carries a small-screen and a large-screen cell and only one is
  // visible, so wait on attachment rather than visibility.
  await page.waitForSelector('.ghl-cell', { state: 'attached', timeout: 30000 });
  await page.waitForSelector('#ghl-summary', { state: 'attached', timeout: 10000 });

  // Give the exact-line pass a moment to replace the estimates.
  await page.waitForFunction(
    () => {
      const s = document.querySelector('.ghl-summary-status');
      return s && !window.__ghlBusy.some((b) => s.textContent.includes(b));
    },
    null, { timeout: 45000 }
  ).catch(() => console.log('note: exact-line pass still running, continuing'));

  const summary = await page.$eval('#ghl-summary .ghl-summary-stats', (n) => n.textContent.trim());
  const status = await page.$eval('#ghl-summary .ghl-summary-status', (n) => n.textContent.trim());
  const rows = await page.$$eval('.ghl-cell[data-ghl-path]', (cells) => {
    const seen = new Map();
    for (const c of cells) {
      // Two cells per row (small/large screen); prefer whichever is visible.
      const visible = c.offsetParent !== null;
      if (seen.has(c.dataset.ghlPath) && !visible) continue;
      seen.set(c.dataset.ghlPath, {
        path: c.dataset.ghlPath,
        severity: c.dataset.severity,
        visible,
        lines: c.querySelector('.ghl-num').textContent,
        pct: c.querySelector('.ghl-pct').textContent,
        width: c.querySelector('.ghl-bar-fill').style.width,
      });
    }
    return [...seen.values()];
  });

  console.log(`\nsummary: ${summary}`);
  console.log(`status : ${status || '(idle)'}`);
  console.log('\nrows:');
  for (const r of rows) {
    console.log(`  ${r.lines.padStart(8)}  ${(r.pct || '').padStart(4)}  ${r.severity.padEnd(7)} ${r.path}`);
  }

  await page.screenshot({ path: path.join(OUT_DIR, 'file-list.png'), fullPage: false });

  assert(rows.length > 0, 'bars rendered in the file list');
  assert(rows.every((r) => r.visible), 'the visible name cell got the bar, not just the hidden one');
  assert(rows.some((r) => /\d/.test(r.lines)), 'rows show a line count');
  assert(rows.some((r) => parseFloat(r.width) > 90), 'the largest row fills its bar');
  assert(summary.includes(msg('unitLines', '').trim()), `the summary strip shows a total (${summary})`);

  // The metric toggle: sizes come from the tree alone, so this costs nothing.
  const requestsBeforeToggle = apiRequests.length;
  await page.click('#ghl-summary [data-ghl-metric="bytes"]');
  const sizeNums = await page.$$eval('.ghl-cell[data-ghl-path] .ghl-num', (ns) =>
    ns.filter((n) => n.offsetParent !== null).map((n) => n.textContent)
  );
  assert(sizeNums.some((n) => /\d [KM]?B$/.test(n)), `rows show sizes when the toggle says size (${sizeNums.slice(0, 3).join(', ')})`);
  assert(apiRequests.length === requestsBeforeToggle, 'switching the metric makes no request');
  await page.screenshot({ path: path.join(OUT_DIR, 'sizes.png'), fullPage: false });

  // The treemap follows the toggle: area = size, legend of line thresholds hidden.
  await page.click('#ghl-summary [data-ghl-action="treemap"]');
  await page.waitForSelector('.ghl-overlay .ghl-tm-tile', { timeout: 10000 });
  const sizeStatus = await page.$eval('.ghl-tm-status', (n) => n.textContent);
  assert(sizeStatus === msg('tmArea', msg('metricBytes')), `the treemap says it measures sizes (${sizeStatus})`);
  const sizeEnds = await page.$$eval('.ghl-modal-foot [data-ghl-ramp-end]', (ns) => ns.map((n) => n.textContent));
  assert(sizeEnds.length === 2 && sizeEnds.every((e) => /B\b/.test(e)),
    `the legend's ends are spelt in bytes here (${sizeEnds.join(' | ')})`);
  await page.screenshot({ path: path.join(OUT_DIR, 'treemap-sizes.png') });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ghl-overlay', { state: 'detached', timeout: 5000 });

  await page.click('#ghl-summary [data-ghl-metric="lines"]');

  const rateLimited = RATE_LIMITED.test(status);
  if (rateLimited) {
    skip(`API quota exhausted — the extension reported it correctly: "${status}"`);
  } else {
    const tone = await page.$eval('#ghl-summary .ghl-summary-status', (n) => n.dataset.tone);
    assert(tone !== 'error', `no error in the status line (${status})`);
    if (!MANUAL) {
      assert(rows.some((r) => !r.lines.startsWith('~')), 'at least one exact line count landed');
    }
  }

  // --- manual mode: nothing is fetched until the button is pressed --------
  if (MANUAL && !rateLimited) {
    const button = await page.$('#ghl-summary [data-ghl-action="fetch"]:visible');
    assert(!!button, 'the fetch button is offered');
    const picks = await page.$$eval('.ghl-row-pick[data-pick="on"]', (ps) =>
      ps.filter((p) => p.offsetParent !== null).length
    );
    assert(picks > 0, `each row offers a checkbox for the fetch (${picks} visible)`);
    assert(await page.$('#ghl-summary .ghl-pick-all:visible') === null, "the strip's fallback all-rows toggle stays hidden");
    assert(
      rows.every((r) => r.lines.startsWith('~') || r.lines === 'generated' || r.lines === 'binary'),
      'everything is still an estimate before the button is pressed'
    );

    // Unticking a row takes it out of the picture and out of the count; tick
    // it back so the full fetch below is what it says.
    const firstPick = await page.$('.ghl-row-pick[data-pick="on"]:visible');
    const firstPath = await firstPick.getAttribute('data-ghl-path');
    const countBefore = (await button.textContent()).match(/\d+/)[0];
    await firstPick.click();
    await page.waitForFunction(
      (p) => document.querySelector(`.ghl-cell[data-ghl-path="${p}"]`)?.dataset.state === 'off', firstPath, { timeout: 5000 }
    );
    const countAfter = (await button.textContent()).match(/\d+/)[0];
    assert(Number(countAfter) < Number(countBefore), `unticking ${firstPath} drops the count (${countBefore} → ${countAfter})`);
    await page.screenshot({ path: path.join(OUT_DIR, 'manual-unticked.png'), fullPage: false });
    await firstPick.click();
    await page.waitForFunction(
      (p) => document.querySelector(`.ghl-cell[data-ghl-path="${p}"]`)?.dataset.state !== 'off', firstPath, { timeout: 5000 }
    );

    const beforeClick = apiRequests.length;
    const label = button ? (await button.textContent()) : '';
    await button.click();

    await page.waitForFunction(
      () => {
        const s = document.querySelector('.ghl-summary-status');
        return s && !window.__ghlBusy.some((b) => s.textContent.includes(b));
      },
      null, { timeout: 60000 }
    );

    const after = await page.$$eval('.ghl-cell[data-ghl-path]', (cells) =>
      [...cells].filter((c) => c.offsetParent !== null)
        .map((c) => c.querySelector('.ghl-num').textContent)
    );
    const spent = apiRequests.length - beforeClick;

    console.log(`\nmanual fetch: "${label.trim()}" -> ${spent} requests`);
    assert(spent > 0, `pressing the button fetched (${spent} requests)`);
    assert(after.some((n) => /^[\d,]+$/.test(n)), 'estimates were replaced with exact counts');
    const doneLabel = await page.$eval('#ghl-summary [data-ghl-action="fetch"]', (b) => `${b.disabled ? 'disabled ' : ''}${b.textContent}`);
    assert(doneLabel === `disabled ${msg('fetchDone')}`, `the button stays put, disabled, as done (${doneLabel})`);
    await page.screenshot({ path: path.join(OUT_DIR, 'manual-mode.png') });
  }

  // What is left of the budget, read off the response headers by the worker.
  const rate = await page.$eval('#ghl-summary .ghl-rate', (n) => [
    n.hidden, n.querySelector('.ghl-rate-value').textContent, n.querySelector('.ghl-rate-note').textContent,
  ].join('|')).catch(() => 'missing');
  if (rateLimited) {
    skip(`API budget — already exhausted (${rate.split('|')[1]})`);
  } else {
    const [hidden, text, note] = rate.split('|');
    assert(hidden === 'false' && /\d[\d,]*\s*\/\s*[\d,]+/.test(text),
      `the strip reports what is left of the API budget (${text})`);
    assert(note.trim().length > 0, 'with a note saying whose budget it is');
    // Our own tooltip, so it can be shown and read rather than taken on trust.
    await page.hover('#ghl-summary .ghl-rate');
    await page.waitForSelector('#ghl-summary .ghl-rate-note:visible', { timeout: 3000 });
    assert(true, 'and the note appears on hover');
  }

  // The ramp: every row's bar is coloured by its own line count, so a
  // directory of differently sized files shows more than one colour.
  const barColours = await page.$$eval('.ghl-cell[data-ghl-path]', (cells) =>
    [...cells].filter((c) => c.offsetParent !== null && c.dataset.state === 'file')
      .map((c) => c.querySelector('.ghl-bar-fill').style.background)
  );
  assert(barColours.every((c) => /^(hsl|rgb|color)a?\(/.test(c)), `file bars are coloured from the ramp (${barColours[0]})`);
  assert(new Set(barColours).size > 1, `and differ with the count (${new Set(barColours).size} distinct)`);

  // Directories run on their own ramp, keyed to the largest file inside.
  const dirColours = await page.$$eval('.ghl-cell[data-state="dir"]', (cells) =>
    [...cells].filter((c) => c.offsetParent !== null)
      .map((c) => ({ path: c.dataset.ghlPath, colour: c.querySelector('.ghl-bar-fill').style.background, tip: c.title }))
  );
  assert(dirColours.every((d) => /^(hsl|rgb|color)a?\(/.test(d.colour)),
    `directory bars are coloured too (${dirColours[0]?.colour})`);
  const maxFilePrefix = msg('tipMaxFile', '').trim();
  assert(dirColours.every((d) => d.tip.includes(maxFilePrefix)), 'and say which file that colour is about');

  // Treemap
  await page.click('#ghl-summary [data-ghl-action="treemap"]');
  await page.waitForSelector('.ghl-overlay .ghl-tm-tile', { timeout: 10000 });
  const tiles = await page.$$eval('.ghl-tm-tile', (ts) =>
    ts.map((t) => ({ w: parseFloat(t.style.width), h: parseFloat(t.style.height) }))
  );
  await page.screenshot({ path: path.join(OUT_DIR, 'treemap.png') });

  const rampBars = await page.$$eval('.ghl-modal-foot .ghl-ramp-bar', (ns) => ns.map((n) => n.style.background));
  assert(rampBars.length === 2, `the treemap legend shows both ramps (${rampBars.length})`);
  assert(rampBars.every((b) => /linear-gradient/.test(b)), `each is the ramp itself (${rampBars[0].slice(0, 50)})`);
  assert(rampBars[0] !== rampBars[1], 'and the folder ramp is its own colour family');
  const ticks = (await page.$$('.ghl-ramp-tick')).length;
  assert(ticks === 2, `with the warn threshold ticked on each (${ticks})`);

  assert(tiles.length > 0, `treemap drew tiles (${tiles.length})`);
  assert(tiles.every((t) => t.w >= 0 && t.h >= 0), 'every tile has a valid size');
  assert(tiles.some((t) => t.w > 40 && t.h > 40), 'at least one tile is big enough to read');

  await page.keyboard.press('Escape');
  await page.waitForSelector('.ghl-overlay', { state: 'detached', timeout: 5000 });
  assert(true, 'Escape closes the treemap');

  // Navigating into a subdirectory must re-run the whole thing. Scoped to the
  // file table so we do not click the sidebar tree; `[title]` skips the
  // go-to-parent row and `:visible` skips the small-screen duplicate.
  const subdir = await page.$(
    'table[aria-labelledby="folders-and-files"] a[href*="/tree/"][title][class*="Link--primary"]:visible'
  );
  if (rateLimited) {
    skip('subdirectory re-render — needs API quota (covered by scripts/test.mjs)');
  } else if (!subdir) {
    skip('subdirectory re-render — no subdirectory on this page');
  } else {
    const href = await subdir.getAttribute('href');
    const dirPath = href.split('/main/')[1];
    await subdir.click();
    await page.waitForFunction((h) => location.pathname === h, href, { timeout: 15000 });
    // Manual mode: this commit's tree was cached by the view above, so the
    // subdirectory shows on its own — no press, no request.
    const requestsBeforeSubdir = apiRequests.length;

    // Wait for the swap to complete rather than sampling mid-flight: the old
    // directory's cells stay attached until teardown runs.
    let swapped = true;
    await page.waitForFunction(
      (prefix) => {
        const cells = [...document.querySelectorAll('.ghl-cell[data-ghl-path]')];
        return cells.length > 0 && cells.every((c) => c.dataset.ghlPath.startsWith(prefix));
      },
      `${dirPath}/`,
      { timeout: 30000 }
    ).catch(() => { swapped = false; });

    const subRows = await page.$$eval('.ghl-cell[data-ghl-path]', (cells) =>
      [...new Set(cells.map((c) => c.dataset.ghlPath))]
    );
    assert(swapped, `rows swapped to ${dirPath} after navigating (saw ${subRows.join(', ')})`);
    assert(subRows.length > 0, `bars re-render after navigating into ${href}`);
    if (MANUAL) {
      assert(apiRequests.length === requestsBeforeSubdir, 'a cached commit shows in manual mode without a request');
    }
    await page.screenshot({ path: path.join(OUT_DIR, 'subdirectory.png') });
  }

  // The repository root keeps its header row at zero height; the column head
  // must land in the latest-commit box there, not on top of the first row.
  if (MANUAL) {
    const root = TARGET_URL.split('/').slice(0, 5).join('/');
    await page.goto(root, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ghl-summary [data-ghl-action="fetch"]:visible', { timeout: 30000 });
    const home = await page.waitForSelector('[data-testid="latest-commit"] > .ghl-col-head', { timeout: 15000 }).catch(() => null);
    assert(!!home, 'on the repository root the head sits in the latest-commit box');
    assert((await page.$$('thead th > .ghl-col-head')).length === 0, 'and not in the collapsed header row');
    await page.screenshot({ path: path.join(OUT_DIR, 'manual-root.png'), fullPage: false });
  }

  const realErrors = consoleErrors.filter(
    (e) => !/net::|Failed to load resource|favicon|Content Security Policy/i.test(e)
  );
  assert(realErrors.length === 0, `no page errors${realErrors.length ? ': ' + realErrors[0] : ''}`);

  const seen = new Set();
  // `/rate_limit` is asked once per view when a page draws without spending
  // anything; GitHub does not count it against the budget it reports, and
  // repeating it is the point rather than waste.
  const charged = apiRequests.filter((r) => !r.url.includes('/rate_limit'));
  const duplicates = charged.filter((r) => (seen.has(r.url) ? true : (seen.add(r.url), false)));
  assert(
    duplicates.length === 0,
    `no API request is made twice (${charged.length} checked)` +
      (duplicates.length ? ` — repeated: ${duplicates[0].url}` : '')
  );

  // Classic tokens have no read-only scope, so some users have no choice but to
  // hand this a write-capable token. Prove it only ever reads.
  const mutating = apiRequests.filter((r) => r.method !== 'GET');
  assert(
    mutating.length === 0,
    `every API request is a GET (${apiRequests.length} checked)` +
      (mutating.length ? ` — found ${mutating[0].method} ${mutating[0].url}` : '')
  );

  console.log(`\nscreenshots: ${path.relative(process.cwd(), OUT_DIR)}/`);
} catch (err) {
  // A screenshot of the moment it broke is worth more than the stack trace.
  const page = context.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(OUT_DIR, 'failure.png') }).catch(() => {});
    console.error(`\nfailure screenshot: ${path.relative(process.cwd(), OUT_DIR)}/failure.png`);
  }
  failures++;
  console.error(`\n${err.message}`);
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const tail = skips ? `, ${skips} skipped` : '';
console.log(failures ? `\n${failures} check(s) failed${tail}` : `\nall checks passed${tail}`);
process.exit(failures ? 1 : 0);
