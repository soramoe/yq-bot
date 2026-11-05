/**
 * 观众簿 —— 只回答一件事：**这个人以前来过吗？**
 *
 * ## 为什么需要它
 *
 * 欢迎插件原来只有一张 90 秒内存冷却表。而观众进出间隔通常比 90 秒长，
 * 于是一个常驻老观众一晚上会被欢迎十几次；进程一重启，连那 90 秒也没了。
 *
 * 真实数据（`data/events/21452505`，8 小时）：4206 次进场，只有 3806 个不同的人。
 * 重复的那 400 次全都会被再欢迎一遍，而且播得越久越严重 ——
 * 老观众的占比只会越来越高，这是慢性病，不治会越来越疼。
 *
 * ## 为什么是「按天分片 + 只追加」
 *
 * 另一种显而易见的做法是一个 `roster.json`，内存一份 Map，定时全量重写。
 * 算过账：十万人约 4MB，每 5 分钟写一次 → 一天 1GB 写入量，
 * 而这个数据一天只**增加几百条**。用大炮打蚊子，还顺手把 SSD 写坏。
 *
 * 和事件日志同构就够：一天一个 `YYYY-MM-DD.jsonl`，只 append。
 * 每人每天最多一行（同一天再来不写），一天几百到几千行、几十 KB。
 * 超期直接整片删 —— 不需要"逐条过期"的复杂逻辑，
 * 因为分片的粒度本来就是天，而"多久没来算陌生人"本来就是按天算的。
 *
 * ## 只存三样
 *
 * uid、最后一次来的时间、当时的名字。名字不参与任何判断，
 * 只是为了以后能回答"这个 uid 到底是谁"。
 *
 * ## 它不做的事
 *
 * 不判断该不该欢迎、不渲染文案、不落盘"说了什么"。
 * 那是插件的职责。这里只提供事实，判断留给 `plugins/welcome`。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dayKey } from './event-log.mjs';

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };

const DAY_MS = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');

/** 和 EventLog 同一套校验：roomId 会拼进路径，不能让它带 `..` */
function assertRoomId(roomId) {
  const s = String(roomId ?? '');
  if (!/^\d{1,20}$/.test(s)) throw new Error(`非法 roomId：${JSON.stringify(roomId)}`);
  return s;
}

export class Roster {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir      数据根目录（`data/`）
   * @param {string|number} opts.roomId
   * @param {number} [opts.keepDays]   保留多少天。更早的分片在 prune 时整片删除
   * @param {number} [opts.maxPeople]  内存条目硬上限，防止异常数据把内存吃光
   * @param {boolean} [opts.persist]   false = 只在内存里记（沙盒回放用，绝不落盘）
   * @param {object} [opts.log]
   */
  constructor({ dataDir, roomId, keepDays = 90, maxPeople = 1_000_000, persist = true, log = SILENT_LOG }) {
    /**
     * 沙盒回放必须用 persist: false。
     * 回放的是历史事件，把它记进真实观众簿等于"伪造历史"——
     * 回放一遍，那天的人就都变成"来过"了，而他们可能从没来过。
     */
    this.persist = persist;
    this.roomId = persist ? assertRoomId(roomId) : String(roomId ?? '');
    this.dataDir = dataDir;
    this.dir = persist ? join(dataDir, 'roster', this.roomId) : '';
    this.keepDays = Number.isFinite(keepDays) && keepDays >= 1 ? Math.floor(keepDays) : 90;
    this.maxPeople = maxPeople;
    this.log = log;

    /**
     * uid → { ts, name, writtenDay, previousSeenAt }
     *
     * 这是唯一的读路径。磁盘上的分片只在启动时读一次，
     * 之后所有判断都走这张表 —— 否则每条进场都要翻一遍磁盘。
     *
     * `previousSeenAt` 是「这一次之前的那一次」。为什么必须存下来：
     * 观众一进房间，`mark()` 就把 `ts` 刷成"现在"，此后再问
     * 「他上次什么时候来的」，答案永远是"今天" —— 弹幕指令
     * `#我来过` 对任何在场的人都会说"今天"、毫无信息量。
     * 而"上一次"这个值只有在 `mark()` 那一刻才知道，过时就没了，
     * 所以在那时顺手记下来；`load()` 也从相邻分片里取同一个口径，
     * 否则重启一次所有人的"上次"都会变回"从没来过"。
     */
    this._seen = new Map();

    this._loaded = false;
    this._appended = 0;
    this._badLines = 0;
    /** 因为超上限而没记下来的新人数量。非 0 说明 maxPeople 该调了 */
    this._skipped = 0;
    this._pruned = { files: 0, people: 0 };
  }

