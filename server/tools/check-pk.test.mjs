import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PK_POLL_SEC,
  PK_STALE_MS,
  opponentEdge,
  pkCompare,
  pkRoomIdOf,
  pkRoomView,
  pkStale,
} from '../core/pk.mjs';

const info = (over = {}) => ({
  roomId: 100,
  uid: 900,
  title: '对面房间',
  liveState: 'live',
  online: 120,
  attention: 3400,
  areaName: '虚拟主播',
  ...over,
});

test('PK：房间号只收正整数，0 / 空 / 非数字都当没配', () => {
  assert.equal(pkRoomIdOf('1901584685'), '1901584685');
  assert.equal(pkRoomIdOf(' 123 '), '123');
  assert.equal(pkRoomIdOf('007'), '7');
  assert.equal(pkRoomIdOf(0), '');
  assert.equal(pkRoomIdOf('0'), '');
  assert.equal(pkRoomIdOf('abc'), '');
  assert.equal(pkRoomIdOf(''), '');
  assert.equal(pkRoomIdOf(null), '');
  assert.equal(pkRoomIdOf('1234567890123'), '');
});

test('PK：房间信息压成面板形状，榜单只取前 5 并合计', () => {
  const rank = {
    items: [1, 2, 3, 4, 5, 6].map((i) => ({ name: `人${i}`, score: i * 10 })),
    total: 210,
  };
  const view = pkRoomView(info(), { rank });
  assert.equal(view.roomId, '100');
  assert.equal(view.live, true);
  assert.equal(view.title, '对面房间');
  assert.equal(view.online, 120);
  assert.equal(view.rankTotal, 210);
  assert.equal(view.rankTop.length, 5);
  assert.deepEqual(view.rankTop[0], { name: '人1', score: 10 });
});

test('PK：没有信息时返回 null，缺字段时给安全默认值', () => {
  assert.equal(pkRoomView(null), null);
  const view = pkRoomView({ roomId: 7, liveState: 'round' });
  assert.equal(view.live, false);
  assert.equal(view.online, 0);
  assert.equal(view.attention, 0);
  assert.equal(view.rankTotal, 0);
  assert.deepEqual(view.rankTop, []);
});

test('PK：对比只算公开数字，领先方按人气判断', () => {
  const self = pkRoomView(info({ roomId: 1, online: 200, attention: 5000 }), {
    rank: { items: [], total: 300 },
  });
  const opp = pkRoomView(info({ roomId: 2, online: 120, attention: 3400 }), {
    rank: { items: [], total: 100 },
  });
  const c = pkCompare(self, opp);
  assert.equal(c.bothLive, true);
  assert.equal(c.lead, 'self');
  assert.equal(c.onlineGap, 80);
  assert.equal(c.attentionGap, 1600);
  assert.equal(c.rankGap, 200);

  const behind = pkCompare(self, { ...opp, online: 400 });
  assert.equal(behind.lead, 'opp');
  const tie = pkCompare(self, { ...opp, online: 200 });
  assert.equal(tie.lead, 'tie');
  assert.equal(pkCompare(self, null), null);
});

test('PK：两边都开播才算同时在线', () => {
  const live = pkRoomView(info());
  const off = pkRoomView(info({ liveState: 'off' }));
  assert.equal(pkCompare(live, live).bothLive, true);
  assert.equal(pkCompare(live, off).bothLive, false);
});

test('PK：对面开播 / 下播才出边沿，第一次拉数据不喊', () => {
  const live = pkRoomView(info());
  const off = pkRoomView(info({ liveState: 'off' }));
  assert.equal(opponentEdge(null, live), null, '第一次拿到数据时不能当成刚开播');
  assert.equal(opponentEdge(off, live), 'start');
  assert.equal(opponentEdge(live, off), 'end');
  assert.equal(opponentEdge(live, live), null);
  assert.equal(opponentEdge(off, off), null);
  assert.equal(opponentEdge(off, null), null);
});

test('PK：超过 3 分钟的数据算旧，轮询间隔是 60 秒', () => {
  assert.equal(PK_POLL_SEC, 60);
  assert.equal(PK_STALE_MS, 180_000);
  const now = 1_000_000;
  assert.equal(pkStale(now - 10_000, now), false);
  assert.equal(pkStale(now - PK_STALE_MS, now), false);
  assert.equal(pkStale(now - PK_STALE_MS - 1, now), true);
  assert.equal(pkStale(0, now), true);
  assert.equal(pkStale('nope', now), true);
});
