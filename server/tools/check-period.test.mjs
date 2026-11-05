/**
 * 月报 / 季报自检：边界、加法、环比与文案。
 *
 * 日期用本地时间构造，机器时区变了也只影响「哪一天」，不影响
 * 「月初/季初」这些边界本身。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { periodDelta, periodRange, periodSummary, periodText } from '../core/period.mjs';

const NOV_15 = new Date(2026, 10, 15, 12, 0, 0).getTime();

test('区间：自然月从 1 号 0 点开始，上期是上个月', () => {
  const r = periodRange('month', NOV_15);
  assert.equal(r.label, '2026 年 11 月');
  assert.equal(r.from, new Date(2026, 10, 1).getTime());
  assert.equal(r.to, new Date(2026, 11, 1).getTime());
  assert.equal(r.prevFrom, new Date(2026, 9, 1).getTime());
  assert.equal(r.prevTo, r.from);
});

test('区间：自然季从季初开始，跨年也对', () => {
  const q4 = periodRange('quarter', NOV_15);
  assert.equal(q4.label, '2026 年第 4 季度');
  assert.equal(q4.from, new Date(2026, 9, 1).getTime());
  assert.equal(q4.to, new Date(2027, 0, 1).getTime());
  assert.equal(q4.prevFrom, new Date(2026, 6, 1).getTime());

  const q1 = periodRange('quarter', new Date(2027, 1, 10).getTime());
  assert.equal(q1.label, '2027 年第 1 季度');
  assert.equal(q1.prevFrom, new Date(2026, 9, 1).getTime());
});

test('加法：场次与各计数都按字段相加，缺字段按 0', () => {
  const s = periodSummary([
    { durationSec: 3600, danmaku: 100, giftCount: 2, giftBattery: 50, totalBattery: 50 },
    { durationSec: 1800, danmaku: 30, guardCount: 1, guardBattery: 1980, totalBattery: 1980 },
    null,
  ]);
  assert.equal(s.sessions, 2);
  assert.equal(s.durationSec, 5400);
  assert.equal(s.danmaku, 130);
  assert.equal(s.giftCount, 2);
  assert.equal(s.guardBattery, 1980);
  assert.equal(s.scCount, 0);
  assert.equal(s.totalBattery, 2030);
});

test('环比：上期为 0 时给 null，不编 +∞%', () => {
  const d = periodDelta({ totalBattery: 200, danmaku: 50, sessions: 2 }, { totalBattery: 100, danmaku: 0, sessions: 1 });
  assert.equal(d.totalBattery.diff, 100);
  assert.equal(d.totalBattery.pct, 100);
  assert.equal(d.danmaku.pct, null);
  assert.equal(d.sessions.diff, 1);
});

test('文案：有数据给场次/收入/环比，空区间直说没有', () => {
  const cur = { sessions: 2, durationSec: 5400, danmaku: 130, enterCount: 40, followCount: 5, totalBattery: 2030, giftBattery: 50, guardBattery: 1980, scBattery: 0 };
  const prev = { sessions: 1, totalBattery: 100 };
  const delta = periodDelta(cur, prev);
  const text = periodText({ kind: 'month', label: '2026 年 11 月', cur, prev, delta });
  assert.match(text, /【月报】2026 年 11 月/);
  assert.match(text, /场次 2 · 时长 1 小时 30 分 · 弹幕 130/);
  assert.match(text, /收入 ¥203（礼物 ¥5 \/ 舰长 ¥198 \/ 醒目留言 ¥0）/);
  assert.match(text, /比上期：收入 \+1930%/);

  assert.equal(periodText({ kind: 'quarter', label: '2027 年第 1 季度', cur: { sessions: 0 } }), '【季报】2027 年第 1 季度\n这段时间没有开播记录。');
});
