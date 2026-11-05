/**
 * 房间与弹幕服务器信息。
 *
 * 一个容易踩的点：**用户给的是短号，API 要的是真实房间号**。
 * 短号（如 32260）和真实 roomId（如 22603245）是两套编号，
 * 直接拿短号去连弹幕服务器，会连上一个"存在但没内容"的房间 ——
 * 不报错，只是什么都收不到。
 *
 * 所以这里把 resolveRoomId 单独暴露出来，并且强制所有下游都用它转换过的真实号。
 */

import { biliJson, assertOk, withQuery } from './http.mjs';
import { signedGet } from './wbi.mjs';
import { mergeCookie as mergeCookieStr } from './cookie.mjs';

const API = 'https://api.live.bilibili.com';

/** 直播状态码 → 语义。0 未开播、1 直播中、2 轮播（视为未开播） */
export const LIVE_STATE = {
  OFF: 'off',
  LIVE: 'live',
  ROUND: 'round',
};

export function liveStateFromCode(code) {
  const n = Number(code);
  if (n === 1) return LIVE_STATE.LIVE;
  if (n === 2) return LIVE_STATE.ROUND;
  return LIVE_STATE.OFF;
}

/**
 * 短号 → 真实房间号。
 * @returns {Promise<{roomId:number, shortId:number, uid:number, liveStatus:number, liveState:string, liveTime:number}>}
 */
export async function resolveRoomId(input) {
  const url = withQuery(`${API}/room/v1/Room/room_init`, { id: input });
  const data = assertOk(await biliJson(url, { referer: 'https://live.bilibili.com/' }), url);

  return {
    roomId: Number(data.room_id),
    shortId: Number(data.short_id),
    uid: Number(data.uid),
    liveStatus: Number(data.live_status),
    liveState: liveStateFromCode(data.live_status),
    liveTime: Number(data.live_time) || 0,
  };
}

/**
 * 房间详细信息（标题、分区、封面、在线人数…）。
 * @param {number|string} roomId 真实房间号
 */
export async function fetchRoomInfo(roomId, cookie = '') {
  const url = withQuery(`${API}/room/v1/Room/get_info`, { room_id: roomId });
  const data = assertOk(
    await biliJson(url, { cookie, referer: `https://live.bilibili.com/${roomId}` }),
    url,
  );

  return {
    roomId: Number(data.room_id),
    shortId: Number(data.short_id),
    uid: Number(data.uid),
    title: String(data.title || ''),
    cover: String(data.user_cover || data.keyframe || ''),
    areaName: String(data.area_name || ''),
    parentAreaName: String(data.parent_area_name || ''),
    liveStatus: Number(data.live_status),
    liveState: liveStateFromCode(data.live_status),
    online: Number(data.online) || 0,
    attention: Number(data.attention) || 0,
    liveTime: Number(data.live_time) || 0,
  };
}

/**
 * 取弹幕服务器地址和连接 token。
 *
 * 这个接口需要 WBI 签名，且**必须带登录 Cookie**：
 * 不带 Cookie 也能连上，但 B站 会把连接当游客，约 5 分钟后
 * 把消息里的用户名打码成 `X***`、uid 归零 —— 表现为"欢迎语里全是 X***"。
 *
 * @returns {Promise<{token:string, hosts:{host:string, wssPort:number, wsPort:number}[]}>}
 */
export async function fetchDanmuInfo(roomId, cookie = '', buvid = '') {
  const url = `${API}/xlive/web-room/v1/index/getDanmuInfo`;
  const json = await signedGet(
    url,
    { id: roomId, type: 0 },
    { cookie: mergeCookieStr(cookie, buvid ? `buvid3=${buvid}` : ''), referer: `https://live.bilibili.com/${roomId}` },
  );
  const data = assertOk(json, url);

  const hosts = (data.host_list || [])
    .filter((h) => h && h.host && h.wss_port)
    .map((h) => ({ host: h.host, wssPort: Number(h.wss_port), wsPort: Number(h.ws_port) }));

  // 接口偶尔返回空列表。此时用官方默认节点兜底，
  // 总比"连不上任何服务器"要好 —— 默认节点在大部分地区可用。
  if (hosts.length === 0) {
    hosts.push({ host: 'broadcastlv.chat.bilibili.com', wssPort: 443, wsPort: 2243 });
  }

  return { token: String(data.token || ''), hosts };
}

/**
 * 取一个设备指纹（buvid3）。
 *
 * 没有它，B站 会把连接质量降级（部分消息不下发）。
 * 接口拿不到时本地随机生成一个格式合法的 —— 比空着强，且能被服务端接受。
 */
export async function fetchBuvid() {
  try {
    const json = await biliJson('https://api.bilibili.com/x/frontend/finger/spi', {
      referer: 'https://www.bilibili.com/',
    });
    if (json?.code === 0 && json?.data?.b_3) return String(json.data.b_3);
  } catch {
    // 忽略，走本地生成
  }
  return randomBuvid();
}

function randomBuvid() {
  const hex = (n) =>
    Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}infoc`;
}
