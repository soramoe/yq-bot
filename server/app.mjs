/**
 * 应用层：把"一个房间的运行体"包装成"可以被 HTTP 查询的进程"。
 *
 * 分层用意：
 *   RoomRunner  只关心 B站 → 事件 → 日志 → 投影
 *   App         只关心 装配、配置、对外状态、事件广播
 *   http/*      只关心 协议
 *
 * 这样以后加第二个房间、加定时任务、加战报生成，都只动这一层。
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';

import { AuthStore } from './auth.mjs';
import { RoomRunner } from './room-runner.mjs';
import { reconcile, formatReport } from './core/reconcile.mjs';
import { AccessGuard } from './core/access.mjs';
import { UpdateChecker } from './core/update.mjs';
import { buildDiagnostic } from './core/diagnostic.mjs';
import { maskWebhook, notifyText, reportText, sendWebhook } from './core/notify.mjs';
import { buildScQueue, MAX_READ_IDS } from './core/sc-queue.mjs';
import {
  MAX_SONG_ITEMS,
  applySongAction,
  parseSongRequest,
  pushSong,
  songPosition,
  songQueueView,
} from './core/song-queue.mjs';
import {
  GOAL_TIERS,
  MAX_GOAL_BATTERY,
  goalMilestone,
  goalText,
} from './core/goal.mjs';
import {
  MAX_BIG_SPEND_BATTERY,
  PATRON_RETURN_DAYS,
  bigSpendText,
  moneyText,
  paidBatteryOf,
  patronNameOf,
} from './core/patrons.mjs';
import { verifyCookie } from './bili/login.mjs';

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };

/** 内存里保留多少条事件，供页面回看与断线补发。
 *  一场直播几千条，5000 条大约 3–5MB，足够覆盖最常见的"切标签页几分钟"。 */
const MAX_BUFFER = 5000;

/**
 * 同时最多跑几个房间。
 *
 * 每个房间 = 一条长连 + 一个插件宿主 + 一份投影，插件还会各自起定时器。
 * 10 个在普通机器上是几 MB 内存和几条长连，够用；再多就该考虑
 * "这不是一台机器该干的事"了（先按 10 个设计，见 Q4）。
 */
const MAX_ROOMS = 10;

/** 房间号：纯数字，1–12 位。前后端共用这一条判断 */
export function normalizeRoomId(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,12}$/.test(s)) {
    throw Object.assign(new Error('房间号必须是纯数字'), { status: 400, code: 'bad_room' });
  }
  // 去掉前导零："00123" 和 "123" 是同一个房间，不能各开一份
  return s.replace(/^0+(?=\d)/, '');
}

export class App {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {number|string} opts.roomId
   * @param {boolean} [opts.dryRun]
   * @param {string|null} [opts.pluginsDir]
   * @param {object} [opts.log]
   * @param {(args:object)=>import('./room-runner.mjs').RoomRunner} [opts.createRunner]
   *   运行体工厂。默认就是 `new RoomRunner`；测试注入假的，就不必连 B站。
   */
  constructor({ dataDir, roomId, dryRun = true, pluginsDir = null, log = SILENT_LOG, createRunner = null, fetchImpl = null }) {
    this.dataDir = dataDir;
    this.pluginsDir = pluginsDir;
    this.log = log;
    this.createRunner = createRunner ?? ((args) => new RoomRunner(args));
    /** webhook 用的 fetch：默认用全局的，自检里注入记录器 */
    this.fetchImpl = fetchImpl;

    this.roomId = roomId;
    this.dryRun = dryRun;

    /**
     * 插件配置：{ pluginId: { key: value } }。
     *
     * 存在 App 而不是 Runner：切房间会重建 Runner，但"欢迎语怎么说"这件事
     * 跟房间无关。放在 Runner 里，换个房间用户的设置就没了。
     */
    this.pluginConfigs = {};
    /** 宿主级禁用：{ pluginId: false }。没出现在这里 = 启用 */
    this.pluginEnabled = {};

    /**
     * 明文日志保留天数。更早的分片在启动时压成 .gz（只压不删）。
     *
     * 默认 30 天：一周前的直播基本只剩"翻一眼"的用途，
     * 而明文留一个月足够排查绝大多数问题。
     */
    this.logKeepDays = 30;

    /**
     * 观众簿保留天数。和日志不一样：这里超期是**整片删除**，
     * 因为"多久没来算陌生人"本来就是按天算的，逐条过期没有意义。
     *
     * 默认 90 天，比欢迎插件的 `returningDays`（默认 30）宽三倍 ——
     * 留点余量，用户把 30 改成 60 时不用回头改这里。
     */
    this.rosterKeepDays = 90;

    /**
     * 更新源地址。空 = 没配，检查时明确说"没配"而不是假装查过了。
     *
     * 存在这里而不是写死在 core/update.mjs：它属于"这台机器的设置"，
     * 和房间号、演练模式一样会随 app.json 落盘。
     */
    this.updateUrl = '';

    /**
     * 开播 / 下播提醒的 webhook 地址。空 = 只在页面上弹 toast。
     * 企微 / 钉钉 / 飞书机器人的地址都可以（载荷形状按域名区分）。
     * 同 updateUrl：属于这台机器的设置，随 app.json 落盘。
     */
    this.notifyWebhook = '';

    /**
     * 下播后是否把本场战报也发到同一个 webhook。
     *
     * 默认关：已经配了开播/下播提醒的人，不该在升级后突然被多推一条长消息。
     * 战报要读 `runner.projection` 里刚封存的那一场，没有 webhook 时无从外发，
     * 所以这两项是一组的（`setNotifySettings` 会拒绝"只开战报不填地址"）。
     */
    this.notifyReport = false;

    /**
     * 单笔大额提醒的阈值（电池，0 = 关闭）。
     *
     * 只按**单条事件**判断，不按"同一个人这一场累计"：
     * 累计口径需要维护一张跨事件的状态表，而"这一笔就很大"才是当场该反应的事。
     * 页内 toast 照发；配了 webhook 时再外发。1 元 = 10 电池。
     */
    this.bigSpendBattery = 0;

    /**
     * 本场礼物目标（电池，0 = 关闭）。
     *
     * "本场"以投影当前场次为准：下播再开就是新的一轮，进度从 0 开始。
     * 目标属于这台机器（所有房间共用一个），因为主播通常只有一个价目表。
     */
    this.giftGoalBattery = 0;

    /**
     * 四档里程碑的自定义文案：`{ "30": "还差一点…", "100": "…" }`。
     *
     * 只挂在 30 / 60 / 80 / 100 上；空串或没写的档用默认文案。
     * 属这台机器（与目标金额同一份配置），换房间不用重填。
     */
    this.giftGoalTexts = {};

    /**
     * 过线时是否在弹幕里播报。
     *
     * 默认开：设了目标却完全没声，观众不知道进度走到哪了。
     * 不想说话的人可以在面板里关掉，页内提示与挂件进度条仍然在。
     */
    this.giftGoalAnnounce = true;

    /** 已经播报过的里程碑：`<房间>:<场次>:<百分比>`，防同一场重复喊 */
    this._goalSaid = new Set();

    /**
     * 付费用户回访提醒的累计门槛（电池，0 = 关闭）。
     *
     * "回访"只看**这场开播之前**的付费记录：本场刚送过礼的人不算回访，
     * 那是正在发生的事，大额提醒/答谢已经在处理了。
     * 数据来自日志重放（投影的场次明细只保留礼物，舰长/SC 看不到）。
     */
    this.patronReturnBattery = 0;

    /** 当前场次的回访索引：{ key, map }。懒加载，换场/改门槛后重建 */
    this._patronIndex = null;
    /** 正在预热/已预热的 key，防止 ENTER 洪峰时重复读日志 */
    this._patronWarmKey = '';
    /** 同一场同一个人只提醒一次 */
    this._patronSaid = new Set();

    /**
     * SC 待读：已读事件 id 集合。懒加载，读失败就当全没读过。
     *
     * id 自带房间前缀（`e<roomId>-<seq>`），多房间共用一个集合也不会串。
     * 它只是清单的投影：不参与统计，删了也只是"重新变成未读"。
     */
    this._scReadIds = null;

    /**
     * SC 点歌队列。状态是"播放中/排队中"这类人工动作，没法从日志重放出来，
     * 所以单独存 `data/songs.json`；懒加载，读失败当空队列。
     */
    this.songQueue = [];
    this._songsLoaded = false;

    /** 版本号要最先就位：下面的 UpdateChecker 构造时就要用 */
    this.version = readVersion();

    /** @type {import('./room-runner.mjs').RoomRunner|null} 当前页面在看的那个房间 */
    this.runner = null;

    /**
     * 同时在跑的房间。
     *
     * 键是**用户输入的那个房间号**（短号也行），值是这个房间在 App 层的全部家当：
     *   { key, runner, events, oldestSeq }
     *
     * 为什么按输入号做键：开房间时还不知道真实号（短号要联网解析），
     * 而"用户下次还会打的那串数字"就是它。查房间时两个号都认（`_findRoom`），
     * 否则先打短号、再打真实号，同一个房间会被开成两份 —— 长连翻倍、
     * 日志写进两个目录、统计变成两半。
     *
     * 事件缓冲也放在这里而不是 App 上：切到后台的房间不能丢它的事件，
     * 否则切回来就是一片空白，只能靠"重新读日志"补，而那是同步 IO。
     */
    this.rooms = new Map();
    /** 当前在看哪个房间（键）。WS 只推这个房间的事件 */
    this.activeKey = '';

    /**
     * 访问口令。默认不启用（D13：拿到真实用户之前不设门槛），
     * 但**跨站写操作由 Origin 检查挡住**，那一条不需要用户做任何事。
     */
    this.access = new AccessGuard({ dataDir });

    /** 更新检查器。getUrl 每次现取，改完配置立刻生效，不用重启 */
    this.update = new UpdateChecker({ current: this.version, getUrl: () => this.updateUrl });

    /** 最近一次凭证校验结果。给页面显示"上次查是什么时候、结论是什么" */
    this._authCheck = null;

    this.startedAt = Date.now();

    /** @type {Set<(msg:object)=>void>} */
    this._subs = new Set();

    this._switching = false;
    this._tickTimer = null;
    this._rosterTimer = null;
  }

  /* ────────────────────────── 生命周期 ────────────────────────── */

