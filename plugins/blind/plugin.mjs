/**
 * 盲盒播报插件。
 *
 * ## 这个插件存在的最大意义：证明 claims 仲裁是对的
 *
 * 二代最脏的一处设计就在这里。礼物答谢插件想知道"盲盒插件会不会也播报这个礼物"，
 * 于是**直接去读盲盒插件的配置**，自己复算一遍 minProfit 和冷却时间。
 * 结果：谁先改配置都会让判断失效，盲盒插件改了过滤逻辑答谢这边毫不知情。
 * 更糟的是它只静态复算了 minProfit，冷却没算 —— 于是「minProfit=10 且这盒只赚 3」
 * 时，盲盒不吭声、答谢让了路，**观众花了钱一条反馈都看不到**。
 *
 * 三代不猜。规则只有一条：
 *
 *   > 只有**真的要播**的时候才 `return true`（认领）。
 *   > 不播就 `return false`，让低优先级的礼物答谢接手。
 *
 * 于是"是否播报"和"是否让路"永远是同一个判断，不可能再错位。
 * 优先级只写在 manifest 的 claims 里（盲盒 200 > 答谢 100），插件之间零引用。
 *
 * ## 哪些盲盒字段是可信的
 *
 * 只用报文**明确给的**：盒子 id、盒子名、盒子单价，以及奖品的总价。
 * 绝不靠"奖品 id 反推盒子"——有些奖品本身也能单独赠送，反推会把普通礼物
 * 误判成盲盒（二代做过这个诊断工具，最后没敢进统计）。
 * 判定逻辑在 `server/bili/normalize.mjs` 的 `findBlindBox`，那里有字段号依据。
 */

/** 冷却表上限，防止超长直播里无限增长 */
const MAX_COOLDOWN_KEYS = 2000;

/** 请求发言的优先级：>0 表示"间隔不够时我愿意等一个槽位"（闸门负责判定） */
const SAY_PRIORITY = 1;
/** 最多等 3 秒。等不到就放弃，绝不把闸门变成无限队列 */
const SAY_MAX_WAIT_MS = 3000;

export default {
  id: 'blind',

  /**
   * 冷却表放 `ctx.scratch`（每宿主每插件一份）。
   *
   * 挂在模块导出对象上时，ESM 按 URL 缓存让两个房间共用同一张表 ——
   * A 房间 onStart 里的 `clear()` 会把 B 房间的冷却一起清掉，
   * 于是隔壁刚播过的人在这边又能播一次。见决策记录 D60。
   */
  onStart(ctx) {
    ctx.scratch.last = new Map();
    ctx.log.info('盲盒播报插件已启动');
  },

  onStop(ctx) {
    ctx.scratch.last?.clear();
    ctx.scratch.last = null;
    ctx.log.info('盲盒播报插件已停止');
  },

  onEvent(ctx, ev) {
    if (ev.type !== 'GIFT') return false;

    const cfg = ctx.config;
    if (!cfg.enabled) return false;

    const p = ev.payload ?? {};
    const blind = p.blind;

    // 不是盲盒 —— 让路
    if (!blind) return false;

    const uid = String(p.uid ?? '').trim();
    const profit = Number(blind.profit) || 0;

    // 盈亏不够看 —— 让路（礼物答谢会照常道谢，只是不吹盈亏）
    if (profit < (Number(cfg.minProfit) || 0)) return false;

    // 冷却 —— 同样让路，不是"吞掉"
    const now = timeOf(ev);
    if (uid && this._onCooldown(ctx, uid, cfg.cooldownSec, now)) return false;

    const uname = String(p.uname ?? '').trim() || '观众';
    const text = ctx.render(cfg.template, buildVars(p, blind, uname));
    if (!text) return false;

    // 先记冷却再请求发送：即使闸门因为限速拦下了，这个人也不该在下一秒重播一次
    if (uid) this._mark(ctx, uid, now);

    ctx.say(text, {
      reason: 'blind',
      reply: { uid, uname },
      priority: SAY_PRIORITY,
      maxWaitMs: SAY_MAX_WAIT_MS,
    });
    return true;
  },

  _key(ctx, uid) {
    const roomId = ctx.state?.roomId ?? '';
    return `${roomId}:${uid}`;
  },

  _onCooldown(ctx, uid, cooldownSec, now = Date.now()) {
    const sec = Number(cooldownSec) || 0;
    if (sec <= 0) return false;
    const prev = lastOf(ctx).get(this._key(ctx, uid));
    if (prev === undefined) return false;
    return now - prev < sec * 1000;
  },

  _mark(ctx, uid, now = Date.now()) {
    const last = lastOf(ctx);
    last.set(this._key(ctx, uid), now);
    if (last.size > MAX_COOLDOWN_KEYS) {
      let i = 0;
      const drop = Math.floor(MAX_COOLDOWN_KEYS / 2);
      for (const k of last.keys()) {
        last.delete(k);
        if (++i >= drop) break;
      }
    }
  },
};

/** 惰性初始化：测试直接 dispatch、沙盒回放没走 onStart 时也不会崩 */
function lastOf(ctx) {
  if (!ctx.scratch.last) ctx.scratch.last = new Map();
  return ctx.scratch.last;
}

/**
 * 事件时间；缺失或为 0 时退回现实时钟。
 *
 * 冷却必须按事件时间算：回放把四小时的日志压进几十毫秒，
 * 用 `Date.now()` 的话同一个人四小时里开两个盲盒只会播一次 ——
 * 而当时是播了两次的，回放只是**少说一句**，不报错。
 */
function timeOf(ev) {
  const ts = Number(ev?.ts);
  return Number.isFinite(ts) && ts > 0 ? ts : Date.now();
}

/**
 * 模板变量。
 *
 * `{盈亏}` 给的是**带方向的短语**（赚 5 电池 / 亏 3 电池 / 保本），
 * `{盈亏数}` 给的是带符号的纯数字（+5 / -3 / 0）。
 * 两者都提供，是因为"想直接读"和"想自己排版"是两种需求，
 * 只给其中一个都会逼用户自己拼字符串。
 */
function buildVars(p, blind, uname) {
  const profit = Number(blind.profit) || 0;
  const word =
    profit > 0 ? `赚 ${fmt(profit)} 电池` : profit < 0 ? `亏 ${fmt(-profit)} 电池` : '保本';

  return {
    用户: uname,
    盒子: String(blind.boxName ?? ''),
    礼物: String(p.giftName ?? ''),
    数量: Math.max(1, Number(p.num) || 1),
    成本: fmt(blind.cost),
    价值: fmt(blind.value),
    盈亏: word,
    盈亏数: profit > 0 ? `+${fmt(profit)}` : profit < 0 ? `-${fmt(-profit)}` : '0',
  };
}

/** 电池数显示：整数就不带小数点，9.0 → 9 */
function fmt(n) {
  const v = Math.round((Number(n) || 0) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
