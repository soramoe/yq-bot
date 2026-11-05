/**
 * P0 自检：验收标准只有一条 —— **重启后统计误差 = 0**。
 *
 * 这里每一条用例都对应一个真实踩过的坑：
 *   · 重放幂等     ← 二代"补发被限流吃掉 57 条"
 *   · 重启一致     ← 二代"重启丢整场统计"
 *   · 隐式场次     ← 二代"直播中重启接不上本场"
 *   · 两种礼物报文 ← 二代"连击口径新旧不一致"
 *   · 半行容错     ← 进程被杀时最后一行只写一半
 *   · 对账能报错   ← 二代统计静默归零，全程无一行日志
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { EventLog, dayKey } from '../core/event-log.mjs'
import { Projection } from '../core/projection.mjs'
import { RoomStateMachine, EDGE, LIVE, OFFLINE } from '../core/state-machine.mjs'
import { reconcile, formatReport } from '../core/reconcile.mjs'
import { sumByType } from '../core/sum.mjs'

const ROOM = '1901584685'

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yy3-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

/** 造一场：开播 → 若干弹幕 / 礼物 / 进场 → 可选下播 */
function seedSession(log, { danmaku = 0, gifts = [], enters = 0, close = true } = {}) {
  log.append('LIVE_START', { liveStatus: 1 })
  for (let i = 0; i < enters; i++) {
    log.append('ENTER', { uid: 1000 + i, uname: `观众${i}` })
  }
  for (let i = 0; i < danmaku; i++) {
    log.append('DANMAKU', { uid: 2000 + (i % 7), uname: `说${i}`, text: `弹幕${i}` })
  }
  for (const g of gifts) {
    log.append('GIFT', {
      uid: g.uid ?? 3001,
      uname: g.uname ?? '送礼人',
      giftName: g.giftName ?? '小花花',
      num: g.num ?? 1,
      price: g.price ?? 10,
    })
  }
  if (close) log.append('LIVE_END', { liveStatus: 0 })
}

// ─── 1. 日志基本读写 ────────────────────────────────────────
test('事件日志：写入后按 seq 升序读出', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  for (let i = 0; i < 100; i++) log.append('DANMAKU', { uid: i, text: `t${i}` })

  const all = log.readAll()
  assert.equal(all.length, 100)
  assert.equal(all[0].seq, 1)
  assert.equal(all.at(-1).seq, 100)
  assert.deepEqual(
    all.map((e) => e.seq),
    Array.from({ length: 100 }, (_, i) => i + 1),
  )
})

// ─── 2. 重启后 seq 接着涨（不能从 1 重来）───────────────────
test('事件日志：重启后 seq 从断点续上', (t) => {
  const dir = tmp(t)
  const a = new EventLog({ root: dir, roomId: ROOM })
  a.append('DANMAKU', { uid: 1 })
  a.append('DANMAKU', { uid: 2 })
  assert.equal(a.lastSeq, 2)

  const b = new EventLog({ root: dir, roomId: ROOM })
  assert.equal(b.lastSeq, 2, '新建实例必须从磁盘恢复 seq')
  const ev = b.append('DANMAKU', { uid: 3 })
  assert.equal(ev.seq, 3)
})

// ─── 3. 按天分片 ───────────────────────────────────────────
test('事件日志：跨天自动换文件', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  log.append('DANMAKU', {}, { ts: new Date(2026, 10, 1, 23, 30).getTime() })
  log.append('DANMAKU', {}, { ts: new Date(2026, 10, 2, 0, 30).getTime() })

  const files = readdirSync(join(dir, ROOM))
  assert.equal(files.length, 2)
  assert.deepEqual(files.sort(), ['2026-11-01.jsonl', '2026-11-02.jsonl'])
})

