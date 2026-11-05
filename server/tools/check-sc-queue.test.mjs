/**
 * 醒目留言待读队列自检。
 *
 * 这一层最怕"看起来正常"：金额差十倍、旧 SC 只有元没有电池、
 * 或者窗口边界少算一条，页面上都没人看得出来 —— 只有主播回头找 SC 时
 * 才发现少了一句。所以这里把金额口径和窗口边界都钉死。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_QUEUE_ITEMS, MAX_READ_IDS, buildScQueue } from '../core/sc-queue.mjs'

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const sc = (seq, payload, ts = NOW, extra = {}) => ({
  seq,
  ts,
  type: 'SUPER_CHAT',
  payload,
  ...extra,
})

test('只收 SC：其它事件一条都不进队列', () => {
  const out = buildScQueue(
    [
      sc(1, { uid: '1', uname: '甲', text: '你好', yuan: 30 }),
      { seq: 2, ts: NOW, type: 'GIFT', payload: { uid: '2', battery: 9_999 } },
      { seq: 3, ts: NOW, type: 'DANMAKU', payload: { text: '路过' } },
    ],
    { days: 0, now: NOW },
  )
  assert.equal(out.items.length, 1)
  assert.equal(out.scanned, 1)
  assert.equal(out.items[0].text, '你好')
})

test('金额口径：优先 battery；旧日志只有 yuan 时按 1 元 = 10 电池', () => {
  const out = buildScQueue(
    [
      sc(1, { uid: '1', uname: '甲', yuan: 30 }),
      sc(2, { uid: '2', uname: '乙', yuan: 50, battery: 500 }),
      sc(3, { uid: '3', uname: '丙', battery: 0 }),
    ],
    { days: 0, now: NOW },
  )
  const bySeq = new Map(out.items.map((it) => [it.seq, it]))
  assert.equal(bySeq.get(1).battery, 300)
  assert.equal(bySeq.get(1).money, '¥30')
  assert.equal(bySeq.get(2).battery, 500, '有精确电池价时不能被 yuan 覆盖')
  assert.equal(bySeq.get(2).money, '¥50')
  assert.equal(bySeq.get(3).battery, 0)
  assert.equal(bySeq.get(3).money, '¥0')
})

test('排序：新的在前，同一毫秒按 seq 倒序', () => {
  const out = buildScQueue(
    [
      sc(1, { uid: '1', uname: '旧' }, NOW - 1_000),
      sc(3, { uid: '3', uname: '同刻后' }, NOW),
      sc(2, { uid: '2', uname: '同刻前' }, NOW),
    ],
    { days: 0, now: NOW },
  )
  assert.deepEqual(
    out.items.map((it) => it.seq),
    [3, 2, 1],
  )
})

test('窗口：days=7 只留窗口内；days=0 表示全部；from/to 如实返回', () => {
  const evs = [
    sc(1, { uid: '1', uname: '旧' }, NOW - 8 * DAY),
    sc(2, { uid: '2', uname: '新' }, NOW - 1 * DAY),
  ]
  const week = buildScQueue(evs, { days: 7, now: NOW })
  assert.deepEqual(week.items.map((it) => it.seq), [2])
  assert.equal(week.days, 7)
  assert.equal(week.from, NOW - 7 * DAY)
  assert.equal(week.to, NOW)

  const all = buildScQueue(evs, { days: 0, now: NOW })
  assert.deepEqual(all.items.map((it) => it.seq), [2, 1])
  assert.equal(all.from, 0)
})

test('已读：按 id 标记，id 缺省时由 roomId + seq 生成；unread 只数列表里的', () => {
  const out = buildScQueue(
    [
      sc(1, { uid: '1', uname: '甲' }, NOW, { id: 'e100-1' }),
      sc(2, { uid: '2', uname: '乙' }, NOW - 1, { roomId: '100' }),
    ],
    { days: 0, now: NOW, readIds: new Set(['e100-1']) },
  )
  const bySeq = new Map(out.items.map((it) => [it.seq, it]))
  assert.equal(bySeq.get(1).read, true)
  assert.equal(bySeq.get(2).id, 'e100-2', '没有 id 的旧日志也要能稳定标记')
  assert.equal(bySeq.get(2).read, false)
  assert.equal(out.unread, 1)
})

test('名字：uname 空白时回落 name；都没有时给 uid 或匿名', () => {
  const out = buildScQueue(
    [
      sc(1, { uid: '8', uname: '  ', name: '乙' }),
      sc(2, { uid: '9' }),
      sc(3, {}),
    ],
    { days: 0, now: NOW },
  )
  const bySeq = new Map(out.items.map((it) => [it.seq, it]))
  assert.equal(bySeq.get(1).name, '乙')
  assert.equal(bySeq.get(2).name, 'uid 9')
  assert.equal(bySeq.get(3).name, '匿名观众')
})

test('截断：max 无效时退回默认，最多 MAX_QUEUE_ITEMS 条，scanned 仍报真实数', () => {
  const evs = Array.from({ length: MAX_QUEUE_ITEMS + 3 }, (_, i) =>
    sc(i + 1, { uid: String(i), uname: `人${i}` }, NOW - i),
  )
  const out = buildScQueue(evs, { days: 0, now: NOW, max: 10_000 })
  assert.equal(out.items.length, MAX_QUEUE_ITEMS, '一次不能把几千条全塞给页面')
  assert.equal(out.scanned, MAX_QUEUE_ITEMS + 3)

  const small = buildScQueue(evs, { days: 0, now: NOW, max: 2 })
  assert.equal(small.items.length, 2)
  assert.equal(small.unread, 2)
  assert.equal(MAX_READ_IDS, 5000)
})

test('异常输入：不是数组、缺 payload、seq/ts 坏掉都不能抛', () => {
  assert.doesNotThrow(() => buildScQueue(null, { now: NOW }))
  const out = buildScQueue(
    [
      null,
      {},
      sc('x', { uid: '1' }),
      sc(1, null),
      { seq: 2, ts: NOW, type: 'SUPER_CHAT' },
      sc(3, { uid: '3', uname: '丙' }, 0),
      sc(4, { uid: '4', uname: '丁', yuan: 10 }, NOW),
    ],
    { days: 30, now: NOW },
  )
  assert.equal(out.items.length, 1, '坏条目跳过，好条目照常进来')
  assert.equal(out.items[0].name, '丁')
})
