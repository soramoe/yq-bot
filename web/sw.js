/**
 * Service Worker：离线壳。
 *
 * ## 只做壳，不做数据
 *
 * 缓存的是页面本身（HTML / CSS / 各个 JS 模块 / 图标）。`/api/` 一律不碰 ——
 * 一个"看统计"的工具，最坏的情况不是打不开，而是**打开了，显示的却是昨天的数字**。
 * 所以数据请求宁可失败并由页面明说"断了"，也不要缓存顶上。
 *
 * ## 网络优先，不是缓存优先
 *
 * 常规 PWA 用缓存优先 + 内容哈希做版本管理。这个项目是零构建的：
 * 没有哈希、也没有资源清单，缓存优先就等于"改完代码要手动记得改版本号"，
 * 迟早出现"我明明改了，页面还是旧的"。本地服务的网络延迟几乎为零，
 * 所以这里反过来 —— 能连上就用新的，连不上才用缓存。
 *
 * ## 为什么要自己爬资源列表
 *
 * 没有打包器列出依赖，手写清单加一个模块就漏一次。安装时顺着 import
 * 和 HTML 里的 src/href 走一遍，爬到的都缓存，漏不掉。
 *
 * 单文件失败不影响整体安装（用 allSettled 而不是 addAll）：
 * 某个图标 404 不该让整个离线能力装不上。
 */

import {
  extractRefs,
  offlineFallback,
  resolveRef,
  shouldHandle,
  SHELL_SEEDS,
} from './core/sw-policy.js'

/**
 * 缓存名。改了这里就等于"换一代缓存"，旧的会在 activate 时被删掉。
 *
 * 平时不需要动它：策略是网络优先，改了前端下一次请求就是新的。
 * 只有"预缓存清单本身变了语义"（比如壳的入口文件换了）才值得升。
 */
const VERSION = 'v1'
const CACHE = `yy3-shell-${VERSION}`

/** 爬取起点。从 index.html 出发能顺着 href/script 覆盖到所有页面资源 */
const SEEDS = SHELL_SEEDS

/** 只有这些扩展名值得继续往下读源码找依赖 */
const CRAWLABLE = /\.(?:m?js|html)$/

/**
 * 预缓存：从 SEEDS 出发，顺着引用把整棵依赖树抓下来。
 * @returns {Promise<string[]>} 真的缓存成功的路径（调试用）
 */
async function precache() {
  const cache = await caches.open(CACHE)
  const seen = new Set()
  const queue = [...SEEDS]
  const done = []

  while (queue.length) {
    const path = queue.shift()
    if (seen.has(path)) continue
    seen.add(path)

    let res
    try {
      res = await fetch(path, { cache: 'no-store' })
    } catch {
      continue // 单个资源拿不到就算了，下次激活还有机会
    }
    if (!res.ok) continue

    await cache.put(path, res.clone())
    done.push(path)

    if (!CRAWLABLE.test(path)) continue
    for (const ref of extractRefs(await res.text())) {
      const abs = resolveRef(ref, path)
      if (abs && !seen.has(abs)) queue.push(abs)
    }
  }

  return done
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precache()
      .catch(() => {})
      // 装好就接班：这是个本机工具，不存在"等用户都关掉标签页再升级"的必要
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

/**
 * 网络优先，失败回落缓存。
 * @param {Request} request
 */
async function networkFirst(request) {
  try {
    const res = await fetch(request)
    // 只缓存我们自己源的正常响应：opaque / 304 存进去没用，还会让下次拿到空响应
    if (res && res.ok && res.type === 'basic') {
      const cache = await caches.open(CACHE)
      cache.put(request, res.clone()).catch(() => {})
    }
    return res
  } catch (err) {
    const cached = await caches.match(request)
    if (cached) return cached

    const fb = offlineFallback(request)
    if (fb) {
      const shell = await caches.match(fb)
      if (shell) return shell
    }

    throw err
  }
}

self.addEventListener('fetch', (event) => {
  if (!shouldHandle(event.request, self.location.origin)) return
  event.respondWith(networkFirst(event.request))
})

/** 页面上想主动让新版本接班时发这个（现在没用到，留个明确的入口） */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting()
})
