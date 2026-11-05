/**
 * B站扫码登录。
 *
 * 流程：申请二维码 → 轮询状态 → 成功后拿到 Cookie。
 *
 * 三个容易踩的点，这里都处理了：
 *
 * 1. **凭证有两个来源**。老接口把 Cookie 放在 Set-Cookie 响应头，
 *    新版登录成功时还会在 data.url 的查询串里带一份。
 *    只认其中一个，会出现"登录成功但没拿到凭证"。
 *
 * 2. **轮询必须能停**。二维码有效期约 180 秒，轮询要跟着停，
 *    否则用户关掉页面后这边还在每 2 秒打一次 B站接口。
 *
 * 3. **不能把 Cookie 回给前端**。前端只需要知道"谁登录了"。
 */

import { biliRaw, BiliError } from './http.mjs';
import { cookieFromSetCookie, stringifyCookie, isComplete, WANTED } from './cookie.mjs';

const PASSPORT = 'https://passport.bilibili.com';
const REFERER = 'https://www.bilibili.com/';
const QR_ORIGIN = { Origin: 'https://www.bilibili.com' };

/** B站登录状态码 */
export const QR_STATUS = {
  SUCCESS: 0,
  EXPIRED: 86038,
  SCANNED: 86090,
  WAITING: 86101,
};

/**
 * 申请一个登录二维码。
 * @returns {Promise<{url:string, key:string}>} url 用来画二维码，key 用来轮询
 */
export async function requestQrcode() {
  const url = `${PASSPORT}/x/passport-login/web/qrcode/generate`;
  const { json } = await biliRaw(url, { referer: REFERER, headers: QR_ORIGIN });

  if (json?.code !== 0 || !json?.data?.url || !json?.data?.qrcode_key) {
    // 这里要把 B站 的原话带出来：风控时会返回 -412 之类，
    // 如果只报"获取失败"，用户和我们都不知道该等还是该换网络
    throw new BiliError(
      json?.message || '获取登录二维码失败',
      json?.code ?? -1,
      url,
    );
  }

  return { url: json.data.url, key: json.data.qrcode_key };
}

/**
 * 轮询扫码状态。
 *
 * @param {string} key
 * @returns {Promise<{status:'waiting'|'scanned'|'confirmed'|'expired'|'error',
 *                    message:string, cookie?:string, raw?:any}>}
 */
export async function pollQrcode(key) {
  if (!key) return { status: 'error', message: '缺少 qrcode_key' };

  const url = `${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`;
  const { json, setCookies } = await biliRaw(url, { referer: REFERER, headers: QR_ORIGIN });

  const code = json?.data?.code;

  if (code === QR_STATUS.SUCCESS) {
    const jar = collectCredentials(setCookies, json?.data?.url);
    const cookie = stringifyCookie(jar);

    if (!isComplete(cookie)) {
      return {
        status: 'error',
        message: '登录成功但凭证不完整，请改用「粘贴 Cookie」方式',
        raw: { got: Object.keys(jar) },
      };
    }
    return { status: 'confirmed', message: json.data.message || '登录成功', cookie };
  }

  if (code === QR_STATUS.EXPIRED) {
    return { status: 'expired', message: '二维码已过期，请刷新' };
  }
  if (code === QR_STATUS.SCANNED) {
    return { status: 'scanned', message: '已扫码，请在手机上点确认' };
  }
  if (code === QR_STATUS.WAITING) {
    return { status: 'waiting', message: '等待扫码' };
  }

  return {
    status: 'error',
    message: json?.data?.message || json?.message || `未知状态（code=${code}）`,
  };
}

/**
 * 从两处来源收集凭证：Set-Cookie 头 + data.url 的查询串。
 * @param {string[]} setCookies
 * @param {string} [redirectUrl]
 */
export function collectCredentials(setCookies = [], redirectUrl = '') {
  const jar = cookieFromSetCookie(setCookies);

  // 逐字段补齐而不是"有 SESSDATA 就整个不用"：
  // 真实情况可能是头部带了 SESSDATA 却漏了 bili_jct，
  // 少了这个字段能连直播间但发不出弹幕 —— 那是更难查的半残状态。
  if (redirectUrl) {
    try {
      const u = new URL(redirectUrl);
      for (const k of WANTED) {
        if (jar[k]) continue; // 响应头优先
        const v = u.searchParams.get(k);
        if (v) jar[k] = v;
      }
    } catch {
      // 链接格式变了就忽略，下面 isComplete 会报"不完整"
    }
  }

  return jar;
}

/**
 * 校验 Cookie 是否还有效，并取回账号信息。
 *
 * 注意：这个接口返回的 face 头像是 http 链接，页面上要换成 https，
 * 否则浏览器会因混合内容拦掉。
 *
 * @returns {Promise<{valid:boolean, uid?:number, uname?:string, face?:string, reason?:string}>}
 */
export async function verifyCookie(cookie) {
  if (!cookie) return { valid: false, reason: '没有 Cookie' };

  const url = 'https://api.bilibili.com/x/web-interface/nav';
  try {
    const { json } = await biliRaw(url, {
      cookie,
      referer: 'https://live.bilibili.com/',
    });

    if (json?.code === 0 && json?.data?.isLogin) {
      return {
        valid: true,
        uid: json.data.mid,
        uname: json.data.uname,
        face: toHttps(json.data.face),
        level: json.data.level_info?.current_level ?? 0,
      };
    }
    return {
      valid: false,
      reason: json?.message || (json?.data?.isLogin === false ? '登录态已失效' : '校验失败'),
    };
  } catch (err) {
    return { valid: false, reason: err?.message || '网络错误' };
  }
}

function toHttps(url = '') {
  return String(url).replace(/^http:\/\//, 'https://');
}
