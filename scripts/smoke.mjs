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

function skip(msg) {
  console.log(`skip  ${msg}`);
  skips++;
}

const RATE_LIMITED = /レート制限|rate limit/;

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

  // Feed the extension a token if one is in the environment, by driving its own
  // options page — the same path a user takes.
  //
  // Two tokens are configured on purpose: the real one scoped to the owner
  // under test, and a deliberately invalid one as the default. If per-owner
  // routing regresses, the run picks the invalid default and fails loudly
  // instead of quietly passing.
  if (process.env.GITHUB_TOKEN) {
    const owner = new URL(TARGET_URL).pathname.split('/').filter(Boolean)[0];
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;

    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await page.fill('.token-row:nth-child(1) .token-value', process.env.GITHUB_TOKEN);

    // Owner auto-discovery: asks GitHub which owners this token can reach.
    await page.click('.token-row:nth-child(1) .token-verify');
    await page.waitForFunction(
      () => {
        const s = document.querySelector('.token-row:nth-child(1) .token-status');
        return s && s.textContent && !/確認中/.test(s.textContent);
      },
      { timeout: 20000 }
    );
    const verdict = await page.$eval('.token-row:nth-child(1) .token-status', (n) => n.textContent);
    const discovered = await page.$eval('.token-row:nth-child(1) .token-owners', (n) => n.value);
    const autoLabel = await page.$eval('.token-row:nth-child(1) .token-label', (n) => n.value);

    assert(/として有効/.test(verdict), `verify identified the token (${verdict})`);
    assert(discovered.trim().length > 0, `owners were auto-filled (${discovered})`);
    assert(autoLabel.trim().length > 0, `label was auto-filled (${autoLabel})`);

    // Now point it at the repo under test so routing can be exercised.
    await page.fill('.token-row:nth-child(1) .token-owners', owner);
    await page.fill('.token-row:nth-child(1) .token-label', 'scoped');

    await page.click('#add-token');
    await page.fill('.token-row:nth-child(2) .token-value', 'not-a-real-token-routing-probe');
    await page.fill('.token-row:nth-child(2) .token-label', 'bad-default');
    await page.check('.token-row:nth-child(2) .token-default');

    if (MANUAL) {
      await page.check('input[name="exactLinesMode"][value="manual"]');
    }

    await page.click('#save');
    await page.waitForFunction(() => document.querySelector('#save-status')?.dataset.tone === 'ok');

    const saved = await page.$eval('#save-status', (n) => n.textContent);
    assert(/2 件/.test(saved), `both tokens saved (${saved})`);
    assert(
      (await page.$$('.token-row')).length === 2,
      'the options page renders both tokens after reload'
    );
    console.log(`configured 2 tokens — real one scoped to "${owner}", invalid one as default\n`);
  }

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

  // Manual mode fetches nothing until asked. Press the plain button, check the
  // sizes it shows, then switch the view to lines for the checks below.
  if (MANUAL) {
    await page.waitForSelector('#ghl-summary [data-ghl-action="sizes"]:visible', { timeout: 30000 });
    assert(apiRequests.length === 0, `nothing is requested before サイズを取得 is pressed (${apiRequests.length})`);
    await page.screenshot({ path: path.join(OUT_DIR, 'manual-idle.png'), fullPage: false });
    await page.click('#ghl-summary [data-ghl-action="sizes"]');
    await page.waitForSelector('.ghl-cell', { state: 'attached', timeout: 30000 });
    const sizes = await page.$$eval('.ghl-cell[data-ghl-path] .ghl-num', (ns) =>
      ns.filter((n) => n.offsetParent !== null).map((n) => n.textContent)
    );
    assert(
      sizes.length > 0 && sizes.every((t) => /\d [KM]?B$/.test(t) || /generated|binary/.test(t)),
      `rows show sizes after サイズを取得 (${sizes.slice(0, 3).join(', ')})`
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'manual-sizes.png'), fullPage: false });
    await page.click('#ghl-summary [data-ghl-metric="lines"]');
  }

  // Each row carries a small-screen and a large-screen cell and only one is
  // visible, so wait on attachment rather than visibility.
  await page.waitForSelector('.ghl-cell', { state: 'attached', timeout: 30000 });
  await page.waitForSelector('#ghl-summary', { state: 'attached', timeout: 10000 });

  // Give the exact-line pass a moment to replace the estimates.
  await page.waitForFunction(
    () => {
      const s = document.querySelector('.ghl-summary-status');
      return s && !/取得中|推定中|読み込み中/.test(s.textContent);
    },
    { timeout: 45000 }
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
  assert(/行/.test(summary), 'summary strip shows a total');

  // The metric toggle: sizes come from the tree alone, so this costs nothing.
  const requestsBeforeToggle = apiRequests.length;
  await page.click('#ghl-summary [data-ghl-metric="bytes"]');
  const sizeNums = await page.$$eval('.ghl-cell[data-ghl-path] .ghl-num', (ns) =>
    ns.filter((n) => n.offsetParent !== null).map((n) => n.textContent)
  );
  assert(sizeNums.some((t) => /\d [KM]?B$/.test(t)), `rows show sizes when the toggle says サイズ (${sizeNums.slice(0, 3).join(', ')})`);
  assert(apiRequests.length === requestsBeforeToggle, 'switching the metric makes no request');
  await page.screenshot({ path: path.join(OUT_DIR, 'sizes.png'), fullPage: false });

  // The treemap follows the toggle: area = size, legend of line thresholds hidden.
  await page.click('#ghl-summary [data-ghl-action="treemap"]');
  await page.waitForSelector('.ghl-overlay .ghl-tm-tile', { timeout: 10000 });
  const sizeStatus = await page.$eval('.ghl-tm-status', (n) => n.textContent);
  assert(/サイズ/.test(sizeStatus), `treemap says it measures sizes (${sizeStatus})`);
  assert(await page.$('.ghl-modal-foot .ghl-legend:visible') === null, 'the line-threshold legend is hidden for sizes');
  await page.screenshot({ path: path.join(OUT_DIR, 'treemap-sizes.png') });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ghl-overlay', { state: 'detached', timeout: 5000 });

  await page.click('#ghl-summary [data-ghl-metric="lines"]');

  const rateLimited = RATE_LIMITED.test(status);
  if (rateLimited) {
    skip(`API quota exhausted — the extension reported it correctly: "${status}"`);
  } else {
    assert(!/失敗|エラー/.test(status), `no error in the status line (${status})`);
    if (!MANUAL) {
      assert(rows.some((r) => !r.lines.startsWith('~')), 'at least one exact line count landed');
    }
  }

  // --- manual mode: nothing is fetched until the button is pressed --------
  if (MANUAL && !rateLimited) {
    const button = await page.$('#ghl-summary [data-ghl-action="fetch"]:visible');
    assert(!!button, 'the fetch button is offered');
    const picks = await page.$$eval('.ghl-cell[data-pick="on"] .ghl-pick', (ps) =>
      ps.filter((p) => p.offsetParent !== null).length
    );
    assert(picks > 0, `each row offers a checkbox for the fetch (${picks} visible)`);
    assert(!!(await page.$('#ghl-summary .ghl-pick-all:visible')), 'the all-rows toggle is offered');
    assert(
      rows.every((r) => r.lines.startsWith('~') || r.lines === 'generated' || r.lines === 'binary'),
      'everything is still an estimate before the button is pressed'
    );

    const beforeClick = apiRequests.length;
    const label = button ? (await button.textContent()) : '';
    await button.click();

    await page.waitForFunction(
      () => {
        const s = document.querySelector('.ghl-summary-status');
        return s && !/取得中/.test(s.textContent);
      },
      { timeout: 60000 }
    );

    const after = await page.$$eval('.ghl-cell[data-ghl-path]', (cells) =>
      [...cells].filter((c) => c.offsetParent !== null)
        .map((c) => c.querySelector('.ghl-num').textContent)
    );
    const spent = apiRequests.length - beforeClick;

    console.log(`\nmanual fetch: "${label.trim()}" -> ${spent} requests`);
    assert(spent > 0, `pressing the button fetched (${spent} requests)`);
    assert(after.some((n) => /^[\d,]+$/.test(n)), 'estimates were replaced with exact counts');
    assert(
      await page.$('#ghl-summary [data-ghl-action="fetch"]:visible') === null,
      'the button goes away once there is nothing left to fetch'
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'manual-mode.png') });
  }

  // Treemap
  await page.click('#ghl-summary [data-ghl-action="treemap"]');
  await page.waitForSelector('.ghl-overlay .ghl-tm-tile', { timeout: 10000 });
  const tiles = await page.$$eval('.ghl-tm-tile', (ts) =>
    ts.map((t) => ({ w: parseFloat(t.style.width), h: parseFloat(t.style.height) }))
  );
  await page.screenshot({ path: path.join(OUT_DIR, 'treemap.png') });

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
    if (MANUAL) {
      await page.waitForSelector('#ghl-summary [data-ghl-action="sizes"]:visible', { timeout: 15000 });
      await page.click('#ghl-summary [data-ghl-action="sizes"]');
    }

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
    await page.screenshot({ path: path.join(OUT_DIR, 'subdirectory.png') });
  }

  const realErrors = consoleErrors.filter(
    (e) => !/net::|Failed to load resource|favicon|Content Security Policy/i.test(e)
  );
  assert(realErrors.length === 0, `no page errors${realErrors.length ? ': ' + realErrors[0] : ''}`);

  const seen = new Set();
  const duplicates = apiRequests.filter((r) => (seen.has(r.url) ? true : (seen.add(r.url), false)));
  assert(
    duplicates.length === 0,
    `no API request is made twice (${apiRequests.length} total)` +
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
