/**
 * 欢迎链路演示：连真实直播间，用演练模式跑完整条链路。
 *
 * 这个脚本的价值在于**它不会打扰任何人**：
 * dryRun 打开后，闸门走完整的判断（限速、去重、模板、日志），
 * 只是最后不真的调用发送接口。所以可以随便拿别人的直播间试。
 *
 * 用法：
 *   node server/tools/welcome-demo.mjs <房间号> [秒数]
 *
 * 看什么：
 *   · 进场事件有没有被 welcome 插件认领
 *   · 欢迎语渲染成什么样（粉丝牌、舰长这些变量对不对）
 *   · 被闸门拦下时说没说清原因（interval / duplicate）
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AuthStore } from '../auth.mjs'
import { RoomRunner } from '../room-runner.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

const roomId = process.argv[2] || '1901584685'
const seconds = Number(process.argv[3] || 30)

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

const log = {
  debug: (...a) => console.log(stamp(), '[debug]', ...a),
  info: (...a) => console.log(stamp(), ...a),
  warn: (...a) => console.log(stamp(), '[warn]', ...a),
  error: (...a) => console.log(stamp(), '[error]', ...a),
}

const auth = new AuthStore({ dataDir: join(root, 'data') }).load()
if (!auth.loggedIn) {
  console.log('没有可用凭证，先跑 `npm run login` 扫码')
  process.exit(1)
}

console.log(
  `账号：${auth.status().uname || auth.status().uid} | 房间：${roomId} | ${seconds} 秒 | 演练模式（不会真的发弹幕）`,
)
console.log('─'.repeat(72))

const runner = new RoomRunner({
  roomId,
  cookie: auth.cookie,
  dataDir: join(root, 'data'),
  log,
  dryRun: true,
  pluginsDir: join(root, 'plugins'),
})

/** 收到的每条事件都打一行，便于对照"事件进来了 → 插件有没有认领" */
runner.on('event', (ev) => {
  if (ev.type === 'ONLINE_COUNT' || ev.type === 'LIKE' || ev.type === 'SENT') return
  const p = ev.payload ?? {}
  const who = p.uname ? `${p.uname}` : ''
  const extra =
    ev.type === 'GIFT'
      ? `${p.giftName ?? ''}×${p.num ?? 1}`
      : ev.type === 'DANMAKU'
        ? String(p.text ?? '').slice(0, 20)
        : ''
  console.log(`  #${ev.seq} ${ev.type.padEnd(12)} ${who} ${extra}`)
})

runner.on('claimed', ({ by, event }) => {
  console.log(`      └─ 由 ${by} 处理（${event.type}）`)
})

await runner.start()

setTimeout(async () => {
  console.log('─'.repeat(72))
  const snap = runner.snapshot()
  console.log('收包：', JSON.stringify(snap.connection?.stats ?? {}))
  const c = snap.gate?.counters ?? {}
  console.log(
    `闸门：演练 ${c.dryRun} 条 | 因限速丢弃 ${c.blockedInterval} | 因重复丢弃 ${c.blockedDedupe} | 失败 ${c.failed}`,
  )
  console.log(
    '插件：',
    (snap.plugins?.plugins ?? []).map((p) => `${p.id}（认领 ${p.stats.claimed} 次）`).join(' '),
  )
  console.log('日志：', JSON.stringify(snap.log))
  console.log('统计：', `弹幕 ${snap.stats?.danmaku} 进场 ${snap.stats?.enterCount} 礼物 ${snap.stats?.giftCount}`)
  await runner.stop()
  process.exit(0)
}, seconds * 1000)
