/**
 * 发送闸门：**该不该说**。
 *
 * 这个模块是决策记录 D5「console 下沉内核」的落地 ——
 * 二代把总控制台做成了插件，于是"要不要发"这件事有两个地方能改
 * （插件的开关、设置里的 dryRun），最后长出 `effectiveDryRun()`
 * 这类补丁。三代把它放进内核：**插件只能请求说话，不能决定是否说话。**
 *
 * 四条规矩，全部在内核里，不重复实现：
 *
 * 1. **dryRun**：演练模式。走完整条链路（含限速、去重、日志），
 *    只是最后不真的发出去。这样"演练"能真实反映限速行为，
 *    而不是一演练就顺畅、一实战就卡。
 *
 * 2. **最小间隔**：两次发送之间至少隔一段时间。B站 对机器人
 *    的识别很大程度上看发送节奏，匀速是最明显的特征。
 *
 * 3. **内容去重**：同一句话在窗口内不重复发。连击礼物、连续进场
 *    最容易触发重复播报，这类重复是观众最直观的"机器人感"。
 *
 * 4. **记进日志**：发出去的每一句话都写一条 SENT 事件。
 *    重启后靠它知道刚才欢迎过谁 —— 二代这些状态全在内存里，重启即失忆。
 *
 * 5. **优先级**（2026-11-02 补）：默认"超频就丢"，但**花了钱的消息可以等**。
 *    实测在热闹的房间里，进场欢迎每秒一条就能把最小间隔占满，
 *    于是礼物答谢几乎永远发不出去 —— 观众花了钱一条反馈都没有，
 *    而闸门只是把计数 `blockedInterval` 加一，界面上看不出任何异常。
 *    所以 `priority > 0` 的消息允许等一个槽位（最多等 `maxWaitMs`），
 *    低优先级的照旧直接丢：一次进场欢迎不值得为它排队。
 *
 * 与 dryRun 相关的取舍：**dryRun 也占时间槽和去重窗口**。
 * 如果不占，演练时一切顺畅、正式上线立刻被限速打脸，
 * 那演练就没有意义了。
 */

import { EVENT } from './events.mjs'
import { prepareText, MAX_TEXT } from '../bili/send.mjs'

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * 闸门的出厂参数。
 *
 * 单独导出是因为**沙盒回放要按同一套参数折算**（见 `simulateSendGate`）：
 * 参数写两处，改了其中一处就会出现"回放说能发 100 条、实际只出去 40 条"，
 * 而这种差异既不会报错也不会有人去查。
 */
export const GATE_DEFAULTS = {
  /** 两次发送的最小间隔（毫秒） */
  minIntervalMs: 1200,
  /** 同一句话的静默窗口（毫秒） */
  dedupeWindowMs: 30_000,
  /** 去重表最多保留多少条，防止长直播里无限增长 */
  maxDedupeKeys: 500,
  /** 授权失效时整机只读：所有发言都被拦下，但页面和日志照常 */
  licenseBlocked: false,
}

/**
 * 按**事件时间**过一遍闸门的规矩，回答"这批想说的话里，几句真的发得出去"。
 *
 * ## 为什么需要它
 *
 * 沙盒回放不能真发（也不该真发），于是它看不见限速。而限速在热闹房间里
 * 是**主要矛盾**：实测某一场日志，欢迎插件想说 3845 句，实际只发出 1806 条 ——
 * 差的那 2000 多条全被 1.2 秒的最小间隔吃了。
 *
 * 也就是说：沙盒给出的"会发 3845 句"是一句**看起来正常的假话**，
 * 用户照着它调文案，上线只会发出一半。
 *
 * 这个函数不碰网络、不改任何状态，只是把同一套规则按事件时间重放一次，
 * 让回放能同时报出"想说多少"和"发得出去多少"。
 *
 * 注意两处刻意的差别（都是"算不准就不装作算得准"）：
 *   · 没有时间戳的条目**不更新** `last`，否则它会把自己和后面全判成超频；
 *   · 去重按 `prepareText` 之后的内容算，和线上截图一致（长文案会被截断合并）。
 *
 * @param {Array<{ts?:number, text?:string}>} said
 * @param {{minIntervalMs?:number, dedupeWindowMs?:number}} [opts]
 * @returns {{sendable:number, blockedInterval:number, blockedDedupe:number}}
 */
