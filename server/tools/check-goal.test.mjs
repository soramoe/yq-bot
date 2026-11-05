/**
 * 本场礼物目标自检。
 *
 * 这个功能最容易错在**边界**：刚好越过某一档、一条礼物同时越过几档、
 * 以及同一场重复事件再喊一遍。数字看起来都正常，只有听弹幕的人会发现
 * "目标过半喊了两次"或者"该喊的时候没声"。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { GOAL_TIERS, MAX_GOAL_BATTERY, goalMilestone, goalText } from '../core/goal.mjs'

/* ══════════════════ 过线判断 ══════════════════ */

test('过线：默认四档 30 / 60 / 80 / 100，刚好压线才算过', () => {
  assert.deepEqual([...GOAL_TIERS], [30, 60, 80, 100])
  assert.equal(goalMilestone(0, 2999, 10000), 0)
  assert.equal(goalMilestone(0, 3000, 10000), 30)
  assert.equal(goalMilestone(3000, 5999, 10000), 0, '过了 30% 但没到 60%，不重复喊')
  assert.equal(goalMilestone(3000, 6000, 10000), 60)
  assert.equal(goalMilestone(0, 8000, 10000), 80)
  assert.equal(goalMilestone(9999, 10000, 10000), 100)
})

test('过线：一条礼物同时越过几档，只报最高的那档', () => {
  assert.equal(goalMilestone(0, 12000, 10000), 100)
  assert.equal(goalMilestone(2900, 7000, 10000), 60)
  assert.equal(goalMilestone(0, 3100, 10000), 30)
})

test('过线：可以传入自定义档位（给测试和将来留口子）', () => {
  assert.equal(goalMilestone(0, 5000, 10000, [50]), 50)
  assert.equal(goalMilestone(0, 5000, 10000, [50, 75]), 50)
  assert.equal(goalMilestone(0, 5000, 10000, []), 0)
})

test('过线：金额没涨、目标为 0、目标为负都不响', () => {
  assert.equal(goalMilestone(5000, 5000, 10000), 0)
  assert.equal(goalMilestone(6000, 5000, 10000), 0)
  assert.equal(goalMilestone(0, 10000, 0), 0)
  assert.equal(goalMilestone(0, 10000, -1), 0)
})

test('过线：目标上限是 10 亿电池（1 亿元）', () => {
  assert.equal(MAX_GOAL_BATTERY, 1_000_000_000)
})

/* ══════════════════ 文案 ══════════════════ */

test('文案：中间档带档位、当前值与目标值，达成只报目标', () => {
  assert.equal(goalText(30, 3000, 10000), '礼物目标到 30% 啦：¥300/¥1000')
  assert.equal(goalText(60, 6100, 10000), '礼物目标到 60% 啦：¥610/¥1000')
  assert.equal(goalText(100, 12000, 10000), '礼物目标达成！¥1000')
})

test('文案：元换算保留一位小数，整数不带 .0', () => {
  assert.equal(goalText(30, 3005, 9990), '礼物目标到 30% 啦：¥300.5/¥999')
  assert.equal(goalText(100, 9990, 9990), '礼物目标达成！¥999')
})

test('文案：自定义文案支持 {当前} / {目标} / {百分比} 占位符', () => {
  assert.equal(
    goalText(60, 6100, 10000, '老板大气！{当前}/{目标}（{百分比}%）'),
    '老板大气！¥610/¥1000（60%）',
  )
  assert.equal(goalText(100, 12000, 10000, '  达成啦  '), '达成啦')
  assert.equal(goalText(30, 3000, 10000, ''), '礼物目标到 30% 啦：¥300/¥1000')
})