// ─── 3b. 日志归档：只压不删，读取必须完全透明 ────────────────
test('归档：只压过期分片，保留窗口内的原件不动', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM, keepDays: 3 })
  const now = new Date(2026, 10, 20, 12).getTime()
  const day = 86400000

  log.append('DANMAKU', { k: 'old' }, { ts: now - 40 * day })
  log.append('DANMAKU', { k: 'mid' }, { ts: now - 10 * day })
  log.append('DANMAKU', { k: 'now' }, { ts: now })

  const res = log.archiveOld({ keepDays: 3, now })
  assert.equal(res.archived.length, 2, '40 天前和 10 天前的都该被归档')

  const files = readdirSync(join(dir, ROOM))
  assert.ok(files.includes(`${dayKey(now)}.jsonl`), '今天的明文必须留着')
  assert.ok(files.includes(`${dayKey(now - 40 * day)}.jsonl.gz`))
  assert.ok(!files.includes(`${dayKey(now - 40 * day)}.jsonl`), '归档后原件必须删除')

  const again = log.archiveOld({ keepDays: 3, now })
  assert.equal(again.archived.length, 0, '已经归档过的不该重复处理')
})

test('归档：读出来的事件与归档前逐条相同（透明解压）', async (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM, keepDays: 3 })
  const now = new Date(2026, 10, 20, 12).getTime()
  const day = 86400000

  for (let i = 0; i < 5; i++) log.append('DANMAKU', { i }, { ts: now - (40 - i) * day })
  log.append('DANMAKU', { i: 5 }, { ts: now })

  const before = log.readAll()
  log.archiveOld({ keepDays: 3, now })

  const sync = log.readAll()
  const streamed = await log.readAllAsync()
  assert.deepEqual(sync, before, '归档不能改变读到的事实')
  assert.deepEqual(streamed, before, '异步路径也必须能读 gz')
  assert.deepEqual(
    sync.map((e) => e.seq),
    [1, 2, 3, 4, 5, 6],
    '跨归档边界也必须按 seq 升序',
  )
})

test('归档：重启后 seq 从归档里续上，不从 1 重来', (t) => {
  const dir = tmp(t)
  const now = new Date(2026, 10, 20, 12).getTime()
  const day = 86400000

  const first = new EventLog({ root: dir, roomId: ROOM, keepDays: 3 })
  for (let i = 0; i < 3; i++) first.append('DANMAKU', { i }, { ts: now - 40 * day })
  first.archiveOld({ keepDays: 3, now })

  // 全部归档，磁盘上没有一行明文 —— 这是最容易返回 0 的路径
  const files = readdirSync(join(dir, ROOM))
  assert.equal(files.filter((f) => f.endsWith('.jsonl')).length, 0)

  const second = new EventLog({ root: dir, roomId: ROOM, keepDays: 3 })
  assert.equal(second.lastSeq, 3, 'seq 必须从归档里续上；返回 0 会让整场统计冻结')

  const ev = second.append('DANMAKU', { after: true })
  assert.equal(ev.seq, 4, '新事件不能与归档里的 seq 撞号')
})

test('归档：keepDays 非法时一条都不动', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  const now = new Date(2026, 10, 20, 12).getTime()
  log.append('DANMAKU', {}, { ts: now - 900 * 86400000 })

  const res = log.archiveOld({ keepDays: 0, now })
  assert.equal(res.archived.length, 0)
  assert.equal(readdirSync(join(dir, ROOM)).length, 1)
})

// ─── 3b. 归档被打断：同一天明文与 .gz 并存，事件不能被读两遍 ──
test('归档：明文与 .gz 并存时按日期去重，不重复读入', async (t) => {
  const dir = tmp(t)
  const ts = Date.now()
  const log = new EventLog({ root: dir, roomId: ROOM })
  log.append('DANMAKU', { uid: 1 }, { ts })
  log.append('DANMAKU', { uid: 2 }, { ts })
  const roomDir = join(dir, ROOM)
  const plain = join(roomDir, `${dayKey(ts)}.jsonl`)

  // 模拟"写完 .gz、删明文之前进程被杀"：两份文件同时存在，内容相同
  const raw = readFileSync(plain)
  writeFileSync(`${plain}.gz`, gzipSync(raw))
  assert.equal(readdirSync(roomDir).length, 2, '前提：两种文件确实并存')

  // 审计实测：修之前这里会读出 4 条（2 条 × 两遍）
  assert.equal(log.readAll().length, 2, '同步读取不能重复')
  assert.equal((await log.readAllAsync()).length, 2, '流式读取不能重复')

  // 去重不是靠"悄悄跳过"，要能在体检数据里看到磁盘上留了两份
  assert.deepEqual(log.stats().duplicateDays, [dayKey(ts)])
  assert.equal(log.stats().files, 1, '去重后只算一个分片')
})

