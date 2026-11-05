/**
 * 二维码编码器（零依赖，字节模式，纠错级别 M，版本 1–10）。
 *
 * 为什么自己写：本地工具不能让"断网就扫不了码"成为可能，
 * 也不想为一个 400 行的算法引一个 npm 包。
 *
 * 只支持字节模式 + M 级，理由：
 *   - 登录 URL 全是 ASCII，字节模式足够，不需要数字/字母数字优化
 *   - M 级（15% 纠错）是手机屏幕扫码的最佳平衡点，L 级太脆，Q/H 级容量太小
 *   - 版本 1–10 最大可装 213 字节，B站登录 URL 实测约 100–120 字节
 *
 * 正确性保障：tools/check-qr.test.mjs 会拿二代的 qrcode 库当对照，
 * 对每个版本、每个掩码逐位比对模块矩阵。画错一位，测试立刻红。
 */

/** 纠错级别 M 的码字规格：[总码字, 每块纠错码字, [[块数, 每块数据码字], ...]] */
const SPEC_M = {
  1: [26, 10, [[1, 16]]],
  2: [44, 16, [[1, 28]]],
  3: [70, 26, [[1, 44]]],
  4: [100, 18, [[2, 32]]],
  5: [134, 24, [[2, 43]]],
  6: [172, 16, [[4, 27]]],
  7: [196, 18, [[4, 31]]],
  8: [242, 22, [[2, 38], [2, 39]]],
  9: [292, 22, [[3, 36], [2, 37]]],
  10: [346, 26, [[4, 43], [1, 44]]],
};

/** 对齐图形中心坐标（版本 → 坐标列表） */
const ALIGN_POS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

export const MIN_VERSION = 1;
export const MAX_VERSION = 10;

/* ---------- GF(256) 与 Reed-Solomon ---------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function initGalois() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // QR 用的本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gmul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    for (let j = 0; j < b.length; j++) out[i + j] ^= gmul(a[i], b[j]);
  }
  return out;
}

/** 生成多项式：(x-α^0)(x-α^1)...(x-α^(n-1))，最高次在前 */
function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) g = polyMul(g, [1, EXP[i]]);
  return g;
}

/** 对一块数据算纠错码字，返回长度 ecLen 的余数 */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (!factor) continue;
    for (let j = 1; j <= ecLen; j++) res[i + j] ^= gmul(gen[j], factor);
  }
  return res.slice(data.length);
}

/* ---------- 位缓冲 ---------- */

class BitBuffer {
  constructor() {
    /** @type {number[]} */
    this.bits = [];
  }
  /** 写入 value 的低 len 位，高位在前 */
  put(value, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
  /** 转成字节数组（长度必须是 8 的倍数） */
  toBytes() {
    const out = new Uint8Array(this.bits.length >>> 3);
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >>> 3] |= 0x80 >>> (i & 7);
    }
    return out;
  }
}

/* ---------- 规格查询 ---------- */

function specOf(version) {
  const s = SPEC_M[version];
  if (!s) throw new Error(`不支持的二维码版本：${version}`);
  const [total, ec, groups] = s;
  let data = 0;
  let blocks = 0;
  for (const [count, per] of groups) {
    data += count * per;
    blocks += count;
  }
  // 自检：数据 + 纠错 必须等于总码字，否则表格写错了
  if (data + blocks * ec !== total) {
    throw new Error(`二维码版本 ${version} 的码字表不自洽：${data}+${blocks}*${ec} ≠ ${total}`);
  }
  return { total, ec, groups, dataCodewords: data, blockCount: blocks };
}

/** 字节模式下字符计数指示符的位数 */
function cciBits(version) {
  return version <= 9 ? 8 : 16;
}

/** 该版本能装多少字节（字节模式） */
export function byteCapacity(version) {
  const { dataCodewords } = specOf(version);
  return Math.floor((dataCodewords * 8 - 4 - cciBits(version)) / 8);
}

/** 选最小可容纳的版本 */
export function pickVersion(byteLen, minVersion = MIN_VERSION, maxVersion = MAX_VERSION) {
  for (let v = minVersion; v <= maxVersion; v++) {
    if (byteCapacity(v) >= byteLen) return v;
  }
  throw new Error(
    `内容过长：${byteLen} 字节，版本 ${maxVersion}（M 级）最多 ${byteCapacity(maxVersion)} 字节`,
  );
}

