/**
 * 两个"不靠事件驱动"的玩法插件：定时播报、关键词回击。
 *
 * 它们和 welcome/gift/sc 的测试重点不同 —— 那两个是"收到事件 → 说什么"，
 * 这两个是"什么时候说 / 该不该说"，所以断言集中在**门禁**上：
 * 未开播不说、冷却中不说、文案为空不说。
 *
 * 定时播报用 `t.mock.timers` 推进假时钟，不等真实 60 秒。
 * 真等的话，这组断言要跑几十秒，而慢测试的下场是没人跑。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import schedule, {
  isLiveState,
  shouldSpeak,
  nextTemplate,
  varsOf,
} from '../../plugins/schedule/plugin.mjs'
import reply, {
  parseRules,
  matchRule,
  hitKeyword,
  isCoolingDown,
  isReplyable,
} from '../../plugins/reply/plugin.mjs'

/* ══════════════════ 通用：假 ctx ══════════════════ */

const SILENT = { debug() {}, info() {}, warn() {}, error() {} }

/** 造一个够用的插件上下文。say 只是记账，不经过闸门 */
function fakeCtx(config, state = { state: 'live', roomId: '9001' }) {
  const said = []
  return {
    said,
    config,
    state,
    /** 宿主的每房间私有存储（真实宿主里由 PluginHost 提供） */
    scratch: Object.create(null),
    log: SILENT,
    render: (tpl, vars) =>
      String(tpl).replace(/\{([^{}]+)\}/g, (w, k) =>
        Object.prototype.hasOwnProperty.call(vars, String(k).trim()) ? String(vars[String(k).trim()]) : w,
      ),
    say(text, extra = {}) {
      said.push({ text, ...extra })
      return Promise.resolve({ ok: true, skipped: null });
    },
  }
}

function schedConfig(over = {}) {
  return {
    enabled: true,
    intervalSec: 60,
    onlyWhenLive: true,
    shuffle: false,
    templates: ['第一句', '第二句'],
    ...over,
  }
}

/* ══════════════════ 定时播报：纯逻辑 ══════════════════ */

test('播报：顺序模式按序轮播，游标跨轮传递（不会一直说第一句）', () => {
  const list = ['A', 'B', 'C']
  let cursor = 0
  const seen = []
  for (let i = 0; i < 5; i++) {
    const r = nextTemplate(list, cursor, false)
    seen.push(r.text)
    cursor = r.cursor
  }
  assert.deepEqual(seen, ['A', 'B', 'C', 'A', 'B'])
})

test('播报：游标越界（规则改短了）自动绕回，不能变成 undefined', () => {
  const r = nextTemplate(['A', 'B'], 99, false)
  assert.equal(r.text, 'B', '(99 % 2) = 1 → B')
})

test('播报：随机模式只在列表里挑，且不移动游标', () => {
  const list = ['A', 'B', 'C']
  for (const x of [0, 0.34, 0.67, 0.999]) {
    const r = nextTemplate(list, 0, true, () => x)
    assert.ok(list.includes(r.text), `挑出了列表外的内容：${r.text}`)
    assert.equal(r.cursor, 0)
  }
})

test('播报：文案为空时返回空串而不是崩', () => {
  assert.equal(nextTemplate([], 0, false).text, '')
  assert.equal(nextTemplate(null, 0, false).text, '')
  assert.equal(nextTemplate(['   ', ''], 0, false).text, '')
})

test('播报：门禁 —— 关掉/没文案/没开播都不说，live 与 live_unknown 都说', () => {
  assert.equal(shouldSpeak(schedConfig({ enabled: false }), { state: 'live' }).reason, 'disabled')
  assert.equal(shouldSpeak(schedConfig({ templates: [] }), { state: 'live' }).reason, 'no-templates')
  assert.equal(shouldSpeak(schedConfig(), { state: 'offline' }).reason, 'not-live')

  // live_unknown 是"房间里有人在说话，但没收到开播消息"（进程在直播中途启动），
  // 把它当未开播会让用户以为功能坏了
  assert.equal(shouldSpeak(schedConfig(), { state: 'live_unknown' }).ok, true)
  assert.equal(shouldSpeak(schedConfig(), { state: 'live' }).ok, true)

  // 关掉"只在直播中说"后，下播也让说 —— 这是用户明确要求的
  assert.equal(shouldSpeak(schedConfig({ onlyWhenLive: false }), { state: 'offline' }).ok, true)
})

