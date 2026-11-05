/**
 * B站 弹幕长连客户端。
 *
 * 只做一件事：把直播间说的话，变成规范事件流。
 * 开播状态、房间管理、统计全都不在这里 —— 那是上层的职责。
 *
 * 五个必须处理的异常（每一个都是二代用真实故障换来的）：
 *
 * 1. **假活连接**。NAT 超时、切网、代理抖动时，TCP 那头早没了，
 *    但本端 socket 仍是 OPEN：心跳照发、界面照显示"已连接"，一条弹幕都收不到。
 *    挂机一整晚最怕这个。所以用「90 秒内没有任何入站报文」判死。
 *
 * 2. **认证超时**。发了 AUTH 但对方不回 AUTH_REPLY，连接会一直挂着不报错。
 *
 * 3. **终止 CONNECTING 中的 socket 会抛 error**。ws 的 'error' 是 EventEmitter
 *    事件，没有监听器时 Node 会升级成未捕获异常，**整个进程直接退出**。
 *    所以摘监听器之后必须立刻补一个空的 error 兜底。
 *
 * 4. **旧连接的 close 后到**。换凭据重连时，旧 socket 的 close 事件可能在
 *    新连接建立之后才触发，不能让它把新连接一起清掉。
 *
 * 5. **压缩包只拆一层**。B站 的 zlib/brotli 包解开后仍是同样的包头格式，
 *    里面还套着几十条消息。只解一层就等于丢掉一整批弹幕。
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import { encode, decode, parseJson, parsePopularity, OP, VER } from './packet.mjs';
import { normalize } from './normalize.mjs';
import { resolveRoomId, fetchDanmuInfo, fetchBuvid } from './room.mjs';
import { uidFromCookie } from './cookie.mjs';

const HEARTBEAT_INTERVAL = 30_000;
const AUTH_TIMEOUT = 10_000;
const MAX_RECONNECT_DELAY = 60_000;
/** 90 秒 = 三个心跳周期都没有任何回包，正常情况不可能发生 */
const STALE_TIMEOUT = 90_000;

export const STATUS = {
  IDLE: 'idle',
  RESOLVING: 'resolving',
  CONNECTING: 'connecting',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  CLOSED: 'closed',
  ERROR: 'error',
};

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };

export class LiveClient extends EventEmitter {
  /**
   * @param {{roomId:number|string, cookie?:string, label?:string, log?:object}} opts
   */
  constructor({ roomId, cookie = '', label = '', log = SILENT_LOG }) {
    super();

    this.inputRoomId = roomId;
    this.realRoomId = 0;
    this.anchorUid = 0;
    this.cookie = cookie;
    this.uid = uidFromCookie(cookie);
    this.label = label || String(roomId);
    this.log = log;

    this.buvid = '';
    this.token = '';
    /** @type {{host:string,wssPort:number,wsPort:number}[]} */
    this.hosts = [];
    this.hostIndex = 0;

    /** @type {WebSocket|null} */
    this.ws = null;
    /** 正在建立的握手的收尾函数，cleanup 时负责 settle，避免调用方永远等下去 */
    this._pendingHandshake = null;

    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.authTimer = null;

    this.reconnectAttempts = 0;
    this.manualClose = false;
    this.status = STATUS.IDLE;
    this.popularity = 0;
    /** 最后一次收到任何入站报文的时间（假活检测基准） */
    this.lastRecvAt = 0;

    this.stats = { packets: 0, events: 0, ignored: 0, unparsed: 0, inflatedFail: 0 };
  }

  get isRunning() {
    return Boolean(this.ws) && this.ws.readyState === WebSocket.OPEN && !this.manualClose;
  }

  /** 距上次收到报文过了多久。数值一直涨 = 连接已经假活 */
  get silentMs() {
    return this.lastRecvAt ? Date.now() - this.lastRecvAt : 0;
  }

  _setStatus(status, extra = {}) {
    if (this.status === status && Object.keys(extra).length === 0) return;
    this.status = status;
    this.emit('status', { status, ...extra });
  }

  async start() {
    if (this.isRunning) return this;
    this.manualClose = false;
    this._clearTimers();
    this.reconnectAttempts = 0;
    await this._connect();
    return this;
  }

  stop() {
    this.manualClose = true;
    this._clearTimers();
    this._cleanupSocket();
    this._setStatus(STATUS.CLOSED);
    this.log.info(`[${this.label}] 已停止`);
  }

