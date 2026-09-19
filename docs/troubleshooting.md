# Troubleshooting

Start with the status at the right of the summary strip, above the listing. Most
of the answers are there.

## No bars, no strip, nothing

| Check | Do |
|---|---|
| Is the extension enabled in `chrome://extensions`? | Enable it |
| Is this a page with a file list? | It works on a repository root and under `/tree/`. Not on issues, pull requests, or a single file's `/blob/` page |
| Has GitHub's markup changed? | See "When a GitHub change breaks it", below |

Right after reloading the extension, tabs that were already open have lost their
connection to it. Refresh the page.

## `The background is not responding`

Chrome has stopped the extension's service worker. Refreshing the page brings it
back. If it keeps happening, toggle the extension off and on in
`chrome://extensions`.

## `API rate limit (60/hour unauthenticated)`

Unauthenticated, GitHub allows 60 requests an hour. [Add a token](token.md) and
it becomes 5,000.

Seeing this *with* a token registered means the budget is shared with everything
else signed in as you — the `gh` CLI, CI, other extensions. The limit is **per
user account**, not per token.

## `Paused by GitHub's secondary rate limit` / `Fetched too fast — waiting`

This appears after opening a lot of directories in quick succession. The
extension is holding back on its own and will resume by itself; there is nothing
to do.

If it is constant, set "Fetching exact line counts" to **manual** in the
options — nothing is fetched until you press the button. Lowering "Fetch limit
per view" helps too.

## Nothing on a private repository / `Cannot reach the repository (check X's permissions)`

X is the label of the token that was actually used. Start there.

- **The wrong token was used** — add that repository's owner to the right
  token's "owners" field
  ([Using several accounts](token.md#using-several-accounts))
- **The right token failed** — its permissions are not enough. The org may need
  to allow it, or SAML SSO to be authorised; see
  [When an organization's repositories do not show](token.md#when-an-organizations-repositories-do-not-show)

With only one token registered, it is simply a matter of permissions.

## The wrong token keeps being used

A token with an empty "owners" field is only reached as the "default". Press
"Verify and fill in the owners" on it in the options and its account and
organizations are filled in.

Note that a token explicitly set for an owner is not followed by a search
through the others if it fails — an explicit setting is not something to
override quietly. Correct the setting instead.

## The counts stay marked `~`

`~` is an estimate from the byte size. One of these:

- Still counting — the status says `Counting lines 42/120`
- **"Fetching exact line counts" is set to manual** — press "Fetch line counts
  (N)" above the listing
- It is set to off — change it
- The view is past the fetch limit (300 files by default)
- The file is over 2 MB, which is not fetched
- A rate limit cut the pass short

A directory's total is marked `~` if anything below it still is.

## The counts disagree with GitHub

- They are **what `wc -l` counts** — blank lines and comments included
- Generated files and binaries are excluded, and say so on the listing as
  `generated` / `binary`
- A directory's number is the sum of every file below it

## A new commit is not showing

**Refresh the page.** The extension does not poll, so a tab left open goes on
showing the commit it loaded. A refresh refetches against the new commit, and
costs little — only the files that changed.

## The layout looks wrong, or a bar is in an odd place

GitHub's markup has probably changed. Open an issue and it will be fixed.

## When a GitHub change breaks it (for developers)

GitHub reworks its markup every few months. To fix it locally:

```bash
npm install
npm run fixture   # take in GitHub's current HTML
npm test          # the failures say which assumptions broke
```

If the response comes back without server-side rendering, hand it a page saved
from the browser instead:

```bash
node scripts/capture-fixture.mjs ./saved.html
```

## Clearing the cache

"Clear the cache", under "Advanced" in the options. Counts, trees and texts all
go, and are fetched again next time.
