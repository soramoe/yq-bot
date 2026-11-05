/**
 * 发送链路自检（全离线，不打 B站 接口）。
 *
 * 这一组测的不是"能不能发出去"，而是**发不出去时会不会说清楚原因**：
 * 二代最难的故障是"能连、能收，但发不出去"，日志里只有一行 code=-111，
 * 没人知道是 csrf 还是封禁。所以错误分类和提示文案都当成功能来测。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  sendDanmaku,
  prepareText,
  classify,
  checkCredential,
  csrfOf,
  describeCode,
  MAX_TEXT,
} from '../bili/send.mjs'
import { SendGate, simulateSendGate } from '../core/gate.mjs'
import { EventLog } from '../core/event-log.mjs'
import { Projection } from '../core/projection.mjs'

const ROOM = '1901584685'
const GOOD_COOKIE = 'SESSDATA=abc123; bili_jct=csrf456; DedeUserID=3273440'

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yy3-send-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

/** 假的发送实现：记录每次调用，返回预设结果 */
function fakePost(result = { code: 0 }) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    if (result instanceof Error) throw result
    return { json: result, status: 200, setCookies: [], headers: new Headers() }
  }
  fn.calls = calls
  return fn
}

/* ═══════════════ 文本清洗 ═══════════════ */

test('发送：弹幕是单行的，换行与制表符必须清掉', () => {
  const r = prepareText('你好\n世界\t！')
  assert.equal(r.text, '你好 世界 ！')
  assert.equal(r.truncated, false)
})

test('发送：超长按上限截断，并标记 truncated', () => {
  const long = '一'.repeat(50)
  const r = prepareText(long)
  assert.equal(r.text.length, MAX_TEXT)
  assert.equal(r.truncated, true)
  assert.equal(r.original, long, '原文要留着，便于排查"为什么少了几个字"')
})

test('发送：截断不许把一个 emoji 切成两半（会留下孤立代理项）', () => {
  // 这个名字刚好把 20 字上限卡在一个 emoji 中间：19 个汉字 + 😀（2 个码元）＝ 21
  const name = '一'.repeat(19) + '😀'
  const r = prepareText(name, { max: 20 })

  assert.equal(r.truncated, true)
  assert.ok(r.text.length <= 20, `不能超上限，实际 ${r.text.length}`)

  // 孤立代理项：码元层面看着像字符，实际是半个，发出去是乱码方块
  for (const ch of r.text) {
    const cp = ch.codePointAt(0)
    assert.ok(cp < 0xd800 || cp > 0xdfff, '截断位置落到了代理项中间')
  }
  // 剩下的部分必须是完整的汉字，不能是"19 个汉字 + 半个 emoji"
  assert.equal(r.text, '一'.repeat(19))
})

test('发送：截断正好落在字符边界时不吞字符', () => {
  const r = prepareText('😂'.repeat(15), { max: 20 })
  assert.equal(r.text, '😂'.repeat(10), '20 个码元正好 10 个 emoji')
  assert.equal(r.truncated, true)
})

test('发送：连续空白压成一个空格，首尾去掉', () => {
  assert.equal(prepareText('  a     b  ').text, 'a b')
})

/* ═══════════════ 凭证检查 ═══════════════ */

test('凭证：只有 SESSDATA 没有 bili_jct 必须提前拦下（这是发不出去的典型现场）', () => {
  const r = checkCredential('SESSDATA=only_this')
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['bili_jct'], '要指名缺哪个，不能只说"凭证不全"')
})

test('凭证：csrf 取自 bili_jct', () => {
  assert.equal(csrfOf(GOOD_COOKIE), 'csrf456')
  assert.equal(csrfOf('SESSDATA=x'), '')
})

/* ═══════════════ 错误码分类 ═══════════════ */

test('错误码：风控与权限类是 fatal，限流类是 retry', () => {
  assert.equal(classify(0), 'ok')
  assert.equal(classify(-101), 'fatal', '未登录')
  assert.equal(classify(-111), 'fatal', 'csrf 错误')
  assert.equal(classify(-352), 'fatal', '风控验证')
  assert.equal(classify(10030), 'fatal', '安全策略拦截：重试同一条只会再被拦')
  assert.equal(classify(-799), 'retry', '服务端限速')
  assert.equal(classify(10031), 'retry')
})

