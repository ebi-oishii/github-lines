# Usage

## Reading the display

### The bars on the file list

Each row gains, on its right, where it stands in that directory.

```
core           ███████████████████  10,081  90%
as-promise     ▌                       358   3%
create.ts      ▊                       412   4%
index.ts                                27
types.ts       ▌                       342   3%
```

| What you see | What it means |
|---|---|
| Bar length | **Relative to the largest entry in that directory** |
| The number | Its line count |
| `%` | Its share of the directory's total (hidden below 0.5%) |
| `~1,204` | An estimate; the real count has not been fetched |
| `generated` | Not counted — a generated file |
| `binary` | Not counted — binary |
| `–` | Nothing could be read for it (a submodule, perhaps) |

Drawing the bar as a share of the total would make every row of a 30-file
directory a 3% sliver, hiding the very outlier this is for. So **the bar is
scaled to the largest entry** and **the number is the true share**.

Hovering a row shows its full path, line count, share, file count and byte size.

### Colour

A file's colour moves continuously with its line count (the thresholds default
to 500 and 800, and are configurable).

| Colour | Meaning |
|---|---|
| Blue → green | Ordinary — from zero up to the warn threshold |
| Amber | The warn threshold (500 by default) |
| Orange → red | On towards danger; 800 and above is all the same red |
| Pale → deep violet | A directory, deepening with **the largest file inside it** |
| Grey | Not counted |

On the **Size** reading the same ramp applies, with the thresholds read in
bytes: 500 lines is about 16 KB, 800 about 25 KB, at 32 bytes to a line.

A directory's colour is not about its total. A small directory with one bloated
file in it is dark, which is the thing worth finding; the tooltip names that
file.

### The summary strip

The band above the listing.

```
GitHub Lines   11,220 lines · 25 files · biggest: core/ 10k lines (90%)   [Treemap]
███████████████████████████████████████████████▏▍▏▎
■ core/ 90%
```

The stacked bar is the directory's children. Click a segment to scroll to that
row and flash it.

The right-hand side carries the status (`Counting lines 42/120`, `API rate
limit…`). Nothing there means every number on screen is final.

Under the right-hand end of the bar is what is left of the API budget —
`API 4,981/5,000` — read off the last response rather than counted here, and
asked of GitHub's `/rate_limit` when there has been no response to read (a page
drawn from the cache, or a manual view yet to fetch anything). That question is
free: GitHub does not count it against the limit it reports. It goes amber near the end and red at zero. Hover it
(or tab to it) and it says which account the budget belongs to and when it comes
back.

**[Lines | Size]** on the left of the strip switches what the bars, the shares
and the treemap measure. Sizes come with the tree listing, so they are always
exact and switching to them costs no request. They are coloured on the same
ramp, read in bytes at a typical line's length — so a file that is amber by its
lines is about amber by its size, and there is no second pair of thresholds to
configure.

In manual mode nothing is fetched when the page opens, and one button offers
whatever the toggle says. (If you have seen the same commit before, its tree is
in the cache and the view is drawn on open without a request — counts too, where
they are cached, and estimates where they are not.) On **Lines** the button
reads **"Fetch line counts"** and goes from the tree listing all the way to the
counts; switch to **Size** and it reads **"Fetch sizes"**, which is the one tree
request. Once the tree is in, the button names its price — **"Fetch line counts
(124)"**, one request per file. With nothing left to fetch it stays where it is,
disabled, reading **"Fetched"**.

Every row carries a checkbox at its head from the moment the page opens. Above
the column — to the left of the "Name" header, or in the latest-commit box on a
repository root, which has no header row — sit the extension's icon and a
checkbox for every row, with a rule down the column. A ticked row is included:
untick it and it leaves the bars, the shares, the total, the treemap and the
count on the button (a directory takes everything inside it). The checkbox above
the column ticks or unticks them all.

### The treemap

Opened with the "Treemap" button. **Area is line count.**

- Click a directory's header — drill into it
- Click a file — go to it on GitHub
- Click the breadcrumb — back up
- `Esc`, or click the backdrop — close

## Settings

Right-click the extension's icon → "Options", or "Extension options" under
`chrome://extensions`.

