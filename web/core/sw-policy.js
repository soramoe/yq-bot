/**
 * Service Worker 里"会做决定"的那部分，单独抽成纯函数。
 *
 * 为什么不在 sw.js 里直接写：SW 依赖 `self` / `caches` / `fetch`，在 node 里
 * 根本跑不起来 —— 于是这类逻辑只能靠"装到浏览器里点一下"来验证。
 * 而这里恰好是最容易写错、后果又最大的地方：
 *
 *   · 该跳过却没跳过的请求（比如 /api/），会把**过期数据**当成真数据给出去；
 *   · 该回落的导航请求没回落，离线时打开就是一片浏览器的"无法连接"。
 *
 * 抽出来之后，这两个判断都能在 `npm run check:pwa` 里断言。
 */

/** 接口一律直连，绝不进缓存：宁可报错，也不能给一份看起来正常的旧数字 */
export const API_PREFIX = '/api/'

/** 离线时导航回落到这个文件（就是壳） */
export const SHELL_URL = '/index.html'

/** WebSocket 不经 fetch 拦截，列出来是为了"读代码的人不用猜" */
export const WS_PATH = '/ws'

/**
 * 预缓存起点。
 *
 * 这份清单只放"爬不到入口"的东西：图标、清单、样式表（CSS 里的 @import
 * 这里不解析）。JS 全部靠 import 爬出来 —— 加一个模块忘了写进清单，
 * 是这个功能最典型的坏法，所以干脆不给人忘的机会。
 *
 * `check:pwa` 会拿着这份清单真的爬一遍，断言 web 下每个 js/css 都在覆盖范围内。
 */
export const SHELL_SEEDS = [
  SHELL_URL,
  '/app.css',
  '/tokens.css',
  '/app.js',
  '/manifest.webmanifest',
  '/favicon.svg',
  // SW 自己 import 的模块：离线时 SW 重启也要能加载，否则"离线"直接失效
  '/core/sw-policy.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon-180.png',
]

/**
 * 这个请求要不要交给 SW 处理。
 *
 * @param {{url:string, method?:string}} request Request 或形状相同的对象
 * @param {string} origin 页面自身的 origin
 * @returns {boolean}
 */
export function shouldHandle(request, origin) {
  if (!request || !request.url) return false
  if (String(request.method ?? 'GET').toUpperCase() !== 'GET') return false

  let url
  try {
    url = new URL(String(request.url))
  } catch {
    return false
  }
  if (url.origin !== origin) return false
  if (url.pathname.startsWith(API_PREFIX)) return false
  if (url.pathname === WS_PATH) return false
  return true
}

/**
 * 网络失败时该拿哪个页面顶上。
 *
 * 只有导航请求有"一整个页面"可回落；JS/CSS 缺了就是缺了，
 * 拿 index.html 顶替只会让浏览器把 HTML 当 JS 解析，报一堆莫名其妙的错。
 *
 * @param {{mode?:string}} request
 * @returns {string|null}
 */
export function offlineFallback(request) {
  return String(request?.mode ?? '') === 'navigate' ? SHELL_URL : null
}

/**
 * 从 JS / HTML 源码里找出引用的本地资源。
 *
 * 项目是零构建的：没有打包器给出资源清单，也就没有"哪些文件要预缓存"的答案。
 * 手写一份清单必然会漏（加一个 views/xxx.js 就忘一次），
 * 所以让 SW 在安装时顺着 import 和图里的 href 自己爬一遍。
 *
 * 认得粗：注释里写的示例也会被当成引用抓出来。这是**故意的取舍** ——
 * 抓到不存在的路径，安装时 fetch 拿不到就跳过，代价是一次 404；
 * 而为了排除注释去写一个 JS 词法分析器，才是真的不值得。
 *
 * @param {string} text
 * @returns {string[]} 原样写法的引用（解析交给 resolveRef）
 */
export function extractRefs(text) {
  const src = String(text ?? '')
  const out = []
  const push = (v) => {
    if (v) out.push(v)
  }

  // import x from './a.js' / export ... from './a.js'
  for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) push(m[1])
  // import './a.js'（副作用导入）
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) push(m[1])
  // import('./a.js')（动态导入）
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1])
  // <script src> / <link href>
  for (const m of src.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) push(m[1])

  return out.filter((v) => v.startsWith('/') || v.startsWith('./') || v.startsWith('../'))
}

/**
 * 把写法的引用解析成站内路径。
 *
 * @param {string} ref 例如 './core/dom.js'
 * @param {string} base 引用所在的文件路径，例如 '/app.js'
 * @returns {string|null} 例如 '/core/dom.js'；外链、锚点返回 null
 */
export function resolveRef(ref, base) {
  try {
    const u = new URL(String(ref), `http://sw.local${base}`)
    if (u.origin !== 'http://sw.local') return null
    return u.pathname
  } catch {
    return null
  }
}