/* ---------- 主流程 ---------- */

/**
 * 生成二维码。
 *
 * @param {string} text
 * @param {{version?:number, mask?:number}} [options]
 *   version 0 = 自动；mask -1 = 自动（按惩罚分选最优）
 * @returns {{version:number, size:number, mask:number, modules:Uint8Array,
 *            at:(row:number,col:number)=>number, isFunction:Uint8Array}}
 */
export function encodeQr(text, options = {}) {
  const { version: forcedVersion = 0, mask: forcedMask = -1 } = options;

  const bytes = new TextEncoder().encode(String(text));
  const version = forcedVersion || pickVersion(bytes.length);
  const spec = specOf(version);

  const data = buildDataCodewords(bytes, version, spec);
  const allCodewords = interleave(data, spec);
  const size = version * 4 + 17;

  // 功能图形只和版本有关，算一次，8 个掩码复用
  const base = buildFunctionPattern(version, size);

  let best = null;
  const maskList = forcedMask >= 0 ? [forcedMask] : [0, 1, 2, 3, 4, 5, 6, 7];

  for (const mask of maskList) {
    const modules = new Uint8Array(base.modules); // 拷贝功能图形
    placeData(modules, base.isFunction, size, allCodewords);
    applyMask(modules, base.isFunction, size, mask);
    writeFormat(modules, size, mask);
    writeVersion(modules, size, version);
    const penalty = score(modules, size);
    if (!best || penalty < best.penalty) best = { mask, modules, penalty };
  }

  const modules = best.modules;
  return {
    version,
    size,
    mask: best.mask,
    modules,
    isFunction: base.isFunction,
    at: (row, col) => modules[row * size + col],
  };
}

/** 文本 → 数据码字（模式头 + 长度 + 内容 + 终止符 + 填充） */
function buildDataCodewords(bytes, version, spec) {
  const capBits = spec.dataCodewords * 8;
  const buf = new BitBuffer();

  buf.put(0b0100, 4); // 字节模式
  buf.put(bytes.length, cciBits(version));
  for (const b of bytes) buf.put(b, 8);

  // 终止符：最多 4 个 0，不足则全补
  const remain = capBits - buf.length;
  if (remain < 0) throw new Error('内容超出该版本容量');
  buf.put(0, Math.min(4, remain));

  // 补齐到字节边界
  while (buf.length % 8 !== 0) buf.put(0, 1);

  const out = Array.from(buf.toBytes());
  // 交替填充 0xEC / 0x11，这是标准规定的填充字节
  let pad = 0xec;
  while (out.length < spec.dataCodewords) {
    out.push(pad);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return out;
}

/** 分块 → 每块算纠错 → 按列交织 */
function interleave(dataCodewords, spec) {
  /** @type {{data:number[], ec:number[]}[]} */
  const blocks = [];
  let offset = 0;
  for (const [count, per] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const chunk = dataCodewords.slice(offset, offset + per);
      offset += per;
      blocks.push({ data: chunk, ec: Array.from(rsEncode(Uint8Array.from(chunk), spec.ec)) });
    }
  }

  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

/**
 * 画功能图形：定位图形、分隔符、时序、对齐、暗模块、格式信息占位。
 * 返回的 isFunction 用来标记"这些格子在放数据/掩码时要跳过"。
 */
function buildFunctionPattern(version, size) {
  const modules = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);

  const set = (row, col, val) => {
    modules[row * size + col] = val;
    isFunction[row * size + col] = 1;
  };

  // 1) 三个定位图形 + 分隔符（8×8 区域，含外围一圈白）
  for (const [r, c] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        // 切比雪夫距离：3 = 外框（黑），2 = 白环，<=1 = 中心 3×3（黑）
        const d = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        set(rr, cc, inside && (d === 3 || d <= 1) ? 1 : 0);
      }
    }
  }

  // 2) 时序图形：第 6 行与第 6 列，从 8 到 size-9，黑白交替
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    set(6, i, v);
    set(i, 6, v);
  }

  // 3) 对齐图形（5×5，避开定位图形所在的三个角落）
  const pos = ALIGN_POS[version] || [];
  for (const r of pos) {
    for (const c of pos) {
      // 与定位图形重叠的位置要跳过
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const d = Math.max(Math.abs(dr), Math.abs(dc));
          set(r + dr, c + dc, d === 2 || d === 0 ? 1 : 0);
        }
      }
    }
  }

  // 4) 固定黑点：格式信息旁边那一格永远是黑的
  set(size - 8, 8, 1);

  // 5) 格式信息区先占位（值在 writeFormat 里填）
  for (let i = 0; i <= 8; i++) {
    if (!isFunction[8 * size + i]) set(8, i, 0);
    if (!isFunction[i * size + 8]) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, 0);
    set(8, size - 1 - i, 0);
  }
  set(size - 8, 8, 1);
  // 注意：(8, size-8) 不是固定黑点，它是第二份格式信息的最后一位，
  // 由 writeFormat 填。曾在这里误设成 1，导致单模块永久错。

  // 6) 版本信息区（版本 ≥ 7 才有）：6×3 两处
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(b, a, 0);
      set(a, b, 0);
    }
  }

  return { modules, isFunction };
}