| Setting | Default | What it is |
|---|---|---|
| Access tokens | none | [How to set one up](token.md). Needed for private repositories and for 5,000 requests an hour. Several can be registered and routed per owner |
| Warn / danger thresholds | 500 / 800 lines | Where the colour ramp is anchored |
| Language | follow the browser | English or Japanese, if you would rather pin one |
| Show proportion bars | on | The bars on the listing |
| Show the treemap button | on | The button on the summary strip |
| Fetching exact line counts | manual | Automatic / manual / off — see below |
| Fetch limit per view | 300 files | The most it will count in one view |
| Parallel requests | 8 | How many at a time |
| Respect `.gitattributes` | on | Excludes `linguist-generated` / `linguist-vendored` |
| Exclude patterns | see below | Globs, one per line |

Settings are saved as you change them, and reach any open GitHub tab at once.

## When it counts

"Fetching exact line counts", in the options, offers three.

| Mode | What it does | API requests per view |
|---|---|---|
| **Manual** (default) | Fetches nothing on open. The button fetches whatever [Lines \| Size] says; the row checkboxes narrow it | 0 (+1 for sizes, +N for counts) |
| **Automatic** | Starts counting as soon as the page opens | 1 tree + files not yet counted |
| **Off** | Estimates, always | 1 tree |

**In every mode, a file counted before shows its real value from the cache,
without a request.** Reopen a directory you have already seen and the button
sits there disabled, reading "Fetched", because there is nothing left to
fetch.

Manual suits you if:

- you want to decide what the API budget goes on — you are on the
  unauthenticated 60 an hour, or looking at an enormous monorepo
- the proportions are usually enough, and you want exact numbers only when you
  go looking

If a rate limit cuts a pass short, the button stays up with what is left on it,
to press again once the quota returns.

## What is excluded

Three passes. An excluded file counts as zero lines and shows as `generated` or
`binary` on the listing.

1. **Binaries** — images, fonts, archives, compiled output. Recognised by
   extension and always excluded, whatever the settings say
2. **`.gitattributes`** — files the repository itself declares
   `linguist-generated=true` or `linguist-vendored`. Its own declaration, so
   more accurate than any glob
3. **Exclude patterns** — by default `node_modules/`, `dist/`, `build/`,
   `vendor/`, `coverage/`, the usual lockfiles, `*.min.js`, `*.map`, `*.svg`,
   `*.pb.go`, `*.g.dart` and the like. Edit them in the options

`*` does not cross a slash; `**/` matches at any depth.

## How the counts are arrived at

The GitHub API has no endpoint for "how many lines is this file", so it takes
two passes.

1. **One Tree API request** gives every file's byte size. A per-language
   bytes-per-line ratio turns that into an estimate, and the bars are drawn
   immediately, marked `~`
2. The files in the directory on screen are **fetched in parallel and their
   `\n`s counted**, replacing the estimates as they land (the `~` goes). Each
   one also teaches the extension this repository's real bytes-per-line, so the
   files still estimated converge too

So the bars are there after one request, and sharpen over the next few seconds.

## The cache, and what it spends

### What is cached

| Data | Key | Kept |
|---|---|---|
| Line counts | blob SHA | Indefinitely |
| Trees | commit SHA | Indefinitely (the last 40) |
| `.gitattributes` | blob SHA | Indefinitely |

A git blob SHA is **a hash of the content**. A file whose content has not
changed is never fetched twice — not on another branch, not after a later
commit, not in a different repository.

### When a branch gets a commit

**It refetches.** A tree is cached under the commit SHA, so a push makes a new
key, which misses.

Only **what changed** is fetched again: counts are keyed by blob SHA, so a
commit touching one file costs one tree request plus one blob — two in total.

It does **not poll**. A new commit is noticed when the page is loaded again.
Leave a tab open while someone pushes and it goes on showing the commit it
loaded until you refresh.

### Measured

`npm run measure` takes the numbers. On `sindresorhus/got` (123 countable
files):

| Action | Requests | Time |
|---|---|---|
| Opening the repository root, first time | **126** (1 tree + 124 blobs + 1 free rate check) | 6.8 s |
| Opening the same repository again | **0** | 1.9 s |
| Into a subdirectory | **0** | 2.1 s |

Only 125 of those count against the budget; `/rate_limit` does not.

The rule of thumb is "countable files + 1". But counting stops at **300 files
per view**, so beyond that it does not take everything at the root — it fetches
what the directory you actually opened needs. The tree stays one request even
for a monorepo of ten thousand files.

The rate limit is 60 an hour unauthenticated (per IP) and 5,000 with a token —
**per user account, not per token**, so it is shared with anything else signed
in as you, the `gh` CLI included. [API use and terms](api-usage-and-terms.md)
has the detail.

Set "Fetching exact line counts" to **manual** or **off** and opening a page
costs **the one tree request**.
