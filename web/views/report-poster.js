/**
 * 下播战报海报。
 *
 * 为什么在浏览器里画而不是服务端生成图片：
 * 服务端没有 canvas，引一个原生依赖（或 headless 浏览器）只为一张图，
 * 会把"唯一外部依赖是 ws"这条线破掉；而战报数据本来就已经在页面上了，
 * 浏览器画一张 1080×1350 的图是最短路径。
 *
 * 这里只做"把服务端算好的数字排版"，**不重新统计**——海报和页面必须同源，
 * 否则发出去的数字和页面对不上，比没有海报更糟。
 */

const W = 1080;
const H = 1350;
const PAD = 84;

function pad2(v) {
  return String(v).padStart(2, '0');
}

function yuanText(batteryValue) {
  const v = (Number(batteryValue) || 0) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** 秒数 → 「2 小时 14 分」/「14 分」/「不到 1 分钟」 */
function durText(sec) {
  const totalMin = Math.max(0, Math.round((Number(sec) || 0) / 60));
  if (totalMin < 1) return '不到 1 分钟';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (!h) return `${m} 分钟`;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/**
 * 把一场战报整理成海报上的文字。纯函数，方便直接断言。
 *
 * @param {object} report `summarizeSession()` 的结果
 */
export function posterLines(report = {}) {
  const start = new Date(Number(report.startedAt) || 0);
  const valid = Number.isFinite(start.getTime()) && start.getTime() > 0;
  const date = valid ? `${start.getFullYear()}.${pad2(start.getMonth() + 1)}.${pad2(start.getDate())}` : '';
  const time = valid ? `${pad2(start.getHours())}:${pad2(start.getMinutes())}` : '';
  const prefix = report.implicit ? '≥ ' : report.endedAtEstimated ? '约 ' : '';

  const rows = [
    ['礼物', `${Number(report.giftCount) || 0} 件`, `¥${yuanText(report.giftBattery)}`],
    ['舰长', `${Number(report.guardCount) || 0} 位`, `¥${yuanText(report.guardBattery)}`],
    ['醒目留言', `${Number(report.scCount) || 0} 条`, `¥${yuanText(report.scBattery)}`],
  ];

  const tops = (Array.isArray(report.giftTop) ? report.giftTop : [])
    .filter((g) => g && String(g.name ?? '').trim())
    .slice(0, 3)
    .map((g) => `${g.name} × ${Number(g.count) || 0}`);

  return {
    kicker: '渔情B站直播助手机器人 · 直播战报',
    date,
    time,
    duration: report.closed === false && report.stale ? '本场已中断' : `${prefix}${durText(report.durationSec)}`,
    stats: [
      ['弹幕', String(Number(report.danmaku) || 0)],
      ['观众', String(Number(report.uniqueViewers) || 0)],
      ['进场', String(Number(report.enterCount) || 0)],
      ['涨粉', String(Number(report.followCount) || 0)],
    ],
    rows,
    total: `¥${yuanText(report.totalBattery)}`,
    top: tops.length ? `热门礼物  ${tops.join('   ·   ')}` : '',
    footnote: '数据来自直播间日志 · 金额单位：元',
  };
}

function text(ctx, str, x, y, { size = 32, weight = 400, color = '#e2e8f0', align = 'left' } = {}) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(str), x, y);
}

function line(ctx, x1, y1, x2, y2, color = '#243247', width = 2) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/**
 * 画一张 1080×1350 的海报。
 *
 * 只用最基础的 2D API（fillRect / fillText / stroke），不依赖
 * roundRect、filter 这类新接口——它们在不同浏览器里支持度不一，
 * 而海报糊一半比没有更难看。
 */
export function drawPoster(ctx, report, { width = W, height = H } = {}) {
  const L = posterLines(report);

  const bg = ctx.createLinearGradient?.(0, 0, width, height);
  if (bg) {
    bg.addColorStop(0, '#111d33');
    bg.addColorStop(1, '#090f1c');
    ctx.fillStyle = bg;
  } else {
    ctx.fillStyle = '#0c1424';
  }
  ctx.fillRect(0, 0, width, height);

  // 顶部强调条
  ctx.fillStyle = '#38bdf8';
  ctx.fillRect(PAD, 118, 96, 8);

  text(ctx, L.kicker, PAD, 184, { size: 30, color: '#7dd3fc', weight: 600 });
  text(ctx, L.date, PAD, 300, { size: 92, weight: 700, color: '#f8fafc' });
  if (L.time) text(ctx, `开播 ${L.time}`, PAD + 4, 352, { size: 32, color: '#94a3b8' });

  text(ctx, L.duration, PAD, 470, { size: 56, weight: 700, color: '#f8fafc' });
  text(ctx, '本场时长', width - PAD, 470, { size: 28, color: '#64748b', align: 'right' });

  line(ctx, PAD, 520, width - PAD, 520);

  // 四项现场数据，2×2
  const cellW = (width - PAD * 2) / 2;
  L.stats.forEach(([label, value], i) => {
    const x = PAD + (i % 2) * cellW;
    const y = 596 + Math.floor(i / 2) * 112;
    text(ctx, label, x, y, { size: 28, color: '#64748b' });
    text(ctx, value, x, y + 58, { size: 54, weight: 700, color: '#e2e8f0' });
  });

  line(ctx, PAD, 848, width - PAD, 848);

  // 收入明细
  L.rows.forEach(([label, count, money], i) => {
    const y = 924 + i * 62;
    text(ctx, label, PAD, y, { size: 32, color: '#94a3b8' });
    text(ctx, count, PAD + 260, y, { size: 32, color: '#cbd5e1' });
    text(ctx, money, width - PAD, y, { size: 34, weight: 600, color: '#e2e8f0', align: 'right' });
  });

  text(ctx, '本场总收入', PAD, 1140, { size: 30, color: '#64748b' });
  text(ctx, L.total, PAD, 1218, { size: 84, weight: 700, color: '#38bdf8' });

  if (L.top) text(ctx, L.top, PAD, 1280, { size: 26, color: '#94a3b8' });
  text(ctx, L.footnote, width - PAD, height - 42, { size: 22, color: '#475569', align: 'right' });
}

/** 海报文件名：用 ASCII，避免不同系统/上传端的编码问题。 */
export function posterFileName(report = {}) {
  const d = new Date(Number(report.startedAt) || 0);
  const valid = Number.isFinite(d.getTime()) && d.getTime() > 0;
  const stamp = valid
    ? `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`
    : 'unknown';
  return `report-${stamp}.png`;
}

/**
 * 在浏览器里生成并下载海报。
 *
 * @param {object} report
 * @param {{createCanvas?:Function, save?:Function, toast?:Function}} [opts]
 */
export async function downloadPoster(report, { createCanvas, save, toast = () => {} } = {}) {
  const make = createCanvas ?? (() => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  });
  const canvas = make(W, H);
  const ctx = canvas.getContext?.('2d');
  if (!ctx) throw new Error('浏览器不支持 canvas，生成不了海报');

  drawPoster(ctx, report, { width: W, height: H });

  const blob = await new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('当前浏览器不支持导出图片'));
      return;
    }
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('生成图片失败'))), 'image/png');
  });

  const filename = posterFileName(report);
  const saved = save ? save(blob, filename) : false;
  if (!saved) toast(`已生成 ${filename}，但当前环境不能自动下载`, 'warn');
  return { blob, filename, saved };
}
