import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanEntryName, extractTarGz, parseTar } from '../core/release-tar.mjs';
import { App } from '../app.mjs';
import {
  backupAndReplace,
  downloadPackage,
  packageProblem,
  plannedItems,
  pruneBackups,
  restoreBackup,
  sha256Hex,
} from '../core/update-apply.mjs';

function header(name, size, type) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, 'utf8');
  b.write('0000644\0', 100);
  b.write('0000000\0', 108);
  b.write('0000000\0', 116);
  b.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  b.write('00000000000\0', 136);
  b.write('        ', 148);
  b.write(type, 156);
  b.write('ustar\0', 257);
  b.write('00', 263);
  return b;
}

function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    if (e.type === 'L') {
      const name = Buffer.from(e.name, 'utf8');
      parts.push(header(e.name.slice(0, 100), name.length, 'L'));
      parts.push(name, Buffer.alloc((512 - (name.length % 512)) % 512));
      continue;
    }
    const data = Buffer.from(e.data ?? '');
    parts.push(header(e.name, data.length, e.type ?? '0'));
    if (e.type !== '5') {
      parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'yuyue3-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('更新包：条目名规范化，绝对路径和 .. 一律拒绝', () => {
  assert.equal(cleanEntryName('server/app.mjs'), 'server/app.mjs');
  assert.equal(cleanEntryName('server\\web\\a.txt'), 'server/web/a.txt');
  assert.equal(cleanEntryName('./a//b'), 'a/b');
  assert.equal(cleanEntryName('../evil'), null);
  assert.equal(cleanEntryName('a/../../evil'), null);
  assert.equal(cleanEntryName('/etc/passwd'), null);
  assert.equal(cleanEntryName('C:/windows/system32'), null);
  assert.equal(cleanEntryName(''), null);
});

test('更新包：tar.gz 解压后内容一致，目录和空文件都保留', (t) => {
  const dest = makeRoot(t);
  const gz = gzipSync(
    makeTar([
      { name: 'server/', type: '5' },
      { name: 'server/app.mjs', data: 'new app' },
      { name: 'web/empty.txt', data: '' },
      { name: 'README.md', data: '# hi' },
    ]),
  );

  const { count } = extractTarGz(gz, dest);
  assert.equal(count, 3);
  assert.equal(readFileSync(join(dest, 'server', 'app.mjs'), 'utf8'), 'new app');
  assert.equal(readFileSync(join(dest, 'web', 'empty.txt'), 'utf8'), '');
  assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), '# hi');
});

test('更新包：路径穿越和符号链接在落盘前就被拦下', (t) => {
  const dest = makeRoot(t);
  assert.throws(
    () => extractTarGz(gzipSync(makeTar([{ name: '../evil.txt', data: 'x' }])), dest),
    /不安全路径/,
  );

  const link = makeTar([{ name: 'server/link', type: '2' }]);
  assert.throws(() => extractTarGz(gzipSync(link), dest), /不支持的条目类型/);
});

test('更新包：sha256 和 size 对不上时明确报错', () => {
  const buf = Buffer.from('hello update');
  const good = sha256Hex(buf);
  assert.equal(packageProblem(buf, { sha256: good, size: buf.length }), '');
  assert.match(packageProblem(buf, { sha256: '0'.repeat(64) }), /sha256/);
  assert.match(packageProblem(buf, { size: buf.length + 1 }), /大小不对/);
  assert.match(packageProblem(Buffer.alloc(0)), /空的/);
});

test('更新包：替换前先备份，替换失败/回滚能还原旧文件', (t) => {
  const root = makeRoot(t);
  const staging = makeRoot(t);
  const backupDir = join(root, 'data', 'backups', '20261105-120000');

  mkdirSync(join(root, 'server'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'server', 'app.mjs'), 'old');
  writeFileSync(join(root, 'data', 'auth.json'), '{"keep":true}');
  writeFileSync(join(root, 'README.md'), 'old readme');

  mkdirSync(join(staging, 'server'), { recursive: true });
  writeFileSync(join(staging, 'server', 'app.mjs'), 'new');
  writeFileSync(join(staging, 'README.md'), 'new readme');

  const items = plannedItems(staging);
  assert.deepEqual(items.sort(), ['README.md', 'server']);

  const touched = backupAndReplace({ root, staging, items, backupDir });
  assert.equal(readFileSync(join(root, 'server', 'app.mjs'), 'utf8'), 'new');
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'new readme');
  // data/ 不在替换清单里，原样保留
  assert.equal(readFileSync(join(root, 'data', 'auth.json'), 'utf8'), '{"keep":true}');
  assert.equal(readFileSync(join(backupDir, 'server', 'app.mjs'), 'utf8'), 'old');

  restoreBackup({ root, backupDir, items: touched });
  assert.equal(readFileSync(join(root, 'server', 'app.mjs'), 'utf8'), 'old');
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'old readme');
  assert.equal(existsSync(join(root, 'data', 'auth.json')), true);
});

