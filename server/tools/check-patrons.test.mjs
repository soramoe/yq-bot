/**
 * 付费用户档案自检。
 *
 * 这里最容易错的是**金额口径**和**窗口**：少算一条旧日志、把免费礼物
 * 算进金额、或者按"最后遍历到的名字"覆盖昵称 —— 页面上都是
 * "看起来正常的数字"，没人会发现。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_BIG_SPEND_BATTERY,
  bigSpendText,
  buildPatrons,
  paidBatteryOf,
  patronNameOf,
} from '../core/patrons.mjs'

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const ev = (seq, type, payload, ts = NOW) => ({ seq, ts, type, payload })

/* ══════════════════ 单笔金额 ══════════════════ */

test('金额：礼物 / 舰长 / SC 都按电池算，免费礼物是 0', () => {
  assert.equal(paidBatteryOf(ev(1, 'GIFT', { battery: 2000, isPaid: true })), 2000)
  assert.equal(paidBatteryOf(ev(1, 'GIFT', { battery: 2000, isPaid: false })), 0, '免费礼物不算钱')
  assert.equal(paidBatteryOf(ev(1, 'GIFT', { num: 3, price: 100 })), 300, '旧日志没有 battery 时按数量×单价')
  assert.equal(paidBatteryOf(ev(1, 'GUARD_BUY', { battery: 1980 })), 1980)
  assert.equal(paidBatteryOf(ev(1, 'GUARD_BUY', { num: 1, price: 1980 })), 1980)
  assert.equal(paidBatteryOf(ev(1, 'SUPER_CHAT', { battery: 500 })), 500)
  assert.equal(paidBatteryOf(ev(1, 'SUPER_CHAT', { yuan: 30 })), 300, '旧 SC 只有元时按 1 元 = 10 电池')
  assert.equal(paidBatteryOf(ev(1, 'DANMAKU', { battery: 999 })), 0, '只有付费事件算付费用户')
})

test('名字：优先 uname，其次 name，两端空白去掉', () => {
  assert.equal(patronNameOf(ev(1, 'GIFT', { uname: ' 甲 ' })), '甲')
  assert.equal(patronNameOf(ev(1, 'GIFT', { name: '乙' })), '乙')
  assert.equal(patronNameOf(ev(1, 'GIFT', { uname: '   ', name: '丙' })), '丙', 'uname 是空白串也要回落')
  assert.equal(patronNameOf(ev(1, 'GIFT', {})), '')
})

/* ══════════════════ 大额文案 ══════════════════ */

test('大额文案：礼物、续费舰长、醒目留言各有各的说法', () => {
  assert.equal(
    bigSpendText(ev(1, 'GIFT', { uname: '甲', giftName: '火箭', battery: 2000 })),
    '甲 送出 火箭（¥200）',
  )
  assert.equal(
    bigSpendText(ev(1, 'GIFT', { uname: '甲', giftName: '辣条', num: 3, battery: 300 })),
    '甲 送出 辣条 ×3（¥30）',
  )
  assert.equal(
    bigSpendText(ev(1, 'GUARD_BUY', { uname: '甲', guardLevel: 3, battery: 1980, isRenew: true })),
    '甲 续费舰长（¥198）',
  )
  assert.equal(
    bigSpendText(ev(1, 'GUARD_BUY', { uname: '甲', guardLevel: 1, battery: 199800 })),
    '甲 开通总督（¥19980）',
  )
  assert.equal(
    bigSpendText(ev(1, 'SUPER_CHAT', { uname: '甲', battery: 500, yuan: 50 })),
    '甲 发来 ¥50 的醒目留言',
  )
  assert.equal(bigSpendText(ev(1, 'GIFT', { uname: '甲', isPaid: false })), '', '0 元不提醒')
  assert.equal(bigSpendText(ev(1, 'DANMAKU', { uname: '甲' })), '')
})

/* ══════════════════ 聚合 ══════════════════ */

