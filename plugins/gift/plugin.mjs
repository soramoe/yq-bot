/**
 * 礼物答谢插件。
 *
 * ## 这个插件真正难的地方不是"说谢谢"
 *
 * 难在**连击**。B站 在客户端把连击攒着发，同一个人送 10 个礼物，
 * 服务端可能只推过来 3 条报文。于是有三件事必须处理对：
 *
 *   1. **合并**：不合并的话，一场连击会把弹幕区刷满。
 *   2. **数量**：`num` 只是"这一条"的数量。B站 同时给了 `comboCount`
 *      （到此为止一共几个）。**用差值补**，而不是简单相加 ——
 *      简单相加会得到 1+1+1=3，而观众送的是 10 个。
 *   3. **顺序**：同一个人"先送 A 再送 B"，如果不先把 A 结算掉，
 *      两条答谢会按合并窗口的到期时间乱序发出，看起来像机器人错乱。
 *
 * ## 为什么不用"每次事件都发"
 *
 * 二代最早就是来一条谢一条，实测一场连击能刷出十几条重复弹幕，
 * 观众直接在弹幕里骂。合并不是"优化"，是可用性的底线。
 *
 * ## 顺延要有上限
 *
 * 观众一直送就一直等，会把「×2 ×3 … ×50」攒到几十个才憋出一句 ——
 * 答谢迟到比不答谢更奇怪。所以超过 maxWaitSec 必须发。
 *
 * ## 状态放在内存里，重启就没了
 *
 * 这是**故意的**：pending 里的东西丢了最多漏一句答谢，
 * 而把它写进事件日志会在重启后重放，变成重复答谢 —— 后者更糟。
 */

/** 扫描待发队列的间隔。200ms 足够精确，也不会让 CPU 有感觉 */
const TICK_MS = 200;

/** 待发队列上限。正常直播远远到不了，纯粹防内存泄漏 */
const MAX_PENDING = 500;

/** 请求发言的优先级：>0 表示"间隔不够时我愿意等一个槽位"（闸门负责判定） */
const SAY_PRIORITY = 1;
/** 最多等 3 秒。等不到就放弃，绝不把闸门变成无限队列 */
const SAY_MAX_WAIT_MS = 3000;

