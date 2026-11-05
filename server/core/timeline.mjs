/**
 * 时间轴回看：把一场直播按时间切成小格，回答「到这一刻为止，场上是什么样」。
 *
 * ## 和战报、沙盒的分工
 *
 *   · 战报：这一场**总共**怎么样（一行汇总 + 每场一张卡）
 *   · 时间轴：这一场**怎么走过来的**（第 20 分钟弹幕突然涨了，是谁带的）
 *   · 沙盒：**换一套配置**重跑，会多说哪些话
 *
 * 三者的数据都来自同一份日志，但只有时间轴是"沿时间轴看"，所以它的形状
 * 必须是**累积量**：第 3 格的数字里包含第 1、2 格。非累积的"每分钟增量"
 * 也能画，但那要前端自己加总才能回答"现在多少"，等于又开一个真相。
 *
 * ## 为什么格子里是快照而不是增量
 *
 * 累积量可以直接和战报对账：最后一格必须等于战报里这一场的数字。
 * 增量做不到这一点（少一条事件就永远差一点，而且查不出来）。
 * 自检里就是这么断言的 —— 两边口径一旦分叉，测试立刻失败。
 *
 * ## 为什么标记里没有弹幕
 *
 * 一场八小时的直播有一万多条弹幕，全带上就是几 MB，而拖动时间轴时
 * 真正想看的不是"第 3000 条弹幕说了什么"，是"这一段发生了什么值得注意的事"：
 * 礼物、醒目留言、上舰、关注、开播下播、以及**机器人自己说了什么**。
 * 弹幕的量已经由柱子表达了（每格多少条）。想看具体弹幕，去事件流翻。
 */

import { Projection, summarizeSession } from './projection.mjs'

/** 一格的默认宽度（秒）。60 秒是"能看出起伏、又不会让格子多到拖不动"的平衡点 */
export const DEFAULT_STEP_SEC = 60

/** 格子宽度的硬边界：低于 10 秒就没有"回看"的意义，高于 1 小时看不出波动 */
const MIN_STEP_SEC = 10
const MAX_STEP_SEC = 3600

/**
 * 最多多少格。2000 格 × 几十字节 ≈ 百来 KB，前端也画得动；
 * 超过就自动加宽格子，而不是拒绝请求 —— 用户要的是"看一眼这一场"，
 * 不该因为播了 40 小时就什么都不给。
 */
const MAX_FRAMES = 2000

/** 最多多少条标记。再多前端列表也翻不动，且响应会明显变大 */
const MAX_MARKS = 800

/**
 * 哪些事件值得出现在时间轴上。
 *
 * 刻意不含 DANMAKU / ENTER / LIKE：它们的量由柱子表达，
 * 逐条列出来只会把真正值得看的那几条冲走。
 */
const MARK_TYPES = new Set([
  'LIVE_START',
  'LIVE_END',
  'GIFT',
  'SUPER_CHAT',
  'GUARD_BUY',
  'FOLLOW',
  'SHARE',
  'SENT',
])

/**
 * 把格子宽度收敛到合法范围。
 * @param {unknown} v
 * @returns {number}
 */
export function normalizeStep(v) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STEP_SEC
  return Math.min(MAX_STEP_SEC, Math.max(MIN_STEP_SEC, n))
}

/** 一帧里要带的字段。和战报同源，前端画图/挂数字都直接读它 */
function frameOf(session, t, start) {
  if (!session) {
    return {
      t,
      elapsedSec: Math.max(0, Math.round((t - start) / 1000)),
      danmaku: 0,
      enterCount: 0,
      uniqueViewers: 0,
      followCount: 0,
      giftCount: 0,
      giftBattery: 0,
      guardCount: 0,
      guardBattery: 0,
      scCount: 0,
      scBattery: 0,
      sentCount: 0,
      totalBattery: 0,
      peakPopularity: 0,
    }
  }

  // 复用战报的摘要函数：时间轴上第 N 格的数字和战报卡片上的数字
  // 必须用同一段代码算出来，否则"图上 120、卡片上 118"这种事迟早发生
  const s = summarizeSession(session, t)
  return {
    t,
    elapsedSec: Math.max(0, Math.round((t - start) / 1000)),
    danmaku: s.danmaku,
    enterCount: s.enterCount,
    uniqueViewers: s.uniqueViewers,
    followCount: s.followCount,
    giftCount: s.giftCount,
    giftBattery: s.giftBattery,
    guardCount: s.guardCount,
    guardBattery: s.guardBattery,
    scCount: s.scCount,
    scBattery: s.scBattery,
    sentCount: s.sentCount,
    totalBattery: s.totalBattery,
    peakPopularity: s.peakPopularity,
  }
}

