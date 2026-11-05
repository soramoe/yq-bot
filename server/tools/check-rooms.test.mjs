/**
 * 多房间自检。
 *
 * 这一层最容易出的错**全是静默的**：两个房间的数字混在一起、
 * 后台房间的事件推到了当前页面、切回来发现缓冲是空的 ——
 * 没有一条会抛异常，页面上只会"看起来数字不对"。
 *
 * 所以这里不连 B站：注入一个假运行体（`createRunner`），
 * 只验 App 层的账 —— 谁在跑、谁在看、事件进了谁的缓冲。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import App, { normalizeRoomId } from '../app.mjs'
import { buildRoutes } from '../http/api.mjs'
import { MAX_BIG_SPEND_BATTERY } from '../core/patrons.mjs'
import { MAX_GOAL_BATTERY } from '../core/goal.mjs'

const SILENT = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * 假宿主。
 *
 * 只实现 App 层会碰的那几个方法。关键在于它**每个房间一份**，
 * 和线上一致（PluginHost 是 RoomRunner 里 `_wire()` 建出来的）——
 * 这条正是"配置只改到当前房间"那个 bug 的载体。
 */
class FakeHost {
  constructor(configs = {}, enabled = {}) {
    /** id → 当前生效的配置（模拟 coerceConfig 之后的形状） */
    this.config = { ...configs }
    /** id → 是否启用 */
    this.enabled = { ...enabled }
    this.updates = 0
  }

  updateConfig(id, patch) {
    this.updates++
    this.config[id] = { ...(this.config[id] ?? {}), ...patch }
    return { ...this.config[id] }
  }

  resetConfig(id) {
    this.updates++
    delete this.config[id]
    return {}
  }

  setEnabled(id, on) {
    this.updates++
    this.enabled[id] = Boolean(on)
    return true
  }

  snapshot() {
    return { dir: 'fake', count: 0, errors: [], plugins: [] }
  }

  stats() {
    return []
  }
}

/** 假闸门：只关心 dryRun 有没有被改到 */
class FakeGate {
  constructor(dryRun) {
    this.config = { dryRun }
    this.updates = 0
    this.said = []
  }

  update(patch) {
    this.updates++
    Object.assign(this.config, patch)
    return { ...this.config }
  }

  snapshot() {
    return { dryRun: this.config.dryRun, counters: {} }
  }

  /** 播报：记录但不真的发弹幕 */
  async say(opts) {
    this.said.push(opts)
    return { ok: true, dryRun: this.config.dryRun, text: opts.text }
  }
}

/**
 * 假运行体。
 *
 * `realRoomId` 故意和输入号不同 —— 线上短号会被解析成真实号，
 * 而"先打短号再打真实号"必须是同一个房间，这条只有让两个号不同才测得出来。
 */
class FakeRunner extends EventEmitter {
  /** 前 N 次 start() 失败。每个用例开始时记得归零 */
  static failNext = 0

  constructor(args) {
    super()
    this.inputRoomId = String(args.roomId)
    this.realRoomId = Number(this.inputRoomId) + 1_000_000
    this.args = args
    this.stops = 0
    this.started = false
    this.log_ = null
    this.projection = null
    this.roster = null
    this.client = null
    this.host = new FakeHost(args.pluginConfigs, args.pluginEnabled)
    this.gate = new FakeGate(args.dryRun)
    this.dryRun = args.dryRun
    this.info = { title: `房间${this.inputRoomId}`, liveState: 'live' }
    this.danmaku = 0
  }

  async start() {
    // 前 N 次启动直接失败：用来验证"失败之后还能再试一次"
    if (FakeRunner.failNext > 0) {
      FakeRunner.failNext--
      this.started = false
      throw new Error('模拟启动失败')
    }
    this.started = true
    return this
  }

  async stop() {
    this.stops++
    this.started = false
  }

  stats() {
    return { state: 'live', danmaku: this.danmaku, sessionId: `s-${this.inputRoomId}` }
  }

  snapshot() {
    return { roomId: this.realRoomId }
  }

  /** 模拟一条事件进这个房间 */
  push(rec, edge) {
    if (rec.type === 'DANMAKU') this.danmaku++
    this.emit('event', rec, null, edge)
  }
}

/** 一个计数器，保证每次构造的实例都能被找到 */
const made = []
function makeApp(t, { rooms = ['100'], activeRoomId = '', cfg = {}, fetchImpl, log } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'yy3-rooms-'))
  if (Object.keys(cfg).length || rooms.length) {
    writeFileSync(
      join(dataDir, 'app.json'),
      JSON.stringify({ rooms, activeRoomId, ...cfg }),
      'utf8',
    )
  }

  made.length = 0
  FakeRunner.failNext = 0
  const app = new App({
    dataDir,
    roomId: rooms[0],
    dryRun: true,
    log: log ?? SILENT,
    fetchImpl,
    createRunner: (args) => {
      const r = new FakeRunner(args)
      made.push(r)
      return r
    },
  })

  t.after(async () => {
    await app.stop()
  })
  return { app, dataDir }
}

const evt = (seq, type = 'DANMAKU') => ({ seq, ts: 1_700_000_000_000 + seq, type, payload: {} })

/* ══════════════════ 房间号 ══════════════════ */

test('房间号：去前导零、拒绝非数字（"00123" 和 "123" 是同一间）', () => {
  assert.equal(normalizeRoomId(' 00123 '), '123')
  assert.equal(normalizeRoomId(123), '123')
  assert.equal(normalizeRoomId('0'), '0')
  for (const bad of ['', 'abc', '12 34', '1234567890123', null, undefined, {}, '-1']) {
    assert.throws(() => normalizeRoomId(bad), /纯数字/, `应当拒绝：${String(bad)}`)
  }
})

/* ══════════════════ 启动与激活 ══════════════════ */

test('启动：配置里有几个房间就起几个，页面打开的是上次在看的那间', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200', '300'], activeRoomId: '200' })
  await app.start()

  assert.equal(app.rooms.size, 3, '三个房间都要在跑')
  assert.equal(app.activeKey, '200', '激活的是记住的那间')
  assert.equal(app.runner.inputRoomId, '200', 'this.runner 必须指向当前这间')
  assert.equal(app.roomId, 1_000_200, '对外报的是真实房间号')

  for (const r of made) assert.equal(r.started, true)
})

test('启动：记住的房间号已经不在列表里时，退回第一个（不能什么都不显示）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'], activeRoomId: '999' })
  await app.start()
  assert.equal(app.activeKey, '100')
})

/* ══════════════════ 切换 ══════════════════ */

test('切换：切到已在跑的房间不重建、不断流', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'] })
  await app.start()
  const before = made.length
  const other = app.rooms.get('200').runner

  await app.switchRoom('200')

  assert.equal(app.activeKey, '200')
  assert.equal(made.length, before, '不许新建运行体')
  assert.equal(other.stops, 0, '切视图不等于停房间 —— 停了之后回来要重连 + 重放')
  assert.equal(app.rooms.get('100').runner.stops, 0)
})

test('切换：打开一个新房间，旧房间继续跑', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()
  const first = app.rooms.get('100').runner

  await app.switchRoom('777')

  assert.equal(app.rooms.size, 2)
  assert.equal(app.activeKey, '777')
  assert.equal(first.stops, 0, '旧房间不该被停掉，否则"多房间"就没有意义')
  assert.equal(first.started, true)
})

test('切换：短号解析出真实号之后，再用真实号打开不会开出第二份', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()
  const realId = app.rooms.get('100').runner.realRoomId // 1000100

  await app.switchRoom(String(realId))

  assert.equal(app.rooms.size, 1, '同一个直播间的两个号不能各开一份：长连翻倍、日志写两处')
  assert.equal(app.activeKey, '100')
})

test('切换：超过上限时明确拒绝，而不是默默多跑一条长连', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()
  for (let i = 1; i <= 9; i++) await app.switchRoom(String(500 + i))
  assert.equal(app.rooms.size, 10)

  await assert.rejects(() => app.switchRoom('999'), /最多同时跑/)
  assert.equal(app.rooms.size, 10, '被拒绝之后不能留下半个房间')
})