// ─── 4. 半行容错：进程被杀留下的残行不能崩 ──────────────────
test('事件日志：读到半行跳过并计入 badLines', (t) => {
  const dir = tmp(t)
  const ts = Date.now()
  const log = new EventLog({ root: dir, roomId: ROOM })
  log.append('DANMAKU', { uid: 1 }, { ts })
  appendFileSync(join(dir, ROOM, `${dayKey(ts)}.jsonl`), '{"seq":99,"type":"DAN', 'utf8')

  const all = log.readAll()
  assert.equal(all.length, 1, '残行应被跳过')
  assert.equal(log.stats().badLines, 1)
})

// ─── 4b. 流式读取：给 HTTP 用的那条路径必须与同步版事实相同 ──
test('事件日志：readAllAsync 与 readAll 逐条一致（含坏行计数）', async (t) => {
  const dir = tmp(t)
  const ts = Date.now()
  const log = new EventLog({ root: dir, roomId: ROOM })
  for (let i = 0; i < 50; i++) log.append('DANMAKU', { uid: i }, { ts })
  appendFileSync(join(dir, ROOM, `${dayKey(ts)}.jsonl`), '{"seq":999,"type":"DAN', 'utf8')

  const sync = log.readAll()
  const streamed = await log.readAllAsync()

  // 两条路径读的是同一批文件，任何一条给出不同答案都是灾难：
  // 一个用于启动重放，一个用于对账 —— 它们不一致就意味着"对账报错"是假的。
  assert.deepEqual(streamed, sync)
  assert.equal(streamed.length, 50)
  assert.equal(log.stats().badLines, 1)
  assert.deepEqual(
    streamed.map((e) => e.seq),
    Array.from({ length: 50 }, (_, i) => i + 1),
    'seq 必须升序',
  )
})

test('事件日志：异步读取跨天多分片也按 seq 升序', async (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  log.append('DANMAKU', { k: 1 }, { ts: new Date(2026, 10, 1, 23, 30).getTime() })
  log.append('DANMAKU', { k: 2 }, { ts: new Date(2026, 10, 2, 0, 30).getTime() })
  log.append('DANMAKU', { k: 3 }, { ts: new Date(2026, 10, 3, 0, 30).getTime() })

  const all = await log.readAllAsync()
  assert.deepEqual(all.map((e) => e.payload.k), [1, 2, 3])
})

// ─── 5. 非法 roomId 必须挡住（拼路径的地方）────────────────
test('事件日志：拒绝路径穿越的 roomId', (t) => {
  const dir = tmp(t)
  assert.throws(() => new EventLog({ root: dir, roomId: '../evil' }), /非法的 roomId/)
  assert.throws(() => new EventLog({ root: dir, roomId: '' }), /非法的 roomId/)
})

// ─── 6. 状态机幂等 ────────────────────────────────────────
test('状态机：重复的 LIVE_START / LIVE_END 不重复出边沿', () => {
  const sm = new RoomStateMachine()
  assert.equal(sm.feed({ type: 'LIVE_START' }).edge, EDGE.LIVE_STARTED)
  assert.equal(sm.state, LIVE)
  assert.equal(sm.feed({ type: 'LIVE_START' }).edge, null, '重复开播不应再出边沿')
  assert.equal(sm.feed({ type: 'LIVE_END' }).edge, EDGE.LIVE_ENDED)
  assert.equal(sm.state, OFFLINE)
  assert.equal(sm.feed({ type: 'LIVE_END' }).edge, null, '重复下播不应再出边沿')
})

// ─── 7. 投影：重放幂等（喂两遍不翻倍）──────────────────────
test('投影：同一批事件喂两遍，数字不变', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  seedSession(log, { danmaku: 50, enters: 10, gifts: [{ num: 3, price: 10 }] })

  const events = log.readAll()
  const p = new Projection(ROOM)
  p.applyAll(events)
  const first = p.snapshot()

  p.applyAll(events)
  p.applyAll(events)
  const again = p.snapshot()

  assert.deepEqual(again, first, '重复 apply 必须完全一致')
  assert.equal(first.grand.danmaku, 50)
})

