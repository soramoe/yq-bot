/**
 * 长期观众簿自检。
 *
 * 这一组用例最要紧的不是"功能跑通了"，而是**三处曾经写错的地方不能再错回去**：
 *
 *   1. prune 用「精确时间戳」剪内存、却用「日期」删分片 —— 两边尺子不一样，
 *      重启前后同一个人的待遇会突然改变，且不报错。
 *   2. 到 maxPeople 上限时只跳过写盘、却照样往内存里塞人 —— 上限形同虚设。
 *   3. 写盘失败后按内存里的时间判「同一天」，于是今天剩下的来访全都不再重试。
 *
 * 每条都配了反向验证：把实现改回旧写法，对应断言必须失败。
 * 时间全部用固定值，不依赖"今天"是几号。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Roster } from '../core/roster.mjs'
import { dayKey } from '../core/event-log.mjs'
import { classifyVisit } from '../../plugins/welcome/greet.mjs'

const DAY = 86_400_000
const ROOM = '1901584685'

/** UTC 04:00 = 本地 12:00。减几个小时也不会跨天，方便造"当天但更早"的记录 */
const T0 = Date.UTC(2026, 9, 1, 4, 0, 0)

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yy3-roster-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

const shardPath = (dir, ts) => join(dir, 'roster', ROOM, `${dayKey(ts)}.jsonl`)

