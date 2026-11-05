/**
 * 弹幕指令。
 *
 * ## 为什么是"整条消息恰好是一个指令"
 *
 * 观众正常说话时也会带井号（话题、编号、颜文字）。只要规则允许
 * "包含 #帮助"，`#帮助` 就会在聊天里到处触发。所以解析规则是：
 *
 *   整条消息 = `#` 或 `＃` + **一个不含空格的词**（≤ 12 字）
 *
 * `#帮助 你好`、`刚才那个#帮助有点用` 都不算。宁可漏触发，也不能乱插话。
 *
 * ## 为什么要抢在关键词回击前面
 *
 * 宿主的分发是"谁认领谁就短路后面的人"。指令必须优先看到弹幕，
 * 否则用户配了一条 `帮助` 关键词，`#帮助` 就会先被回击插件吃掉。
 * 所以 claims 给 120（reply 是 100）；但**非指令弹幕一律返回 false**，
 * 不会挡住回击插件。
 *
 * ## 数据从哪来
 *
 *   · `#本场`：`ctx.state`（投影快照），只读当前场次
 *   · `#我来过`：`ctx.roster.peek()`，只查不写
 *
 * 两者都是只读入口。指令插件不改任何状态 —— 一个"观众能触发"的功能
 * 不应该顺带改变统计或观众簿。
 */

/** 一个指令词最长多少字。超过就不像指令了 */
const MAX_WORD = 12

/** 冷却表上限，防止超长直播里无限增长 */
const MAX_KEYS = 5000

/**
 * 指令别名。键是**小写后**的词（中文没有大小写，但英文指令有）。
 * 表里同时给中英文，是因为观众不会记得只有中文能用。
 */
const ALIASES = new Map([
  ['帮助', 'help'],
  ['help', 'help'],
  ['?', 'help'],
  ['？', 'help'],
  ['本场', 'session'],
  ['数据', 'session'],
  ['session', 'session'],
  ['我来过', 'visit'],
  ['打卡', 'visit'],
  ['visit', 'visit'],
])

/**
 * 从一条弹幕里解析指令。
 *
 * @param {string} text
 * @returns {string} 规范化后的指令（help / session / visit），不是指令返回空串
 */
