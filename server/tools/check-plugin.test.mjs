/**
 * 插件宿主与欢迎插件自检。
 *
 * 重点测两件事：
 *   1. **仲裁**：多个插件想要同一类事件时，只有优先级最高的那个能处理，
 *      后面的不再被调用 —— 这是二代"礼物答谢去读盲盒插件配置"的解药。
 *   2. **插件拿不到后门**：它只能 `say()` 请求发言，不能直接调发送，
 *      也拿不到事件日志。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PluginHost,
  validateManifest,
  coerceConfig,
  defaultsOf,
  claimPriority,
} from '../core/plugin-host.mjs'
import { render, placeholders, missingVars } from '../core/template.mjs'

const PLUGIN_DIR = join(process.cwd(), 'plugins')

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yy3-plug-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

/** 造一个临时插件目录 */
function makePlugin(root, id, { claims = {}, onEventSrc = 'return false', manifest = {} } = {}) {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', claims, ...manifest }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(dir, 'plugin.mjs'),
    `export default { id: ${JSON.stringify(id)}, onEvent(ctx, ev) { ${onEventSrc} } }\n`,
    'utf8',
  )
  return dir
}

/* ═══════════════ manifest 校验 ═══════════════ */

test('manifest：id 必须和目录名一致（不一致说明复制错了目录）', () => {
  const errs = validateManifest({ id: 'a', name: 'A', version: '1.0.0' }, 'b')
  assert.ok(errs.some((e) => /目录名/.test(e)))
})

test('manifest：claims 里的未知事件类型要报出来', () => {
  const errs = validateManifest({
    id: 'aa',
    name: 'A',
    version: '1.0.0',
    claims: { NOT_AN_EVENT: 10 },
  })
  assert.ok(errs.some((e) => /未知事件类型/.test(e)))
})

test('manifest：config 的字段类型必须是已知的十种之一', () => {
  const errs = validateManifest({
    id: 'aa',
    name: 'A',
    version: '1.0.0',
    config: [{ key: 'x', type: 'colorful-picker', label: 'X' }],
  })
  assert.ok(errs.some((e) => /type 不认识/.test(e)))
})

test('manifest：config 的 key 不能重复', () => {
  const errs = validateManifest({
    id: 'aa',
    name: 'A',
    version: '1.0.0',
    config: [
      { key: 'x', type: 'text', label: 'X' },
      { key: 'x', type: 'text', label: 'X2' },
    ],
  })
  assert.ok(errs.some((e) => /重复/.test(e)))
})

test('config：按 manifest 的 min/max 收敛，非法数字回落到默认值', () => {
  const m = {
    id: 'aa',
    name: 'A',
    version: '1.0.0',
    config: [{ key: 'n', type: 'number', label: 'N', default: 5, min: 1, max: 10 }],
  }
  assert.equal(coerceConfig(m, { n: 999 }).n, 10, '超过上限要收敛')
  assert.equal(coerceConfig(m, { n: -3 }).n, 1, '低于下限要收敛')
  assert.equal(coerceConfig(m, { n: 'abc' }).n, 5, '非法值回落默认')
  assert.equal(coerceConfig(m, { n: 7 }).n, 7)
})

test('config：lines 类型支持数组与换行字符串两种输入', () => {
  const m = {
    id: 'aa',
    name: 'A',
    version: '1.0.0',
    config: [{ key: 'k', type: 'lines', label: 'K' }],
  }
  assert.deepEqual(coerceConfig(m, { k: 'a\nb\n\n c ' }).k, ['a', 'b', 'c'])
  assert.deepEqual(coerceConfig(m, { k: ['x', ' y '] }).k, ['x', 'y'])
})

test('config：默认值来自 manifest，switch 默认为 false', () => {
  const m = {
    id: 'aa',
    name: 'A',
    version: '1.0.0',
    config: [
      { key: 's', type: 'switch', label: 'S' },
      { key: 't', type: 'text', label: 'T' },
    ],
  }
  assert.deepEqual(defaultsOf(m), { s: false, t: '' })
})

/* ═══════════════ 模板 ═══════════════ */

test('模板：未知占位符原样保留（悄悄变空串会让"写错了"更难发现）', () => {
  assert.equal(render('欢迎 {用户}{不存在的}', { 用户: '小明' }), '欢迎 小明{不存在的}')
})

