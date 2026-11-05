/**
 * P2 层自检：路由、静态文件、WebSocket 补发、前端状态仓库。
 *
 * 这里不连 B站：WS 部分用假 App 对象驱动。
 * 好处是这些断言永远能跑，不受直播间开不开播影响 ——
 * 一个"偶尔才能跑"的测试等于没有测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { Router } from '../http/router.mjs';
import { resolveStaticPath } from '../http/static.mjs';
import { isLocalHost } from '../http/json.mjs';
import { attachWebSocket } from '../http/ws.mjs';
import App, { upTo } from '../app.mjs';

import { store } from '../../web/core/store.js';
import { battery, yuan, guardName, hhmmss } from '../../web/core/format.js';

/* ══════════════════════ 路由 ══════════════════════ */

test('路由：精确匹配与命名参数', () => {
  const r = new Router();
  r.get('/api/status', () => 'status');
  r.post('/api/room/:id', () => 'room');

  const a = r.match('GET', '/api/status');
  assert.equal(a.handler(), 'status');

  const b = r.match('POST', '/api/room/12345');
  assert.equal(b.handler(), 'room');
  assert.equal(b.params.id, '12345');

  // 结尾多一个斜杠也算命中：手输地址时很常见
  assert.equal(r.match('GET', '/api/status/').handler(), 'status');
});

test('路由：参数不会吃掉斜杠', () => {
  const r = new Router();
  r.get('/api/room/:id', () => 'room');
  assert.equal(r.match('GET', '/api/room/1/extra'), null, '/api/room/1/extra 不该命中原路由');
});

test('路由：方法不对时返回 allow 列表', () => {
  const r = new Router();
  r.get('/api/status', () => 1);
  r.post('/api/status', () => 2);

  const hit = r.match('DELETE', '/api/status');
  assert.ok(hit.allow, '应当返回 allow 而不是 null');
  assert.deepEqual(hit.allow.sort(), ['GET', 'OPTIONS', 'POST']);
});

test('路由：参数里的中文与百分号编码能正确还原', () => {
  const r = new Router();
  r.get('/api/room/:id', (ctx) => ctx.params.id);
  const hit = r.match('GET', '/api/room/%E4%B8%AD%E6%96%87');
  assert.equal(hit.handler(hit), '中文');
});

test('路由：参数里有坏掉的百分号编码时报 400，不能变成 500', () => {
  const r = new Router();
  r.post('/api/plugins/:id/config', () => 'config');

  /**
   * `%E0%A4%A` 是 **不完整的多字节序列**：`new URL()` 照收不误，
   * 但 `decodeURIComponent()` 会抛 `URIError`。
   *
   * 以前这个异常原样冒到 HTTP 层：状态码 500、日志里打一整段堆栈、
   * 错误码 `internal_error`。而这明明是**请求方写错了地址**，
   * 服务端没出任何问题 —— 报 500 会让人去翻服务端日志找不存在的问题，
   * 而且任何本机进程只要拼个坏地址就能把日志刷满。
   */
  for (const bad of ['/api/plugins/%E0%A4%A/config', '/api/plugins/%ZZ/config']) {
    assert.throws(
      () => r.match('POST', bad),
      (err) => err.status === 400 && err.code === 'bad_path',
      `应当按"地址不合法"处理：${bad}`,
    );
  }
});

/* ══════════════════════ 静态文件 ══════════════════════ */

test('静态文件：拒绝目录穿越的四种写法', () => {
  const root = join(tmpdir(), 'webroot-test');
  for (const evil of [
    '/../package.json',
    '/../../Windows/win.ini',
    '/%2e%2e/%2e%2e/package.json',
    '/core/../../../package.json',
  ]) {
    assert.equal(resolveStaticPath(root, evil), null, `应当拒绝：${evil}`);
  }
});

test('静态文件：拒绝 NUL 截断与不允许的扩展名', () => {
  const root = join(tmpdir(), 'webroot-test');
  assert.equal(resolveStaticPath(root, '/app.js%00.png'), null);
  assert.equal(resolveStaticPath(root, '/.env'), null, '没有扩展名的文件不该被发出去');
  assert.equal(resolveStaticPath(root, '/data.json.bak'), null);
});

