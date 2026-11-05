/**
 * 生成 PWA 图标（零依赖）。
 *
 * 为什么自己写 PNG 编码：整个项目的图形需求就是「一个图标 + 一张柱状图」，
 * 为它引 sharp / canvas 等于为了 4 个文件多背几十 MB 的原生依赖。
 * PNG 的最小可用子集（IHDR + IDAT + IEND，8 位 RGBA，无滤波）不到 60 行。
 *
 * 图案：深色底 + 一弯月（渔月）。用 3×3 超采样出抗锯齿边缘，
 * 因为图标会被放在桌面/任务栏上，硬锯齿一眼就看得出来。
 *
 * 用法：node server/tools/make-icons.mjs
 * 产物：web/icons/*.png（改了这个脚本或配色后重跑一次即可）
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(root, 'web', 'icons')

/* ────────────────────── 配色（和 web/tokens.css 同源） ────────────────────── */

const BG = [11, 13, 17] // --bg  #0b0d11
const MOON = [76, 141, 255] // --accent #4c8dff

/* ────────────────────── PNG 编码 ────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * @param {number} size 宽高（正方形）
 * @param {Buffer} rgba 长度 size*size*4
 */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：RGBA
  ihdr[10] = 0 // 压缩
  ihdr[11] = 0 // 滤波
  ihdr[12] = 0 // 隔行

  // 每行前面加一个滤波字节 0（None）。不滤波压得稍差，但代码少了 5 种分支
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ────────────────────── 画图 ────────────────────── */

/**
 * 画一弯月。
 *
 * `inset` 是"内容占画布的比例"：maskable 图标会被系统裁成圆形/方形，
 * 只保证中间 80% 可见，所以那几版要画得更小一点。
 */
function draw(size, { inset = 1 } = {}) {
  const px = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size / 2
  const rOuter = size * 0.3 * inset
  const rInner = size * 0.255 * inset
  const dx = size * 0.115 * inset
  const dy = -size * 0.045 * inset
  const SS = 3 // 每轴采样数
  const N = SS * SS

  const mix = (a, b, t) => Math.round(a + (b - a) * t)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let moonHits = 0
      let innerHits = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px0 = x + (sx + 0.5) / SS
          const py0 = y + (sy + 0.5) / SS
          const d1 = Math.hypot(px0 - cx, py0 - cy)
          if (d1 > rOuter) continue
          moonHits++
          // 挖掉的那个圆和月亮同心偏移，剩下的就是月牙
          if (Math.hypot(px0 - cx - dx, py0 - cy - dy) <= rInner) innerHits++
        }
      }

      const i = (y * size + x) * 4
      /**
       * 月牙 = 外圆减去挖掉的圆。
       * 挖掉的部分直接算成底色，而不是画一个深色圆 —— 深色圆会在底色上
       * 留下一圈可见的接缝，看起来像"一颗球叠在另一颗球上"，不像月亮。
       */
      const cover = Math.max(0, moonHits - innerHits) / N
      const rgb = [
        mix(BG[0], MOON[0], cover),
        mix(BG[1], MOON[1], cover),
        mix(BG[2], MOON[2], cover),
      ]

      px[i] = rgb[0]
      px[i + 1] = rgb[1]
      px[i + 2] = rgb[2]
      px[i + 3] = 255
    }
  }

  return px
}

/* ────────────────────── 输出 ────────────────────── */

const TARGETS = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  // maskable 会被裁成各种形状，内容收进中间 80%
  { file: 'icon-maskable-512.png', size: 512, inset: 0.78 },
  { file: 'apple-touch-icon-180.png', size: 180 },
]

mkdirSync(outDir, { recursive: true })

for (const t of TARGETS) {
  const png = encodePng(t.size, draw(t.size, t))
  writeFileSync(join(outDir, t.file), png)
  console.log(`${t.file}  ${t.size}×${t.size}  ${(png.length / 1024).toFixed(1)} KB`)
}