test('模板：空值不产生多余空格', () => {
  assert.equal(render('欢迎 {用户} ！', { 用户: '小明' }), '欢迎 小明 ！')
  assert.equal(render('欢迎 {用户} {粉丝牌}！', { 用户: '小明', 粉丝牌: '' }), '欢迎 小明 ！')
})

test('模板：能从模板反查用到的占位符', () => {
  assert.deepEqual(placeholders('{用户} {粉丝牌} {用户}').sort(), ['用户', '粉丝牌'].sort())
  assert.deepEqual(missingVars('{用户} {舰长}', { 用户: 'a' }), ['舰长'])
})

/* ═══════════════ 加载与仲裁 ═══════════════ */

test('宿主：能加载真实 plugins 目录，且 welcome 在内', async () => {
  const host = new PluginHost({ dir: PLUGIN_DIR, say: async () => ({ ok: true }) })
  await host.load()

  const snap = host.snapshot()
  assert.ok(snap.count >= 1, `至少要加载到 welcome，实际 ${snap.count} 个`)
  assert.equal(snap.errors.length, 0, `不应有加载错误：${JSON.stringify(snap.errors)}`)
  assert.ok(snap.plugins.some((p) => p.id === 'welcome'))
})

test('宿主：单个插件坏掉不影响其他插件加载', async (t) => {
  const root = tmp(t)
  makePlugin(root, 'good', { onEventSrc: 'return true' })
  // 故意写一个坏的 manifest
  mkdirSync(join(root, 'broken'), { recursive: true })
  writeFileSync(join(root, 'broken', 'manifest.json'), '{ 这不是 json', 'utf8')
  writeFileSync(join(root, 'broken', 'plugin.mjs'), 'export default {}\n', 'utf8')

  const host = new PluginHost({ dir: root })
  await host.load()

  assert.equal(host.plugins.size, 1, '好的那个要照常加载')
  assert.equal(host.errors.length, 1)
  assert.match(host.errors[0].message, /manifest/)
})

test('仲裁：同一事件只交给优先级最高的插件，后面的不再被调用', async (t) => {
  const root = tmp(t)
  const asked = []

  // 低优先级：记录自己被问过
  makePlugin(root, 'low', {
    claims: { GIFT: 10 },
    onEventSrc: `globalThis.__asked = globalThis.__asked || []; globalThis.__asked.push('low'); return true`,
  })
  makePlugin(root, 'high', {
    claims: { GIFT: 100 },
    onEventSrc: `globalThis.__asked = globalThis.__asked || []; globalThis.__asked.push('high'); return true`,
  })

  const host = new PluginHost({ dir: root })
  await host.load()
  globalThis.__asked = []

  const r = await host.dispatch({ type: 'GIFT', payload: {} })

  assert.equal(r.claimedBy, 'high', '优先级高的先被问，且它认领了')
  assert.deepEqual(globalThis.__asked, ['high'], '低优先级插件根本不该被调用')
  assert.deepEqual(r.asked, ['high'])
  delete globalThis.__asked
  void asked
})

test('仲裁：高优先级插件不认领时，顺延给下一个', async (t) => {
  const root = tmp(t)
  makePlugin(root, 'high', { claims: { GIFT: 100 }, onEventSrc: 'return false' })
  makePlugin(root, 'low', { claims: { GIFT: 10 }, onEventSrc: 'return true' })

  const host = new PluginHost({ dir: root })
  await host.load()
  const r = await host.dispatch({ type: 'GIFT', payload: {} })

  assert.equal(r.claimedBy, 'low')
  assert.deepEqual(r.asked, ['high', 'low'])
})

test('仲裁：没声明 claims 的插件收不到事件', async (t) => {
  const root = tmp(t)
  makePlugin(root, 'silent', { onEventSrc: 'return true' })
  const host = new PluginHost({ dir: root })
  await host.load()

  const r = await host.dispatch({ type: 'ENTER', payload: {} })
  assert.equal(r.claimedBy, null)
  assert.deepEqual(r.asked, [])
})

test('仲裁：插件抛异常不会中断整条分发链', async (t) => {
  const root = tmp(t)
  makePlugin(root, 'high', { claims: { GIFT: 100 }, onEventSrc: 'throw new Error("炸了")' })
  makePlugin(root, 'low', { claims: { GIFT: 10 }, onEventSrc: 'return true' })

  const host = new PluginHost({ dir: root })
  await host.load()
  const r = await host.dispatch({ type: 'GIFT', payload: {} })

  assert.equal(r.claimedBy, 'low', '前面的插件炸了，后面仍要收到事件')
  assert.equal(host.plugins.get('high').stats.errors, 1)
})