test('投影：重放同一条事件不交出旧边沿（否则提醒会重复）', () => {
  const p = new Projection(ROOM)
  const ev = { seq: 1, ts: 1_700_000_000_000, type: 'LIVE_START', payload: {} }

  p.apply(ev)
  assert.equal(p.lastEdge, 'live_started', '第一次真的产生了边沿')

  p.apply(ev)
  assert.equal(p.lastEdge, null, '幂等返回时没有新边沿，不能把上一次的再交出去')
})

test('投影：重连补的 inferred 下播也算「估计时刻」，不能当时长精确值', () => {
  // 断线期间下播：B站 不会补发 LIVE_END，重连后只能按"最后一条事件"推断，
  // 和启动校准的 synthetic 一样，结束时刻是不准的。
  const p = new Projection(ROOM)
  p.apply({ seq: 1, ts: 1_700_000_000_000, type: 'LIVE_START', payload: {} })
  p.apply({ seq: 2, ts: 1_700_000_100_000, type: 'DANMAKU', payload: { uid: 1 } })
  p.apply({ seq: 3, ts: 1_700_000_500_000, type: 'LIVE_END', payload: { inferred: true } })

  const s = p.listSessions().at(-1)
  assert.equal(s.endedAtEstimated, true, 'inferred 下播必须标估计')
  assert.equal(s.endedAt, 1_700_000_160_000, '推断时刻 = 最后一条事件 + 60 秒宽限，不是重连时刻')
})

// ─── 8. 重启后统计误差 = 0（P0 的核心验收）─────────────────
test('投影：重启后重放，统计与崩溃前完全一致', (t) => {
  const dir = tmp(t)
  const log1 = new EventLog({ root: dir, roomId: ROOM })
  seedSession(log1, {
    danmaku: 120,
    enters: 30,
    gifts: [
      { uid: 1, uname: '甲', giftName: '小花花', num: 10, price: 10 },
      { uid: 2, uname: '乙', giftName: '心动卡', num: 1, price: 100 },
    ],
  })

  const before = new Projection(ROOM)
  before.applyAll(log1.readAll())
  const snapBefore = before.snapshot()

  // 模拟崩溃后重启：全新实例，从磁盘读
  const log2 = new EventLog({ root: dir, roomId: ROOM })
  const after = new Projection(ROOM)
  after.applyAll(log2.readAll())
  const snapAfter = after.snapshot()

  assert.deepEqual(snapAfter, snapBefore, '重启前后快照必须逐字段相等')
  assert.equal(snapAfter.giftBattery, 10 * 10 + 1 * 100)
  assert.equal(snapAfter.giftCount, 11)
  assert.equal(snapAfter.finishedSessions, 1)
})

// ─── 9. 直播中重启：隐式场次接上，不丢数 ───────────────────
test('投影：直播中重启后继续写入，增量不丢不重', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })

  log.append('LIVE_START', {})
  for (let i = 0; i < 50; i++) log.append('DANMAKU', { uid: i, text: `a${i}` })

  // 此刻"重启"
  const p = new Projection(ROOM)
  p.applyAll(log.readAll())
  assert.equal(p.state, LIVE, '重放后应仍是直播中')
  assert.equal(p.snapshot().danmaku, 50)

  // 重启后继续收包（没有新的 LIVE_START）
  for (let i = 0; i < 10; i++) log.append('DANMAKU', { uid: i, text: `b${i}` })
  p.applyAll(log.readAll())

  const snap = p.snapshot()
  assert.equal(snap.danmaku, 60, '新增 10 条，且不能把前 50 条重算一遍')
  assert.equal(snap.grand.danmaku, 60)
})

// ─── 10. 连击两种报文的统计结果必须一致 ────────────────────
test('投影：num=1 逐条 与 num=10 一次，礼物个数相同', (t) => {
  const dirA = tmp(t)
  const logA = new EventLog({ root: dirA, roomId: ROOM })
  logA.append('LIVE_START', {})
  for (let i = 1; i <= 10; i++) {
    logA.append('GIFT', { uid: 1, uname: '甲', giftName: '小花花', num: 1, price: 10, comboCount: i })
  }
  const pA = new Projection(ROOM)
  pA.applyAll(logA.readAll())

  const dirB = tmp(t)
  const logB = new EventLog({ root: dirB, roomId: ROOM })
  logB.append('LIVE_START', {})
  logB.append('GIFT', { uid: 1, uname: '甲', giftName: '小花花', num: 10, price: 10, comboCount: 1 })
  const pB = new Projection(ROOM)
  pB.applyAll(logB.readAll())

  const a = pA.snapshot()
  const b = pB.snapshot()
  assert.equal(a.giftCount, 10)
  assert.equal(b.giftCount, 10)
  assert.equal(a.giftBattery, b.giftBattery, '两种报文口径必须得出同样的电池数')
})