function writeShard(dir, ts, recs) {
  mkdirSync(join(dir, 'roster', ROOM), { recursive: true })
  writeFileSync(shardPath(dir, ts), recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

/* ══════════════════ 记账语义 ══════════════════ */

test('观众簿：第一次来是陌生人，同一天再来只更新内存、不重复写盘', async (t) => {
  const dir = tmp(t)
  const r = new Roster({ dataDir: dir, roomId: ROOM })
  await r.load()

  const a = r.mark(1001, '小明', T0)
  assert.equal(a.isFirstEver, true)
  assert.equal(a.previousSeenAt, 0)
  assert.equal(a.daysSince, Infinity)
  assert.equal(a.recorded, true)

  const b = r.mark(1001, '小明', T0 + 3600_000)
  assert.equal(b.isFirstEver, false)
  assert.equal(b.previousSeenAt, T0, '返回的是「来之前」的时间，不是更新后的')
  assert.ok(Math.abs(b.daysSince - 3600_000 / DAY) < 1e-9)
  assert.equal(b.recorded, false, '同一天只写一行')

  const lines = readFileSync(shardPath(dir, T0), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), { u: '1001', n: '小明', t: T0 })
  assert.equal(r.size, 1)
})

test('观众簿：跨天再来写新分片，名字也更新成最新的', async (t) => {
  const dir = tmp(t)
  const r = new Roster({ dataDir: dir, roomId: ROOM })
  await r.load()

  r.mark(1001, '小明', T0)
  const v = r.mark(1001, '小明改了名', T0 + DAY)

  assert.equal(v.previousSeenAt, T0)
  assert.equal(v.recorded, true)
  assert.equal(r.peek(1001).name, '小明改了名')
  assert.equal(existsSync(shardPath(dir, T0)), true)
  assert.equal(existsSync(shardPath(dir, T0 + DAY)), true)
  assert.equal(r.brief().days, 2)
})

test('观众簿：重启后从分片重建，同一人跨多片只取最新那条', async (t) => {
  const dir = tmp(t)
  const r1 = new Roster({ dataDir: dir, roomId: ROOM })
  await r1.load()
  r1.mark(1001, '旧名', T0)
  r1.mark(1001, '新名', T0 + DAY)
  r1.mark(2002, '乙', T0 + DAY)

  const r2 = new Roster({ dataDir: dir, roomId: ROOM })
  await r2.load()
  assert.equal(r2.size, 2)
  assert.equal(r2.peek(1001).lastSeenAt, T0 + DAY, '不能取到早的那个分片')
  assert.equal(r2.peek(1001).name, '新名')
  // 「上一次」必须从相邻分片里接回来：否则重启之后，弹幕指令 `#我来过`
  // 会对一个常来的老观众说"第一次见你呀"
  assert.equal(r2.peek(1001).previousSeenAt, T0, '重启后 previousSeenAt 要接着上一次，不能清零')
  assert.equal(r2.peek(2002).previousSeenAt, 0, '只来过一次的人没有「上一次」')

  const v = r2.mark(1001, '', T0 + 2 * DAY)
  assert.equal(v.isFirstEver, false, '重启不能让老观众失忆')
  assert.equal(v.previousSeenAt, T0 + DAY)
})

test('观众簿：坏行跳过但不影响好行，且统计里报出来', async (t) => {
  const dir = tmp(t)
  mkdirSync(join(dir, 'roster', ROOM), { recursive: true })
  // 故意手写的三行坏数据 + 一行好数据
  const bad = [
    '{这不是 json',
    JSON.stringify({ u: '', n: '空 uid', t: T0 }),
    JSON.stringify({ u: '缺时间' }),
  ]
  writeFileSync(
    shardPath(dir, T0),
    [...bad, JSON.stringify({ u: 'ok', n: '正常', t: T0 })].join('\n') + '\n',
    'utf8',
  )

  const r = new Roster({ dataDir: dir, roomId: ROOM })
  await r.load()
  assert.equal(r.size, 1)
  assert.equal(r.peek('ok').name, '正常')
  assert.equal(r.stats().badLines, 3)
})

test('观众簿：匿名观众（uid 为空或 0）不记，也不算新人', async (t) => {
  const dir = tmp(t)
  const r = new Roster({ dataDir: dir, roomId: ROOM })
  await r.load()

  for (const uid of [0, '0', '', null, undefined]) {
    const v = r.mark(uid, '匿名', T0)
    assert.equal(v.recorded, false)
    assert.equal(v.isFirstEver, false, '匿名不该被当成"第一次来"特殊对待')
  }
  assert.equal(r.size, 0)
  assert.equal(existsSync(join(dir, 'roster', ROOM, `${dayKey(T0)}.jsonl`)), false)
})

test('观众簿：roomId 会拼进路径，必须挡住目录穿越；沙盒内存版不受此限', (t) => {
  const dir = tmp(t)
  assert.throws(() => new Roster({ dataDir: dir, roomId: '../escape' }), /非法 roomId/)
  assert.throws(() => new Roster({ dataDir: dir, roomId: '123/456' }), /非法 roomId/)
  // 沙盒用的是内存版，roomId 只是冷却 key 的一部分，不落盘
  assert.doesNotThrow(() => new Roster({ dataDir: '', roomId: 'sandbox:replay', persist: false }))
})

/* ══════════════════ 三处反向验证 ══════════════════ */

test('反向验证：prune 的磁盘与内存必须用同一把尺子（按天，不按时间戳）', async (t) => {
  const dir = tmp(t)
  const now = T0 + 9 * DAY
  const cutoffTs = now - 2 * DAY
  const earlyTs = cutoffTs - 4 * 3600_000 // 当天，但早于 cutoffTs
  const oldTs = cutoffTs - 2 * DAY

  assert.equal(dayKey(earlyTs), dayKey(cutoffTs), '前提：early 与 cutoff 是同一天')
  assert.ok(dayKey(oldTs) < dayKey(cutoffTs), '前提：old 在更早的分片里')

  // 手工造三个分片，绕开 mark() 才能精确控制时间戳
  writeShard(dir, oldTs, [{ u: 'old', n: '老', t: oldTs }])
  writeShard(dir, earlyTs, [{ u: 'early', n: '临界', t: earlyTs }])
  writeShard(dir, now, [{ u: 'new', n: '新人', t: now }])

  const r = new Roster({ dataDir: dir, roomId: ROOM, keepDays: 2 })
  await r.load()
  assert.equal(r.size, 3)

  const cut = r.prune(now)
  assert.equal(cut.files, 1, '只删 cutoffDay 之前的分片')
  assert.equal(cut.people, 1)
  assert.equal(r.size, 2)

  // ★ 旧实现用 `rec.ts < cutoffTs` 剪内存，会把 early 删掉，这条断言就会失败。
  //   磁盘上它还在 → 重启后又认识他了 → 行为突变且无报错。
  assert.ok(r.peek('early'), 'cutoffDay 当天早于 cutoffTs 的人，内存里必须还在')
  assert.equal(r.peek('early').lastSeenAt, earlyTs)
  assert.equal(existsSync(shardPath(dir, earlyTs)), true, '磁盘分片也在，两边一致')
  assert.equal(existsSync(shardPath(dir, oldTs)), false)
  assert.equal(r.peek('old'), null)

  // 重启后行为不能变：这是上面那条不一致真正伤人的地方
  const r2 = new Roster({ dataDir: dir, roomId: ROOM, keepDays: 2 })
  await r2.load()
  assert.ok(r2.peek('early'), '重启后还得认识他')
  assert.equal(r2.peek('old'), null)
})

test('反向验证：到 maxPeople 上限后，内存人数不能继续涨', async (t) => {
  const dir = tmp(t)
  const r = new Roster({ dataDir: dir, roomId: ROOM, maxPeople: 2, persist: false })
  await r.load()

  assert.equal(r.mark(1, '甲', T0).recorded, true)
  assert.equal(r.mark(2, '乙', T0).recorded, true)
  assert.equal(r.mark(3, '丙', T0).recorded, false)
  assert.equal(r.mark(4, '丁', T0).recorded, false)

  // ★ 旧实现只跳过写盘、却照样 `this._seen.set(...)`，这里会是 4。
  assert.equal(r.size, 2, '上限是保险丝，不是"不写盘但继续吃内存"')
  assert.equal(r.stats().skipped, 2)
  assert.equal(r.mark(3, '丙', T0 + DAY).isFirstEver, true, '超限的人一直按新观众处理')
  // 老观众仍要能正常更新
  assert.equal(r.mark(1, '甲', T0 + DAY).isFirstEver, false)
  assert.equal(r.size, 2)
})

test('反向验证：写盘失败后，同一天再来必须重试而不是永远跳过', async (t) => {
  const dir = tmp(t)
  const r = new Roster({ dataDir: dir, roomId: ROOM })
  await r.load()

  // 模拟磁盘满：这一次写不进去
  r._append = () => false
  const a = r.mark(1, '甲', T0)
  assert.equal(a.recorded, false)
  assert.equal(r.size, 1, '内存仍记着，免得这一场里被当成两个人')

  // 恢复真实写入
  r._append = Roster.prototype._append.bind(r)
  const b = r.mark(1, '甲', T0 + 3600_000)
  // ★ 旧实现用 `dayKey(previousSeenAt)` 判同天，这次会被当成"已记过"直接跳过，
  //   于是这一天永远补不回来，重启后他又变陌生人。
  assert.equal(b.recorded, true, '写盘失败不能堵住一整天的重试')
  const lines = readFileSync(shardPath(dir, T0), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).u, '1')
})