test('仲裁：通配 claims 能收到所有事件', () => {
  assert.equal(claimPriority({ claims: { '*': 5 } }, 'DANMAKU'), 5)
  assert.equal(claimPriority({ claims: { GIFT: 1 } }, 'ENTER'), null)
})

/** 造一个会记录自己执行轨迹的插件，用来验证"顺序"与"并发" */
function makeProbe(root, id, delayMs = 15) {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', claims: { DANMAKU: 100 } }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(dir, 'plugin.mjs'),
    `export default {
  id: ${JSON.stringify(id)},
  onEdge(ctx, edge) { (globalThis.__trace ??= []).push('edge:' + edge) },
  async onEvent(ctx, ev) {
    const g = (globalThis.__trace ??= [])
    const n = ev.payload && ev.payload.n
    g.push('enter:' + n)
    globalThis.__live = (globalThis.__live ?? 0) + 1
    globalThis.__peak = Math.max(globalThis.__peak ?? 0, globalThis.__live)
    await new Promise((r) => setTimeout(r, ${delayMs}))
    globalThis.__live--
    g.push('leave:' + n)
    return false
  }
}
`,
    'utf8',
  )
  return dir
}

function resetProbe() {
  globalThis.__trace = []
  globalThis.__live = 0
  globalThis.__peak = 0
}

/* ═══════════════ 串行投递 ═══════════════ */

test('投递：同一插件的多条事件严格串行，不会重叠执行', async (t) => {
  const dir = tmp(t)
  makeProbe(dir, 'probe', 15)
  const host = new PluginHost({ dir })
  await host.load()
  resetProbe()

  // 像收包一样连着投递，一个都不 await —— 这正是 room-runner 的真实姿势
  const pending = [1, 2, 3, 4].map((n) => host.deliver({ type: 'DANMAKU', payload: { n } }))
  await Promise.all(pending)

  assert.deepEqual(
    globalThis.__trace,
    ['enter:1', 'leave:1', 'enter:2', 'leave:2', 'enter:3', 'leave:3', 'enter:4', 'leave:4'],
    '插件看到的事件顺序必须与投递顺序一致，且前一条处理完才进下一条',
  )
  assert.equal(globalThis.__peak, 1, `同一插件不允许并发进入 onEvent，实测峰值 ${globalThis.__peak}`)
})

test('投递：边沿事件先于同一事件的处理（不该先看到弹幕再看到开播）', async (t) => {
  const dir = tmp(t)
  makeProbe(dir, 'probe', 1)
  const host = new PluginHost({ dir })
  await host.load()
  resetProbe()

  await host.deliver({ type: 'DANMAKU', payload: { n: 7 } }, 'live_started')

  assert.deepEqual(globalThis.__trace, ['edge:live_started', 'enter:7', 'leave:7'])
})

test('投递：队列积压到上限时丢弃新事件，并计入 dropped（不静默）', async (t) => {
  const dir = tmp(t)
  makeProbe(dir, 'probe', 1)
  const host = new PluginHost({ dir })
  await host.load()

  // 白盒：直接把队列撑到上限，比真投 5000 条快得多。
  // 要验的是"满了怎么办"，不是"怎么满的"。
  host._queue.length = host.snapshot().queue.max
  const r = await host.deliver({ type: 'DANMAKU', payload: { n: 0 } })

  assert.equal(r.ok, false)
  assert.equal(r.reason, 'queue_full')
  assert.equal(host.dropped, 1)
  assert.equal(host.snapshot().queue.dropped, 1, '丢弃必须出现在快照里，界面上才看得见')

  host._queue.length = 0
})

test('投递：没有任何插件认领时也能正常返回', async (t) => {
  const dir = tmp(t)
  makeProbe(dir, 'probe', 1)
  const host = new PluginHost({ dir })
  await host.load()

  const r = await host.deliver({ type: 'LIKE', payload: {} })
  assert.equal(r.ok, true)
  assert.equal(r.claimedBy, null)
})

/* ═══════════════ 欢迎插件 ═══════════════ */

