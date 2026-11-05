/**
 * 布局护栏。
 *
 * 为什么不靠截图：这台机器上的 Edge 无头起不来（各种参数都在 100ms 内退出，
 * 不出文件也不出日志），而"歪了"这类问题恰恰只有看图才发现得了。
 * 所以这里换个角度：**把"会不会歪"变成可以算的断言**。
 *
 * 只覆盖一类问题 —— 「某个数字改大了，导致内容在某个宽度下排不下」。
 * 它算不出好看不好看，但算得出：
 *   - 5 张统计卡在桌面区间会不会掉成 4+1
 *   - 侧栏固定宽 + 主区内边距加起来会不会把主区挤没
 *   - 顶栏动作区会不会把房间名压成省略号
 *
 * 这些数字全部从 CSS 里读，不在测试里重抄一遍。重抄就等于抄错也一起抄。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * 去掉 CSS 注释再解析。
 *
 * 不这么做会出事：注释里写了 "grid 子项默认 min-width:auto：……"
 * 这样的句子，正则就会把注释当成声明，读出一个以 "auto：" 开头的值。
 * 第一版就是这么误报的 —— 而误报比漏报更糟，会让人开始不信任护栏。
 */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const TOKENS = strip(read('web/tokens.css'));
const CSS = strip(read('web/app.css'));
const HTML = read('web/index.html');
const PANELS = read('web/views/panels.js');

/* ── 极简 CSS 读取：够用就好，不引解析器 ─────────────────── */

/** 取 `选择器 { ... }` 的块内容（花括号配平），找不到返回 null */
function block(css, selector, from = 0) {
  const i = css.indexOf(`${selector} {`, from);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, j);
    }
  }
  return null;
}

