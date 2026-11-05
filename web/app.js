/**
 * 页面主控。
 *
 * 数据流只有一条：
 *   WebSocket → store（去重/排序）→ stream（渲染，带节流）
 *                                → panels（只改数字）
 *
 * 断线重连时带 `after=<本地最大 seq>` 上去，服务端补发缺失部分。
 * 不能用"重新拉最近 200 条"来凑 —— 那会重复，而且接不上更早的部分。
 */

import { api } from './core/api.js';
import { $, el, replaceChildren } from './core/dom.js';
import { connLabel } from './core/format.js';
import { store } from './core/store.js';
import { createSide, createStats } from './views/panels.js';
import { createReports } from './views/reports.js';
import { createSettings } from './views/settings.js';
import { createStream } from './views/stream.js';
import { createNotifyConfig } from './views/notify-config.js';
import { createGoalConfig } from './views/goal-config.js';
import { createPushConfig } from './views/push-config.js';
import { createObsConfig } from './views/obs-config.js';
import { createPatrons } from './views/patrons.js';
import { createScQueue } from './views/sc-queue.js';
import { createSongQueue } from './views/song-queue.js';
import { createPk } from './views/pk.js';
import { buildRoomRows, summarizeRooms } from './views/room-overview.js';
import { installPwa } from './core/pwa.js';

const dom = {
  liveDot: $('#live-dot'),
  roomLabel: $('#room-label'),
  modePill: $('#mode-pill'),
  connPill: $('#conn-pill'),
  connText: $('#conn-text'),
  offlinePill: $('#offline-pill'),
  healthPill: $('#health-pill'),
  dryToggle: $('#dryrun-toggle'),
  btnRoom: $('#btn-room'),
  btnPlugins: $('#btn-plugins'),
  btnReports: $('#btn-reports'),
  btnPatrons: $('#btn-patrons'),
  btnSc: $('#btn-sc'),
  scBadge: $('#sc-badge'),
  btnSongs: $('#btn-songs'),
  songsBadge: $('#songs-badge'),
  btnPk: $('#btn-pk'),
  dlgPk: $('#dlg-pk'),
  dlgReports: $('#dlg-reports'),
  dlgPatrons: $('#dlg-patrons'),
  dlgSc: $('#dlg-sc'),
  dlgSongs: $('#dlg-songs'),
  stats: $('#stats'),
  stream: $('#stream'),
  filters: $('#filters'),
  jump: $('#jump'),
  evCount: $('#ev-count'),
  side: $('#side'),
  dlg: $('#dlg-room'),
  roomForm: $('#room-form'),
  roomList: $('#room-list'),
  roomSummary: $('#room-summary'),
  roomInput: $('#room-input'),
  roomOk: $('#room-ok'),
  notifyInput: $('#notify-input'),
  notifySave: $('#notify-save'),
  notifyReport: $('#notify-report'),
  goalInput: $('#goal-input'),
  goalSave: $('#goal-save'),
  goalAnnounce: $('#goal-announce'),
  goalText30: $('#goal-text-30'),
  goalText60: $('#goal-text-60'),
  goalText80: $('#goal-text-80'),
  goalText100: $('#goal-text-100'),
  pushProvider: $('#push-provider'),
  pushTarget: $('#push-target'),
  pushSave: $('#push-save'),
  pushTest: $('#push-test'),
  pushHint: $('#push-hint'),
  pushWeekly: $('#push-weekly'),
  obsEnabled: $('#obs-enabled'),
  obsUrl: $('#obs-url'),
  obsPassword: $('#obs-password'),
  obsLiveScene: $('#obs-live-scene'),
  obsOfflineScene: $('#obs-offline-scene'),
  obsSave: $('#obs-save'),
  obsClearPass: $('#obs-clear-pass'),
  obsHint: $('#obs-hint'),
  dlgPlugins: $('#dlg-plugins'),
  plgTabs: $('#plg-tabs'),
  plgBody: $('#plg-body'),
  plgClose: $('#plg-close'),
  toasts: $('#toasts'),
};

