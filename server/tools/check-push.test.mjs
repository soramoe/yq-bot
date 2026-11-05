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
  assert.match(pushTargetProblem('sms', 'x'), /不认识/);
  assert.equal(pushTargetProblem('bark', 'abc123'), '');
  assert.equal(pushTargetProblem('ntfy', 'yuyue3'), '');
  assert.equal(pushTargetProblem('serverchan', 'SCT123456789'), '');
});

test('Telegram：token|chat_id 的形状校验', () => {
  const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
  assert.equal(pushTargetProblem('telegram', `${token}|-1001234567890`), '');
  assert.match(pushTargetProblem('telegram', token), /bot_token\|chat_id/);
  assert.match(pushTargetProblem('telegram', 'abc|123456789'), /bot token/);
  assert.match(pushTargetProblem('telegram', `${token}|abc`), /chat_id/);
  assert.match(pushTargetProblem('telegram', 'https://api.telegram.org/x'), /不是网址/);
});

test('Telegram：拼 sendMessage 请求，正文进 JSON', () => {
  const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
  const req = buildPushRequest('telegram', `${token}|-1001234567890`, '开播了', { title: '标题不参与' });
  assert.equal(req.url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(req.init.body), {
    chat_id: '-1001234567890',
    text: '开播了',
    disable_web_page_preview: true,
  });
});

test('Bark：key 拼路径，完整地址原样用', () => {
  const a = buildPushRequest('bark', 'abc123', '开播了', { title: '渔情LiveBot' });
  assert.equal(
    a.url,
    `https://api.day.app/abc123/${encodeURIComponent('开播了')}?title=${encodeURIComponent('渔情LiveBot')}&group=${encodeURIComponent('渔情LiveBot')}&level=active`,
  );
  assert.equal(a.init.method, 'GET');

  const b = buildPushRequest('bark', 'https://api.day.app/mykey/', 'hi');
  assert.ok(b.url.startsWith('https://api.day.app/mykey/'));

  assert.equal(buildPushRequest('bark', 'bad key', 'hi'), null);
});

test('推送：完整地址自带 query 时追加参数，不再拼第二个问号', () => {
  const n = buildPushRequest('ntfy', 'https://ntfy.sh/yuyue3?auth=abc', 'hi');
  assert.equal(new URL(n.url).searchParams.get('auth'), 'abc');
  assert.equal(new URL(n.url).searchParams.get('title'), '渔情LiveBot');
  assert.equal(n.url.split('?').length - 1, 1, '只能有一个问号');

  const b = buildPushRequest('bark', 'https://api.day.app/mykey?x=1', 'hi');
  assert.equal(new URL(b.url).searchParams.get('x'), '1');
  assert.equal(new URL(b.url).searchParams.get('level'), 'active');
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
  assert.equal(pushError('telegram', { ok: true }), '');
  assert.match(pushError('telegram', { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), /blocked/);
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
  const saved = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const r = await sendPush('bark', 'abc', 'hi', {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no fetch');
  } finally {
    globalThis.fetch = saved;
  }
  const bad = await sendPush('bark', 'bad key', 'hi', { fetchImpl: async () => assert.fail('不该请求') });
  assert.equal(bad.ok, false);
  assert.ok(PUSH_PROVIDERS.includes('telegram'));
});

test('sendPush：成功返回 status', async () => {
  const r = await sendPush('serverchan', 'SCT123456789', 'hi', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) }),
  });
  assert.deepEqual(r, { ok: true, status: 200 });
});
