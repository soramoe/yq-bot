import test from 'node:test'
import assert from 'node:assert/strict'

import { pickHighlights } from '../../web/views/highlights.js'

const T0 = Date.parse('2026-11-05T20:00:00+08:00')
const gift = (ts, battery, uname = '甲') => ({
  seq: 1,
  ts,
  type: 'GIFT',
  uname,
  text: '辣条',
  num: 1,
  battery,
  guardLevel: 0,
})
const sc = (ts, battery, uname = '乙') => ({
  seq: 2,
  ts,
  type: 'SUPER_CHAT',
  uname,
  text: '加油',
  num: 1,
  battery,
  guardLevel: 0,
})
const guard = (ts, battery, uname = '丙') => ({
  seq: 3,
  ts,
  type: 'GUARD_BUY',
  uname,
  text: '舰长',
  num: 1,
  battery,
  guardLevel: 3,
})

const frames = (...deltas) =>
  deltas.map((d, i) => ({ t: T0 + (i + 1) * 60_000, danmakuDelta: d }))

test('高光：SC > 舰长 > 礼物，按分数挑', () => {
  const out = pickHighlights(
    [
      gift(T0 + 60_000, 500),
      guard(T0 + 120_000, 200),
      sc(T0 + 180_000, 100),
    ],
    [],
  )
  assert.deepEqual(out.map((m) => m.type), ['GIFT', 'GUARD_BUY', 'SUPER_CHAT'])
  assert.ok(out[2].score > out[1].score)
  assert.ok(out[1].score > out[0].score)
})

test('高光：免费礼物不算钱，不进榜', () => {
  const out = pickHighlights([gift(T0 + 60_000, 0)], [])
  assert.equal(out.length, 0, 'battery 为 0 的礼物不该占高光位置')
})

test('高光：弹幕高峰只取最密的两格，且分数低于花钱事件', () => {
  const out = pickHighlights(
    [gift(T0 + 30_000, 100)],
    frames(15, 30, 20, 5),
  )
  const peaks = out.filter((m) => m.type === 'PEAK')
  assert.equal(peaks.length, 2)
  assert.deepEqual(peaks.map((m) => m.count).sort((a, b) => b - a), [30, 20])
  assert.ok(out[0].type === 'GIFT', '礼物要排在弹幕高峰前面')
})

test('高光：结果按时间升序，剪辑时从头往后看', () => {
  const out = pickHighlights(
    [sc(T0 + 300_000, 100), gift(T0 + 60_000, 500), guard(T0 + 180_000, 200)],
    [],
  )
  const ts = out.map((m) => m.ts)
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b))
})

test('高光：max 夹在 1..30，默认 12', () => {
  const marks = Array.from({ length: 40 }, (_, i) => gift(T0 + i * 1000, 100 + i))
  assert.equal(pickHighlights(marks, [], { max: 5 }).length, 5)
  assert.equal(pickHighlights(marks, [], { max: 0 }).length, 1)
  assert.equal(pickHighlights(marks, [], { max: 999 }).length, 30)
  assert.equal(pickHighlights(marks, []).length, 12)
})

test('高光：空数据、坏时间不抛也不出', () => {
  assert.deepEqual(pickHighlights([], []), [])
  assert.deepEqual(pickHighlights(null, null), [])
  const out = pickHighlights(
    [{ type: 'GIFT', ts: 'nope', battery: 100 }, { type: 'GIFT', ts: 0, battery: 100 }],
    [{ t: 0, danmakuDelta: 99 }],
  )
  assert.equal(out.length, 0, '时间不合法的高光没有落点，不能显示')
})