test('播报：状态文案与时间变量', () => {
  const at = new Date(2026, 10, 3, 9, 5, 0).getTime()
  const v = varsOf({ state: 'live', roomId: '9001' }, at)
  assert.equal(v.时间, '09:05', '分钟必须补零，08:5 看起来像 bug')
  assert.equal(v.日期, '11-03')
  assert.equal(v.房间, '9001')
  assert.equal(v.状态, '直播中')

  assert.equal(varsOf({ state: 'offline' }, at).状态, '未开播')
  assert.equal(isLiveState('live_unknown'), true)
  assert.equal(isLiveState('offline'), false)
})

/* ══════════════════ 定时播报：用假时钟真跑 ══════════════════ */

/**
 * 推进假时钟。
 *
 * 必须**按唤醒周期分步推**，不能一次 `tick(60000)`：`t.mock.timers`
 * 每次 tick 只执行"此刻已到期"的那批定时器，而插件是"醒来 → 再排下一次"
 * 的链式结构，新排的那个在本次 tick 里不会被算进去。
 * 一次推到底的结果是"只醒了一次"，看起来像功能没生效 —— 是测试骗了人。
 */
function advance(t, ms, step = 5000) {
  let left = ms;
  while (left > 0) {
    const d = Math.min(step, left);
    t.mock.timers.tick(d);
    left -= d;
  }
}

test('播报：每到一个间隔说一句，按顺序轮播', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const ctx = fakeCtx(schedConfig())
  schedule.onStart(ctx)
  t.after(() => schedule.onStop(ctx))

  assert.equal(ctx.said.length, 0, '刚启动不该立刻说话（重启一次说一句是最烦的）')

  advance(t, 60_000)
  await Promise.resolve()
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.said[0].text, '第一句')

  advance(t, 60_000)
  await Promise.resolve()
  assert.equal(ctx.said.length, 2)
  assert.equal(ctx.said[1].text, '第二句', '第二句而不是又一句第一句')
})

test('播报：未开播时一个周期过去也不说', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const ctx = fakeCtx(schedConfig(), { state: 'offline', roomId: '9001' })
  schedule.onStart(ctx)
  t.after(() => schedule.onStop(ctx))

  advance(t, 60_000)
  await Promise.resolve()
  assert.equal(ctx.said.length, 0)
})

test('播报：改间隔立刻在下一轮生效（不用重启）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const ctx = fakeCtx(schedConfig({ intervalSec: 600 }))
  schedule.onStart(ctx)
  t.after(() => schedule.onStop(ctx))

  // 600 秒还没到，不该说话
  advance(t, 300_000)
  await Promise.resolve()
  assert.equal(ctx.said.length, 0)

  // 用户把 600 改成 60：最多一个唤醒周期（5 秒）内就该按新节奏走，
  // 而不是把剩下的 300 秒睡完 —— 后者才是"改了像没改"的典型表现
  ctx.config.intervalSec = 60
  advance(t, 5_000)
  await Promise.resolve()
  assert.equal(ctx.said.length, 1, '间隔改小后必须在 5 秒内见效')
})

test('播报：关掉开关后在下一轮内静默，重新打开又能说', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const ctx = fakeCtx(schedConfig())
  schedule.onStart(ctx)
  t.after(() => schedule.onStop(ctx))

  ctx.config.enabled = false
  advance(t, 60_000)
  await Promise.resolve()
  assert.equal(ctx.said.length, 0, '关掉之后不许再说')

  ctx.config.enabled = true
  // 关闭状态是 5 秒轮询，所以打开后 5 秒内就该开口，而不是等满 60 秒
  advance(t, 5_000)
  await Promise.resolve()
  assert.equal(ctx.said.length, 1, '重新打开后不该让用户等一整个周期')
})

test('播报：模板里的占位符会被渲染，未提供的不动', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const ctx = fakeCtx(schedConfig({ templates: ['现在是{时间}，{不存在}'] }))
  schedule.onStart(ctx)
  t.after(() => schedule.onStop(ctx))

  advance(t, 60_000)
  await Promise.resolve()
  assert.match(ctx.said[0].text, /^现在是\d\d:\d\d，\{不存在\}$/)
})

/* ══════════════════ 关键词回击：解析 ══════════════════ */

test('回击：规则解析 —— 多关键词、注释、回复里带等号', () => {
  const { rules, bad } = parseRules([
    '打卡=打卡成功',
    '你好|hi|hello=你好呀',
    '# 这是注释',
    '// 这也是注释',
    '礼包=兑换码:a=b',
    '没有等号的一行',
    '=右边没关键词',
    '关键词=',
    '',
  ])

  assert.equal(rules.length, 3)
  assert.deepEqual(rules[0].keywords, ['打卡'])
  assert.deepEqual(rules[1].keywords, ['你好', 'hi', 'hello'])
  assert.equal(rules[2].reply, '兑换码:a=b', '回复里可以再出现等号')

  assert.equal(bad, 3, '格式不对的行要计数，不能静默丢掉 —— 否则用户以为没保存')
})

