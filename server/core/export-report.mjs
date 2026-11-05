/**
 * 场次复盘导出：把战报变成一份能发出去、能存档的单文件 HTML。
 *
 * ## 为什么是服务端生成，而不是前端拼
 *
 * 三个理由，按重要性排：
 *
 * 1. **口径只有一份。** 页面上的数字来自 `/api/reports`，导出页必须和它一模一样。
 *    前端再拼一遍就是第二个真相 —— 二代在金额上分叉过两次（差 1000 倍），
 *    那种 bug 的典型形态就是"两个地方各算一遍，平时看起来一样，某天不一样了"。
 * 2. **不依赖浏览器。** 自检可以在 node 里直接断言生成的字符串，
 *    不需要假 DOM、不需要无头浏览器（这台机器上的无头浏览器起不来）。
 * 3. **自包含。** 零外链、零脚本、图片是内联 SVG —— 断网也能打开，
 *    发到群里不会被微信的图片代理吃掉，打印出来就是一份纸质复盘。
 *
 * ## 安全
 *
 * 导出文件里会出现**别人说的话**：观众昵称、礼物名。它们全是不可信输入。
 * 所以每一处插值都走 `esc()`，并且文件里没有任何 `<script>`、没有外链样式，
 * 再叠一层 CSP meta —— 即使某个名字里塞了 `<img onerror=...>`，它也只是一段文字。
 */

import { duration, n, yuan } from '../../web/core/format.js'

