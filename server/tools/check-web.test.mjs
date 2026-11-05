/**
 * 配置面板的渲染自检。
 *
 * 为什么要在 Node 里给前端搭一个假 DOM：
 * 这台机器上的无头浏览器起不来（`--screenshot` 输出 0 字节，换过三种参数），
 * 而"面板点开才发现崩了"是最难排查的一类问题 —— 页面白屏、控制台一行红字，
 * 但服务端一切正常。所以这里用最小 DOM 把 `createSettings` 真跑一遍。
 *
 * 假 DOM 只实现被用到的那几个方法，它的价值不在"像浏览器"，
 * 而在**能把真实 manifest 喂进去**：字段类型、默认值、schema 全是生产数据，
 * 前端不认识任何具体插件，所以这条链路通了，加新插件也不会白屏。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PluginHost } from '../core/plugin-host.mjs'
import { findPack } from '../../web/core/greetings.js'
import { buildRoomRows, summarizeRooms } from '../../web/views/room-overview.js'

/* ══════════════════ 最小 DOM ══════════════════ */

class FakeNode {
  constructor(tag, ns = '') {
    this.tagName = String(tag).toUpperCase()
    this.namespaceURI = ns
    this.className = ''
    this.children = []
    this.dataset = {}
    this.attrs = {}
    this.style = {}
    this.listeners = {}
    this.parentElement = null
    this._text = ''
    /* 侧栏会用 classList.toggle 标「强」态。假 DOM 只需支持这几个方法，
       与 className 同步与否不影响这里的断言 */
    const set = new Set()
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !set.has(c) : !!force
        if (on) set.add(c)
        else set.delete(c)
        return on
      },
    }
  }

  set textContent(v) {
    this._text = String(v)
    this.children = []
  }
  get textContent() {
    if (this.children.length === 0) return this._text
    return this._text + this.children.map((c) => c.textContent).join('')
  }

  setAttribute(k, v) {
    this.attrs[k] = String(v)
  }
  getAttribute(k) {
    return this.attrs[k] ?? null
  }

  /* 真实浏览器里 value / checked 是**属性**而不是 attribute，
     表单事件读的也是 `e.target.value`。假 DOM 必须照这个语义实现，
     否则测试会以为"提交了空对象"是代码问题，其实是桩不对。 */
  get value() {
    return this.attrs.value ?? ''
  }
  set value(v) {
    this.attrs.value = String(v)
  }
  get checked() {
    return this.attrs.checked === 'checked' || this.attrs.checked === true
  }
  set checked(v) {
    if (v) this.attrs.checked = 'checked'
    else delete this.attrs.checked
  }

  addEventListener(type, fn) {
    ;(this.listeners[type] ??= []).push(fn)
  }

  /** 下载锚点会调用 click()；浏览器里这会触发下载，这里只记一笔 */
  click() {
    this.clicks = (this.clicks ?? 0) + 1
  }

  remove() {
    const p = this.parentElement
    if (!p) return
    const i = p.children.indexOf(this)
    if (i >= 0) p.children.splice(i, 1)
    this.parentElement = null
  }

  /** 真实元素的 class 在 className 上，SVG 元素的在 attribute 上（见 dom.js） */
  _cls() {
    return `${this.className} ${this.attrs.class ?? ''}`
  }

  append(...nodes) {
    for (const n of nodes) {
      if (!n) continue
      const list = n.tagName === '#FRAGMENT' ? n.children : [n]
      for (const c of list) {
        c.parentElement = this
        this.children.push(c)
      }
    }
  }

  replaceChildren(...nodes) {
    this.children = []
    this.append(...nodes)
  }

  replaceWith(node) {
    const p = this.parentElement
    if (!p) return
    const i = p.children.indexOf(this)
    if (i >= 0) {
      p.children[i] = node
      node.parentElement = p
    }
  }

  /** 只支持 `.class` 与 `.class[data-key="x"]` 两种，够用就行 */
  querySelector(sel) {
    const m = /^\.([\w-]+)(?:\[data-key="(.*)"\])?$/.exec(sel)
    if (!m) return null
    return this._find((n) => n.className.split(/\s+/).includes(m[1]) && (!m[2] || n.dataset.key === m[2]))
  }

  _find(pred) {
    for (const c of this.children) {
      if (pred(c)) return c
      const deeper = c._find(pred)
      if (deeper) return deeper
    }
    return null
  }

  /** 测试用：按类名收集所有后代（HTML 看 className，SVG 看 class 属性） */
  all(className) {
    const out = []
    const walk = (n) => {
      for (const c of n.children) {
        if (c._cls().split(/\s+/).includes(className)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
}

function installDom() {
  globalThis.document = {
    createElement: (t) => new FakeNode(t),
    // 图表要走 createElementNS：用 createElement 造出来的 <rect> 是
    // HTMLUnknownElement，塞进 <svg> 里会被整棵丢掉（见 dom.js）
    createElementNS: (ns, t) => new FakeNode(t, ns),
    createDocumentFragment: () => new FakeNode('#fragment'),
    // 下载锚点需要挂进文档（游离节点的 click 在 Firefox 里不触发下载）
    body: new FakeNode('body'),
  }
}

/* ══════════════════ 假请求 ══════════════════ */

function installFetch(t, snapshot, options = {}) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url)
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })

    if (path === '/api/plugins') {
      return { ok: true, status: 200, json: async () => ({ ok: true, ...snapshot }) }
    }

    // 维护页要读一次状态（版本号、当前更新源）
    if (path === '/api/status') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          version: '0.2.0',
          config: { roomId: '1901584685', updateUrl: '' },
          update: options.update ?? null,
        }),
      }
    }

    if (path === '/api/update/download') {
      if (options.downloadError) {
        return { ok: false, status: 502, json: async () => ({ ok: false, error: { message: options.downloadError } }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, version: '0.3.0', bytes: 1024, sha256: 'a'.repeat(64) }),
      }
    }

    if (path === '/api/update/apply') {
      if (options.applyError) {
        return { ok: false, status: 409, json: async () => ({ ok: false, error: { message: options.applyError, code: options.applyCode } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, version: '0.3.0', restarting: true }) }
    }

    if (path === '/api/update/check') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, configured: true, current: '0.2.0', latest: '0.2.0', hasUpdate: false }),
      }
    }

    // 任何写操作都回一份"服务端收敛后"的配置：这里故意把 template 改成大写，
    // 用来验证前端回填的是服务端的值而不是自己传的值
    const m = /^\/api\/plugins\/([\w-]+)\/(config|reset|enabled)$/.exec(path)
    if (m) {
      const p = snapshot.plugins.find((x) => x.id === m[1])
      const cfg = { ...p.config }
      if (m[2] === 'config') Object.assign(cfg, init.body ?? {})
      return { ok: true, status: 200, json: async () => ({ ok: true, id: m[1], config: cfg }) }
    }

    return { ok: false, status: 404, json: async () => ({ ok: false, error: { message: '没有这个接口' } }) }
  }
  t.after(() => {
    delete globalThis.fetch
  })
  return calls
}

/* ══════════════════ 用例 ══════════════════ */

/** 拿到真实插件快照（和 /api/plugins 返回的形状一致） */
async function realSnapshot(t) {
  const host = new PluginHost({ dir: join(process.cwd(), 'plugins') })
  await host.load()
  t.after(() => host.stopAll())
  const snap = host.snapshot()
  return { plugins: snap.plugins, errors: snap.errors }
}

async function mount(t, options = {}) {
  installDom()
  const snapshot = await realSnapshot(t)
  const calls = installFetch(t, snapshot, options)

  // 放到 import 之后也不要紧：settings.js 顶层不碰 DOM，只在函数里用
  const { createSettings } = await import('../../web/views/settings.js')

  const dlg = new FakeNode('dialog')
  dlg.open = false
  dlg.showModal = () => {
    dlg.open = true
  }
  dlg.close = () => {
    dlg.open = false
  }

  const tabs = new FakeNode('div')
  const body = new FakeNode('div')
  const closeBtn = new FakeNode('button')

  const toasts = []
  const settings = createSettings({
    dlg,
    tabs,
    body,
    closeBtn,
    toast: (text, level) => toasts.push({ text, level }),
  })

  return { settings, tabs, body, calls, toasts, snapshot }
}

test('面板：顶部先是固定的「维护」，之后按插件生成 tab', async (t) => {
  const { settings, tabs, snapshot } = await mount(t)
  await settings.open()

  const list = tabs.all('plg-tab')
  assert.equal(list.length, snapshot.plugins.length + 1, '插件数 + 一个固定的「维护」')
  assert.equal(list[0].textContent, '维护', '维护排在最前：找"检查更新/导出诊断"的人不该翻过所有插件')
  assert.deepEqual(
    list.slice(1).map((x) => x.textContent),
    snapshot.plugins.map((p) => p.name),
  )
})

test('面板：插件多到装不下时，PC 滚轮落在 tab 条上要能横向滚动', async (t) => {
  const { settings, tabs } = await mount(t)
  await settings.open()

  tabs.scrollWidth = 500
  tabs.clientWidth = 200
  tabs.scrollLeft = 0
  const wheel = tabs.listeners.wheel?.[0]
  assert.ok(wheel, 'tab 条没有绑定滚轮事件，PC 上只能靠拖动滚动条')

  let prevented = false
  const ev = (deltaY) => ({
    deltaY,
    deltaX: 0,
    ctrlKey: false,
    defaultPrevented: false,
    preventDefault() {
      prevented = true
    },
  })

  wheel(ev(120))
  assert.equal(prevented, true, '还能滚的时候要拦住页面滚动')
  assert.equal(tabs.scrollLeft, 120, '竖向滚轮要变成横向位移')

  tabs.scrollLeft = 290
  prevented = false
  wheel(ev(120))
  assert.equal(tabs.scrollLeft, 300, '不能滚过最大宽度')
  assert.equal(prevented, true, '最后一段还能滚')

  prevented = false
  wheel(ev(120))
  assert.equal(tabs.scrollLeft, 300)
  assert.equal(prevented, false, '滚到头之后不能再拦页面滚动')
})

test('面板：tab 条要保留可见的细滚动条，不能把滚动藏掉', () => {
  const css = readFileSync(join(process.cwd(), 'web/app.css'), 'utf8')
  const start = css.indexOf('.plg-tabs {')
  assert.ok(start >= 0)
  const block = css.slice(start, css.indexOf('}', start) + 1)
  assert.match(block, /overflow-x:\s*auto/, '横向滚动本身要保留')
  assert.match(block, /scrollbar-width:\s*thin/, 'PC 上要看得见还能滚')
  assert.equal(/scrollbar-width:\s*none/.test(block), false, '别再把滚动条藏掉')
})

test('面板：每个字段都渲染成一行，没有漏项', async (t) => {
  const { settings, body, snapshot } = await mount(t)
  await settings.open()

  // 默认选中的是第一个插件
  const p = snapshot.plugins[0]
  const rows = body.all('plg-field')
  assert.equal(rows.length, p.fields.length, `${p.id} 应渲染 ${p.fields.length} 个字段`)

  const keys = rows.map((r) => r.dataset.key).sort()
  assert.deepEqual(keys, p.fields.map((f) => f.key).sort())
})

test('面板：所有插件都能渲染，没有哪个插件会让面板崩', async (t) => {
  const { settings, tabs, body, snapshot } = await mount(t)
  await settings.open()

  // 按名字点，不按索引：tab 列表前面还有一个固定的「维护」
  for (const p of snapshot.plugins) {
    pick(tabs, p.name)
    assert.equal(body.all('plg-field').length, p.fields.length, `${p.id} 渲染失败`)
  }
})

test('面板：manifest 里出现过的每种控件类型都能渲染出可交互节点', async (t) => {
  const { settings, tabs, body, snapshot } = await mount(t)
  await settings.open()

  const types = new Set(snapshot.plugins.flatMap((p) => p.fields.map((f) => f.type)))
  const rendered = new Set()

  for (const p of snapshot.plugins) {
    pick(tabs, p.name)
    for (const f of p.fields) {
      const row = body.querySelector(`.plg-field[data-key="${f.key}"]`)
      assert.ok(row, `${p.id}.${f.key} 没有渲染`)

      // 行里必须有"能改"的东西：input / textarea / select 三者之一
      const hasControl = row._find((n) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName))
      assert.ok(hasControl, `${p.id}.${f.key}（${f.type}）没有生成控件`)
      rendered.add(f.type)
    }
  }

  // 兜底提示：将来 manifest 用了新类型，前端没跟上时这里会列出差异
  for (const ty of types) assert.ok(rendered.has(ty), `类型 ${ty} 没有控件`)
})

