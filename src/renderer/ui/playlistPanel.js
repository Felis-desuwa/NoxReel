import { reorderIds } from '../lib/playlist.js';
import { make, patch, place } from './dom.js';

/**
 * 右栏的播放列表表格。只管画和收集手势，列表怎么改由 app.js 决定（经回调）。
 *
 *  - 行以 item id 为键，重绘时复用同一个元素；行里的每个子节点也按 key 复用（见 dom.js 的 patch），
 *    传输和算哈希时列表每 400ms 重绘一次，按钮换了人就会吃掉正按着的那次点击、把焦点丢回 body。
 *  - 拖动进行中不重绘，松手后补画最后一次。
 *  - 拖动排序：落在行的上半截算「插到它前面」，下半截算「插到它后面」。
 *  - 从资源管理器拖文件进来，交给 onDropFiles。
 *  - 每行一个「⋯」菜单，收纳全部行操作。
 *
 * 视图模型（由 app.js 的 playlistView() 生成）：
 * {
 *   canEdit, emptyText,
 *   rows: [{ id, index, name, meta: [片段], current, next, locked, lockTitle,
 *            transfer: {text, tone, ratio} | null,
 *            notice: {text, tone, site, actions: [{key, label}]} | null,
 *            menu: [{key, label, danger}] }],
 *   pending: [{ key, name, text, detail, tone, ratio, actions: [{key, label}] }],
 *   history: [{ id, name, meta, menu }],
 * }
 * banner：列表上方的一行提示（比如房主离开了），没有就是空串。
 * meta 片段：字符串是界面文案（会翻译）；{raw: '文本', label?: '前缀'} 是用户内容（不翻译，前缀照翻）；
 * {text, className} 是带样式的界面文案。
 */

const ITEM_TYPE = 'text/x-noxreel-item';