const stats = createStats(dom.stats);
const side = createSide(dom.side, { toast });
const stream = createStream({
  body: dom.stream,
  chips: dom.filters,
  jump: dom.jump,
  count: dom.evCount,
  store,
});

const settings = createSettings({
  dlg: dom.dlgPlugins,
  tabs: dom.plgTabs,
  body: dom.plgBody,
  closeBtn: dom.plgClose,
  toast,
});

const reports = createReports({ dlg: dom.dlgReports, toast });

// 付费用户榜读的是当前房间的全量日志，和战报同源；打开时才算，不占常驻请求
const patrons = createPatrons({ dlg: dom.dlgPatrons, toast });

// SC 待读：和榜单一样平时不拉，打开才读日志；徽标靠实时事件自己抬
const scQueue = createScQueue({ dlg: dom.dlgSc, badge: dom.scBadge, toast });

// 点歌队列由内核收进 data/songs.json；页面只读，动作走 /api/songs/action
const songQueue = createSongQueue({ dlg: dom.dlgSongs, badge: dom.songsBadge, api, toast });

// PK 情报：只拉公开房间信息，不读对面弹幕、不自动发言
const pkPanel = createPk({ dlg: dom.dlgPk, toast });

// 提醒 webhook 的设置面板在「房间总览」里：它的作用域就是"所有房间"，
// 单独开一页反而会让人以为只对当前这间生效
const notifyConfig = createNotifyConfig({
  input: dom.notifyInput,
  button: dom.notifySave,
  reportBox: dom.notifyReport,
  api,
  toast,
});

// 礼物目标和提醒一样是机器级设置，放在房间总览里，打开时读一次
const goalConfig = createGoalConfig({
  input: dom.goalInput,
  announceBox: dom.goalAnnounce,
  textBoxes: {
    30: dom.goalText30,
    60: dom.goalText60,
    80: dom.goalText80,
    100: dom.goalText100,
  },
  button: dom.goalSave,
  api,
  toast,
});

// 手机推送也是机器级设置；和 webhook 分开配，接收人不是同一拨
const pushConfig = createPushConfig({
  select: dom.pushProvider,
  input: dom.pushTarget,
  saveButton: dom.pushSave,
  testButton: dom.pushTest,
  hint: dom.pushHint,
  weekBox: dom.pushWeekly,
  api,
  toast,
});

// OBS 场景联动：机器级设置，密码单向
const obsConfig = createObsConfig({
  enabledBox: dom.obsEnabled,
  urlInput: dom.obsUrl,
  passwordInput: dom.obsPassword,
  liveInput: dom.obsLiveScene,
  offlineInput: dom.obsOfflineScene,
  saveButton: dom.obsSave,
  clearButton: dom.obsClearPass,
  hint: dom.obsHint,
  api,
  toast,
});

dom.btnReports?.addEventListener('click', () => {
  // 不用 await：打开面板先出骨架，数据到了再填 —— 读全量日志可能要一两秒
  reports.open().catch((err) => toast(`战报打不开：${err.message}`, 'error'));
});

dom.btnPatrons?.addEventListener('click', () => {
  // load 内部自己 toast 失败，这里只负责把面板打开
  patrons.open();
});

dom.btnSc?.addEventListener('click', () => {
  scQueue.open();
});

dom.btnSongs?.addEventListener('click', () => {
  songQueue.open();
});

dom.btnPk?.addEventListener('click', () => {
  pkPanel.open();
});

const state = {
  brief: null,
  status: null,
  roomId: null,
  wsAlive: false,
};

/* ══════════════════════ 顶部状态 ══════════════════════ */

function applyBrief(b) {
  if (!b) return;
  state.brief = b;

  stats.update(b);
  side.updateBrief(b);
  updateTop();
}

