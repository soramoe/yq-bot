import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PUSH_PROVIDERS,
  buildPushRequest,
  pushError,
  pushTargetProblem,
  sendPush,
} from '../core/push.mjs';

test('推送配置：空、空格、超长、渠道不符都要能说清', () => {
  assert.match(pushTargetProblem('', ''), /缺少|渠道|不能为空/);
  assert.match(pushTargetProblem('bark', ''), /不能为空/);
  assert.match(pushTargetProblem('bark', 'a b'), /空格/);
  assert.match(pushTargetProblem('bark', 'x'.repeat(301)), /太长/);
  assert.match(pushTargetProblem('telegram', 'x'), /不认识/);
  assert.equal(pushTargetProblem('bark', 'abc123'), '');
  assert.equal(pushTargetProblem('ntfy', 'yuyue3'), '');
  assert.equal(pushTargetProblem('serverchan', 'SCT123456789'), '');
});

test('Bark：key 拼路径，完整地址原样用', () => {
  const a = buildPushRequest('bark', 'abc123', '开播了', { title: '渔月崽三代' });
  assert.equal(
    a.url,
    `https://api.day.app/abc123/${encodeURIComponent('开播了')}?title=${encodeURIComponent('渔月崽三代')}&group=${encodeURIComponent('渔月崽三代')}&level=active`,
  );
  assert.equal(a.init.method, 'GET');

  const b = buildPushRequest('bark', 'https://api.day.app/mykey/', 'hi');
  assert.ok(b.url.startsWith('https://api.day.app/mykey/'));

  assert.equal(buildPushRequest('bark', 'bad key', 'hi'), null);
});

test('ntfy：topic 拼路径，标题走 query 不进 header', () => {
  const req = buildPushRequest('ntfy', 'yuyue3', '下播了', { title: '开播提醒' });
  assert.equal(req.url, `https://ntfy.sh/yuyue3?title=${encodeURIComponent('开播提醒')}&tags=fish`);
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.body, '下播了');
  assert.equal(req.init.headers['content-type'], 'text/plain; charset=utf-8');
});

test('Server酱：SendKey 拼地址，表单里带 title 与 desp', () => {
  const req = buildPushRequest('serverchan', 'SCT123456789', '大额提醒正文', { title: '大额提醒' });
  assert.equal(req.url, 'https://sctapi.ftqq.com/123456789.send');
  assert.equal(req.init.method, 'POST');
  const form = new URLSearchParams(req.init.body);
  assert.equal(form.get('title'), '大额提醒');
  assert.equal(form.get('desp'), '大额提醒正文');
});

test('平台错误：200 也可能是失败，按渠道读字段', () => {
  assert.equal(pushError('bark', { code: 200, message: 'success' }), '');
  assert.match(pushError('bark', { code: 400, message: 'bad key' }), /bad key/);
  assert.equal(pushError('ntfy', { id: 'x' }), '');
  assert.match(pushError('ntfy', { error: 'topic is too small' }), /topic/);
  assert.equal(pushError('serverchan', { code: 0 }), '');
  assert.match(pushError('serverchan', { code: 40001, message: 'bad key' }), /bad key/);
  assert.equal(pushError('bark', null), '');
});

test('sendPush：HTTP 200 + 平台错误 → ok:false', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 400, message: 'key 失效' }),
    };
  };
  const r = await sendPush('bark', 'abc', 'hi', { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /key 失效/);
  assert.equal(seen.init.method, 'GET');
});

test('sendPush：网络失败不抛出，只返回 error', async () => {
  const r = await sendPush('ntfy', 'yuyue3', 'hi', {
    fetchImpl: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test('sendPush：没配 fetch 或目标不合法时不请求', async () => {
  assert.equal((await sendPush('bark', 'abc', 'hi', { fetchImpl: null })).ok, false);
  const bad = await sendPush('bark', 'bad key', 'hi', { fetchImpl: async () => assert.fail('不该请求') });
  assert.equal(bad.ok, false);
  assert.ok(PUSH_PROVIDERS.includes('ntfy'));
});

test('sendPush：成功返回 status', async () => {
  const r = await sendPush('serverchan', 'SCT123456789', 'hi', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) }),
  });
  assert.deepEqual(r, { ok: true, status: 200 });
});
