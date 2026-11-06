/**
 * 安装包（zip）的边界。
 *
 * 只保证三件事：
 * 1. 该带的带（LICENSE / docs / 安装说明 / ws）；
 * 2. 不该带的不带（data / logs / 代理 / 私钥）；
 * 3. 自己写的 zip 读写器能原样读回中文文件名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip, collectFiles, readZipEntries } from '../../scripts/make-dist.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

test('安装包：真实仓库收集到 LICENSE/docs/安装说明/ws，且不带私有文件', () => {
  const files = collectFiles(ROOT);
  const names = files.map((f) => f.rel);

  for (const need of ['LICENSE', 'docs/licensing.md', '安装说明.txt', 'node_modules/ws/package.json']) {
    assert.ok(names.includes(need), `安装包缺少 ${need}`);
  }
  for (const bad of names) {
    assert.ok(!bad.startsWith('data/'), `不该带 data/：${bad}`);
    assert.ok(!bad.startsWith('logs/'), `不该带 logs/：${bad}`);
    assert.ok(!bad.endsWith('.pem') && !bad.endsWith('.key'), `不该带私钥：${bad}`);
    assert.ok(!bad.endsWith('proxy.txt'), `不该带本机代理：${bad}`);
  }
  for (const devOnly of [
    '签发授权.bat',
    'docs/private-key.md',
    'docs/决策记录.md',
    'server/tools/license-issue.mjs',
    'server/tools/license-studio.mjs',
    'server/tools/license-studio.html',
    'server/tools/license-keygen.mjs',
  ]) {
    assert.ok(!names.includes(devOnly), `开发者专用文件不该进安装包：${devOnly}`);
  }
});

test('安装包：自己写的 zip 能读回内容，中文文件名不丢', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yq-dist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'license-text\n');
  fs.writeFileSync(path.join(dir, 'docs', 'licensing.md'), '# 许可\n');
  fs.writeFileSync(path.join(dir, '安装说明.txt'), '安装说明\n');
  fs.writeFileSync(path.join(dir, 'scripts-proxy.txt'), 'proxy\n');

  const files = [
    { rel: 'LICENSE', abs: path.join(dir, 'LICENSE') },
    { rel: 'docs/licensing.md', abs: path.join(dir, 'docs', 'licensing.md') },
    { rel: '安装说明.txt', abs: path.join(dir, '安装说明.txt') },
  ];
  const buf = buildZip(files);
  const entries = readZipEntries(buf);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['LICENSE', 'docs/licensing.md', '安装说明.txt']);
  const zh = entries.find((e) => e.name === '安装说明.txt');
  assert.equal(zh.data.toString('utf8'), '安装说明\n');
  const lic = entries.find((e) => e.name === 'LICENSE');
  assert.equal(lic.data.toString('utf8'), 'license-text\n');
});

test('安装包：scripts/proxy.txt 会被跳过，但 scripts/install.bat 保留', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yq-dist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'install.bat'), '@echo off\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'proxy.txt'), 'http://127.0.0.1:12450\n');

  const files = collectFiles(dir);
  const names = files.map((f) => f.rel);
  assert.ok(names.includes('scripts/install.bat'));
  assert.ok(!names.includes('scripts/proxy.txt'));

  // 临时目录里没有 DIST_ENTRIES 的其它项，这组只验证 scripts/ 下的取舍。
  const zip = readZipEntries(buildZip(files));
  assert.ok(zip.some((e) => e.name === 'scripts/install.bat'));
  assert.ok(!zip.some((e) => e.name === 'scripts/proxy.txt'));
});