export function parseCommand(text) {
  const s = String(text ?? '').trim()
  // `\S` 保证中间没有空格：`#帮助 你好` 不会被当成指令
  const m = /^[#＃]\s*(\S{1,12})$/.exec(s)
  if (!m) return ''
  const word = m[1].toLowerCase()
  if ([...word].length > MAX_WORD) return ''
  return ALIASES.get(word) ?? ''
}

/**
 * 把"上次来访时间"变成人话。
 *
 * 不用 `toLocaleDateString`：观众关心的是"多久以前"，不是一个日期。
 * 而且日期格式受系统区域设置影响，同一个包在不同机器上说出来的话不一样。
 *
 * @param {number} ts
 * @param {number} [now]
 */
export function agoText(ts, now = Date.now()) {
  const day = 86400_000
  const days = Math.floor(Math.max(0, now - Number(ts || 0)) / day)
  // 0 天包含"刚刚"和"今天早些时候"：对观众来说都是今天来过
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  return `${days} 天前`
}

/** 每宿主每插件私有的冷却表 */
function coolMap(ctx) {
  if (!ctx.scratch.cool) ctx.scratch.cool = new Map()
  return ctx.scratch.cool
}

/**
 * 冷却表。时间基准由调用方传进来（事件时间），不是 `Date.now()`。
 *
 * 为什么：沙盒回放把四小时的日志压缩成不到一秒，若按真实时钟判冷却，
 * 一个人四小时里问两次 `#本场`，回放里只会答一次 —— 而当时是答了两次的。
 * 回放的意义就是"当时会怎样"，所以凡是有时间含义的判断，都得用事件时间。
 */
function onCooldown(ctx, uid, sec, now = Date.now()) {
  if (!uid || !(Number(sec) > 0)) return false
  const map = coolMap(ctx)
  const at = map.get(uid)
  return typeof at === 'number' && now - at < Number(sec) * 1000
}

function mark(ctx, uid, now = Date.now()) {
  if (!uid) return
  const map = coolMap(ctx)
  map.set(uid, now)
  if (map.size <= MAX_KEYS) return
  // 清掉最早的一半。写过一次就不再读同一个 key，不需要真正的 LRU
  let i = 0
  const drop = Math.floor(MAX_KEYS / 2)
  for (const k of map.keys()) {
    map.delete(k)
    if (++i >= drop) break
  }
}

export default {
  id: 'command',

  onStart(ctx) {
    ctx.scratch.cool = new Map()
    ctx.log.info('弹幕指令插件已启动')
  },

  onStop(ctx) {
    ctx.scratch.cool = null
    ctx.log.info('弹幕指令插件已停止')
  },

  onEvent(ctx, ev) {
    const cfg = ctx.config
    if (!cfg.enabled) return false
    if (ev.type !== 'DANMAKU') return false

    const p = ev.payload ?? {}
    const cmd = parseCommand(p.text)
    if (!cmd) return false // 不是指令：让给别的插件，一个字都不碰

    const uid = String(p.uid ?? '')
    const uname = String(p.uname ?? '').trim()

    // 没名字就没法称呼，但仍然"认领"：这条确实是发给我的指令，
    // 不该让关键词回击再拿它匹配一次
    if (!uname) return true

    // 时间基准用事件时间而不是 Date.now()：沙盒回放历史日志时，
    // 冷却和「上一次来」都必须相对那一刻算，否则同一条弹幕会随
    // 回放速度说出不同的话（详见 onCooldown 的说明）。
    // ts 为 0 说明这条事件没带时间（测试或坏数据），退回真实时钟。
    const now = Number.isFinite(ev.ts) && ev.ts > 0 ? ev.ts : Date.now()

    // 冷却期内认领但不说 —— 认领是"我看过了"，不是"我不管"
    if (onCooldown(ctx, uid, cfg.cooldownSec, now)) return true

    const text = answer(ctx, cmd, { uid, uname, now })
    if (!text) return true

    // 记冷却要在请求发送之前：即使被闸门限速拦下，
    // 也不该下一秒立刻再试一次（那只会让限速持续满格）
    mark(ctx, uid, now)

    // 20 字是 B站 弹幕上限。超了会被静默截断，所以至少留个日志痕迹 ——
    // 否则用户只会看到"回复少了一半"，不知道是自己文案太长
    if ([...text].length > 20) {
      ctx.log.warn(`指令回复超过 20 字，会被截断：${text}`)
    }

    ctx.say(text, {
      reason: 'command',
      reply: uid ? { uid, uname } : null,
    })

    return true
  },
}

/**
 * 拼一句回复。返回空串表示"这条指令没什么可说的"。
 *
 * @param {object} ctx
 * @param {string} cmd 已规范化的指令
 * @param {{uid:string, uname:string, now:number}} who
 */
function answer(ctx, cmd, who) {
  const cfg = ctx.config

  if (cmd === 'help') return String(cfg.helpText ?? '')

  if (cmd === 'session') {
    const st = ctx.state ?? {}
    return ctx.render(cfg.sessionText, {
      弹幕: st.danmaku ?? 0,
      进场: st.enterCount ?? 0,
      观众: st.uniqueViewers ?? 0,
      礼物: st.giftCount ?? 0,
      舰长: st.guardCount ?? 0,
      SC: st.scCount ?? 0,
      用户: who.uname,
    })
  }

  if (cmd === 'visit') {
    /**
     * 用 `previousSeenAt`，不用 `lastSeenAt`。
     *
     * 观众一进房间，内核在事件入库时就 `mark()` 过了，所以对**正在说话
     * 的这个人**来说 `lastSeenAt` 恒等于刚才 —— 拿它回答"上次什么时候来"
     * 永远是"今天"，等于没回答。`previousSeenAt` 才是「这一次之前的那一次」。
     *
     * 观众簿可能不存在（沙盒、载入失败、这人只发弹幕从没被记过）：
     * 那就当第一次见，与"没有这个功能之前"的行为一致，不会因为簿子读不出来就不理人。
     */
    const rec = ctx.roster?.peek?.(who.uid) ?? null
    const prev = Number(rec?.previousSeenAt) || 0
    if (!(prev > 0)) return ctx.render(cfg.firstVisitText, { 用户: who.uname })
    return ctx.render(cfg.visitText, {
      用户: who.uname,
      上次: agoText(prev, who.now),
    })
  }

  return ''
}
