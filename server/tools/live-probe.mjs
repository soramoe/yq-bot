/**
 * 直播间探针：连上一个真实房间，把收到的事件打出来。
 *
 * 这不是自检（自检必须离线），而是**手动验证工具**。
 * 用途：确认协议层在真实环境里工作 —— 房间号解析、弹幕服务器、认证、拆包、归一化。
 *
 * 用法：
 *   node server/tools/live-probe.mjs <房间号> [秒数]
 *   node server/tools/live-probe.mjs 1901584685 30
 *
 * 只读不写：这个工具不会发任何弹幕，也不会动二代正在跑的进程。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthStore } from '../auth.mjs';
import { LiveClient } from '../bili/live-client.mjs';
import { resolveRoomId, fetchRoomInfo } from '../bili/room.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const roomArg = process.argv[2] || '1901584685';
const seconds = Math.max(5, Number(process.argv[3]) || 30);

const log = {
  debug() {},
  info: (m) => console.log(`  ${m}`),
  warn: (m) => console.log(`  ! ${m}`),
  error: (m) => console.log(`  x ${m}`),
};

const store = new AuthStore({ dataDir: join(__dirname, '..', '..', 'data') }).load();

console.log('');
console.log('  渔情LiveBot · 直播间探针');
console.log(`  ${store.describe()}`);
console.log('');

const info = await resolveRoomId(roomArg);
console.log(`  房间：${roomArg} → ${info.roomId}`);
console.log(`  主播：${info.uid}  状态：${info.liveState}`);

const detail = await fetchRoomInfo(info.roomId, store.cookie);
console.log(`  标题：${detail.title || '(空)'}`);
console.log(`  分区：${detail.parentAreaName} / ${detail.areaName}  在线：${detail.online}`);
console.log('');

const client = new LiveClient({
  roomId: info.roomId,
  cookie: store.cookie,
  label: String(info.roomId),
  log,
});

let shown = 0;
const MAX_SHOW = 25;
const tally = Object.create(null);

client.on('resolved', (r) => {
  console.log(`  真实房间号：${r.roomId}`);
});

client.on('status', (s) => {
  console.log(`  [状态] ${s.status}${s.message ? ' - ' + s.message : ''}`);
});

client.on('popularity', (v) => {
  console.log(`  [人气] ${v}`);
});

client.on('event', (ev) => {
  tally[ev.type] = (tally[ev.type] ?? 0) + 1;
  if (shown >= MAX_SHOW) return;
  shown++;
  console.log(`  ${formatEvent(ev)}`);
});

function formatEvent(ev) {
  const p = ev.payload;
  const who = p.uname || p.uid || '?';

  switch (ev.type) {
    case 'DANMAKU':
      return `[弹幕] ${who}${p.medal ? `(${p.medal.name}${p.medal.level})` : ''}：${p.text || '(图片)'}`;
    case 'ENTER':
      return `[进场] ${who}${p.guardLevel ? ` 舰长${p.guardLevel}` : ''}`;
    case 'FOLLOW':
      return `[关注] ${who}`;
    case 'SHARE':
      return `[分享] ${who}`;
    case 'GIFT':
      return `[礼物] ${who} 送 ${p.giftName} ×${p.num}（${p.battery} 电池，${p.coinType}）`;
    case 'GUARD_BUY':
      return `[上舰] ${who} 等级${p.guardLevel} ×${p.num}（${p.battery} 电池${p.isRenew ? '，续费' : ''}）`;
    case 'SUPER_CHAT':
      return `[醒目留言] ${who} ¥${(p.battery / 10).toFixed(1)}：${p.text}`;
    case 'ONLINE_COUNT':
      return `[在线] ${p.count}`;
    case 'LIKE':
      return `[点赞] ${who}`;
    case 'LIVE_START':
      return '[开播]';
    case 'LIVE_END':
      return '[下播]';
    default:
      return `[${ev.type}] ${JSON.stringify(p).slice(0, 100)}`;
  }
}

console.log(`  开始接收（${seconds} 秒）…`);
console.log('');

await client.start().catch((err) => {
  console.log(`  连接失败：${err.message}`);
});

setTimeout(() => {
  client.stop();
  console.log('');
  console.log('  ---- 统计 ----');
  console.log(`  数据包 ${client.stats.packets} | 事件 ${client.stats.events} | 忽略 ${client.stats.ignored} | 无法解析 ${client.stats.unparsed}`);
  if (client.stats.inflatedFail) console.log(`  ! 有 ${client.stats.inflatedFail} 次解压失败`);

  const types = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (types.length === 0) {
    console.log('  没收到任何事件 —— 房间可能未开播，或该时段没人说话');
  } else {
    console.log('  ' + types.map(([t, n]) => `${t}×${n}`).join('  '));
  }
  console.log('');
  process.exit(0);
}, seconds * 1000);
