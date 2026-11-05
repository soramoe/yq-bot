/**
 * 统计投影：把事件流 reduce 成一份可读的数字。
 *
 * 核心承诺（决策记录 D2）：**统计不是被"保存"的，是被"算出来"的。**
 * 所以这个模块没有 save / load，只有 apply 和 snapshot。
 * 重启时重新 applyAll(readAll()) 就能得到和崩溃前完全一致的结果。
 *
 * 四个容易做错的点，这里都显式处理了：
 *
 * 1. **幂等**：只处理 seq 大于 lastSeq 的事件。
 *    同一批日志喂两遍，数字不会翻倍。
 *
 * 2. **场次边界**：直播中重启时，日志里没有新的 LIVE_START，
 *    但事件还在来 —— 这时用「隐式场次」接上，而不是丢进虚空。
 *    二代在这里靠"条件不匹配就拒绝"来保守恢复，代价是统计静默归零。
 *
 *    隐式场次**不能**把状态机设成 live（审计发现的 bug）：
 *    那样后面真正的 LIVE_START 就因为没有状态变化而不出边沿，
 *    两场数据被合并成一场。它进的是 live_unknown。
 *
 * 3. **礼物计数与事件条数不是一回事**：
 *    一条 GIFT 事件可能带 num=10。所以对账要分两层看
 *    （事件条数、累加后的个数），不能混。
 *
 * 4. **下播瞬间的延迟弹幕**：B站 的推送有延迟，LIVE_END 之后几秒内
 *    仍会收到那场的弹幕。这些必须归回刚结束的场次，
 *    否则每场之后都会多出一段只有几条弹幕的"幽灵场"。
 */

import { RoomStateMachine, LIVE, OFFLINE, EDGE } from './state-machine.mjs'

/** 下播后这段时间内到达的事件，仍归入刚结束的那一场 */
const REOPEN_GRACE = 60_000

/**
 * 多久没有任何事件，就认为"这一场其实已经断了"。
 *
 * 依据来自真实日志：`ONLINE_COUNT` 是 B站 定时推送的采样（实测一场 1334 条，
 * 中位间隔 11 秒，p99 不到 8 秒）。所以"半小时一条事件都没有"不可能是
 * 一场还在进行的直播 —— 只能是连接断了、进程退了，或者 B站 没推 LIVE_END。
 *
 * 30 分钟取的是保守值：宁可把一场安静的长播继续算作进行中，
 * 也不要因为一时没人说话就把正在播的场次判死。
 */
const STALE_AFTER = 30 * 60_000

/** 一场直播的统计骨架。使用普通对象而不是 Map，便于直接 JSON 序列化比对。 */
function emptySession(id, startedAt) {
  return {
    id,
    startedAt,
    endedAt: 0,
    closed: false,
    /** 是否已进入 sessions 列表（避免复活后被重复收录） */
    archived: false,
    /** 场次起点是否未知（进程在直播中途启动） */
    implicit: false,
    /** B站 的开播时间，用于识别同一次开播的重复推送 */
    liveTime: 0,
    /**
     * 这一场里**最后一条事件的时间**。
     *
     * 用途只有一个：没有 LIVE_END 时，用它推断这一场大概什么时候结束的。
     * 以前没有任何字段记这个，于是"上一场"的结束时间只能取"下一场开播时间"，
     * 直播中断网一次就会得到"播了 20 小时"这种数（审计实测：20 小时）。
     */
    lastEventTs: startedAt,
    /** 结束时间是推断出来的（没收到 LIVE_END），不是 B站 告诉我们的 */
    endedAtEstimated: false,
    danmaku: 0,
    giftCount: 0,
    giftBattery: 0,
    guardCount: 0,
    guardBattery: 0,
    scCount: 0,
    scBattery: 0,
    enterCount: 0,
    /**
     * 下面四个字段只服务战报，**不参与对账**。
     *
     * 对账比的是 snapshot() 里那几个"钱和量"的字段（弹幕、礼物、舰长、SC），
     * 那几条走 `_accumulateGrand` 的第二条求和路径。这里刻意不进 grand：
     * 涨粉/人气/点赞都是"看过一眼就行"的数据，把它们拉进对账只会让
     * 每条断言都要多维护一份口径，收益为零。
     */
    followCount: 0,
    sentCount: 0,
    likeCount: 0,
    /** 本场看到过的最高人气值。B站 的在线人数是采样推送，取峰值才有意义 */
    peakPopularity: 0,
    viewers: Object.create(null),
    giftByUser: Object.create(null),
    giftByGift: Object.create(null),
  }
}