/* ══════════════════ 事件隔离 ══════════════════ */

test('事件：后台房间的事件不进当前缓冲，也不推到页面', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'] })
  await app.start()

  const seen = []
  app.subscribe((m) => seen.push(m))

  const r100 = app.rooms.get('100').runner
  const r200 = app.rooms.get('200').runner

  r200.push(evt(1))
  assert.equal(app.events.length, 0, '当前看的是 100，200 的弹幕不能算进来')
  assert.equal(seen.filter((m) => m.type === 'event').length, 0, '后台房间的事件不该推到页面')

  r100.push(evt(2))
  assert.equal(app.events.length, 1)
  assert.equal(seen.filter((m) => m.type === 'event').length, 1)
})

test('事件：切回后台房间时，它的事件还在（不用重新读日志）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'] })
  await app.start()

  app.rooms.get('200').runner.push(evt(7))
  await app.switchRoom('200')

  assert.equal(app.events.length, 1, '切回来是空的就是"后台房间把事件丢了"')
  assert.equal(app.events[0].seq, 7)
  assert.equal(app.recentEvents({}).events.length, 1)
})

test('事件：seq 重复的不会被记两次（补发重叠）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()
  const r = app.rooms.get('100').runner

  r.push(evt(3))
  r.push(evt(3))
  r.push(evt(2))
  assert.equal(app.events.length, 1)
})

/* ══════════════════ 关闭 ══════════════════ */

test('关闭：只停这一个；关掉当前房间会自动切到剩下的一间', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'] })
  await app.start()
  assert.equal(app.activeKey, '100')

  const r100 = app.rooms.get('100').runner
  const r200 = app.rooms.get('200').runner

  await app.closeRoom('100')

  assert.equal(r100.stops, 1, '关掉的那个要停')
  assert.equal(r200.stops, 0, '没关的不能受牵连')
  assert.equal(app.rooms.size, 1)
  assert.equal(app.activeKey, '200', '主动关掉当前房间后必须自动切走，不能留一个空视图')
  assert.equal(app.runner, r200)
})

test('关闭：只剩一个房间时拒绝（关完就再也没有数据源了）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()

  await assert.rejects(() => app.closeRoom('100'), /至少要留一个/)
  assert.equal(app.rooms.size, 1)
  assert.equal(app.rooms.get('100').runner.stops, 0)
})

/* ══════════════════ 配置持久化 ══════════════════ */

test('配置：房间列表和"上次在看的那间"都要落盘（重启后回到原样）', async (t) => {
  const { app, dataDir } = makeApp(t, { rooms: ['100'] })
  await app.start()
  await app.switchRoom('200')
  await app.switchRoom('100')

  const cfg = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8'))
  assert.deepEqual(cfg.rooms.sort(), ['100', '200'], '开了几个房间要记住')
  assert.equal(cfg.activeRoomId, '100', '否则重启后页面跳到另一间，像是自己乱切')
})

/* ══════════════════ 配置要作用到每个房间 ══════════════════ */

/**
 * 这一组的存在理由：插件配置和演练开关**存在 App 上**（文案属于主播人设，
 * 换个直播间不该变成另一套），但真正生效的是**每个房间各自的宿主/闸门**。
 * 只改当前那间的话，切到后台房间会看到旧文案 —— 而且切回来又对了，
 * 表现像随机故障；演练开关更糟：用户以为已经静音，后台房间还在真发弹幕。
 *
 * 两个现象都不报错，所以只能靠断言钉住。
 */

test('插件配置：改一次要同步到所有房间的宿主', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'], cfg: { plugins: { welcome: { template: '旧文案' } } } })
  await app.start()

  app.updatePluginConfig('welcome', { template: '新文案' })

  for (const [key, room] of app.rooms) {
    assert.equal(
      room.runner.host.config.welcome?.template,
      '新文案',
      `房间 ${key} 的宿主没跟上：切过去就会看到旧文案`,
    )
  }
})

test('插件配置：在后台房间改，切回原房间也不能留着旧值', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'] })
  await app.start()

  await app.switchRoom('200')
  app.updatePluginConfig('gift', { template: '谢谢{用户}' })
  await app.switchRoom('100')

  assert.equal(app.runner.host.config.gift?.template, '谢谢{用户}', '切回来读到的是旧配置')
})

test('插件停用：宿主级开关对每个房间都生效', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'] })
  await app.start()

  app.setPluginEnabled('blind', false)
  for (const [key, room] of app.rooms) {
    assert.equal(room.runner.host.enabled.blind, false, `房间 ${key} 的盲盒还开着`)
  }

  app.setPluginEnabled('blind', true)
  for (const [key, room] of app.rooms) {
    assert.notEqual(room.runner.host.enabled.blind, false, `房间 ${key} 没恢复`)
  }
})

test('插件配置：恢复默认也要恢复所有房间', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'], cfg: { plugins: { welcome: { template: '旧文案' } } } })
  await app.start()

  app.resetPluginConfig('welcome')

  for (const [key, room] of app.rooms) {
    assert.equal(room.runner.host.config.welcome, undefined, `房间 ${key} 还留着用户配置`)
  }
})

test('演练开关：一次切换要让所有房间都跟着变（否则后台房间会真发弹幕）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200', '300'] })
  await app.start()

  app.setDryRun(false)
  for (const [key, room] of app.rooms) {
    assert.equal(room.runner.gate.config.dryRun, false, `房间 ${key} 的闸门还是演练模式`)
    assert.equal(room.runner.dryRun, false, `房间 ${key} 的运行体还认为自己在演练`)
  }

  app.setDryRun(true)
  for (const [key, room] of app.rooms) {
    assert.equal(room.runner.gate.config.dryRun, true, `房间 ${key} 没回到演练模式`)
  }
})

test('新开的房间：带上的是**当前**配置，不是开机那一刻的', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()

  app.updatePluginConfig('welcome', { template: '后改的' })
  app.setDryRun(false)

  await app.switchRoom('400')
  const fresh = app.rooms.get('400').runner

  assert.equal(fresh.host.config.welcome?.template, '后改的', '新房间拿到的是旧配置')
  assert.equal(fresh.gate.config.dryRun, false, '新房间拿到的是旧演练模式')
})

/* ══════════════════ 接口 ══════════════════ */

/** 收集 JSON 响应的小桩：不需要真的开端口 */
function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code
    },
    end(buf) {
      this.body = String(buf ?? '')
    },
  }
}

test('接口：GET /api/rooms 给出 active 与每个房间的状态', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'], activeRoomId: '200' })
  await app.start()
  app.rooms.get('100').runner.push(evt(1))
  app.rooms.get('100').runner.push(evt(2))

  const routes = buildRoutes(app)
  const res = fakeRes()
  await routes.match('GET', '/api/rooms').handler({ res, url: new URL('http://x/api/rooms'), app })

  const data = JSON.parse(res.body)
  assert.equal(data.active, '200')
  assert.equal(data.rooms.length, 2)

  const first = data.rooms.find((r) => r.key === '100')
  assert.equal(first.roomId, 1_000_100, '对外显示真实房间号')
  assert.equal(first.danmaku, 2)
  assert.equal(first.active, false)
  assert.equal(data.rooms.find((r) => r.key === '200').active, true)
})

test('接口：POST /api/rooms/close 缺 roomId 时 400，不是把房间关了', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'] })
  await app.start()

  const routes = buildRoutes(app)
  const res = fakeRes()
  const { Readable } = await import('node:stream')
  const req = Readable.from([Buffer.from('{}')])
  req.headers = { 'content-type': 'application/json' }

  await routes.match('POST', '/api/rooms/close').handler({
    req,
    res,
    url: new URL('http://x/api/rooms/close'),
    app,
  })

  assert.equal(res.statusCode, 400)
  assert.equal(app.rooms.size, 2, '参数不对不能真去关房间')
})

