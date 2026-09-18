# Development

The extension itself needs no build. `npm install` is only the test
dependencies (jsdom, playwright-core).

```bash
npm install
npm test             # logic and DOM tests (95 of them, no network)
npm run smoke        # load it into a real Chrome and drive github.com
npm run measure      # count the API requests
npm run icons        # regenerate icons/*.png
npm run fixture      # refresh the test fixture from GitHub's live HTML
```

`smoke` and `measure` spend the unauthenticated 60-an-hour budget, so it is
easier to hand them a token:

```bash
GITHUB_TOKEN=$(gh auth token) npm run smoke
node scripts/smoke.mjs --manual    # exercise manual mode, where you press the button
node scripts/smoke.mjs --headed    # watch it happen
```

## How the code is laid out

```
manifest.json
src/
  lib/
    namespace.js      the namespace every context hangs things off
    patterns.js       exclusions, .gitattributes, bytes-to-lines estimation
    settings.js       reading and writing chrome.storage.local
    i18n.js           the catalogues, and applying them to a page
  background/
    service-worker.js the GitHub API, the IndexedDB cache, rate control
  content/
    util.js           DOM helpers, parallelism, talking to the service worker
    page.js           reading GitHub's page (repository / ref / path / rows)
    store.js          orchestration — estimates converging on real counts,
                      and what pressing the fetch button does (`state.press`)
    inline.js         the row bars and the summary strip
    treemap.js        a squarified treemap
    main.js           navigation and lifecycle
  options/            the options page
  styles/content.css  the injected CSS
_locales/             en and ja message catalogues
```

### Why every API call goes through the service worker

Under MV3 a content script's `fetch` answers to the **page's** CORS rules rather
than the extension's host permissions, so github.com cannot call
`api.github.com` directly. Keeping the cache in the worker also means it uses
the extension's own storage instead of polluting github.com's origin.

### What reading GitHub's page assumes

`page.js` has three layers, tried in order:

1. The React app's embedded JSON (`react-app.embeddedData`) — the only source
   that gives the commit OID
2. `<meta>` tags plus the branch-selector button
3. Parsing the URL alone

**The path always comes from the URL.** GitHub does not update the embedded JSON
on a client-side navigation, so taking the path from it leaves every soft
navigation labelled with the previous directory. (A bug that actually happened;
`scripts/test.mjs` has the regression test.)

**A row's own path comes from its link's href**, for the same reason in
miniature: GitHub folds a chain of single-child directories into one row whose
text is the whole chain and whose `title` is the sentence "This path skips
through empty directories". The href is the only part that names the entry.

## Localisation

The UI strings live in `_locales/<lang>/messages.json` and are looked up through
`chrome.i18n` by default, which picks the catalogue from **Chrome's UI
language** (on macOS, the OS language). Choosing a language in the options wins
over that; since chrome.i18n has no override, the chosen catalogue is loaded and
consulted first (a content script cannot read a packaged file itself, so it asks
the service worker's `LOCALE` handler).

- From code: `GHL.t('key', substitutions…)`. Counted nouns go through
  `GHL.i18n.count('unitLines', n, text)` to decline (English has `unitLines` and
  `unitLinesOne`; Japanese points both at one string)
- In HTML: `data-i18n="key"` for text, `-html` for a sentence carrying a `<code>`
  or a `<strong>`, and `-title` / `-placeholder` / `-label`.
  `GHL.i18n.applyDom()` fills them in on load
- To add a language, write `_locales/<lang>/messages.json` with every key
  translated, then add it to `SUPPORTED` in `src/lib/i18n.js` and to
  `<select id="locale">` in the options. Missing keys and mismatched `$1`
  substitutions fail `scripts/test.mjs`
- Nothing is drawn before `GHL.i18n.ready()` resolves, so no label is ever
  painted in one language and swapped in another

## Tests

### `scripts/test.mjs` (95, no network)

- Pure logic: globs, `.gitattributes`, line estimation, rollups, the treemap
  layout algorithm
- Token routing: choosing one per owner, migrating from the old shape
- Talking to the service worker: timeouts, retries, a lost context
- DOM: against **a fixture cut from GitHub's real HTML**
  (`tests/fixtures/tree-page.html`) — context extraction, finding rows,
  injecting bars
- Client-side navigation: `main.js` actually running, redrawing and tearing down
- The counting modes: automatic / manual / off, and migration from the old
  boolean. Manual fetches whichever [Lines | Size] says, from one button
- The lines/size toggle: the same rows drawn by size, and switching costing no
  request
- Manual mode's checkboxes: an unticked row (and everything under a directory)
  leaving the fetch, and the checkbox above the column taking them all — which
  moves to the strip on a page with no header row
- Recovering from a failure: a failed fetch leaves a button that starts over,
  an exclusion rule that went unread is read again on the next press, and a
  press does what the button offered — a failed size fetch never turns into a
  file-per-row count
- What came back not covering the view: a directory a truncated tree left out
  counts nothing rather than counting the repository, and does not follow the
  reader to the next directory
- Localisation: both catalogues carrying the same keys and the same `$1`
  substitutions, and every key the code asks for existing

### `scripts/smoke.mjs`

Loads the unpacked extension into a real Chrome and drives github.com. It binds
the real token to the owner under test **with an invalid one set as the
default**, so a regression in per-owner routing fails the run rather than
passing quietly. It checks the bars, the treemap, navigation, filling in a
token's owners, that no URL is fetched twice, and **that every API request is a
GET**, then saves screenshots under `tests/screenshots/` — `failure.png` on the
way out if something breaks.

### `scripts/measure.mjs`

Counts API requests at the network layer. `--urls` breaks down everything that
is not a blob.

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/measure.mjs owner/repo --urls
```

## When a GitHub change breaks it

GitHub reworks its markup every few months.

```bash
npm run fixture   # take in the current HTML
npm test          # the failures say which assumptions broke
```

Sometimes GitHub answers without server-side rendering — a shell that only the
client fills in. Hand it a page saved from the browser instead:

```bash
node scripts/capture-fixture.mjs ./saved.html
```

## Changing the rate control

These constants in `src/background/service-worker.js` answer to
[GitHub's guidance](api-usage-and-terms.md). Check that guidance before loosening
any of them.

| Constant | Default | GitHub's limit |
|---|---|---|
| `MAX_PER_WINDOW` | 600 a minute | 900 points a minute |
| `settings.concurrency` | 8 | 100 |
| `settings.maxExactFetch` | 300 a view | — |
