import test from 'node:test';
import assert from 'node:assert/strict';

import { battleOf, fetchPkBattle, PK_INFO_URL } from '../bili/pk-battle.mjs';

test('PK 状态：从 pk_info_v2 抠出进行中的一场', () => {
  const json = {
    code: 0,
    data: {
      pk_info_v2: {
        pk_basic: { pk_id: 401834805, status: 201, start_time: 1793877647, end_time: 1793877957 },
        members: [
          { uid: 3546781386279405, room_id: 1984344423, uname: '青梧客ke' },
          { uid: 3546788128623228, room_id: 1901584685, uname: 'Moon渔渔' },
        ],
      },
    },
  };
  const out = battleOf(json, 1793877700000);
  assert.equal(out.active, true);
  assert.equal(out.pkId, '401834805');
  assert.equal(out.startAt, 1793877647000);
  assert.equal(out.endAt, 1793877957000);
  assert.deepEqual(out.members, [
    { uid: '3546781386279405', roomId: '1984344423', name: '青梧客ke' },
    { uid: '3546788128623228', roomId: '1901584685', name: 'Moon渔渔' },
  ]);
});

test('PK 状态：没有 pk_info_v2 就是没在打', () => {
  assert.deepEqual(battleOf({ code: 0, data: {} }), {
    active: false,
    pkId: '',
    startAt: 0,
    endAt: 0,
    members: [],
  });
  assert.equal(battleOf({ code: 0, data: { pk_info_v2: { pk_basic: null } } }).active, false);
});

test('PK 状态：status 不标准时按结束时间兜底，过期的算结束', () => {
  const base = {
    code: 0,
    data: {
      pk_info_v2: {
        pk_basic: { pk_id: 7, status: 0, start_time: 100, end_time: 200 },
        members: [{ uid: 1, room_id: 2, uname: '甲' }],
      },
    },
  };
  assert.equal(battleOf(base, 150_000).active, true);
  assert.equal(battleOf(base, 250_000).active, false);
});

test('PK 状态：过滤空 uid、0 和缺房间号的成员', () => {
  const out = battleOf({
    code: 0,
    data: {
      pk_info_v2: {
        pk_basic: { pk_id: 1, status: 201, start_time: 1, end_time: 9e12 },
        members: [
          { uid: '', room_id: 1, uname: '空' },
          { uid: 0, room_id: 2, uname: '零' },
          { uid: 3, room_id: 0, uname: '缺房号' },
          { uid: 4, room_id: 5, uname: '  ' },
        ],
      },
    },
  }, 1000);
  assert.deepEqual(out.members, [{ uid: '4', roomId: '5', name: '房间 5' }]);
});

test('PK 状态：接口请求带 room_id，code 非 0 要抛', async () => {
  let url = '';
  let headers = {};
  const ok = await fetchPkBattle({
    roomId: '1901584685',
    fetchImpl: async (u, init) => {
      url = String(u);
      headers = init.headers;
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            pk_info_v2: {
              pk_basic: { pk_id: 9, status: 201, start_time: 1, end_time: 9e12 },
              members: [],
            },
          },
        }),
      };
    },
  });
  assert.equal(ok.pkId, '9');
  assert.ok(url.startsWith(PK_INFO_URL));
  assert.equal(new URL(url).searchParams.get('room_id'), '1901584685');
  assert.ok(headers['user-agent']);

  await assert.rejects(
    fetchPkBattle({
      roomId: '1',
      fetchImpl: async () => ({ ok: true, json: async () => ({ code: -400, message: 'bad' }) }),
    }),
    /bad/,
  );
});
