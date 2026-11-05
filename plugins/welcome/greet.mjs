/**
 * 打招呼的核心：「这个人该不该被说一句，说什么」。
 *
 * 三条路径（进场 / 关注 / 上舰）共用这一份实现，只换文案。
 *
 * 早先它们是三个方法，逻辑逐行重复：取名字、判冷却、渲染、mark、say。
 * 改一处就得记得改另两处 —— 关注这一路要加时，才发现复制粘贴的代价
 * 不是行数，是「总有一份忘了改」。
 *
 * 冷却表三条路径**共用**，这是关键：关注之后 B站 常常还会再推一条进场，
 * 两条各自判断就会连发两句欢迎。共用一张表时，先到的那条说，
 * 后到的那条被挡住 —— 谁先到都对，且只发一句。
 *
 * ## 两道闸门，不是一道
 *
 * ① 短期冷却（默认 90 秒）挡的是「立刻进出」：点错退出再进来。
 * ② 本场一次（默认开）挡的是「一晚进出二十次」：这才是真正的刷屏来源，
 *    而它恰恰是 90 秒冷却最无力的地方 —— 观众进出间隔通常比 90 秒长。
 *
 * 以前只有 ①，所以一个常驻老观众一晚上被欢迎十几次。
 *
 * ## 「来没来过」由观众簿回答
 *
 * `ev._visit` 是房间运行器在事件入库时挂上去的派生字段（见 roster.mjs）。
 * 没有它时（沙盒、或观众簿载入失败）所有人按新观众对待 ——
 * 与"没有这个功能之前"的行为完全一致，不会突然全体静默。
 */

import { honorVars, nameOf } from './honor.mjs'

/** 冷却表的上限，防止超长直播里无限增长 */
const MAX_COOLDOWN_KEYS = 5000

/**
 * 场次 id 变了（进程重启）之后，多久之内仍算「本场已经说过」。
 *
 * 场次 id 是 `s${seq}`，重启后再开播会得到新 id，于是全场观众又变
 * 「本场没说过」。一次重启换来整个房间被重新欢迎一遍，代价太蠢。
 * 取 2 小时：比任何一次正常的"中间休息"长，又不至于跨过两场直播。
 */
const SESSION_GRACE_MS = 2 * 3600_000

/**
 * 这次来访该归到哪一类。
 *
 * - `new`    从没见过，或者上次来已经是 returningDays 天之前了
 * - `return` 见过，且还算熟人
 * - `silent` 见过，但配置成不打扰
 *
 * @param {object} cfg
 * @param {{isFirstEver:boolean, daysSince:number}|null|undefined} visit
 * @returns {'new'|'return'|'silent'}
 */
export function classifyVisit(cfg, visit) {
  // 没有观众簿就按新观众处理。这个降级方向是刻意选的：
  // 宁可多欢迎一句，也不要因为簿子读不出来就整晚没声音、还不报错。
  if (!visit || visit.isFirstEver) return 'new'

  const days = Number(cfg.returningDays)
  if (Number.isFinite(days) && days > 0 && visit.daysSince > days) return 'new'

  const mode = String(cfg.returningMode || 'return')
  if (mode === 'silent') return 'silent'
  if (mode === 'same') return 'new'
  return 'return'
}

export class Greeter {
  constructor() {
    /**
     * `${roomId}:${uid}` → { at, sessionId }
     *
     * 带房间前缀：多房间共用宿主时不会串味。
     * 记 sessionId：判断"本场说过没有"要用，光有时间不够。
     */
    this._last = new Map()
  }

  reset() {
    this._last.clear()
  }

