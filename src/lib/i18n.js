/* Locale strings, from `_locales/<lang>/messages.json` via chrome.i18n.

   Chrome picks the catalogue from the *browser's* UI language, not the page's,
   falling back to the manifest's `default_locale`. There is no override: a
   reader whose Chrome is in English gets English on a Japanese repository,
   which is the behaviour every other extension has.

   Outside an extension context — the test harness — a missing catalogue hands
   back the key, so a failure reads as the key rather than as an empty box. */
(function (GHL) {
  'use strict';

  function t(key, ...subs) {
    const i18n = globalThis.chrome && chrome.i18n;
    const s = i18n ? i18n.getMessage(key, subs.map((v) => String(v))) : '';
    return s || key;
  }

  /* Counted nouns. Chrome's catalogues have no plural forms, so the two English
     ones are separate keys and Japanese points both at the same string. */
  function count(key, n, formatted) {
    return t(n === 1 ? `${key}One` : key, formatted);
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

  GHL.i18n = { t, count, applyDom };
  GHL.t = t;
})(globalThis.GHL);
