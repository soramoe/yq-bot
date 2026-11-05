/**
 * 礼物答谢 / 盲盒播报 / 盲盒字段解析 自检。
 *
 * 三件事必须测死，因为它们都是"错了不会报错，只会表现得很怪"的那种：
 *
 *   1. **连击差值法**：B站 客户端攒着发，中间报文会丢。数量算错不会抛异常，
 *      只会让答谢写「×3」而统计说 5 个 —— 事后根本查不出来。
 *   2. **仲裁让路**：盲盒不播时答谢必须接手。二代就是这里错位，
 *      结果「观众花了钱，一条反馈都没有」。
 *   3. **盲盒字段**：字段号是从真实报文里对出来的，没有任何 schema 保护。
 *      这里手工拼一段 protobuf 来锁住字段号，改错了立刻红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { PluginHost } from '../core/plugin-host.mjs';
import { normalize } from '../bili/normalize.mjs';

const PLUGIN_DIR = join(process.cwd(), 'plugins');

/* ═══════════════ 手工拼 protobuf（只为了锁字段号） ═══════════════ */

function varint(n) {
  const out = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint(field * 8 + wire);
}

function pbInt(field, n) {
  return Buffer.concat([tag(field, 0), varint(n)]);
}

function pbRaw(field, buf) {
  return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
}

function pbText(field, s) {
  return pbRaw(field, Buffer.from(String(s), 'utf8'));
}

/**
 * 造一条 SEND_GIFT_V2。
 * 字段号与 server/bili/normalize.mjs 的注释一一对应：
 *   礼物明细 #1 id #2 名称 #3 数量 #5 单价 #6 总价 #8 gold/silver #11 连击数
 *   盲盒元信息（顶层第 9 层）#2 盒子 id #3 盒子名 #6 盒子单价
 */
function giftV2({ uid = 1001, uname = '小明', giftId, giftName, num, price, total, combo = 0, box = null }) {
  const detail = Buffer.concat([
    pbInt(1, giftId),
    pbText(2, giftName),
    pbInt(3, num),
    pbInt(5, price),
    pbInt(6, total),
    pbText(8, 'gold'),
    ...(combo ? [pbInt(11, combo)] : []),
  ]);

  const parts = [pbInt(1, uid), pbText(2, uname), pbRaw(3, detail)];

  if (box) {
    parts.push(
      pbRaw(
        9,
        Buffer.concat([pbInt(2, box.id), pbText(3, box.name), pbInt(6, box.coin)]),
      ),
    );
  }

  return { cmd: 'SEND_GIFT_V2', data: { pb: Buffer.concat(parts).toString('base64') } };
}

/* ═══════════════ 归一化：盲盒 ═══════════════ */

test('盲盒：报文带第 9 层时解析出盒子、成本、盈亏', () => {
  const ev = normalize(
    giftV2({
      giftId: 35207,
      giftName: '小花花',
      num: 1,
      price: 10000,
      total: 10000, // 100 电池的奖品
      box: { id: 35206, name: '幸运盲盒', coin: 5000 }, // 50 电池的盒子
    }),
  );

  assert.equal(ev.type, 'GIFT');
  assert.ok(ev.payload.blind, '这一条必须认成盲盒');
  assert.equal(ev.payload.blind.boxName, '幸运盲盒');
  assert.equal(ev.payload.blind.cost, 50);
  assert.equal(ev.payload.blind.value, 100);
  assert.equal(ev.payload.blind.profit, 50);
});

test('盲盒：普通礼物没有第 9 层，blind 必须是 null（不靠奖品 id 反猜）', () => {
  const ev = normalize(
    giftV2({ giftId: 35207, giftName: '小花花', num: 1, price: 100, total: 100 }),
  );
  assert.equal(ev.payload.blind, null);
});

test('盲盒：一次买 3 个盒子，成本要乘 3', () => {
  const ev = normalize(
    giftV2({
      giftId: 35207,
      giftName: '小花花',
      num: 3,
      price: 100,
      total: 300,
      box: { id: 35206, name: '幸运盲盒', coin: 5000 },
    }),
  );
  assert.equal(ev.payload.blind.num, 3);
  assert.equal(ev.payload.blind.cost, 150, '3 个盒子 = 150 电池');
  assert.equal(ev.payload.blind.profit, -147);
});

