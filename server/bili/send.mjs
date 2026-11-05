/**
 * 发送直播弹幕。
 *
 * 这一层的领域知识全部来自二代的实测，不是猜的：
 *
 * 1. **必须带 csrf（= bili_jct）**，不是 SESSDATA 就够了。
 *    只有 SESSDATA 时能连直播间、能收弹幕，但发不出去 ——
 *    这种"半残"状态最难查，所以这里对两个字段分别报错。
 *
 * 2. **错误码要分三类**：ok / retry / fatal。
 *    把风控码当网络抖动重试，只会加重风控 —— 而风控码的典型形态
 *    恰恰是"以前没见过的新码"。所以**未知码一律按 fatal 处理**，
 *    宁可停一下等人来看，也不硬发。这是 fail-safe 的方向选择。
 *
 * 3. **@ 只能靠结构化字段**。B站 不解析文本里的 "@名字"，
 *    必须带 reply_mid / reply_uname / show_reply 才会渲染成可点的粉色 @。
 *
 * 4. **弹幕不能换行、不能超长**。超长会被 1003212 拒，
 *    而普通账号只有 20 字上限（大航海 30）。这里按上限硬截断，
 *    宁可少说几个字，也不要一条都发不出去。
 *
 * 与二代的不同：这个模块**只管发**，不管限速、不管 dryRun、不管去重。
 * 那些是内核闸门的职责（见 server/core/gate.mjs）——
 * 让一个模块同时管"怎么发"和"该不该发"，最后一定会互相缠绕。
 */

import { biliRaw } from './http.mjs'
import { parseCookie } from './cookie.mjs'

const API = 'https://api.live.bilibili.com'

/** 普通账号的弹幕上限。大航海更高，但按最严的来最安全。 */
export const MAX_TEXT = 20
/** 大航海的上限，舰长及以上可用 */
export const MAX_TEXT_NOBLE = 30

/** B站 发弹幕的业务码 → 人话。查不到时调用方应展示原始 message。 */
export const SEND_CODE = {
  0: '',
  '-101': '账号未登录，Cookie 已失效（SESSDATA 过期）',
  '-102': '账号已被封禁',
  '-111': 'CSRF 校验失败，bili_jct 不正确',
  '-400': '请求参数错误',
  '-403': '权限不足，可能已被禁言',
  '-412': 'IP 被风控拦截',
  '-799': '请求过于频繁，已被服务端限速',
  '-352': '触发风控校验，需要完成验证码',
  10030: '弹幕被安全策略拦截（含敏感词或重复内容）',
  10031: '发送频率过快，已被限流',
  1003212: '弹幕内容超出长度限制',
}

/**
 * 不可重试：继续发只会加重风控或根本没有意义。
 *
 * 10030 是实测加进来的 —— 同一条内容被安全策略连拦时，
 * 按 retry 反复撞本身就是机器人特征。
 */
const FATAL_CODES = new Set([-101, -102, -111, -403, -352, 10030])

/** 可重试：等一会儿、降速后还有机会 */
const RETRY_CODES = new Set([-799, 10031, -412, -500, -503, -504, -996, -997])

export function describeCode(code) {
  const n = Number(code)
  const text = SEND_CODE[n]
  return text === undefined ? '' : text
}

/**
 * 错误码分类。
 *
 * **未知码一律 fatal。** 这一点在二代反复权衡过：
 * 风控码的典型形态就是"没见过的新码"，把它当 retry 等于
 * 在"最该停下来"的时刻继续按节奏发。确认某个码只是临时问题后，
 * 把它加进 RETRY_CODES 即可（白名单式放行）。
 */
export function classify(code) {
  const n = Number(code)
  if (n === 0) return 'ok'
  if (FATAL_CODES.has(n)) return 'fatal'
  if (RETRY_CODES.has(n)) return 'retry'
  return 'fatal'
}

/** 从 cookie 串里取 csrf。空串表示取不到。 */
export function csrfOf(cookie) {
  const c = parseCookie(cookie)
  return c.bili_jct || ''
}

/** 能否发送：SESSDATA 与 bili_jct 缺一不可 */
export function checkCredential(cookie) {
  const c = parseCookie(cookie)
  const missing = []
  if (!c.SESSDATA) missing.push('SESSDATA')
  if (!c.bili_jct) missing.push('bili_jct')
  return { ok: missing.length === 0, missing, uid: c.DedeUserID || '' }
}

/**
 * 把要发的内容整理成 B站 能接受的样子。
 *
 * 换行会被吞掉、连续空白会变成一串空格 —— 这些不是"美化"，
 * 是发送前的必要清洗：带 \n 的弹幕会被服务端拒绝。
 *
 * @param {string} text
 * @param {{max?:number}} [opts]
 * @returns {{text:string, truncated:boolean, original:string}}
 */