test('聚合：按 uid 跨事件合并，金额/次数分开记，昵称取最新', () => {
  const events = [
    ev(1, 'GIFT', { uid: '1', uname: '甲', giftName: '火箭', battery: 1000, isPaid: true }, NOW - 2 * DAY),
    ev(2, 'SUPER_CHAT', { uid: '1', uname: '甲改名', battery: 500 }, NOW - DAY),
    ev(3, 'GUARD_BUY', { uid: '2', uname: '乙', guardLevel: 3, battery: 3000 }, NOW),
    ev(4, 'GIFT', { uid: '3', uname: '丙', battery: 0, isPaid: false }, NOW),
    ev(5, 'GIFT', { uid: '0', uname: '匿名', battery: 9999 }, NOW),
  ]

  const data = buildPatrons(events, { days: 30, now: NOW, limit: 10 })

  assert.equal(data.patrons.length, 2, '免费礼物和匿名 uid 不能进榜')
  assert.equal(data.patrons[0].uid, '2')
  assert.equal(data.patrons[0].rank, 1)
  assert.equal(data.patrons[0].totalBattery, 3000)

  const first = data.patrons[1]
  assert.equal(first.uid, '1')
  assert.equal(first.name, '甲改名', '昵称取时间最新的那条')
  assert.equal(first.totalBattery, 1500)
  assert.equal(first.giftBattery, 1000)
  assert.equal(first.scBattery, 500)
  assert.equal(first.giftCount, 1)
  assert.equal(first.scCount, 1)
  assert.equal(first.firstTs, NOW - 2 * DAY)
  assert.equal(first.lastTs, NOW - DAY)

  assert.equal(data.totals.patrons, 2)
  assert.equal(data.totals.totalBattery, 4500)
  assert.equal(data.totals.giftBattery, 1000)
  assert.equal(data.totals.guardBattery, 3000)
  assert.equal(data.totals.scBattery, 500)
  assert.equal(data.scanned, events.length)
})

test('窗口：days 只收窗口内的；days=0 表示全部', () => {
  const events = [
    ev(1, 'GIFT', { uid: '1', uname: '老', battery: 1000 }, NOW - 40 * DAY),
    ev(2, 'GIFT', { uid: '2', uname: '新', battery: 2000 }, NOW - DAY),
  ]

  const recent = buildPatrons(events, { days: 30, now: NOW })
  assert.deepEqual(recent.patrons.map((p) => p.uid), ['2'])
  assert.equal(recent.totals.totalBattery, 2000)

  const all = buildPatrons(events, { days: 0, now: NOW })
  assert.equal(all.patrons.length, 2)
  assert.equal(all.totals.totalBattery, 3000)
  assert.equal(all.from, 0)
})

test('排序与截断：总额降序，同额时最近出现的在前；limit 夹在 1..200', () => {
  const events = [
    ev(1, 'GIFT', { uid: '1', uname: '甲', battery: 1000 }, NOW - DAY),
    ev(2, 'GIFT', { uid: '2', uname: '乙', battery: 1000 }, NOW),
    ev(3, 'GIFT', { uid: '3', uname: '丙', battery: 2000 }, NOW),
  ]

  const data = buildPatrons(events, { days: 30, now: NOW, limit: 2 })
  assert.deepEqual(data.patrons.map((p) => p.uid), ['3', '2'], '同额时最近出现的在前')
  assert.equal(data.totals.patrons, 3, 'limit 只截榜单，totals 仍是全部')

  assert.equal(buildPatrons([], { limit: 0 }).patrons.length, 0)
  const many = Array.from({ length: 250 }, (_, i) =>
    ev(i + 1, 'GIFT', { uid: String(i + 1), uname: `u${i}`, battery: 10 }),
  )
  assert.equal(buildPatrons(many, { days: 0, limit: 500 }).patrons.length, 200)
})

test('异常输入：不是数组、缺 payload、时间戳坏掉都不能抛', () => {
  assert.doesNotThrow(() => buildPatrons(null, { days: 30 }))
  assert.deepEqual(buildPatrons(null).patrons, [])

  const data = buildPatrons([
    { seq: 1, type: 'GIFT', payload: { uid: '1', battery: 100 } },
    { seq: 2, ts: 'bad', type: 'GIFT', payload: { uid: '1', battery: 100 } },
    null,
  ])
  assert.equal(data.totals.totalBattery, 0, '没有 ts 的事件不能进榜')
  assert.ok(MAX_BIG_SPEND_BATTERY > 0)
})
