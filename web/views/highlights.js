/**
 * 从一场的时间轴数据里挑「值得回看」的瞬间。
 *
 * 只做选择，不做文案：文案由页面用同一套 `markBody` 拼，
 * 免得服务端和前端各写一份金额格式。
 *
 * 规则很直白：
 *   - 花钱的事优先：醒目留言 > 上舰 > 礼物（金额越高越靠前）；
 *   - 再补两处弹幕高峰，免得整张单子只剩「谁送了钱」；
 *   - 选完按时间排回去，剪辑时是从头往后看的。
 */

/** 一条事件值多少分。分数只用于排序，没有业务含义。 */
function scoreOf(mark) {
  const battery = Number(mark?.battery) || 0;
  switch (mark?.type) {
    case 'SUPER_CHAT':
      return 1000 + battery * 2;
    case 'GUARD_BUY':
      return 800 + battery;
    case 'GIFT':
      return battery > 0 ? 100 + battery : 0;
    default:
      return 0;
  }
}

/**
 * @param {object[]} marks 时间轴返回的 marks（GIFT / SC / GUARD / FOLLOW…）
 * @param {object[]} frames 时间轴返回的 frames（含 danmakuDelta）
 * @param {{from?:number, max?:number}} [opts]
 * @returns {object[]} 按时间升序的高光；每项保留原 mark 字段并加 `score`
 */
export function pickHighlights(marks, frames, { from = 0, max = 12 } = {}) {
  const want = Number(max)
  const cap = Math.min(30, Math.max(1, Number.isFinite(want) ? Math.floor(want) : 12));
  const picked = [];

  for (const m of Array.isArray(marks) ? marks : []) {
    const score = scoreOf(m);
    if (score > 0) picked.push({ ...m, score });
  }

  // 弹幕高峰：每格是「这一格新增的弹幕数」，挑最高的两格。
  // 和礼物放在一起时分数压低，避免一晚上只有几根柱子。
  const peaks = (Array.isArray(frames) ? frames : [])
    .map((f) => ({ ...f, delta: Number(f?.danmakuDelta) || 0 }))
    .filter((f) => f.delta >= 10)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 2);

  for (const f of peaks) {
    picked.push({
      type: 'PEAK',
      ts: Number(f.t) || 0,
      count: f.delta,
      score: 60 + Math.min(200, f.delta),
    });
  }

  const top = picked
    .sort((a, b) => b.score - a.score || Number(a.ts) - Number(b.ts))
    .slice(0, cap)
    .filter((m) => Number(m.ts) > 0);

  return top.sort((a, b) => Number(a.ts) - Number(b.ts));
}
