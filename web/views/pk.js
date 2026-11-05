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

  const briefBox = el('input', { class: 'pk-check', attrs: { type: 'checkbox' } });
  const threshold = el('input', {
    class: 'pk-num',
    attrs: { type: 'number', min: '0', step: '100', inputmode: 'numeric' },
  });
  const nameInput = el('input', {
    class: 'pk-text',
    attrs: { type: 'text', maxlength: '80', placeholder: '迎战主播：{名字}' },
  });
  const onlineInput = el('input', {
    class: 'pk-text',
    attrs: { type: 'text', maxlength: '80', placeholder: '在线人数：{人数}' },
  });
  const rankInput = el('input', {
    class: 'pk-text',
    attrs: { type: 'text', maxlength: '80', placeholder: '前十贡献：{贡献}' },
  });
  const strongInput = el('input', {
    class: 'pk-text',
    attrs: { type: 'text', maxlength: '80', placeholder: '对方很强时说什么' },
  });
  const weakInput = el('input', {
    class: 'pk-text',
    attrs: { type: 'text', maxlength: '80', placeholder: '对方一般时说什么' },
  });
  const briefRow = el('div', { class: 'pk-brief' }, {
    children: [
      el('label', { class: 'pk-brief-line' }, {
        children: [briefBox, el('span', { text: '开场 PK 时自动播报对面情报' })],
      }),
      el('label', { class: 'pk-brief-line' }, {
        children: [el('span', { text: '榜十贡献满' }), threshold, el('span', { text: '算强（0 = 永远算一般）' })],
      }),
      el('label', { class: 'pk-brief-line' }, {
        children: [el('span', { text: '播报文案（保留占位符）：' })],
      }),
      el('label', { class: 'pk-brief-line' }, {
        children: [el('span', { text: '主播：' }), nameInput],
      }),
      el('label', { class: 'pk-brief-line' }, {
        children: [el('span', { text: '人数：' }), onlineInput],
      }),
      el('label', { class: 'pk-brief-line' }, {
        children: [el('span', { text: '贡献：' }), rankInput],
      }),
      el('p', { class: 'pk-hint', text: '整段都能改；{名字}、{人数}、{贡献} 会替换成实时数据，别删。' }),
      el('label', { class: 'pk-brief-line' }, {
        children: [el('span', { text: '强：' }), strongInput],
      }),
      el('label', { class: 'pk-brief-line' }, {
        children: [el('span', { text: '弱：' }), weakInput],
      }),
    ],
  });

  replaceChildren(dlg, [
    el('div', { class: 'pk-wrap' }, { children: [head, grid, compare, briefRow, foot] }),
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
    const brief = view?.brief ?? {};
    briefBox.checked = brief.enabled === true;
    threshold.value = String(brief.threshold ?? 1000);
    nameInput.value = brief.name || '迎战主播：{名字}';
    onlineInput.value = brief.online || '在线人数：{人数}';
    rankInput.value = brief.rank || '前十贡献：{贡献}';
    strongInput.value = brief.strong || '';
    weakInput.value = brief.weak || '';
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
      // busy 是单飞锁，不管 seq 有没有变都要放开，否则一次慢请求会把面板永久锁死
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
    const rawThreshold = threshold.value.trim();
    const wantThreshold = Number(rawThreshold);
    // Number('') === 0：清空输入框不能被当成"0 = 永远算一般"
    if (!rawThreshold || !Number.isInteger(wantThreshold) || wantThreshold < 0) {
      toast('强敌阈值要写成 0 或正整数', 'error');
      return;
    }
    for (const [label, box, placeholder] of [
      ['主播', nameInput, '{名字}'],
      ['人数', onlineInput, '{人数}'],
      ['贡献', rankInput, '{贡献}'],
    ]) {
      const text = box.value.trim();
      if (!text) {
        toast(`${label}播报文案不能为空`, 'error');
        return;
      }
      if (!text.includes(placeholder)) {
        toast(`${label}播报文案里要保留 ${placeholder}`, 'error');
        return;
      }
    }
    if (!strongInput.value.trim() || !weakInput.value.trim()) {
      toast('强弱两段文案都要填', 'error');
      return;
    }
    saveBtn.disabled = true;
    try {
      const saved = await api.savePk({
        roomId: raw,
        enabled: briefBox.checked,
        threshold: wantThreshold,
        name: nameInput.value.trim(),
        online: onlineInput.value.trim(),
        rank: rankInput.value.trim(),
        strong: strongInput.value.trim(),
        weak: weakInput.value.trim(),
      });
      toast(raw ? '已保存 PK 房间与开场播报' : '已关闭 PK 情报（开场播报设置已保留）');
      render(saved);
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
