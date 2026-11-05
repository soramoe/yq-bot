import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  drawPoster,
  downloadPoster,
  posterFileName,
  posterLines,
} from '../../web/views/report-poster.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel) => readFileSync(`${ROOT}/${rel}`, 'utf8');

function fakeCtx() {
  const texts = [];
  const rects = [];
  const lines = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    createLinearGradient() {
      return { addColorStop() {} };
    },
    fillRect(x, y, w, h) {
      rects.push([x, y, w, h]);
    },
    fillText(text, x, y) {
      texts.push({ text: String(text), x, y });
    },
    beginPath() {},
    moveTo(x, y) {
      lines.push(['m', x, y]);
    },
    lineTo(x, y) {
      lines.push(['l', x, y]);
    },
    stroke() {},
    save() {},
    restore() {},
  };
  return { ctx, texts, rects, lines };
}

function report(over) {
  return {
    startedAt: Date.parse('2026-11-05T20:00:00+08:00'),
    durationSec: 2 * 3600 + 14 * 60,
    danmaku: 1234,
    uniqueViewers: 56,
    enterCount: 78,
    followCount: 9,
    peakPopularity: 3456,
    giftCount: 12,
    giftBattery: 2380,
    guardCount: 2,
    guardBattery: 1980,
    scCount: 3,
    scBattery: 60,
    totalBattery: 4420,
    giftTop: [
      { name: '火箭', count: 2 },
      { name: '小花花', count: 8 },
      { name: '辣条', count: 20 },
      { name: '不该出现', count: 1 },
    ],
    closed: true,
    endedAtEstimated: false,
    implicit: false,
    stale: false,
    ...over,
  };
}

test('战报海报：标题、日期、四项现场数据与收入都来自同一个场次', () => {
  const L = posterLines(report());
  assert.equal(L.kicker, '渔情LiveBot · 直播战报');
  assert.equal(L.date, '2026.11.05');
  assert.equal(L.time, '20:00');
  assert.equal(L.duration, '2 小时 14 分');
  assert.deepEqual(L.stats, [
    ['弹幕', '1234'],
    ['观众', '56'],
    ['进场', '78'],
    ['涨粉', '9'],
  ]);
  assert.deepEqual(L.rows, [
    ['礼物', '12 件', '¥238'],
    ['舰长', '2 位', '¥198'],
    ['醒目留言', '3 条', '¥6'],
  ]);
  assert.equal(L.total, '¥442');
  assert.match(L.top, /火箭/);
  assert.equal(L.top.split('·').length, 3, '热门礼物最多三条');
});

test('战报海报：推算起点/推算结束/中断各自加限定语，不冒充精确', () => {
  assert.equal(posterLines(report({ implicit: true })).duration, '≥ 2 小时 14 分');
  assert.equal(posterLines(report({ endedAtEstimated: true })).duration, '约 2 小时 14 分');
  assert.equal(posterLines(report({ closed: false, stale: true })).duration, '本场已中断');
  assert.equal(posterLines(report({ implicit: true, endedAtEstimated: true })).duration, '≥ 2 小时 14 分');
});

test('战报海报：不足一分钟 / 整点 / 空场次都能读', () => {
  assert.equal(posterLines(report({ durationSec: 20 })).duration, '不到 1 分钟');
  assert.equal(posterLines(report({ durationSec: 3600 })).duration, '1 小时');
  const empty = posterLines(report({ giftTop: [], giftBattery: 0, guardBattery: 0, scBattery: 0, totalBattery: 0 }));
  assert.equal(empty.top, '');
  assert.equal(empty.total, '¥0');
});

test('战报海报：文件名用 ASCII，起点无效也不崩', () => {
  assert.equal(posterFileName(report()), 'report-20261105-2000.png');
  assert.equal(posterFileName({ startedAt: 0 }), 'report-unknown.png');
  assert.equal(posterFileName({}), 'report-unknown.png');
});

test('战报海报：1080×1350 画布上确实写进了标题、日期、总收入与脚注', () => {
  const { ctx, texts, rects } = fakeCtx();
  drawPoster(ctx, report());
  assert.deepEqual(rects[0], [0, 0, 1080, 1350]);
  const all = texts.map((t) => t.text);
  assert.ok(all.includes('渔情LiveBot · 直播战报'));
  assert.ok(all.includes('2026.11.05'));
  assert.ok(all.includes('¥442'));
  assert.ok(all.includes('数据来自直播间日志 · 金额单位：元'));
  assert.ok(all.some((t) => t.includes('热门礼物')));
  assert.ok(all.includes('弹幕'));
});

test('战报海报：下载走 canvas.toBlob + saveBlob，成功与失败都给出明确结果', async () => {
  const { ctx } = fakeCtx();
  const canvas = {
    getContext: () => ctx,
    toBlob(cb) {
      cb(new Blob(['x'], { type: 'image/png' }));
    },
  };
  const saved = [];
  const out = await downloadPoster(report(), {
    createCanvas: () => canvas,
    save: (blob, name) => {
      saved.push([blob.size, name]);
      return true;
    },
  });
  assert.equal(out.filename, 'report-20261105-2000.png');
  assert.equal(out.saved, true);
  assert.deepEqual(saved, [[1, 'report-20261105-2000.png']]);

  const warned = [];
  const out2 = await downloadPoster(report(), {
    createCanvas: () => canvas,
    save: () => false,
    toast: (text, level) => warned.push([text, level]),
  });
  assert.equal(out2.saved, false);
  assert.equal(warned.length, 1);
  assert.equal(warned[0][1], 'warn');
});

test('战报海报：没有 canvas 的环境明确报错，而不是静默失败', async () => {
  await assert.rejects(
    () => downloadPoster(report(), { createCanvas: () => ({ getContext: () => null }) }),
    /不支持 canvas/,
  );
});

test('战报海报：战报卡片上确实有入口，且和页面数字同源（静态护栏）', () => {
  const src = read('web/views/reports.js');
  assert.match(src, /from '\.\/report-poster\.js'/);
  assert.match(src, /class: 'btn small poster-open'/);
  assert.match(src, /downloadPoster\(r, \{ save: saveBlob, toast \}\)/);
  assert.ok(src.includes('exportPoster(r)'));
});