  /**
   * @param {{roomFromCli?:boolean, dryRunFromCli?:boolean}} [opts]
   *   CLI 显式给的参数优先于配置文件；没给的才用上次记住的值。
   *   两边都"配置文件优先"会让 `--live` 静默失效，那种 bug 最难察觉。
   */
  async start({ roomFromCli = false, dryRunFromCli = false } = {}) {
    const cfg = this._loadConfig();
    if (!roomFromCli && cfg.roomId) this.roomId = cfg.roomId;
    if (!dryRunFromCli && typeof cfg.dryRun === 'boolean') this.dryRun = cfg.dryRun;

    // 插件配置没有 CLI 覆盖的概念：命令行不该塞一个 JSON
    if (cfg.plugins && typeof cfg.plugins === 'object') this.pluginConfigs = cfg.plugins;
    if (cfg.pluginEnabled && typeof cfg.pluginEnabled === 'object') {
      this.pluginEnabled = cfg.pluginEnabled;
    }
    // 归档窗口也要能配：不同人一场的弹幕量差几十倍，写死一个天数不现实
    if (Number.isFinite(cfg.logKeepDays) && cfg.logKeepDays >= 1) {
      this.logKeepDays = Math.floor(cfg.logKeepDays);
    }
    // 观众簿保留期同理：`returningDays` 说"多久没来算新观众"，
    // 簿子至少要留这么久，否则判断会被剪枝悄悄截断
    if (Number.isFinite(cfg.rosterKeepDays) && cfg.rosterKeepDays >= 1) {
      this.rosterKeepDays = Math.floor(cfg.rosterKeepDays);
    }
    // 更新源：空字符串也算有效值（用户主动清空 = 不要检查更新）
    if (typeof cfg.updateUrl === 'string') this.updateUrl = cfg.updateUrl.trim().slice(0, 500);
    // 提醒 webhook 同理：空 = 关闭提醒的外发，页内 toast 照旧。
    // 但不能像 updateUrl 那样静默截断：截断后的 URL 看起来能发，实际每次都失败，
    // 用户还会以为"配置还在"。写坏就忽略并说一声，别拿半截地址去请求。
    if (typeof cfg.notifyWebhook === 'string') {
      const raw = cfg.notifyWebhook.trim();
      if (!raw) {
        this.notifyWebhook = '';
      } else if (raw.length > 500 || !/^https?:\/\/\S+$/i.test(raw)) {
        this.log.warn('[配置] data/app.json 里的提醒 webhook 无效或过长，已忽略（页内提醒不受影响）');
        this.notifyWebhook = '';
      } else {
        this.notifyWebhook = raw;
      }
    }
    if (typeof cfg.notifyReport === 'boolean') this.notifyReport = cfg.notifyReport;
    // 没有地址就没有"发到哪儿"：手工改配置改出的半套状态要收掉
    if (!this.notifyWebhook) this.notifyReport = false;

    // 大额提醒阈值：只接受 0..MAX 的整数。写坏了就当没配（0=关），
    // 不能截断成半截数字 —— 那会变成"每笔都提醒"或"永远不提醒"，且没人看得出来
    if (cfg.bigSpendBattery !== undefined) {
      if (
        Number.isInteger(cfg.bigSpendBattery) &&
        cfg.bigSpendBattery >= 0 &&
        cfg.bigSpendBattery <= MAX_BIG_SPEND_BATTERY
      ) {
        this.bigSpendBattery = cfg.bigSpendBattery;
      } else {
        this.log.warn(
          '[配置] data/app.json 里的 bigSpendBattery 无效（0..1000000000 的整数），已忽略',
        );
      }
    }

    // 本场礼物目标：同样只收 0..MAX 的整数；写坏了当没配，不能截断
    if (cfg.giftGoalBattery !== undefined) {
      if (
        Number.isInteger(cfg.giftGoalBattery) &&
        cfg.giftGoalBattery >= 0 &&
        cfg.giftGoalBattery <= MAX_GOAL_BATTERY
      ) {
        this.giftGoalBattery = cfg.giftGoalBattery;
      } else {
        this.log.warn(
          '[配置] data/app.json 里的 giftGoalBattery 无效（0..1000000000 的整数），已忽略',
        );
      }
    }
    if (typeof cfg.giftGoalAnnounce === 'boolean') this.giftGoalAnnounce = cfg.giftGoalAnnounce;
    // 目标为 0 时没有"过线"可播报，开关跟着关掉，避免留下一个永远不生效的 true
    if (!this.giftGoalBattery) this.giftGoalAnnounce = false;

    // 每档的自定义文案：只认 30/60/80/100 四个键，值必须是字符串；写坏的单条忽略
    if (cfg.giftGoalTexts && typeof cfg.giftGoalTexts === 'object' && !Array.isArray(cfg.giftGoalTexts)) {
      const texts = {};
      for (const pct of GOAL_TIERS) {
        const raw = cfg.giftGoalTexts[String(pct)];
        if (typeof raw !== 'string') continue;
        const text = raw.trim().slice(0, 80);
        if (text) texts[String(pct)] = text;
      }
      this.giftGoalTexts = texts;
    }

    // 回访提醒门槛：0..MAX 的整数，写坏了就当没配（0=关）
    if (cfg.patronReturnBattery !== undefined) {
      if (
        Number.isInteger(cfg.patronReturnBattery) &&
        cfg.patronReturnBattery >= 0 &&
        cfg.patronReturnBattery <= MAX_BIG_SPEND_BATTERY
      ) {
        this.patronReturnBattery = cfg.patronReturnBattery;
      } else {
        this.log.warn(
          '[配置] data/app.json 里的 patronReturnBattery 无效（0..1000000000 的整数），已忽略',
        );
      }
    }

    mkdirSync(this.dataDir, { recursive: true });

    /**
     * 要跑哪几个房间。
     *
     * 优先级：命令行显式给 > 配置文件里记住的房间列表 > 配置文件里的单个 roomId。
     * 命令行给了就**只跑那一个** —— `--room 123` 的意思是"这次就跑 123"，
     * 不是"再加上 123"。两边都留着一个会让启动行为取决于改没改过配置文件，
     * 那种不确定最难解释。
     */
    const wanted = roomFromCli
      ? [String(this.roomId)]
      : [...new Set(
          (Array.isArray(cfg.rooms) ? cfg.rooms : [])
            .map((x) => String(x))
            .filter((x) => /^\d{1,12}$/.test(x)),
        )].slice(0, MAX_ROOMS);
    if (wanted.length === 0) wanted.push(String(this.roomId));

    const remembered = wanted.includes(String(cfg.activeRoomId ?? ''))
      ? String(cfg.activeRoomId)
      : wanted[0];

    for (const key of wanted) {
      await this._bootRoom(key);
    }
    // 先激活记住的那个：页面打开时看到的就是上次在看的那间
    await this._activate(remembered, { silent: true });

    // 每秒推一次状态给前端。
    // 与事件流分开推：事件是"发生时"的，状态是"当前值"的，
    // 混在一条通道里就会让"丢了某条事件"和"数字不对"两件事分不清。
    this._tickTimer = setInterval(() => this._pushStats(), 1000);
    this._tickTimer.unref?.();

    // 长时间不重启的机器（挂一两个月那种）靠这个兜住。
    // 6 小时一次：遍历分片目录 + 一遍 Map，几毫秒，没必要更勤。
    // 每个房间一本簿子，都要剪。
    this._rosterTimer = setInterval(() => {
      for (const room of this.rooms.values()) room.runner?.roster?.prune();
    }, 6 * 3600_000);
    this._rosterTimer.unref?.();

    return this;
  }

  /**
   * 起一个房间的运行体，并登记进 `rooms`。
   *
   * 只装配、不激活 —— 激活是另一件事（`_activate`），因为启动时
   * 要把配置里的几个房间都起起来，但页面只能看其中一个。
   */
  async _bootRoom(key) {
    const auth = new AuthStore({ dataDir: this.dataDir }).load();
    if (!auth.loggedIn) {
      this.log.warn(`[${key}] 没有登录凭证，将只能以游客身份连接（5 分钟后用户名会被打码）`);
    }

    const runner = this.createRunner({
      roomId: key,
      cookie: auth.cookie,
      dataDir: this.dataDir,
      log: this.log,
      dryRun: this.dryRun,
      pluginsDir: this.pluginsDir,
      pluginConfigs: this.pluginConfigs,
      pluginEnabled: this.pluginEnabled,
      logKeepDays: this.logKeepDays,
      rosterKeepDays: this.rosterKeepDays,
    });

    /** 这个房间在 App 层的家当。先登记再启动：启动过程中就可能来事件 */
    const room = { key, runner, events: [], oldestSeq: 0 };
    this.rooms.set(key, room);

    /**
     * 所有回调都绑到**这个房间**上，不再读 `this.runner`。
     *
     * 读 `this.runner` 的话，后台房间的事件会被记进当前房间的缓冲 ——
     * 两个房间的数字搅在一起，而页面上看不出任何异常。
     */
    runner.on('event', (rec, raw, edge) => this._onEvent(room, rec, edge));
    runner.on('claimed', (x) => {
      if (!this._isActive(room)) return;
      this._emit({ type: 'claimed', data: { by: x.by, seq: x.event.seq } });
    });
    runner.on('status', (s) => {
      if (!this._isActive(room)) return;
      this._emit({ type: 'conn', data: { status: s } });
    });
    runner.on('logError', (err) => {
      if (!this._isActive(room)) return;
      this._emit({ type: 'notice', data: { level: 'error', text: `写日志失败：${err.message}` } });
    });

    await runner.start().catch((err) => {
      // 连不上不能拖垮整个进程：页面还要能打开、还要能看到失败原因
      this.log.error(`启动房间 ${key} 失败：${err.message}`);
      if (this._isActive(room)) {
        this._emit({ type: 'notice', data: { level: 'error', text: `房间启动失败：${err.message}` } });
      }
    });

    // 观众簿剪枝放在启动路径上：进程重启比"连续跑满 6 小时"常见得多，
    // 只靠定时器的话，天天重启的机器永远等不到那一次
    try {
      runner.roster?.prune();
    } catch (err) {
      this.log.warn(`[${key}] 观众簿剪枝失败：${err.message}`);
    }

    // 预载最近事件，让页面一打开就有上下文，而不是白屏等下一辆公交车
    this._preload(room);

    await this._checkReconcile(room);
    return room;
  }

  /** 从日志预载最近 MAX_BUFFER 条到这个房间的内存缓冲 */
  _preload(room) {
    room.events = [];
    room.oldestSeq = 0;

    if (!room.runner?.log_) return;

    const t0 = Date.now();
    try {
      const all = room.runner.log_.readAll();
      /** 预载时读到的全量，直接留给对账复用 —— 否则启动要把整份日志读两遍 */
      room.preloadAll = all;
      room.events = all.length > MAX_BUFFER ? all.slice(-MAX_BUFFER) : all;
      room.oldestSeq = room.events[0]?.seq ?? 0;
      this.log.info(
        `[${room.key}] 预载 ${room.events.length} 条事件到内存（日志共 ${all.length} 条，耗时 ${Date.now() - t0}ms）`,
      );
    } catch (err) {
      // 预载失败不该阻止服务启动：补发拿不到历史，但实时流还能用
      this.log.error(`[${room.key}] 预载事件失败：${err.message}`);
    }
  }