const num = (v) => (Number.isFinite(v) ? Number(v) : 0)

/**
 * 金额口径：报文给了精确总价就用它，否则退回 单价 × 数量。
 *
 * 这个函数被场次统计、总累计、对账路径**三处共用**，
 * 所以口径不可能再走偏。审计发现守卫的场次统计曾用 `数量 × 单价`，
 * 而总累计用 `battery`，两条路径不一致 —— 那种差异的表现是
 * "对账永远差一点点"，最难查。
 */
export function batteryOf(p) {
  const count = num(p.num) || 1
  return Number.isFinite(p.battery) ? p.battery : count * num(p.price)
}

/**
 * 礼物的金额（电池）。免费礼物金额为 0。
 *
 * 为什么不能直接用 `batteryOf`：银瓜子的免费礼物（小心心一类）报文里
 * 常常**也带 `total_coin`**，照算的话「本场收入」会凭空多出几块几毛。
 * 这种偏差对账查不出来 —— 两条计算路径读的是同一个字段，
 * 错得一模一样，一致性照样成立。
 *
 * 判据用 `isPaid === false` 而不是 `isPaid === true`：
 * 老日志里没有这个字段，缺省必须按"付费"处理，否则升级后
 * 历史礼物金额会整片归零。
 */
export function giftBatteryOf(p) {
  if (p?.isPaid === false) return 0
  return batteryOf(p)
}

export class Projection {
  constructor(roomId) {
    this.roomId = roomId
    this.lastSeq = 0
    this.sm = new RoomStateMachine(OFFLINE)
    /**
     * 最近一次 `apply()` 产生的边沿。
     *
     * 不直接读 `sm.lastEdge`：`apply()` 对重复 seq 是幂等返回，状态机压根没跑，
     * 直读会把**上一次**的边沿再交出去 —— 上层拿它发提醒，同一条事件重放一次
     * 就会多响一遍。这里自己记"这一次调用产生了什么"。
     */
    this._edge = null
    /** @type {ReturnType<typeof emptySession>|null} 当前场 */
    this.session = null
    /** @type {Array} 已封存的场次（与 session 共享引用，复活时数字自动跟着变） */
    this.sessions = []
    /** 每种事件处理过多少条 —— 对账的第一层依据 */
    this.eventsByType = Object.create(null)
    /**
     * 与场次无关的总累计。存在的唯一理由：对账要比「不分场的总数」，
     * 否则当前场统计一重置，就没法和全量日志对上了。
     */
    this.grand = {
      events: 0,
      danmaku: 0,
      giftCount: 0,
      giftBattery: 0,
      guardCount: 0,
      guardBattery: 0,
      scCount: 0,
      scBattery: 0,
      enterCount: 0,
    }
  }

  get state() {
    return this.sm.state
  }

  /** 最近一次处理事件产生的边沿（live_started / live_ended / null）。上层用它决定要不要通知插件 */
  get lastEdge() {
    return this._edge
  }