function updateTop() {
  const b = state.brief;

  // 房间
  const room = b?.roomId ? `${b.roomId}${b.title ? ` · ${b.title}` : ''}` : '—';
  dom.roomLabel.textContent = room;
  dom.roomLabel.title = b?.title ?? '';

  // 开播状态点
  const st = b?.state;
  const dotClass = st === 'live' ? 'dot is-live' : st === 'live_unknown' ? 'dot is-unknown' : 'dot';
  if (dom.liveDot.className !== dotClass) dom.liveDot.className = dotClass;
  dom.liveDot.title =
    st === 'live'
      ? '直播中'
      : st === 'live_unknown'
        ? '有事件在来，但场次起点未知'
        : '未开播';

  // 模式
  const dry = b?.dryRun !== false;
  // 演练模式下开关本身已经说明了状态，再挂一个 pill 只是重复；
  // 真实发送时必须醒目，因为那时候"说错话"是有代价的。
  dom.modePill.hidden = dry;
  dom.modePill.textContent = '真实发送中';
  dom.modePill.className = 'pill is-warn';
  dom.modePill.title = '插件说的话会真的发到直播间';
  if (dom.dryToggle.checked !== dry && !dom.dryToggle.disabled) dom.dryToggle.checked = dry;

  updateConnPill();
}

function updateConnPill() {
  const bs = state.brief?.conn?.status;

  let text;
  let cls;

  if (!state.wsAlive) {
    text = '页面断开';
    cls = 'pill is-bad';
  } else if (!bs || bs === 'idle') {
    text = '未连接 B站';
    cls = 'pill';
  } else if (bs === 'live' || bs === 'open') {
    text = 'B站已连接';
    cls = 'pill is-live';
  } else if (bs === 'closed' || bs === 'error') {
    text = 'B站断开';
    cls = 'pill is-bad';
  } else {
    text = connLabel(bs);
    cls = 'pill';
  }

  dom.connPill.className = cls;
  dom.connText.textContent = text;
}

/* ══════════════════════ 状态同步 ══════════════════════ */

function applyStatus(s) {
  if (!s) return;
  state.status = s;

  const rid = s.brief?.roomId ? String(s.brief.roomId) : null;
  // 房间换了：旧房间的事件不能留在页面上，那会让人以为新房间已经这么多弹幕了
  if (rid && state.roomId && rid !== state.roomId) {
    store.reset();
    stream.reset();
  }
  if (rid) state.roomId = rid;

  if (s.brief) applyBrief(s.brief);
  side.updateFull(s);

  if (s.config && typeof s.config.dryRun === 'boolean') {
    dom.dryToggle.checked = s.config.dryRun;
  }
}

async function refreshStatus() {
  try {
    applyStatus(await api.status());
  } catch {
    // 拿不到状态不必弹提示：WS 断开本身已经有可见反馈，重复提示只是噪音
  }
}

/* ══════════════════════ WebSocket ══════════════════════ */

let ws = null;
let retry = 0;
let retryTimer = null;