/** 切到指定插件（tab 是按插件 id 排的序，不能假设第一个就是欢迎） */
function pick(tabs, name) {
  const tab = tabs.all('plg-tab').find((x) => x.textContent === name)
  assert.ok(tab, `找不到插件「${name}」的 tab`)
  tab.listeners.click[0]()
  return tab
}

test('面板：文本字段的默认值来自 config，不是硬编码', async (t) => {
  const { settings, tabs, body } = await mount(t)
  await settings.open()
  pick(tabs, '欢迎')

  const row = body.querySelector('.plg-field[data-key="template"]')
  const input = row._find((n) => n.tagName === 'INPUT')
  assert.ok(input)
  assert.match(input.attrs.value, /欢迎/, '默认应填 manifest 里的欢迎语')
})

test('面板：改一个字段只提交这一个字段（增量 patch，不是整份配置）', async (t) => {
  const { settings, tabs, body, calls } = await mount(t)
  await settings.open()
  pick(tabs, '欢迎')

  const row = body.querySelector('.plg-field[data-key="template"]')
  const input = row._find((n) => n.tagName === 'INPUT')
  input.value = '新的欢迎语'

  await input.listeners.change[0]({ target: input })

  const save = calls.find((c) => c.method === 'POST' && /\/config$/.test(c.path))
  assert.ok(save, '应当发出保存请求')
  assert.equal(save.path, '/api/plugins/welcome/config')
  assert.deepEqual(save.body, { template: '新的欢迎语' }, '只带改过的那一个键')
})

test('面板：开关走的是 enabled 接口，不是 config 接口', async (t) => {
  const { settings, body, calls } = await mount(t)
  await settings.open()

  // 页面上有两个 switch：一个是插件启停，一个是字段里的 switch
  const enableSwitch = body._find((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox')
  enableSwitch.checked = false
  await enableSwitch.listeners.change[0]({ target: enableSwitch })

  const hit = calls.find((c) => /\/enabled$/.test(c.path))
  assert.ok(hit, '应当调用 enabled 接口')
  assert.equal(hit.body.enabled, false)
})

test('面板：恢复默认调用 reset 接口', async (t) => {
  const { settings, tabs, body, calls } = await mount(t)
  await settings.open()
  pick(tabs, '欢迎')

  const btn = body._find((n) => n.tagName === 'BUTTON' && n.textContent === '恢复默认')
  assert.ok(btn, '应有恢复默认按钮')
  await btn.listeners.click[0]()

  const hit = calls.find((c) => /\/reset$/.test(c.path))
  assert.ok(hit)
  assert.equal(hit.path, '/api/plugins/welcome/reset')
})

/* ══════════════════ 战报面板 ══════════════════ */

/** 一份形状与 /api/reports 完全一致的数据（字段名改了这里就会红） */
function reportsPayload() {
  const session = (over = {}) => ({
    id: 's1',
    implicit: false,
    closed: true,
    /** 结束时间是否为推断（没收到 LIVE_END）—— 决定时长前面加不加「约」 */
    endedAtEstimated: false,
    /** 还开着但很久没有事件（连接断了），不是真的还在播 */
    stale: false,
    startedAt: new Date(2026, 10, 2, 20, 0).getTime(),
    endedAt: new Date(2026, 10, 2, 21, 0).getTime(),
    lastEventTs: new Date(2026, 10, 2, 21, 0).getTime(),
    durationSec: 3600,
    danmaku: 120,
    enterCount: 40,
    uniqueViewers: 55,
    followCount: 3,
    sentCount: 12,
    likeCount: 900,
    peakPopularity: 1800,
    giftCount: 6,
    giftBattery: 100,
    guardCount: 1,
    guardBattery: 1000,
    scCount: 2,
    scBattery: 500,
    totalBattery: 1600,
    giftTop: [{ name: '辣条', count: 4 }],
    ...over,
  })

  return {
    ok: true,
    days: 0,
    reports: [session({ id: 'live', closed: false, implicit: true }), session()],
    summary: {
      sessions: 2,
      implicitSessions: 1,
      durationSec: 7200,
      danmaku: 240,
      enterCount: 80,
      followCount: 6,
      giftCount: 12,
      giftBattery: 200,
      guardCount: 2,
      guardBattery: 2000,
      scCount: 4,
      scBattery: 1000,
      totalBattery: 3200,
      peakPopularity: 1800,
    },
    /**
     * 每日序列（服务端按天聚合好）。故意留一天弹幕为 0、收入不为 0：
     * 图上一个 0 不该画出一根柱子，否则"没播"和"播了没人说话"看起来一样。
     */
    series: [
      {
        day: '2026-11-01',
        sessions: 1,
        durationSec: 3600,
        danmaku: 100,
        enterCount: 30,
        followCount: 2,
        giftCount: 3,
        giftBattery: 100,
        scCount: 1,
        totalBattery: 1000,
      },
      {
        day: '2026-11-02',
        sessions: 1,
        durationSec: 3600,
        danmaku: 0,
        enterCount: 10,
        followCount: 1,
        giftCount: 1,
        giftBattery: 200,
        scCount: 0,
        totalBattery: 200,
      },
      {
        day: '2026-11-03',
        sessions: 1,
        durationSec: 3600,
        danmaku: 50,
        enterCount: 20,
        followCount: 1,
        giftCount: 2,
        giftBattery: 50,
        scCount: 1,
        totalBattery: 500,
      },
    ],
    log: { days: ['2026-11-01', '2026-11-02'], files: 2, archived: 0 },
    warnings: [{ code: 'legacy-sc', count: 2, text: '有 2 条醒目留言由旧版本采集，金额会偏低' }],
  }
}

function installReportsDom(payload, calls = [], timeline = timelinePayload()) {
  installDom()
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url)
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
    // 导出的复盘页：先于 /api/reports 判断，否则会被那个前缀吃掉
    if (path.startsWith('/api/reports/export')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (k) =>
            String(k).toLowerCase() === 'content-disposition'
              ? 'attachment; filename="yuyue3-report-7734200-2026-11-05_06-07.html"'
              : null,
        },
        blob: async () => new Blob(['<html></html>']),
      }
    }
    if (path.startsWith('/api/reports')) {
      return { ok: true, status: 200, json: async () => payload }
    }
    if (path.startsWith('/api/timeline')) {
      return { ok: true, status: 200, json: async () => timeline }
    }
    if (path === '/api/sandbox') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          fed: 3,
          total: 3,
          stopped: null,
          said: [{ seq: 2, ts: Date.now(), plugin: 'welcome', text: '欢迎甲' }],
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: { message: '没有这个接口' } }) }
  }
}

/**
 * 时间轴的数据形状（和 /api/timeline 一致）。
 *
 * 累积弹幕每格 +2：这样"柱子里一格新增 2 条"和"读数 20 条"能分开验证，
 * 不会出现两者都写成同一个数、改错了也看不出来。
 *
 * `tailSec` 用来造"最后一格不满"的窗口 —— 真实场次几乎从不正好是格宽的整数倍。
 */
function timelinePayload({
  hour = 20,
  minute = 0,
  count = 30,
  stepSec = 60,
  tailSec = 0,
  firstEmpty = true,
} = {}) {
  const from = new Date(2026, 10, 2, hour, minute).getTime()
  const frames = []
  for (let i = 0; i < count; i++) {
    const last = i === count - 1
    // 最后一格的结束时刻 = 窗口终点，所以 tailSec 要在这里扣掉
    const t = from + (i + 1) * stepSec * 1000 - (last ? tailSec * 1000 : 0)
    const delta = firstEmpty && i === 0 ? 0 : 2
    frames.push({
      t,
      elapsedSec: Math.round((t - from) / 1000),
      danmaku: i * 2,
      danmakuDelta: delta,
      enterCount: i,
      uniqueViewers: i,
      followCount: 0,
      giftCount: 0,
      giftBattery: 0,
      guardCount: 0,
      guardBattery: 0,
      scCount: 0,
      scBattery: 0,
      sentCount: 0,
      totalBattery: i * 10,
      peakPopularity: 0,
    })
  }

  return {
    ok: true,
    from,
    to: frames[frames.length - 1].t,
    stepSec,
    frames,
    marks: [
      { seq: 3, ts: from + 5 * 60_000, type: 'GIFT', uname: '甲', text: '辣条', num: 2, battery: 200, guardLevel: 0 },
      { seq: 9, ts: from + 20 * 60_000, type: 'SUPER_CHAT', uname: '乙', text: '加油', num: 1, battery: 300, guardLevel: 0 },
      { seq: 12, ts: from + 25 * 60_000, type: 'SENT', uname: '', text: '感谢甲的辣条', num: 1, battery: 0, guardLevel: 0 },
    ],
    marksTruncated: false,
    totals: frames[frames.length - 1],
    eventCount: 120,
  }
}

function mountReports(payload, calls) {
  const dlg = new FakeNode('dialog')
  dlg.open = false
  dlg.showModal = () => {
    dlg.open = true
  }
  dlg.close = () => {
    dlg.open = false
  }
  return { dlg, calls }
}

test('战报：面板开着时切房间会重拉（不能留着上一间的场次）', async (t) => {
  const payload = reportsPayload()
  const calls = []
  installReportsDom(payload, calls)
  t.after(() => delete globalThis.fetch)

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(payload, calls)
  const reports = createReports({ dlg, toast: () => {} })

  const reportCalls = () => calls.filter((c) => c.path.startsWith('/api/reports')).length

  // 面板没开：白算一遍要读全量日志，不能因为"可能有人看"就先算
  await reports.refreshIfOpen()
  assert.equal(reportCalls(), 0, '面板关着的时候不该发请求')

  await reports.open()
  const before = reportCalls()
  assert.ok(before >= 1, '打开面板本来就要拉一次')

  await reports.refreshIfOpen()
  assert.equal(reportCalls(), before + 1, '面板开着时切房间必须重新拉一次')
})

test('战报：导出会把当前范围一起带上去（导出的和看到的是同一段）', async (t) => {
  const payload = reportsPayload()
  const calls = []
  installReportsDom(payload, calls)
  t.after(() => delete globalThis.fetch)

  // 假 DOM 里 createObjectURL 会让下载走到"成功"那条路，而它的 revoke 定时器
  // 要挂 10 秒（真浏览器需要，node 里只会拖慢自检）。摘掉它，走"不能自动下载"的分支。
  const realCreate = URL.createObjectURL
  URL.createObjectURL = undefined
  t.after(() => {
    URL.createObjectURL = realCreate
  })

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(payload, calls)
  const reports = createReports({ dlg, toast: () => {} })
  await reports.open()

  const btn = dlg.all('btn').find((b) => b.textContent === '导出复盘页')
  assert.ok(btn, '战报面板上要有导出入口')

  await btn.listeners.click[0]()
  const first = calls.filter((c) => c.path.startsWith('/api/reports/export'))
  assert.equal(first.length, 1, '点一次导出只发一次请求')
  assert.match(first[0].path, /days=0/, '当前是「全部」，导出的也必须是全部')

  // 换成"最近 7 天"再导出：文件里的范围必须跟着页面走
  dlg.all('chip').find((c) => c.textContent === '最近 7 天').listeners.click[0]()
  await new Promise((r) => setTimeout(r, 5))

  await btn.listeners.click[0]()
  const all = calls.filter((c) => c.path.startsWith('/api/reports/export'))
  assert.match(all[all.length - 1].path, /days=7/, '页面看的是 7 天，导出的也必须是 7 天')
})

test('战报：一场一个卡片，内容全部来自接口（页面自己不算统计）', async (t) => {
  const payload = reportsPayload()
  const calls = []
  installReportsDom(payload, calls)
  t.after(() => delete globalThis.fetch)

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(payload, calls)
  const reports = createReports({ dlg, toast: () => {} })
  await reports.open()

  assert.equal(dlg.all('rpt-session').length, 2, '两场就该两个卡片')
  assert.equal(dlg.all('rpt-cell').length, 8, '汇总条固定 8 格')

  // 3200 电池 = 320 元。前端如果自己换算错，这里会红
  const money = dlg.all('rpt-cell').map((c) => c.textContent).join('|')
  assert.match(money, /320/, `汇总收入应显示 320 元，实际：${money}`)

  // 隐式场次要被标出来，否则用户会拿假时长去比较
  assert.ok(
    dlg.all('rpt-badge').some((b) => b.textContent === '起点未知'),
    '隐式场次必须标注',
  )
  assert.ok(
    dlg.all('rpt-badge').some((b) => b.textContent === '进行中'),
    '未结束的场次要标成进行中',
  )

  // 旧日志的金额偏低这件事必须显示出来，否则用户会认为是我们算错了
  assert.equal(dlg.all('rpt-warn').length, 1, '服务端给了 warnings 就要显示')
  assert.match(dlg.all('rpt-warn')[0].textContent, /偏小|偏低/)
})

