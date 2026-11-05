/**
 * 端到端冒烟验证：真实收一段弹幕，然后强制从日志重放，比对两次统计。
 *
 * 这是决策记录 D2 的现场证明：
 * **统计不需要"恢复逻辑"，只需要重放。**
 *
 * 用法：node server/tools/room-demo.mjs [房间号] [秒数]
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthStore } from '../auth.mjs';
import { RoomRunner } from '../room-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', '..', 'data');

const roomArg = process.argv[2] || '21452505';
const seconds = Math.max(5, Number(process.argv[3]) || 30);

const log = {
  debug() {},
  info: (m) => console.log(`  ${m}`),
  warn: (m) => console.log(`  ! ${m}`),
  error: (m) => console.log(`  x ${m}`),
};

const store = new AuthStore({ dataDir }).load();

console.log('');
console.log('  渔情LiveBot · 端到端验证');
console.log(`  ${store.describe()}`);
console.log('');

const runner = new RoomRunner({ roomId: roomArg, cookie: store.cookie, dataDir, log });

let count = 0;
runner.on('event', (ev) => {
  count++;
  if (count <= 8) {
    const p = ev.payload || {};
    console.log(`  #${ev.seq} ${ev.type} ${p.uname || p.uid || ''} ${p.text || p.giftName || ''}`);
  }
});

await runner.start();

setTimeout(() => {
  const before = runner.stats();
  const conn = runner.client ? runner.client.snapshot() : {};
  runner.stop();

  console.log('');
  console.log('  ---- 收包情况 ----');
  console.log(`  事件 ${count} 条 | 数据包 ${conn.stats?.packets ?? 0} | 忽略 ${conn.stats?.ignored ?? 0} | 无法解析 ${conn.stats?.unparsed ?? 0}`);

  console.log('');
  console.log('  ---- 内存里的统计（before）----');
  printStats(before);

  // 关键一步：新开一个 runner，只靠日志重建，不共享任何内存状态
  console.log('');
  console.log('  ---- 丢弃内存，从日志重放（after）----');
  const fresh = new RoomRunner({ roomId: runner.realRoomId, cookie: '', dataDir, log });
  const after = fresh.restore();
  printStats(after);

  // 逐字段比对
  const diffs = compare(before, after);
  console.log('');
  if (diffs.length === 0) {
    console.log('  ✓ 重放结果与内存统计完全一致 —— 重启不丢数据成立');
  } else {
    console.log('  ✗ 不一致，共 ' + diffs.length + ' 处：');
    for (const d of diffs) console.log('     ' + d);
  }
  console.log('');
  process.exit(diffs.length === 0 ? 0 : 1);
}, seconds * 1000);

function printStats(snap) {
  if (!snap) return console.log('    (无)');
  // 注意：snapshot() 是**扁平**结构，场次字段直接在顶层
  console.log(
    `    状态 ${snap.state} | 场次 ${snap.sessionId ?? '-'} | 弹幕 ${snap.danmaku} | 进场 ${snap.enterCount} | ` +
      `礼物 ${snap.giftCount} 个 ${snap.giftBattery} 电池 | 舰长 ${snap.guardCount} | 活跃观众 ${snap.uniqueViewers}`,
  );
  console.log(
    `    总累计：弹幕 ${snap.grand?.danmaku ?? 0} | 礼物 ${snap.grand?.giftCount ?? 0} 个 ${snap.grand?.giftBattery ?? 0} 电池`,
  );
}

/** 只比数字，不比时间戳 */
function compare(a, b) {
  const diffs = [];
  const pick = (s) => ({
    state: s?.state,
    sessionId: s?.sessionId ?? null,
    danmaku: s?.danmaku ?? 0,
    enterCount: s?.enterCount ?? 0,
    giftCount: s?.giftCount ?? 0,
    giftBattery: s?.giftBattery ?? 0,
    guardCount: s?.guardCount ?? 0,
    uniqueViewers: s?.uniqueViewers ?? 0,
    lastSeq: s?.lastSeq ?? 0,
    grandDanmaku: s?.grand?.danmaku ?? 0,
    grandGiftCount: s?.grand?.giftCount ?? 0,
    grandGiftBattery: s?.grand?.giftBattery ?? 0,
    grandBattery: s?.grand?.battery ?? 0,
  });

  const pa = pick(a);
  const pb = pick(b);

  for (const k of Object.keys(pa)) {
    if (pa[k] !== pb[k]) diffs.push(`${k}: 内存=${pa[k]} 重放=${pb[k]}`);
  }
  return diffs;
}
