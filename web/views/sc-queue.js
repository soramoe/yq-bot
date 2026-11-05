/**
 * 醒目留言待读清单。
 *
 * SC 回过一句就沉进弹幕里了：主播切走一眼，回头就找不到。
 * 这里把日志里的 SC 按时间列出来，配上"已读"标记 —— 标记落盘在
 * 服务端，换浏览器 / 重启都还在；清单本身始终从日志重放，不会漂。
 *
 * 注意：没开弹窗时也可能有新的 SC，所以徽标要自己记数（bump），
 * 不能等打开面板才知道。打开面板时以 `/api/sc` 的 unread 为准。
 */

import { el, replaceChildren } from '../core/dom.js';
import { api } from '../core/api.js';

const CHIPS = [
  { d: 7, label: '最近 7 天' },
  { d: 30, label: '最近 30 天' },
  { d: 0, label: '全部' },
];

function stamp(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function createScQueue({ dlg, badge = null, toast = () => {} }) {
  let days = 30;
  let busy = false;
  /** 在途请求期间切了范围：回来后再按最新 days 拉一次，别把点击吞掉 */
  let pendingReload = false;
  let loadSeq = 0;
  /** 当前面板里的条目（已读按钮改的是这份数据） */
  let items = [];
  let unread = 0;
  let scanned = 0;
  let markBusy = false;

  const closeBtn = el('button', {
    class: 'btn',
    text: '关闭',
    attrs: { type: 'button' },
    on: { click: () => dlg.close() },
  });

  const markAllBtn = el('button', {
    class: 'btn',
    text: '全部已读',
    attrs: { type: 'button' },
    on: { click: markAll },
  });

  const head = el('header', { class: 'sc-head' }, {
    children: [
      el('h4', { text: '醒目留言 · 待读' }),
      el('span', { class: 'sc-sub', text: '只收 SC；已读状态会保留，换页面不会丢' }),
      el('span', { class: 'sc-spacer' }),
      markAllBtn,
      closeBtn,
    ],
  });

  const chipRow = el('div', { class: 'sc-chips' });
  const summaryBox = el('div', { class: 'sc-summary' });
  const listBox = el('div', { class: 'sc-list' });

  replaceChildren(dlg, [
    el('div', { class: 'sc-wrap' }, { children: [head, chipRow, summaryBox, listBox] }),
  ]);

  function setBadge(n) {
    unread = Math.max(0, Number(n) || 0);
    if (!badge) return;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = unread === 0;
  }

  function renderChips() {
    replaceChildren(
      chipRow,
      CHIPS.map((c) =>
        el('button', {
          class: 'chip',
          text: c.label,
          attrs: { type: 'button', 'aria-pressed': String(c.d === days) },
          on: {
            click: () => {
              if (days === c.d) return;
              days = c.d;
              renderChips();
              load();
            },
          },
        }),
      ),
    );
  }

  function renderSummary() {
    const u = items.filter((it) => !it.read).length;
    replaceChildren(summaryBox, [
      el('span', { class: 'sc-count', text: `未读 ${u} 条` }),
      el('span', { class: 'sc-total', text: `这段时间共 ${scanned} 条醒目留言` }),
    ]);
  }

  function renderList() {
    if (!items.length) {
      replaceChildren(listBox, [
        el('div', { class: 'empty-hint', text: '这段时间还没有醒目留言' }),
        el('div', { class: 'sc-empty-sub', text: 'SC 出现后会自动进这张清单；读过再点"已读"即可' }),
      ]);
      return;
    }

    replaceChildren(
      listBox,
      items.map((it) => {
        const id = it.id;
        return el('div', { class: `sc-row${it.read ? ' is-read' : ''}`, attrs: { 'data-id': id } }, {
          children: [
            el('div', { class: 'sc-row-head' }, {
              children: [
                el('b', { text: it.name || `uid ${it.uid}` }),
                el('span', { class: 'sc-money', text: it.money }),
                el('span', { class: 'sc-time', text: stamp(it.ts) }),
                el('span', { class: 'sc-state', text: it.read ? '已读' : '未读' }),
                el('span', { class: 'sc-spacer' }),
                it.read
                  ? null
                  : el('button', {
                      class: 'btn sc-mark',
                      text: '已读',
                      attrs: { type: 'button' },
                      on: { click: () => markOne(id) },
                    }),
              ],
            }),
            el('p', { class: 'sc-text', text: it.text || '（没有留言正文）' }),
          ],
        });
      }),
    );
  }

  function render(data) {
    // 拷一份：下面的"已读"会改 item.read，不能顺手把接口响应（或测试里的夹具）改掉
    items = Array.isArray(data?.items) ? data.items.map((it) => ({ ...it })) : [];
    scanned = Math.max(Number(data?.scanned) || 0, items.length);
    setBadge(items.filter((it) => !it.read).length);
    renderSummary();
    renderList();
  }

  async function load() {
    if (busy) {
      pendingReload = true;
      return;
    }
    busy = true;
    pendingReload = false;
    const seq = ++loadSeq;

    try {
      const data = await api.scQueue({ days });
      if (seq !== loadSeq) return;
      render(data);
    } catch (err) {
      if (seq !== loadSeq) return;
      toast(`醒目留言清单打不开：${err.message}`, 'error');
    } finally {
      busy = false;
      if (pendingReload) {
        pendingReload = false;
        load();
      }
    }
  }

  async function postRead(ids) {
    if (markBusy || !ids.length) return;
    markBusy = true;
    try {
      await api.markScRead(ids);
      const set = new Set(ids);
      for (const it of items) if (set.has(it.id)) it.read = true;
      setBadge(items.filter((it) => !it.read).length);
      renderSummary();
      renderList();
    } catch (err) {
      toast(`标记已读失败：${err.message}`, 'error');
    } finally {
      markBusy = false;
    }
  }

  function markOne(id) {
    postRead([id]);
  }

  function markAll() {
    const ids = items.filter((it) => !it.read).map((it) => it.id);
    if (!ids.length) {
      toast('没有未读的醒目留言', 'info');
      return;
    }
    postRead(ids);
  }

  renderChips();

  return {
    open() {
      if (!dlg.open) dlg.showModal();
      load();
    },
    refreshIfOpen() {
      if (dlg.open) load();
    },
    /** 新 SC 进缓冲时调用：面板关着也要把徽标抬起来 */
    bump(count = 1) {
      setBadge(unread + Math.max(1, Number(count) || 1));
      if (dlg.open) load();
    },
    /** 换房间：旧房间的未读不能挂在新房间头上，面板开着就重拉 */
    reset() {
      setBadge(0);
      if (dlg.open) load();
    },
  };
}
