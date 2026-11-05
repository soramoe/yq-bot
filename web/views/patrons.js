/**
 * 付费用户档案。
 *
 * 「谁在这个直播间花过钱、花了多少」——按 uid 跨场次合并，
 * 数字全部来自 `/api/patrons`（服务端重放日志得出），前端只负责排版。
 *
 * 大额提醒的阈值也放这里：它和这张榜回答的是同一个问题
 * （"哪些消费值得当场看一眼"），分开摆会让人不知道去哪儿调。
 */

import { el, replaceChildren } from '../core/dom.js';
import { api } from '../core/api.js';
import { n, yuan } from '../core/format.js';

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

export function createPatrons({ dlg, toast }) {
  let days = 30;
  let busy = false;
  /** 在途请求期间又切了范围：等这次回来再按最新的 days 拉一次，不能把点击吞掉 */
  let pendingReload = false;
  /** 请求序号：切范围快的时候，先发的旧结果不能盖掉后发的新结果 */
  let loadSeq = 0;
  /** 输入框里当前显示的阈值（电池）；保存成功会递增版本号 */
  let shownThresholdBattery = 0;
  /** 回访提醒门槛（电池）；与单笔大额共用一次保存 */
  let shownReturnBattery = 0;
  let thresholdVersion = 0;
  /** 这次 load 发出时的保存版本：之后又保存过，旧响应就不能回滚输入框 */
  let loadVersion = 0;

  const closeBtn = el('button', {
    class: 'btn',
    text: '关闭',
    attrs: { type: 'button' },
    on: { click: () => dlg.close() },
  });

  const head = el('header', { class: 'patron-head' }, {
    children: [
      el('h4', { text: '付费用户档案' }),
      el('span', { class: 'patron-sub', text: '按 uid 跨场次合并 · 免费礼物不计金额' }),
      closeBtn,
    ],
  });

  const chipRow = el('div', { class: 'patron-chips' });
  const summaryBox = el('div', { class: 'patron-summary' });
  const listBox = el('div', { class: 'patron-list' });

  const alertInput = el('input', {
    class: 'patron-num',
    attrs: { type: 'number', min: '0', step: '0.1', inputmode: 'decimal' },
  });
  const returnInput = el('input', {
    class: 'patron-num',
    attrs: { type: 'number', min: '0', step: '0.1', inputmode: 'decimal' },
  });
  // 榜单还没回来就点保存时，空串会被当成"没填"而拒绝；默认显示 0 更符合直觉
  alertInput.value = '0';
  returnInput.value = '0';
  const alertSave = el('button', {
    class: 'btn',
    text: '保存',
    attrs: { type: 'button' },
    on: { click: saveAlert },
  });

  const alertRow = el('div', { class: 'patron-alert' }, {
    children: [
      el('label', { class: 'patron-alert-label', text: '单笔大额提醒：满 ¥' }),
      alertInput,
      el('span', { class: 'patron-alert-unit', text: '时提醒' }),
    ],
  });

  const returnRow = el('div', { class: 'patron-alert' }, {
    children: [
      el('label', { class: 'patron-alert-label', text: '回访提醒：近 90 天累计满 ¥' }),
      returnInput,
      el('span', { class: 'patron-alert-unit', text: '时提醒（只在本场第一次进房）' }),
      alertSave,
    ],
  });

  const alertHint = el('p', {
    class: 'patron-hint',
    text: '0 = 关闭。大额只按单笔判断；回访只看这场开播之前的付费记录（同一场同一人只响一次，不往外发 webhook）。',
  });

  replaceChildren(dlg, [
    el('div', { class: 'patron-wrap' }, {
      children: [head, chipRow, summaryBox, listBox, alertRow, returnRow, alertHint],
    }),
  ]);

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

  function renderSummary(data) {
    const t = data?.totals ?? {};
    const total = Number(t.totalBattery) || 0;
    if (!t.patrons) {
      replaceChildren(summaryBox, [
        el('div', { class: 'empty-hint', text: '这段时间还没有付费记录' }),
      ]);
      return;
    }

    const cell = (k, v, accent) =>
      el('div', { class: 'patron-cell' }, {
        children: [
          el('div', { class: 'k', text: k }),
          el('div', { class: `v${accent ? ' accent' : ''}`, text: v }),
        ],
      });

    replaceChildren(summaryBox, [
      cell('付费用户', `${n(t.patrons)} 位`),
      cell('合计', `¥${yuan(total)}`, true),
      cell('礼物', `¥${yuan(t.giftBattery)}`),
      cell('舰长', `¥${yuan(t.guardBattery)}`),
      cell('醒目留言', `¥${yuan(t.scBattery)}`),
    ]);
  }

  function renderList(data) {
    const rows = Array.isArray(data?.patrons) ? data.patrons : [];
    if (!rows.length) {
      replaceChildren(listBox, [
        el('div', { class: 'empty-hint', text: '没有符合条件的付费用户' }),
      ]);
      return;
    }

    replaceChildren(
      listBox,
      rows.map((p) => {
        const parts = [];
        if (p.giftBattery > 0) parts.push(`礼物 ¥${yuan(p.giftBattery)}`);
        if (p.guardBattery > 0) parts.push(`舰长 ¥${yuan(p.guardBattery)}`);
        if (p.scBattery > 0) parts.push(`SC ¥${yuan(p.scBattery)}`);

        return el('div', { class: 'patron-row' }, {
          children: [
            el('span', { class: 'patron-rank', text: `#${p.rank}` }),
            el('span', { class: 'patron-who' }, {
              children: [
                el('b', { text: p.name || `uid ${p.uid}` }),
                el('span', { class: 'patron-uid', text: `uid ${p.uid}` }),
              ],
            }),
            el('span', { class: 'patron-money', text: `¥${yuan(p.totalBattery)}` }),
            el('span', { class: 'patron-break', text: parts.join(' · ') || '—' }),
            el('span', { class: 'patron-last', text: `上次 ${stamp(p.lastTs)}` }),
          ],
        });
      }),
    );
  }

  function render(data) {
    renderSummary(data);
    renderList(data);
    // 保存请求比这次 load 更晚落地时，服务端返回值才是新的；
    // 否则这个迟到的响应会把刚输入的阈值改回旧值。
    if (loadVersion === thresholdVersion) {
      shownThresholdBattery = Number(data?.bigSpendBattery) || 0;
      shownReturnBattery = Number(data?.returnBattery) || 0;
    }
    alertInput.value = String(shownThresholdBattery / 10);
    returnInput.value = String(shownReturnBattery / 10);
  }

  async function load() {
    if (busy) {
      pendingReload = true;
      return;
    }
    busy = true;
    pendingReload = false;
    const seq = ++loadSeq;
    loadVersion = thresholdVersion;

    try {
      const data = await api.patrons({ days, limit: 50 });
      if (seq !== loadSeq) return; // 已经有更新的请求在路上了，旧结果直接丢
      render(data);
    } catch (err) {
      if (seq !== loadSeq) return;
      toast(`付费用户榜打不开：${err.message}`, 'error');
    } finally {
      busy = false;
      if (pendingReload) {
        pendingReload = false;
        load();
      }
    }
  }

  async function saveAlert() {
    const parseYuan = (input, label) => {
      const rawValue = input.value.trim();
      // 空串会被 Number('') 变成 0 —— 不能把"清空输入框"当成"关掉提醒"
      if (rawValue === '') {
        toast(`${label}要写成 0 或正数（单位：元）`, 'error');
        return null;
      }
      const yuanValue = Number(rawValue);
      if (!Number.isFinite(yuanValue) || yuanValue < 0) {
        toast(`${label}要写成 0 或正数（单位：元）`, 'error');
        return null;
      }
      // 页面用元输入，接口收电池：1 元 = 10 电池。这里只做一次换算
      return Math.round(yuanValue * 10);
    };

    const batteryValue = parseYuan(alertInput, '提醒阈值');
    if (batteryValue === null) return;
    const returnBatteryValue = parseYuan(returnInput, '回访提醒门槛');
    if (returnBatteryValue === null) return;

    alertSave.disabled = true;
    try {
      const r = await api.saveBigSpend(batteryValue, returnBatteryValue);
      shownThresholdBattery = Number(r.battery) || 0;
      shownReturnBattery = Number(r.returnBattery) || 0;
      thresholdVersion += 1;
      alertInput.value = String(shownThresholdBattery / 10);
      returnInput.value = String(shownReturnBattery / 10);
      const parts = [];
      parts.push(
        shownThresholdBattery ? `单笔满 ¥${shownThresholdBattery / 10} 就提醒` : '大额提醒已关闭',
      );
      parts.push(
        shownReturnBattery ? `回访门槛 ¥${shownReturnBattery / 10}` : '回访提醒已关闭',
      );
      toast(parts.join('；'), 'info');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      alertSave.disabled = false;
    }
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
  };
}
