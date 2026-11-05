/**
 * 请求封装。
 *
 * 全部走这一个出口，好处是错误形态统一：任何调用点拿到的失败
 * 都是 { message, status }，不用各自判断 res.ok / 解析失败 / 网络断。
 */

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 访问口令存在 sessionStorage，不是 localStorage。
 *
 * 理由：localStorage 会一直留着，而这台机器可能被别人用；
 * sessionStorage 关掉标签页就没了，符合"这次操作是你授权的"这个语义。
 * 代价是刷新页面要重新输一次 —— 口令默认关闭，用到它的人本来就不介意。
 */
const TOKEN_KEY = 'yuyue.access';

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    // 隐私模式 / 被禁用时 sessionStorage 会抛，当成"没有口令"
    return '';
  }
}

/** @param {string} value */
export function setToken(value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 存不进去只影响"下次还要再输一次"，不影响本次操作 */
  }
}

export const hasToken = () => Boolean(readToken());

/** 从 Content-Disposition 里取文件名。没有就返回空串 */
export function filenameFrom(disposition) {
  const m = /filename="?([^";]+)"?/i.exec(String(disposition ?? ''));
  return m ? m[1].trim() : '';
}

async function request(path, { method = 'GET', body, timeout = 15000 } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  // 自定义头同时干两件事：带上身份，以及让跨站请求必须走预检（发不出去）
  const token = readToken();
  if (token) headers['X-Access-Token'] = token;

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      // 本地服务，超时给短一点：卡住说明后端出问题了，早报错比干等好。
      // 但战报和回放要读全量日志、还要加载一套独立插件，15 秒不够 ——
      // 它们单独传更长的 timeout，而不是把全局超时放宽。
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new ApiError('请求超时', 0, 'timeout');
    throw new ApiError('连不上服务，可能已经退出', 0, 'network');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应（比如上游返回了 HTML 错误页）
  }

  if (!res.ok || data?.ok === false) {
    const msg = data?.error?.message || `请求失败（HTTP ${res.status}）`;
    throw new ApiError(msg, res.status, data?.error?.code);
  }

  return data;
}

/**
 * 取一个**二进制附件**（诊断包、导出的复盘页）。
 *
 * 和 `request()` 分开而不是加个 flag：这一条路径的失败形态完全不同 ——
 * 成功时响应体不是 JSON，失败时才是。混进 `request()` 里会让每个调用点
 * 都要判断"我拿到的是数据还是文件"，而那正是最容易写错的地方。
 *
 * 失败时先读一次 JSON 把服务端的原话捞出来：直接 `res.blob()` 再 throw，
 * 用户看到的会是"请求失败（HTTP 429）"，而真正的原因（"战报还在算"）被丢掉了。
 */
async function requestBlob(path, { method = 'GET', body, timeout = 30000, fallbackName = 'download.bin' } = {}) {
  const headers = {};
  const token = readToken();
  if (token) headers['X-Access-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new ApiError('请求超时', 0, 'timeout');
    throw new ApiError('连不上服务，可能已经退出', 0, 'network');
  }

  if (!res.ok) {
    let msg = `请求失败（HTTP ${res.status}）`;
    try {
      const d = await res.json();
      msg = d?.error?.message || msg;
    } catch {
      /* 不是 JSON 就用默认文案 */
    }
    throw new ApiError(msg, res.status);
  }

  const blob = await res.blob();
  return {
    blob,
    filename: filenameFrom(res.headers.get('content-disposition')) || fallbackName,
    size: blob.size,
  };
}

