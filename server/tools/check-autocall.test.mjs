/**
 * 主动打招呼（自动点名）：服务自己定时挑人、结构化 @ 过去。
 *
 * 这组断言的重点不是"说了什么"，而是**什么时候说、点谁、点没点到**：
 *   · 不等事件、不用人点 —— 时间到了就得自己开口
 *   · 不 @ 刚被欢迎过的人、不 @ 早走了的人、不反复 @ 同一个人
 *   · 被限速拦下不能算点过名（否则静默消耗候选）
 *
 * 定时部分用 t.mock.timers 推进假时钟，不等真实 300 秒。
 * 注意只 mock setTimeout、不 mock Date：造候选时按真实 Date.now() 回推
 * 来访时间，冷却过期则用直接改 scratch.called 的方式模拟，比让假时钟
 * 拖动整本观众簿的时间窗更可控。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import autocall, {
  DEFAULTS,
  isLiveState,
  shouldCall,
  resolveWindow,
  nextGreeting,
  isCooling,
  pickCandidate,
} from '../../plugins/autocall/plugin.mjs'
import { Roster } from '../core/roster.mjs'
import { validateManifest, defaultsOf, PluginHost } from '../core/plugin-host.mjs'

const SILENT = { debug() {}, info() {}, warn() {}, error() {} }
const NOW0 = 1_800_000_000_000

/* ══════════════════ 桩 ══════════════════ */

/** 造一本内存观众簿。ageMs = 距今多久进来的 */
function makeRoster(entries = [], now = Date.now()) {
  const r = new Roster({ dataDir: '', roomId: '9001', persist: false })
  for (const [uid, name, ageMs] of entries) r.mark(String(uid), name, now - ageMs)
  return r
}

function fakeCtx(config, opts = {}) {
  const said = []
  const warns = []
  let block = opts.block ?? null

  return {
    said,
    warns,
    config,
    state: opts.state ?? { state: 'live', roomId: '9001' },
    scratch: Object.create(null),
    roster: Object.prototype.hasOwnProperty.call(opts, 'roster')
      ? opts.roster
      : makeRoster(opts.entries ?? [['1001', '甲', 60_000], ['1002', '乙', 120_000]]),
    speakers: opts.speakers ?? null,
    presence: opts.presence ?? null,
    log: { ...SILENT, warn: (m) => warns.push(String(m)) },
    render: (tpl, vars) =>
      String(tpl).replace(/\{([^{}]+)\}/g, (w, k) =>
        Object.prototype.hasOwnProperty.call(vars, String(k).trim())
          ? String(vars[String(k).trim()])
          : w,
      ),
    say(text, extra = {}) {
      said.push({ text, ...extra })
      const b = typeof block === 'function' ? block(text, extra, said.length) : block
      return Promise.resolve(b ?? { ok: true })
    },
    _block(b) {
      block = b
    },
  }
}

function cfg(over = {}) {
  return { ...DEFAULTS, enabled: true, templates: ['你好 {用户}', '在呀 {用户}'], ...over }
}

/** 链式 setTimeout 必须分步推进，一次 tick(300000) 只会醒一次 */
function advance(t, ms, step = 5000) {
  let left = ms
  while (left > 0) {
    const d = Math.min(step, left)
    t.mock.timers.tick(d)
    left -= d
  }
}

