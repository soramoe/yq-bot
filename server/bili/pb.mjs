/**
 * 轻量 protobuf 读取器。
 *
 * B站 有一部分消息（新版进场 INTERACT_WORD_V2、新版礼物 SEND_GIFT_V2）
 * 把数据塞进 base64 编码的 protobuf，而不是 JSON。
 * 我们没有 .proto 定义，也没必要有 —— 只需要按字段号取值。
 *
 * 设计要点：**只读不写，永不抛异常**。
 * 一段坏字节最多让这一条报文解析失败，绝不能让整条弹幕连接崩掉。
 */

/**
 * @typedef {{wire:number, num?:number, bytes?:Buffer, str?:string|null}} PbEntry
 */

/** 读一个 varint。用 BigInt 避免超过 2^53 时精度丢失 */
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let i = pos;

  while (i < buf.length) {
    const byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7n;
    if (shift > 63n) throw new Error('varint 过长');
  }
  throw new Error('varint 截断');
}

/** 判断一段字节是不是可读文本（用是否含替换字符/控制字符来排除二进制） */
function asText(bytes) {
  if (!bytes || bytes.length === 0) return null;
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD')) return null;
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) return null;
  return text;
}

/**
 * 解析成 字段号 → 条目数组 的映射。
 * 同一字段号可能出现多次（repeated 字段），所以值是数组。
 * @param {Buffer} buf
 * @returns {Map<number, PbEntry[]>}
 */
export function readPb(buf) {
  /** @type {Map<number, PbEntry[]>} */
  const fields = new Map();
  if (!Buffer.isBuffer(buf) || buf.length === 0) return fields;

  let pos = 0;
  while (pos < buf.length) {
    let tag;
    try {
      [tag, pos] = readVarint(buf, pos);
    } catch {
      break;
    }

    const fieldNo = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (fieldNo <= 0) break;

    let entry;
    try {
      if (wire === 0) {
        let v;
        [v, pos] = readVarint(buf, pos);
        entry = { wire, num: Number(v) };
      } else if (wire === 2) {
        let len;
        [len, pos] = readVarint(buf, pos);
        const size = Number(len);
        if (size < 0 || pos + size > buf.length) break;
        const bytes = buf.subarray(pos, pos + size);
        pos += size;
        entry = { wire, bytes, str: asText(bytes) };
      } else if (wire === 5) {
        if (pos + 4 > buf.length) break;
        entry = { wire, num: buf.readUInt32LE(pos) };
        pos += 4;
      } else if (wire === 1) {
        if (pos + 8 > buf.length) break;
        entry = { wire, num: Number(buf.readBigUInt64LE(pos)) };
        pos += 8;
      } else {
        // 3/4 是已废弃的 group 类型，2 里的 wire 也可能出现未知值 —— 都停下
        break;
      }
    } catch {
      break;
    }

    if (!fields.has(fieldNo)) fields.set(fieldNo, []);
    fields.get(fieldNo).push(entry);
  }

  return fields;
}

/** 取第一个数值字段 */
export function pbNum(fields, fieldNo, fallback = 0) {
  const list = fields?.get(fieldNo);
  if (!list?.length || list[0].num == null) return fallback;
  return list[0].num;
}

/** 取第一个文本字段 */
export function pbStr(fields, fieldNo, fallback = '') {
  const list = fields?.get(fieldNo);
  if (!list?.length) return fallback;
  return list[0].str ?? fallback;
}

/** 取第一个字节字段（嵌套消息用） */
export function pbBytes(fields, fieldNo) {
  const list = fields?.get(fieldNo);
  if (!list?.length || !list[0].bytes) return null;
  return list[0].bytes;
}

/** 取嵌套消息，递归解析 */
export function pbMsg(fields, fieldNo) {
  const bytes = pbBytes(fields, fieldNo);
  return bytes ? readPb(bytes) : null;
}

/** 取同一字段号的全部条目 */
export function pbList(fields, fieldNo) {
  return fields?.get(fieldNo) ?? [];
}

/** base64 → 字段映射。解码失败返回空 Map，调用方按"没解出内容"处理 */
export function decodeBase64Pb(base64) {
  try {
    return readPb(Buffer.from(String(base64 || ''), 'base64'));
  } catch {
    return new Map();
  }
}