export default {
  id: 'gift',

  /**
   * 待发队列、定时器、分发上下文全部放 `ctx.scratch`。
   *
   * 以前它们是这个对象上的 `_pending / _timer / _ctx`。ESM 按 URL 缓存，
   * 一个进程里这个对象只有一份 —— 两个房间各起一个宿主时，
   * A 房间 onStart 里的 `_pending.clear()` 会把 B 房间攒的连击一起清掉；
   * 更糟的是 setInterval 回调里的 `this._ctx` 指向最后收包的那个房间，
   * 于是 A 的礼物答谢会发到 B 去。见决策记录 D60。
   */
  onStart(ctx) {
    const s = ctx.scratch;
    stopTimer(s);
    s.pending = new Map();
    s.ctx = ctx;
    s.timer = setInterval(() => tick(s), TICK_MS);
    // 不能因为这个定时器把进程钉住：Node 里 interval 默认会保持事件循环存活，
    // 直播进程需要能被正常关掉。
    s.timer.unref?.();
    ctx.log.info('礼物答谢插件已启动');
  },

  onStop(ctx) {
    const s = ctx.scratch;
    const dropped = s.pending?.size ?? 0;
    stopTimer(s);
    s.pending?.clear();
    s.pending = null;
    s.ctx = null;
    ctx.log.info(
      '礼物答谢插件已停止' + (dropped ? `（${dropped} 条待发答谢被丢弃）` : ''),
    );
  },

  onEvent(ctx, ev) {
    if (ev.type !== 'GIFT') return false;

    const cfg = ctx.config;
    const p = ev.payload ?? {};

    // 没有名字也没有 uid：没法称呼，也没法去重。留给别的插件
    const who = identityOf(p);
    if (!who) return false;

    // ctx 每个事件都是新对象，存一份给定时器用。
    // 它属于这个宿主（scratch），所以不会指到别的房间去
    const s = ctx.scratch;
    s.ctx = ctx;
    const pending = pendingOf(ctx);

    /**
     * 合并窗口按**事件时间**走，不是只靠定时器。
     *
     * 定时器在回放里几乎不响：四个小时的日志能被压进几十毫秒跑完，
     * 于是"每 8 秒结算一次"这件事一次都没发生过，沙盒里默认配置下
     * **一条答谢都不出现**，而用户改的恰恰是答谢文案。
     * 线上事件时间≈现实时间，两种口径的结果完全一样。
     */
    const now = timeOf(ev);
    sweep(s, now);

    if (!cfg.enabled) return false;

    // 免费礼物不谢。注意是"不认领"而不是"认领了但不说话"，
    // 这样别的插件（比如盲盒）还有机会
    if (cfg.skipFree && p.isPaid === false) return false;

    const num = Math.max(1, Number(p.num) || 1);
    const total = round1(Number(p.battery) || 0);
    const floor = Math.max(0, Number(cfg.minBattery) || 0);
    if (total < floor) return false;

    const item = {
      room: roomOf(ctx),
      who: who.who,
      uid: who.uid,
      uname: who.uname,
      giftId: Number(p.giftId) || 0,
      giftName: String(p.giftName ?? '').trim() || '礼物',
      num,
      total,
      /** 上一次看到的连击累计值，差值法全靠它 */
      lastCombo: Number(p.comboCount) || 0,
      /** 顺延基准 = 第一次的到期时间 */
      first: 0,
      deadline: 0,
    };

    // 不合并 / 窗口为 0：来一条谢一条
    if (!cfg.mergeOn || Number(cfg.mergeSec) <= 0) {
      flush(s, item);
      return true;
    }

    // 合并键必须带房间：两个房间里的同一个 uid 是两个人，
    // 只按「人 + 礼物」合并会把 A 房间的心意答谢到 B 房间去
    const key = `${item.room}|${item.who}|${item.giftId || item.giftName}`;

    // 同一个人送的**别的**礼物先把旧的结算掉，否则两条答谢会乱序
    for (const [k, v] of pending) {
      if (v.room === item.room && v.who === item.who && k !== key) {
        pending.delete(k);
        flush(s, v);
      }
    }

    const prev = pending.get(key);
    if (!prev) {
      if (pending.size >= MAX_PENDING) dropOldest(pending);
      item.first = now + Number(cfg.mergeSec) * 1000;
      item.deadline = item.first;
      pending.set(key, item);
      return true;
    }

    this._merge(prev, item, cfg, now);
    return true;
  },

  /**
   * 把新到的礼物并进已有条目。
   *
   * **差值法**：`comboCount` 是"到此为止一共几个"，不是"这条加了几个"。
   * 它变大就说明中间有报文没推过来，差额才是真正漏掉的数量。
   * 只有在拿不到 comboCount（或它没变大）时才退回累加 num。
   *
   * @param {number} [now] 事件时间。缺省用现实时钟（直接调它的测试走这条）
   */
  _merge(prev, item, cfg, now = Date.now()) {
    const c = item.lastCombo;

    if (c > 0 && prev.lastCombo > 0 && c > prev.lastCombo) {
      const add = c - prev.lastCombo;
      // 单价 = 总价 / 数量。金额也按同一比例补，否则「×5 · 3 电池」两个数对不上
      const unit = prev.num > 0 ? prev.total / prev.num : 0;
      prev.num += add;
      prev.total = round1(prev.total + unit * add);
      prev.lastCombo = c;
    } else {
      prev.num += item.num;
      prev.total = round1(prev.total + item.total);
      prev.lastCombo = Math.max(prev.lastCombo || 0, c);
    }

    // 顺延，但有上限：从第一次的到期时间算起，最多等 maxWaitSec
    const maxWait = Math.max(0, Number(cfg.maxWaitSec) || 0) * 1000;
    const next = now + Number(cfg.mergeSec) * 1000;
    prev.deadline = maxWait > 0 ? Math.min(prev.first + maxWait, next) : next;
  },

  /**
   * 回放收尾（**只有沙盒会调**）。
   *
   * 最后一条答谢没人来触发结算 —— 线上等定时器，回放里没有"之后"了。
   * 不结清的话，沙盒只会显示前面几条，看上去像"结尾那句丢了"。
   */
  onReplayEnd(ctx) {
    sweep(ctx.scratch, Infinity);
  },
};