  /** 处理一条事件。返回 this，便于链式。 */
  apply(ev) {
    this._edge = null
    if (!ev || !Number.isInteger(ev.seq)) return this
    if (ev.seq <= this.lastSeq) return this // 幂等：已处理过
    this.lastSeq = ev.seq

    this.eventsByType[ev.type] = (this.eventsByType[ev.type] ?? 0) + 1
    this._accumulateGrand(ev)

    const { edge } = this.sm.feed(ev)
    this._edge = edge
    const p = ev.payload ?? {}

    switch (ev.type) {
      case 'LIVE_START': {
        if (edge === EDGE.LIVE_STARTED) {
          // 上一场（真场次或隐式场次）在这里收尾。
          // 走到这里的上一场一定**没有** LIVE_END（有了就已经 closed 了），
          // 所以结束时间只能推断，标记 estimated 让战报显示成"约"。
          this._closeSession(ev.ts, { estimated: true })
          const s = emptySession(`s${ev.seq}`, ev.ts)
          s.liveTime = num(p.liveTime)
          this.session = s
        }
        break
      }

      case 'LIVE_END': {
        // 机器人启动 / 重连后补的那条 LIVE_END 是"我看它没在播了"，不是 B站 推的 ——
        // 它的 ts 是发现时刻，可能比真实下播晚，同样只能推断。
        // inferred 与 synthetic 一样要标 estimated：重连补的下播同样不知道准确时刻。
        if (edge === EDGE.LIVE_ENDED) {
          this._closeSession(ev.ts, { estimated: p.synthetic === true || p.inferred === true })
        }
        break
      }

      case 'DANMAKU': {
        const s = this._ensureSession(ev.ts)
        s.danmaku++
        this._touchViewer(s, p.uid)
        break
      }

      case 'ENTER': {
        const s = this._ensureSession(ev.ts)
        s.enterCount++
        this._touchViewer(s, p.uid)
        break
      }

      case 'GIFT': {
        const s = this._ensureSession(ev.ts)
        const count = num(p.num) || 1
        const battery = giftBatteryOf(p)

        s.giftCount += count
        s.giftBattery += battery
        this._touchViewer(s, p.uid)

        if (p.giftName) {
          s.giftByGift[p.giftName] = (s.giftByGift[p.giftName] ?? 0) + count
        }
        if (p.uid != null) {
          const key = String(p.uid)
          const cur = s.giftByUser[key] ?? { name: p.uname ?? '', count: 0, battery: 0 }
          cur.name = p.uname ?? cur.name
          cur.count += count
          cur.battery += battery
          s.giftByUser[key] = cur
        }
        break
      }

      case 'GUARD_BUY': {
        const s = this._ensureSession(ev.ts)
        const count = num(p.num) || 1

        s.guardCount += count
        s.guardBattery += batteryOf(p)
        this._touchViewer(s, p.uid)
        break
      }

      case 'SUPER_CHAT': {
        // 一条 SC 就是一个单位：没有"数量"，也不合并。
        // 金额走 battery（归一化层已从「元」换算成电池）
        const s = this._ensureSession(ev.ts)
        s.scCount += 1
        s.scBattery += num(p.battery)
        this._touchViewer(s, p.uid)
        break
      }

      case 'FOLLOW': {
        // 关注不进 grand，只进本场（战报要"这场涨了几个粉"）
        const s = this._ensureSession(ev.ts)
        s.followCount++
        this._touchViewer(s, p.uid)
        break
      }

      case 'SENT': {
        // 机器人自己说的话。同样只进本场，用来算"这场答谢了多少次"
        const s = this._ensureSession(ev.ts)
        s.sentCount++
        break
      }

      case 'LIKE': {
        const s = this._ensureSession(ev.ts)
        s.likeCount += num(p.count) || 1
        break
      }

      case 'ONLINE_COUNT': {
        // 人气是采样推送（每隔一会儿一条），所以取峰值而不是累加。
        // 0 通常是"这次还没采到"，不能把峰值刷成 0
        const s = this._ensureSession(ev.ts)
        const v = num(p.count)
        if (v > s.peakPopularity) s.peakPopularity = v
        break
      }

      default:
        // 未知类型照样计数（eventsByType 已记），但不影响统计。
        break
    }

    return this
  }

  /** 批量重放。天然幂等，重复调用不会翻倍。 */
  applyAll(events) {
    for (const ev of events) this.apply(ev)
    return this
  }

  /**
   * 取当前场。
   *
   * 三种情况：
   *   a) 当前场还开着 → 直接返回
   *   b) 上一场刚结束（60 秒内）→ 把延迟弹幕累加到**已关闭**的那场
   *      （注意：不把它重新打开。早先的写法把 closed 改回 false，
   *       结果场次永远关不上，后面所有事件都归进同一场 —— 修一个 bug 引出另一个）
   *   c) 没有场次 / 隔得太久 → 建一个「隐式场次」接上，而不是把事件丢进虚空
   */
  _ensureSession(ts) {
    const cur = this.session
    if (cur) {
      if (!cur.closed) {
        cur.lastEventTs = ts
        return cur
      }
      if (ts - cur.endedAt <= REOPEN_GRACE) {
        cur.lastEventTs = ts
        return cur
      }
    }

    const s = emptySession(`implicit-${this.lastSeq}`, ts)
    s.implicit = true
    this.session = s

    // 有事件在来 = 房间里在播，但**场次起点未知**。
    // 这里只标记 live_unknown，不出边沿，也不冒充 live。
    this.sm.markLiveUnknown()
    return s
  }