/* ══════════════════ 开播 / 下播提醒 ══════════════════ */

test('提醒：后台房间开播也要通知（这是这个功能的全部意义）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100', '200'], activeRoomId: '100' })
  await app.start()
  const seen = []
  app.subscribe((m) => seen.push(m))

  app.rooms.get('200').runner.push(
    { seq: 9, ts: 1_700_000_009_000, type: 'LIVE_START', payload: { liveTime: 1 } },
    'live_started',
  )

  const notices = seen.filter((m) => m.type === 'notice')
  assert.equal(notices.length, 1, '页面正看着 100，200 开播也必须能知道')
  assert.match(notices[0].data.text, /1000200/, '要说清是哪间')
  assert.match(notices[0].data.text, /开播/)
  assert.doesNotMatch(notices[0].data.text, /undefined|NaN/)
})

test('提醒：下播也通知，且文案和开播区分得开', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()
  const seen = []
  app.subscribe((m) => seen.push(m))

  app.rooms.get('100').runner.push(
    { seq: 5, ts: 1_700_000_010_000, type: 'LIVE_END', payload: {} },
    'live_ended',
  )
  const text = seen.find((m) => m.type === 'notice')?.data.text ?? ''
  assert.match(text, /下播/)
})

test('提醒：同一条事件重放两次只响一次（seq 相同）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()
  const seen = []
  app.subscribe((m) => seen.push(m))

  const rec = { seq: 2, ts: 1_700_000_017_000, type: 'LIVE_START', payload: {} }
  const r = app.rooms.get('100').runner
  r.push(rec, 'live_started')
  r.push(rec, 'live_started')

  assert.equal(seen.filter((m) => m.type === 'notice').length, 1, '补发重叠不能让开播提醒响两遍')
})

test('提醒：启动校准补的开播/下播不通知（那不是"此刻"发生的事）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()
  const seen = []
  app.subscribe((m) => seen.push(m))

  app.rooms.get('100').runner.push(
    { seq: 3, ts: 1_700_000_011_000, type: 'LIVE_START', payload: { synthetic: true } },
    'live_started',
  )
  app.rooms.get('100').runner.push(
    { seq: 4, ts: 1_700_000_012_000, type: 'LIVE_END', payload: { synthetic: true } },
    'live_ended',
  )

  assert.equal(seen.filter((m) => m.type === 'notice').length, 0)
})

test('提醒：重连补的 inferred 边沿要提醒（它确实发生过）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()
  const seen = []
  app.subscribe((m) => seen.push(m))

  app.rooms.get('100').runner.push(
    { seq: 2, ts: 1_700_000_018_000, type: 'LIVE_START', payload: { inferred: true } },
    'live_started',
  )

  assert.equal(seen.filter((m) => m.type === 'notice').length, 1, '断线期间开播了，重连后要补提醒')
})

test('提醒：不是边沿的重复 LIVE_START 不通知（状态机已判重复推送）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()
  const seen = []
  app.subscribe((m) => seen.push(m))

  app.rooms.get('100').runner.push(
    { seq: 1, ts: 1_700_000_013_000, type: 'LIVE_START', payload: {} },
    null,
  )
  assert.equal(seen.filter((m) => m.type === 'notice').length, 0, '没有边沿就只是普通事件')
})

test('提醒：配置了 webhook 就按对应平台的形状 POST', async (t) => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200 }
  }
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { notifyWebhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' },
    fetchImpl,
  })
  await app.start()

  app.rooms.get('100').runner.push(
    { seq: 2, ts: 1_700_000_014_000, type: 'LIVE_START', payload: {} },
    'live_started',
  )
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(calls.length, 1, '开播要真的发一次 webhook')
  assert.equal(calls[0].url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.msgtype, 'text', '企微/钉钉的形状')
  assert.match(body.text.content, /开播/)
})

test('提醒：webhook 失败不能拖垮通知本身（页内 toast 照发）', async (t) => {
  const fetchImpl = async () => {
    throw new Error('对方 502')
  }
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { notifyWebhook: 'https://example.com/hook' },
    fetchImpl,
  })
  await app.start()
  const seen = []
  app.subscribe((m) => seen.push(m))

  app.rooms.get('100').runner.push(
    { seq: 2, ts: 1_700_000_015_000, type: 'LIVE_START', payload: {} },
    'live_started',
  )
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(seen.filter((m) => m.type === 'notice').length, 2, 'webhook 挂了页内通知还在，并补一条失败提示')
  const warn = seen.find((m) => m.type === 'notice' && m.data?.level === 'warn')
  assert.match(warn.data.text, /webhook 没发出去/)
})

test('提醒：平台回 HTTP 200 但 errcode 非 0 也算失败（不能静默）', async (t) => {
  const cases = [
    ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', { errcode: 93000, errmsg: 'invalid webhook url' }],
    ['https://oapi.dingtalk.com/robot/send?access_token=t', { errcode: 310000, errmsg: 'sign not match' }],
    ['https://open.feishu.cn/open-apis/bot/v2/hook/abc', { code: 19001, msg: 'param invalid' }],
  ]

  for (const [url, body] of cases) {
    const seen = []
    const { app } = makeApp(t, {
      rooms: ['100'],
      cfg: { notifyWebhook: url },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }),
    })
    await app.start()
    app.subscribe((m) => seen.push(m))
    app.rooms.get('100').runner.push(
      { seq: 2, ts: 1_700_000_017_000, type: 'LIVE_START', payload: {} },
      'live_started',
    )
    await new Promise((r) => setTimeout(r, 30))

    const warn = seen.find((m) => m.type === 'notice' && m.data?.level === 'warn')
    assert.ok(warn, `${url} 的失败要显示出来`)
    assert.match(warn.data.text, /webhook 没发出去/)
  }
})

test('webhook 失败判定：飞书 code=0 / 自建网关 code=200 都不能误判', async () => {
  const { webhookError, sendWebhook } = await import('../core/notify.mjs')

  assert.equal(webhookError('https://open.feishu.cn/open-apis/bot/v2/hook/x', { code: 0 }), '')
  assert.match(webhookError('https://open.feishu.cn/open-apis/bot/v2/hook/x', { code: 19001, msg: 'bad' }), /19001/)
  assert.equal(webhookError('https://gw.example.com/hook', { code: 200 }), '', '自建网关的 code=200 不是失败')
  assert.equal(webhookError('https://qyapi.weixin.qq.com/hook', { errcode: 0 }), '')
  assert.equal(webhookError('https://qyapi.weixin.qq.com/hook', null), '')

  const { buildWebhookPayload } = await import('../core/notify.mjs')
  const lark = buildWebhookPayload('https://open.larksuite.com/open-apis/bot/v2/hook/x', '开播了')
  assert.equal(lark.msg_type, 'text', 'Lark 与飞书同形')

  const res = await sendWebhook('https://qyapi.weixin.qq.com/hook', 'text', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ errcode: 93000, errmsg: 'bad' }) }),
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /93000/)
})

test('提醒：发送失败的日志只留域名，不把 webhook 密钥抄进日志', async (t) => {
  const warns = []
  const log = { debug() {}, info() {}, warn(m) { warns.push(String(m)) }, error() {} }
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { notifyWebhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET' },
    fetchImpl: async () => {
      throw new Error('对方 502')
    },
    log,
  })
  await app.start()
  app.rooms.get('100').runner.push(
    { seq: 2, ts: 1_700_000_016_000, type: 'LIVE_START', payload: {} },
    'live_started',
  )
  await new Promise((r) => setTimeout(r, 30))

  const hit = warns.find((m) => m.includes('webhook 发送失败'))
  assert.ok(hit, '失败要留一条日志')
  assert.ok(!hit.includes('SECRET'), 'query 里的密钥不能进日志')
  assert.match(hit, /qyapi\.weixin\.qq\.com/, '至少留域名，知道发给了哪家')
})