// ─── 11. 对账：正常数据必须通过 ────────────────────────────
test('对账：正常日志全部通过', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  seedSession(log, {
    danmaku: 30,
    enters: 5,
    gifts: [{ num: 2, price: 50 }],
  })

  const events = log.readAll()
  const p = new Projection(ROOM)
  p.applyAll(events)

  const r = reconcile({ events, snapshot: p.snapshot(), logStats: log.stats() })
  assert.equal(r.ok, true, formatReport(r))
  assert.equal(r.summary.failed, 0)
})

// ─── 12. 对账必须能抓到差异（否则它毫无意义）───────────────
test('对账：投影数字被篡改时必须报错', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  seedSession(log, { danmaku: 10, gifts: [{ num: 1, price: 10 }] })

  const events = log.readAll()
  const p = new Projection(ROOM)
  p.applyAll(events)
  const snap = p.snapshot()

  snap.grand.giftBattery += 1
  const r = reconcile({ events, snapshot: snap, logStats: log.stats() })
  assert.equal(r.ok, false)
  assert.ok(r.diffs.some((d) => d.name === '礼物电池累计'), formatReport(r))
})

// ─── 13. 对账能发现序号缺口 ───────────────────────────────
test('对账：日志缺号时必须报错', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  seedSession(log, { danmaku: 5 })

  const events = log.readAll()
  const holed = events.filter((e) => e.seq !== 3)
  const p = new Projection(ROOM)
  p.applyAll(events)

  const r = reconcile({ events: holed, snapshot: p.snapshot(), logStats: log.stats() })
  assert.equal(r.ok, false)
  assert.ok(r.diffs.some((d) => d.name === '序号连续'), formatReport(r))
})

test('对账：空日志不该报错（新装第一次启动就会走到这里）', () => {
  // 以前序号连续那条是 `maxSeq - minSeq + 1`，空数组时 min=max=0 会算出 1，
  // 于是"0 条日志"被判成"序号不连续" —— 新装第一次启动就报一次对账失败，
  // 而对账失败本该是"数据出问题了"的强信号，被这种假阳性磨没了就没人看了。
  const p = new Projection(ROOM)
  const r = reconcile({ events: [], snapshot: p.snapshot() })
  assert.equal(r.ok, true, formatReport(r))
  assert.equal(r.summary.events, 0)
})

test('对账：二十万条事件也不崩（不许用 Math.min(...arr) 展开）', () => {
  // 展开运算符会把这些元素全变成实参。实测本机上限在 12 万～20 万之间，
  // 超过就 `RangeError: Maximum call stack size exceeded`。
  // 日志是 append-only 的，条数只会一直涨 —— 一场 9000 条的话，
  // 二十几场就摸到这条线，也就是"开播一个月的房间"
  const N = 200_000
  const base = Date.now()
  const events = Array.from({ length: N }, (_, i) => ({
    seq: i + 1,
    ts: base + i,
    roomId: ROOM,
    type: 'DANMAKU',
    source: 'test',
    payload: { uid: 1 },
  }))
  const p = new Projection(ROOM)
  p.applyAll(events)
  const r = reconcile({ events, snapshot: p.snapshot() })
  assert.equal(r.ok, true, formatReport(r))
  assert.equal(r.summary.lastSeq, N)
})

// ─── 14. 独立求和路径与投影口径一致 ────────────────────────
test('求和：分组求和与投影累加得出同一个数', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  seedSession(log, {
    danmaku: 40,
    enters: 8,
    gifts: [
      { num: 5, price: 10 },
      { num: 3, price: 100 },
      { num: 1, price: 1 },
    ],
  })
  log.append('LIVE_START', {})
  log.append('GUARD_BUY', { uid: 9, uname: '舰长', guardLevel: 3, num: 1, price: 198000 })

  const events = log.readAll()
  const p = new Projection(ROOM)
  p.applyAll(events)
  const snap = p.snapshot()
  const exp = sumByType(events)

  assert.equal(exp.danmaku, snap.grand.danmaku)
  assert.equal(exp.giftCount, snap.grand.giftCount)
  assert.equal(exp.giftBattery, snap.grand.giftBattery)
  assert.equal(exp.guardBattery, snap.grand.guardBattery)
  assert.equal(exp.guardBattery, 198000)
})