async function welcomeHost(t, config = {}) {
  const says = []
  const host = new PluginHost({
    dir: PLUGIN_DIR,
    say: async (args) => {
      says.push(args)
      return { ok: true, text: args.text }
    },
    getState: () => ({ roomId: '999' }),
    configs: { welcome: config },
  })
  await host.load()
  await host.startAll()
  t.after(async () => host.stopAll())
  return { host, says }
}

test('欢迎：进场时说欢迎语，并把 @ 一起带上', async (t) => {
  const { host, says } = await welcomeHost(t)

  const r = await host.dispatch({
    type: 'ENTER',
    payload: { uid: 1001, uname: '小明', medal: null, guardLevel: 0 },
  })

  assert.equal(r.claimedBy, 'welcome')
  assert.equal(says.length, 1)
  assert.equal(says[0].text, '欢迎 小明 来到直播间')
  assert.equal(says[0].reason, 'welcome')
  assert.equal(says[0].source, 'welcome')
  assert.deepEqual(says[0].reply, { uid: 1001, uname: '小明' })
  assert.equal(host.plugins.get('welcome').stats.sent, 1, '说出去的才计入 sent')
})

test('欢迎：同一人冷却期内不重复欢迎（反复进出是最常见的刷屏来源）', async (t) => {
  const { host, says } = await welcomeHost(t, { cooldownSec: 90 })

  await host.dispatch({ type: 'ENTER', payload: { uid: 1001, uname: '小明' } })
  await host.dispatch({ type: 'ENTER', payload: { uid: 1001, uname: '小明' } })

  assert.equal(says.length, 1, '第二句要被冷却拦下')
})

test('欢迎：冷却按事件时间算 —— 两小时后重新进场要再欢迎一次', async (t) => {
  // 沙盒把一晚上压成几百毫秒。冷却若读 Date.now()，两小时后的第二次进场
  // 会被"90 秒冷却"挡住 —— 回放比当时少说一句，而且没有任何提示。
  // 这里显式关掉「本场一次」，只留冷却这一道闸门。
  const { host, says } = await welcomeHost(t, { cooldownSec: 90, oncePerSession: false })
  const t0 = 1_800_000_000_000

  await host.dispatch({ type: 'ENTER', ts: t0, payload: { uid: 1001, uname: '小明' } })
  await host.dispatch({ type: 'ENTER', ts: t0 + 10_000, payload: { uid: 1001, uname: '小明' } })
  assert.equal(says.length, 1, '10 秒内重复进场要挡住')

  await host.dispatch({ type: 'ENTER', ts: t0 + 2 * 3600_000, payload: { uid: 1001, uname: '小明' } })
  assert.equal(says.length, 2, '两小时后重新进场，冷却早过了')
})

test('欢迎：冷却 0 表示不限（要连「本场一次」一起关掉才是真的不限）', async (t) => {
  // 现在有两道闸门了。只把冷却设成 0，第二句仍会被「本场只欢迎一次」拦下 ——
  // 这条测的是「冷却」本身，所以必须把另一道闸门显式关掉。
  const { host, says } = await welcomeHost(t, { cooldownSec: 0, oncePerSession: false })
  await host.dispatch({ type: 'ENTER', payload: { uid: 1001, uname: '小明' } })
  await host.dispatch({ type: 'ENTER', payload: { uid: 1001, uname: '小明' } })
  assert.equal(says.length, 2)
})

test('欢迎：冷却 0 也挡不住「本场只欢迎一次」（两道闸门各自独立）', async (t) => {
  // 反向验证：把 oncePerSession 去掉（回到只有冷却的旧写法），
  // 下面这个断言就必须失败。它证明新闸门真的在起作用，不是测试碰巧过。
  const { host, says } = await welcomeHost(t, { cooldownSec: 0, oncePerSession: true })
  await host.dispatch({ type: 'ENTER', payload: { uid: 1001, uname: '小明' } })
  await host.dispatch({ type: 'ENTER', payload: { uid: 1001, uname: '小明' } })
  assert.equal(says.length, 1, '第二句要被「本场一次」拦下，而不是被冷却拦下')
})

test('欢迎：关掉开关后不再说话，也不能认领事件', async (t) => {
  const { host, says } = await welcomeHost(t, { enabled: false })
  const r = await host.dispatch({ type: 'ENTER', payload: { uid: 1001, uname: '小明' } })
  assert.equal(r.claimedBy, null)
  assert.equal(says.length, 0)
})