test('回击：三种匹配方式', () => {
  const rules = [{ keywords: ['晚安'] }]

  // 默认整句相等：这是安全默认值
  assert.equal(matchRule(rules, '晚安').index, 0)
  assert.equal(matchRule(rules, '晚安呀').index, -1, 'exact 模式下多一个字就不该命中')
  assert.equal(matchRule(rules, '还没晚安呢').index, -1)

  assert.equal(matchRule(rules, '晚安呀', 'prefix').index, 0)
  assert.equal(matchRule(rules, '还没晚安呢', 'prefix').index, -1)

  assert.equal(matchRule(rules, '还没晚安呢', 'contains').index, 0)
  assert.equal(matchRule(rules, ' 晚安 ', 'exact').index, 0, '首尾空白要忽略')
})

test('回击：忽略大小写可关', () => {
  const rules = [{ keywords: ['Hi'] }]
  assert.equal(matchRule(rules, 'hi', 'exact', true).index, 0)
  // 关掉之后 hi ≠ Hi
  assert.equal(matchRule(rules, 'hi', 'exact', false).index, -1)
  assert.equal(matchRule(rules, 'Hi', 'exact', false).index, 0)
})

test('回击：空内容不命中任何规则', () => {
  const rules = [{ keywords: [''] }, { keywords: ['x'] }]
  assert.equal(hitKeyword(rules[0].keywords, '什么都可以'), '')
  assert.equal(matchRule(rules, '').index, -1)
})

test('回击：冷却判定边界', () => {
  const now = 1_000_000
  assert.equal(isCoolingDown(now - 59_000, 60, now), true)
  assert.equal(isCoolingDown(now - 60_000, 60, now), false, '正好到点就该能回')
  assert.equal(isCoolingDown(0, 60, now), false, '没回过')
  assert.equal(isCoolingDown(now - 1_000, 0, now), false, '0 表示不限')
})

test('回击：系统消息不回复（没有 uid 或没有用户名）', () => {
  assert.equal(isReplyable({ uid: 1, uname: '甲', text: '打卡' }), true)
  assert.equal(isReplyable({ uid: null, uname: '甲', text: '打卡' }), false)
  assert.equal(isReplyable({ uid: 1, uname: '  ', text: '打卡' }), false)
  assert.equal(isReplyable({ uid: 1, uname: '甲', text: '   ' }), false)
})

/* ══════════════════ 关键词回击：端到端 ══════════════════ */

function replyConfig(over = {}) {
  return {
    enabled: true,
    rules: ['打卡=打卡成功', '晚安=晚安好梦'],
    matchMode: 'exact',
    cooldownSec: 60,
    ignoreCase: true,
    template: '{回复}',
    ...over,
  }
}

const dm = (seq, text, uid = 1, uname = '甲') => ({
  seq,
  ts: Date.now(),
  roomId: '9001',
  type: 'DANMAKU',
  source: 'test',
  payload: { uid, uname, text },
})

test('回击：命中就回，不命中不吭声', () => {
  const ctx = fakeCtx(replyConfig())
  reply.onStart(ctx)

  assert.equal(reply.onEvent(ctx, dm(1, '随便聊聊')), false)
  assert.equal(ctx.said.length, 0)

  assert.equal(reply.onEvent(ctx, dm(2, '打卡')), true)
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.said[0].text, '打卡成功')
  assert.equal(ctx.said[0].reason, 'reply')
})

test('回击：同一规则冷却内只回一次，不同规则互不影响', () => {
  const ctx = fakeCtx(replyConfig())
  reply.onStart(ctx)

  assert.equal(reply.onEvent(ctx, dm(1, '打卡', 1, '甲')), true)
  assert.equal(reply.onEvent(ctx, dm(2, '打卡', 2, '乙')), false, '同一规则在冷却中')

  // 另一条规则不该被牵连 —— 全局冷却是最常见的写错方式
  assert.equal(reply.onEvent(ctx, dm(3, '晚安', 3, '丙')), true)
  assert.equal(ctx.said.length, 2)
  assert.equal(ctx.said[1].text, '晚安好梦')
})

