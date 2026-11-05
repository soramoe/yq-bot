/**
 * PWA 自检。
 *
 * 这一组断言守的是"装不上"和"装上了但骗人"两类问题：
 *
 *   1. **清单/图标不合法 → 浏览器直接不给装**。这类错误在页面上没有任何提示，
 *      只有 DevTools 的 Application 面板里有一句红字，所以必须在自检里挡。
 *   2. **预缓存漏文件 → 离线时白屏**。零构建没有资源清单，加一个 views/xxx.js
 *      就漏一次；这里拿 SHELL_SEEDS 真的爬一遍，比对 web 下所有源码文件。
 *   3. **把接口也缓存 → 离线时显示昨天的数字**。这比打不开更糟：
 *      打不开人知道是断了，显示旧数字人会当成真的。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { extractRefs, resolveRef, shouldHandle, offlineFallback, SHELL_SEEDS } from '../../web/core/sw-policy.js'
import { watchConnection, registerWorker, SW_URL } from '../../web/core/pwa.js'
import { resolveStaticPath, serveStatic } from '../http/static.mjs'
import { securityHeaders } from '../http/json.mjs'

const WEB = join(process.cwd(), 'web')
const read = (...p) => readFileSync(join(WEB, ...p), 'utf8')

/* ══════════════════ 清单 ══════════════════ */

const manifest = JSON.parse(read('manifest.webmanifest'))

test('PWA 清单：必填字段齐全，装得上', () => {
  assert.equal(manifest.name, '渔情B站直播助手机器人 · 观测台')
  assert.ok(manifest.short_name && manifest.short_name.length <= 12, 'short_name 太长会被系统截断')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  // standalone 是"像 App 一样打开"的关键：缺了就是普通网页加个快捷方式
  assert.equal(manifest.display, 'standalone')
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i)
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i)
  assert.equal(manifest.lang, 'zh-CN')
})

test('PWA 清单：图标覆盖 192/512，且有一张 maskable', () => {
  const icons = manifest.icons ?? []
  const sizes = icons.map((i) => i.sizes)
  assert.ok(sizes.includes('192x192'), '缺 192：安卓安装提示要求至少一张 192')
  assert.ok(sizes.includes('512x512'), '缺 512：启动画面和高分屏要用')

  const maskable = icons.filter((i) => String(i.purpose).includes('maskable'))
  assert.equal(maskable.length, 1, 'maskable 图标必须有，否则安卓会把它裁成带黑边的方块')
  assert.equal(maskable[0].sizes, '512x512')

  for (const i of icons) assert.equal(i.type, 'image/png')
})

