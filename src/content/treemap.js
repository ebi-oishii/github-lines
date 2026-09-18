/* Squarified treemap, rendered as nested absolutely-positioned divs.

   Area is proportional to the chosen metric — line count by default, or file
   size — so a file that has swallowed half a package is literally half the
   picture. */
(function (GHL) {
  'use strict';

  const { util } = GHL;
  const { el, fmt } = util;
  const { t, count } = GHL.i18n;

  const linesOf = (n) => count('unitLines', n, fmt(n));
  const filesOf = (n) => count('unitFiles', n, fmt(n));

  const OVERLAY_ID = 'ghl-treemap-overlay';
  const HEADER_H = 17;
  const PAD = 2;
  const MAX_CHILDREN = 80;
  const MAX_DEPTH = 6;

  /* ------------------------------------------------------------- layout */

  function worst(row, side) {
    if (side <= 0) return Infinity;
    let sum = 0;
    let min = Infinity;
    let max = 0;
    for (const it of row) {
      sum += it.area;
      if (it.area < min) min = it.area;
      if (it.area > max) max = it.area;
    }
    if (sum <= 0) return Infinity;
    const s2 = sum * sum;
    const w2 = side * side;
    return Math.max((w2 * max) / s2, s2 / (w2 * min));
  }

  function placeRow(row, rect, out) {
    const sum = row.reduce((s, it) => s + it.area, 0);
    if (sum <= 0) return rect;

    if (rect.w >= rect.h) {
      const rw = sum / rect.h;
      let y = rect.y;
      for (const it of row) {
        const rh = it.area / rw;
        out.push({ node: it.node, x: rect.x, y, w: rw, h: rh });
        y += rh;
      }
      return { x: rect.x + rw, y: rect.y, w: rect.w - rw, h: rect.h };
    }

    const rh = sum / rect.w;
    let x = rect.x;
    for (const it of row) {
      const rw = it.area / rh;
      out.push({ node: it.node, x, y: rect.y, w: rw, h: rh });
      x += rw;
    }
    return { x: rect.x, y: rect.y + rh, w: rect.w, h: rect.h - rh };
  }

  function squarify(items, rect) {
    const out = [];
    if (rect.w <= 0 || rect.h <= 0) return out;

    const total = items.reduce((s, it) => s + it.value, 0);
    if (total <= 0) return out;

    const scale = (rect.w * rect.h) / total;
    const queue = items.map((it) => ({ node: it.node, area: it.value * scale }));

    let cur = { ...rect };
    let row = [];
    let i = 0;

    while (i < queue.length) {
      const side = Math.min(cur.w, cur.h);
      const next = queue[i];
      if (row.length === 0 || worst(row, side) >= worst(row.concat([next]), side)) {
        row.push(next);
        i++;
      } else {
        cur = placeRow(row, cur, out);
        row = [];
      }
    }
    if (row.length) placeRow(row, cur, out);
    return out;
  }

  /* -------------------------------------------------------------- render */

  function childrenOf(node, m) {
    const kids = [...node.children.values()]
      .filter((n) => m.value(n) > 0)
      .sort((a, b) => m.value(b) - m.value(a));

    if (kids.length <= MAX_CHILDREN) return kids;

    const head = kids.slice(0, MAX_CHILDREN - 1);
    const rest = kids.slice(MAX_CHILDREN - 1);
    head.push({
      name: t('restItems', rest.length),
      path: node.path,
      type: 'aggregate',
      children: new Map(),
      total: rest.reduce((s, n) => s + n.total, 0),
      fileCount: rest.reduce((s, n) => s + n.fileCount, 0),
      allExact: rest.every((n) => n.allExact),
      bytes: rest.reduce((s, n) => s + (n.bytes || 0), 0),
      maxFile: rest.reduce((s, n) => Math.max(s, n.maxFile || 0), 0),
    });
    return head;
  }

  function drawNode(node, rect, depth, parentEl, opts) {
    const tile = el('div', { class: 'ghl-tm-tile' });
    tile.style.left = rect.x + 'px';
    tile.style.top = rect.y + 'px';
    tile.style.width = Math.max(0, rect.w - 1) + 'px';
    tile.style.height = Math.max(0, rect.h - 1) + 'px';

    const m = opts.metric;
    const other = m.key === 'lines' ? GHL.inline.METRICS.bytes : GHL.inline.METRICS.lines;
    const isDir = node.type === 'dir';
    const share = opts.rootTotal > 0 ? (m.value(node) / opts.rootTotal) * 100 : 0;

    tile.title =
      `${node.path || node.name}\n` +
      `${m.long(node)} (${share.toFixed(1)}%)` +
      (isDir ? `\n${filesOf(node.fileCount)}` : '') +
      (isDir && m.key === 'lines' ? `\n${t('tipMaxFile', linesOf(node.maxFile || 0))}` : '') +
      `\n${other.long(node)}`;

    const canRecurse =
      isDir &&
      depth < MAX_DEPTH &&
      rect.w > 64 &&
      rect.h > 44 &&
      node.children.size > 0;

    if (!canRecurse) {
      tile.classList.add('ghl-tm-leaf');
      tile.dataset.kind = node.type;
      tile.dataset.severity = m.severity(node, opts.settings);
      // Tiles are translucent so the labels stay readable over them.
      tile.style.background = m.fill ? m.fill(node, opts.settings, 0.55) : '';

      if (rect.w > 44 && rect.h > 20) {
        tile.appendChild(el('span', { class: 'ghl-tm-label' }, [
          el('span', { class: 'ghl-tm-name', text: node.name + (isDir ? '/' : '') }),
          rect.h > 34 && rect.w > 60
            ? el('span', { class: 'ghl-tm-value', text: m.short(node) })
            : null,
        ]));
      }

      if (node.type !== 'aggregate') {
        tile.classList.add('ghl-tm-clickable');
        tile.addEventListener('click', (e) => {
          e.stopPropagation();
          opts.onSelect(node);
        });
      }
      parentEl.appendChild(tile);
      return;
    }

    tile.classList.add('ghl-tm-group');
    const head = el('div', { class: 'ghl-tm-head ghl-tm-clickable' }, [
      el('span', { class: 'ghl-tm-name', text: node.name + '/' }),
      el('span', { class: 'ghl-tm-value', text: m.short(node) }),
    ]);
    // The header is the only part of a folded-up directory you can see, so it
    // carries the same colour its tile would.
    head.style.background = m.fill ? m.fill(node, opts.settings, 0.55) : '';
    head.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onDrill(node.path);
    });
    tile.appendChild(head);
    parentEl.appendChild(tile);

    const inner = {
      x: PAD,
      y: HEADER_H,
      w: rect.w - PAD * 2 - 1,
      h: rect.h - HEADER_H - PAD - 1,
    };
    const kids = childrenOf(node, m);
    const placed = squarify(kids.map((n) => ({ node: n, value: m.value(n) })), inner);
    for (const p of placed) {
      drawNode(p.node, { x: p.x, y: p.y, w: p.w, h: p.h }, depth + 1, tile, opts);
    }
  }

  /* --------------------------------------------------------------- modal */

  let modal = null;

  function buildBreadcrumb(ctx, path, onDrill) {
    const crumbs = [];
    const parts = path ? path.split('/') : [];

    crumbs.push(
      el('button', { class: 'ghl-crumb', type: 'button', onclick: () => onDrill('') }, [ctx.repo])
    );
    let acc = '';
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const target = acc;
      crumbs.push(el('span', { class: 'ghl-crumb-sep', text: '/' }));
      crumbs.push(
        i === parts.length - 1
          ? el('span', { class: 'ghl-crumb ghl-crumb-current', text: part })
          : el('button', { class: 'ghl-crumb', type: 'button', onclick: () => onDrill(target) }, [part])
      );
    });
    return crumbs;
  }

  function fileUrl(ctx, path) {
    const segs = path.split('/').map(encodeURIComponent).join('/');
    return `/${ctx.owner}/${ctx.repo}/blob/${ctx.ref.split('/').map(encodeURIComponent).join('/')}/${segs}`;
  }

  function dirUrl(ctx, path) {
    const segs = path.split('/').map(encodeURIComponent).join('/');
    const ref = ctx.ref.split('/').map(encodeURIComponent).join('/');
    return path ? `/${ctx.owner}/${ctx.repo}/tree/${ref}/${segs}` : `/${ctx.owner}/${ctx.repo}/tree/${ref}`;
  }

  function draw() {
    if (!modal) return;
    const { state, path } = modal;
    const raw = state.index && (state.index.get(path) || state.root);
    // Manual mode's checkboxes filter the directory on screen; drilling into a
    // subdirectory shows all of it.
    const node = raw && state.settings.exactLinesMode === 'manual' && path === state.ctx.path
      ? GHL.inline.viewOf(raw, state)
      : raw;
    const canvas = modal.canvas;
    canvas.textContent = '';
    if (!node) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    // Breadcrumb + stats
    modal.crumbs.textContent = '';
    for (const c of buildBreadcrumb(state.ctx, path, drill)) modal.crumbs.appendChild(c);

    const m = GHL.inline.metricOf(state);
    modal.stats.textContent = `${m.long(node)} · ${filesOf(node.fileCount)}`;
    modal.status.textContent = statusLine(state, m);
    // The thresholds are line counts; the legend has nothing to say about sizes.
    modal.legend.hidden = m.key !== 'lines';

    const opts = {
      settings: state.settings,
      metric: m,
      rootTotal: m.value(node) || 1,
      onDrill: drill,
      onSelect: (n) => {
        if (n.type === 'dir') drill(n.path);
        else if (n.type === 'file') location.assign(fileUrl(state.ctx, n.path));
      },
    };

    const kids = childrenOf(node, m);
    if (!kids.length) {
      canvas.appendChild(el('div', { class: 'ghl-tm-empty', text: t('tmEmpty') }));
      return;
    }

    const placed = squarify(
      kids.map((n) => ({ node: n, value: m.value(n) })),
      { x: 0, y: 0, w: rect.width, h: rect.height }
    );
    for (const p of placed) {
      drawNode(p.node, { x: p.x, y: p.y, w: p.w, h: p.h }, 0, canvas, opts);
    }
  }

  function statusLine(state, m) {
    if (m.key === 'lines') {
      if (state.status === 'refining') {
        return t('tmRefining', state.progress.done, state.progress.total);
      }
      if (state.status === 'estimated') return t('statusEstimating');
    }
    if (state.warning) return GHL.inline.errorText(state.warning);
    if (state.truncated) return t(m.key === 'lines' ? 'statusTruncated' : 'statusTruncatedSizes');
    return t('tmArea', m.label);
  }

  function drill(path) {
    if (!modal) return;
    modal.path = path;
    draw();
  }

  function close() {
    if (!modal) return;
    modal.resizeObserver.disconnect();
    document.removeEventListener('keydown', modal.onKey);
    modal.overlay.remove();
    modal = null;
  }

  function open(state) {
    if (modal) { close(); }

    const canvas = el('div', { class: 'ghl-tm-canvas' });
    const crumbs = el('div', { class: 'ghl-tm-crumbs' });
    const stats = el('span', { class: 'ghl-tm-stats' });
    const status = el('span', { class: 'ghl-tm-status' });
    // The ramps themselves, with the warn threshold ticked on each.
    const rampBar = (colorAt) => el('span', {
      class: 'ghl-ramp-bar',
      style: {
        background: `linear-gradient(to right, ${GHL.inline.rampStops(state.settings, 12, colorAt).join(', ')})`,
      },
    }, [
      el('span', {
        class: 'ghl-ramp-tick',
        style: { left: `${(state.settings.warnLines / Math.max(2, state.settings.dangerLines)) * 100}%` },
        title: t('rampTick', linesOf(state.settings.warnLines)),
      }),
    ]);
    const legend = el('span', { class: 'ghl-legend ghl-ramps' }, [
      el('span', { class: 'ghl-ramp' }, [
        el('span', { class: 'ghl-ramp-end' }, [t('rampFileStart')]),
        rampBar(GHL.inline.lineColor),
        el('span', { class: 'ghl-ramp-end' }, [t('unitLinesOrMore', fmt(state.settings.dangerLines))]),
      ]),
      el('span', { class: 'ghl-ramp' }, [
        el('span', { class: 'ghl-ramp-end' }, [t('rampDirStart')]),
        rampBar(GHL.inline.dirColor),
        el('span', { class: 'ghl-ramp-end' }, [t('unitLinesOrMore', fmt(state.settings.dangerLines))]),
      ]),
    ]);

    const overlay = el('div', { id: OVERLAY_ID, class: 'ghl-overlay' }, [
      el('div', { class: 'ghl-modal', role: 'dialog', 'aria-label': t('tmLabel') }, [
        el('div', { class: 'ghl-modal-head' }, [
          crumbs,
          stats,
          el('span', { class: 'ghl-spacer' }),
          el('a', {
            class: 'ghl-btn ghl-btn-quiet',
            href: dirUrl(state.ctx, state.ctx.path),
            title: t('tmOpenTitle'),
          }, [t('tmOpen')]),
          el('button', {
            class: 'ghl-btn ghl-btn-quiet', type: 'button', 'aria-label': t('tmClose'),
            onclick: close,
          }, ['✕']),
        ]),
        canvas,
        el('div', { class: 'ghl-modal-foot' }, [
          legend,
          el('span', { class: 'ghl-spacer' }),
          status,
        ]),
      ]),
    ]);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);

    const resizeObserver = new ResizeObserver(util.debounce(draw, 80));
    resizeObserver.observe(canvas);

    modal = { overlay, canvas, crumbs, stats, status, legend, state, path: state.ctx.path, onKey, resizeObserver };
    draw();
  }

  function update(state) {
    if (!modal) return;
    modal.state = state;
    draw();
  }

  function isOpen() { return !!modal; }

  GHL.treemap = { open, close, update, isOpen, squarify };
})(globalThis.GHL);
