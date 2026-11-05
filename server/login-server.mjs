/**
 * 扫码登录服务。
 *
 * 独立小服务（默认 8898），只监听 127.0.0.1。
 * 主服务起来以后，把 createLoginHandler() 挂到主服务上即可，不用改这里。
 *
 * 两个设计取向：
 *
 * 1. **终端也能扫**。启动时直接在终端渲染二维码，不想开浏览器的人扫屏幕就行。
 *    浏览器打开同一个地址会复用这张码，不会每刷新一次就重打一次 B站接口。
 *
 * 2. **失败要能看懂**。B站风控、网络不通、凭证不完整，这三种情况的处理方式
 *    完全不同，所以错误信息必须区分，不能统一报"登录失败"。
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AuthStore } from './auth.mjs';
import { requestQrcode, pollQrcode, verifyCookie } from './bili/login.mjs';
import { qrSvg, qrTerminal } from './qr/svg.mjs';
import { renderLoginPage } from './login/page.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 复用二维码的时间窗：B站的码约 180 秒失效，我们留一半余量 */
const SHARE_TTL = 90_000;

/** 两次申请二维码的最小间隔，防止用户狂点刷新把 IP 打进风控 */
const MIN_QR_INTERVAL = 1500;

/**
 * 创建请求处理器。
 *
 * deps 用于注入 B站 接口实现：测试时换成假实现，就能完全离线跑，
 * 也不会因为跑测试而真的去申请二维码（那会消耗真实接口配额、可能触发风控）。
 *
 * @param {{auth:AuthStore, host:string, port:number, log?:Function,
 *          deps?:{requestQrcode?:Function, pollQrcode?:Function, verifyCookie?:Function}}} opts
 */
