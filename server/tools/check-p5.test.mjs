/**
 * P5 自检：访问口令、写操作闸门、更新检查、诊断包。
 *
 * 这个文件盯的是"出事会很安静"的那几类问题：
 *
 *   · 口令明文落盘 —— 备份/换机器时一起送出去
 *   · 跨站写操作没被拦 —— 你的浏览器开着别的页面，配置就被改了
 *   · 诊断包漏了 Cookie —— 一个"发出去求助"的动作变成账号泄露
 *   · 更新检查把网络错误当成"已是最新" —— 让人以为没有新版本
 *
 * 每条都尽量**真跑一遍**（真的写文件、真的打包、真的读回来比对），
 * 而不是断言"函数返回了某个字段"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccessGuard, passwordProblem, MIN_LENGTH } from '../core/access.mjs';
import { checkOrigin, guardWrite } from '../http/write-guard.mjs';
import { UpdateChecker, compareVersion, parseManifest } from '../core/update.mjs';
import {
  buildDiagnostic,
  crc32,
  eventSkeleton,
  hashUid,
  maskName,
  redact,
  unzipStore,
  zipStore,
} from '../core/diagnostic.mjs';
import { App } from '../app.mjs';

/** 每个用例一个独立目录，互不影响 */
function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yuyue3-p5-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ══════════════════════ 访问口令 ══════════════════════ */

test('口令：没启用时一律放行，启用后才开始认人', (t) => {
  const g = new AccessGuard({ dataDir: tmp(t) });

  assert.equal(g.enabled, false);
  assert.equal(g.verify(''), true, '没设口令时 verify 也必须放行，否则调用方要到处判 enabled');
  assert.equal(g.verify('随便什么'), true);

  g.setPassword('goodpass1');
  assert.equal(g.enabled, true);
  assert.equal(g.verify('goodpass1'), true);
  assert.equal(g.verify('goodpass2'), false);
  assert.equal(g.verify(''), false, '空口令在启用后必须被拒');
});

test('口令：首尾空格不影响识别 —— 设置和校验必须是同一个口径', (t) => {
  // 反向验证的对象是"设置时 trim、校验时不 trim"的写法：
  // 那样这里第二条断言会失败，而失败信息是"口令不对"，
  // 用户只会以为自己记错了口令（界面恰好两端都 trim，所以肉眼看不出来）
  const g = new AccessGuard({ dataDir: join(tmp(t), 'a') });
  g.setPassword('  goodpass1  ');

  assert.equal(g.verify('goodpass1'), true, '设置时 trim 了，校验也必须 trim');
  assert.equal(g.verify('  goodpass1  '), true, '带空格的写法是同一个口令');
  assert.equal(g.verify('  goodpass2  '), false, 'trim 之后不一样还是不一样');

  const h = new AccessGuard({ dataDir: join(tmp(t), 'b') });
  h.setPassword('goodpass1');
  assert.equal(h.verify(' goodpass1 '), true, '先设后带空格来解锁，也要能进');
});

test('口令：磁盘上只有盐和哈希，没有明文；重启后仍然认', (t) => {
  const dir = tmp(t);
  const g = new AccessGuard({ dataDir: dir });
  g.setPassword('sup3r-secret');

  const raw = readFileSync(join(dir, 'access.json'), 'utf8');
  assert.equal(raw.includes('sup3r-secret'), false, '口令不能以明文落在 data/ 下');

  const again = new AccessGuard({ dataDir: dir });
  assert.equal(again.enabled, true, '重启后要能读回来，否则每次重启都变成"没有口令"');
  assert.equal(again.verify('sup3r-secret'), true);
  assert.equal(again.verify('sup3r-secrets'), false);
});

