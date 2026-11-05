/**
 * 时间轴回看。
 *
 * 这一组断言盯的是"图上和卡片上会不会打架"：
 *
 *   1. **最后一格必须等于战报**。两边各算一遍是这类功能最常见的翻车方式 ——
 *      图上 120、卡片上 118，谁也不知道该信哪个，而且永远查不出差在哪。
 *   2. **格子边界的归属要确定**。事件恰好落在 60 秒整点时，算第一格还是
 *      第二格必须写死，否则同样一份日志在两次请求里能给出不同结果。
 *   3. **空地不能凭空造数据**。窗口里没事件时返回空，而不是一排 0 ——
 *      一排 0 看起来像"这一场没人说话"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTimeline, normalizeStep } from '../core/timeline.mjs'
import { buildReports, summarizeReports } from '../core/report.mjs'
import { buildRoutes } from '../http/api.mjs'

const ROOM = '9001'
const T0 = new Date('2026-11-02T20:00:00+08:00').getTime()
const MIN = 60_000

let seq = 0
/** 造一条事件；seq 自增，顺序即参数顺序 */
function ev(ts, type, payload = {}) {
  return { seq: ++seq, ts, type, payload }
}

/** 场次：20:00 开播，22:00 下播 */
function sessionEvents() {
  seq = 0
  return [
    ev(T0, 'LIVE_START', { liveTime: T0 }),
    ev(T0 + 10_000, 'ENTER', { uid: 1, uname: '甲' }),
    ev(T0 + 20_000, 'DANMAKU', { uid: 1, uname: '甲', text: '一' }),
    ev(T0 + 30_000, 'DANMAKU', { uid: 2, uname: '乙', text: '二' }),
    ev(T0 + 2 * MIN, 'DANMAKU', { uid: 1, uname: '甲', text: '三' }),
    ev(T0 + 3 * MIN, 'GIFT', { uid: 2, uname: '乙', giftName: '辣条', num: 2, battery: 200, isPaid: true }),
    ev(T0 + 61 * MIN, 'SUPER_CHAT', { uid: 3, uname: '丙', message: '加油', battery: 300, yuan: 30 }),
    ev(T0 + 90 * MIN, 'GUARD_BUY', { uid: 4, uname: '丁', guardLevel: 3, num: 1, battery: 1980 }),
    ev(T0 + 100 * MIN, 'FOLLOW', { uid: 5, uname: '戊' }),
    ev(T0 + 110 * MIN, 'SENT', { text: '感谢乙的辣条', reason: 'gift' }),
    ev(T0 + 120 * MIN, 'LIVE_END', {}),
  ]
}

const FROM = T0
const TO = T0 + 120 * MIN

/* ══════════════════ 格子 ══════════════════ */

test('时间轴：格子按分钟切，累积量随时间单调不减', () => {
  const tl = buildTimeline(sessionEvents(), { from: FROM, to: TO, stepSec: 60, roomId: ROOM })

  assert.equal(tl.frames.length, 120, '两小时按分钟切就是 120 格')
  assert.equal(tl.frames[0].elapsedSec, 60, '第一格结束在 60 秒')

  let prev = 0
  for (const f of tl.frames) {
    assert.ok(f.danmaku >= prev, '累积量不许倒退')
    prev = f.danmaku
  }
  assert.equal(tl.frames[0].danmaku, 2, '第一分钟有 2 条弹幕')
  assert.equal(tl.frames[1].danmaku, 2, '第二分钟没有新弹幕，累积量不变')
  assert.equal(tl.frames[2].danmaku, 3, '第 2 分钟整点那条落在第三格（左闭右开）')
  assert.equal(tl.frames[119].danmaku, 3)
})

test('时间轴：边界上的事件归后一格（左闭右开），最后一格含右端点', () => {
  seq = 0
  const events = [
    ev(T0, 'LIVE_START', { liveTime: T0 }),
    ev(T0 + 59_999, 'DANMAKU', { uid: 1, uname: '甲', text: '差 1 毫秒' }),
    ev(T0 + 60_000, 'DANMAKU', { uid: 1, uname: '甲', text: '整 60 秒' }),
    ev(T0 + 120_000, 'DANMAKU', { uid: 1, uname: '甲', text: '整 120 秒' }),
  ]
  const tl = buildTimeline(events, { from: T0, to: T0 + 120_000, stepSec: 60, roomId: ROOM })

  assert.equal(tl.frames.length, 2)
  assert.equal(tl.frames[0].danmaku, 1, '59.999 秒属于第一格')
  assert.equal(
    tl.frames[1].danmaku,
    3,
    '60 秒整属于第二格；120 秒是右端点，也算进来（否则最后一刻的数据会丢）',
  )
})