/**
 * 一条值得回看的事件。
 *
 * 只保留展示需要的原始字段，**不在这里拼文案** —— 金额的单位换算
 * （电池 → 元）和"舰长/提督"的叫法都在前端，和页面其它地方共用一份，
 * 服务端再拼一遍就会有两个说法。
 *
 * @param {{seq:number, ts:number, type:string, payload:object}} ev
 */
function markOf(ev) {
  const p = ev.payload ?? {}
  return {
    seq: Number(ev.seq) || 0,
    ts: Number(ev.ts) || 0,
    type: String(ev.type ?? ''),
    uname: String(p.uname ?? ''),
    // 礼物名 / SC 正文 / 机器人说的话，都在 text 里（字段名沿用了报文）
    text: String(p.giftName ?? p.message ?? p.text ?? ''),
    num: Number(p.num) || 1,
    battery: Number.isFinite(Number(p.battery)) ? Number(p.battery) : 0,
    guardLevel: Number(p.guardLevel) || 0,
  }
}

/**
 * 生成时间轴。
 *
 * @param {object[]} events 已按 seq 升序的事件（可以是整天/整场的日志）
 * @param {object} opts
 * @param {number} opts.from 窗口起点（ms，含）
 * @param {number} opts.to   窗口终点（ms，含）
 * @param {number} [opts.stepSec]
 * @param {string} [opts.roomId]
 * @param {number} [opts.maxMarks]
 * @returns {{from:number,to:number,stepSec:number,frames:object[],marks:object[],
 *   marksTruncated:boolean,totals:object,eventCount:number}}
 */
