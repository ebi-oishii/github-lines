/* Reading the GitHub page: what repo/ref/directory are we looking at, and
   which DOM rows correspond to which paths.

   Three layers, best first:
     1. The React app's embedded JSON — the only source that gives us the commit
        OID, which makes every cache entry immutable.
     2. <meta> tags + the ref-selector button — survives payload reshuffles, and
        knowing the real ref name makes the URL path unambiguous even for
        branches with a slash in the name.
     3. Pure URL parsing, assuming a single-segment ref.

   GitHub reshapes the payload periodically (it recently moved everything one
   level down into per-route objects), so layer 1 searches for the shapes it
   needs rather than hardcoding the route names. */
(function (GHL) {
  'use strict';

  const SHA_RE = /^[0-9a-f]{40}$/i;

  function parseEmbeddedScripts() {
    const out = [];
    for (const node of document.querySelectorAll(
      'script[type="application/json"][data-target="react-app.embeddedData"]'
    )) {
      try {
        const data = JSON.parse(node.textContent);
        if (data && data.payload) out.push(data.payload);
      } catch (_) { /* not JSON we can use */ }
    }
    return out;
  }

  /* Walks the payload looking for a `repo` with an ownerLogin, a `refInfo`
     carrying a currentOid, and the path of the directory being displayed. */
  function harvest(payload) {
    const found = { repo: null, refInfo: null };

    (function visit(obj, depth) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 4) return;

      if (!found.repo && obj.repo && obj.repo.ownerLogin && obj.repo.name) {
        found.repo = obj.repo;
      }
      if (obj.refInfo && obj.refInfo.name) {
        // Prefer whichever refInfo actually carries the commit OID.
        if (!found.refInfo || (!found.refInfo.currentOid && obj.refInfo.currentOid)) {
          found.refInfo = obj.refInfo;
        }
      }

      for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) visit(value, depth + 1);
      }
    })(payload, 0);

    return found;
  }

  /* Note what this deliberately does NOT return: a path.

     GitHub's router does not rewrite the embedded payload when it navigates
     client-side — the script still describes whichever directory the page was
     first loaded with. Trusting its `path` means every soft navigation labels
     the new rows with the previous directory's paths. The URL is the only
     source that is always current, so the path is always derived from it. */
  function contextFromPayload() {
    for (const payload of parseEmbeddedScripts()) {
      const found = harvest(payload);
      if (!found.repo || !found.refInfo) continue;
      return {
        owner: found.repo.ownerLogin,
        repo: found.repo.name,
        ref: found.refInfo.name,
        oid: found.refInfo.currentOid || found.refInfo.name,
        isPrivate: !!found.repo.private,
      };
    }
    return null;
  }

  function metaContent(name) {
    const node = document.querySelector(`meta[name="${name}"]`);
    return node ? node.getAttribute('content') : null;
  }

  function refFromDom() {
    const button = document.querySelector(
      '[data-testid="anchor-button"][aria-label$=" branch"], [data-testid="anchor-button"][aria-label$=" tag"]'
    );
    if (button) {
      const label = button.getAttribute('aria-label') || '';
      const stripped = label.replace(/\s+(branch|tag)$/, '').trim();
      if (stripped) return stripped;
    }
    const text = document.querySelector('.ref-selector-button-text-container');
    if (text && text.textContent.trim()) return text.textContent.trim();
    return '';
  }

  /* Splits `<ref>/<path>` given a candidate ref name. Returns null when the URL
     does not actually start with that ref, which is how we detect that a
     payload or DOM reading has gone stale. */
  function splitRef(rest, ref) {
    if (!ref) return null;
    const refParts = ref.split('/');
    if (rest.slice(0, refParts.length).join('/') !== ref) return null;
    return { ref, path: rest.slice(refParts.length).join('/') };
  }

  function getContext() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    const owner = parts[0];
    const repo = parts[1];
    const kind = parts[2];
    if (kind && kind !== 'tree' && kind !== 'blob') return null;

    const rest = parts.slice(3).map(decodeURIComponent);

    // owner/repo always come from the URL — it is the one thing that is never
    // stale. The payload is consulted only for the ref name, commit OID and
    // visibility, and only when it agrees the URL is about the same repo.
    const payload = contextFromPayload();
    const fromPayload = payload && payload.owner === owner && payload.repo === repo ? payload : null;
    const domRef = refFromDom();

    let ref = '';
    let path = '';
    let source = 'url';

    if (!rest.length) {
      // Repository root: no ref in the URL, so take whatever the page says.
      ref = (fromPayload && fromPayload.ref) || domRef || '';
      source = fromPayload ? 'payload' : (domRef ? 'dom' : 'url');
    } else {
      const split =
        (fromPayload && splitRef(rest, fromPayload.ref)) ||
        splitRef(rest, domRef);

      if (split) {
        ref = split.ref;
        path = split.path;
        source = fromPayload && split.ref === fromPayload.ref ? 'payload' : 'dom';
      } else {
        // Nothing on the page matched the URL. Assume a single-segment ref,
        // which is right for the overwhelming majority of branch names.
        ref = rest[0];
        path = rest.slice(1).join('/');
      }
    }

    if (!ref) return null;

    // The OID only describes this ref if the page was talking about this ref.
    const oid = fromPayload && fromPayload.ref === ref ? fromPayload.oid : ref;

    return {
      owner,
      repo,
      ref,
      oid,
      path,
      source,
      isPrivate: fromPayload
        ? fromPayload.isPrivate
        : metaContent('octolytics-dimension-repository_public') === 'false',
      isTree: kind !== 'blob',
      immutable: SHA_RE.test(oid),
    };
  }

  /* The container holding the file listing. Ordered newest-layout-first, with
     older layouts as fallbacks. */
  function findListContainer() {
    return (
      document.querySelector('table[aria-labelledby="folders-and-files"]') ||
      document.querySelector('[data-testid="folders-and-files"]') ||
      document.querySelector('.js-navigation-container[role="grid"]') ||
      document.querySelector('div[role="grid"].Details-content--hidden-not-important') ||
      null
    );
  }

  const ROW_SELECTOR = 'tr, .Box-row, [role="row"]';
  const NAME_CELL_SELECTOR = '.react-directory-filename-column';

  function isFileLink(href, prefix) {
    return href.startsWith(prefix) && /^(blob|tree)\//.test(href.slice(prefix.length));
  }

  /* Returns [{ el, hosts, name, type, path }].

     `hosts` is a list because each row carries two name cells — one for small
     screens and one for large — and only one of them is visible at a time. We
     inject into both and let GitHub's own media queries decide which shows. */
  function findRows(ctx) {
    const container = findListContainer();
    const scope = container || document.querySelector('main') || document.body;
    const prefix = `/${ctx.owner}/${ctx.repo}/`;
    const rows = [];

    for (const row of scope.querySelectorAll(ROW_SELECTOR)) {
      const anchors = [];
      for (const a of row.querySelectorAll('a[href]')) {
        if (isFileLink(a.getAttribute('href') || '', prefix)) anchors.push(a);
      }
      if (!anchors.length) continue;

      const first = anchors[0];
      const name = (first.getAttribute('title') || first.textContent || '').trim();
      // ".." is the go-to-parent row; a name with a slash means the anchor is
      // not a plain entry in this directory.
      if (!name || name === '..' || name.includes('/')) continue;
      if (/parent/i.test(first.getAttribute('aria-label') || '')) continue;

      const href = first.getAttribute('href') || '';
      const type = href.slice(prefix.length).startsWith('tree/') ? 'dir' : 'file';

      const hosts = [];
      for (const a of anchors) {
        const host = a.closest(NAME_CELL_SELECTOR) || a.closest('td') || a.parentElement;
        if (host && !hosts.includes(host)) hosts.push(host);
      }
      if (!hosts.length) continue;

      rows.push({
        el: row,
        hosts,
        name,
        type,
        path: ctx.path ? `${ctx.path}/${name}` : name,
      });
    }

    return rows;
  }

  /* The summary strip goes above the file table, inside the same column. */
  function findSummaryAnchor() {
    const container = findListContainer();
    if (!container) return null;
    return (
      container.closest('[data-hpc]') ||
      container.closest('.Box') ||
      container.parentElement
    );
  }

  GHL.page = {
    getContext,
    findListContainer,
    findRows,
    findSummaryAnchor,
  };
})(globalThis.GHL);
