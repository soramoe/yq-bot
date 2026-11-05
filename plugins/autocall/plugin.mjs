/**
 * 主动打招呼：服务自己定时挑一个观众，@ 他说句招呼。
 *
 * 与欢迎插件的区别，也是这个插件存在的全部理由：
 *   欢迎是「有人进来 → 说」，没有事件就永远不说话；
 *   这里是「时间到了 → 从最近来过的人里挑一个说」，不需要任何人点、
 *   也不需要等下一条事件。冷场时也能自己把话头抛出去。
 *
 * 为什么挑人不从事件流里攒，而是读 `ctx.roster`：
 *   · 若声明 claims 去"旁观" ENTER，就必须排在 welcome 前面才看得到事件
 *     （claims 按优先级分发，第一个返回 true 的会截断），且必须永远返回
 *     false。这个顺序约束很脆：以后有人调一下 welcome 的优先级就静默失效。
 *   · 观众簿由内核在事件入库时统一记账，插件禁用、换房间、跑沙盒都不影响
 *     它；插件只读，不参与写入。
 *   · 顺带能用「最近多久来过」把已经走了的人滤掉。
 *
 * 三条必须提前钉死的规矩：
 *
 * 1. **文案里不写 @昵称。** B站 收到 reply_mid 会自己挂一个可点的粉色
 *    @ 标签；文案里再写一遍就成了「@小明 你好呀 小明」。
 * 2. **被闸门拦下不算点过名。** 限速/去重时若把人标记成"已点"，这一轮就
 *    白白消耗掉一个候选，而且不报任何错 —— 表现是「偶尔一整轮谁也没被
 *    @ 到」。只有真发出去才记。
 * 3. **状态全放 ctx.scratch。** 计时器、文案游标、每人冷却表放模块对象上，
 *    两个房间会互相清定时器、共用冷却，症状是"时有时无"且不报错。
 */

import { MAX_TEXT, prepareText } from '../../server/bili/send.mjs';

/** 间隔硬下限。低于它就是在刷屏，而刷屏是 B站 风控最明确的特征 */
const MIN_INTERVAL_SEC = 60;

/**
 * 短周期唤醒 + 累加已过时间，而不是一次性睡满间隔。
 * 这样把 600 秒改成 60 秒后最多 5 秒就生效，不用重启、不用等十分钟。
 */
const WAKE_MS = 5000;

/** 一次最多看多少个候选。观众簿可能有几十万人，没必要全排一遍 */
const MAX_CANDIDATES = 200;

/** 与 schedule 同一判据。故意不 import：插件之间不该互相绑死加载 */
export function isLiveState(state) {
  return state === 'live' || state === 'live_unknown';
}

/** 数字配置统一夹逼：NaN、越界、字符串都在这里收口 */
function num(v, fallback, min, max) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;
}

/** 这一轮该不该开口。拆成纯函数才能直接断言，不用等真实时间 */
export function shouldCall(cfg, state) {
  if (!cfg?.enabled) return { ok: false, reason: 'disabled' };
  if (!Array.isArray(cfg.templates) || cfg.templates.length === 0) {
    return { ok: false, reason: 'no-templates' };
  }
  if (cfg.onlyWhenLive !== false && !isLiveState(state?.state)) {
    return { ok: false, reason: 'not-live' };
  }
  return { ok: true };
}

/**
 * 把「只挑最近来过的」和「刚进场先不 @」换算成两个时间窗。
 *
 * 两者互不相交时候选恒为空 —— 功能表现为"开了也没反应"，且没有任何报错。
 * 与其让配置静默失效，不如夹到窗口一半并记一条 warn。
 */
export function resolveWindow(cfg = {}) {
  const withinMs = num(cfg.withinSec, 600, 30, 86400) * 1000;
  let minAgeMs = num(cfg.minAgeSec, 20, 0, 600) * 1000;
  let clamped = false;
  if (minAgeMs >= withinMs) {
    minAgeMs = Math.floor(withinMs / 2);
    clamped = true;
  }
  return { withinMs, minAgeMs, clamped };
}

