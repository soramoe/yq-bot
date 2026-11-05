/**
 * 身份展示：把事件载荷里的"这个人是谁"翻成模板变量。
 *
 * 单独一个文件，是因为这是**唯一需要知道 B站 数据形状**的地方。
 * 模板怎么写、冷却怎么算、发不发得出去，都和粉丝牌的字段无关；
 * 把它们混在一起，改一次模板就得在一堆业务逻辑里找变量组装的那几行。
 *
 * 两条硬规则（都来自二代的真实事故）：
 *
 * 1. **空值给空串，绝不给 undefined。**
 *    模板引擎会把 undefined 原样塞进文案，于是弹幕里出现
 *    「欢迎 用户名（undefined 的粉丝牌）」。空串至少不会被人看见。
 *
 * 2. **粉丝牌的名字和等级可能有一个没一个。**
 *    只改过粉丝牌没送过礼的人，`medal.name` 有、`medal.level` 可能是 0；
 *    刚上舰的人有 `guardLevel` 但没有粉丝牌。所以两段各判各的。
 */

import { GUARD_NAME } from '../../server/core/events.mjs'

/**
 * @param {object} payload 规范化后的事件载荷
 * @returns {{用户:string, 粉丝牌:string, 舰长:string}}
 */
export function honorVars(payload = {}) {
  const p = payload ?? {}

  // 粉丝牌：名字在就显示，等级是 0 或缺失就不带 —— "小渔" 比 "小渔undefined" 强
  const medal = p.medal
  const medalText =
    medal && medal.name ? `${medal.name}${medal.level ? medal.level : ''}` : ''

  const guardLevel = Number(p.guardLevel) || 0
  const guardText = guardLevel ? GUARD_NAME[guardLevel] ?? '' : ''

  return {
    用户: String(p.uname ?? ''),
    粉丝牌: medalText,
    舰长: guardText,
  }
}

/** 有没有名字可以称呼。没有名字就不是这个插件该管的事 */
export function nameOf(payload = {}) {
  return String(payload?.uname ?? '').trim()
}