export function simulateSendGate(said, { minIntervalMs, dedupeWindowMs } = {}) {
  const interval = Number.isFinite(minIntervalMs) ? Number(minIntervalMs) : GATE_DEFAULTS.minIntervalMs
  const dedupeFor = Number.isFinite(dedupeWindowMs)
    ? Number(dedupeWindowMs)
    : GATE_DEFAULTS.dedupeWindowMs

  const out = { sendable: 0, blockedInterval: 0, blockedDedupe: 0 }
  /** 上次"发出去"的事件时间。null 表示还没发过 —— 不能用 0 兜底（见 canSay 的注释） */
  let last = null
  /** 文案 → 上次发出的时间 */
  const dedupe = new Map()

  for (const item of said ?? []) {
    const raw = String(item?.text ?? '')
    const text = prepareText(raw, { max: MAX_TEXT }).text
    if (!text) continue

    const ts = Number(item?.ts)
    const hasTs = Number.isFinite(ts) && ts > 0

    if (hasTs && last !== null && ts - last < interval) {
      out.blockedInterval++
      continue
    }

    const seen = dedupe.get(text)
    if (hasTs && seen !== undefined && ts - seen < dedupeFor) {
      out.blockedDedupe++
      continue
    }

    out.sendable++
    if (hasTs) {
      last = ts
      dedupe.set(text, ts)
    }
  }

  return out
}