test('时间轴：输入顺序不影响结果（内部按 seq 归一）', () => {
  seq = 0
  const events = [
    ev(T0, 'LIVE_START', { liveTime: T0 }),
    ev(T0 + 3 * MIN, 'DANMAKU', { uid: 1, uname: '甲', text: '后' }),
    ev(T0 + 30_000, 'DANMAKU', { uid: 1, uname: '甲', text: '先' }),
  ]
  // 故意打乱顺序再送进来：调用方（HTTP 层）不应承担"必须排好"的义务。
  // 关键在于**不能按时间排** —— 投影按 seq 去重，按时间排会让它丢掉事件。
  const shuffled = [events[0], events[2], events[1]]
  const a = buildTimeline(shuffled, { from: T0, to: T0 + 5 * MIN, stepSec: 60, roomId: ROOM })
  const b = buildTimeline(events, { from: T0, to: T0 + 5 * MIN, stepSec: 60, roomId: ROOM })

  assert.deepEqual(a, b, '乱序输入必须得到同一份时间轴')
  assert.equal(a.totals.danmaku, 2, '两条弹幕都不能丢（这是按时间排会踩的坑）')
  assert.deepEqual(
    shuffled.map((e) => e.seq),
    [1, 3, 2],
    '不能就地排序调用方的数组 —— 它可能还要给别处用',
  )
})

/* ══════════════════ 与战报同源 ══════════════════ */

test('时间轴：最后一格与战报完全一致（同一份日志，两个入口）', () => {
  const events = sessionEvents()
  const tl = buildTimeline(events, { from: FROM, to: TO, stepSec: 60, roomId: ROOM })
  const [session] = buildReports(events, { roomId: ROOM })
  const report = summarizeReports(buildReports(events, { roomId: ROOM }))

  const last = tl.frames[tl.frames.length - 1]
  for (const key of [
    'danmaku',
    'enterCount',
    'uniqueViewers',
    'followCount',
    'giftCount',
    'giftBattery',
    'guardCount',
    'guardBattery',
    'scCount',
    'scBattery',
    'sentCount',
    'totalBattery',
    'peakPopularity',
  ]) {
    assert.equal(last[key], session[key], `${key} 在时间轴和战报卡片里必须相等`)
    assert.equal(tl.totals[key], session[key], `totals.${key} 也必须相等`)
  }

  // 汇总条（多场相加）在共有字段上也得对得上 —— 单场时它就是这一场
  for (const key of ['danmaku', 'enterCount', 'followCount', 'giftCount', 'totalBattery']) {
    assert.equal(tl.totals[key], report[key], `${key} 和汇总条也要相等`)
  }

  // 金额口径单独钉一次：SC 的 battery 已经是电池，不能再乘 10
  assert.equal(tl.totals.totalBattery, 200 + 300 + 1980)

  // 柱状图用的"每格新增"必须正好加回总数：图上的柱子和卡片上的数字同源
  assert.equal(
    tl.frames.reduce((sum, f) => sum + f.danmakuDelta, 0),
    tl.totals.danmaku,
    '每格新增之和必须等于总数（否则柱子看起来对、加起来不对）',
  )
})

test('时间轴：窗口外的事件一条都不算', () => {
  seq = 0
  const events = [
    ev(T0 - 60 * MIN, 'LIVE_START', { liveTime: T0 - 60 * MIN }),
    ev(T0 - 60 * MIN + 1000, 'DANMAKU', { uid: 9, uname: '之前', text: '不算' }),
    ev(T0 + 1000, 'DANMAKU', { uid: 1, uname: '甲', text: '算' }),
    ev(T0 + 30 * MIN, 'DANMAKU', { uid: 1, uname: '甲', text: '之后' }),
  ]
  const tl = buildTimeline(events, { from: T0, to: T0 + 10 * MIN, stepSec: 60, roomId: ROOM })

  assert.equal(tl.eventCount, 1)
  assert.equal(tl.totals.danmaku, 1)
})

/* ══════════════════ 空与边界 ══════════════════ */

