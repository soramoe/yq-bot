/**
 * 房间运行器：把「连接」和「内核」缝在一起。
 *
 * 职责边界很窄，只有一件事：
 *   B站 报文 → 规范事件 → **先落盘** → 再投影 → 通知外部
 *
 * 顺序不能反。二代的统计是"内存累加 + 定时落盘"，所以崩溃/重启会丢掉
 * 未落盘的部分；三代把落盘放在投影之前，**日志是唯一事实来源**，
 * 投影随时可以从日志重算（决策记录 D2）。
 *
 * 启动时做两件事：
 *   1. 重放已有日志，把统计恢复到上次的水平（不是"猜"，是"重算"）
 *   2. 用接口校准开播状态，必要时补一条 LIVE_START / LIVE_END
 *       —— 因为 WebSocket 只在"开播那一刻"推 LIVE，
 *          进程在直播中途启动是收不到那条消息的
 */

import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { EventLog } from './core/event-log.mjs';
import { Projection } from './core/projection.mjs';
import { Roster } from './core/roster.mjs';
import { EVENT, ROSTER_EVENTS } from './core/events.mjs';
import { SendGate } from './core/gate.mjs';
import { PluginHost } from './core/plugin-host.mjs';
import { LiveClient } from './bili/live-client.mjs';
import { resolveRoomId, fetchRoomInfo } from './bili/room.mjs';
import { sendDanmaku } from './bili/send.mjs';

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 不会被插件看见的事件类型。
 *
 * SENT 必须排除：插件看到"自己刚说了话"再去说话，就是无限循环。
 * 闸门的间隔与去重能挡住大部分，但那是限速，不是防递归 ——
 * 结构上直接不给入口，才是干净的做法。
 */
/**
 * 插件看不到的事件：SENT（防止自我触发），ROOM_TITLE（展示元数据，玩法无关）。
 * ROOM_CHANGE 不进观众簿 —— 它没有 uid，是房间的属性不是观众的行为。
 */
const PLUGIN_INVISIBLE = new Set([EVENT.SENT, EVENT.ROOM_TITLE]);

/**
 * 哪些事件要记进观众簿 —— 定义在 `core/events.mjs`。
 *
 * 这里转出去只是为了让老的引用（自检、文档）不用改：
 * 沙盒回放也要用同一份清单，而它不该为此 import 整个 B站 长连模块。
 */
export { ROSTER_EVENTS };

