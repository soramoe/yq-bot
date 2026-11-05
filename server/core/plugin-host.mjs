/**
 * 插件宿主：加载、校验、分发、仲裁。
 *
 * ## 为什么要"仲裁"
 *
 * 二代最脏的一处设计：礼物答谢插件想知道"盲盒插件会不会也播报这个礼物"，
 * 于是直接去读盲盒插件的配置，自己复算一遍 minProfit。
 * 结果两个插件的配置谁先改都会让判断失效，而且盲盒插件改了逻辑
 * 答谢插件这边不会知道 —— 这种耦合完全查不出来。
 *
 * 三代的做法：插件在 manifest 里声明 `claims`（我对哪类事件感兴趣、优先级多少），
 * 内核按优先级依次询问，**第一个说"我来处理"的赢，后面的不再调用**。
 * 插件之间零引用，也不需要读对方的配置。
 *
 * ## 为什么加载顺序不重要
 *
 * 二代的插件按字母序加载，`blind` 恰好在 `gift` 前面 —— 纯属巧合。
 * 三代由 claims 优先级决定谁先看到事件，和文件名字母序无关。
 *
 * ## 插件契约
 *
 * ```js
 * export default {
 *   id: 'welcome',
 *   onEvent(ctx, ev)  { return true }  // 返回 true = 这条事件我处理了
 *   onEdge(ctx, edge, ev) {}           // live_started / live_ended
 *   onStart(ctx) {}  onStop(ctx) {}
 * }
 * ```
 *
 * ctx 里只有插件的**能力**，没有后门：
 *   say()      → 请求内核发送（受闸门约束，插件无法绕过）
 *   config     → 这个插件自己的配置
 *   state      → 只读的房间状态
 *   log        → 带插件名前缀的日志
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { EVENT, isEventType, EVENT_LABEL } from './events.mjs'
import { render } from './template.mjs'

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * 插件投递队列的上界。
 *
 * 队列存在的理由是**顺序**，不是为了缓冲：插件大多有内部状态
 * （连击计数、冷却表、盈亏累计），两条事件并发进去就会把状态搅乱 ——
 * 而 giteway 那边一旦 await，收包线程立刻往下走，并发是默认行为，不是意外。
 *
 * 上界存在的理由是**反压**：某个插件卡住（比如 SC 在等闸门槽位，最多 5 秒），
 * 后面的全排在队里。排到 5000 条说明插件已经病态，这时丢新事件比无限吃内存好。
 * 但**必须留下痕迹** —— 丢弃会计数并写 warn，不允许静默。
 */
const MAX_QUEUE = 5000

/** manifest 里允许出现的配置控件类型。前端按这个渲染，新增插件前端零改动。 */
export const FIELD_TYPES = new Set([
  'text',
  'number',
  'textarea',
  'switch',
  'select',
  'lines',
  'list',
  'color',
])

/**
 * 校验 manifest。返回问题列表，空数组表示通过。
 * 这里要严格 —— manifest 写错了应该在启动时就报出来，
 * 而不是等运行到某个事件才发现插件没生效。
 *
 * @param {any} m
 * @param {string} [expectId] 目录名，用于校验 id 一致性
 */
export function validateManifest(m, expectId) {
  const errs = []
  if (!m || typeof m !== 'object') return ['manifest 不是对象']

  if (typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(m.id)) {
    errs.push('id 必须是小写字母开头的 2–31 位 a-z0-9-')
  }
  if (expectId && m.id !== expectId) {
    errs.push(`id（${m.id}）与目录名（${expectId}）不一致`)
  }
  if (typeof m.name !== 'string' || !m.name) errs.push('缺少 name')
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) {
    errs.push('version 必须是 x.y.z')
  }

  if (m.claims !== undefined) {
    if (!m.claims || typeof m.claims !== 'object') {
      errs.push('claims 必须是对象，形如 { "ENTER": 100 }')
    } else {
      for (const [type, prio] of Object.entries(m.claims)) {
        if (type !== '*' && !isEventType(type)) {
          errs.push(`claims 里有未知事件类型：${type}`)
        }
        if (!Number.isFinite(prio)) errs.push(`claims.${type} 必须是数字`)
      }
    }
  }

  if (m.config !== undefined && !Array.isArray(m.config)) {
    errs.push('config 必须是数组')
  } else if (Array.isArray(m.config)) {
    const seen = new Set()
    for (const f of m.config) {
      if (!f || typeof f !== 'object') {
        errs.push('config 里有非对象项')
        continue
      }
      if (typeof f.key !== 'string' || !f.key) errs.push('config 项缺少 key')
      else if (seen.has(f.key)) errs.push(`config 的 key 重复：${f.key}`)
      else seen.add(f.key)

      if (!FIELD_TYPES.has(f.type)) errs.push(`config.${f.key} 的 type 不认识：${f.type}`)
      if (typeof f.label !== 'string' || !f.label) errs.push(`config.${f.key} 缺少 label`)
    }
  }

  return errs
}

