/**
 * 事件流视图。
 *
 * 三个决定：
 *
 * 1. **渲染有上限，数据没有。** DOM 最多留 1200 行，删头补尾时补偿 scrollTop，
 *    否则长直播跑到几万条时页面会开始卡，而且滚动位置会乱跳。
 *
 * 2. **自动滚动只在"用户本来就在底部"时生效。** 否则你往上翻看某条弹幕，
 *    下一秒就被新事件拽回底部 —— 这是监控界面最常见的烦人设计。
 *
 * 3. **进场默认不显示。** 一个几千人的房间，进场能占全部事件的 70%，
 *    全显示出来就把礼物和弹幕淹了。它还在，只是需要你主动打开。
 */

import { el } from '../core/dom.js';
import { battery, guardName, hhmmss, yuan } from '../core/format.js';

/** 事件分组，用于筛选 chip */
const GROUPS = {
  DANMAKU: ['DANMAKU'],
  GIFT: ['GIFT', 'GUARD_BUY', 'SUPER_CHAT'],
  ENTER: ['ENTER', 'FOLLOW'],
  ROBOT: ['SENT'],
  SYSTEM: ['LIVE_START', 'LIVE_END', 'ROOM_TITLE'],
};

/** 默认选中的组：进场关着，其余开着 */
const DEFAULT_ON = ['DANMAKU', 'GIFT', 'ROBOT', 'SYSTEM'];

/** 这两个是"心跳数字"，不是事件。计入统计，但不该占一行文字。 */
const NEVER_RENDER = new Set(['LIKE', 'ONLINE_COUNT']);

const LABEL = {
  DANMAKU: '弹幕',
  ENTER: '进场',
  GIFT: '礼物',
  GUARD_BUY: '舰长',
  SUPER_CHAT: '醒目',
  FOLLOW: '关注',
  SENT: '发言',
  LIVE_START: '开播',
  LIVE_END: '下播',
  ROOM_TITLE: '改标题',
};

const MAX_ROWS = 1200;
const NEAR_BOTTOM = 80;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.body 滚动容器
 * @param {HTMLElement} opts.chips 筛选按钮容器
 * @param {HTMLElement} opts.jump "有新事件"按钮
 * @param {HTMLElement} opts.count 计数显示
 * @param {{events:any[]}} opts.store 事件仓库（切换筛选时从这里重建）
 */