export function prepareText(text, { max = MAX_TEXT } = {}) {
  const original = String(text ?? '')
  let s = original
    .replace(/[\r\n\t]+/g, ' ') // 弹幕是单行，换行必须去掉
    .replace(/\s{2,}/g, ' ')
    .trim()

  let truncated = false
  if (s.length > max) {
    /**
     * 按**码位**截断，不能按 UTF-16 长度。
     *
     * `s.slice(0, max)` 数的是 UTF-16 码元：B站 名字里的 emoji（😀 之类）
     * 占两个码元，正好切在中间就会留下一个孤立代理项（lone surrogate）。
     * 那种字符串 JSON 能序列化，发出去却是乱码方块 ——
     * 而且只在"名字里带 emoji + 文案刚好卡在边界"时出现，几乎不可能复现。
     *
     * 用 Array.from 按码位切开就不会切断任何字符；长度仍按码元判断，
     * 因为 B站 的 20 字上限数的是码元，不是"看得见的字数"。
     */
    const cps = Array.from(s)
    let acc = 0
    let cut = 0
    for (const ch of cps) {
      if (acc + ch.length > max) break
      acc += ch.length
      cut++
    }
    s = cps.slice(0, cut).join('')
    truncated = true
  }

  return { text: s, truncated, original }
}

/**
 * @param {object} opts
 * @param {number|string} opts.roomId 真实房间号
 * @param {string} opts.text
 * @param {string} opts.cookie
 * @param {number} [opts.color]  十进制颜色，默认白色
 * @param {number} [opts.mode]   1 = 滚动弹幕
 * @param {number} [opts.fontSize]
 * @param {{uid:number|string, uname:string, color?:string}|null} [opts.reply] 结构化 @
 * @param {number} [opts.timeout]
 * @param {Function} [opts.post]  便于自检注入，默认走真实接口
 * @returns {Promise<{ok:boolean, code:number, kind:'ok'|'retry'|'fatal', message:string, text:string, truncated:boolean}>}
 */
export async function sendDanmaku({
  roomId,
  text,
  cookie,
  color = 16777215,
  mode = 1,
  fontSize = 25,
  reply = null,
  timeout = 8000,
  post = biliRaw,
}) {
  const cred = checkCredential(cookie)
  if (!cred.ok) {
    return {
      ok: false,
      code: cred.missing.includes('SESSDATA') ? -101 : -111,
      kind: 'fatal',
      message: `缺少 ${cred.missing.join(' / ')}，无法发送弹幕`,
      text: '',
      truncated: false,
    }
  }

  if (!roomId) {
    return { ok: false, code: -400, kind: 'fatal', message: '缺少房间号', text: '', truncated: false }
  }

  const prepared = prepareText(text)
  if (!prepared.text) {
    return {
      ok: false,
      code: -400,
      kind: 'fatal',
      message: '弹幕内容为空',
      text: '',
      truncated: false,
    }
  }

  const csrf = csrfOf(cookie)
  const params = {
    bubble: '0',
    msg: prepared.text,
    color: String(color),
    mode: String(mode),
    fontsize: String(fontSize),
    rnd: String(Math.round(Date.now() / 1000)),
    roomid: String(roomId),
    csrf,
    csrf_token: csrf,
  }

  // 结构化 @：纯文本 "@名字" 在 B站 里不会被识别成提及
  if (reply && reply.uid) {
    params.reply_mid = String(reply.uid)
    params.reply_uname = String(reply.uname ?? '')
    params.reply_uname_color = String(reply.color ?? '#FB7299')
    params.show_reply = 'true'
  }

  let resp
  try {
    const r = await post(`${API}/msg/send`, {
      method: 'POST',
      cookie,
      timeout,
      referer: `https://live.bilibili.com/${roomId}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams(params).toString(),
    })
    resp = r?.json ?? r
  } catch (err) {
    // 网络层异常：连接失败、超时。这类可以重试，且不属于"被风控"
    return {
      ok: false,
      code: -996,
      kind: 'retry',
      message: `网络异常：${err?.message || err}`,
      text: prepared.text,
      truncated: prepared.truncated,
    }
  }

  const code = Number(resp?.code ?? -1)
  const message =
    code === 0
      ? '发送成功'
      : describeCode(code) || resp?.message || `未知错误（code=${code}）`

  return {
    ok: code === 0,
    code,
    kind: classify(code),
    message,
    text: prepared.text,
    truncated: prepared.truncated,
  }
}

export default sendDanmaku
