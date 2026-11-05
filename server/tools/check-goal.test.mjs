/**
 * 本场礼物目标自检。
 *
 * 这个功能最容易错在**边界**：刚好越过 50%、一条礼物同时越过两档、
 * 以及同一场重复事件再喊一遍。数字看起来都正常，只有听弹幕的人会发现
 * "目标过半喊了两次"或者"该喊的时候没声"。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_GOAL_BATTERY, goalMilestone, goalText } from '../core/goal.mjs'

/* ══════════════════ 过线判断 ══════════════════ */

test('过线：不到 50% 不响，刚好 50% 响 50，刚好 100% 响 100', () => {
  assert.equal(goalMilestone(0, 4999, 10000), 0)
  assert.equal(goalMilestone(0, 5000, 10000), 50)
  assert.equal(goalMilestone(5000, 9999, 10000), 0, '已经过半但没到 100，不重复喊')
  assert.equal(goalMilestone(9999, 10000, 10000), 100)
})

test('过线：一条礼物同时越过两档，只报 100', () => {
  assert.equal(goalMilestone(0, 12000, 10000), 100)
  assert.equal(goalMilestone(4000, 10000, 10000), 100)
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

test('文案：过半带当前值与目标值，达成只报目标', () => {
  assert.equal(goalText(50, 5000, 10000), '目标过半：¥500/¥1000')
  assert.equal(goalText(100, 12000, 10000), '礼物目标达成！¥1000')
})

test('文案：元换算保留一位小数，整数不带 .0', () => {
  assert.equal(goalText(50, 5005, 9990), '目标过半：¥500.5/¥999')
  assert.equal(goalText(100, 9990, 9990), '礼物目标达成！¥999')
})
