/**
 * 本场礼物目标：纯计算，不碰 DOM、不碰网络。
 *
 * 目标只回答两件事：
 *   · 这一笔礼物有没有把本场推过 50% / 100%（`goalMilestone`）；
 *   · 过线时该说哪句话（`goalText`）。
 *
 * 为什么用"过线"而不是"当前比例"：每来一条礼物都报一次进度会刷屏，
 * 而把"从 49% 到 51%"和"从 0 直接跳到 120%"都归成同一次过线，
 * 才不会出现"一条大礼物连喊两声"。
 */

/** 目标上限（电池）。1e9 电池 = 1 亿元，足够拦住手滑多打几个 0 */
export const MAX_GOAL_BATTERY = 1_000_000_000

/** 电池 → 元，不带 ¥ 前缀；整数不带小数点，和战报/榜单一个口径 */
function yuanText(battery) {
  const v = Math.max(0, Number(battery) || 0) / 10
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/**
 * 这一笔礼物越过了哪个里程碑（50 / 100），没越过返回 0。
 *
 * 一条礼物同时越过两档时只报 100：先喊"过半"再喊"达成"会在一秒内连发两条，
 * 而观众看到的本来就是"直接达成了"。
 *
 * @param {number} before 这笔之前的本场礼物电池
 * @param {number} after  这笔之后的本场礼物电池
 * @param {number} goal   目标电池，0 = 关闭
 * @returns {0|50|100}
 */
export function goalMilestone(before, after, goal) {
  const g = Number(goal) || 0
  const b = Number(before) || 0
  const a = Number(after) || 0
  if (g <= 0 || a <= b) return 0

  if (b < g && a >= g) return 100
  if (b < g / 2 && a >= g / 2) return 50
  return 0
}

/**
 * 过线播报文案。尽量短：弹幕是公共频道，一句话说完比一段话更容易被看见。
 *
 * @param {50|100} milestone
 * @param {number} after 过线时的本场礼物电池
 * @param {number} goal  目标电池
 */
export function goalText(milestone, after, goal) {
  const target = yuanText(goal)
  if (milestone === 100) return `礼物目标达成！¥${target}`
  return `目标过半：¥${yuanText(after)}/¥${target}`
}