/** 把 manifest 的 config 定义展开成一份默认配置 */
export function defaultsOf(manifest) {
  const out = {}
  for (const f of manifest.config ?? []) {
    out[f.key] = f.default !== undefined ? f.default : defaultForType(f.type)
  }
  return out
}

function defaultForType(type) {
  switch (type) {
    case 'switch':
      return false
    case 'number':
      return 0
    case 'lines':
    case 'list':
      return []
    default:
      return ''
  }
}

/** 按 manifest 的类型约束，把外部传进来的值收敛到合法范围 */
export function coerceConfig(manifest, raw = {}) {
  const out = defaultsOf(manifest)
  for (const f of manifest.config ?? []) {
    if (!Object.prototype.hasOwnProperty.call(raw, f.key)) continue
    const v = raw[f.key]
    switch (f.type) {
      case 'switch':
        out[f.key] = Boolean(v)
        break
      case 'number': {
        let n = Number(v)
        if (!Number.isFinite(n)) n = out[f.key]
        if (Number.isFinite(f.min) && n < f.min) n = f.min
        if (Number.isFinite(f.max) && n > f.max) n = f.max
        out[f.key] = n
        break
      }
      case 'lines':
        out[f.key] = Array.isArray(v)
          ? v.map((x) => String(x).trim()).filter(Boolean)
          : String(v ?? '')
              .split('\n')
              .map((x) => x.trim())
              .filter(Boolean)
        break
      case 'list':
        out[f.key] = Array.isArray(v) ? v : []
        break
      default:
        out[f.key] = v === null || v === undefined ? '' : String(v)
    }
  }
  return out
}

export class PluginHost {
  /**
   * @param {object} opts
   * @param {string} opts.dir       插件根目录
   * @param {object} [opts.log]
   * @param {Function} [opts.say]   内核发送入口（已受闸门约束）
   * @param {Function} [opts.getState] 返回房间状态快照（只读）
   * @param {object} [opts.configs]  { pluginId: 用户配置 }
   * @param {object} [opts.roster]   观众簿（只读使用；不存在时插件要能降级）
   * @param {object} [opts.speakers] 最近说过话的人（只读；可选）
   */
  constructor({
    dir,
    log = SILENT_LOG,
    say = null,
    getState = null,
    configs = {},
    enabled = {},
    roster = null,
    speakers = null,
    /**
     * 沙盒用：每次加载都强制一份新的插件模块实例。
     *
     * 为什么必须有：ESM 按 **URL** 缓存，同一个 plugin.mjs 第二次 import
     * 拿到的是同一个模块对象 —— 而 welcome 的冷却表、gift 的连击计数
     * 都挂在模块级。沙盒若复用，就会拿生产状态去试跑：结果不准，
     * 还会反过来把正在播的那一场搅乱。
     */
    cacheBust = false,
  }) {
    this.dir = dir
    this.log = log
    this.sayFn = say
    this.getState = getState
    this.userConfigs = configs
    /**
     * 用户手动关掉的插件。
     *
     * 与 manifest 里的 `config.enabled` 是**两件事**：
     *   - config.enabled 是插件自己的业务开关（"欢迎功能开不开"）
     *   - 这里是宿主级的"这个插件整个不参与"
     * 分开的理由：插件被宿主禁掉时，不该顺手把用户的配置改成 false ——
     * 再启用时用户会发现自己的设置被动了。
     */
    this.userEnabled = enabled
    this.cacheBust = cacheBust
    /**
     * 观众簿。内核提供的**事实**，不是能力 —— 插件只能看，不能改。
     * 记账（mark）由 room-runner 在事件入库时统一做，插件无从插手：
     * 否则插件被禁用一次，观众簿就断更一段，而且没人会发现。
     */
    this.roster = roster
    /** 最近说过话的人：只读，用于判断"此刻还在不在房间里" */
    this.speakers = speakers

    /** @type {Map<string, object>} id → 已加载的插件条目 */
    this.plugins = new Map()
    this.errors = []

    /** 串行投递队列（见 MAX_QUEUE 的注释：为了顺序，顺带反压） */
    this._queue = []
    this._pumping = false
    /** 队列满而被丢弃的事件数 —— 非 0 就说明有插件卡死了 */
    this.dropped = 0
  }

