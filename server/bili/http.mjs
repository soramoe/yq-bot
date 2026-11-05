/**
 * B站 HTTP 封装。
 *
 * 只用 Node 内置 fetch，零依赖。
 *
 * 两条原则：
 * 1. 超时必须有 —— 没有超时的请求会让登录页永远卡在「等待扫码」
 * 2. 非 JSON 响应不抛异常，转成 code=-998 —— B站在风控时会返回 HTML 页面，
 *    直接 throw 会把「被风控」误报成「网络错误」，排查方向全错。
 */

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT = 10_000;

/** B站接口错误。保留 code 与 url，便于在日志里定位是哪个接口、返回什么码。 */
export class BiliError extends Error {
  constructor(message, code, url) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.url = url;
  }
}

/**
 * 发一个请求，返回解析后的 JSON（B站接口几乎都返回 JSON）。
 * @param {string} url
 * @param {{cookie?:string, method?:string, headers?:Record<string,string>,
 *          body?:any, timeout?:number, referer?:string}} [opts]
 */
export async function biliJson(url, opts = {}) {
  const { json } = await biliRaw(url, opts);
  return json;
}

/**
 * 发一个请求，额外返回原始响应头。
 * 扫码登录必须走这个：凭证在 Set-Cookie 里，普通 JSON 解析拿不到。
 *
 * @returns {Promise<{json:any, status:number, setCookies:string[], headers:Headers}>}
 */
export async function biliRaw(url, opts = {}) {
  const {
    cookie = '',
    method = 'GET',
    headers = {},
    body,
    timeout = DEFAULT_TIMEOUT,
    referer = 'https://www.bilibili.com/',
    redirect = 'follow',
  } = opts;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body,
      redirect,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    // AbortSignal.timeout 抛的是 TimeoutError，不是 AbortError，两个都要认
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new BiliError(
      timedOut ? `请求超时（${timeout}ms）：${url}` : `网络错误：${err?.message || err}`,
      timedOut ? 'ETIMEDOUT' : 'ENETWORK',
      url,
    );
  }

  const text = await res.text();

  let json;
  if (!text) {
    json = { code: -1, message: '响应为空' };
  } else {
    try {
      json = JSON.parse(text);
    } catch {
      // 风控页、验证页都是 HTML，这里要保留前 200 字，否则现场就丢了
      json = { code: -998, message: `非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 200)}` };
    }
  }

  // getSetCookie 是 Node 20+ 的 Headers 方法；不存在时回退到手工切分
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : splitSetCookieHeader(res.headers.get('set-cookie'));

  return { json, status: res.status, setCookies, headers: res.headers };
}

/** 老环境的兼容路径：把合并后的 Set-Cookie 头切回数组 */
function splitSetCookieHeader(raw) {
  if (!raw) return [];
  // 逗号分隔，但 Expires=Wed, 21 Oct ... 里的逗号不能切
  return String(raw)
    .split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** B站业务码断言：code !== 0 一律抛错，避免把错误响应当数据用 */
export function assertOk(json, url) {
  if (!json || json.code !== 0) {
    throw new BiliError(json?.message || `接口返回异常 code=${json?.code}`, json?.code ?? -1, url);
  }
  return json.data;
}

/** 给 GET 请求拼查询串（跳过 undefined / null） */
export function withQuery(url, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${url}${url.includes('?') ? '&' : '?'}${s}` : url;
}