test('战报：每日趋势是真 SVG（不是 div 拼的），柱子数 = 有数据的天数', async (t) => {
  const payload = reportsPayload()
  const calls = []
  installReportsDom(payload, calls)
  t.after(() => delete globalThis.fetch)

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(payload, calls)
  const reports = createReports({ dlg, toast: () => {} })
  await reports.open()

  const svg = dlg.all('rpt-svg')
  assert.equal(svg.length, 1, '要有一张图')
  assert.equal(svg[0].tagName, 'SVG')
  assert.equal(svg[0].namespaceURI, 'http://www.w3.org/2000/svg', '必须走 createElementNS，否则浏览器什么都不画')
  assert.match(svg[0].getAttribute('aria-label'), /每日弹幕趋势/)

  // 弹幕为 0 的那天不画柱子：画一根 0 高的线看不出来，
  // 反而会让"没播"和"播了没人说话"在图上长得一样
  const bars = dlg.all('rpt-bar')
  assert.equal(bars.length, 2, `3 天里只有 2 天有弹幕，实际画了 ${bars.length} 根`)
  assert.ok(
    Number(bars[0].getAttribute('height')) > Number(bars[1].getAttribute('height')),
    '100 条的柱子要比 50 条高',
  )
  assert.equal(dlg.all('rpt-grid').length, 2, '基线 + 中间参考线')

  // 合计来自服务端序列（100 + 0 + 50），页面自己加就会和服务端算出两个数
  const notes = () => dlg.all('rpt-note').map((x) => x.textContent).join('|')
  assert.match(notes(), /3 天 · 合计 150/, `合计算错：${notes()}`)

  // 切到收入：第二天"有收入没弹幕"，柱子应该变成 3 根
  const before = calls.filter((c) => c.path.startsWith('/api/reports')).length
  const income = dlg.all('chip').find((c) => c.textContent === '收入')
  assert.ok(income, '要有"收入"这个指标')
  await income.listeners.click[0]()

  assert.equal(dlg.all('rpt-bar').length, 3, '收入三天都有，柱子变 3 根')
  assert.match(notes(), /合计 ¥170/, `1700 电池 = 170 元，实际：${notes()}`)
  assert.equal(
    calls.filter((c) => c.path.startsWith('/api/reports')).length,
    before,
    '换指标只是换个画法，不许重新请求',
  )
})

test('战报：天数很多时柱子必须画得下（不能把最近几天裁出画布）', async (t) => {
  /**
   * 每根柱子原来有 1px 的下限、缝最少 1px。天数一多（>330 天），
   * `天数 × 2px` 就超过画布宽：图右边缘的柱子全部被 SVG 裁掉，
   * 而图上还写着"365 天" —— 最近那些天根本不在画面里，还不报错。
   */
  const payload = reportsPayload()
  payload.series = Array.from({ length: 365 }, (_, i) => {
    const d = new Date(2026, 0, 1 + i)
    const p = (x) => String(x).padStart(2, '0')
    return {
      day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      sessions: 1,
      durationSec: 3600,
      danmaku: 10 + (i % 7),
      enterCount: 1,
      followCount: 0,
      totalBattery: 0,
    }
  })
  const calls = []
  installReportsDom(payload, calls)
  t.after(() => delete globalThis.fetch)

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(payload, calls)
  const reports = createReports({ dlg, toast: () => {} })
  await reports.open()

  const bars = dlg.all('rpt-bar')
  assert.equal(bars.length, 365, '每天一根，一根都不能少')

  // 画布 680 宽，左右各留 6：柱子必须在 [6, 674] 之内
  const right = (b) => Number(b.getAttribute('x')) + Number(b.getAttribute('width'))
  const left = (b) => Number(b.getAttribute('x'))
  const maxRight = Math.max(...bars.map(right))
  const minLeft = Math.min(...bars.map(left))

  assert.ok(maxRight <= 674.01, `最右边的柱子越界到 ${maxRight.toFixed(1)}px，会被裁掉`)
  assert.ok(minLeft >= 5.99, `最左边的柱子越界到 ${minLeft.toFixed(1)}px`)
  // 也不能缩成一团躲在左边：宽度要用满画布
  assert.ok(maxRight > 660, `柱子只用到了 ${maxRight.toFixed(1)}px，右边空了一大块`)
})

test('战报：连点范围时，先发的旧结果不能顶掉新结果', async (t) => {
  /**
   * 三个范围的计算成本差很远（"全部"= 全量日志重放）。用户连点
   * 「最近 7 天 → 最近 30 天」时，第一发可能后到 —— 后到的旧结果
   * 把新结果顶掉：chip 高亮着 30 天，图上却还是 7 天。
   *
   * 不报错、不卡住，只是"数字不对"，而用户没法知道该信哪个。
   */
  const series = (n) =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(2026, 10, 1 + i)
      const p = (x) => String(x).padStart(2, '0')
      return {
        day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
        sessions: 1,
        durationSec: 3600,
        danmaku: 10,
        enterCount: 1,
        followCount: 0,
        totalBattery: 0,
      }
    })

  installDom()
  globalThis.fetch = async (url) => {
    const days = Number(new URL(String(url), 'http://x').searchParams.get('days'))
    // 只给"7 天"这一发拖后腿：它先发，却最后到
    await new Promise((r) => setTimeout(r, days === 7 ? 80 : 5))
    return {
      ok: true,
      status: 200,
      json: async () => ({ ...reportsPayload(), days, series: series(days === 7 ? 7 : 30) }),
    }
  }
  t.after(() => delete globalThis.fetch)

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(null, [])
  const reports = createReports({ dlg, toast: () => {} })
  await reports.open() // 默认"全部"

  const chip = (label) => dlg.all('chip').find((c) => c.textContent === label)
  chip('最近 7 天').listeners.click[0]() // 故意不 await：模拟连点
  chip('最近 30 天').listeners.click[0]()

  await new Promise((r) => setTimeout(r, 300))

  const notes = dlg.all('rpt-note').map((x) => x.textContent).join('|')
  assert.match(notes, /30 天/, `chip 是 30 天，内容却是旧结果：${notes}`)
  assert.equal(dlg.all('rpt-bar').length, 30, '柱子和 chip 对不上：又是旧结果覆盖了新的')
})

test('战报：撞上"上一次还在算"时自己等一下再问，不把这句话甩给用户', async (t) => {
  /**
   * 服务端同一时刻只算一份战报（连点两下跑两遍全量重放毫无意义）。
   * 但用户连点范围是正常操作 —— 页面拿到 429 就显示
   * "读不到战报：上一次战报还在算"，等于让他再点一次。
   * 正确做法是自己退避重试。
   */
  installDom()
  let hits = 0
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith('/api/reports')) return { ok: false, status: 404, json: async () => ({}) }
    hits++
    if (hits === 1) {
      return {
        ok: false,
        status: 429,
        json: async () => ({ ok: false, error: { code: 'busy', message: '上一次战报还在算，稍等一下' } }),
      }
    }
    return { ok: true, status: 200, json: async () => reportsPayload() }
  }
  t.after(() => delete globalThis.fetch)

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(null, [])
  await createReports({ dlg, toast: () => {} }).open()

  const hints = dlg.all('empty-hint').map((x) => x.textContent).join('|')
  assert.ok(!/还在算/.test(hints), `把"还在算"当错误显示了：${hints}`)
  assert.ok(hits >= 2, '应当自己重试一次')
  assert.ok(dlg.all('rpt-bar').length > 0, '重试成功之后要真的把图画出来')
})

test('战报：已中断的场次不许显示"进行中"（它只是日志里还开着）', async (t) => {
  const payload = reportsPayload()
  // 连接断了、进程被杀，日志里留下一个永远开着的场次
  payload.reports = [
    { ...payload.reports[0], id: 'dead', closed: false, stale: true, implicit: false },
  ]
  const calls = []
  installReportsDom(payload, calls)
  t.after(() => delete globalThis.fetch)

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(payload, calls)
  await createReports({ dlg, toast: () => {} }).open()

  const badges = dlg.all('rpt-badge').map((b) => b.textContent)
  assert.ok(badges.includes('已中断'), `应当标成已中断，实际：${badges.join('/')}`)
  assert.ok(!badges.includes('进行中'), '已经断了的场次不能显示成进行中')
})

test('战报：结束时间是推断出来的，时长前面要有「约」', async (t) => {
  const payload = reportsPayload()
  payload.reports = [{ ...payload.reports[1], id: 'est', endedAtEstimated: true }]
  const calls = []
  installReportsDom(payload, calls)
  t.after(() => delete globalThis.fetch)

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(payload, calls)
  await createReports({ dlg, toast: () => {} }).open()

  const dur = dlg.all('rpt-dur').map((d) => d.textContent).join('|')
  assert.match(dur, /约/, `推断时长必须标出来，实际：${dur}`)
})

test('时间轴：点开某一场 → 拖动 → 读数与标记跟着走，返回能回到列表', async (t) => {
  const payload = reportsPayload()
  const calls = []
  installReportsDom(payload, calls)
  t.after(() => delete globalThis.fetch)

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(payload, calls)
  const reports = createReports({ dlg, toast: () => {} })
  await reports.open()

  const openBtn = dlg.all('tl-open')[0]
  assert.ok(openBtn, '每场卡片上都要有时间轴入口')
  await openBtn.listeners.click[0]()

  // 窗口就该是这一场的起点和终点：多算一分钟都会把隔壁场的事件卷进来
  const req = calls.find((c) => c.path.startsWith('/api/timeline'))
  assert.ok(req, '点开就该请求时间轴')
  assert.equal(
    req.path,
    `/api/timeline?from=${payload.reports[0].startedAt}&to=${payload.reports[0].endedAt}&step=60`,
  )

  assert.equal(dlg.all('rpt-list')[0].hidden, true, '打开时间轴时列表要让位')

  const svg = dlg.all('tl-svg')
  assert.equal(svg.length, 1)
  assert.equal(svg[0].namespaceURI, 'http://www.w3.org/2000/svg', '还是那个坑：SVG 必须走 NS')
  // 第一格没有新增弹幕 → 不画柱子；其余 29 格各 +2
  assert.equal(dlg.all('tl-bar').length, 29, `柱子数不对：${dlg.all('tl-bar').length}`)
  assert.equal(dlg.all('tl-tick').length, 3, '三条标记就要三个刻度')
  assert.equal(dlg.all('tl-cursor').length, 1)

  // 每次读数都重新取节点：拖动会重建这排读数，抓着旧引用会读到上一次的值
  const val = (i) => dlg.all('tl-stats')[0].children[i].children[1].textContent
  assert.equal(val(0), '58', '默认停在末尾，读数应是整场的累积弹幕')

  const range = dlg.all('tl-range')[0]
  range.value = '10'
  range.listeners.input[0]({ target: range })

  assert.equal(val(0), '20', '第 11 格累积 20 条（每格 +2）')
  assert.match(dlg.all('tl-moment')[0].textContent, /到 20:11 为止/, '时刻要跟着光标走')
  assert.equal(dlg.all('tl-mark').length, 1, '光标在 11 分钟时，后面那两条还没发生')

  range.value = '29'
  range.listeners.input[0]({ target: range })
  assert.equal(dlg.all('tl-mark').length, 3, '拖到末尾，三条标记都该在')

  const back = dlg._find((n) => n.tagName === 'BUTTON' && n.textContent === '返回列表')
  assert.ok(back, '时间轴要有返回入口')
  await back.listeners.click[0]()

  assert.equal(dlg.all('tl-svg').length, 0, '返回后时间轴要收起来')
  assert.equal(dlg.all('rpt-list')[0].hidden, false, '列表要回来')
})

/* ── 时间轴的几何：不许溢出画布，也不许和光标各走各的 ── */

const PLOT = { W: 680, PAD: 4 };
const plotLeft = PLOT.PAD;
const plotRight = PLOT.W - PLOT.PAD;

const barBox = (b) => {
  const x = Number(b.attrs.x);
  return { left: x, right: x + Number(b.attrs.width) };
};

/** 和 reports.js 里的 xAt 同一个换算：时间 → 像素 */
const xOfTime = (payload, ts) =>
  plotLeft + ((Number(ts) - payload.from) / (payload.to - payload.from)) * (plotRight - plotLeft);

async function openTimelineWith(payload, timeline) {
  const calls = [];
  installReportsDom(payload, calls, timeline);
  const { createReports } = await import('../../web/views/reports.js');
  const { dlg } = mountReports(payload, calls);
  await createReports({ dlg, toast: () => {} }).open();
  await dlg.all('tl-open')[0].listeners.click[0]();
  return dlg;
}

/**
 * 守的是"后半场不见了"这个不报错的 bug。
 *
 * 柱子原本按槽位等宽摆，且每根有 0.6px 的下限。格数一多，
 * 0.6 × 格数 就超过画布宽 —— 溢出部分被 SVG 裁掉，
 * 于是轴上写着"播到 00:00"，右半边却一根柱子都没有。
 * 二十小时按分钟切（1200 格）就够触发。
 */