test('时间轴：空窗口返回空，而不是一排 0', () => {
  const zero = buildTimeline([], { from: T0, to: T0 + 10 * MIN })
  assert.deepEqual(zero.frames, [])
  assert.equal(zero.totals, null)
  assert.deepEqual(zero.marks, [])

  // 起点 == 终点（只播了一瞬间）也是空：没有"一段"可回看
  assert.deepEqual(buildTimeline(sessionEvents(), { from: T0, to: T0 }).frames, [])
  // 倒过来的窗口同理，不能算出负数格
  assert.deepEqual(buildTimeline(sessionEvents(), { from: T0 + 1000, to: T0 }).frames, [])
  // 非数字也不许抛
  assert.deepEqual(buildTimeline(sessionEvents(), { from: 'x', to: null }).frames, [])
})

test('时间轴：格宽收敛到 10 秒 ~ 1 小时，非法值退回默认', () => {
  assert.equal(normalizeStep(1), 10)
  assert.equal(normalizeStep(99999), 3600)
  assert.equal(normalizeStep(0), 60)
  assert.equal(normalizeStep('abc'), 60)
  assert.equal(normalizeStep(30), 30)
})

test('时间轴：跨度太大时自动加宽格子，但最后一格仍落在窗口终点', () => {
  // 40 小时、按 10 秒切会有 14400 格 —— 必须收敛到上限以内
  const span = 40 * 3600_000
  const events = [{ seq: 1, ts: T0, type: 'LIVE_START', payload: { liveTime: T0 } }]
  const tl = buildTimeline(events, { from: T0, to: T0 + span, stepSec: 10 })
  assert.ok(tl.frames.length <= 2000, `格数要收敛，实际 ${tl.frames.length}`)
  assert.equal(tl.frames[tl.frames.length - 1].t, T0 + span, '最后一格的末尾必须正好是窗口终点')
  assert.ok(tl.stepSec > 10, '是加宽格子，不是把后半段截掉')
})

/* ══════════════════ 标记 ══════════════════ */

test('时间轴：标记里只有值得回看的事件，弹幕和进场不进', () => {
  const tl = buildTimeline(sessionEvents(), { from: FROM, to: TO, stepSec: 60, roomId: ROOM })
  const types = tl.marks.map((m) => m.type)

  assert.deepEqual(types, ['LIVE_START', 'GIFT', 'SUPER_CHAT', 'GUARD_BUY', 'FOLLOW', 'SENT', 'LIVE_END'])
  assert.equal(types.includes('DANMAKU'), false, '弹幕的量已经由柱子表达')
  assert.equal(types.includes('ENTER'), false)

  const sc = tl.marks.find((m) => m.type === 'SUPER_CHAT')
  assert.equal(sc.battery, 300, '金额原样带出，前端统一换算成元')
  assert.equal(sc.text, '加油', 'SC 正文在 message 字段里，要能取到')

  const sent = tl.marks.find((m) => m.type === 'SENT')
  assert.equal(sent.text, '感谢乙的辣条', '机器人说过什么，是回看时最想知道的东西之一')
})

test('时间轴：标记按时间升序，且超过上限时明确标出来', () => {
  seq = 0
  const many = [ev(T0, 'LIVE_START', { liveTime: T0 })]
  for (let i = 1; i <= 20; i++) many.push(ev(T0 + i * 1000, 'GIFT', { uid: i, uname: `人${i}`, num: 1 }))

  const tl = buildTimeline(many, { from: T0, to: T0 + 60_000, stepSec: 60, maxMarks: 5 })
  assert.equal(tl.marks.length, 5)
  assert.equal(tl.marksTruncated, true, '截断了就必须说，不能让用户以为这一场只有 5 个礼物')
  assert.deepEqual(
    tl.marks.map((m) => m.ts),
    [...tl.marks.map((m) => m.ts)].sort((a, b) => a - b),
    '标记要按时间升序',
  )

  const all = buildTimeline(many, { from: T0, to: T0 + 60_000, stepSec: 60, maxMarks: 500 })
  assert.equal(all.marksTruncated, false)
})

/* ══════════════════ HTTP 路由 ══════════════════ */

/**
 * 打真实路由表，而不是绕过它直接调 buildTimeline。
 *
 * 纯函数全对、接口照样出错的情况很常见：参数名写错、to<=from 没挡、
 * 429 分支永远进不去 —— 这些只有走一遍 handler 才暴露得出来。
 */
function fakeRes() {
  const out = { status: 0, body: null, done: false }
  const res = {
    writeHead(status) {
      out.status = status
    },
    end(buf) {
      out.done = true
      out.body = buf ? JSON.parse(String(buf)) : null
    },
  }
  return { res, out }
}