test('错误码：没见过的码按 fatal 处理（fail-safe）', () => {
  // 风控码的典型形态就是"没见过的新码"。当成 retry 等于在最该停下的时刻继续发。
  assert.equal(classify(-88888), 'fatal')
  assert.equal(classify(2000123), 'fatal')
})

test('错误码：常见码有中文说明', () => {
  assert.match(describeCode(-111), /bili_jct/)
  assert.match(describeCode(1003212), /长度/)
  assert.equal(describeCode(-99999), '', '查不到时返回空串，由调用方展示原始 message')
})

/* ═══════════════ 发送本体 ═══════════════ */

test('发送：成功时参数齐全（csrf / roomid / msg）', async () => {
  const post = fakePost({ code: 0 })
  const r = await sendDanmaku({ roomId: ROOM, text: '你好', cookie: GOOD_COOKIE, post })

  assert.equal(r.ok, true)
  assert.equal(r.kind, 'ok')
  assert.equal(post.calls.length, 1)

  const body = new URLSearchParams(post.calls[0].opts.body)
  assert.equal(body.get('csrf'), 'csrf456')
  assert.equal(body.get('csrf_token'), 'csrf456')
  assert.equal(body.get('roomid'), ROOM)
  assert.equal(body.get('msg'), '你好')
  assert.equal(body.get('mode'), '1')
})

test('发送：带 @ 时必须用结构化字段（纯文本 @ 在 B站 无效）', async () => {
  const post = fakePost({ code: 0 })
  await sendDanmaku({
    roomId: ROOM,
    text: '欢迎来到直播间',
    cookie: GOOD_COOKIE,
    reply: { uid: 12345, uname: '小明' },
    post,
  })

  const body = new URLSearchParams(post.calls[0].opts.body)
  assert.equal(body.get('reply_mid'), '12345')
  assert.equal(body.get('reply_uname'), '小明')
  assert.equal(body.get('show_reply'), 'true')
})

test('发送：正文里已经写了名字时不再挂结构化 @，避免名字出现两遍', async () => {
  const post = fakePost({ code: 0 })
  await sendDanmaku({
    roomId: ROOM,
    text: '感谢小明送出的礼物',
    cookie: GOOD_COOKIE,
    reply: { uid: 12345, uname: '小明' },
    post,
  })

  const body = new URLSearchParams(post.calls[0].opts.body)
  assert.equal(body.get('msg'), '感谢小明送出的礼物')
  assert.equal(body.get('reply_mid'), null, '名字已经在正文里了')
  assert.equal(body.get('show_reply'), null)
})

test('发送：不带 @ 时不要出现 reply 字段（多余字段可能触发风控）', async () => {
  const post = fakePost({ code: 0 })
  await sendDanmaku({ roomId: ROOM, text: '普通弹幕', cookie: GOOD_COOKIE, post })
  const body = new URLSearchParams(post.calls[0].opts.body)
  assert.equal(body.get('reply_mid'), null)
  assert.equal(body.get('show_reply'), null)
})

test('发送：凭证不全时不发请求，并直接给出可读原因', async () => {
  const post = fakePost({ code: 0 })
  const r = await sendDanmaku({ roomId: ROOM, text: '你好', cookie: 'SESSDATA=x', post })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'fatal')
  assert.match(r.message, /bili_jct/)
  assert.equal(post.calls.length, 0, '既然发不出去，就不要再打接口')
})

test('发送：内容为空不请求接口', async () => {
  const post = fakePost({ code: 0 })
  const r = await sendDanmaku({ roomId: ROOM, text: '   \n  ', cookie: GOOD_COOKIE, post })
  assert.equal(r.ok, false)
  assert.equal(post.calls.length, 0)
})

test('发送：网络异常归类为 retry，不是 fatal', async () => {
  const post = fakePost(new Error('socket hang up'))
  const r = await sendDanmaku({ roomId: ROOM, text: '你好', cookie: GOOD_COOKIE, post })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'retry')
  assert.match(r.message, /网络异常/)
})