test('时间轴：格子再多，柱子也不许画出画布', async (t) => {
  const payload = reportsPayload();
  const timeline = timelinePayload({ count: 1200, stepSec: 60 });
  t.after(() => delete globalThis.fetch);

  const dlg = await openTimelineWith(payload, timeline);
  const bars = dlg.all('tl-bar');
  assert.equal(bars.length, 1199, '第一格没有新增，其余每格一根');

  let maxRight = 0;
  for (const b of bars) {
    const box = barBox(b);
    assert.ok(box.left >= plotLeft - 0.05, `柱子左边界越界：${box.left}`);
    assert.ok(
      box.right <= plotRight + 0.05,
      `柱子画到画布外面了：右边界 ${box.right.toFixed(1)} > ${plotRight}（共 ${bars.length} 根，会被裁掉）`,
    );
    maxRight = Math.max(maxRight, box.right);
  }
  assert.ok(maxRight >= plotRight - 1, `最后一根要贴住右边界，实际只到 ${maxRight.toFixed(1)}`);
});

/**
 * 守的是"柱子和光标错位"这个不报错的 bug。
 *
 * 真实场次几乎从不正好是格宽的整数倍：两小时零 17 分按分钟切，
 * 最后一格只有 17 分钟多一点。柱子若按槽位等宽摆，越往后偏得越多 ——
 * 光标停在 21:30，指针却压在前一根柱子上，读数看着像"这一格"的。
 */
test('时间轴：每一格的柱子都对齐光标所在的时刻', async (t) => {
  const payload = reportsPayload();
  // 31 格，最后一格只有 30 秒 —— 故意让窗口不是格宽的整数倍
  const timeline = timelinePayload({ count: 31, stepSec: 60, tailSec: 30, firstEmpty: false });
  t.after(() => delete globalThis.fetch);

  const dlg = await openTimelineWith(payload, timeline);
  const bars = dlg.all('tl-bar');
  assert.equal(bars.length, 31);

  // 稀疏时柱间留 2px 缝，所以右边界会比"这一格的结束时刻"早 2px，允许这点误差
  const TOL = 2.2;
  timeline.frames.forEach((f, i) => {
    const got = barBox(bars[i]).right;
    const want = xOfTime(timeline, f.t);
    assert.ok(
      Math.abs(got - want) <= TOL,
      `第 ${i + 1} 格柱子右边界 ${got.toFixed(1)}，该在 ${want.toFixed(1)} 附近（差 ${(got - want).toFixed(1)}px）`,
    );
  });

  // 拖到最后一格，光标必须压在最后一根柱子右侧 —— 两者本来就是一回事
  const range = dlg.all('tl-range')[0];
  range.value = String(timeline.frames.length - 1);
  range.listeners.input[0]({ target: range });

  const cursorX = Number(dlg.all('tl-cursor')[0].attrs.x1);
  assert.ok(
    Math.abs(cursorX - barBox(bars[bars.length - 1]).right) <= TOL,
    `光标 ${cursorX} 和最后一根柱子 ${barBox(bars[bars.length - 1]).right} 错位了`,
  );
});

test('时间轴：跨天的场次要把结束日期写出来，不能只写"02:00"', async (t) => {
  const payload = reportsPayload();
  // 23:30 播到 00:00 —— 结束已经在第二天了
  const timeline = timelinePayload({ hour: 23, minute: 30, count: 30 });
  t.after(() => delete globalThis.fetch);

  const dlg = await openTimelineWith(payload, timeline);
  const title = dlg.all('tl-title')[0].textContent;

  assert.match(
    title,
    /→ 11-03 00:00/,
    `跨天场次的标题必须带结束日期，否则会被当成同一天凌晨。实际：${title}`,
  );
  assert.doesNotMatch(title, /→ 00:00/, '不能只写时间');
});

test('战报：沙盒回放走 POST /api/sandbox，把结果逐条列出来', async (t) => {
  const payload = reportsPayload()
  const calls = []
  installReportsDom(payload, calls)
  t.after(() => delete globalThis.fetch)

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(payload, calls)
  const reports = createReports({ dlg, toast: () => {} })
  await reports.open()

  const btn = dlg._find((n) => n.tagName === 'BUTTON' && n.textContent === '开始回放')
  assert.ok(btn, '应有开始回放按钮')
  await btn.listeners.click[0]()

  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/sandbox')
  assert.ok(post, '应当发出回放请求')
  assert.equal(post.body.maxSaid, 300, '默认上限来自输入框')

  assert.equal(dlg.all('rpt-sb-row').length, 1, '回放说出了 1 条就该列 1 行')
  const row = dlg.all('rpt-sb-row')[0]
  assert.match(row.textContent, /欢迎甲/)
  assert.match(row.textContent, /welcome/)
})

/**
 * 这条断言守的是一个**不报错**的 bug。
 *
 * 服务端 WS 重连时补发的是一整窗事件（MAX_BUFFER 条）。前端如果只留更少，
 * 多出来的那一截会被自己的裁剪逻辑丢掉，页面上看不出任何异常 ——
 * 只是"那几分钟什么都没发生"。而事件流正是用来核对那几分钟发生了什么的。
 *
 * 两个数字分处两个文件、两种语言（服务端常量 / 前端常量），
 * 靠人记得同步是不现实的，所以读源码比。
 */
/* ══════════════════ 跨端约束 ══════════════════ */

test('前端事件上限不低于服务端缓冲窗口', () => {
  const webSrc = readFileSync(join(process.cwd(), 'web/core/store.js'), 'utf8')
  const appSrc = readFileSync(join(process.cwd(), 'server/app.mjs'), 'utf8')

  const webMax = Number(/const MAX = (\d+)/.exec(webSrc)?.[1])
  const srvMax = Number(/const MAX_BUFFER = (\d+)/.exec(appSrc)?.[1])

  assert.ok(Number.isFinite(webMax), 'web/core/store.js 里找不到 const MAX = <数字>')
  assert.ok(Number.isFinite(srvMax), 'server/app.mjs 里找不到 const MAX_BUFFER = <数字>')
  assert.ok(
    webMax >= srvMax,
    `前端保留 ${webMax} 条 < 服务端补发窗口 ${srvMax} 条：` +
      '切走标签页再回来，中间那截会被前端自己裁掉，且不报任何错',
  )
})

/* ══════════════════ 侧栏：观众簿 ══════════════════ */

test('侧栏：长期观众簿显示服务端给的聚合数字，且人数变了要跟着变', async () => {
  installDom()
  const { createSide } = await import('../../web/views/panels.js')
  const root = document.createElement('div')
  const side = createSide(root)

  // 只显示聚合数字：即使服务端多给了名单字段，也不能渲染出来。
  // （以前断言的是"文本里不含 uid 这个词"，但侧栏现在有自己的账号面板，
  //   那个 uid 是使用者自己的，和观众名单是两回事 —— 所以改成盯具体人名）
  side.updateBrief({
    roster: { people: 3806, days: 12, keepDays: 90, viewers: [{ uid: '1', name: '张三' }] },
  })
  assert.match(root.textContent, /3,806 人/, '人数要用千分位格式化')
  assert.match(root.textContent, /90 天/)
  assert.equal(root.textContent.includes('张三'), false, '观众名单不该出现在页面上')

  // 反向验证：这里若是硬编码的一句静态文字，这条就会失败
  side.updateBrief({ roster: { people: 7, days: 1, keepDays: 30 } })
  assert.match(root.textContent, /7 人/)
  assert.doesNotMatch(root.textContent, /3,806/)

  // 服务端没给（旧版本 / 载入失败）时降级成占位符，不能崩
  side.updateBrief({})
  assert.match(root.textContent, /—/)
})

/* ══════════════════ 侧栏：手动 @ 已移除 ══════════════════ */

test('侧栏：不再有「主动 @ 打招呼」面板，其他面板还在', async () => {
  installDom()
  const { createSide } = await import('../../web/views/panels.js')
  const root = document.createElement('div')
  createSide(root)

  // 手动点名已整体移除：面板、表单、状态行、发送按钮都不能残留
  assert.equal(root.all('callout-form').length, 0)
  assert.equal(root.all('callout-status').length, 0)
  assert.equal(root.textContent.includes('主动 @ 打招呼'), false)
  assert.equal(root.textContent.includes('@ 并打招呼'), false)

  // 反向：别把整块侧栏一起删了，观众簿 / 闸门 / 插件面板必须还在
  assert.match(root.textContent, /长期观众簿/)
  assert.match(root.textContent, /发送闸门/)
  assert.match(root.textContent, /插件/)
})

test('设置页：招呼语字段有预设下拉，选一套就把整包保存进去', async (t) => {
  const { settings, tabs, body, calls, snapshot } = await mount(t)
  await settings.open()

  const idx = snapshot.plugins.findIndex((p) => p.id === 'autocall')
  assert.ok(idx >= 0, 'autocall 插件要在快照里')
  // 按名字点，不按索引：tab 列表前面还有一个固定的「维护」
  pick(tabs, snapshot.plugins[idx].name)

  const selects = body.all('plg-preset')
  assert.equal(selects.length, 1, '只有 manifest 写了 presets 的字段才有这个下拉')
  const note = body.all('plg-hint').find((x) => /当前预设/.test(x.textContent))
  assert.ok(note, '要显示当前用的是哪一套，不能选了没反馈')
  assert.match(note.textContent, /轻松日常/)

  const select = selects[0]
  select.value = 'playful'
  select.listeners.change[0]({ target: select })
  await new Promise((r) => setImmediate(r))

  const call = calls.find((c) => c.path === '/api/plugins/autocall/config')
  assert.ok(call, '选预设要走和普通编辑完全相同的保存路径')
  assert.deepEqual(call.body.templates, findPack('playful').lines)
})

/* ══════════════════ 侧栏：账号与访问口令（P5） ══════════════════ */

test('侧栏：账号面板显示登录态、昵称、uid，并给出校验与退登入口', async () => {
  installDom()
  const { createSide } = await import('../../web/views/panels.js')
  const root = document.createElement('div')
  const side = createSide(root)

  side.updateFull({ account: { loggedIn: true, uid: 42, uname: '渔月崽', check: null }, access: { enabled: false } })

  assert.match(root.textContent, /已登录/)
  assert.match(root.textContent, /渔月崽/)
  assert.match(root.textContent, /42/)

  const labels = root.all('btn').map((b) => b.textContent)
  assert.ok(labels.includes('校验凭证'), '要有主动校验：凭证悄悄失效是最难查的问题')
  assert.ok(labels.includes('退出登录'))

  // 未登录时不该给"退出登录"点（点了只会报错）
  side.updateFull({ account: { loggedIn: false, uid: 0, uname: '' }, access: { enabled: false } })
  assert.match(root.textContent, /未登录/)
  const out = root.all('btn').find((b) => b.textContent === '退出登录')
  assert.equal(out.disabled, true)
})

test('侧栏：访问口令面板随状态切换「开启 / 解锁」', async () => {
  installDom()
  const { createSide } = await import('../../web/views/panels.js')
  const root = document.createElement('div')
  const side = createSide(root)

  side.updateFull({ account: { loggedIn: false }, access: { enabled: false } })
  assert.ok(root.all('btn').some((b) => b.textContent === '开启'), '没启用时是「开启」')
  const off = root.all('btn').find((b) => b.textContent === '关闭口令')
  assert.ok(off, '关闭按钮要存在')
  assert.equal(Boolean(off.hidden), true, '没启用时不该显示「关闭口令」')

  // 启用后、手里还没有凭据 → 是「解锁」；不能显示成「修改口令」，
  // 否则用户会以为自己改的是口令，实际是在解锁
  side.updateFull({ account: { loggedIn: false }, access: { enabled: true } })
  assert.ok(root.all('btn').some((b) => b.textContent === '解锁'))
  assert.equal(root.all('btn').some((b) => b.textContent === '修改口令'), false)
})

test('设置页：「维护」里有更新检查与诊断包，且检查更新会真的发请求', async (t) => {
  const { settings, tabs, body, calls } = await mount(t)
  await settings.open()

  pick(tabs, '维护')
  // renderMaintenance 是异步的（要读一次 /api/status）
  await new Promise((r) => setImmediate(r))

  assert.match(body.textContent, /当前版本 0\.2\.0/)
  assert.match(body.textContent, /更新源/)
  assert.match(body.textContent, /诊断包/)
  assert.match(body.textContent, /不含 Cookie/, '要明确告诉用户这个包可以发给别人')

  const check = body.all('btn').find((b) => b.textContent === '检查更新')
  assert.ok(check, '要有检查更新按钮')
  await check.listeners.click[0]()
  await new Promise((r) => setImmediate(r))
  assert.ok(calls.some((c) => c.path === '/api/update/check'), '按钮要真的发请求，不能只改文字')
  assert.match(body.textContent, /已是最新/)

  // 从维护切回插件，插件面板不能被"维护页"的状态污染
  pick(tabs, '欢迎')
  assert.ok(body.all('plg-field').length > 0)
})