test('口令：对外状态里没有盐和哈希，也没有长度以外的线索', (t) => {
  const g = new AccessGuard({ dataDir: tmp(t) });
  g.setPassword('goodpass1');

  const st = g.status();
  assert.deepEqual(Object.keys(st).sort(), ['enabled', 'lockedMs', 'minLength', 'updatedAt']);
  assert.equal(JSON.stringify(st).includes('goodpass1'), false);
  // salt/hash 是 hex 字符串，只要出现就说明漏了
  const raw = readFileSync(g.file, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(JSON.stringify(st).includes(parsed.hash), false, '哈希不能下发到前端');
  assert.equal(JSON.stringify(st).includes(parsed.salt), false, '盐不能下发到前端');
});

test('口令：弱口令被拒绝，且给出能看懂的原因', (t) => {
  const g = new AccessGuard({ dataDir: tmp(t) });

  assert.match(passwordProblem('abc'), /至少/);
  assert.match(passwordProblem('a'.repeat(MIN_LENGTH)), /单调/);
  assert.match(passwordProblem(123456), /字符串/);
  assert.equal(passwordProblem('goodpass1'), null);

  assert.throws(() => g.setPassword('abc'), /至少/);
  assert.equal(g.enabled, false, '被拒绝的口令不能让口令功能"半开"');
});

test('口令：关闭之后文件被删掉，且恢复为不需要口令', (t) => {
  const dir = tmp(t);
  const g = new AccessGuard({ dataDir: dir });
  g.setPassword('goodpass1');
  const file = join(dir, 'access.json');
  assert.equal(existsSync(file), true);

  g.disable();
  assert.equal(existsSync(file), false, '关掉口令要删文件，不留一份用不到的哈希');
  assert.equal(g.enabled, false);
  assert.equal(g.verify('随便'), true);

  // 重新读盘也不能"复活"
  const again = new AccessGuard({ dataDir: dir });
  assert.equal(again.enabled, false);
});

test('口令：文件坏掉时退化成"没有口令"，不能把服务锁在门外', (t) => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'access.json'), '{ 这不是 JSON');
  const broken = new AccessGuard({ dataDir: dir });
  assert.equal(broken.enabled, false);
  assert.equal(broken.verify(''), true);

  // 结构不完整（有 enabled 但没有 hash）同样不能锁死
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ v: 1, enabled: true }));
  const partial = new AccessGuard({ dataDir: dir });
  assert.equal(partial.enabled, false);
  assert.equal(partial.verify(''), true);
});

test('口令：连续输错会被挡住一段时间，期间正确口令也进不来', (t) => {
  const g = new AccessGuard({ dataDir: tmp(t) });
  g.setPassword('goodpass1');

  for (let i = 0; i < 5; i++) {
    assert.equal(g.verify(`wrong-${i}`), false);
  }
  assert.ok(g.lockedFor() > 0, '连错 5 次后要进入退避，否则可以无成本地暴力猜');
  assert.equal(g.verify('goodpass1'), false, '退避期间正确口令也不能立刻通过');

  // 退避结束（这里直接把截止时间拨到过去，等价于等到了）
  g._blockedUntil = Date.now() - 1;
  assert.equal(g.verify('goodpass1'), true);
  assert.equal(g.lockedFor(), 0);
});

/* ══════════════════════ 写操作闸门 ══════════════════════ */

function fakeReq(method, headers = {}) {
  return { method, headers: { host: '127.0.0.1:8900', ...headers } };
}

function fakeApp({ enabled = false, verify = () => true, lockedFor = () => 0 } = {}) {
  return { access: { enabled, verify, lockedFor } };
}

test('闸门：只读方法不检查，不管 Origin 多离谱', () => {
  const app = fakeApp({ enabled: true, verify: () => false });
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const r = guardWrite(fakeReq(method, { origin: 'https://evil.example' }), {
      app,
      port: 8900,
      pathname: '/api/status',
    });
    assert.equal(r, null, `${method} 不该被拦`);
  }
});