function connect() {
  clearTimeout(retryTimer);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws?after=${store.lastSeq}`;

  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws = socket;

  socket.addEventListener('open', () => {
    if (ws !== socket) return;
    retry = 0;
    state.wsAlive = true;
    updateConnPill();
    // 重连后补一次完整状态：断线期间房间可能被换掉、插件可能变了
    refreshStatus();
  });

  socket.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(msg);
  });

  socket.addEventListener('close', () => {
    if (ws !== socket) return;
    ws = null;
    state.wsAlive = false;
    updateConnPill();
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // close 一定会跟着来，这里不重复处理
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  });
}

function scheduleReconnect() {
  retry++;
  // 指数退避 + 抖动：服务重启时所有标签页不会同一毫秒一起打上来
  const delay = Math.min(8000, 400 * 2 ** Math.min(retry, 5)) + Math.random() * 300;
  retryTimer = setTimeout(connect, delay);
}

/**
 * 主动重连（换房间后用）。
 *
 * 为什么换房间必须重连：backlog 只在**建立连接时**发一次。
 * 服务端切房间后缓冲里装的是新房间的历史，但页面已经连着，不会重新取 ——
 * 结果是数字对（来自每秒推送），事件流却是空的，看着像"这个房间没人说话"。
 */
function reconnect() {
  clearTimeout(retryTimer);
  const old = ws;
  // 先摘掉引用：close 回调里靠 `ws !== socket` 判断"这条连接已经被替换"，
  // 不摘的话会再多连一条
  ws = null;
  if (old) {
    try {
      old.close();
    } catch {
      /* ignore */
    }
  }
  retry = 0;
  connect();
}

function handle(msg) {
  switch (msg.type) {
    case 'hello':
      applyStatus(msg.data?.status);
      break;

    case 'backlog': {
      const d = msg.data ?? {};
      if (d.gap) {
        const behind = Math.max(0, (d.latestSeq ?? 0) - (d.to ?? 0));
        toast(
          behind > 0
            ? `断线期间积压太多，只补到 #${d.to}，后面还有 ${behind} 条没补（页面继续收新事件）`
            : `断线太久，中间有一截事件已滚出缓冲，补不回来了（从 #${d.from} 开始）`,
          'warn',
        );
      }
      ingest(d.events ?? []);
      break;
    }

    case 'event':
      ingest([msg.data], { bump: true });
      break;

    case 'stats':
      applyBrief(msg.data);
      break;

    case 'notice':
      toast(msg.data?.text ?? '', msg.data?.level ?? 'info');
      break;

    case 'plugins':
      // 别的标签页改了插件配置：面板开着就同步，没开就不要白拉一次接口
      if (dom.dlgPlugins?.open) settings.reload();
      break;

    case 'songs':
      songQueue.update(msg.data);
      break;

    case 'reset':
      store.reset();
      stream.reset();
      /**
       * 插件面板开着的话要重拉一次。
       *
       * 配置是全局的（切房间不变），但**认领 / 发言 / 报错这些计数是分房间的** ——
       * 不重拉就会一直显示上一间的数字，看起来像"新房间也说了这么多"。
       * 面板没开就不拉：那是白花一次请求。
       */
      if (dom.dlgPlugins?.open) settings.reload();
      // 战报读的是当前房间的日志：面板开着就必须按新房间重算，
      // 否则上一间的场次卡片会一直挂着，而数字本身看起来完全正常
      reports.refreshIfOpen();
      patrons.refreshIfOpen();
      // 未读是分房间的：切过去还挂着上一间的徽标会让人以为新房间有 SC
      scQueue.reset();
      // 点歌队列是全局的，但页面显示的"正在播放"要跟新房间的播报对齐
      songQueue.refreshIfOpen();
      // PK 对比的是"当前房间 vs 对面"，换房必须重拉
      pkPanel.refreshIfOpen();
      refreshStatus();
      // 换房间：服务端缓冲已经换成新房间的，但 backlog 只在建连时发，
      // 不重连就永远缺着新房间开头那一段
      reconnect();
      break;

    default:
      // claimed / conn / pong：目前不需要展示成一行文字
      break;
  }
}

function ingest(list, { bump = false } = {}) {
  const added = store.ingest(list);
  if (!added.length) return;
  stream.append(added);
  // 新 SC 不打开面板也该看见：补发/backlog 不算"新"，避免把已读的旧 SC 又顶成未读
  if (bump) {
    const scCount = added.filter((e) => e?.type === 'SUPER_CHAT').length;
    if (scCount) scQueue.bump(scCount);
  }
}

/* ══════════════════════ 交互 ══════════════════════ */

dom.dryToggle.addEventListener('change', async () => {
  const want = dom.dryToggle.checked;

  if (!want) {
    // 从演练切到真实，是一次"开始对外说话"的操作，必须明确确认
    const ok = window.confirm(
      '切到真实发送模式？\n\n插件之后说的话会真的发到直播间，包括欢迎语和答谢。\n建议先在演练模式里看过实际输出再切。',
    );
    if (!ok) {
      dom.dryToggle.checked = true;
      return;
    }
  }

  dom.dryToggle.disabled = true;
  try {
    const r = await api.setDryRun(want);
    toast(r.dryRun ? '已切到演练模式，不会真的发弹幕' : '已切到真实发送模式', r.dryRun ? 'info' : 'warn');
    refreshStatus();
  } catch (err) {
    dom.dryToggle.checked = !want; // 失败要回滚，否则开关会显示一个并不存在的状态
    toast(err.message, 'error');
  } finally {
    dom.dryToggle.disabled = false;
  }
});

