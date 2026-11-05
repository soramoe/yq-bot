/**
 * 登录链路自检（全离线）。
 *
 * B站接口在这里全部被替换成假实现，所以这个测试：
 *   - 不需要网络，也不会因为跑测试而真的申请二维码
 *   - 可以在 CI / 断网环境跑
 *   - 能稳定复现"扫码后凭证没拿到""Host 被伪造"这类事故
 *
 * 重点验证的不是"能不能登录成功"，而是**失败时会不会把凭证或账号搞坏**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseCookie,
  stringifyCookie,
  cookieFromSetCookie,
  mergeCookie,
  isComplete,
  missingFields,
  uidFromCookie,
  redactCookie,
  looksLeaked,
  WANTED,
} from '../bili/cookie.mjs';
import { collectCredentials } from '../bili/login.mjs';
import { biliRaw, BiliError } from '../bili/http.mjs';
import { AuthStore } from '../auth.mjs';
import { createLoginHandler } from '../login-server.mjs';

/** 一个结构完整的假 Cookie */
const FAKE_COOKIE = [
  'SESSDATA=deadbeefdeadbeefdeadbeef0123456789',
  'bili_jct=abcdef0123456789abcdef0123456789',
  'DedeUserID=1970515035',
  'DedeUserID__ckMd5=0123456789abcdef',
  'sid=xyz789',
].join('; ');

function tmpDataDir() {
  return mkdtempSync(join(tmpdir(), 'yy3-auth-'));
}

/* ---------------- Cookie 基础工具 ---------------- */

test('Cookie：解析与拼回可以往返', () => {
  const jar = parseCookie(FAKE_COOKIE);
  assert.equal(jar.DedeUserID, '1970515035');
  assert.equal(jar.sid, 'xyz789');

  const round = stringifyCookie(jar);
  assert.deepEqual(parseCookie(round), jar);
});

test('Cookie：完整性判断能指出缺哪一项', () => {
  assert.equal(isComplete(FAKE_COOKIE), true);
  assert.deepEqual(missingFields(FAKE_COOKIE), []);

  const noJct = 'SESSDATA=aaaaaaaaaaaaaaaaaaaa; DedeUserID=123';
  assert.equal(isComplete(noJct), false);
  assert.deepEqual(missingFields(noJct), ['bili_jct']);

  // 空值不算"有"
  assert.equal(isComplete('SESSDATA=; bili_jct=; DedeUserID=1'), false);
});

test('Cookie：合并时后者覆盖前者，顺序稳定', () => {
  const merged = mergeCookie('SESSDATA=old; bili_jct=j1; DedeUserID=1', 'SESSDATA=new');
  assert.match(merged, /SESSDATA=new/);
  assert.doesNotMatch(merged, /SESSDATA=old/);
  assert.match(merged, /bili_jct=j1/);
});

test('Cookie：只从 Set-Cookie 里挑需要的字段', () => {
  const jar = cookieFromSetCookie([
    'SESSDATA=abc123; Path=/; HttpOnly; Secure',
    'bili_jct=def456; Path=/',
    'buvid3=ignored; Path=/',
    'DedeUserID=999; Path=/',
  ]);
  assert.equal(jar.SESSDATA, 'abc123');
  assert.equal(jar.bili_jct, 'def456');
  assert.equal(jar.DedeUserID, '999');
  assert.equal(jar.buvid3, undefined, '不需要的字段不该留下');
});

test('Cookie：脱敏后不能还原出原值', () => {
  const masked = redactCookie(FAKE_COOKIE);
  const jar = parseCookie(FAKE_COOKIE);

  for (const key of WANTED) {
    if (!jar[key]) continue;
    assert.ok(!masked.includes(jar[key]), `脱敏后仍能搜到 ${key} 的原值`);
  }
  assert.match(masked, /^SESSDATA=/, '脱敏后仍要保留字段名，否则看不懂');
  assert.match(masked, /\*/, '应该有打码字符');
});

test('Cookie：能识别文本里是否泄露了真实凭证', () => {
  const leakedLine = `login ok, cookie=${FAKE_COOKIE}`;
  assert.equal(looksLeaked(leakedLine, FAKE_COOKIE), true);

  const safeLine = `login ok, cookie=${redactCookie(FAKE_COOKIE)}`;
  assert.equal(looksLeaked(safeLine, FAKE_COOKIE), false);
});