export class RoomRunner extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number|string} opts.roomId
   * @param {string} [opts.cookie]
   * @param {string} opts.dataDir
   * @param {object} [opts.log]
   * @param {boolean} [opts.dryRun]  演练模式：走完整链路但不真的发出去
   * @param {string|null} [opts.pluginsDir] 插件目录；null 表示不加载插件
   * @param {object} [opts.pluginConfigs]
   * @param {object} [opts.pluginEnabled]  宿主级禁用表 { pluginId: false }
   * @param {number} [opts.logKeepDays]    明文日志保留天数，更早的归档成 .gz
   * @param {number} [opts.rosterKeepDays] 观众簿保留天数，更早的分片整片删除
   */
  constructor({
    roomId,
    cookie = '',
    dataDir,
    log = SILENT_LOG,
    dryRun = true,
    pluginsDir = null,
    pluginConfigs = {},
    pluginEnabled = {},
    logKeepDays = 30,
    rosterKeepDays = 90,
    /**
     * 房间号解析。默认走真实接口，自检可以注入一个会失败/不会失败的实现 ——
     * 否则"启动失败之后能不能再试一次"这件事必须联网才能验证。
     */
    resolveRoom = resolveRoomId,
    /**
     * 房间详情。和 `resolveRoom` 一样可注入：重连校准要再取一次，
     * 自检不该为此真的联网。
     */
    fetchInfo = fetchRoomInfo,
  }) {
    super();

    this.inputRoomId = roomId;
    this.realRoomId = 0;
    this.cookie = cookie;
    this.dataDir = dataDir;
    this.log = log;
    this._resolveRoom = resolveRoom;
    this._fetchRoom = fetchInfo;
    /** 校准并发保护：快速抖动时不要叠着发请求 */
    this._resyncPending = null;

    /** @type {EventLog|null} */
    this.log_ = null;
    /** @type {Projection|null} */
    this.projection = null;
    /** @type {LiveClient|null} */
    this.client = null;
    /** @type {SendGate|null} */
    this.gate = null;
    /** @type {PluginHost|null} */
    this.host = null;
    /**
     * @type {Roster|null} 观众簿：记住"这个人以前来过吗"。
     *
     * 放在这里而不是 App 层，是因为它按房间分片 —— 切房间就该换一本。
     * 但如果多个房间将来要共享"同一个主播的观众"，这里要改成由 App 持有。
     */
    this.roster = null;

    /**
     * 最近说过话的人（uid → {uid,name,lastSpokeAt}）。
     *
     * B站 的结构化 @ 只对**当前还在房间里**的人生效：目标已经走了时，
     * 服务端会把 reply_mid 归零，观众看到的就是一条没有 @ 的普通弹幕。
     * 观众簿只能说明"来过"，不能说明"还在"；刚发过弹幕的人则一定在。
     * 主动招呼优先从这里挑人，@ 才挂得出来。
     */
    this._speakers = new Map();

    this.pluginsDir = pluginsDir;
    this.pluginConfigs = pluginConfigs;
    this.pluginEnabled = pluginEnabled;
    this.dryRun = dryRun;
    this.logKeepDays = logKeepDays;
    this.rosterKeepDays = rosterKeepDays;

    this.info = null;
    this.started = false;
  }

  /** 启动时重放日志。返回恢复出的统计，便于日志里报一句"接上了多少"。 */
  restore() {
    const roomKey = String(this.realRoomId || this.inputRoomId);

    this.log_ = new EventLog({
      root: join(this.dataDir, 'events'),
      roomId: roomKey,
      keepDays: this.logKeepDays,
    });
    this.projection = new Projection(roomKey);

    // 观众簿跟日志同房间分片。这里只创建，载入在 start() 里 await ——
    // restore 是同步的，而五十万条同步读会卡住事件循环几百毫秒。
    this.roster = new Roster({
      dataDir: this.dataDir,
      roomId: roomKey,
      keepDays: this.rosterKeepDays,
      log: this.log,
    });

    // 归档放在重放之前：先压缩老分片，接下来的 readAll 走的是同一套透明读取，
    // 归档与否对统计没有影响 —— 这正是"只压不删"的前提。
    const arch = this.log_.archiveOld({ keepDays: this.logKeepDays });
    if (arch.archived.length > 0) {
      const before = arch.archived.reduce((s, a) => s + a.bytes, 0);
      const after = arch.archived.reduce((s, a) => s + a.packed, 0);
      const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
      this.log.info(
        `归档 ${arch.archived.length} 个日志分片（${arch.cutoffDay} 之前），` +
          `${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB（省 ${pct}%）`,
      );
    }

    const events = this.log_.readAll();
    this.projection.applyAll(events);

    const snap = this.projection.snapshot();
    this.log.info(
      `[${roomKey}] 重放 ${events.length} 条事件，当前状态 ${snap.state}` +
        (snap.hasKnownStart ? '' : '（场次起点未知，等下一次开播消息）') +
        `，本场弹幕 ${snap.danmaku}、进场 ${snap.enterCount}、礼物 ${snap.giftCount} 个 ${snap.giftBattery} 电池`,
    );

    const logStats = this.log_.stats();
    if (logStats.recoveredByScan) {
      // 这不是致命问题，但说明上次退出不干净，值得让人知道
      this.log.warn(`[${roomKey}] 上次退出时不干净：日志尾部损坏，已通过全量扫描恢复序号`);
    }
    if (logStats.badLines > 0) {
      this.log.warn(`[${roomKey}] 日志里有 ${logStats.badLines} 行损坏（多半是进程被杀时的半行）`);
    }

    this.emit('restored', snap);
    return snap;
  }

  /** 装配发送闸门与插件宿主 */
  _wire() {
    this.gate = new SendGate({
      send: ({ roomId, text, reply }) =>
        sendDanmaku({ roomId, text, reply, cookie: this.cookie }),
      record: (type, payload) => this._ingest({ type, payload }),
      log: this.log,
      config: { dryRun: this.dryRun },
    });

    if (!this.pluginsDir) return;

    this.host = new PluginHost({
      dir: this.pluginsDir,
      log: this.log,
      say: (args) => this.gate.say({ roomId: this.realRoomId || this.inputRoomId, ...args }),
      getState: () => this.projection?.snapshot() ?? null,
      configs: this.pluginConfigs,
      enabled: this.pluginEnabled,
      roster: this.roster,
      speakers: { recent: (opts) => this.recentSpeakers(opts) },
    });
  }

  async start() {
    if (this.started) return this;
    this.started = true;

    try {
      // 先解析房间号，日志要按真实房间号分片
      const resolved = await this._resolveRoom(this.inputRoomId);
      this.realRoomId = resolved.roomId;

      // room_init 只给房间号与开播状态，**没有标题**。
      // 标题要显示在页面上，所以再取一次 get_info 补上。
      // 取失败不能影响启动：宁可标题空着，也不能因为展示信息连不上直播间。
      let detail = null;
      try {
        detail = await this._fetchRoom(this.realRoomId, this.cookie);
      } catch (err) {
        this.log.warn(`[${this.realRoomId}] 取房间详情失败：${err.message}`);
      }

      this.info = {
        ...resolved,
        ...(detail ?? {}),
        roomId: resolved.roomId,
        liveState: detail?.liveState ?? resolved.liveState,
      };

      this.restore();

      // 观众簿必须在插件启动前载入：插件 onStart 里就要能查人。
      // 载入失败降级成"谁都不认识"—— 表现是重复欢迎变多，
      // 而不是整个机器人连不上，这个代价换得动。
      if (this.roster) {
        await this.roster.load().catch((err) => {
          this.log.warn(`[${this.realRoomId}] 观众簿载入失败，本次按"全是新观众"处理：${err.message}`);
        });
      }

      this._wire();

      if (this.host) {
        await this.host.load();
        await this.host.startAll();
      }

      // 校准开播状态：进程可能是直播中途启动的，收不到那条 LIVE
      this._syncLiveState(this.info);

      this.client = new LiveClient({
        roomId: this.realRoomId,
        cookie: this.cookie,
        label: String(this.realRoomId),
        log: this.log,
      });

      this.client.on('status', (s) => this.emit('status', s));
      this.client.on('popularity', (v) => this.emit('popularity', v));
      this.client.on('event', (ev, raw) => this._ingest(ev, raw));
      this.client.on('resolved', (r) => {
        this.emit('resolved', r);
      });
      this.client.on('ready', () => this._onReady());

      await this.client.start().catch((err) => {
        this.log.error(`[${this.realRoomId}] 启动连接失败：${err.message}`);
      });

      return this;
    } catch (err) {
      /**
       * 启动失败必须把 `started` 放回去。
       *
       * 以前 `this.started = true` 写在第一行且没有回滚：只要解析房间号
       * 或者加载插件抛一次（断网、B站 接口抖动、某个插件 manifest 写错），
       * 这个房间就**永久**处于"已启动"状态 —— 再调 start() 会直接 return，
       * 于是它既没有日志也没有长连，页面上还占着一个位置，只能重启进程。
       *
       * 同时拆掉已经装了一半的部件：插件可能已经起了定时器，
       * 不清掉的话"重试一次"会得到两套插件实例，两边都在说话。
       */
      this.started = false;

      const host = this.host;
      this.host = null;
      try {
        await host?.stopAll();
      } catch {
        /* 半启动的宿主，停不掉也不该盖住真正的错误 */
      }

      try {
        this.client?.stop();
      } catch {
        /* 同上 */
      }
      this.client = null;
      this.gate = null;

      throw err;
    }
  }

  /**
   * 校准开播状态。
   *
   * 只补一条边沿事件，不重复补：如果投影本来就是 live，说明日志里
   * 已经有过 LIVE_START（或者上一场还没结束），不再重复写。
   */
  _syncLiveState(info, { inferred = false } = {}) {
    const state = this.projection?.snapshot().state;
    const isLive = info.liveState === 'live';

    if (isLive && state === 'offline') {
      this.log.info(`[${this.realRoomId}] 房间在播但状态为 ${state}，补一条开播事件`);
      // synthetic：进程启动时补的，不是"此刻开播"。通知层靠它区分
      // 「真的开播了」和「重启的时候它本来就在播」（后者不该提醒）。
      // inferred：重连后补的。它确实发生在断线期间，应该提醒 ——
      // 但不能算 synthetic，否则会被通知层静默掉。
      this._ingest({
        type: EVENT.LIVE_START,
        payload: inferred ? { liveTime: info.liveTime, inferred: true } : { liveTime: info.liveTime, synthetic: true },
      });
    } else if (!isLive && state !== 'offline') {
      this.log.info(`[${this.realRoomId}] 房间已停播但状态为 ${state}，补一条下播事件`);
      // synthetic：这不是 B站 推的 LIVE_END，是"我启动时看到它没在播"推断的。
      // 它的 ts 是启动时刻，可能比真实下播晚几小时，投影必须知道这一点，
      // 否则会把结束时间当成精确值（战报上的时长直接错成几小时）。
      // inferred 同理：重连补的下播也不知道准确时刻，结束时间要标"约"。
      this._ingest({
        type: EVENT.LIVE_END,
        payload: inferred ? { liveTime: info.liveTime, inferred: true } : { liveTime: info.liveTime, synthetic: true },
      });
    }
  }

  /**
   * 连接就绪。
   *
   * 启动时已经用 `info` 校准过一次，所以**这里补出来的边沿都发生在启动之后**：
   * 一律按 inferred 处理，让提醒层照发。
   *
   * 为什么不能把第一次 ready 还当 synthetic：如果启动时房间没播、几秒内开播，
   * ready 的校准会先拿到 live 并补一条 synthetic LIVE_START；紧接着真正的
   * LIVE 事件到达时，状态机按同一个 liveTime 判重复，不再出边沿 —— 这条开播
   * 提醒就永久丢了。启动时本来就在播的情况，上一步的 `_syncLiveState(info)`
   * 已经补过 synthetic 了，这里不会再补。
   */
  _onReady() {
    this.emit('ready');
    if (!this.started) return;

    this._resyncLive({ inferred: true }).catch((err) => {
      this.log.warn(`[${this.realRoomId}] 连接后校准开播状态失败：${err.message}`);
    });
  }

  /**
   * 重新取房间信息并校准。
   *
   * 不并发的理由：网络抖动时 ready 可能连着来两次，两次 get_info 的
   * 返回顺序不保证，后发的先到会把"刚校准过"又推回旧状态。
   */
  async _resyncLive({ inferred = true } = {}) {
    if (this._resyncPending) return this._resyncPending;

    this._resyncPending = (async () => {
      if (!this.started) return;
      const detail = await this._fetchRoom(this.realRoomId, this.cookie);
      if (!detail || !this.started) return;

      this.info = {
        ...(this.info ?? {}),
        ...detail,
        roomId: this.realRoomId,
        // get_info 少了开播状态时保留旧值，不能把 live 误读成离线
        liveState: detail.liveState ?? this.info?.liveState ?? '',
      };
      this._syncLiveState(this.info, { inferred });
    })().finally(() => {
      this._resyncPending = null;
    });

    return this._resyncPending;
  }

  /** 核心：先落盘，再投影，然后通知（插件、外部订阅者） */
  _ingest(ev, raw) {
    if (!ev || !ev.type) return null;

    let record;
    try {
      record = this.log_.append(ev.type, ev.payload ?? {});
    } catch (err) {
      // 落盘失败是严重问题：统计会开始不可信，必须明确报出来。
      //
      // 事件名不能叫 'error'：Node 的 EventEmitter 在没有 'error' 监听器时
      // 会把异常直接抛到进程顶层 —— 于是"磁盘写满"会变成"进程崩掉"，
      // 而崩溃前的最后一行日志恰好是写不进去的那条，排查时看不到任何线索。
      this.log.error(`[${this.realRoomId}] 写日志失败：${err.message}`);
      this.emit('logError', err);
      return null;
    }

    let edge = null;
    try {
      this.projection.apply(record);
      edge = this.projection.lastEdge;
    } catch (err) {
      // 投影出错不能影响收包，日志已经存下了，重启就能重算
      this.log.error(`[${this.realRoomId}] 投影失败：${err.message}`);
    }

    /**
     * 观众簿记账。
     *
     * 放在这里而不是插件里：插件关了、被禁用了，观众簿也得继续记 ——
     * 否则"关掉欢迎一个月再打开"，整个房间的观众全变陌生人。
     *
     * `_visit` 是**派生字段**，只挂在这个内存对象上：`append()` 已经把它
     * 序列化过了，所以它不会写进日志（日志里只有原始报文归一化后的 payload）。
     * 前端会收到这个字段，但没人读它，几十字节而已。
     *
     * 只挂在 ENTER 上：欢迎插件用它区分"新观众 / 欢迎回来"。
     * 其余几类（礼物、上舰、SC、关注、分享）也记账，但**不带 visit** ——
     * 它们同样说明"这个人在场"，却没人会去读那份额外的派生字段，
     * 每条都挂一份只是白占内存缓冲。
     *
     * **弹幕和点赞刻意不记**（见 `ROSTER_EVENTS` 的注释）：它们太频繁，
     * 会把 `lastSeenAt` 刷成"现在"，"多久没来了"这个判断就废了。
     */
    if (this.roster && ROSTER_EVENTS.has(record.type)) {
      const p = record.payload ?? {};
      try {
        const visit = this.roster.mark(p.uid, p.uname, record.ts);
        if (record.type === EVENT.ENTER) record._visit = visit;
      } catch (err) {
        // 记账失败不该影响发事件：这个人这一场被当成第一次来，仅此而已
        this.log.warn(`[${this.realRoomId}] 观众簿记账失败：${err.message}`);
      }
    }

    /**
     * 记住"刚说过话的人"。只用于主动招呼挑人：
     * 观众簿记的是来过，这里记的是此刻还在。
     * 跳过机器人自己，否则会 @ 到自己。
     */
    if (record.type === EVENT.DANMAKU) {
      const p = record.payload ?? {};
      const uid = String(p.uid ?? '').trim();
      const name = String(p.uname ?? '').trim();
      const selfUid = String(this.client?.uid ?? '');
      if (/^\d{1,20}$/.test(uid) && name && uid !== selfUid) {
        this._speakers.set(uid, { uid, name, lastSpokeAt: record.ts });
        if (this._speakers.size > 500) {
          const first = this._speakers.keys().next().value;
          if (first !== undefined) this._speakers.delete(first);
        }
      }
    }

    /**
     * 标题变更要立刻反映到 `info.title` —— 页头（brief）、房间总览
     * （roomsList）、开播提醒都读它。info 只在 start() 填过一次，
     * 不在这里跟的话，标题会停在启动那一刻，进程活多久就旧多久。
     */
    if (record.type === EVENT.ROOM_TITLE) {
      const t = String(record.payload?.title ?? '').trim();
      if (t && this.info && this.info.title !== t) this.info.title = t;
    }

    this.emit('event', record, raw, edge);

    // 插件分发放在最后：即使插件全炸了，日志和统计都已经落定
    this._dispatchToPlugins(record, edge);

    return record;
  }

  /**
   * 最近说过话的人，按说话时间倒序。
   *
   * 只读、不写盘；超过窗口的不返回。给主动招呼挑人用 ——
   * 刚发过弹幕的人一定还在房间，B站 才会把 @ 挂出来。
   */
  recentSpeakers({ withinMs = 180_000, limit = 100, now = Date.now() } = {}) {
    const cap = Math.max(0, Math.min(500, Math.floor(Number(limit) || 0)));
    if (cap === 0) return [];

    const out = [];
    for (const rec of this._speakers.values()) {
      const age = now - rec.lastSpokeAt;
      if (!Number.isFinite(age) || age < 0 || age > withinMs) continue;
      out.push({ uid: rec.uid, name: rec.name, lastSpokeAt: rec.lastSpokeAt });
    }
    out.sort((a, b) => b.lastSpokeAt - a.lastSpokeAt);
    return out.slice(0, cap);
  }

  /**
   * 把事件交给插件。
   *
   * 不 await —— 收包不能等插件，直播场景里丢包比延迟更糟。
   * 但**顺序不能靠运气**：用 host.deliver() 入队，由宿主保证
   * "插件看到的事件顺序 = 日志顺序"。直接 fire-and-forget 调 dispatch()
   * 会让两条事件并发进同一个插件，把连击计数之类的内部状态搅乱。
   */
  _dispatchToPlugins(record, edge) {
    if (!this.host || PLUGIN_INVISIBLE.has(record.type)) return;

    this.host
      .deliver(record, edge, (r) => this.emit('claimed', r))
      .catch((err) => {
        this.log.error(`[${this.realRoomId}] 事件投递失败：${err.message}`);
      });
  }

  async stop() {
    this.started = false;
    if (this.client) {
      this.client.stop();
      this.client = null;
    }
    if (this.host) {
      await this.host.stopAll().catch(() => {});
      this.host = null;
    }
    if (this.log_) {
      this.log_.close();
    }
  }

  /** 当前统计（来自投影，与日志严格一致） */
  stats() {
    return this.projection ? this.projection.snapshot() : null;
  }

  snapshot() {
    return {
      inputRoomId: this.inputRoomId,
      realRoomId: this.realRoomId,
      /** 房间标题与开播状态分开给：之前这里把 liveState 塞进了 title，读的人会以为拿的是标题 */
      title: this.info ? String(this.info.title ?? '') : '',
      liveState: this.info ? String(this.info.liveState ?? '') : '',
      connection: this.client ? this.client.snapshot() : null,
      stats: this.stats(),
      log: this.log_ ? this.log_.stats() : null,
      gate: this.gate ? this.gate.snapshot() : null,
      plugins: this.host ? this.host.snapshot() : null,
    };
  }
}

export default RoomRunner;