/* ══════════════════ 沙盒与状态摘要 ══════════════════ */

test('观众簿：persist:false 是纯内存版，绝不创建 data/roster', async (t) => {
  const dir = tmp(t)
  const r = new Roster({ dataDir: dir, roomId: ROOM, persist: false })
  await r.load()

  r.mark(1, '甲', T0)
  r.mark(1, '甲', T0 + DAY)
  assert.equal(r.size, 1)
  assert.equal(r.stats().appended, 2)
  assert.equal(existsSync(join(dir, 'roster')), false, '一个目录都不许建')
  assert.deepEqual(r.prune(T0 + 9 * DAY), { files: 0, people: 0 }, '回放不能按"现在"剪掉历史中段')
  assert.equal(r.brief().people, 1)
})

test('观众簿：brief() 只给人数与天数，不带任何个人名单', async (t) => {
  const dir = tmp(t)
  const r = new Roster({ dataDir: dir, roomId: ROOM, keepDays: 45 })
  await r.load()
  r.mark(1, '甲', T0)
  r.mark(2, '乙', T0)

  const b = r.brief()
  assert.deepEqual(b, { people: 2, days: 1, keepDays: 45 })
  const wire = JSON.stringify(b)
  assert.equal(wire.includes('甲'), false)
  assert.equal(wire.includes('乙'), false)
  assert.equal(wire.includes('uid'), false, '1Hz 通道上不该出现任何个人标识')
})

/* ══════════════════ 老观众分类 ══════════════════ */

const BASE_CFG = { returningMode: 'return', returningDays: 30 }