export class SendGate {
  /**
   * @param {object} opts
   * @param {Function} opts.send    真正的发送实现（bili/send.mjs 的 sendDanmaku）
   * @param {Function} [opts.record] 记录事件（RoomRunner 的 _ingest 包装）
   * @param {object} [opts.log]
   * @param {Function} [opts.now]   便于自检注入时钟
   */
  constructor({ send, record = null, log = SILENT_LOG, now = Date.now, sleep = null, config = {} }) {
    if (typeof send !== 'function') throw new Error('SendGate 需要一个 send 函数')

    this.send = send
    this.record = record
    this.log = log
    this.now = now
    /** 等待实现。自检里注入假时钟，避免"靠 sleep 卡时间"的脆弱断言 */
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))

    this.config = {
      dryRun: false,
      ...GATE_DEFAULTS,
      /** 单条弹幕字符上限 */
      maxText: MAX_TEXT,
      ...config,
    }

    /** 每个房间上一次发送的时间 */
    this._lastSentAt = new Map()
    /** key = `roomId\u0000text` → 上次发送时间 */
    this._dedupe = new Map()

    this.counters = {
      sent: 0,
      dryRun: 0,
      blockedInterval: 0,
      blockedDedupe: 0,
      failed: 0,
      /** 高优先级消息为了等槽位实际等待的次数 */
      waited: 0,
      /** 等了也没等到、最后放弃的次数。这个数不该长期上涨 */
      gaveUp: 0,
    }
  }

  /** 热改配置。返回实际生效的配置，便于调用方回读。 */
  update(patch = {}) {
    for (const [k, v] of Object.entries(patch)) {
      if (k in this.config && v !== undefined) this.config[k] = v
    }
    return { ...this.config }
  }

  /**
   * 只判断不说。给调用方一次"预检"的机会，
   * 避免把不该说的话先拼好再被拦（拼模板有代价，也可能有副作用）。
   *
   * @returns {{ok:boolean, reason?:string, waitMs?:number}}
   */
  canSay({ roomId, text }) {
    if (this.config.licenseBlocked) return { ok: false, reason: 'license' }
    const { text: clean } = prepareText(text, { max: this.config.maxText })
    if (!clean) return { ok: false, reason: 'empty' }

    const now = this.now()
    const last = this._lastSentAt.get(String(roomId))
    // 注意用 undefined 判断"从未发送过"，不能用 `?? 0` 兜底：
    // 那样在注入时钟（或系统时间被调早）的场景下，
    // 第一句话会被当成"刚刚才发过"而白白拦掉。
    if (last !== undefined && now - last < this.config.minIntervalMs) {
      return { ok: false, reason: 'interval', waitMs: this.config.minIntervalMs - (now - last) }
    }

    const key = `${roomId}\u0000${clean}`
    const seen = this._dedupe.get(key)
    if (seen && now - seen < this.config.dedupeWindowMs) {
      return { ok: false, reason: 'duplicate', waitMs: this.config.dedupeWindowMs - (now - seen) }
    }

    return { ok: true }
  }

  /**
   * 说一句话。
   *
   * @param {object} opts
   * @param {number|string} opts.roomId
   * @param {string} opts.text
   * @param {{uid:number|string, uname:string, color?:string}|null} [opts.reply]
   * @param {string} [opts.reason]  为什么说这句（welcome / gift / manual），便于事后追查
   * @param {string} [opts.source]  哪个插件要求说的
   * @param {number} [opts.priority] 0 = 超频就丢；>0 = 可以等一个槽位
   * @param {number} [opts.maxWaitMs] 最多等多久。超了就放弃，不会无限排队
   * @returns {Promise<{ok:boolean, skipped:string|null, dryRun:boolean, text:string, code?:number, message?:string}>}
   */
  async say({
    roomId,
    text,
    reply = null,
    reason = '',
    source = '',
    priority = 0,
    maxWaitMs = 0,
  }) {
    const verdict = this.canSay({ roomId, text })
    if (!verdict.ok) {
      // 高优先级只管一件事：**因为间隔不够被拦时可以等**。
      // 去重拦下的（同一句话）不该等 —— 等完还是同一句话，白等。
      const waitMs = Number(verdict.waitMs) || 0
      const canWait =
        verdict.reason === 'interval' &&
        priority > 0 &&
        maxWaitMs > 0 &&
        waitMs > 0 &&
        waitMs <= maxWaitMs

      if (canWait) {
        this.counters.waited++
        await this.sleep(waitMs)
        // 只重试一次：maxWaitMs 传 0，避免反复排队把闸门变成队列
        const retry = await this.say({
          roomId,
          text,
          reply,
          reason,
          source,
          priority,
          maxWaitMs: 0,
        })
        if (!retry.ok) this.counters.gaveUp++
        return retry
      }

      if (verdict.reason === 'interval') this.counters.blockedInterval++
      else if (verdict.reason === 'duplicate') this.counters.blockedDedupe++
      return {
        ok: false,
        skipped: verdict.reason,
        dryRun: this.config.dryRun,
        text: '',
        waitMs: verdict.waitMs ?? 0,
      }
    }

    const prepared = prepareText(text, { max: this.config.maxText })

    // 结构化 @ 会由 B站 在正文前挂一个可点的「@昵称」标签。
    // 如果文案里已经写了这个名字（常见于模板填了 {用户}），再挂一次就会变成
    // 「@小明 感谢小明 的礼物」——名字出现两遍。这里统一收敛：正文已经带名字
    // 就不再加结构化 @，正文没写名字才挂。插件不需要各自判断。
    const effectiveReply =
      reply && reply.uid && reply.uname && prepared.text.includes(String(reply.uname))
        ? null
        : reply

    // 无论演练还是实战，都先占住时间槽与去重窗口：
    // 否则演练时一路畅通，正式上线立刻被限速打脸。
    const now = this.now()
    this._lastSentAt.set(String(roomId), now)
    this._rememberDedupe(`${roomId}\u0000${prepared.text}`, now)

    if (this.config.dryRun) {
      this.counters.dryRun++
      this._emitSent({ roomId, prepared, reply: effectiveReply, reason, source, dryRun: true, code: 0 })
      this.log.info(`[演练] 本该发送：${prepared.text}`)
      return { ok: true, skipped: null, dryRun: true, text: prepared.text }
    }

    let res
    try {
      res = await this.send({ roomId, text: prepared.text, reply: effectiveReply })
    } catch (err) {
      this.counters.failed++
      this.log.error(`发送异常：${err?.message || err}`)
      return {
        ok: false,
        skipped: null,
        dryRun: false,
        text: prepared.text,
        code: -996,
        message: String(err?.message || err),
      }
    }

    if (res.ok) {
      this.counters.sent++
      this._emitSent({ roomId, prepared, reply: effectiveReply, reason, source, dryRun: false, code: 0 })
    } else {
      this.counters.failed++
      this.log.warn(`发送失败 [${res.code}] ${res.message}`)
    }

    return {
      ok: res.ok,
      skipped: null,
      dryRun: false,
      text: prepared.text,
      code: res.code,
      message: res.message,
      kind: res.kind,
      truncated: prepared.truncated,
    }
  }

  _rememberDedupe(key, at) {
    this._dedupe.set(key, at)
    // 长直播里 key 会一直增长，超上限时清掉最早的一半。
    // 不用 LRU：这里的访问模式是"写过就不再读"，LRU 没有收益。
    if (this._dedupe.size > this.config.maxDedupeKeys) {
      const drop = Math.floor(this.config.maxDedupeKeys / 2)
      let i = 0
      for (const k of this._dedupe.keys()) {
        this._dedupe.delete(k)
        if (++i >= drop) break
      }
    }
  }

  _emitSent({ roomId, prepared, reply, reason, source, dryRun, code }) {
    if (typeof this.record !== 'function') return
    this.record(EVENT.SENT, {
      roomId: String(roomId),
      text: prepared.text,
      truncated: prepared.truncated,
      reason,
      source,
      dryRun,
      code,
      replyUid: reply?.uid ?? null,
      replyUname: reply?.uname ?? null,
    })
  }

  snapshot() {
    return {
      dryRun: this.config.dryRun,
      minIntervalMs: this.config.minIntervalMs,
      dedupeWindowMs: this.config.dedupeWindowMs,
      counters: { ...this.counters },
      dedupeKeys: this._dedupe.size,
      rooms: this._lastSentAt.size,
    }
  }
}

export default SendGate