// ─── 15. 多场次：历史封存，当前场重置 ──────────────────────
test('投影：连开两场，历史封存且当前场重新计数', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  seedSession(log, { danmaku: 10 })
  seedSession(log, { danmaku: 25 })

  const p = new Projection(ROOM)
  p.applyAll(log.readAll())
  const snap = p.snapshot()

  assert.equal(snap.finishedSessions, 2, '两场都应封存')
  assert.equal(snap.danmaku, 25, '当前场只算第二场')
  assert.equal(snap.grand.danmaku, 35, '总累计要包含两场')

  const list = p.listSessions()
  assert.equal(list.length, 2)
  assert.equal(list[0].danmaku, 10)
  assert.equal(list[1].danmaku, 25)
})

// ─── 15b. 封存场次缺 endedAt 时，时长不能算成 0 ─────────────
test('投影：已封存但缺 endedAt 的场次，时长退化成"到现在"，不能是 0', (t) => {
  /**
   * `listSessions()` 原来是 `this.sessions.map(summarizeSession)` ——
   * `Array.map` 会把**下标**当第二个参数传进去，于是 `summarizeSession(s, 0)`
   * 的 `now` 变成了 0、1、2……
   *
   * 正常流程走不到（`_closeSession` 一定会写 endedAt），但只要有一条
   * "已封存、endedAt 为 0"的场次（旧版本数据、手工修过的日志、以后新增的
   * 封存路径），时长就会被算成 max(0, (0 - startedAt)/1000) = 0 ——
   * 战报上一场三小时的直播显示"0 分钟"，而没有任何报错。
   */
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  seedSession(log, { danmaku: 3 })

  const p = new Projection(ROOM)
  p.applyAll(log.readAll())
  assert.equal(p.sessions.length, 1, '这一场应当已封存')

  // 模拟"日志里没有可靠的结束时间"（现在写不出这种数据，但历史上可以有）。
  // 开场时间也往前挪两小时，不能贴着"现在"，否则时长本来就接近 0，测不出区别
  p.sessions[0].endedAt = 0
  p.sessions[0].startedAt = Date.now() - 2 * 3600_000

  const [s] = p.listSessions()
  assert.ok(s.durationSec > 3600, `时长算成了 ${s.durationSec} 秒：map 又把下标当 now 了`)
})

/* ═══════════════════════════════════════════════════════════
 * 审计回归：这六条全部来自 2026-11-02 的一次代码审计，
 * 每一处都先复现出真实后果，再修，再锁死。
 * 它们共同的特征是 —— 出问题时**一行日志都没有**。
 * ═══════════════════════════════════════════════════════════ */

// ─── 16. seq 恢复：尾部读不出时不能从 0 重来 ──────────────
test('日志：最后几行全坏时，seq 必须全量扫描恢复，不能从 0 重来', (t) => {
  const dir = tmp(t)
  const roomDir = join(dir, ROOM)
  const f = join(roomDir, `${dayKey(Date.now())}.jsonl`)
  // 先建目录再写文件：EventLog 的构造函数会 mkdir，这里要提前放好数据
  const first = new EventLog({ root: dir, roomId: ROOM })
  for (let i = 1; i <= 5; i++) {
    first.append(i === 1 ? 'LIVE_START' : 'DANMAKU', { uid: i })
  }
  // 模拟"进程被反复杀掉 + 磁盘写坏"，尾部 3 行全是垃圾
  appendFileSync(f, '坏行一\n坏行二\n坏行三', 'utf8')
  assert.ok(readdirSync(roomDir).includes(`${dayKey(Date.now())}.jsonl`))

  const log = new EventLog({ root: dir, roomId: ROOM })
  assert.equal(log.lastSeq, 5, '尾部读不出时要全量扫描，仍恢复出 5')
  assert.equal(log.stats().recoveredByScan, true, '要能报出"这次恢复走了全量扫描"')

  // 关键后果：seq 若从 1 重来，投影的幂等判断会把之后所有事件当成"已处理"
  const p = new Projection(ROOM)
  p.applyAll(log.readAll())
  const before = p.snapshot().danmaku
  p.apply(log.append('DANMAKU', { uid: 99 }))
  assert.equal(p.snapshot().danmaku, before + 1, '新事件必须被计入，不能静默丢弃')
})