/** 让异步 tick 及其 ctx.say(...).then(...) 的微任务全部跑完 */
async function flush() {
  // tick 现在会 await presence / say，链路上不止两层微任务；
  // 固定推进足够多轮，比数着 await 层数写更不容易随实现变化而挂。
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/* ══════════════════ 纯逻辑：门禁与配置 ══════════════════ */

test('主动招呼：门禁 —— 关掉 / 没文案 / 没开播都不说，live_unknown 算在播', () => {
  const live = { state: 'live' }
  assert.equal(shouldCall(cfg({ enabled: false }), live).reason, 'disabled')
  assert.equal(shouldCall(cfg({ templates: [] }), live).reason, 'no-templates')
  assert.equal(shouldCall(cfg(), { state: 'offline' }).reason, 'not-live')
  assert.equal(shouldCall(cfg(), live).ok, true)
  assert.equal(shouldCall(cfg(), { state: 'live_unknown' }).ok, true)
  assert.equal(shouldCall(cfg({ onlyWhenLive: false }), { state: 'offline' }).ok, true)
  assert.equal(isLiveState('live_unknown'), true)
  assert.equal(isLiveState('offline'), false)
})

test('主动招呼：时间窗互不相交时自动夹逼，不能让功能静默失效', () => {
  const ok = resolveWindow({ withinSec: 600, minAgeSec: 20 })
  assert.deepEqual(ok, { withinMs: 600_000, minAgeMs: 20_000, clamped: false })

  const bad = resolveWindow({ withinSec: 60, minAgeSec: 600 })
  assert.equal(bad.clamped, true)
  assert.equal(bad.minAgeMs, 30_000, '夹到窗口一半')
  assert.ok(bad.minAgeMs < bad.withinMs, '夹完必须还有交集，否则候选恒为空')

  // 非法值回退到安全默认，不能变成 NaN 让所有比较都 false
  const nan = resolveWindow({ withinSec: 'abc', minAgeSec: 'xyz' })
  assert.equal(nan.withinMs, 600_000)
  assert.equal(nan.minAgeMs, 20_000)
})

test('主动招呼：文案顺序轮播且游标跨轮，随机只在列表里挑', () => {
  const list = ['A', 'B', 'C']
  const seen = []
  let cursor = 0
  for (let i = 0; i < 5; i++) {
    const r = nextGreeting(list, cursor, false)
    seen.push(r.text)
    cursor = r.cursor
  }
  assert.deepEqual(seen, ['A', 'B', 'C', 'A', 'B'])

  assert.equal(nextGreeting(['A', 'B'], 99).text, 'B', '游标越界自动绕回')
  for (const x of [0, 0.34, 0.67, 0.999]) {
    const r = nextGreeting(list, 2, true, () => x)
    assert.ok(list.includes(r.text))
    assert.equal(r.cursor, 2, '随机模式不移动游标')
  }
  assert.equal(nextGreeting([]).text, '')
  assert.equal(nextGreeting(['', '  ']).text, '')
})

test('主动招呼：冷却判定 —— 0 表示不限，边界用严格小于', () => {
  assert.equal(isCooling(NOW0, 0, NOW0 + 999_999), false, '0 秒冷却不该挡任何人')
  assert.equal(isCooling(0, 1000, NOW0), false, '没点过的人不在冷却')
  assert.equal(isCooling(NOW0, 1000, NOW0 + 999), true)
  assert.equal(isCooling(NOW0, 1000, NOW0 + 1000), false)
})

/* ══════════════════ 纯逻辑：挑人 ══════════════════ */

const CAND = [
  { uid: '1', name: '甲', lastSeenAt: 300 },
  { uid: '2', name: '乙', lastSeenAt: 200 },
  { uid: '3', name: '丙', lastSeenAt: 100 },
]

test('主动招呼：默认最久没被点过的优先，雨露均沾不总点同一批人', () => {
  const called = new Map()
  const first = pickCandidate(CAND, cfg(), called, NOW0)
  assert.equal(first.uid, '1', '都没点过时按最近来过的优先（更可能还在房间里）')
  called.set('1', NOW0)

  const second = pickCandidate(CAND, cfg(), called, NOW0)
  assert.equal(second.uid, '2', '1 在冷却里，不能还是他')
  called.set('2', NOW0 - 1000)

  const third = pickCandidate(CAND, cfg(), called, NOW0)
  assert.equal(third.uid, '3', '1 比 2 更久没被点，但都在冷却，只剩 3')
})

test('主动招呼：newest / random 两种策略', () => {
  assert.equal(pickCandidate(CAND, cfg({ pickMode: 'newest' }), new Map(), NOW0).uid, '1')
  const called = new Map([['1', NOW0]])
  assert.equal(
    pickCandidate(CAND, cfg({ pickMode: 'newest' }), called, NOW0).uid,
    '2',
    'newest 也受每人冷却约束，不能一直 @ 同一个人',
  )
  for (const x of [0, 0.5, 0.999]) {
    assert.ok(
      ['1', '2', '3'].includes(pickCandidate(CAND, cfg({ pickMode: 'random' }), new Map(), NOW0, () => x).uid),
    )
  }
})

test('主动招呼：全员在冷却时返回 null（这一轮不该硬点一个人）', () => {
  const called = new Map(CAND.map((c) => [c.uid, NOW0]))
  assert.equal(pickCandidate(CAND, cfg(), called, NOW0), null)
  // 冷却过期后又能挑
  const expired = new Map(CAND.map((c) => [c.uid, NOW0 - 3600_000]))
  assert.equal(pickCandidate(CAND, cfg(), expired, NOW0).uid, '1')
})

test('主动招呼：脏候选（无 uid / 无昵称）不会被挑中', () => {
  const dirty = [...CAND, null, { uid: '', name: 'x' }, { uid: '9', name: '' }]
  const got = pickCandidate(dirty, cfg(), new Map(), NOW0)
  assert.ok(got && got.uid === '1')
})

/* ══════════════════ 观众簿只读候选 ══════════════════ */

test('观众簿 recent：按最近来访倒序，且只返回能结构化 @ 的人', () => {
  const r = new Roster({ dataDir: '', roomId: '9001', persist: false })
  r.mark('1001', '甲', NOW0 - 60_000)
  r.mark('1002', '乙', NOW0 - 30_000)
  r.mark('0', '匿名', NOW0 - 10_000)          // uid 0
  r.mark('', '空uid', NOW0 - 10_000)          // 空 uid
  r.mark('1003', '', NOW0 - 10_000)           // 没昵称
  r.mark('not-a-number', '脏数据', NOW0 - 10_000)

  const got = r.recent({ now: NOW0, withinMs: 0, minAgeMs: 0 })
  assert.deepEqual(
    got.map((c) => c.uid),
    ['1002', '1001'],
    '倒序 + 匿名/空昵称/非数字 uid 全部挡掉',
  )
})

test('观众簿 recent：太新 / 太久 / 时钟回拨 / limit 都按窗口过滤', () => {
  const r = new Roster({ dataDir: '', roomId: '9001', persist: false })
  r.mark('1', '刚进来', NOW0 - 5_000)
  r.mark('2', '正好', NOW0 - 60_000)
  r.mark('3', '早走了', NOW0 - 3_600_000)
  r.mark('4', '未来人', NOW0 + 60_000)

  const pick = (o) => r.recent({ now: NOW0, withinMs: 600_000, minAgeMs: 20_000, ...o }).map((c) => c.uid)
  assert.deepEqual(pick({}), ['2'], '只留下落在两个窗口交集里的人')
  assert.deepEqual(pick({ minAgeMs: 0 }), ['1', '2'], '不限 minAge 时刚进来的也算进来，且按最近来访倒序')
  assert.deepEqual(pick({ withinMs: 0 }), ['2', '3'], 'within=0 表示不限时间')

  // 时钟回拨写出的「未来人」永远不能进候选：age 为负，minAge 哪怕是 0 也会挡住。
  // 否则一次系统时间调整就会让机器人 @ 一个还没出现的人。
  const all = r.recent({ now: NOW0, minAgeMs: 0, withinMs: 0 }).map((c) => c.uid)
  assert.equal(all.includes('4'), false)
  assert.deepEqual(all, ['1', '2', '3'])

  assert.equal(r.recent({ now: NOW0, limit: 0 }).length, 0)
  assert.equal(r.recent({ now: NOW0, limit: 1 }).length, 1)
  assert.equal(r.recent({ now: NOW0, limit: 99999 }).length, 3, 'limit 硬上限 500，不越过它')
})

test('观众簿 recent 是纯只读：挑人不会往簿子里写东西', () => {
  const r = makeRoster([['1', '甲', 60_000]])
  const before = r.brief().people
  r.recent({ now: NOW0 })
  assert.equal(r.brief().people, before)
  assert.equal(r.peek('999'), null)
})

/* ══════════════════ 完整链路（假时钟） ══════════════════ */

test('主动招呼：默认关闭时一个周期过去也不说', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg({ enabled: false }))
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 0)
})