test('设置页：更新包下载完才出现「重启并应用」，应用前必须确认', async (t) => {
  const update = {
    configured: true,
    hasUpdate: true,
    current: '0.2.0',
    latest: '0.3.0',
    download: 'https://example.com/yuyue3-0.3.0.tar.gz',
    sha256: 'a'.repeat(64),
    size: 1024,
    notes: '测试版本',
  }
  const { settings, tabs, body, calls } = await mount(t, { update })
  await settings.open()

  pick(tabs, '维护')
  await new Promise((r) => setImmediate(r))

  const dl = body.all('btn').find((b) => b.textContent === '下载更新包')
  assert.ok(dl, '有新版本且带 download 时要出现下载按钮')
  assert.notEqual(dl.style.display, 'none')

  const apply = body.all('btn').find((b) => b.textContent === '重启并应用')
  assert.ok(apply, '要有应用按钮')
  assert.equal(apply.style.display, 'none', '没下载前不能出现「重启并应用」')

  await dl.listeners.click[0]()
  await new Promise((r) => setImmediate(r))
  assert.ok(calls.some((c) => c.path === '/api/update/download'), '下载按钮要真的发请求')
  assert.equal(dl.textContent, '重新下载')
  assert.notEqual(apply.style.display, 'none', '下载完才允许应用')

  const confirms = []
  globalThis.window = {
    confirm: (msg) => {
      confirms.push(msg)
      return true
    },
  }
  t.after(() => {
    delete globalThis.window
  })

  await apply.listeners.click[0]()
  await new Promise((r) => setImmediate(r))
  assert.ok(confirms.length >= 1, '重启前必须弹确认')
  assert.ok(
    calls.some((c) => c.path === '/api/update/apply' && c.body?.confirm === true),
    '确认后要带着 confirm:true 发请求',
  )
})

/* ══════════════════ 多房间总览 ══════════════════ */

/**
 * 这一组是纯函数断言，不需要假 DOM。
 *
 * 总览里最容易写错的是**状态词**：一个"根本没连上"的房间和一个"主播没开播"
 * 的房间，在这里长得一模一样 —— 灰点、零弹幕。页面不会报错，
 * 用户只能自己纳闷"为什么这间一直没数据"。所以判断逻辑单独拿出来测。
 */
test('总览：没连上的房间不能显示成"未开播"', () => {
  const rows = buildRoomRows([
    {
      key: '100',
      roomId: 1000100,
      title: '',
      state: 'offline',
      started: false,
      danmaku: 0,
      giftCount: 0,
      popularity: 0,
      conn: 'idle',
      active: false,
    },
    {
      key: '200',
      roomId: 1000200,
      title: '今天的直播',
      state: 'live',
      started: true,
      danmaku: 1234,
      giftCount: 7,
      popularity: 3200,
      conn: 'live',
      active: true,
    },
  ])

  assert.equal(rows[0].dot, 'err', '没连上要用错误色，不是普通灰点')
  assert.match(rows[0].subtitle, /没连上/)
  assert.equal(rows[0].cells[3].v, '未连上', '连接那一列不能写成"未连接"就完事，要说清是没起来')

  assert.equal(rows[1].dot, 'live')
  assert.equal(rows[1].subtitle, '今天的直播', '有标题就显示标题，"直播中"是兜底')
  assert.deepEqual(
    rows[1].cells.map((c) => c.v),
    ['1,234', '7', '3,200', '已连接'],
  )
  assert.equal(rows[1].active, true)
});

test('总览：汇总只数房间，不把不同直播间的数字加在一起', () => {
  const s = summarizeRooms([
    { state: 'live', started: true, danmaku: 100 },
    { state: 'live_unknown', started: true, danmaku: 50 },
    { state: 'offline', started: true, danmaku: 0 },
    { state: 'offline', started: false, danmaku: 0 },
  ])
  assert.deepEqual(s, { total: 4, live: 2, broken: 1 })
});

test('总览：字段缺失时不诬陷成"没连上"', () => {
  // 老服务端（还没有 started 字段）返回的房间，不该整排标红
  const rows = buildRoomRows([{ roomId: 7734200, state: 'live', danmaku: 5 }])
  assert.equal(rows[0].broken, false)
  assert.equal(rows[0].dot, 'live')
  assert.equal(rows[0].cells[2].v, '—', '人气为 0 时显示破折号，0 会让人以为直播间没人')
});

test('el()：title 选项要真的落在属性上（悬停提示不许被静默丢掉）', async () => {
  installDom()
  try {
    const { el } = await import('../../web/core/dom.js')
    const node = el('span', { class: 'dot is-live', title: '直播中' })
    assert.equal(node.getAttribute('title'), '直播中')
    // 没传 title 的节点不该凭空多出一个"undefined"属性
    const bare = el('span', { text: 'x' })
    assert.equal(bare.getAttribute('title'), null)
  } finally {
    delete globalThis.document
  }
});

/* ══════════════════ 开播/下播提醒设置 ══════════════════ */

/**
 * 这块 UI 曾经是"死"的：index.html 里画了输入框和保存按钮，
 * app.js 没有接线，点保存什么都不会发生 —— 页面不报错，用户只会以为
 * "webhook 不生效"。所以这里用假 api 把读、写、失败三条路都跑一遍。
 */
async function mountNotify({ webhook = '', report = false, fail = null, withReportBox = true } = {}) {
  const { createNotifyConfig } = await import('../../web/views/notify-config.js')
  const input = new FakeNode('input')
  const button = new FakeNode('button')
  const reportBox = new FakeNode('input')
  reportBox.checked = report
  const toasts = []
  const saved = []
  const reports = []
  const api = {
    notify: async () => ({ ok: true, webhook, report }),
    saveNotify: async (v, r) => {
      saved.push(v)
      reports.push(r)
      if (fail) throw new Error(fail)
      return { ok: true, webhook: v, report: Boolean(r) }
    },
  }
  const cfg = createNotifyConfig({
    input,
    button,
    ...(withReportBox ? { reportBox } : {}),
    api,
    toast: (text, level) => toasts.push({ text, level }),
  })
  return { cfg, input, button, reportBox, toasts, saved, reports }
}

test('提醒设置：打开总览时连"下播战报"开关一起回填', async () => {
  const { cfg, input, reportBox } = await mountNotify({
    webhook: 'https://qyapi.weixin.qq.com/hook?key=k',
    report: true,
  })
  await cfg.load()
  assert.equal(input.value, 'https://qyapi.weixin.qq.com/hook?key=k')
  assert.equal(reportBox.checked, true)
});

test('提醒设置：勾了战报就一起保存，成功后提示包含战报', async () => {
  const { cfg, input, reportBox, toasts, saved, reports } = await mountNotify()
  input.value = 'https://example.com/hook'
  reportBox.checked = true
  await cfg.save()

  assert.deepEqual(saved, ['https://example.com/hook'])
  assert.deepEqual(reports, [true], '战报开关要和地址一起发，不能等下次')
  assert.match(toasts.at(-1).text, /战报/)
});

test('提醒设置：清空地址时顺带关掉战报，不留下永远发不出去的开关', async () => {
  const { cfg, input, reportBox, toasts, reports } = await mountNotify({ report: true })
  input.value = '  '
  await cfg.save()

  assert.deepEqual(reports, [false], '地址都没了，战报不能还勾着')
  assert.equal(reportBox.checked, false)
  assert.match(toasts.at(-1).text, /页内提示照旧/)
});

test('提醒设置：打开总览时回填服务端保存的地址', async () => {
  const { cfg, input } = await mountNotify({ webhook: 'https://qyapi.weixin.qq.com/hook?key=k' })
  await cfg.load()
  assert.equal(input.value, 'https://qyapi.weixin.qq.com/hook?key=k')
});

test('提醒设置：保存前 trim，成功提示，按钮恢复可点', async () => {
  const { cfg, input, button, toasts, saved } = await mountNotify()
  input.value = '  https://example.com/hook  '
  await cfg.save()

  assert.deepEqual(saved, ['https://example.com/hook'], '发出去的是 trim 后的地址')
  assert.equal(input.value, 'https://example.com/hook')
  assert.equal(toasts.at(-1).level, 'info')
  assert.equal(button.disabled, false, '失败或成功后按钮都要恢复')
});

test('提醒设置：清空 = 关闭外发，页内提示照旧', async () => {
  const { cfg, input, toasts, saved } = await mountNotify()
  input.value = '   '
  await cfg.save()

  assert.deepEqual(saved, [''], '空串要真的发给服务端，不能悄悄跳过')
  assert.equal(toasts.at(-1).level, 'warn')
  assert.match(toasts.at(-1).text, /页内提示照旧/)
});

test('提醒设置：不是 http(s) 的地址不发请求，输入框保留原文', async () => {
  const { cfg, input, toasts, saved } = await mountNotify()
  input.value = 'javascript:alert(1)'
  await cfg.save()

  assert.deepEqual(saved, [], '非法地址不许发出去')
  assert.equal(input.value, 'javascript:alert(1)', '留在框里让用户改，不能偷偷清掉')
  assert.equal(toasts.at(-1).level, 'error')
});

test('提醒设置：保存失败时不能清空用户刚粘的地址', async () => {
  const { cfg, input, button, toasts } = await mountNotify({ fail: '写保护：先解锁' })
  input.value = 'https://example.com/hook'
  await cfg.save()

  assert.equal(input.value, 'https://example.com/hook')
  assert.equal(toasts.at(-1).text, '写保护：先解锁')
  assert.equal(button.disabled, false)
});

test('提醒设置：输入框里按回车是保存，不是提交「打开这间」的表单', async () => {
  const { cfg, input, saved } = await mountNotify()
  input.value = 'https://example.com/hook'

  let prevented = false;
  input.listeners.keydown[0]({ key: 'Enter', preventDefault: () => (prevented = true) })
  await new Promise((r) => setImmediate(r))

  assert.equal(prevented, true, '回车必须拦下，否则会顺带提交房间号表单')
  assert.deepEqual(saved, ['https://example.com/hook'])
});

test('提醒设置：页面上的控件必须真的接到 app.js（防"看得见、点了没反应"复发）', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')

  for (const id of ['notify-input', 'notify-save', 'notify-report']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 里没有 #${id}，设置无处可填`)
  }
  assert.match(app, /createNotifyConfig\s*\(/, 'app.js 没有创建提醒设置')
  assert.match(app, /notifyInput:\s*\$\('#notify-input'\)/, '输入框没取到')
  assert.match(app, /notifySave:\s*\$\('#notify-save'\)/, '保存按钮没取到')
  assert.match(app, /reportBox:\s*dom\.notifyReport/, '战报开关没传给提醒设置')
  assert.match(app, /notifyConfig\.load\(\)/, '打开总览时要回填已保存的地址')
});

test('提醒设置：旧页面没有战报勾选框时，不能顺手把服务端的战报关掉', async () => {
  // 浏览器缓存了改动前的 index.html，但脚本是新的：reportBox 为 null。
  // 这时保存地址如果显式发 report:false，会把已经开着的战报悄悄关掉。
  const { cfg, input, reports, saved } = await mountNotify({ withReportBox: false })
  input.value = 'https://example.com/hook'
  await cfg.save()

  assert.deepEqual(saved, ['https://example.com/hook'])
  assert.deepEqual(reports, [undefined], '没有勾选框就不发 report 字段，让服务端保持原值')
})

test('提醒设置：保存之后迟到的 load 不能把地址改回旧值', async () => {
  const { createNotifyConfig } = await import('../../web/views/notify-config.js')
  const input = new FakeNode('input')
  const button = new FakeNode('button')
  let resolveLoad
  const api = {
    notify: () =>
      new Promise((resolve) => {
        resolveLoad = resolve
      }),
    saveNotify: async (v) => ({ ok: true, webhook: v }),
  }
  const cfg = createNotifyConfig({ input, button, api })

  input.value = 'https://example.com/new'
  const late = cfg.load() // 打开弹窗发出的读，还没回来
  await cfg.save() // 用户先点了保存
  resolveLoad({ ok: true, webhook: 'https://example.com/old' })
  await late

  assert.equal(input.value, 'https://example.com/new', '保存后的值不能被更早的读覆盖')
});

/* ══════════════════ 付费用户档案 ══════════════════ */

