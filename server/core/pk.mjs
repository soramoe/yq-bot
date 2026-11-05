/**
 * PK 情报：把「我」和「对面」的房间摆在一起看。
 *
 * 这里只做纯函数：房间信息从 B站 来，接口由调用方注入。
 * 不碰 DOM、不碰网络，才能在没有直播的时候也测清楚。
 */

/** 对面上一次状态多久算过期（毫秒）。超过就认为数据不可信，不拿旧数据喊「开播」。 */
export const PK_STALE_MS = 180_000;

/** 默认多少秒拉一次对面房间。60 秒足够看见开播，又不会把 B站 接口打疼。 */
export const PK_POLL_SEC = 60;

/**
 * 把用户输入的房间号收拾成数字字符串。
 * 空、0、非数字都当「没配」。
 */
export function pkRoomIdOf(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{1,12}$/.test(s)) return '';
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(n);
}

/**
 * 把 `fetchRoomInfo` 的返回压成面板要的形状。
 * 只留下能公开比较的字段，不把 cookie 之类的东西带出去。
 */
export function pkRoomView(info, { rank = null } = {}) {
  if (!info) return null;
  const items = Array.isArray(rank?.items) ? rank.items.slice(0, 5) : [];
  const total = Number(rank?.total) || 0;
  return {
    roomId: String(info.roomId ?? ''),
    uid: Number(info.uid) || 0,
    title: String(info.title ?? ''),
    live: info.liveState === 'live',
    liveState: String(info.liveState ?? 'off'),
    online: Number(info.online) || 0,
    attention: Number(info.attention) || 0,
    area: String(info.areaName ?? ''),
    rankTotal: total,
    rankTop: items.map((it) => ({
      name: String(it?.name ?? ''),
      score: Number(it?.score ?? it?.gold ?? 0) || 0,
    })),
  };
}

/**
 * 两边一起看。
 * @returns {null|{bothLive:boolean,lead:'self'|'opp'|'tie',onlineGap:number,attentionGap:number,rankGap:number}}
 */
export function pkCompare(self, opp) {
  if (!self || !opp) return null;
  const rankGap = Number(self.rankTotal || 0) - Number(opp.rankTotal || 0);
  const onlineGap = Number(self.online || 0) - Number(opp.online || 0);
  const attentionGap = Number(self.attention || 0) - Number(opp.attention || 0);
  const lead = onlineGap > 0 ? 'self' : onlineGap < 0 ? 'opp' : 'tie';
  return {
    bothLive: Boolean(self.live && opp.live),
    lead,
    onlineGap,
    attentionGap,
    rankGap,
  };
}

/**
 * 对面开播 / 下播的边沿。`prev`/`next` 是 pkRoomView。
 * 第一次拉数据（prev 为 null）不喊，避免启动时把「本来就在播」当开播。
 */
export function opponentEdge(prev, next) {
  if (!prev || !next) return null;
  if (!prev.live && next.live) return 'start';
  if (prev.live && !next.live) return 'end';
  return null;
}

/** 对面数据是不是太旧了（正常轮询 60 秒，超过 3 分钟没更新就别拿它当现状）。 */
export function pkStale(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return true;
  return now - t > PK_STALE_MS;
}
