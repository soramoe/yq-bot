/**
 * 高能榜（在线榜）。
 *
 * 用途不是统计，是**发 @ 之前确认这个人此刻还在房间里**：
 * B站 的结构化 @ 只对当前在场的人生效，目标已经离开时服务端会把
 * `reply_mid` 归零，观众看到的是一条没有 @ 的弹幕（有时只剩一个空位）。
 *
 * 注意它**不是完整在线名单**：只有消费靠前的那几十个人。榜上没找到
 * 不等于人不在，所以调用方只能把"命中"当作可靠信号，不能把"没命中"
 * 当作"已离开"。
 */

import { UA } from './http.mjs';

export const ONLINE_RANK_URL =
  'https://api.live.bilibili.com/xlive/general-interface/v1/rank/getOnlineGoldRank';

/** 一页最多取多少。B站 这个接口页大小上限不大，50 足够覆盖头部 */
export const ONLINE_RANK_PAGE_SIZE = 50;

/**
 * 从接口响应里取出 uid 集合。
 * 兼容 `OnlineRankItem` / `onlineRankItem` 两种大小写（不同版本不一样）。
 *
 * @returns {{ uids: Set<string>, onlineNum: number }}
 */
export function onlineRankUids(json) {
  const data = json?.data ?? {};
  const list = Array.isArray(data.OnlineRankItem)
    ? data.OnlineRankItem
    : Array.isArray(data.onlineRankItem)
      ? data.onlineRankItem
      : [];
  const uids = new Set();
  for (const it of list) {
    const uid = String(it?.uid ?? '').trim();
    if (uid && uid !== '0') uids.add(uid);
  }
  return { uids, onlineNum: Number(data.onlineNum) || 0 };
}

/**
 * 拉一页高能榜。网络/接口错误直接抛，由调用方决定缓存多久的"未知"。
 *
 * @param {object} opts
 * @param {number|string} opts.roomId
 * @param {number|string} [opts.ruid] 当前登录账号，接口要求带
 * @param {string} [opts.cookie]
 * @param {number} [opts.page]
 * @param {number} [opts.pageSize]
 * @param {Function} [opts.fetchImpl] 自检注入
 * @param {number} [opts.timeout]
 */
export async function fetchOnlineRank({
  roomId,
  ruid = 0,
  cookie = '',
  page = 1,
  pageSize = ONLINE_RANK_PAGE_SIZE,
  fetchImpl = globalThis.fetch,
  timeout = 6000,
} = {}) {
  if (!roomId) throw new Error('缺少房间号');
  if (typeof fetchImpl !== 'function') throw new Error('no fetch');

  const url = new URL(ONLINE_RANK_URL);
  url.searchParams.set('roomId', String(roomId));
  // 这个接口要求带登录 uid；传 0 会直接 -400。
  // 连接还没拿到 uid 时，从 cookie 的 DedeUserID 兜底，别让查榜白跑。
  const fromCookie = /(?:^|;\s*)DedeUserID=(\d{1,20})/.exec(cookie || '')?.[1] || '';
  url.searchParams.set('ruid', String(ruid || fromCookie || 0));
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));

  const res = await fetchImpl(url, {
    headers: {
      'User-Agent': UA,
      Referer: `https://live.bilibili.com/${roomId}`,
      Accept: 'application/json, text/plain, */*',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(timeout),
  });
  const json = await res.json();
  if (json?.code !== 0) {
    throw new Error(`高能榜接口返回 ${json?.code ?? '未知'}：${json?.message ?? ''}`.trim());
  }
  return onlineRankUids(json);
}
