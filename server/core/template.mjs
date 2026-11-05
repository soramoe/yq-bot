/**
 * 模板渲染：`{用户}` 这类占位符 → 实际文本。
 *
 * 放在内核而不是插件里（决策记录 D3）：欢迎、答谢、下播、定时播报
 * 四个插件都要拼文本，各写一套的结果是「有的支持 {粉丝牌}，有的不支持」，
 * 用户永远记不住哪个模板能用哪些占位符。
 *
 * 三条规则：
 *
 * 1. **未知占位符原样保留**。`{不存在的}` 就留在那儿 ——
 *    悄悄替换成空串会让"模板写错了"变成"某个字不见了"，更难发现。
 *
 * 2. **值为空时回落**。比如没带粉丝牌，`{粉丝牌}` 用 fallback 或空串。
 *    这里不做"智能兜底"（比如拿等级冒充），那是插件的领域判断。
 *
 * 3. **渲染后收敛空白**。模板里 `欢迎 {用户} ！` 在用户名为空时
 *    会变成 `欢迎  ！`，多出来的空格要收掉。
 */

/**
 * @param {string} template
 * @param {Record<string, any>} vars
 * @param {{keepUnknown?:boolean}} [opts]
 * @returns {string}
 */
export function render(template, vars = {}, opts = {}) {
  const keepUnknown = opts.keepUnknown !== false
  const src = String(template ?? '')

  const out = src.replace(/\{([^{}]+)\}/g, (whole, rawKey) => {
    const key = String(rawKey).trim()
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      return keepUnknown ? whole : ''
    }
    const v = vars[key]
    return v === null || v === undefined ? '' : String(v)
  })

  // 收敛因空值产生的多余空白，但保留换行意图（弹幕本身是单行，这里不管换行）
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

/** 从模板里抽出用到的占位符，给前端做"这个模板需要哪些字段"的提示 */
export function placeholders(template) {
  const set = new Set()
  for (const m of String(template ?? '').matchAll(/\{([^{}]+)\}/g)) {
    set.add(String(m[1]).trim())
  }
  return [...set]
}

/** 模板里出现但没给值的占位符 —— 用于"模板写错了吗"的告警 */
export function missingVars(template, vars = {}) {
  return placeholders(template).filter((k) => !Object.prototype.hasOwnProperty.call(vars, k))
}

export default render
