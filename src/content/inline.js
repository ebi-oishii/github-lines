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

  /* ------------------------------------------------------------ row cells */

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

  /* A row has one name cell per breakpoint; paint every one of them. */
  function renderRow(row, node, dirTotal, maxTotal, settings) {
    for (const host of row.hosts) {
      paintCell(cellIn(host), row, node, dirTotal, maxTotal, settings);
    }
  }

  function paintCell(cell, row, node, dirTotal, maxTotal, settings) {
    const fill = cell.querySelector('.ghl-bar-fill');
    const num = cell.querySelector('.ghl-num');
    const pct = cell.querySelector('.ghl-pct');

    if (!node) {
      cell.dataset.ghlPath = row.path;
      cell.dataset.state = 'unknown';
      fill.style.width = '0%';
      num.textContent = '–';
      pct.textContent = '';
      cell.title = 'GitHub Lines: この項目の情報を取得できませんでした（サブモジュール等）';
      return;
    }

    const total = node.total || 0;
    const isFile = node.type === 'file';
    const excluded = isFile && node.excluded;

    cell.dataset.ghlPath = node.path;
    cell.dataset.state = excluded ? 'excluded' : (isFile ? 'file' : 'dir');
    cell.dataset.severity = excluded ? 'none' : (isFile ? severity(total, settings) : 'dir');

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
    num.textContent = approxPrefix(node) + fmt(total);
    pct.textContent = share >= 0.5 ? Math.round(share) + '%' : '';

    const lines = [];
    lines.push(node.path);
    lines.push(`${approxPrefix(node)}${fmt(total)} 行 — このディレクトリの ${share.toFixed(1)}%`);
    if (!isFile) lines.push(`${fmt(node.fileCount)} ファイル`);
    lines.push(util.fmtBytes(node.bytes || node.size || 0));
    if (!node.allExact) lines.push('（推定値。行数を取得中または取得対象外）');
    if (isFile && total >= settings.dangerLines) {
      lines.push(`⚠ 閾値 ${fmt(settings.dangerLines)} 行を超えています`);
    } else if (isFile && total >= settings.warnLines) {
      lines.push(`閾値 ${fmt(settings.warnLines)} 行に近づいています`);
    }
    cell.title = lines.join('\n');
  }

  function clearRows() {
    for (const cell of document.querySelectorAll(`.${CELL_CLASS}`)) cell.remove();
  }

  /* ---------------------------------------------------------- summary bar */

  function segmentsFor(dirNode, settings, limit = 12) {
    const kids = [...dirNode.children.values()]
      .filter((n) => (n.total || 0) > 0)
      .sort((a, b) => b.total - a.total);

    const head = kids.slice(0, limit);
    const tail = kids.slice(limit);
    const segments = head.map((n, i) => ({
      node: n,
      label: n.name + (n.type === 'dir' ? '/' : ''),
      total: n.total,
      tone: n.type === 'file' ? severity(n.total, settings) : 'dir',
      alt: i % 2 === 1,
    }));

    if (tail.length) {
      segments.push({
        node: null,
        label: `他 ${tail.length} 件`,
        total: tail.reduce((s, n) => s + n.total, 0),
        tone: 'rest',
        alt: false,
      });
    }
    return segments;
  }

  function buildSummary() {
    return el('div', { id: SUMMARY_ID, class: 'ghl-summary' }, [
      el('div', { class: 'ghl-summary-head' }, [
        el('span', { class: 'ghl-summary-title' }, ['GitHub Lines']),
        el('span', { class: 'ghl-summary-stats' }),
        el('span', { class: 'ghl-spacer' }),
        el('span', { class: 'ghl-summary-status' }),
        el('button', { class: 'ghl-btn', type: 'button', 'data-ghl-action': 'treemap' }, [
          'ツリーマップ',
        ]),
      ]),
      el('div', { class: 'ghl-stack' }),
      el('div', { class: 'ghl-legend' }),
    ]);
  }

  function renderSummary(state, dirNode, onTreemap) {
    const anchor = GHL.page.findSummaryAnchor();
    if (!anchor) return;

    let node = document.getElementById(SUMMARY_ID);
    if (!node) {
      node = buildSummary();
      node.querySelector('[data-ghl-action="treemap"]').addEventListener('click', onTreemap);
    }
    if (node.previousElementSibling !== anchor && node.parentElement !== anchor.parentElement) {
      anchor.parentElement.insertBefore(node, anchor);
    } else if (!node.isConnected) {
      anchor.parentElement.insertBefore(node, anchor);
    }

    const settings = state.settings;
    const button = node.querySelector('[data-ghl-action="treemap"]');
    button.hidden = !settings.showTreemapButton;
    button.disabled = !state.index;

    const stats = node.querySelector('.ghl-summary-stats');
    const status = node.querySelector('.ghl-summary-status');
    const stack = node.querySelector('.ghl-stack');
    const legend = node.querySelector('.ghl-legend');

    const total = dirNode.total || 0;
    const biggest = [...dirNode.children.values()].sort((a, b) => b.total - a.total)[0];

    if (!state.index) {
      // Nothing fetched yet — the status line carries the message instead.
      stats.textContent = '—';
    } else {
      const parts = [`${approxPrefix(dirNode)}${fmt(total)} 行`, `${fmt(dirNode.fileCount)} ファイル`];
      if (biggest && total > 0) {
        const share = Math.round((biggest.total / total) * 100);
        parts.push(`最大: ${biggest.name}${biggest.type === 'dir' ? '/' : ''} ${fmtCompact(biggest.total)} 行 (${share}%)`);
      }
      stats.textContent = parts.join('  ·  ');
    }

    status.textContent = statusText(state);
    status.dataset.tone = state.status === 'error' ? 'error' : (state.warning ? 'warn' : 'ok');

    // Stacked proportion bar
    stack.textContent = '';
    legend.textContent = '';
    const segments = segmentsFor(dirNode, settings);
    for (const seg of segments) {
      const pct = total > 0 ? (seg.total / total) * 100 : 0;
      const bar = el('span', {
        class: 'ghl-seg',
        'data-tone': seg.tone,
        'data-alt': seg.alt ? '1' : '0',
        style: { width: pct.toFixed(3) + '%' },
        title: `${seg.label}\n${fmt(seg.total)} 行 (${pct.toFixed(1)}%)`,
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

  function statusText(state) {
    if (state.status === 'error') return errorText(state.error);
    if (state.warning) return errorText(state.warning);
    if (state.status === 'loading') return '読み込み中…';
    if (state.status === 'estimated') return 'バイト数から推定中…';
    if (state.status === 'refining') {
      return `実行数を取得中 ${state.progress.done}/${state.progress.total}`;
    }
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
      case 'bad_token': return 'トークンが無効です — 設定を確認してください';
      case 'not_found':
        return err.authenticated
          ? 'リポジトリにアクセスできません（トークンの権限を確認）'
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

  const EMPTY_DIR = { children: new Map(), total: 0, fileCount: 0, allExact: true };

  function render(state, onTreemap) {
    const settings = state.settings;
    if (!settings) return;

    const ctx = state.ctx;
    const dirNode = state.index && (state.index.get(ctx.path) || state.root);

    // Still loading, or the request failed outright. Show the strip regardless:
    // a blank page gives the user nothing to act on, and "no bars" should never
    // be indistinguishable from "extension not running".
    if (!dirNode) {
      clearRows();
      renderSummary(state, EMPTY_DIR, onTreemap);
      return;
    }

    renderSummary(state, dirNode, onTreemap);

    if (!settings.showInlineBars) {
      clearRows();
      return;
    }

    const rows = GHL.page.findRows(ctx);
    const visible = rows
      .map((r) => ({ row: r, node: state.index.get(r.path) }))
      .filter((x) => x.node);

    const dirTotal = dirNode.total || 0;
    const maxTotal = visible.reduce((m, x) => Math.max(m, x.node.total || 0), 0);

    for (const r of rows) {
      renderRow(r, state.index.get(r.path), dirTotal, maxTotal, settings);
    }
  }

  GHL.inline = { render, clearRows, removeSummary, severity, errorText, SUMMARY_ID };
})(globalThis.GHL);
