/**
 * 服务健康检查：只报「现在需要人看一眼」的状态。
 *
 * 不追求把每个指标都列出来——页面上已经有弹幕数、在线数；
 * 这里只回答一个问题：**再不管它，今晚这场会不会悄悄废掉？**
 */

export const HEALTH_QUIET_MS = 15 * 60_000;
export const HEALTH_RECONNECT_MS = 5 * 60_000;
export const HEALTH_LOG_ERR_MS = 10 * 60_000;

/** 弹幕连接完全断开超过这么久，就不是「马上会重连」了。 */
const BAD_WS = new Set(['error', 'closed']);

/**
 * @param {object} s
 * @param {string} [s.status] 弹幕连接状态：live / reconnecting / error / closed…
 * @param {string} [s.liveState] 直播间状态：live / offline / live_unknown
 * @param {number} [s.reconnectingSince] 进入 reconnecting 的时刻
 * @param {number} [s.lastEventAt] 最近收到事件的时间（墙钟）
 * @param {number} [s.lastLogErrorAt] 最近写日志失败的时间
 * @param {number} [s.now]
 * @returns {{code:string,level:'warn'|'error',text:string}[]}
 */
export function healthIssues({
  status = '',
  liveState = '',
  reconnectingSince = 0,
  lastEventAt = 0,
  lastLogErrorAt = 0,
  now = Date.now(),
} = {}) {
  const out = [];
  const past = (t, ms) => t > 0 && now - t >= ms;

  if (BAD_WS.has(status)) {
    out.push({
      code: 'ws',
      level: 'error',
      text: `弹幕连接已经断开（${status}），机器人现在听不到直播间。`,
    });
  } else if (status === 'reconnecting' && past(reconnectingSince, HEALTH_RECONNECT_MS)) {
    out.push({
      code: 'ws',
      level: 'warn',
      text: `弹幕连接重连超过 ${Math.round(HEALTH_RECONNECT_MS / 60_000)} 分钟还没好，可能被风控或网络卡住了。`,
    });
  }

  if (liveState === 'live' && past(lastEventAt, HEALTH_QUIET_MS)) {
    out.push({
      code: 'quiet',
      level: 'warn',
      text: `直播中已经 ${Math.round(HEALTH_QUIET_MS / 60_000)} 分钟没收到任何事件，可能断流或没人说话。`,
    });
  }

  if (lastLogErrorAt > 0 && now - lastLogErrorAt < HEALTH_LOG_ERR_MS) {
    out.push({
      code: 'log',
      level: 'error',
      text: '最近写日志失败过，重启后这一段的复盘数据会缺。',
    });
  }

  return out;
}

/** 给 `/api/health` 的稳定形状：页面和外部监控都读这一份。 */
export function healthView(input) {
  const issues = healthIssues(input);
  return {
    ok: issues.length === 0,
    at: Number(input?.now) || Date.now(),
    status: String(input?.status ?? ''),
    liveState: String(input?.liveState ?? ''),
    lastEventAt: Number(input?.lastEventAt) || 0,
    lastLogErrorAt: Number(input?.lastLogErrorAt) || 0,
    issues,
  };
}