export const api = {
  status: () => request('/api/status'),
  events: ({ after = 0, limit = 200 } = {}) =>
    request(`/api/events?after=${after}&limit=${limit}`),
  plugins: () => request('/api/plugins'),
  reconcile: () => request('/api/reconcile'),
  /** 战报：要读全量日志重算，超时放宽到 60 秒 */
  reports: ({ days = 0 } = {}) => request(`/api/reports?days=${days}`, { timeout: 60000 }),
  /** 时间轴：同样要读全量日志，只重放一个窗口 */
  timeline: ({ from, to, step = 60 }) =>
    request(`/api/timeline?from=${from}&to=${to}&step=${step}`, { timeout: 60000 }),
  /** 沙盒回放：加载一套独立插件 + 跑完全部事件，给 2 分钟 */
  sandbox: ({ day = '', maxSaid = 300 } = {}) =>
    request('/api/sandbox', { method: 'POST', body: { day, maxSaid }, timeout: 120000 }),
  setDryRun: (dryRun) => request('/api/dryrun', { method: 'POST', body: { dryRun } }),
  setRoom: (roomId) => request('/api/room', { method: 'POST', body: { roomId } }),
  /** 同时在跑的房间。切换只是换视图，不会停掉别的房间 */
  rooms: () => request('/api/rooms'),
  closeRoom: (roomId) => request('/api/rooms/close', { method: 'POST', body: { roomId } }),
  notify: () => request('/api/notify'),
  saveNotify: (webhook, report) =>
    request('/api/notify', {
      method: 'POST',
      body: report === undefined ? { webhook } : { webhook, report },
    }),
  /** 付费用户档案：同样要读全量日志，超时放宽到 60 秒 */
  patrons: ({ days = 30, limit = 30 } = {}) =>
    request(`/api/patrons?days=${days}&limit=${limit}`, { timeout: 60000 }),
  saveBigSpend: (battery, returnBattery) =>
    request('/api/patrons/alert', {
      method: 'POST',
      body: returnBattery === undefined ? { battery } : { battery, returnBattery },
    }),
  /** SC 待读清单：同样读全量日志，超时放宽到 60 秒 */
  scQueue: ({ days = 30 } = {}) => request(`/api/sc?days=${days}`, { timeout: 60000 }),
  markScRead: (ids) => request('/api/sc/read', { method: 'POST', body: { ids } }),
  /** 本场礼物目标：电池为单位，0 = 关闭 */
  goal: () => request('/api/goal'),
  saveGoal: ({ goalBattery, announce }) =>
    request('/api/goal', { method: 'POST', body: { goalBattery, announce } }),
  savePluginConfig: (id, patch) =>
    request(`/api/plugins/${encodeURIComponent(id)}/config`, { method: 'POST', body: patch }),
  resetPluginConfig: (id) =>
    request(`/api/plugins/${encodeURIComponent(id)}/reset`, { method: 'POST', body: {} }),
  setPluginEnabled: (id, enabled) =>
    request(`/api/plugins/${encodeURIComponent(id)}/enabled`, { method: 'POST', body: { enabled } }),

  /* ── 账号凭证 ── */
  authStatus: () => request('/api/auth'),
  /** 会联网，给 25 秒（B站 接口抖的时候 15 秒不够） */
  checkAuth: () => request('/api/auth/check', { method: 'POST', body: {}, timeout: 25000 }),
  /** 会重建运行体（断流重连），给 25 秒 */
  logout: () => request('/api/auth/logout', { method: 'POST', body: {}, timeout: 25000 }),

  /* ── 访问口令 ── */
  accessStatus: () => request('/api/access'),
  /** 成功后调用方要把这个口令记下来（setToken），否则下一次写操作还是 401 */
  unlock: (token) => request('/api/access/unlock', { method: 'POST', body: { token } }),
  setPassword: (password) => request('/api/access/password', { method: 'POST', body: { password } }),
  disablePassword: () => request('/api/access/disable', { method: 'POST', body: {} }),

  /* ── 更新 ── */
  setUpdateUrl: (url) => request('/api/update/url', { method: 'POST', body: { url } }),
  checkUpdate: ({ force = false } = {}) =>
    request('/api/update/check', { method: 'POST', body: { force }, timeout: 30000 }),

  /**
   * 诊断包。
   *
   * 返回 `{ blob, filename, size }`，**不在这里触发下载** ——
   * 触发下载要用 document/URL.createObjectURL，那是 UI 的事，
   * 而这个文件是纯逻辑，自检能直接调（假 DOM 里没有 createObjectURL）。
   */
  diagnostic: () => requestBlob('/api/diagnostic', { method: 'POST', body: {}, fallbackName: 'yuyue3-diag.zip' }),

  /**
   * 导出复盘页（自包含 HTML）。
   *
   * 服务端要读全量日志重算一遍，和战报是同一份计算 —— 所以超时给 60 秒。
   * 同样返回 blob，下载交给 UI（理由同上）。
   */
  exportReport: ({ days = 0 } = {}) =>
    requestBlob(`/api/reports/export?days=${days}`, { timeout: 60000, fallbackName: 'yuyue3-report.html' }),
};

export { ApiError };
