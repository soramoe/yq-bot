/**
 * 房间状态机：offline ⇄ live ⇄ live_unknown。
 *
 * 为什么单独抽出来（决策记录 D3）：
 *
 * 二代把幂等判断散落在各个插件里 —— 每个插件自己写
 * `if (st.liveOn) return`、`if (liveStartedAt > 0) return`。
 * 结果是：谁忘了写，谁就在重连/重放时重复发一次欢迎或下播文案，
 * 而且这种 bug 只在特定时序下出现，极难复现。
 *
 * 三代的做法：**边沿事件只由状态机产出**，插件只消费
 * `live_started` / `live_ended`，不需要自己判断"是不是第一次"。
 *
 * ## 为什么有三个状态而不是两个
 *
 * 审计发现的真实缺陷：隐式场次（进程在直播中途启动，只有弹幕没有 LIVE_START）
 * 曾把状态直接设为 `live`，于是后面真正的 LIVE_START 到来时，
 * 「当前已是 live」导致不出边沿 —— 两场数据被合并成一场，全程零报错。
 *
 * 所以必须区分：
 *   - `live`          在播，且**场次起点确定**（收到过 LIVE_START）
 *   - `live_unknown`  在播，但**场次起点未知**（只有事件，没有 LIVE_START）
 *
 * 隐式场次进入的是 `live_unknown`，因此真 LIVE_START 到来时
 * `live_unknown → live` 仍是一次真实的状态转变，边沿照出。
 *
 * ## 幂等靠什么
 *
 * 不靠"当前状态"，靠 **seq**：同一个事件喂两遍，投影层第一道判断就挡住了
 * （`ev.seq <= lastSeq`）。状态机只负责语义，不负责去重。
 * 唯一例外是 B站 在重连后重复推送同一次开播，用 `liveTime` 识别，
 * 见下面 `_isSameLive`。
 */

export const OFFLINE = 'offline'
export const LIVE = 'live'
export const LIVE_UNKNOWN = 'live_unknown'

export const EDGE = {
  LIVE_STARTED: 'live_started',
  LIVE_ENDED: 'live_ended',
}

export class RoomStateMachine {
  /** @param {'offline'|'live'|'live_unknown'} initial */
  constructor(initial = OFFLINE) {
    this.state = initial === LIVE || initial === LIVE_UNKNOWN ? initial : OFFLINE
    /** 当前场次的开播时间（B站 的 live_time），0 表示未知。用于识别重复推送 */
    this.liveTime = 0
    this.lastEdge = null
  }

  get isLive() {
    return this.state !== OFFLINE
  }

  /** 场次起点是否确定（收到了 LIVE_START）。隐式场次为 false。 */
  get hasKnownStart() {
    return this.state === LIVE
  }

  /**
   * 标记「有事件在来，但没收到开播消息」。
   * 不产生边沿 —— 这不是一次开播，只是发现房间里已经有人说话了。
   */
  markLiveUnknown() {
    if (this.state === OFFLINE) this.state = LIVE_UNKNOWN
    return this.state
  }

  /**
   * 喂一个事件，返回状态与边沿。
   *
   * @param {{type: string, payload?: object}} event
   * @returns {{state: string, edge: string|null, changed: boolean}}
   */
  feed(event) {
    const before = this.state
    let edge = null
    const type = event?.type
    const payload = event?.payload ?? {}

    if (type === 'LIVE_START') {
      const liveTime = Number.isFinite(payload.liveTime) ? payload.liveTime : 0

      if (before === LIVE && this._isSameLive(liveTime)) {
        // 同一次开播的重复推送（重连、重放）：不开新场、不出边沿
      } else {
        this.state = LIVE
        this.liveTime = liveTime || this.liveTime
        edge = EDGE.LIVE_STARTED
      }
    } else if (type === 'LIVE_END') {
      if (before !== OFFLINE) {
        this.state = OFFLINE
        this.liveTime = 0
        edge = EDGE.LIVE_ENDED
      }
    }

    this.lastEdge = edge
    return { state: this.state, edge, changed: before !== this.state }
  }

  /**
   * 判断这条 LIVE_START 是否只是同一次开播的重复推送。
   *
   * 有 liveTime 时严格比对；没有 liveTime 时保守认定为重复 ——
   * 因为"真的又开了一场"几乎总伴随新的 liveTime，
   * 而"重推"往往是补发、重放、重连这类没有新信息的情形。
   * 万一判断错了，代价是多一场空场次，而不是丢一整场数据。
   */
  _isSameLive(liveTime) {
    if (!liveTime || !this.liveTime) return true
    return liveTime === this.liveTime
  }

  /** 供快照序列化。 */
  toJSON() {
    return { state: this.state, liveTime: this.liveTime, lastEdge: this.lastEdge }
  }
}

export default RoomStateMachine