/**
 * HTML 转义。
 *
 * 顺序无所谓（一次性替换，不做二次解析），但五个字符一个都不能漏：
 * 少转 `'` 会让"单引号包属性的写法"可被注入，而这种写法在别处随时可能出现。
 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;'
    if (c === '<') return '&lt;'
    if (c === '>') return '&gt;'
    if (c === '"') return '&quot;'
    return '&#39;'
  })
}

const pad2 = (v) => String(v).padStart(2, '0')

/** 时间戳 → "11-02 20:00"（本地时间，和页面上的战报一致） */
function stamp(ts) {
  const d = new Date(Number(ts) || 0)
  if (!Number.isFinite(d.getTime())) return '—'
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 完整日期 → "2026-11-02 20:00" */
function stampFull(ts) {
  const d = new Date(Number(ts) || 0)
  if (!Number.isFinite(d.getTime())) return '—'
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 秒 → "1 时 23 分"（format.js 的口径，传的是毫秒） */
function dur(sec) {
  return duration((Number(sec) || 0) * 1000)
}

/** 电池 → "¥12.3" */
function money(batteryValue) {
  return `¥${yuan(batteryValue)}`
}

/**
 * 导出文件名。
 *
 * 用**本地时间**：文件名是给人看的，日志分片和日志行也都是本地时间。
 * （诊断包曾经用 UTC，于是 12:55 出的包叫 04-55-40，用户对不上时间 —— 同一条教训。）
 */
export function reportFileName({ roomId, at = new Date() } = {}) {
  const d = at instanceof Date ? at : new Date(at)
  const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const time = `${pad2(d.getHours())}-${pad2(d.getMinutes())}`
  const room = String(roomId ?? '').replace(/[^\d]/g, '') || 'room'
  return `yuyue3-report-${room}-${day}_${time}.html`
}

/* ══════════════════════ 图表 ══════════════════════ */

/**
 * 一张竖向柱状图（内联 SVG 字符串）。
 *
 * 几何取自页面上的趋势图，但这里不做交互 —— 导出页是静态的，
 * 鼠标悬停只有原生 `<title>` 提示（聊胜于无，且不需要脚本）。
 *
 * @param {Array<{day:string, value:number}>} points
 * @param {{key?:string, title:string, unit:string, color:string, fmt?:(v:number)=>string}} opts
 */
function barChart(points, { key = '', title, unit, color, fmt = (v) => n(v) }) {
  const W = 640
  const H = 200
  const padL = 52
  const padR = 14
  const padT = 14
  const padB = 34
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const rows = (points ?? []).filter((p) => Number.isFinite(p.value))
  if (rows.length === 0) {
    return `<figure class="chart" data-k="${esc(key)}"><figcaption>${esc(title)}</figcaption><p class="empty">没有数据</p></figure>`
  }

  const max = Math.max(1, ...rows.map((p) => p.value))
  /** 顶线取一个整数，刻度看起来才是"整齐的数" */
  const top = niceCeil(max)

  const slot = plotW / rows.length
  // 缝跟着槽宽走：一年 365 天时槽宽不到 2px，留缝会把柱子吃没
  const gap = slot >= 26 ? 6 : slot >= 12 ? 3 : slot >= 5 ? 1 : 0
  const barW = Math.min(48, Math.max(0.5, slot - gap), slot)

  // 只给有值的天画柱子：0 高的柱子看不出来，反而让"没播"和"播了没人说话"长得一样
  const bars = rows
    .map((p, i) => {
      if (!(p.value > 0)) return ''
      const h = (p.value / top) * plotH
      const x = padL + i * slot + (slot - barW) / 2
      const y = padT + plotH - h
      const tip = `${p.day}　${fmt(p.value)}${unit}`
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${color}" rx="1.5"><title>${esc(tip)}</title></rect>`
    })
    .join('')

  // 横向标签：太密就隔几个显示一个，否则会糊成一条黑线
  const labelEvery = Math.max(1, Math.ceil(rows.length / 12))
  const labels = rows
    .map((p, i) => {
      if (i % labelEvery !== 0) return ''
      const x = padL + i * slot + slot / 2
      return `<text x="${x.toFixed(2)}" y="${H - 12}" text-anchor="middle" class="ax">${esc(String(p.day ?? '').slice(5))}</text>`
    })
    .join('')

  // 三条参考线：底、中、顶。数值标签贴在左边
  const grid = [0, 0.5, 1]
    .map((f) => {
      const y = padT + plotH - f * plotH
      const label = fmt(top * f)
      return (
        `<line x1="${padL}" y1="${y.toFixed(2)}" x2="${W - padR}" y2="${y.toFixed(2)}" class="grid"/>` +
        `<text x="${padL - 8}" y="${(y + 4).toFixed(2)}" text-anchor="end" class="ax">${esc(label)}</text>`
      )
    })
    .join('')

  return [
    `<figure class="chart" data-k="${esc(key)}">`,
    `<figcaption>${esc(title)}<span class="unit">（${esc(unit || '数值')}）</span></figcaption>`,
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`,
    grid,
    bars,
    labels,
    '</svg>',
    '</figure>',
  ].join('')
}

/** 把最大值抬到一个"好看"的刻度：1 / 2 / 5 × 10^n */
function niceCeil(v) {
  const x = Number(v) || 0
  if (x <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(x))
  const norm = x / mag
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * mag
}

/* ══════════════════════ 主体 ══════════════════════ */

/**
 * 生成整份复盘页。
 *
 * @param {object} input
 * @param {object[]} input.reports    `buildReports()` 的结果（新的在前）
 * @param {object}   input.summary    `summarizeReports()` 的结果
 * @param {object[]} input.series     `buildDailySeries()` 的结果（按天升序）
 * @param {object[]} [input.warnings] `auditReports()` 的结果
 * @param {{roomId?:string, title?:string, rangeLabel?:string, at?:Date, version?:string}} [input.meta]
 * @returns {string} 完整的 HTML 文档
 */
export function buildReportHtml({ reports = [], summary = {}, series = [], warnings = [], meta = {} }) {
  const roomId = String(meta.roomId ?? '')
  const title = String(meta.title ?? '')
  const rangeLabel = String(meta.rangeLabel ?? '全部')
  const at = meta.at instanceof Date ? meta.at : new Date()
  const version = String(meta.version ?? '')
  const s = summary ?? {}

  const pageTitle = `直播复盘 · 房间 ${roomId || '未知'}`

  const cards = [
    { k: '场次', v: n(s.sessions ?? reports.length), sub: s.implicitSessions ? `其中 ${n(s.implicitSessions)} 场起点未知` : '' },
    { k: '总时长', v: dur(s.durationSec), sub: s.sessions ? `平均 ${dur(Math.round((s.durationSec || 0) / s.sessions))}` : '' },
    { k: '弹幕', v: n(s.danmaku), sub: '' },
    { k: '进场人次', v: n(s.enterCount), sub: `涨粉 ${n(s.followCount)}` },
    { k: '礼物', v: money(s.giftBattery), sub: `${n(s.giftCount)} 个` },
    { k: '醒目留言', v: money(s.scBattery), sub: `${n(s.scCount)} 条` },
    { k: '大航海', v: money(s.guardBattery), sub: `${n(s.guardCount)} 个` },
    { k: '总收入', v: money(s.totalBattery), sub: '礼物 + SC + 舰长' },
  ]
    .map(
      (c) => `<div class="card"><div class="k">${esc(c.k)}</div><div class="v">${esc(c.v)}</div>${
        c.sub ? `<div class="s">${esc(c.sub)}</div>` : ''
      }</div>`,
    )
    .join('')

  const charts =
    series.length === 0
      ? '<p class="empty">这段时间没有直播记录。</p>'
      : [
          barChart(
            series.map((d) => ({ day: d.day, value: d.danmaku })),
            { key: 'danmaku', title: '每天弹幕', unit: '条', color: '#3b6fd4' },
          ),
          barChart(
            // 用 totalBattery（礼物 + SC + 舰长）：`buildDailySeries` 只给合计，
            // 没有 scBattery 这个字段 —— 写成 `giftBattery + scBattery` 会得到 NaN，
            // 整张图被当成"没有数据"跳过，而且不会报错。
            series.map((d) => ({ day: d.day, value: d.totalBattery })),
            { key: 'income', title: '每天收入', unit: '元', color: '#b8860b', fmt: (v) => yuan(v) },
          ),
        ].join('')

  const rows =
    reports.length === 0
      ? `<tr><td colspan="9" class="empty">没有场次记录</td></tr>`
      : reports
          .map((r) => {
            const tags = []
            if (!r.closed) tags.push(r.stale ? '已中断' : '进行中')
            if (r.implicit) tags.push('起点未知')
            if (r.endedAtEstimated) tags.push('结束时间约')
            const top = (r.giftTop ?? []).map((g) => `${g.name}×${g.count}`).join('、')
            return [
              '<tr>',
              `<td class="nowrap">${esc(stampFull(r.startedAt))}</td>`,
              `<td class="nowrap">${esc(dur(r.durationSec))}</td>`,
              `<td class="num">${esc(n(r.danmaku))}</td>`,
              `<td class="num">${esc(n(r.enterCount))}</td>`,
              `<td class="num">${esc(n(r.giftCount))}</td>`,
              `<td class="num">${esc(money(r.totalBattery))}</td>`,
              `<td class="num">${esc(n(r.peakPopularity))}</td>`,
              `<td>${tags.length ? `<span class="tag">${esc(tags.join(' · '))}</span>` : ''}</td>`,
              `<td class="dim">${esc(top)}</td>`,
              '</tr>',
            ].join('')
          })
          .join('')

  const warnBlock = warnings.length
    ? `<section class="warns"><h2>需要说明的数字</h2><ul>${warnings
        .map((w) => `<li>${esc(w.text)}</li>`)
        .join('')}</ul></section>`
    : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(pageTitle)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 20px 48px;
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: #1c1c1e; background: #f6f7f9;
  }
  main { max-width: 900px; margin: 0 auto; background: #fff; border: 1px solid #e3e5e9;
    border-radius: 10px; padding: 26px 28px 34px; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: .5px; }
  h2 { font-size: 15px; margin: 30px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #eceef1; }
  .meta { margin: 0; color: #6b7280; font-size: 12.5px; }
  .meta b { color: #374151; font-weight: 600; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-top: 20px; }
  .card { border: 1px solid #e8eaee; border-radius: 8px; padding: 10px 12px; background: #fcfcfd; }
  .card .k { font-size: 12px; color: #6b7280; }
  .card .v { font-size: 20px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .card .s { font-size: 11.5px; color: #8a9099; margin-top: 2px; min-height: 1em; }
  .charts { display: grid; grid-template-columns: 1fr; gap: 16px; }
  @media (min-width: 760px) { .charts { grid-template-columns: 1fr 1fr; } }
  .chart { margin: 0; }
  figcaption { font-size: 12.5px; color: #4b5563; margin-bottom: 4px; }
  figcaption .unit { color: #9aa0a6; }
  .chart svg { width: 100%; height: auto; display: block; }
  .chart .grid { stroke: #e5e7eb; stroke-width: 1; }
  .chart .ax { fill: #9aa0a6; font-size: 10px; }
  .note { color: #8a9099; font-size: 12px; margin: 8px 0 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 7px 8px; border-bottom: 1px solid #eef0f3; text-align: left; vertical-align: top; }
  th { font-weight: 600; color: #4b5563; background: #fafbfc; font-size: 12px; }
  tbody tr:nth-child(even) { background: #fcfdfe; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .nowrap { white-space: nowrap; }
  .dim { color: #9aa0a6; }
  .tag { display: inline-block; padding: 0 6px; border-radius: 999px; background: #fff4e5;
    color: #b45309; font-size: 11px; white-space: nowrap; }
  .empty { color: #9aa0a6; padding: 12px 0; }
  .warns { margin-top: 8px; }
  .warns ul { margin: 0; padding-left: 18px; color: #92400e; }
  .warns li { margin: 4px 0; }
  footer { margin-top: 34px; padding-top: 12px; border-top: 1px solid #eceef1;
    color: #9aa0a6; font-size: 11.5px; }
  @media print {
    body { background: #fff; padding: 0; }
    main { border: 0; border-radius: 0; padding: 0; max-width: none; }
    h2 { break-after: avoid; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>${esc(pageTitle)}</h1>
    <p class="meta">
      ${title ? `${esc(title)} · ` : ''}范围：<b>${esc(rangeLabel)}</b> ·
      导出时间：<b>${esc(stampFull(at.getTime()))}</b>
      ${version ? ` · 版本 ${esc(version)}` : ''}
    </p>
  </header>

  <section class="cards">${cards}</section>

  <section>
    <h2>每日趋势</h2>
    <div class="charts">${charts}</div>
    <p class="note">跨零点的那一场算在开场那天；没开播的日子不画柱子。</p>
  </section>

  <section>
    <h2>场次明细</h2>
    <table>
      <thead>
        <tr>
          <th>开始</th><th>时长</th><th class="num">弹幕</th><th class="num">进场</th>
          <th class="num">礼物</th><th class="num">收入</th><th class="num">峰值人气</th>
          <th>备注</th><th>热门礼物</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>

  ${warnBlock}

  <footer>
    本页由渔月崽三代从事件日志重放生成，不含 Cookie、口令或任何登录凭据。
    数字与页面上的「场后战报」同源同口径。
  </footer>
</main>
</body>
</html>
`
}

export default buildReportHtml