test('脱敏：飞书的 key 在路径里，也必须一起藏掉', async () => {
  const { maskWebhook } = await import('../core/notify.mjs')
  assert.equal(maskWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/abc-123'), 'https://open.feishu.cn/…')
  assert.equal(maskWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k'), 'https://qyapi.weixin.qq.com/…')
  assert.equal(maskWebhook(''), '', '没配就没有可脱敏的')
  assert.equal(maskWebhook('not a url'), '…', '认不出的更不能原样打')
})

test('webhook 载荷：飞书与企微/钉钉用各自的字段名', async () => {
  const { buildWebhookPayload } = await import('../core/notify.mjs')
  const wecom = buildWebhookPayload('https://qyapi.weixin.qq.com/hook', '开播了')
  assert.equal(wecom.msgtype, 'text')
  assert.equal(wecom.text.content, '开播了')

  const ding = buildWebhookPayload('https://oapi.dingtalk.com/robot/send?token=t', '开播了')
  assert.equal(ding.msgtype, 'text', '钉钉与企微同形')
  assert.equal(ding.text.content, '开播了')

  const feishu = buildWebhookPayload('https://open.feishu.cn/open-apis/bot/v2/hook/x', '开播了')
  assert.equal(feishu.msg_type, 'text', '飞书是 msg_type + content.text')
  assert.equal(feishu.content.text, '开播了')

  const generic = buildWebhookPayload('https://example.com/hook', '开播了')
  assert.equal(generic.msgtype, 'text', '认不出的地址按企微/钉钉形状发')
})

test('战报：文案带时长、观众、三类收入与 Top 送礼', async () => {
  const { reportText } = await import('../core/notify.mjs')
  const text = reportText({
    roomId: 42,
    title: '测试间',
    summary: {
      durationSec: 3720,
      uniqueViewers: 12,
      danmaku: 34,
      giftCount: 2,
      giftBattery: 300,
      guardCount: 1,
      guardBattery: 1980,
      scCount: 1,
      scBattery: 100,
      totalBattery: 2380,
    },
    topGifters: [{ name: '甲', battery: 200 }, { name: '乙', battery: 100 }],
  })

  assert.match(text, /^【本场战报】房间 42 · 测试间/)
  assert.match(text, /时长 1 小时 2 分/)
  assert.match(text, /观众 12 · 弹幕 34/)
  assert.match(text, /礼物 2 个 ¥30/)
  assert.match(text, /舰长 1 个 ¥198/)
  assert.match(text, /SC 1 条 ¥10/)
  assert.match(text, /总收入 ¥238/)
  assert.match(text, /Top 送礼：甲 ¥20、乙 ¥10/)
})

test('战报：推算的结束时间和未知起点都要在文案里说清楚', async () => {
  const { reportText } = await import('../core/notify.mjs')
  const text = reportText({
    roomId: 42,
    summary: { durationSec: 600, implicit: true, endedAtEstimated: true, danmaku: 3 },
  })

  assert.match(text, /约 10 分钟（起点未知）/, '不能把推算值说得像精确值')
  assert.match(text, /本场没有礼物、舰长或 SC/)
  assert.doesNotMatch(text, /总收入/)
})

test('提醒：开了战报后，下播先发提醒、再发本场战报', async (t) => {
  const calls = []
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { notifyWebhook: 'https://qyapi.weixin.qq.com/hook', notifyReport: true },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200 }
    },
  })
  await app.start()

  // 假运行体没有投影，这里挂一个最小投影：App 只读 snapshot() 和 session
  app.rooms.get('100').runner.projection = {
    session: { endedAtEstimated: false },
    snapshot: () => ({
      liveStartedAt: 1_700_000_000_000,
      liveEndedAt: 1_700_000_600_000,
      sessionImplicit: false,
      uniqueViewers: 12,
      danmaku: 34,
      giftCount: 2,
      giftBattery: 300,
      guardCount: 1,
      guardBattery: 1980,
      scCount: 1,
      scBattery: 100,
      topGifters: [{ name: '甲', battery: 200 }],
    }),
  }

  app.rooms.get('100').runner.push(
    { seq: 1, ts: 1_700_000_700_000, type: 'LIVE_END', payload: {} },
    'live_ended',
  )
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(calls.length, 2, '一条下播提醒 + 一条战报')
  const notice = JSON.parse(calls[0].init.body).text.content
  assert.match(notice, /【下播】/)
  const report = JSON.parse(calls[1].init.body).text.content
  assert.match(report, /【本场战报】/)
  assert.match(report, /观众 12 · 弹幕 34/)
  assert.match(report, /总收入 ¥238/)
})

test('提醒：战报按边沿当下取数，重连开新场也不能把这一场串成空账', async (t) => {
  const calls = []
  let release = null
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { notifyWebhook: 'https://qyapi.weixin.qq.com/hook', notifyReport: true },
    fetchImpl: (url, init) => {
      calls.push({ url, init })
      return new Promise((resolve) => {
        release = resolve
      })
    },
  })
  await app.start()

  // 提醒的 webhook 卡在半路时，现场已经重连并开了新一场：
  // 投影的 session / snapshot 都换成新场。战报若在这之后才取数就会串账。
  let phase = 'old'
  let snapCalls = 0
  const runner = app.rooms.get('100').runner
  runner.projection = {
    get session() {
      return phase === 'old' ? { endedAtEstimated: false } : { endedAtEstimated: false }
    },
    snapshot: () => {
      snapCalls++
      if (phase === 'old') {
        return {
          liveStartedAt: 1_700_000_000_000,
          liveEndedAt: 1_700_000_600_000,
          uniqueViewers: 12,
          danmaku: 34,
          giftCount: 1,
          giftBattery: 2380,
          topGifters: [{ name: '甲', battery: 200 }],
        }
      }
      return { liveStartedAt: 1_700_001_000_000, uniqueViewers: 0, danmaku: 0 }
    },
  }

  runner.push({ seq: 1, ts: 1_700_000_700_000, type: 'LIVE_END', payload: {} }, 'live_ended')
  assert.equal(calls.length, 1, '提醒先发出')
  assert.equal(snapCalls, 1, '取数必须发生在边沿当下，不能等 webhook 回来')

  phase = 'new'
  release({ ok: true, status: 200 })
  for (let i = 0; i < 10 && calls.length < 2; i++) await new Promise((r) => setImmediate(r))

  assert.equal(calls.length, 2, '提醒之后补发战报')
  release({ ok: true, status: 200 })
  const report = JSON.parse(calls[1].init.body).text.content
  assert.match(report, /观众 12 · 弹幕 34/)
  assert.match(report, /总收入 ¥238/)
  assert.equal(snapCalls, 1, '战报用的是边沿当下的快照，不再读第二遍')
})

test('提醒：没开战报开关时，下播只发提醒', async (t) => {
  const calls = []
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { notifyWebhook: 'https://qyapi.weixin.qq.com/hook' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200 }
    },
  })
  await app.start()
  app.rooms.get('100').runner.projection = {
    session: {},
    snapshot: () => ({ liveStartedAt: 1, liveEndedAt: 2, danmaku: 1 }),
  }
  app.rooms.get('100').runner.push(
    { seq: 1, ts: 1_700_000_700_000, type: 'LIVE_END', payload: {} },
    'live_ended',
  )
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(calls.length, 1)
  assert.match(JSON.parse(calls[0].init.body).text.content, /【下播】/)
})

test('提醒：重启校准的 synthetic 下播不推战报', async (t) => {
  const calls = []
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { notifyWebhook: 'https://qyapi.weixin.qq.com/hook', notifyReport: true },
    fetchImpl: async () => {
      calls.push(1)
      return { ok: true, status: 200 }
    },
  })
  await app.start()
  app.rooms.get('100').runner.projection = {
    session: {},
    snapshot: () => ({ liveStartedAt: 1, liveEndedAt: 2, danmaku: 1 }),
  }
  app.rooms.get('100').runner.push(
    { seq: 1, ts: 1_700_000_700_000, type: 'LIVE_END', payload: { synthetic: true } },
    'live_ended',
  )
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(calls.length, 0, '启动校准不是"刚才下播"，不该推战报')
})

