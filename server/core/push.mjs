/**
 * 手机推送。
 *
 * 和 webhook 分开的理由：webhook 是"发到群里"，推送是"发到手机"。
 * 两者的目标地址形状、失败判定、甚至用户配置的东西都不一样；
 * 混在一起会让 notify.mjs 变成一个大杂烩。
 *
 * 支持四家：
 * - Bark（iOS，免费）：target 是 key，也接受完整的 `https://api.day.app/<key>`。
 * - ntfy（全平台，免费）：target 是 topic，也接受完整地址（自建服务）。
 * - Server酱（微信）：target 是 SendKey。
 * - Telegram：target 是 `bot_token|chat_id`（token 里本身有冒号，所以用竖线分隔）。
 *
 * 三家都可能 HTTP 200 + body 里报错（key 失效、额度用光），所以不能只看
 * `res.ok`；HTTP 层的错误和平台错误都要落到返回值里。
 */

/** Server酱 的 SendKey 前缀；只是提示，不做强校验（老 key 可能不带）。 */
const SERVERCHAN_KEY_HINT = 'SCT';

export const PUSH_PROVIDERS = Object.freeze(['bark', 'ntfy', 'serverchan', 'telegram']);

export const MAX_PUSH_TARGET_LEN = 300;

/**
 * 配置校验。返回空串表示没问题。
 *
 * @param {string} provider
 * @param {string} target
 * @returns {string}
 */
export function pushTargetProblem(provider, target) {
  if (!PUSH_PROVIDERS.includes(provider)) return '不认识的推送渠道';
  const t = String(target ?? '').trim();
  if (!t) return '推送目标不能为空';
  if (t.length > MAX_PUSH_TARGET_LEN) return `推送目标太长了（最多 ${MAX_PUSH_TARGET_LEN} 字符）`;
  if (/\s/.test(t)) return '推送目标不能有空格';

  const looksUrl = /^https?:\/\//i.test(t);
  if (provider === 'telegram') {
    if (looksUrl) return 'Telegram 要填 bot_token|chat_id，不是网址';
    const parts = t.split('|');
    if (parts.length !== 2) return 'Telegram 要写成 bot_token|chat_id（中间用竖线隔开）';
    const [token, chatId] = parts;
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      return 'Telegram bot token 看起来不对（形如 123456:ABC…）';
    }
    if (!/^-?\d{5,}$/.test(chatId)) {
      return 'Telegram chat_id 看起来不对（一般是数字，频道 / 群以 -100 开头）';
    }
    return '';
  }
  if (!looksUrl && t.includes('://')) return '推送目标要是 http:// 或 https:// 开头的地址';
  if (provider === 'serverchan') {
    const key = t.replace(/^SCT/i, '');
    if (looksUrl) return 'Server酱 的 SendKey 不是网址，只填 key';
    if (!serverchanKeyLooksOk(key)) return 'Server酱 的 SendKey 看起来不对（一般以 SCT 开头）';
  }
  return '';
}

/**
 * 把 id 归一成"能发出去的目标"。空串 = 关掉。
 *
 * @param {string} provider
 * @param {string} target
 * @returns {{provider:string,target:string}}
 */
export function normalizePushSettings(provider, target) {
  const p = String(provider ?? '').trim();
  const t = String(target ?? '').trim();
  if (!p && !t) return { provider: '', target: '' };
  if (!PUSH_PROVIDERS.includes(p)) return { provider: p, target: t };
  return { provider: p, target: t };
}

/** Bark 的 key 是 base62 风格的短串；完整 URL 也接受。 */
function barkBase(target) {
  const t = target.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(t) ? t : `https://api.day.app/${encodeURIComponent(t)}`;
}

/** ntfy 的 topic 放进路径；完整 URL 原样用。 */
function ntfyBase(target) {
  const t = target.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(t) ? t : `https://ntfy.sh/${encodeURIComponent(t)}`;
}

function serverchanKeyLooksOk(key) {
  if (!key) return false;
  if (key.length < 8 || key.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(key);
}

/**
 * 拼一次推送请求。
 *
 * 不直接 fetch：纯函数才能把三家形状钉死在自检里。
 *
 * @param {string} provider
 * @param {string} target
 * @param {string} text
 * @param {{title?:string}} [opts]
 * @returns {{url:string, init:object}|null}
 */
export function buildPushRequest(provider, target, text, { title = '渔月崽三代' } = {}) {
  if (pushTargetProblem(provider, target)) return null;
  const body = String(text ?? '');
  const t = String(target ?? '').trim();

  if (provider === 'bark') {
    const base = barkBase(t);
    // 用 URL 拼，不手写 ?：完整地址可能已经带了 ?auth=… 之类的参数
    const u = new URL(base);
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/${encodeURIComponent(body)}`;
    u.searchParams.set('title', title);
    u.searchParams.set('group', '渔月崽三代');
    u.searchParams.set('level', 'active');
    return { url: u.toString(), init: { method: 'GET' } };
  }

  if (provider === 'ntfy') {
    const base = ntfyBase(t);
    const u = new URL(base);
    u.searchParams.set('title', title);
    u.searchParams.set('tags', 'fish');
    return {
      url: u.toString(),
      init: {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body,
      },
    };
  }

  if (provider === 'telegram') {
    const [token, chatId] = t.split('|');
    return {
      url: `https://api.telegram.org/bot${token}/sendMessage`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
      },
    };
  }

  // serverchan
  const key = t.replace(/^SCT/i, '');
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams({ title, desp: body }).toString(),
  };
  return { url: `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, init };
}

/**
 * 从 200 的响应体里找平台错误。
 *
 * @param {string} provider
 * @param {object|null} body
 * @returns {string} 空串 = 成功
 */
export function pushError(provider, body) {
  if (!body || typeof body !== 'object') return '';

  if (provider === 'bark') {
    if (body.code !== undefined && body.code !== null && Number(body.code) !== 200) {
      return `code ${body.code}: ${body.message ?? ''}`.trim();
    }
    return '';
  }

  if (provider === 'ntfy') {
    if (body.error) return `error: ${body.error}`;
    return '';
  }

  if (provider === 'serverchan') {
    if (body.code !== undefined && body.code !== null && Number(body.code) !== 0) {
      return `code ${body.code}: ${body.message ?? body.info ?? ''}`.trim();
    }
    return '';
  }

  if (provider === 'telegram') {
    if (body.ok === true) return '';
    if (body.ok === false) {
      return `Telegram 返回失败：${body.description ?? `code ${body.error_code ?? '?'}`}`;
    }
    return '';
  }

  return '';
}

/**
 * 发一次推送。永不抛出。
 *
 * @param {string} provider
 * @param {string} target
 * @param {string} text
 * @param {{fetchImpl?:Function, timeoutMs?:number, title?:string}} [opts]
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
export async function sendPush(provider, target, text, { fetchImpl, timeoutMs = 8000, title } = {}) {
  const problem = pushTargetProblem(provider, target);
  if (problem) return { ok: false, error: problem };

  const req = buildPushRequest(provider, target, text, title ? { title } : {});
  if (!req) return { ok: false, error: '推送配置不完整' };

  const fetcher = fetchImpl ?? globalThis.fetch;
  if (typeof fetcher !== 'function') return { ok: false, error: 'no fetch' };

  try {
    const res = await fetcher(req.url, { ...req.init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res?.ok) return { ok: false, status: res?.status };

    let body = null;
    if (typeof res.json === 'function') {
      body = await res.json().catch(() => null);
    }
    const bad = pushError(provider, body);
    if (bad) return { ok: false, status: res.status, error: bad };
    return { ok: true, status: res?.status };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
