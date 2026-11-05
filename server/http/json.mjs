/**
 * 请求 / 响应的统一出入口。
 *
 * 收口在这里有一个实际好处：所有响应都带同一套安全头，
 * 不会出现"某个接口忘了加 CSP"这种漏洞。
 */

/** 只允许本地来源。前端不需要联外，CSP 收紧到最小可用集。
 *  - img-src 放 https: 是因为 B站 头像在外部域，且不加载它没有替代方案
 *  - connect-src 'self' 已覆盖同源 ws://（CSP3） */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    // Service Worker 与 manifest：不放行的话，离线壳装不上（CSP 会拦 worker 脚本）
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

export function securityHeaders() {
  return { ...SECURITY_HEADERS };
}

/**
 * 发 JSON。不做 pretty print —— 这是给程序读的。
 * @param {import('node:http').ServerResponse} res
 * @param {any} data
 * @param {number} [status]
 * @param {Record<string,string>} [extraHeaders]
 */
export function sendJson(res, data, status = 200, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(data ?? null), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * 统一错误响应。带上 code 便于前端分支，message 给人看。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
export function sendError(res, status, code, message) {
  sendJson(res, { ok: false, error: { code, message } }, status);
}

/**
 * 读 JSON 请求体。
 *
 * 限长是必要的：这个服务监听本机，但浏览器里的任意网页都能向
 * 127.0.0.1 发 POST（CSRF）。限长 + 检查 Content-Type 至少让
 * "用一个超大 body 打爆内存"这条路走不通。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit?:number}} [opts]
 * @returns {Promise<any>}
 */
export function readJson(req, { limit = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '');
    if (type && !type.includes('application/json')) {
      reject(Object.assign(new Error('Content-Type 必须是 application/json'), { status: 415 }));
      return;
    }

    const chunks = [];
    let size = 0;

    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // 不 reject 后继续收：直接断开，避免对方继续灌数据
        req.destroy();
        reject(Object.assign(new Error(`请求体超过 ${limit} 字节`), { status: 413 }));
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (size === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });

    req.on('error', reject);
  });
}

/**
 * 只允许本机访问。
 *
 * 防 DNS 重绑定：恶意域名解析到 127.0.0.1 之后，浏览器会把请求发给本机，
 * 而 Host 头是攻击者的域名。检查 Host 就能挡住这一类。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} port
 */
export function isLocalHost(req, port) {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!host) return false;
  const name = host.replace(/:\d+$/, '');
  if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1') return true;
  // 允许端口被省略的情况
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