dom.btnRoom.addEventListener('click', () => {
  dom.roomInput.value = '';
  dom.dlg.showModal();
  // 列表是现拉的：别的标签页可能刚开了/关了一间，缓存下来只会显示过期的
  renderRooms();
  // 提醒地址同理：可能刚在另一个标签页改过
  notifyConfig.load();
  goalConfig.load();
  pushConfig.load();
  obsConfig.load();
  // 打开期间每 2 秒刷一次：多房间的用处就是"一眼扫过去"，不刷新等于看快照
  startRoomPoll();
  dom.roomInput.focus();
});

// 关掉弹窗就停表。esc、点取消、点提交都会走到这里，
// 挂在 dialog 的 close 上比在每个关掉的地方手动停更靠谱
dom.dlg.addEventListener('close', stopRoomPoll);

$('#room-cancel').addEventListener('click', () => dom.dlg.close());

dom.btnPlugins.addEventListener('click', () => settings.open());

/* ── 房间总览 ── */

/**
 * 总览要每隔一会儿重新拉一次。
 *
 * 为什么不是"打开时读一次就行"：多房间的意义就是**一眼扫过去**看哪间在动。
 * 只画一次快照，用户盯着看的那几行数字永远不变，看着像断了。
 *
 * 但也不能用 1Hz 的 WS 推送：那一路只推**当前这间**（其余房间有意不推，
 * 否则切换房间的语义会乱）。所以这里单独轮询。
 */
const ROOM_POLL_MS = 2000;
let roomPoll = null;
/** 渲染序号：轮询和手动打开可能同时进行，先发的后到会让列表闪一下旧数据 */
let roomRenderSeq = 0;

/**
 * 上一次画出来的那几个节点。
 *
 * 用来做"只改数字、不重建行"（原因见 `renderRooms` 里那段注释）：
 *   roomRows  `${roomId}\0列名` → 值节点
 *   roomDots  roomId → 状态点
 *   roomSubs  roomId → 副标题
 *   roomSig   房间集合 + 谁是当前的。变了才重建
 */
let roomRows = null;
let roomDots = new Map();
let roomSubs = new Map();
let roomSig = '';

function startRoomPoll() {
  stopRoomPoll();
  roomPoll = setInterval(() => {
    // 弹窗已经关了还继续拉接口，纯属浪费 —— 宁可多判一次
    if (!dom.dlg?.open) {
      stopRoomPoll();
      return;
    }
    renderRooms({ quiet: true });
  }, ROOM_POLL_MS);
}

function stopRoomPoll() {
  if (roomPoll) {
    clearInterval(roomPoll);
    roomPoll = null;
  }
}

/**
 * 画房间总览。
 *
 * 每一行说清楚五件事：**这间到底起来没有**、在不在播、多少弹幕、多少礼物、
 * 连没连上 B站。少一样就会出现"看起来在线、其实什么都没收到"的房间。
 *
 * @param {{quiet?:boolean}} [opts] quiet = 轮询触发的刷新，不要画"读取中"占位
 */
