/**
 * HTTP 服务的装配：一处决定请求怎么走。
 *
 * 处理顺序固定为：本机校验 → API → 静态 → 404。
 * API 在前，是因为将来可能出现和静态目录同名的接口路径，
 * 接口优先比文件优先更符合预期（也避免有人靠放个同名文件劫持接口）。
 */

import { createServer } from 'node:http';
import { extname } from 'node:path';

import { buildRoutes } from './api.mjs';
import { attachWebSocket } from './ws.mjs';
import { serveStatic } from './static.mjs';
import { isLocalHost, securityHeaders, sendError, sendJson } from './json.mjs';
import { guardWrite } from './write-guard.mjs';
import { AuthStore } from '../auth.mjs';
import { createLoginHandler } from '../login-server.mjs';

/**
 * @param {object} opts
 * @param {import('../app.mjs').App} opts.app
 * @param {string} opts.webRoot 静态文件根目录
 * @param {number} opts.port
 * @param {object} [opts.log]
 */
export function createHttpServer({ app, webRoot, port, log = console }) {
  const router = buildRoutes(app);

  /**
   * 登录页挂在主服务下（`/login`），不再是单独的 8898 进程。
   * 扫码成功后的回调会重建房间连接 —— 换号不用重启服务。
   */
  const loginHandler = createLoginHandler({
    auth: new AuthStore({ dataDir: app.dataDir }).load(),
    host: '127.0.0.1',
    port,
    base: '/login',
    log: (msg) => log.info?.(msg),
    onLogin: (account) => app.rebindAccount(account),
  });

  const server = createServer(async (req, res) => {
    const started = process.hrtime.bigint();

    try {
      // 1) 只服务本机。这条必须在最前面：解析 URL 之前就拒绝掉最省事
      if (!isLocalHost(req, port)) {
        sendError(res, 403, 'forbidden_host', '只允许从本机访问');
        return;
      }

      let url;
      try {
        url = new URL(req.url, `http://${req.headers.host}`);
      } catch {
        sendError(res, 400, 'bad_url', '无法解析请求地址');
        return;
      }

      // 2) 登录页与登录接口（本机扫码，不走写闸门：它自己的 Host 校验更窄）
      if (url.pathname === '/login' || url.pathname.startsWith('/login/')) {
        await loginHandler(req, res);
        accessLog(log, req, res, url, started);
        return;
      }

      // 3) 接口
      const hit = router.match(req.method, url.pathname);
      if (hit?.handler) {
        // 写操作的统一闸门：Origin + 访问口令。
        // 放在调用 handler **之前**，且只有这里知道 method ——
        // 新增写接口自动被保护，不会有人忘记加。
        const denied = guardWrite(req, { app, port, pathname: url.pathname });
        if (denied) {
          sendError(res, denied.status, denied.code, denied.message);
          accessLog(log, req, res, url, started);
          return;
        }
        await hit.handler({ req, res, url, params: hit.params, app });
        accessLog(log, req, res, url, started);
        return;
      }
      if (hit?.allow) {
        res.setHeader('Allow', hit.allow.join(', '));
        if (req.method === 'OPTIONS') {
          // 同源页面不会发预检，但给了也无害
          res.writeHead(204, { ...securityHeaders(), Allow: hit.allow.join(', ') });
          res.end();
          return;
        }
        sendError(res, 405, 'method_not_allowed', `该路径不支持 ${req.method}`);
        return;
      }

      // 3) 静态文件
      if (req.method === 'GET' || req.method === 'HEAD') {
        const served = await serveStatic(req, res, webRoot, url.pathname, securityHeaders());
        if (served) {
          accessLog(log, req, res, url, started);
          return;
        }
      }

      // 4) 兜底
      if (url.pathname.startsWith('/api/')) {
        sendError(res, 404, 'no_route', `没有这个接口：${url.pathname}`);
      } else if (!extname(url.pathname)) {
        // 只有"看上去像一个页面"的路径才回退到首页。
        // 带扩展名的请求（比如写错的 /views/live.js）必须 404 ——
        // 否则浏览器拿到的是 HTML，报的是"模块 MIME 类型不对"，
        // 而真正的原因（文件不存在）完全看不出来。
        const served = await serveStatic(req, res, webRoot, '/index.html', securityHeaders());
        if (!served) sendError(res, 404, 'not_found', '页面不存在');
      } else {
        sendError(res, 404, 'not_found', `找不到 ${url.pathname}`);
      }
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (status >= 500) {
        log.error(`请求出错 ${req.method} ${req.url}：${err?.stack ?? err}`);
      }
      if (!res.headersSent) {
        /**
         * 带上业务错误码（`last_room` / `too_many_rooms` / `bad_room` …）。
         *
         * 以前这里写死成 `bad_request`，于是 App 层特意分的 code 全被抹平：
         * 页面只能靠人话分辨"这是最后一个房间不能关"和"参数没传"，
         * 而人话是会改的。有 code 才能稳定分支。
         */
        const code = typeof err?.code === 'string' && err.code
          ? err.code
          : status >= 500
            ? 'internal_error'
            : 'bad_request';
        sendError(res, status, code, err?.message ?? '未知错误');
      } else {
        res.destroy();
      }
    }
  });

  attachWebSocket(server, app, { port });

  // 长连接会一直占着，默认 65 秒就断会让页面反复重连
  server.keepAliveTimeout = 72_000;
  server.headersTimeout = 75_000;

  return server;
}

/** 只记 API 与错误，静态资源的每次 304 没必要刷屏 */
function accessLog(log, req, res, url, started) {
  if (!url.pathname.startsWith('/api/')) return;
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  log.debug?.(`${req.method} ${url.pathname}${url.search} → ${res.statusCode} (${ms.toFixed(1)}ms)`);
}

export { sendJson };
export default createHttpServer;
