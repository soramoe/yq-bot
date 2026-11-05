/**
 * 战报与沙盒回放。
 *
 * 两块内容放在同一个面板里，因为它们回答的是同一个问题：
 * **「这场到底怎么样了」和「换个配置会怎么样」**。
 * 分成两个入口的话，用户要记住"战报在哪、回放在哪"，而它们天然是一起看的。
 *
 * 数据全部来自 `/api/reports`（日志重放），页面不做任何统计计算 ——
 * 前端一旦自己算，就会和服务端算出两个数，然后没人知道该信哪个。
 */

import { el, replaceChildren, svgEl } from '../core/dom.js';
import { api } from '../core/api.js';
import { saveBlob } from '../core/download.js';
import { downloadPoster } from './report-poster.js';
import { battery, duration, guardName, hhmmss, n, yuan } from '../core/format.js';

/** 时间戳 → "11-02 20:00" */
function stampDate(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 电池 → "¥12.3"，和统计卡上的口径保持一致 */
function money(batteryValue) {
  return `¥${yuan(batteryValue)}`;
}

/**
 * 趋势图能切着看的几个指标。
 *
 * 一次只画一条，**不做双轴**：弹幕几千条、收入几十块，画在一张图上
 * 必然要两根纵轴，而两根轴的比例怎么取都会误导人（"收入是不是也涨了"
 * 这种问题，答案取决于你把它缩放到多高）。想看收入就切过去看。
 */
const METRICS = [
  { key: 'danmaku', label: '弹幕', unit: '条' },
  { key: 'enterCount', label: '进场', unit: '人' },
  { key: 'followCount', label: '涨粉', unit: '人' },
  { key: 'totalBattery', label: '收入', unit: '' },
];

/** 一天的标签 'YYYY-MM-DD' → 'MM-DD' */
function shortDay(day) {
  return String(day ?? '').slice(5);
}

export function createReports({ dlg, toast }) {
  let days = 0;
  let busy = false;
  /** 当前图表看哪个指标。切换不重新请求：序列只有一份，换的是画法 */
  let metricKey = 'danmaku';
  /** 最近一次拿到的每日序列（服务端按天聚合好的，前端只画不算） */
  let series = [];

  /* 时间轴的状态 */
  let tlFrom = 0;
  let tlTo = 0;
  let tlFrames = [];
  let tlMarks = [];
  let tlCursorX = null;
  /** 请求序号：拖得快时可能有多个响应在飞，只认最后一个 */
  let tlToken = 0;
  let tlRange = null;
  let tlMoment = null;
  let tlStats = null;
  let tlMarksBox = null;
  let tlSub = null;

  const closeBtn = el('button', { class: 'btn', text: '关闭', attrs: { type: 'button' } });

  /**
   * 导出复盘页。
   *
   * 生成在服务端（`core/export-report.mjs`）：口径必须和这一页完全一致，
   * 而"前端再算一遍"就是第二个真相。这里只负责把 blob 交出去。
   */
  const exportBtn = el('button', {
    class: 'btn small',
    text: '导出复盘页',
    attrs: { type: 'button', title: '生成一份单文件 HTML：能存档、能发群里、能直接打印' },
  });

  const chipRow = el('div', { class: 'rpt-chips' });
  const warnBox = el('div', { class: 'rpt-warns' });
  const summaryBox = el('div', { class: 'rpt-summary' });
  const chartBox = el('div', { class: 'rpt-chart' });
  const listBox = el('div', { class: 'rpt-list' });
  const timelineBox = el('div', { class: 'tl' });

  /* ── 沙盒区 ── */
  const daySelect = el('select', { class: 'rpt-select' });
  const maxInput = el('input', {
    class: 'rpt-num',
    attrs: { type: 'number', min: '1', max: '5000', value: '300' },
  });
  const runBtn = el('button', { class: 'btn primary', text: '开始回放', attrs: { type: 'button' } });
  const sandboxOut = el('div', { class: 'rpt-sandbox-out' });

  const CHIPS = [
    { d: 0, label: '全部' },
    { d: 7, label: '最近 7 天' },
    { d: 30, label: '最近 30 天' },
  ];

  function renderChips() {
    replaceChildren(
      chipRow,
      CHIPS.map((c) =>
        el('button', {
          // 选中态用 aria-pressed 而不是自定义 class：样式复用事件流那排 chip，
          // 同时屏幕阅读器也知道这个是"按下的筛选"
          class: 'chip',
          text: c.label,
          attrs: { type: 'button', 'aria-pressed': String(c.d === days) },
          on: {
            click: () => {
              if (days === c.d) return;
              days = c.d;
              renderChips();
              load();
            },
          },
        }),
      ),
    );
  }

  /* ── 汇总条 ── */
  function renderSummary(s) {
    if (!s) {
      replaceChildren(summaryBox, [el('div', { class: 'empty-hint', text: '还没有数据' })]);
      return;
    }
    const cell = (k, v, accent) =>
      el('div', {
        class: 'rpt-cell',
        children: [
          el('div', { class: 'k', text: k }),
          el('div', { class: `v${accent ? ' accent' : ''}`, text: v }),
        ],
      });

    replaceChildren(summaryBox, [
      cell('场次', `${n(s.sessions)} 场`),
      cell('总时长', duration(s.durationSec * 1000)),
      cell('弹幕', n(s.danmaku)),
      cell('进场', n(s.enterCount)),
      cell('涨粉', n(s.followCount)),
      cell('礼物', `${n(s.giftCount)} 件`),
      cell('醒目', `${n(s.scCount)} 条`),
      cell('收入', money(s.totalBattery), true),
    ]);
  }

  /* ── 单场卡片 ── */
  function renderSession(r) {
    /**
     * 三种状态，不能只分"进行中/已结束"两种：
     *
     *   closed            收到过 LIVE_END，时间精确
     *   stale             还开着，但很久没有事件 —— 连接断了/进程被杀，
     *                     日志里留下一个永远开着的场次。显示"进行中"是撒谎
     *   live              真的还在播
     *
     * 之前只有前两种的判断，于是三个月前那场会显示"进行中 · 2160 小时"。
     */
    const stale = Boolean(r.stale);
    const live = !r.closed && !stale;

    const badgeText = live ? '进行中' : stale ? '已中断' : '已结束';
    const badgeClass = live ? 'rpt-badge live' : stale ? 'rpt-badge warn' : 'rpt-badge';

    // 时长前面的符号就是"这个数有多可信"：
    //   ≥  起点未知（进程在直播中途启动），实际比这个长
    //   约 结束时间由"最后一条事件"推断，没收到 LIVE_END
    const prefix = r.implicit ? '≥ ' : r.endedAtEstimated ? '约 ' : '';
    const durText = `${prefix}${duration(r.durationSec * 1000)}`;

    const endStamp = r.endedAt
      ? stampDate(r.endedAt)
      : stale
        ? `${stampDate(r.lastEventTs)} 后无数据`
        : '现在';

    /**
     * 只有真的播过一段才给时间轴：零长度的一场拖出来只有一格，
     * 点进去什么也看不到，比没有按钮更让人困惑。
     */
    const canOpen = (Number(r.endedAt) || Number(r.lastEventTs) || 0) > Number(r.startedAt);

    return el('div', {
      class: `rpt-session${live ? ' is-live' : ''}${stale ? ' is-stale' : ''}`,
      children: [
        el('div', {
          class: 'rpt-shead',
          children: [
            el('span', { class: badgeClass, text: badgeText }),
            r.implicit ? el('span', { class: 'rpt-badge warn', text: '起点未知' }) : null,
            el('span', { class: 'rpt-time', text: `${stampDate(r.startedAt)} → ${endStamp}` }),
            el('span', { class: 'spacer' }),
            el('button', {
              class: 'btn small poster-open',
              text: '海报',
              attrs: { type: 'button' },
              on: { click: () => exportPoster(r) },
            }),
            canOpen
              ? el('button', {
                  class: 'btn small tl-open',
                  text: '时间轴',
                  attrs: { type: 'button' },
                  on: { click: () => openTimeline(r) },
                })
              : null,
            el('span', { class: 'rpt-dur', text: durText }),
          ],
        }),
        el('div', {
          class: 'rpt-metrics',
          children: [
            kv('弹幕', n(r.danmaku)),
            kv('进场', n(r.enterCount)),
            kv('独立观众', n(r.uniqueViewers)),
            kv('涨粉', n(r.followCount)),
            kv('峰值人气', n(r.peakPopularity)),
            kv('机器人发言', n(r.sentCount)),
          ],
        }),
        el('div', {
          class: 'rpt-metrics',
          children: [
            kv('礼物', `${n(r.giftCount)} 件 · ${money(r.giftBattery)}`),
            kv('舰长', `${n(r.guardCount)} 位 · ${money(r.guardBattery)}`),
            kv('醒目留言', `${n(r.scCount)} 条 · ${money(r.scBattery)}`),
            kv('本场收入', money(r.totalBattery), true),
          ],
        }),
        r.giftTop && r.giftTop.length
          ? el('div', {
              class: 'rpt-top',
              text: `热门礼物：${r.giftTop.map((g) => `${g.name}×${g.count}`).join('、')}`,
            })
          : null,
      ],
    });
  }

  function kv(k, v, accent) {
    return el('div', {
      class: 'rpt-metric',
      children: [
        el('span', { class: 'k', text: k }),
        el('span', { class: `v${accent ? ' accent' : ''}`, text: v }),
      ],
    });
  }

  /* ── 每日趋势图（手写 SVG） ── */

  /**
   * 画图。
   *
   * 为什么手写 SVG 而不是引图表库：这里只有一种图（柱状），
   * 而引一个库要带进几十 KB、一套自己的样式体系和一个新依赖 ——
   * 这个项目的唯一外部依赖是 `ws`，为一张柱子图破例不值得。
   *
   * 为什么数值全部来自服务端：图上的数一旦由前端自己算，
   * 迟早和卡片、和战报合计算出三个不一样的数，然后没人知道该信哪个。
   */
  function renderChart() {
    const m = METRICS.find((x) => x.key === metricKey) ?? METRICS[0];
    const fmt = (v) => (m.key === 'totalBattery' ? money(v) : n(v));

    const chips = el('div', {
      class: 'rpt-chips',
      children: METRICS.map((x) =>
        el('button', {
          class: 'chip',
          text: x.label,
          attrs: { type: 'button', 'aria-pressed': String(x.key === metricKey) },
          on: {
            click: () => {
              if (metricKey === x.key) return;
              metricKey = x.key;
              renderChart();
            },
          },
        }),
      ),
    });

    const rows = Array.isArray(series) ? series : [];
    const total = rows.reduce((s, r) => s + (Number(r[m.key]) || 0), 0);

    const head = el('div', {
      class: 'rpt-chart-head',
      children: [
        el('span', { class: 'rpt-chart-title', text: '每日趋势' }),
        chips,
        el('span', { class: 'spacer' }),
        el('span', {
          class: 'rpt-note',
          text: rows.length ? `${rows.length} 天 · 合计 ${fmt(total)}` : '',
        }),
      ],
    });

    if (!rows.length) {
      replaceChildren(chartBox, [
        head,
        el('div', { class: 'empty-hint', text: '这段时间没有可画的数据' }),
      ]);
      return;
    }

    // 画布坐标固定 680×170，靠 CSS 缩放适配宽度：SVG 是矢量，
    // 换宽度不会糊，而按容器真实像素算坐标就得监听 resize
    const W = 680;
    const H = 170;
    const PAD_L = 6;
    const PAD_R = 6;
    const PAD_T = 16;
    const PAD_B = 24;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const baseY = PAD_T + plotH;

    const maxV = Math.max(1, ...rows.map((r) => Number(r[m.key]) || 0));
    /**
     * 柱子几何。
     *
     * 关键是 **`barW + gap <= slot`**（slot = 画布宽 / 天数）——
     * 满足它，总宽就一定画得下；不满足就会溢出，而 SVG 会把超出的部分
     * 直接裁掉：图上"合计 365 天"，最近的那些天却根本不在画面里。
     *
     * 以前是「缝最多 6px、柱宽最少 1px」，天数一多（>330 天）
     * 1px 下限就把总宽顶出画布了。下限是用来"看得见"的，
     * 但看不见一列柱子远比整段被裁掉轻 —— 所以下限给不了就让位。
     */
    const slot = plotW / rows.length;
    // 缝跟着槽宽走：30 天时槽宽 22px，给 6px 的缝柱子就细得像牙签
    const gap = slot >= 26 ? 6 : slot >= 12 ? 3 : slot >= 5 ? 1 : 0;
    // 只有两三天时不要把柱子拉成一整块色斑：限宽 56
    const barW = Math.min(56, Math.max(0.5, slot - gap), slot);
    const offsetX = PAD_L + Math.max(0, (plotW - (barW * rows.length + gap * (rows.length - 1))) / 2);
    // 日期标签最多画 7 个：全画会糊成一条黑线
    const labelStep = Math.max(1, Math.ceil(rows.length / 7));

    const bars = [];
    rows.forEach((r, i) => {
      const v = Number(r[m.key]) || 0;
      const h = v <= 0 ? 0 : Math.max(2, (v / maxV) * plotH);
      const x = offsetX + i * (barW + gap);
      if (h > 0) {
        bars.push(
          svgEl('rect', {
            class: 'rpt-bar',
            attrs: {
              x: x.toFixed(1),
              y: (baseY - h).toFixed(1),
              width: barW.toFixed(1),
              height: h.toFixed(1),
              rx: '1.5',
            },
            // 原生 tooltip：不写一行 JS，鼠标停上去就知道这是哪天、多少
            children: [svgEl('title', { text: `${r.day} · ${m.label} ${fmt(v)}` })],
          }),
        );
      }
      // 最后一个标签总画；但紧挨着它的那个步进标签就不画了 ——
      // 两个日期挤在一起会比少一个日期更难读
      const nearLast = rows.length - 1 - i < labelStep;
      if (i === rows.length - 1 || (i % labelStep === 0 && !nearLast)) {
        bars.push(
          svgEl('text', {
            class: 'rpt-axis',
            text: shortDay(r.day),
            attrs: {
              x: (x + barW / 2).toFixed(1),
              y: H - 8,
              'text-anchor': i === rows.length - 1 ? 'end' : 'middle',
            },
          }),
        );
      }
    });

    const grid = [
      svgEl('line', {
        class: 'rpt-grid',
        attrs: { x1: PAD_L, y1: baseY, x2: W - PAD_R, y2: baseY },
      }),
      svgEl('line', {
        class: 'rpt-grid is-soft',
        attrs: { x1: PAD_L, y1: PAD_T + plotH / 2, x2: W - PAD_R, y2: PAD_T + plotH / 2 },
      }),
      svgEl('text', {
        class: 'rpt-axis is-max',
        text: fmt(maxV),
        attrs: { x: PAD_L, y: PAD_T - 4 },
      }),
    ];

    const svg = svgEl('svg', {
      class: 'rpt-svg',
      attrs: {
        viewBox: `0 0 ${W} ${H}`,
        // 用 role=img + aria-label 让屏幕阅读器读到"这是什么图"，
        // 而不是念一堆 <rect>
        role: 'img',
        'aria-label': `每日${m.label}趋势，共 ${rows.length} 天，合计 ${fmt(total)}`,
      },
      children: [...grid, ...bars],
    });

    replaceChildren(chartBox, [
      head,
      svg,
      el('div', {
        class: 'rpt-note',
        text: '按场次开播那天归日：22 点播到 2 点的那场，四个小时都算在前一天',
      }),
    ]);
  }

  /* ── 时间轴回看 ── */

  /**
   * 标记的文案与配色。
   *
   * 金额换算统一走 `money()`（和页面其它地方同一套），服务端只给电池数 ——
   * 两边各拼一遍文案，迟早会出现"图上 ¥0.2、卡片上 ¥0.3"。
   */
  const MARK_TEXT = {
    GIFT: (m) => `礼物 ${m.text || '礼物'} ×${n(m.num)}${m.battery > 0 ? ` · ${money(m.battery)}` : ''}`,
    SUPER_CHAT: (m) => `醒目留言 ${money(m.battery)}${m.text ? `：${m.text}` : ''}`,
    GUARD_BUY: (m) => `${guardName(m.guardLevel)}${m.battery > 0 ? ` · ${money(m.battery)}` : ''}`,
    FOLLOW: () => '关注了直播间',
    SHARE: () => '分享了直播间',
    LIVE_START: () => '开播',
    LIVE_END: () => '下播',
    SENT: (m) => `机器人：${m.text || '（无内容）'}`,
  };

  /** 一条标记的正文，不带时间（列表里时间单独一列、占固定宽度） */
  function markBody(m) {
    return (MARK_TEXT[m.type] ?? (() => m.type))(m);
  }

  /** 一条标记 → "21:03 礼物 辣条 ×2 · ¥0.2" */
  function markLine(m) {
    return `${hhmmss(m.ts).slice(0, 5)} ${markBody(m)}`;
  }

  /**
   * 画时间轴的条带：柱子 = 每格新增弹幕，顶部细线 = 值得回看的事件。
   *
   * 柱子用服务端算好的 `danmakuDelta`，不在前端拿相邻两格相减 ——
   * 那样等于把"累积量"的定义再写一遍，改一处就会静默对不上。
   *
   * 几何全部走 `xAt()`（时间 → 像素），柱子、刻度、光标共用同一套换算。
   * 早先柱子是按"第 i 格占第 i 个槽位"等宽摆的，于是：
   *   · 最后一格往往不满（窗口长度不是格宽整数倍），柱子却照样占满一格，
   *     光标按时间比例走，两者能差半格；
   *   · 格数超过 ~1120 时，每根柱子有 0.6px 的下限，总宽超过画布，
   *     后半场被裁在画布外面 —— 轴上写着"播到 00:00"，图上却什么都没有。
   * 按时长切就没这两个问题：柱子总宽恒等于画布宽，最后一格自然变窄。
   *
   * @returns {{svg:SVGElement, cursor:SVGElement, xOf:(i:number)=>number}}
   */
  function buildStrip() {
    const W = 680;
    const H = 96;
    const PAD = 4;
    const plotW = W - PAD * 2;
    const baseY = 78;
    const top = 12;

    const n0 = tlFrames.length;
    const maxV = Math.max(1, ...tlFrames.map((f) => Number(f.danmakuDelta) || 0));

    /** 时间 → x。越界的值夹到两端，不让柱子画出画布 */
    const span = tlTo - tlFrom || 1;
    const xAt = (ts) => PAD + Math.min(1, Math.max(0, (Number(ts) - tlFrom) / span)) * plotW;

    // 一格平均占多少像素：缝和最小宽度都得看它，不能拍脑袋
    const slot = plotW / n0;
    const gap = slot >= 8 ? 2 : slot >= 4 ? 1 : 0;
    // 窄到看不见时留一线（但不超过槽宽，否则又会叠起来溢出画布）
    const floorW = Math.min(1, slot * 0.9);

    const bars = [];
    tlFrames.forEach((f, i) => {
      const v = Math.max(0, Number(f.danmakuDelta) || 0);
      const h = v <= 0 ? 0 : Math.max(1, (v / maxV) * (baseY - top));
      if (h <= 0) return;

      // 这一格的左右边界：起点是上一格的终点，第一格从窗口起点开始
      const x0 = xAt(i === 0 ? tlFrom : tlFrames[i - 1].t);
      const w = Math.max(floorW, xAt(f.t) - x0 - gap);

      bars.push(
        svgEl('rect', {
          class: 'tl-bar',
          attrs: {
            x: x0.toFixed(1),
            y: (baseY - h).toFixed(1),
            width: w.toFixed(1),
            height: h.toFixed(1),
          },
          children: [svgEl('title', { text: `${hhmmss(f.t).slice(0, 5)} 前 1 格 ${n(v)} 条弹幕` })],
        }),
      );
    });

    /** 事件刻度：和柱子、光标同一套时间换算，所以刻度一定落在对应柱子的右边界上 */
    const ticks = tlMarks.map((m) =>
      svgEl('rect', {
        class: `tl-tick is-${String(m.type).toLowerCase()}`,
        attrs: {
          x: xAt(m.ts).toFixed(1),
          y: '2',
          width: '1.6',
          height: '7',
        },
        children: [svgEl('title', { text: `${hhmmss(m.ts)} ${markLine(m)}` })],
      }),
    );

    const cursor = svgEl('line', {
      class: 'tl-cursor',
      attrs: { x1: PAD, x2: PAD, y1: '0', y2: String(baseY + 4) },
    });

    const axis = [
      svgEl('text', { class: 'tl-axis', text: hhmmss(tlFrom).slice(0, 5), attrs: { x: PAD, y: H - 4 } }),
      svgEl('text', {
        class: 'tl-axis',
        text: hhmmss(tlTo).slice(0, 5),
        attrs: { x: W - PAD, y: H - 4, 'text-anchor': 'end' },
      }),
    ];

    const svg = svgEl('svg', {
      class: 'tl-svg',
      attrs: {
        viewBox: `0 0 ${W} ${H}`,
        role: 'img',
        'aria-label': `这一场的时间轴，${hhmmss(tlFrom).slice(0, 5)} 到 ${hhmmss(tlTo).slice(0, 5)}`,
      },
      children: [
        svgEl('line', {
          class: 'tl-grid',
          attrs: { x1: PAD, y1: baseY, x2: W - PAD, y2: baseY },
        }),
        ...bars,
        ...ticks,
        ...axis,
        cursor,
      ],
    });

    // 光标停在某一格的**右边界**（就是这一格的结束时刻，也是读数的时刻）
    const xOf = (i) => {
      const f = tlFrames[Math.min(tlFrames.length - 1, Math.max(0, i))];
      return f ? xAt(f.t) : PAD;
    };

    return { svg, cursor, xOf };
  }

  /** 把光标移到第 i 格，并刷新读数 */
  function moveCursor(i) {
    const idx = Math.min(tlFrames.length - 1, Math.max(0, i));
    const f = tlFrames[idx];
    if (!f) return;

    if (tlCursorX) {
      const x = tlCursorX.xOf(idx).toFixed(1);
      tlCursorX.cursor.setAttribute('x1', x);
      tlCursorX.cursor.setAttribute('x2', x);
    }

    if (tlMoment) {
      tlMoment.textContent =
        `到 ${hhmmss(f.t).slice(0, 5)} 为止 · 已播 ${duration(f.elapsedSec * 1000)}`;
    }

    if (tlStats) {
      const cell = (k, v, accent) => kv(k, v, accent);
      replaceChildren(tlStats, [
        cell('弹幕', n(f.danmaku)),
        cell('进场', n(f.enterCount)),
        cell('观众', n(f.uniqueViewers)),
        cell('涨粉', n(f.followCount)),
        cell('礼物', `${n(f.giftCount)} 件`),
        cell('舰长', n(f.guardCount)),
        cell('醒目', n(f.scCount)),
        cell('收入', money(f.totalBattery), true),
      ]);
    }

    if (tlMarksBox) {
      // 只看光标之前的：时间轴的语义是"到这一刻"，后面的事还没发生
      const passed = tlMarks.filter((m) => m.ts <= f.t);
      const tail = passed.slice(-6).reverse();
      replaceChildren(
        tlMarksBox,
        tail.length
          ? tail.map((m) =>
              el('div', {
                class: `tl-mark is-${String(m.type).toLowerCase()}`,
                children: [
                  el('span', { class: 't', text: hhmmss(m.ts).slice(0, 5) }),
                  el('span', { class: 'x', text: markBody(m) }),
                ],
              }),
            )
          : [el('div', { class: 'empty-hint', text: '这一刻之前没有值得标记的事件' })],
      );
    }
  }

  /** 打开某一场的时间轴 */
  async function openTimeline(r) {
    const from = Number(r.startedAt) || 0;
    const to = Number(r.endedAt) || Number(r.lastEventTs) || Date.now();
    if (!(to > from)) {
      toast('这一场的时长太短，没有可回看的片段', 'warn');
      return;
    }

    const token = ++tlToken;
    listBox.hidden = true;
    replaceChildren(timelineBox, [el('div', { class: 'empty-hint', text: '正在重建这一场…' })]);

    let data;
    try {
      data = await api.timeline({ from, to });
    } catch (err) {
      if (token !== tlToken) return;
      replaceChildren(timelineBox, [
        el('div', { class: 'tl-head', children: [
          el('span', { class: 'tl-title', text: '时间轴' }),
          el('span', { class: 'spacer' }),
          backBtn(),
        ] }),
        el('div', { class: 'empty-hint', text: `读不到时间轴：${err.message}` }),
      ]);
      return;
    }
    if (token !== tlToken) return;

    tlFrom = Number(data.from) || from;
    tlTo = Number(data.to) || to;
    tlFrames = Array.isArray(data.frames) ? data.frames : [];
    tlMarks = Array.isArray(data.marks) ? data.marks : [];

    if (tlFrames.length === 0) {
      replaceChildren(timelineBox, [
        el('div', { class: 'tl-head', children: [
          el('span', { class: 'tl-title', text: '时间轴' }),
          el('span', { class: 'spacer' }),
          backBtn(),
        ] }),
        el('div', { class: 'empty-hint', text: '这一段日志里没有事件，画不出时间轴' }),
      ]);
      return;
    }

    const { svg, cursor, xOf } = buildStrip();
    tlCursorX = { cursor, xOf };

    tlRange = el('input', {
      class: 'tl-range',
      attrs: {
        type: 'range',
        min: '0',
        max: String(tlFrames.length - 1),
        step: '1',
        // 默认停在整场的末尾：打开时先给全貌，再往回拖
        value: String(tlFrames.length - 1),
        'aria-label': '拖动回看这一场',
      },
      on: { input: (e) => moveCursor(Number(e.target.value)) },
    });

    tlMoment = el('div', { class: 'tl-moment' });
    tlStats = el('div', { class: 'tl-stats' });
    tlMarksBox = el('div', { class: 'tl-marks' });

    tlSub = el('div', {
      class: 'rpt-note',
      text: `每格 ${data.stepSec} 秒 · 共 ${tlFrames.length} 格${
        data.marksTruncated ? ` · 标记只保留前 ${tlMarks.length} 条` : ''
      }`,
    });

    /**
     * 场次跨天时（22:00 播到 02:00）必须把结束日期也写出来。
     * 只写 `11-02 22:00 → 02:00` 看起来像同一天凌晨，而那是**第二天** ——
     * 回看的人会去翻错的那一天。
     */
    const sameDay = new Date(tlFrom).toDateString() === new Date(tlTo).toDateString();
    const endLabel = sameDay ? hhmmss(tlTo).slice(0, 5) : stampDate(tlTo);

    replaceChildren(timelineBox, [
      el('div', {
        class: 'tl-head',
        children: [
          el('span', { class: 'tl-title', text: `时间轴 · ${stampDate(tlFrom)} → ${endLabel}` }),
          el('span', { class: 'spacer' }),
          backBtn(),
        ],
      }),
      svg,
      tlRange,
      tlMoment,
      tlStats,
      tlSub,
      el('div', { class: 'tl-marks-title', text: '到这一刻为止发生了什么' }),
      tlMarksBox,
    ]);

    moveCursor(tlFrames.length - 1);
    // 打开后直接给焦点：方向键可以一格一格地走，不用摸鼠标
    try {
      tlRange.focus();
    } catch {
      /* 假 DOM 里没有 focus */
    }
  }

  /** 回到场次列表（也用于换范围时强制收起） */
  function closeTimeline() {
    tlToken++;
    tlCursorX = null;
    replaceChildren(timelineBox, []);
    listBox.hidden = false;
  }

  /** 回到场次列表 */
  function backBtn() {
    return el('button', {
      class: 'btn small',
      text: '返回列表',
      attrs: { type: 'button' },
      on: { click: closeTimeline },
    });
  }

  /* ── 加载战报 ── */

  /**
   * 请求序号：**只有最新一次的结果允许上屏**。
   *
   * 三个范围的计算成本差很远（"全部"要重放全量日志）。用户连点
   * 「最近 7 天 → 最近 30 天」时，第一发可能后到，把新结果顶掉 ——
   * chip 高亮着 30 天，图上还是 7 天。不报错、不卡住，只是"数字不对"，
   * 而用户没有任何依据判断该信哪个。
   */
  let loadSeq = 0;

  async function load(retry = 0) {
    const seq = ++loadSeq;
    // 换范围后旧的时间轴就不成立了：它属于上一批结果，留着只会误导
    closeTimeline();
    replaceChildren(listBox, [el('div', { class: 'empty-hint', text: '正在从日志重算…' })]);
    // 旧警告先清掉：换范围后还挂着上一次的提示，会让人以为这次也有问题
    replaceChildren(warnBox, []);
    try {
      const data = await api.reports({ days });
      // 期间又发起了新的加载：这次的结果已经过期，丢掉即可（新的那次会渲染）
      if (seq !== loadSeq) return;
      series = data.series ?? [];

      renderSummary(data.summary);
      renderChart();
      // 服务端会告诉我们"哪些数字来自已知有偏差的旧日志"。
      // 不显示的话，用户看到 0.1 元的 SC 只会认为是我们算错了。
      replaceChildren(
        warnBox,
        (data.warnings ?? []).map((w) =>
          el('div', { class: 'rpt-warn', text: w.text }),
        ),
      );
      replaceChildren(
        listBox,
        data.reports.length
          ? data.reports.map(renderSession)
          : [el('div', { class: 'empty-hint', text: '这段时间没有场次记录' })],
      );

      // 沙盒的日期选项来自日志，不是战报 —— 空场次的一天也该能回放
      const daysList = (data.log?.days ?? []).slice().reverse();
      /**
       * 重建选项会把用户选的那天冲掉（select 回到第一项 = 最新一天）。
       * 换一个时间范围的 chip 是"看别的天数"，不是"改回放日期"，
       * 所以要把已经选过的那天接回来；那天真的没了才退回最新一天。
       */
      const keep = daySelect.value;
      replaceChildren(
        daySelect,
        daysList.length
          ? daysList.map((d) => el('option', { text: d, attrs: { value: d } }))
          : [el('option', { text: '（暂无日志）', attrs: { value: '' } })],
      );
      if (keep && daysList.includes(keep)) daySelect.value = keep;
    } catch (err) {
      if (seq !== loadSeq) return;
      /**
       * 服务端同一时刻只算一份战报，连点必然有一发撞上 429。
       * 用户要的是**新范围**，把"上一次还在算"直接甩给他等于让他再点一次；
       * 这里退避重试两次就够了（一份战报通常一两秒内算完）。
       */
      if (err?.code === 'busy' && retry < 2) {
        await new Promise((r) => setTimeout(r, 700));
        // 这期间用户又点了别的：交给新的那次，不要和它抢
        if (seq !== loadSeq) return;
        return load(retry + 1);
      }
      replaceChildren(listBox, [el('div', { class: 'empty-hint', text: `读不到战报：${err.message}` })]);
      renderSummary(null);
      // 图表也要清掉：留着上一段范围的柱子，看起来像"这次也算出来了"
      series = [];
      renderChart();
    }
  }

  /* ── 沙盒回放 ── */
  async function runSandbox() {
    if (busy) return;
    const day = daySelect.value || '';
    const maxSaid = Math.min(Math.max(Number(maxInput.value) || 300, 1), 5000);

    busy = true;
    runBtn.disabled = true;
    runBtn.textContent = '回放中…';
    replaceChildren(sandboxOut, [el('div', { class: 'empty-hint', text: '正在用当前配置重跑日志…' })]);

    try {
      const r = await api.sandbox({ day, maxSaid });
      /**
       * 回放给的"会说什么"是**插件想说的**，不含闸门的限速。
       * 热闹房间里这个差距可以过半（实测一场：想说 3845 句、真发出去 1806 条），
       * 不写出来，用户会照着这个数字调文案，上线只出去一半。
       */
      const said = Number(r.said?.length) || 0;
      const sendable = Number.isFinite(r.sendable) ? r.sendable : said;
      const limited = Math.max(0, said - sendable);

      const head = el('div', {
        class: 'rpt-sb-head',
        text:
          `回放 ${n(r.fed)} / ${n(r.total)} 条事件，` +
          `插件会发出 ${n(said)} 条` +
          (limited > 0
            ? `，其中 ${n(sendable)} 条真能发出去（限速拦掉 ${n(limited)} 条）`
            : '') +
          (r.stopped ? `（${r.stopped}）` : ''),
      });

      replaceChildren(sandboxOut, [
        head,
        // 服务端说明"哪些东西回放不出来"。不显示的话，用户会拿
        // "回放里定时播报没出现"当成配置没生效
        r.note ? el('div', { class: 'rpt-note', text: r.note }) : null,
        r.said.length
          ? el('div', {
              class: 'rpt-sb-list',
              children: r.said.map((s) =>
                el('div', {
                  class: 'rpt-sb-row',
                  children: [
                    el('span', { class: 't', text: hhmmss(s.ts) }),
                    el('span', { class: 'p', text: s.plugin }),
                    el('span', { class: 'x', text: s.text }),
                  ],
                }),
              ),
            })
          : el('div', { class: 'empty-hint', text: '按当前配置，这段日志不会触发任何发言' }),
      ]);
    } catch (err) {
      replaceChildren(sandboxOut, [el('div', { class: 'empty-hint', text: `回放失败：${err.message}` })]);
    } finally {
      busy = false;
      runBtn.disabled = false;
      runBtn.textContent = '开始回放';
    }
  }

  closeBtn.addEventListener('click', () => dlg.close());
  runBtn.addEventListener('click', runSandbox);

  async function exportPage() {
    exportBtn.disabled = true;
    const label = exportBtn.textContent;
    exportBtn.textContent = '正在生成…';
    try {
      // 带上当前的 days：页面上看的是"最近 7 天"，导出的也该是同一段
      const { blob, filename, size } = await api.exportReport({ days });
      const saved = saveBlob(blob, filename);
      const kb = Math.max(1, Math.round(size / 1024));
      toast(
        saved
          ? `已导出 ${filename}（${kb} KB），双击就能打开`
          : `已生成 ${filename}（${kb} KB），但当前环境不能自动下载，请从浏览器下载记录里取`,
        saved ? 'info' : 'warn',
      );
    } catch (err) {
      toast(`导出失败：${err.message}`, 'error');
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = label;
    }
  }

  exportBtn.addEventListener('click', exportPage);

  /**
   * 单场海报。数据就是卡片上这份 r，不再请求服务端 ——
   * 海报和页面上的数字必须完全一致，多一次请求就多一个对不上的机会。
   */
  async function exportPoster(r) {
    try {
      const { filename, saved } = await downloadPoster(r, { save: saveBlob, toast });
      // 不能自动下载的提示已经在 downloadPoster 里弹过，这里只报成功。
      if (saved) toast(`海报已生成 ${filename}`, 'info');
    } catch (err) {
      toast(`海报生成失败：${err.message}`, 'error');
    }
  }

  const node = el('div', {
    class: 'rpt-wrap',
    children: [
      el('header', {
        class: 'rpt-head',
        children: [el('h4', { text: '场后战报' }), el('span', { class: 'spacer' }), closeBtn],
      }),
      el('div', {
        class: 'rpt-toolbar',
        children: [
          chipRow,
          el('span', { class: 'spacer' }),
          exportBtn,
          el('span', { class: 'rpt-note', text: '数字全部由日志重算，与实时统计同源' }),
        ],
      }),
      warnBox,
      summaryBox,
      chartBox,
      listBox,
      timelineBox,
      el('div', {
        class: 'rpt-sandbox',
        children: [
          el('div', {
            class: 'rpt-sb-bar',
            children: [
              el('span', { class: 'rpt-sb-title', text: '沙盒回放' }),
              el('span', { class: 'rpt-note', text: '用当前配置重跑历史日志，一条都不会真发' }),
            ],
          }),
          el('div', {
            class: 'rpt-sb-ctrl',
            children: [
              el('label', { class: 'rpt-lbl', children: [el('span', { text: '日期' }), daySelect] }),
              el('label', { class: 'rpt-lbl', children: [el('span', { text: '最多' }), maxInput] }),
              runBtn,
            ],
          }),
          sandboxOut,
        ],
      }),
    ],
  });

  dlg.append(node);

  return {
    async open() {
      if (!dlg.open) dlg.showModal();
      renderChips();
      await load();
    },
    close() {
      if (dlg.open) dlg.close();
    },
    /**
     * 房间换了：面板开着就按当前范围重算一次。
     *
     * 战报读的是**当前房间**的日志，切走之后留着上一间的那几张卡片，
     * 看起来就像"新房间已经播了这么多场" —— 数字全是真的，只是属于别人。
     * 关着的时候什么都不做：读全量日志要一两秒，没人看的时候白算没意义。
     */
    refreshIfOpen() {
      if (!dlg.open) return Promise.resolve();
      return load();
    },
  };
}