  /** 换凭据：已经连上就必须重连，否则新凭据不生效 */
  async setCookie(cookie) {
    const next = cookie || '';
    if (next === this.cookie) return;
    const wasRunning = this.isRunning;

    this.cookie = next;
    this.uid = uidFromCookie(next);
    this.log.info(`[${this.label}] 登录凭据已更新（uid ${this.uid || '游客'}）`);

    if (wasRunning) {
      this._clearTimers();
      this._cleanupSocket();
      this.reconnectAttempts = 0;
      this._setStatus(STATUS.RECONNECTING, { reason: 'cookie-changed' });
      await this._connect();
    }
  }

  /* ---------------- 连接流程 ---------------- */

  async _connect() {
    if (this.manualClose) return;
    this._cleanupSocket();

    try {
      this._setStatus(this.realRoomId ? STATUS.RECONNECTING : STATUS.RESOLVING);

      if (!this.realRoomId) {
        const info = await resolveRoomId(this.inputRoomId);
        this.realRoomId = info.roomId;
        this.anchorUid = info.uid;
        this.log.info(
          `[${this.label}] 房间号 ${this.inputRoomId} → ${this.realRoomId}（主播 ${info.uid}，${info.liveState}）`,
        );
        this.emit('resolved', info);
      }

      if (this.manualClose) return;

      if (!this.buvid) this.buvid = await fetchBuvid();

      const danmu = await fetchDanmuInfo(this.realRoomId, this.cookie, this.buvid);
      this.token = danmu.token;
      this.hosts = danmu.hosts;
      this.log.info(`[${this.label}] 弹幕服务器 ${this.hosts.length} 个`);

      if (this.manualClose) return;

      this._setStatus(STATUS.CONNECTING, { roomId: this.realRoomId });
      await this._openSocket();
    } catch (err) {
      if (this.manualClose) return;
      this.log.error(`[${this.label}] 连接失败：${err.message}`);
      this._setStatus(STATUS.ERROR, { message: err.message });
      this._scheduleReconnect();
      throw err;
    }
  }

  async _openSocket() {
    const host = this.hosts[this.hostIndex % this.hosts.length];
    const url = `wss://${host.host}:${host.wssPort}/sub`;

    await new Promise((resolve, reject) => {
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Origin: 'https://live.bilibili.com',
      };
      // 带 Cookie 是必须的：游客连接约 5 分钟后 B站 会把用户名打码成 X***
      if (this.cookie) headers.Cookie = this.cookie;

      const ws = new WebSocket(url, { headers, handshakeTimeout: 10_000 });
      this.ws = ws;

      const done = (err) => {
        if (this._pendingHandshake === done) this._pendingHandshake = null;
        if (err) reject(err);
        else resolve();
      };
      this._pendingHandshake = done;

      const onOpen = () => {
        ws.off('error', onFail);
        done();
      };
      const onFail = (err) => {
        ws.off('open', onOpen);
        done(err);
      };

      ws.once('open', onOpen);
      ws.once('error', onFail);
    });