/* ═══════════════ 插件宿主 ═══════════════ */

async function makeHost(t, { gift = {}, blind = {}, getState } = {}) {
  const says = [];
  const host = new PluginHost({
    dir: PLUGIN_DIR,
    say: async (args) => {
      says.push(args);
      return { ok: true, text: args.text };
    },
    getState: getState ?? (() => ({ roomId: '999' })),
    configs: { welcome: {}, gift, blind },
  });
  await host.load();
  await host.startAll();
  t.after(async () => {
    await host.stopAll();
  });
  return { host, says };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一条普通（非盲盒）礼物事件 */
function giftEvent(over = {}, payloadOver = {}) {
  return {
    type: 'GIFT',
    payload: {
      uid: 1001,
      uname: '小明',
      giftId: 30001,
      giftName: '小花花',
      num: 1,
      price: 1,
      battery: 1,
      isPaid: true,
      comboCount: 0,
      blind: null,
      ...payloadOver,
    },
    ...over,
  };
}

/* ═══════════════ 礼物答谢 ═══════════════ */

test('答谢：合上窗口后说一句话，数量为 1 时用单数文案', async (t) => {
  const { host, says } = await makeHost(t, { gift: { mergeSec: 0.05 } });

  const r = await host.dispatch(giftEvent());
  assert.equal(r.claimedBy, 'gift');

  await sleep(300);

  assert.equal(says.length, 1);
  assert.equal(says[0].text, '感谢 小明 的小花花！');
  assert.equal(says[0].reason, 'gift');
  // uid 统一成字符串：B站 报文里是数字，带上 @ 回复时要用同一个值
  assert.deepEqual(says[0].reply, { uid: '1001', uname: '小明' });
});

test('答谢：连击差值法 —— comboCount 从 1 跳到 5，数量必须是 5 而不是 3', async (t) => {
  const { host, says } = await makeHost(t, {
    gift: {
      mergeSec: 0.08,
      templateMulti: '感谢 {用户} 的{礼物}×{数量}（{电池}电池）',
    },
  });

  // 观众实际送了 5 个，但服务端只推过来 3 条报文
  await host.dispatch(giftEvent({}, { comboCount: 1 }));
  await host.dispatch(giftEvent({}, { comboCount: 2 }));
  await host.dispatch(giftEvent({}, { comboCount: 5 }));

  await sleep(300);

  assert.equal(says.length, 1, '合并成一句，不能刷屏');
  assert.equal(says[0].text, '感谢 小明 的小花花×5（5电池）');
});

test('答谢：没有 comboCount 时退回累加 num', async (t) => {
  const { host, says } = await makeHost(t, {
    gift: { mergeSec: 0.08, templateMulti: '{礼物}×{数量}' },
  });

  await host.dispatch(giftEvent({}, { num: 2, battery: 2, comboCount: 0 }));
  await host.dispatch(giftEvent({}, { num: 3, battery: 3, comboCount: 0 }));

  await sleep(300);

  assert.equal(says[0].text, '小花花×5');
});

test('答谢：合并窗口按**事件时间**算 —— 回放里 40 秒后的礼物不能并成一句', async (t) => {
  const { host, says } = await makeHost(t, { gift: { mergeSec: 8 } });
  const t0 = Date.now() - 3600_000; // 一小时前的历史日志

  await host.dispatch(giftEvent({ ts: t0 }));
  await host.dispatch(giftEvent({ ts: t0 + 40_000 }, { comboCount: 2 }));

  // 回放里现实时钟几乎没动，但这两条相隔 40 秒，早过了 8 秒窗口
  await host.replayEnd();

  assert.equal(says.length, 2, '按现实时钟算的话这里只会有一条 —— 沙盒就少说了一句');
});

test('答谢：窗口内的两条仍然合并（按事件时间也不能拆开）', async (t) => {
  const { host, says } = await makeHost(t, {
    gift: { mergeSec: 8, templateMulti: '{礼物}×{数量}' },
  });
  const t0 = Date.now() - 3600_000;

  await host.dispatch(giftEvent({ ts: t0 }));
  await host.dispatch(giftEvent({ ts: t0 + 2000 }, { comboCount: 2 }));
  await host.replayEnd();

  assert.equal(says.length, 1, '2 秒 < 8 秒窗口，必须合成一句');
  assert.equal(says[0].text, '小花花×2');
});

test('答谢：收尾时把最后一条也结清（否则沙盒里结尾那句会凭空消失）', async (t) => {
  const { host, says } = await makeHost(t, { gift: { mergeSec: 60 } });
  // 窗口 60 秒，而回放只跑几十毫秒 —— 定时器一次都不会到点
  await host.dispatch(giftEvent({ ts: Date.now() - 3600_000 }));
  assert.equal(says.length, 0, '这时候还没到期');

  await host.replayEnd();
  assert.equal(says.length, 1, '收尾必须把攒下的结清');
});

test('答谢：同一个人换了礼物，旧的先结算（否则两条答谢会乱序）', async (t) => {
  const { host, says } = await makeHost(t, { gift: { mergeSec: 0.06 } });

  await host.dispatch(giftEvent({}, { giftId: 1, giftName: '甲' }));
  await host.dispatch(giftEvent({}, { giftId: 2, giftName: '乙' }));

  assert.equal(says.length, 1, '换礼物的那一刻旧的必须先发');
  assert.match(says[0].text, /甲/);

  await sleep(300);
  assert.equal(says.length, 2);
  assert.match(says[1].text, /乙/);
});

test('答谢：免费礼物不认领（不花钱的不占弹幕）', async (t) => {
  const { host, says } = await makeHost(t, { gift: { mergeSec: 0.05 } });
  const r = await host.dispatch(giftEvent({}, { isPaid: false }));
  assert.equal(r.claimedBy, null);
  await sleep(80);
  assert.equal(says.length, 0);
});

test('答谢：低于门槛的礼物不认领', async (t) => {
  const { host, says } = await makeHost(t, { gift: { mergeSec: 0.05, minBattery: 10 } });
  assert.equal((await host.dispatch(giftEvent({}, { battery: 1 }))).claimedBy, null);
  assert.equal((await host.dispatch(giftEvent({}, { battery: 50 }))).claimedBy, 'gift');
  await sleep(300);
  assert.equal(says.length, 1);
  assert.match(says[0].text, /小花花/);
});

test('答谢：关掉合并后立即发，不等窗口', async (t) => {
  const { host, says } = await makeHost(t, { gift: { mergeOn: false } });
  await host.dispatch(giftEvent());
  assert.equal(says.length, 1, '关闭合并应当同步就发出去');
});

test('答谢：关掉开关后不认领', async (t) => {
  const { host, says } = await makeHost(t, { gift: { enabled: false } });
  assert.equal((await host.dispatch(giftEvent())).claimedBy, null);
  await sleep(80);
  assert.equal(says.length, 0);
});

test('答谢：顺延有上限 —— 一直送礼也必须先发一次', async (t) => {
  const impl = (await import('../../plugins/gift/plugin.mjs')).default;

  // 第一条是 25 秒前到期的，而最长只允许等 20 秒 → 这次合并后应当立即到期
  const first = Date.now() - 25000;
  const prev = { num: 1, total: 1, lastCombo: 1, first, deadline: first };
  impl._merge(prev, { num: 1, total: 1, lastCombo: 2 }, { mergeSec: 8, maxWaitSec: 20 });

  assert.equal(prev.deadline, first + 20000, '顺延封顶在第一次之后 20 秒');
  assert.ok(prev.deadline < Date.now(), '已经超过封顶时间，下一个 tick 就该发');
  assert.equal(prev.num, 2, '封顶不影响计数');
});

test('答谢：一个人连送多个不同礼物时，不会把别人并进来', async (t) => {
  const { host, says } = await makeHost(t, {
    gift: { mergeSec: 0.05, template: '{用户}×{数量}', templateMulti: '{用户}×{数量}' },
  });

  // uid 缺失、昵称不同 → 必须各算一条
  await host.dispatch(giftEvent({}, { uid: '', uname: '甲' }));
  await host.dispatch(giftEvent({}, { uid: '', uname: '乙' }));
  await sleep(300);

  assert.equal(says.length, 2, '两个匿名观众不能被并成一条');
  assert.equal(says[0].text, '甲×1');
  assert.equal(says[1].text, '乙×1');
});

test('答谢：两个房间的同一个观众不会被并成一条', async (t) => {
  let room = '111';
  const { host, says } = await makeHost(t, {
    gift: { mergeSec: 0.05 },
    getState: () => ({ roomId: room }),
  });

  // 同一个 uid 在两个房间各送一个 —— 这是两个人
  await host.dispatch(giftEvent());
  room = '222';
  await host.dispatch(giftEvent());

  await sleep(300);

  assert.equal(says.length, 2, '合并键里必须带房间，否则会答谢成「×2」记到一个人头上');
  for (const s of says) assert.doesNotMatch(s.text, /×/);
});

/* ═══════════════ 盲盒播报与仲裁 ═══════════════ */

const BOX = { boxId: 35206, boxName: '幸运盲盒', num: 1, cost: 50, value: 100, profit: 50 };

function blindEvent({ uid = 9001, uname = '欧皇', profit = 50, box = BOX, ts } = {}) {
  return giftEvent(
    ts ? { ts } : {},
    { uid, uname, giftName: '小花花', battery: 100, blind: { ...box, profit } },
  );
}

test('盲盒：赚了就说开出什么，并抢在答谢前面认领', async (t) => {
  const { host, says } = await makeHost(t, { gift: { mergeSec: 0.05 } });

  const r = await host.dispatch(blindEvent());
  assert.equal(r.claimedBy, 'blind', '盲盒优先级更高（claims 200 > 100）');
  assert.equal(says.length, 1);
  assert.match(says[0].text, /幸运盲盒/);
  assert.match(says[0].text, /赚 50 电池/);
  assert.equal(says[0].reason, 'blind');

  await sleep(300);
  assert.equal(says.length, 1, '认领了就不能再被答谢一次');
});

test('盲盒：亏了且低于门槛 → 让路给礼物答谢（这条就是二代的老 bug）', async (t) => {
  const { host, says } = await makeHost(t, {
    gift: { mergeSec: 0.05 },
    blind: { minProfit: 0 },
  });

  const r = await host.dispatch(blindEvent({ profit: -20 }));
  assert.equal(r.claimedBy, 'gift', '盲盒不播时必须由答谢接手，不能让观众一条反馈都没有');

  await sleep(300);
  assert.equal(says.length, 1);
  assert.match(says[0].text, /小花花/);
  assert.doesNotMatch(says[0].text, /盲盒/);
});

test('盲盒：同一人冷却期内让路，而不是吞掉', async (t) => {
  const { host, says } = await makeHost(t, {
    gift: { mergeSec: 0.05 },
    blind: { cooldownSec: 30 },
  });

  assert.equal((await host.dispatch(blindEvent({ profit: 80 }))).claimedBy, 'blind');
  assert.equal(
    (await host.dispatch(blindEvent({ profit: 80 }))).claimedBy,
    'gift',
    '冷却里的第二个盲盒交回答谢',
  );

  await sleep(300);
  assert.equal(says.length, 2);
  assert.equal(says[0].reason, 'blind');
  assert.equal(says[1].reason, 'gift');
});

test('盲盒：冷却按**事件时间**算 —— 回放里 60 秒后的第二个盒子还要播', async (t) => {
  const { host, says } = await makeHost(t, {
    gift: { mergeSec: 0.05 },
    blind: { cooldownSec: 30 },
  });
  const t0 = Date.now() - 3600_000; // 一小时前的历史日志

  const first = await host.dispatch(blindEvent({ profit: 80, ts: t0 }));
  const second = await host.dispatch(blindEvent({ profit: 80, ts: t0 + 60_000 }));

  assert.equal(first.claimedBy, 'blind');
  // 回放把一小时压进几十毫秒。用现实时钟的话，两条只差 1ms，第二个会被冷却挡住
  assert.equal(second.claimedBy, 'blind', '当时是隔了一分钟播的，回放也不能少这一句');
  await sleep(200);
  assert.equal(says.filter((s) => s.reason === 'blind').length, 2);
});

test('盲盒：关掉开关后完全让路', async (t) => {
  const { host } = await makeHost(t, { blind: { enabled: false } });
  assert.equal((await host.dispatch(blindEvent())).claimedBy, 'gift');
});
