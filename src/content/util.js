/* Small DOM / async helpers shared by the content scripts. */
(function (GHL) {
  'use strict';

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else node.setAttribute(k, v);
      }
    }
    for (const c of [].concat(children || [])) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  const nf = new Intl.NumberFormat('en-US');
  const fmt = (n) => nf.format(Math.round(n));

  function fmtCompact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function throttle(fn, ms) {
    let last = 0;
    let pending = null;
    let timer = null;
    return function (...args) {
      const now = Date.now();
      const wait = ms - (now - last);
      pending = args;
      if (wait <= 0) {
        last = now;
        fn.apply(this, pending);
        pending = null;
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          if (pending) { fn.apply(this, pending); pending = null; }
        }, wait);
      }
    };
  }

  /* Run `tasks` (thunks returning promises) with bounded concurrency, calling
     `onEach` as each settles. Never rejects; failures surface as onEach(null). */
  async function pool(tasks, limit, onEach) {
    let i = 0;
    const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
      while (i < tasks.length) {
        const idx = i++;
        let result = null;
        let error = null;
        try { result = await tasks[idx](); } catch (e) { error = e; }
        if (onEach) onEach(result, idx, error);
      }
    });
    await Promise.all(workers);
  }

  function sendOnce(msg, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      // MV3 service workers are terminated when idle. Normally Chrome reports
      // that through lastError, but a worker killed mid-request can leave the
      // callback hanging forever — which would freeze the UI with no
      // explanation. Always bound the wait.
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);

      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            finish({ ok: false, error: 'disconnected', message: chrome.runtime.lastError.message });
          } else {
            finish(res || { ok: false, error: 'empty' });
          }
        });
      } catch (e) {
        finish({ ok: false, error: 'invalidated', message: String(e) });
      }
    });
  }

  const RETRYABLE = new Set(['timeout', 'disconnected', 'empty']);

  async function send(msg, { timeoutMs = 20000, retries = 1 } = {}) {
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      last = await sendOnce(msg, timeoutMs);
      if (last.ok || !RETRYABLE.has(last.error)) return last;
      // The first message after the worker sleeps often fails; the retry wakes it.
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
    return last;
  }

  /* GitHub navigates client-side. It emits turbo/soft-nav events, but not
     reliably for every route, so a debounced URL check on DOM mutation is the
     backstop. History patching is not an option: the content script runs in an
     isolated world, so the page's own pushState calls are invisible to us. */
  function onNavigate(cb) {
    let last = location.href;
    const check = () => {
      if (location.href === last) return;
      last = location.href;
      cb();
    };
    const checkSoon = GHL.util.debounce(check, 60);

    for (const evt of ['turbo:load', 'turbo:render', 'pjax:end', 'soft-nav:end']) {
      document.addEventListener(evt, () => cb());
    }
    window.addEventListener('popstate', checkSoon);

    new MutationObserver(checkSoon).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  /* Re-run `cb` when the page's own React re-render wipes our injected nodes.
     Debounced hard: GitHub mutates the DOM constantly. */
  function onDomSettle(cb, ms = 250) {
    const debounced = GHL.util.debounce(cb, ms);
    const mo = new MutationObserver(debounced);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }

  GHL.util = { el, fmt, fmtCompact, fmtBytes, debounce, throttle, pool, send, onNavigate, onDomSettle };
})(globalThis.GHL);
