/**
 * 醒目留言（SC）答谢自检。
 *
 * 这里的每一条都对着一个「错了不报错」的真实缺陷：
 *
 *   1. **金额差 1000 倍**：SC 报文的 `price` 是元，却被当成金瓜子除以了 100。
 *      日志里一条 100 元的 SC 记为 1 电池（0.1 元），另一条直接记成 0。
 *      这种错误不会抛异常，只会让统计和答谢金额一起错得很自然。
 *   2. **没人认领**：SUPER_CHAT 长期没有插件接，花钱最多的人一句反馈都没有 ——
 *      直接违反「花了钱就一定有反馈」这条验收线。
 *   3. **弹幕只有 20 字**：复述留言必须截断，否则要么被发送层截在半个词上，
 *      要么整句被服务端拒掉。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path';

import { normalize } from '../bili/normalize.mjs';
import { PluginHost } from '../core/plugin-host.mjs';
import { Projection } from '../core/projection.mjs';
import { reconcile } from '../core/reconcile.mjs';

const PLUGIN_DIR = join(process.cwd(), 'plugins');

/* ═══════════════ 归一化：金额单位 ═══════════════ */

/** 一条原始 SC 报文。字段形状取自实测：price 是元，time 是置顶秒数 */
function rawSc({ uid = 7001, uname = '老板', price = 100, message = '加油', time = 300 } = {}) {
  return {
    cmd: 'SUPER_CHAT_MESSAGE',
    data: {
      uid,
      price,
      message,
      time,
      user_info: { uname },
    },
  };
}

test('SC 金额：100 元必须是 1000 电池，不是 1（曾经差 1000 倍）', () => {
  const ev = normalize(rawSc({ price: 100 }));
  assert.equal(ev.payload.yuan, 100);
  assert.equal(ev.payload.battery, 1000, '100 元 = 1000 电池');
  assert.equal(ev.payload.price, 100, 'price 保持元，方便文案直接引用');
});

test('SC 金额：30 元写 300 电池，不能被四舍五入成 0', () => {
  const ev = normalize(rawSc({ price: 30 }));
  assert.equal(ev.payload.battery, 300);
  assert.equal(ev.payload.yuan, 30);
});

test('SC 金额：小额也不会被抹成 0（旧实现 50 元档会记成 0）', () => {
  const ev = normalize(rawSc({ price: 50 }));
  assert.equal(ev.payload.battery, 500);
});

/* ═══════════════ 插件 ═══════════════ */

async function makeHost(t, config = {}, saysOverride = null) {
  const says = [];
  const host = new PluginHost({
    dir: PLUGIN_DIR,
    say: async (args) => {
      says.push(args);
      return saysOverride ? saysOverride(args) : { ok: true, text: args.text };
    },
    getState: () => ({ roomId: '999' }),
    configs: { sc: config },
  });
  await host.load();
  await host.startAll();
  t.after(async () => {
    await host.stopAll();
  });
  return { host, says };
}

/** 一条已归一化好的 SC 事件 */
function scEvent(payloadOver = {}) {
  return {
    type: 'SUPER_CHAT',
    payload: {
      uid: '7001',
      uname: '老板',
      text: '这波操作太秀了',
      yuan: 30,
      battery: 300,
      price: 30,
      duration: 60,
      ...payloadOver,
    },
  };
}

test('SC：有人发醒目留言就道谢，认领 SUPER_CHAT', async (t) => {
  const { host, says } = await makeHost(t);

  const r = await host.dispatch(scEvent());

  assert.equal(r.claimedBy, 'sc');
  assert.equal(says.length, 1);
  assert.equal(says[0].text, '感谢老板的30元SC！');
  assert.equal(says[0].reason, 'sc');
  assert.deepEqual(says[0].reply, { uid: '7001', uname: '老板' });
});

test('SC：默认不复述留言（弹幕只有 20 字，复述会被截断）', async (t) => {
  const { host, says } = await makeHost(t);
  await host.dispatch(scEvent({ text: '这是一段很长很长的留言内容会超过弹幕上限' }));
  assert.equal(says.length, 1);
  assert.ok(!says[0].text.includes('很长'), `不该带留言，实际：${says[0].text}`);
});

test('SC：打开复述后，留言按 maxTextLen 截断', async (t) => {
  const { host, says } = await makeHost(t, {
    readText: true,
    maxTextLen: 4,
    templateWithText: '感谢 {用户} 的 {金额} 元 SC：{留言}',
  });

  await host.dispatch(scEvent({ text: '这波操作太秀了' }));
  assert.equal(says.length, 1);
  assert.equal(says[0].text, '感谢 老板 的 30 元 SC：这波操作');
});

