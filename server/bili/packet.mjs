/**
 * B站 弹幕长连的二进制包格式。
 *
 * 16 字节头 + 包体：
 *   0–3   总长度（含头）
 *   4–5   头长度（固定 16）
 *   6–7   协议版本（0 明文 / 1 人气值 / 2 zlib / 3 brotli）
 *   8–11  操作码
 *   12–15 序号（固定 1）
 *
 * 一个 TCP 包里可能塞了**多个**逻辑包，而且压缩包解开后还是同样格式，
 * 所以解码必须是"拆 → 逐个解压 → 递归拆"。二代踩过的坑：只拆一层，
 * 结果 zlib 包里的几十条弹幕全丢。
 */

import { brotliDecompressSync, inflateSync } from 'node:zlib';

export const OP = {
  HANDSHAKE: 0,
  HANDSHAKE_REPLY: 1,
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8,
};

export const VER = {
  PLAIN: 0,
  POPULARITY: 1,
  ZLIB: 2,
  BROTLI: 3,
};

export const HEADER_LEN = 16;

/** 解压后超过这个大小就认为异常（防压缩炸弹把内存打满） */
const MAX_INFLATED = 8 * 1024 * 1024;
const MAX_DEPTH = 4;

/**
 * 组一个包。
 * @param {number} op
 * @param {string|Buffer|object} body 对象会被 JSON 化
 * @param {number} [ver]
 */
export function encode(op, body = '', ver = VER.PLAIN) {
  let payload;
  if (Buffer.isBuffer(body)) payload = body;
  else if (typeof body === 'object' && body !== null) payload = Buffer.from(JSON.stringify(body), 'utf8');
  else payload = Buffer.from(String(body), 'utf8');

  const buf = Buffer.allocUnsafe(HEADER_LEN + payload.length);
  buf.writeUInt32BE(HEADER_LEN + payload.length, 0);
  buf.writeUInt16BE(HEADER_LEN, 4);
  buf.writeUInt16BE(ver, 6);
  buf.writeUInt32BE(op, 8);
  buf.writeUInt32BE(1, 12);
  payload.copy(buf, HEADER_LEN);
  return buf;
}

/**
 * 拆包。返回按到达顺序展开的包列表（压缩包已递归解开）。
 * @param {Buffer} buffer
 * @returns {{ver:number, op:number, body:Buffer}[]}
 */
export function decode(buffer, depth = 0) {
  const out = [];
  if (!Buffer.isBuffer(buffer) || depth > MAX_DEPTH) return out;

  let offset = 0;
  while (offset + HEADER_LEN <= buffer.length) {
    const totalLen = buffer.readUInt32BE(offset);
    const headerLen = buffer.readUInt16BE(offset + 4);
    const ver = buffer.readUInt16BE(offset + 6);
    const op = buffer.readUInt32BE(offset + 8);

    // 长度不合法说明包已经错位了，后面的都无法信任，直接停
    if (headerLen < HEADER_LEN || totalLen < headerLen || offset + totalLen > buffer.length) break;

    const body = buffer.subarray(offset + headerLen, offset + totalLen);

    if (ver === VER.ZLIB || ver === VER.BROTLI) {
      const inflated = inflate(ver, body);
      if (inflated) out.push(...decode(inflated, depth + 1));
    } else {
      out.push({ ver, op, body });
    }

    offset += totalLen;
  }

  return out;
}

function inflate(ver, body) {
  try {
    /**
     * `maxOutputLength` 是**解压过程中**的硬上限：超过它 zlib 会直接抛
     * `ERR_BUFFER_TOO_LARGE`，而不是先把几 GB 解出来再让我们比大小。
     *
     * 以前的写法是解压之后才 `out.length > MAX_INFLATED` —— 那个检查在
     * 压缩炸弹面前毫无作用：一个几百字节的包可以在解压这一步就把进程内存打满，
     * 后面的判断根本没机会执行。注释写着"防压缩炸弹"，实现却是"炸完再说"。
     *
     * 抛出的错误由下面的 catch 吞掉，整包丢弃：坏包不该让长连崩掉。
     */
    const out =
      ver === VER.BROTLI
        ? brotliDecompressSync(body, { maxOutputLength: MAX_INFLATED })
        : inflateSync(body, { maxOutputLength: MAX_INFLATED });
    if (out.length > MAX_INFLATED) return null;
    return out;
  } catch {
    // 压缩包坏了、或者解压后超限：丢掉这一包，但不能让整条连接崩掉
    return null;
  }
}

/** 包体当 JSON 解析（B站 的消息包体都是 JSON） */
export function parseJson(body) {
  if (!body || body.length === 0) return null;
  const text = body.toString('utf8').replace(/\0+$/, '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 心跳回包的前 4 字节是人气值 */
export function parsePopularity(body) {
  if (!body || body.length < 4) return 0;
  return body.readUInt32BE(0);
}