/** 按之字形把码字填进矩阵（避开功能模块） */
function placeData(modules, isFunction, size, codewords) {
  const totalBits = codewords.length * 8;
  let i = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 第 6 列是时序图形，跳过
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        const idx = row * size + col;
        if (isFunction[idx]) continue;
        if (i < totalBits) {
          modules[idx] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
          i++;
        } else {
          modules[idx] = 0; // 剩余位（remainder bits）填 0
        }
      }
    }
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(modules, isFunction, size, mask) {
  const fn = MASKS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const idx = r * size + c;
      if (isFunction[idx]) continue;
      if (fn(r, c)) modules[idx] ^= 1;
    }
  }
}

/** 格式信息：BCH(15,5) + 固定掩码 0x5412，写两份 */
function writeFormat(modules, size, mask) {
  const ecBitsM = 0; // M 级
  const data = (ecBitsM << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const bit = (i) => (bits >>> i) & 1;

  // 第一份：围左上定位图形
  for (let i = 0; i <= 5; i++) modules[i * size + 8] = bit(i);
  modules[7 * size + 8] = bit(6);
  modules[8 * size + 8] = bit(7);
  modules[8 * size + 7] = bit(8);
  for (let i = 9; i < 15; i++) modules[8 * size + (14 - i)] = bit(i);

  // 第二份：右上 + 左下
  for (let i = 0; i < 8; i++) modules[8 * size + (size - 1 - i)] = bit(i);
  for (let i = 8; i < 15; i++) modules[(size - 15 + i) * size + 8] = bit(i);
}

/**
 * 版本信息：BCH(18,6)，版本 ≥ 7 才有，写两份（右上、左下）。
 * 只写 6 位版本号看不出区别，但缺了这 18 位，扫码器认不出大版本。
 */
function writeVersion(modules, size, version) {
  if (version < 7) return;

  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;

  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b * size + a] = bit; // 右上
    modules[a * size + b] = bit; // 左下
  }
}

/**
 * 惩罚分（标准四条规则），用来挑最优掩码。
 * 分数越低越好 —— 目的是让图案"不像二维码"（减少大片同色和假定位图形），
 * 扫码器更容易定位。
 */
function score(modules, size) {
  const at = (r, c) => modules[r * size + c];
  let s = 0;

  // N1：行/列上连续 5 个以上同色
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      let prev = horizontal ? at(i, 0) : at(0, i);
      for (let j = 1; j < size; j++) {
        const v = horizontal ? at(i, j) : at(j, i);
        if (v === prev) {
          run++;
        } else {
          if (run >= 5) s += 3 + (run - 5);
          run = 1;
          prev = v;
        }
      }
      if (run >= 5) s += 3 + (run - 5);
    }
  }

  // N2：2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) s += 3;
    }
  }

  // N3：形似定位图形的 1:1:3:1:1 序列（前后带 4 个白）
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      let h1 = true;
      let h2 = true;
      let v1 = true;
      let v2 = true;
      for (let k = 0; k < 11; k++) {
        const h = at(i, j + k);
        const v = at(j + k, i);
        if (h !== pat1[k]) h1 = false;
        if (h !== pat2[k]) h2 = false;
        if (v !== pat1[k]) v1 = false;
        if (v !== pat2[k]) v2 = false;
      }
      if (h1) s += 40;
      if (h2) s += 40;
      if (v1) s += 40;
      if (v2) s += 40;
    }
  }

  // N4：黑白比例偏离 50%
  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const total = size * size;
  s += Math.floor(Math.abs((dark * 100) / total - 50) / 5) * 10;

  return s;
}
