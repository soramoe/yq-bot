/**
 * 战报与沙盒回放自检。
 *
 * 这两块有一个共同的风险：**看起来对，但数字来源是内存而不是日志**。
 * 所以这里的断言全部从"构造一段事件"出发，不碰任何全局状态 ——
 * 能算对，就说明它真的是从日志算的。
 *
 * 沙盒还有一条独有风险：ESM 按 URL 缓存，插件模块是单例。
 * 沙盒如果不隔离，就会拿线上正在用的冷却表去试跑 ——
 * 结果既不准，还会污染生产状态。`cacheBust` 那条断言专门守这件事。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { buildReports, summarizeReports, auditReports, buildDailySeries } from '../core/report.mjs'
import { buildReportHtml, reportFileName, esc } from '../core/export-report.mjs'
import { replay } from '../core/sandbox.mjs'

const PLUGIN_DIR = join(process.cwd(), 'plugins')
const ROOM = '9001'
const T0 = new Date(2026, 10, 2, 20, 0, 0).getTime()

/** 造一条符合 Projection 期望形状的事件 */
function ev(seq, ts, type, payload = {}) {
  return { seq, id: `e${ROOM}-${seq}`, ts, roomId: ROOM, type, source: 'test', payload }
}

/* ══════════════════ 场次时长 ══════════════════ */

/**
 * 审计发现的两个"假时长"。共同点：数字离谱却不报错，
 * 因为在此之前**没有任何代码读 endedAt** —— 战报是第一个读它的地方。
 */
test('场次：没有 LIVE_END 时不能用下一场开播时间当结束（会算成几十小时）', () => {
  const H = 3_600_000
  const events = [
    ev(1, T0, 'LIVE_START', { liveTime: 1 }),
    ev(2, T0 + 60_000, 'DANMAKU', { uid: 1 }),
    ev(3, T0 + 120_000, 'DANMAKU', { uid: 2 }),
    // 断网 / 进程被杀，B站 没有推 LIVE_END，20 小时后才又开播
    ev(4, T0 + 20 * H, 'LIVE_START', { liveTime: 2 }),
    ev(5, T0 + 20 * H + 60_000, 'DANMAKU', { uid: 3 }),
  ]
  const reports = buildReports(events, { roomId: ROOM, now: T0 + 20 * H + 120_000 })
  const first = reports.find((r) => r.danmaku === 2)

  // 修之前这里是 1200 分钟（20 小时）
  assert.equal(first.durationSec, 180, '结束时间应推断为"最后一条事件 + 60 秒宽限"')
  assert.equal(first.endedAtEstimated, true, '推断出来的结束时间必须标出来，不能假装精确')
})

test('场次：启动时补的 synthetic LIVE_END 也算推断（它的时间戳是启动时刻）', () => {
  const H = 3_600_000
  const events = [
    ev(1, T0, 'LIVE_START', { liveTime: 1 }),
    ev(2, T0 + 300_000, 'DANMAKU', { uid: 1 }),
    // 真实下播在 T0+5min，进程 5 小时后才启动，补了一条 LIVE_END
    ev(3, T0 + 5 * H, 'LIVE_END', { liveTime: 1, synthetic: true }),
    ev(4, T0 + 5 * H + 60_000, 'DANMAKU', { uid: 2 }),
  ]
  const reports = buildReports(events, { roomId: ROOM, now: T0 + 5 * H + 120_000 })
  // 最后那条弹幕会开出新的一场（隐式），所以这里要挑出已结束的那一场
  const first = reports.find((r) => r.closed)
  assert.equal(first.durationSec, 360, '应推断为 5min + 60 秒宽限，而不是 5 小时')
  assert.equal(first.endedAtEstimated, true)
})

test('场次：真正收到 LIVE_END 时时间是精确的，不许被推断逻辑改掉', () => {
  const events = [
    ev(1, T0, 'LIVE_START', { liveTime: 1 }),
    ev(2, T0 + 60_000, 'DANMAKU', { uid: 1 }),
    ev(3, T0 + 600_000, 'LIVE_END', { liveTime: 1 }),
  ]
  const [r] = buildReports(events, { roomId: ROOM, now: T0 + 700_000 })
  assert.equal(r.durationSec, 600, 'LIVE_END 的时间戳就是权威，不能用最后一条弹幕去缩')
  assert.equal(r.endedAtEstimated, false)
})