test('发送：超长文本被截断后才发出（宁可少几个字，也别一条都发不出去）', async () => {
  const post = fakePost({ code: 0 })
  const r = await sendDanmaku({
    roomId: ROOM,
    text: '这是一条特别特别长的欢迎语，长到超过了二十个字的上限',
    cookie: GOOD_COOKIE,
    post,
  })
  const body = new URLSearchParams(post.calls[0].opts.body)
  assert.equal(body.get('msg').length, MAX_TEXT)
  assert.equal(r.truncated, true)
})

/* ═══════════════ 内核闸门 ═══════════════ */

function makeGate(t, overrides = {}) {
  const calls = []
  const records = []
  const gate = new SendGate({
    send: async (args) => {
      calls.push(args)
      return { ok: true, code: 0, kind: 'ok', message: '发送成功' }
    },
    record: (type, payload) => records.push({ type, payload }),
    now: overrides.now ?? Date.now,
    sleep: overrides.sleep ?? null,
    config: { minIntervalMs: 0, dedupeWindowMs: 0, ...overrides.config },
  })
  return { gate, calls, records }
}

test('闸门：正常发送会记一条 SENT 事件', async (t) => {
  const { gate, calls, records } = makeGate(t)
  const r = await gate.say({ roomId: ROOM, text: '欢迎小明', reason: 'welcome', source: 'welcome' })

  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(records.length, 1)
  assert.equal(records[0].type, 'SENT')
  assert.equal(records[0].payload.text, '欢迎小明')
  assert.equal(records[0].payload.reason, 'welcome')
  assert.equal(records[0].payload.source, 'welcome')
})

test('闸门：正文已带昵称时不再挂结构化 @，也不在事件里记 reply', async (t) => {
  const { gate, calls, records } = makeGate(t)
  await gate.say({
    roomId: ROOM,
    text: '欢迎小明',
    reply: { uid: 456, uname: '小明' },
    reason: 'welcome',
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].reply, null, '名字已经在正文里，不能再挂 @')
  assert.equal(records[0].payload.replyUid, null)
})

test('闸门：正文没写昵称时照常挂结构化 @', async (t) => {
  const { gate, calls, records } = makeGate(t)
  await gate.say({
    roomId: ROOM,
    text: '欢迎来到直播间',
    reply: { uid: 456, uname: '小明' },
    reason: 'welcome',
  })

  assert.equal(calls[0].reply?.uid, 456)
  assert.equal(records[0].payload.replyUid, 456)
})

test('闸门：演练模式不真发，但照样记 SENT（标记 dryRun）', async (t) => {
  const { gate, calls, records } = makeGate(t, { config: { dryRun: true } })
  const r = await gate.say({ roomId: ROOM, text: '演练一句' })

  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(calls.length, 0, '演练不能真的发出去')
  assert.equal(records.length, 1)
  assert.equal(records[0].payload.dryRun, true, '日志里要能区分演练与实战')
})

test('闸门：最小间隔之内的第二句被拦下，并告诉还要等多久', async (t) => {
  let clock = 1000
  const { gate, calls } = makeGate(t, { now: () => clock, config: { minIntervalMs: 1200 } })

  const a = await gate.say({ roomId: ROOM, text: '第一句' })
  clock += 300
  const b = await gate.say({ roomId: ROOM, text: '第二句' })

  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  assert.equal(b.skipped, 'interval')
  assert.equal(b.waitMs, 900, '要算出还差多少毫秒，而不是只说"太快了"')
  assert.equal(calls.length, 1)

  clock += 1000 // 累计 1300ms
  const c = await gate.say({ roomId: ROOM, text: '第三句' })
  assert.equal(c.ok, true, '过了间隔就该放行')
})

test('闸门：高优先级消息会等一个槽位，不会被进场欢迎挤掉', async (t) => {
  let clock = 1000
  const { gate, calls, records } = makeGate(t, {
    now: () => clock,
    // 假 sleep：只推进时钟，不真的等
    sleep: async (ms) => {
      clock += ms
    },
    config: { minIntervalMs: 1200 },
  })

  await gate.say({ roomId: ROOM, text: '欢迎 A' })

  // 实测场景：热闹房间里每 300ms 就有人进场，礼物答谢永远排不上
  clock += 300
  const r = await gate.say({
    roomId: ROOM,
    text: '感谢小明的小花花',
    reason: 'gift',
    priority: 1,
    maxWaitMs: 3000,
  })

  assert.equal(r.ok, true, '花了钱的消息应当等到槽位，而不是被丢掉')
  assert.equal(calls.length, 2)
  assert.equal(gate.counters.waited, 1)
  assert.equal(gate.counters.gaveUp, 0)
  assert.equal(records.at(-1).payload.reason, 'gift')
})

