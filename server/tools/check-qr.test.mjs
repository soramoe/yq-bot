/**
 * 二维码编码器自检。
 *
 * 这个测试的价值全在"对照"：自己写的编码器如果画错了，
 * 单靠自己测自己是查不出来的（同一个人犯的错会一致地犯两次）。
 *
 * 所以拿一个成熟实现（二代项目 node_modules 里的 qrcode）当参照，
 * 把 10 个版本 × 8 个掩码的模块矩阵逐位比对。
 * 一位不一致就算失败 —— 二维码没有"差不多对"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

import { encodeQr, byteCapacity, pickVersion, MIN_VERSION, MAX_VERSION } from '../qr/encode.mjs';
import { qrSvg, qrTerminal } from '../qr/svg.mjs';

/** 参照实现的位置（二代项目的依赖，仅测试期使用，不进三代运行时） */
const ORACLE_PKG = 'E:/渔月崽二代机器人/package.json';

let QRCode = null;
try {
  if (existsSync(ORACLE_PKG)) {
    QRCode = createRequire(ORACLE_PKG)('qrcode');
  }
} catch {
  QRCode = null;
}

/**
 * 造一段指定字节长度的 ASCII 文本。
 *
 * 必须含小写字母：纯大写的字母数字内容会被参照实现自动切到
 * alphanumeric 模式（0010），而本编码器固定用 byte 模式（0100），
 * 两者码流不同，逐位比对就会假失败。
 */
function textOfLength(n) {
  const base = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  while (s.length < n) s += base;
  return s.slice(0, n);
}

/** 把文本包成"强制字节模式"的分段，确保参照实现和本编码器走同一条路 */
function asByteSegment(text) {
  return [{ data: text, mode: 'byte' }];
}

test('版本选择：容量边界正确', () => {
  // 每个版本能装的字节数是单调递增的，且 pickVersion 恰好卡在边界上
  let prev = 0;
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    const cap = byteCapacity(v);
    assert.ok(cap > prev, `版本 ${v} 的容量 ${cap} 应该大于版本 ${v - 1} 的 ${prev}`);
    prev = cap;

    assert.equal(pickVersion(cap), v, `${cap} 字节应该刚好装进版本 ${v}`);
    if (v < MAX_VERSION) {
      assert.equal(pickVersion(cap + 1), v + 1, `${cap + 1} 字节应该装不进版本 ${v}`);
    }
  }
});

test('版本选择：超长内容要明确报错，不能静默截断', () => {
  const tooLong = textOfLength(byteCapacity(MAX_VERSION) + 1);
  assert.throws(() => pickVersion(tooLong.length), /内容过长/);
});

test('二维码：与参照实现逐位一致（10 版本 × 8 掩码 = 80 组）', (t) => {
  if (!QRCode) return t.skip(`未找到参照实现：${ORACLE_PKG}`);

  let checked = 0;
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    // 用"刚好装满该版本"的内容，这样填充字节和分块都走到极限
    const text = textOfLength(byteCapacity(version));

    for (let mask = 0; mask < 8; mask++) {
      const mine = encodeQr(text, { version, mask });
      const ref = QRCode.create(asByteSegment(text), {
        errorCorrectionLevel: 'M',
        version,
        maskPattern: mask,
      });

      assert.equal(mine.size, ref.modules.size, `版本 ${version} 尺寸不一致`);

      const size = mine.size;
      let diff = 0;
      let firstDiff = -1;
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const a = mine.at(r, c);
          const b = ref.modules.data[r * size + c] ? 1 : 0;
          if (a !== b) {
            diff++;
            if (firstDiff < 0) firstDiff = r * size + c;
          }
        }
      }

      assert.equal(
        diff,
        0,
        `版本 ${version} 掩码 ${mask} 有 ${diff} 个模块不一致` +
          (firstDiff >= 0 ? `（首个差异 row=${Math.floor(firstDiff / size)} col=${firstDiff % size}）` : ''),
      );
      checked++;
    }
  }

  assert.equal(checked, 80, '应该比对了 80 组');
});

test('二维码：自动选版本与自动选掩码，结果与参照实现相同', (t) => {
  if (!QRCode) return t.skip('未找到参照实现');

  const samples = [
    'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=abc123',
    'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=' + 'x'.repeat(64),
    textOfLength(200),
    'hi',
  ];

  for (const text of samples) {
    const mine = encodeQr(text);
    const ref = QRCode.create(asByteSegment(text), { errorCorrectionLevel: 'M' });

    assert.equal(mine.version, ref.version, `「${text.slice(0, 30)}…」自动版本不一致`);
    assert.equal(mine.mask, ref.maskPattern, `「${text.slice(0, 30)}…」自动掩码不一致`);

    const size = mine.size;
    let diff = 0;
    for (let i = 0; i < size * size; i++) {
      if (mine.modules[i] !== (ref.modules.data[i] ? 1 : 0)) diff++;
    }
    assert.equal(diff, 0, `「${text.slice(0, 30)}…」有 ${diff} 个模块不一致`);
  }
});

test('二维码：功能图形位置符合规范', () => {
  const qr = encodeQr(textOfLength(40));

  // 三个定位图形的中心 3×3 必须是黑的
  for (const [r, c] of [
    [3, 3],
    [3, qr.size - 4],
    [qr.size - 4, 3],
  ]) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        assert.equal(qr.at(r + dr, c + dc), 1, `定位图形中心 (${r},${c}) 应为黑`);
      }
    }
  }

  // 时序图形交替
  for (let i = 8; i < qr.size - 8; i++) {
    assert.equal(qr.at(6, i), i % 2 === 0 ? 1 : 0, `时序图形第 6 行第 ${i} 列不对`);
  }
});

test('二维码：SVG 输出结构可用', () => {
  const svg = qrSvg('https://example.com/test');

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /<path d="M/, '应该用 path 而不是几百个 rect');
  assert.ok(svg.endsWith('</svg>'));

  // 一个二维码不该产生上万字符的 SVG
  assert.ok(svg.length < 20_000, `SVG 长度 ${svg.length} 异常`);
});

test('二维码：终端输出每行宽度一致', () => {
  const lines = qrTerminal('https://example.com').split('\n');
  assert.ok(lines.length > 10);

  // 去掉 ANSI 颜色码后，每行字符数必须相同
  const widths = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length);
  assert.equal(new Set(widths).size, 1, `终端二维码各行列数不一致：${[...new Set(widths)].join(',')}`);
});