  /**
   * 扫描并加载全部插件。
   * 单个插件坏了不影响其他的 —— 直播场景下，"少一个插件"远好过"整个起不来"。
   */
  async load() {
    this.plugins.clear()
    this.errors = []

    if (!existsSync(this.dir)) {
      this.log.warn(`插件目录不存在：${this.dir}`)
      return this
    }

    const dirs = readdirSync(this.dir)
      .filter((name) => {
        const p = join(this.dir, name)
        return statSync(p).isDirectory() && existsSync(join(p, 'manifest.json'))
      })
      .sort()

    for (const name of dirs) {
      try {
        await this._loadOne(name)
      } catch (err) {
        this.errors.push({ id: name, message: err.message })
        this.log.error(`插件 ${name} 加载失败：${err.message}`)
      }
    }

    this.log.info(
      `插件已加载 ${this.plugins.size} 个` +
        (this.errors.length ? `，${this.errors.length} 个失败` : ''),
    )
    return this
  }

  async _loadOne(name) {
    const base = join(this.dir, name)
    const manifestPath = join(base, 'manifest.json')

    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      throw new Error(`manifest.json 解析失败：${err.message}`)
    }

    const errs = validateManifest(manifest, name)
    if (errs.length) throw new Error(`manifest 不合法：${errs.join('；')}`)

    const entryPath = ['plugin.mjs', 'plugin.js', 'index.mjs']
      .map((f) => join(base, f))
      .find((p) => existsSync(p))
    if (!entryPath) throw new Error('找不到 plugin.mjs')