test('闸门：跨站 Origin 一律 403（这是挡住 CSRF 的那一道）', () => {
  const app = fakeApp();
  const bad = guardWrite(fakeReq('POST', { origin: 'https://evil.example' }), {
    app,
    port: 8900,
    pathname: '/api/dryrun',
  });
  assert.equal(bad.status, 403);
  assert.equal(bad.code, 'bad_origin');

  // sandboxed iframe / file:// 会给字面量 "null"
  const nul = guardWrite(fakeReq('POST', { origin: 'null' }), { app, port: 8900, pathname: '/api/dryrun' });
  assert.equal(nul.status, 403);
});

test('闸门：本机三种 Origin 都放行，没有 Origin 也放行（curl / 脚本）', () => {
  const app = fakeApp();
  for (const origin of ['http://127.0.0.1:8900', 'http://localhost:8900', 'http://[::1]:8900']) {
    assert.equal(
      guardWrite(fakeReq('POST', { origin }), { app, port: 8900, pathname: '/api/dryrun' }),
      null,
      `${origin} 应该被放行`,
    );
  }
  assert.equal(guardWrite(fakeReq('POST'), { app, port: 8900, pathname: '/api/dryrun' }), null);
});

test('闸门：端口不同的同主机 Origin 不算同源', () => {
  const app = fakeApp();
  const r = guardWrite(fakeReq('POST', { origin: 'http://127.0.0.1:3000' }), {
    app,
    port: 8900,
    pathname: '/api/dryrun',
  });
  assert.equal(r.status, 403, '别的本地服务也不该能改我们的配置');
});

test('闸门：启用口令后没有 token 返回 401，带对了才放行', () => {
  let token = 'goodpass1';
  const app = fakeApp({ enabled: true, verify: (v) => v === token });

  const no = guardWrite(fakeReq('POST'), { app, port: 8900, pathname: '/api/dryrun' });
  assert.equal(no.status, 401);
  assert.equal(no.code, 'locked_out');

  const wrong = guardWrite(fakeReq('POST', { 'x-access-token': 'nope' }), {
    app,
    port: 8900,
    pathname: '/api/dryrun',
  });
  assert.equal(wrong.status, 401);

  const ok = guardWrite(fakeReq('POST', { 'x-access-token': token }), {
    app,
    port: 8900,
    pathname: '/api/dryrun',
  });
  assert.equal(ok, null);
});

test('闸门：退避中返回 429 而不是 401（前端要能区分"等下再试"）', () => {
  const app = fakeApp({ enabled: true, verify: () => false, lockedFor: () => 12_000 });
  const r = guardWrite(fakeReq('POST'), { app, port: 8900, pathname: '/api/dryrun' });
  assert.equal(r.status, 429);
  assert.match(r.message, /12 秒/);
});

test('闸门：解锁接口必须免口令，但仍然要过 Origin 检查', () => {
  const app = fakeApp({ enabled: true, verify: () => false });

  // 免口令：否则设了口令就再也没有入口能打开
  assert.equal(
    guardWrite(fakeReq('POST'), { app, port: 8900, pathname: '/api/access/unlock' }),
    null,
  );

  // 但跨站不能试：否则攻击者能在你的页面上暴力猜口令
  const cross = guardWrite(fakeReq('POST', { origin: 'https://evil.example' }), {
    app,
    port: 8900,
    pathname: '/api/access/unlock',
  });
  assert.equal(cross.status, 403);

  // 也不能跨站"抢先设置口令"
  const set = guardWrite(fakeReq('POST', { origin: 'https://evil.example' }), {
    app: fakeApp(),
    port: 8900,
    pathname: '/api/access/password',
  });
  assert.equal(set.status, 403);
});

test('闸门：checkOrigin 只看"有没有 Origin、对不对得上"', () => {
  assert.equal(checkOrigin(undefined, 8900), null);
  assert.equal(checkOrigin('', 8900), null);
  assert.equal(checkOrigin('http://127.0.0.1:8900', 8900), null);
  assert.equal(checkOrigin('HTTP://127.0.0.1:8900', 8900), null, '大小写不该影响判断');
  assert.equal(checkOrigin('null', 8900).code, 'bad_origin');
  assert.equal(checkOrigin('http://127.0.0.1:8901', 8900).code, 'bad_origin');
});

