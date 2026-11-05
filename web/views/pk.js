/**
 * PK 情报面板。
 *
 * 只摆公开数据：两边房间标题、直播状态、人气、粉丝数、高能榜前几。
 * 不读对面弹幕、不猜比分，也不自动发任何东西 —— 提醒由服务端按边沿推。
 */

import { el, replaceChildren } from '../core/dom.js';
import { api } from '../core/api.js';
import { n } from '../core/format.js';

const AUTO_MS = 30_000;

function liveText(view) {
  if (!view) return '还没有数据';
  if (view.live) return '直播中';
  return view.liveState === 'round' ? '轮播中' : '未开播';
}

function stat(label, value) {
  return el('div', { class: 'pk-stat' }, {
    children: [
      el('span', { class: 'pk-stat-k', text: label }),
      el('strong', { class: 'pk-stat-v', text: value }),
    ],
  });
}

function makeColumn(title) {
  const name = el('div', { class: 'pk-col-title', text: title });
  const room = el('div', { class: 'pk-room-title', text: '—' });
  const state = el('div', { class: 'pk-state' });
  const stats = el('div', { class: 'pk-stats' });
  const rank = el('ol', { class: 'pk-rank' });
  const box = el('section', { class: 'pk-col' }, {
    children: [name, room, state, stats, rank],
  });

  function render(view) {
    if (!view) {
      room.textContent = '未配置 / 还没有数据';
      state.textContent = '';
      replaceChildren(stats, []);
      replaceChildren(rank, [el('li', { class: 'pk-empty', text: '—' })]);
      return;
    }
    room.textContent = view.title || `房间 ${view.roomId}`;
    state.textContent = `${liveText(view)}${view.area ? ` · ${view.area}` : ''}`;
    state.className = `pk-state${view.live ? ' is-live' : ''}`;
    replaceChildren(stats, [
      stat('人气', n(view.online)),
      stat('粉丝', n(view.attention)),
      stat('高能榜', view.rankTotal ? n(view.rankTotal) : '暂无'),
    ]);
    const top = Array.isArray(view.rankTop) ? view.rankTop : [];
    replaceChildren(
      rank,
      top.length
        ? top.map((it, i) =>
            el('li', { class: 'pk-rank-row' }, {
              children: [
                el('span', { class: 'pk-rank-i', text: String(i + 1) }),
                el('span', { class: 'pk-rank-name', text: it.name || '匿名' }),
                el('span', { class: 'pk-rank-score', text: n(it.score) }),
              ],
            }),
          )
        : [el('li', { class: 'pk-empty', text: '暂无高能榜数据' })],
    );
  }

  return { box, render };
}

export function createPk({ dlg, toast = () => {} }) {
  let timer = null;
  let busy = false;
  let seq = 0;

  const input = el('input', {
    class: 'pk-input',
    attrs: {
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: '对面房间号（短号也行）',
    },
  });

  const saveBtn = el('button', {
    class: 'btn',
    text: '保存',
    attrs: { type: 'button' },
    on: { click: () => save() },
  });
  const refreshBtn = el('button', {
    class: 'btn',
    text: '刷新',
    attrs: { type: 'button' },
    on: { click: () => refresh() },
  });
  const closeBtn = el('button', {
    class: 'btn',
    text: '关闭',
    attrs: { type: 'button' },
    on: { click: () => dlg.close() },
  });

  const head = el('header', { class: 'pk-head' }, {
    children: [
      el('h4', { text: 'PK 情报' }),
      el('span', { class: 'pk-sub', text: '两边公开数据对比 · 不读对面弹幕' }),
      el('span', { class: 'pk-spacer' }),
      input,
      saveBtn,
      refreshBtn,
      closeBtn,
    ],
  });

  const self = makeColumn('我方');
  const opp = makeColumn('对面');
  const grid = el('div', { class: 'pk-grid' }, { children: [self.box, opp.box] });
  const compare = el('p', { class: 'pk-compare' });
  const foot = el('p', {
    class: 'pk-foot',
    text: '每 60 秒自动拉一次对面房间；对面开播 / 下播时会提醒一次。',
  });

  replaceChildren(dlg, [
    el('div', { class: 'pk-wrap' }, { children: [head, grid, compare, foot] }),
  ]);

  dlg.addEventListener('close', () => stopAuto());

  function stopAuto() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startAuto() {
    stopAuto();
    timer = setInterval(() => {
      if (dlg.open && !busy) refresh();
    }, AUTO_MS);
  }

  function render(view) {
    input.value = view?.roomId || '';
    foot.textContent = view?.stale
      ? '数据超过 3 分钟没更新了，可能不是现状；点「刷新」再拉一次。'
      : '每 60 秒自动拉一次对面房间；对面开播 / 下播时会提醒一次。';
    const selfView = view?.self ?? null;
    const oppView = view?.opponent ?? null;
    self.render(selfView);
    opp.render(oppView);

    if (!view?.enabled) {
      compare.textContent = '填一个对面房间号，保存后开始对比。';
      compare.className = 'pk-compare';
      return;
    }
    const c = view.compare;
    if (!c) {
      compare.textContent = '还没有拉到数据，点「刷新」试一次。';
      compare.className = 'pk-compare';
      return;
    }
    if (!c.bothLive) {
      compare.textContent = '两边没有同时开播，先不做对比。';
      compare.className = 'pk-compare';
      return;
    }
    const gap = Math.abs(c.onlineGap);
    const lead = c.lead === 'self' ? '我方领先' : c.lead === 'opp' ? '对面领先' : '两边持平';
    compare.textContent = `${lead} ${n(gap)} 人气 · 高能榜差 ${n(Math.abs(c.rankGap))}`;
    compare.className = `pk-compare${c.lead === 'opp' ? ' is-behind' : ''}`;
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    const mine = ++seq;
    refreshBtn.disabled = true;
    try {
      const view = await api.refreshPk();
      if (mine === seq) render(view);
    } catch (err) {
      if (mine === seq) toast(`PK 情报拉不到：${err.message}`, 'error');
    } finally {
      busy = false;
      refreshBtn.disabled = false;
    }
  }

  async function load() {
    try {
      const view = await api.pk();
      render(view);
      if (view?.enabled) refresh();
    } catch (err) {
      toast(`PK 情报打不开：${err.message}`, 'error');
    }
  }

  async function save() {
    const raw = input.value.trim();
    saveBtn.disabled = true;
    try {
      const saved = await api.savePk(raw);
      toast(saved.roomId ? '已保存 PK 房间，正在拉对面数据' : '已关闭 PK 情报');
      render({ enabled: Boolean(saved.roomId), roomId: saved.roomId, self: null, opponent: null, compare: null });
      if (saved.roomId) refresh();
    } catch (err) {
      toast(`保存 PK 设置失败：${err.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  return {
    open() {
      if (!dlg.open) dlg.showModal();
      startAuto();
      load();
    },
    refreshIfOpen() {
      if (dlg.open) load();
    },
  };
}
