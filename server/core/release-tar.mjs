/**
 * 纯 JS 解 tar.gz。
 *
 * 更新包只需要"读文件"这一小部分 tar 能力，为此引一个压缩库不值得：
 * 项目唯一的依赖是 ws。这里支持的子集：
 *   - ustar 前缀字段、GNU 长文件名（type L）、PAX 扩展头（type x）
 *   - 普通文件（0 / NUL）和目录（5）
 *   - 明确拒绝符号链接、硬链接、设备文件
 *
 * 安全边界比格式完整更重要：先把每个条目名规范化并拒绝绝对路径、
 * 盘符和 `..`，再写文件；解完之后还要求目标路径落在 destDir 内。
 */

import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const BLOCK = 512;

/** 解压后的 tar 上限：防 gzip 炸弹 */
const MAX_TAR_BYTES = 200 * 1024 * 1024;

/**
 * 规范化 tar 条目名。
 * @param {string} name
 * @returns {string|null} 不安全/空时返回 null
 */
export function cleanEntryName(name) {
  const raw = String(name ?? '')
    .replace(/\\/g, '/')
    .replace(/\0/g, '')
    .trim();
  if (!raw) return null;
  if (raw.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(raw)) return null;

  const parts = raw.split('/').filter((p) => p && p !== '.');
  if (!parts.length) return null;
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

function readString(buf, start, len) {
  let i = start;
  const end = start + len;
  while (i < end && buf[i] !== 0) i++;
  return buf.subarray(start, i).toString('utf8');
}

function readOctal(buf, start, len) {
  const s = readString(buf, start, len).trim();
  if (!s) return 0;
  const n = Number.parseInt(s, 8);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 解析 tar buffer。
 * @param {Buffer} tar
 * @returns {{path:string, dir:boolean, data:Buffer}[]}
 */
export function parseTar(tar) {
  const out = [];
  let offset = 0;
  let nextPath = null;

  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) break;

    const name = readString(block, 0, 100);
    const size = readOctal(block, 124, 12);
    const type = String.fromCharCode(block[156] || 0x30);
    const isUstar = readString(block, 257, 6) === 'ustar';
    const prefix = isUstar ? readString(block, 345, 155) : '';

    if (size === null) throw new Error('更新包结构损坏：条目大小不是八进制');
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length) throw new Error('更新包结构损坏：条目超出文件末尾');

    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    // PAX 扩展头：把里面的 path= 留给下一条
    if (type === 'x' || type === 'g') {
      const text = data.toString('utf8');
      for (const line of text.split('\n')) {
        const sp = line.indexOf(' ');
        if (sp <= 0) continue;
        const kv = line.slice(sp + 1);
        const eq = kv.indexOf('=');
        if (eq <= 0) continue;
        if (kv.slice(0, eq) === 'path') nextPath = kv.slice(eq + 1);
      }
      continue;
    }

    // GNU 长文件名：内容就是下一条的名字
    if (type === 'L') {
      nextPath = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }

    const full = nextPath || (prefix ? `${prefix}/${name}` : name);
    nextPath = null;

    if (type === '5') {
      out.push({ path: full, dir: true, data: Buffer.alloc(0) });
      continue;
    }
    if (type !== '0' && type !== '\0') {
      throw new Error(`更新包里有不支持的条目类型（${type}）：${full}`);
    }
    out.push({ path: full, dir: false, data });
  }

  return out;
}

/**
 * 解开 tar.gz 并写入目录。
 * @param {Buffer} gzBuffer
 * @param {string} destDir
 * @returns {{count:number, files:string[]}}
 */
export function extractTarGz(gzBuffer, destDir) {
  if (!Buffer.isBuffer(gzBuffer) || !gzBuffer.length) throw new Error('更新包是空的');

  let tar;
  try {
    tar = gunzipSync(gzBuffer, { maxOutputLength: MAX_TAR_BYTES });
  } catch (err) {
    throw new Error(`更新包解不开：${err?.message ?? '不是合法的 tar.gz'}`);
  }
  if (tar.length > MAX_TAR_BYTES) throw new Error('更新包解压后太大了');

  const entries = parseTar(tar);
  const root = resolve(destDir);
  const files = [];

  for (const entry of entries) {
    const rel = cleanEntryName(entry.path);
    if (!rel) throw new Error(`更新包里有不安全路径：${entry.path}`);

    const target = resolve(root, rel);
    // 双保险：即使上面的规范化被绕过，也不允许写出 destDir
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`更新包里的路径越界：${entry.path}`);
    }

    if (entry.dir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    files.push(rel);
  }

  return { count: files.length, files };
}

export default extractTarGz;
