import test from 'node:test';
import assert from 'node:assert/strict';

import { ONLINE_RANK_URL, fetchOnlineRank, onlineRankUids } from '../bili/rank.mjs';

const okJson = (list, extra = {}) => ({ code: 0, message: '0', data: { onlineNum: 12, OnlineRankItem: list, ...extra } });

test('高能榜：解析 OnlineRankItem，过滤空 uid 与 0', () => {
  const { uids, onlineNum } = onlineRankUids(
    okJson([
      { uid: 1001, name: '甲' },
      { uid: '1002', name: '乙' },
      { uid: 0, name: '平台' },
      { uid: '', name: '空' },
      { name: '没 uid' },
    ]),
  );
  assert.deepEqual([...uids], ['1001', '1002']);
  assert.equal(onlineNum, 12);
});

test('高能榜：也兼容小写 onlineRankItem', () => {
  const { uids, onlineNum } = onlineRankUids({
    code: 0,
    data: { onlineNum: 3, onlineRankItem: [{ uid: '42' }] },
  });
  assert.deepEqual([...uids], ['42']);
  assert.equal(onlineNum, 3);
});

test('高能榜：没有榜单数据时返回空集合，不是报错', () => {
  const { uids, onlineNum } = onlineRankUids({ code: 0, data: {} });
  assert.equal(uids.size, 0);
  assert.equal(onlineNum, 0);
  assert.equal(onlineRankUids(null).uids.size, 0);
});

test('高能榜：请求带 roomId/ruid/page/pageSize、UA、Referer 与 Cookie', async () => {
  let seen = null;
  const result = await fetchOnlineRank({
    roomId: 1901584685,
    ruid: 1970515035,
    cookie: 'SESSDATA=abc; bili_jct=def',
    page: 2,
    pageSize: 20,
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { json: async () => okJson([{ uid: '777' }]) };
    },
  });

  assert.equal(seen.url.origin + seen.url.pathname, ONLINE_RANK_URL);
  assert.equal(seen.url.searchParams.get('roomId'), '1901584685');
  assert.equal(seen.url.searchParams.get('ruid'), '1970515035');
  assert.equal(seen.url.searchParams.get('page'), '2');
  assert.equal(seen.url.searchParams.get('pageSize'), '20');
  assert.equal(seen.opts.headers.Referer, 'https://live.bilibili.com/1901584685');
  assert.match(seen.opts.headers['User-Agent'], /Mozilla|Chrome|Edge/i);
  assert.equal(seen.opts.headers.Cookie, 'SESSDATA=abc; bili_jct=def');
  assert.deepEqual([...result.uids], ['777']);
});

test('高能榜：没传 ruid 时从 cookie 的 DedeUserID 兜底，不能传 0', async () => {
  let seen = null;
  await fetchOnlineRank({
    roomId: 100,
    cookie: 'SESSDATA=abc; DedeUserID=1970515035; bili_jct=def',
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { json: async () => okJson([]) };
    },
  });
  assert.equal(seen.url.searchParams.get('ruid'), '1970515035');
});

test('高能榜：ruid 传字符串 "0" 也要按缺失处理，从 cookie 兜底', async () => {
  let seen = null;
  await fetchOnlineRank({
    roomId: 100,
    ruid: '0',
    cookie: 'DedeUserID=1970515035',
    fetchImpl: async (url) => {
      seen = url;
      return { json: async () => okJson([]) };
    },
  });
  assert.equal(seen.searchParams.get('ruid'), '1970515035');
});

test('高能榜：没有 cookie 时不带 Cookie 头，ruid 缺省 0', async () => {
  let seen = null;
  await fetchOnlineRank({
    roomId: 100,
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { json: async () => okJson([]) };
    },
  });
  assert.equal(seen.url.searchParams.get('ruid'), '0');
  assert.equal(Object.prototype.hasOwnProperty.call(seen.opts.headers, 'Cookie'), false);
});

test('高能榜：接口 code 非 0 时抛错并带原 message', async () => {
  await assert.rejects(
    () =>
      fetchOnlineRank({
        roomId: 1,
        fetchImpl: async () => ({ json: async () => ({ code: -400, message: '请求错误' }) }),
      }),
    /高能榜接口返回 -400：请求错误/,
  );
});

test('高能榜：缺房间号或没有 fetch 时直接抛错，不发请求', async () => {
  await assert.rejects(() => fetchOnlineRank({ roomId: 0 }), /缺少房间号/);
  await assert.rejects(
    () => fetchOnlineRank({ roomId: 1, fetchImpl: null }),
    /no fetch/,
  );
});