/* ══════════════════════ 更新检查 ══════════════════════ */

test('更新：版本按数字段比，不是按字符串比', () => {
  assert.ok(compareVersion('1.10.0', '1.9.0') > 0, '字符串比较会得出 1.10.0 < 1.9.0，这是最容易踩的坑');
  assert.ok(compareVersion('0.2.1', '0.2.0') > 0);
  assert.equal(compareVersion('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersion('v1.0.0', '1.0.0'), 0, 'v 前缀不该影响');
  assert.equal(compareVersion('1.0.0', '1.0'), 0, '缺省段按 0 补齐：1.0 和 1.0.0 是同一个版本');
  assert.equal(compareVersion('abc', '0.0.0'), 0, '解析不了的版本退化成 0，不该抛');
});

test('更新：没配更新源时明确说没配，不发请求也不缓存', async () => {
  let called = 0;
  const c = new UpdateChecker({
    current: '0.2.0',
    getUrl: () => '',
    fetchImpl: async () => {
      called++;
      throw new Error('不该被调用');
    },
  });

  const r = await c.check();
  assert.equal(r.configured, false);
  assert.match(r.hint, /还没有配置更新源/);
  assert.equal(called, 0);
  assert.equal(c.snapshot(), null, '没配置不该产生缓存');
});

test('更新：拿到更高的版本 → hasUpdate，且 notes/url 透传', async () => {
  const c = new UpdateChecker({
    current: '0.2.0',
    getUrl: () => 'https://example.com/latest.json',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '0.3.0', notes: '加了弹幕指令', url: 'https://example.com/dl' }),
    }),
  });

  const r = await c.check();
  assert.equal(r.hasUpdate, true);
  assert.equal(r.latest, '0.3.0');
  assert.equal(r.notes, '加了弹幕指令');
  assert.equal(r.url, 'https://example.com/dl');
  assert.equal(r.error, undefined);
});

test('更新：同版本 / 更低版本都不算"有新版本"', async () => {
  const mk = (version) =>
    new UpdateChecker({
      current: '0.2.0',
      getUrl: () => 'https://example.com/latest.json',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version }) }),
    });

  assert.equal((await mk('0.2.0').check()).hasUpdate, false);
  assert.equal((await mk('0.1.9').check()).hasUpdate, false);
});

test('更新：网络故障要报错，不能伪装成"已是最新"', async () => {
  const netErr = new UpdateChecker({
    current: '0.2.0',
    getUrl: () => 'https://example.com/latest.json',
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });
  const a = await netErr.check();
  assert.equal(a.hasUpdate, undefined, '失败时不能有 hasUpdate，否则页面会显示"已是最新"');
  assert.match(a.error, /连不上更新源/);

  const timeout = new UpdateChecker({
    current: '0.2.0',
    getUrl: () => 'https://example.com/latest.json',
    fetchImpl: async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    },
  });
  assert.match((await timeout.check()).error, /没响应/);
});