test('闸门：低优先级消息仍然直接丢（一次进场欢迎不值得排队）', async (t) => {
  let clock = 1000
  const { gate } = makeGate(t, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    config: { minIntervalMs: 1200 },
  })

  await gate.say({ roomId: ROOM, text: '欢迎 A' })
  clock += 300
  const r = await gate.say({ roomId: ROOM, text: '欢迎 B' })

  assert.equal(r.ok, false)
  assert.equal(r.skipped, 'interval')
  assert.equal(gate.counters.waited, 0, '低优先级不许等')
  assert.equal(gate.counters.blockedInterval, 1)
})

test('闸门：等待超过上限就放弃，不会把闸门变成无限队列', async (t) => {
  let clock = 1000
  const { gate, calls } = makeGate(t, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    config: { minIntervalMs: 60_000 },
  })

  await gate.say({ roomId: ROOM, text: '欢迎 A' })
  clock += 100

  const r = await gate.say({ roomId: ROOM, text: '感谢小明', priority: 1, maxWaitMs: 3000 })

  assert.equal(r.ok, false, '要等 59.9 秒，超过上限，必须放弃')
  assert.equal(calls.length, 1)
  assert.equal(gate.counters.waited, 0, '一开始就该判断出等不起')
  assert.equal(gate.counters.blockedInterval, 1)
})

test('闸门：去重拦下的高优先级消息不等待（等完还是同一句话）', async (t) => {
  let clock = 1000
  const { gate } = makeGate(t, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    config: { dedupeWindowMs: 30_000 },
  })

  await gate.say({ roomId: ROOM, text: '感谢小花花' })
  clock += 5000
  const r = await gate.say({
    roomId: ROOM,
    text: '感谢小花花',
    priority: 1,
    maxWaitMs: 3000,
  })

  assert.equal(r.ok, false)
  assert.equal(r.skipped, 'duplicate')
  assert.equal(gate.counters.waited, 0)
  assert.equal(gate.counters.blockedDedupe, 1)
})

test('闸门：同一句话在去重窗口内不重复发（连击礼物最容易触发）', async (t) => {
  let clock = 1000
  const { gate, calls } = makeGate(t, { now: () => clock, config: { dedupeWindowMs: 30_000 } })

  await gate.say({ roomId: ROOM, text: '感谢小花花' })
  clock += 5000
  const b = await gate.say({ roomId: ROOM, text: '感谢小花花' })

  assert.equal(b.ok, false)
  assert.equal(b.skipped, 'duplicate')
  assert.equal(calls.length, 1, '重复的一句不该被发出去')

  // 内容不同则可以发
  clock += 100
  const c = await gate.say({ roomId: ROOM, text: '感谢小心心' })
  assert.equal(c.ok, true)
})

test('闸门：演练模式同样占用时间槽与去重窗口', async (t) => {
  let clock = 1000
  const { gate, calls } = makeGate(t, {
    now: () => clock,
    config: { dryRun: true, minIntervalMs: 1200, dedupeWindowMs: 0 },
  })

  await gate.say({ roomId: ROOM, text: '演练一' })
  clock += 300
  const b = await gate.say({ roomId: ROOM, text: '演练二' })

  assert.equal(b.ok, false, '演练不该一路畅通 —— 否则演练结果不能代表实战')
  assert.equal(b.skipped, 'interval')
  assert.equal(calls.length, 0)
})

test('闸门：切换 dryRun 立即生效，不用重建', async (t) => {
  const { gate, calls } = makeGate(t, { config: { minIntervalMs: 0, dedupeWindowMs: 0 } })
  await gate.say({ roomId: ROOM, text: '一' })
  assert.equal(calls.length, 1)

  gate.update({ dryRun: true })
  const r = await gate.say({ roomId: ROOM, text: '二' })
  assert.equal(r.dryRun, true)
  assert.equal(calls.length, 1, '切到演练后不能再真发')
})

