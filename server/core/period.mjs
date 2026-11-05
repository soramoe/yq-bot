/**
 * 月报 / 季报：把一段时间的场次战报加起来，和上一段比。
 *
 * 和战报、周报一样，只做加法，不重新定义口径：
 * 电池还是 10 = 1 元，免费礼物还是 0，旧日志缺字段就按 0 算。
 */

export const PERIOD_KINDS = Object.freeze(['month', 'quarter']);

const MONTH_NAMES = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];

/** 本地时区的自然月 / 自然季边界；to 不含，方便直接比较 ts */
export function periodRange(kind, now = Date.now()) {
  const d = new Date(now);
  const year = d.getFullYear();
  const month = d.getMonth();

  if (kind === 'quarter') {
    const q = Math.floor(month / 3);
    const from = new Date(year, q * 3, 1);
    const to = new Date(year, q * 3 + 3, 1);
    const prevFrom = new Date(year, q * 3 - 3, 1);
    return {
      kind,
      label: `${year} 年第 ${q + 1} 季度`,
      from: from.getTime(),
      to: to.getTime(),
      prevFrom: prevFrom.getTime(),
      prevTo: from.getTime(),
    };
  }

  const from = new Date(year, month, 1);
  const to = new Date(year, month + 1, 1);
  const prevFrom = new Date(year, month - 1, 1);
  return {
    kind: 'month',
    label: `${year} 年 ${MONTH_NAMES[month]}`,
    from: from.getTime(),
    to: to.getTime(),
    prevFrom: prevFrom.getTime(),
    prevTo: from.getTime(),
  };
}

const SUM_KEYS = [
  'durationSec',
  'danmaku',
  'enterCount',
  'followCount',
  'giftCount',
  'giftBattery',
  'guardCount',
  'guardBattery',
  'scCount',
  'scBattery',
  'totalBattery',
];

/** 把一场场 summarizeSession 的结果加成一个区间总数 */
export function periodSummary(reports = []) {
  const out = { sessions: 0 };
  for (const k of SUM_KEYS) out[k] = 0;
  for (const r of reports) {
    if (!r || typeof r !== 'object') continue;
    out.sessions += 1;
    for (const k of SUM_KEYS) out[k] += Math.max(0, Number(r?.[k]) || 0);
  }
  return out;
}

/** 收入、弹幕这类数字的环比；上期为 0 时 pct 给 null，不编「+∞%」 */
export function periodDelta(cur, prev) {
  const keys = ['totalBattery', 'giftBattery', 'guardBattery', 'scBattery', 'danmaku', 'followCount', 'sessions'];
  const out = {};
  for (const k of keys) {
    const a = Number(cur?.[k]) || 0;
    const b = Number(prev?.[k]) || 0;
    out[k] = {
      value: a,
      prev: b,
      diff: a - b,
      pct: b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null,
    };
  }
  return out;
}

function yuan(battery) {
  const v = Math.max(0, Number(battery) || 0) / 10;
  return `¥${Number.isInteger(v) ? v : v.toFixed(1)}`;
}

function durationText(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (!h) return `${m} 分钟`;
  return `${h} 小时 ${m} 分`;
}

function pctText(delta) {
  if (!delta) return '';
  if (delta.pct === null) return delta.value > 0 ? '上期没有记录' : '';
  const sign = delta.pct > 0 ? '+' : '';
  return `${sign}${delta.pct}%`;
}

/** 一段可以直接发群里的纯文本；没有数据也不硬撑 */
export function periodText({ kind = 'month', label = '', cur = {}, prev = {}, delta = null } = {}) {
  const title = kind === 'quarter' ? '季报' : '月报';
  const lines = [`【${title}】${label}`];
  if (!cur.sessions) {
    lines.push('这段时间没有开播记录。');
    return lines.join('\n');
  }
  lines.push(
    `场次 ${cur.sessions} · 时长 ${durationText(cur.durationSec)} · 弹幕 ${cur.danmaku} · 进场 ${cur.enterCount} · 涨粉 ${cur.followCount}`,
  );
  lines.push(
    `收入 ${yuan(cur.totalBattery)}（礼物 ${yuan(cur.giftBattery)} / 舰长 ${yuan(cur.guardBattery)} / 醒目留言 ${yuan(cur.scBattery)}）`,
  );
  if (delta) {
    const income = delta.totalBattery;
    const danmaku = pctText(delta.danmaku);
    const parts = [];
    if (income?.pct !== null) parts.push(`收入 ${pctText(income)}`);
    else if (income?.value) parts.push('上期没有收入记录');
    if (danmaku) parts.push(`弹幕 ${danmaku}`);
    if (delta.sessions && delta.sessions.diff) {
      parts.push(`场次 ${delta.sessions.diff > 0 ? '+' : ''}${delta.sessions.diff}`);
    }
    if (parts.length) lines.push(`比上期：${parts.join(' · ')}`);
  }
  return lines.join('\n');
}
