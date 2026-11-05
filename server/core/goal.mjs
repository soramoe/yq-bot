/**
 * 本场礼物目标：纯计算，不碰 DOM、不碰网络。
 *
 * 目标回答三件事：
 *   · 这一笔礼物把本场推过了哪一档（`goalMilestone`）；
 *   · 过线时该说哪句话（`goalText`）；
 *   · 自定义文案支持哪几个占位符（`{当前}` / `{目标}` / `{百分比}`）。
 *
 * 为什么用"过线"而不是"当前比例"：每来一条礼物都报一次进度会刷屏，
 * 而把"从 29% 到 31%"和"从 0 直接跳到 120%"都归成同一次过线，
 * 才不会出现"一条大礼物连喊好几声"。
 */

/** 目标上限（电池）。1e9 电池 = 1 亿元，足够拦住手滑多打几个 0 */
export const MAX_GOAL_BATTERY = 1_000_000_000

/** 默认四档：低档给"开始有人帮"的反馈，高档给"还差一点"的推动 */
export const GOAL_TIERS = Object.freeze([30, 60, 80, 100])

/** 电池 → 元，不带 ¥ 前缀；整数不带小数点，和战报/榜单一个口径 */
function yuanText(battery) {
  const v = Math.max(0, Number(battery) || 0) / 10
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/**
 * 这一笔礼物越过了哪一档（30 / 60 / 80 / 100），没越过返回 0。
 *
 * 一条礼物同时越过几档时只报最高的那档：先喊 30% 再喊 60% 会在一秒内连发，
 * 而观众看到的本来就是"直接到了 60%"。
 *
 * @param {number} before 这笔之前的本场礼物电池
 * @param {number} after  这笔之后的本场礼物电池
 * @param {number} goal   目标电池，0 = 关闭
 * @param {number[]} [tiers] 档位百分比，默认四档
 * @returns {number} 越过的最高档，没越过返回 0
 */
export function goalMilestone(before, after, goal, tiers = GOAL_TIERS) {
  const g = Number(goal) || 0
  const b = Number(before) || 0
  const a = Number(after) || 0
  if (g <= 0 || a <= b) return 0

  const list = [...new Set(tiers.map((x) => Number(x)).filter((x) => x > 0 && x <= 100))].sort(
    (x, y) => x - y,
  );

  let hit = 0
  for (const pct of list) {
    const line = (g * pct) / 100
    if (b < line && a >= line) hit = pct
  }
  return hit
}

/**
 * 过线播报文案。尽量短：弹幕是公共频道，一句话说完比一段话更容易被看见。
 *
 * 自定义文案支持三个占位符，写别的原样保留：
 *   {当前} → 过线时的金额（元）    {目标} → 目标金额（元）    {百分比} → 档位
 *
 * @param {number} milestone 越过的档位百分比
 * @param {number} after 过线时的本场礼物电池
 * @param {number} goal  目标电池
 * @param {string} [custom] 自定义文案，空串用默认
 */
export function goalText(milestone, after, goal, custom = '') {
  const target = yuanText(goal)
  const current = yuanText(after)
  const own = typeof custom === 'string' ? custom.trim() : ''
  if (own) {
    return own
      .replaceAll('{当前}', `¥${current}`)
      .replaceAll('{目标}', `¥${target}`)
      .replaceAll('{百分比}', String(milestone))
  }
  if (milestone >= 100) return `礼物目标达成！¥${target}`
  return `礼物目标到 ${milestone}% 啦：¥${current}/¥${target}`
}
