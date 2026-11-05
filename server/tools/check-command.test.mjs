/**
 * 弹幕指令：#帮助 / #本场 / #我来过。
 *
 * 这组断言盯的不是"能不能回"，而是三件容易做错的事：
 *
 *   1. **别乱插话** —— 观众正常聊天带井号是常态。规则一旦放宽成"包含"，
 *      `刚才那个#帮助有点用` 也会被回一句，房间里就变成刷屏。
 *   2. **别挡住关键词回击** —— 指令的 claims 必须高于 reply（100），
 *      否则用户配了 `帮助` 关键词，`#帮助` 会先被吃掉；但非指令弹幕
 *      必须原样让路，一个字都不能碰。
 *   3. **"上次来"要说对** —— 观众进场时内核已经记过账了，`lastSeenAt`
 *      恒等于刚才，拿它回答永远是"今天"。必须用 `previousSeenAt`。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import command, { parseCommand, agoText } from '../../plugins/command/plugin.mjs'
import { render } from '../core/template.mjs'
import { Roster } from '../core/roster.mjs'
import { validateManifest, defaultsOf, claimPriority, PluginHost } from '../core/plugin-host.mjs'

const SILENT = { debug() {}, info() {}, warn() {}, error() {} }
const DAY = 86_400_000

/* ══════════════════ 桩 ══════════════════ */

/** 造一本内存观众簿；entries = [uid, name, 距今多久来过] */
function makeRoster(entries = [], now = Date.now()) {
  const r = new Roster({ dataDir: '', roomId: '9001', persist: false })
  for (const [uid, name, ageMs] of entries) r.mark(String(uid), name, now - ageMs)
  return r
}

function fakeCtx(config, opts = {}) {
  const said = []
  const warns = []
  return {
    said,
    warns,
    config,
    state: opts.state ?? { danmaku: 0, enterCount: 0, uniqueViewers: 0 },
    scratch: Object.create(null),
    roster: Object.prototype.hasOwnProperty.call(opts, 'roster')
      ? opts.roster
      : makeRoster(opts.entries ?? []),
    log: { ...SILENT, warn: (m) => warns.push(String(m)) },
    // 用真的 render：模板语义（未知占位符原样保留、收敛空白）必须和线上一致
    render,
    say(text, extra = {}) {
      said.push({ text, ...extra })
      return Promise.resolve({ ok: true })
    },
  }
}

function cfg(over = {}) {
  return {
    enabled: true,
    cooldownSec: 15,
    helpText: '我会：#帮助 / #本场 / #我来过',
    sessionText: '本场 {弹幕} 条弹幕，{观众} 位观众',
    visitText: '{用户} 上次是{上次}来的',
    firstVisitText: '第一次见你呀 {用户}',
    ...over,
  }
}

/** 造一条弹幕事件 */
function dm(text, { uid = '1001', uname = '甲', ts = Date.now() } = {}) {
  return { type: 'DANMAKU', ts, payload: { uid, uname, text } }
}

/* ══════════════════ 解析：只认整条消息 ══════════════════ */

test('指令解析：整条消息恰好是 `#` + 一个词才算', () => {
  assert.equal(parseCommand('#帮助'), 'help')
  assert.equal(parseCommand('＃帮助'), 'help', '全角井号也得认：中文输入法打出来的就是它')
  assert.equal(parseCommand('  #帮助  '), 'help', '首尾空白不算内容')
  assert.equal(parseCommand('#HELP'), 'help', '英文指令不区分大小写')
  assert.equal(parseCommand('#?'), 'help')
  assert.equal(parseCommand('#本场'), 'session')
  assert.equal(parseCommand('#数据'), 'session', '别名：观众不会记得只有"本场"能用')
  assert.equal(parseCommand('#我来过'), 'visit')
  assert.equal(parseCommand('#打卡'), 'visit')
})

