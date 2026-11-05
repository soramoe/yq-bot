/**
 * DOM 小工具。
 *
 * 全项目不用 innerHTML。原因是本页面显示的全是**别人说的话**：
 * 弹幕内容、昵称、礼物名，全都是不可信输入。用 textContent 构造节点，
 * 注入问题在结构上就不存在，而不是"记得转义"。
 */

/**
 * @param {string} tag
 * @param {{
 *   class?:string, text?:string|number, title?:string, html?:never,
 *   dataset?:Record<string,string>, attrs?:Record<string,string>,
 *   on?:Record<string,Function>, children?:Array<Node|null|undefined|false>
 * }} [opts]
 * @param {{children?:Array<Node|null|undefined|false>}} [extra]
 *   只为了 `el(tag, {...}, { children })` 这种写法读起来更清楚：
 *   参数一多，children 挤在同一个对象字面量末尾很难看清层级。
 */
export function el(tag, opts = {}, extra) {
  return fill(document.createElement(tag), opts, extra, false);
}

/** SVG 命名空间。图表必须用 createElementNS 造，否则浏览器把它当未知 HTML 元素，什么都不画 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 造一个 SVG 元素。选项和 `el` 一样。
 *
 * 不能直接用 `el`：`createElement('rect')` 造出来的是 HTMLUnknownElement，
 * 放进 `<svg>` 里会被整棵丢掉 —— 页面一片空白，控制台里一句话都没有。
 * 另外 SVG 元素的 `className` 是只读的 `SVGAnimatedString`，
 * 直接赋值在严格模式下会抛，所以 class 走 setAttribute。
 */
export function svgEl(tag, opts = {}, extra) {
  return fill(document.createElementNS(SVG_NS, tag), opts, extra, true);
}

function fill(node, opts = {}, extra, isSvg) {
  const o = extra ? { ...opts, ...extra } : opts;

  if (o.class) {
    if (isSvg) node.setAttribute('class', o.class);
    else node.className = o.class;
  }
  if (o.text !== undefined && o.text !== null) node.textContent = String(o.text);
  /**
   * `title` 单独支持，不用挤进 `attrs`。
   *
   * 原因：它是最常用的一个属性（悬停提示），而**不认识**的选项键会被
   * 这一段静默丢掉 —— 写成 `el('span', { title: '直播中' })` 时悬停什么都不显示，
   * 页面上看不出任何异常，也没人会想到是构造函数不认这个键。
   * 与其让每个人都记得写 `attrs: { title }`，不如让它就在这儿生效。
   */
  if (o.title !== undefined && o.title !== null) node.setAttribute('title', String(o.title));
  // SVG 元素上 dataset 在旧浏览器里不存在，而图表的附加数据都走 attrs
  if (o.dataset && !isSvg) for (const k in o.dataset) node.dataset[k] = o.dataset[k];
  if (o.attrs) for (const k in o.attrs) node.setAttribute(k, String(o.attrs[k]));
  if (o.on) for (const k in o.on) node.addEventListener(k, o.on[k]);
  if (o.children) {
    for (const c of o.children) {
      if (c) node.append(c);
    }
  }

  return node;
}

export function clear(node) {
  node.replaceChildren();
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

/**
 * 批量替换掉某个容器的内容。
 * 用 DocumentFragment 一次插入：逐个 append 会触发多次布局。
 */
export function replaceChildren(container, nodes) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) if (n) frag.append(n);
  container.replaceChildren(frag);
}