test('更新：非 JSON、缺 version、非法 version 都给人话，不抛', async () => {
  const mk = (json) =>
    new UpdateChecker({
      current: '0.2.0',
      getUrl: () => 'https://example.com/latest.json',
      fetchImpl: async () => ({ ok: true, status: 200, json }),
    });

  assert.match((await mk(async () => { throw new Error('bad'); }).check()).error, /不是合法 JSON/);
  assert.match((await mk(async () => ({ hello: 1 })).check()).error, /格式不对/);
  assert.match((await mk(async () => ({ version: '最新版' })).check()).error, /格式不对/);

  const http500 = new UpdateChecker({
    current: '0.2.0',
    getUrl: () => 'https://example.com/latest.json',
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.match((await http500.check()).error, /HTTP 500/);
});

test('更新：只接受 http/https；file:// 不能当更新源', async () => {
  const c = new UpdateChecker({
    current: '0.2.0',
    getUrl: () => 'file:///C:/windows/win.ini',
    fetchImpl: async () => {
      throw new Error('不该被调用');
    },
  });
  assert.match((await c.check()).error, /只支持 http\/https/);

  const bad = new UpdateChecker({
    current: '0.2.0',
    getUrl: () => '不是地址',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  assert.match((await bad.check()).error, /不是合法 URL/);
});

test('更新：5 分钟内重复点用缓存，force 才真的再发一次', async () => {
  let called = 0;
  const c = new UpdateChecker({
    current: '0.2.0',
    getUrl: () => 'https://example.com/latest.json',
    fetchImpl: async () => {
      called++;
      return { ok: true, status: 200, json: async () => ({ version: '0.2.0' }) };
    },
  });

  await c.check();
  await c.check();
  assert.equal(called, 1, '连点两下不该发两次请求');

  await c.check({ force: true });
  assert.equal(called, 2, 'force 要能绕过缓存');

  assert.equal(c.snapshot().cached, true);
});

test('更新：同时点两次只发一次（并发合并，不是排队）', async () => {
  let called = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });

  const c = new UpdateChecker({
    current: '0.2.0',
    getUrl: () => 'https://example.com/latest.json',
    fetchImpl: async () => {
      called++;
      await gate;
      return { ok: true, status: 200, json: async () => ({ version: '0.3.0' }) };
    },
  });

  const p1 = c.check();
  const p2 = c.check();
  release();
  const [a, b] = await Promise.all([p1, p2]);

  assert.equal(called, 1);
  assert.equal(a.latest, '0.3.0');
  assert.equal(b.latest, '0.3.0');
});

test('更新：manifest 解析只认数字版本', () => {
  assert.deepEqual(parseManifest({ version: '1.2.3', notes: 'x' }), { version: '1.2.3', notes: 'x', url: '' });
  assert.equal(parseManifest({ version: 'v1.2.3' }).version, 'v1.2.3');
  assert.equal(parseManifest({ version: '1.2.3-beta.1' }), null);
  assert.equal(parseManifest({ version: '' }), null);
  assert.equal(parseManifest(null), null);
  // notes 有长度上限，防止一个 10MB 的说明把界面撑爆
  assert.equal(parseManifest({ version: '1.0.0', notes: 'x'.repeat(5000) }).notes.length, 2000);
});

/* ══════════════════════ 诊断包 ══════════════════════ */

test('诊断包：CRC32 对得上标准值', () => {
  // 这是 CRC-32/ISO-HDLC 的标准检验值（"123456789" → 0xCBF43926）
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('诊断包：zip 打包后用标准格式读回来，内容一字不差', () => {
  const entries = [
    { name: 'meta.json', data: '{"version":"0.2.0"}' },
    { name: '中文/说明.txt', data: '中文内容也要能往返' },
    { name: 'empty.txt', data: '' },
  ];
  const zip = zipStore(entries, { mtime: new Date('2026-11-04T10:00:00Z') });

  // 结构最基本的自证：本地头 + 中央目录 + EOCD 三个签名都在
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);

  const back = unzipStore(zip);
  assert.equal(back.size, 3);
  for (const e of entries) {
    assert.equal(back.get(e.name).toString('utf8'), e.data, `${e.name} 内容不一致`);
  }
});

test('诊断包：文件名用本地时间（和日志分片同一口径，不能偷偷用 UTC）', () => {
  /**
   * `toISOString()` 给的是 UTC：本地 12:55 会写成 `04-55`。
   * 而日志分片是 `2026-11-04.jsonl`（本地日期）、日志行是 `12:55:40`（本地时间）。
   * 用户拿着一份"04 点"的包说"我 12 点出的问题"，两边对不上 ——
   * 不会报错，只会让排查从一开始就错。
   */
  const now = new Date(2026, 10, 4, 12, 55, 40);
  const { filename } = buildDiagnostic({ meta: {}, status: {}, now });
  assert.equal(filename, 'yuyue3-diag-2026-11-04_12-55-40.zip');
});

test('诊断包：打包出来的包里有这几样东西，且 README 说明了脱敏范围', () => {
  const { filename, buffer, entries } = buildDiagnostic({
    meta: { app: 'yuyue3', version: '0.2.0' },
    status: { ok: true, version: '0.2.0' },
    config: { roomId: '123' },
  });

  assert.match(filename, /^yuyue3-diag-[\d\-_T]+\.zip$/);
  const files = unzipStore(buffer);
  for (const name of entries) assert.ok(files.has(name), `缺少 ${name}`);
  assert.ok(files.has('README.txt'));

  const readme = files.get('README.txt').toString('utf8');
  assert.match(readme, /脱敏/);
  assert.match(readme, /Cookie/);
  assert.match(readme, /不包含/);
});

test('诊断包：配置里的 Cookie / 口令 / 密钥一律变成 ***，值本身不出现', () => {
  const secret = 'SESSDATA=abcdefghijklmnop123456; bili_jct=deadbeef; DedeUserID=42';
  const { buffer } = buildDiagnostic({
    meta: {},
    status: {},
    config: {
      roomId: '123',
      cookie: secret,
      accessToken: 'tok_live_123',
      nested: { password: 'hunter2', apiKey: 'sk-abc', keep: 'ok' },
      // 字段名不敏感、但值里塞了 Cookie 串：也要被替换
      harmless: secret,
      // 提醒 webhook 地址本身就是写凭据（query / 路径里带 key）
      notifyWebhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=hook_key_123',
      botKey: 'bot_secret_456',
    },
  });

  const files = unzipStore(buffer);
  const config = JSON.parse(files.get('config.json').toString('utf8'));

  assert.equal(config.cookie, '***');
  assert.equal(config.notifyWebhook, '***');
  assert.equal(config.botKey, '***');
  assert.equal(config.accessToken, '***');
  assert.equal(config.nested.password, '***');
  assert.equal(config.nested.apiKey, '***');
  assert.equal(config.nested.keep, 'ok', '不敏感的字段要原样保留，否则诊断没意义');
  assert.equal(config.harmless, '***', '值里出现 SESSDATA= 也要替换');
  assert.equal(config.roomId, '123');

  // 最要命的一条：整个包的字节里不能出现凭据原文
  const all = [...files.values()].map((b) => b.toString('utf8')).join('\n');
  assert.equal(all.includes('abcdefghijklmnop123456'), false);
  assert.equal(all.includes('deadbeef'), false);
  assert.equal(all.includes('hunter2'), false);
  assert.equal(all.includes('tok_live_123'), false);
  assert.equal(all.includes('hook_key_123'), false);
  assert.equal(all.includes('bot_secret_456'), false);
});

test('诊断包：全角/深层结构也要脱敏，且不能因为嵌套过深爆栈', () => {
  // 20 层嵌套：超过深度上限的部分会被切成 ***，但绝不能抛
  let deep = { leaf: 'x' };
  for (let i = 0; i < 20; i++) deep = { child: deep };

  const out = redact({ a: deep, b: [{ cookie: 'c' }] });
  assert.equal(out.b[0].cookie, '***');
  assert.ok(out.a, '深层结构不该让函数抛异常');
  assert.equal(JSON.stringify(out).includes('"c"'), false);
});

test('诊断包：事件骨架里没有昵称、没有弹幕正文、uid 只留短哈希', () => {
  const rec = {
    seq: 7,
    type: 'DANMAKU',
    ts: 1700000000000,
    payload: {
      uid: '99887766',
      uname: '观众小明',
      text: '这是一句弹幕',
      giftName: '小心心',
      num: 3,
      battery: 12.5,
    },
  };

  const sk = eventSkeleton(rec);
  assert.equal(sk.seq, 7);
  assert.equal(sk.type, 'DANMAKU');
  assert.equal(sk.num, 3);
  assert.equal(sk.battery, 12.5);

  assert.equal(sk.uname, undefined, '昵称是第三方个人信息，不能进包');
  assert.equal(sk.text, undefined, '弹幕正文不能进包');
  assert.equal(sk.giftName, undefined);
  assert.equal(sk.uid, hashUid('99887766'), 'uid 换成短哈希');
  assert.equal(String(sk.uid).length, 8);
  assert.equal(String(sk.uid).includes('99887766'), false);

  // 同一个 uid 的哈希必须稳定：否则"这两条是不是同一个人"就判断不了
  assert.equal(hashUid('99887766'), hashUid(99887766));
  assert.notEqual(hashUid('1'), hashUid('2'));
});

test('诊断包：自己的昵称打码只留首字，空值不炸', () => {
  assert.equal(maskName('渔月崽'), '渔***');
  assert.equal(maskName('A'), 'A***');
  assert.equal(maskName(''), '');
  assert.equal(maskName(null), '');
});

/* ══════════════════════ 与真实 App 的接线 ══════════════════════ */

test('接线：App 生成的诊断包里没有 Cookie 原文，也没有插件目录的绝对路径', (t) => {
  const dir = tmp(t);
  const cookie = 'SESSDATA=sessdata_value_should_never_leak; bili_jct=jct_value_should_never_leak; DedeUserID=42';
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({ cookie, uid: 42, uname: '渔月崽', savedAt: '2026-11-01T00:00:00Z' }),
  );
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ roomId: '1901584685', dryRun: true }));

  const app = new App({ dataDir: dir, roomId: '1901584685', pluginsDir: 'C:\\Users\\someone\\渔月崽三代\\plugins' });
  const { buffer } = app.makeDiagnostic();
  const files = unzipStore(buffer);
  const all = [...files.values()].map((b) => b.toString('utf8')).join('\n');

  assert.equal(all.includes('sessdata_value_should_never_leak'), false, 'Cookie 值泄露');
  assert.equal(all.includes('jct_value_should_never_leak'), false, 'bili_jct 泄露');
  assert.equal(all.includes('someone'), false, '插件目录的绝对路径会带出系统用户名，要抹掉');

  const meta = JSON.parse(files.get('meta.json').toString('utf8'));
  assert.equal(meta.app, 'yuyue3');
  assert.equal(meta.roomId, '1901584685');
  assert.equal(meta.version, app.version);
});