test('指令解析：正常聊天里带井号一律不算，宁漏不乱', () => {
  // 这几条是"放宽成包含"之后会立刻在真实直播间刷屏的写法
  assert.equal(parseCommand('刚才那个#帮助有点用'), '')
  assert.equal(parseCommand('#帮助 你好'), '', '带参数的命令不支持，也不能吃掉这半句')
  assert.equal(parseCommand('# 帮助 你好'), '')
  assert.equal(parseCommand('#'), '')
  assert.equal(parseCommand(''), '')
  assert.equal(parseCommand(null), '')
  assert.equal(parseCommand('帮助'), '', '没有井号就是普通聊天')
  assert.equal(parseCommand('#帮助帮助帮助帮助帮助帮'), '', '超过 12 字不像指令了')
  assert.equal(parseCommand('#不存在的指令'), '', '没定义过就是不认')
})

test('指令解析：反向验证 —— 换成「包含即触发」，正常聊天立刻被吃掉', () => {
  // 一个"看起来更宽松更好用"的等价实现。它必须在这条真实弹幕上翻车，
  // 否则说明上面那条断言只是摆设（谁都能通过）。
  const loose = (text) => (/帮助/.test(String(text ?? '')) ? 'help' : '')
  assert.equal(loose('刚才那个#帮助有点用'), 'help')
  assert.equal(parseCommand('刚才那个#帮助有点用'), '')
})

test('「上次来」的人话：今天 / 昨天 / N 天前，未来时间不许说成天文数字', () => {
  const now = 1_800_000_000_000
  assert.equal(agoText(now, now), '今天')
  assert.equal(agoText(now - 23 * 3600_000, now), '今天', '不到一天都算今天')
  assert.equal(agoText(now - 25 * 3600_000, now), '昨天')
  assert.equal(agoText(now - 3 * DAY, now), '3 天前')
  assert.equal(agoText(now + 10 * DAY, now), '今天', '时钟回拨写出的"未来人"不能变成负数天')
  // ts = 0 是"没有记录"。它不替调用方编答案（算出来是两万天前），
  // 所以调用方必须自己挡住 —— 插件里就是 `if (!(prev > 0)) return 第一次见`
  assert.ok(agoText(0, now).endsWith('天前'))
})

/* ══════════════════ 分发：认领边界 ══════════════════ */

test('指令插件：非弹幕事件、普通弹幕，一律不认领', async () => {
  const ctx = fakeCtx(cfg())
  assert.equal(await command.onEvent(ctx, { type: 'GIFT', ts: Date.now(), payload: {} }), false)
  assert.equal(await command.onEvent(ctx, { type: 'ENTER', ts: Date.now(), payload: {} }), false)
  assert.equal(await command.onEvent(ctx, dm('今天人好多')), false, '普通聊天必须让给关键词回击')
  assert.equal(ctx.said.length, 0)
})

test('指令插件：关掉后什么都不认领，也不说话', async () => {
  const ctx = fakeCtx(cfg({ enabled: false }))
  assert.equal(await command.onEvent(ctx, dm('#帮助')), false)
  assert.equal(ctx.said.length, 0)
})

test('指令插件：#帮助 回一句，并且是结构化 @（可点、有通知）', async () => {
  const ctx = fakeCtx(cfg())
  assert.equal(await command.onEvent(ctx, dm('#帮助')), true)
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.said[0].text, '我会：#帮助 / #本场 / #我来过')
  assert.equal(ctx.said[0].reason, 'command')
  assert.deepEqual(ctx.said[0].reply, { uid: '1001', uname: '甲' })
})

test('指令插件：#本场 用当前场次的数字渲染，不读别的东西', async () => {
  const ctx = fakeCtx(cfg(), {
    state: { danmaku: 128, enterCount: 40, uniqueViewers: 33, giftCount: 7, guardCount: 1, scCount: 0 },
  })
  await command.onEvent(ctx, dm('#本场'))
  assert.equal(ctx.said[0].text, '本场 128 条弹幕，33 位观众')
})

/* ══════════════════ 频率：认领 ≠ 必须说 ══════════════════ */

test('指令插件：同一人冷却期内认领但不说，别人不受影响', async () => {
  const ctx = fakeCtx(cfg({ cooldownSec: 15 }))
  await command.onEvent(ctx, dm('#帮助'))
  assert.equal(ctx.said.length, 1)

  assert.equal(await command.onEvent(ctx, dm('#本场')), true, '冷却中仍然认领：这条确实是指令')
  assert.equal(ctx.said.length, 1, '认领不等于必须说')

  await command.onEvent(ctx, dm('#帮助', { uid: '2002', uname: '乙' }))
  assert.equal(ctx.said.length, 2, 'A 的冷却不许挡住 B')
})