test('静态文件：合法路径按白名单解析，目录取 index.html', () => {
  const root = join(tmpdir(), 'webroot-test');
  assert.equal(resolveStaticPath(root, '/app.css'), join(root, 'app.css'));
  assert.equal(resolveStaticPath(root, '/'), join(root, 'index.html'));
  assert.equal(resolveStaticPath(root, '/core/dom.js'), join(root, 'core', 'dom.js'));
});

test('静态文件：/webapp 不会被当成 /web 的子目录', () => {
  const root = join(tmpdir(), 'web');
  // 关键：前缀检查必须带分隔符，否则 /webapp/x.js 能绕过
  assert.equal(resolveStaticPath(root, '/../webapp/x.js'), null);
});

/* ══════════════════════ Host 校验 ══════════════════════ */

test('Host 校验：只认本机地址', () => {
  const mk = (host) => ({ headers: { host } });
  assert.equal(isLocalHost(mk('127.0.0.1:8900'), 8900), true);
  assert.equal(isLocalHost(mk('localhost:8900'), 8900), true);
  assert.equal(isLocalHost(mk('[::1]:8900'), 8900), true);

  assert.equal(isLocalHost(mk('evil.example.com'), 8900), false);
  assert.equal(isLocalHost(mk('127.0.0.1.evil.com:8900'), 8900), false);
  assert.equal(isLocalHost(mk(''), 8900), false);
});

/* ══════════════════════ WebSocket 补发 ══════════════════════ */

/** 起一个只提供 /ws 的临时服务，用假 App 驱动 */
async function startWsFixture({ events = [], onRecent } = {}) {
  const subs = new Set();

  const app = {
    status: () => ({ ok: true, room: { roomId: '1' } }),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    recentEvents({ after = 0, limit = 100 } = {}) {
      if (onRecent) onRecent({ broadcast: (msg) => subs.forEach((f) => f(msg)) });

      const pool = events.filter((e) => e.seq > after).slice(0, limit);
      return {
        events: pool,
        gap: false,
        from: pool[0]?.seq ?? 0,
        to: pool[pool.length - 1]?.seq ?? 0,
        oldestSeq: events[0]?.seq ?? 0,
      };
    },
  };

  const server = createServer((req, res) => {
    res.writeHead(404).end();
  });
  const { port } = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
  attachWebSocket(server, app, { port });

  return {
    port,
    broadcast: (msg) => subs.forEach((f) => f(msg)),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/**
 * 连上并立刻开始收集消息。
 *
 * 注意：必须在构造 WebSocket 的同一步挂 message 监听。
 * 如果等 'open' 之后再挂，服务端在 handleUpgrade 里发出的第一条
 * 消息可能已经先到了 —— 那是测试自己的竞态，不是服务端丢消息。
 */
function openWs(port, query = '') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
    const queue = [];
    const waiters = [];

    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });

    ws.on('error', reject);

    ws.once('open', () => {
      resolve({
        ws,
        close: () => ws.close(),
        next(ms = 2000) {
          if (queue.length) return Promise.resolve(queue.shift());
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('等待 WS 消息超时')), ms);
            waiters.push((msg) => {
              clearTimeout(timer);
              res(msg);
            });
          });
        },
      });
    });
  });
}

test('WS：连接后先收 hello，再收一整批 backlog', async () => {
  const events = [1, 2, 3].map((i) => ({ seq: i, ts: 1000 + i, type: 'DANMAKU', payload: { text: `t${i}` } }));
  const fx = await startWsFixture({ events });
  const conn = await openWs(fx.port);

  try {
    const hello = await conn.next();
    assert.equal(hello.type, 'hello');

    const backlog = await conn.next();
    assert.equal(backlog.type, 'backlog');
    assert.equal(backlog.data.events.length, 3, '一次性给整批，不是逐条挤出来');
    assert.deepEqual(
      backlog.data.events.map((e) => e.seq),
      [1, 2, 3],
    );
  } finally {
    conn.close();
    await fx.close();
  }
});

