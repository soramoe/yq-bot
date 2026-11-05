/**
 * 醒目留言（SC）答谢插件。
 *
 * ## 和礼物答谢最像，但三条规矩完全相反
 *
 * | | 礼物答谢 | SC 答谢 |
 * |---|---|---|
 * | 合并 | 必须合并（连击会刷屏） | **绝不合并** |
 * | 冷却 | 同一人有冷却 | **没有冷却** |
 * | 优先级 | 可以等槽位 | 更要等（买了置顶的） |
 *
 * 理由：SC 是观众**花钱买了置顶**的，一条就是一条。把它合并成
 * 「感谢 A、B 的醒目留言×2」，等于把两个人各付一次的钱合成一次答谢 ——
 * 观众不会骂机器人，会觉得主播没看见他。
 *
 * ## 金额的单位陷阱（这个坑真的踩过）
 *
 * 礼物、上舰的报文金额是**金瓜子**，走 `toBattery()`（÷100）。
 * 而 SC 报文的 `price` 是**元**。三代最早一律套 `toBattery()`，
 * 于是 100 元的 SC 被算成 1 电池（0.1 元）—— 差 1000 倍，且不报错。
 *
 * 现在归一化层已经负责换算，插件这边拿到的 `yuan` 就是元，
 * **不要再乘除任何系数**。
 *
 * ## 为什么不默认复述留言
 *
 * B站 弹幕长度上限是 20 字（普通账号）。SC 的留言动辄三五十字，
 * 直接塞进去会被发送层截断，变成一句断在半个词上的话 ——
 * 比不复述更难看。所以默认只道谢 + 报金额，复述需要手动打开，
 * 并且留言会先截到 `maxTextLen`。
 *
 * ## 已知取舍：同一人连发同额 SC
 *
 * 两条「感谢 A 的 30 元醒目留言！」文案一模一样，会被内核闸门的
 * **内容去重**拦下第二条。这是故意的：闸门不为单个插件破例（D22）。
 * 拦下时插件会写一条 info 日志，不会静默吞掉。
 */

/** 比礼物答谢高一级：SC 买了置顶，更需要即时反馈 */
const SAY_PRIORITY = 2
/** 最多等 5 秒。SC 比礼物贵，值得多等一会儿 */
const SAY_MAX_WAIT_MS = 5000

/**
 * 弹幕长度上限，与 `server/bili/send.mjs` 的 `MAX_TEXT` 保持一致。
 *
 * 这里**不复用那个常量**是对的：插件不该 import 发送层（D22 的精神 ——
 * 插件只知道"我要说一句话"，不知道这句话怎么发出去）。
 * 但两边必须写一样的数，所以这里注明来源，改那边时记得改这里。
 *
 * 超长不会被拒，发送层会截断，于是文案会断在半个词上。所以插件先自己
 * 检查一遍并告警 —— 让"难看"变成日志里能看见的事，而不是悄悄发生。
 */
const DANMAKU_LIMIT = 20

export default {
  id: 'sc',

  /**
   * 本场计数放 `ctx.scratch`，不放这个模块导出对象。
   * ESM 按 URL 缓存，挂在对象上就是全进程一份 —— 两个房间会互相
   * 把对方的计数清零，且重启统计不准。见决策记录 D60。
   */
  onStart(ctx) {
    ctx.scratch.seen = 0
    ctx.log.info('醒目留言答谢插件已启动')
  },

  onStop(ctx) {
    ctx.log.info(`醒目留言答谢插件已停止（本场处理 ${ctx.scratch.seen ?? 0} 条）`)
    ctx.scratch.seen = 0
  },

  onEvent(ctx, ev) {
    if (ev.type !== 'SUPER_CHAT') return false

    const cfg = ctx.config
    if (!cfg.enabled) return false

    const p = ev.payload ?? {}
    const uid = String(p.uid ?? '')
    const uname = String(p.uname ?? '').trim()

    // 没名字就没法称呼。不认领，留给别的插件（目前没有别的）
    if (!uname) return false

    // 金额在归一化层已经换算成元，这里直接用，不要再除
    const yuan = Number(p.yuan) || 0
    const floor = Math.max(0, Number(cfg.minYuan) || 0)
    if (yuan < floor) return false

    const text = buildText(ctx, cfg, p, uname)
    if (!text) return false

    if (text.length > DANMAKU_LIMIT) {
      // 不阻断发送：截断后的句子虽然难看，但至少观众看到回应了。
      // 告警是为了让"该改短文案"这件事浮上来
      ctx.log.warn(
        `醒目留言答谢有 ${text.length} 字，超过弹幕上限 ${DANMAKU_LIMIT} 会被截断：${text}`,
      )
    }

    ctx.scratch.seen = (ctx.scratch.seen ?? 0) + 1

    Promise.resolve(
      ctx.say(text, {
        reason: 'sc',
        reply: uid ? { uid, uname } : null,
        priority: SAY_PRIORITY,
        maxWaitMs: SAY_MAX_WAIT_MS,
      }),
    )
      .then((r) => {
        if (r && !r.ok) {
          // 最常见的是 duplicate（同人同额连发）。不是错误，但要留痕：
          // 「主播以为回了、其实没回」是最难发现的那类问题
          ctx.log.info(`醒目留言答谢未发出（${r.skipped ?? 'unknown'}）：${text}`)
        }
      })
      .catch((err) => ctx.log.warn(`醒目留言答谢失败：${err.message}`))

    return true
  },
}

/**
 * 拼一句答谢。
 *
 * 复述留言时先按 `maxTextLen` 截断：整句弹幕总共只有 20 字，
 * 留言多占一个字，称呼或金额就更可能被截掉半个。
 */
function buildText(ctx, cfg, p, uname) {
  const raw = String(p.text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

  const wantText = !!cfg.readText && raw.length > 0
  const tpl = wantText ? cfg.templateWithText : cfg.template
  if (!tpl) return ''

  const limit = Math.max(0, Number(cfg.maxTextLen) || 0)
  const cut = wantText && raw.length > limit ? raw.slice(0, limit) : raw

  const duration = Number(p.duration) || 0

  return ctx.render(tpl, {
    用户: uname,
    // 整数不显示小数点：30 元比 30.0 元好看，0.1 元也不会被抹成 0
    金额: formatYuan(Number(p.yuan) || 0),
    时长: duration > 0 ? Math.round(duration / 60) : 0,
    留言: cut,
  })
}

/** 30 → "30"，30.5 → "30.5"。不补零，弹幕里每一个字都贵 */
function formatYuan(n) {
  return String(Math.round((Number(n) || 0) * 10) / 10)
}