export function createStream({ body, chips, jump, count, store }) {
  /** @type {Set<string>} */
  const on = new Set(DEFAULT_ON);
  let rendered = 0;

  // index.html 里已经放了一个空状态（JS 还没跑的时候给个提示）。
  // 复用它，而不是再 append 一个 —— 否则 DOM 里会有两个"等待事件…"，
  // 而代码只管得住自己创建的那个，静态那个永远删不掉。
  let emptyEl = body.querySelector('.stream-empty');
  if (!emptyEl) {
    emptyEl = buildEmpty('等待事件…');
    body.append(emptyEl);
  }

  /* ── 筛选 UI ── */

  const chipNodes = Object.keys(GROUPS).map((k) => {
    const btn = el('button', {
      class: 'chip',
      text: { DANMAKU: '弹幕', GIFT: '礼物', ENTER: '进场', ROBOT: '机器人', SYSTEM: '系统' }[k],
      attrs: { type: 'button', 'aria-pressed': String(on.has(k)) },
      on: {
        click: () => {
          if (on.has(k)) on.delete(k);
          else on.add(k);
          btn.setAttribute('aria-pressed', String(on.has(k)));
          rerenderFromStore();
        },
      },
    });
    return btn;
  });
  chips.append(...chipNodes);

  /* ── 滚动行为 ── */

  const isNearBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < NEAR_BOTTOM;

  function scrollToBottom() {
    body.scrollTop = body.scrollHeight;
    jump.hidden = true;
  }

  jump.addEventListener('click', scrollToBottom);

  body.addEventListener('scroll', () => {
    if (isNearBottom()) jump.hidden = true;
  });

  /* ── 渲染 ── */

  function visible(type) {
    if (NEVER_RENDER.has(type)) return false;
    for (const k of Object.keys(GROUPS)) {
      if (on.has(k) && GROUPS[k].includes(type)) return true;
    }
    return false;
  }

  /**
   * 追加一批事件。
   * @param {any[]} list 已按 seq 升序
   */
  function append(list) {
    if (!list.length) return;

    const wasNear = isNearBottom();
    const frag = document.createDocumentFragment();
    let added = 0;

    for (const ev of list) {
      const row = renderRow(ev);
      if (!row) continue;
      frag.append(row);
      added++;
    }

    if (!added) {
      // 一行都没画出来，但事件确实在进来（比如只开"弹幕"而房间全是进场）。
      // 这时空状态还写着"等待事件…"，看起来像没连上 —— 说清楚是筛选挡的。
      if (!rendered && emptyEl) {
        emptyEl.textContent =
          on.size === 0 ? '所有分类都被关掉了' : '这一类暂时没有事件（数据在收，只是没勾选）';
      }
      updateCount();
      return;
    }

    if (emptyEl) {
      emptyEl.remove();
      emptyEl = null;
    }

    body.append(frag);
    rendered += added;

    trim(wasNear);

    if (wasNear) scrollToBottom();
    else jump.hidden = false;

    updateCount();
  }

  /**
   * 删掉超量的头部行。
   * 必须补偿 scrollTop，否则用户正在往上看时内容会自己往上跳一截。
   */
  function trim(wasNear) {
    const over = rendered - MAX_ROWS;
    if (over <= 0) return;

    const before = body.scrollHeight;
    for (let i = 0; i < over; i++) {
      const first = body.firstElementChild;
      if (!first) break;
      first.remove();
      rendered--;
    }
    if (!wasNear) {
      body.scrollTop -= before - body.scrollHeight;
    }
  }

  function renderRow(ev) {
    if (!visible(ev.type)) return null;

    const p = ev.payload ?? {};
    return el('div', {
      class: 'ev',
      dataset: { k: ev.type },
      attrs: { title: `#${ev.seq}` },
      children: [
        el('span', { class: 'ev-time', text: hhmmss(ev.ts) }),
        el('span', { class: 'ev-tag', text: LABEL[ev.type] ?? ev.type }),
        // 窄屏会把标签列藏掉，改用这个属性在正文前面补一个类型前缀
        el('div', { class: 'ev-body', dataset: { tag: LABEL[ev.type] ?? ev.type }, children: bodyOf(ev, p) }),
      ],
    });
  }

  function bodyOf(ev, p) {
    const who = el('span', { class: 'ev-who', text: p.uname || p.replyUname || '匿名' });

    switch (ev.type) {
      case 'DANMAKU':
        return [
          who,
          medalNote(p.medal),
          el('span', {
            class: 'ev-text',
            text: p.text || (p.imageAlt ? `[表情 ${p.imageAlt}]` : '（空消息）'),
          }),
        ];

      case 'GIFT': {
        const amount = `${battery(p.battery)} 电池 · ¥${yuan(p.battery)}`;
        return [
          who,
          el('span', { class: 'ev-text', text: '送出 ' }),
          el('span', { class: 'ev-text', text: p.giftName || '礼物' }),
          el('span', { class: 'ev-note', text: `×${p.num ?? 1}` }),
          el('span', { class: 'ev-amount', text: amount }),
        ];
      }

      case 'GUARD_BUY':
        return [
          who,
          el('span', { class: 'ev-text', text: `开通${guardName(p.guardLevel)}` }),
          el('span', { class: 'ev-amount', text: `${battery(p.battery)} 电池` }),
        ];

      case 'SUPER_CHAT':
        return [
          who,
          el('span', { class: 'ev-text', text: p.text || '（醒目留言）' }),
          el('span', { class: 'ev-amount', text: `¥${yuan(p.battery)}` }),
        ];

      case 'ENTER':
        return [who, el('span', { class: 'ev-text', text: '进入直播间' }), medalNote(p.medal)];

      case 'FOLLOW':
        return [who, el('span', { class: 'ev-text', text: '关注了' })];

      case 'SENT':
        return [
          el('span', { class: 'ev-who', text: '机器人' }),
          el('span', { class: 'ev-text', text: p.text ?? '' }),
          el('span', { class: 'ev-note', text: p.dryRun ? '演练' : '已发送' }),
          p.truncated ? el('span', { class: 'ev-note', text: '已截断' }) : null,
        ];

      case 'LIVE_START':
        return [el('span', { class: 'ev-text', text: '直播开始' })];

      case 'LIVE_END':
        return [el('span', { class: 'ev-text', text: '直播结束' })];

      case 'ROOM_TITLE':
        return [
          el('span', { class: 'ev-text', text: `标题改为「${p.title ?? ''}」` }),
        ];

      default:
        return [who, el('span', { class: 'ev-text', text: ev.type })];
    }
  }

  function medalNote(medal) {
    if (!medal || !medal.name) return null;
    return el('span', { class: 'ev-note', text: `[${medal.name}${medal.level ? ` ${medal.level}` : ''}]` });
  }

  /**
   * 筛选变化后重画。
   * 只重画这一屏 —— 事件源是内存里的 store，不重新请求。
   */
  function rerenderFromStore() {
    body.replaceChildren();
    rendered = 0;
    emptyEl = null;

    // 用最近的一批重建，避免"切筛选就把几千行全塞回来"
    const slice = store.events.slice(-MAX_ROWS);
    const frag = document.createDocumentFragment();
    for (const ev of slice) {
      const row = renderRow(ev);
      if (!row) continue;
      frag.append(row);
      rendered++;
    }

    if (rendered === 0) {
      emptyEl = buildEmpty(on.size === 0 ? '所有分类都被关掉了' : '这一类暂时没有事件');
      body.append(emptyEl);
    } else {
      body.append(frag);
      requestAnimationFrame(scrollToBottom);
    }
    updateCount();
  }

  function reset() {
    body.replaceChildren();
    rendered = 0;
    emptyEl = buildEmpty('等待事件…');
    body.append(emptyEl);
    jump.hidden = true;
    updateCount();
  }

  function updateCount() {
    count.textContent = rendered ? `显示 ${rendered.toLocaleString('zh-CN')} 条` : '';
  }

  return { append, reset };
}

function buildEmpty(text) {
  return el('div', { class: 'stream-empty', text });
}