test('主动招呼：不用人点、不等事件，时间到了自己 @ 一位观众', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg())
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  assert.equal(ctx.said.length, 0, '刚启动不该立刻 @ 人（重启一次就 @ 一次最烦）')
  advance(t, 295_000)
  await flush()
  assert.equal(ctx.said.length, 0, '没到间隔不许说')

  advance(t, 5_000)
  await flush()
  assert.equal(ctx.said.length, 1)

  const s = ctx.said[0]
  assert.deepEqual(s.reply, { uid: '1001', uname: '甲' }, '必须是结构化 @，带 uid')
  assert.equal(s.reason, 'autocall')
  assert.equal(s.priority, 0, '主动招呼不该抢礼物答谢的等待槽位')
  assert.match(s.text, /^你好 甲$/, '文案里绝不写 @甲：B站 会自己挂可点标签')
  assert.equal(s.text.includes('@'), false, '重复写 @ 会变成「@甲 你好 甲」')
})

test('主动招呼：按顺序轮播文案，且两轮点的是不同的人', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg())
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  advance(t, 300_000)
  await flush()

  assert.equal(ctx.said.length, 2)
  assert.equal(ctx.said[0].text, '你好 甲')
  assert.equal(ctx.said[1].text, '在呀 乙', '文案轮到第二句、人也换成没被点过的')
  assert.equal(ctx.said[0].reply.uid, '1001')
  assert.equal(ctx.said[1].reply.uid, '1002')
})

