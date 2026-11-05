/**
 * 事件日志：append-only JSONL，按「房间 + 日期」分片。
 *
 * 设计要点（对应决策记录 D2）：
 *
 * 1. **日志是事实，不是缓存。** 写入成功才算这个事件发生过。
 *    所有统计都由 readAll() 重放得出，不存在"内存算着、定时存一下"的路径。
 *
 * 2. **seq 单调递增，且是幂等的依据。**
 *    投影只处理 seq 大于已处理值的记录，所以同一批事件喂两遍结果不变。
 *    这是"重启不需要恢复逻辑"的根基 —— 重放天然幂等。
 *
 * 3. **按天分片，跨天自动换文件。**
 *    文件名是 YYYY-MM-DD.jsonl（本地时区），字符串排序即时间排序。
 *    好处：单文件不会无限增长，删旧数据只删文件。
 *
 * 4. **读取要能容忍半行。**
 *    进程被杀时最后一行可能只写了一半。读取时跳过无法解析的行，
 *    并在 stats() 的 badLines 里报出来 —— 静默吞掉坏数据比崩溃更危险。
 */

import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib'

/** roomId 会拼进路径，必须挡住 ../ 之类的穿越。 */
function assertRoomId(roomId) {
  if (typeof roomId !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(roomId)) {
    throw new Error(`非法的 roomId: ${String(roomId)}`)
  }
}

const pad = (n) => String(n).padStart(2, '0')

/** 本地时区的日期键，用于分片文件名。 */
export function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 读文件末尾若干行，用于恢复 seq 时避免把整个文件读进内存。
 * 只读最后 64KB —— 一行事件最多几百字节，足够覆盖最后几条。
 */
function readTailLines(file, want = 3) {
  const size = statSync(file).size
  if (size === 0) return []
  const len = Math.min(size, 64 * 1024)
  const buf = Buffer.alloc(len)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buf, 0, len, size - len)
  } finally {
    closeSync(fd)
  }
  return buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim())
    .slice(-want)
}

/**
 * 扫描整个分片，返回其中最大的 seq。
 * 只在尾部恢复失败时走这条路 —— 慢，但不会给出错误答案。
 * 归档过的分片（.gz）也能扫：先解压再按行看。
 */
function scanMaxSeq(shard) {
  let text
  try {
    const raw = readFileSync(shard.path)
    // gunzipSync 的第二个参数是 options 对象，传 'utf8' 会被忽略并返回 Buffer
    text = (shard.gz ? gunzipSync(raw) : raw).toString('utf8')
  } catch {
    return 0
  }
  let max = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (Number.isInteger(ev.seq) && ev.seq > max) max = ev.seq
    } catch {
      // 半行/坏行：跳过。seq 只增不减，少读一条不会让结果偏大
    }
  }
  return max
}

/** 把一段 JSONL 文本解析进 out，返回无法解析的行数。同步读取路径用。 */
function parseInto(text, out) {
  let bad = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (Number.isInteger(ev.seq)) out.push(ev)
      else bad++
    } catch {
      bad++
    }
  }
  return bad
}

export class EventLog {
  /**
   * @param {object} opts
   * @param {string} opts.root     日志根目录，例如 data/events
   * @param {string} opts.roomId   房间号
   * @param {number} [opts.keepDays] 保留多少天的明文分片，更早的归档成 .gz
   */
  constructor({ root, roomId, keepDays = 30 }) {
    assertRoomId(roomId)
    this.root = root
    this.roomId = roomId
    this.dir = join(root, roomId)
    this.keepDays = keepDays
    mkdirSync(this.dir, { recursive: true })
    /** 尾部恢复失败、走了全量扫描 —— 说明上次退出不干净，应当被上层报出来 */
    this._recoveredByScan = false
    /** readAll 时发现 seq 计数器偏小、被校准过几次 */
    this._seqRepaired = 0
    // 必须在上面两个标志之后调用：_recoverSeq 会写 _recoveredByScan
    this._seq = this._recoverSeq()
    this._appended = 0
    /**
     * 全量读取缓存：{ key, events }。
     *
     * 报表、付费用户榜、SC 待读、对账都会全量读一遍；直播中每点一次
     * 就要把同一批文件重新解析一遍，几千条时是几十毫秒、几万条时能到秒级。
     * 文件列表 + 每个分片的 size/mtime 不变就复用上一份结果。
     */
    this._readCache = null
    this._readCacheHits = 0
    this._readCacheMisses = 0
  }