/** 挑这一轮说哪句。顺序模式的游标必须跨轮保存，否则每轮都是第一句 */
export function nextGreeting(list, cursor = 0, shuffle = false, rand = Math.random) {
  const items = (Array.isArray(list) ? list : [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);
  if (items.length === 0) return { text: '', cursor: 0 };

  if (shuffle) {
    const i = Math.min(items.length - 1, Math.max(0, Math.floor(rand() * items.length)));
    return { text: items[i], cursor };
  }
  const i = ((cursor % items.length) + items.length) % items.length;
  return { text: items[i], cursor: i + 1 };
}

/** 这个人还在冷却里吗。注入 now 才能断言，不用真的等半小时 */
export function isCooling(lastAt, cooldownMs, now) {
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return false;
  if (!lastAt) return false;
  return now - lastAt < cooldownMs;
}

/**
 * 从候选里挑这一位点谁。
 *
 * 默认 `oldest` = 最久没被点过的优先；都没点过时按**最近来过的**优先
 * （刚进来的人更可能还在房间里，@ 出去才有人接话）。
 * 热闹房间里这样才不会总 @ 到同一批人。
 *
 * @param {Array<{uid:string,name:string,lastSeenAt:number}>} candidates
 * @param {object} cfg
 * @param {Map<string,number>} called  uid → 上次真发出去的时间
 * @param {number} now
 * @param {() => number} [rand]
 */
export function pickCandidate(candidates, cfg = {}, called = new Map(), now = Date.now(), rand = Math.random) {
  const cdMs = num(cfg.perUserCooldownSec, 1800, 0, 86400) * 1000;
  const pool = (Array.isArray(candidates) ? candidates : []).filter(
    (c) => c && c.uid && c.name && !isCooling(called.get(c.uid), cdMs, now),
  );
  if (pool.length === 0) return null;

  const mode = cfg.pickMode || 'oldest';
  if (mode === 'random') {
    const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)));
    return pool[i];
  }
  if (mode === 'newest') {
    return pool.reduce((a, b) => (b.lastSeenAt > a.lastSeenAt ? b : a));
  }
  return pool.reduce((a, b) => {
    const ka = called.get(a.uid) ?? 0;
    const kb = called.get(b.uid) ?? 0;
    if (ka !== kb) return ka < kb ? a : b;
    return a.lastSeenAt >= b.lastSeenAt ? a : b;
  });
}

/** 默认配置，测试与「配置还没下发」时都用它 */
export const DEFAULTS = {
  enabled: false,
  intervalSec: 300,
  onlyWhenLive: true,
  withinSec: 600,
  minAgeSec: 20,
  perUserCooldownSec: 1800,
  pickMode: 'oldest',
  shuffle: false,
  templates: ['{用户}，在呀？一起聊会儿~'],
};

export default {
  id: 'autocall',

  onStart(ctx) {
    const st = ctx.scratch;
    st.timer = null;
    st.elapsed = 0;
    st.cursor = 0;
    st.called = new Map();
    st.inflight = false;
    st.sent = 0;
    st.warnedWindow = false;
    st.warnedLong = false;
    arm(ctx, st);
    ctx.log.info('主动打招呼已启动（默认关闭；开启后按间隔自动挑一位观众 @）');
  },

  onStop(ctx) {
    stop(ctx, ctx.scratch);
    ctx.scratch.called?.clear();
    ctx.log.info(`主动打招呼已停止（本场发出 ${ctx.scratch.sent ?? 0} 次）`);
  },

  /**
   * 不认领任何事件。
   *
   * claims 是空对象而不是不写：让"这个插件完全不吃事件"在 manifest 里
   * 一眼可见 —— 排查"为什么它不说话"时，第一步就是确认它该不该被事件唤醒。
   */
  onEvent() {
    return false;
  },
};

/* ─────────────── 计时器 ─────────────── */