const PATRON_DATA = {
  days: 30,
  from: 0,
  to: 0,
  scanned: 3,
  bigSpendBattery: 5_000,
  returnBattery: 3_000,
  patrons: [
    {
      uid: '1',
      name: '甲',
      totalBattery: 2_000,
      giftBattery: 2_000,
      guardBattery: 0,
      scBattery: 0,
      giftCount: 1,
      guardCount: 0,
      scCount: 0,
      firstTs: 1_700_000_000_000,
      lastTs: 1_700_000_000_000,
      rank: 1,
    },
  ],
  totals: {
    patrons: 1,
    totalBattery: 2_000,
    giftBattery: 2_000,
    guardBattery: 0,
    scBattery: 0,
    giftCount: 1,
    guardCount: 0,
    scCount: 0,
  },
};

async function mountPatrons(t, { data = PATRON_DATA, fail = '', deferGet = false } = {}) {
  installDom();
  const calls = [];
  let releaseGet = null;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });

    if (fail && path.startsWith('/api/patrons')) throw new Error(fail);
    if (path.startsWith('/api/patrons?')) {
      if (deferGet) await new Promise((r) => { releaseGet = r; });
      return { ok: true, status: 200, json: async () => ({ ok: true, ...data }) };
    }
    if (path === '/api/patrons/alert') {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, battery: body.battery, returnBattery: body.returnBattery ?? 0 }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: { message: '没有这个接口' } }) };
  };
  t.after(() => {
    delete globalThis.fetch;
  });

  const { createPatrons } = await import('../../web/views/patrons.js');
  const dlg = new FakeNode('dialog');
  dlg.open = false;
  dlg.showModal = () => {
    dlg.open = true;
  };
  dlg.close = () => {
    dlg.open = false;
  };

  const toasts = [];
  const view = createPatrons({
    dlg,
    toast: (text, level = 'info') => toasts.push({ text, level }),
  });
  return { view, dlg, toasts, calls, releaseGet: () => releaseGet?.() };
}

test('付费用户榜：打开就拉最近 30 天，榜单和阈值都回填', async (t) => {
  const { view, dlg, calls } = await mountPatrons(t);
  view.open();
  assert.equal(dlg.open, true);
  await new Promise((r) => setImmediate(r));

  assert.match(calls[0].path, /\/api\/patrons\?days=30&limit=50/, '默认看最近 30 天')
  assert.equal(dlg.all('patron-row').length, 1)
  assert.match(dlg.all('patron-row')[0].textContent, /甲/)
  assert.match(dlg.all('patron-row')[0].textContent, /¥200/)
  assert.equal(dlg.all('patron-num')[0].value, '500', '阈值 5000 电池 = ¥500')
  assert.equal(dlg.all('patron-num')[1].value, '300', '回访门槛 3000 电池 = ¥300')
});

test('付费用户榜：切范围会按新的 days 重新拉', async (t) => {
  const { view, dlg, calls } = await mountPatrons(t);
  view.open();
  await new Promise((r) => setImmediate(r));

  const seven = dlg.all('chip').find((c) => c.textContent === '最近 7 天');
  seven.listeners.click[0]();
  await new Promise((r) => setImmediate(r));

  assert.match(calls.at(-1).path, /days=7/)
});

test('付费用户榜：阈值输入用元，发给服务端的是电池', async (t) => {
  const { view, dlg, toasts, calls } = await mountPatrons(t);
  view.open();
  await new Promise((r) => setImmediate(r));

  const save = dlg.all('btn').find((b) => b.textContent === '保存');

  // 清空输入框是「没填」，不能因为 Number('') === 0 被当成「关闭提醒」
  dlg.all('patron-num')[0].value = '   ';
  save.listeners.click[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, '空阈值不能发请求');
  assert.match(toasts.at(-1).text, /要写成 0 或正数/);

  dlg.all('patron-num')[0].value = '1000';
  save.listeners.click[0]();
  await new Promise((r) => setImmediate(r));

  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual(
    post.body,
    { battery: 10_000, returnBattery: 3_000 },
    '¥1000 = 10000 电池；回访门槛一并提交',
  )
  assert.match(toasts.at(-1).text, /¥1000/)
});

test('付费用户榜：迟到的旧榜单不能把刚保存的阈值改回去', async (t) => {
  const { view, dlg, releaseGet } = await mountPatrons(t, { deferGet: true });
  view.open(); // 榜单请求挂在路上
  dlg.all('patron-num')[0].value = '1000';
  dlg.all('btn').find((b) => b.textContent === '保存').listeners.click[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(dlg.all('patron-num')[0].value, '1000', '保存成功先显示新值');

  releaseGet(); // 旧榜单现在才回来（bigSpendBattery 还是 5000）
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(dlg.all('patron-num')[0].value, '1000', '旧响应不能把刚保存的阈值改回去');
});

test('付费用户榜：空数据要给出空状态，不能只留一片空白', async (t) => {
  const { view, dlg } = await mountPatrons(t, {
    data: {
      ...PATRON_DATA,
      patrons: [],
      totals: { ...PATRON_DATA.totals, patrons: 0, totalBattery: 0, giftBattery: 0 },
    },
  });
  view.open();
  await new Promise((r) => setImmediate(r));

  assert.match(dlg.textContent, /这段时间还没有付费记录/)
  assert.match(dlg.textContent, /没有符合条件的付费用户/)
});

test('付费用户榜：页面上的按钮和弹窗必须真的接到 app.js', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8');
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8');
  const api = readFileSync(join(process.cwd(), 'web/core/api.js'), 'utf8');

  assert.ok(html.includes('id="btn-patrons"'), 'index.html 里没有付费用户榜按钮')
  assert.ok(html.includes('id="dlg-patrons"'), 'index.html 里没有付费用户榜弹窗')
  assert.match(app, /createPatrons\s*\(/, 'app.js 没有创建付费用户榜')
  assert.match(app, /patrons\.open\(\)/, '按钮没接到 open()')
  assert.match(app, /patrons\.refreshIfOpen\(\)/, '换房间时要刷新付费用户榜')
  assert.match(api, /\/api\/patrons\?days=/, 'api.js 没有付费用户榜接口')
  assert.match(api, /\/api\/patrons\/alert/, 'api.js 没有大额阈值接口')
});

/* ══════════════════ SC 待读 ══════════════════ */

const SC_DATA = {
  days: 30,
  from: 0,
  to: 0,
  scanned: 2,
  unread: 1,
  items: [
    {
      id: 'e100-3',
      seq: 3,
      ts: 1_700_000_010_000,
      uid: '1',
      name: '甲',
      text: '你好呀',
      money: '¥30',
      battery: 300,
      read: false,
    },
    {
      id: 'e100-2',
      seq: 2,
      ts: 1_700_000_000_000,
      uid: '2',
      name: '乙',
      text: '看过了',
      money: '¥50',
      battery: 500,
      read: true,
    },
  ],
}

async function mountScQueue(t, { data = SC_DATA, fail = '' } = {}) {
  installDom()
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url)
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })

    if (fail && path.startsWith('/api/sc')) throw new Error(fail)
    if (path.startsWith('/api/sc?')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, ...data }) }
    }
    if (path === '/api/sc/read') {
      const ids = JSON.parse(init.body).ids
      return { ok: true, status: 200, json: async () => ({ ok: true, marked: ids.length }) }
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: { message: '没有这个接口' } }) }
  }
  t.after(() => {
    delete globalThis.fetch
  })

  const { createScQueue } = await import('../../web/views/sc-queue.js')
  const dlg = new FakeNode('dialog')
  dlg.open = false
  dlg.showModal = () => {
    dlg.open = true
  }
  dlg.close = () => {
    dlg.open = false
  }
  const badge = new FakeNode('span')

  const toasts = []
  const view = createScQueue({
    dlg,
    badge,
    toast: (text, level = 'info') => toasts.push({ text, level }),
  })
  return { view, dlg, badge, toasts, calls }
}

test('SC 待读：打开就拉最近 30 天，渲染条目并回填徽标', async (t) => {
  const { view, dlg, badge, calls } = await mountScQueue(t)
  view.open()
  assert.equal(dlg.open, true)
  await new Promise((r) => setImmediate(r))

  assert.match(calls[0].path, /\/api\/sc\?days=30/, '默认看最近 30 天')
  assert.equal(dlg.all('sc-row').length, 2)
  assert.match(dlg.textContent, /你好呀/)
  assert.match(dlg.textContent, /¥30/)
  assert.equal(badge.textContent, '1', '徽标只数未读')
  assert.equal(badge.hidden, false)
})

test('SC 待读：切范围会按新的 days 重新拉', async (t) => {
  const { view, dlg, calls } = await mountScQueue(t)
  view.open()
  await new Promise((r) => setImmediate(r))

  const seven = dlg.all('chip').find((c) => c.textContent === '最近 7 天')
  seven.listeners.click[0]()
  await new Promise((r) => setImmediate(r))

  assert.match(calls.at(-1).path, /days=7/)
})

test('SC 待读：点单条已读只提交这一条的 id，徽标跟着降', async (t) => {
  const { view, dlg, badge, calls } = await mountScQueue(t)
  view.open()
  await new Promise((r) => setImmediate(r))

  dlg.all('sc-mark')[0].listeners.click[0]()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  const post = calls.find((c) => c.method === 'POST')
  assert.deepEqual(post.body, { ids: ['e100-3'] })
  assert.equal(badge.hidden, true, '全读完了徽标要收起来')
  assert.match(dlg.all('sc-row')[0]._cls(), /is-read/)
})

test('SC 待读：全部已读把剩下的 id 一次提交；没有未读时只提示', async (t) => {
  const { view, dlg, calls, toasts } = await mountScQueue(t, {
    data: {
      ...SC_DATA,
      unread: 2,
      items: SC_DATA.items.map((it) => ({ ...it, read: false })),
    },
  })
  view.open()
  await new Promise((r) => setImmediate(r))

  dlg.all('btn').find((b) => b.textContent === '全部已读').listeners.click[0]()
  await new Promise((r) => setImmediate(r))
  const post = calls.find((c) => c.method === 'POST')
  assert.deepEqual(post.body.ids.sort(), ['e100-2', 'e100-3'])

  await new Promise((r) => setImmediate(r))
  dlg.all('btn').find((b) => b.textContent === '全部已读').listeners.click[0]()
  await new Promise((r) => setImmediate(r))
  assert.match(toasts.at(-1).text, /没有未读/)
})

test('SC 待读：面板关着时新 SC 也要抬徽标，打开后以服务端未读为准', async (t) => {
  const { view, badge } = await mountScQueue(t)
  view.bump(2)
  assert.equal(badge.textContent, '2')
  assert.equal(badge.hidden, false)

  view.open()
  await new Promise((r) => setImmediate(r))
  assert.equal(badge.textContent, '1', '打开后不能把已读的旧 SC 又算成未读')
})

test('SC 待读：空数据给空状态，不抛也不留白', async (t) => {
  const { view, dlg } = await mountScQueue(t, {
    data: { days: 30, from: 0, to: 0, scanned: 0, unread: 0, items: [] },
  })
  view.open()
  await new Promise((r) => setImmediate(r))

  assert.match(dlg.textContent, /还没有醒目留言/)
  assert.match(dlg.textContent, /共 0 条/)
})

test('SC 待读：接口失败只提示，不把面板打崩', async (t) => {
  const { view, dlg, toasts } = await mountScQueue(t, { fail: '日志读不出来' })
  view.open()
  await new Promise((r) => setImmediate(r))

  assert.match(toasts.at(-1).text, /醒目留言清单打不开/)
  assert.equal(dlg.open, true)
})