test('回击：冷却按事件时间算，回放压缩时间也不会少回', () => {
  // 沙盒把一晚的日志压成几百毫秒。冷却若读 Date.now()，一小时后那条
  // 「打卡」会被"一分钟冷却"挡住 —— 回放比当时少回一条，且不报错。
  const ctx = fakeCtx(replyConfig())
  reply.onStart(ctx)

  const t0 = 1_800_000_000_000
  const at = (seq, text, ts) => ({ ...dm(seq, text), ts })

  assert.equal(reply.onEvent(ctx, at(1, '打卡', t0)), true)
  assert.equal(reply.onEvent(ctx, at(2, '打卡', t0 + 5_000)), false, '5 秒内还在 60 秒冷却里')
  assert.equal(reply.onEvent(ctx, at(3, '打卡', t0 + 3600_000)), true, '一小时后冷却早过了')
  assert.equal(ctx.said.length, 2)
})

test('回击：一条弹幕命中两条规则、前一条在冷却 → 用后一条（不能整体放弃）', () => {
  const ctx = fakeCtx(
    replyConfig({ matchMode: 'contains', rules: ['打卡=打卡成功', '晚安=晚安好梦'] }),
  )
  reply.onStart(ctx)

  assert.equal(reply.onEvent(ctx, dm(1, '打卡晚安', 1, '甲')), true)
  assert.equal(ctx.said[0].text, '打卡成功', '先命中的先用')

  // 再来一条同时命中两条：打卡在冷却，晚安还能用
  assert.equal(reply.onEvent(ctx, dm(2, '打卡晚安', 2, '乙')), true)
  assert.equal(ctx.said.length, 2)
  assert.equal(ctx.said[1].text, '晚安好梦', '前一条冷却不该让整条弹幕都失去回应')
})

test('回击：关掉开关就完全不动', () => {
  const ctx = fakeCtx(replyConfig({ enabled: false }))
  reply.onStart(ctx)
  assert.equal(reply.onEvent(ctx, dm(1, '打卡')), false)
  assert.equal(ctx.said.length, 0)
})

test('回击：模板可用 {用户} {关键词} {内容}', () => {
  const ctx = fakeCtx(replyConfig({ template: '{用户} 说的「{关键词}」收到了' }))
  reply.onStart(ctx)
  reply.onEvent(ctx, dm(1, '打卡', 7, '小明'))
  assert.equal(ctx.said[0].text, '小明 说的「打卡」收到了')
})

test('回击：规则行格式错误不影响其他规则生效', () => {
  const ctx = fakeCtx(replyConfig({ rules: ['写错的一行', '打卡=还行'] }))
  reply.onStart(ctx)
  assert.equal(reply.onEvent(ctx, dm(1, '打卡')), true)
  assert.equal(ctx.said[0].text, '还行')
})

test('回击：改了规则后冷却表被清空（下标含义变了，不能沿用）', () => {
  const ctx = fakeCtx(replyConfig())
  reply.onStart(ctx)

  assert.equal(reply.onEvent(ctx, dm(1, '打卡')), true)
  assert.equal(reply.onEvent(ctx, dm(2, '打卡')), false, '同规则刚回过')

  // 把规则顺序整个换掉：原来的"下标 0"已经不是打卡了
  ctx.config.rules = ['晚安=晚安好梦', '打卡=打卡成功']
  assert.equal(reply.onEvent(ctx, dm(3, '打卡')), true, '规则变了，旧冷却不该按老下标误拦')
})

test('回击：真跑一遍完整链路（PluginHost + 假发送）', async () => {
  const { PluginHost } = await import('../core/plugin-host.mjs')
  const said = []
  const host = new PluginHost({
    dir: join(process.cwd(), 'plugins'),
    configs: { reply: replyConfig() },
    say: async ({ text, source }) => {
      said.push({ text, source })
      return { ok: true }
    },
  })
  await host.load()
  await host.startAll()

  const claimed = await host.dispatch(dm(1, '打卡'))
  assert.equal(claimed.claimedBy, 'reply', '命中了就该由它认领')
  assert.equal(said.length, 1)
  assert.equal(said[0].source, 'reply', 'source 必须是插件 id，否则界面上分不清谁说的')

  // 没命中的弹幕不该被认领
  const none = await host.dispatch(dm(2, '随便聊聊'))
  assert.equal(none.claimedBy, null)
})

