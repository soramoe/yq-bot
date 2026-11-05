/**
 * 上舰。
 *
 * 单独一个文件不是为了行数，是因为它有一条**和普通进场不同的业务判断**：
 * 上舰的人常常同时触发一条进场事件，两条都处理就会在同一个瞬间
 * 发两句（一句"欢迎"一句"感谢舰长"）。
 *
 * 现在靠两件事解决：
 *   1. 上舰走 `guard` 文案，且 `claims` 里 GUARD_BUY 的优先级高于 ENTER
 *   2. 与进场**共用同一张冷却表** —— 上舰那条说完，紧跟着的进场被挡住
 *
 * 第 2 条是关键。只靠"优先级高"的话，两条事件类型不同，各自都会走到
 * 自己的 handler 里，挡不住。
 */

export function handleGuard(ctx, ev, greeter) {
  const cfg = ctx.config
  if (!cfg.welcomeGuard) return false
  // 续费和首次上舰是两种话：对老舰长说"开通"会让人觉得你没记住他。
  // 报文里的 is_renew 由 normalize.mjs 统一认（也兼容名字里带"续费"的情况）。
  const renew = ev?.payload?.isRenew === true
  // 续费文案留空时回落到上舰文案：宁可说得普通，也不能因为没填新字段就不吭声。
  const template = renew ? cfg.renewTemplate || cfg.guardTemplate : cfg.guardTemplate
  return greeter.greet(ctx, ev, {
    template,
    reason: renew ? 'guard_renew' : 'guard',
    sessionGate: false,
  })
}