  /**
   * 不分场次的累计。与 _ensureSession 无关，所以不会因为重启、
   * 换场、隐式场次而丢数 —— 这是对账能对上的前提。
   */
  _accumulateGrand(ev) {
    const p = ev.payload ?? {}
    const g = this.grand
    g.events++
    switch (ev.type) {
      case 'DANMAKU':
        g.danmaku++
        break
      case 'ENTER':
        g.enterCount++
        break
      case 'GIFT': {
        const c = num(p.num) || 1
        g.giftCount += c
        g.giftBattery += giftBatteryOf(p)
        break
      }
      case 'GUARD_BUY': {
        const c = num(p.num) || 1
        g.guardCount += c
        g.guardBattery += batteryOf(p)
        break
      }
      case 'SUPER_CHAT': {
        g.scCount += 1
        g.scBattery += num(p.battery)
        break
      }
      default:
        break
    }
  }

  _touchViewer(session, uid) {
    if (uid != null && uid !== '') session.viewers[String(uid)] = true
  }

  /**
   * 封存当前场。重复调用安全（archived 标记保证只入列一次）。
   *
   * 注意：sessions 里存的是**引用**不是副本，所以场次被复活后
   * 继续累加的数字会自动反映到 sessions 里，不会出现
   * "当前场涨了、历史记的还是旧数"这种两份数据打架的情况。
   */
  _closeSession(endTs, { estimated = false } = {}) {
    const s = this.session
    if (!s) return

    /**
     * 已经收过尾的场次**不许再收一次**。
     *
     * 这里原来没有这道判断：LIVE_END 把场次关掉、endedAt 记为下播时间，
     * 下一次 LIVE_START 又会调一次 _closeSession(ev.ts)，用**新一场的开播时间**
     * 把上一场的 endedAt 覆盖掉。后果是"上一场播了 4 分钟，战报显示 1 小时"。
     *
     * 之所以很久没发现：之前没有人读 endedAt —— 实时统计只关心"现在这一场"，
     * 场次列表也只是存着不用。战报一上来读时长，这个假数字立刻现形。
     * 这就是"只写不读的字段最容易烂"的实例。
     */
    if (s.closed) return

    s.closed = true
    let end = endTs || s.endedAt || Date.now()

    /**
     * 推断结束时间：**没有 LIVE_END 的场次，不能拿下一场的开播时间当自己的结束**。
     *
     * 审计实测：12:00 开播、12:02 最后一条弹幕、B站 没推 LIVE_END，
     * 20 小时后才又开播 —— 上一场被算成"播了 1200 分钟"。
     * 断网、进程崩溃、B站 漏推都会走到这条路上，而且数字错得离谱却不报错。
     *
     * 改成用"本场最后一条事件 + 下播宽限"作结束时间：
     * 真实下播后几十秒内一定没有新事件，所以这个推断的误差在分钟级，
     * 而不是小时级。同时打上 endedAtEstimated，战报显示成"约 4 分钟"，
     * 不假装这是精确值。
     */
    if (estimated) {
      const last = Number(s.lastEventTs) || 0
      if (last > 0) {
        const clamp = last + REOPEN_GRACE
        if (clamp < end) {
          end = clamp
          s.endedAtEstimated = true
        }
      }
    }

    s.endedAt = end
    if (!s.archived) {
      s.archived = true
      this.sessions.push(s)
    }
  }

  /**
   * 纯数据快照，可直接 JSON 序列化与断言比对。
   * 不含 Set / Map / 函数，保证「存下来的」和「算出来的」可逐字段比较。
   */
  snapshot() {
    const s = this.session
    const viewers = s ? Object.keys(s.viewers).length : 0

    const topGifters = s
      ? Object.entries(s.giftByUser)
          .map(([uid, v]) => ({ uid, name: v.name, count: v.count, battery: v.battery }))
          .sort((a, b) => b.battery - a.battery || b.count - a.count)
          .slice(0, 10)
      : []

    const giftRank = s
      ? Object.entries(s.giftByGift)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
      : []

    const realSessions = this.sessions.filter((x) => !x.implicit).length

    return {
      roomId: this.roomId,
      lastSeq: this.lastSeq,
      state: this.state,
      /** 场次起点是否确定（收到过 LIVE_START）。隐式场次为 false。 */
      hasKnownStart: this.sm.hasKnownStart,
      sessionId: s?.id ?? null,
      sessionImplicit: s?.implicit ?? false,
      liveStartedAt: s?.startedAt ?? 0,
      liveEndedAt: s?.endedAt ?? 0,
      danmaku: s?.danmaku ?? 0,
      giftCount: s?.giftCount ?? 0,
      giftBattery: s?.giftBattery ?? 0,
      guardCount: s?.guardCount ?? 0,
      guardBattery: s?.guardBattery ?? 0,
      scCount: s?.scCount ?? 0,
      scBattery: s?.scBattery ?? 0,
      enterCount: s?.enterCount ?? 0,
      uniqueViewers: viewers,
      topGifters,
      giftRank,
      /** 已封存的**真**场次数。隐式场次不计入，避免"场次数量虚增" */
      finishedSessions: realSessions,
      implicitSessions: this.sessions.length - realSessions,
      eventsByType: { ...this.eventsByType },
      grand: { ...this.grand },
    }
  }