test('欢迎：上舰走上舰文案，且带上舰长名称', async (t) => {
  const { host, says } = await welcomeHost(t)

  await host.dispatch({
    type: 'GUARD_BUY',
    payload: { uid: 1002, uname: '土豪', guardLevel: 3, num: 1 },
  })

  assert.equal(says.length, 1)
  assert.equal(says[0].text, '感谢 土豪 开通舰长！')
  assert.equal(says[0].reason, 'guard')
})

test('欢迎：续费舰长用续费文案，不说"开通"', async (t) => {
  const { host, says } = await welcomeHost(t)

  await host.dispatch({
    type: 'GUARD_BUY',
    payload: { uid: 1003, uname: '老舰长', guardLevel: 3, num: 1, isRenew: true },
  })

  assert.equal(says.length, 1)
  assert.equal(says[0].text, '感谢 老舰长 续费舰长！')
  assert.equal(says[0].reason, 'guard_renew')
})

test('欢迎：续费文案留空时回落到上舰文案（不能因为没填就不吭声）', async (t) => {
  const { host, says } = await welcomeHost(t, { renewTemplate: '' })

  await host.dispatch({
    type: 'GUARD_BUY',
    payload: { uid: 1004, uname: '老舰长', guardLevel: 3, num: 1, isRenew: true },
  })

  assert.equal(says.length, 1, '字段没填也得说一句')
  assert.equal(says[0].text, '感谢 老舰长 开通舰长！')
})

test('欢迎：关掉"单独欢迎上舰"后，上舰不再播报', async (t) => {
  const { host, says } = await welcomeHost(t, { welcomeGuard: false })
  const r = await host.dispatch({
    type: 'GUARD_BUY',
    payload: { uid: 1002, uname: '土豪', guardLevel: 3 },
  })
  assert.equal(r.claimedBy, null)
  assert.equal(says.length, 0)
})

test('欢迎：有人关注时说关注文案（关注是留人，不是花钱，但也要有回应）', async (t) => {
  const { host, says } = await welcomeHost(t)

  const r = await host.dispatch({ type: 'FOLLOW', payload: { uid: 3001, uname: '新粉丝' } })

  assert.equal(r.claimedBy, 'welcome')
  assert.equal(says.length, 1)
  assert.equal(says[0].text, '感谢 新粉丝 关注！')
  assert.equal(says[0].reason, 'follow')
})

/**
 * 这条是这次改动里最容易写错的地方。
 *
 * B站 在关注后常常**再推一条进场**。如果关注和进场各自判冷却，
 * 观众会连着收到「感谢关注」+「欢迎来到直播间」两句 —— 关注本来是
 * 好事，结果变成了刷屏。
 *
 * 共用一张冷却表就能解决：先到的那条说，后到的那条被挡住。
 * 两种顺序都要对，所以下面两条用例分别覆盖「关注在前」和「进场在前」。
 */
test('欢迎：关注后紧跟进场，只发一条（共用冷却表）', async (t) => {
  const { host, says } = await welcomeHost(t, { cooldownSec: 90 })

  await host.dispatch({ type: 'FOLLOW', payload: { uid: 3002, uname: '新粉丝' } })
  await host.dispatch({ type: 'ENTER', payload: { uid: 3002, uname: '新粉丝' } })

  assert.equal(says.length, 1, '关注已经说过，随后的进场必须被冷却挡住')
  assert.equal(says[0].reason, 'follow')
})

test('欢迎：先进场后关注，也只发一条（反过来也必须挡住）', async (t) => {
  const { host, says } = await welcomeHost(t, { cooldownSec: 90 })

  await host.dispatch({ type: 'ENTER', payload: { uid: 3003, uname: '路过' } })
  await host.dispatch({ type: 'FOLLOW', payload: { uid: 3003, uname: '路过' } })

  assert.equal(says.length, 1)
  assert.equal(says[0].reason, 'welcome')
})

test('欢迎：本场欢迎过，之后关注仍然单独谢（本场一次只挡重复进场）', async (t) => {
  const { host, says } = await welcomeHost(t, { cooldownSec: 0, oncePerSession: true })

  await host.dispatch({ type: 'ENTER', payload: { uid: 3005, uname: '常驻' } })
  await host.dispatch({ type: 'FOLLOW', payload: { uid: 3005, uname: '常驻' } })

  assert.equal(says.length, 2, '开场欢迎过，不代表这次关注可以不说')
  assert.equal(says[0].reason, 'welcome')
  assert.equal(says[1].reason, 'follow')
})

