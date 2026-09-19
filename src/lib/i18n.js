/* Locale strings, from `_locales/<lang>/messages.json`.

   By default they come from chrome.i18n, which picks the catalogue from the
   *browser's* UI language — not the page's — falling back to the manifest's
   `default_locale`. That is what an extension is expected to do, so it is the
   default here too.

   A reader who wants one particular language sets it in the options, and that
   is the only case this file does anything more: chrome.i18n has no override,
   so the chosen catalogue is loaded and consulted first. A content script
   cannot fetch a packaged file directly — that would mean making `_locales`
   web-accessible, and readable by every page — so it asks the service worker,
   which can.

   Outside an extension context — the test harness — a missing catalogue hands
   back the key, so a failure reads as the key rather than as an empty box. */
(function (GHL) {
  'use strict';

  const SUPPORTED = ['en', 'ja'];

  let chosen = null;     // the catalogue to consult first, or null to follow the browser
  let chosenFor = '';    // which locale `chosen` holds
  let inFlight = null;

  function substitute(message, subs) {
    return message.replace(/\$(\d)/g, (_, i) => {
      const v = subs[Number(i) - 1];
      return v === undefined ? '' : v;
    });
  }

  function t(key, ...subs) {
    const list = subs.map((v) => String(v));
    if (chosen && chosen[key]) return substitute(chosen[key].message, list);
    const i18n = globalThis.chrome && chrome.i18n;
    const s = i18n ? i18n.getMessage(key, list) : '';
    return s || key;
  }

  /* Counted nouns. Chrome's catalogues have no plural forms, so the two English
     ones are separate keys and Japanese points both at the same string. */
  function count(key, n, formatted) {
    return t(n === 1 ? `${key}One` : key, formatted);
  }

  async function catalogue(locale) {
    const path = `_locales/${locale}/messages.json`;
    // An extension page can read its own package; a content script has to ask.
    if (location.protocol === 'chrome-extension:') {
      const res = await fetch(chrome.runtime.getURL(path));
      return res.json();
    }
    const res = await GHL.util.send({ type: 'LOCALE', locale });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'no catalogue');
    return res.messages;
  }

  /* Reads the chosen locale and loads its catalogue if that is not what is
     already loaded. Resolves once `t` is answering in the right language, so
     callers can await it before their first render. Safe to call repeatedly. */
  // Which call is the current one: catalogues are fetched from the service
  // worker, so two changes in quick succession can come back out of order.
  let generation = 0;

  function load() {
    const mine = ++generation;
    inFlight = (async () => {
      // Reading the choice can fail too — an extension reloaded under an open
      // tab, say. The browser's own language is a working answer; never
      // booting is not.
      let settings = null;
      try { settings = GHL.settings ? await GHL.settings.get() : null; } catch (_) { settings = null; }
      const want = settings && SUPPORTED.includes(settings.locale) ? settings.locale : '';
      if (mine !== generation || want === chosenFor) return;
      if (!want) {
        chosen = null;
        chosenFor = '';
        return;
      }
      try {
        const messages = await catalogue(want);
        if (mine !== generation) return; // a later choice has taken over
        chosen = messages;
        chosenFor = want;
      } catch (_) {
        // Fall back to the browser's language rather than to empty labels.
        chosen = null;
        chosenFor = '';
      }
    })();
    return inFlight;
  }

  function ready() {
    return inFlight || load();
  }

  /* `data-i18n` on an element replaces its text; the variants set an attribute
     instead, and `-html` its markup. The markup case exists for the few
     sentences that carry a <code> or a <strong>; the strings come from the
     extension's own bundle, never from a page. */
  const BINDINGS = [
    ['data-i18n', (node, s) => { node.textContent = s; }],
    ['data-i18n-html', (node, s) => { node.innerHTML = s; }],
    ['data-i18n-title', (node, s) => node.setAttribute('title', s)],
    ['data-i18n-placeholder', (node, s) => node.setAttribute('placeholder', s)],
    ['data-i18n-label', (node, s) => node.setAttribute('aria-label', s)],
  ];

  function applyDom(root) {
    const scope = root || document;
    for (const [attr, set] of BINDINGS) {
      for (const node of scope.querySelectorAll(`[${attr}]`)) {
        set(node, t(node.getAttribute(attr)));
      }
    }
    return scope;
  }

  GHL.i18n = { t, count, applyDom, load, ready, SUPPORTED };
  GHL.t = t;
})(globalThis.GHL);