test('老观众：没有观众簿时一律按新观众，宁可多说一句也不能全场静默', () => {
  assert.equal(classifyVisit(BASE_CFG, null), 'new')
  assert.equal(classifyVisit(BASE_CFG, undefined), 'new')
  assert.equal(classifyVisit(BASE_CFG, { isFirstEver: true, daysSince: Infinity }), 'new')
})

test('老观众：三种模式与 returningDays 的边界', () => {
  const seen = { isFirstEver: false, daysSince: 1 }
  assert.equal(classifyVisit(BASE_CFG, seen), 'return')
  assert.equal(classifyVisit({ ...BASE_CFG, returningMode: 'same' }, seen), 'new')
  assert.equal(classifyVisit({ ...BASE_CFG, returningMode: 'silent' }, seen), 'silent')

  assert.equal(classifyVisit(BASE_CFG, { isFirstEver: false, daysSince: 31 }), 'new')
  assert.equal(classifyVisit(BASE_CFG, { isFirstEver: false, daysSince: 30 }), 'return', '刚好 30 天仍算熟客')
  assert.equal(
    classifyVisit({ ...BASE_CFG, returningDays: 0 }, { isFirstEver: false, daysSince: 9999 }),
    'return',
    '0 表示永远记得',
  )
})

/* ══════════════════ 与沙盒回放的集成 ══════════════════ */

test('沙盒回放：用内存观众簿重放历史事件，第二句要说「欢迎回来」', async (t) => {
  const { replay } = await import('../core/sandbox.mjs')
  const events = [
    { seq: 1, ts: T0, type: 'ENTER', payload: { uid: 1001, uname: '甲', medal: null, guardLevel: 0 } },
    { seq: 2, ts: T0 + DAY, type: 'ENTER', payload: { uid: 1001, uname: '甲', medal: null, guardLevel: 0 } },
  ]

  const res = await replay({
    events,
    pluginsDir: join(process.cwd(), 'plugins'),
    roomId: ROOM,
    // 关掉「本场一次」和冷却，才能看见第二句的分类结果
    configs: { welcome: { oncePerSession: false, cooldownSec: 0 } },
  })

  assert.deepEqual(res.errors, [], '回放不该有插件报错')
  assert.equal(res.fed, 2)
  assert.equal(res.said.length, 2)
  assert.equal(res.said[0].text, '欢迎 甲 来到直播间')
  assert.equal(res.said[1].text, '欢迎回来 甲', '第二次来要认出来')
})

/* ══════════════════ 记账范围：哪些事件进簿子 ══════════════════ */

test('记账范围：低频的在场事件都记，弹幕和点赞不记', async () => {
  const { ROSTER_EVENTS } = await import('../room-runner.mjs')

  // 这几类事件的 payload 里都有 uid + 昵称，也就是"这个人确实在场"的证据。
  // 只记 ENTER 的话，只关注 / 只分享 / 只看舰的人永远进不了簿子 ——
  // 自动打招呼挑人时就会漏掉他们，而且不报任何错。
  for (const type of ['ENTER', 'GIFT', 'FOLLOW', 'SHARE', 'GUARD_BUY', 'SUPER_CHAT']) {
    assert.ok(ROSTER_EVENTS.has(type), `${type} 应该记账`)
  }

  // 弹幕和点赞**故意不记**：它们量大且频繁，每记一次都会把 lastSeenAt
  // 刷成"现在"，于是「多久没来了」这个语义被自己刷没了。
  for (const type of ['DANMAKU', 'LIKE']) {
    assert.equal(ROSTER_EVENTS.has(type), false, `${type} 太频繁，会把 lastSeenAt 刷成"刚来过"`)
  }

  // 这几类没有 uid，记不了也不该记
  for (const type of ['ONLINE_COUNT', 'LIVE_START', 'LIVE_END', 'SENT']) {
    assert.equal(ROSTER_EVENTS.has(type), false, `${type} 没有 uid，不该记账`)
  }

  // 集合里混进 undefined 几乎都是 `EVENT.XXX` 写错了常量名
  // （比如把 SUPER_CHAT 写成 SC）—— 那样只记账会静默少一类，不会报错
  assert.equal([...ROSTER_EVENTS].some((x) => x === undefined), false, 'ROSTER_EVENTS 里有 undefined，多半是事件常量名写错')
})