    this.log.info(`[${this.label}] WebSocket 已建立：${host.host}`);
    this._bindSocket(this.ws);
    this._sendAuth();
  }

  _bindSocket(ws) {
    ws.on('message', (data) => this._onMessage(data));

    ws.on('close', (code) => {
      /**
       * 旧 socket 的 close 可能晚到（换凭据、假活重连、认证超时时我们会主动
       * `_cleanupSocket()` 换一条新的），它只代表"那一条连接没了"。
       *
       * 这里**必须**先判 `this.ws === ws` 才能碰定时器。以前是无条件
       * `_clearTimers()`，于是旧连接迟到的 close 会把**新连接**的心跳清掉：
       * 之后新连接不再发心跳，而假活检测也挂在同一个心跳定时器里 ——
       * 两个保护同时失效，表现是"界面显示已连接，但一条弹幕都收不到"，
       * 而且不会自己好起来（B站 那头要等 TCP 超时才断）。
       */
      if (this.ws !== ws) {
        this.log.debug?.(`[${this.label}] 旧连接已关闭（code=${code}），忽略`);
        return;
      }

      this.ws = null;
      this._clearTimers();

      if (this.manualClose) {
        this._setStatus(STATUS.CLOSED);
        return;
      }
      this.log.warn(`[${this.label}] 连接断开（code=${code}）`);
      this.hostIndex++;
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (this.manualClose) return;
      this.log.warn(`[${this.label}] 连接异常：${err.message}`);
    });
  }

  _sendAuth() {
    const body = {
      uid: this.uid || 0,
      roomid: this.realRoomId,
      protover: VER.BROTLI,
      buvid: this.buvid,
      platform: 'web',
      type: 2,
      key: this.token,
    };

    this.ws.send(encode(OP.AUTH, body, VER.PLAIN));

    clearTimeout(this.authTimer);
    this.authTimer = setTimeout(() => {
      if (this.status === STATUS.LIVE) return;
      this.log.warn(`[${this.label}] 认证超时，重连`);
      this._cleanupSocket();
      this.hostIndex++;
      this._scheduleReconnect();
    }, AUTH_TIMEOUT);
  }

  _startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.lastRecvAt = Date.now();

    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;

      if (this._isStale()) {
        const silent = Math.round((Date.now() - this.lastRecvAt) / 1000);
        this.log.warn(`[${this.label}] ${silent} 秒无任何报文，判定假活，主动重连`);
        this._cleanupSocket();
        this.hostIndex++;
        this._scheduleReconnect();
        return;
      }

      /**
       * 必须兜住：readyState 检查与 send 之间没有任何异步间隙，
       * 但 socket 可能在**同一轮事件循环里**已经被 close 事件置为 CLOSING ——
       * 此时 `ws.send()` 会同步抛 "WebSocket is not open"。
       *
       * 定时器回调里抛出的异常没人接，会被 `uncaughtException` 接住，
       * 而 main.mjs 对未捕获异常的处理是**关掉整个进程**。
       * 也就是"心跳撞上一次正常的重连"会让机器人直接退出 —— 代价完全不成比例。
       */
      try {
        this.ws.send(encode(OP.HEARTBEAT, ''));
      } catch (err) {
        this.log.warn(`[${this.label}] 心跳发送失败，走重连：${err.message}`);
        this._cleanupSocket();
        this.hostIndex++;
        this._scheduleReconnect();
      }
    }, HEARTBEAT_INTERVAL);

    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /** 单独抽出来便于自检直接验证（不依赖真实时间流逝） */
  _isStale(now = Date.now()) {
    if (!this.lastRecvAt) return false;
    return now - this.lastRecvAt > STALE_TIMEOUT;
  }

  /* ---------------- 收包 ---------------- */

  _onMessage(data) {
    this.lastRecvAt = Date.now();

    let packets;
    try {
      packets = decode(data);
    } catch (err) {
      this.stats.unparsed++;
      this.log.warn(`[${this.label}] 拆包失败：${err.message}`);
      return;
    }

    if (packets.length === 0) this.stats.inflatedFail++;

    for (const packet of packets) {
      this.stats.packets++;

      switch (packet.op) {
        case OP.AUTH_REPLY:
          clearTimeout(this.authTimer);
          this.reconnectAttempts = 0;
          this._setStatus(STATUS.LIVE, { roomId: this.realRoomId });
          this._startHeartbeat();
          this.log.info(`[${this.label}] 认证成功，开始接收弹幕`);
          this.emit('ready', { roomId: this.realRoomId });
          break;

        case OP.HEARTBEAT_REPLY: {
          const value = parsePopularity(packet.body);
          if (value !== this.popularity) {
            this.popularity = value;
            this.emit('popularity', value);
          }
          break;
        }

        case OP.MESSAGE: {
          const raw = parseJson(packet.body);
          if (!raw) {
            this.stats.unparsed++;
            break;
          }

          const ev = normalize(raw);
          if (!ev) {
            this.stats.ignored++;
            break;
          }

          this.stats.events++;
          // 原始报文也给出去：排查"某个 cmd 没进来"时要能看到它
          this.emit('event', ev, raw);
          break;
        }

        default:
          break;
      }
    }
  }

  /* ---------------- 收尾 ---------------- */

  _clearTimers() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  _cleanupSocket() {
    const ws = this.ws;
    this.ws = null;

    if (ws) {
      try {
        ws.removeAllListeners();
        // 必须补这个：终止 CONNECTING 中的 ws 会 emit 'error'，
        // 而 EventEmitter 在没有 error 监听器时会把异常抛到进程顶层。
        ws.on('error', () => {});
        ws.terminate();
      } catch {
        /* ignore */
      }
    }

    const pending = this._pendingHandshake;
    this._pendingHandshake = null;
    if (pending) pending(new Error('连接在建立完成前被终止'));

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this.manualClose || this.reconnectTimer) return;

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY);
    this.reconnectAttempts++;

    this._setStatus(STATUS.RECONNECTING, {
      attempts: this.reconnectAttempts,
      nextDelay: delay,
    });
    this.log.warn(`[${this.label}] ${Math.round(delay / 1000)} 秒后重连（第 ${this.reconnectAttempts} 次）`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect().catch(() => {
        // _connect 内部已安排重连
      });
    }, delay);

    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  snapshot() {
    return {
      inputRoomId: this.inputRoomId,
      realRoomId: this.realRoomId,
      anchorUid: this.anchorUid,
      status: this.status,
      popularity: this.popularity,
      guest: !this.cookie,
      silentMs: this.lastRecvAt ? Date.now() - this.lastRecvAt : null,
      reconnectAttempts: this.reconnectAttempts,
      stats: { ...this.stats },
    };
  }
}

export default LiveClient;