export function buildTimeline(events, { from, to, stepSec, roomId = '', maxMarks = MAX_MARKS } = {}) {
  const start = Number(from)
  const end = Number(to)

  const empty = {
    from: Number.isFinite(start) ? Math.floor(start) : 0,
    to: Number.isFinite(end) ? Math.floor(end) : 0,
    stepSec: normalizeStep(stepSec),
    frames: [],
    marks: [],
    marksTruncated: false,
    totals: null,
    eventCount: 0,
  }

  // 起点 >= 终点 就是空窗口：宁可明确返回空，也不要造出一堆 0 让前端以为"这一场没人"
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return empty

  /**
   * 格宽。
   *
   * 请求的宽度先过一遍合法区间，然后按**格数上限**自动加宽：
   * 四十小时的直播按 10 秒切是一万四千格，浏览器拖不动，响应也太大。
   * 加宽而不是截断 —— 截断会让时间轴停在半路，最后几小时根本看不到，
   * 而"回看这一场"恰恰常常是为了看结尾。
   */
  const spanMs = end - start
  const stepMs = Math.max(normalizeStep(stepSec) * 1000, Math.ceil(spanMs / MAX_FRAMES))
  const step = Math.round((stepMs / 1000) * 10) / 10
  const count = Math.max(1, Math.ceil(spanMs / stepMs))

  /** 窗口内的事件，按时间顺序喂给投影 */
  const picked = []
  const marks = []
  let marksTruncated = false

  for (const ev of Array.isArray(events) ? events : []) {
    const ts = Number(ev?.ts)
    if (!Number.isFinite(ts) || ts < start || ts > end) continue
    picked.push(ev)

    if (MARK_TYPES.has(ev.type)) {
      if (marks.length < maxMarks) marks.push(markOf(ev))
      else marksTruncated = true
    }
  }

  /**
   * 窗口里一条事件都没有：直接返回空。
   *
   * 不返回"一排 0" —— 一排 0 在前端看起来像"这一场有人但全程没人说话"，
   * 而事实是"这一天根本没开播 / 日志里没有这一段"。两者要能分开。
   */
  if (picked.length === 0) return { ...empty, from: Math.floor(start), to: Math.floor(end), stepSec: step }

  /**
   * 按 **seq** 排序，不是按时间。
   *
   * 投影是幂等的：`apply()` 会丢掉 `seq <= lastSeq` 的事件（防重复投递）。
   * 所以喂给它的顺序必须是 seq 升序，**按时间排会把事件悄悄丢掉** ——
   * 时间轴最后一格于是比战报少一截，而且不报错。
   * 格子仍然按时间切（下面按 ts 算 bucket），只是喂数据用 seq 顺序。
   *
   * 这也意味着：时钟被校准过、seq 与时间不一致的那天，
   * 来得"晚"的事件会记在它到达之后的那几格里 —— 和线上实时看到的一样。
   * 合计不受影响：所有事件最终都会被 apply 一次。
   */
  picked.sort((a, b) => Number(a.seq) - Number(b.seq))

  // 标记只用于展示，按时间排更好读（和上面的喂数据顺序无关）
  marks.sort((a, b) => a.ts - b.ts || a.seq - b.seq)

  /**
   * 逐条重放，在跨越格子边界时拍快照。
   *
   * 一次遍历：O(事件数 + 格数)。若"每格从头 apply 一遍"，
   * 八小时的直播能到上亿次。
   */
  const proj = new Projection(String(roomId ?? ''))
  const frames = []
  /** 下一格待拍的下标。格子是累积量，所以只在跨格时拍一次 */
  let b = 0
  /** 上一格的累积弹幕数，用来算「这一格新增了多少」 */
  let prevDanmaku = 0

  /**
   * 压入一格。
   *
   * `danmakuDelta` 是**这一格新增**的弹幕数，由服务端算好给柱状图用。
   * 前端若自己拿相邻两格相减，就等于又写了一遍"累积量"的定义 ——
   * 一旦哪天 frames 改成增量，图上会静默变成二阶差分。
   */
  const pushFrame = (f) => {
    f.danmakuDelta = Math.max(0, f.danmaku - prevDanmaku)
    prevDanmaku = f.danmaku
    frames.push(f)
  }

  /** 第 index 格的结束时刻。最后一格收在窗口终点上，不越出 to */
  const frameEndOf = (index) => Math.min(end, start + (index + 1) * stepMs)

  for (const ev of picked) {
    const ts = Number(ev.ts)
    const bucket = Math.min(count - 1, Math.max(0, Math.floor((ts - start) / stepMs)))

    // 先把它**之前**的格子拍完，再喂这条事件 —— 这样这条事件只影响自己那一格起
    while (b < bucket) {
      pushFrame(frameOf(proj.session, frameEndOf(b), start))
      b++
    }

    try {
      proj.apply(ev)
    } catch {
      // 单条脏事件只让这一格偏一点，不能让整条时间轴失败
    }
  }

  // 剩下的格子（后面没有事件了，数字保持不动）
  while (b < count) {
    pushFrame(frameOf(proj.session, frameEndOf(b), start))
    b++
  }

  const last = frames[frames.length - 1] ?? null
  return {
    from: Math.floor(start),
    to: Math.floor(end),
    stepSec: step,
    frames,
    marks,
    marksTruncated,
    /** 整段窗口的合计。恒等于 frames 的最后一格，前端拿它对账 */
    totals: last
      ? {
          danmaku: last.danmaku,
          enterCount: last.enterCount,
          uniqueViewers: last.uniqueViewers,
          followCount: last.followCount,
          giftCount: last.giftCount,
          giftBattery: last.giftBattery,
          guardCount: last.guardCount,
          guardBattery: last.guardBattery,
          scCount: last.scCount,
          scBattery: last.scBattery,
          sentCount: last.sentCount,
          totalBattery: last.totalBattery,
          peakPopularity: last.peakPopularity,
        }
      : null,
    eventCount: picked.length,
  }
}

export default buildTimeline