test('SC 待读：按钮、弹窗和 api 必须真的接到 app.js', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')
  const apiSrc = readFileSync(join(process.cwd(), 'web/core/api.js'), 'utf8')

  assert.ok(html.includes('id="btn-sc"'), 'index.html 里没有 SC 待读按钮')
  assert.ok(html.includes('id="sc-badge"'), 'index.html 里没有未读徽标')
  assert.ok(html.includes('id="dlg-sc"'), 'index.html 里没有 SC 待读弹窗')
  assert.match(app, /createScQueue\s*\(/, 'app.js 没有创建 SC 待读面板')
  assert.match(app, /scQueue\.open\(\)/, '按钮没接到 open()')
  assert.match(app, /scQueue\.reset\(\)/, '换房间时要重置未读徽标')
  assert.match(app, /scQueue\.bump\(/, '实时事件要把徽标抬起来')
  assert.match(apiSrc, /\/api\/sc\?days=/, 'api.js 没有 SC 清单接口')
  assert.match(apiSrc, /\/api\/sc\/read/, 'api.js 没有标记已读接口')
})

/* ══════════════════ 本场礼物目标 ══════════════════ */

async function mountGoal({ goalBattery = 0, announce = false, texts = {}, fail = '' } = {}) {
  const { createGoalConfig } = await import('../../web/views/goal-config.js')
  const input = new FakeNode('input')
  const announceBox = new FakeNode('input')
  const textBoxes = {
    30: new FakeNode('input'),
    60: new FakeNode('input'),
    80: new FakeNode('input'),
    100: new FakeNode('input'),
  }
  const button = new FakeNode('button')
  const saved = []
  const toasts = []
  const api = {
    goal: async () => ({ ok: true, goalBattery, announce, texts }),
    saveGoal: async (v) => {
      if (fail) throw new Error(fail)
      saved.push(v)
      // 和服务端一样：目标清零时播报开关也要收掉
      return {
        ok: true,
        goalBattery: v.goalBattery,
        announce: v.goalBattery ? v.announce : false,
        texts: v.texts ?? {},
      }
    },
  }
  const cfg = createGoalConfig({
    input,
    announceBox,
    textBoxes,
    button,
    api,
    toast: (text, level) => toasts.push({ text, level }),
  })
  return { cfg, input, announceBox, textBoxes, button, saved, toasts }
}

test('礼物目标：打开时把电池回填成元，勾选与四档文案跟着回填', async () => {
  const { cfg, input, announceBox, textBoxes } = await mountGoal({
    goalBattery: 20_000,
    announce: true,
    texts: { 30: '还差一点', 100: '达成啦' },
  })
  await cfg.load()
  assert.equal(input.value, '2000', '输入框单位是元，不能把 20000 电池直接填进去')
  assert.equal(announceBox.checked, true)
  assert.equal(textBoxes[30].value, '还差一点')
  assert.equal(textBoxes[100].value, '达成啦')
  assert.equal(textBoxes[60].value, '')
})

test('礼物目标：保存把元换算成电池，播报开关与文案一起发', async () => {
  const { cfg, input, announceBox, textBoxes, button, toasts, saved } = await mountGoal()
  input.value = '1000'
  announceBox.checked = true
  textBoxes[60].value = '  老板大气  '
  await cfg.save()

  assert.deepEqual(saved, [
    { goalBattery: 10_000, announce: true, texts: { 60: '老板大气' } },
  ])
  assert.equal(toasts.at(-1).level, 'info')
  assert.match(toasts.at(-1).text, /30\/60\/80\/100% 过线时播报/)
  assert.equal(button.disabled, false)
})

test('礼物目标：清空或非数字不发请求，保留原文并提示', async () => {
  const { cfg, input, toasts, saved } = await mountGoal()

  input.value = '   '
  await cfg.save()
  assert.deepEqual(saved, [], '空串不能当成 0 关掉目标')

  input.value = 'abc'
  await cfg.save()
  assert.deepEqual(saved, [])
  assert.equal(input.value, 'abc', '让用户改，不能偷偷清掉')
  assert.equal(toasts.at(-1).level, 'error')
})

test('礼物目标：保存 0 时强制关播报，不留下假开关', async () => {
  const { cfg, input, announceBox, toasts, saved } = await mountGoal()
  input.value = '0'
  announceBox.checked = true
  await cfg.save()

  assert.deepEqual(saved, [{ goalBattery: 0, announce: true, texts: {} }], '勾选状态照发，服务端会收掉')
  assert.equal(announceBox.checked, false, '回填以服务端返回为准')
  assert.match(toasts.at(-1).text, /已关闭礼物目标/)
})

test('礼物目标：保存失败保留用户填的目标，按钮恢复', async () => {
  const { cfg, input, button, toasts } = await mountGoal({ fail: '写不进配置' })
  input.value = '888'
  await cfg.save()

  assert.equal(input.value, '888')
  assert.equal(toasts.at(-1).text, '写不进配置')
  assert.equal(button.disabled, false)
})

test('礼物目标：输入框回车是保存，不提交房间表单', async () => {
  const { cfg, input, saved } = await mountGoal()
  input.value = '500'

  let prevented = false
  input.listeners.keydown[0]({ key: 'Enter', preventDefault: () => (prevented = true) })
  await new Promise((r) => setImmediate(r))

  assert.equal(prevented, true)
  assert.deepEqual(saved, [{ goalBattery: 5_000, announce: false, texts: {} }])
})

test('礼物目标：页面控件必须真的接到 app.js', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')
  const apiSrc = readFileSync(join(process.cwd(), 'web/core/api.js'), 'utf8')

  for (const id of [
    'goal-input',
    'goal-save',
    'goal-announce',
    'goal-text-30',
    'goal-text-60',
    'goal-text-80',
    'goal-text-100',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 里没有 #${id}`)
  }
  assert.match(app, /createGoalConfig\s*\(/, 'app.js 没有创建礼物目标设置')
  assert.match(app, /goalInput:\s*\$\('#goal-input'\)/)
  assert.match(app, /goalAnnounce:\s*\$\('#goal-announce'\)/)
  assert.match(app, /goalText30:\s*\$\('#goal-text-30'\)/)
  assert.match(app, /textBoxes:\s*\{/, 'app.js 没把四档文案框传给设置模块')
  assert.match(app, /goalConfig\.load\(\)/, '打开总览时要回填目标')
  assert.match(apiSrc, /\/api\/goal/, 'api.js 没有礼物目标接口')
})

/* ══════════════════ 点歌队列 ══════════════════ */

const SONGS_DATA = {
  current: { id: 's1', status: 'playing', song: '晴天', name: '甲', yuan: 30 },
  queued: 1,
  items: [
    { id: 's1', status: 'playing', song: '晴天', name: '甲', yuan: 30 },
    { id: 's2', status: 'queued', song: '后来', name: '乙', yuan: 50 },
  ],
}

async function mountSong(t, { data = SONGS_DATA, fail = '' } = {}) {
  installDom()
  const calls = []
  const api = {
    songs: async () => {
      if (fail) throw new Error(fail)
      return { ok: true, ...data }
    },
    songAction: async (id, action) => {
      calls.push({ id, action })
      if (fail) throw new Error(fail)
      return { ok: true, item: { id, action } }
    },
  }

  const { createSongQueue } = await import('../../web/views/song-queue.js')
  const dlg = new FakeNode('dialog')
  dlg.open = false
  dlg.showModal = () => {
    dlg.open = true
  }
  dlg.close = () => {
    dlg.open = false
  }
  const badge = new FakeNode('span')
  const toasts = []
  const view = createSongQueue({
    dlg,
    badge,
    api,
    toast: (text, level = 'info') => toasts.push({ text, level }),
  })
  return { view, dlg, badge, toasts, calls }
}

test('点歌队列：打开渲染条目，徽标只数排队中的', async (t) => {
  const { view, dlg, badge } = await mountSong(t)
  view.open()
  assert.equal(dlg.open, true)
  await new Promise((r) => setImmediate(r))

  assert.equal(dlg.all('song-row').length, 2)
  assert.match(dlg.textContent, /晴天/)
  assert.match(dlg.textContent, /正在播放：晴天/)
  assert.equal(badge.textContent, '1', '播放中的那条不算徽标')
  assert.equal(badge.hidden, false)
})

test('点歌队列：播放切换当前条，完成会移除并更新徽标', async (t) => {
  const { view, dlg, badge, calls } = await mountSong(t)
  view.open()
  await new Promise((r) => setImmediate(r))

  const play = dlg.all('song-actions').find((row) => row.textContent.includes('播放'))
  play.all('btn').find((b) => b.textContent === '播放').listeners.click[0]()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls.at(-1), { id: 's2', action: 'play' })
  assert.match(dlg.textContent, /正在播放：后来/)

  dlg.all('song-row')[1].all('btn').find((b) => b.textContent === '完成').listeners.click[0]()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls.at(-1), { id: 's2', action: 'done' })
  assert.equal(dlg.all('song-row').length, 1)
})

test('点歌队列：接口失败只提示，不把队列改坏', async (t) => {
  const { view, dlg, badge, toasts } = await mountSong(t, { fail: '写不进 data/songs.json' })
  view.open()
  await new Promise((r) => setImmediate(r))
  assert.match(toasts[0].text, /点歌队列打不开/)

  const empty = await mountSong(t, { data: { current: null, queued: 0, items: [] } })
  empty.view.open()
  await new Promise((r) => setImmediate(r))
  assert.match(empty.dlg.textContent, /还没有人点歌/)
  assert.equal(empty.badge.hidden, true)
})

test('点歌队列：切房间 reset 后重新拉取，不能把全局队列的徽标清零', async (t) => {
  const { view, badge } = await mountSong(t)
  view.open()
  await new Promise((r) => setImmediate(r))
  assert.equal(badge.textContent, '1')

  view.reset()
  await new Promise((r) => setImmediate(r))
  assert.equal(badge.textContent, '1', '队列是全局的，换房间不能清零徽标')
  assert.equal(badge.hidden, false)
})

test('点歌队列：页面控件必须真的接到 app.js', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')
  const apiSrc = readFileSync(join(process.cwd(), 'web/core/api.js'), 'utf8')

  for (const id of ['btn-songs', 'songs-badge', 'dlg-songs']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 里没有 #${id}`)
  }
  assert.match(app, /createSongQueue\s*\(/)
  assert.match(app, /songsBadge:\s*\$\('#songs-badge'\)/)
  assert.match(app, /songQueue\.open\(\)/)
  assert.match(app, /case 'songs':/, 'WebSocket 的 songs 广播没有接')
  assert.match(apiSrc, /\/api\/songs/)
  assert.match(apiSrc, /songAction/)
})

async function mountPush({
  provider = '',
  target = '',
  week = false,
  withWeek = false,
  fail = '',
  testResult = null,
  deferGet = false,
} = {}) {
  const { createPushConfig } = await import('../../web/views/push-config.js')
  const select = new FakeNode('select')
  const input = new FakeNode('input')
  const saveButton = new FakeNode('button')
  const testButton = new FakeNode('button')
  const hint = new FakeNode('p')
  const weekBox = withWeek ? new FakeNode('input') : null
  const saved = []
  const toasts = []
  let releaseGet = null
  const api = {
    push: () => {
      if (!deferGet) return Promise.resolve({ ok: true, provider, target, weekly: week })
      return new Promise((resolve) => {
        releaseGet = () => resolve({ ok: true, provider, target, weekly: week })
      })
    },
    savePush: async (p, t, w) => {
      if (fail) throw new Error(fail)
      saved.push(w === undefined ? { provider: p, target: t } : { provider: p, target: t, weekly: w })
      return { ok: true, provider: p, target: t, weekly: w === undefined ? false : w }
    },
    testPush: async () => testResult ?? { ok: true, sent: true },
  }
  const cfg = createPushConfig({
    select,
    input,
    saveButton,
    testButton,
    hint,
    weekBox,
    api,
    toast: (text, level) => toasts.push({ text, level }),
  })
  return {
    cfg,
    select,
    input,
    saveButton,
    testButton,
    hint,
    weekBox,
    saved,
    toasts,
    releaseGet: () => releaseGet?.(),
  }
}

test('手机推送：打开时回填渠道与目标，并切到对应的说明', async () => {
  const { cfg, select, input, hint } = await mountPush({ provider: 'ntfy', target: 'yuyue3' })
  await cfg.load()
  assert.equal(select.value, 'ntfy')
  assert.equal(input.value, 'yuyue3')
  assert.match(hint.textContent, /topic/)
})

test('手机推送：只填目标不选渠道、或选了渠道不填目标，都不发请求', async () => {
  const { cfg, select, input, saved, toasts } = await mountPush()

  select.value = ''
  input.value = 'abc'
  await cfg.save()
  assert.equal(saved.length, 0)
  assert.match(toasts.at(-1).text, /先选一个推送渠道/)

  select.value = 'bark'
  input.value = ''
  await cfg.save()
  assert.equal(saved.length, 0)
  assert.match(toasts.at(-1).text, /填一下推送目标/)
})

test('手机推送：保存会把渠道与目标一起发，成功后回填', async () => {
  const { cfg, select, input, saved, toasts } = await mountPush()
  select.value = 'bark'
  input.value = '  abc123  '
  await cfg.save()

  assert.deepEqual(saved, [{ provider: 'bark', target: 'abc123' }])
  assert.equal(input.value, 'abc123')
  assert.match(toasts.at(-1).text, /已保存手机推送（Bark（iOS））/)
  assert.equal(toasts.at(-1).level, 'info')
})

test('手机推送：保存失败保留输入，按钮恢复', async () => {
  const { cfg, select, input, saveButton, toasts } = await mountPush({ fail: '写不进去' })
  select.value = 'serverchan'
  input.value = 'SCT123456789'
  await cfg.save()

  assert.equal(input.value, 'SCT123456789', '失败不能把用户填的 key 清掉')
  assert.equal(saveButton.disabled, false)
  assert.match(toasts.at(-1).text, /写不进去/)
  assert.equal(toasts.at(-1).level, 'error')
})

test('手机推送：保存失败后在途的旧 load 也不能把输入改回去', async () => {
  const { cfg, select, input, releaseGet, toasts } = await mountPush({
    provider: 'ntfy',
    target: 'yuyue3',
    fail: '写不进去',
    deferGet: true,
  })

  const loading = cfg.load()
  select.value = 'bark'
  input.value = 'newkey'
  await cfg.save()
  assert.match(toasts.at(-1).text, /写不进去/)

  releaseGet()
  await loading
  assert.equal(input.value, 'newkey', '迟到的旧设置不能盖掉刚填的值')
})

test('手机推送：测试成功与失败都要给出明确结果', async () => {
  const ok = await mountPush({ provider: 'bark', target: 'abc' })
  ok.select.value = 'bark'
  ok.input.value = 'abc'
  await ok.cfg.test()
  assert.match(ok.toasts.at(-1).text, /测试推送发出去了/)

  const bad = await mountPush({
    provider: 'bark',
    target: 'abc',
    testResult: { ok: true, sent: false, error: 'key 无效', status: 0 },
  })
  bad.select.value = 'bark'
  bad.input.value = 'abc'
  await bad.cfg.test()
  assert.match(bad.toasts.at(-1).text, /key 无效/)
})

test('手机推送：页面控件必须真的接到 app.js', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')
  const apiSrc = readFileSync(join(process.cwd(), 'web/core/api.js'), 'utf8')

  for (const id of ['push-provider', 'push-target', 'push-save', 'push-test', 'push-hint']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 里没有 #${id}`)
  }
  assert.match(app, /createPushConfig\s*\(/)
  assert.match(app, /pushProvider:\s*\$\('#push-provider'\)/)
  assert.match(app, /pushConfig\.load\(\)/)
  assert.match(apiSrc, /\/api\/push\/test/)
  assert.match(apiSrc, /savePush/)
})

test('手机推送：周报开关会随配置回填，保存时一起提交', async () => {
  const { cfg, select, input, weekBox, saved, toasts } = await mountPush({
    provider: 'bark',
    target: 'abc123',
    week: true,
    withWeek: true,
  })
  await cfg.load()
  assert.equal(weekBox.checked, true)

  select.value = 'bark'
  input.value = 'abc123'
  weekBox.checked = true
  await cfg.save()
  assert.deepEqual(saved, [{ provider: 'bark', target: 'abc123', weekly: true }])
  assert.match(toasts.at(-1).text, /每周一 10:00/)
})

test('手机推送：没配推送时勾周报，不发请求并当场提示', async () => {
  const { cfg, select, input, weekBox, saved, toasts } = await mountPush({ withWeek: true })
  select.value = ''
  input.value = ''
  weekBox.checked = true
  await cfg.save()
  assert.equal(saved.length, 0)
  assert.match(toasts.at(-1).text, /周报要推到手机/)
})

test('手机推送：周报控件必须真的接到页面与 app.js', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')
  assert.ok(html.includes('id="push-weekly"'), 'index.html 里没有 #push-weekly')
  assert.match(app, /pushWeekly:\s*\$\('#push-weekly'\)/)
  assert.match(app, /weekBox:\s*dom\.pushWeekly/)
})