test('接线：App 的口令状态可以走完整流程（设置 → 校验 → 解锁 → 关闭）', (t) => {
  const dir = tmp(t);
  const app = new App({ dataDir: dir, roomId: '1' });

  assert.equal(app.accessStatus().enabled, false);

  app.setAccessPassword('goodpass1');
  assert.equal(app.accessStatus().enabled, true);

  // 错的口令：抛 401，且带 code 供前端分支
  assert.throws(
    () => app.unlockAccess('wrongpass'),
    (err) => err.status === 401 && err.code === 'bad_token',
  );
  assert.equal(app.unlockAccess('goodpass1').enabled, true);

  app.disableAccess();
  assert.equal(app.accessStatus().enabled, false);
});

test('接线：设置更新源会落盘，重启后还在；非法地址被拒', (t) => {
  const dir = tmp(t);
  const app = new App({ dataDir: dir, roomId: '1' });
  app.setUpdateUrl('https://example.com/latest.json');

  const saved = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'));
  assert.equal(saved.updateUrl, 'https://example.com/latest.json');

  assert.throws(() => app.setUpdateUrl('ftp://example.com/x'), (err) => err.status === 400);
  // 空值合法：等于"不要检查更新"
  assert.equal(app.setUpdateUrl('').updateUrl, '');
});