  /**
   * 已封存场次的摘要列表（战报用）。隐式的也给出，由调用方决定是否使用。
   *
   * 摘要逻辑抽到模块级的 `summarizeSession()`：进行中的那一场不在 sessions 里，
   * 战报要把它也显示出来，两处形状必须一致 —— 各写一份迟早会分叉。
   */
  listSessions() {
    /**
     * 这里必须写成箭头函数。
     *
     * `this.sessions.map(summarizeSession)` 会把**下标**当第二个参数传进去，
     * 而 `summarizeSession(s, now)` 的第二个参数是"现在"。于是第一场拿到 0、
     * 第二场拿到 1…… 关闭的场次有 endedAt 兜着，看不出问题；
     * 一旦某场 endedAt 为 0（旧数据、手工修过的日志、以后新增的封存路径），
     * 时长就成了 max(0, (0 - startedAt)/1000) = 0 —— 三小时的直播显示 0 分钟，
     * 而且一行日志都没有。
     */
    return this.sessions.map((s) => summarizeSession(s))
  }
}

/**
 * 一场的摘要。
 *
 * 已关闭的场次和"正在进行的那一场"都走这里 —— 战报列表里两者是并排显示的，
 * 形状不一致前端就得写两套渲染。
 *
 * `durationSec` 对进行中的场次用 `now` 算，所以它是"已播时长"而不是 0 ——
 * 显示 0 会让人以为数据没进来。
 *
 * @param {object} s 场次对象（Projection.session 或 sessions 里的元素）
 * @param {number} [now]
 */
export function summarizeSession(s, now = Date.now()) {
  const endedAt = s.endedAt || 0
  const lastEventTs = Number(s.lastEventTs) || s.startedAt || 0

  /**
   * 「进行中」的场次如果已经很久没有事件，它其实已经断了 —— 只是没人告诉投影。
   *
   * 最典型的来源：进程退出时补的那条 LIVE_END 只在启动时才写，
   * 而进程是被直接杀掉的（或者机器断电），日志里就留下一个永远开着的场次。
   * 战报若不判这个，三个月前那一场会显示"进行中 · 2160 小时"。
   *
   * 判死之后时长冻结在"最后一条事件"，并标 stale，前端显示成「已中断」，
   * 不冒充还在播。
   */
  const stale = !s.closed && lastEventTs > 0 && now - lastEventTs > STALE_AFTER
  const end = endedAt || (stale ? lastEventTs : now)

  return {
    id: s.id,
    /** 场次起点不可靠（进程在直播中途启动）。战报里要标出来，否则时长是假的 */
    implicit: Boolean(s.implicit),
    closed: Boolean(s.closed),
    /**
     * 这一场没有收到 LIVE_END，结束时间是按"最后一条事件 + 宽限"推断的。
     * 前端显示成「约 x 分钟」，不假装精确。
     */
    endedAtEstimated: Boolean(s.endedAtEstimated),
    /** 开着的场次但已经很久没有事件 —— 连接断了/进程被杀，不是真的还在播 */
    stale,
    startedAt: s.startedAt,
    endedAt,
    /** 最后一条事件的时间。用它判断"这场到底还活着吗"，比 endedAt 可靠 */
    lastEventTs,
    durationSec: Math.max(0, Math.round((end - s.startedAt) / 1000)),
    danmaku: s.danmaku,
    enterCount: s.enterCount,
    uniqueViewers: Object.keys(s.viewers).length,
    followCount: s.followCount ?? 0,
    sentCount: s.sentCount ?? 0,
    likeCount: s.likeCount ?? 0,
    peakPopularity: s.peakPopularity ?? 0,
    giftCount: s.giftCount,
    giftBattery: s.giftBattery,
    guardCount: s.guardCount,
    guardBattery: s.guardBattery,
    scCount: s.scCount,
    scBattery: s.scBattery,
    /** 三类收入合计（电池）。元 = /10，前端统一换算 */
    totalBattery: s.giftBattery + s.guardBattery + s.scBattery,
    giftTop: Object.entries(s.giftByGift)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3),
  }
}

export default Projection
