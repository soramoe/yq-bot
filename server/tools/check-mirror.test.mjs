import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  packageFromManifest,
  pickKeep,
  publishToDir,
  sha256Hex,
  signS3Put,
} from '../../scripts/mirror-release.mjs';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yq-mirror-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('镜像：清单字段要能挡住坏地址和坏版本', () => {
  const ok = packageFromManifest({
    version: 'v0.2.4',
    download: 'https://github.com/o/r/releases/download/v0.2.4/yuyue3-0.2.4.tar.gz',
    sha256: 'a'.repeat(64),
    size: 123,
  });
  assert.equal(ok.version, '0.2.4');
  assert.equal(ok.name, 'yuyue3-0.2.4.tar.gz');

  assert.throws(() => packageFromManifest({ version: '最新', download: 'x', size: 1 }), /version/);
  assert.throws(() => packageFromManifest({ version: '0.2.4', download: '', size: 1 }), /download/);
  assert.throws(
    () => packageFromManifest({ version: '0.2.4', download: 'https://x/y.tgz', sha256: 'zz', size: 1 }),
    /sha256/
  );
  assert.throws(
    () => packageFromManifest({ version: '0.2.4', download: 'https://x/y.tgz', size: 0 }),
    /size/
  );
  assert.throws(
    () => packageFromManifest({ version: '0.2.4', download: 'https://x/y.tgz', size: 200 * 1024 * 1024 }),
    /100MB/
  );
});

test('镜像：保留策略按修改时间留最新 N 个', () => {
  const files = [
    { name: 'a', mtimeMs: 1 },
    { name: 'b', mtimeMs: 3 },
    { name: 'c', mtimeMs: 2 },
  ];
  assert.deepEqual(pickKeep(files, 2).map((f) => f.name), ['b', 'c']);
  assert.deepEqual(pickKeep(files, 0).map((f) => f.name), ['b'], '至少留一个');
});

test('镜像：SigV4 签名稳定、可复现，路径按段编码', () => {
  const opts = {
    endpoint: 'https://acc.r2.cloudflarestorage.com',
    bucket: 'yq-mirror',
    key: 'yq/发布 包.tar.gz',
    body: Buffer.from('hello'),
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'SECRETEXAMPLE',
    region: 'auto',
    now: new Date('2026-11-05T12:34:56Z'),
  };
  const a = signS3Put(opts);
  const b = signS3Put(opts);
  assert.equal(a.headers.authorization, b.headers.authorization);
  assert.match(a.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261105\/auto\/s3\/aws4_request/);
  assert.equal(a.headers['x-amz-date'], '20261105T123456Z');
  assert.match(a.url, /^https:\/\/acc\.r2\.cloudflarestorage\.com\/yq-mirror\/yq\//);
  assert.match(a.url, /%E5%8F%91%E5%B8%83%20%E5%8C%85\.tar\.gz$/, '中文和空格要按 RFC3986 编码');

  const changed = signS3Put({ ...opts, body: Buffer.from('hello!') });
  assert.notEqual(changed.headers['x-amz-content-sha256'], a.headers['x-amz-content-sha256']);
  assert.notEqual(changed.headers.authorization, a.headers.authorization);
});

test('镜像：本地目录发布写入 latest.json 和同名包，并清理最旧的包', async (t) => {
  const dir = tmp(t);
  const pkg = Buffer.from('fake-package-bytes');
  const sha = sha256Hex(pkg);
  const manifest = {
    version: '0.2.4',
    download: 'http://127.0.0.1:0/yuyue3-0.2.4.tar.gz',
    sha256: sha,
    size: pkg.length,
  };

  const server = createServer((req, res) => {
    if (req.url === '/latest.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...manifest, download: `http://127.0.0.1:${server.address().port}/yuyue3-0.2.4.tar.gz` }));
      return;
    }
    if (req.url === '/yuyue3-0.2.4.tar.gz') {
      res.end(pkg);
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  // 造两个旧包，publish 后 keep=2 应该只留下「新包 + 最新的旧包」
  writeFileSync(join(dir, 'yuyue3-0.1.0.tar.gz'), 'old1');
  writeFileSync(join(dir, 'yuyue3-0.2.0.tar.gz'), 'old2');
  const longAgo = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(dir, 'yuyue3-0.1.0.tar.gz'), longAgo, longAgo);
  utimesSync(join(dir, 'yuyue3-0.2.0.tar.gz'), new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'));

  const out = await publishToDir({
    manifestUrl: `http://127.0.0.1:${server.address().port}/latest.json`,
    dir,
    keep: 2,
    allowHttp: true,
  });

  assert.equal(out.version, '0.2.4');
  assert.equal(readFileSync(join(dir, 'yuyue3-0.2.4.tar.gz')).compare(pkg), 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).version, '0.2.4');
  assert.equal(existsSync(join(dir, 'yuyue3-0.1.0.tar.gz')), false, '最旧的包应被清掉');
  assert.equal(existsSync(join(dir, 'yuyue3-0.2.0.tar.gz')), true, 'keep=2 时第二新的旧包要留着');
});

test('镜像：可以用本地清单和本地包发布，不需要联网', async (t) => {
  const dir = tmp(t);
  const pkg = Buffer.from('local-package-bytes');
  const sha = sha256Hex(pkg);
  const manifest = {
    version: '1.0.1',
    download: 'https://github.com/o/r/releases/download/v1.0.1/yuyue3-1.0.1.tar.gz',
    sha256: sha,
    size: pkg.length,
  };
  const manifestFile = join(dir, 'latest.src.json');
  const packageFile = join(dir, 'pkg.tar.gz');
  writeFileSync(manifestFile, JSON.stringify(manifest));
  writeFileSync(packageFile, pkg);

  const out = await publishToDir({
    manifestFile,
    packageFile,
    dir: join(dir, 'mirror'),
    log: () => {},
  });

  assert.equal(out.version, '1.0.1');
  assert.equal(readFileSync(join(dir, 'mirror', 'yuyue3-1.0.1.tar.gz')).compare(pkg), 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'mirror', 'latest.json'), 'utf8')).version, '1.0.1');
});

