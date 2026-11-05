/**
 * 二维码渲染：SVG 与终端。
 *
 * 为什么不直接输出 PNG：SVG 是纯文本，可以直接内联进 HTML，
 * 不用起额外请求、不用把图片写进磁盘、也不用担心缓存。
 * 手机扫 SVG 和扫 PNG 没有任何区别。
 */

import { encodeQr } from './encode.mjs';

/**
 * 生成二维码 SVG 字符串。
 *
 * @param {string} text
 * @param {{size?:number, margin?:number, dark?:string, light?:string,
 *          version?:number, mask?:number, title?:string}} [opts]
 * @returns {string} 完整 `<svg>` 标签
 */
export function qrSvg(text, opts = {}) {
  const {
    size = 240,
    margin = 4,
    dark = '#000000',
    light = '#ffffff',
    version = 0,
    mask = -1,
    title = '',
  } = opts;

  const qr = encodeQr(text, { version, mask });
  const n = qr.size;
  const dim = n + margin * 2;

  // 每行把连续的深色模块合并成一条横线，节点数从 n² 降到几十
  const parts = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.at(r, c)) {
        c++;
        continue;
      }
      let end = c;
      while (end < n && qr.at(r, end)) end++;
      parts.push(`M${c + margin} ${r + margin}h${end - c}v1h${-(end - c)}z`);
      c = end;
    }
  }

  const label = title ? `<title>${escapeXml(title)}</title>` : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="${escapeXml(title || '登录二维码')}">` +
    label +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${parts.join('')}" fill="${dark}"/>` +
    `</svg>`
  );
}

/**
 * 终端二维码（用半块字符，两行并一行，终端里可以直接扫）。
 *
 * 用途：浏览器打不开、或者想在纯命令行环境下快速登录时。
 */
export function qrTerminal(text, opts = {}) {
  const { quiet = 2, invert = false, version = 0, mask = -1 } = opts;
  const qr = encodeQr(text, { version, mask });
  const n = qr.size;
  const dim = n + quiet * 2;

  const get = (r, c) => {
    const rr = r - quiet;
    const cc = c - quiet;
    if (rr < 0 || rr >= n || cc < 0 || cc >= n) return 0;
    return qr.at(rr, cc) ? 1 : 0;
  };

  // 终端背景一般是深色，所以默认反转：深色模块画成浅色字符
  const fg = invert ? '\x1b[47m' : '\x1b[40m';
  const bg = '\x1b[0m';
  const lines = [];

  for (let r = 0; r < dim; r += 2) {
    let line = '';
    for (let c = 0; c < dim; c++) {
      const top = get(r, c);
      const bottom = r + 1 < dim ? get(r + 1, c) : 0;
      // ▀ 上、▄ 下、█ 全、空格是"两个都白"
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(fg + line + bg);
  }
  return lines.join('\n');
}

function escapeXml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
