/**
 * 周报：把「最近 7 天」的战报加成一个总数，再压成一条适合锁屏看的长消息。
 *
 * 口径与 /api/reports 完全一致——周报不另算一遍，只做加法。
 * 场次来自 buildReports()，所以「按开场日归属」这条规则也一起继承：
 * 22:00 播到 02:00 的那一场算在开场那天。
 */

export const WEEKLY_WINDOW_DAYS = 7;
export const WEEKLY_WEEKDAY = 1; // 周一
export const WEEKLY_HOUR = 10; // 上午 10 点

function yuanText(batteryValue) {
  const v = (Number(batteryValue) || 0) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function durText(sec) {
  const totalMin = Math.max(0, Math.round((Number(sec) || 0) / 60));
  if (totalMin < 1) return '不到 1 分钟';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (!h) return `${m} 分钟`;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 把若干场战报加成一周的总数。纯函数。 */
export function weeklySummary(reports = []) {
  const sum = {
    sessions: 0,
    durationSec: 0,
    danmaku: 0,
    enterCount: 0,
    followCount: 0,
    giftCount: 0,
    giftBattery: 0,
    guardCount: 0,
    guardBattery: 0,
    scCount: 0,
    scBattery: 0,
    totalBattery: 0,
  };
  for (const r of reports) {
    if (!r) continue;
    sum.sessions += 1;
    sum.durationSec += Number(r.durationSec) || 0;
    sum.danmaku += Number(r.danmaku) || 0;
    sum.enterCount += Number(r.enterCount) || 0;
    sum.followCount += Number(r.followCount) || 0;
    sum.giftCount += Number(r.giftCount) || 0;
    sum.giftBattery += Number(r.giftBattery) || 0;
    sum.guardCount += Number(r.guardCount) || 0;
    sum.guardBattery += Number(r.guardBattery) || 0;
    sum.scCount += Number(r.scCount) || 0;
    sum.scBattery += Number(r.scBattery) || 0;
    sum.totalBattery += Number(r.totalBattery) || 0;
  }
  return sum;
}

/**
 * 一条能直接推到手机的周报。
 *
 * 为什么压这么短：手机锁屏通知一屏就那么点，超过三四行就会被折叠；
 * 想看细的可以去页面上的场后战报，那条路径一直在。
 */
export function weeklyText({ roomId = '', title = '', summary = {} } = {}) {
  const head = `【周报】房间 ${roomId}${title ? ` · ${title}` : ''}`;
  const s = summary && typeof summary === 'object' ? summary : {};
  const sessions = Number(s.sessions) || 0;

  if (!sessions) return `${head}\n最近 ${WEEKLY_WINDOW_DAYS} 天没有开播记录。`;

  return [
    head,
    `最近 ${WEEKLY_WINDOW_DAYS} 天：${sessions} 场 · 直播 ${durText(s.durationSec)}`,
    `弹幕 ${Number(s.danmaku) || 0} · 进场 ${Number(s.enterCount) || 0} · 涨粉 ${Number(s.followCount) || 0}`,
    `礼物 ¥${yuanText(s.giftBattery)} · 舰长 ¥${yuanText(s.guardBattery)} · 醒目留言 ¥${yuanText(s.scBattery)}`,
    `总收入 ¥${yuanText(s.totalBattery)}`,
  ].join('\n');
}

/**
 * 下一次该发周报的时间（本地时区的周一 10:00）。
 *
 * 正好卡在 10:00:00 那一刻调用时返回**下一周**，避免边界上重复发。
 */
export function weeklyNextAt(now = Date.now(), weekday = WEEKLY_WEEKDAY, hour = WEEKLY_HOUR) {
  const d = new Date(now);
  const daysAhead = ((Number(weekday) - d.getDay() + 7) % 7) || 0;
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + daysAhead, Number(hour), 0, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 7);
  return target.getTime();
}