test('PWA 图标：文件真的存在，且是声明尺寸的 PNG', () => {
  for (const icon of manifest.icons) {
    const file = join(WEB, icon.src.replace(/^\//, ''))
    const buf = readFileSync(file)

    // PNG 魔数
    assert.deepEqual(
      [...buf.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${icon.src} 不是 PNG`,
    )
    // IHDR 紧跟在魔数后：长度(4) + 'IHDR'(4) + 宽(4) + 高(4)
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    const [dw, dh] = icon.sizes.split('x').map(Number)
    assert.equal(`${w}x${h}`, `${dw}x${dh}`, `${icon.src} 实际是 ${w}x${h}，清单里写的是 ${icon.sizes}`)
  }
})

test('PWA 清单：服务端认识 .webmanifest 这个后缀', () => {
  const abs = resolveStaticPath(WEB, '/manifest.webmanifest')
  assert.ok(abs, '静态服务不认 .webmanifest —— 清单会 404，浏览器就不给装')

  const src = readFileSync(join(process.cwd(), 'server', 'http', 'static.mjs'), 'utf8')
  assert.match(
    src,
    /\.webmanifest':\s*'application\/manifest\+json/,
    'MIME 必须是 application/manifest+json，发成 application/json 浏览器不认',
  )
})

/**
 * 上面那条只看得到"路径解析 + 源码里的 MIME 字样"。
 * 真起一次服务取一遍，才能确认发出去的 Content-Type 是浏览器要的那个 ——
 * 清单类型错的表现是"页面一切正常，就是装不上"，最难自己发现。
 */
test('静态服务：清单 / SW / 图标都能真的取到，且类型正确', async (t) => {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname
    const served = await serveStatic(req, res, WEB, pathname, securityHeaders())
    if (!served) res.writeHead(404).end()
  })
  const { port } = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address())))
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.()
    server.close(r)
  }))

  const base = `http://127.0.0.1:${port}`

  const mf = await fetch(`${base}/manifest.webmanifest`)
  assert.equal(mf.status, 200)
  assert.match(String(mf.headers.get('content-type')), /application\/manifest\+json/)
  assert.equal((await mf.json()).display, 'standalone', '发出的清单必须能直接解析')

  const sw = await fetch(`${base}/sw.js`)
  assert.equal(sw.status, 200)
  assert.match(String(sw.headers.get('content-type')), /text\/javascript/, 'SW 脚本的 MIME 错会被浏览器拒绝注册')
  assert.match(await sw.text(), /addEventListener\('install'/)

  const icon = await fetch(`${base}/icons/icon-192.png`)
  assert.equal(icon.status, 200)
  assert.equal(icon.headers.get('content-type'), 'image/png')

  // 离线壳里点到的每个文件都得真的取得到：漏一个，断网时就缺一块
  const bad = []
  for (const path of crawlShell()) {
    // 爬取认得粗，注释里的示例也会被抓出来（见 extractRefs 的注释）：
    // 这类路径在 SW 里就是一次 404 后跳过，不是缺陷，比对时排除
    if (!existsSync(join(WEB, path.replace(/^\//, '')))) continue
    const res = await fetch(`${base}${path}`)
    if (res.status !== 200) bad.push(`${path} → ${res.status}`)
  }
  assert.deepEqual(bad, [], `离线壳里有取不到的文件：\n  ${bad.join('\n  ')}`)
})

/* ══════════════════ 页面接线 ══════════════════ */

test('页面：声明了清单、主题色和离线提示位', () => {
  const html = read('index.html')
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/)
  assert.match(html, /<meta name="theme-color" content="#0b0d11"/)
  assert.match(html, /rel="apple-touch-icon"/, 'iOS 不读 manifest 的图标，得单独给一张')
  assert.match(
    html,
    /id="offline-pill"[^>]*hidden/,
    '离线提示必须默认隐藏：一开始就摆着"离线"会让人以为服务坏了',
  )

  const app = read('app.js')
  assert.match(app, /installPwa\(\{/, '入口要真的调用 installPwa，否则注册代码永远不执行')
})

test('CSP：放行 service worker 与 manifest', () => {
  const src = readFileSync(join(process.cwd(), 'server', 'http', 'json.mjs'), 'utf8')
  assert.match(src, /worker-src 'self'/, '不放行 worker-src，SW 脚本会被 CSP 拦掉')
  assert.match(src, /manifest-src 'self'/, '不放行 manifest-src，清单请求会被拦掉')
})

/* ══════════════════ 该接管谁 ══════════════════ */

const ORIGIN = 'http://127.0.0.1:8900'
const req = (path, init = {}) => ({ url: `${ORIGIN}${path}`, method: 'GET', ...init })

test('SW：接口和 WS 一律不接管（缓存了就会显示过期数字）', () => {
  assert.equal(shouldHandle(req('/api/status'), ORIGIN), false)
  assert.equal(shouldHandle(req('/api/timeline?from=1&to=2'), ORIGIN), false)
  assert.equal(shouldHandle(req('/ws?after=3'), ORIGIN), false)

  // 反向：真的该接管的必须接管，否则离线壳等于没装
  assert.equal(shouldHandle(req('/'), ORIGIN), true)
  assert.equal(shouldHandle(req('/app.js'), ORIGIN), true)
  assert.equal(shouldHandle(req('/views/reports.js'), ORIGIN), true)
  assert.equal(shouldHandle(req('/icons/icon-192.png'), ORIGIN), true)

  // 写操作不碰：POST 交给网络，失败就失败
  assert.equal(shouldHandle(req('/api/plugin', { method: 'POST' }), ORIGIN), false)
  // 别的站不碰
  assert.equal(shouldHandle({ url: 'https://www.bilibili.com/x', method: 'GET' }, ORIGIN), false)
})

test('SW：只有导航请求在离线时回落成壳', () => {
  assert.equal(offlineFallback({ mode: 'navigate' }), '/index.html')
  // 拿 HTML 顶替 JS 只会让浏览器把 HTML 当脚本解析，报一堆莫名其妙的错
  assert.equal(offlineFallback({ mode: 'cors' }), null)
  assert.equal(offlineFallback({}), null)
})

/* ══════════════════ 预缓存不许漏文件 ══════════════════ */

/** 从 SW 的起点出发，顺着 import / href 真的爬一遍 */
function crawlShell() {
  const seen = new Set()
  const queue = [...SHELL_SEEDS]

  while (queue.length) {
    const path = queue.shift()
    if (seen.has(path)) continue
    seen.add(path)
    if (!/\.(?:m?js|html)$/.test(path)) continue

    let text
    try {
      text = readFileSync(join(WEB, path.replace(/^\//, '')), 'utf8')
    } catch {
      continue // 爬不到由下面的"文件存在"断言负责
    }
    for (const ref of extractRefs(text)) {
      const abs = resolveRef(ref, path)
      if (abs && !seen.has(abs)) queue.push(abs)
    }
  }
  return seen
}

/** web 下所有源码文件的站内路径 */
function listSources(dir = WEB, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      listSources(abs, out)
      continue
    }
    if (!/\.(?:m?js|css|html)$/.test(name)) continue
    out.push('/' + relative(WEB, abs).split(sep).join('/'))
  }
  return out
}

test('SW 预缓存：web 下每个源码文件都在覆盖范围内', () => {
  const crawled = crawlShell()

  // sw.js 自己由浏览器负责更新，不进预缓存（也不该进：它一进缓存就再也不会更新）
  const missing = listSources()
    .filter((p) => p !== '/sw.js')
    .filter((p) => !crawled.has(p))

  assert.deepEqual(
    missing,
    [],
    `这些文件不在离线壳里，断网时页面会缺它们（多半是新增了模块）：\n  ${missing.join('\n  ')}`,
  )

  // 起点里点名的文件必须真的存在，否则 install 时会静默少缓存一个
  for (const seed of SHELL_SEEDS) {
    assert.doesNotThrow(
      () => statSync(join(WEB, seed.replace(/^\//, ''))),
      `预缓存起点 ${seed} 不存在`,
    )
  }
})

test('SW：网络优先 + 缓存名带版本 + 激活时清旧缓存', () => {
  const sw = read('sw.js')

  assert.match(sw, /networkFirst\(/, '策略必须是网络优先：零构建没有内容哈希，缓存优先会一直给旧代码')
  assert.match(sw, /const VERSION = '[^']+'/, '缓存名要带版本，否则升级时删不掉旧的')
  assert.match(sw, /caches\.delete/, 'activate 里要删旧缓存，否则磁盘会被历次版本堆满')
  assert.match(sw, /clients\.claim\(\)/, '要 claim，第一次装完才能立刻接管已打开的页面')
  assert.match(sw, /shouldHandle\(/, 'fetch 必须先过策略判断，不能无脑接管')
})

/* ══════════════════ 注册与离线提示 ══════════════════ */

function fakeWin() {
  const listeners = {}
  return {
    addEventListener: (type, fn) => {
      ;(listeners[type] ??= []).push(fn)
    },
    fire: (type) => (listeners[type] ?? []).forEach((fn) => fn()),
  }
}

test('离线提示：断网时显示，恢复后收起', () => {
  const banner = { hidden: true, textContent: '' }
  const nav = { onLine: true }
  const win = fakeWin()
  const said = []

  watchConnection({ nav, win, banner, toast: (t) => said.push(t) })

  assert.equal(banner.hidden, true, '一开始在线，提示要藏着')

  nav.onLine = false
  win.fire('offline')
  assert.equal(banner.hidden, false, '断网了必须说出来')
  assert.match(banner.textContent, /离线/)
  assert.match(said[0] ?? '', /数据不再更新/, '光说"离线"不够，要说清数据是旧的')
  assert.equal(said.length, 1)

  nav.onLine = true
  win.fire('online')
  assert.equal(banner.hidden, true)
  assert.equal(said.length, 2)
})

test('离线提示：打开页面时就已经断网，也要立刻显示', () => {
  const banner = { hidden: true, textContent: '' }
  const win = fakeWin()
  watchConnection({ nav: { onLine: false }, win, banner, toast: () => {} })
  assert.equal(banner.hidden, false, '首屏就离线时不能等 online/offline 事件')
})

test('注册：按 module 方式注册 /sw.js；失败只提示、不炸主流程', async () => {
  const seen = []
  const nav = { serviceWorker: { register: async (url, opts) => { seen.push({ url, opts }); return { scope: '/' } } } }

  const reg = await registerWorker({ nav, toast: () => {} })
  assert.deepEqual(reg, { scope: '/' })
  assert.equal(seen[0].url, SW_URL)
  assert.equal(seen[0].opts.type, 'module', 'sw.js 要 import 纯函数模块，必须走 module')

  // 不支持 SW 的浏览器（或 file:// 打开）：安静地什么都不做
  assert.equal(await registerWorker({ nav: {}, toast: () => {} }), null)

  const said = []
  const bad = { serviceWorker: { register: async () => { throw new Error('SecurityError') } } }
  assert.equal(await registerWorker({ nav: bad, toast: (t) => said.push(t) }), null)
  assert.equal(said.length, 1, '装失败要说一声，但不能抛出去')
  assert.match(said[0], /离线缓存没装上/)
})

/* ══════════════════ 真的把 sw.js 跑一遍 ══════════════════ */

/**
 * 前面的断言都在看"代码里写了什么"，这一条看"它到底做不做得到"。
 *
 * 用假的 `self` / `caches` 把 sw.js 真跑起来，因为 SW 里最容易犯的错
 * 恰恰不是逻辑，而是接线：事件名写错、`respondWith` 没调、`skipWaiting` 漏了 ——
 * 这些在源码断言里全都"看起来是对的"，装到浏览器里却是完全没反应，
 * 而且**页面上没有任何报错**，只有 Application 面板里一行灰字。
 */
test('SW 真的能装上：install 预缓存整壳，断网时导航回落到壳', async (t) => {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname
    const served = await serveStatic(req, res, WEB, pathname, securityHeaders())
    if (!served) res.writeHead(404).end()
  })
  const { port } = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address())))
  const base = `http://127.0.0.1:${port}`

  const realFetch = globalThis.fetch
  const listeners = {}
  const store = new Map()
  const put = []
  const notes = { skipWaiting: 0, claim: 0, deleted: [] }
  let offline = false

  const pathOf = (k) => new URL(typeof k === 'string' ? k : k.url, base).pathname

  const cache = {
    put: async (k, res) => {
      const p = pathOf(k)
      // 真缓存存的是响应副本：body 只能读一次，所以这里读成文本再重建
      store.set(p, { status: res.status, headers: [...res.headers], body: await res.clone().text() })
      put.push(p)
    },
    match: async (k) => {
      const hit = store.get(pathOf(k))
      return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined
    },
  }

  globalThis.self = {
    location: { origin: base },
    addEventListener: (type, fn) => {
      listeners[type] = fn
    },
    skipWaiting: async () => {
      notes.skipWaiting++
    },
    clients: {
      claim: async () => {
        notes.claim++
      },
    },
  }

  globalThis.caches = {
    open: async () => cache,
    match: async (k) => cache.match(k),
    keys: async () => [`yy3-shell-old`, 'some-other-cache'],
    delete: async (n) => {
      notes.deleted.push(n)
      return true
    },
  }

  globalThis.fetch = async (input, init) => {
    if (offline) throw new TypeError('Failed to fetch')
    // SW 里 `fetch('/index.html')` 是合法的：相对路径按 worker 自己的位置解析。
    // node 的 fetch 只认绝对 URL，这里把这层补上，否则测的不是产品代码而是桩的缺陷。
    const url = typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input
    return realFetch(url, init)
  }

  t.after(() => {
    globalThis.fetch = realFetch
    delete globalThis.self
    delete globalThis.caches
    return new Promise((r) => {
      server.closeAllConnections?.()
      server.close(r)
    })
  })

  // 真的把 sw.js 当模块加载一遍（带查询串避免命中别的用例的模块缓存）
  await import('../../web/sw.js?check-pwa')

  assert.equal(typeof listeners.install, 'function', '没有 install 监听：永远装不上')
  assert.equal(typeof listeners.activate, 'function')
  assert.equal(typeof listeners.fetch, 'function')

  /* ── install：预缓存 ── */
  const waiting = []
  listeners.install({ waitUntil: (p) => waiting.push(p) })
  await Promise.all(waiting)

  assert.equal(notes.skipWaiting, 1, '装好要接班，否则新版本要等所有标签页关掉才生效')
  assert.ok(put.includes('/index.html'), '壳本身没进缓存')
  assert.ok(put.includes('/views/reports.js'), '深层模块没爬进去：断网时战报会打不开')
  assert.ok(put.includes('/icons/icon-192.png'), '图标没进缓存')
  assert.equal(
    put.some((p) => p.startsWith('/api/')),
    false,
    '接口被写进了缓存 —— 离线时会显示过期数字',
  )

  /* ── activate：清旧缓存 ── */
  const activating = []
  listeners.activate({ waitUntil: (p) => activating.push(p) })
  await Promise.all(activating)
  assert.deepEqual(notes.deleted, ['yy3-shell-old', 'some-other-cache'], '旧缓存要清掉，但不能清掉自己')
  assert.equal(notes.claim, 1)

  /* ── fetch：在线走网络 ── */
  const ask = async (path, init = {}) => {
    let responded
    const event = {
      request: { url: `${base}${path}`, method: 'GET', mode: 'navigate', ...init },
      respondWith: (r) => {
        responded = r
      },
    }
    listeners.fetch(event)
    return responded ? await responded : undefined
  }

  const online = await ask('/')
  assert.ok(online, '导航请求必须被接管')
  assert.equal(online.status, 200)
  assert.match(await online.text(), /<title>渔情B站直播助手机器人/, '在线时要给服务器的真页面')

  /* ── fetch：断网回落成壳 ── */
  offline = true
  const offlineNav = await ask('/reports/deep-link')
  assert.ok(offlineNav, '断网打开必须给点东西，不能是浏览器的"无法连接"')
  assert.equal(offlineNav.status, 200)
  assert.match(await offlineNav.text(), /<title>渔情B站直播助手机器人/, '回落给的应该是壳')

  /* ── fetch：接口永远不接管（无论在线离线） ── */
  assert.equal(await ask('/api/status', { mode: 'cors' }), undefined, '接口不该被 SW 接管')
  assert.equal(await ask('/api/timeline?from=1&to=2', { mode: 'cors' }), undefined)

  /* ── fetch：写操作也不接管 ── */
  assert.equal(await ask('/api/room', { method: 'POST', mode: 'cors' }), undefined)
})