test('指令插件：cooldownSec = 0 表示不限', async () => {
  const ctx = fakeCtx(cfg({ cooldownSec: 0 }))
  await command.onEvent(ctx, dm('#帮助'))
  await command.onEvent(ctx, dm('#帮助'))
  assert.equal(ctx.said.length, 2)
})

test('指令插件：冷却按事件时间算，不按回放速度算', async () => {
  // 沙盒把四小时日志压成几百毫秒跑完。如果冷却读的是 Date.now()，
  // 同一个人十分钟后问的第二次会被"刚才刚问过"挡住 —— 而当时是答了的。
  const ctx = fakeCtx(cfg({ cooldownSec: 15 }))
  const t0 = 1_800_000_000_000

  await command.onEvent(ctx, dm('#帮助', { ts: t0 }))
  await command.onEvent(ctx, dm('#帮助', { ts: t0 + 10 * 60_000 }))
  assert.equal(ctx.said.length, 2, '十分钟远超过 15 秒冷却，第二次必须答')

  await command.onEvent(ctx, dm('#帮助', { ts: t0 + 10 * 60_000 + 5_000 }))
  assert.equal(ctx.said.length, 2, '同一时刻附近（5 秒）才该被冷却挡住')
})

test('指令插件：没有昵称就只认领不发言（称呼不出来，也不能退回纯文本 @）', async () => {
  const ctx = fakeCtx(cfg())
  assert.equal(await command.onEvent(ctx, dm('#帮助', { uname: '' })), true)
  assert.equal(ctx.said.length, 0)
})

test('指令插件：两个宿主各自的冷却表互不干扰（scratch）', async () => {
  const a = fakeCtx(cfg())
  const b = fakeCtx(cfg())
  await command.onEvent(a, dm('#帮助'))
  await command.onEvent(b, dm('#帮助'))
  assert.equal(a.said.length, 1)
  assert.equal(b.said.length, 1, 'A 房间的冷却不许让 B 房间闭嘴')
  assert.equal(a.scratch.cool.has('1001'), true)
})

test('指令插件：文案超 20 字照样发，但必须留下 warn —— 否则用户只会看到"回复少一半"', async () => {
  const long = '我会：#帮助 看指令 / #本场 看本场数据 / #我来过 看你上次来'
  const ctx = fakeCtx(cfg({ helpText: long }))
  await command.onEvent(ctx, dm('#帮助'))
  assert.equal(ctx.said.length, 1)
  assert.equal(ctx.warns.length, 1)
  assert.match(ctx.warns[0], /20 字/)
})

/* ══════════════════ #我来过：口径 ══════════════════ */

test('指令插件：#我来过 说「上一次」，不是「刚才」', async () => {
  const now = Date.now()
  // 三天前来过，今天又进来了 —— 这正是真实观众的常态
  const roster = makeRoster([['1001', '甲', 3 * DAY]], now)
  roster.mark('1001', '甲', now)

  const ctx = fakeCtx(cfg(), { roster })
  await command.onEvent(ctx, dm('#我来过', { ts: now }))
  assert.equal(ctx.said[0].text, '甲 上次是3 天前来的')
  assert.equal(
    ctx.said[0].text.includes('今天'),
    false,
    '拿 lastSeenAt 会永远答"今天"，等于没回答',
  )
})

test('指令插件：#我来过 遇到簿子里没有的人 / 没有观众簿，都当第一次见', async () => {
  const first = fakeCtx(cfg(), { roster: makeRoster([], Date.now()) })
  await command.onEvent(first, dm('#我来过'))
  assert.equal(first.said[0].text, '第一次见你呀 甲')

  const bare = fakeCtx(cfg(), { roster: null })
  await command.onEvent(bare, dm('#我来过'))
  assert.equal(bare.said[0].text, '第一次见你呀 甲', '簿子读不出来也得理人，不能静默')
})

test('指令插件：查来访不许写簿子 —— 观众能触发的功能不能顺带改统计', async () => {
  const roster = makeRoster([], Date.now())
  const ctx = fakeCtx(cfg(), { roster })
  await command.onEvent(ctx, dm('#我来过', { uid: '999', uname: '路人' }))
  assert.equal(roster.peek('999'), null)
  assert.equal(roster.size, 0)
})

