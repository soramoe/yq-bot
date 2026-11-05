/**
 * 内核认识的事件类型。
 *
 * 这一层存在的意义（决策记录 D12）：
 * **协议会变，事件模型不变。**
 *
 * B站 改一次字段结构，只需要动 `bili/normalize.mjs` 一个文件；
 * 投影、插件、自检全部不受影响。反过来如果把原始报文直接传给插件，
 * 每次协议调整都会波及所有插件。
 *
 * 命名用大写 + 下划线，因为事件名会出现在日志和事件流里，
 * 大写比小写更容易在长日志里一眼扫到。
 */

export const EVENT = {
  /** 弹幕 */
  DANMAKU: 'DANMAKU',
  /** 进场 */
  ENTER: 'ENTER',
  /** 关注 */
  FOLLOW: 'FOLLOW',
  /** 分享直播间 */
  SHARE: 'SHARE',
  /** 送礼物 */
  GIFT: 'GIFT',
  /** 上舰 / 续舰 */
  GUARD_BUY: 'GUARD_BUY',
  /** 醒目留言 */
  SUPER_CHAT: 'SUPER_CHAT',
  /** 点赞 */
  LIKE: 'LIKE',
  /** 在线人数变化 */
  ONLINE_COUNT: 'ONLINE_COUNT',
  /** 开播（边沿，由状态机判定是否真的开播） */
  LIVE_START: 'LIVE_START',
  /** 下播 */
  LIVE_END: 'LIVE_END',
  /**
   * 房间标题变更（B站 的 ROOM_CHANGE）。
   *
   * 主播开播 / 改标题时都会推。`runner.info.title` 只在启动时填一次，
   * 不接这条的话页头与总览显示的标题会一直停在启动那一刻。
   */
  ROOM_TITLE: 'ROOM_TITLE',
  /**
   * 机器人说了一句话。
   *
   * 为什么要把"自己说的话"也写进日志：直播中重启后，
   * 靠它才知道刚才欢迎过谁、答谢过哪个礼物，避免重复播报。
   * 二代的这类状态全在插件内存里，重启即失忆。
   */
  SENT: 'SENT',
};

/** 中文标签，给前端事件流和日志用。新增类型忘了加这里，界面上会显示原始英文名 */
export const EVENT_LABEL = {
  [EVENT.DANMAKU]: '弹幕',
  [EVENT.ENTER]: '进场',
  [EVENT.FOLLOW]: '关注',
  [EVENT.SHARE]: '分享',
  [EVENT.GIFT]: '礼物',
  [EVENT.GUARD_BUY]: '上舰',
  [EVENT.SUPER_CHAT]: '醒目留言',
  [EVENT.LIKE]: '点赞',
  [EVENT.ONLINE_COUNT]: '在线人数',
  [EVENT.LIVE_START]: '开播',
  [EVENT.LIVE_END]: '下播',
  [EVENT.ROOM_TITLE]: '改标题',
  [EVENT.SENT]: '机器人发言',
};

/**
 * 会产生"观众互动"语义的事件类型。
 * 统计"活跃观众"时只看这几类 —— 人数变化和点赞不算互动。
 */
export const INTERACTION_EVENTS = new Set([
  EVENT.DANMAKU,
  EVENT.ENTER,
  EVENT.GIFT,
  EVENT.GUARD_BUY,
  EVENT.SUPER_CHAT,
]);

/** 舰长等级 → 中文 */
export const GUARD_NAME = {
  0: '无',
  1: '总督',
  2: '提督',
  3: '舰长',
};

/**
 * 哪些事件要记进观众簿。
 *
 * 以前只记 ENTER —— 结果是：只关注 / 只分享 / 只上舰 / 只打 SC / 只送礼
 * 的人，报文里明明有 uid 和昵称，却没进簿子，于是自动打招呼永远挑不到他们。
 * 现在凡是**低频、且代表"这个人确实在场"**的事件都记。
 *
 * **刻意不记弹幕和点赞**：这两类量大且频繁，每次 `mark()` 都会把
 * `lastSeenAt` 刷成"现在"。而观众簿回答的是「多久没来了」——
 * 一个人连发三条弹幕就能把自己刷成"刚来过"，这个功能就失去了意义。
 * 而且真正发弹幕的人进场时已经被 ENTER 记过了，边际收益很低。
 *
 * 放在这里而不是 `room-runner` 里：定义它的地方和使用它的地方要有两个
 * （线上入库、沙盒回放），放在任何一边都会让另一边 import 一个重型模块 ——
 * 沙盒为了这个集合去拉整个 B站 长连模块，明显不对。
 */
export const ROSTER_EVENTS = new Set([
  EVENT.ENTER,
  EVENT.GIFT,
  EVENT.FOLLOW,
  EVENT.SHARE,
  EVENT.GUARD_BUY,
  EVENT.SUPER_CHAT,
]);

export function isEventType(type) {
  return Object.prototype.hasOwnProperty.call(EVENT_LABEL, String(type));
}
