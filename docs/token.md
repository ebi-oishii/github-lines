# Tokens

It works on public repositories without one, but the GitHub API allows
**60 requests an hour** unauthenticated, counted per IP. A token raises that to
**5,000 an hour** and reaches private repositories.

## 0. Which kind to make

**It turns on whether you want to see an organization's repositories.** Get this
wrong and you end up with "only the private ones are missing" or "only the org's
are missing".

| | Fine-grained token | Classic token |
|---|---|---|
| What one can cover | **A single owner** — you *or* one organization | Your repositories **and every org you belong to** (`repo` scope) |
| Personal + an org | **One token per org**, all registered here | One is enough |
| The org's permission | Often needed, and may sit pending | Not needed unless the org bans classic tokens |
| SAML SSO | Needs authorising | Needs authorising |
| How fine the permissions go | Fine — `Contents: Read-only` alone | Coarse — `repo` includes write |

- **No organizations, or personal repositories only** → fine-grained
  (recommended; the permissions can be minimal)
- **Across several organizations** → classic is quicker, but `repo` grants write
  access, which some company policies forbid
- **A company org** → check its policy first. Some allow only fine-grained, some
  only classic, some put both behind approval

> By GitHub's design, a fine-grained token is
> [limited to "resources owned by a single user or organization"](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
> That constraint is exactly why this extension takes more than one token.

### Only fine-grained tokens can be read-only

A classic token **has no scope for read-only access to repository contents**.
`repo` is "read and write access to code", and `public_repo` is read/write on
public ones ([the scope list](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)).
A read-only scope has been requested of GitHub for years and does not exist for
classic tokens.

| What you want | How |
|---|---|
| Read-only | **A fine-grained token with `Contents: Read-only`, and nothing else.** One per org, all registered here |
| One token across orgs | Classic, with `repo` — which **hands over write access too** |

Those are the only two. "Across organizations" and "read-only" cannot both be
had, by GitHub's design rather than this extension's.

**This extension only ever issues GETs.** Give it a token that can write and it
still will not change anything. That is not a promise but a checked fact: the
smoke run asserts every API request was a GET, on every run
(`scripts/smoke.mjs`).

Press "Verify and fill in the owners" in the options and a token that carries
write access says so: `⚠ includes write access (repo, workflow)`.

## 1. Create the token on GitHub

### Fine-grained

https://github.com/settings/personal-access-tokens/new

| Field | Set it to |
|---|---|
| Token name | Anything (`github-lines`, say) |
| Expiration | As you like |
| **Resource owner** | **The one that matters.** Your account, or the **organization** you are after |
| Repository access | `All repositories`, or `Only select repositories` |
| **Permissions → Repository permissions → Contents** | **`Read-only`** — and nothing else |

`Metadata: Read-only` comes along automatically. Nothing else is needed.

**Choosing an organization as the resource owner** makes a token for that org's
repositories; your own are then out of its reach. To see both, **make two
tokens** and register both here
([Using several accounts](#using-several-accounts)).

If an org does not appear in the resource owner dropdown, that org does not
allow fine-grained tokens. Ask its administrators, or use a classic token.

Where an org requires approval, the token is created **`pending`** and cannot
reach private repositories until an owner approves it. (If you are an owner of
that org, it is approved for you.)

### Classic

https://github.com/settings/tokens/new

| Field | Set it to |
|---|---|
| Scope | `repo` (or `public_repo`, for public repositories only) |

That one token reaches your repositories and those of **every org you belong
to**. If any of them use SAML SSO, open the token list afterwards and
**"Configure SSO" → Authorize** each org. Forget this and you get 404s.

---

"Generate token" shows it once. Copy it — leave the page and it is gone.

## 2. Register it here

1. Open `chrome://extensions`
2. Under **GitHub Lines**, "Details" → **Extension options**
   (or right-click the toolbar icon → "Options")
3. Paste it into **Personal access token**
4. Press **"Verify and fill in the owners"** — something like
   `valid as your-name — reaches: your-name, my-org` means it worked, and the
   owners that token can see are filled in for you

Settings save themselves; there is no Save button.

For a second token, press "+ Add a token" and do the same on the new row.

Saving reaches any open GitHub tab at once.

## 3. Check it took

Open a private repository and see the bars.

If you can only try a public one, watch the right of the summary strip: the
`API rate limit (60/hour unauthenticated)` warning stops appearing.

## Using several accounts

With more than one GitHub account — personal and work, say — **register a token
each and route them per owner** (a username or an organization name).

A token issued by one account cannot read another account's private
repositories, so which token goes with which repository has to be decided.

### Setting it up

"+ Add a token" adds a row. On each:

| Field | What goes in it |
|---|---|
| Label | A name to recognise it by (`personal`, `work`). Error messages use it |
| Personal access token | The token that account issued |
| Owners this token is for | Comma separated (`your-name, my-org`) |
| Default | The one to use when no owner matches |

**"Verify and fill in the owners"** asks GitHub which repositories that token can
actually see and fills the field from their owners. It reads the token's real
reach rather than who issued it, so a fine-grained token made for an
organization gets that organization's name, not yours.

> Past 100 visible repositories it takes the owners from the first 100, most
> recently pushed. Add any others by hand.

### How one is picked

1. The repository's owner matches some token's "owners" field — use that one
2. No match — the "default" token
3. No default — the first token
4. No tokens — unauthenticated

Owner names are matched case-insensitively.

### Searching, when nothing matches

If only tokens with an empty "owners" field are registered and a repository
comes back 404 — invisible to the one that was tried — the others are tried in
turn. The one that works is remembered for that owner, so the search happens
once per owner.

But **a token explicitly set for that owner is not followed by a search**. An
explicit setting is a statement of intent, and quietly reaching for another
account would be the wrong thing to do with it. You get
`Cannot reach the repository (check work's permissions)` instead, naming the
token that failed.

### About rate limits

Rate limits are per account, so separate accounts have separate budgets. But
this extension **fixes one token per owner**: it will not rotate tokens against
the same repository to stretch a limit
([why, in terms](api-usage-and-terms.md#several-tokens)).

## When an organization's repositories do not show

In order:

### 1. The kind of token, and its resource owner

| What you see | Why | What to do |
|---|---|---|
| Only the org's are missing; yours appear | The fine-grained token's resource owner is you | Make another with that org as the resource owner and add it here |
| The org is not in the resource owner dropdown | That org does not allow fine-grained tokens | Ask its administrators, or use a classic token with `repo` |
| No org's repositories appear at all | A classic token without SSO authorisation | Token list → "Configure SSO" → Authorize the org |

A fine-grained token covers one owner, so **personal + org A + org B needs three
tokens**. Register each and put the matching names in its "owners" field
([Using several accounts](#using-several-accounts)).

### 2. Is it pending approval?

Where an org requires approval, a new token stays `pending` and unusable. Check
at https://github.com/settings/personal-access-tokens — `Pending` means an owner
of that org has yet to approve it.

### 3. Does the org's policy forbid it?

Under the org's Settings → Third-party Access / Personal access tokens,
fine-grained or classic tokens may be restricted. Company orgs often do this.

### What the extension says

| Message | Why |
|---|---|
| `Private repository — add a token in the options` | No token registered |
| `Cannot reach the repository (check X's permissions)` | The token labelled X could not see it: too few permissions, the org has not allowed it, approval pending, or SSO not authorised |
| `X is not valid — check the options` | Expired, revoked, or pasted wrong |

If the token named is not the one you meant, add that repository's owner to the
right token's "owners" field.

## Where they are kept, and what that means

- Tokens live in `chrome.storage.local` — **this machine only**
- `chrome.storage.sync` is not used, so nothing travels to your other machines
  through your Google account
- They are sent to `api.github.com` and nowhere else (the extension's
  `host_permissions` are `github.com` and `api.github.com`)
- To remove one, clear its token field, or press "Restore defaults"

Keep the permission to `Contents: Read-only` and a leaked token exposes the file
contents of the repositories you named, and cannot write to any of them.