/* ══════════════════ 插件契约 + 真实宿主 ══════════════════ */

test('指令插件：manifest 合法、默认开启、优先级高于关键词回击', () => {
  const dir = join(process.cwd(), 'plugins', 'command')
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  assert.deepEqual(validateManifest(m, 'command'), [])
  assert.equal(defaultsOf(m).enabled, true, '指令本身无害，出厂就该能用')
  assert.equal(command.id, 'command')

  const reply = JSON.parse(readFileSync(join(process.cwd(), 'plugins', 'reply', 'manifest.json'), 'utf8'))
  assert.ok(
    claimPriority(m, 'DANMAKU') > claimPriority(reply, 'DANMAKU'),
    '必须抢在关键词回击前面：否则用户配了 `帮助` 关键词，#帮助 就再也到不了指令',
  )
})

test('指令插件：经真实 PluginHost 加载后，`#帮助` 归指令、`打卡` 归关键词回击', async (t) => {
  const dir = join(process.cwd(), 'plugins')

  // 动态生成：新增插件时不会漏，也不会让别的插件的 onStart 插话
  const configs = {}
  for (const name of readdirSync(dir)) {
    const m = JSON.parse(readFileSync(join(dir, name, 'manifest.json'), 'utf8'))
    configs[m.id] = { enabled: false }
  }
  configs.command = { enabled: true, cooldownSec: 0 }
  // 故意让关键词回击也能匹配 `#帮助`：这就是"两个插件都想要这条弹幕"的情形
  configs.reply = { enabled: true, rules: ['#帮助=规则命中', '打卡=打卡成功'], cooldownSec: 0 }

  const said = []
  const host = new PluginHost({
    dir,
    configs,
    roster: makeRoster([['1001', '甲', 2 * DAY]]),
    getState: () => ({ danmaku: 3, enterCount: 1, uniqueViewers: 1 }),
    say: async (o) => {
      said.push(o)
      return { ok: true }
    },
    log: SILENT,
  })

  await host.load()
  await host.startAll()
  t.after(() => host.stopAll())

  assert.deepEqual(host.errors, [], '真实动态 import 必须全部成功')
  assert.ok(host.plugins.has('command'))

  const r1 = await host.deliver({ type: 'DANMAKU', ts: Date.now(), payload: { uid: '1001', uname: '甲', text: '#帮助' } })
  assert.equal(r1.claimedBy, 'command')
  assert.equal(said.length, 1)
  assert.equal(said[0].source, 'command')
  assert.equal(host.plugins.get('reply').stats.claimed, 0, '规则再匹配也不许吃掉指令')

  const r2 = await host.deliver({ type: 'DANMAKU', ts: Date.now(), payload: { uid: '1001', uname: '甲', text: '打卡' } })
  assert.equal(r2.claimedBy, 'reply', '非指令弹幕必须原样让路')
  assert.equal(said.length, 2)
  assert.equal(said[1].text, '打卡成功')
})

test('指令插件：真实宿主 + 真实观众簿，`#我来过` 说出跨天的那一次', async (t) => {
  const dir = join(process.cwd(), 'plugins')
  const configs = {}
  for (const name of readdirSync(dir)) {
    const m = JSON.parse(readFileSync(join(dir, name, 'manifest.json'), 'utf8'))
    configs[m.id] = { enabled: false }
  }
  configs.command = { enabled: true, cooldownSec: 0 }

  const now = Date.now()
  const roster = makeRoster([['1001', '甲', 5 * DAY]], now)
  roster.mark('1001', '甲', now) // 今天又进来了：内存里 ts 已经是"现在"

  const said = []
  const host = new PluginHost({
    dir,
    configs,
    roster,
    getState: () => ({}),
    say: async (o) => {
      said.push(o)
      return { ok: true }
    },
    log: SILENT,
  })
  await host.load()
  await host.startAll()
  t.after(() => host.stopAll())

  await host.deliver({
    type: 'DANMAKU',
    ts: now,
    payload: { uid: '1001', uname: '甲', text: '#我来过' },
  })

  assert.equal(said.length, 1)
  assert.equal(said[0].text, '甲 上次是5 天前来的')
})