  /**
   * @param {object} ctx 插件上下文
   * @param {object} ev  事件
   * @param {{template:string, reason:string, allowReturning?:boolean, sessionGate?:boolean}} opts
   * @returns {boolean} 是否认领了这条事件
   */
  greet(ctx, ev, { template, reason, allowReturning = false, sessionGate = true }) {
    const cfg = ctx.config
    const p = ev.payload ?? {}
    const uid = String(p.uid ?? '')
    const uname = nameOf(p)

    if (!uname) {
      // 没有名字就没法打招呼，但**不能算"处理了"** —— 留给别的插件
      return false
    }

    /**
     * 时间基准用**事件时间**。
     *
     * 线上两者几乎相等；但沙盒回放把几小时日志压成几百毫秒跑完，
     * 按真实时钟判 90 秒冷却，会把"两小时前刚欢迎过的那个人"
     * 一直当成在冷却里 —— 回放少了那一句，且不报错。
     * 而回放的全部意义是"当时会怎样"，所以凡是有时间含义的判断
     * 都得用事件时间。ts 缺失或为 0 时退回真实时钟。
     */
    const now = Number.isFinite(ev.ts) && ev.ts > 0 ? ev.ts : Date.now()

    // ① 短期冷却
    if (this._onCooldown(ctx, uid, cfg.cooldownSec, now)) return true

    // ② 本场已经说过了。
    //    只挡「重复进场」：同一场里进出二十次不该被欢迎二十遍。
    //    关注 / 分享 / 上舰是**一次性**事件，本场欢迎过也不该把这次谢意吞掉 ——
    //    尤其是上舰，花了钱却因为开场被欢迎过而没声，比多说一句难受得多。
    //    这几条仍有 90 秒冷却，挡住"关注后紧跟进场"那种连发。
    if (sessionGate && this._saidThisSession(ctx, uid, cfg, now)) return true

    // ③ 说哪一句，由"来没来过"决定。
    //    只有进场问这个 —— 关注和上舰是**一次性**事件，
    //    对它们说「欢迎回来」既不通顺也不对（他是第一次关注，不是第一次来）
    const kind = allowReturning ? classifyVisit(cfg, ev._visit) : 'new'

    // 熟客静默：认领了但不说。认领是"我看过了，决定不说"，
    // 而不是"我不管"—— 这样将来加别的进场插件时不会出现两套判断打架。
    if (kind === 'silent') return true

    const tpl = kind === 'return' ? cfg.returnTemplate || template : template
    if (!tpl) return false

    const text = ctx.render(tpl, honorVars(p))

    // 记冷却要在真正请求发送之前：即使闸门因为限速把它拦下了，
    // 这个人也不该在下一秒被重新欢迎一次。
    this._mark(ctx, uid, now)

    ctx.say(text, {
      reason,
      reply: p.uid != null && p.uid !== '' ? { uid: p.uid, uname } : null,
    })

    return true
  }

  /** 冷却 key 带房间前缀，避免多房间共用宿主时互相压制 */
  _key(ctx, uid) {
    const roomId = ctx.state?.roomId ?? ''
    return `${roomId}:${uid}`
  }

  /** 冷却判断。cooldownSec <= 0 表示不限。`now` 由调用方按事件时间给 */
  _onCooldown(ctx, uid, cooldownSec, now = Date.now()) {
    const sec = Number(cooldownSec) || 0
    if (sec <= 0 || !uid) return false
    const rec = this._last.get(this._key(ctx, uid))
    if (!rec) return false
    return now - rec.at < sec * 1000
  }

  /**
   * 本场是不是已经跟这个人说过话了。
   *
   * 两段判断：
   *   1. 场次 id 相同 —— 精确，覆盖"同一场里第二次进场"
   *   2. 场次 id 变了但时间很近 —— 覆盖"进程重启"（见 SESSION_GRACE_MS）
   *
   * 关掉 oncePerSession 就退回"只有 90 秒冷却"的老行为。
   */
  _saidThisSession(ctx, uid, cfg, now = Date.now()) {
    if (!cfg.oncePerSession) return false
    const rec = this._last.get(this._key(ctx, uid))
    if (!rec) return false

    const sid = ctx.state?.sessionId ?? ''
    if (sid && rec.sessionId === sid) return true

    return now - rec.at < SESSION_GRACE_MS
  }

  _mark(ctx, uid, now = Date.now()) {
    if (!uid) return
    this._last.set(this._key(ctx, uid), {
      at: now,
      sessionId: ctx.state?.sessionId ?? '',
    })
    if (this._last.size > MAX_COOLDOWN_KEYS) {
      // 清掉最早的一半。这里不需要 LRU：写过一次就不再读同一个 key
      const drop = Math.floor(MAX_COOLDOWN_KEYS / 2)
      let i = 0
      for (const k of this._last.keys()) {
        this._last.delete(k)
        if (++i >= drop) break
      }
    }
  }
}

/** 普通进场 */
export function handleEnter(ctx, ev, greeter) {
  const cfg = ctx.config
  if (!cfg.enabled) return false
  return greeter.greet(ctx, ev, {
    template: cfg.template,
    reason: 'welcome',
    allowReturning: true,
  })
}

/** 关注。关注是留人不是花钱，但也该有回应 */
export function handleFollow(ctx, ev, greeter) {
  const cfg = ctx.config
  if (!cfg.welcomeFollow) return false
  return greeter.greet(ctx, ev, {
    template: cfg.followTemplate,
    reason: 'follow',
    sessionGate: false,
  })
}

/**
 * 分享直播间。
 *
 * 门槛比关注还低（点一下就成），但它是**主动帮你说出去**——
 * 直播间最缺的就是这个，所以值得单独一句文案。
 *
 * 与关注共用同一张冷却表：B站 有时会把"分享后回房"再推一条进场，
 * 各判各的就会连说两句。
 */
export function handleShare(ctx, ev, greeter) {
  const cfg = ctx.config
  if (!cfg.welcomeShare) return false
  return greeter.greet(ctx, ev, {
    template: cfg.shareTemplate,
    reason: 'share',
    sessionGate: false,
  })
}

/** 给测试与外部用的常量，避免两边写死同一个数字 */
export { SESSION_GRACE_MS, MAX_COOLDOWN_KEYS }