test('Cookie：UID 从凭证里直接取，不需要联网', () => {
  assert.equal(uidFromCookie(FAKE_COOKIE), 1970515035);
  assert.equal(uidFromCookie('SESSDATA=x'), 0);
  assert.equal(uidFromCookie(''), 0);
});

/* ---------------- 凭证的两个来源 ---------------- */

test('凭证收集：Cookie 只在 Set-Cookie 里 —— 能拿到', () => {
  const jar = collectCredentials([`SESSDATA=s1; Path=/`, `bili_jct=j1`, `DedeUserID=42`], '');
  assert.equal(jar.SESSDATA, 's1');
  assert.equal(jar.DedeUserID, '42');
});

test('凭证收集：Cookie 只在跳转链接里 —— 也能拿到（新版接口）', () => {
  const redirect =
    'https://passport.biligame.com/crossDomain?SESSDATA=s2%2C123&bili_jct=j2&DedeUserID=43&gourl=x';
  const jar = collectCredentials([], redirect);
  assert.equal(jar.SESSDATA, 's2,123', 'URL 编码要解码');
  assert.equal(jar.bili_jct, 'j2');
  assert.equal(jar.DedeUserID, '43');
});

test('凭证收集：两处都有时以 Set-Cookie 为准', () => {
  const jar = collectCredentials(
    ['SESSDATA=from_header; Path=/'],
    'https://x/crossDomain?SESSDATA=from_url&bili_jct=j',
  );
  assert.equal(jar.SESSDATA, 'from_header');
  // 头部缺的字段仍然可以从链接补齐
  assert.equal(jar.bili_jct, 'j');
});

test('凭证收集：链接是坏的不会抛异常，只是拿不到', () => {
  const jar = collectCredentials([], 'not-a-url');
  assert.deepEqual(jar, {});
});

/* ---------------- 凭证持久化 ---------------- */