// ─── 17. seq 恢复：跨天分片里最后一天全坏，要回退前一天 ────
test('日志：最后一天的分片全坏时，回退到前一天取 seq', (t) => {
  const dir = tmp(t)
  const roomDir = join(dir, ROOM)
  const log = new EventLog({ root: dir, roomId: ROOM })
  log.append('LIVE_START', {})
  // 换一个"第二天"的分片名，内容全是坏的
  const nextDay = `${dayKey(Date.now() + 86_400_000)}.jsonl`
  appendFileSync(join(roomDir, nextDay), '全是坏行\n还是坏行\n', 'utf8')

  assert.equal(new EventLog({ root: dir, roomId: ROOM }).lastSeq, 1)
})

// ─── 18. 隐式场次之后，真正的 LIVE_START 必须开新场 ────────
test('投影：隐式场次遇到真 LIVE_START 要开新场，不能合并两场', () => {
  const p = new Projection(ROOM)
  const ev = (seq, type, payload = {}) => ({ seq, id: `x${seq}`, ts: 1000 + seq, roomId: ROOM, type, payload })

  // 进程在直播中途启动：只有弹幕，没有 LIVE_START
  p.apply(ev(1, 'DANMAKU', { uid: 1 }))
  p.apply(ev(2, 'DANMAKU', { uid: 2 }))
  assert.equal(p.state, 'live_unknown', '有事件在来但场次起点未知')

  // 这时来了一条真正的开播事件
  p.apply(ev(3, 'LIVE_START', { liveTime: 500 }))
  const s = p.snapshot()
  assert.equal(s.sessionId, 's3', '必须开新场，而不是把数据并进隐式场')
  assert.equal(s.danmaku, 0, '新场从 0 开始计数')
  assert.equal(s.state, 'live')
  assert.equal(s.finishedSessions, 0, '隐式场次不计入已完成场次')

  p.apply(ev(4, 'DANMAKU', { uid: 3 }))
  assert.equal(p.snapshot().danmaku, 1, '新场继续累加')
})

// ─── 19. 同一次开播的重复推送，不能反复开新场 ──────────────
test('投影：同 liveTime 的重复 LIVE_START 不开新场，换 liveTime 才开', () => {
  const p = new Projection(ROOM)
  const ev = (seq, type, payload = {}) => ({ seq, id: `y${seq}`, ts: 1000 + seq, roomId: ROOM, type, payload })

  p.apply(ev(1, 'LIVE_START', { liveTime: 900 }))
  p.apply(ev(2, 'DANMAKU', { uid: 1 }))
  p.apply(ev(3, 'LIVE_START', { liveTime: 900 })) // 重连后 B站 重推

  assert.equal(p.snapshot().sessionId, 's1', '重推不开新场')
  assert.equal(p.snapshot().danmaku, 1, '重推不清零')

  p.apply(ev(4, 'LIVE_START', { liveTime: 1200 })) // 真的又开一场
  assert.equal(p.snapshot().sessionId, 's4', '新的开播时间要开新场')
})

// ─── 20. 下播瞬间的延迟弹幕，要归回刚结束的那一场 ──────────
test('投影：下播 60 秒内的延迟弹幕归原场，超过则新开一段', () => {
  const p = new Projection(ROOM)
  const ev = (seq, type, payload = {}, ts) => ({ seq, id: `z${seq}`, ts, roomId: ROOM, type, payload })

  p.apply(ev(1, 'LIVE_START', {}, 1000))
  p.apply(ev(2, 'DANMAKU', { uid: 1 }, 2000))
  p.apply(ev(3, 'LIVE_END', {}, 3000))
  p.apply(ev(4, 'DANMAKU', { uid: 2 }, 4000)) // 下播 1 秒后才推到

  let s = p.snapshot()
  assert.equal(s.sessionId, 's1', '延迟弹幕属于原场')
  assert.equal(s.danmaku, 2)
  assert.equal(s.state, 'offline', '不能因为延迟弹幕把状态改回 live')
  assert.equal(s.liveEndedAt, 3000, '结束时间要保留')

  p.apply(ev(5, 'DANMAKU', { uid: 3 }, 3000 + 120_000)) // 两分钟后
  s = p.snapshot()
  assert.notEqual(s.sessionId, 's1', '隔得太久要新开一段，不能永远挂在上一场')
  assert.equal(p.state, 'live_unknown')
})