test('欢迎：本场欢迎过，之后上舰仍然要谢（花钱不该被吞）', async (t) => {
  const { host, says } = await welcomeHost(t, { cooldownSec: 0, oncePerSession: true })

  await host.dispatch({ type: 'ENTER', payload: { uid: 3006, uname: '舰长' } })
  await host.dispatch({
    type: 'GUARD_BUY',
    payload: { uid: 3006, uname: '舰长', guardLevel: 3, battery: 198000 },
  })

  assert.equal(says.length, 2)
  assert.equal(says[1].reason, 'guard')
})

test('欢迎：关掉"感谢关注"后，关注既不发言也不认领', async (t) => {
  const { host, says } = await welcomeHost(t, { welcomeFollow: false })
  const r = await host.dispatch({ type: 'FOLLOW', payload: { uid: 3004, uname: '新粉丝' } })
  assert.equal(r.claimedBy, null)
  assert.equal(says.length, 0)
})

test('欢迎：有人分享直播间时说分享文案，并带上结构化 @', async (t) => {
  const { host, says } = await welcomeHost(t)

  const r = await host.dispatch({ type: 'SHARE', payload: { uid: 3101, uname: '热心观众' } })

  assert.equal(r.claimedBy, 'welcome', '分享这条事件要能被认领，否则别的插件也可能来处理')
  assert.equal(says.length, 1)
  assert.equal(says[0].text, '谢谢 热心观众 分享直播间～')
  assert.equal(says[0].reason, 'share')
  // 不带 reply 的话，分享的人收不到任何通知，等于白谢
  assert.deepEqual(says[0].reply, { uid: 3101, uname: '热心观众' })
})

test('欢迎：关掉「感谢分享」后，分享既不发言也不认领', async (t) => {
  const { host, says } = await welcomeHost(t, { welcomeShare: false })
  const r = await host.dispatch({ type: 'SHARE', payload: { uid: 3102, uname: '热心观众' } })
  assert.equal(r.claimedBy, null)
  assert.equal(says.length, 0)
})

test('欢迎：分享后紧跟进场，只发一条（和关注共用同一张冷却表）', async (t) => {
  const { host, says } = await welcomeHost(t, { cooldownSec: 90 })

  await host.dispatch({ type: 'SHARE', payload: { uid: 3103, uname: '热心观众' } })
  await host.dispatch({ type: 'ENTER', payload: { uid: 3103, uname: '热心观众' } })

  assert.equal(says.length, 1, '分享已经谢过，随后的进场必须被冷却挡住')
  assert.equal(says[0].reason, 'share')
})

test('欢迎：没有名字的人不处理（没东西可称呼），留给别的插件', async (t) => {
  const { host, says } = await welcomeHost(t)
  const r = await host.dispatch({ type: 'ENTER', payload: { uid: 0, uname: '' } })
  assert.equal(r.claimedBy, null)
  assert.equal(says.length, 0)
})

test('欢迎：粉丝牌渲染成「名字+等级」，没有粉丝牌时不留空洞', async (t) => {
  const { host, says } = await welcomeHost(t, {
    template: '{用户}[{粉丝牌}] 来了',
  })

  await host.dispatch({
    type: 'ENTER',
    payload: { uid: 2001, uname: '有牌子', medal: { name: '脆鲨', level: 4 } },
  })
  await host.dispatch({
    type: 'ENTER',
    payload: { uid: 2002, uname: '没牌子', medal: null },
  })

  assert.equal(says[0].text, '有牌子[脆鲨4] 来了')
  assert.equal(says[1].text, '没牌子[] 来了')
})

test('插件拿不到发送后门：ctx 里没有 send，只有 say', async (t) => {
  const root = tmp(t)
  const dir = join(root, 'probe')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ id: 'probe', name: 'P', version: '1.0.0', claims: { ENTER: 1 } }),
    'utf8',
  )
  // 插件尝试找后门：如果有 send / log 实例 / eventLog，就把它名字报出来
  writeFileSync(
    join(dir, 'plugin.mjs'),
    `export default {
       id: 'probe',
       seen: null,
       onEvent(ctx) {
         this.seen = Object.keys(ctx).sort()
         return true
       }
     }\n`,
    'utf8',
  )

  const host = new PluginHost({ dir: root })
  await host.load()
  await host.dispatch({ type: 'ENTER', payload: {} })

  const seen = host.plugins.get('probe').impl.seen
  assert.ok(seen.includes('say'), '要能请求发言')
  for (const forbidden of ['send', 'eventLog', 'host', 'kernel', 'record']) {
    assert.ok(!seen.includes(forbidden), `ctx 不该暴露 ${forbidden}`)
  }
})