async function renderRooms({ quiet = false } = {}) {
  const seq = ++roomRenderSeq;
  if (!quiet) {
    replaceChildren(dom.roomList, [el('div', { class: 'empty-hint', text: '读取房间列表…' })]);
    replaceChildren(dom.roomSummary, []);
  }

  let data;
  try {
    data = await api.rooms();
  } catch (err) {
    // 轮询失败不要盖掉已经画好的列表：断网一秒钟就把整张表清空，比不刷新更糟
    if (seq !== roomRenderSeq || quiet) return;
    replaceChildren(dom.roomList, [
      el('div', { class: 'empty-hint', text: `读不到房间列表：${err.message}` }),
    ]);
    return;
  }
  if (seq !== roomRenderSeq) return; // 期间又发起了新的渲染，这次的结果已经过期

  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  if (rooms.length === 0) {
    replaceChildren(dom.roomList, [el('div', { class: 'empty-hint', text: '还没有在跑的房间' })]);
    replaceChildren(dom.roomSummary, []);
    return;
  }

  // 判断逻辑全在 room-overview.js 里（纯函数，自检能直接喂假数据），这里只管画
  const sum = summarizeRooms(rooms);
  replaceChildren(dom.roomSummary, [
    el('span', { text: `在跑 ${sum.total} 间 · 直播中 ${sum.live} 间` }),
    // "没起来"必须单独说一句：它和"未开播"在列表里长得一样，
    // 但一个是等就有数据，一个是等多久都不会有
    sum.broken ? el('span', { class: 'room-warn', text: `· ${sum.broken} 间没连上` }) : null,
  ]);

  const canClose = rooms.length > 1;
  const rows = buildRoomRows(rooms);
  const sig = rows.map((r) => `${r.roomId}:${r.active ? 1 : 0}`).join('|');

  /**
   * 每 2 秒重建一遍整张表，会把用户**正要点的那颗按钮**换掉：
   * mousedown 落在旧节点上，mouseup 时它已经不在文档里，click 不会触发。
   * 表现是"点关闭没反应，要多点一下"。
   *
   * 所以只有房间增减 / 切换当前房间时才重建；否则就地改数字。
   * 这也是 `panels.js` 一直用的办法（节点只建一次，之后只改 textContent）。
   */
  if (roomRows && sig === roomSig) {
    patchRooms(rows);
    return;
  }

  roomSig = sig;
  roomRows = new Map();
  roomDots = new Map();
  roomSubs = new Map();
  replaceChildren(
    dom.roomList,
    rows.map((row) => {
      const dot = el('span', {
        class: `dot${row.dot === 'idle' ? '' : ` is-${row.dot}`}`,
        title: row.dotTitle,
      });
      const sub = el('div', { class: 'room-sub', text: row.subtitle, attrs: { title: row.title } });
      roomDots.set(row.roomId, dot);
      roomSubs.set(row.roomId, sub);
      const cells = row.cells.map((c) => {
        const v = el('span', { class: 'room-v', text: c.v });
        roomRows.set(`${row.roomId}\u0000${c.k}`, v);
        return el('div', { class: 'room-metric', children: [el('span', { class: 'room-k', text: c.k }), v] });
      });

      return el('div', {
        class: `room-item${row.active ? ' is-active' : ''}${row.broken ? ' is-broken' : ''}`,
        children: [
          dot,
          el('div', {
            class: 'room-meta',
            children: [
              el('div', {
                class: 'room-id',
                children: [
                  el('span', { text: row.roomId }),
                  row.active ? el('span', { class: 'room-badge', text: '当前' }) : null,
                ],
              }),
              sub,
            ],
          }),
          el('div', { class: 'room-metrics', children: cells }),
          el('div', {
            class: 'room-ops',
            children: [
              row.active
                ? el('span', { class: 'room-here', text: '正在看' })
                : el('button', {
                    class: 'btn small',
                    text: '切到这间',
                    attrs: { type: 'button' },
                    on: { click: () => switchToRoom(row.raw) },
                  }),
              el('button', {
                class: 'btn small',
                text: '关闭',
                // disabled 是"存在即生效"的属性：传 false 也会被写成 disabled="false"，
                // 按钮反而永远点不动。所以只能在为 true 时才带上这个属性
                attrs: canClose ? { type: 'button' } : { type: 'button', disabled: 'disabled' },
                on: { click: () => dropRoom(row.raw) },
              }),
            ],
          }),
        ],
      });
    }),
  );
}

