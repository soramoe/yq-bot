/**
 * WebSocket 推送。
 *
 * 这个文件要解决的核心问题只有一个：**断线重连后不能出现缺口，也不能重复**。
 *
 * 二代的"事件流停在 20:47"就是这里出的问题：
 *   重连时服务端把最近 60 条一次性发过去，前端每房间每秒只放行 3 条，
 *   剩下的 57 条被当成"超频"丢掉了 —— 页面看上去还活着，但数据停在某个时刻。
 *
 * 三代的约定：
 *   1. 服务端补发**一次性一整批**（backlog），不逐条挤
 *   2. 客户端拿 seq 去重、按 seq 排序，**入库不限流**，限流只放在渲染层
 *   3. 补发不到的部分如实标 `gap: true`，不假装连续
 */

import { WebSocketServer } from 'ws';
import { checkOrigin } from './write-guard.mjs';

/** 补发一次最多给多少条。再多说明断了很久，给最近的更实用。 */
const BACKLOG_LIMIT = 800;
const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD = 1 << 20; // 1MB

/**
 * @param {import('node:http').Server} server
 * @param {import('../app.mjs').App} app
 * @param {{port:number}} opts
 */
export function attachWebSocket(server, app, { port }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      socket.destroy();
      return;
    }

    // 只接受 /ws，其他升级请求一律断开 —— 免得将来某个库的 upgrade 被误用
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // 与 HTTP 同一套 Host 校验：防 DNS 重绑定把页面引到本机
    if (!isLocalHostHeader(req.headers.host, port)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // WebSocket **不受同源策略约束**：任意网页都能连 127.0.0.1 读弹幕流，
    // 而且不给看响应也看得到推送。所以 upgrade 必须自己查 Origin ——
    // 和写接口用同一套白名单，缺 Origin 的非浏览器客户端放行（同 guardWrite 的理由）。
    const originBad = checkOrigin(req.headers.origin, port);
    if (originBad) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, url);
    });
  });

  wss.on('connection', (ws, req, url) => {
    const after = Number(url.searchParams.get('after') ?? 0) || 0;

    let closed = false;
    let ready = false;
    /** 订阅已生效但 backlog 还没发完时，新事件先攒着，等 backlog 发完再按序补 */
    const pending = [];

    const send = (obj) => {
      if (closed || ws.readyState !== ws.OPEN) return;
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        // 发送失败说明连接已坏，交给 close 处理
      }
    };

    // 顺序很重要：**先订阅，再取快照**。
    // 反过来的话，取完 backlog 到订阅生效之间的那几条事件会永久丢掉。
    const unsub = app.subscribe((msg) => {
      if (closed) return;
      if (!ready) {
        pending.push(msg);
        return;
      }
      send(msg);
    });

    send({ type: 'hello', data: { now: Date.now(), status: app.status() } });

    const page = app.recentEvents({ after, limit: BACKLOG_LIMIT });
    send({
      type: 'backlog',
      data: {
        events: page.events,
        gap: page.gap,
        from: page.from,
        to: page.to,
        oldestSeq: page.oldestSeq,
        askedAfter: after,
      },
    });

    // backlog 发完，把期间攒下的补上。
    // 去重交给前端（它按 seq 合并），这里只保证不丢。
    ready = true;
    for (const msg of pending) send(msg);
    pending.length = 0;

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (buf) => {
      // 现在没有客户端→服务端的指令。
      // 但必须挂监听：不挂的话 close 前的消息会堆在缓冲区里没人读。
      // 只认一个 ping，用来给"页面在后台被限流"的情况留条活路。
      if (buf.length <= 64 && buf.toString('utf8').includes('ping')) {
        send({ type: 'pong', data: { now: Date.now() } });
      }
    });

    ws.on('close', () => {
      closed = true;
      unsub();
    });

    ws.on('error', () => {
      // ws 的 'error' 没有监听器会抛到进程顶层，这里必须吃掉
      closed = true;
      unsub();
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // 连接已坏，下一轮会被 terminate
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

function isLocalHostHeader(host = '', port) {
  const h = String(host).toLowerCase();
  if (!h) return false;
  const name = h.replace(/:\d+$/, '');
  return (
    name === '127.0.0.1' ||
    name === 'localhost' ||
    name === '[::1]' ||
    name === '::1' ||
    h === `127.0.0.1:${port}` ||
    h === `localhost:${port}`
  );
}

export default attachWebSocket;
