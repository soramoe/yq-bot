/**
 * 沙盒回放：把一段历史日志用**当前配置**重跑一遍，看会说什么，但不真的发。
 *
 * 解决的是一类没法靠推理回答的问题：
 * 「我把欢迎语改了，那天的观众会不会被连发两句？」
 * 「冷却从 60 秒改成 30 秒，昨天那场会多说多少条？」
 * 只能拿真实日志重放才知道，靠读代码猜一定会漏。
 *
 * 三条安全前提：
 *
 * 1. **独立的插件实例。** 靠 cacheBust 强制新模块 —— 否则沙盒会拿生产
 *    正在用的冷却表去跑（ESM 按 URL 缓存，同一文件只会有一个实例）。
 * 2. **不碰闸门、不碰网络。** say() 被换成一个收集数组，不会真发。
 * 3. **不写日志。** 回放用的是内存里的事件，不追加任何东西 ——
 *    否则重放一遍会在日志里留下一堆伪造的 SENT 事件。
 */

import { PluginHost } from './plugin-host.mjs'
import { Projection } from './projection.mjs'
import { Roster } from './roster.mjs'
import { EVENT, ROSTER_EVENTS } from './events.mjs'
import { simulateSendGate, GATE_DEFAULTS } from './gate.mjs'

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * @param {object} opts
 * @param {object[]} opts.events     要回放的事件（已按 seq 升序）
 * @param {string} opts.pluginsDir   插件目录
 * @param {object} [opts.configs]    用户配置（通常就是线上那份）
 * @param {object} [opts.enabled]    宿主级禁用表
 * @param {string} [opts.roomId]     用于插件内部的冷却 key
 * @param {number} [opts.maxSaid]    最多收集多少条发言，防止刷爆内存
 * @param {object} [opts.log]
 */
