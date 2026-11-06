// 组装安装包（zip）。不引第三方压缩库：用 node:zlib 写一个最小的 zip。
//
// 目的：让「本地打 zip」和「GitHub Actions 打 zip」走同一份代码，避免像
// 1.0.2 那样 tar 自动发、zip 手动传，两边清单不一致。
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 安装包只带运行需要的文件；data/logs/auth/代理配置一律不带。
export const DIST_ENTRIES = Object.freeze([
  'server/',
  'web/',
  'plugins/',
  'docs/',
  'scripts/',
  'node_modules/ws/',
  'runtime/',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  '安装说明.txt',
  '启动渔情.bat',
]);

// 只给开发者用的东西，不进用户安装包。
// 签发工具依赖开发者本机的私钥，用户拿到也用不了，但不该出现在安装目录里。
export const SKIP_RELATIVE = Object.freeze([
  'docs/private-key.md',
  'docs/决策记录.md',
  'docs/视频脚本-3分钟.md',
  'server/tools/license-issue.mjs',
  'server/tools/license-keygen.mjs',
  'server/tools/license-studio.mjs',
  'server/tools/license-studio.html',
  'server/tools/check-license-studio.test.mjs',
]);

const SKIP_FILES = new Set(['proxy.txt', '.DS_Store', 'Thumbs.db']);
const SKIP_DIRS = new Set(['data', 'logs', '.git', '.github', 'dist', 'node_modules']);
const SKIP_EXTS = new Set(['.pem', '.key', '.log']);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function shouldSkip(name) {
  const lower = name.toLowerCase();
  if (SKIP_FILES.has(lower)) return true;
  if (SKIP_EXTS.has(path.extname(lower))) return true;
  return false;
}

function walk(dir, relDir, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = `${relDir}/${name}`;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      /**
       * `node_modules` 默认整棵跳过（根目录那份靠 `node_modules/ws/` 单独加回来）。
       * 但 `runtime/node` 是随包的便携 Node —— 它自带的 `node_modules` 里装着
       * npm 本体，跳掉之后 `npm.cmd` / `npx.cmd` 指向的 `npm-cli.js` 就不存在了：
       * 包里的那个 npm 是坏的，用户想用它装个依赖会直接失败。
       */
      const portableNodeModules = name === 'node_modules' && relDir.startsWith('runtime/node');
      if (SKIP_DIRS.has(name) && !portableNodeModules) continue;
      walk(abs, rel, out);
    } else if (st.isFile() && !shouldSkip(name)) {
      out.push({ rel, abs, size: st.size });
    }
  }
}

// 返回 [{ rel, abs, size }]，rel 用 / 分隔。
export function collectFiles(root = ROOT) {
  const out = [];
  for (const entry of DIST_ENTRIES) {
    const abs = path.join(root, entry.replace(/\/$/, ''));
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      // node_modules/ws 是显式加进来的，允许它下面出现 node_modules 字样
      walk(abs, toPosix(entry.replace(/\/$/, '')), out);
    } else if (st.isFile() && !shouldSkip(path.basename(abs))) {
      out.push({ rel: toPosix(entry), abs, size: st.size });
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out.filter((f) => !SKIP_RELATIVE.includes(f.rel));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export function buildZip(files, { date = new Date() } = {}) {
  const { time, day } = dosStamp(date);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.abs);
    const name = Buffer.from(file.rel, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, compressed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(0x0314, 4); // unix, 2.0
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(day, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    for (let i = 30; i < 42; i += 2) cen.writeUInt16LE(0, i);
    central.push(cen, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// 测试用：读回 zip 目录，顺便解出内容。
export function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip：找不到 EOCD");

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out = [];

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    out.push({ name, size, crc, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function writeZip(files, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const buf = buildZip(files);
  fs.writeFileSync(outPath, buf);
  return { path: outPath, bytes: buf.length, files: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--out");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const outPath = at >= 0 ? path.resolve(argv[at + 1]) : path.join(ROOT, "dist", `yuqing-bot-${pkg.version}.zip`);
  const files = collectFiles();
  const result = writeZip(files, outPath);
  console.log(`${result.files} 个文件 → ${result.path}（${result.bytes} 字节）`);
}