  get lastSeq() {
    return this._seq
  }

  /**
   * 全部分片，按日期升序。归档过的也在里面。
   *
   * 一个房间的日志目录里**正常情况下**一天只有一种文件：
   * `YYYY-MM-DD.jsonl`（明文，正在写或还没到归档期）
   * `YYYY-MM-DD.jsonl.gz`（归档，只读）
   *
   * 但异常情况真的会发生：归档的顺序是「写 .gz → 解压校验 → 删明文」，
   * 如果进程正好在写完 .gz、还没删明文的时候被杀（断电、任务管理器结束进程），
   * 同一天就会**两种文件并存**。这时若按文件逐个读，这一天的事件会被读两遍 ——
   * 审计实测：2 条事件读出 4 条。
   *
   * 后果不是"统计翻倍"（投影按 seq 幂等，会跳掉重复的），而是更阴的两种：
   *   · `reconcile` 的独立求和路径会算成两倍 → **对账永远失败**，
   *     而对账失败一旦成为常态，真出问题时就没人看了；
   *   · 战报的"旧版 SC 金额偏低"警告条数翻倍。
   *
   * 所以这里按日期去重，一天只用一份。优先明文：它是可以直接 append 的那份，
   * 内容一定是 .gz 的超集（归档只挑保留期之外的日期，之后不会再有写入）。
   *
   * @returns {{path:string, day:string, gz:boolean}[]}
   */
  _shards() {
    if (!existsSync(this.dir)) return []
    /** @type {Map<string,{path:string, day:string, gz:boolean}>} */
    const byDay = new Map()
    const names = readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'))
      // 排序后同一天的明文（`...jsonl`）一定排在归档（`...jsonl.gz`）前面，
      // 所以下面遇到明文时用它覆盖掉可能已经放进去的归档
      .sort()

    for (const f of names) {
      const day = f.replace(/\.jsonl(\.gz)?$/, '')
      const shard = { path: join(this.dir, f), day, gz: f.endsWith('.gz') }
      const seen = byDay.get(day)
      if (!seen || seen.gz) byDay.set(day, shard)
    }

    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  }