// ─── 21. 守卫金额：场次、总累计、对账必须同一口径 ──────────
test('金额口径：守卫的场次统计与总累计、对账路径用同一个算法', () => {
  const events = [
    { seq: 1, ts: 1, type: 'LIVE_START', payload: {} },
    // 2 个舰长共 667 电池：单价除不尽，数量 × 单价 会算出 666.6
    { seq: 2, ts: 2, type: 'GUARD_BUY', payload: { uid: 1, num: 2, price: 333.3, battery: 667 } },
  ]

  const p = new Projection(ROOM).applyAll(events)
  const snap = p.snapshot()
  const summed = sumByType(events)

  assert.equal(snap.guardBattery, 667, '场次统计要用报文给的精确总价')
  assert.equal(snap.grand.guardBattery, 667, '总累计同口径')
  assert.equal(summed.guardBattery, 667, '对账路径同口径')
})

// ─── 22. 对账要能看见"本场数字错了"，而不只是总账错了 ──────
test('对账：只对总累计不够，本场统计也要独立重算', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  seedSession(log, { danmaku: 5 }) // 第一场：seq 1..7
  seedSession(log, { danmaku: 5 }) // 第二场

  const events = log.readAll()
  const p = new Projection(ROOM).applyAll(events)
  const snap = p.snapshot()

  const good = reconcile({ events, snapshot: snap })
  assert.equal(good.ok, true, `正常情况应当对得上：${formatReport(good)}`)

  // 模拟"场次边界划错"：sessionId 还停在第一场，但数字已经是第二场的
  const broken = reconcile({ events, snapshot: { ...snap, sessionId: 's1' } })
  assert.equal(broken.ok, false, '本场起点与数字不匹配时必须报错')
  assert.ok(
    broken.diffs.some((d) => d.name === '本场弹幕'),
    `应当点名"本场弹幕"不一致，实际失败项：${broken.diffs.map((d) => d.name).join('、')}`,
  )
})

// ─── 免费礼物：个数照算，金额记 0 ──────────────────────────
test('礼物：银瓜子的免费礼物不计入金额，但计入个数', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  log.append('LIVE_START', { liveStatus: 1 })

  // 付费：100 电池
  log.append('GIFT', { uid: 1, uname: '甲', giftName: '辣条', num: 1, battery: 100, isPaid: true })
  // 免费：报文里同样带 total_coin，但 coinType 是银瓜子
  log.append('GIFT', { uid: 2, uname: '乙', giftName: '小心心', num: 3, battery: 30, isPaid: false })
  // 老日志：没有 isPaid 字段 —— 缺省必须按付费算，否则升级后历史金额整片归零
  log.append('GIFT', { uid: 3, uname: '丙', giftName: '辣条', num: 1, battery: 50 })

  const events = log.readAll()
  const snap = new Projection(ROOM).applyAll(events).snapshot()

  assert.equal(snap.giftCount, 5, '个数照算：1 + 3 + 1')
  assert.equal(snap.giftBattery, 150, '金额只算付费的：100 + 50，免费的 30 不计')

  // 对账必须跟着一致，否则这条修完会让每次启动都报差异
  const rep = reconcile({ events, snapshot: snap })
  assert.equal(rep.ok, true, `对账应当通过：${formatReport(rep)}`)
})

test('礼物：送礼榜里的金额同样剔除免费礼物', (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  log.append('LIVE_START', { liveStatus: 1 })
  log.append('GIFT', { uid: 9, uname: '同一个人', giftName: '小心心', num: 5, battery: 50, isPaid: false })

  const snap = new Projection(ROOM).applyAll(log.readAll()).snapshot()
  const row = snap.topGifters.find((u) => String(u.uid) === '9')

  assert.ok(row, '送礼榜里应有这个人')
  assert.equal(row.count, 5, '送了多少个照算')
  assert.equal(row.battery, 0, '送的都是免费的，金额记为 0')
})
