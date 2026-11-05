/**
 * OBS 直播挂件。
 *
 * 这是一个和操作台完全独立的页面：没有按钮、不写数据、也不需要登录。
 * 它只做两件事 ——
 *
 *   1. 跟着 WebSocket 把本场数字、最近礼物刷出来；
 *   2. 每 60 秒拉一次付费用户榜（榜单是跨场的，日志重放成本不低，不能每秒拉）。
 *
 * 背景透明、`pointer-events: none`，由 overlay.css 负责。OBS 里加一个
 * 「浏览器源」，地址填 http://127.0.0.1:8900/overlay.html 即可。
 */

const $ = (id) => document.getElementById(id);

const GUARD_NAME = { 1: '总督', 2: '提督', 3: '舰长' };
const GIFT_TYPES = new Set(['GIFT', 'GUARD_BUY', 'SUPER_CHAT']);
const MAX_GIFTS = 5;
const PAID_REFRESH_MS = 60_000;

const pad = (n) => String(n).padStart(2, '0');

/** 电池 → 元。和榜单、战报同一口径：10 电池 = 1 元，整数不带小数 */
export function moneyText(battery) {
  const v = Math.max(0, Number(battery) || 0) / 10;
  return `¥${Number.isInteger(v) ? v : v.toFixed(1)}`;
}

/** 毫秒 → 直播时长。不足一小时用 MM:SS，超过用 H:MM:SS */
export function durationText(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 一条付费事件在礼物列里的样子；不是付费事件返回 null */
export function giftLine(ev) {
  const p = ev?.payload ?? {};
  const who = String(p.uname || p.name || '匿名').trim() || '匿名';

  if (ev?.type === 'GIFT') {
    const num = Math.max(1, Math.floor(Number(p.num) || 1));
    return {
      who,
      what: `${p.giftName || '礼物'} ×${num}`,
      amount: moneyText(p.battery),
      kind: 'gift',
    };
  }
  if (ev?.type === 'GUARD_BUY') {
    const level = GUARD_NAME[Number(p.guardLevel)] || '大航海';
    return {
      who,
      what: `${p.isRenew === true ? '续费' : '开通'}${level}`,
      amount: moneyText(p.battery),
      kind: 'guard',
    };
  }
  if (ev?.type === 'SUPER_CHAT') {
    return { who, what: '醒目留言', amount: moneyText(p.battery), kind: 'sc' };
  }
  return null;
}

/** 真的开播了要清空上一场的礼物；启动校准补的 synthetic 不能清，那还是本场 */
export function clearsGifts(ev) {
  return ev?.type === 'LIVE_START' && ev?.payload?.synthetic !== true;
}

/* ────────────────────────── 状态 ────────────────────────── */

let lastSeq = 0;
let ws = null;
let retry = 0;
let retryTimer = null;
let clockTimer = null;
let paidTimer = null;
let startedAt = 0;
let liveState = 'offline';
let roomTitle = '';
/** @type {Array<{seq:number, line:ReturnType<typeof giftLine>}>} */
let gifts = [];

// 纯函数（金额/时长/礼物行）要能在 node 里单独测；只有真的在浏览器里才去摸 DOM。
const els = typeof document === 'undefined' ? null : {
  dot: $('ov-dot'),
  room: $('ov-room'),
  sub: $('ov-sub'),
  danmaku: $('ov-danmaku'),
  viewers: $('ov-viewers'),
  enter: $('ov-enter'),
  gift: $('ov-gift'),
  sc: $('ov-sc'),
  paid: $('ov-paid'),
  paidList: $('ov-paid-list'),
  gifts: $('ov-gifts'),
  giftList: $('ov-gift-list'),
  bigspend: $('ov-bigspend'),
  offline: $('ov-offline'),
};

function num(n) {
  const v = Math.max(0, Number(n) || 0);
  return v.toLocaleString('zh-CN');
}

function renderClock() {
  if (!els?.sub) return;
  if (liveState === 'live') {
    els.sub.textContent = startedAt
      ? `直播中 · 已播 ${durationText(Date.now() - startedAt)}`
      : '直播中';
  } else if (liveState === 'live_unknown') {
    els.sub.textContent = '已开播 · 起点未知';
  } else {
    els.sub.textContent = '未开播';
  }
  if (els.offline) els.offline.hidden = liveState !== 'offline';
}

function applyBrief(b) {
  if (!b || !els) return;

  roomTitle = b.title || '';
  els.room.textContent = roomTitle || (b.roomId ? `房间 ${b.roomId}` : '等待连接…');
  els.room.title = roomTitle;

  startedAt = Number(b.liveStartedAt) || 0;
  liveState = b.state || 'offline';

  els.danmaku.textContent = num(b.danmaku);
  els.viewers.textContent = num(b.uniqueViewers);
  els.enter.textContent = num(b.enterCount);
  els.gift.textContent = num(b.giftCount);
  els.sc.textContent = num(b.scCount);

  els.dot.className = `ov-dot${liveState === 'live' ? ' is-live' : liveState === 'live_unknown' ? ' is-unknown' : ''}`;
  renderClock();
}

function renderGifts() {
  if (!els?.giftList) return;
  els.giftList.replaceChildren(
    ...gifts.map(({ line }) => {
      const li = document.createElement('li');
      li.className = `ov-gift-row is-${line.kind}`;

      const what = document.createElement('span');
      what.className = 'ov-what';
      what.textContent = `${line.who} · ${line.what}`;

      const amount = document.createElement('span');
      amount.className = 'ov-amount';
      amount.textContent = line.amount;

      li.append(what, amount);
      return li;
    }),
  );
}

function pushGift(ev) {
  const line = giftLine(ev);
  if (!line) return;
  const seq = Number(ev?.seq) || 0;
  if (gifts.some((g) => g.seq === seq && seq > 0)) return;

  gifts.push({ seq, line });
  // 只留最近几条：这是挂件，不是弹幕流
  if (gifts.length > MAX_GIFTS) gifts = gifts.slice(-MAX_GIFTS);
  renderGifts();
}

function renderPaid(rows) {
  if (!els?.paidList) return;

  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'ov-paid-row';
    li.textContent = '暂时还没有付费记录';
    els.paidList.replaceChildren(li);
    return;
  }

  els.paidList.replaceChildren(
    ...rows.map((p, i) => {
      const li = document.createElement('li');
      li.className = 'ov-paid-row';

      const rank = document.createElement('span');
      rank.className = 'ov-rank';
      rank.textContent = String(i + 1);

      const name = document.createElement('span');
      name.className = 'ov-name';
      name.textContent = p.name || `uid ${p.uid ?? ''}`;
      name.title = String(p.uid ?? '');

      const money = document.createElement('span');
      money.className = 'ov-money';
      money.textContent = moneyText(p.totalBattery);

      li.append(rank, name, money);
      return li;
    }),
  );
}

