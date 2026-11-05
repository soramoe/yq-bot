/**
 * 欢迎插件。
 *
 * 这是三代第一个真正的"玩法"插件，作用是把二代的
 * `welcome`（417 行）+ `welcome-pro`（906 行）合成一个（决策记录 D5）。
 *
 * 二代把它们拆成两个插件，于是同一个进场观众会被两套冷却、
 * 两套模板、两份"这个人归谁管"的判断同时覆盖，最后靠互相打补丁共存。
 *
 * 三代合并成一个插件，内部按职责分三个模块 —— **这个文件只做装配**：
 *
 *   honor.mjs   这个人是谁（粉丝牌、舰长等级）→ 模板变量
 *   greet.mjs   该不该说、说什么、怎么说（含共享冷却表）
 *   guard.mjs   上舰那条特殊路径（要和进场抢同一张冷却表）
 *
 * 为什么值得拆：原来 161 行里，"变量组装"和"冷却判断"和"路由"
 * 三层混在一起，改一处要读完全文才知道会不会碰到另一处。
 * 拆完之后，想知道"粉丝牌怎么渲染"只需看 40 行的 honor.mjs。
 *
 * 领域知识（来自二代的实测，不是猜的）：
 *   · 观众反复进出是最常见的刷屏来源，所以**同一 uid 必须有冷却**，
 *     而不是"每次进场都欢迎一次"。
 *   · 上舰是花钱的事，文案必须和普通进场分开，且优先级更高。
 *   · 粉丝牌 / 舰长等级都可能是空的，模板渲染时不能留下 `{}` 或 "undefined"。
 */

import { Greeter, handleEnter, handleFollow, handleShare } from './greet.mjs'
import { handleGuard } from './guard.mjs'

/**
 * 冷却表要三条路径共用同一份。
 * 每个路径各持一份的话，"关注 + 进场"就会连发两句 —— 这正是二代的老毛病。
 *
 * 但"共用"指的是**同一个房间内**共用，不是整个进程共用。
 * 以前它是模块级的（`const greeter = new Greeter()`），单房间时完全正确，
 * 多房间时两间直播共用一个 Map —— 键虽然带了房间前缀不会串味，
 * 但 `onStart` 里的 `reset()` 会把另一个房间的表一起清空。
 * 宿主给每个插件留了一块 `ctx.scratch`（每宿主每插件一份），放那儿就对了。
 */
function greeterOf(ctx) {
  if (!ctx.scratch.greeter) ctx.scratch.greeter = new Greeter()
  return ctx.scratch.greeter
}

export default {
  id: 'welcome',

  onStart(ctx) {
    ctx.scratch.greeter = new Greeter()
    ctx.log.info('欢迎插件已启动')
  },

  onStop(ctx) {
    ctx.scratch.greeter = null
    ctx.log.info('欢迎插件已停止')
  },

  /**
   * 路由顺序即优先级：上舰 > 关注 > 分享 > 进场。
   *
   * 事件的 type 是互斥的，这个顺序只影响可读性，不影响结果 ——
   * 真正挡住"上舰 + 进场连发两句"的是共享冷却表，不是这里。
   */
  onEvent(ctx, ev) {
    const greeter = greeterOf(ctx)
    if (ev.type === 'GUARD_BUY') return handleGuard(ctx, ev, greeter)
    if (ev.type === 'FOLLOW') return handleFollow(ctx, ev, greeter)
    if (ev.type === 'SHARE') return handleShare(ctx, ev, greeter)
    if (ev.type === 'ENTER') return handleEnter(ctx, ev, greeter)
    return false
  },
}
