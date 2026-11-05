/**
 * WBI 签名。
 *
 * B站 从 2023 年起给一部分 web 接口加了签名校验（`w_rid` + `wts`），
 * 缺了它 `getDanmuInfo` 会直接返回 -352。
 *
 * 算法是公开的：取 nav 接口返回的两个密钥，按固定的 64 位置换表混成一个
 * 32 字符的 key，然后 md5(参数字符串 + key) 就是签名。
 *
 * 这里额外做了两件二代没做的事：
 *   1. 并发请求共用一次密钥刷新（避免同时发 N 个 nav 请求）
 *   2. 签名失败时自动强刷一次密钥再重试（密钥会轮换，缓存 6 小时理论上够，
 *      但"刚好在轮换的那一刻"就会失败一次）
 */

import { createHash } from 'node:crypto';
import { biliJson } from './http.mjs';

/** 官方前端里的混淆表，64 个位置，前 32 位就是最终的 mixin key */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const KEY_TTL = 6 * 60 * 60 * 1000;
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';

/** @type {{mixinKey:string, fetchedAt:number}} */
let cache = { mixinKey: '', fetchedAt: 0 };
/** 正在进行中的刷新，用来合并并发请求 */
let pending = null;

/** 从 https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png 里取出文件名 */
function extractKey(url) {
  const file = String(url).split('/').pop() || '';
  return file.split('.')[0];
}

function mixin(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

/** 强制刷新密钥 */
export async function refreshKeys() {
  if (pending) return pending;

  pending = (async () => {
    const json = await biliJson(NAV_URL, { referer: 'https://www.bilibili.com/' });
    const img = json?.data?.wbi_img;
    if (!img?.img_url || !img?.sub_url) {
      throw new Error('未能获取 WBI 密钥（nav 接口没返回 wbi_img）');
    }
    cache = {
      mixinKey: mixin(extractKey(img.img_url), extractKey(img.sub_url)),
      fetchedAt: Date.now(),
    };
    return cache;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

async function getKeys(force = false) {
  const fresh = cache.mixinKey && Date.now() - cache.fetchedAt < KEY_TTL;
  if (!force && fresh) return cache;
  return refreshKeys();
}

/**
 * 给参数签名，返回可直接拼进 URL 的查询串。
 * @param {Record<string, string|number>} params
 * @param {{force?:boolean}} [opts]
 */
export async function signParams(params, opts = {}) {
  const { mixinKey } = await getKeys(opts.force);

  const withTs = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(withTs)
    .sort()
    .map((k) => {
      // B站 的怪癖：值里的 !'()* 必须先删掉再编码
      const v = String(withTs[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');

  const wRid = createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/**
 * 带签名的请求：签名失败（-352/-403）时强刷密钥重试一次。
 * @param {string} url 不含查询串的地址
 * @param {Record<string, string|number>} params
 * @param {{cookie?:string, referer?:string}} [opts]
 */
export async function signedGet(url, params, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const query = await signParams(params, { force: attempt > 0 });
    const json = await biliJson(`${url}?${query}`, {
      cookie: opts.cookie,
      referer: opts.referer,
    });

    const retryable = json?.code === -352 || json?.code === -403;
    if (retryable && attempt === 0) continue;
    return json;
  }
  // 循环里必然 return，这里只是为了类型完整
  throw new Error('签名请求失败');
}

/** 清空密钥缓存（测试用） */
export function resetKeysCache() {
  cache = { mixinKey: '', fetchedAt: 0 };
  pending = null;
}
