/* Squarified treemap, rendered as nested absolutely-positioned divs.

   Area is proportional to line count, so a file that has swallowed half a
   package is literally half the picture. */
(function (GHL) {
  'use strict';

  const { util } = GHL;
  const { el, fmt, fmtCompact } = util;

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

  function childrenOf(node) {
    const kids = [...node.children.values()]
      .filter((n) => (n.total || 0) > 0)
      .sort((a, b) => b.total - a.total);

    if (kids.length <= MAX_CHILDREN) return kids;

    const head = kids.slice(0, MAX_CHILDREN - 1);
    const rest = kids.slice(MAX_CHILDREN - 1);
    head.push({
      name: `他 ${rest.length} 件`,
      path: node.path,
      type: 'aggregate',
      children: new Map(),
      total: rest.reduce((s, n) => s + n.total, 0),
      fileCount: rest.reduce((s, n) => s + n.fileCount, 0),
      allExact: rest.every((n) => n.allExact),
      bytes: rest.reduce((s, n) => s + (n.bytes || 0), 0),
    });
    return head;
  }

  function drawNode(node, rect, depth, parentEl, opts) {
    const tile = el('div', { class: 'ghl-tm-tile' });
    tile.style.left = rect.x + 'px';
    tile.style.top = rect.y + 'px';
    tile.style.width = Math.max(0, rect.w - 1) + 'px';
    tile.style.height = Math.max(0, rect.h - 1) + 'px';

    const isDir = node.type === 'dir';
    const approx = node.allExact ? '' : '~';
    const share = opts.rootTotal > 0 ? (node.total / opts.rootTotal) * 100 : 0;

    tile.title =
      `${node.path || node.name}\n` +
      `${approx}${fmt(node.total)} 行 (${share.toFixed(1)}%)` +
      (isDir ? `\n${fmt(node.fileCount)} ファイル` : '') +
      (node.type === 'file' ? `\n${util.fmtBytes(node.size || 0)}` : '');

    const canRecurse =
      isDir &&
      depth < MAX_DEPTH &&
      rect.w > 64 &&
      rect.h > 44 &&
      node.children.size > 0;

    if (!canRecurse) {
      tile.classList.add('ghl-tm-leaf');
      tile.dataset.kind = node.type;
      tile.dataset.severity =
        node.type === 'file' ? GHL.inline.severity(node.total, opts.settings) : 'dir';

      if (rect.w > 44 && rect.h > 20) {
        tile.appendChild(el('span', { class: 'ghl-tm-label' }, [
          el('span', { class: 'ghl-tm-name', text: node.name + (isDir ? '/' : '') }),
          rect.h > 34 && rect.w > 60
            ? el('span', { class: 'ghl-tm-value', text: `${approx}${fmtCompact(node.total)}` })
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
      el('span', { class: 'ghl-tm-value', text: `${approx}${fmtCompact(node.total)}` }),
    ]);
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
    const kids = childrenOf(node);
    const placed = squarify(kids.map((n) => ({ node: n, value: n.total })), inner);
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
    const node = state.index && (state.index.get(path) || state.root);
    const canvas = modal.canvas;
    canvas.textContent = '';
    if (!node) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    // Breadcrumb + stats
    modal.crumbs.textContent = '';
    for (const c of buildBreadcrumb(state.ctx, path, drill)) modal.crumbs.appendChild(c);

    const approx = node.allExact ? '' : '~';
    modal.stats.textContent =
      `${approx}${fmt(node.total)} 行 · ${fmt(node.fileCount)} ファイル`;
    modal.status.textContent = statusLine(state);

    const opts = {
      settings: state.settings,
      rootTotal: node.total || 1,
      onDrill: drill,
      onSelect: (n) => {
        if (n.type === 'dir') drill(n.path);
        else if (n.type === 'file') location.assign(fileUrl(state.ctx, n.path));
      },
    };

    const kids = childrenOf(node);
    if (!kids.length) {
      canvas.appendChild(el('div', { class: 'ghl-tm-empty', text: 'カウント対象のファイルがありません' }));
      return;
    }

    const placed = squarify(
      kids.map((n) => ({ node: n, value: n.total })),
      { x: 0, y: 0, w: rect.width, h: rect.height }
    );
    for (const p of placed) {
      drawNode(p.node, { x: p.x, y: p.y, w: p.w, h: p.h }, 0, canvas, opts);
    }
  }

  function statusLine(state) {
    if (state.status === 'refining') {
      return `実行数を取得中 ${state.progress.done}/${state.progress.total} — 残りはバイト数からの推定（~ 付き）`;
    }
    if (state.status === 'estimated') return 'バイト数から推定中…';
    if (state.warning) return GHL.inline.errorText(state.warning);
    if (state.truncated) return '巨大リポジトリのため一部推定';
    return '面積 = 行数';
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

    const overlay = el('div', { id: OVERLAY_ID, class: 'ghl-overlay' }, [
      el('div', { class: 'ghl-modal', role: 'dialog', 'aria-label': 'GitHub Lines treemap' }, [
        el('div', { class: 'ghl-modal-head' }, [
          crumbs,
          stats,
          el('span', { class: 'ghl-spacer' }),
          el('a', {
            class: 'ghl-btn ghl-btn-quiet',
            href: dirUrl(state.ctx, state.ctx.path),
            title: 'このディレクトリを GitHub で開く',
          }, ['開く']),
          el('button', {
            class: 'ghl-btn ghl-btn-quiet', type: 'button', 'aria-label': '閉じる',
            onclick: close,
          }, ['✕']),
        ]),
        canvas,
        el('div', { class: 'ghl-modal-foot' }, [
          el('span', { class: 'ghl-legend' }, [
            el('span', { class: 'ghl-legend-item', 'data-tone': 'ok' }, [
              el('span', { class: 'ghl-legend-dot' }), '通常',
            ]),
            el('span', { class: 'ghl-legend-item', 'data-tone': 'warn' }, [
              el('span', { class: 'ghl-legend-dot' }),
              `${fmt(state.settings.warnLines)} 行以上`,
            ]),
            el('span', { class: 'ghl-legend-item', 'data-tone': 'danger' }, [
              el('span', { class: 'ghl-legend-dot' }),
              `${fmt(state.settings.dangerLines)} 行以上`,
            ]),
          ]),
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

    modal = { overlay, canvas, crumbs, stats, status, state, path: state.ctx.path, onKey, resizeObserver };
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
