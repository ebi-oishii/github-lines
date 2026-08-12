/* Captures a trimmed copy of a real GitHub directory page for the DOM tests.

   GitHub reshapes this markup every few months — when the extension stops
   finding rows, re-run this and see what moved:

     node scripts/capture-fixture.mjs
     node scripts/capture-fixture.mjs https://github.com/owner/repo/tree/main/src
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'tree-page.html');
const URL_ARG = process.argv[2] || 'https://github.com/sindresorhus/got/tree/main/source';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

const KEEP_META = [
  'octolytics-dimension-repository_nwo',
  'octolytics-dimension-repository_public',
  'octolytics-dimension-repository_id',
];
const KEEP_ROWS = 6;
const KEEP_TREE_ITEMS = 6;

const RENDERED_MARKER = 'aria-labelledby="folders-and-files"';

/* GitHub only sometimes server-renders the file table; the rest of the time it
   ships a client-rendered shell, and repeated requests from one IP seem to make
   the shell more likely. Retry, and fall back to a page saved from a browser:

     node scripts/capture-fixture.mjs ./saved-page.html

   (The extension itself copes with both — its mutation observer picks up the
   late client-side render.) */
async function fetchRendered(attempts = 6) {
  if (fs.existsSync(URL_ARG)) {
    const body = fs.readFileSync(URL_ARG, 'utf8');
    if (!body.includes(RENDERED_MARKER)) {
      throw new Error(`${URL_ARG} has no server-rendered file table`);
    }
    return body;
  }

  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(URL_ARG, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${URL_ARG}`);
    const body = await res.text();
    if (body.includes(RENDERED_MARKER)) return body;
    console.log(`attempt ${i}: client-rendered shell only, retrying…`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    'GitHub kept returning the client-rendered shell.\n' +
    'Save the page from your browser and pass the file path instead.'
  );
}

const dom = new JSDOM(await fetchRendered());
const doc = dom.window.document;

function required(selector, label) {
  const node = doc.querySelector(selector);
  if (!node) throw new Error(`missing ${label} — GitHub's markup changed (${selector})`);
  return node;
}

const table = required('table[aria-labelledby="folders-and-files"]', 'file table');
const listWrap = table.closest('[data-hpc]') || table.parentElement;
const payloadScript = required(
  'script[type="application/json"][data-target="react-app.embeddedData"]',
  'embedded payload'
);
const refSelector =
  doc.querySelector('[data-testid="anchor-button"][aria-label$=" branch"]') ||
  doc.querySelector('.ref-selector-button-text-container');
if (!refSelector) throw new Error('missing ref selector — GitHub\'s markup changed');

// Trim the row list: keep the header plus a handful of entries.
for (const body of table.querySelectorAll('tbody')) {
  const rows = [...body.children];
  rows.slice(KEEP_ROWS).forEach((r) => r.remove());
}

// Trim the directory listing inside the payload the same way.
const payload = JSON.parse(payloadScript.textContent);
(function trim(obj, depth) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 4) return;
  if (obj.tree && Array.isArray(obj.tree.items)) {
    obj.tree.items = obj.tree.items.slice(0, KEEP_TREE_ITEMS);
  }
  for (const v of Object.values(obj)) trim(v, depth + 1);
})(payload, 0);

// The source may be a saved file rather than a URL, so take the path from the
// page itself.
const initialPath =
  doc.querySelector('react-app[initial-path]')?.getAttribute('initial-path') || '/';

const metas = KEEP_META
  .map((name) => doc.querySelector(`meta[name="${name}"]`))
  .filter(Boolean)
  .map((m) => '  ' + m.outerHTML)
  .join('\n');

// Never record a local filesystem path in a committed file.
const provenance = URL_ARG.startsWith('http')
  ? URL_ARG
  : `https://github.com${initialPath}`;

const out = `<!doctype html>
<!-- Trimmed capture of ${provenance}
     Regenerate with: node scripts/capture-fixture.mjs [url] -->
<html lang="en" data-color-mode="auto" data-light-theme="light" data-dark-theme="dark">
<head>
  <meta charset="utf-8">
${metas}
</head>
<body>
  <div class="ref-selector-wrapper">
${refSelector.outerHTML}
  </div>
  <react-app app-name="code-view" initial-path="${initialPath}">
    <script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(payload)}</script>
  </react-app>
  <div class="d-flex flex-column gap-3">
${listWrap.outerHTML}
  </div>
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${(out.length / 1024).toFixed(1)} KB)`);