export async function replay({
  events,
  pluginsDir,
  configs = {},
  enabled = {},
  roomId = '',
  maxSaid = 2000,
  log = SILENT_LOG,
}) {
  const said = []
  /** 正在投递的事件。deliver() 是串行的，所以回调里读到的一定是当前这条 */
  let cur = null
  let stopped = null

  /**
   * 内存观众簿。
   *
   * 只放在内存里（persist: false）：回放的是历史事件，把它记进真实观众簿
   * 等于伪造历史 —— 回放一遍，那天的人就都变成"来过"了，而他们可能从没来过。
   *
   * 但回放**必须有**一本：欢迎插件要判断"这个人以前来过吗"，
   * 没有观众簿时它会把所有人都当新观众，于是回放结果和线上差一截，
   * 而这个差异不报错、只体现在"少说了几句欢迎回来"上。
   */
  const roster = new Roster({ dataDir: '', roomId, persist: false, log })
  await roster.load()

  /**
   * 回放自己的投影。
   *
   * 之前这里给的是常量 `{ roomId }`：于是 `#本场` 在回放里永远说
   * 「本场 0 条弹幕，0 位观众」，而这是一句**看起来正常的假话** ——
   * 不会报错，用户只会以为"这个指令坏了"。
   * 欢迎插件判断「本场说过没有」也拿不到 sessionId，只能退回真实时钟，
   * 跨场次的回放于是全被当成同一场。
   *
   * 现在逐条喂给投影，和线上 `RoomRunner._ingest` 的顺序一致：
   * **先投影、再投递**，所以插件看到的数字包含当前这条事件。
   * 这也让"回放结果"只受插件配置影响，不受回放速度影响。
   */
  const projection = new Projection(String(roomId ?? ''))

  const host = new PluginHost({
    dir: pluginsDir,
    log,
    configs,
    enabled,
    roster,
    cacheBust: true,
    getState: () => projection.snapshot(),
    say: async ({ text, reason, source }) => {
      // 沙盒里的"发送"只是记一笔。返回 ok 让插件的 sent 计数也动起来，
      // 这样面板上的数字和真实运行时的含义一致（认领 vs 发言）
      said.push({
        seq: cur?.seq ?? 0,
        ts: cur?.ts ?? 0,
        type: cur?.type ?? '',
        plugin: source,
        reason: reason ?? '',
        text,
      })
      return { ok: true, dryRun: true, sandbox: true }
    },
  })

  try {
    await host.load()
    await host.startAll()

    let fed = 0
    for (const ev of events) {
      /**
       * 和线上完全一样：事件在投递前记账，并把「来之前」的状态挂上去。
       *
       * 记账清单必须**和线上同一份**（`ROSTER_EVENTS`）。以前这里只认 ENTER，
       * 于是"只送礼 / 只上舰 / 只关注、没触发进场报文"的人在回放里成了陌生人
       * —— 欢迎语少一句"欢迎回来"，而结果看上去完全正常。
       * 回放存在的意义就是"结果等于当时会说什么"，差一句就不成立了。
       *
       * 复制一份而不是直接改 `ev`：`events` 是调用方传进来的数组，
       * 往里塞字段会污染它（同一个数组可能还要给别的地方用）。
       * 时间用 `ev.ts` 而不是 Date.now() —— 判断"多少天没来"必须按历史时刻算。
       */
      let e = ev
      if (ROSTER_EVENTS.has(ev.type)) {
        const p = ev.payload ?? {}
        const visit = roster.mark(p.uid, p.uname, ev.ts)
        // 只有进场带 _visit：欢迎插件用它区分"新观众 / 欢迎回来"，
        // 与线上 `RoomRunner._ingest` 完全一致
        e = ev.type === EVENT.ENTER ? { ...ev, _visit: visit } : ev
      }

      /**
       * 投影异常不能中断回放：一条脏事件只该让「那一刻的数字」偏一点，
       * 而不是让整次回放报错退出（那样用户什么都看不到）。
       */
      try {
        projection.apply(e)
      } catch (err) {
        log.warn(`沙盒投影失败（seq ${e.seq ?? '?'}）：${err.message}`)
      }

      cur = e
      await host.deliver(e)
      fed++
      if (said.length >= maxSaid) {
        stopped = `发言数达到上限 ${maxSaid}，回放到此为止`
        break
      }
    }

    /**
     * 收尾：让"等一会儿再发"的插件把攒下的结清。
     *
     * 礼物答谢要等合并窗口结束才发；线上有定时器等，回放里现实时钟
     * 几乎没动 —— 不调这一步，默认配置下沙盒一条答谢都没有，
     * 而用户改的正是答谢文案。
     */
    await host.replayEnd()

    /**
     * 把"想说的话"按事件时间过一遍闸门，算出**真能发出去多少句**。
     *
     * 不做这一步的话，回放在热闹房间里会偏乐观一倍：实测某一场日志，
     * 想说 3845 句、实际只发出 1806 条，差的全被 1.2 秒的最小间隔吃了。
     * 用户拿回放调文案，看到的是一个不会发生的数字。
     */
    const gate = simulateSendGate(said)

    return {
      said,
      /** 其中真能发出去的条数（按最小间隔与去重折算） */
      sendable: gate.sendable,
      gate,
      fed,
      total: events.length,
      /** 非 null 表示提前停了，前端要显示出来，不能让用户以为这就是全部 */
      stopped,
      /**
       * 回放结果的固有局限，必须跟着结果一起返回。
       *
       * 事件驱动的插件（欢迎、礼物、SC、关键词）在回放里完全可复现；
       * 但**按时间触发的插件**（定时播报）依赖的是现实时钟 ——
       * 回放把一小时的日志压缩成几百毫秒跑完，现实时钟几乎没动，
       * 所以它要么一句不说，要么说的话和当时那句话毫无关系。
       * 不说明这一点，用户会拿"回放里播报没出现"当成配置没生效。
       */
      note:
        '按时间触发的发言（定时播报、主动打招呼）与回放速度有关，不在结果里体现；' +
        '读实时数字的插件（`#本场`）看到的是"回放到这一刻"的统计，与当时一致。' +
        `另外闸门的**限速**（每秒最多 1 条、同句 ${Math.round(GATE_DEFAULTS.dedupeWindowMs / 1000)} 秒内不重复）` +
        `不在插件侧：上面列的是"会说什么"，其中 ${gate.sendable} 条真能发出去，` +
        `其余会被限速丢掉 —— 热闹房间里这个差距可以过半`,
      plugins: host.stats(),
      errors: host.errors.map((e) => ({ ...e })),
    }
  } finally {
    await host.stopAll().catch(() => {})
  }
}