test('场次：开着的场次长时间没有事件要标成中断，不能一直算"进行中"', () => {
  const H = 3_600_000
  const events = [ev(1, T0, 'LIVE_START'), ev(2, T0 + 300_000, 'DANMAKU', { uid: 1 })]

  // 5 分钟前还有事件：正常进行中
  const live = buildReports(events, { roomId: ROOM, now: T0 + 600_000 })[0]
  assert.equal(live.stale, false)
  assert.equal(live.durationSec, 600, '进行中用 now 算时长')

  // 3 天后还在"进行中"是不可能的：连接早断了（进程被直接杀掉时没有 LIVE_END）
  const dead = buildReports(events, { roomId: ROOM, now: T0 + 72 * H })[0]
  assert.equal(dead.stale, true, '30 分钟没有事件就该判中断')
  assert.equal(dead.durationSec, 300, '时长冻结在最后一条事件，而不是涨到 72 小时')
})

/* ══════════════════ 战报 ══════════════════ */

test('战报：日志里的两场会被切成两条，新的在前', () => {
  const events = [
    ev(1, T0, 'LIVE_START'),
    ev(2, T0 + 60_000, 'DANMAKU', { uid: 11, uname: '甲' }),
    ev(3, T0 + 120_000, 'GIFT', {
      uid: 11,
      uname: '甲',
      giftName: '辣条',
      num: 2,
      battery: 20,
      isPaid: true,
    }),
    ev(4, T0 + 180_000, 'FOLLOW', { uid: 12, uname: '乙' }),
    ev(5, T0 + 240_000, 'LIVE_END'),
    ev(6, T0 + 3_600_000, 'LIVE_START'),
    ev(7, T0 + 3_660_000, 'DANMAKU', { uid: 13, uname: '丙' }),
  ]

  const reports = buildReports(events, { roomId: ROOM, now: T0 + 3_720_000 })
  assert.equal(reports.length, 2)

  const [current, first] = reports
  assert.equal(current.closed, false, '第二场还没 LIVE_END，应当是进行中')
  assert.equal(current.danmaku, 1)
  assert.equal(current.durationSec, 120, '进行中的场次用 now 算时长，不能是 0')

  assert.equal(first.closed, true)
  assert.equal(first.danmaku, 1)
  assert.equal(first.giftCount, 2, '礼物数量按 num 累加，不是按事件条数')
  assert.equal(first.giftBattery, 20)
  assert.equal(first.followCount, 1)
  assert.equal(first.uniqueViewers, 2, '甲（弹幕+礼物）只算一个人')
  assert.equal(first.durationSec, 240)
  assert.deepEqual(first.giftTop, [{ name: '辣条', count: 2 }])
})

test('战报：没有 LIVE_START 的场次被标成隐式（时长不可信）', () => {
  const reports = buildReports([ev(1, T0, 'DANMAKU', { uid: 1, uname: '甲' })], {
    roomId: ROOM,
    now: T0 + 1000,
  })
  assert.equal(reports.length, 1)
  assert.equal(reports[0].implicit, true)
})

test('战报：三类收入合计等于礼物 + 舰长 + SC', () => {
  const events = [
    ev(1, T0, 'LIVE_START'),
    ev(2, T0 + 1000, 'GIFT', { uid: 1, uname: 'a', giftName: 'x', num: 1, battery: 100, isPaid: true }),
    ev(3, T0 + 2000, 'GUARD_BUY', { uid: 2, uname: 'b', guardLevel: 3, num: 1, battery: 1000 }),
    ev(4, T0 + 3000, 'SUPER_CHAT', { uid: 3, uname: 'c', battery: 500 }),
  ]
  const [r] = buildReports(events, { roomId: ROOM })
  assert.equal(r.giftBattery, 100)
  assert.equal(r.guardBattery, 1000)
  assert.equal(r.scBattery, 500)
  assert.equal(r.totalBattery, 1600)
})