test('主动招呼：被闸门拦下不算点过名，下一轮还挑他', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg(), { block: { ok: false, skipped: 'interval' } })
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.scratch.called.size, 0, '拦下就标记 = 静默消耗候选，最难受的失败方式')

  ctx._block(null)
  // 被拦下时节奏照常清零（和定时播报一致：跳过这一轮，下一个间隔再来），
  // 所以重试要等满一个间隔，而不是 5 秒后连着再撞一次限速。
  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 2)
  assert.equal(ctx.said[1].reply.uid, '1001', '还是同一个人，没有白白跳过')
  assert.equal(ctx.scratch.called.size, 1)
})

test('主动招呼：候选为空 / 没有观众簿时静默跳过，不退化成纯文本 @', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const empty = fakeCtx(cfg(), { entries: [] })
  const noRoster = fakeCtx(cfg(), { roster: null })
  for (const ctx of [empty, noRoster]) {
    autocall.onStart(ctx)
    t.after(() => autocall.onStop(ctx))
    advance(t, 300_000)
    await flush()
    assert.equal(ctx.said.length, 0)
  }
})

test('主动招呼：刚进场的人被跳过（欢迎插件刚 @ 过，不能连着两条）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg({ minAgeSec: 20, withinSec: 600 }), {
    entries: [['1001', '刚进来', 5_000], ['1002', '待会儿了', 60_000]],
  })
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.said[0].reply.uid, '1002')
})

test('主动招呼：早走了的人不在候选里', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg({ minAgeSec: 0, withinSec: 60 }), {
    entries: [['1001', '一小时前', 3_600_000], ['1002', '刚才', 30_000]],
  })
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.said[0].reply.uid, '1002')
})

test('主动招呼：优先挑刚说过话的人，B站 才挂得出 @', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg({ minAgeSec: 0, withinSec: 600 }), {
    entries: [['1001', '很久没说话', 3_600_000]],
    speakers: {
      recent: () => [{ uid: '2002', name: '正在聊', lastSpokeAt: Date.now() - 5_000 }],
    },
  })
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.said[0].reply.uid, '2002', '刚说话的人一定还在房间，@ 才生效')
})

test('主动招呼：高能榜确认在线时，正文不重复名字、仍挂结构化 @', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg({ minAgeSec: 0, templates: ['你好 {用户}'] }), {
    entries: [['1001', '甲', 60_000]],
    presence: { has: async () => true },
  })
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.said[0].text, '你好', '@ 标签会显示名字，正文不再重复')
  assert.deepEqual(ctx.said[0].reply, { uid: '1001', uname: '甲' })
})

test('主动招呼：高能榜没命中时，正文自己带名字、不传 reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg({ minAgeSec: 0, templates: ['你好 {用户}'] }), {
    entries: [['1001', '甲', 60_000]],
    presence: { has: async () => false },
  })
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.said[0].text, '你好 甲', '没确认在线就不能指望 B站 挂 @')
  assert.equal(ctx.said[0].reply, null)
})

test('主动招呼：查在线失败按「无法确认」处理，降级成不带 @ 的文本', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg({ minAgeSec: 0, templates: ['{用户}，来聊会儿'] }), {
    entries: [['1001', '甲', 60_000]],
    presence: { has: async () => { throw new Error('rank timeout') } },
  })
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.said[0].text, '甲，来聊会儿')
  assert.equal(ctx.said[0].reply, null)
})

test('主动招呼：presence.has 同步抛错也按「无法确认」降级，不能把定时器炸掉', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg({ minAgeSec: 0, templates: ['你好 {用户}'] }), {
    entries: [['1001', '甲', 60_000]],
    presence: { has: () => { throw new Error('boom') } },
  })
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.said[0].text, '你好 甲')
  assert.equal(ctx.said[0].reply, null)
})

test('主动招呼：查在线没回来之前，下一轮不能重复挑人再发一条', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = fakeCtx(cfg({ minAgeSec: 0, templates: ['你好 {用户}'] }), {
    entries: [['1001', '甲', 60_000]],
    presence: { has: () => gate },
  })
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 0, '还卡在查榜，不该先发')

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 0, '查榜未回时不能重复挑人')

  release(true)
  await flush()
  assert.equal(ctx.said.length, 1, '查完只发一条')
})