test('回击：两个宿主（两个房间）的状态互不影响', async () => {
  /**
   * 这是一个架构级断言，不测"某个插件写得对不对"。
   *
   * 插件状态如果挂在模块导出对象上（`this._last`），而 ESM 按 URL 缓存，
   * 一个进程里就只有一份 —— 两个房间的两份宿主动的是同一个 Map。
   * 症状是"隔壁房间回了、这个房间不回"，不报错、不报警，只能靠猜。
   *
   * 所以内核提供 `ctx.scratch`（每宿主每插件一份），插件必须用它。
   */
  const { PluginHost } = await import('../core/plugin-host.mjs')

  const make = async () => {
    const said = []
    const host = new PluginHost({
      dir: join(process.cwd(), 'plugins'),
      configs: { reply: replyConfig() },
      say: async ({ text }) => {
        said.push(text)
        return { ok: true }
      },
    })
    await host.load()
    await host.startAll()
    return { host, said }
  }

  const a = await make()
  const b = await make()

  // A 房间刚回过"打卡"，它自己的冷却应当生效
  assert.equal((await a.host.dispatch(dm(1, '打卡', 1, '甲'))).claimedBy, 'reply')
  assert.equal((await a.host.dispatch(dm(2, '打卡', 2, '乙'))).claimedBy, null, 'A 房间自己在冷却')

  // B 房间是另一间直播间，没回过，必须能回
  assert.equal(
    (await b.host.dispatch(dm(1, '打卡', 3, '丙'))).claimedBy,
    'reply',
    'B 房间不该被 A 房间的冷却挡住',
  )

  assert.equal(a.said.length, 1)
  assert.equal(b.said.length, 1)
})

/* ══════════════════ 跨宿主状态隔离（D60） ══════════════════ */

test('D60：盲盒冷却按宿主隔离 —— B 房间启动不能清掉 A 房间的冷却', async (t) => {
  const { PluginHost } = await import('../core/plugin-host.mjs')

  const make = async () => {
    const said = []
    const host = new PluginHost({
      dir: join(process.cwd(), 'plugins'),
      configs: {
        blind: { cooldownSec: 600 },
        gift: { enabled: false },
        sc: { enabled: false },
      },
      say: async ({ text }) => {
        said.push(text)
        return { ok: true }
      },
    })
    await host.load()
    await host.startAll()
    t.after(async () => host.stopAll())
    return { host, said }
  }

  const blindEv = (uid, uname) => ({
    type: 'GIFT',
    payload: {
      uid,
      uname,
      giftName: '魔盒',
      num: 1,
      isPaid: true,
      blind: { profit: 10, boxName: '魔盒', cost: 1, value: 11 },
    },
  })

  const a = await make()
  assert.equal((await a.host.dispatch(blindEv(1, '甲'))).claimedBy, 'blind')

  // ★ 旧实现把 _last 挂在模块导出对象上，B 的 onStart.clear() 会清掉共享表，
  //   于是 A 房间同一个人立刻又能播一次。改回旧写法，下面这条必须失败。
  const b = await make()
  assert.equal(
    (await a.host.dispatch(blindEv(1, '甲'))).claimedBy,
    null,
    'A 房间的冷却不能被 B 房间的启动清掉',
  )
  assert.equal((await b.host.dispatch(blindEv(1, '甲'))).claimedBy, 'blind', 'B 没播过，必须能播')
  assert.equal(a.said.length, 1)
  assert.equal(b.said.length, 1)
})

test('D60：礼物待发连击按宿主隔离 —— A 攒的队列不会被 B 抢走或清空', async (t) => {
  const { PluginHost } = await import('../core/plugin-host.mjs')

  const make = async () => {
    const host = new PluginHost({
      dir: join(process.cwd(), 'plugins'),
      configs: { gift: { enabled: true }, blind: { enabled: false } },
      say: async () => ({ ok: true }),
    })
    await host.load()
    await host.startAll()
    t.after(async () => host.stopAll())
    return host
  }

  const giftEv = (uid, uname) => ({
    type: 'GIFT',
    payload: {
      uid,
      uname,
      giftId: 1,
      giftName: '小花',
      num: 1,
      battery: 1,
      isPaid: true,
      comboCount: 1,
    },
  })

  const a = await make()
  await a.dispatch(giftEv(1, '甲'))
  const pa = a.plugins.get('gift').scratch.pending
  assert.equal(pa.size, 1)

  // ★ 旧实现：B 的 onStart 会 clear 共享的 _pending，这里会变成 0
  const b = await make()
  assert.equal(pa.size, 1, 'B 启动不能清掉 A 攒的连击')

  await b.dispatch(giftEv(2, '乙'))
  assert.equal(pa.size, 1, 'B 的礼物不能并进 A 的队列')
  assert.equal(b.plugins.get('gift').scratch.pending.size, 1)

  // SC 的本场计数同理，两个宿主必须是两份不同的存储
  assert.notEqual(a.plugins.get('sc').scratch, b.plugins.get('sc').scratch)
  assert.equal(a.plugins.get('sc').scratch.seen ?? 0, 0)
})