test('WS：带 after 时只补发之后的事件', async () => {
  const events = [1, 2, 3, 4, 5].map((i) => ({ seq: i, ts: i, type: 'DANMAKU', payload: {} }));
  const fx = await startWsFixture({ events });
  const conn = await openWs(fx.port, '?after=3');

  try {
    await conn.next(); // hello
    const backlog = await conn.next();
    assert.deepEqual(
      backlog.data.events.map((e) => e.seq),
      [4, 5],
      '断点续传：3 之前的一条都不该重发',
    );
  } finally {
    conn.close();
    await fx.close();
  }
});

test('WS：取快照期间到达的事件不能丢（先订阅再取快照）', async () => {
  // 这个顺序是二代的隐患：先取 backlog 再订阅，中间到达的事件永久丢失。
  // 这里让 recentEvents 在被调用时同步广播一条，模拟这个竞态。
  const fx = await startWsFixture({
    events: [],
    onRecent: ({ broadcast }) => {
      broadcast({ type: 'event', data: { seq: 99, ts: 99, type: 'DANMAKU', payload: { text: '抢跑' } } });
    },
  });
  const conn = await openWs(fx.port);

  try {
    await conn.next(); // hello
    await conn.next(); // backlog

    const racing = await conn.next();
    assert.equal(racing.type, 'event');
    assert.equal(racing.data.seq, 99, '快照期间到达的事件必须在 backlog 之后补上');
  } finally {
    conn.close();
    await fx.close();
  }
});

test('WS：订阅之后的新事件会即时推送', async () => {
  const fx = await startWsFixture({ events: [] });
  const conn = await openWs(fx.port);

  try {
    await conn.next(); // hello
    await conn.next(); // backlog

    fx.broadcast({ type: 'event', data: { seq: 7, ts: 7, type: 'GIFT', payload: {} } });
    const ev = await conn.next();
    assert.equal(ev.data.seq, 7);
  } finally {
    conn.close();
    await fx.close();
  }
});

test('WS：跨站 Origin 的升级请求被拒绝（WebSocket 不受同源策略保护）', async () => {
  const fx = await startWsFixture({ events: [] });
  try {
    const err = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${fx.port}/ws`, { origin: 'http://evil.example.com' });
      ws.once('open', () => resolve('open'));
      ws.once('error', resolve);
      ws.once('unexpected-response', (_req, res) => resolve(`HTTP ${res.statusCode}`));
    });
    assert.notEqual(err, 'open', '别的网页不该能连上来读弹幕');
    assert.match(String(err?.message ?? err), /403|Unexpected server response/);
  } finally {
    await fx.close();
  }
});

test('WS：非 /ws 的升级请求被拒绝', async () => {
  const fx = await startWsFixture({ events: [] });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${fx.port}/other`);
    const err = await new Promise((resolve) => ws.once('error', resolve));
    assert.ok(err, '应当连接失败');
  } finally {
    await fx.close();
  }
});

/* ══════════════════════ 补发缺口判定 ══════════════════════ */

/** 直接调真实的 recentEvents 实现，不需要起房间 */
function pageWith(events, opts) {
  // 缓冲现在挂在"房间"上（多房间）：假对象只要给出 `_activeRoom()` 就够
  const room = { key: 'x', events, oldestSeq: events[0]?.seq ?? 0 };
  const fake = { _activeRoom: () => room };
  return App.prototype.recentEvents.call(fake, opts);
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i }));

test('补发：一次给不完时必须标 gap（这就是"事件流少一截"的老病根）', () => {
  const events = range(1, 2500);

  const page = pageWith(events, { after: 1, limit: 800 });

  assert.equal(page.events.length, 800);
  assert.equal(page.from, 2);
  assert.equal(page.to, 801);
  assert.equal(page.latestSeq, 2500);
  assert.equal(page.gap, true, '后面还有 1699 条没给，绝不能装作连续');
});

test('补发：追上了就不报缺口（正常断线重连）', () => {
  const events = range(1, 2500);
  const page = pageWith(events, { after: 2400, limit: 800 });

  assert.equal(page.to, 2500);
  assert.equal(page.gap, false);
});

