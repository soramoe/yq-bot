/**
 * 定时播报：每隔一段时间自动说一句话。
 *
 * 这是三代第一个**不靠事件驱动**的插件 —— 它自己看表。
 * 也正因为如此，它踩到的是别的插件碰不到的三类坑，这里逐个处理：
 *
 * 1. **配置热改要立刻生效。** 其他插件的配置是"下一条事件用新值"，
 *    而这里的事件是定时器自己造的。如果用 `setInterval(间隔)`，
 *    用户把 600 秒改成 60 秒后还得等 10 分钟才生效，只会以为没保存成功。
 *    所以用 **自己给自己排下一轮** 的 setTimeout，每轮都重读配置。
 *
 * 2. **关掉的时候不能"憋着"。** 如果关闭状态下仍按原间隔排队，
 *    用户重新打开后要等一整个周期才听到第一句。关闭时改成 5 秒轮询，
 *    打开后 5 秒内就会开口 —— 这符合"我刚打开它，它就该动一下"的预期。
 *
 * 3. **限速时宁可跳过，不要排队。** 定时播报没有任何时效性，
 *    为它排队只会挤掉礼物答谢这类真正有反馈价值的话。
 *    所以 priority 固定 0：正好撞上间隔就这一轮不说，下一轮照常。
 *
 * 与二代的关系：二代的 `shout`（按间隔喊话）是独立插件，
 * 另有一个"定时播报"插件各管一套计时器，两个都开着就互相抢间隔。
 * 这里按 D6 合并成一个：**喊话只是"文案来源之一"，不是另一个计时器。**
 */

/** 间隔硬下限。低于它就是在刷屏，而刷屏是 B站 风控最明确的特征 */
const MIN_INTERVAL_SEC = 60;

/**
 * 定时器多久醒一次。
 *
 * 用"短周期唤醒 + 累加已过时间"而不是"一次性睡满间隔"，是为了让
 * **改配置立刻生效**：睡满 600 秒的话，用户把间隔改成 60 秒后还得等 10 分钟，
 * 只会以为没保存成功。5 秒醒一次，配置变更最多 5 秒就体现在下一次发言上。
 *
 * 代价是每小时 720 次空转 —— 一个空函数的开销，可以忽略。
 */
const WAKE_MS = 5000;

/**
 * 这个状态算不算"在播"。
 *
 * live_unknown 也要算：它是"房间里有人在说话，但没收到开播消息"，
 * 通常就是进程在直播中途启动。把它当未开播，会让人以为功能坏了。
 */
export function isLiveState(state) {
  return state === 'live' || state === 'live_unknown';
}