async function loadPaid() {
  if (!els) return;
  try {
    const res = await fetch('/api/patrons?days=0&limit=5', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const data = await res.json();
    renderPaid(Array.isArray(data.patrons) ? data.patrons : []);
  } catch {
    // 挂件的原则：读不到就留着上一份，不要往直播画面上弹错误
  }
}

/* ────────────────────────── 大额提醒 ────────────────────────── */

let bigspendTimer = null;

function showBigSpend(text) {
  if (!els?.bigspend) return;
  els.bigspend.textContent = text;
  els.bigspend.hidden = false;
  clearTimeout(bigspendTimer);
  bigspendTimer = setTimeout(() => {
    els.bigspend.hidden = true;
  }, 8000);
}

/* ────────────────────────── WebSocket ────────────────────────── */

function ingest(ev) {
  if (!ev) return;
  const seq = Number(ev.seq) || 0;
  if (seq > lastSeq) lastSeq = seq;

  if (GIFT_TYPES.has(ev.type)) pushGift(ev);

  if (clearsGifts(ev)) {
    gifts = [];
    renderGifts();
  }

  if (ev.type === 'ROOM_TITLE' && ev.payload?.title) {
    roomTitle = String(ev.payload.title);
    if (els) els.room.textContent = roomTitle;
  }
}

function handle(msg) {
  switch (msg?.type) {
    case 'hello':
      applyBrief(msg.data?.status?.brief);
      break;
    case 'backlog':
      for (const ev of msg.data?.events ?? []) ingest(ev);
      break;
    case 'event':
      ingest(msg.data);
      break;
    case 'stats':
      applyBrief(msg.data);
      break;
    case 'notice': {
      const text = String(msg.data?.text ?? '');
      if (text.startsWith('【大额】')) showBigSpend(text);
      break;
    }
    case 'reset':
      // 换房间：上一间的礼物和时长不能挂到新房间头上
      gifts = [];
      lastSeq = 0;
      startedAt = 0;
      liveState = 'offline';
      renderGifts();
      renderClock();
      reconnect();
      break;
    default:
      break;
  }
}

function scheduleReconnect() {
  retry++;
  const delay = Math.min(8000, 400 * 2 ** Math.min(retry, 5)) + Math.random() * 300;
  retryTimer = setTimeout(connect, delay);
}

function connect() {
  clearTimeout(retryTimer);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try {
    socket = new WebSocket(`${proto}//${location.host}/ws?after=${lastSeq}`);
  } catch {
    scheduleReconnect();
    return;
  }

  ws = socket;

  socket.addEventListener('open', () => {
    if (ws !== socket) return;
    retry = 0;
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
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch {
      /* close 会跟着来 */
    }
  });
}

function reconnect() {
  clearTimeout(retryTimer);
  const old = ws;
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

/* ────────────────────────── 启动 ────────────────────────── */

if (els) {
  renderClock();
  renderGifts();
  connect();
  loadPaid();
  clockTimer = setInterval(renderClock, 1000);
  paidTimer = setInterval(loadPaid, PAID_REFRESH_MS);
}
