/* Measures how many GitHub API requests the extension actually spends, and on
   what, by counting them at the network layer. Answers "what does this cost me
   in rate limit?" with a number instead of a guess.

   Usage: GITHUB_TOKEN=$(gh auth token) node scripts/measure.mjs [owner/repo]
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.argv[2] || 'sindresorhus/got';

const CHROME_CANDIDATES = [
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1229/chrome-mac-arm64',
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  ),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) throw new Error('No Chrome found.');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghl-measure-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: chromePath,
  headless: true,
  viewport: { width: 1440, height: 950 },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run'],
});

/* Service-worker requests do not surface on the page, only on the context. */
let counter = null;
context.on('request', (req) => {
  const url = req.url();
  if (!counter || !url.startsWith('https://api.github.com/')) return;
  const kind =
    /\/git\/trees\//.test(url) ? 'tree' :
    /\/git\/blobs\//.test(url) ? 'blob' :
    /\/commits\//.test(url) ? 'resolve-ref' :
    /\/rate_limit/.test(url) ? 'rate_limit' : 'other';
  counter.total++;
  counter.byKind[kind] = (counter.byKind[kind] || 0) + 1;
  if (kind !== 'blob') counter.notable.push(url);
});

const VERBOSE = process.argv.includes('--urls');

try {
  const page = context.pages()[0] || (await context.newPage());
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;

  if (TOKEN) {
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await page.fill('.token-row:nth-child(1) .token-value', TOKEN);
    await page.click('#save');
    await page.waitForFunction(() => document.querySelector('#save-status')?.dataset.tone === 'ok');
    console.log('token configured\n');
  } else {
    console.log('no GITHUB_TOKEN — measuring unauthenticated (60/hr)\n');
  }

  async function visit(label, url) {
    counter = { total: 0, byKind: {}, notable: [] };
    const t0 = Date.now();

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ghl-summary', { state: 'attached', timeout: 60000 });
    await page.waitForFunction(
      () => {
        const s = document.querySelector('.ghl-summary-status');
        return s && !/取得中|推定中|読み込み中/.test(s.textContent);
      },
      { timeout: 180000 }
    );
    // Let any trailing requests land before we stop counting.
    await page.waitForTimeout(1500);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const stats = await page.$eval('.ghl-summary-stats', (n) => n.textContent.trim());
    const status = await page.$eval('.ghl-summary-status', (n) => n.textContent.trim());
    const breakdown = Object.entries(counter.byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');

    console.log(label);
    console.log(`  requests : ${counter.total}${breakdown ? `  (${breakdown})` : ''}`);
    console.log(`  time     : ${elapsed}s`);
    console.log(`  result   : ${stats}`);
    if (status) console.log(`  status   : ${status}`);
    if (VERBOSE) for (const u of counter.notable) console.log(`    - ${u}`);
    console.log('');
  }

  await visit(`${REPO} 直下 — 初回`, `https://github.com/${REPO}`);
  await visit(`${REPO} 直下 — 2回目（同一プロファイル、キャッシュあり）`, `https://github.com/${REPO}`);

  // A directory whose files were not covered by the root view's fetch budget.
  const sub = await page.$(
    'table[aria-labelledby="folders-and-files"] a[href*="/tree/"][title][class*="Link--primary"]:visible'
  );
  if (sub) {
    const href = await sub.getAttribute('href');
    await visit(`${href.split('/').slice(5).join('/')}/ へ移動`, `https://github.com${href}`);
  }
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