function stop(ctx, st) {
  if (st?.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
}

function arm(ctx, st) {
  if (!st) return;
  stop(ctx, st);
  st.timer = setTimeout(() => {
    st.timer = null;
    try {
      tick(ctx, st);
    } catch (err) {
      // 定时器回调里抛出的异常没人接，会被 uncaughtException 接住，
      // 而入口对未捕获异常的处理是关掉整个进程。一句招呼发不出去不该有这种代价。
      ctx.log.error(`主动打招呼出错：${err.message}`);
    }
    arm(ctx, st);
  }, WAKE_MS);
  st.timer.unref?.();
}

function tick(ctx, st) {
  const cfg = ctx.config ?? DEFAULTS;
  // 没走 onStart（测试里直接驱动）时也要能用
  if (!st.called) st.called = new Map();

  // 无论开关、无论是否在播，时间都照样累加：
  // 「刚打开」「刚开播」「刚有人进来」这三种情况都能很快见效。
  st.elapsed += WAKE_MS;

  const verdict = shouldCall(cfg, ctx.state);
  if (!verdict.ok) return;
  // 上一轮的 say 还没回来（等闸门槽位）时不重复挑人
  if (st.inflight) return;

  const intervalSec = num(cfg.intervalSec, 300, MIN_INTERVAL_SEC, 7200);
  if (st.elapsed < intervalSec * 1000) return;

  const win = resolveWindow(cfg);
  if (win.clamped && !st.warnedWindow) {
    ctx.log.warn('候选时间窗不成立（「刚进场先不 @」≥「只挑最近来过的」），已自动夹到窗口一半');
    st.warnedWindow = true;
  }

  // 优先挑「刚说过话的人」。B站 的结构化 @ 只对当前还在房间的人生效：
  // 目标已经离开时服务端会把 reply_mid 归零，观众看到的是一条没有 @ 的弹幕。
  // 观众簿只能证明「来过」，刚发过弹幕才能证明「此刻还在」。
  const now = Date.now();
  let candidates = [];
  if (ctx.speakers && typeof ctx.speakers.recent === 'function') {
    candidates = ctx.speakers.recent({ withinMs: 180_000, limit: MAX_CANDIDATES, now });
  }

  // 冷场时可能很久没人说话，退回观众簿；这时 @ 可能挂不出来，
  // 但总比完全不开口好。
  if (candidates.length === 0) {
    const roster = ctx.roster;
    if (!roster || typeof roster.recent !== 'function') {
      // 没有观众簿（老宿主 / 某些沙盒）时直接静默：挑不到人就不说话，
      // 绝不能退化成"随便 @ 一个名字"或纯文本 @ —— 那比不说更糟。
      return;
    }
    candidates = roster.recent({
      withinMs: win.withinMs,
      minAgeMs: win.minAgeMs,
      limit: MAX_CANDIDATES,
      now,
    });
  }

  const picked = pickCandidate(candidates, cfg, st.called, now);
  if (!picked) {
    // 候选为空 / 全在冷却：**不清零 elapsed**。
    // 这样人一进来（过了 minAge）下一轮就会 @ 到，不用再等满一整个间隔。
    return;
  }

  const { text: tpl, cursor } = nextGreeting(cfg.templates, st.cursor, cfg.shuffle === true);
  if (!tpl) return;

  // 结构化 @ 时文案里绝不写 @名字：B站 会自己挂标签
  const greeting = ctx.render(tpl, { 用户: picked.name });
  const prepared = prepareText(greeting, { max: MAX_TEXT });
  if (prepared.truncated) {
    // 自动流程里没人能立刻改文案，抛错没意义；但也不能发半句话。
    // 只提示一次，避免每轮刷日志。
    if (!st.warnedLong) {
      ctx.log.warn(`招呼语超过 ${MAX_TEXT} 字会被截断，已跳过这一轮：把文案改短一点`);
      st.warnedLong = true;
    }
    return;
  }
  if (!prepared.text) return;

  st.elapsed = 0;
  st.cursor = cursor;
  st.inflight = true;

  // priority 固定 0：主动招呼没有时效性，不该为它挤掉礼物答谢的等待槽位。
  ctx
    .say(prepared.text, {
      reason: 'autocall',
      reply: { uid: picked.uid, uname: picked.name },
      priority: 0,
    })
    .then((r) => {
      st.inflight = false;
      if (r && r.ok) {
        // 只有真发出去才记：演练也算一次（推进轮换），但状态只在内存，
        // 重启即清空，不会污染真实观众簿。
        st.called.set(picked.uid, Date.now());
        st.sent++;
      } else {
        // 被限速/去重/没有闸门：不标记 = 候选保留，下一个间隔仍会挑他。
        // 节奏照常清零（跳过这一轮），不去 5 秒后连着再撞一次限速。
        ctx.log.debug?.(`本轮招呼未发出（${r?.skipped ?? 'unknown'}），候选保留`);
      }
    })
    .catch((err) => {
      st.inflight = false;
      ctx.log.warn(`主动招呼请求异常：${err.message}`);
    });
}