  /** 同一天明文与归档并存的日期（说明上次归档没收干净，值得报出来） */
  duplicateDays() {
    if (!existsSync(this.dir)) return []
    const seen = new Map()
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.jsonl') && !f.endsWith('.jsonl.gz')) continue
      const day = f.replace(/\.jsonl(\.gz)?$/, '')
      seen.set(day, (seen.get(day) ?? 0) + 1)
    }
    return [...seen].filter(([, c]) => c > 1).map(([d]) => d).sort()
  }

  /** 只有明文分片（可以随机读尾部，用于 seq 恢复） */
  _jsonlShards() {
    return this._shards().filter((s) => !s.gz)
  }

  /**
   * 恢复 seq。
   *
   * 这里曾经有一个致命缺陷（审计发现）：只读最后一个文件的最后 3 行，
   * 读不出就返回 0。而返回 0 意味着 seq 从 1 重新计数，与磁盘上已有的事件
   * 撞号；投影的幂等判断（`seq <= lastSeq`）于是把**之后收到的全部事件**
   * 当成"已处理"丢掉 —— 整场统计从此不动，且不报任何错。
   * 这和二代"统计静默归零"是同一种病，只是入口不同。
   *
   * 所以恢复策略改成两级：
   *   1. 快路径：读最后一个文件的尾部（正常情况 1 次 read 解决）
   *   2. 慢路径：尾部读不出（半行、坏行、空文件、跨天文件损坏）
   *      → **全量扫描所有分片取最大 seq**，慢但一定对
   * 只有"文件确实一条合法事件都没有"时才返回 0。
   */
  _recoverSeq() {
    // 只要还剩明文分片，全局最大 seq 一定在明文里：归档只动过了保留期的
    // **旧日期**，而 seq 与时间同向增长。所以正常情况根本不用碰 gz。
    const plain = this._jsonlShards()
    if (plain.length > 0) {
      const tail = this._tailSeq(plain[plain.length - 1].path)
      if (tail > 0) return tail

      let max = 0
      for (const s of plain) max = Math.max(max, scanMaxSeq(s))
      if (max > 0) this._recoveredByScan = true
      return max
    }

    // 极端情况：所有分片都已归档（比如停了半年才再开）。
    // 没有明文可读尾部，只能解压归档全量扫 —— 慢，但"返回 0 让整场统计冻结"
    // 要昂贵得多。这条路径的存在本身就是对上面那句话的兜底。
    const all = this._shards()
    if (all.length === 0) return 0
    let max = 0
    for (const s of all) max = Math.max(max, scanMaxSeq(s))
    if (max > 0) this._recoveredByScan = true
    return max
  }

  /** 快速路径：最后一个文件的尾部找 seq。 */
  _tailSeq(file) {
    let lines
    try {
      lines = readTailLines(file, 3)
    } catch {
      return 0
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i])
        if (Number.isInteger(ev.seq) && ev.seq > 0) return ev.seq
      } catch {
        // 半行，继续往前找
      }
    }
    return 0
  }

  _fileFor(ts) {
    return join(this.dir, `${dayKey(ts)}.jsonl`)
  }

  /**
   * 追加一条事件。同步落盘 —— 正确性优先于吞吐：
   * 一场直播几千条，appendFileSync 的开销完全可以接受，
   * 而"写入后崩溃仍在"是这条链路唯一不能妥协的性质。
   *
   * @returns {object} 完整的事件对象（含 seq / id / ts）
   */
  append(type, payload = {}, meta = {}) {
    if (typeof type !== 'string' || !type) throw new Error('type 不能为空')
    const ts = Number.isFinite(meta.ts) ? meta.ts : Date.now()
    const seq = ++this._seq
    const event = {
      seq,
      id: meta.id ?? `e${this.roomId}-${seq}`,
      ts,
      roomId: this.roomId,
      type,
      source: meta.source ?? 'system',
      payload,
    }
    appendFileSync(this._fileFor(ts), JSON.stringify(event) + '\n', 'utf8')
    this._appended++
    // 新事件一定让旧缓存失效（key 里的 size 也会变，这里只是不依赖它）
    this._readCache = null
    return event
  }

  /** 批量追加，返回事件数组。 */
  appendMany(list) {
    return list.map((it) => this.append(it.type, it.payload, it.meta ?? it))
  }

  /**
   * 读取全部事件，按 seq 升序。
   * 无法解析的行会被跳过并计数，不抛异常 —— 半行不该让整个房间不可用。
   *
   * ⚠️ 同步版。**不要在新代码里用它**（尤其不要在 HTTP 处理里）：
   * 它会把整个文件读进内存再解析，期间事件循环完全停住，
   * 弹幕、心跳、WS 推送全部排队。用 `readAllAsync()`。
   * 保留它只是因为启动时的重放需要一个确定性的同步点。
   */
  /** 缓存键：分片列表 + 每个文件的 size/mtime。任何一次追加/归档都会变 */
  _cacheKey() {
    try {
      return this._shards()
        .map((s) => {
          const st = statSync(s.path)
          return `${s.day}:${st.size}:${st.mtimeMs}`
        })
        .join('|')
    } catch {
      // stat 失败（归档/删除并发）时不缓存，宁可多读一次
      return ''
    }
  }

  _takeCache(key) {
    if (key && this._readCache?.key === key) {
      this._readCacheHits++
      // 返回副本：调用方可能排序/过滤，不能让他们改到缓存里的数组
      return this._readCache.events.slice()
    }
    this._readCacheMisses++
    return null
  }

  _putCache(key, events) {
    // 存副本：miss 路径下这个数组会直接返回给调用方，不能和缓存共用一份
    if (key) this._readCache = { key, events: events.slice() }
  }

  readAll() {
    const keyBefore = this._cacheKey()
    const cached = this._takeCache(keyBefore)
    if (cached) return cached

    const out = []
    let badLines = 0
    for (const shard of this._shards()) {
      const raw = readFileSync(shard.path)
      const text = (shard.gz ? gunzipSync(raw) : raw).toString('utf8')
      badLines += parseInto(text, out)
    }
    out.sort((a, b) => a.seq - b.seq)
    this._afterRead(out, badLines)
    // 读取期间又有追加时 key 会变：这份结果不完整，不能进缓存
    if (this._cacheKey() === keyBefore) this._putCache(keyBefore, out)
    return out
  }

  /**
   * 同 readAll，但逐行流式读取，每读一行都让出一次事件循环。
   *
   * 为什么必须有两个版本：`/api/reconcile` 会全量重算，几万条时同步读
   * 能让整个服务卡住半秒以上 —— 而它偏偏是个"我随手点一下确认"的按钮，
   * 用户点得越随意，卡顿出现得越随机。
   *
   * 代价：内存里仍然要留住全部事件对象（对账需要两条独立求和路径）。
   * 想要更省就得把 reconcile 也改成流式 reduce，那是另一件事。
   */
  async readAllAsync() {
    const keyBefore = this._cacheKey()
    const cached = this._takeCache(keyBefore)
    if (cached) return cached

    const out = []
    let badLines = 0
    for (const shard of this._shards()) {
      const fileStream = createReadStream(shard.path)
      // 归档分片是 gzip：先解压再按行读。透明在这里，调用方不需要知道
      // 某一天的文件是明文还是压缩的 —— 否则每个读日志的地方都要判一次。
      const input = shard.gz ? fileStream.pipe(createGunzip()) : fileStream
      if (shard.gz) input.setEncoding('utf8')
      else fileStream.setEncoding('utf8')

      const rl = createInterface({ input, crlfDelay: Infinity })
      try {
        for await (const raw of rl) {
          const line = raw.trim()
          if (!line) continue
          try {
            const ev = JSON.parse(line)
            if (Number.isInteger(ev.seq)) out.push(ev)
            else badLines++
          } catch {
            badLines++
          }
        }
      } finally {
        rl.close()
        input.destroy()
        fileStream.destroy()
      }
    }
    out.sort((a, b) => a.seq - b.seq)
    this._afterRead(out, badLines)
    if (this._cacheKey() === keyBefore) this._putCache(keyBefore, out)
    return out
  }

  /** 两条读取路径共用的收尾：记坏行数、校准 seq 计数器。 */
  _afterRead(out, badLines) {
    this._badLines = badLines

    // 最后一道防线：读完全部日志后，seq 计数器一定不小于磁盘上的最大值。
    // 这样即便构造时恢复算法被什么意外绕过了，也不会写出撞号的 seq。
    if (out.length > 0) {
      const max = out[out.length - 1].seq
      if (max > this._seq) {
        this._seq = max
        this._seqRepaired = (this._seqRepaired ?? 0) + 1
      }
    }
  }

  /** 只读 seq 大于 afterSeq 的事件。 */
  readFrom(afterSeq = 0) {
    return this.readAll().filter((e) => e.seq > afterSeq)
  }

  /** 日志自身的体检数据，供对账使用。 */
  stats() {
    const shards = this._shards()
    let bytes = 0
    for (const s of shards) bytes += statSync(s.path).size
    return {
      roomId: this.roomId,
      files: shards.length,
      // day 是从文件名切出来的，不是从绝对路径 —— Windows 的路径是反斜杠，
      // 用 `/^.*\//` 匹配不到，会把整个绝对路径当成"日期"输出
      days: shards.map((s) => s.day),
      /** 已归档（.gz）的分片数 */
      archived: shards.filter((s) => s.gz).length,
      /**
       * 同一天明文与归档并存的日期。正常应为空 ——
       * 非空说明上次归档在"写完 .gz、还没删明文"之间被打断，
       * 虽然读取已经按日期去重（不会重算），但磁盘上留着两份白占空间。
       */
      duplicateDays: this.duplicateDays(),
      /** 保留窗口（天），明文分片超过它就会被归档 */
      keepDays: this.keepDays,
      bytes,
      lastSeq: this._seq,
      appended: this._appended,
      badLines: this._badLines ?? 0,
      /** 上次退出不干净：尾部读不出，靠全量扫描才恢复的 seq */
      recoveredByScan: this._recoveredByScan,
      /** readAll 校准过几次 seq 计数器（正常应为 0） */
      seqRepaired: this._seqRepaired,
      /** 全量读取缓存命中/未命中次数（排查"为什么还是慢"用） */
      readCacheHits: this._readCacheHits ?? 0,
      readCacheMisses: this._readCacheMisses ?? 0,
    }
  }

  /**
   * 把超过保留窗口的明文分片压成 .gz，**校验通过后**才删原件。
   *
   * 为什么需要它：日志是 append-only 的，一天一个文件，从不清理 ——
   * 一年下来几百 MB，而 99% 的用途只是"上周三那场怎么样"。
   * 但删是绝对不能删的：日志是唯一事实来源，删了就等于把历史账本烧了。
   * 所以只压缩，不删除，读取时透明解压。
   *
   * 三个安全点：
   * 1. **只动保留窗口之外的**（按日期键比较，含今天的那份永远不会被碰）
   * 2. **压完立刻解压比对字节**，不一致就删掉 .gz 保留原件 ——
   *    宁可占空间，也不能出现"文件看起来在，内容却打不开"
   * 3. **不删 .gz 之外的东西**，也不递归、不按通配符删
   *
   * @returns {{archived:{day:string,bytes:number,packed:number}[], skipped:number, cutoffDay:string}}
   */
  archiveOld({ keepDays = this.keepDays, now = Date.now() } = {}) {
    const days = Number(keepDays)
    if (!Number.isFinite(days) || days < 1) {
      return { archived: [], skipped: 0, cutoffDay: '', reason: 'keepDays 必须 >= 1' }
    }
    const cutoffDay = dayKey(now - days * 86400000)
    const archived = []
    let skipped = 0

    for (const shard of this._jsonlShards()) {
      if (shard.day >= cutoffDay) {
        skipped++
        continue
      }
      try {
        const raw = readFileSync(shard.path)
        const packed = gzipSync(raw, { level: 9 })
        const gzPath = shard.path + '.gz'
        writeFileSync(gzPath, packed)

        // 校验：解压回来必须与原件逐字节相同，否则说明压缩过程出了问题
        const back = gunzipSync(readFileSync(gzPath))
        if (!back.equals(raw)) {
          unlinkSync(gzPath)
          skipped++
          continue
        }
        unlinkSync(shard.path)
        archived.push({ day: shard.day, bytes: raw.length, packed: packed.length })
      } catch {
        // 单个文件归档失败不该影响其他文件，也不该让启动失败
        skipped++
      }
    }

    // 归档改变了分片列表；即使某个文件没动，key 也可能只是碰巧相同
    if (archived.length) this._readCache = null
    return { archived, skipped, cutoffDay }
  }

  close() {
    // 占位：同步写入模式下无需 flush。保留接口，便于日后换成批量写。
  }
}

export default EventLog