test('闸门：不同房间各自计时', async (t) => {
  let clock = 1000
  const { gate, calls } = makeGate(t, { now: () => clock, config: { minIntervalMs: 1200 } })

  await gate.say({ roomId: '111', text: '房间一的' })
  await gate.say({ roomId: '222', text: '房间二的' })
  assert.equal(calls.length, 2, '一个房间说满了不该影响另一个房间')
})

test('闸门：说话与记账都进日志，重放后能知道刚才说过什么', async (t) => {
  const dir = tmp(t)
  const log = new EventLog({ root: dir, roomId: ROOM })
  log.append('LIVE_START', {})

  const records = []
  const gate = new SendGate({
    send: async () => ({ ok: true, code: 0, kind: 'ok', message: 'ok' }),
    record: (type, payload) => records.push(log.append(type, payload)),
    config: { minIntervalMs: 0, dedupeWindowMs: 0, dryRun: true },
  })

  await gate.say({ roomId: ROOM, text: '欢迎 A', reason: 'welcome' })
  await gate.say({ roomId: ROOM, text: '欢迎 B', reason: 'welcome' })

  const p = new Projection(ROOM)
  p.applyAll(log.readAll())
  const snap = p.snapshot()

  assert.equal(snap.eventsByType.SENT, 2, 'SENT 事件要能从日志里数出来')
  assert.equal(records.length, 2)
})

test('闸门：没有 send 函数直接构造失败（宁可启动就炸，也别运行中发现）', () => {
  assert.throws(() => new SendGate({}), /需要一个 send 函数/)
})

test('闸门：发送实现抛异常时不会把整条链路带崩', async (t) => {
  const gate = new SendGate({
    send: async () => {
      throw new Error('网络断了')
    },
    config: { minIntervalMs: 0, dedupeWindowMs: 0 },
  })
  const r = await gate.say({ roomId: ROOM, text: '你好' })
  assert.equal(r.ok, false)
  assert.equal(r.code, -996)
  assert.equal(gate.snapshot().counters.failed, 1)
})

/* ══════════════════ 回放里的限速折算 ══════════════════ */

/**
 * `simulateSendGate` 是"离线版的闸门"：同样的两条规矩（最小间隔、同句去重），
 * 但时间来自**事件时间**而不是现实时钟。
 *
 * 它存在的理由只有一个：沙盒回放不会真发，于是它天然看不到限速 ——
 * 而真实房间里限速拦掉的消息可以过半。这个函数让回放能如实报出
 * "想说 N 句，其中 M 句真的发得出去"。
 */
test('限速折算：同一秒里挤 10 句只放行 1 句，间隔拉开就都放行', () => {
  const T = 1_700_000_000_000;

  const crowded = Array.from({ length: 10 }, (_, i) => ({
    ts: T + i * 100,
    text: `欢迎 观众${i}`,
  }));
  const a = simulateSendGate(crowded);
  assert.equal(a.sendable, 1, '1.2 秒最小间隔：同一秒只有第一句能出去');
  assert.equal(a.blockedInterval, 9);

  const spaced = crowded.map((s, i) => ({ ...s, ts: T + i * 2000 }));
  const b = simulateSendGate(spaced);
  assert.equal(b.sendable, 10, '每 2 秒一句，全部发得出去');
  assert.equal(b.blockedInterval, 0);
});

test('限速折算：同一句话在去重窗口内重复，第二句被拦', () => {
  const T = 1_700_000_000_000;
  const r = simulateSendGate([
    { ts: T, text: '来了就好' },
    { ts: T + 5000, text: '来了就好' },
  ]);
  assert.equal(r.sendable, 1);
  assert.equal(r.blockedDedupe, 1, '间隔够了但话一样，仍然会被去重拦住');
});

test('限速折算：时间缺失时不更新"上次发送时间"，不能把后面全判成超频', () => {
  const T = 1_700_000_000_000;
  const r = simulateSendGate([
    { ts: T, text: '第一句' },
    { ts: 0, text: '时间不明的一句' },
    { ts: T + 3000, text: '第三句' },
  ]);
  assert.equal(r.sendable, 3, '不能因为一条没有时间戳就往死里拦');
});
