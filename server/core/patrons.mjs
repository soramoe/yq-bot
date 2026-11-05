/**
 * 付费用户档案：按 uid 跨场次聚合**付费**贡献。
 *
 * 为什么是重放日志，而不是读线上投影：
 *   - 投影只保留这一场的明细，跨场/跨天看不到；
 *   - 战报（`report.mjs`）已经是"日志是唯一事实"的口径，这里必须同源，
 *     否则两个页面上的"某人的贡献"会对不上，而且谁单独看都正常。
 *
 * 只算礼物 / 舰长 / 醒目留言。免费礼物（银瓜子）计入礼物个数但不计入金额 ——
 * 这与 `Projection.giftBatteryOf` 的口径完全一致（那边是整个项目的金额真相）。
 */

import { EVENT, GUARD_NAME } from './events.mjs'

const PAID_TYPES = new Set([EVENT.GIFT, EVENT.GUARD_BUY, EVENT.SUPER_CHAT])

/** 单次大额提醒的上限。再大就不是"提醒"，而是配置写错了 */
export const MAX_BIG_SPEND_BATTERY = 1_000_000_000

/** 回访提醒的回看窗口：只看这之前来过、且付过钱的 */
export const PATRON_RETURN_DAYS = 90

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 单条事件的付费电池数。兼容没有 battery 字段的旧日志 */
export function paidBatteryOf(ev) {
  const p = ev?.payload ?? {}
  const direct = Number(p.battery)
  const count = Math.max(1, num(p.num, 1))

  switch (ev?.type) {
    case EVENT.GIFT:
      // 免费礼物：个数照记，金额是 0。不能因为"送了东西"就算付费用户
      if (p.isPaid === false) return 0
      if (Number.isFinite(direct)) return Math.max(0, direct)
      return Math.max(0, count * num(p.price))

    case EVENT.GUARD_BUY:
      if (Number.isFinite(direct)) return Math.max(0, direct)
      return Math.max(0, count * num(p.price))

    case EVENT.SUPER_CHAT:
      if (Number.isFinite(direct)) return Math.max(0, direct)
      // 旧日志可能只有 yuan；1 元 = 10 电池
      return Math.max(0, num(p.yuan) * 10)

    default:
      return 0
  }
}

/** 事件里的人名。统一取 `uname`，旧数据没有时再退 `name` */
export function patronNameOf(ev) {
  const p = ev?.payload ?? {}
  const uname = String(p.uname ?? '').trim()
  // uname 是空白串时也要回落：`??` 只挡 null/undefined，挡不住 ''
  if (uname) return uname
  return String(p.name ?? '').trim()
}

/** 电池 → 元。整数不带 .0，其余保留一位（和 notify.reportText 同一口径） */
export function moneyText(batteryValue) {
  const yuan = Number(batteryValue) / 10
  if (!Number.isFinite(yuan)) return '0'
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(1)
}

/**
 * 一条事件对应的"大额"文案（不含 `【大额】` 前缀，由调用方决定怎么显示）。
 * 不是付费事件、或者金额为 0 时返回空串。
 */
export function bigSpendText(ev) {
  const batteryValue = paidBatteryOf(ev)
  if (batteryValue <= 0) return ''

  const p = ev?.payload ?? {}
  const who = patronNameOf(ev) || '有人'
  const money = moneyText(batteryValue)

  switch (ev?.type) {
    case EVENT.GIFT: {
      const count = Math.max(1, num(p.num, 1))
      const gift = String(p.giftName ?? '').trim() || '礼物'
      return `${who} 送出 ${gift}${count > 1 ? ` ×${count}` : ''}（¥${money}）`
    }

    case EVENT.GUARD_BUY: {
      const level = GUARD_NAME[Number(p.guardLevel)] || '大航海'
      const verb = p.isRenew === true ? '续费' : '开通'
      return `${who} ${verb}${level}（¥${money}）`
    }

    case EVENT.SUPER_CHAT:
      return `${who} 发来 ¥${money} 的醒目留言`

    default:
      return ''
  }
}

/**
 * 按 uid 聚合付费贡献。
 *
 * @param {Array<object>} events 事件日志（任意顺序；这里按事件时间取最新名字）
 * @param {{days?:number, now?:number, limit?:number}} [opts]
 *   days=0 表示全部；limit 只截断返回的榜单，totals 始终统计窗口内所有人。
 * @returns {{days:number, from:number, to:number, patrons:Array<object>,
 *   totals:{patrons:number, totalBattery:number, giftBattery:number,
 *   guardBattery:number, scBattery:number, giftCount:number,
 *   guardCount:number, scCount:number}, scanned:number}}
 */
export function buildPatrons(events, { days = 30, now = Date.now(), limit = 30 } = {}) {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0
  const from = safeDays > 0 ? now - safeDays * 86400000 : 0
  const safeLimit = Math.min(200, Math.max(1, Math.floor(num(limit, 30)) || 30))

  const byUid = new Map()

  for (const ev of Array.isArray(events) ? events : []) {
    if (!PAID_TYPES.has(ev?.type)) continue

    const p = ev.payload ?? {}
    const uid = String(p.uid ?? '').trim()
    // 没有 uid 的付费事件没法归到人头上，宁可漏也不能把所有人并成一个"匿名付费用户"
    if (!uid || uid === '0') continue

    const ts = num(ev.ts)
    if (!Number.isFinite(ts) || ts <= 0) continue
    if (from > 0 && ts < from) continue

    const batteryValue = paidBatteryOf(ev)
    if (batteryValue <= 0) continue

    let row = byUid.get(uid)
    if (!row) {
      row = {
        uid,
        name: '',
        totalBattery: 0,
        giftBattery: 0,
        guardBattery: 0,
        scBattery: 0,
        giftCount: 0,
        guardCount: 0,
        scCount: 0,
        firstTs: ts,
        lastTs: 0,
      }
      byUid.set(uid, row)
    }

    row.totalBattery += batteryValue
    row.firstTs = Math.min(row.firstTs, ts)

    if (ev.type === EVENT.GIFT) {
      row.giftBattery += batteryValue
      row.giftCount += Math.max(1, num(p.num, 1))
    } else if (ev.type === EVENT.GUARD_BUY) {
      row.guardBattery += batteryValue
      row.guardCount += Math.max(1, num(p.num, 1))
    } else if (ev.type === EVENT.SUPER_CHAT) {
      row.scBattery += batteryValue
      row.scCount += 1
    }

    const name = patronNameOf(ev)
    // 名字会改。取**时间上最新**的那条，而不是最后遍历到的那条
    if (name && ts >= row.lastTs) row.name = name
    if (ts >= row.lastTs) row.lastTs = ts
  }

  const totals = {
    patrons: byUid.size,
    totalBattery: 0,
    giftBattery: 0,
    guardBattery: 0,
    scBattery: 0,
    giftCount: 0,
    guardCount: 0,
    scCount: 0,
  }
  for (const row of byUid.values()) {
    totals.totalBattery += row.totalBattery
    totals.giftBattery += row.giftBattery
    totals.guardBattery += row.guardBattery
    totals.scBattery += row.scBattery
    totals.giftCount += row.giftCount
    totals.guardCount += row.guardCount
    totals.scCount += row.scCount
  }

  const patrons = [...byUid.values()]
    .sort((a, b) => b.totalBattery - a.totalBattery || b.lastTs - a.lastTs)
    .slice(0, safeLimit)
    .map((row, i) => ({ ...row, rank: i + 1 }))

  return {
    days: safeDays,
    from,
    to: now,
    patrons,
    totals,
    scanned: Array.isArray(events) ? events.length : 0,
  }
}