/* ══════════════════ OBS 场景联动 ══════════════════ */

async function mountObs({
  enabled = false,
  url = '',
  liveScene = '',
  offlineScene = '',
  passwordSet = false,
  fail = '',
} = {}) {
  const { createObsConfig } = await import('../../web/views/obs-config.js')
  const enabledBox = new FakeNode('input')
  const urlInput = new FakeNode('input')
  const passwordInput = new FakeNode('input')
  const liveInput = new FakeNode('input')
  const offlineInput = new FakeNode('input')
  const saveButton = new FakeNode('button')
  const clearButton = new FakeNode('button')
  const hint = new FakeNode('p')
  const saved = []
  const toasts = []
  let view = { enabled, url, liveScene, offlineScene, passwordSet }
  const api = {
    obs: async () => ({ ok: true, ...view }),
    saveObs: async (payload) => {
      if (fail) throw new Error(fail)
      saved.push(payload)
      view = {
        enabled: Boolean(payload.enabled),
        url: payload.url ?? '',
        liveScene: payload.liveScene ?? '',
        offlineScene: payload.offlineScene ?? '',
        passwordSet: payload.clearPassword ? false : Boolean(payload.password) || view.passwordSet,
      }
      return { ok: true, ...view }
    },
  }
  const cfg = createObsConfig({
    enabledBox,
    urlInput,
    passwordInput,
    liveInput,
    offlineInput,
    saveButton,
    clearButton,
    hint,
    api,
    toast: (text, level) => toasts.push({ text, level }),
  })
  return {
    cfg,
    enabledBox,
    urlInput,
    passwordInput,
    liveInput,
    offlineInput,
    saveButton,
    clearButton,
    hint,
    saved,
    toasts,
  }
}

test('OBS 设置：打开时回填地址与场景，密码只提示已设置', async () => {
  const { cfg, enabledBox, urlInput, liveInput, offlineInput, passwordInput, hint } = await mountObs({
    enabled: true,
    url: 'ws://127.0.0.1:4455',
    liveScene: '直播中',
    offlineScene: '闲聊',
    passwordSet: true,
  })
  await cfg.load()
  assert.equal(enabledBox.checked, true)
  assert.equal(urlInput.value, 'ws://127.0.0.1:4455')
  assert.equal(liveInput.value, '直播中')
  assert.equal(offlineInput.value, '闲聊')
  assert.equal(passwordInput.value, '')
  assert.match(passwordInput.placeholder, /留空表示不改/)
  assert.match(hint.textContent, /留空表示不改/)
})

test('OBS 设置：密码留空表示不改，保存时不发 password 字段', async () => {
  const { cfg, urlInput, passwordInput, liveInput, saved } = await mountObs({
    enabled: true,
    url: 'ws://127.0.0.1:4455',
    liveScene: '直播中',
    passwordSet: true,
  })
  urlInput.value = 'ws://127.0.0.1:4466'
  liveInput.value = '主画面'
  passwordInput.value = ''
  await cfg.save(false)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].password, undefined)
  assert.equal(saved[0].clearPassword, false)
  assert.equal(saved[0].url, 'ws://127.0.0.1:4466')
})

test('OBS 设置：清空密码走 clearPassword', async () => {
  const { cfg, passwordInput, saved } = await mountObs({
    enabled: true,
    url: 'ws://127.0.0.1:4455',
    passwordSet: true,
  })
  passwordInput.value = 'something'
  await cfg.save(true)
  assert.equal(saved[0].clearPassword, true)
  assert.equal(saved[0].password, undefined)
})

test('OBS 设置：勾了联动却不填地址，不发请求', async () => {
  const { cfg, enabledBox, urlInput, saved, toasts } = await mountObs({ enabled: false })
  enabledBox.checked = true
  urlInput.value = ''
  await cfg.save(false)
  assert.equal(saved.length, 0)
  assert.match(toasts.at(-1).text, /不能为空/)
})

test('OBS 设置：保存失败保留输入并提示', async () => {
  const { cfg, urlInput, saved, toasts } = await mountObs({
    enabled: true,
    url: 'ws://127.0.0.1:4455',
    fail: '写不进配置',
  })
  urlInput.value = 'ws://127.0.0.1:4477'
  await cfg.save(false)
  assert.equal(saved.length, 0)
  assert.equal(urlInput.value, 'ws://127.0.0.1:4477')
  assert.match(toasts.at(-1).text, /保存 OBS 设置失败/)
})

test('OBS 设置：控件必须真的接到页面与 app.js', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')
  for (const id of ['obs-enabled', 'obs-url', 'obs-password', 'obs-live-scene', 'obs-offline-scene', 'obs-save']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 里没有 #${id}`)
  }
  assert.match(app, /createObsConfig\(/)
  assert.match(app, /obsEnabled:\s*\$\('#obs-enabled'\)/)
  assert.match(app, /obsConfig\.load\(\)/)
})

/* ══════════════════ PK 情报 ══════════════════ */

test('PK 情报：按钮、弹窗与接线都在，换房要重拉', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')
  const apiSrc = readFileSync(join(process.cwd(), 'web/core/api.js'), 'utf8')
  const view = readFileSync(join(process.cwd(), 'web/views/pk.js'), 'utf8')
  const css = readFileSync(join(process.cwd(), 'web/app.css'), 'utf8')

  for (const id of ['btn-pk', 'dlg-pk']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 里没有 #${id}`)
  }
  assert.match(app, /createPk\s*\(/)
  assert.match(app, /btnPk:\s*\$\('#btn-pk'\)/)
  assert.match(app, /dlgPk:\s*\$\('#dlg-pk'\)/)
  assert.match(app, /pkPanel\.open\(\)/)
  assert.match(app, /pkPanel\.refreshIfOpen\(\)/)
  assert.match(apiSrc, /\/api\/pk/)
  assert.match(apiSrc, /\/api\/pk\/refresh/)
  assert.match(view, /createPk\s*\(/)
  assert.match(css, /\.pk-grid/)
  assert.match(css, /\.pk-rank/)
  assert.match(css, /\.pk-brief/)
  assert.match(view, /briefBox\.checked/)
  assert.match(view, /nameInput\.value/)
  assert.match(view, /onlineInput\.value/)
  assert.match(view, /rankInput\.value/)
  assert.match(view, /strongInput\.value/)
  assert.match(view, /\{名字\}/)
  assert.match(view, /\{人数\}/)
  assert.match(view, /\{贡献\}/)
  assert.match(apiSrc, /savePk:\s*\(settings\)/)
})


/* ── 高光：只挑花钱的瞬间 ── */

test('高光：只挑礼物和 SC，按时间排，返回能收起', async (t) => {
  const payload = reportsPayload()
  const timeline = timelinePayload()
  installReportsDom(payload, [], timeline)
  t.after(() => delete globalThis.fetch)

  const { createReports } = await import('../../web/views/reports.js')
  const { dlg } = mountReports(payload, [])
  await createReports({ dlg, toast: () => {} }).open()

  const open = dlg.all('hl-open')[0]
  assert.ok(open, '每场卡片上都要有高光入口')
  await open.listeners.click[0]()

  const rows = dlg.all('hl-row')
  assert.equal(rows.length, 2, 'SENT 不算高光，只有礼物和 SC')
  assert.match(rows[0].textContent, /20:05/)
  assert.match(rows[0].textContent, /辣条/)
  assert.match(rows[1].textContent, /加油/)

  const back = dlg._find((n) => n.tagName === 'BUTTON' && n.textContent === '返回列表')
  assert.ok(back, '高光也要能返回列表')
  await back.listeners.click[0]()
  assert.equal(dlg.all('hl-row').length, 0, '返回后高光要收起')
  assert.equal(dlg.all('rpt-list')[0].hidden, false, '列表要回来')
})

test('高光：按钮、纯函数和样式都在，别只画个壳', () => {
  const reports = readFileSync(join(process.cwd(), 'web/views/reports.js'), 'utf8')
  const picker = readFileSync(join(process.cwd(), 'web/views/highlights.js'), 'utf8')
  const css = readFileSync(join(process.cwd(), 'web/app.css'), 'utf8')

  assert.match(reports, /pickHighlights/, 'reports.js 要真的调用挑拣函数')
  assert.match(reports, /openHighlights/, 'reports.js 要有打开高光的实现')
  assert.match(reports, /hl-open/, '场次卡片要有高光按钮')
  assert.match(picker, /export function pickHighlights/, 'highlights.js 要导出纯函数')
  assert.match(css, /\.hl-row\s*\{/, '高光列表要有样式')
  assert.match(css, /\.hl-copy\s*\{/, '复制按钮要有样式')
})
/* ── 健康状态灯：别只加个接口，页面得真的看 ── */

test('服务健康：状态灯真的接在页面和 api 上', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')
  const apiSrc = readFileSync(join(process.cwd(), 'web/core/api.js'), 'utf8')

  assert.ok(html.includes('id="health-pill"'), '顶部要有一个健康状态灯')
  assert.match(app, /refreshHealth/, 'app.js 要真的去拉健康状态')
  assert.match(app, /\/api\/health|api\.health/, 'app.js 要调健康接口')
  assert.match(apiSrc, /health:\s*\(\)\s*=>\s*request\('\/api\/health'/, 'api.js 要有 health 方法')
})
test('月报 / 季报：战报面板里有入口，接口也接上了', () => {
  const reports = readFileSync(join(process.cwd(), 'web/views/reports.js'), 'utf8')
  const apiSrc = readFileSync(join(process.cwd(), 'web/core/api.js'), 'utf8')
  assert.match(reports, /openPeriod/, 'reports.js 要能打开月报')
  assert.match(reports, /api\.period/, '月报要调 /api/period')
  assert.match(reports, /perBox/, '月报要有自己的容器')
  assert.match(apiSrc, /period:\s*\(kind/, 'api.js 要有 period 方法')
})