test('补发：要的比缓冲里最早的还早，也要报缺口', () => {
  const events = range(1000, 1200);
  const page = pageWith(events, { after: 10, limit: 800 });

  assert.equal(page.gap, true);
  assert.equal(page.from, 1000);
});

test('补发：after 已经是最新时返回空，且不算缺口', () => {
  const events = range(1, 500);
  const page = pageWith(events, { after: 500, limit: 800 });

  assert.equal(page.events.length, 0);
  assert.equal(page.gap, false);
  assert.equal(page.latestSeq, 500);
});

test('对账：只比到快照那一刻，别把后到的事件算成差异', () => {
  const events = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];

  assert.equal(upTo({ lastSeq: 2 }, events).length, 2, '快照只到 2，第 3 条不能算进去');
  assert.equal(upTo({ lastSeq: 3 }, events).length, 3);
  assert.equal(upTo({ lastSeq: 0 }, events).length, 3, '快照没有 seq 时不要乱过滤');
  assert.equal(upTo(null, events).length, 3);
});

/* ══════════════════════ 前端状态仓库 ══════════════════════ */

test('仓库：重复投递同一条事件不会翻倍', () => {
  store.reset();
  const evs = [1, 2, 3].map((i) => ({ seq: i, ts: i, type: 'DANMAKU', payload: {} }));

  store.ingest(evs);
  store.ingest(evs); // 补发 + 实时流重叠的典型场景

  assert.equal(store.events.length, 3);
  assert.equal(store.lastSeq, 3);
});

test('仓库：乱序到达会按 seq 排好', () => {
  store.reset();
  store.ingest([{ seq: 3, ts: 3, type: 'A', payload: {} }]);
  store.ingest([{ seq: 1, ts: 1, type: 'A', payload: {} }]);
  store.ingest([{ seq: 2, ts: 2, type: 'A', payload: {} }]);

  assert.deepEqual(
    store.events.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(store.lastSeq, 3);
});

test('仓库：补发不覆盖已经收到的最新的 seq', () => {
  store.reset();
  store.ingest([{ seq: 10, ts: 10, type: 'A', payload: {} }]);
  store.ingest([
    { seq: 8, ts: 8, type: 'A', payload: {} },
    { seq: 9, ts: 9, type: 'A', payload: {} },
  ]);

  assert.deepEqual(
    store.events.map((e) => e.seq),
    [8, 9, 10],
  );
  assert.equal(store.lastSeq, 10);
});

test('仓库：一批内部乱序时，也要按 seq 排好（不能假设服务端一定升序）', () => {
  store.reset();
  store.ingest([{ seq: 10, ts: 10, type: 'A', payload: {} }]);

  // 这一批的第一个比 tail 大，后面两个却更小 —— 以前按 added[0] 判断会直接追加，顺序就乱了
  store.ingest([
    { seq: 12, ts: 12, type: 'A', payload: {} },
    { seq: 11, ts: 11, type: 'A', payload: {} },
    { seq: 13, ts: 13, type: 'A', payload: {} },
  ]);

  assert.deepEqual(
    store.events.map((e) => e.seq),
    [10, 11, 12, 13],
  );
  assert.equal(store.lastSeq, 13);
});

test('仓库：没有 seq 的脏数据被丢弃，不会污染顺序', () => {
  store.reset();
  store.ingest([{ seq: 1, ts: 1, type: 'A', payload: {} }, null, { type: 'B' }, { seq: NaN }]);
  assert.equal(store.events.length, 1);
});

/* ══════════════════════ 格式化 ══════════════════════ */

test('格式化：电池与元的换算差十倍，不能混', () => {
  assert.equal(battery(0), '0');
  assert.equal(battery(12.3), '12.3');
  assert.equal(battery(10), '10');

  // 1 电池 = 0.1 元
  assert.equal(yuan(100), '10');
  assert.equal(yuan(10), '1');
  assert.equal(yuan(1234), '123.4', '1234 电池 = 123.4 元');
});

test('格式化：大航海等级与时间', () => {
  assert.equal(guardName(1), '总督');
  assert.equal(guardName(2), '提督');
  assert.equal(guardName(3), '舰长');
  assert.equal(guardName(0), '大航海');

  const t = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.equal(hhmmss(t), '03:04:05');
});