/** 只需要 runner.log_，其余字段本条路由不碰 */
function appWith(events) {
  return { roomId: ROOM, runner: { log_: { readAllAsync: async () => events } } }
}

/** 按注册表命中 /api/timeline 并跑一次 handler */
async function callTimeline(app, query = '') {
  const routes = buildRoutes(app)
  const hit = routes.match('GET', '/api/timeline')
  assert.ok(hit && hit.handler, '/api/timeline 必须注册成 GET 路由')

  const { res, out } = fakeRes()
  await hit.handler({ res, url: new URL(`http://127.0.0.1:8900/api/timeline${query}`) })
  assert.ok(out.done, 'handler 必须真的写出响应')
  return out
}

test('时间轴接口：正常窗口返回的帧与 buildTimeline 逐字段一致', async () => {
  const events = sessionEvents()
  const out = await callTimeline(appWith(events), `?from=${FROM}&to=${TO}&step=60`)

  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)

  const direct = buildTimeline(events, { from: FROM, to: TO, stepSec: 60, roomId: ROOM })
  assert.deepEqual(
    { ...out.body, ok: undefined },
    { ...direct, ok: undefined },
    '接口不许自己对时间轴做二次加工，形状必须和纯函数一致',
  )
})

test('时间轴接口：参数不合法时明确报错，而不是算出半张图', async () => {
  const app = appWith(sessionEvents())

  // 缺参数 / 非数字：NaN 参与比较永远是 false，光靠 to <= from 挡不住
  for (const q of ['', '?from=1', '?from=abc&to=def', `?to=${TO}`]) {
    const out = await callTimeline(app, q)
    assert.equal(out.status, 400, `${q || '(无参数)'} 必须 400`)
    assert.equal(out.body.error.code, 'bad_range')
  }

  // 倒过来的窗口 / 起止相同：没有"一段"可回看
  const inverted = await callTimeline(app, `?from=${TO}&to=${FROM}`)
  assert.equal(inverted.body.error.code, 'bad_range')
  const same = await callTimeline(app, `?from=${TO}&to=${TO}`)
  assert.equal(same.body.error.code, 'bad_range')
})

test('时间轴接口：跨度超过 7 天直接拒绝（防止有人把整年日志拖进来）', async () => {
  const app = appWith(sessionEvents())
  const out = await callTimeline(app, `?from=${T0}&to=${T0 + 8 * 86400_000}`)
  assert.equal(out.status, 400)
  assert.equal(out.body.error.code, 'too_wide')

  // 正好 7 天必须放行：边界不能少一天
  const edge = await callTimeline(app, `?from=${T0}&to=${T0 + 7 * 86400_000}&step=3600`)
  assert.equal(edge.status, 200, '7 天整是允许的上限')
})

test('时间轴接口：格宽非法值退回默认，不把 1 秒当真', async () => {
  const app = appWith(sessionEvents())
  const bad = await callTimeline(app, `?from=${FROM}&to=${TO}&step=abc`)
  assert.equal(bad.body.stepSec, 60, '缺省/非法 step 用默认 60 秒')

  const tooSmall = await callTimeline(app, `?from=${FROM}&to=${TO}&step=1`)
  assert.equal(tooSmall.body.stepSec, 10, '1 秒一格太快，收敛到下限')
})

test('时间轴接口：房间没启动时说清楚，不给空图', async () => {
  const out = await callTimeline({ roomId: ROOM }, `?from=${FROM}&to=${TO}`)
  assert.equal(out.status, 503)
  assert.equal(out.body.error.code, 'not_ready')
})

test('时间轴接口：连点两下时第二次拿到 429，不并发跑两遍全量重放', async () => {
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const app = {
    roomId: ROOM,
    runner: {
      log_: {
        readAllAsync: async () => {
          await gate
          return sessionEvents()
        },
      },
    },
  }

  const routes = buildRoutes(app)
  const hit = routes.match('GET', '/api/timeline')
  const a = fakeRes()
  const b = fakeRes()
  const url = new URL(`http://127.0.0.1:8900/api/timeline?from=${FROM}&to=${TO}`)

  const first = hit.handler({ res: a.res, url })
  const second = hit.handler({ res: b.res, url }) // 第一次还没读完日志
  release()
  await Promise.all([first, second])

  assert.equal(a.out.status, 200, '第一次必须正常返回')
  assert.equal(b.out.status, 429, '第二次必须被告知"还在算"')
  assert.equal(b.out.body.error.code, 'busy')
})
