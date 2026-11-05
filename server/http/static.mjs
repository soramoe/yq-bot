/**
 * 静态文件服务。
 *
 * 只做四件事：解析路径、防穿越、定 MIME、带缓存校验。
 * 不引 serve-static / express.static —— 那些包做的事情这里 80 行就够，
 * 而它们的默认行为（目录列表、index 回退顺序）需要额外关掉，反而更绕。
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

/** 只发这些类型。默认拒绝比默认放行安全：将来误放了 .env 也不会被读到 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // PWA 清单必须是这个 type：发成 application/json 浏览器不认，装不了
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 把 URL 路径映射到磁盘路径。
 *
 * 返回 null 表示"不该给"，调用方统一回 404 —— 不区分"不存在"和"越界"，
 * 避免把目录结构泄露给探测者。
 *
 * @param {string} root 静态根目录（绝对路径）
 * @param {string} urlPath 已经过 URL 解析的 pathname
 * @returns {string|null}
 */
export function resolveStaticPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // 非法百分号编码
  }

  // NUL 截断是经典的路径绕过手法
  if (decoded.includes('\0')) return null;

  // 目录默认取 index.html。只处理这一层，不做多级回退。
  if (decoded.endsWith('/')) decoded += 'index.html';

  const abs = resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  const rootAbs = resolve(root);
  // sep 结尾保证 /webapp 不会匹配到 /web
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;

  const ext = extname(abs).toLowerCase();
  if (!MIME[ext]) return null;

  return abs;
}

/**
 * 生成弱 ETag。内容和大小 + 毫秒时间戳绑定，
 * 对本地服务足够：文件一改就变，不改就一直命中 304。
 */
function etagOf(st) {
  return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

/**
 * 处理一次静态请求。命中就直接把响应写完，返回 true。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} root
 * @param {string} pathname
 * @param {Record<string,string>} headers 额外的响应头（CSP 等）
 * @returns {Promise<boolean>} 是否已经响应
 */
export async function serveStatic(req, res, root, pathname, headers = {}) {
  const file = resolveStaticPath(root, pathname);
  if (!file) return false;

  let st;
  try {
    st = await stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  const ext = extname(file).toLowerCase();
  const etag = etagOf(st);

  const common = {
    ...headers,
    'Content-Type': MIME[ext],
    'Cache-Control': 'no-cache',
    ETag: etag,
  };

  // 304 不需要 body：本地开发频繁刷新时省掉整份传输
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, common);
    res.end();
    return true;
  }

  res.writeHead(200, { ...common, 'Content-Length': String(st.size) });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  // 流式发送：前端单个文件几百 KB，一次读进内存没必要
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);

  return true;
}

export default serveStatic;