test('AuthStore：保存后能原样读回，且状态里不含 Cookie', () => {
  const dir = tmpDataDir();
  try {
    const store = new AuthStore({ dataDir: dir });
    store.save({ cookie: FAKE_COOKIE, uid: 1970515035, uname: '渔月崽', face: 'https://x/f.jpg' });

    const reloaded = new AuthStore({ dataDir: dir }).load();
    assert.equal(reloaded.loggedIn, true);
    assert.equal(reloaded.cookie, FAKE_COOKIE);

    const status = reloaded.status();
    assert.equal(status.uname, '渔月崽');
    assert.equal(status.uid, 1970515035);
    assert.ok(!('cookie' in status), 'status() 绝不能把 Cookie 交给前端');
    assert.ok(!JSON.stringify(status).includes('SESSDATA'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AuthStore：凭证不完整时拒绝保存', () => {
  const dir = tmpDataDir();
  try {
    const store = new AuthStore({ dataDir: dir });
    assert.throws(() => store.save({ cookie: 'SESSDATA=only' }), /凭证不完整/);
    assert.equal(store.loggedIn, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AuthStore：文件损坏时退化成未登录，而不是让进程起不来', () => {
  const dir = tmpDataDir();
  try {
    // 模拟"写一半断电"留下的半截 JSON
    writeFileSync(join(dir, 'auth.json'), '{"cookie":"SESSDATA=abc","uid":1');

    const store = new AuthStore({ dataDir: dir }).load();
    assert.equal(store.loggedIn, false);
    assert.equal(store.cookie, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AuthStore：结构缺字段时同样当作未登录', () => {
  const dir = tmpDataDir();
  try {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ uid: 123, uname: 'x' }));
    const store = new AuthStore({ dataDir: dir }).load();
    assert.equal(store.loggedIn, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AuthStore：写入是原子的，不留 .tmp 残file', () => {
  const dir = tmpDataDir();
  try {
    const store = new AuthStore({ dataDir: dir });
    store.save({ cookie: FAKE_COOKIE, uid: 1, uname: 'a', face: '' });
    store.save({ cookie: FAKE_COOKIE, uid: 2, uname: 'b', face: '' });

    const files = readdirSync(dir);
    assert.deepEqual(files, ['auth.json'], `目录里不该残留临时文件：${files.join(',')}`);

    const data = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
    assert.equal(data.uid, 2, '第二次保存应该覆盖');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AuthStore：clear 之后磁盘文件消失', () => {
  const dir = tmpDataDir();
  try {
    const store = new AuthStore({ dataDir: dir });
    store.save({ cookie: FAKE_COOKIE });
    assert.ok(existsSync(join(dir, 'auth.json')));

    store.clear();
    assert.equal(existsSync(join(dir, 'auth.json')), false);
    assert.equal(store.loggedIn, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AuthStore：describe() 是脱敏的，可以直接进日志', () => {
  const dir = tmpDataDir();
  try {
    const store = new AuthStore({ dataDir: dir });
    store.save({ cookie: FAKE_COOKIE, uname: '渔月崽' });
    const desc = store.describe();
    assert.match(desc, /渔月崽/);
    assert.equal(looksLeaked(desc, FAKE_COOKIE), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- HTTP 层 ---------------- */

test('HTTP：非 JSON 响应转成 code=-998，并保留原文片段', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>风控验证页</html>');
  });
  await listen(server);
  const { port } = address(server);

  try {
    const { json, status } = await biliRaw(`http://127.0.0.1:${port}/x`);
    assert.equal(status, 200);
    assert.equal(json.code, -998);
    assert.match(json.message, /风控验证页/, '原文要保留，否则现场就丢了');
  } finally {
    server.close();
  }
});

test('HTTP：超时抛 BiliError 且带 ETIMEDOUT，不能挂死', async () => {
  const server = createServer((req, res) => {
    // 故意不回，模拟网络卡住
    setTimeout(() => res.end('{}'), 3000);
  });
  await listen(server);
  const { port } = address(server);

  const started = Date.now();
  try {
    await assert.rejects(
      () => biliRaw(`http://127.0.0.1:${port}/slow`, { timeout: 300 }),
      (err) => {
        assert.ok(err instanceof BiliError);
        assert.equal(err.code, 'ETIMEDOUT');
        return true;
      },
    );
  } finally {
    server.close();
  }
  assert.ok(Date.now() - started < 2000, '超时应该按设定触发，不该等服务器自己返回');
});

/* ---------------- 登录服务端 ---------------- */

/** 起一个挂了登录处理器的服务，返回 { base, auth, close } */
async function startTestServer(overrides = {}, { base = '', onLogin = null } = {}) {
  const dir = tmpDataDir();
  const auth = new AuthStore({ dataDir: dir });

  /** @type {any} */
  let handlerRef = null;
  const server = createServer((req, res) => handlerRef(req, res));
  await listen(server);
  const port = address(server).port;

  const deps = {
    requestQrcode: async () => ({ url: 'https://passport.bilibili.com/x?k=1', key: 'key-1' }),
    pollQrcode: async () => ({ status: 'waiting', message: '等待扫码' }),
    verifyCookie: async () => ({ valid: true, uid: 1970515035, uname: '渔月崽', face: '' }),
    ...overrides,
  };

  handlerRef = createLoginHandler({ auth, host: '127.0.0.1', port, deps, base, onLogin });

  return {
    base: `http://127.0.0.1:${port}`,
    auth,
    port,
    async close() {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('登录服务：首页返回带 CSP 的 HTML', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/`);
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);

    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'nonce-/, '内联脚本必须靠 nonce 放行');
    assert.match(html, /扫码登录/);
    // nonce 必须真的出现在页面里，否则脚本会被浏览器拦掉
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce && html.includes(`nonce="${nonce}"`), 'CSP 里的 nonce 要和页面标签一致');
  } finally {
    await s.close();
  }
});

test('登录服务：伪造 Host 一律拒绝（防 DNS 重绑定）', async () => {
  const s = await startTestServer();
  try {
    // fetch 不允许改 Host（浏览器语义里它是禁用头），只能走底层 http
    const res = await rawRequest(s.port, '/api/auth', 'evil.example.com');
    assert.equal(res.status, 403);

    // 对照：正常 Host 必须放行，否则上面那条等于"永远拒绝"
    const ok = await rawRequest(s.port, '/api/auth', `127.0.0.1:${s.port}`);
    assert.equal(ok.status, 200);
  } finally {
    await s.close();
  }
});

test('登录服务：申请二维码返回可用 SVG，且不回传二维码内容', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/api/qr`, { method: 'POST' });
    const data = await res.json();

    assert.equal(data.ok, true);
    assert.match(data.svg, /^<svg/, '前端要直接内联这张 SVG');
    assert.equal(data.key, 'key-1');
    assert.ok(!('url' in data), '二维码内容不必给前端');
  } finally {
    await s.close();
  }
});

test('登录服务：扫码成功后落盘，且响应里绝不出现 Cookie', async () => {
  const s = await startTestServer({
    pollQrcode: async () => ({ status: 'confirmed', message: '登录成功', cookie: FAKE_COOKIE }),
  });

  try {
    const res = await fetch(`${s.base}/api/qr/poll?key=key-1`);
    const body = await res.text();

    assert.equal(JSON.parse(body).status, 'confirmed');
    assert.equal(looksLeaked(body, FAKE_COOKIE), false, '响应体泄露了 SESSDATA');

    assert.equal(s.auth.loggedIn, true);
    assert.equal(s.auth.cookie, FAKE_COOKIE);

    const status = JSON.parse(await (await fetch(`${s.base}/api/auth`)).text());
    assert.equal(status.loggedIn, true);
    assert.equal(status.uname, '渔月崽');
    assert.equal(looksLeaked(JSON.stringify(status), FAKE_COOKIE), false);
  } finally {
    await s.close();
  }
});

test('登录服务：资料校验失败也要保住凭证（不能白扫一次）', async () => {
  const s = await startTestServer({
    pollQrcode: async () => ({ status: 'confirmed', message: 'ok', cookie: FAKE_COOKIE }),
    verifyCookie: async () => ({ valid: false, reason: '网络抖动' }),
  });

  try {
    const data = await (await fetch(`${s.base}/api/qr/poll?key=key-1`)).json();
    assert.equal(data.status, 'confirmed');
    assert.equal(s.auth.loggedIn, true, '凭证已到手就必须保存');
  } finally {
    await s.close();
  }
});

test('登录服务：过期与已扫码状态如实透传', async () => {
  for (const [status, keyword] of [
    ['expired', /过期/],
    ['scanned', /确认/],
  ]) {
    const s = await startTestServer({
      pollQrcode: async () => ({
        status,
        message: status === 'expired' ? '二维码已过期，请刷新' : '已扫码，请在手机上点确认',
      }),
    });
    try {
      const data = await (await fetch(`${s.base}/api/qr/poll?key=k`)).json();
      assert.equal(data.status, status);
      assert.match(data.message, keyword);
      assert.equal(s.auth.loggedIn, false);
    } finally {
      await s.close();
    }
  }
});

test('登录服务：退出登录会清掉凭证', async () => {
  const s = await startTestServer({
    pollQrcode: async () => ({ status: 'confirmed', message: 'ok', cookie: FAKE_COOKIE }),
  });

  try {
    await fetch(`${s.base}/api/qr/poll?key=k`);
    assert.equal(s.auth.loggedIn, true);

    await fetch(`${s.base}/api/logout`, { method: 'POST' });
    assert.equal(s.auth.loggedIn, false);

    const status = JSON.parse(await (await fetch(`${s.base}/api/auth`)).text());
    assert.deepEqual(status, { loggedIn: false });
  } finally {
    await s.close();
  }
});

test('登录服务：不存在的路径返回 404 而不是崩掉', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/nope`);
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

test('登录服务：可以挂在主服务 /login 下，登录成功会回调重连', async () => {
  const calls = [];
  const s = await startTestServer(
    {
      pollQrcode: async () => ({ status: 'confirmed', cookie: FAKE_COOKIE }),
    },
    { base: '/login', onLogin: async (account) => calls.push(account) },
  );
  try {
    const page = await fetch(`${s.base}/login`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /BASE = '\/login'/, '页面请求要带 /login 前缀');
    assert.match(html, /BASE \+ '\/api\/qr'/, '轮询和申请二维码都不能落到主服务的 /api 上');

    const qr = await fetch(`${s.base}/login/api/qr`, { method: 'POST' });
    const qrBody = await qr.json();
    assert.equal(qrBody.ok, true);
    assert.equal(qrBody.key, 'key-1');

    const poll = await fetch(`${s.base}/login/api/qr/poll?key=key-1`);
    const pollBody = await poll.json();
    assert.equal(pollBody.status, 'confirmed');
    assert.equal(s.auth.loggedIn, true);
    assert.equal(calls.length, 1, '登录成功必须通知主服务重连');
    assert.equal(calls[0].uname, '渔月崽');

    const auth = await (await fetch(`${s.base}/login/api/auth`)).json();
    assert.equal(auth.loggedIn, true);
  } finally {
    await s.close();
  }
});

/* ---------------- 工具 ---------------- */

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function address(server) {
  return server.address();
}

/** 发一个可以自定义 Host 的请求（fetch 不允许改 Host） */
function rawRequest(port, path, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