test('战报：汇总里峰值取最大而不是相加（相加会算出天文数字）', () => {
  const base = {
    implicit: false,
    durationSec: 100,
    danmaku: 1,
    enterCount: 1,
    followCount: 1,
    giftCount: 0,
    giftBattery: 0,
    guardCount: 0,
    guardBattery: 0,
    scCount: 0,
    scBattery: 0,
    totalBattery: 0,
    peakPopularity: 100,
  }
  const sum = summarizeReports([
    base,
    { ...base, durationSec: 60, peakPopularity: 5000 },
    { ...base, implicit: true },
  ])

  assert.equal(sum.sessions, 3)
  assert.equal(sum.implicitSessions, 1)
  assert.equal(sum.durationSec, 260)
  assert.equal(sum.peakPopularity, 5000, '峰值是 max，不是 sum')
})

test('战报：空日志返回空列表，不抛异常', () => {
  const reports = buildReports([], { roomId: ROOM })
  assert.deepEqual(reports, [])
  assert.equal(summarizeReports([]).sessions, 0)
})

/* ══════════════════ 每日趋势 ══════════════════ */

/** 造一条"战报"级别的摘要（图表只吃这个，不吃原始事件） */
function rpt(startedAt, over = {}) {
  return {
    startedAt,
    durationSec: 3600,
    danmaku: 10,
    enterCount: 5,
    followCount: 1,
    giftCount: 1,
    giftBattery: 100,
    scCount: 0,
    totalBattery: 100,
    ...over,
  }
}

test('趋势：同一天两场合成一根柱子，中间空的日子补 0', () => {
  const day1 = new Date(2026, 10, 1, 20, 0).getTime()
  const day3 = new Date(2026, 10, 3, 20, 0).getTime()

  const series = buildDailySeries([
    rpt(day1, { danmaku: 10 }),
    rpt(day1 + 3 * 3600_000, { danmaku: 5 }), // 同一天的第二场
    rpt(day3, { danmaku: 7 }), // 中间的 11-02 没有播
  ])

  assert.deepEqual(
    series.map((x) => x.day),
    ['2026-11-01', '2026-11-02', '2026-11-03'],
    '空的那天要补成 0：否则图上两根柱子挨着，看起来像连着播了三天',
  )
  assert.equal(series[0].sessions, 2)
  assert.equal(series[0].danmaku, 15)
  assert.equal(series[1].sessions, 0)
  assert.equal(series[1].danmaku, 0)
  assert.equal(series[1].totalBattery, 0)
})

test('趋势：金额口径与战报汇总同源（两处加起来必须相等）', () => {
  const reports = [
    rpt(new Date(2026, 10, 1, 20, 0).getTime(), { totalBattery: 1200, giftBattery: 1000, scCount: 1 }),
    rpt(new Date(2026, 10, 2, 20, 0).getTime(), { totalBattery: 800, giftBattery: 300 }),
  ]
  const series = buildDailySeries(reports)
  const sum = summarizeReports(reports)

  assert.equal(
    series.reduce((s, x) => s + x.totalBattery, 0),
    sum.totalBattery,
    '图上合计和汇总条必须是同一个数，否则没人知道该信哪个',
  )
  assert.equal(
    series.reduce((s, x) => s + x.danmaku, 0),
    sum.danmaku,
  )
})

test('趋势：超出上限只留最近 N 天，脏数据不参与也不抛', () => {
  const base = new Date(2026, 9, 1, 20, 0).getTime()
  const many = []
  for (let i = 0; i < 90; i++) many.push(rpt(base + i * 86400_000))
  // 起点非法的场次直接丢掉：画在图上的每根柱子都得能说出是哪一天
  many.push(rpt(NaN), rpt(0), { startedAt: undefined })

  const series = buildDailySeries(many, { maxDays: 10 })
  assert.equal(series.length, 10, '只留最近 10 天')
  assert.equal(series[9].day, dayOf(base + 89 * 86400_000), '留下的是最后一天')
  assert.equal(series[0].day, dayOf(base + 80 * 86400_000))

  assert.deepEqual(buildDailySeries([]), [], '空输入不抛')
  assert.equal(buildDailySeries(many, { maxDays: 0 }).length, 60, '非法上限退回默认 60，不是把 90 天全塞进来')
})

