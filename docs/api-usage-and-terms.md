# API use and terms

Where this extension stands against GitHub's terms. **This is not legal
advice**, but it names the clauses and what was implemented against each.

## In short

GitHub's terms **explicitly permit collecting information through the API**, and
what this extension does sits inside that. What they forbid is chiefly evading
rate limits, making excessive requests, and spamming or selling personal
information. None of it applies here.

## The clauses

### Scraping and the API are distinguished

[GitHub Acceptable Use Policies §7](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies):

> Scraping refers to extracting information from our Service via an automated process,
> such as a bot or webcrawler. **Scraping does not refer to the collection of information
> through our API.**

The file listing and the file contents both come from the **official REST API**
(`/git/trees`, `/git/blobs`). Nothing is lifted out of the HTML.

The page's DOM is read, but only for which repository, branch and directory you
have open. That is reading a page you opened yourself, in your own browser —
not a bot walking the site.

### What is forbidden, and what was built against it

[GitHub Terms of Service §H (API Terms)](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service):

| The term | What this does |
|---|---|
| "You may not share API tokens to exceed GitHub's rate limitations." | Each person's tokens stay in their own machine's `chrome.storage.local`. Nothing is shared or proxied: there is no server in the middle, only the browser talking to `api.github.com` |
| "Abuse or excessively frequent requests to GitHub via the API may result in … suspension." | See "Not asking too often", below |
| "You may not use the API to download data or Content from GitHub for spamming purposes, including for the purposes of selling GitHub users' personal information." | What is taken is byte sizes and line counts. No personal information is touched, sent, stored or sold |

### Not asking too often

Built against [GitHub's rate limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and its [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

| GitHub's guidance | What this does |
|---|---|
| No more than 100 concurrent requests | **8** by default, 16 at most |
| REST GETs up to 900 points a minute | Caps itself at **600 requests a minute** (a token bucket in the service worker) |
| Honour `retry-after` before sending again | A 403 or 429 carrying `retry-after` **stops every request** until that moment |
| Send nothing while `x-ratelimit-remaining` is 0 | Stops until `x-ratelimit-reset`, with the time left shown in the UI |
| Wait at least a minute on a secondary rate limit | 60 seconds, where no `retry-after` is given |

### It only reads

Every request is a **GET**. No writing or deleting endpoint is ever called.
Because classic tokens have no read-only scope for contents, some people have no
choice but to configure a token that can write; as an assurance, the smoke run
asserts on every run that every API request was a GET.

The best-practice clause about spacing `POST`/`PATCH`/`PUT`/`DELETE` a second
apart simply does not arise.

Beyond that, most of the design is about not making the request at all.

- **One tree request for the whole repository** (`?recursive=1`), not one per
  directory
- **A permanent cache keyed by blob SHA.** A git blob SHA is a hash of the
  content, so a file counted once is never fetched again
- **Identical requests collapse.** Concurrent requests for the same URL become
  one
- **A ceiling of 300 files per view**, so a huge repository never turns into
  thousands of requests at once

Measured: a 123-file repository costs 125 requests the first time and 0 after
that (`npm run measure`).

## Several tokens

Several accounts' tokens can be registered, and there is a line drawn in the
design so that this stays within the terms.

The clause at issue:

> You may not share API tokens to exceed GitHub's rate limitations.

**What that forbids is cycling tokens to get past a limit.** Registering several
accounts' tokens is not a way around anything — it is a necessity: a token
issued by account A technically cannot read account B's private repositories.

So:

| | |
|---|---|
| **What it does** | Fix, deterministically, one token per repository owner |
| **What it will not do** | Rotate tokens against the same repository to win more budget |

The same owner always resolves to the same token. Nor does it switch tokens when
a budget runs out: it waits for that account's window to reset.

There is a search through the other tokens when a repository comes back 404, but
that is to work out once which account can see it. The answer is remembered and
fixed from then on; it is never used to add up budgets.

Tokens are also only ever stored on their owner's own machine, with no path to
anyone else's — there is no server in the middle, only the browser talking to
`api.github.com`.

## What a rate limit counts

| | Counted per | Limit |
|---|---|---|
| Unauthenticated | Source IP | 60 an hour |
| Personal access token | **User account** | 5,000 an hour |

Per account rather than per token, so the budget is shared with anything else
signed in as you — the `gh` CLI, CI, and the rest.

There is **no metered billing** on GitHub's REST API. Exceeding a limit costs
nothing; it means waiting for the window to reset.

## A browser extension changing GitHub's pages

Nothing in GitHub's terms forbids changing what your own browser shows you.
[Refined GitHub](https://github.com/refined-github/refined-github) and much of
the [list GitHub itself points to](https://github.com/stefanbuck/awesome-browser-extensions-for-github)
do exactly this.

## Worth keeping in mind

- **This is not legal advice.** Terms change, and the judgement is GitHub's
- **Pointing it at an employer's GitHub** brings your company's own policies —
  whether PATs may be issued, what tools may touch source code. Check those.
  This extension does fetch file contents through the API, to count their
  lines. Those contents are turned into a number in memory and **never stored or
  sent anywhere**; what the cache keeps is the integer
- **Publishing on the Chrome Web Store** brings Google's policies as well
  (Limited Use, minimal permissions, a posted privacy policy). None of that
  applies to loading it unpacked

## References

- [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)
- [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