/** 取某条属性的原始值 */
function prop(blockText, name) {
  if (!blockText) return null;
  const m = blockText.match(new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

/** 设计变量表 */
const VARS = Object.fromEntries(
  [...TOKENS.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
);

/** 把 `16px 16px 16px var(--s6)` 拆成数字数组 */
function lengths(value) {
  if (!value) return [];
  return value
    .replace(/var\((--[\w-]+)\)/g, (_, k) => VARS[k] ?? '0px')
    .split(/\s+/)
    .map((t) => parseFloat(t))
    .filter((n) => Number.isFinite(n));
}

/** 数字（用于 gap 这类单值） */
const one = (value) => lengths(value)[0] ?? 0;

/* ── 从 CSS 里读出布局的关键常量 ─────────────────────────── */

const appBlock = block(CSS, '.app');
const mainBlock = block(CSS, '.main');
const sideBlock = block(CSS, '.side');
const statsBlock = block(CSS, '.stats');
const kvBlock = block(CSS, '.kv');

const BREAK_STACK = 1024;

/** `.app` 的两列：第一列自适应，第二列固定 —— 侧栏宽就从这里读 */
const appCols = appBlock && prop(appBlock, 'grid-template-columns');
const sideWidth = appCols ? Number((appCols.match(/(\d+)px/) ?? [])[1]) : NaN;

/** 主区左右内边距（padding 简写：上 右 下 左） */
const mainPad = lengths(prop(mainBlock, 'padding'));
const padRight = mainPad[1] ?? 0;
const padLeft = mainPad.length === 4 ? mainPad[3] : (mainPad[1] ?? 0);

/** 统计卡的最小宽度与间距 */
const statMin = statsBlock ? Number((prop(statsBlock, 'grid-template-columns').match(/min\((\d+)px/) ?? [])[1]) : NaN;
const statGap = one(prop(statsBlock, 'gap'));

/** 统计卡张数：直接数 panels.js 里的定义，改张数这里会跟着变 */
const CARD_COUNT = (PANELS.match(/^\s*\{\s*key:\s*'/gm) ?? []).length;

/** 某个视口宽度下，主区可用内容宽 */
function contentWidth(vw) {
  return vw - sideWidth - padLeft - padRight;
}

/** 给定上限宽度，n 个卡能排成几列 */
function columnsFor(vw, min, gap, n) {
  const content = contentWidth(vw);
  const tracks = Math.max(1, Math.floor((content + gap) / (min + gap)));
  return Math.min(tracks, n);
}

/** 桌面区间内第一次能排成单行的视口宽度 */
function singleRowFrom(min, gap, n) {
  for (let vw = BREAK_STACK + 1; vw <= 4000; vw++) {
    if (columnsFor(vw, min, gap, n) >= n) return vw;
  }
  return Infinity;
}

/* ══════════════════════ 骨架 ══════════════════════ */

test('骨架：主区必须显式写 flex/grid 列，且允许收缩', () => {
  assert.ok(appCols, '.app 必须有 grid-template-columns');
  assert.match(appCols, /minmax\(0,\s*1fr\)/, '第一列必须是 minmax(0,1fr)：写成 auto 会按内容撑宽');
  assert.ok(Number.isFinite(sideWidth) && sideWidth > 0, `侧栏宽读不出来：${appCols}`);

  // 曾经踩过：.main 没写列，隐式列按最宽的 nowrap 内容算，整页被撑出屏幕
  assert.match(
    prop(mainBlock, 'grid-template-columns') ?? '',
    /minmax\(0,\s*1fr\)/,
    '.main 必须显式写 grid-template-columns: minmax(0, 1fr)',
  );
  for (const [name, b] of [['.main', mainBlock], ['.side', sideBlock]]) {
    assert.match(prop(b, 'min-width') ?? '', /^0/, `${name} 必须有 min-width: 0，否则收缩链断了`);
  }
});

test('骨架：主区内容宽必须为正，侧栏不能把主区吃掉', () => {
  const narrow = contentWidth(BREAK_STACK + 1);
  assert.ok(narrow > 400, `1025px 视口下主区只剩 ${narrow}px，侧栏 ${sideWidth}px 太宽了`);
  assert.ok(padLeft + padRight < 80, `主区左右内边距合计 ${padLeft + padRight}px，偏大`);
});

/* ══════════════════════ 统计卡 ══════════════════════ */

test('统计卡：张数变了要重新核算排布（这是一条提醒，不是洁癖）', () => {
  assert.ok(CARD_COUNT >= 4 && CARD_COUNT <= 6, `读到 ${CARD_COUNT} 张统计卡，数错了？`);
  assert.ok(Number.isFinite(statMin) && statMin > 0, '统计卡最小宽度读不出来');
});

test('统计卡：桌面区间（>1024）必须始终排成一行', () => {
  const from = singleRowFrom(statMin, statGap, CARD_COUNT);
  assert.ok(
    from <= BREAK_STACK + 1,
    `${CARD_COUNT} 张卡要视口 ≥${from}px 才排得开，于是 ${BREAK_STACK + 1}–${from - 1}px 会掉成 ${CARD_COUNT - 1}+1 的孤儿卡。` +
      `下限 ${statMin}px 需要再调小（可用宽度 = 视口 − ${sideWidth + padLeft + padRight}px）`,
  );
});

test('统计卡：宽屏下不能被撑得过分宽', () => {
  const content = contentWidth(1920);
  const w = Math.floor((content - statGap * (CARD_COUNT - 1)) / CARD_COUNT);
  assert.ok(w < 340, `1920px 下每张卡 ${w}px，比侧栏还宽，应该加 max-width 或改列数分配`);
});

/* ══════════════════════ 侧栏 ══════════════════════ */

test('侧栏：矮屏要能滚，不能把内容裁掉', () => {
  assert.match(prop(sideBlock, 'overflow-y') ?? '', /auto|scroll/, '.side 必须 overflow-y: auto');
});

test('侧栏：键值对不用「右对齐到边缘」（D26）', () => {
  const jc = prop(kvBlock, 'justify-content') ?? '';
  assert.ok(!/space-between/.test(jc), '.kv 不能用 space-between：容器一窄，值会被压成 0 宽（看得见 DOM、看不见字）');
});

test('断点：≤1024 必须切成单列堆叠', () => {
  const media = block(CSS, `@media (max-width: ${BREAK_STACK}px)`);
  assert.ok(media, `缺 @media (max-width: ${BREAK_STACK}px)`);

  const appInMedia = block(media, '.app');
  assert.match(
    prop(appInMedia, 'grid-template-columns') ?? '',
    /minmax\(0,\s*1fr\)/,
    '窄屏必须把两列改成一列',
  );
  const sideInMedia = block(media, '.side');
  assert.equal(
    prop(sideInMedia, 'flex-direction'),
    'column',
    '窄屏侧栏必须改单列：并排两列会把值挤出可视区',
  );
});

/* ══════════════════════ 顶栏 ══════════════════════ */

/** 粗估一个控件的宽度：内边距 + 边框 + 文字。中文字宽约等于字号，英文按 0.55 折 */
function estimateControl(kind, text) {
  const fs = kind === 'btn' ? one(VARS['--fs-sm']) : one(VARS['--fs-xs']);
  const padX = kind === 'btn' ? one(VARS['--s3']) : one(VARS['--s2']);
  const border = 2;
  let textW = 0;
  for (const ch of text) textW += /[\u4e00-\u9fa5]/.test(ch) ? fs : fs * 0.55;
  return padX * 2 + border + textW;
}

test('顶栏：右侧动作区不能把房间名挤没', () => {
  const actions = /<div class="top-actions">([\s\S]*?)<\/div>/.exec(HTML);
  assert.ok(actions, '顶栏里找不到 .top-actions');

  const buttons = [...actions[1].matchAll(/<button class="btn"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim());
  const pills = [...actions[1].matchAll(/<span class="pill"[^>]*>([\s\S]*?)<\/span>\s*(?=<|$)/g)];

  // 连接状态那个 pill 里含一个 6px 圆点 + 6px 间距
  let total = 0;
  for (const b of buttons) total += estimateControl('btn', b);
  for (const m of pills) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    total += estimateControl('pill', text) + (/class="dot"/.test(m[1]) ? 12 : 0);
  }
  // 演练开关：方框 30 + 间距 6 + 文字
  const switchText = (/<label class="switch"[\s\S]*?<span>([^<]*)<\/span>/.exec(actions[1]) ?? [])[1] ?? '演练模式';
  total += 36 + estimateControl('pill', switchText);

  const gap = one(VARS['--s3']);
  const count = buttons.length + [...actions[1].matchAll(/<span class="pill"/g)].length + 1;
  total += gap * (count - 1);

  const topPad = one(VARS['--s6']);
  const topGap = one(VARS['--s4']);
  const brandMin = 120; // 圆点 + 名称 + 分隔符，房间名可以被省略号收缩

  const budget = 1025 - topPad * 2 - topGap - brandMin;
  assert.ok(
    total <= budget,
    `顶栏右侧合计约 ${Math.round(total)}px，超过预算 ${Math.round(budget)}px：` +
      `1025px 视口下房间名会被压成省略号。要么精简按钮，要么把断点提前`,
  );
});

/* ══════════════════ 接线：页面里真有这些元素 ══════════════════ */

/**
 * `$('#x')` 拿到 null 时，`addEventListener` 会当场抛错，
 * 整页的接线就此中断 —— 而且报错在控制台里，页面上只是"什么都不动"。
 * 加一个面板、忘了往 HTML 里补一行，就是这个形状。
 */
test('接线：app.js 里每个 $(#id) 在 index.html 里都真的存在', () => {
  const JS = read('web/app.js');
  const ids = [...JS.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 10, `只找到 ${ids.length} 个 id，正则可能失效了`);

  const missing = [...new Set(ids)].filter((id) => !new RegExp(`id="${id}"`).test(HTML));
  assert.deepEqual(missing, [], `index.html 里缺少这些元素：${missing.join(', ')}`);
});

/* ══════════════ 换房间：面板不能留上一间的数字 ══════════════ */

/**
 * `reset` 是"服务端换房间了"的唯一信号。
 *
 * 它会清空事件流、重连 WS，但**插件面板的数据不走 WS** ——
 * 那是一次独立的 `/api/plugins` 请求。不重拉的话，认领 / 发言 / 报错
 * 会一直停在上一间的数字上，而配置是全局的，看起来完全正常。
 * 这种"一半新一半旧"最难发现，所以在这里钉一条。
 */
test('换房间：收到 reset 时要重拉插件面板（配置全局、计数分房间）', () => {
  const JS = read('web/app.js');
  const i = JS.indexOf("case 'reset':");
  assert.ok(i > 0, 'app.js 里找不到 reset 分支');

  // 取这个 case 到它的 break; 之间那一段
  const end = JS.indexOf('break;', i);
  const body = JS.slice(i, end > i ? end : i + 600);

  assert.match(body, /store\.reset\(\)/, 'reset 必须清空事件仓库（否则新房间的弹幕接在旧房间尾巴上）');
  assert.match(body, /reconnect\(\)/, 'reset 必须重连：backlog 只在建连时发一次');
  assert.match(
    body,
    /settings\.reload\(\)/,
    'reset 时插件面板没刷新：切房间后会一直显示上一间的认领/发言计数',
  );
  assert.match(
    body,
    /reports\.refreshIfOpen\(\)/,
    'reset 时战报面板没刷新：切房间后那一堆场次卡片其实还是上一间的',
  );
});
