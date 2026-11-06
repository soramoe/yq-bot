/**
 * 许可与发布边界。
 *
 * 这组断言不检查「法律条款写得对不对」——那得人来看；它只保证工程上不会
 * 把不该丢的东西弄丢：许可证文件在、npm 发布清单带 LICENSE、私钥被 ignore、
 * Release 的 tar 不会把 LICENSE 排除掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('许可：仓库根目录是源码可见商业授权，不是 OSI 开源', () => {
  const text = read('LICENSE');
  assert.match(text, /YUQING SOURCE-AVAILABLE LICENSE/i);
  assert.match(text, /Production Use/, '必须写明生产使用需要授权');
  assert.match(text, /License Key/);
  assert.match(text, /not an OSI-approved open source/i);
  assert.doesNotMatch(text, /Permission is hereby granted, free of charge/i, '不能混进 MIT 的授权句');
});

test('许可：中文说明与私钥规范都在，并且写明了轮换和泄露处理', () => {
  const zh = read('docs/licensing.md');
  assert.match(zh, /不是 OSI 开源|不是 OSI/);
  assert.match(zh, /生产使用需要/);
  assert.match(zh, /私钥/);

  const key = read('docs/private-key.md');
  assert.match(key, /轮换|换密钥/);
  assert.match(key, /泄露/);
  assert.match(key, /\*\.pem/);
});

test('许可：npm 发布清单带 LICENSE 和 docs，package.json 标了许可证', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE');
  assert.ok(Array.isArray(pkg.files), '需要 files 字段，否则 npm pack 会漏文件');
  assert.ok(pkg.files.includes('LICENSE'));
  assert.ok(pkg.files.includes('docs/licensing.md'));
  assert.ok(pkg.files.includes('docs/使用手册.md'));
  assert.ok(pkg.files.includes('server/'));
});

test('许可：私钥被 gitignore 挡住；Release 打包不会排除 LICENSE', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^\*\.pem$/m);
  assert.match(ignore, /^\*\.key$/m);

  const flow = read('.github/workflows/release.yml');
  assert.match(flow, /find \. -mindepth 1 -maxdepth 1/);
  assert.doesNotMatch(flow, /grep -v[^\n]*LICENSE/, 'LICENSE 不能被 exclude');
});