test('更新包：只替换包里真实存在的条目，不碰没动过的东西', (t) => {
  const root = makeRoot(t);
  const staging = makeRoot(t);
  mkdirSync(join(root, 'server'), { recursive: true });
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'server', 'app.mjs'), 'old');
  writeFileSync(join(root, 'web', 'app.js'), 'keep me');

  mkdirSync(join(staging, 'server'), { recursive: true });
  writeFileSync(join(staging, 'server', 'app.mjs'), 'new');

  const touched = backupAndReplace({
    root,
    staging,
    items: ['server', 'web'],
    backupDir: join(root, 'data', 'backups', '20261105-130000'),
  });
  assert.deepEqual(touched, ['server']);
  assert.equal(readFileSync(join(root, 'web', 'app.js'), 'utf8'), 'keep me');
});

test('更新包：备份只留最近两份', (t) => {
  const root = makeRoot(t);
  const backups = join(root, 'backups');
  for (const name of ['20261101-100000', '20261102-100000', '20261103-100000']) {
    mkdirSync(join(backups, name), { recursive: true });
  }
  pruneBackups(backups, 2);
  assert.equal(existsSync(join(backups, '20261101-100000')), false);
  assert.equal(existsSync(join(backups, '20261102-100000')), true);
  assert.equal(existsSync(join(backups, '20261103-100000')), true);
});

test('更新包：GNU 长文件名也能解出来', (t) => {
  const dest = makeRoot(t);
  const long = `server/${'x'.repeat(120)}.mjs`;
  const gz = gzipSync(makeTar([{ type: 'L', name: long }, { name: 'short.mjs', data: 'ok' }]));
  const { files } = extractTarGz(gz, dest);
  assert.ok(files.includes(long), `长文件名应被还原成 ${long}`);
  assert.equal(readFileSync(join(dest, long), 'utf8'), 'ok');
});

test('更新包：parseTar 读得回自己写的最小 tar', () => {
  const entries = parseTar(makeTar([{ name: 'a.txt', data: 'abc' }]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'a.txt');
  assert.equal(entries[0].data.toString('utf8'), 'abc');
});

test('更新包：下载只走 https，http 地址在发请求前就拒绝', async () => {
  let called = 0;
  await assert.rejects(
    downloadPackage({
      url: 'http://example.com/pkg.tar.gz',
      fetchImpl: async () => {
        called++;
        return { ok: true };
      },
    }),
    /https/,
  );
  assert.equal(called, 0);
});

test('更新包：https 被重定向到 http 也要拒绝，不能只看起始地址', async () => {
  await assert.rejects(
    downloadPackage({
      url: 'https://example.com/pkg.tar.gz',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'http://example.com/pkg.tar.gz',
        headers: { get: () => '10' },
        arrayBuffer: async () => Buffer.alloc(10),
      }),
    }),
    /非 https/,
  );
});

test('更新下载：校验通过才落盘，重复下载复用缓存', async (t) => {
  const dataDir = makeRoot(t);
  const pkg = gzipSync(makeTar([{ name: 'server/app.mjs', data: 'new' }]));
  const sha = sha256Hex(pkg);

  let calls = 0;
  const app = new App({
    dataDir,
    roomId: '1',
    dryRun: true,
    fetchImpl: async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(pkg.length) },
        arrayBuffer: async () => pkg,
      };
    },
  });
  app.update._cache = {
    configured: true,
    hasUpdate: true,
    current: '0.2.0',
    latest: '0.3.0',
    download: 'https://example.com/yuyue3-0.3.0.tar.gz',
    sha256: sha,
    size: pkg.length,
    source: 'https://example.com/latest.json',
    checkedAt: Date.now(),
  };

  const first = await app.downloadUpdate();
  assert.equal(first.bytes, pkg.length);
  assert.equal(first.sha256, sha);
  assert.equal(existsSync(first.file), true);

  const second = await app.downloadUpdate();
  assert.equal(second.cached, true);
  assert.equal(calls, 1, '同一个包不该重复下载');
});

test('更新下载：sha 对不上时报错，不留下半成品', async (t) => {
  const dataDir = makeRoot(t);
  const pkg = gzipSync(makeTar([{ name: 'server/app.mjs', data: 'new' }]));
  const app = new App({
    dataDir,
    roomId: '1',
    dryRun: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(pkg.length) },
      arrayBuffer: async () => pkg,
    }),
  });
  app.update._cache = {
    configured: true,
    hasUpdate: true,
    current: '0.2.0',
    latest: '0.3.0',
    download: 'https://example.com/yuyue3-0.3.0.tar.gz',
    sha256: '0'.repeat(64),
    size: pkg.length,
    checkedAt: Date.now(),
  };

  await assert.rejects(app.downloadUpdate(), /sha256/);
  assert.equal(existsSync(join(dataDir, 'updates', '0.3.0', 'package.tar.gz')), false);
});

test('更新下载：没有检查到新版本时明确拒绝', async (t) => {
  const dataDir = makeRoot(t);
  const app = new App({ dataDir, roomId: '1', dryRun: true });
  await assert.rejects(app.downloadUpdate(), /先点"检查更新"/);
});
