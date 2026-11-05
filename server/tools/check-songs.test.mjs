import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SONG_ITEMS,
  applySongAction,
  parseSongRequest,
  pushSong,
  songNameOf,
  songPosition,
  songQueueView,
} from '../core/song-queue.mjs';

const sc = (text, extra = {}) => ({
  seq: 1,
  ts: 1_700_000_000_000,
  type: 'SUPER_CHAT',
  payload: { uid: '42', uname: '小明', text, yuan: 30, ...extra },
});

test('点歌：只认 SC 开头的「点歌」，别的话不收', () => {
  assert.deepEqual(parseSongRequest(sc('点歌 晴天')), { song: '晴天' });
  assert.deepEqual(parseSongRequest(sc('点歌：晴天')), { song: '晴天' });
  assert.deepEqual(parseSongRequest(sc('点歌，晴天')), { song: '晴天' });
  assert.equal(parseSongRequest(sc('想听晴天')), null);
  assert.equal(parseSongRequest(sc('点歌')), null);
  assert.equal(parseSongRequest({ type: 'DANMAKU', payload: { text: '点歌 晴天' } }), null);
  assert.equal(parseSongRequest({ type: 'SUPER_CHAT', payload: null }), null);
});

test('点歌：换行压成空格，歌名截到 40 字', () => {
  assert.deepEqual(parseSongRequest(sc('点歌\n晴天\r\n')), { song: '晴天' });
  const long = '一'.repeat(80);
  assert.equal(parseSongRequest(sc(`点歌 ${long}`)).song.length, 40);
});

test('点歌：名字回落顺序与金额口径', () => {
  assert.equal(songNameOf({ uname: ' 小明 ' }), '小明');
  assert.equal(songNameOf({ uname: '  ', name: '小红' }), '小红');
  assert.equal(songNameOf({ uid: '7' }), 'uid 7');
  assert.equal(songNameOf({ uid: '0' }), '匿名观众');
  assert.equal(songNameOf({}), '匿名观众');
});

test('点歌：进队列、位置、重复不重复加', () => {
  const items = [];
  const first = pushSong(items, { song: '晴天' }, sc('点歌 晴天'));
  assert.equal(items.length, 1);
  assert.equal(first.status, 'queued');
  assert.equal(songPosition(items, first.id), 1);

  const second = pushSong(items, { song: '后来' }, { ...sc('点歌 后来'), seq: 2 });
  assert.equal(songPosition(items, second.id), 2);

  // 同一个人点同一首、还在队里：不重复
  assert.equal(pushSong(items, { song: '晴天' }, { ...sc('点歌 晴天'), seq: 3 }), null);
  assert.equal(items.length, 2);

  // 播放完再点同一首：可以重新排
  applySongAction(items, first.id, 'done');
  assert.ok(pushSong(items, { song: '晴天' }, { ...sc('点歌 晴天'), seq: 4 }));
});

test('点歌：视图优先播放中，否则队首；queued 不含播放中', () => {
  const items = [
    { id: 'a', status: 'queued', song: 'A' },
    { id: 'b', status: 'playing', song: 'B' },
    { id: 'c', status: 'queued', song: 'C' },
  ];
  const v = songQueueView(items);
  assert.equal(v.current.id, 'b');
  assert.equal(v.queued, 2);
  assert.notEqual(v.items, items, '对外给副本，页面不能改内部数组');

  const v2 = songQueueView([{ id: 'a', status: 'queued', song: 'A' }]);
  assert.equal(v2.current.id, 'a');
});

test('点歌：播放会把上一条放回排队，完成/跳过会移除', () => {
  const items = [
    { id: 'a', status: 'playing' },
    { id: 'b', status: 'queued' },
  ];
  applySongAction(items, 'b', 'play');
  assert.equal(items[0].status, 'queued');
  assert.equal(items[1].status, 'playing');

  applySongAction(items, 'b', 'skip');
  assert.equal(items.length, 1);

  assert.equal(applySongAction(items, 'missing', 'play'), null);
  assert.equal(applySongAction(items, 'a', 'unknown'), null);
});

test('点歌：队列满了先丢已完成的，再丢最老的', () => {
  const items = [
    { id: 'old', status: 'done' },
    { id: 'a', status: 'queued' },
    { id: 'b', status: 'playing' },
  ];
  const added = pushSong(items, { song: '新歌' }, { ...sc('点歌 新歌'), seq: 9 }, { max: 3 });
  assert.ok(added);
  assert.equal(items.length, 3);
  assert.equal(items[0].id, 'a', '先丢 done 那条');
  assert.equal(items.some((it) => it.id === 'old'), false);

  // 没有可丢的完成项：丢最老
  const items2 = [
    { id: 'a', status: 'queued' },
    { id: 'b', status: 'playing' },
    { id: 'c', status: 'queued' },
  ];
  pushSong(items2, { song: '新歌' }, { ...sc('点歌 新歌'), seq: 10 }, { max: 3 });
  assert.equal(items2[0].id, 'b');
  assert.equal(items2.length, 3);
});

test('点歌：非法 uid 不排队，上限常量固定', () => {
  const items = [];
  assert.equal(pushSong(items, { song: '晴天' }, sc('点歌 晴天', { uid: '' })), null);
  assert.equal(pushSong(items, { song: '晴天' }, sc('点歌 晴天', { uid: '0' })), null);
  assert.equal(MAX_SONG_ITEMS, 100);
});