  /**
   * 每次启动做一次对账。
   *
   * 这是"统计可信"的唯一硬证明，也是唯一能发现"投影漏了某类事件"的办法。
   * 不等程序出错才查 —— 每次重启都主动算一遍，差异立刻暴露。
   */
  async _checkReconcile(room) {
    const runner = room?.runner;
    if (!runner?.log_ || !runner.projection) return null;
    try {
      const events = room.preloadAll ?? runner.log_.readAll();
      // 用完就放掉：这份是启动瞬间的快照，之后的实时事件不在里面
      room.preloadAll = null;
      const snapshot = runner.stats();
      const report = reconcile({ events: upTo(snapshot, events), snapshot });
      if (report.ok) {
        this.log.info(`[${room.key}] 对账通过：本场、总累计与日志逐条累加一致`);
      } else {
        // 对不上是"数据会说谎"的信号，必须出现在日志里，不能只在页面上闪一下
        this.log.error(`对账失败：\n${formatReport(report)}`);
      }
      return report;
    } catch (err) {
      this.log.warn(`对账执行失败：${err.message}`);
      return null;
    }
  }

  async stop() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._rosterTimer) {
      clearInterval(this._rosterTimer);
      this._rosterTimer = null;
    }
    // 所有房间都要停：只停当前那个的话，后台房间的长连会一直挂着，
    // 进程看起来"退出"了却又被 keep-alive 拖住
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    this.activeKey = '';
    this.runner = null;
    for (const room of rooms) {
      await room.runner?.stop().catch(() => {});
    }
  }

  /* ────────────────────────── 配置 ────────────────────────── */

  _configPath() {
    return join(this.dataDir, 'app.json');
  }

  _loadConfig() {
    const path = this._configPath();
    let mainError = null;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      mainError = err;
    }
    // 主配置被写坏时退到上一次的备份，不能默默当成"什么都没配"，
    // 否则用户重启后会看到房间、webhook、阈值全部凭空消失。
    try {
      const backup = JSON.parse(readFileSync(`${path}.bak`, 'utf8'));
      this.log.warn('[配置] data/app.json 读不出来，已从上一次备份 app.json.bak 恢复');
      return backup;
    } catch {
      // 第一次启动没有配置文件是正常情况，不刷 warning；
      // 但如果主文件存在却读不出来、备份也没了，就是真的丢配置了，必须说出来。
      if (mainError?.code !== 'ENOENT') {
        this.log.warn('[配置] data/app.json 与 app.json.bak 都读不出来，按空配置启动');
      }
      return {};
    }
  }

  _saveConfig() {
    const data = JSON.stringify(
      {
        roomId: this.roomId,
        /** 同时在跑的房间（键）。只留一个时也要写，重启后才回到"就这一个" */
        rooms: [...this.rooms.keys()],
        /** 上次页面在看的那个。重启后打开的还是它 */
        activeRoomId: this.activeKey,
        dryRun: this.dryRun,
        plugins: this.pluginConfigs,
        pluginEnabled: this.pluginEnabled,
        logKeepDays: this.logKeepDays,
        rosterKeepDays: this.rosterKeepDays,
        updateUrl: this.updateUrl,
        notifyWebhook: this.notifyWebhook,
        notifyReport: this.notifyReport,
        bigSpendBattery: this.bigSpendBattery,
        patronReturnBattery: this.patronReturnBattery,
        giftGoalBattery: this.giftGoalBattery,
        giftGoalAnnounce: this.giftGoalAnnounce,
        giftGoalTexts: this.giftGoalTexts,
      },
      null,
      2,
    );
    const path = this._configPath();
    const tmp = `${path}.tmp`;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      // 先留上一份好配置：原子写只防"写了一半"，防不了"内容被改坏"。
      // 但**坏掉的 app.json 不配当备份** —— 用户手改坏了文件，下一次保存
      // 不能把上一份能读的 .bak 也覆盖掉，否则两个一起坏，配置彻底没了。
      try {
        const current = readFileSync(path, 'utf8');
        JSON.parse(current);
        copyFileSync(path, `${path}.bak`);
      } catch {
        // 没有旧文件，或旧文件本身已经坏了：保留已有的 .bak
      }
      // 原子写：先写临时文件再改名，避免断电留下半个 JSON 文件
      writeFileSync(tmp, data, 'utf8');
      renameSync(tmp, path);
      return true;
    } catch (err) {
      this.log.warn(`保存配置失败：${err.message}`);
      return false;
    }
  }

  /* ────────────────────── 醒目留言待读 ────────────────────── */

  _scReadPath() {
    return join(this.dataDir, 'sc-read.json');
  }

  _loadScRead() {
    if (this._scReadIds) return this._scReadIds;
    try {
      const raw = JSON.parse(readFileSync(this._scReadPath(), 'utf8'));
      const ids = Array.isArray(raw?.ids) ? raw.ids.filter((x) => typeof x === 'string' && x.trim()) : [];
      this._scReadIds = new Set(ids.slice(-MAX_READ_IDS));
    } catch {
      // 文件不存在（第一次用）或坏掉都不该影响服务：当作全没读过
      this._scReadIds = new Set();
    }
    return this._scReadIds;
  }

  /** 给接口用的只读副本：调用方不能直接改内部 Set */
  scReadIds() {
    return new Set(this._loadScRead());
  }

  /**
   * 标记若干条 SC 为已读，返回真正新增的条数。
   *
   * 写盘失败会把内存里的标记回滚并抛 500 —— 只回 ok 不落盘的话，
   * 下次重启已读状态全丢，用户会以为"点过了又变回未读"。
   */
  markScRead(ids) {
    const set = this._loadScRead();
    // 写盘失败要能整份回滚：包括"超过上限挤掉的最早几条"
    const before = [...set];
    const added = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id !== 'string') continue;
      const key = id.trim();
      if (!key || set.has(key)) continue;
      set.add(key);
      added.push(key);
    }
    if (!added.length) return 0;

    // Set 按插入顺序迭代：超过上限就丢最早标记的那些
    while (set.size > MAX_READ_IDS) set.delete(set.values().next().value);
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const path = this._scReadPath();
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ids: [...set] }, null, 2), 'utf8');
      renameSync(tmp, path);
    } catch (err) {
      this._scReadIds = new Set(before);
      this.log.warn(`保存醒目留言已读状态失败：${err.message}`);
      throw { status: 500, code: 'save_failed', message: '保存已读状态失败：写不进 data/sc-read.json' };
    }
    return added.length;
  }

  /* ────────────────────── SC 点歌队列 ────────────────────── */

  _songsPath() {
    return join(this.dataDir, 'songs.json');
  }

  _loadSongs() {
    if (this._songsLoaded) return this.songQueue;
    this._songsLoaded = true;
    try {
      const raw = JSON.parse(readFileSync(this._songsPath(), 'utf8'));
      const items = Array.isArray(raw?.items) ? raw.items : [];
      this.songQueue = items
        .filter(
          (it) =>
            it &&
            typeof it === 'object' &&
            typeof it.id === 'string' &&
            it.id.trim() &&
            typeof it.song === 'string' &&
            it.song.trim() &&
            (it.status === 'queued' || it.status === 'playing'),
        )
        .slice(-MAX_SONG_ITEMS)
        .map((it) => ({
          id: it.id,
          seq: Number(it.seq) || 0,
          ts: Number(it.ts) || 0,
          uid: String(it.uid ?? ''),
          name: String(it.name ?? ''),
          song: String(it.song),
          yuan: Number(it.yuan) || 0,
          status: it.status,
        }));
    } catch {
      // 第一次用、文件坏了：当空队列，不影响开播
      this.songQueue = [];
    }
    return this.songQueue;
  }

  songsView() {
    return songQueueView(this._loadSongs());
  }

  _broadcastSongs() {
    this._emit({ type: 'songs', data: this.songsView() });
  }

  _saveSongs() {
    mkdirSync(this.dataDir, { recursive: true });
    const path = this._songsPath();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ items: this.songQueue }, null, 2), 'utf8');
    renameSync(tmp, path);
  }

  /**
   * 一条 SC 进来时尝试收进点歌队列。
   *
   * 只处理当前房间：后台房间的 SC 如果也往同一个队列塞，页面上会突然多出
   * 一首没听见点歌过程的歌。拦截发生在"是否活跃"这一层，而不是解析之前。
   */
  _enqueueSong(room, rec) {
    if (!room || !rec || !this._isActive(room)) return;
    const request = parseSongRequest(rec);
    if (!request) return;

    const item = pushSong(this._loadSongs(), request, rec);
    if (!item) return;

    try {
      this._saveSongs();
    } catch (err) {
      this.log.warn(`[点歌] 保存队列失败：${err.message}`);
    }
    this._broadcastSongs();

    const pos = songPosition(this.songQueue, item.id);
    const text = pos <= 1 ? `已点歌：${item.song}（下一首）` : `已点歌：${item.song}（第 ${pos} 位）`;
    this.log.info(`[点歌] ${item.name}：${item.song}`);
    Promise.resolve(room.runner?.gate?.say?.({
      roomId: room.runner?.realRoomId ?? room.key,
      text,
      reason: 'song_queue',
      source: 'songs',
      priority: 1,
      maxWaitMs: 5000,
    })).catch((err) => this.log.warn(`[点歌] 播报失败：${err?.message ?? err}`));
  }

  /**
   * 播放 / 完成 / 跳过。
   *
   * 状态变化必须落盘：这是人工看过队列之后做的决定，重启后不能回到
   * "这首歌又排在队首"。落盘失败就整份回滚并报 500，不能页面显示成功、
   * 实际没存。
   */
  songAction(id, action) {
    this._loadSongs();
    const before = this.songQueue.map((it) => ({ ...it }));
    const item = applySongAction(this.songQueue, id, action);
    if (!item) throw { status: 404, code: 'song_not_found', message: '队列里没有这首歌' };

    if (action === 'play') {
      const text = `接下来播放：${item.song}`;
      Promise.resolve(this.runner?.gate?.say?.({
        roomId: this.runner?.realRoomId ?? '',
        text,
        reason: 'song_play',
        source: 'songs',
        priority: 1,
        maxWaitMs: 5000,
      })).catch((err) => this.log.warn(`[点歌] 播报失败：${err?.message ?? err}`));
    }

    try {
      this._saveSongs();
    } catch (err) {
      this.songQueue = before;
      this.log.warn(`[点歌] 保存队列失败：${err.message}`);
      throw { status: 500, code: 'save_failed', message: '保存点歌队列失败：写不进 data/songs.json' };
    }
    this._broadcastSongs();
    return item;
  }

  /** 演练模式开关。等价于"这台机器今天是否允许真的说话"。 */
  setDryRun(dryRun) {
    const v = Boolean(dryRun);
    /**
     * **每个房间都要改**，不是只改当前这个。
     *
     * 这个开关回答的是"这台机器今天允不允许真的说话"，与"页面在看哪一间"无关。
     * 只改当前房间的后果特别阴：用户点了"切到演练模式"，界面上确实显示已静音，
     * 而后台那几个房间的闸门还停在真实发送 —— 它们照样把话发到直播间，
     * 全程没有任何报错，只有事后翻日志才发现"那几句不该发"。
     */
    for (const room of this.rooms.values()) {
      const r = room.runner;
      if (!r) continue;
      if (r.gate) r.gate.update({ dryRun: v });
      r.dryRun = v;
    }
    // 即便 rooms 是空的（启动中、刚退登），App 上这个值也要改：
    // 之后每起一间都用它，开关不能空转
    this.dryRun = v;
    this._saveConfig();
    this._emit({ type: 'notice', data: { level: 'info', text: v ? '已切到演练模式（不真的发弹幕）' : '已切到真实发送模式' } });
    this._pushStats();
    return v;
  }

  /**
   * 把一次插件配置变更同步到**除当前房间之外**的所有宿主。
   *
   * 为什么要逐个同步：插件配置存在 App 上（文案属于主播人设，换个直播间
   * 不该变成另一套话），但真正读它的是每个房间**各自**的 PluginHost ——
   * 每个宿主在启动时把配置 coerce 了一份自己的副本。
   *
   * 只改当前那间的结果是：切到后台房间看到旧文案，切回来又对了。
   * 用户只会觉得"设置有时候生效有时候不生效"，而代码里没有任何一处会报错。
   *
   * 单个宿主出错只记日志、不抛出：已经有一间改成功了，
   * 为了一间失败把整次请求回滚反而更混乱（用户会看到"改失败但值变了"）。
   */
  _syncHosts(exceptHost, fn) {
    for (const room of this.rooms.values()) {
      const host = room.runner?.host;
      if (!host || host === exceptHost) continue;
      try {
        fn(host);
      } catch (err) {
        this.log.warn(`[${room.key}] 同步插件配置失败：${err.message}`);
      }
    }
  }

  /* ────────────────────────── 插件配置 ────────────────────────── */

  /** 插件全貌：含 config（当前生效值）、fields（schema）、stats */
  pluginSnapshot() {
    return this.runner?.host?.snapshot() ?? { dir: null, count: 0, errors: [], plugins: [] };
  }

  /**
   * 改插件配置。
   *
   * **只存用户改过的那几个键**，不存完整配置。
   * 存完整配置的话，用户第一次点开面板就会把所有默认值固化成"用户设置"，
   * 之后插件升级改了默认文案，老用户永远看不到新文案，而且没有任何提示。
   *
   * 写盘之后立刻广播：同一台机器的其他标签页也要看到，否则两个标签页
   * 会各自显示不同的值，谁对谁错看不出来。
   */
  updatePluginConfig(id, patch) {
    const host = this.runner?.host;
    if (!host) throw Object.assign(new Error('房间还没启动，无法改插件配置'), { status: 503 });

    const next = host.updateConfig(id, patch);
    if (!next) throw Object.assign(new Error(`没有这个插件：${id}`), { status: 404 });

    // 其余房间的宿主也要跟上，否则切过去看到的是旧文案（见 _syncHosts）
    this._syncHosts(host, (h) => h.updateConfig(id, patch));

    const diff = {};
    for (const [k, v] of Object.entries(patch ?? {})) diff[k] = next[k];
    this.pluginConfigs = { ...this.pluginConfigs, [id]: { ...(this.pluginConfigs[id] ?? {}), ...diff } };

    this._saveConfig();
    this._emit({ type: 'plugins', data: { reason: 'config', id } });
    this.log.info(`插件配置已更新：${id} → ${JSON.stringify(diff)}`);
    return next;
  }

  /** 恢复 manifest 默认值：连磁盘上的增量一起删掉 */
  resetPluginConfig(id) {
    const host = this.runner?.host;
    if (!host) throw Object.assign(new Error('房间还没启动，无法改插件配置'), { status: 503 });

    const next = host.resetConfig(id);
    if (!next) throw Object.assign(new Error(`没有这个插件：${id}`), { status: 404 });

    this._syncHosts(host, (h) => h.resetConfig(id));

    const rest = { ...this.pluginConfigs };
    delete rest[id];
    this.pluginConfigs = rest;

    this._saveConfig();
    this._emit({ type: 'plugins', data: { reason: 'reset', id } });
    this.log.info(`插件配置已恢复默认：${id}`);
    return next;
  }

  /**
   * 宿主级启用/禁用。
   *
   * 与插件的 `config.enabled` 不同：这里是"这个插件根本不参与认领"。
   * 两者都要有，因为"暂时不想让盲盒播报说话"和"这个功能我彻底不要"
   * 是两种意图，混成一个开关会让用户关掉之后不知道怎么恢复。
   */
  setPluginEnabled(id, enabled) {
    const host = this.runner?.host;
    if (!host) throw Object.assign(new Error('房间还没启动，无法改插件状态'), { status: 503 });

    if (!host.setEnabled(id, enabled)) {
      throw Object.assign(new Error(`没有这个插件：${id}`), { status: 404 });
    }

    // 别的房间也得真的停掉 —— 只改当前这间等于"关了个寂寞"
    this._syncHosts(host, (h) => h.setEnabled(id, enabled));

    const on = Boolean(enabled);
    const next = { ...this.pluginEnabled };
    if (on) delete next[id];
    else next[id] = false;
    this.pluginEnabled = next;

    this._saveConfig();
    this._emit({ type: 'plugins', data: { reason: 'enabled', id } });
    this.log.info(`插件已${on ? '启用' : '停用'}：${id}`);
    return { id, enabled: on };
  }

  /* ────────────────────────── 房间 ────────────────────────── */

  /** 按输入号或真实号找一个已在跑的房间；都没有返回 null */
  _findRoom(id) {
    const key = String(id ?? '').trim();
    if (!key) return null;
    const byKey = this.rooms.get(key);
    if (byKey) return byKey;
    // 短号会被解析成真实号：用户先打短号、再打真实号，是同一个房间
    for (const room of this.rooms.values()) {
      if (String(room.runner?.realRoomId ?? '') === key) return room;
    }
    return null;
  }

  /** 当前在看的那一间（可能还没激活） */
  _activeRoom() {
    return this.activeKey ? (this.rooms.get(this.activeKey) ?? null) : null;
  }

  _isActive(room) {
    return Boolean(room) && room.key === this.activeKey;
  }

  /**
   * 把某一间设成"页面在看的"。
   *
   * 只切指针，不碰运行体：后台房间一直连着、一直记日志，
   * 切回来是毫秒级的事，不需要重连 B站，也不需要重读日志。
   */
  async _activate(key, { silent = false } = {}) {
    const room = this._findRoom(key);
    if (!room) {
      throw Object.assign(new Error(`没有这个房间：${key}`), { status: 404, code: 'no_room' });
    }
    if (this.activeKey === room.key && this.runner === room.runner) return this;

    this.activeKey = room.key;
    this.runner = room.runner;
    this.roomId = room.runner?.realRoomId || room.key;

    if (!silent) {
      // 让页面先清空，避免"新房间的第一条事件"接在旧房间的尾巴上
      this._emit({ type: 'reset', data: { roomId: String(this.roomId) } });
      this._pushStats();
    }
    this._saveConfig();
    // 切到哪间就预热哪间的回访索引；不 await，读日志不该挡住切房
    this._warmPatrons().catch((err) =>
      this.log.warn(`[回访] 预热失败：${err?.message ?? err}`),
    );
    return this;
  }

  /**
   * 切到某个房间；还没在跑就先开起来。
   *
   * 与二代最大的不同：**不停止旧房间**。停掉再起的话，回来时那一场
   * 中间断了一段，统计要靠重放补齐 —— 而且 B站 的长连也得重建，
   * 每次切换都要等几秒。多房间的意义恰恰是不用等。
   */
  async switchRoom(roomId) {
    const next = normalizeRoomId(roomId);
    if (this._switching) {
      throw Object.assign(new Error('正在切换房间，请稍候'), { status: 409 });
    }
    const existing = this._findRoom(next);
    if (existing) {
      // 上次启动失败过（断网、接口抖动）时，再点一次就该真的重试 ——
      // 否则用户只能"关掉再打开"，而关掉会连同它的缓冲一起丢掉
      await this._reviveRoom(existing);
      return this._activate(next).then(() => this.status());
    }

    if (this.rooms.size >= MAX_ROOMS) {
      throw Object.assign(new Error(`最多同时跑 ${MAX_ROOMS} 个房间，先关掉一个`), {
        status: 400,
        code: 'too_many_rooms',
      });
    }

    this._switching = true;
    try {
      this.log.info(`打开房间 ${next}（当前共 ${this.rooms.size} 个）`);
      await this._bootRoom(next);
      await this._activate(next);
      // 启动失败不能装作没事：页面会切过去，但那一间什么都没有，
      // 不说明的话看起来就像"这个房间没人说话"
      if (!this._findRoom(next)?.runner?.started) {
        this._emit({
          type: 'notice',
          data: { level: 'error', text: `房间 ${next} 启动失败，再点一次会重试` },
        });
      }
      return this.status();
    } finally {
      this._switching = false;
    }
  }

  /**
   * 重试启动一个"登记了但没起来"的房间。
   *
   * 正常情况是空操作（`started` 已经是 true）。只在真正需要时才动，
   * 因为 `start()` 会重建投影和长连，代价不小。
   */
  async _reviveRoom(room) {
    const runner = room?.runner;
    if (!runner || runner.started) return;

    this.log.info(`重试启动房间 ${room.key}（上次没起来）`);
    try {
      await runner.start();
    } catch (err) {
      this.log.error(`重试启动房间 ${room.key} 还是失败：${err.message}`);
      this._emit({
        type: 'notice',
        data: { level: 'error', text: `房间 ${room.key} 启动失败：${err.message}` },
      });
      return;
    }

    this._preload(room);
    await this._checkReconcile(room);
  }

  /**
   * 关掉一个房间。
   *
   * 必须留一个：全关掉之后页面没有任何数据源，"打开房间"的入口也就
   * 没地方可点了 —— 那不是"节省资源"，是自己把自己关在门外。
   */
  async closeRoom(roomId) {
    const room = this._findRoom(normalizeRoomId(roomId));
    if (!room) {
      throw Object.assign(new Error('没有这个房间'), { status: 404, code: 'no_room' });
    }
    if (this.rooms.size <= 1) {
      throw Object.assign(new Error('至少要留一个房间'), { status: 400, code: 'last_room' });
    }
    if (this._switching) {
      throw Object.assign(new Error('正在切换房间，请稍候'), { status: 409 });
    }

    this._switching = true;
    try {
      const wasActive = this._isActive(room);
      this.rooms.delete(room.key);
      // 先把指针挪开再停：否则停止过程中的事件会往"已经关掉的房间"里写
      if (wasActive) {
        this.activeKey = '';
        this.runner = null;
      }
      await room.runner?.stop().catch(() => {});
      this.log.info(`关闭房间 ${room.key}（剩 ${this.rooms.size} 个）`);

      if (wasActive) {
        const next = this.rooms.values().next().value;
        await this._activate(next.key);
      }
      this._saveConfig();
      return { ...this.status(), closed: room.key };
    } finally {
      this._switching = false;
    }
  }

  /**
   * 在跑的房间一览。给页面上的房间选择器用。
   *
   * 这里**不做聚合**：每个房间只报自己的数字，合并成一个总数是没有意义的
   * （不同直播间的弹幕加起来能说明什么？）。要多房间对比，页面自己排。
   */
  roomsList() {
    const out = [];
    for (const room of this.rooms.values()) {
      const r = room.runner;
      const st = r?.stats?.() ?? {};
      const conn = r?.client?.snapshot?.() ?? null;
      out.push({
        key: room.key,
        roomId: r?.realRoomId || room.key,
        title: r?.info?.title ?? '',
        liveState: r?.info?.liveState ?? '',
        state: st.state ?? 'offline',
        /**
         * 这个运行体**到底起来没有**。
         *
         * 只看 `state` 是分不清的：一间从没连上过的房间（解析房间号失败、
         * 断网、B站 接口抖）和一间"主播今天没播"的房间，`state` 都是 offline。
         * 页面上两者长得一模一样，用户点进去看到白屏，只能猜。
         */
        started: Boolean(r?.started),
        danmaku: st.danmaku ?? 0,
        enterCount: st.enterCount ?? 0,
        giftCount: st.giftCount ?? 0,
        giftBattery: st.giftBattery ?? 0,
        /** 本场人气峰值：B站 的在线数是采样推送，只有峰值可跨小时比较 */
        popularity: conn?.popularity ?? 0,
        /** 与 B站 的连接状态（idle / live / closed / error …），和 liveState 不是一回事 */
        conn: conn?.status ?? 'idle',
        /** 本场开始时间；0 表示"起点未知"（进程在直播中途启动） */
        since: st.liveStartedAt || 0,
        active: room.key === this.activeKey,
      });
    }
    return out;
  }

  /* ────────────────────────── 账号凭证 ────────────────────────── */

  /**
   * 凭证状态。
   *
   * **不返回 Cookie**，也不返回脱敏后的摘要 —— 页面不需要，
   * 而"页面上看得见的东西"迟早会被截图发出去。
   *
   * @returns {object}
   */
  authStatus() {
    const as = new AuthStore({ dataDir: this.dataDir }).load().status();
    return {
      ...as,
      /** 最近一次主动校验的结论；null = 这次启动还没查过 */
      check: this._authCheck,
      /** 重新登录不在这个端口上做（登录是独立进程，要能显示二维码） */
      loginHint: '在项目目录执行 npm run login 重新扫码',
    };
  }

  /**
   * 主动校验 Cookie 还有没有效。
   *
   * 三件事刻意这么做：
   *
   * 1. **失效不自动删凭证。** 校验失败最常见的原因是"没网"或"B站 接口抖动"，
   *    删了之后用户得重新扫码 —— 而实际上凭证可能好好的。
   * 只报告，删不删由人决定（`logout()` 才删）。
   * 2. **有效时顺手更新昵称/头像。** 用户在 B站 改了名，这里能跟上，
   *    否则界面上一直显示旧名字。
   * 3. **结论要落日志。** 凭证悄悄失效是最难查的一类问题：
   *    表现是"机器人不说话"，而看代码逻辑一切正常。
   */
  async checkAuth() {
    const auth = new AuthStore({ dataDir: this.dataDir }).load();

    if (!auth.loggedIn) {
      this._authCheck = { at: Date.now(), valid: false, reason: '还没有登录凭证，现在以游客身份连接' };
      return this._authCheck;
    }

    const r = await verifyCookie(auth.cookie);
    this._authCheck = {
      at: Date.now(),
      valid: Boolean(r.valid),
      reason: r.reason ?? '',
      uid: Number(r.uid) || 0,
      uname: r.uname ?? '',
    };

    if (r.valid) {
      try {
        auth.patchProfile({ uname: r.uname, face: r.face, uid: r.uid });
      } catch (err) {
        // 补资料失败不影响"凭证有效"这个结论
        this.log.warn(`更新账号资料失败：${err.message}`);
      }
      this.log.info(`凭证校验通过：${r.uname || r.uid}`);
    } else {
      this.log.warn(`凭证校验未通过：${r.reason ?? '未知原因'}`);
    }

    return this._authCheck;
  }

  /**
   * 退出登录：删凭证 + 重建运行体。
   *
   * **必须重建**。只删文件不重建的话，长连还攥着旧 Cookie 在跑 ——
   * 界面显示"已退出"，实际上还在用你的身份连接、还能发言。
   */
  async logout() {
    if (this._switching) {
      throw Object.assign(new Error('正在切换房间或账号，请稍候'), { status: 409 });
    }

    new AuthStore({ dataDir: this.dataDir }).load().clear();
    this._authCheck = { at: Date.now(), valid: false, reason: '已退出登录' };
    this.log.info('已清除登录凭证');

    this._switching = true;
    try {
      const keys = [...this.rooms.keys()];
      const wasActive = this.activeKey;
      for (const room of this.rooms.values()) {
        await room.runner?.stop().catch(() => {});
      }
      this.rooms.clear();
      this.activeKey = '';
      this.runner = null;
      this._emit({ type: 'reset', data: { roomId: String(this.roomId) } });

      // 每个房间都要用新凭证重连：只重建当前那个的话，后台房间
      // 还攥着旧 Cookie 在跑 —— 界面说"已退出"，实际还在用你的身份连接
      for (const key of keys) await this._bootRoom(key);
      if (keys.length) {
        await this._activate(keys.includes(wasActive) ? wasActive : keys[0], { silent: true });
      }
      this._pushStats();
    } finally {
      this._switching = false;
    }

    return this.authStatus();
  }

  /* ────────────────────────── 访问口令 ────────────────────────── */

  accessStatus() {
    return this.access.status();
  }

  /**
   * 尝试解锁。**只有这个接口免鉴权** —— 否则锁上之后就再也打不开了。
   * @param {unknown} token
   */
  unlockAccess(token) {
    const ok = this.access.verify(token);
    const st = this.access.status();
    if (!ok) {
      const left = st.lockedMs;
      throw Object.assign(
        new Error(left > 0 ? `连续输错了，请等 ${Math.ceil(left / 1000)} 秒再试` : '口令不对'),
        { status: left > 0 ? 429 : 401, code: left > 0 ? 'locked' : 'bad_token' },
      );
    }
    return st;
  }

  /**
   * 设置或修改口令。设置成功后，**新口令立刻就是之后的解锁凭据**。
   * @param {unknown} pw
   */
  setAccessPassword(pw) {
    const st = this.access.setPassword(pw);
    this.log.info('访问口令已更新：之后的写操作需要带口令');
    this._emit({ type: 'notice', data: { level: 'warn', text: '访问口令已开启，本页已自动解锁' } });
    return st;
  }

  /** 关闭口令。删文件，不留死数据 */
  disableAccess() {
    const st = this.access.disable();
    this.log.warn('访问口令已关闭：本机任何页面都能改配置了');
    this._emit({ type: 'notice', data: { level: 'warn', text: '访问口令已关闭' } });
    return st;
  }

  /* ────────────────────────── 更新检查 ────────────────────────── */

  /** 设置更新源。传空字符串等于"不要检查" */
  setUpdateUrl(url) {
    const next = String(url ?? '').trim().slice(0, 500);
    if (next) {
      // 只在有值时校验：空值是合法的"关闭"
      let parsed;
      try {
        parsed = new URL(next);
      } catch {
        throw Object.assign(new Error('更新源不是合法 URL'), { status: 400, code: 'bad_url' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw Object.assign(new Error('更新源只支持 http/https'), { status: 400, code: 'bad_url' });
      }
    }
    this.updateUrl = next;
    this._saveConfig();
    return { updateUrl: this.updateUrl };
  }

  checkUpdate({ force = false } = {}) {
    return this.update.check({ force });
  }

  /* ────────────────────────── 诊断包 ────────────────────────── */

  /**
   * 打包一份脱敏诊断信息。
   *
   * 事件只取最近 300 条，且逐条压成"骨架"（core/diagnostic.mjs）——
   * 包会被人转发，宁可少给信息，也不能把观众昵称和弹幕内容带出去。
   */
  makeDiagnostic() {
    return buildDiagnostic({
      meta: {
        app: 'yuyue3',
        version: this.version,
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: `${platform()} ${release()}`,
        arch: arch(),
        pid: process.pid,
        uptimeMs: Date.now() - this.startedAt,
        roomId: String(this.roomId),
        dryRun: this.dryRun,
        pluginsDir: this.pluginsDir ? '已加载' : '未加载',
        eventBuffer: this._activeRoom()?.events.length ?? 0,
        rooms: this.roomsList().map((r) => r.key),
      },
      status: this.status(),
      brief: this.brief(),
      config: this._loadConfig(),
      access: this.access.status(),
      update: this.update.snapshot(),
      events: (this._activeRoom()?.events ?? []).slice(-300),
      logStats: this.runner?.log_?.stats() ?? null,
    });
  }

  /* ────────────────────────── 订阅与广播 ────────────────────────── */

  /**
   * 当前房间的事件缓冲（只读）。
   *
   * 保留这个名字是因为外面（`/api/events`、诊断包）一直这么读；
   * 但**写入口只有一个**：`_onEvent(room, rec)`。有 setter 的话，
   * 某处随手 `app.events = []` 就能把缓冲清掉而不影响 `rooms` 里的记录，
   * 之后补发就永远少一截 —— 所以这里刻意只给 getter。
   */
  get events() {
    return this._activeRoom()?.events ?? [];
  }

  get oldestSeq() {
    return this._activeRoom()?.oldestSeq ?? 0;
  }

  /**
   * @param {(msg:object)=>void} fn
   * @returns {()=>void} 取消订阅
   */
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _emit(msg) {
    for (const fn of this._subs) {
      try {
        fn(msg);
      } catch {
        // 单个订阅者（比如已经断开的 WS）出错不能影响其他人
      }
    }
  }

  /**
   * 一条事件落进**它自己那个房间**的缓冲。
   *
   * 房间是参数，不是 `this.runner`：后台房间的事件必须记进它自己的缓冲，
   * 读当前房间的话，两个房间的数字会搅在一起 —— 而且页面上看不出任何异常。
   */
  _onEvent(room, rec, edge) {
    if (!room || !rec) return;

    // 追加进缓冲。用 seq 判断是否重复：插件重放、补发重叠都可能送来同一条
    const last = room.events[room.events.length - 1];
    if (last && rec.seq <= last.seq) {
      // 重复事件不再进缓冲，也**不发提醒**：状态机这次根本没跑，
      // 带过来的 edge 是上一条事件的旧边沿，照着发就会重复响。
      return;
    }

    room.events.push(rec);
    if (!room.oldestSeq) room.oldestSeq = rec.seq;

    if (room.events.length > MAX_BUFFER) {
      const drop = room.events.length - MAX_BUFFER;
      room.events.splice(0, drop);
      room.oldestSeq = room.events[0]?.seq ?? 0;
    }

    // 只推当前看的这一间。页面只有一个视图，后台房间的数字走 /api/rooms
    if (this._isActive(room)) this._emit({ type: 'event', data: rec });

    this._notifyLiveEdge(room, rec, edge);
    // 大额提醒与开播/下播无关，但同样只在这一层做：插件可以被关掉，
    // "有人一次花了很多钱"这件事不该取决于哪个插件刚好开着
    this._notifyBigSpend(room, rec);
    // 礼物目标同样挂在内核层：插件关掉不影响"本场进度走到哪"
    this._notifyGoal(room, rec);
    // SC 点歌：队列状态要跨重启保留，所以也放在内核层，不依赖 sc 插件
    this._enqueueSong(room, rec);
    // 回访看的是"这场之前"的付费记录；新场次开始后旧索引立刻作废。
    // 只处理当前房间：后台房间开播不该清掉正在看的这一场的索引，
    // 否则同一场里的老观众会被重复提醒一遍。
    if (rec.type === 'LIVE_START' && this._isActive(room)) {
      this._patronIndex = null;
      this._patronWarmKey = '';
      this._patronSaid.clear();
      this._warmPatrons().catch((err) =>
        this.log.warn(`[回访] 新场次预热失败：${err?.message ?? err}`),
      );
    }
    this._notifyPatronReturn(room, rec);
  }

  /**
   * 开播 / 下播提醒。
   *
   * 边沿来自投影的状态机（`projection.lastEdge`，`_ingest` 里刚算完就带过来），
   * 不是事件类型本身 —— B站 重连后会重复推同一次 LIVE，状态机会判成
   * "没有新边沿"，靠事件类型发通知的人会把一次开播提醒三遍。
   *
   * 通知发给**所有订阅者**、不分房间：这个功能的存在意义就是
   * "页面正看着 A 房间时，B 房间开播了也要知道"。
   * `synthetic` 是启动校准补的事件（重启时它本来就在播），不是此刻发生的，
   * 提醒了只会让人困惑"我什么都没干它怎么开播了"。
   */
  _notifyLiveEdge(room, rec, edge) {
    if (edge !== 'live_started' && edge !== 'live_ended') return;
    if (rec?.payload?.synthetic) return;

    const runner = room.runner;
    const roomId = runner?.realRoomId || room.key;
    const title = runner?.info?.title ?? '';
    const start = edge === 'live_started';
    const text = notifyText({ kind: start ? 'start' : 'end', roomId, title });

    this._emit({
      type: 'notice',
      data: { level: start ? 'success' : 'info', text },
    });
    this.log.info(`[提醒] ${text}`);

    const webhook = this.notifyWebhook;
    if (!webhook) return;

    // 战报必须在边沿"此刻"同步取数：如果等提醒的 webhook 回来再取，
    // 断线重连快的话新一场已经开演，snapshot() 会换成新场，战报就成了一张空账。
    // 取到的文本是死数据，之后就算投影变了也不影响。
    const report = !start && this.notifyReport ? this._buildLiveReport(room, roomId, title) : null;

    // 不 await：通知外发不该让事件处理排队，失败也只记一条日志
    sendWebhook(webhook, text, { fetchImpl: this.fetchImpl }).then((r) => {
      if (!r.ok) {
        const why = r.error ?? `HTTP ${r.status}`;
        this.log.warn(`[提醒] webhook 发送失败（${why}）：${maskWebhook(webhook)}`);
        // 页内 toast 已经发了，这一条是补充"外发没成功"——
        // 否则配了 webhook 的人只会看到页内弹窗，以为群里也收到了。
        this._emit({
          type: 'notice',
          data: { level: 'warn', text: `提醒已显示，但 webhook 没发出去：${why}` },
        });
      }
      // 下播战报排在提醒之后：同一个群先看到「下播了」，再看到这一场的账。
      // 提醒失败也照样试战报 —— 两种消息各自有用，不能因为前者挂了就不发后者。
      if (report) this._sendReportText(webhook, roomId, report);
    });
  }

  /**
   * 单笔大额提醒。
   *
   * 只看**这一条**事件的电池数，不看累计：累计需要一张跨事件的状态表，
   * 而且"这一笔很大"才是该当场说的事。阈值单位是电池（1 元 = 10 电池）。
   *
   * 页内 toast 永远发；配了 webhook 才外发。失败只补一条警告，不能影响别的。
   *
   * 文案里带房间号：多房间是常态，只写"甲送出火箭"的话，
   * 正看着 A 间的人会以为是 A 间发生的事。
   */
  _notifyBigSpend(room, rec) {
    const threshold = this.bigSpendBattery;
    if (!threshold) return;
    if (
      rec?.type !== 'GIFT' &&
      rec?.type !== 'GUARD_BUY' &&
      rec?.type !== 'SUPER_CHAT'
    ) {
      return;
    }
    if (paidBatteryOf(rec) < threshold) return;

    const body = bigSpendText(rec);
    if (!body) return;

    const roomId = room?.runner?.realRoomId || room?.key || '';
    const text = `【大额】${roomId ? `房间 ${roomId} · ` : ''}${body}`;
    this._emit({ type: 'notice', data: { level: 'warn', text } });
    this.log.info(`[大额] ${text}`);

    const webhook = this.notifyWebhook;
    if (!webhook) return;
    sendWebhook(webhook, text, { fetchImpl: this.fetchImpl }).then((r) => {
      if (r.ok) return;
      const why = r.error ?? `HTTP ${r.status}`;
      this.log.warn(`[大额] webhook 发送失败（${why}）：${maskWebhook(webhook)}`);
      this._emit({
        type: 'notice',
        data: { level: 'warn', text: `大额提醒已显示，但 webhook 没发出去：${why}` },
      });
    });
  }

  /**
   * 本场礼物目标过线播报。
   *
   * 只在 GIFT 上判断：目标的名字就是"礼物"，舰长/SC 有各自的答谢；
   * 混在一起会让主播说不清"还差多少"。进度取刚更新过的投影快照，
   * 用「这笔之前 / 这笔之后」算过线，避免按当前比例每来一条就喊一次。
   *
   * 同一场同一档只播一次（`_goalSaid` 按场次 id 记）；换场后 sessionId 变了，
   * 旧的 key 永远不会再命中，所以不需要主动清空。
   */
  _notifyGoal(room, rec) {
    const goal = this.giftGoalBattery;
    if (!goal || rec?.type !== 'GIFT') return;
    // 目标是给"页面正在看的这一场"设的；后台房间的礼物不该在
    // 当前页面上喊过半/达成，否则观众会把别人的进度当成这间的。
    if (!this._isActive(room)) return;

    const proj = room?.runner?.projection;
    if (!proj || typeof proj.snapshot !== 'function') return;

    let snap;
    try {
      snap = proj.snapshot();
    } catch {
      return;
    }
    if (!snap) return;

    const after = Math.max(0, Number(snap.giftBattery) || 0);
    const before = Math.max(0, after - (paidBatteryOf(rec) || 0));
    const milestone = goalMilestone(before, after, goal);
    if (!milestone) return;

    const roomId = room.runner?.realRoomId || room.key;
    const key = `${roomId}:${snap.sessionId ?? ''}:${milestone}`;
    if (this._goalSaid.has(key)) return;
    this._goalSaid.add(key);
    // 极端长跑也不让这个 Set 无限涨；清掉后最坏是同一场再喊一次
    if (this._goalSaid.size > 500) this._goalSaid.clear();

    const text = goalText(milestone, after, goal, this.giftGoalTexts?.[String(milestone)] ?? '');
    this._emit({ type: 'notice', data: { level: 'info', text } });
    this.log.info(`[目标] ${text}`);

    if (!this.giftGoalAnnounce) return;
    const gate = room.runner?.gate;
    if (!gate?.say) return;

    // 高优先级 + 等一个槽位：过线是"此刻"的事，错过了补一句反而奇怪。
    // 不 await：闸门自己的失败已经会记日志，这里只兜住 Promise 拒绝。
    gate
      .say({
        roomId,
        text,
        reason: 'gift_goal',
        source: 'goal',
        priority: 1,
        maxWaitMs: 5000,
      })
      .catch((err) => this.log.warn(`[目标] 播报失败：${err?.message ?? err}`));
  }

  /**
   * 下播战报：把刚封存的那一场组装成文本。
   *
   * 数据源是投影自己（`snapshot()`），不是重新读日志：
   *   - 此刻日志里已经写进了 LIVE_END，重放会得到同一场；
   *   - 但重放还要扫完整个文件，消息会晚到几十秒，还会把"下一场"混进来的风险带回来。
   * 投影是事实的实时影子，这一场刚闭合，它最清楚。
   *
   * 这里只组装、不发送，而且由 `_notifyLiveEdge` 同步调用 —— 见那边的竞态说明。
   *
   * @returns {string|null} 没有投影或取数失败时返回 null（跳过战报，不拖垮提醒）
   */
  _buildLiveReport(room, roomId, title) {
    const proj = room?.runner?.projection;
    if (!proj || typeof proj.snapshot !== 'function') return null;

    let snap;
    try {
      snap = proj.snapshot();
    } catch (err) {
      this.log.warn(`[战报] 取本场数据失败：${err.message}`);
      return null;
    }
    if (!snap) return null;

    const s = proj.session ?? null;
    const startedAt = Number(snap.liveStartedAt) || 0;
    const endedAt = Number(snap.liveEndedAt) || 0;
    const summary = {
      implicit: Boolean(snap.sessionImplicit ?? s?.implicit),
      endedAtEstimated: Boolean(s?.endedAtEstimated),
      // 起点是推断出来的（没有 LIVE_START）时不要拿 0 当起点算出天文数字
      durationSec: startedAt > 0 && endedAt > startedAt ? (endedAt - startedAt) / 1000 : 0,
      uniqueViewers: snap.uniqueViewers,
      danmaku: snap.danmaku,
      giftCount: snap.giftCount,
      giftBattery: snap.giftBattery,
      guardCount: snap.guardCount,
      guardBattery: snap.guardBattery,
      scCount: snap.scCount,
      scBattery: snap.scBattery,
      totalBattery:
        (Number(snap.giftBattery) || 0) +
        (Number(snap.guardBattery) || 0) +
        (Number(snap.scBattery) || 0),
    };

    try {
      return reportText({ roomId, title, summary, topGifters: snap.topGifters ?? [] });
    } catch (err) {
      // 战报是附属功能：文案组装失败只记日志，不能把提醒变成未处理异常
      this.log.warn(`[战报] 组装失败：${err.message}`);
      return null;
    }
  }

  /** 战报发送：失败只 warn + 页内提示，绝不影响已经发出去的提醒。 */
  _sendReportText(webhook, roomId, text) {
    sendWebhook(webhook, text, { fetchImpl: this.fetchImpl }).then((r) => {
      if (r.ok) return;
      const why = r.error ?? `HTTP ${r.status}`;
      this.log.warn(`[战报] webhook 发送失败（${why}）：${maskWebhook(webhook)}`);
      this._emit({
        type: 'notice',
        data: { level: 'warn', text: `房间 ${roomId} 的战报没发出去：${why}` },
      });
    });
  }

  /**
   * 保存提醒设置（webhook + 是否推下播战报）。
   *
   * 两项一次落盘：分开存的话，第二次失败会留下"地址变了、开关没变"的半套配置，
   * 而页面上看起来是保存成功了。
   *
   * @param {{webhook?:string, report?:boolean}} patch
   */
  setNotifySettings({ webhook, report } = {}) {
    const nextWebhook = webhook === undefined ? this.notifyWebhook : String(webhook ?? '').trim();
    let nextReport = report === undefined ? this.notifyReport : Boolean(report);

    if (nextWebhook && !/^https?:\/\/\S+$/i.test(nextWebhook)) {
      throw Object.assign(new Error('webhook 地址要以 http:// 或 https:// 开头，且不能有空格'), {
        status: 400,
        code: 'bad_webhook',
      });
    }
    // 原来这里是 slice(0, 500)：超长地址被悄悄截断，用户看到"已保存"，
    // 实际存进去的是半截 URL，下发时才失败。宁可当场说地址太长。
    if (nextWebhook.length > 500) {
      throw Object.assign(new Error('webhook 地址太长了（最多 500 字符）'), {
        status: 400,
        code: 'bad_webhook',
      });
    }
    if (!nextWebhook && nextReport) {
      // 显式要开战报却没有地址 —— 拒绝；只是清空地址时则顺带关掉战报，
      // 否则会留下一个勾着、却永远发不出去的开关。
      if (report === true) {
        throw Object.assign(new Error('下播战报要发出去，得先填一个 webhook 地址'), {
          status: 400,
          code: 'report_needs_webhook',
        });
      }
      nextReport = false;
    }

    const beforeWebhook = this.notifyWebhook;
    const beforeReport = this.notifyReport;
    this.notifyWebhook = nextWebhook;
    this.notifyReport = nextReport;
    if (!this._saveConfig()) {
      // 落盘失败就回滚，别让页面显示"存住了"、重启后又变回去
      this.notifyWebhook = beforeWebhook;
      this.notifyReport = beforeReport;
      throw Object.assign(new Error('保存提醒设置失败：写不进 data/app.json'), {
        status: 500,
        code: 'save_failed',
      });
    }
    return { webhook: this.notifyWebhook, report: this.notifyReport };
  }

  /**
   * 设置提醒 webhook。空串 = 关闭外发（页内 toast 不受影响）。
   * @param {string} url
   */
  setNotifyWebhook(url) {
    return this.setNotifySettings({ webhook: url }).webhook;
  }

  /**
   * 设置单笔大额提醒的阈值（电池，0 = 关闭）。
   *
   * 只接受整数、不接受字符串："10000" 这种从表单里直接传上来的值
   * 如果被 Number() 强转，会和"10000 电池"看起来一样，但类型契约就破了；
   * 而且负数/小数会让比较逻辑变得难以解释。
   */
  setBigSpendBattery(battery) {
    if (!Number.isInteger(battery) || battery < 0 || battery > MAX_BIG_SPEND_BATTERY) {
      throw Object.assign(new Error('大额提醒阈值要写成 0 或正整数（单位：电池，0 = 关闭）'), {
        status: 400,
        code: 'bad_threshold',
      });
    }

    const before = this.bigSpendBattery;
    this.bigSpendBattery = battery;
    if (!this._saveConfig()) {
      this.bigSpendBattery = before;
      throw Object.assign(new Error('保存大额提醒设置失败：写不进 data/app.json'), {
        status: 500,
        code: 'save_failed',
      });
    }
    return this.bigSpendBattery;
  }

  /**
   * 设置付费用户回访提醒的累计门槛（电池，0 = 关闭）。
   *
   * 改门槛后旧索引立刻作废：索引是按"门槛以上的 uid"筛过的，
   * 留着的话改完要等下播才生效，页面会看起来"点了没反应"。
   */
  setPatronReturnBattery(battery) {
    if (!Number.isInteger(battery) || battery < 0 || battery > MAX_BIG_SPEND_BATTERY) {
      throw Object.assign(new Error('回访提醒门槛要写成 0 或正整数（单位：电池，0 = 关闭）'), {
        status: 400,
        code: 'bad_return',
      });
    }

    const before = this.patronReturnBattery;
    this.patronReturnBattery = battery;
    if (!this._saveConfig()) {
      this.patronReturnBattery = before;
      throw Object.assign(new Error('保存回访提醒设置失败：写不进 data/app.json'), {
        status: 500,
        code: 'save_failed',
      });
    }

    this._patronIndex = null;
    this._patronWarmKey = '';
    this._patronSaid.clear();
    this._warmPatrons().catch((err) =>
      this.log.warn(`[回访] 改门槛后预热失败：${err?.message ?? err}`),
    );
    return this.patronReturnBattery;
  }

  /**
   * 预热当前房间的回访索引：把"本场开始之前、近 90 天内付过钱"的 uid
   * 从日志里捞出来，缓存到这一场结束。
   *
   * 只做当前房间：提醒是给正在看的这间用的；后台房间的 ENTER 也会走
   * `_notifyPatronReturn`，但索引对不上场次就会安静跳过。
   */
  async _warmPatrons() {
    const threshold = this.patronReturnBattery;
    if (!threshold) return;

    const room = this._activeRoom();
    const runner = room?.runner;
    const log = runner?.log_;
    const session = runner?.projection?.session;
    // session 还指着上一场（没开播时投影不会清空它）就不能拿来预热：
    // 否则离线期间进房的人会被当成"回访"提醒一遍。
    if (!log || !session?.id || session.closed) return;

    const start = Number(session.startedAt) || 0;
    if (!start) return;

    const key = `${room.key}:${session.id}:${threshold}`;
    if (this._patronWarmKey === key) return;
    this._patronWarmKey = key;

    const since = start - PATRON_RETURN_DAYS * 86400000;
    try {
      const all = await log.readAllAsync();
      // 等待期间可能切房/换场/改门槛：结果只给最后发起的那一次
      if (this._patronWarmKey !== key) return;

      const byUid = new Map();
      for (const ev of all) {
        const ts = Number(ev?.ts) || 0;
        // 本场之内的付费不算"回访"，那是正在发生的事
        if (!ts || ts >= start) continue;
        const type = ev?.type;
        if (type !== 'GIFT' && type !== 'GUARD_BUY' && type !== 'SUPER_CHAT') continue;

        const p = ev.payload ?? {};
        const uid = String(p.uid ?? '').trim();
        if (!uid || uid === '0') continue;

        const battery = paidBatteryOf(ev);
        if (!(battery > 0)) continue;

        const row = byUid.get(uid) ?? { total: 0, lastTs: 0, name: '' };
        row.total += battery;
        if (ts >= row.lastTs) {
          row.lastTs = ts;
          const name = patronNameOf(ev);
          if (name) row.name = name;
        }
        byUid.set(uid, row);
      }

      const map = new Map();
      for (const [uid, row] of byUid) {
        if (row.total >= threshold && row.lastTs >= since) map.set(uid, row);
      }
      this._patronIndex = { key, map };
    } catch (err) {
      // 读取失败时把 key 放掉，否则这一场再也不会重试；
      // 下一条 ENTER 会再试一次（_notifyPatronReturn 的兜底）。
      if (this._patronWarmKey === key) this._patronWarmKey = '';
      this.log.warn(`[回访] 读取历史付费用户失败：${err?.message ?? err}`);
    }
  }

  /**
   * 付费用户回访：只在 ENTER 上判断，同一场同一个人只响一次。
   *
   * 页内提示就够：这是给主播自己看的信息，不往外发 webhook，
   * 免得"老观众来了"和真正的开播/大额通知混在群里。
   */
  _notifyPatronReturn(room, rec) {
    const threshold = this.patronReturnBattery;
    if (!threshold || rec?.type !== 'ENTER') return;

    const p = rec.payload ?? {};
    const uid = String(p.uid ?? '').trim();
    if (!uid || uid === '0') return;

    const idx = this._patronIndex;
    if (!idx) {
      // 启动时投影可能还没建好、或上次读日志失败；来 ENTER 时补一次。
      // _warmPatrons 自己按 key 去重，不会因为进房频繁而反复读盘。
      if (this._isActive(room)) {
        this._warmPatrons().catch((err) =>
          this.log.warn(`[回访] 延迟预热失败：${err?.message ?? err}`),
        );
      }
      return;
    }
    const sessionId = room?.runner?.projection?.session?.id;
    if (!sessionId || idx.key !== `${room.key}:${sessionId}:${threshold}`) return;

    const hit = idx.map.get(uid);
    if (!hit) return;

    const saidKey = `${room.key}:${sessionId}:${uid}`;
    if (this._patronSaid.has(saidKey)) return;
    this._patronSaid.add(saidKey);
    if (this._patronSaid.size > 1000) {
      // 只丢最早的一半，别一次清空：清空会让同一场里的老观众再被提醒一遍
      let drop = 500;
      for (const old of this._patronSaid) {
        if (drop-- <= 0) break;
        this._patronSaid.delete(old);
      }
    }

    const roomId = room.runner?.realRoomId || room.key;
    const name = patronNameOf(rec) || hit.name || `uid ${uid}`;
    const text = `【回访】房间 ${roomId} · ${name} 回来了（近 ${PATRON_RETURN_DAYS} 天累计 ¥${moneyText(hit.total)}）`;
    this._emit({ type: 'notice', data: { level: 'info', text } });
    this.log.info(`[回访] ${text}`);
  }

  /**
   * 设置本场礼物目标与是否播报。
   *
   * 目标是"所有房间共用"的机器级配置：主播只有一个价目表，
   * 换个房间就看到另一个目标反而会让人以为是 bug。
   *
   * 目标为 0 时强制关掉播报：否则广播开关看起来还亮着，
   * 但永远不会有"过线"发生，用户会以为功能坏了。
   */
  setGiftGoal({ goalBattery, announce, texts } = {}) {
    const nextGoal = goalBattery === undefined ? this.giftGoalBattery : goalBattery;
    if (!Number.isInteger(nextGoal) || nextGoal < 0 || nextGoal > MAX_GOAL_BATTERY) {
      throw Object.assign(new Error('礼物目标要写成 0 或正整数（单位：电池，0 = 关闭）'), {
        status: 400,
        code: 'bad_goal',
      });
    }
    if (announce !== undefined && typeof announce !== 'boolean') {
      throw Object.assign(new Error('播报开关只能是 true 或 false'), {
        status: 400,
        code: 'bad_goal',
      });
    }

    let nextTexts = this.giftGoalTexts;
    if (texts !== undefined) {
      if (!texts || typeof texts !== 'object' || Array.isArray(texts)) {
        throw Object.assign(new Error('自定义文案要写成 { "30": "…", "100": "…" } 这样的对象'), {
          status: 400,
          code: 'bad_goal',
        });
      }
      const clean = {};
      for (const [key, value] of Object.entries(texts)) {
        if (!GOAL_TIERS.includes(Number(key))) {
          throw Object.assign(new Error('自定义文案只能挂在 30 / 60 / 80 / 100 这几档上'), {
            status: 400,
            code: 'bad_goal',
          });
        }
        if (typeof value !== 'string') {
          throw Object.assign(new Error('每一档的自定义文案都必须是字符串'), {
            status: 400,
            code: 'bad_goal',
          });
        }
        const text = value.trim().slice(0, 80);
        if (text) clean[String(Number(key))] = text;
      }
      nextTexts = clean;
    }

    const beforeGoal = this.giftGoalBattery;
    const beforeAnnounce = this.giftGoalAnnounce;
    const beforeTexts = this.giftGoalTexts;
    this.giftGoalBattery = nextGoal;
    this.giftGoalAnnounce = nextGoal ? (announce ?? beforeAnnounce) : false;
    this.giftGoalTexts = nextTexts;
    if (!this._saveConfig()) {
      this.giftGoalBattery = beforeGoal;
      this.giftGoalAnnounce = beforeAnnounce;
      this.giftGoalTexts = beforeTexts;
      throw Object.assign(new Error('保存礼物目标失败：写不进 data/app.json'), {
        status: 500,
        code: 'save_failed',
      });
    }
    return {
      goalBattery: this.giftGoalBattery,
      announce: this.giftGoalAnnounce,
      texts: this.giftGoalTexts,
    };
  }

  _pushStats() {
    if (!this.runner) return;
    this._emit({ type: 'stats', data: this.brief() });
  }

  /* ────────────────────────── 查询 ────────────────────────── */

  /**
   * 精简状态：给每秒一次的推送用。
   * 不含插件字段定义、不含事件类型明细 —— 那些只在页面加载时取一次。
   */
  brief() {
    const r = this.runner;
    if (!r) return null;

    const st = r.stats() ?? {};
    const conn = r.client ? r.client.snapshot() : null;
    const gate = r.gate ? r.gate.snapshot() : null;

    return {
      roomId: r.realRoomId || r.inputRoomId,
      title: r.info?.title ?? '',
      liveState: r.info?.liveState ?? '',
      state: st.state,
      hasKnownStart: st.hasKnownStart,
      sessionId: st.sessionId,
      sessionImplicit: st.sessionImplicit,
      liveStartedAt: st.liveStartedAt,
      liveEndedAt: st.liveEndedAt,
      danmaku: st.danmaku ?? 0,
      enterCount: st.enterCount ?? 0,
      giftCount: st.giftCount ?? 0,
      giftBattery: st.giftBattery ?? 0,
      /** 本场礼物目标（电池，0 = 关闭）。挂件进度条按它画，页面也能显示 */
      giftGoalBattery: this.giftGoalBattery,
      guardCount: st.guardCount ?? 0,
      scCount: st.scCount ?? 0,
      scBattery: st.scBattery ?? 0,
      uniqueViewers: st.uniqueViewers ?? 0,
      lastSeq: st.lastSeq ?? 0,
      grand: st.grand ?? {},
      dryRun: gate?.dryRun ?? this.dryRun,
      gate: gate?.counters ?? null,
      conn: conn
        ? {
            status: conn.status,
            popularity: conn.popularity,
            silentMs: conn.silentMs,
            reconnectAttempts: conn.reconnectAttempts,
            guest: conn.guest,
            stats: conn.stats,
          }
        : null,
      plugins: r.host?.stats() ?? [],
      /**
       * 观众簿只报"认识多少人"和"保留多久"，不报具体名单。
       *
       * 名单是观众的个人信息，而这个字段每秒都会推给前端一次 ——
       * 没必要把几百人的 uid 一直挂在一条 1Hz 的通道上。
       *
       * 走 brief() 而不是 stats()：后者会遍历整张表求最早/最晚来访，
       * 十万人 × 1Hz 是纯浪费。这里只要一个人数和分片数。
       */
      roster: r.roster ? r.roster.brief() : null,
      buffer: {
        count: this._activeRoom()?.events.length ?? 0,
        oldestSeq: this._activeRoom()?.oldestSeq ?? 0,
      },
    };
  }

  /** 完整状态：页面加载时取一次 */
  status() {
    const r = this.runner;
    const auth = new AuthStore({ dataDir: this.dataDir }).load();
    const as = auth.status();

    return {
      ok: true,
      /**
       * 自报家门。
       *
       * 启停脚本要靠它判断「8900 端口上跑的是不是我」——
       * 只看端口有没有监听是不够的：别的程序占了这个端口，
       * 脚本会以为服务已经在跑，于是「启动成功」然后什么都不做。
       * 这个字段是给运维用的，前端不依赖它。
       */
      app: 'yuyue3',
      /** 进程号：停止脚本按它精确结束，页面侧栏也可以显示 */
      pid: process.pid,
      now: Date.now(),
      version: this.version,
      uptimeMs: Date.now() - this.startedAt,
      account: {
        loggedIn: Boolean(as.loggedIn),
        uid: as.uid ?? 0,
        uname: as.uname ?? '',
        face: as.face ?? '',
        /** 上次主动校验的结论：页面据此显示"凭证可能已过期" */
        check: this._authCheck,
      },
      /** 访问口令状态：只给"开没开"，哈希之类的东西永远不下发 */
      access: this.access.status(),
      /** 上次更新检查结果（可能为 null）。不发请求，只是回显 */
      update: this.update.snapshot(),
      config: {
        roomId: this.roomId,
        dryRun: this.dryRun,
        pluginsDir: this.pluginsDir,
        updateUrl: this.updateUrl,
      },
      room: r ? r.snapshot() : null,
      brief: this.brief(),
      /** 当前在看哪个房间、一共有哪几个 */
      activeRoomId: this.activeKey,
      rooms: this.roomsList(),
      buffer: {
        count: this._activeRoom()?.events.length ?? 0,
        oldestSeq: this._activeRoom()?.oldestSeq ?? 0,
        max: MAX_BUFFER,
      },
    };
  }

  /**
   * 取事件。
   *
   * after > 0 时取 seq 之后的（补发用）；否则取最近的 limit 条（首屏用）。
   *
   * `gap` 是关键：告诉前端"你看到的两段之间不是连续的"。**有两种缺口**，
   * 少判一种就会重演二代的"事件流停在某个时刻"：
   *
   *   1. `after` 比缓冲里最早的还早 —— 要的那段已经被滚出缓冲了；
   *   2. 一次没给完 —— 取到 limit 上限，而后面还有更新的（**这条以前漏了**）。
   *
   * 第 2 种才是常见情况：WS 一次最多补 800 条，断线几分钟就超过 800 了。
   * 以前只在第 1 种情况下标 gap，于是"补了 800 条、剩下 2000 条悄悄丢掉"
   * 这件事在页面看来是连续的 —— 数字照跳，事件流少一截，没有任何提示。
   *
   * @param {{after?:number, limit?:number}} [opts]
   */
  recentEvents({ after = 0, limit = 200 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 200, 1), MAX_BUFFER);
    // 补发 / 首屏都只针对**当前在看的**那一间
    const room = this._activeRoom();
    const events = room?.events ?? [];
    const oldestSeq = room?.oldestSeq ?? 0;
    const latest = events[events.length - 1]?.seq ?? 0;

    if (after > 0) {
      const start = events.findIndex((e) => e.seq > after);
      if (start < 0) {
        // 没有比 after 更新的了：不是在补发，是已经追平
        return {
          events: [],
          gap: false,
          from: 0,
          to: after,
          oldestSeq,
          latestSeq: latest,
        };
      }

      const slice = events.slice(start, start + n);
      const to = slice[slice.length - 1]?.seq ?? 0;
      const gap = after < oldestSeq - 1 || to < latest;

      return {
        events: slice,
        gap,
        from: slice[0]?.seq ?? 0,
        to,
        oldestSeq,
        latestSeq: latest,
      };
    }

    const slice = events.slice(-n);
    return {
      events: slice,
      gap: false,
      from: slice[0]?.seq ?? 0,
      to: slice[slice.length - 1]?.seq ?? 0,
      oldestSeq,
      latestSeq: latest,
    };
  }
}

/**
 * 只保留 seq <= 快照那一刻的事件。
 *
 * 为什么需要：对账是"日志逐条累加"和"投影快照"两边比。
 * 读日志和取快照之间总有一小段时间，直播中每秒都有事件进来 ——
 * 快照会比日志**多**几条，对账于是报"差几条"。
 * 那种误报最伤：一旦对账会无缘无故失败，真出问题时没人会当回事。
 */
export function upTo(snapshot, events) {
  const lastSeq = Number(snapshot?.lastSeq);
  if (!Number.isFinite(lastSeq) || lastSeq <= 0) return events;
  return events.filter((e) => Number(e?.seq) <= lastSeq);
}

function readVersion() {  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export default App;