test('提醒：开了战报但运行体没有投影时，不能把提醒拖垮', async (t) => {
  const calls = []
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { notifyWebhook: 'https://qyapi.weixin.qq.com/hook', notifyReport: true },
    fetchImpl: async () => {
      calls.push(1)
      return { ok: true, status: 200 }
    },
  })
  await app.start()
  // FakeRunner.projection 默认就是 null
  app.rooms.get('100').runner.push(
    { seq: 1, ts: 1_700_000_700_000, type: 'LIVE_END', payload: {} },
    'live_ended',
  )
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(calls.length, 1, '提醒照发，战报没有数据就跳过')
})

test('接口：POST /api/notify 校验并保存 webhook，GET 能读回', async (t) => {
  const { app, dataDir } = makeApp(t, { rooms: ['100'] })
  await app.start()

  const routes = buildRoutes(app)
  const { Readable } = await import('node:stream')
  const post = async (body) => {
    const res = fakeRes()
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.headers = { 'content-type': 'application/json' }
    await routes.match('POST', '/api/notify').handler({
      req,
      res,
      url: new URL('http://x/api/notify'),
      app,
    })
    return res
  }

  // 非法地址：路由把带 status 的错误抛给 server.mjs 的兜底处理（HTTP 层会转成 400）
  await assert.rejects(() => post({ webhook: 'javascript:alert(1)' }), (e) => e.status === 400)
  await assert.rejects(
    () => post({ webhook: 'https://qyapi.weixin.qq.com/ho ok' }),
    (e) => e.status === 400,
    '带空白的地址浏览器发不出去，不该被当成已保存',
  )
  await assert.rejects(
    () => post({ webhook: `https://example.com/${'a'.repeat(500)}` }),
    (e) => e.status === 400,
    '超长地址要当场拒绝，不能悄悄截断成半截 URL',
  )

  const good = await post({ webhook: 'https://qyapi.weixin.qq.com/hook' })
  assert.equal(good.statusCode, 200)
  assert.equal(app.notifyWebhook, 'https://qyapi.weixin.qq.com/hook')

  const cleared = await post({ webhook: '' })
  assert.equal(cleared.statusCode, 200, '空串表示关闭，是合法值')
  assert.equal(app.notifyWebhook, '')

  await post({ webhook: 'https://qyapi.weixin.qq.com/hook' })
  const saved = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8'))
  assert.equal(saved.notifyWebhook, 'https://qyapi.weixin.qq.com/hook', '要落盘，重启不能丢')

  const res = fakeRes()
  await routes.match('GET', '/api/notify').handler({ res, url: new URL('http://x/api/notify'), app })
  assert.equal(JSON.parse(res.body).webhook, 'https://qyapi.weixin.qq.com/hook')
})

test('接口：提醒设置能保存/读回"下播战报"开关，没有地址时不能单开战报', async (t) => {
  const { app, dataDir } = makeApp(t, { rooms: ['100'] })
  await app.start()

  const routes = buildRoutes(app)
  const { Readable } = await import('node:stream')
  const post = async (body) => {
    const res = fakeRes()
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.headers = { 'content-type': 'application/json' }
    await routes.match('POST', '/api/notify').handler({
      req,
      res,
      url: new URL('http://x/api/notify'),
      app,
    })
    return res
  }

  const on = await post({ webhook: 'https://qyapi.weixin.qq.com/hook', report: true })
  assert.equal(JSON.parse(on.body).report, true)
  assert.equal(app.notifyReport, true)
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')).notifyReport, true, '开关也要落盘')

  const off = await post({ report: false })
  assert.equal(JSON.parse(off.body).report, false, '只改开关时不用重发地址')

  await assert.rejects(
    () => post({ webhook: '', report: true }),
    (e) => e.status === 400 && e.code === 'report_needs_webhook',
    '没有地址却勾战报，必须当场拒绝',
  )

  await post({ webhook: 'https://qyapi.weixin.qq.com/hook', report: true })
  const cleared = await post({ webhook: '' })
  assert.equal(JSON.parse(cleared.body).report, false, '清空地址要顺带关掉战报，不能留下永远发不出去的开关')

  const read = fakeRes()
  await routes.match('GET', '/api/notify').handler({ res: read, url: new URL('http://x/api/notify'), app })
  assert.equal(JSON.parse(read.body).report, false)
})

test('接口：开了口令后，读 webhook 也要口令（地址本身就是写凭据）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()
  app.access.setPassword('pw-123')

  const routes = buildRoutes(app)
  const read = async (headers = {}) => {
    const res = fakeRes()
    await routes.match('GET', '/api/notify').handler({ req: { headers }, res, url: new URL('http://x/api/notify'), app })
    return res
  }

  const denied = await read()
  assert.equal(denied.statusCode, 401, '口令开着就不能白读 webhook')

  const ok = await read({ 'x-access-token': 'pw-123' })
  assert.equal(ok.statusCode, 200, '解锁之后照常读')
})

test('配置：坏掉/超长的 webhook 不能截断着用，战报开关跟着收掉', async (t) => {
  const longUrl = `https://example.com/${'a'.repeat(600)}`
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { notifyWebhook: longUrl, notifyReport: true },
  })
  await app.start()
  assert.equal(app.notifyWebhook, '', '超长地址不能截断成半截 URL')
  assert.equal(app.notifyReport, false, '没有可用地址，战报开关不能还开着')

  const { app: app2 } = makeApp(t, {
    rooms: ['100'],
    cfg: { notifyWebhook: 'javascript:alert(1)', notifyReport: true },
  })
  await app2.start()
  assert.equal(app2.notifyWebhook, '', '不是 http(s) 的地址在加载时就该被丢掉')
  assert.equal(app2.notifyReport, false)
})

/* ══════════════════ 运行体自己的启动失败 ══════════════════ */

test('运行体：解析房间号失败后还能再试，不能被记成"已启动"', async () => {  /**
   * 这条盯的是一个很难自己恢复的故障：
   *
   * 以前 `started = true` 写在 start() 第一行、失败也不回滚。只要解析房间号
   * 抛一次（断网、B站 接口抖、房间号输错），这个运行体就永久停在
   * "已启动"——再调 start() 直接 return，既没有日志也没有长连，
   * 而 App 那边还以为它好好的。用户看到的是"这间房永远白屏"，只能重启进程。
   */
  const { RoomRunner } = await import('../room-runner.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'yy3-runner-'))

  let calls = 0
  const runner = new RoomRunner({
    roomId: '100',
    dataDir: dir,
    pluginsDir: null,
    resolveRoom: async () => {
      calls++
      throw new Error('网络断了')
    },
  })

  await assert.rejects(() => runner.start(), /网络断了/)
  assert.equal(runner.started, false, '启动失败不能留下 started=true')
  assert.equal(runner.client, null, '半启动的连接要拆掉')

  await assert.rejects(() => runner.start(), /网络断了/)
  assert.equal(calls, 2, '第二次 start 必须真的又试了一遍（而不是直接 return）')
})

test('房间：上一次启动失败，再打开一次会真的重试（不是原地返回）', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  FakeRunner.failNext = 1
  await app.start()

  const room = app.rooms.get('100')
  assert.equal(room.runner.started, false, '先确认这一次确实失败了')

  const before = made.length
  await app.switchRoom('100')

  assert.equal(made.length, before, '不该重建运行体（重建会把它的缓冲一起丢掉）')
  assert.equal(room.runner.started, true, '再点一次必须真的重试启动')
})

