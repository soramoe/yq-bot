/**
 * 触发浏览器下载。
 *
 * 从 settings.js 搬出来的：现在有两个地方要下载文件（诊断包、导出的复盘页），
 * 复制一份的话，某天修了"游离锚点不触发下载"这类坑，另一份还留着。
 */

/**
 * @param {Blob} blob
 * @param {string} filename
 * @returns {boolean} false 表示这个环境没法自动下载（自检里的假 DOM）
 *
 * revoke 故意延后：某些浏览器在 click() 返回后才真正开始读 blob，
 * 立刻 revoke 会让下载变成一个 0 字节的文件。
 *
 * 锚点要先挂进文档再点：Firefox 和旧版 Safari 对**游离节点**的 click()
 * 不触发下载（Chrome 能过，所以在 Chrome 上写代码永远发现不了这个问题）。
 */
export function saveBlob(blob, filename) {
  try {
    if (typeof URL?.createObjectURL !== 'function') return false
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.style.display = 'none'
    const host = document.body ?? document.documentElement ?? null
    host?.append(a)
    a.click()
    a.remove?.()
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* 已经释放过就算了 */
      }
    }, 10_000)
    return true
  } catch {
    return false
  }
}

export default saveBlob
