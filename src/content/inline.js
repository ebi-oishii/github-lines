/* Inline UI: a proportion bar on every row of the file list, plus a summary
   strip above the table.

   Bar width is scaled to the *largest* item in the directory rather than to the
   directory total. Scaling to the total makes every row in a 30-file directory
   a 3% sliver, which hides exactly the outlier we are trying to surface. The
   percentage text still reports the true share of the directory. */
(function (GHL) {
  'use strict';

  const { util } = GHL;
  const { el, fmt, fmtCompact } = util;

  const SUMMARY_ID = 'ghl-summary';
  const CELL_CLASS = 'ghl-cell';

  function severity(lines, settings) {
    if (lines >= settings.dangerLines) return 'danger';
    if (lines >= settings.warnLines) return 'warn';
    return 'ok';
  }

  function approxPrefix(node) {
    return node.allExact ? '' : '~';
  }

  /* The two things a node can be measured by. Lines are what the extension is
     for; bytes come free with the tree listing and are always exact, so they
     carry no `~` and no thresholds. */
  const METRICS = {
    lines: {
      key: 'lines',
      label: '行数',
      value: (n) => n.total || 0,
      cell: (n) => approxPrefix(n) + fmt(n.total || 0),
      short: (n) => approxPrefix(n) + fmtCompact(n.total || 0) + ' 行',
      long: (n) => `${approxPrefix(n)}${fmt(n.total || 0)} 行`,
      fmtTotal: (v) => `${fmt(v)} 行`,
      severity: (n, settings) => (n.type === 'file' ? severity(n.total || 0, settings) : 'dir'),
    },
    bytes: {
      key: 'bytes',
      label: 'サイズ',
      value: (n) => n.bytes || 0,
      cell: (n) => util.fmtBytes(n.bytes || 0),
      short: (n) => util.fmtBytes(n.bytes || 0),
      long: (n) => util.fmtBytes(n.bytes || 0),
      fmtTotal: (v) => util.fmtBytes(v),
      severity: (n) => (n.type === 'file' ? 'ok' : 'dir'),
    },
  };

  function metricOf(state) {
    return METRICS[state.metric] || METRICS.lines;
  }

  /* ------------------------------------------------------------ row cells */

  const PICK_CLASS = 'ghl-row-pick';

  function cellIn(host) {
    let cell = host.querySelector(`:scope > .${CELL_CLASS}`);
    if (!cell) {
      cell = el('span', { class: CELL_CLASS }, [
        el('span', { class: 'ghl-bar' }, [el('span', { class: 'ghl-bar-fill' })]),
        el('span', { class: 'ghl-num' }),
        el('span', { class: 'ghl-pct' }),
      ]);
      host.appendChild(cell);
    }
    return cell;
  }

  /* Manual mode's checkbox goes at the head of the row, before GitHub's file
     icon — the bar cell sits at the far end of the name column. */
  function pickIn(host, handlers) {
    let pick = host.querySelector(`:scope > .${PICK_CLASS}`);
    if (!pick) {
      pick = el('input', { class: PICK_CLASS, type: 'checkbox' });
      // The row may navigate on click; keep the toggle to ourselves.
      pick.addEventListener('click', (e) => e.stopPropagation());
      pick.addEventListener('change', () => {
        if (handlers.onPick) handlers.onPick(pick.dataset.ghlPath, pick.checked);
      });
      host.insertBefore(pick, host.firstChild);
    }
    return pick;
  }

  /* A row has one name cell per breakpoint; paint every one of them. */
  function renderRow(row, node, dirTotal, maxTotal, state, handlers, manual, included) {
    for (const host of row.hosts) {
      paintPick(pickIn(host, handlers), row.path, state, manual);
      paintCell(cellIn(host), row, node, dirTotal, maxTotal, state, included);
    }
  }

  /* Whether manual mode's checkbox for a row is ticked. Rows are always
     included outside manual mode. */
  function isIncluded(state, path) {
    return !(state.deselected && state.deselected.has(path));
  }

  /* Manual mode's checkbox column is up for the whole view. A ticked row is
     in: its bar and number show, it counts towards the totals and the
     percentages, and its files are what "行数を取得" fetches. Untick it and it
     drops out of all of that. Other modes have no column. */
  function paintPick(pick, path, state, manual) {
    pick.dataset.ghlPath = path;
    if (!manual) { pick.dataset.pick = 'none'; return; }
    pick.dataset.pick = 'on';
    pick.checked = isIncluded(state, path);
    const left = (state.pickable && state.pickable.get(path)) || 0;
    pick.title = 'この行を表示と取得に含める' + (left ? `（未取得 ${fmt(left)} ファイル）` : '');
  }

  /* Manual mode's view of the directory: the unticked rows dropped, totals
     recomputed over what is left. Feeds the strip, the percentages and the
     treemap alike. */
  function viewOf(dirNode, state) {
    const children = new Map();
    let total = 0;
    let bytes = 0;
    let fileCount = 0;
    let allExact = true;
    for (const [name, child] of dirNode.children) {
      if (!isIncluded(state, child.path)) continue;
      children.set(name, child);
      total += child.total || 0;
      bytes += child.bytes || 0;
      fileCount += child.fileCount || 0;
      if (!child.allExact) allExact = false;
    }
    return { ...dirNode, children, total, bytes, fileCount, allExact };
  }

  function paintCell(cell, row, node, dirTotal, maxTotal, state, included) {
    const settings = state.settings;
    const fill = cell.querySelector('.ghl-bar-fill');
    const num = cell.querySelector('.ghl-num');
    const pct = cell.querySelector('.ghl-pct');

    // Unticked in manual mode: out of the picture, but the cell keeps its
    // footprint so the column does not reflow.
    if (!included) {
      cell.dataset.ghlPath = row.path;
      cell.dataset.state = 'off';
      cell.dataset.severity = 'none';
      fill.style.width = '0%';
      num.textContent = '';
      pct.textContent = '';
      cell.title = '';
      return;
    }

    if (!node) {
      cell.dataset.ghlPath = row.path;
      cell.dataset.state = 'unknown';
      fill.style.width = '0%';
      num.textContent = '–';
      pct.textContent = '';
      cell.title = 'GitHub Lines: この項目の情報を取得できませんでした（サブモジュール等）';
      return;
    }

    const m = metricOf(state);
    const total = m.value(node);
    const isFile = node.type === 'file';
    const excluded = isFile && node.excluded;

    cell.dataset.ghlPath = node.path;
    cell.dataset.state = excluded ? 'excluded' : (isFile ? 'file' : 'dir');
    cell.dataset.severity = excluded ? 'none' : m.severity(node, settings);

    if (excluded) {
      fill.style.width = '0%';
      num.textContent = node.binary ? 'binary' : 'generated';
      pct.textContent = '';
      cell.title = node.binary
        ? `${node.path}\nバイナリのため行数を数えていません (${util.fmtBytes(node.size)})`
        : `${node.path}\n生成物として除外 (${util.fmtBytes(node.size)})`;
      return;
    }

    const share = dirTotal > 0 ? (total / dirTotal) * 100 : 0;
    const width = maxTotal > 0 ? Math.max(total > 0 ? 2 : 0, (total / maxTotal) * 100) : 0;

    fill.style.width = width.toFixed(2) + '%';
    num.textContent = m.cell(node);
    pct.textContent = share >= 0.5 ? Math.round(share) + '%' : '';

    const tip = [];
    tip.push(node.path);
    tip.push(`${m.long(node)} — このディレクトリの ${share.toFixed(1)}%`);
    if (!isFile) tip.push(`${fmt(node.fileCount)} ファイル`);
    if (m.key === 'lines') {
      tip.push(util.fmtBytes(node.bytes || node.size || 0));
      if (!node.allExact) tip.push('（推定値。行数を取得中または取得対象外）');
      if (isFile && total >= settings.dangerLines) {
        tip.push(`⚠ 閾値 ${fmt(settings.dangerLines)} 行を超えています`);
      } else if (isFile && total >= settings.warnLines) {
        tip.push(`閾値 ${fmt(settings.warnLines)} 行に近づいています`);
      }
    } else {
      tip.push(METRICS.lines.long(node));
    }
    cell.title = tip.join('\n');
  }

  function clearRows() {
    for (const n of document.querySelectorAll(`.${CELL_CLASS}, .${PICK_CLASS}, .${COL_HEAD_CLASS}`)) n.remove();
  }

  function clearCells() {
    for (const n of document.querySelectorAll(`.${CELL_CLASS}`)) n.remove();
  }

  /* Row paths whose checkbox is currently on screen. */
  function pickedKeysOnScreen() {
    return [...new Set(
      [...document.querySelectorAll(`.${PICK_CLASS}[data-pick="on"]`)].map((p) => p.dataset.ghlPath)
    )];
  }

  function allRowsBox(handlers) {
    const box = el('input', {
      class: 'ghl-pick', type: 'checkbox', 'data-ghl-action': 'pick-all',
      title: 'GitHub Lines: すべての行を取得対象にする／外す',
    });
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => {
      if (handlers.onPickAll) handlers.onPickAll(box.checked, pickedKeysOnScreen());
    });
    return box;
  }

  /* The all-rows checkbox mirrors the rows: ticked when every row is,
     indeterminate when only some are. Clicking it takes all rows with it. */
  function syncAllRowsBox(box, pickKeys, state) {
    const selected = pickKeys.filter((k) => isIncluded(state, k)).length;
    box.checked = pickKeys.length > 0 && selected === pickKeys.length;
    box.indeterminate = selected > 0 && selected < pickKeys.length;
  }

  /* The head of the checkbox column, in the table's "Name" header cells (one
     per breakpoint, like the rows): the icon, with the all-rows checkbox under
     it, exactly over the rows' checkboxes — so the column reads as ours and is
     driven from its top. The vertical rule between the checkboxes and GitHub's
     file icons is CSS on the rows and on the header. Returns whether a head
     found a home. */
  const COL_HEAD_CLASS = 'ghl-col-head';

  function renderColumnHead(state, handlers, pickKeys, show) {
    const cells = show ? GHL.page.findNameHeaders() : [];
    if (!cells.length) {
      for (const h of document.querySelectorAll(`.${COL_HEAD_CLASS}`)) h.remove();
      return false;
    }
    for (const th of cells) {
      let head = th.querySelector(`:scope > .${COL_HEAD_CLASS}`);
      if (!head) {
        head = el('span', { class: COL_HEAD_CLASS }, [icon(), allRowsBox(handlers)]);
        th.insertBefore(head, th.firstChild);
      }
      syncAllRowsBox(head.querySelector('input'), pickKeys, state);
    }
    return true;
  }

  /* ---------------------------------------------------------- summary bar */

  function segmentsFor(dirNode, settings, m, limit = 12) {
    const kids = [...dirNode.children.values()]
      .filter((n) => m.value(n) > 0)
      .sort((a, b) => m.value(b) - m.value(a));

    const head = kids.slice(0, limit);
    const tail = kids.slice(limit);
    const segments = head.map((n, i) => ({
      node: n,
      label: n.name + (n.type === 'dir' ? '/' : ''),
      total: m.value(n),
      tone: m.severity(n, settings),
      alt: i % 2 === 1,
    }));

    if (tail.length) {
      segments.push({
        node: null,
        label: `他 ${tail.length} 件`,
        total: tail.reduce((s, n) => s + m.value(n), 0),
        tone: 'rest',
        alt: false,
      });
    }
    return segments;
  }

  /* The toolbar icon, inline so it follows GitHub's theme and stays crisp.
     Static markup, so innerHTML is safe here. */
  const ICON_SVG =
    '<svg viewBox="0 0 128 128" aria-hidden="true">' +
    '<g fill="currentColor" opacity="0.3">' +
    '<rect x="17" y="17" width="94" height="24" rx="12"/>' +
    '<rect x="17" y="52" width="94" height="24" rx="12"/>' +
    '<rect x="17" y="87" width="94" height="24" rx="12"/></g>' +
    '<rect x="17" y="17" width="94" height="24" rx="12" style="fill:var(--ghl-danger)"/>' +
    '<rect x="17" y="52" width="56" height="24" rx="12" style="fill:var(--ghl-warn)"/>' +
    '<rect x="17" y="87" width="32" height="24" rx="12" style="fill:var(--ghl-ok)"/>' +
    '</svg>';

  function icon() {
    const span = el('span', { class: 'ghl-icon' });
    span.innerHTML = ICON_SVG;
    return span;
  }

  function buildSummary() {
    return el('div', { id: SUMMARY_ID, class: 'ghl-summary' }, [
      el('div', { class: 'ghl-summary-head' }, [
        el('span', { class: 'ghl-summary-title' }, [icon(), 'GitHub Lines']),
        el('span', { class: 'ghl-summary-stats' }),
        el('span', { class: 'ghl-spacer' }),
        el('span', { class: 'ghl-summary-status' }),
        // Marked with the icon so the checkboxes in GitHub's table below read
        // as ours, not GitHub's.
        // Only when the column head has no home (older GitHub layouts).
        el('label', { class: 'ghl-pick-all', title: 'GitHub Lines: すべての行を取得対象にする／外す' }, [
          icon(),
          'すべて',
        ]),
        // What the bars measure — and, in manual mode, what the button beside
        // it fetches.
        el('span', { class: 'ghl-metric', role: 'group', 'aria-label': '表示する量' }, [
          el('button', { type: 'button', 'data-ghl-metric': 'lines', title: 'バーと割合を行数で表示' }, ['行数']),
          el('button', { type: 'button', 'data-ghl-metric': 'bytes', title: 'バーと割合をファイルサイズで表示' }, ['サイズ']),
        ]),
        el('button', { class: 'ghl-btn ghl-btn-fetch', type: 'button', 'data-ghl-action': 'fetch' }),
        el('button', { class: 'ghl-btn', type: 'button', 'data-ghl-action': 'treemap' }, [
          'ツリーマップ',
        ]),
      ]),
      el('div', { class: 'ghl-stack' }),
      el('div', { class: 'ghl-legend' }),
    ]);
  }

  /* `pickKeys` are the row paths the checkboxes currently stand for;
     `headPlaced` says the column head is up, so the strip's copy of the
     all-rows checkbox is not needed. */
  function renderSummary(state, dirNode, handlers, pickKeys, headPlaced) {
    const anchor = GHL.page.findSummaryAnchor();
    if (!anchor) return;

    let node = document.getElementById(SUMMARY_ID);
    if (!node) {
      node = buildSummary();
      node.querySelector('[data-ghl-action="treemap"]')
        .addEventListener('click', () => handlers.onTreemap && handlers.onTreemap());
      for (const b of node.querySelectorAll('[data-ghl-metric]')) {
        b.addEventListener('click', () => handlers.onMetric && handlers.onMetric(b.dataset.ghlMetric));
      }
      node.querySelector('[data-ghl-action="fetch"]')
        .addEventListener('click', () => handlers.onFetch && handlers.onFetch());
      node.querySelector('.ghl-pick-all').insertBefore(allRowsBox(handlers), node.querySelector('.ghl-pick-all').lastChild);
    }
    if (node.previousElementSibling !== anchor && node.parentElement !== anchor.parentElement) {
      anchor.parentElement.insertBefore(node, anchor);
    } else if (!node.isConnected) {
      anchor.parentElement.insertBefore(node, anchor);
    }

    const settings = state.settings;
    const treemapButton = node.querySelector('[data-ghl-action="treemap"]');
    treemapButton.hidden = !settings.showTreemapButton;
    treemapButton.disabled = !state.index;

    const m = metricOf(state);
    const idle = state.status === 'idle';

    // 行数 | サイズ. With a tree in, it says what the bars measure; before one
    // — manual mode's idle — it also says what the button fetches.
    const toggle = node.querySelector('.ghl-metric');
    toggle.hidden = !state.index && !idle;
    for (const b of toggle.querySelectorAll('[data-ghl-metric]')) {
      b.setAttribute('aria-pressed', String(b.dataset.ghlMetric === m.key));
    }

    // Manual mode's one button fetches whichever the toggle says. Sizes cost a
    // single request, so that reading is plain; lines cost one per file and
    // carry the colour. Once the tree is in the sizes are known, so the button
    // stays only for lines and names its price. With every row unticked it
    // stays visible but disabled, so the zero is explained.
    const fetchButton = node.querySelector('[data-ghl-action="fetch"]');
    const wantsLines = m.key === 'lines';
    const none = pickKeys.length > 0 &&
      pickKeys.every((k) => state.deselected && state.deselected.has(k));
    fetchButton.classList.toggle('ghl-btn-primary', wantsLines);
    fetchButton.hidden = !(idle || (state.status === 'pending' && wantsLines));
    if (idle && !wantsLines) {
      fetchButton.disabled = false;
      fetchButton.textContent = 'サイズを取得';
      fetchButton.title = 'ファイル一覧を 1 リクエストで取得し、各ファイルのサイズを表示します';
    } else if (idle) {
      fetchButton.disabled = none;
      fetchButton.textContent = '行数を取得';
      fetchButton.title = none
        ? '取得する行にチェックを入れてください'
        : 'ファイル一覧を取得し、続けてチェックした行の各ファイルの行数を GitHub から取得します\n' +
          '（ファイル数と同じだけ API リクエストを使います）';
    } else if (!fetchButton.hidden) {
      fetchButton.disabled = state.pending === 0;
      fetchButton.textContent = `行数を取得（${fmt(state.pending)}）`;
      fetchButton.title = state.pending
        ? `${fmt(state.pending)} ファイルの行数を GitHub から取得します\n` +
          '（同じ数だけ API リクエストを使います。取得済みのファイルは含みません）'
        : '取得する行にチェックを入れてください';
    }

    // The strip's copy of the all-rows checkbox, for pages where the column
    // head could not be placed.
    const pickAll = node.querySelector('.ghl-pick-all');
    const manual = settings.showInlineBars && settings.exactLinesMode === 'manual';
    pickAll.hidden = !manual || headPlaced;
    if (!pickAll.hidden) syncAllRowsBox(pickAll.querySelector('input'), pickKeys, state);

    const stats = node.querySelector('.ghl-summary-stats');
    const status = node.querySelector('.ghl-summary-status');
    const stack = node.querySelector('.ghl-stack');
    const legend = node.querySelector('.ghl-legend');

    const total = m.value(dirNode);
    const biggest = [...dirNode.children.values()].sort((a, b) => m.value(b) - m.value(a))[0];

    if (!state.index) {
      // Nothing fetched yet — the status line carries the message instead.
      stats.textContent = '—';
    } else {
      const parts = [m.long(dirNode), `${fmt(dirNode.fileCount)} ファイル`];
      if (biggest && total > 0) {
        const share = Math.round((m.value(biggest) / total) * 100);
        parts.push(`最大: ${biggest.name}${biggest.type === 'dir' ? '/' : ''} ${m.short(biggest)} (${share}%)`);
      }
      stats.textContent = parts.join('  ·  ');
    }

    status.textContent = statusText(state, m);
    status.dataset.tone = state.status === 'error' ? 'error' : (state.warning ? 'warn' : 'ok');

    // Stacked proportion bar
    stack.textContent = '';
    legend.textContent = '';
    const segments = segmentsFor(dirNode, settings, m);
    for (const seg of segments) {
      const pct = total > 0 ? (seg.total / total) * 100 : 0;
      const bar = el('span', {
        class: 'ghl-seg',
        'data-tone': seg.tone,
        'data-alt': seg.alt ? '1' : '0',
        style: { width: pct.toFixed(3) + '%' },
        title: `${seg.label}\n${m.fmtTotal(seg.total)} (${pct.toFixed(1)}%)`,
      });
      if (seg.node) {
        bar.addEventListener('click', () => {
          const row = document.querySelector(`.${CELL_CLASS}[data-ghl-path="${cssEscape(seg.node.path)}"]`);
          if (row) {
            row.closest('tr, .Box-row, [role="row"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            row.classList.add('ghl-flash');
            setTimeout(() => row.classList.remove('ghl-flash'), 1200);
          }
        });
        bar.classList.add('ghl-seg-clickable');
      }
      stack.appendChild(bar);

      if (pct >= 6) {
        legend.appendChild(
          el('span', { class: 'ghl-legend-item', 'data-tone': seg.tone }, [
            el('span', { class: 'ghl-legend-dot' }),
            `${seg.label} ${Math.round(pct)}%`,
          ])
        );
      }
    }
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function statusText(state, m) {
    if (state.status === 'error') return errorText(state.error);
    if (state.warning) return errorText(state.warning);
    if (state.status === 'loading') return '読み込み中…';
    if (state.status === 'idle') return '未取得';
    if (state.status === 'refining') {
      return `実行数を取得中 ${state.progress.done}/${state.progress.total}`;
    }
    // Estimates only exist for lines; sizes are exact from the start.
    if (m && m.key === 'bytes') return state.truncated ? '巨大リポジトリのため一部のみ' : '';
    if (state.status === 'estimated') return 'バイト数から推定中…';
    if (state.status === 'pending') return 'バイト数からの推定値';
    if (state.truncated) return '巨大リポジトリのため一部推定';
    return '';
  }

  function untilText(reset) {
    if (!reset) return '';
    const minutes = Math.ceil((reset - Date.now()) / 60000);
    return minutes > 0 ? `（あと約 ${minutes} 分）` : '';
  }

  function errorText(err) {
    if (!err) return 'エラー';
    switch (err.error) {
      case 'rate_limit':
        return err.authenticated
          ? `API レート制限に到達しました${untilText(err.reset)}`
          : 'API レート制限（未認証 60回/時）— 設定でトークンを登録してください';
      case 'secondary_rate_limit':
        return `GitHub の二次レート制限により一時停止中${untilText(err.reset)}`;
      case 'throttled':
        return '短時間に取得しすぎたため待機中 — しばらくすると再開します';
      case 'bad_token':
        return `${err.tokenLabel || 'トークン'} が無効です — 設定を確認してください`;
      case 'not_found':
        // With several accounts configured, naming the one that was tried is
        // the difference between a useful message and a mystery.
        return err.authenticated
          ? `リポジトリにアクセスできません（${err.tokenLabel || 'トークン'} の権限を確認）`
          : 'private リポジトリ — 設定でトークンを登録してください';
      case 'timeout':
        return 'バックグラウンドが応答しません — ページを更新してください';
      case 'disconnected':
      case 'invalidated':
        return '拡張が再読み込みされました — ページを更新してください';
      default: return `取得に失敗しました (${err.error || 'error'})`;
    }
  }

  function removeSummary() {
    document.getElementById(SUMMARY_ID)?.remove();
  }

  /* ------------------------------------------------------------- render */

  const EMPTY_DIR = { children: new Map(), total: 0, bytes: 0, fileCount: 0, allExact: true };

  function render(state, handlers) {
    const settings = state.settings;
    if (!settings) return;

    const ctx = state.ctx;
    const dirNode = state.index && (state.index.get(ctx.path) || state.root);
    const rows = GHL.page.findRows(ctx);
    // Manual mode's checkbox column is up for the whole view, one box per row
    // on screen.
    const manual = settings.showInlineBars && settings.exactLinesMode === 'manual';
    const pickKeys = manual ? rows.map((r) => r.path) : [];
    const headPlaced = renderColumnHead(state, handlers, pickKeys, manual);
    if (manual) {
      for (const r of rows) {
        for (const host of r.hosts) paintPick(pickIn(host, handlers), r.path, state, true);
      }
    }

    // No tree yet — idle, loading, or the request failed outright. Show the
    // strip regardless: a blank page gives the user nothing to act on, and "no
    // bars" should never be indistinguishable from "extension not running".
    if (!dirNode) {
      clearCells();
      if (!manual) clearRows();
      renderSummary(state, EMPTY_DIR, handlers, pickKeys, headPlaced);
      return;
    }

    // What the strip and the percentages are computed over: in manual mode,
    // the ticked rows only.
    const view = manual ? viewOf(dirNode, state) : dirNode;
    renderSummary(state, view, handlers, pickKeys, headPlaced);

    if (!settings.showInlineBars) {
      clearRows();
      return;
    }

    const visible = rows
      .map((r) => ({ row: r, node: state.index.get(r.path) }))
      .filter((x) => x.node && (!manual || isIncluded(state, x.row.path)));

    const m = metricOf(state);
    const dirTotal = m.value(view);
    const maxTotal = visible.reduce((acc, x) => Math.max(acc, m.value(x.node)), 0);

    for (const r of rows) {
      const included = !manual || isIncluded(state, r.path);
      renderRow(r, state.index.get(r.path), dirTotal, maxTotal, state, handlers, manual, included);
    }
  }

  GHL.inline = { render, clearRows, removeSummary, severity, errorText, METRICS, metricOf, viewOf, SUMMARY_ID };
})(globalThis.GHL);