test('运行体：ROOM_TITLE 事件要真的更新 info.title（页头与总览都读它）', async () => {
  /**
   * B站 在开播/改标题时会推 ROOM_CHANGE。以前归一化层直接丢弃它，
   * 于是 `runner.info` 只在 start() 填一次 —— 页头标题、房间总览、
   * 将来的开播提醒，显示的永远是启动那一刻的旧标题，进程活多久就旧多久。
   */
  const { RoomRunner } = await import('../room-runner.mjs')
  const { EventLog } = await import('../core/event-log.mjs')
  const { Projection } = await import('../core/projection.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'yy3-title-'))

  const runner = new RoomRunner({ roomId: '100', dataDir: dir, pluginsDir: null })
  // 不走 start()（那会去连 B站），手工把 _ingest 依赖的三样装上
  runner.realRoomId = 100
  runner.log_ = new EventLog({ root: dir, roomId: '100' })
  runner.projection = new Projection('100')
  runner.info = { title: '旧标题', liveState: 'off' }

  runner._ingest({ type: 'ROOM_TITLE', payload: { title: '晚上好，今天聊点新的' } })
  assert.equal(runner.info.title, '晚上好，今天聊点新的')

  // 空标题不许覆盖：ROOM_CHANGE 偶尔推空串，把好标题冲掉就白改了
  runner._ingest({ type: 'ROOM_TITLE', payload: { title: '' } })
  assert.equal(runner.info.title, '晚上好，今天聊点新的')
})

test('重连：ready 后再取一次房间信息，断线期间的上下播要补出边沿', async () => {
  /**
   * B站 长连接断了重连之后，不会补发断线期间的 LIVE / LIVE_END。
   * 只在 start() 校准一次的话，这中间的开播/下播就永久丢了 ——
   * 页面还停在旧状态，下一次提醒也跟着错。
   */
  const { RoomRunner } = await import('../room-runner.mjs')
  const { EventLog } = await import('../core/event-log.mjs')
  const { Projection } = await import('../core/projection.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'yy3-resync-'))

  let live = true
  let fetches = 0
  const runner = new RoomRunner({
    roomId: '100',
    dataDir: dir,
    pluginsDir: null,
    resolveRoom: async () => ({ roomId: 100 }),
    fetchInfo: async () => {
      fetches++
      return { liveState: live ? 'live' : 'offline', title: '标题' }
    },
  })
  // 不走 start()（那会去连 B站），只装 _syncLiveState 需要的东西
  runner.started = true
  runner.realRoomId = 100
  runner.info = { roomId: 100, liveState: 'offline', title: '' }
  runner.log_ = new EventLog({ root: dir, roomId: '100' })
  runner.projection = new Projection('100')

  // 启动时的校准：B站 此刻没播，什么都不补
  runner._syncLiveState(runner.info)
  assert.equal(runner.log_.readAll().length, 0, '启动时没播就不该有事件')

  // 启动之后、第一次 ready 之前开播了。这条补边沿必须标 inferred：
  // 它发生在启动之后，是真开播；标 synthetic 会被提醒层静默掉，而紧接着
  // 真正的 LIVE 事件又会因为同一个 liveTime 被状态机判重，提醒就永久丢了。
  runner._onReady()
  await runner._resyncLive()
  assert.equal(fetches, 1, 'ready 后要再取一次房间信息')
  let last = runner.log_.readAll().at(-1)
  assert.equal(last.type, 'LIVE_START')
  assert.equal(last.payload.inferred, true, '启动后补的开播必须能提醒')
  assert.equal(last.payload.synthetic, undefined, '不能混成启动校准')

  // 断线期间下播了；重连 ready 必须发现并补 LIVE_END，标记 inferred（可提醒）
  live = false
  runner.info = { ...runner.info, liveState: 'live' }
  runner._onReady()
  await runner._resyncLive()
  last = runner.log_.readAll().at(-1)
  assert.equal(last.type, 'LIVE_END')
  assert.equal(last.payload.inferred, true, '重连补的不能当 synthetic 静默掉')
  assert.equal(runner.projection.snapshot().state, 'offline')
})

test('总览：能看出哪一间其实没起来，也能看到每间的数字', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()

  // 新开一间，但让它启动失败
  FakeRunner.failNext = 1
  await app.switchRoom('300')

  const byKey = Object.fromEntries(app.roomsList().map((r) => [r.key, r]))

  /**
   * 这条是"看不清"的典型：`state` 来自投影，一个**从没连上过**的房间
   * 和一间"主播今天没播"的房间，`state` 都是 offline。
   * 只看这一列，用户永远分不清是"没开播"还是"根本没连上，点了也没用"。
   */
  assert.equal(byKey['100'].started, true)
  assert.equal(byKey['300'].started, false, '启动失败必须能和"没开播"区分开')

  // 总览上每一列都要有数据源，缺一个页面上就是一列"—"
  for (const r of app.roomsList()) {
    for (const k of ['danmaku', 'enterCount', 'giftCount', 'giftBattery', 'popularity', 'conn', 'since']) {
      assert.ok(k in r, `roomsList() 缺字段 ${k}`);
    }
  }

  // 连接状态不能只给 liveState：那是"主播的状态"，机器连没连上看的是这个
  assert.equal(byKey['100'].conn, 'idle');
})

/* ══════════════════ 大额提醒 / 付费用户档案 ══════════════════ */

const bigTick = () => new Promise((r) => setTimeout(r, 30))

test('大额提醒：单笔到阈值才响，页内与 webhook 各一次', async (t) => {
  const calls = []
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { bigSpendBattery: 10_000, notifyWebhook: 'https://example.com/hook' },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200 }
    },
  })
  await app.start()
  const seen = []
  app.subscribe((m) => seen.push(m))
  const runner = app.rooms.get('100').runner

  runner.push({
    seq: 1,
    ts: 1_700_000_001_000,
    type: 'GIFT',
    payload: { uid: '7', uname: '甲', giftName: '火箭', battery: 9_999, isPaid: true },
  })
  await bigTick()
  assert.equal(seen.filter((m) => m.type === 'notice').length, 0, '差 1 电池也不响')

  runner.push({
    seq: 2,
    ts: 1_700_000_002_000,
    type: 'GIFT',
    payload: { uid: '7', uname: '甲', giftName: '火箭', battery: 10_000, isPaid: true },
  })
  await bigTick()

  const notices = seen.filter((m) => m.type === 'notice')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].data.level, 'warn')
  assert.equal(notices[0].data.text, '【大额】房间 1000100 · 甲 送出 火箭（¥1000）')

  assert.equal(calls.length, 1, '配了 webhook 就外发')
  assert.equal(calls[0].body.msgtype, 'text')
  assert.match(calls[0].body.text.content, /【大额】房间 1000100 · 甲 送出 火箭/)
})

test('大额提醒：0 = 关闭，免费礼物再大也不响', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'] })
  await app.start()
  const seen = []
  app.subscribe((m) => seen.push(m))
  const runner = app.rooms.get('100').runner

  runner.push({
    seq: 1,
    ts: 1_700_000_003_000,
    type: 'GIFT',
    payload: { uid: '7', uname: '甲', battery: 1_000_000_000, isPaid: true },
  })
  await bigTick()
  assert.equal(seen.filter((m) => m.type === 'notice').length, 0, '默认阈值 0 不提醒')

  app.setBigSpendBattery(100)
  runner.push({
    seq: 2,
    ts: 1_700_000_004_000,
    type: 'GIFT',
    payload: { uid: '8', uname: '乙', battery: 1_000_000_000, isPaid: false },
  })
  await bigTick()
  assert.equal(seen.filter((m) => m.type === 'notice').length, 0, '免费礼物金额是 0')
})

test('大额提醒：webhook 失败不能拖垮页内提示', async (t) => {
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { bigSpendBattery: 500, notifyWebhook: 'https://example.com/hook' },
    fetchImpl: async () => {
      throw new Error('对方 502')
    },
  })
  await app.start()
  const seen = []
  app.subscribe((m) => seen.push(m))

  app.rooms.get('100').runner.push({
    seq: 1,
    ts: 1_700_000_005_000,
    type: 'SUPER_CHAT',
    payload: { uid: '9', uname: '丙', battery: 500, yuan: 50 },
  })
  await bigTick()

  const notices = seen.filter((m) => m.type === 'notice')
  assert.equal(notices.length, 2)
  assert.match(notices[0].data.text, /【大额】房间 1000100 · 丙 发来 ¥50 的醒目留言/)
  assert.match(notices[1].data.text, /大额提醒已显示，但 webhook 没发出去/)
})

