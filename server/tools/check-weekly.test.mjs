import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEEKLY_WINDOW_DAYS,
  weeklyNextAt,
  weeklySummary,
  weeklyText,
} from '../../server/core/weekly.mjs';

test('周报：一周总数只做加法，口径跟场次战报一致', () => {
  const s = weeklySummary([
    { durationSec: 3600, danmaku: 100, enterCount: 10, followCount: 2, giftCount: 3, giftBattery: 500, guardCount: 1, guardBattery: 1980, scCount: 1, scBattery: 30, totalBattery: 2510 },
    { durationSec: 1800, danmaku: 50, enterCount: 4, followCount: 1, giftCount: 1, giftBattery: 100, guardCount: 0, guardBattery: 0, scCount: 2, scBattery: 60, totalBattery: 160 },
  ]);
  assert.equal(s.sessions, 2);
  assert.equal(s.durationSec, 5400);
  assert.equal(s.danmaku, 150);
  assert.equal(s.enterCount, 14);
  assert.equal(s.followCount, 3);
  assert.equal(s.giftBattery, 600);
  assert.equal(s.guardBattery, 1980);
  assert.equal(s.scBattery, 90);
  assert.equal(s.totalBattery, 2670);
});

test('周报：一条消息压成五行，金额按元显示', () => {
  const text = weeklyText({
    roomId: '39025',
    title: '测试间',
    summary: weeklySummary([
      { durationSec: 7200, danmaku: 12, enterCount: 3, followCount: 1, giftCount: 1, giftBattery: 2380, guardCount: 1, guardBattery: 1980, scCount: 1, scBattery: 60, totalBattery: 4420 },
    ]),
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '【周报】房间 39025 · 测试间');
  assert.match(lines[1], /1 场 · 直播 2 小时/);
  assert.match(text, /礼物 ¥238/);
  assert.match(text, /舰长 ¥198/);
  assert.match(text, /醒目留言 ¥6/);
  assert.match(text, /总收入 ¥442/);
});

test('周报：没有开播记录时也发一条，而不是空消息', () => {
  const text = weeklyText({ roomId: '100', summary: weeklySummary([]) });
  assert.match(text, /【周报】房间 100/);
  assert.match(text, new RegExp(`最近 ${WEEKLY_WINDOW_DAYS} 天没有开播记录`));
});

test('周报：下一次推送是本地周一 10:00，边界不重复发', () => {
  // 2026-11-01 是周日，11-02 是周一
  const sundayNoon = new Date(2026, 10, 1, 12, 0, 0).getTime();
  const mondayMorning = new Date(2026, 10, 2, 9, 0, 0).getTime();
  const mondayTen = new Date(2026, 10, 2, 10, 0, 0).getTime();
  const mondayEleven = new Date(2026, 10, 2, 11, 0, 0).getTime();

  assert.equal(weeklyNextAt(sundayNoon), mondayTen);
  assert.equal(weeklyNextAt(mondayMorning), mondayTen);
  assert.equal(
    weeklyNextAt(mondayTen),
    new Date(2026, 10, 9, 10, 0, 0).getTime(),
    '正好 10:00 时算下一周，避免同一分钟发两次',
  );
  assert.equal(weeklyNextAt(mondayEleven), new Date(2026, 10, 9, 10, 0, 0).getTime());
});

test('周报：跨月也落在下一个周一', () => {
  // 2026-11-30 是周一，12-01 是周二
  const tuesday = new Date(2026, 11, 1, 8, 0, 0).getTime();
  assert.equal(weeklyNextAt(tuesday), new Date(2026, 11, 7, 10, 0, 0).getTime());
});