test('SC：整数金额不带小数点（30 元不是 30.0 元）', async (t) => {
  const { host, says } = await makeHost(t);
  await host.dispatch(scEvent({ yuan: 30, battery: 300 }));
  assert.equal(says[0].text, '感谢老板的30元SC！');
});

test('SC：低于金额门槛时不认领，也不说话', async (t) => {
  const { host, says } = await makeHost(t, { minYuan: 50 });
  const r = await host.dispatch(scEvent({ yuan: 30, battery: 300 }));
  assert.equal(r.claimedBy, null);
  assert.equal(says.length, 0);
});

test('SC：没有用户名时不认领（没法称呼）', async (t) => {
  const { host, says } = await makeHost(t);
  const r = await host.dispatch(scEvent({ uname: '   ' }));
  assert.equal(r.claimedBy, null);
  assert.equal(says.length, 0);
});

test('SC：优先级高于礼物答谢（都花钱，但置顶更急）', async (t) => {
  const { host, says } = await makeHost(t);
  await host.dispatch(scEvent());
  assert.equal(says.length, 1);
  assert.equal(says[0].priority, 2, '礼物答谢是 1，SC 必须更高');
  assert.ok(says[0].maxWaitMs >= 3000, '买置顶的人值得多等一会儿');
});

test('SC：关掉开关后不认领（要能一秒钟关掉）', async (t) => {
  const { host, says } = await makeHost(t, { enabled: false });
  const r = await host.dispatch(scEvent());
  assert.equal(r.claimedBy, null);
  assert.equal(says.length, 0);
});

test('SC：同人同额连发两条，两条都请求发送（合不合并是闸门的事）', async (t) => {
  const { host, says } = await makeHost(t);
  await host.dispatch(scEvent());
  await host.dispatch(scEvent());
  assert.equal(says.length, 2, 'SC 绝不合并：一条就是一条');
});

/* ═══════════════ 投影与对账 ═══════════════ */

function ev(seq, type, payload, ts = 1000 + seq) {
  return { seq, id: `e-${seq}`, ts, roomId: '999', type, source: 'system', payload };
}

test('投影：SC 计入本场与总累计，且金额用电池', () => {
  const p = new Projection('999');
  p.applyAll([
    ev(1, 'LIVE_START', {}),
    ev(2, 'SUPER_CHAT', { uid: '1', uname: 'a', battery: 1000, yuan: 100 }),
    ev(3, 'SUPER_CHAT', { uid: '2', uname: 'b', battery: 300, yuan: 30 }),
  ]);

  const s = p.snapshot();
  assert.equal(s.scCount, 2);
  assert.equal(s.scBattery, 1300);
  assert.equal(s.grand.scCount, 2);
  assert.equal(s.grand.scBattery, 1300);
});

test('对账：SC 的条数与金额两条都要参与比对并一致', () => {
  const events = [
    ev(1, 'LIVE_START', {}),
    ev(2, 'SUPER_CHAT', { uid: '1', uname: 'a', battery: 1000, yuan: 100 }),
  ];
  const p = new Projection('999');
  p.applyAll(events);

  const report = reconcile({ events, snapshot: p.snapshot() });
  const scChecks = report.checks.filter((c) => /醒目留言/.test(c.name));
  assert.ok(scChecks.length >= 2, 'SC 必须有独立的对账项，否则金额错了没人知道');
  assert.ok(scChecks.every((c) => c.pass), JSON.stringify(scChecks.filter((c) => !c.pass)));
  assert.equal(report.ok, true);
});

/**
 * 弹幕只有 20 字，默认文案必须自己就能装进去。
 *
 * 这条不是洁癖：超长会被发送层静默截断，句子断在半个词上。
 * 默认配置是"开箱即用"的意思 —— 用户什么都不改时，它就该是完整的。
 */
test('SC：默认文案在长用户名下也不超弹幕上限', async (t) => {
  const { host, says } = await makeHost(t);
  // CZCJiaxu 是实测抓到的真实用户名，9 个字符，属于偏长的
  await host.dispatch(scEvent({ uname: 'CZCJiaxu', yuan: 100, battery: 1000 }));
  assert.equal(says.length, 1);
  assert.ok(
    says[0].text.length <= 20,
    `默认文案必须 ≤20 字，实际 ${says[0].text.length}：${says[0].text}`,
  );
});