test('镜像：安装包跟着更新包一起发，两种产物各自留 N 份', async (t) => {
  const dir = tmp(t);
  const pkg = Buffer.from('local-package-bytes');
  const manifest = {
    version: '1.0.7',
    download: 'https://github.com/o/r/releases/download/v1.0.7/yuyue3-1.0.7.tar.gz',
    sha256: sha256Hex(pkg),
    size: pkg.length,
  };
  const manifestFile = join(dir, 'latest.src.json');
  const packageFile = join(dir, 'pkg.tar.gz');
  const zipFile = join(dir, 'yuqing-bot-1.0.7.zip');
  writeFileSync(manifestFile, JSON.stringify(manifest));
  writeFileSync(packageFile, pkg);
  writeFileSync(zipFile, 'install-zip-bytes');

  const mirror = join(dir, 'mirror');
  mkdirSync(mirror, { recursive: true });
  // 两类产物各堆 3 份旧的；keep=2 时每类只该剩「新的 + 最新的旧的那个」
  ['1.0.4', '1.0.5', '1.0.6'].forEach((v, i) => {
    for (const name of [`yuyue3-${v}.tar.gz`, `yuqing-bot-${v}.zip`]) {
      const file = join(mirror, name);
      writeFileSync(file, 'old');
      const at = new Date(Date.UTC(2020 + i, 0, 1));
      utimesSync(file, at, at);
    }
  });

  await publishToDir({
    manifestFile,
    packageFile,
    dir: mirror,
    keep: 2,
    extraFiles: [{ path: zipFile }],
    log: () => {},
  });

  assert.equal(readFileSync(join(mirror, 'yuqing-bot-1.0.7.zip'), 'utf8'), 'install-zip-bytes', '安装包要落盘');
  assert.equal(readFileSync(join(mirror, 'yuyue3-1.0.7.tar.gz')).compare(pkg), 0);

  const zips = readdirSync(mirror).filter((n) => n.endsWith('.zip')).sort();
  const tars = readdirSync(mirror).filter((n) => n.endsWith('.tar.gz')).sort();
  assert.deepEqual(zips, ['yuqing-bot-1.0.6.zip', 'yuqing-bot-1.0.7.zip'], '安装包不能把更新包挤掉，反之亦然');
  assert.deepEqual(tars, ['yuyue3-1.0.6.tar.gz', 'yuyue3-1.0.7.tar.gz']);
  assert.equal(existsSync(join(mirror, 'yuqing-bot-1.0.4.zip')), false, '最旧的安装包应被清掉');
});

test('镜像：sha256 对不上时拒绝落盘，不覆盖已有 latest.json', async (t) => {
  const dir = tmp(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'latest.json'), '{"version":"0.0.9"}');
  const pkg = Buffer.from('wrong');
  const server = createServer((req, res) => {
    if (req.url === '/latest.json') {
      res.end(
        JSON.stringify({
          version: '0.2.4',
          download: `http://127.0.0.1:${server.address().port}/yuyue3-0.2.4.tar.gz`,
          sha256: 'b'.repeat(64),
          size: pkg.length,
        })
      );
      return;
    }
    res.end(pkg);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  await assert.rejects(
    publishToDir({
      manifestUrl: `http://127.0.0.1:${server.address().port}/latest.json`,
      dir,
      allowHttp: true,
    }),
    /sha256/
  );
  assert.equal(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).version, '0.0.9');
});
