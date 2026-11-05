/**
 * 醒目留言待读队列。
 *
 * SC 是单价最高、也最容易被弹幕刷走的一类事件：插件已经回过一句，
 * 但那句话留在直播间的聊天流里，主播切走一眼就找不回来了。
 * 这里把日志里的 SC 重新捞出来，配上"已读"状态 —— 日志是事实，
 * 已读标记只是这张清单的投影，不参与任何统计。
 */

/** 最多保留多少条已读 id：SC 本来就不多，5000 条够覆盖很久 */
export const MAX_READ_IDS = 5000;
/** 单次最多回多少条：防止一个奇怪的历史房间把面板拖成几千行 */
export const MAX_QUEUE_ITEMS = 500;

/** 电池 → 元，和战报/榜单同一口径（10 电池 = 1 元） */
function moneyText(battery) {
  const v = Math.max(0, Number(battery) || 0) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** SC 的价格：优先报文里的电池价，旧日志没有就按 1 元 = 10 电池折算 */
function scBatteryOf(p) {
  const direct = Number(p?.battery);
  if (Number.isFinite(direct) && direct >= 0) return Math.round(direct);
  return Math.max(0, Math.round((Number(p?.yuan) || 0) * 10));
}

/**
 * @param {Array<object>} events 日志事件（任意顺序）
 * @param {{days?:number, now?:number, readIds?:Set<string>, max?:number}} [opts]
 * @returns {{days:number, from:number, to:number, items:object[], unread:number, scanned:number}}
 */
export function buildScQueue(events, { days = 30, now = Date.now(), readIds = new Set(), max = MAX_QUEUE_ITEMS } = {}) {
  const to = Number.isFinite(now) ? now : Date.now();
  const d = Number.isFinite(days) && days > 0 ? days : 0;
  const from = d > 0 ? to - d * 86_400_000 : 0;
  const cap = Math.min(MAX_QUEUE_ITEMS, Math.max(1, Math.floor(Number(max) || MAX_QUEUE_ITEMS)));
  const read = readIds instanceof Set ? readIds : new Set();

  const found = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.type !== 'SUPER_CHAT') continue;
    const seq = Number(ev.seq);
    const ts = Number(ev.ts);
    if (!Number.isFinite(seq) || !Number.isFinite(ts) || ts <= 0) continue;
    if (d > 0 && ts < from) continue;

    const p = ev.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const uid = String(p.uid ?? '').trim();
    const uname = String(p.uname ?? '').trim();
    const name = uname || String(p.name ?? '').trim() || (uid ? `uid ${uid}` : '匿名观众');
    const id = String(ev.id || `e${ev.roomId ?? ''}-${seq}`);
    const battery = scBatteryOf(p);

    found.push({
      id,
      seq,
      ts,
      uid,
      name,
      text: String(p.text ?? ''),
      yuan: battery / 10,
      battery,
      money: `¥${moneyText(battery)}`,
      read: read.has(id),
    });
  }

  // 新的在前；同一毫秒按 seq 倒序，保证顺序稳定
  found.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
  const items = found.slice(0, cap);
  return {
    days: d,
    from,
    to,
    items,
    unread: items.filter((it) => !it.read).length,
    scanned: found.length,
  };
}
