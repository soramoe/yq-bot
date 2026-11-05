/**
 * Cookie 的解析、合并、校验、脱敏。
 *
 * 单独一个模块的理由：Cookie 是这个项目里**唯一的高敏数据**。
 * 它出现在日志、错误信息、诊断包、前端接口里 —— 只要有一处忘了脱敏，
 * 用户的账号就泄露了。所以脱敏函数必须和解析函数放在一起，
 * 谁解析谁就记得脱敏。
 */

/**
 * 登录态必需的字段。
 * SESSDATA 是身份，bili_jct 是 CSRF 令牌（发弹幕/送礼必须有），
 * DedeUserID 是 UID（用来判断"这条弹幕是不是我自己发的"）。
 */
export const REQUIRED = ['SESSDATA', 'bili_jct', 'DedeUserID'];

/** 登录响应里值得保留的所有字段 */
export const WANTED = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

/** 解析 `a=1; b=2` 形式的 Cookie 串 */
export function parseCookie(str = '') {
  /** @type {Record<string,string>} */
  const out = {};
  for (const part of String(str).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/** 把对象拼回 Cookie 串（保持 WANTED 的顺序，方便人眼比对） */
export function stringifyCookie(jar = {}) {
  const keys = [...new Set([...WANTED, ...Object.keys(jar)])];
  return keys
    .filter((k) => jar[k])
    .map((k) => `${k}=${jar[k]}`)
    .join('; ');
}

/**
 * 从 Set-Cookie 数组里挑出需要的项。
 * @param {string[]} setCookies
 * @returns {Record<string,string>}
 */
export function cookieFromSetCookie(setCookies = []) {
  /** @type {Record<string,string>} */
  const jar = {};
  for (const raw of setCookies) {
    const pair = String(raw).split(';')[0];
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (WANTED.includes(k) && v) jar[k] = v;
  }
  return jar;
}

/** 两个 Cookie 串合并，后者覆盖前者（刷新登录态时用） */
export function mergeCookie(base = '', extra = '') {
  return stringifyCookie({ ...parseCookie(base), ...parseCookie(extra) });
}

/** 是否具备完整登录态（缺 bili_jct 时能连 WS，但发不了弹幕） */
export function isComplete(cookieOrJar = '') {
  const jar = typeof cookieOrJar === 'string' ? parseCookie(cookieOrJar) : cookieOrJar;
  return REQUIRED.every((k) => Boolean(jar[k]));
}

/** 缺哪些字段 */
export function missingFields(cookieOrJar = '') {
  const jar = typeof cookieOrJar === 'string' ? parseCookie(cookieOrJar) : cookieOrJar;
  return REQUIRED.filter((k) => !jar[k]);
}

/** 从 Cookie 里取 UID（不联网） */
export function uidFromCookie(cookieOrJar = '') {
  const jar = typeof cookieOrJar === 'string' ? parseCookie(cookieOrJar) : cookieOrJar;
  const n = Number(jar.DedeUserID);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 脱敏：只留前 4 位和后 3 位，中间全部打码。
 *
 * 这是全项目**唯一允许**把 Cookie 变成可显示文本的出口。
 * 日志、错误、诊断包一律走这里，不许直接打印原值。
 */
export function redactCookie(cookieOrJar = '') {
  const jar = typeof cookieOrJar === 'string' ? parseCookie(cookieOrJar) : cookieOrJar;
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${redactValue(String(v))}`)
    .join('; ');
}

/** 单个值脱敏。短值整体打码，避免"打了码等于没打" */
export function redactValue(v = '') {
  const s = String(v);
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(12, s.length - 7))}${s.slice(-3)}`;
}

/**
 * 判断 Cookie 字符串里是否**残留**未脱敏的敏感值。
 * 用来自检：任何日志行里出现 SESSDATA 原值都算 bug。
 */
export function looksLeaked(text = '', cookie = '') {
  const jar = parseCookie(cookie);
  const secret = jar.SESSDATA;
  if (!secret || secret.length < 16) return false;
  return String(text).includes(secret);
}