test('宿主：热改配置立即生效', async (t) => {
  const { host, says } = await welcomeHost(t, { template: '欢迎 {用户}' })

  host.updateConfig('welcome', { template: '嗨 {用户}' })
  await host.dispatch({ type: 'ENTER', payload: { uid: 3001, uname: 'A' } })

  assert.equal(says[0].text, '嗨 A')
})

test('插件：请求发言时闸门抛错，也不能变成未处理的 Promise 拒绝', async (t) => {
  const root = tmp(t)
  makePlugin(root, 'boom', {
    claims: { ENTER: 5 },
    // 插件照常见写法调用 say 而不 await —— 绝大多数插件都会这么写
    onEventSrc: `ctx.say('说一句'); return true`,
  })

  const host = new PluginHost({
    dir: root,
    // 闸门内部出错（比如磁盘写满导致记日志失败）
    say: () => {
      throw new Error('闸门炸了')
    },
  })
  await host.load()

  // 不抛出、不 reject：Node 默认把未处理的 Promise 拒绝当致命错误，
  // 让"某个插件请求发言失败"升级成"整个机器人挂掉"是最糟的失败方式
  const r = await host.dispatch({ type: 'ENTER', payload: {} })
  assert.equal(r.claimedBy, 'boom')

  await new Promise((res) => setTimeout(res, 10))
  assert.equal(host.plugins.get('boom').stats.errors, 1)
  assert.match(host.plugins.get('boom').stats.lastError, /闸门炸了/)
})

test('插件：发送失败不计入 sent（「认领」与「发言」的差额要能看出来）', async (t) => {
  const root = tmp(t)
  makePlugin(root, 'talk', {
    claims: { ENTER: 5 },
    onEventSrc: `ctx.say('hi'); return true`,
  })

  let allow = false
  const host = new PluginHost({
    dir: root,
    say: async () => (allow ? { ok: true, text: 'hi' } : { ok: false, skipped: 'interval', text: '' }),
  })
  await host.load()

  await host.dispatch({ type: 'ENTER', payload: {} })
  await new Promise((res) => setTimeout(res, 5))
  assert.equal(host.plugins.get('talk').stats.sent, 0, '被闸门拦下的不算发言')

  allow = true
  await host.dispatch({ type: 'ENTER', payload: {} })
  await new Promise((res) => setTimeout(res, 5))
  assert.equal(host.plugins.get('talk').stats.sent, 1)
})

test('插件：ctx.state 能真正拿到房间状态（这里曾经永远是 null）', async (t) => {
  const root = tmp(t)
  makePlugin(root, 'peek', { claims: { ENTER: 5 }, onEventSrc: `this.seen = ctx.state; return true` })

  const host = new PluginHost({ dir: root, getState: () => ({ roomId: '123', state: 'live' }) })
  await host.load()
  await host.dispatch({ type: 'ENTER', payload: {} })

  const seen = host.plugins.get('peek').impl.seen
  assert.equal(seen?.roomId, '123', 'ctx.state 曾经恒为 null：getter 里的 this 指向 ctx 对象而不是宿主')
})

test('宿主：边沿事件分发给所有插件，不参与仲裁', async (t) => {
  const root = tmp(t)
  makePlugin(root, 'edge-a', { claims: {}, manifest: {} })
  writeFileSync(
    join(root, 'edge-a', 'plugin.mjs'),
    `export default { id: 'edge-a', onEdge(ctx, edge) { globalThis.__edges = globalThis.__edges || []; globalThis.__edges.push(edge) } }\n`,
    'utf8',
  )

  const host = new PluginHost({ dir: root })
  await host.load()
  assert.equal(host.errors.length, 0, `加载不该出错：${JSON.stringify(host.errors)}`)

  globalThis.__edges = []
  await host.dispatchEdge('live_started', { type: 'LIVE_START' })

  assert.deepEqual(globalThis.__edges, ['live_started'])
  delete globalThis.__edges
})