export function createPlaylistPanel({ body, onAction, onMove, onDropFiles }) {
  const table = make('div', { className: 'pl-table', attrs: { role: 'list' } });
  const history = make('details', { className: 'pl-history hidden' });
  const historySummary = make('summary');
  const historyList = make('div', { className: 'pl-history-list', attrs: { role: 'list' } });
  history.append(historySummary, historyList);
  const empty = make('p', { className: 'panel-empty' });
  const banner = make('div', { className: 'pl-banner hidden' });
  body.replaceChildren(banner, table, empty, history);

  const rowEls = new Map();
  let view = null;
  let dragging = null; // 正在拖的 item id
  let deferred = null; // 拖动期间攒下的最后一次重绘
  let menu = null; // {el, id, anchor}

  /* ------------------------------ 绘制 ------------------------------ */

  function metaSpecs(parts) {
    const out = [];
    let i = 0;
    for (const part of parts || []) {
      if (part == null || part === '') continue;
      const n = i++;
      if (out.length) out.push({ key: `sep${n}`, className: `pl-sep${part.className ? ` ${part.className}-sep` : ''}`, text: ' · ' });
      if (typeof part === 'string') out.push({ key: `m${n}`, text: part });
      else if (part.raw !== undefined) {
        if (part.label) out.push({ key: `label${n}`, text: part.label });
        out.push({ key: `m${n}`, raw: true, className: part.className || '', text: String(part.raw ?? '') });
      } else out.push({ key: `m${n}`, className: part.className || '', text: part.text });
    }
    return out;
  }

  function actionSpecs(actions, id) {
    return (actions || []).map((a) => ({
      key: `act:${a.key}`,
      tag: 'button',
      className: `ghost tiny pl-act${a.primary ? ' primary-lite' : ''}`,
      text: a.label,
      attrs: { 'data-act': a.key, 'data-id': id },
    }));
  }

  /** 进度条只在 ratio 严格介于 0 和 1 之间时画。 */
  function progressSpec(ratio) {
    if (typeof ratio !== 'number' || !(ratio > 0) || !(ratio < 1)) return null;
    return { key: 'progress', className: 'pl-progress', children: [{ key: 'bar', tag: 'i', style: { width: `${(ratio * 100).toFixed(1)}%` } }] };
  }

  function moreSpec(row) {
    if (!row.menu?.length) return { key: 'more', className: 'pl-more-spacer' };
    return {
      key: 'more',
      tag: 'button',
      className: 'pl-more',
      text: '⋯',
      attrs: { 'data-menu': row.id, 'aria-label': '更多操作', title: '更多操作', 'aria-haspopup': 'menu' },
    };
  }

  function fillRow(el, row, { canEdit, inHistory = false }) {
    el.className = [
      'pl-row',
      row.current ? 'current' : '',
      row.next ? 'next' : '',
      inHistory ? 'played' : '',
      canEdit && !inHistory ? 'editable' : '',
    ]
      .filter(Boolean)
      .join(' ');
    el.dataset.id = row.id;
    el.draggable = canEdit && !inHistory;
    el.setAttribute('role', 'listitem');

    const badges = [];
    if (row.locked) {
      badges.push({ key: 'lock', className: 'pl-lock', text: '🔒', attrs: { title: row.lockTitle || '', 'aria-label': row.lockTitle || '' } });
    }

    // 「正在播放 / 下一部」放在右边状态栏的最上面，和传输状态上下排：
    // 一行里播放状态和传输状态各占一处，不再和片名挤在一起
    const state = [];
    if (row.current) state.push({ key: 'badge', className: 'pl-badge playing', text: '正在播放' });
    else if (row.next) state.push({ key: 'badge', className: 'pl-badge next', text: '下一部' });
    if (row.transfer) {
      state.push({ key: 'transfer', className: `pl-transfer ${row.transfer.tone || ''}`, text: row.transfer.text });
      state.push(progressSpec(row.transfer.ratio));
    }

    patch(el, [
      canEdit && !inHistory ? { key: 'grip', className: 'pl-grip', text: '⠿', attrs: { 'aria-hidden': 'true' } } : null,
      inHistory ? null : { key: 'index', className: 'pl-index', text: String(row.index) },
      {
        key: 'main',
        tag: 'div',
        className: 'pl-main',
        children: [
          {
            key: 'title',
            tag: 'div',
            className: 'pl-title',
            children: [{ key: 'name', raw: true, className: 'pl-name', text: row.name, attrs: { title: row.name } }, ...badges],
          },
          { key: 'meta', tag: 'div', className: 'pl-meta', children: metaSpecs(row.meta) },
          row.notice
            ? {
                key: 'notice',
                tag: 'div',
                className: `pl-notice ${row.notice.tone || ''}`,
                children: [
                  {
                    key: 'text',
                    className: 'pl-notice-text',
                    children: [
                      { key: 'label', text: row.notice.text },
                      row.notice.site ? { key: 'site', raw: true, className: 'pl-site', text: String(row.notice.site) } : null,
                    ],
                  },
                  ...actionSpecs(row.notice.actions, row.id),
                ],
              }
            : null,
        ],
      },
      { key: 'state', tag: 'div', className: 'pl-state', children: state },
      moreSpec(row),
    ]);
  }

  function fillPending(el, job) {
    el.className = `pl-row pending ${job.tone || ''}`;
    el.dataset.pending = job.key;
    el.draggable = false;
    el.setAttribute('role', 'listitem');
    patch(el, [
      { key: 'index', className: 'pl-index', text: '+' },
      {
        key: 'main',
        tag: 'div',
        className: 'pl-main',
        children: [
          {
            key: 'title',
            tag: 'div',
            className: 'pl-title',
            children: [{ key: 'name', raw: true, className: 'pl-name', text: job.name, attrs: { title: job.name } }],
          },
          {
            key: 'meta',
            tag: 'div',
            className: 'pl-meta',
            children: [{ key: 'text', className: `pl-pending-text ${job.tone || ''}`, text: job.detail || '' }],
          },
        ],
      },
      {
        key: 'state',
        tag: 'div',
        className: 'pl-state',
        children: [
          { key: 'transfer', className: `pl-transfer ${job.tone || ''}`, text: job.text },
          progressSpec(job.ratio),
          ...actionSpecs(job.actions, job.key),
        ],
      },
    ]);
  }

  function keyed(key, create) {
    let el = rowEls.get(key);
    if (!el) {
      el = create();
      rowEls.set(key, el);
    }
    return el;
  }

  function render(next) {
    view = next;
    if (dragging) {
      deferred = next;
      return;
    }
    deferred = null;
    banner.classList.toggle('hidden', !next.banner);
    banner.textContent = '';
    if (next.banner) banner.append(make('span', { text: next.banner }));
    const seen = new Set();
    const queueEls = next.rows.map((row) => {
      const key = `q:${row.id}`;
      seen.add(key);
      const el = keyed(key, () => make('div'));
      fillRow(el, row, { canEdit: next.canEdit });
      return el;
    });
    const pendingEls = (next.pending || []).map((job) => {
      const key = `p:${job.key}`;
      seen.add(key);
      const el = keyed(key, () => make('div'));
      fillPending(el, job);
      return el;
    });
    place(table, [...queueEls, ...pendingEls]);
    table.classList.toggle('editable', !!next.canEdit);

    const showEmpty = !next.rows.length && !(next.pending || []).length;
    empty.classList.toggle('hidden', !showEmpty);
    empty.textContent = '';
    if (showEmpty) empty.append(make('span', { text: next.emptyText || '' }));

    const played = next.history || [];
    history.classList.toggle('hidden', !played.length);
    patch(historySummary, [{ key: 'count', text: `已播放（${played.length}）` }]);
    place(
      historyList,
      played.map((row) => {
        const key = `h:${row.id}`;
        seen.add(key);
        const el = keyed(key, () => make('div'));
        fillRow(el, row, { canEdit: next.canEdit, inHistory: true });
        return el;
      })
    );

    for (const key of [...rowEls.keys()]) if (!seen.has(key)) rowEls.delete(key);
    if (menu) {
      // 菜单对应的行没了（被别人删掉），菜单也收起来；⋯ 一般跨重绘还是同一个按钮，
      // 但这一行在队列和已播放之间搬了家就是另一个元素了，这时改认新按钮
      const anchor = findRow(menu.id) ? moreButtonOf(menu.id) : null;
      if (!anchor) closeMenu();
      else if (anchor !== menu.anchor) {
        menu.anchor = anchor;
        anchor.setAttribute('aria-expanded', 'true');
      }
    }
  }

  function moreButtonOf(id) {
    return [...body.querySelectorAll('.pl-more')].find((el) => el.dataset.menu === id) || null;
  }

  function findRow(id) {
    if (!view) return null;
    return view.rows.find((r) => r.id === id) || (view.history || []).find((r) => r.id === id) || null;
  }

  /* ------------------------------ 行菜单 ------------------------------ */

  /** refocus：键盘关掉菜单或选完一项时，焦点回到 ⋯，别掉到页面最前面。 */
  function closeMenu({ refocus = false } = {}) {
    if (!menu) return;
    const { el, anchor } = menu;
    menu = null;
    el.remove();
    anchor?.setAttribute('aria-expanded', 'false');
    if (refocus && anchor && body.contains(anchor)) anchor.focus();
  }

  function openMenu(id, anchor) {
    const row = findRow(id);
    closeMenu();
    if (!row?.menu?.length) return;
    const el = make(
      'div',
      { className: 'pl-menu', attrs: { role: 'menu' } },
      row.menu.map((item) =>
        make('button', {
          className: `pl-menu-item${item.danger ? ' danger' : ''}`,
          text: item.label,
          attrs: { role: 'menuitem', 'data-act': item.key, 'data-id': id },
          props: { disabled: !!item.disabled },
        })
      )
    );
    document.body.append(el);
    const rect = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - box.width - 8, rect.right - box.width));
    const below = rect.bottom + 4;
    const top = below + box.height > window.innerHeight - 8 ? Math.max(8, rect.top - box.height - 4) : below;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    anchor.setAttribute('aria-expanded', 'true');
    menu = { el, id, anchor };
    el.querySelector('button:not([disabled])')?.focus();
  }

  document.addEventListener('mousedown', (e) => {
    if (menu && !menu.el.contains(e.target) && e.target !== menu.anchor) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu({ refocus: true });
  });
  window.addEventListener('resize', closeMenu);
  body.addEventListener('scroll', closeMenu, { passive: true });

  document.addEventListener('click', (e) => {
    const item = e.target.closest?.('.pl-menu-item');
    if (!item || !menu?.el.contains(item)) return;
    const { act, id } = item.dataset;
    closeMenu({ refocus: true });
    onAction(act, id);
  });

  body.addEventListener('click', (e) => {
    const more = e.target.closest('.pl-more');
    if (more) {
      if (menu?.anchor === more) closeMenu();
      else openMenu(more.dataset.menu, more);
      return;
    }
    const act = e.target.closest('.pl-act');
    if (act) onAction(act.dataset.act, act.dataset.id);
  });

  /* ------------------------------ 拖动 ------------------------------ */

  const queueRows = () => [...table.querySelectorAll('.pl-row[data-id]')];

  function clearDropMarks() {
    for (const el of table.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
    body.classList.remove('file-over');
  }

  /** 鼠标落点对应的「插到谁前面」。null 表示放到最后。 */
  function dropTarget(e) {
    const rows = queueRows();
    const over = e.target.closest?.('.pl-row[data-id]');
    if (!over || !table.contains(over)) {
      // 落在表格空白处：放到最后
      return { beforeId: null, mark: rows[rows.length - 1] || null, after: true };
    }
    const rect = over.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    if (!after) return { beforeId: over.dataset.id, mark: over, after: false };
    const i = rows.indexOf(over);
    return { beforeId: rows[i + 1]?.dataset.id ?? null, mark: over, after: true };
  }

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  body.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.pl-row[data-id]');
    if (!row || !view?.canEdit || !table.contains(row)) return;
    closeMenu();
    dragging = row.dataset.id;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(ITEM_TYPE, dragging);
  });

  body.addEventListener('dragover', (e) => {
    if (dragging) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      const target = dropTarget(e);
      target.mark?.classList.add(target.after ? 'drop-after' : 'drop-before');
      return;
    }
    if (hasFiles(e) && view?.canEdit) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      body.classList.add('file-over');
    }
  });

  body.addEventListener('dragleave', (e) => {
    if (!body.contains(e.relatedTarget)) clearDropMarks();
  });

  body.addEventListener('drop', (e) => {
    if (dragging) {
      e.preventDefault();
      const id = dragging;
      const { beforeId } = dropTarget(e);
      finishDrag();
      // 拖动途中被收回了编辑权限（补画后的 view 才是最新的）：松手不再发请求
      if (!view?.canEdit) return;
      // 拖回原位（插到自己前面，或插到紧跟着自己的那一行前面）什么都不用做
      const ids = view.rows.map((r) => r.id);
      const next = reorderIds(ids, id, beforeId);
      if (!next || next.every((x, i) => x === ids[i])) return;
      onMove(id, beforeId);
      return;
    }
    if (hasFiles(e) && view?.canEdit) {
      e.preventDefault();
      clearDropMarks();
      onDropFiles([...e.dataTransfer.files]);
    }
  });

  function finishDrag() {
    for (const el of table.querySelectorAll('.dragging')) el.classList.remove('dragging');
    clearDropMarks();
    dragging = null;
    if (deferred) render(deferred);
  }

  body.addEventListener('dragend', () => {
    if (dragging) finishDrag();
  });

  return {
    render,
    isDragging: () => !!dragging,
    closeMenu,
  };
}
