/**
 * 对账：拿日志算一遍，拿投影算一遍，两边对上才算数。
 *
 * 为什么必须存在（决策记录 D2 的推论）：
 * 二代统计出错不报错 —— 直播中重启，30 秒后 `_persistSession` 用 0 覆盖了
 * lastSession，全程静默。用户三天后才发现"那场礼物没算上"。
 *
 * 对账的作用不是修复，是**让错误当场可见**。
 *
 * 实现上刻意不复用 Projection 的累加代码：
 * Projection 是「边遍历边加」，这里先**按类型分组、再分组求和**。
 * 两条路径独立，才能抓到"某类事件漏处理"或"字段名读错"这类问题。
 * 如果两边共用同一段代码，它只能证明代码自己和自己一致。
 */

import { sumByType } from './sum.mjs'

const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol

/**
 * 从 sessionId 解析场次起点 seq。
 *
 * 场次 id 的两种形态都编码了起点：
 *   s123         → 收到 LIVE_START，那条事件的 seq 是 123
 *   implicit-45  → 没有 LIVE_START，第 45 条事件触发建场
 *
 * 有了起点就能独立重算"这一场"的数字，而不是只对得上总累计。
 */
function sessionStartSeq(sessionId) {
  const m = /^(?:s|implicit-)(\d+)$/.exec(String(sessionId ?? ''))
  return m ? Number(m[1]) : 0
}

/**
 * @param {object} input
 * @param {Array} input.events      从日志读出的全部事件
 * @param {object} input.snapshot   Projection.snapshot()
 * @param {object} [input.logStats] EventLog.stats()
 * @param {number} [input.tolerance] 数值比较容差
 * @returns {{ok: boolean, checks: Array, diffs: Array, summary: object}}
 */
export function reconcile({ events, snapshot, logStats = null, tolerance = 1e-6 }) {
  const checks = []
  const add = (name, expected, actual, note = '') => {
    const pass =
      typeof expected === 'number' && typeof actual === 'number'
        ? near(expected, actual, tolerance)
        : expected === actual
    checks.push({ name, expected, actual, pass, note })
  }

  const exp = sumByType(events)
  const g = snapshot.grand ?? {}

  // ── 第一层：日志本身是否自洽 ──────────────────────────────
  const seqs = events.map((e) => e.seq)
  const dupSeq = seqs.length - new Set(seqs).size
  add('序号无重复', 0, dupSeq, dupSeq ? '同一 seq 出现多次，可能重复写入' : '')

  /**
   * 求 min/max 用循环而不是 `Math.min(...seqs)`。
   *
   * 展开运算符会把整个数组变成实参，几万个元素就够把调用栈撑爆
   * （`RangeError: Maximum call stack size exceeded`）。而日志是 append-only 的，
   * 条数只会一直涨 —— 这不是"也许有一天"，是"某一天必然"。
   * 那种报错还特别难归类：表现为"点对账没反应"，而不是"对账失败"。
   */
  let minSeq = 0
  let maxSeq = 0
  for (const s of seqs) {
    if (!minSeq || s < minSeq) minSeq = s
    if (s > maxSeq) maxSeq = s
  }
  const spanCount = seqs.length ? maxSeq - minSeq + 1 : 0
  add('序号连续', spanCount, seqs.length, '缺口说明有事件丢失')

  add('末条序号一致', maxSeq, snapshot.lastSeq ?? 0)

  add(
    '事件条数一致',
    events.length,
    (snapshot.grand?.events ?? Object.values(snapshot.eventsByType ?? {}).reduce((a, b) => a + b, 0)),
  )

  // ── 第二层：分类条数 ─────────────────────────────────────
  const types = new Set([...Object.keys(exp.types), ...Object.keys(snapshot.eventsByType ?? {})])
  for (const t of types) {
    add(`事件条数 · ${t}`, exp.types[t] ?? 0, snapshot.eventsByType?.[t] ?? 0)
  }

  // ── 第三层：业务数字 ─────────────────────────────────────
  add('弹幕累计', exp.danmaku, g.danmaku ?? 0)
  add('礼物个数累计', exp.giftCount, g.giftCount ?? 0)
  add('礼物电池累计', exp.giftBattery, g.giftBattery ?? 0)
  add('舰长个数累计', exp.guardCount, g.guardCount ?? 0)
  add('舰长电池累计', exp.guardBattery, g.guardBattery ?? 0)
  add('醒目留言条数累计', exp.scCount, g.scCount ?? 0)
  add('醒目留言电池累计', exp.scBattery, g.scBattery ?? 0)
  add('进场累计', exp.enterCount, g.enterCount ?? 0)

  // ── 第三层半：当前场 ─────────────────────────────────────
  // 只对总累计是不够的：一场内部算错（场次边界划错、两场被合并）
  // 时总累计照样对得上，错误全藏在"本场数字"里。
  const startSeq = sessionStartSeq(snapshot.sessionId)
  if (startSeq > 0) {
    const inSession = events.filter((e) => e.seq >= startSeq)
    const se = sumByType(inSession)
    add('本场弹幕', se.danmaku, snapshot.danmaku ?? 0, '从场次起点 seq 独立重算')
    add('本场礼物个数', se.giftCount, snapshot.giftCount ?? 0)
    add('本场礼物电池', se.giftBattery, snapshot.giftBattery ?? 0)
    add('本场舰长个数', se.guardCount, snapshot.guardCount ?? 0)
    add('本场舰长电池', se.guardBattery, snapshot.guardBattery ?? 0)
    add('本场醒目留言条数', se.scCount, snapshot.scCount ?? 0)
    add('本场醒目留言电池', se.scBattery, snapshot.scBattery ?? 0)
    add('本场进场', se.enterCount, snapshot.enterCount ?? 0)
  }

  // ── 第四层：磁盘层面 ─────────────────────────────────────
  if (logStats) {
    add('日志坏行数', 0, logStats.badLines ?? 0, '坏行通常是进程被杀导致半行写入')
    add('日志末序号一致', logStats.lastSeq ?? 0, maxSeq)
  }

  const diffs = checks.filter((c) => !c.pass)
  return {
    ok: diffs.length === 0,
    checks,
    diffs,
    summary: {
      total: checks.length,
      passed: checks.length - diffs.length,
      failed: diffs.length,
      events: events.length,
      lastSeq: maxSeq,
      expected: exp,
    },
  }
}

/** 人类可读报告，给 CLI / 自检用。 */
export function formatReport(result) {
  const lines = []
  for (const c of result.checks) {
    if (c.pass) continue
    const note = c.note ? `  (${c.note})` : ''
    lines.push(`  FAIL  ${c.name}  期望 ${c.expected}  实际 ${c.actual}${note}`)
  }
  const { total, passed, failed } = result.summary
  lines.push(`  对账: ${total} 项，通过 ${passed}，失败 ${failed}`)
  return lines.join('\n')
}

export default reconcile