/**
 * 惰性初始化待发队列。
 *
 * 宿主正常流程一定先 onStart，但测试会直接 dispatch、沙盒也会重放历史事件；
 * 那种情况下 scratch 里还没有 pending，不能让它崩在第一行。
 */
function pendingOf(ctx) {
  if (!ctx.scratch.pending) ctx.scratch.pending = new Map();
  return ctx.scratch.pending;
}

/** 定时器：把到期的条目发出去。s 是这个宿主私有的 scratch */
function tick(s) {
  sweep(s, Date.now());
}

/**
 * 结算所有到期的条目。
 *
 * `now` 由调用方给：定时器给现实时钟，事件处理给**事件时间**，
 * 回放收尾给 `Infinity`（剩下的全结清）。口径只在参数里，函数里不读时钟。
 *
 * @param {object} s 宿主私有 scratch
 * @param {number} now
 */
function sweep(s, now) {
  const pending = s?.pending;
  if (!pending || pending.size === 0) return;
  for (const [k, v] of pending) {
    if (v.deadline > now) continue;
    pending.delete(k);
    try {
      flush(s, v);
    } catch (err) {
      // 定时器/事件回调里抛出的异常没有调用方接得住。
      // 答谢发不出去是小事，把处理链打断是大事。
      s.ctx?.log.warn(`答谢发送异常：${err.message}`);
    }
  }
}

/** 事件时间；缺失或为 0 时退回现实时钟（老日志、手工 dispatch 的测试） */
function timeOf(ev) {
  const ts = Number(ev?.ts);
  return Number.isFinite(ts) && ts > 0 ? ts : Date.now();
}

/** 真正请求发送。插件不碰发送本身，只说"我要说这句" */
function flush(s, item) {
  const ctx = s.ctx;
  if (!ctx) return;

  const cfg = ctx.config;
  const multi = item.num > 1;
  const tpl = multi ? cfg.templateMulti : cfg.template;

  const text = ctx.render(tpl, {
    用户: item.uname,
    礼物: item.giftName,
    数量: item.num,
    电池: item.total,
  });
  if (!text) return;

  // 定时器里调用，没有 async 上下文 —— 必须自己兜住异常，
  // 否则一次发送失败会变成未处理的 Promise 拒绝
  Promise.resolve(
    ctx.say(text, {
      reason: 'gift',
      reply: { uid: item.uid, uname: item.uname },
      // 花了钱的消息可以等一个槽位：热闹房间里进场欢迎会把最小间隔占满，
      // 不等的话答谢几乎永远发不出去（而且是静默发不出去）
      priority: SAY_PRIORITY,
      maxWaitMs: SAY_MAX_WAIT_MS,
    }),
  )
    .then((r) => {
      if (r && !r.ok) ctx.log.warn(`答谢没发出去（${r.skipped ?? 'unknown'}）：${text}`);
    })
    .catch((err) => ctx.log.warn(`答谢发送失败：${err.message}`));
}

function dropOldest(pending) {
  const first = pending.keys().next();
  if (!first.done) pending.delete(first.value);
}

function stopTimer(s) {
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

/**
 * 合并身份。
 *
 * 正常就是 uid。缺 uid 时退回昵称；两样都没有返回 null（不处理）。
 *
 * 二代踩过的坑：合并键直接用 uid，uid 为空时键是 `|礼物id`，
 * 于是三个**不同**的匿名观众被并进一条，发出「感谢 甲 的鲜花×3」，
 * 乙丙的名字直接消失。宁可少一条答谢，也不能把别人的心意记到别人头上。
 */
function identityOf(p) {
  const uid = String(p.uid ?? '').trim();
  const uname = String(p.uname ?? '').trim();
  if (uid) return { who: uid, uid, uname };
  if (uname) return { who: `n:${uname}`, uid: '', uname };
  return null;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/**
 * 房间号。
 *
 * 现在只跑一个房间，但合并键里必须带它：宿主是按进程共享的，
 * 一旦开第二个房间，只按「人 + 礼物」合并就会把两个房间的数据混在一起 ——
 * 而且混起来之后**没有任何报错**，只是偶尔答谢错人。
 */
function roomOf(ctx) {
  const id = ctx?.state?.roomId;
  return id === undefined || id === null ? '' : String(id);
}