test('主动招呼：文案超长时跳过这一轮，不发半句、不刷日志', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const long = '这是一条明显超过B站弹幕长度上限的招呼语'.repeat(4)
  const ctx = fakeCtx(cfg({ templates: [long] }))
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 0, '截断后半句话比不说更糟')
  assert.equal(ctx.warns.length, 1, '只提示一次，不能每 5 秒刷一条')
  assert.match(ctx.warns[0], /超过/)
})

test('主动招呼：改间隔 / 关掉开关都在下一轮生效，不用重启', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg({ intervalSec: 600 }))
  autocall.onStart(ctx)
  t.after(() => autocall.onStop(ctx))

  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 0, '600 秒间隔，300 秒时不该说')

  ctx.config.intervalSec = 60
  advance(t, 5_000)
  await flush()
  assert.equal(ctx.said.length, 1, '改小后 5 秒内见效')

  ctx.config.enabled = false
  advance(t, 300_000)
  await flush()
  assert.equal(ctx.said.length, 1, '关掉后不许再说')
})

test('主动招呼：onStop 清掉定时器，停了之后推进时间也不再说', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = fakeCtx(cfg())
  autocall.onStart(ctx)
  autocall.onStop(ctx)
  advance(t, 600_000)
  await flush()
  assert.equal(ctx.said.length, 0)
})

test('主动招呼：两个房间各自挑人，计时器/游标/冷却不串味（scratch）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const a = fakeCtx(cfg(), { entries: [['1001', '甲', 60_000]] })
  const b = fakeCtx(cfg(), { entries: [['2002', '乙', 60_000]] })
  autocall.onStart(a)
  autocall.onStart(b)
  t.after(() => {
    autocall.onStop(a)
    autocall.onStop(b)
  })

  advance(t, 300_000)
  await flush()
  assert.equal(a.said.length, 1)
  assert.equal(b.said.length, 1)
  assert.equal(a.said[0].reply.uid, '1001')
  assert.equal(b.said[0].reply.uid, '2002', 'B 不能被 A 的冷却表挡住')
  assert.equal(a.scratch.called.has('2002'), false)
  assert.equal(b.scratch.called.has('1001'), false)
})

/* ══════════════════ 插件契约 ══════════════════ */

test('主动招呼：manifest 合法、默认关闭、不认领任何事件', () => {
  const dir = join(process.cwd(), 'plugins', 'autocall')
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  assert.deepEqual(validateManifest(m, 'autocall'), [])
  assert.deepEqual(m.claims, {}, '绝不声明 claims：靠事件流挑人会与 welcome 抢优先级')
  assert.equal(defaultsOf(m).enabled, false, '默认必须关闭')
  assert.equal(autocall.onEvent({}, { type: 'ENTER' }), false)
  assert.equal(autocall.id, 'autocall')
})

test('主动招呼：经真实 PluginHost 加载后，开启即可自己 @（全链路集成）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const dir = join(process.cwd(), 'plugins')
  // 把其他插件的业务开关全关掉：startAll() 会调用所有插件的 onStart，
  // 不想让它们的定时器在假时钟推进时插话。动态生成，新增插件时不会漏。
  const configs = {}
  for (const name of readdirSync(dir)) {
    const m = JSON.parse(readFileSync(join(dir, name, 'manifest.json'), 'utf8'))
    configs[m.id] = { enabled: false }
  }
  configs.autocall = { enabled: true, intervalSec: 60, templates: ['你好 {用户}'] }

  const said = []
  const host = new PluginHost({
    dir,
    configs,
    roster: makeRoster([['1001', '甲', 60_000]]),
    getState: () => ({ state: 'live', roomId: '9001' }),
    say: async (o) => {
      said.push(o)
      return { ok: true }
    },
    log: SILENT,
  })

  await host.load()
  await host.startAll()
  t.after(() => host.stopAll())

  assert.deepEqual(host.errors, [], '真实动态 import 必须全部成功（相对路径不能错）')
  assert.ok(host.plugins.has('autocall'), '插件要真的被目录扫描加载进来')

  advance(t, 60_000)
  await flush()

  assert.equal(said.length, 1, '不用人点、没有事件，时间到了就得自己开口')
  assert.equal(said[0].text, '你好 甲')
  assert.equal(said[0].reason, 'autocall')
  assert.equal(said[0].source, 'autocall')
  assert.deepEqual(said[0].reply, { uid: '1001', uname: '甲' }, '经宿主包装后 reply 不能丢')
  assert.equal(host.plugins.get('autocall').stats.sent, 1)
})