/** 把时间戳渲染成播报里能用的变量 */
export function varsOf(state, now = Date.now()) {
  const d = new Date(now);
  const p = (x) => String(x).padStart(2, '0');
  return {
    时间: `${p(d.getHours())}:${p(d.getMinutes())}`,
    日期: `${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    房间: String(state?.roomId ?? ''),
    状态: isLiveState(state?.state) ? '直播中' : '未开播',
  };
}

/**
 * 挑这一轮说哪句。
 *
 * 顺序模式的游标必须**跨轮保存**（放在 state 里），否则每轮都从第一句开始，
 * 用户会看到同一句话反复说 —— 而且会以为"我写的那几句没生效"。
 *
 * @param {string[]} list
 * @param {number} cursor  上一轮用到的下标（下一轮从 cursor+1 开始）
 * @param {boolean} shuffle
 * @param {() => number} [rand]
 * @returns {{text:string, cursor:number}}
 */
export function nextTemplate(list, cursor = 0, shuffle = false, rand = Math.random) {
  const items = (Array.isArray(list) ? list : []).map((s) => String(s ?? '').trim()).filter(Boolean);
  if (items.length === 0) return { text: '', cursor: 0 };

  if (shuffle) {
    const i = Math.min(items.length - 1, Math.max(0, Math.floor(rand() * items.length)));
    return { text: items[i], cursor };
  }

  const i = ((cursor % items.length) + items.length) % items.length;
  return { text: items[i], cursor: i + 1 };
}

/** 这一轮该不该开口。拆出来是为了能直接断言，不用等真实时间 */
export function shouldSpeak(config, state) {
  if (!config?.enabled) return { ok: false, reason: 'disabled' };
  if (!Array.isArray(config.templates) || config.templates.length === 0) {
    return { ok: false, reason: 'no-templates' };
  }
  if (config.onlyWhenLive !== false && !isLiveState(state?.state)) {
    return { ok: false, reason: 'not-live' };
  }
  return { ok: true };
}

export default {
  id: 'schedule',

  onStart(ctx) {
    /**
     * 计时器状态放 `ctx.scratch`，**不放 `this`**。
     *
     * `this` 是这个模块的导出对象，而 ESM 按 URL 缓存 —— 一个进程里只有一份。
     * 单房间时看没问题；一旦两个房间同时跑（或沙盒回放加载了第二份宿主），
     * 两份计时器会互相 `clearTimeout`，表现是"播报时有时无"，且不报错。
     */
    ctx.scratch.timer = null;
    ctx.scratch.cursor = 0;
    ctx.scratch.elapsed = 0;
    arm(ctx, ctx.scratch);
    ctx.log.info('定时播报已启动（关闭状态下每 5 秒检查一次开关）');
  },

  onStop(ctx) {
    stop(ctx, ctx.scratch);
    ctx.scratch.timer = null;
    ctx.log.info('定时播报已停止');
  },

  /**
   * 不认领任何事件。
   *
   * claims 是空对象而不是不写：`validateManifest` 对两者一视同仁，
   * 但写出来能让"这个插件不吃事件"这件事在 manifest 里一眼可见 ——
   * 排查"为什么它不说话"时，第一步就是确认它到底该不该被事件唤醒。
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

/**
 * 排下一次唤醒。每次只睡一个短周期（WAKE_MS），真正"到没到点"由 `tick` 数。
 */
function arm(ctx, st) {
  if (!st) return;
  stop(ctx, st);
  st.timer = setTimeout(() => {
    st.timer = null;
    try {
      tick(ctx, st);
    } catch (err) {
      // 定时器回调里抛出的异常没人接，会被 uncaughtException 接住，
      // 而入口对未捕获异常的处理是**关掉整个进程**。
      // 一句播报发不出去不该有这种代价。
      ctx.log.error(`定时播报出错：${err.message}`);
    }
    arm(ctx, st);
  }, WAKE_MS);

  // 不阻止进程退出（测试里尤其重要：忘了 stop 会让 node --test 挂住）
  st.timer.unref?.();
}

function tick(ctx, st) {
  const cfg = ctx.config ?? {};

  // 无论开关、无论是否在播，时间都照样累加。这样两种"刚打开"都能很快见效：
  //   · 关着放了一会儿再打开 → 攒的时间早就够，下一次唤醒就开口
  //   · 没开播时打开的 → 一开播就开口，而不是再等一整个周期
  st.elapsed += WAKE_MS;

  const verdict = shouldSpeak(cfg, ctx.state);
  if (!verdict.ok) return;

  const sec = Number(cfg.intervalSec);
  const intervalSec = Number.isFinite(sec) && sec >= MIN_INTERVAL_SEC ? sec : MIN_INTERVAL_SEC;
  if (st.elapsed < intervalSec * 1000) return;

  const { text, cursor } = nextTemplate(cfg.templates, st.cursor, cfg.shuffle === true);
  if (!text) return;

  const rendered = ctx.render(text, varsOf(ctx.state));
  if (!rendered) return;

  // 说话才清零：条件不满足时保留已攒的时间，条件一满足就能立刻说
  st.elapsed = 0;
  st.cursor = cursor;

  // 不 await、不排队：播报没有时效性，撞上限速就跳过这一轮
  ctx.say(rendered, { reason: 'schedule' }).then((r) => {
    if (r && !r.ok) ctx.log.debug?.(`本轮播报未发出（${r.skipped ?? 'unknown'}）：${rendered}`);
  });
}