test('大额阈值：只收 0..MAX 的整数，保存要落盘', async (t) => {
  const { app, dataDir } = makeApp(t, { rooms: ['100'] })
  await app.start()

  for (const bad of ['10000', -1, 1.5, NaN, Infinity, MAX_BIG_SPEND_BATTERY + 1]) {
    assert.throws(
      () => app.setBigSpendBattery(bad),
      (e) => e.status === 400 && e.code === 'bad_threshold',
      `应当拒绝：${String(bad)}`,
    )
  }

  assert.equal(app.setBigSpendBattery(25_000), 25_000)
  const saved = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8'))
  assert.equal(saved.bigSpendBattery, 25_000, '阈值要落盘，重启不能丢')

  assert.equal(app.setBigSpendBattery(0), 0, '0 是合法的关闭值')

  // 手改 app.json 塞超范围的值：要当没配，不能悄悄钳成 MAX 后继续用
  const { app: badApp } = makeApp(t, {
    rooms: ['101'],
    cfg: { bigSpendBattery: MAX_BIG_SPEND_BATTERY + 1 },
  })
  await badApp.start()
  assert.equal(badApp.bigSpendBattery, 0, '超出上限的配置应当被忽略')
  await badApp.stop()
})

test('接口：GET /api/patrons 返回榜单、合计与大额阈值', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'], cfg: { bigSpendBattery: 8_800 } })
  await app.start()
  app.rooms.get('100').runner.log_ = {
    readAllAsync: async () => [
      { seq: 1, ts: 1_700_000_010_000, type: 'GIFT', payload: { uid: '1', uname: '甲', giftName: '火箭', battery: 2_000 } },
      { seq: 2, ts: 1_700_000_011_000, type: 'SUPER_CHAT', payload: { uid: '2', uname: '乙', battery: 500, yuan: 50 } },
    ],
  }

  const routes = buildRoutes(app)
  const res = fakeRes()
  await routes.match('GET', '/api/patrons').handler({
    res,
    url: new URL('http://x/api/patrons?days=0&limit=10'),
    app,
  })

  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(data.patrons.length, 2)
  assert.equal(data.patrons[0].name, '甲')
  assert.equal(data.totals.totalBattery, 2_500)
  assert.equal(data.bigSpendBattery, 8_800)
  assert.equal(data.returnBattery, 0, '没配回访门槛时应当是 0（关闭）')
})

test('接口：POST /api/patrons/alert 校验类型并保存', async (t) => {
  const { app, dataDir } = makeApp(t, { rooms: ['100'] })
  await app.start()

  const routes = buildRoutes(app)
  const { Readable } = await import('node:stream')
  const post = async (body) => {
    const res = fakeRes()
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.headers = { 'content-type': 'application/json' }
    await routes.match('POST', '/api/patrons/alert').handler({
      req,
      res,
      url: new URL('http://x/api/patrons/alert'),
      app,
    })
    return res
  }

  const bad = await post({ battery: '10000' })
  assert.equal(bad.statusCode, 400, '字符串不能被悄悄转成数字')

  const ok = await post({ battery: 10_000 })
  assert.equal(ok.statusCode, 200)
  assert.equal(JSON.parse(ok.body).battery, 10_000)
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')).bigSpendBattery, 10_000)

  const ret = await post({ returnBattery: 5_000 })
  assert.equal(ret.statusCode, 200)
  assert.equal(JSON.parse(ret.body).returnBattery, 5_000)
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')).patronReturnBattery, 5_000)

  const badRet = await post({ returnBattery: '5000' })
  assert.equal(badRet.statusCode, 400, '回访门槛同样只收整数')
})

test('接口：GET /api/sc 返回 SC 清单；房间没起来时明确 503', async (t) => {
  const { app: idle } = makeApp(t, { rooms: ['100'] })
  await idle.start()
  const idleRoutes = buildRoutes(idle)
  const idleRes = fakeRes()
  await idleRoutes.match('GET', '/api/sc').handler({
    res: idleRes,
    url: new URL('http://x/api/sc?days=30'),
    app: idle,
  })
  assert.equal(idleRes.statusCode, 503)
  assert.match(idleRes.body, /房间还没启动/)

  const { app, dataDir } = makeApp(t, { rooms: ['100'] })
  await app.start()
  app.rooms.get('100').runner.log_ = {
    readAllAsync: async () => [
      { id: 'e100-1', seq: 1, ts: 1_700_000_000_000, type: 'SUPER_CHAT', payload: { uid: '1', uname: '甲', text: '第一条', yuan: 30 } },
      { id: 'e100-2', seq: 2, ts: 1_700_000_005_000, type: 'SUPER_CHAT', payload: { uid: '2', uname: '乙', text: '第二条', battery: 500 } },
    ],
  }
  writeFileSync(join(dataDir, 'sc-read.json'), JSON.stringify({ ids: ['e100-1'] }))

  const routes = buildRoutes(app)
  const res = fakeRes()
  await routes.match('GET', '/api/sc').handler({
    res,
    url: new URL('http://x/api/sc?days=0'),
    app,
  })
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(data.items.length, 2)
  assert.equal(data.items[0].name, '乙', '新的在前')
  assert.equal(data.items[0].read, false)
  assert.equal(data.items[1].read, true, '落盘的已读 id 要生效')
  assert.equal(data.unread, 1)
})

test('接口：POST /api/sc/read 校验 id 并落盘，重复标记不重复计数', async (t) => {
  const { app, dataDir } = makeApp(t, { rooms: ['100'] })
  await app.start()
  const routes = buildRoutes(app)
  const { Readable } = await import('node:stream')
  const post = async (body) => {
    const res = fakeRes()
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.headers = { 'content-type': 'application/json' }
    await routes.match('POST', '/api/sc/read').handler({
      req,
      res,
      url: new URL('http://x/api/sc/read'),
      app,
    })
    return res
  }

  for (const bad of [
    { ids: 'e100-1' },
    { ids: [] },
    { ids: ['not-an-event-id'] },
    { ids: Array.from({ length: 501 }, (_, i) => `e100-${i + 1}`) },
  ]) {
    const res = await post(bad)
    assert.equal(res.statusCode, 400, `坏请求应当 400：${JSON.stringify(bad).slice(0, 40)}`)
  }

  const ok = await post({ ids: ['e100-1', ' e100-2 '] })
  assert.equal(ok.statusCode, 200)
  assert.equal(JSON.parse(ok.body).marked, 2)
  const saved = JSON.parse(readFileSync(join(dataDir, 'sc-read.json'), 'utf8'))
  assert.deepEqual(saved.ids.sort(), ['e100-1', 'e100-2'])

  const again = await post({ ids: ['e100-1'] })
  assert.equal(JSON.parse(again.body).marked, 0, '已经读过的不该再算新增')

  // 新 App 读同一份数据目录：已读状态要还在（只构造，不启动，避免再连一次）
  const app2 = new App({ dataDir, roomId: '100', dryRun: true, log: SILENT })
  assert.equal(app2.scReadIds().has('e100-2'), true, '已读状态必须跨进程保留')
})

/* ══════════════════ 本场礼物目标 ══════════════════ */