/** 就地更新数字与状态点。房间集合没变的时候走这条路 */
function patchRooms(rows) {
  for (const row of rows) {
    const dot = roomDots.get(row.roomId);
    if (dot) {
      dot.className = `dot${row.dot === 'idle' ? '' : ` is-${row.dot}`}`;
      dot.title = row.dotTitle;
    }
    const sub = roomSubs.get(row.roomId);
    if (sub && sub.textContent !== row.subtitle) {
      sub.textContent = row.subtitle;
      sub.title = row.title;
    }
    for (const c of row.cells) {
      const v = roomRows.get(`${row.roomId}\u0000${c.k}`);
      if (v && v.textContent !== c.v) v.textContent = c.v;
    }
  }
}

/** 总览里的一格数字：上面是说明，下面是值 */
function metric(label, value) {
  return el('div', {
    class: 'room-metric',
    children: [
      el('span', { class: 'room-k', text: label }),
      el('span', { class: 'room-v', text: String(value) }),
    ],
  });
}

async function switchToRoom(r) {
  try {
    const res = await api.setRoom(String(r.roomId ?? ''));
    dom.dlg.close();
    toast(`已切到房间 ${r.roomId}`, 'info');
    applyStatus(res.status);
    store.reset();
    stream.reset();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function dropRoom(r) {
  try {
    const res = await api.closeRoom(String(r.roomId ?? ''));
    toast(`已关闭房间 ${r.roomId}`, 'info');
    applyStatus(res.status);
    renderRooms();
  } catch (err) {
    toast(err.message, 'error');
  }
}

dom.roomForm.addEventListener('submit', async (e) => {
  // 取消按钮交给 <dialog> 的默认行为，直接关掉
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();

  const id = dom.roomInput.value.trim();
  if (!/^\d{1,12}$/.test(id)) {
    toast('房间号必须是纯数字', 'error');
    return;
  }

  dom.roomOk.disabled = true;
  try {
    const r = await api.setRoom(id);
    dom.dlg.close();
    toast(`已打开房间 ${id}`, 'info');
    applyStatus(r.status);
    store.reset();
    stream.reset();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    dom.roomOk.disabled = false;
  }
});

/* ══════════════════════ 提示 ══════════════════════ */

function toast(text, level = 'info') {
  if (!text) return;
  const node = el('div', {
    class: `toast${level === 'error' ? ' is-error' : level === 'warn' ? ' is-warn' : ''}`,
    text,
  });
  dom.toasts.append(node);
  setTimeout(() => node.remove(), 5200);
  while (dom.toasts.children.length > 4) dom.toasts.firstElementChild.remove();
}

/* ══════════════════════ 启动 ══════════════════════ */

/**
 * PWA：装离线壳 + 断网提示。
 *
 * 放在最前面且不 await：它不依赖任何数据，越早注册越早开始缓存 ——
 * 用户第一次打开页面时就把壳存下来，之后哪次服务没起来也能看到界面。
 */
installPwa({ banner: dom.offlinePill, toast });

window.addEventListener('beforeunload', () => {
  clearTimeout(retryTimer);
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
});

// 页面从后台切回前台：浏览器可能已经把 WS 判死，主动确认一下
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!state.wsAlive) connect();
  else refreshStatus();
});

await refreshStatus();
connect();

// 排行这类"变化慢"的数据每 3 秒补一次完整状态即可
setInterval(refreshStatus, 3000);

/* 健康检查是低频的：服务会不会出事，不会在一秒内变来变去 */
let lastHealth = null;

function renderHealth(h) {
  lastHealth = h;
  const issues = Array.isArray(h?.issues) ? h.issues : [];
  dom.healthPill.hidden = issues.length === 0;
  if (!issues.length) return;
  dom.healthPill.textContent = `服务告警 ${issues.length}`;
  dom.healthPill.title = issues.map((x) => x.text).join('\n');
}

async function refreshHealth() {
  try {
    renderHealth(await api.health());
  } catch {
    // 健康接口自己都打不开时，别在页面上再叠一层红字
  }
}

dom.healthPill.addEventListener('click', () => {
  const issues = lastHealth?.issues ?? [];
  if (!issues.length) return;
  toast(issues.map((x) => x.text).join('；'), 'warn');
});

refreshHealth();
setInterval(refreshHealth, 60_000);