export function createLoginHandler({ auth, host, port, log = () => {}, deps = {}, base = '', onLogin = null }) {
  const api = {
    requestQrcode,
    pollQrcode,
    verifyCookie,
    ...deps,
  };
  /** 最近申请的一张二维码，浏览器和终端共用 */
  let shared = null;
  let lastQrAt = 0;

  /**
   * 取一张可用的二维码：能复用就复用，否则新申请。
   * @param {boolean} force 强制新申请
   */
  async function obtainQr(force = false) {
    const fresh = shared && Date.now() - shared.at < SHARE_TTL;
    if (!force && fresh) return shared;

    if (Date.now() - lastQrAt < MIN_QR_INTERVAL) {
      throw new Error('操作太快了，请等一秒再试');
    }
    lastQrAt = Date.now();

    const { url, key } = await api.requestQrcode();
    shared = { url, key, at: Date.now() };
    return shared;
  }

  const pagePath = base || '/';
  const routes = [
    ['GET', pagePath, handlePage],
    ['GET', `${base}/api/auth`, handleAuthStatus],
    ['POST', `${base}/api/qr`, handleNewQr],
    ['GET', `${base}/api/qr/poll`, handlePollStatus],
    ['POST', `${base}/api/logout`, handleLogout],
  ];

  async function handlePage(req, res) {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // 页面完全自包含：连字体和图片都不外链，只允许 B站 的头像域名
      'Content-Security-Policy':
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        `img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'none'`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(renderLoginPage(nonce, { base }));
  }

  async function handleAuthStatus(req, res) {
    sendJson(res, 200, auth.status());
  }

  async function handleNewQr(req, res) {
    try {
      const qr = await obtainQr(true);
      sendJson(res, 200, {
        ok: true,
        key: qr.key,
        svg: qrSvg(qr.url, { size: 216, margin: 3, title: 'B站登录二维码' }),
        // 二维码内容不外传，前端只需要图和 key
      });
    } catch (err) {
      log(`[QR] 申请失败：${err.message}`);
      sendJson(res, 200, { ok: false, message: humanizeQrError(err) });
    }
  }

  async function handlePollStatus(req, res, url) {
    const key = url.searchParams.get('key') || '';
    if (!key) return sendJson(res, 400, { status: 'error', message: '缺少 key' });

    try {
      const result = await api.pollQrcode(key);

      if (result.status !== 'confirmed') {
        return sendJson(res, 200, { status: result.status, message: result.message });
      }

      // 拿到凭证了。先保存 —— 即使下面的资料校验失败，也不能把凭证丢掉
      const account = await resolveAccount(result.cookie, api.verifyCookie);
      auth.save({
        cookie: result.cookie,
        uid: account.uid,
        uname: account.uname,
        face: account.face,
      });

      shared = null; // 用过就作废，避免复用已失效的 key
      log(`[AUTH] 登录成功：${account.uname || account.uid}`);

      // 主服务挂载时，凭证落盘后立刻重绑房间连接，不需要重启进程。
      // 重绑失败不影响这次登录本身：凭证已经保存，下次启动还能用。
      if (onLogin) {
        try {
          await onLogin(account);
        } catch (err) {
          log(`[AUTH] 登录后重连房间失败：${err.message}`);
        }
      }

      sendJson(res, 200, {
        status: 'confirmed',
        message: '登录成功',
        account: { uid: account.uid, uname: account.uname, face: account.face },
      });
    } catch (err) {
      log(`[QR] 轮询异常：${err.message}`);
      sendJson(res, 200, { status: 'error', message: `状态查询失败：${err.message}` });
    }
  }

  async function handleLogout(req, res) {
    const was = auth.loggedIn;
    auth.clear();
    shared = null;
    log(`[AUTH] 已退出登录${was ? '' : '（本来就没登录）'}`);
    sendJson(res, 200, { ok: true });
  }

  return async function handler(req, res) {
    // 防 DNS 重绑定：只认本机名。攻击者把域名解析到 127.0.0.1 时，Host 是他的域名
    if (!isLocalHost(req.headers.host, port)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('只允许本机访问');
      return;
    }

    let url;
    try {
      url = new URL(req.url, `http://${host}:${port}`);
    } catch {
      res.writeHead(400).end();
      return;
    }

    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const route = routes.find(([m, p]) => m === method && p === url.pathname);

    if (!route) {
      sendJson(res, 404, { ok: false, message: '没有这个接口' });
      return;
    }

    try {
      await route[2](req, res, url);
    } catch (err) {
      log(`[HTTP] ${url.pathname} 处理失败：${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, message: err.message });
    }
  };
}

/**
 * 启动登录服务。
 * @param {{port?:number, dataDir?:string, showQr?:boolean, log?:Function}} [opts]
 */
export async function startLoginServer(opts = {}) {
  const {
    port = 8898,
    dataDir = join(__dirname, '..', 'data'),
    showQr = true,
    log = console.log,
  } = opts;

  const host = '127.0.0.1';
  const auth = new AuthStore({ dataDir }).load();
  const handler = createLoginHandler({ auth, host, port, log });

  const server = createServer(handler);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const url = `http://${host}:${port}`;

  log('');
  log('  渔情LiveBot · 扫码登录');
  log(`  ${auth.describe()}`);
  log('');

  if (showQr) {
    try {
      const { url: qrUrl } = await requestQrcode();
      log(qrTerminal(qrUrl, { quiet: 2 }));
      log('');
      log('  用 B站 手机客户端扫上面的码，或打开下面的地址：');
    } catch (err) {
      log(`  （终端二维码生成失败：${humanizeQrError(err)}）`);
      log('  请在浏览器里打开下面的地址：');
    }
    log('');
  }

  log(`  ${url}`);
  log('');
  log('  Ctrl+C 退出');
  log('');

  return {
    server,
    port,
    url,
    auth,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 校验 Host 头是否为本机地址 */
function isLocalHost(hostHeader = '', port) {
  const h = String(hostHeader).toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/** 把校验结果整理成账号信息；校验失败但凭证已到手的，返回空资料而不是抛错 */
async function resolveAccount(cookie, verify = verifyCookie) {
  const info = await verify(cookie);
  if (info.valid) {
    return { uid: info.uid, uname: info.uname, face: info.face };
  }
  return { uid: 0, uname: '', face: '', warn: info.reason };
}

/** 把接口错误翻成人能看懂的一句话 */
function humanizeQrError(err) {
  const msg = err?.message || '未知错误';
  if (err?.code === -412 || /412|风控/.test(msg)) {
    return 'B站 触发了风控（-412），请稍等几分钟再试，或换个网络';
  }
  if (err?.code === 'ETIMEDOUT') {
    return '连不上 B站，请检查网络或代理设置';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) {
    return '域名解析失败，请检查网络';
  }
  return msg;
}

/* 直接运行本文件时启动服务 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLoginServer({ port: Number(process.env.PORT) || 8898 }).catch((err) => {
    console.error(`启动失败：${err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error(`端口被占用，换一个：set PORT=8897 && node server/login-server.mjs`);
    }
    process.exit(1);
  });
}
