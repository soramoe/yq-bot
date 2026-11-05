/**
 * 场后战报。
 *
 * 全部数字都来自**日志重放**，没有一处读内存里的实时统计 ——
 * 这是"日志是事实，统计是投影"最直接的兑现方式：
 * 战报可以在服务没运行时算、可以对三个月前那场算、可以算出和当时一模一样的数。
 *
 * 为什么不复用线上那个 Projection 实例：
 * 它只保留"当前场"和已封存的场次，而一个进程重启后 sessions 就没了。
 * 战报必须是**从日志独立算出来**的，否则"重启后战报变少"这种事会反复发生。
 */

import { Projection, summarizeSession } from './projection.mjs'
import { dayKey } from './event-log.mjs'

/**
 * 从事件列表算出全部场次，**新的在前**。
 *
 * @param {object[]} events 已按 seq 升序的事件
 * @param {{roomId?:string, now?:number}} [opts]
 * @returns {object[]}
 */
export function buildReports(events, { roomId = '', now = Date.now() } = {}) {
  const proj = new Projection(roomId)
  proj.applyAll(events)

  const list = proj.listSessions()
  // 进行中的那一场不在 sessions 里（只有关闭时才封存），但用户最想看的
  // 恰恰是"现在这场打到多少了" —— 所以补在最后，然后一起倒序。
  if (proj.session && !proj.session.closed) {
    list.push(summarizeSession(proj.session, now))
  }

  return list.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * 战报的可信度审计：指出哪些数字来自**已知有偏差**的历史数据。
 *
 * 背景：`SUPER_CHAT` 的金额曾经算错过两次（先是把元当金瓜子，差 1000 倍；
 * 修到一半时又差 10 倍），最终改成读报文自带的 `rate` 才对。
 * 日志是 append-only 的，**错误的历史数据永远留在那里**，不会被改写 ——
 * 这是对的（改事实日志比留下错误更危险），但战报必须把这件事说出来。
 *
 * 否则用户看到"2 条醒目留言，共 0.1 元"只会得出一个结论：这软件算错了。
 *
 * 判据：新版 SC 载荷一定带 `yuan` 字段，旧版没有。
 */
export function auditReports(events) {
  const warnings = []
  let legacySc = 0

  for (const e of events) {
    if (e?.type !== 'SUPER_CHAT') continue
    if (e.payload?.yuan === undefined) legacySc++
  }

  if (legacySc > 0) {
    warnings.push({
      code: 'legacy-sc',
      count: legacySc,
      text: `有 ${legacySc} 条醒目留言由旧版本采集，金额按当时的错误口径记录（偏小），相关场次的收入会偏低`,
    })
  }

  return warnings
}

/**
 * 把战报按「天」聚合成一条序列，给趋势图用。
 *
 * ## 为什么从战报聚合，而不是从原始事件聚合
 *
 * 从事件聚合就要再写一遍"礼物算多少电池、舰长怎么折算、SC 的元怎么变电池"——
 * 那是**第二个真相**，和 `Projection` 那份迟早会分叉（二代就分叉过，
 * 金额差 1000 倍）。这里只做加法，口径全在 `summarizeSession` 里。
 *
 * 代价是图上的粒度只能到"天"，而且**跨零点的那一场算在开场那天**：
 * 22:00 播到 02:00，四个小时的数字都落在前一天。这比"按小时切、
 * 切出来的两半跟哪一场都对不上"要清楚得多，前端也把这句话写在图下面。
 *
 * @param {object[]} reports  `buildReports()` 的结果（新的在前，这里会重排）
 * @param {{maxDays?:number}} [opts] 最多保留多少天（太多柱子看不出东西）
 * @returns {Array<{day:string, sessions:number, durationSec:number, danmaku:number,
 *   enterCount:number, followCount:number, giftCount:number, giftBattery:number,
 *   scCount:number, totalBattery:number}>} 按日期升序
 */
export function buildDailySeries(reports, { maxDays = 60 } = {}) {
  const cap = Math.max(1, Math.min(366, Math.floor(Number(maxDays) || 60)))
  const map = new Map()

  for (const r of reports ?? []) {
    const start = Number(r?.startedAt)
    // 起点未知的场次（implicit）也有 startedAt，只是它不可信；图上照算，
    // 因为"哪天的数据"比"几点开始的"稳得多
    if (!Number.isFinite(start) || start <= 0) continue
    const day = dayKey(start)

    let b = map.get(day)
    if (!b) {
      b = emptyDay(day)
      map.set(day, b)
    }
    b.sessions++
    b.durationSec += Number(r.durationSec) || 0
    b.danmaku += Number(r.danmaku) || 0
    b.enterCount += Number(r.enterCount) || 0
    b.followCount += Number(r.followCount) || 0
    b.giftCount += Number(r.giftCount) || 0
    b.giftBattery += Number(r.giftBattery) || 0
    b.scCount += Number(r.scCount) || 0
    b.totalBattery += Number(r.totalBattery) || 0
  }

  // 日期是 YYYY-MM-DD，定长且补零，所以字符串比较就是时间比较
  const days = [...map.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  return fillGaps(days).slice(-cap)
}

/** 空一天给一个全零的桶 */
function emptyDay(day) {
  return {
    day,
    sessions: 0,
    durationSec: 0,
    danmaku: 0,
    enterCount: 0,
    followCount: 0,
    giftCount: 0,
    giftBattery: 0,
    scCount: 0,
    totalBattery: 0,
  }
}

/**
 * 把没开播的日子补成 0。
 *
 * 不补的话，图上一根柱子挨着一根柱子，看起来像"连着播了 N 天"，
 * 而实际上中间隔了一周 —— 趋势图最不该骗人的就是这一点。
 * 只在**首尾之间**补：范围那两头（"最近 7 天"里今天还没播）由卡片上的
 * 汇总数字交代，不在这里假装知道范围。
 */
function fillGaps(rows) {
  if (rows.length < 2) return rows
  const out = []
  const dayMs = 86_400_000
  for (let i = 0; i < rows.length; i++) {
    out.push(rows[i])
    if (i === rows.length - 1) break
    // 用本地零点做加法：直接 +dayMs 在夏令时切换那天会差一小时从而漏/重一天
    let cur = dayStart(rows[i].day)
    const next = dayStart(rows[i + 1].day)
    let guard = 0
    while (cur + dayMs < next && guard++ < 400) {
      cur += dayMs
      out.push(emptyDay(dayKey(cur)))
    }
  }
  return out
}

/** 'YYYY-MM-DD' → 本地零点时间戳 */
function dayStart(day) {
  const [y, m, d] = String(day).split('-').map((x) => Number.parseInt(x, 10))
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 0
  return new Date(y, m - 1, d).getTime()
}

/**
 * 把一段时间的战报汇总成一行，给"最近 7 天"这类场景用。
 *
 * 隐式场次（进程在直播中途启动）也算进来：它的数字是真的，
 * 只是**时长和起点不可靠**。汇总里总量要算它，时长要标出来由前端提示。
 */
export function summarizeReports(reports) {
  const out = {
    sessions: reports.length,
    implicitSessions: 0,
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
    peakPopularity: 0,
  }
  for (const r of reports) {
    if (r.implicit) out.implicitSessions++
    out.durationSec += r.durationSec
    out.danmaku += r.danmaku
    out.enterCount += r.enterCount
    out.followCount += r.followCount
    out.giftCount += r.giftCount
    out.giftBattery += r.giftBattery
    out.guardCount += r.guardCount
    out.guardBattery += r.guardBattery
    out.scCount += r.scCount
    out.scBattery += r.scBattery
    out.totalBattery += r.totalBattery
    // 峰值不能相加，取最大
    if (r.peakPopularity > out.peakPopularity) out.peakPopularity = r.peakPopularity
  }
  return out
}
