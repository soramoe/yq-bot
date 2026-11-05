/**
 * 事件仓库。
 *
 * 只做三件事：去重、按 seq 排序、裁剪。
 *
 * **不做限流。** 这是二代"事件流停在 20:47"的直接教训：
 * 当时限流写在入库之前，重连补发的 60 条只放行了 3 条，数据永久丢了。
 * 限流属于渲染层（人眼也读不了每秒 30 行），入库必须一条不漏。
 */

/**
 * 内存里保留多少条。
 *
 * 必须 **≥ 服务端的事件缓冲上限**（`server/app.mjs` 的 `MAX_BUFFER`）。
 * 比它小的话，切走标签页几分钟再回来，服务端补发的是一整窗 5000 条，
 * 前端只留 4000 —— 中间那 1000 条永远补不回来，页面上看起来就像
 * "这段时间什么都没发生"。而事件流恰恰是用来事后核对"那几分钟发生了什么"的。
 *
 * 这条跨端约束由 `check-web` 的断言钉住（读两个文件比对），不靠记得改。
 */
const MAX = 5000;

export const store = {
  /** @type {Array<{seq:number, ts:number, type:string, payload:object}>} */
  events: [],
  lastSeq: 0,
  /** @type {Set<number>} */
  _seen: new Set(),

  /**
   * 收一批事件。返回真正新增的那些（已排序）。
   * @param {any[]} list
   * @returns {any[]}
   */
  ingest(list) {
    if (!Array.isArray(list) || list.length === 0) return [];

    const added = [];
    for (const ev of list) {
      if (!ev || typeof ev.seq !== 'number' || !Number.isFinite(ev.seq)) continue;
      if (this._seen.has(ev.seq)) continue;
      this._seen.add(ev.seq);
      added.push(ev);
    }
    if (added.length === 0) return [];

    // 先排序，再判断能不能直接追加。
    // 以前是拿 `added[0]` 当"这批里最小的"来判断 —— 只要服务端给来的
    // 不是升序（补发与实时流交错、以后的批量接口），事件顺序就会乱，
    // 而页面乱序看起来像"事件本身乱了"，没人会想到是排序条件写错了。
    added.sort((a, b) => a.seq - b.seq);

    // 绝大多数情况是"比现有最大的还大"，直接追加，避免 O(n log n)
    const tail = this.events[this.events.length - 1];
    if (!tail || added[0].seq > tail.seq) {
      for (const ev of added) this.events.push(ev);
    } else {
      // 补发与实时流交错时会走到这里：整体重排一次，保证页面顺序 = 事实顺序
      this.events.push(...added);
      this.events.sort((a, b) => a.seq - b.seq);
    }

    if (this.events.length > MAX) {
      const drop = this.events.length - MAX;
      const removed = this.events.splice(0, drop);
      // 同步清 seen，否则 Set 会随直播时长一直涨
      for (const ev of removed) this._seen.delete(ev.seq);
    }

    this.lastSeq = this.events[this.events.length - 1]?.seq ?? 0;
    return added;
  },

  reset() {
    this.events = [];
    this.lastSeq = 0;
    this._seen.clear();
  },
};