/** 本地日期串，和 report.mjs 的 dayKey 同口径 */
function dayOf(ts) {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ══════════════════ 数据可信度 ══════════════════ */

test('审计：旧格式 SC 会被点名（金额偏小这件事必须自己说出来）', () => {
  // 旧格式：只有 price/battery，没有 yuan。这条正是差 1000 倍的那个 bug 留下的样子
  const legacy = [
    ev(1, T0, 'SUPER_CHAT', { uid: 1, uname: 'a', battery: 1, price: 1, duration: 300 }),
  ]
  const fresh = [ev(1, T0, 'SUPER_CHAT', { uid: 1, uname: 'a', yuan: 100, battery: 1000 })]

  const warns = auditReports(legacy)
  assert.equal(warns.length, 1)
  assert.equal(warns[0].code, 'legacy-sc')
  assert.equal(warns[0].count, 1)
  assert.match(warns[0].text, /偏小/, '提示必须说明后果，不能只说"旧数据"')

  assert.equal(auditReports(fresh).length, 0, '新格式不该报警')
  assert.equal(auditReports([]).length, 0)
})

/* ══════════════════ 沙盒回放 ══════════════════ */

test('沙盒：用当前配置回放，能算出"会说什么"，且不真发', async () => {
  const result = await replay({
    events: [ev(1, T0, 'ENTER', { uid: 1, uname: '甲' })],
    pluginsDir: PLUGIN_DIR,
    configs: { welcome: { template: '欢迎{用户}', cooldownSec: 0 } },
    roomId: ROOM,
  })

  assert.equal(result.said.length, 1)
  assert.equal(result.said[0].plugin, 'welcome')
  assert.equal(result.said[0].text, '欢迎甲')
  assert.equal(result.said[0].seq, 1, '要说清是哪条事件触发的')
  assert.equal(result.fed, 1)
  assert.equal(result.stopped, null)
})

test('沙盒：同一场里冷却仍然生效（回放不是无脑全发）', async () => {
  const enter = (seq) => ev(seq, T0 + seq * 1000, 'ENTER', { uid: 7, uname: '同一个人' })
  const result = await replay({
    events: [enter(1), enter(2), enter(3)],
    pluginsDir: PLUGIN_DIR,
    configs: { welcome: { template: '欢迎{用户}', cooldownSec: 600 } },
    roomId: ROOM,
  })
  assert.equal(result.said.length, 1, '冷却 600 秒内只该说一句')
})

test('沙盒：两次回放互不影响（cacheBust 隔离，不共用生产的冷却表）', async () => {
  const cfg = { welcome: { template: '欢迎{用户}', cooldownSec: 600 } }
  const events = [ev(1, T0, 'ENTER', { uid: 42, uname: '甲' })]

  const first = await replay({ events, pluginsDir: PLUGIN_DIR, configs: cfg, roomId: ROOM })
  const second = await replay({ events, pluginsDir: PLUGIN_DIR, configs: cfg, roomId: ROOM })

  assert.equal(first.said.length, 1)
  // 若没有 cacheBust，第二次会命中第一次留下的冷却记录 → 0 条。
  // 这说明沙盒拿的是同一份模块实例，也就意味着它会污染线上状态。
  assert.equal(second.said.length, 1, '两次回放必须是两个独立实例')
})

test('沙盒：回放要区分"想说多少句"和"真能发出去多少句"', async () => {
  /**
   * 真实数据上量出来的偏差：某一场日志里欢迎插件"想说" 3845 句，
   * 日志里实际只有 1806 条 SENT —— 差的那 2000 多条全被闸门的
   * **最小间隔**（1.2 秒）拦掉了。热闹直播间里进场速度远高于这个。
   *
   * 沙盒不碰闸门（不能真发），于是它的结果天然偏乐观。用户拿它调文案时
   * 看到"会发 3845 句"，实际只会出去一半 —— 这就是一句**看起来正常的假话**。
   * 所以回放要同时报出"按事件时间过一遍闸门能剩下多少"。
   */
  const base = T0
  const events = Array.from({ length: 20 }, (_, i) =>
    ev(i + 1, base, 'ENTER', { uid: 5000 + i, uname: `观众${i}` }),
  )

  const r = await replay({
    events,
    pluginsDir: PLUGIN_DIR,
    configs: { welcome: { template: '欢迎{用户}', cooldownSec: 0 } },
    roomId: ROOM,
  })

  assert.equal(r.said.length, 20, '插件这边 20 个人各欢迎一句')
  assert.equal(r.sendable, 1, '同一秒里挤 20 句，1.2 秒的最小间隔只放行第一句')
  assert.equal(r.gate.blockedInterval, 19)
  assert.match(r.note, /限速/, '限制条件必须写进结果里，不能让用户自己猜');
})

test('沙盒：默认配置下，礼物答谢不能"一句都没有"', async () => {
  /**
   * 这条盯的是"回放少说几句也不报错"那类问题里最尴尬的一种：
   * 默认配置开了连击合并，答谢要等窗口结束才发；线上靠定时器等那 8 秒，
   * 回放把三分钟压进几十毫秒，定时器一次都没响 → 结果一条都没有。
   * 用户改的偏偏就是答谢文案，看到空结果只会以为"配置没生效"。
   */
  const gifts = [1, 2, 3].map((i) =>
    ev(i, T0 + i * 60_000, 'GIFT', {
      uid: 100 + i,
      uname: `观众${i}`,
      giftId: 1,
      giftName: '辣条',
      num: 1,
      battery: 100,
      isPaid: true,
      comboCount: 1,
      blind: null,
    }),
  )

  const result = await replay({ events: gifts, pluginsDir: PLUGIN_DIR, configs: {}, roomId: ROOM })

  assert.equal(result.said.length, 3, '三条相隔一分钟的礼物，每一条都该有答谢')
  assert.deepEqual(
    result.said.map((s) => s.plugin),
    ['gift', 'gift', 'gift'],
  )
  assert.match(result.said[0].text, /观众1/)
  assert.match(result.said[2].text, /观众3/, '最后一条最容易丢 —— 它后面没有事件来触发结算')
})

test('沙盒：观众簿的记账口径要和线上一致（只送过礼也算来过）', async () => {
  /**
   * 线上入库时按 `ROSTER_EVENTS` 记账：进场、送礼、关注、分享、上舰、SC 都算"在场"。
   * 沙盒以前只认 ENTER —— 于是"只送了礼、没触发进场报文"的人在回放里是陌生人，
   * 欢迎语少一句"欢迎回来"。
   *
   * 这条差异不会报错，只会让回放结果比线上少几句话，
   * 而回放存在的唯一意义就是"结果等于当时会说什么"。
   */
  const day = 86_400_000
  const events = [
    // 第一天只送礼：没有 ENTER 报文（房间重连后常见）
    ev(1, T0, 'GIFT', {
      uid: 9,
      uname: '甲',
      giftId: 1,
      giftName: '辣条',
      num: 1,
      battery: 100,
      isPaid: true,
      comboCount: 1,
      blind: null,
    }),
    // 第二天再进场：应该被认成老观众
    ev(2, T0 + day, 'ENTER', { uid: 9, uname: '甲' }),
  ]

  const result = await replay({
    events,
    pluginsDir: PLUGIN_DIR,
    configs: {
      welcome: { template: '新{用户}', returnTemplate: '回{用户}', cooldownSec: 0, oncePerSession: false },
    },
    roomId: ROOM,
  })

  const welcomed = result.said.filter((s) => s.plugin === 'welcome')
  assert.equal(welcomed.length, 1, '第二天进场该有欢迎')
  assert.equal(welcomed[0].text, '回甲', '只送过礼的人第二天来，必须是"欢迎回来"')
})

test('沙盒：触到发言上限时提前停，并明确告知停在哪', async () => {
  const events = [1, 2, 3, 4, 5].map((n) =>
    ev(n, T0 + n * 1000, 'ENTER', { uid: 100 + n, uname: `观众${n}` }),
  )
  const result = await replay({
    events,
    pluginsDir: PLUGIN_DIR,
    configs: { welcome: { template: '欢迎{用户}', cooldownSec: 0 } },
    roomId: ROOM,
    maxSaid: 2,
  })

  assert.equal(result.said.length, 2)
  assert.ok(result.stopped, '提前停了就必须说明，不能让人以为这就是全部')
  assert.equal(result.fed, 2)
  assert.equal(result.total, 5)
})

test('沙盒：插件目录不存在时不崩，返回空结果并带错误', async () => {
  const result = await replay({
    events: [ev(1, T0, 'ENTER', { uid: 1, uname: '甲' })],
    pluginsDir: join(process.cwd(), '__no_such_plugins__'),
    roomId: ROOM,
  })
  assert.equal(result.said.length, 0)
  assert.equal(result.plugins.length, 0)
})

/**
 * 回放必须能回答「这条指令当时会说什么」。
 *
 * 这条以前是坏的：沙盒给插件的 `ctx.state` 是一个常量 `{ roomId }`，
 * 于是 `#本场` 在回放里永远说「0 条弹幕，0 位观众」—— 一句看起来正常
 * 的假话，不报错，用户只会以为指令坏了。
 */
test('沙盒：回放里的 `#本场` 读到的是"到这一刻"的统计', async () => {
  const events = [
    ev(1, T0, 'LIVE_START', { liveTime: T0 }),
    ev(2, T0 + 1000, 'DANMAKU', { uid: 1, uname: '甲', text: '一' }),
    ev(3, T0 + 2000, 'DANMAKU', { uid: 2, uname: '乙', text: '二' }),
    ev(4, T0 + 3000, 'ENTER', { uid: 3, uname: '丙' }),
    // 这条自身也会被计入，和线上一样：投影先于投递
    ev(5, T0 + 4000, 'DANMAKU', { uid: 1, uname: '甲', text: '#本场' }),
  ]

  const result = await replay({
    events,
    pluginsDir: PLUGIN_DIR,
    configs: { command: { enabled: true, cooldownSec: 0 } },
    roomId: ROOM,
  })

  assert.deepEqual(result.errors, [], '回放不该有插件报错')
  const cmd = result.said.filter((s) => s.plugin === 'command')
  assert.equal(cmd.length, 1)
  assert.equal(
    cmd[0].text,
    '本场 3 条弹幕，3 位观众',
    '弹幕 3 条（含当前这条）、观众 3 人 —— 不是全 0',
  )
})

test('沙盒：冷却按历史时刻算，回放多久都不影响结果', async () => {
  // 一场四小时的直播，同一个人每小时问一次 `#本场`。
  // 若冷却读 Date.now()，回放里的四次会被压成一次 —— 而当时是四次。
  const HOUR = 3600_000
  const events = [ev(1, T0, 'LIVE_START', { liveTime: T0 })]
  for (let i = 0; i < 4; i++) {
    events.push(ev(2 + i, T0 + i * HOUR + 1000, 'DANMAKU', { uid: 9, uname: '老观众', text: '#本场' }))
  }

  const result = await replay({
    events,
    pluginsDir: PLUGIN_DIR,
    configs: { command: { enabled: true, cooldownSec: 30 } },
    roomId: ROOM,
  })

  assert.equal(result.said.length, 4, '四小时内问四次，一次都不该被"刚才刚问过"吃掉')
})

/* ══════════════════ 复盘页导出 ══════════════════ */

/** 一段有礼物、有弹幕、有一场下播的日志 */
function exportEvents() {
  return [
    ev(1, T0, 'LIVE_START', { liveTime: T0 }),
    ev(2, T0 + 60_000, 'DANMAKU', { uid: 1, uname: '甲', text: '晚上好' }),
    ev(3, T0 + 120_000, 'DANMAKU', { uid: 2, uname: '乙', text: '来了' }),
    // 礼物名是不可信输入：导出页必须把它当文字，而不是标签
    ev(4, T0 + 180_000, 'GIFT', {
      uid: 1,
      uname: '甲',
      giftName: '<img src=x onerror=alert(1)>',
      num: 2,
      price: 1,
      battery: 2,
      isPaid: true,
    }),
    ev(5, T0 + 240_000, 'SUPER_CHAT', { uid: 3, uname: '丙', text: '加油', yuan: 30, battery: 300 }),
    ev(6, T0 + 30 * 60_000, 'LIVE_END', {}),
  ]
}

function exportInput(over = {}) {
  const reports = buildReports(exportEvents())
  return {
    reports,
    summary: summarizeReports(reports),
    series: buildDailySeries(reports),
    warnings: [],
    meta: {
      roomId: '7734200',
      title: '测试直播间',
      rangeLabel: '全部',
      at: new Date(2026, 10, 5, 6, 7, 0),
      version: '0.2.0',
    },
    ...over,
  }
}

test('复盘导出：是一份能单独打开的 HTML，不依赖任何外链和脚本', () => {
  const html = buildReportHtml(exportInput())

  assert.ok(html.startsWith('<!doctype html>'), '必须是完整文档')
  assert.ok(html.trimEnd().endsWith('</html>'), '必须有收尾')
  assert.match(html, /<meta charset="utf-8">/, '中文必须声明编码，否则 Windows 上打开是乱码')
  assert.equal(/<script/i.test(html), false, '导出页里不许有脚本')
  assert.equal(/https?:\/\//i.test(html.replace(/https?:\/\/www\.w3\.org[^"']*/g, '')), false, '不许有外链')
  assert.match(html, /<svg/, '趋势图要内联在文件里，不是外链图片')
})

test('复盘导出：观众昵称和礼物名一律当文字，不能变成标签', () => {
  const html = buildReportHtml(exportInput())

  assert.equal(html.includes('<img src=x'), false, '不可信输入被原样拼进了 HTML —— 这就是 XSS')
  assert.ok(html.includes('&lt;img src=x'), '应当转义后作为文字显示')
  // 顺带把转义函数的五个字符都钉住
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;')
})

test('复盘导出：数字和战报同源（不是页面自己再算一遍）', () => {
  const input = exportInput()
  const html = buildReportHtml(input)

  // 场次 1、弹幕 2、SC 300 电池 = 30 元
  assert.match(html, /直播复盘 · 房间 7734200/)
  assert.match(html, /<div class="k">场次<\/div><div class="v">1<\/div>/, '场次数要和战报一致')
  assert.match(html, /<div class="k">弹幕<\/div><div class="v">2<\/div>/, '弹幕数要和战报一致')
  assert.ok(html.includes('¥30'), 'SC 30 元要按 300 电池换算出来')
  assert.ok(html.includes('测试直播间'), '房间标题要带上')

  // NaN / undefined 出现在页面上，说明某个字段名取错了 ——
  // 而图表的处理方式是"值不是有限数就当没数据"，于是整张图静默消失
  assert.equal(/NaN|undefined|Infinity/.test(html), false, '页面上不许出现 NaN/undefined/Infinity')

  const income = html.match(/<figure class="chart" data-k="income">[\s\S]*?<\/figure>/)?.[0] ?? ''
  assert.match(income, /<rect /, '这一天有收入，图上就必须有柱子')
  assert.match(income, /每天收入/)

  // 表头列数必须和每行 td 数一致，否则表格会静默错位
  const head = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? ''
  const body = html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? ''
  const ths = (head.match(/<th[ >]/g) ?? []).length
  const tds = (body.match(/<td[ >]/g) ?? []).length
  assert.ok(ths > 0 && tds > 0)
  assert.equal(tds % ths, 0, `表格列数对不上：${ths} 列表头，${tds} 个单元格`)
})

test('复盘导出：没有记录时也给一份完整页面，不能抛', () => {
  const html = buildReportHtml({ reports: [], summary: {}, series: [], warnings: [] })
  assert.ok(html.startsWith('<!doctype html>'))
  assert.match(html, /没有场次记录/)
  assert.match(html, /这段时间没有直播记录/)
})

test('复盘导出：文件名用本地时间、纯 ASCII（和日志分片对得上）', () => {
  const at = new Date(2026, 10, 5, 6, 7, 0)
  const name = reportFileName({ roomId: 7734200, at })
  assert.equal(name, 'yuyue3-report-7734200-2026-11-05_06-07.html')
  assert.match(name, /^[\x20-\x7e]+$/, '文件名要保持纯 ASCII：中文名在部分浏览器/解压工具里会乱码')
})

test('接口：GET /api/reports/export 直接回 HTML 附件（不是 JSON 包一层）', async () => {
  const { buildRoutes } = await import('../http/api.mjs')

  const events = exportEvents()
  const app = {
    runner: {
      log_: { readAllAsync: async () => events, stats: () => ({ days: 1 }) },
      realRoomId: 7734200,
      info: { title: '测试直播间' },
    },
    roomId: 7734200,
    version: '0.2.0',
  }

  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers ?? {}
    },
    end(body) {
      this.body = body
    },
  }

  const route = buildRoutes(app).match('GET', '/api/reports/export')
  assert.ok(route, '路由表里要有这个接口')

  await route.handler({ res, url: new URL('http://x/api/reports/export?days=0'), req: null })

  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Content-Type'] ?? '', /text\/html/, '必须声明成 HTML，否则浏览器不会渲染')
  assert.match(
    res.headers['Content-Disposition'] ?? '',
    /attachment; filename="yuyue3-report-7734200-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.html"/,
    '要当附件下载，文件名带房间号与本地时间',
  )

  const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body)
  assert.match(text, /<!doctype html>/)
  assert.match(text, /直播复盘 · 房间 7734200/)
})
