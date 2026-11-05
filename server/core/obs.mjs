/**
 * OBS 场景联动（obs-websocket 5.x，OBS 28+ 自带）。
 *
 * 只做一件事：开播切到「直播中」场景、下播切回「闲聊」场景。
 * 不常驻长连 —— 每次边沿才连一次，切完就关：
 *   - 常驻的话要处理断线重连、OBS 重启、密码变更，复杂度远超"切个场景"的价值；
 *   - 开播/下播一小时一次都算频繁，连一次几百毫秒可以接受。
 *
 * 协议：Hello(op0) → Identify(op1，有 authentication 就回 challenge 响应)
 * → Identified(op2) → Request(op6)/Response(op7)。
 */

import { createHash } from 'node:crypto';
import { WebSocket as NodeWebSocket } from 'ws';

function sha256Base64(text) {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

/** obs-websocket 的认证串：base64(sha256(base64(sha256(password+salt)) + challenge))。 */
export function obsAuthString(password, salt, challenge) {
  const secret = sha256Base64(`${password}${salt}`);
  return sha256Base64(`${secret}${challenge}`);
}

/**
 * 连上并完成 Identify 后 resolve 一个客户端。
 *
 * @param {{url:string, password?:string, WebSocketImpl?:typeof WebSocket,
 *   timeoutMs?:number, requestTimeoutMs?:number}} opts
 */
export function createObsClient({
  url,
  password = '',
  WebSocketImpl = NodeWebSocket,
  timeoutMs = 6000,
  requestTimeoutMs = 8000,
} = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch (err) {
      reject(new Error(`连接 OBS 失败：${err.message}`));
      return;
    }

    let settled = false;
    let requestSeq = 0;
    const pending = new Map();

    const connTimer = setTimeout(() => {
      settleReject(new Error('连接 OBS 超时'));
    }, timeoutMs);
    connTimer.unref?.();

    function settleReject(err) {
      if (settled) return;
      settled = true;
      clearTimeout(connTimer);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      try {
        ws.close();
      } catch {
        /* 已经关了 */
      }
      reject(err);
    }

    function settleResolve(client) {
      if (settled) return;
      settled = true;
      clearTimeout(connTimer);
      resolve(client);
    }

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.op !== 'number') return;

      if (msg.op === 0) {
        const hello = msg.d ?? {};
        const identify = { rpcVersion: 1 };
        if (hello.authentication) {
          identify.authentication = obsAuthString(
            password,
            String(hello.authentication.salt ?? ''),
            String(hello.authentication.challenge ?? ''),
          );
        }
        try {
          ws.send(JSON.stringify({ op: 1, d: identify }));
        } catch (err) {
          settleReject(new Error(`OBS 握手失败：${err.message}`));
        }
        return;
      }

      if (msg.op === 2) {
        settleResolve({
          get identified() {
            return true;
          },
          request(type, requestData = {}) {
            const requestId = `r${++requestSeq}`;
            return new Promise((res, rej) => {
              const timer = setTimeout(() => {
                pending.delete(requestId);
                rej(new Error(`OBS 请求超时：${type}`));
              }, requestTimeoutMs);
              timer.unref?.();
              pending.set(requestId, {
                resolve(v) {
                  clearTimeout(timer);
                  res(v);
                },
                reject(e) {
                  clearTimeout(timer);
                  rej(e);
                },
              });
              try {
                ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId, requestData } }));
              } catch (err) {
                pending.delete(requestId);
                clearTimeout(timer);
                rej(new Error(`OBS 请求失败：${err.message}`));
              }
            });
          },
          close() {
            try {
              ws.close();
            } catch {
              /* 已经关了 */
            }
          },
        });
        return;
      }

      if (msg.op === 7) {
        const d = msg.d ?? {};
        const p = pending.get(d.requestId);
        if (!p) return;
        pending.delete(d.requestId);
        const status = d.requestStatus ?? {};
        if (status.result === true) p.resolve(d.responseData ?? {});
        else p.reject(new Error(status.comment || `OBS 请求失败（code ${status.code ?? '?'}）`));
      }
    });

    ws.addEventListener('close', (ev) => {
      const authFailed = ev?.code === 4009;
      const err = new Error(authFailed ? 'OBS 认证失败：密码不对' : 'OBS 连接已关闭');
      if (settled) {
        for (const p of pending.values()) p.reject(err);
        pending.clear();
        return;
      }
      settleReject(err);
    });

    ws.addEventListener('error', () => {
      settleReject(new Error('连接 OBS 失败（检查地址与 OBS 是否开着 WebSocket 服务）'));
    });
  });
}