test('礼物目标：过半与达成各播一次，重复事件不重复喊', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'], cfg: { giftGoalBattery: 10_000 } })
  await app.start()

  const runner = app.rooms.get('100').runner
  let gift = 0
  runner.projection = { snapshot: () => ({ giftBattery: gift, sessionId: 's-goal' }) }

  const notices = []
  app.subscribe((m) => {
    if (m.type === 'notice') notices.push(m)
  })

  let seq = 0
  const giftEv = (battery) => {
    seq += 1
    return {
      seq,
      ts: 1_700_000_000_000 + seq,
      type: 'GIFT',
      payload: { uid: '7', uname: '甲', giftName: '火箭', num: 1, battery, isPaid: true },
    }
  }

  gift = 5_000
  runner.push(giftEv(5_000))
  await bigTick()
  assert.equal(runner.gate.said.length, 1)
  assert.equal(runner.gate.said[0].text, '目标过半：¥500/¥1000')
  assert.equal(runner.gate.said[0].priority, 1, '过线要抢一个弹幕槽位')

  gift = 10_000
  runner.push(giftEv(5_000))
  await bigTick()
  assert.equal(runner.gate.said.length, 2)
  assert.equal(runner.gate.said[1].text, '礼物目标达成！¥1000')

  gift = 11_000
  runner.push(giftEv(1_000))
  await bigTick()
  assert.equal(runner.gate.said.length, 2, '已经达成的目标不再重复播')

  // 同一条事件重放：_onEvent 直接 return，不该再喊
  const replay = { ...giftEv(0) }
  replay.seq = seq
  runner.push(replay)
  await bigTick()
  assert.equal(runner.gate.said.length, 2)
  assert.equal(notices.filter((m) => /目标/.test(m.data.text)).length, 2)
})

test('礼物目标：为 0 或关掉播报时，页内提示照旧但不出声', async (t) => {
  const { app: off } = makeApp(t, { rooms: ['100'] })
  await off.start()
  const runnerOff = off.rooms.get('100').runner
  runnerOff.projection = { snapshot: () => ({ giftBattery: 50_000, sessionId: 's0' }) }
  const seenOff = []
  off.subscribe((m) => seenOff.push(m))
  runnerOff.push({
    seq: 1,
    ts: 1_700_000_001_000,
    type: 'GIFT',
    payload: { uid: '7', uname: '甲', giftName: '火箭', battery: 50_000, isPaid: true },
  })
  await bigTick()
  assert.equal(seenOff.filter((m) => m.type === 'notice').length, 0, '目标为 0 时什么都不说')
  assert.equal(runnerOff.gate.said.length, 0)

  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { giftGoalBattery: 10_000, giftGoalAnnounce: false },
  })
  await app.start()
  const runner = app.rooms.get('100').runner
  runner.projection = { snapshot: () => ({ giftBattery: 5_000, sessionId: 's1' }) }
  const seen = []
  app.subscribe((m) => seen.push(m))
  runner.push({
    seq: 1,
    ts: 1_700_000_002_000,
    type: 'GIFT',
    payload: { uid: '7', uname: '甲', giftName: '火箭', battery: 5_000, isPaid: true },
  })
  await bigTick()
  assert.equal(seen.filter((m) => m.type === 'notice').length, 1, '页内提示不受播报开关影响')
  assert.equal(runner.gate.said.length, 0, '播报关掉就不能发弹幕')
})

test('礼物目标配置：坏值忽略，不截断成半截目标', async (t) => {
  const logs = []
  const { app } = makeApp(t, {
    rooms: ['100'],
    cfg: { giftGoalBattery: MAX_GOAL_BATTERY + 1 },
    log: { ...SILENT, warn: (m) => logs.push(m) },
  })
  await app.start()
  assert.equal(app.giftGoalBattery, 0)
  assert.equal(app.giftGoalAnnounce, false, '没有目标就没有可播报的里程碑')
  assert.match(logs.join('\n'), /giftGoalBattery 无效/)
})

test('接口：GET/POST /api/goal 校验整数并落盘', async (t) => {
  const { app, dataDir } = makeApp(t, { rooms: ['100'] })
  await app.start()
  const routes = buildRoutes(app)

  const get = fakeRes()
  await routes.match('GET', '/api/goal').handler({
    res: get,
    url: new URL('http://x/api/goal'),
    app,
  })
  assert.equal(get.statusCode, 200)
  assert.deepEqual(JSON.parse(get.body), { ok: true, goalBattery: 0, announce: false })

  const { Readable } = await import('node:stream')
  const post = async (body) => {
    const res = fakeRes()
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.headers = { 'content-type': 'application/json' }
    await routes.match('POST', '/api/goal').handler({
      req,
      res,
      url: new URL('http://x/api/goal'),
      app,
    })
    return res
  }

  for (const bad of [{ goalBattery: '20000' }, { goalBattery: -1 }, { goalBattery: 1.5 }]) {
    assert.equal((await post(bad)).statusCode, 400, `坏目标应当 400：${JSON.stringify(bad)}`)
  }

  const ok = await post({ goalBattery: 20_000, announce: true })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(JSON.parse(ok.body), { ok: true, goalBattery: 20_000, announce: true })
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')).giftGoalBattery, 20_000)

  const cleared = await post({ goalBattery: 0, announce: true })
  assert.equal(cleared.statusCode, 200)
  assert.equal(JSON.parse(cleared.body).announce, false, '目标清零时播报也要关，不能留下假开关')
})

/* ══════════════════ 付费用户回访 ══════════════════ */

test('回访提醒：这场之前付过钱的观众再进房，只响一次；没到门槛的不响', async (t) => {
  const { app } = makeApp(t, { rooms: ['100'], cfg: { patronReturnBattery: 500 } })
  await app.start()

  const runner = app.runner
  const start = 1_700_000_000_000
  runner.projection = {
    session: { id: 's1', startedAt: start },
    snapshot: () => ({ sessionId: 's1' }),
  }
  runner.log_ = {
    // 900ms 之前：付过 600 电池（过线）；100 电池的没到门槛
    readAllAsync: async () => [
      { seq: 1, ts: start - 900, type: 'GIFT', payload: { uid: '7', uname: '甲', battery: 600 } },
      { seq: 2, ts: start - 800, type: 'SUPER_CHAT', payload: { uid: '8', uname: '乙', battery: 100 } },
    ],
  }

  await app._warmPatrons()

  const notices = []
  app.subscribe((msg) => {
    if (msg.type === 'notice') notices.push(msg.data.text)
  })

  runner.push({ seq: 11, ts: start + 100, type: 'ENTER', payload: { uid: '7', uname: '甲' } })
  assert.equal(notices.length, 1, '过了门槛的回访要提醒')
  assert.match(notices[0], /【回访】房间 1000100 · 甲 回来了/)
  assert.match(notices[0], /¥60/)

  // 同一场同一个人再进一次（重连补发 / 反复进出）不能又响
  runner.push({ seq: 12, ts: start + 200, type: 'ENTER', payload: { uid: '7', uname: '甲' } })
  assert.equal(notices.length, 1, '同一场同一人只响一次')

  // 没到门槛的付费用户不算"值得提醒的回访"
  runner.push({ seq: 13, ts: start + 300, type: 'ENTER', payload: { uid: '8', uname: '乙' } })
  assert.equal(notices.length, 1)
})

test('回访提醒：0 = 关闭；改门槛后旧索引作废', async (t) => {
  const { app, dataDir } = makeApp(t, { rooms: ['100'], cfg: { patronReturnBattery: 0 } })
  await app.start()

  const runner = app.runner
  const start = 1_700_000_000_000
  runner.projection = { session: { id: 's1', startedAt: start } }
  runner.log_ = {
    readAllAsync: async () => [
      { seq: 1, ts: start - 500, type: 'GIFT', payload: { uid: '7', uname: '甲', battery: 900 } },
    ],
  }

  const notices = []
  app.subscribe((msg) => {
    if (msg.type === 'notice') notices.push(msg.data.text)
  })

  runner.push({ seq: 11, ts: start + 100, type: 'ENTER', payload: { uid: '7', uname: '甲' } })
  assert.equal(notices.length, 0, '0 时完全不提醒')

  // 改门槛后立刻生效（索引要按新门槛重建）
  app.setPatronReturnBattery(500)
  // setPatronReturnBattery 内部异步预热；等它读完再进房
  await new Promise((r) => setImmediate(r))
  runner.push({ seq: 12, ts: start + 200, type: 'ENTER', payload: { uid: '7', uname: '甲' } })
  assert.equal(notices.length, 1)

  // 回访门槛要落盘，重启后才不用重配
  const cfg = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8'))
  assert.equal(cfg.patronReturnBattery, 500)
})