    // cacheBust：沙盒要一份全新的模块实例（见构造函数注释）
    const href = pathToFileURL(entryPath).href
    const url = this.cacheBust
      ? `${href}?sandbox=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : href
    const mod = await import(url)
    const impl = mod.default ?? mod
    if (!impl || typeof impl !== 'object') throw new Error('plugin.mjs 必须默认导出一个对象')

    this.plugins.set(manifest.id, {
      manifest,
      impl,
      dir: base,
      config: coerceConfig(manifest, this.userConfigs[manifest.id] ?? {}),
      // 只有明确存过 false 才算关；没存过（含旧配置文件）一律按启用
      enabled: this.userEnabled[manifest.id] !== false,
      /**
       * 每个宿主 × 每个插件独有的一小块存储。
       *
       * 为什么必须有：ESM 按 URL 缓存，同一个 plugin.mjs 在本进程里
       * **只有一个模块对象** —— 插件把状态写成 `this._last = new Map()`
       * （this 指那个模块对象）时，两个房间的两份宿主会共用同一份状态。
       * 单房间时看不出来，一旦上多房间（Q4）就会出现"A 房间回了，B 房间不回"、
       * "A 的冷却挡住 B"这类**不报错**的串味。
       *
       * 插件要放跨事件的状态，就放 ctx.scratch，别放模块对象。
       */
      scratch: Object.create(null),
      stats: { events: 0, claimed: 0, sent: 0, errors: 0, lastError: '' },
    })
  }

  /** 这个插件自己的上下文。插件拿不到 EventLog、拿不到 send，只能请求。 */
  _ctx(id) {
    const entry = this.plugins.get(id)
    // 必须显式捕获：`get state()` 是对象字面量里的方法，
    // 里面的 `this` 指的是**这个 ctx 对象**，不是宿主。
    // 之前写成 `this.getState` 的判断永远为 false，于是 ctx.state 恒为 null ——
    // 而且不报错：所有用 `ctx.state?.roomId` 的地方都静默拿到 undefined。
    const host = this

    const log = {
      debug: (...a) => this.log.debug?.(`[${id}]`, ...a),
      info: (...a) => this.log.info?.(`[${id}]`, ...a),
      warn: (...a) => this.log.warn?.(`[${id}]`, ...a),
      error: (...a) => this.log.error?.(`[${id}]`, ...a),
    }

    return {
      /**
       * 请求说一句话。插件无法绕过闸门、dryRun、去重。
       *
       * **返回的 Promise 永不 reject。** 这是故意的：
       * Node 默认把未处理的 Promise 拒绝当成致命错误，直接结束进程。
       * 而插件里 `ctx.say(...)` 大多不 await（说了就走），
       * 于是"闸门内部某处抛了一下"就会变成"机器人整个挂掉"——
       * 这是最不该发生、也最难联想的失败方式。所以在这里兜住。
       */
      say: async (text, extra = {}) => {
        if (typeof this.sayFn !== 'function') {
          return { ok: false, skipped: 'no-gate', text: '' }
        }

        let result
        try {
          result = await this.sayFn({
            text,
            reason: extra.reason ?? '',
            source: id,
            reply: extra.reply ?? null,
            // 优先级与等待上限也由插件声明，但**是否放行仍由闸门判断** ——
            // 插件能做的是"我愿意等"，不是"我可以插队"
            priority: extra.priority ?? 0,
            maxWaitMs: extra.maxWaitMs ?? 0,
          })
        } catch (err) {
          entry.stats.errors++
          entry.stats.lastError = err.message
          this.log.error(`插件 ${id} 请求发言时出错：${err.message}`)
          return { ok: false, skipped: 'error', text: '', message: err.message }
        }

        // 只数真正说出去的。界面上「N 认领 · M 发言」的差额就是被闸门拦下的量，
        // 这个差额长期很大说明限速配得太紧，得看得见
        if (result && result.ok) entry.stats.sent++
        return result
      },
      /** 渲染模板，占位符规则由内核统一 */
      render: (tpl, vars, opts) => render(tpl, vars, opts),
      /**
       * 这个插件在这个宿主里的私有存储。**跨事件的状态放这里，不要放模块对象。**
       * 理由见 `scratch` 字段的注释：模块对象是进程级共享的。
       */
      scratch: entry.scratch,
      /**
       * 观众簿：只读。`peek(uid)` 给出「上次什么时候来的」。
       *
       * 只给只读入口是刻意的 —— 记账由内核在事件入库时统一做，
       * 插件不参与。这样插件被禁用、被换掉、跑在沙盒里，都不会让
       * 观众簿断更或写进假数据。
       */
      get roster() {
        return host.roster
      },
      get speakers() {
        return host.speakers
      },
      get config() {
        return entry.config
      },
      get state() {
        return typeof host.getState === 'function' ? host.getState() : null
      },
      log,
    }
  }

  /**
   * 投递一条事件（串行版，**收包链应该用这个**）。
   *
   * 与 `dispatch()` 的区别只有一条：这里排队。
   * `dispatch()` 是"现在就问一圈插件"，`deliver()` 是"按到达顺序问一圈"。
   *
   * 以前直接 fire-and-forget 调 dispatch，单个插件看起来没问题，
   * 一旦某个插件的 onEvent 里有 await（SC 等闸门槽位要 5 秒），
   * 下一条事件就会插进来把它打断：连击计数错位、冷却表读到中间态。
   * 这类 bug 不报错、不掉线，只是"偶尔少答谢一次"，最难查。
   *
   * 返回的 Promise **永远 resolve**，不会 reject —— 调用方可以不 await，
   * 但等于放弃了处理结果。队列满时 resolve `{ ok:false, reason:'queue_full' }`。
   *
   * @param {object} record           已经落盘的事件
   * @param {string|null} [edge]      边沿事件名（live_started / live_ended）
   * @param {(r:{by:string,event:object})=>void} [onClaimed] 被认领时回调
   */
  deliver(record, edge = null, onClaimed = null) {
    if (!record || !record.type) return Promise.resolve({ ok: true, claimedBy: null })

    if (this._queue.length >= MAX_QUEUE) {
      this.dropped++
      // 丢弃必须看得见：一个插件卡死会让这里每秒刷一行，比"什么都不发生"好得多
      this.log.warn(
        `插件队列积压 ${this._queue.length} 条（上限 ${MAX_QUEUE}），` +
          `丢弃 ${record.type}；累计丢弃 ${this.dropped} 条`,
      )
      return Promise.resolve({ ok: false, reason: 'queue_full', claimedBy: null })
    }

    return new Promise((resolve) => {
      this._queue.push({ record, edge, onClaimed, resolve })
      // 不 await：deliver 是同步入队，真正的处理在 _pump 里按序进行
      this._pump()
    })
  }

  /** 队列消费者。同一时刻只允许一个在跑，这就是"串行"的落点。 */
  async _pump() {
    if (this._pumping) return
    this._pumping = true
    try {
      while (this._queue.length > 0) {
        const job = this._queue.shift()
        let claimedBy = null
        try {
          // 边沿先于事件：插件处理 live_started 时不该先收到这场的第一条弹幕
          if (job.edge) await this.dispatchEdge(job.edge, job.record)
          const r = await this.dispatch(job.record)
          claimedBy = r.claimedBy
          if (claimedBy && typeof job.onClaimed === 'function') {
            job.onClaimed({ by: claimedBy, event: job.record })
          }
        } catch (err) {
          this.log.error(`投递 ${job.record.type} 失败：${err.message}`)
        }
        job.resolve({ ok: true, claimedBy })
      }
    } finally {
      this._pumping = false
    }
  }

  /**
   * 分发一条事件。
   *
   * 关键：**按 claims 优先级依次询问，第一个返回 true 的赢。**
   * 后面的插件不再被调用 —— 这就是"谁播报这个礼物"的仲裁，
   * 不需要任何插件去读别人的配置。
   *
   * @returns {{claimedBy:string|null, asked:string[]}}
   */
  async dispatch(ev) {
    if (!ev || !ev.type) return { claimedBy: null, asked: [] }

    const candidates = [...this.plugins.entries()]
      .filter(([, e]) => e.enabled)
      .map(([id, e]) => ({
        id,
        entry: e,
        prio: claimPriority(e.manifest, ev.type),
      }))
      .filter((c) => c.prio !== null)
      .sort((a, b) => b.prio - a.prio)

    const asked = []
    for (const c of candidates) {
      if (typeof c.entry.impl.onEvent !== 'function') continue
      asked.push(c.id)
      c.entry.stats.events++

      let claimed = false
      try {
        claimed = Boolean(await c.entry.impl.onEvent(this._ctx(c.id), ev))
      } catch (err) {
        c.entry.stats.errors++
        c.entry.stats.lastError = err.message
        // 一个插件抛异常不能中断整条分发链，否则后面的插件全部收不到事件
        this.log.error(`插件 ${c.id} 处理 ${ev.type} 出错：${err.message}`)
      }

      if (claimed) {
        c.entry.stats.claimed++
        return { claimedBy: c.id, asked }
      }
    }

    return { claimedBy: null, asked }
  }

  /** 分发边沿事件（live_started / live_ended），不参与仲裁 —— 每个插件都该知道 */
  async dispatchEdge(edge, ev) {
    const results = []
    for (const [id, e] of this.plugins) {
      if (!e.enabled || typeof e.impl.onEdge !== 'function') continue
      try {
        await e.impl.onEdge(this._ctx(id), edge, ev)
        results.push({ id, ok: true })
      } catch (err) {
        e.stats.errors++
        e.stats.lastError = err.message
        this.log.error(`插件 ${id} 处理边沿 ${edge} 出错：${err.message}`)
        results.push({ id, ok: false, message: err.message })
      }
    }
    return results
  }

  async startAll() {
    for (const [id, e] of this.plugins) {
      if (typeof e.impl.onStart !== 'function') continue
      try {
        await e.impl.onStart(this._ctx(id))
      } catch (err) {
        e.stats.errors++
        e.stats.lastError = err.message
        this.log.error(`插件 ${id} 启动失败：${err.message}`)
      }
    }
  }

  async stopAll() {
    for (const [id, e] of this.plugins) {
      if (typeof e.impl.onStop !== 'function') continue
      try {
        await e.impl.onStop(this._ctx(id))
      } catch (err) {
        this.log.warn(`插件 ${id} 停止时出错：${err.message}`)
      }
    }
  }

  /**
   * 回放收尾（**只有沙盒会调用，线上永远不走这里**）。
   *
   * 有些插件的输出挂在"稍后再说"上：礼物答谢要等合并窗口结束才发。
   * 线上靠定时器等那几秒，回放里现实时钟几乎没动，于是默认配置下
   * 沙盒**一条答谢都不出现** —— 而用户改的恰恰是答谢文案，
   * 看到空结果只会以为配置没生效。
   *
   * 让插件在这里把攒下的一次性结清，回放结果才等于"当时会说什么"。
   */
  async replayEnd() {
    for (const [id, e] of this.plugins) {
      if (typeof e.impl.onReplayEnd !== 'function') continue
      try {
        await e.impl.onReplayEnd(this._ctx(id))
      } catch (err) {
        e.stats.errors++
        e.stats.lastError = err.message
        this.log.warn(`插件 ${id} 回放收尾时出错：${err.message}`)
      }
    }
  }

  setEnabled(id, enabled) {
    const e = this.plugins.get(id)
    if (!e) return false
    e.enabled = Boolean(enabled)
    return true
  }

  /**
   * 改配置。
   *
   * 返回值分两种情况：插件不存在返回 null，存在则返回**收敛后**的完整配置。
   * 一定要返回完整配置而不是原样回显 patch —— manifest 有 min/max/类型约束，
   * 前端传 `100000` 而插件实际用的是 `600`，回显 patch 会让界面显示一个假值。
   */
  updateConfig(id, patch = {}) {
    const e = this.plugins.get(id)
    if (!e) return null
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw Object.assign(new Error('配置必须是对象'), { status: 400 })
    }
    e.config = coerceConfig(e.manifest, { ...e.config, ...patch })
    return { ...e.config }
  }

  /** 恢复 manifest 里的默认值（不是"删除文件"——默认值本身就写在 manifest 里） */
  resetConfig(id) {
    const e = this.plugins.get(id)
    if (!e) return null
    e.config = coerceConfig(e.manifest, {})
    return { ...e.config }
  }

  /**
   * 精简统计：给"每秒推一次"的界面用。
   *
   * 不用 `snapshot()`：那个会复制每个插件的配置和字段定义（数组、对象），
   * 一秒一次 × 每个打开的标签页，纯属白烧 CPU。要配置走 `/api/plugins`。
   */
  stats() {
    return [...this.plugins.entries()].map(([id, e]) => ({
      id,
      name: e.manifest.name,
      enabled: e.enabled,
      claimed: e.stats.claimed,
      sent: e.stats.sent,
      errors: e.stats.errors,
    }))
  }

  snapshot() {
    return {
      dir: this.dir,
      count: this.plugins.size,
      /**
       * 投递队列的状态。`dropped > 0` 或 `depth` 长期不归零，
       * 说明某个插件卡住了 —— 这是唯一能看见这件事的地方。
       */
      queue: { depth: this._queue.length, dropped: this.dropped, max: MAX_QUEUE },
      errors: this.errors.map((x) => ({ ...x })),
      plugins: [...this.plugins.entries()].map(([id, e]) => ({
        id,
        name: e.manifest.name,
        version: e.manifest.version,
        description: e.manifest.description ?? '',
        enabled: e.enabled,
        claims: { ...(e.manifest.claims ?? {}) },
        config: { ...e.config },
        fields: (e.manifest.config ?? []).map((f) => ({ ...f })),
        stats: { ...e.stats },
      })),
    }
  }
}

/** 插件对某类事件的优先级；没声明返回 null（表示不关心） */
export function claimPriority(manifest, type) {
  const claims = manifest?.claims
  if (!claims) return null
  if (Number.isFinite(claims[type])) return claims[type]
  if (Number.isFinite(claims['*'])) return claims['*']
  return null
}

/** 给前端事件流用的中文名。SENT 这类内核事件也要有标签 */
export function labelOf(type) {
  return EVENT_LABEL[type] ?? String(type)
}

export default PluginHost