  get size() {
    return this._seen.size;
  }

  /**
   * 读全部保留期内的分片，建内存索引。
   *
   * 用异步读：五十万人、九十片的情况下同步读会卡住事件循环几百毫秒，
   * 而这段时间正是刚启动、B站 长连在握手的时候，容易触发重连。
   */
  async load() {
    if (!this.persist) {
      // 内存版没有"历史"，但回放过程中 mark 会把它填起来 ——
      // 这正好对应线上的行为：第一次见到就当陌生人，之后就认识了
      this._loaded = true;
      return this;
    }

    mkdirSync(this.dir, { recursive: true });

    const shards = this._shards();
    const t0 = Date.now();

    for (const shard of shards) {
      let text;
      try {
        text = await readFile(shard.path, 'utf8');
      } catch (err) {
        // 单个分片读不了不该让服务起不来：少认识几个人，比整个功能不可用强
        this.log.warn(`观众簿分片读取失败 ${shard.day}：${err.message}`);
        continue;
      }

      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;

        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          this._badLines++;
          continue;
        }

        const uid = String(rec.u ?? '');
        const ts = Number(rec.t);
        if (!uid || !Number.isFinite(ts)) {
          this._badLines++;
          continue;
        }

        // 同一人可能出现在多个分片里（跨天来过）。取最新的那条，
        // 并把**上一条**的时间留下来 —— 这就是"上一次来"的唯一来源。
        // writtenDay 记的是"这一行确实在盘上"的那天，见 mark() 的说明
        const prev = this._seen.get(uid);
        if (prev && prev.ts >= ts) continue;
        this._seen.set(uid, {
          ts,
          name: String(rec.n ?? ''),
          writtenDay: shard.day,
          previousSeenAt: prev?.ts ?? 0,
        });
      }
    }

    this._loaded = true;

    if (this._seen.size > this.maxPeople) {
      // 只报不删：删掉哪一半都是错的，而真到这一步说明数据本身有问题，
      // 需要人看一眼。这里保证的是"不会继续涨"，mark 会停止记录新人。
      this.log.warn(
        `观众簿已有 ${this._seen.size} 人，超过上限 ${this.maxPeople}，将不再记录新观众`,
      );
    }

    if (this._seen.size > 0) {
      this.log.info(
        `观众簿载入 ${this._seen.size} 人（${shards.length} 个分片，${Date.now() - t0}ms）`,
      );
    }

    return this;
  }

  /**
   * 记一次来访，并返回「来之前」的状态。
   *
   * 返回的是 `previousSeenAt`，不是更新后的时间 —— 调用方要判断的是
   * "这个人刚才进来之前算不算熟客"。这中间差一次赋值，但语义差很远。
   *
   * @param {string|number} uid
   * @param {string} [name]
   * @param {number} [ts]
   * @returns {{previousSeenAt:number, isFirstEver:boolean, daysSince:number, recorded:boolean}}
   */
  mark(uid, name = '', ts = Date.now()) {
    const id = String(uid ?? '').trim();

    // uid 为 0 或空的是匿名观众：既不认识也不该被当成"新人"特殊对待
    if (!id || id === '0') {
      return { previousSeenAt: 0, isFirstEver: false, daysSince: Infinity, recorded: false };
    }

    const prev = this._seen.get(id);
    const previousSeenAt = prev?.ts ?? 0;
    const isFirstEver = previousSeenAt === 0;
    const today = dayKey(ts);

    /**
     * 同一天只写一行。观众反复进出是常态，按次写会让分片涨十倍，
     * 而对判断"来过没有"毫无增益 —— 我们要的是"哪天来过"。
     *
     * 但判断依据必须是「上次**确实写进盘里**的日子」，不是 `previousSeenAt` 的日子。
     * 写盘失败（磁盘满、权限）时内存里仍记着这个人，若按内存日子判同天，
     * 今天剩下的所有来访都不会再重试写盘 —— 重启后他又变成陌生人，
     * 而且全程只有一行 error 日志，没人会想到是"一次失败堵了一整天"。
     */
    const writtenDay = prev?.writtenDay ?? '';
    const sameDay = writtenDay === today;

    // 到上限了：新人既不写盘也不进内存。
    // 「不进内存」是关键 —— 早先只跳过写盘却照样 set，Map 会一直涨，
    // 于是 maxPeople 这个保险丝形同虚设。超限时宁可一直把他当新观众。
    if (isFirstEver && this._seen.size >= this.maxPeople) {
      this._skipped++;
      return {
        previousSeenAt,
        isFirstEver,
        daysSince: Infinity,
        recorded: false,
      };
    }

    let recorded = false;
    if (!sameDay) recorded = this._append(id, name, ts);

    // 内存里**总是**更新：哪怕没写盘，"上次来"也必须按最新算，
    // 否则同一人今天第二次进来会被算成"几小时前来的"
    this._seen.set(id, {
      ts,
      name: name || prev?.name || '',
      writtenDay: recorded ? today : writtenDay,
      // 「这一次之前的那一次」：过时即失去，所以只能在这里记（见 _seen 的说明）
      previousSeenAt,
    });

    return {
      previousSeenAt,
      isFirstEver,
      daysSince: previousSeenAt > 0 ? (ts - previousSeenAt) / DAY_MS : Infinity,
      recorded,
    };
  }

  /**
   * 只查不记。给"不关心写入、只想看看"的场景用。
   *
   * 返回三样：`lastSeenAt`（最近一次）、`previousSeenAt`（这一次之前的那一次）、
   * `name`。对"现在正在说话的人"来说，`lastSeenAt` 就是此刻（他进场时刚记过），
   * 想知道"他上次来"必须看 `previousSeenAt`。
   */
  peek(uid) {
    const rec = this._seen.get(String(uid ?? '').trim());
    if (!rec) return null;
    return {
      lastSeenAt: rec.ts,
      previousSeenAt: Number(rec.previousSeenAt) || 0,
      name: rec.name,
    };
  }

  /**
   * 列出「最近来过」的观众，供自动点名挑人 —— **纯只读，不写盘**。
   *
   * 观众簿的主索引是 uid（判断"来过没"只需要它），这里是为数不多的
   * 反向遍历：一次点名才扫一遍，人数受 keepDays / maxPeople 约束，
   * 不值得为此常驻第二份按时间排序的索引、还要处理改名与剪枝同步。
   *
   * 两个时间窗必须同时给：
   *   · minAgeMs —— 刚进场那几秒排除掉。欢迎插件刚 @ 过他，
   *     再来一条自动招呼就是连着两条弹幕点同一个人，观感上像卡了。
   *   · withinMs —— 太久没出现的排除掉。人早走了，@ 出去没人应。
   *
   * 只返回**能结构化 @ 的人**：uid 是纯数字、昵称非空。
   * 观众簿里可能因脏数据留下别的 uid，放出去会 @ 不到人，
   * 而这种失败在前端只表现为"没反应"，所以要在这里就挡住。
   *
   * @param {object} [opts]
   * @param {number} [opts.withinMs] 只保留最近这段时间来过的，0 = 不限
   * @param {number} [opts.minAgeMs] 排除刚进来不到这段时间的
   * @param {number} [opts.limit]    最多返回多少条（硬上限 500）
   * @param {number} [opts.now]      注入时钟，自检不用等真实时间
   * @returns {Array<{uid:string,name:string,lastSeenAt:number}>} 按最近来访倒序
   */
  recent({ withinMs = 0, minAgeMs = 0, limit = 200, now = Date.now() } = {}) {
    const cap = Math.max(0, Math.min(500, Math.floor(Number(limit) || 0)));
    if (cap === 0) return [];

    const out = [];
    for (const [uid, rec] of this._seen) {
      if (!/^\d{1,20}$/.test(uid)) continue;
      const name = String(rec?.name ?? '').trim();
      if (!name) continue;

      const age = now - rec.ts;
      // 时钟回拨时 age 为负，也会被 minAge 挡掉，不会挑出"未来的人"
      if (age < minAgeMs) continue;
      if (withinMs > 0 && age > withinMs) continue;
      out.push({ uid, name, lastSeenAt: rec.ts });
    }

    // 倒序；同一毫秒用 uid 兜一个稳定序，否则 Map 插入序会让断言飘
    out.sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.uid.localeCompare(b.uid));
    return out.slice(0, cap);
  }

  /**
   * 剪掉超过 keepDays 的分片，以及内存里对应的条目。
   *
   * 两件事必须一起做。只删文件不删内存，会出现"磁盘上已经没有这个人，
   * 内存里他还是熟客"的状态 —— 下次重启后行为突然改变，最难查。
   */
  prune(now = Date.now()) {
    // 内存版不剪：回放的是一段历史，按"现在"去剪会把回放中段的人当成过期
    if (!this.persist) return { files: 0, people: 0 };

    const cutoffTs = now - this.keepDays * DAY_MS;
    const cutoffDay = dayKey(cutoffTs);

    let files = 0;
    for (const shard of this._shards()) {
      // 字符串比较即可：固定 `YYYY-MM-DD` 格式的字典序等于时间序
      if (shard.day >= cutoffDay) continue;
      try {
        rmSync(shard.path, { force: true });
        files++;
      } catch (err) {
        this.log.warn(`观众簿分片删除失败 ${shard.day}：${err.message}`);
      }
    }

    /**
     * 内存必须用**和分片同一把尺子**剪：按天，不按精确时间戳。
     *
     * 用 `rec.ts < cutoffTs` 看起来更精确，其实会制造最难受的不一致：
     * `cutoffDay` 这个分片按天比较被保留了，但分片里 00:00~cutoff 时刻
     * 那几个人的内存条目被删掉 —— 磁盘上还写着他们，内存里却不认识。
     * 于是重启前后同一个人的待遇突然改变，且没有任何报错。
     */
    let people = 0;
    for (const [uid, rec] of this._seen) {
      if (dayKey(rec.ts) < cutoffDay) {
        this._seen.delete(uid);
        people++;
      }
    }

    this._pruned = { files, people };
    if (files > 0 || people > 0) {
      this.log.info(`观众簿剪枝：删除 ${files} 个分片、${people} 人（保留 ${this.keepDays} 天）`);
    }
    return this._pruned;
  }

  /**
   * 轻量摘要：给 1Hz 状态推送用。
   *
   * `stats()` 会逐片 stat 求字节数、再遍历整张表求最早/最晚来访，
   * 那是「体检」用的，一次几毫秒但会随人数线性涨。状态推送每秒一次，
   * 十万人就是每秒十万次迭代，白白吃掉一个核心。
   * 这里只取 O(1) 的人数 + 一次目录列举，不含任何个人名单。
   */
  brief() {
    return {
      people: this._seen.size,
      days: this._shards().length,
      keepDays: this.keepDays,
    };
  }

  /** 磁盘与内存体检，供状态聚合使用 */
  stats() {
    const shards = this._shards();
    let bytes = 0;
    for (const s of shards) {
      try {
        bytes += statSync(s.path).size;
      } catch {
        // 统计大小失败不影响其他字段
      }
    }

    let oldestAt = 0;
    let newestAt = 0;
    for (const rec of this._seen.values()) {
      if (!oldestAt || rec.ts < oldestAt) oldestAt = rec.ts;
      if (rec.ts > newestAt) newestAt = rec.ts;
    }

    return {
      roomId: this.roomId,
      people: this._seen.size,
      days: shards.length,
      bytes,
      keepDays: this.keepDays,
      appended: this._appended,
      badLines: this._badLines,
      skipped: this._skipped,
      loaded: this._loaded,
      oldestAt,
      newestAt,
      pruned: { ...this._pruned },
    };
  }

  /** 全部分片，按日期升序 */
  _shards() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => ({ path: join(this.dir, f), day: f.replace(/\.jsonl$/, '') }));
  }

  /** 追加一行。失败只记日志，不抛 —— 观众簿写不进去不该影响直播 */
  _append(uid, name, ts) {
    if (!this.persist) {
      this._appended++;
      return true;
    }
    const file = join(this.dir, `${dayKey(ts)}.jsonl`);
    const line = `${JSON.stringify({ u: uid, n: name || '', t: ts })}\n`;
    try {
      appendFileSync(file, line, 'utf8');
      this._appended++;
      return true;
    } catch (err) {
      this.log.error(`观众簿写入失败：${err.message}`);
      return false;
    }
  }
}

export default Roster;
