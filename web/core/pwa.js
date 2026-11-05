/**
 * PWA 接线：注册 Service Worker、断网时给个明确的说法。
 *
 * 依赖全部可注入（navigator / window / 提示条），因为 `check:pwa` 用假 DOM 跑，
 * 不能依赖浏览器全局。这和 views/* 里那些 create*({...}) 是同一套写法。
 */

/** SW 的位置必须和它的作用域一致：放在根目录才能管到整站 */
export const SW_URL = '/sw.js'

/**
 * 盯着在线状态，把"离线"这件事显示出来。
 *
 * 为什么要显式提示：SW 装好之后，断网打开页面**看起来是正常的** ——
 * 壳、样式、布局一样不少，只有数字停在上次。不说明白，人会以为
 * "直播间现在真的没人说话"，而不是"我看的是旧数据"。
 *
 * @returns {() => boolean} 立刻重算一次状态（测试与首屏都用它）
 */
export function watchConnection({ nav, win, banner, toast = () => {} } = {}) {
  const apply = () => {
    const online = nav?.onLine !== false
    if (banner) {
      banner.hidden = online
      banner.textContent = online ? '' : '离线 · 界面来自缓存，数据停在断开前'
    }
    return online
  }

  win?.addEventListener?.('offline', () => {
    apply()
    toast('网络断了：界面还能翻，但数据不再更新', 'warn')
  })

  win?.addEventListener?.('online', () => {
    apply()
    toast('网络回来了', 'info')
  })

  apply()
  return apply
}

/**
 * 注册 Service Worker。
 *
 * 失败不弹错误框：这影响的是"能不能离线看"，不影响主流程。
 * 但要说一声 —— 静默失败的话，用户只会觉得"这功能时灵时不灵"。
 *
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
export async function registerWorker({ nav, toast = () => {} } = {}) {
  if (!nav?.serviceWorker?.register) return null
  try {
    // type: 'module'：sw.js 要 import 纯函数模块（见 web/core/sw-policy.js）
    return await nav.serviceWorker.register(SW_URL, { type: 'module' })
  } catch (err) {
    toast(`离线缓存没装上：${err?.message ?? err}`, 'warn')
    return null
  }
}

/**
 * 一次装好。
 * @returns {() => boolean} 在线状态的即时计算函数
 */
export function installPwa({
  nav = globalThis.navigator,
  win = globalThis.window,
  banner = null,
  toast = () => {},
} = {}) {
  const apply = watchConnection({ nav, win, banner, toast })
  // 不 await：注册失败已经在里面处理了，主流程不该等它
  registerWorker({ nav, toast })
  return apply
}
