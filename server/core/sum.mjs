/**
 * 按类型分组后求和 —— 对账专用的「第二条计算路径」。
 *
 * 刻意与 Projection 的「边遍历边累加」不同：这里先把事件按类型装进桶，
 * 再逐桶求和。两条路径独立，才能抓到"某类事件漏处理""字段名读错"
 * 这类问题；如果对账复用投影的累加代码，它只能证明代码和自己一致。
 */

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function sumByType(events = []) {
  /** @type {Map<string, Array<object>>} */
  const groups = new Map()

  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue
    const payload = ev.payload ?? {}
    const bucket = groups.get(ev.type)
    if (bucket) bucket.push(payload)
    else groups.set(ev.type, [payload])
  }

  const total = (type, fn) => {
    const bucket = groups.get(type)
    if (!bucket) return 0
    let sum = 0
    for (const p of bucket) sum += fn(p)
    return sum
  }

  const count = (type) => groups.get(type)?.length ?? 0

  return {
    types: Object.fromEntries([...groups].map(([type, list]) => [type, list.length])),
    danmaku: count('DANMAKU'),
    enterCount: count('ENTER'),
    giftCount: total('GIFT', (p) => num(p.num) || 1),
    // 与 projection 保持同一口径：报文给了精确总价就用它。
    // 这里"独立"指的是算法独立（先分组再求和在两个维度上），
    // 不是口径独立 —— 口径是业务定义，两边必须一致，否则对账永远不会通过。
    // 免费礼物（银瓜子）金额记 0，个数照算：报文里同样带 total_coin，
    // 照加会让本场收入虚高，而且两边错得一样、对账发现不了。
    giftBattery: total('GIFT', (p) =>
      p.isPaid === false ? 0 : Number.isFinite(p.battery) ? p.battery : (num(p.num) || 1) * num(p.price),
    ),
    guardCount: total('GUARD_BUY', (p) => num(p.num) || 1),
    guardBattery: total('GUARD_BUY', (p) => (Number.isFinite(p.battery) ? p.battery : (num(p.num) || 1) * num(p.price))),
    // 醒目留言一条一个价，没有"数量"概念，所以个数 = 条数。
    // battery 由归一化层从「元」换算好，这里不再碰 price（那是元，不是电池）
    scCount: count('SUPER_CHAT'),
    scBattery: total('SUPER_CHAT', (p) => num(p.battery)),
  }
}

export default sumByType
