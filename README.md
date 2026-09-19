# GitHub Lines

[日本語](README.ja.md)

A Chrome extension that puts a bar on GitHub's file list showing **each entry's
share of the lines in that directory**.

Let an AI write code for a while and one file tends to swell out of proportion
to the rest — but GitHub's own listing shows you nothing but names, so you never
see it happen. This makes it obvious in the browser, without cloning anything.

![The file list](docs/screenshot-file-list-vue.png)

That `apiSetupHelpers.ts` is nearing the warning threshold at 573 lines, and
that `compat/` and `components/` carry 13% of the directory each, are both there
the moment the page opens. (The pictures are Vue's `runtime-core` package.)

The "Treemap" button switches to a view where **area is line count**. Click a
directory to drill into it.

![The treemap](docs/screenshot-treemap-vue.png)

## Setting it up

There is nothing to build. Five minutes, in order:

### 1. Load the extension

1. Clone this repository, or [download the ZIP](https://github.com/ebi-oishii/github-lines/archive/refs/heads/main.zip) and unpack it
2. Open `chrome://extensions`
3. Turn on "Developer mode", top right
4. "Load unpacked", and pick the directory holding `manifest.json`

Open any GitHub repository and it is working. It does not go and count lines on
its own, so start by pressing "Fetch line counts" in the strip above the file
list.

### 2. Open the options

If you have pinned it to the toolbar, click the icon. Otherwise, from
`chrome://extensions`, under GitHub Lines, click "Extension options".

Settings are saved as you change them. There is no Save button.

### 3. Add a token (needed for private repositories)

It works on public repositories without one, but the GitHub API allows 60
requests an hour unauthenticated. A token raises that to 5,000 and reaches
private repositories.

1. [Create a fine-grained token](https://github.com/settings/personal-access-tokens/new).
   The only permission it needs is `Repository permissions → Contents: Read-only`
2. Paste it into "Access tokens" in the options
3. Press "Verify and fill in the owners". The accounts and organizations that
   token can actually read are filled in for you

How to create one in detail, and what to watch for with organizations and SAML
SSO, is in [Tokens](docs/token.md). If you keep separate accounts for personal
and work, you can [route a token per owner](docs/token.md#using-several-accounts).

### 4. Choose when it counts

| Mode | What it does | When |
|---|---|---|
| Manual (default) | Fetches nothing on open; counts when you press the button | You would rather a page you are passing through spent nothing |
| Automatic | Counts as soon as the page opens | You always want real numbers |
| Off | Estimates only | The proportions are enough |

Manual is the default so that a page you merely passed through does not spend
your API budget — 60 an hour, until you add a token. In manual mode the
checkbox on each row narrows what gets fetched. See
[Usage](docs/usage.md#when-it-counts).

### 5. Language (optional)

It follows your browser's language by default (English or Japanese). You can pin
one under "Display → Language" in the options.

### Updating

If you cloned it: `git pull`, then press reload on GitHub Lines in
`chrome://extensions`. GitHub tabs you had open need a refresh.

## Reading the display

| What you see | What it means |
|---|---|
| Bar length | **Relative to the largest entry in that directory** — the top one is always full |
| `52%` | Its **actual share** of the directory's total |
| `~1,204` | An estimate; the real count has not been fetched |
| Blue → green → amber → red | Continuous with the line count (amber at 500, red at 800 and above; both configurable) |
| Pale → deep violet | A directory, deepening with **the largest file inside it** |
| | On the Size reading, the same ramp with the thresholds read in bytes |
| `generated` `binary` | Not counted |

[Usage](docs/usage.md) has the rest.

## Documentation

| | |
|---|---|
| [Usage](docs/usage.md) | Reading the display, every setting, exclusions, the cache and what it spends |
| [Tokens](docs/token.md) | Creating and registering a PAT, organizations, SAML SSO |
| [Troubleshooting](docs/troubleshooting.md) | No bars, counts that disagree, and the rest |
| [API use and terms](docs/api-usage-and-terms.md) | How this extension treats GitHub's terms and rate limits |

## Limits

- `github.com` only (GitHub Enterprise Server is not supported)
- A "line" is what `wc -l` counts. Blank lines and comments are not told apart
- On a repository large enough for the Tree API to answer `truncated` — around
  100,000 files — nested directory totals are incomplete, and the status line
  says so

## Licence

[Apache-2.0](LICENSE)
