/**
 * 关键词回击：弹幕里出现指定关键词时回一句。
 *
 * 看起来是最简单的玩法（"匹配到就说话"），但它有三个必须提前想清楚的地方，
 * 否则上线当天就会变成刷屏机器：
 *
 * 1. **默认用"整句相等"，而不是"包含"。**
 *    包含匹配听起来更"智能"，实际是灾难：一个 2000 人的房间，
 *    每秒十几条弹幕，只要有一句里带了"晚安"，它就回。而"包含"还会
 *    命中"晚安晚安晚安""还没晚安呢"这类正常聊天 —— 观众立刻知道这是机器人。
 *    所以默认 exact，想放宽可以自己改，但默认值必须是安全的那个。
 *
 * 2. **同一规则必须有冷却，而且是"规则级"不是"全局级"。**
 *    全局冷却会让"打卡"和"晚安"互相挤占；规则级冷却才是
 *    "这个词一分钟内只回一次"这个用户真正想要的语义。
 *
 * 3. **回复本身不会再触发自己。**
 *    这一条不用写代码 —— 内核根本不把 `SENT` 事件交给插件
 *    （见 room-runner 的 PLUGIN_INVISIBLE）。如果哪天有人"顺手"把 SENT
 *    放开给插件，这里就会进入无限回击。所以下面还有一道 cheap 的自我检查：
 *    忽略未登录用户和空内容，避免把系统消息当成观众发言。
 *
 * 与二代的关系：二代的关键词插件把"匹配"和"发送"写在一起，
 * 而且用的是 `indexOf`（等于强制包含匹配）。三代把匹配拆成纯函数，
 * 可以单独断言"这条弹幕该不该回"。
 */

/**
 * 解析规则行。
 *
 * 格式：`关键词=回复`，关键词可以用 `|` 分隔多个写法。
 * 用第一个 `=` 切分，这样回复里可以再出现 `=`（比如 `礼包=兑换码:a=b`）。
 *
 * 解析失败的行**跳过并计数**，不静默丢弃 —— 用户写了 10 行只生效 3 行时，
 * 必须能在日志里看到"有 7 行格式不对"，而不是以为规则没保存。
 *
 * @param {string[]} lines
 * @returns {{rules: Array<{keywords:string[], reply:string}>, bad:number}}
 */
export function parseRules(lines) {
  const rules = [];
  let bad = 0;

  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw ?? '').trim();
    if (!line) continue;
    // 允许用 # 或 // 开头的注释行，方便把规则分组
    if (line.startsWith('#') || line.startsWith('//')) continue;

    const at = line.indexOf('=');
    if (at <= 0) {
      bad++;
      continue;
    }

    const keywords = line
      .slice(0, at)
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    const reply = line.slice(at + 1).trim();

    if (keywords.length === 0 || !reply) {
      bad++;
      continue;
    }
    rules.push({ keywords, reply });
  }

  return { rules, bad };
}

/**
 * 一组关键词里，有没有哪个命中了这句话？返回命中的那个写法，没命中返回空串。
 */
export function hitKeyword(keywords, text, mode = 'exact', ignoreCase = true) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const hay = ignoreCase ? raw.toLowerCase() : raw;

  for (const kw of Array.isArray(keywords) ? keywords : []) {
    const needle = ignoreCase ? String(kw).toLowerCase() : String(kw);
    if (!needle) continue;
    const hit =
      mode === 'contains'
        ? hay.includes(needle)
        : mode === 'prefix'
          ? hay.startsWith(needle)
          : hay === needle;
    if (hit) return kw;
  }
  return '';
}

/**
 * 这条弹幕命中哪条规则？返回下标，没命中返回 -1。
 *
 * @param {Array<{keywords:string[]}>} rules
 * @param {string} text
 * @param {'exact'|'prefix'|'contains'} mode
 * @param {boolean} ignoreCase
 * @returns {{index:number, keyword:string}}
 */
export function matchRule(rules, text, mode = 'exact', ignoreCase = true) {
  if (!String(text ?? '').trim()) return { index: -1, keyword: '' };
  for (let i = 0; i < rules.length; i++) {
    const kw = hitKeyword(rules[i].keywords, text, mode, ignoreCase);
    if (kw) return { index: i, keyword: kw };
  }
  return { index: -1, keyword: '' };
}

/** 冷却判定拆成纯函数：注入 now 才能断言，不用真的等 60 秒 */
export function isCoolingDown(lastAt, cooldownSec, now) {
  const sec = Number(cooldownSec);
  if (!Number.isFinite(sec) || sec <= 0) return false;
  if (!lastAt) return false;
  return now - lastAt < sec * 1000;
}

/**
 * 这条弹幕值不值得回应。
 *
 * 不看内容只看"人"：没有 uid 或没有用户名的，多半是系统消息
 * （房间公告、活动提示），回它没有任何意义。
 */
export function isReplyable(payload) {
  const p = payload ?? {};
  if (p.uid === null || p.uid === undefined || p.uid === '') return false;
  const uname = String(p.uname ?? '').trim();
  if (!uname) return false;
  if (!String(p.text ?? '').trim()) return false;
  return true;
}

export default {
  id: 'reply',

  onStart(ctx) {
    /**
     * 状态放 `ctx.scratch`（每个宿主的每个插件独有的一份），不放 `this`。
     * `this` 是模块导出对象，一个进程里只有一份 —— 多房间时会串味，
     * 而串味的症状是"隔壁房间回了、这个房间不回"，最难联想。
     */
    ctx.scratch.last = new Map();
    ctx.scratch.src = null;
    ctx.scratch.parsed = { rules: [], bad: 0 };
    ctx.log.info('关键词回击已启动');
  },

  onStop(ctx) {
    ctx.scratch.last = null;
    ctx.scratch.parsed = null;
    ctx.scratch.src = null;
    ctx.log.info('关键词回击已停止');
  },

  onEvent(ctx, ev) {
    if (ev.type !== 'DANMAKU') return false;

    const cfg = ctx.config;
    if (!cfg?.enabled) return false;
    if (!isReplyable(ev.payload)) return false;
    // 没走 onStart（测试里直接喂事件）时也要能用
    if (!ctx.scratch.last) ctx.scratch.last = new Map();
    if (!ctx.scratch.parsed) ctx.scratch.parsed = { rules: [], bad: 0 };

    const rules = this._rules(ctx);
    if (rules.length === 0) return false;

    const text = String(ev.payload.text ?? '');
    const mode = cfg.matchMode || 'exact';
    const ic = cfg.ignoreCase !== false;
    /**
     * 冷却用**事件时间**，不是 `Date.now()`。
     *
     * 线上两者几乎相等；但沙盒回放把几小时日志压成几百毫秒跑完，
     * 按真实时钟判冷却会让"几小时前回过的那个人"一直被当成在冷却里，
     * 于是回放结果比当时少一大截，而且不报错 —— 用户只会觉得
     * "我改了规则怎么没反应"。
     */
    const now = Number.isFinite(ev.ts) && ev.ts > 0 ? ev.ts : Date.now();

    /**
     * 逐个规则找"命中了、而且不在冷却里"的那一条。
     *
     * 为什么不是"取第一条命中的，再看它冷却没冷却"：
     * 包含模式下 `打卡晚安` 会同时命中两条规则，如果先命中的那条正在冷却，
     * 直接放弃就等于"明明有可用的规则却不回"。这种漏回不会报错，
     * 表现是"偶尔某句话没反应"，最难查。
     */
    let picked = -1;
    let keyword = '';
    for (let i = 0; i < rules.length; i++) {
      const kw = hitKeyword(rules[i].keywords, text, mode, ic);
      if (!kw) continue;
      if (isCoolingDown(ctx.scratch.last.get(i) ?? 0, cfg.cooldownSec, now)) {
        ctx.log.debug?.(`关键词「${kw}」在冷却中，这条不回`);
        continue;
      }
      picked = i;
      keyword = kw;
      break;
    }
    if (picked < 0) return false;

    ctx.scratch.last.set(picked, now);

    const vars = {
      回复: rules[picked].reply,
      用户: String(ev.payload.uname ?? ''),
      关键词: keyword,
      内容: text,
    };
    const out = ctx.render(cfg.template || '{回复}', vars);
    if (!out) return false;

    /**
     * priority 1 + 等一个间隔：回击是观众能立刻感知到的互动，
     * 撞上限速时值得等一个槽位（最多一个最小间隔）。
     * 但不能等更久 —— 一分钟后再回一句"打卡成功"比不回更怪。
     */
    ctx
      .say(out, {
        reason: 'reply',
        reply: { uid: ev.payload.uid, uname: ev.payload.uname },
        priority: 1,
        maxWaitMs: 1500,
      })
      .then((r) => {
        if (r && !r.ok) ctx.log.debug?.(`关键词回复未发出（${r.skipped ?? 'unknown'}）：${out}`);
      });

    return true;
  },

  /**
   * 按需解析规则，并带缓存。
   *
   * 不做缓存的话，每条弹幕都要重新解析一遍规则行 —— 房间里每秒十几条，
   * 1000 条规则就是每秒上万次字符串切分，纯粹白烧 CPU。
   * 缓存键用原始行的长度 + 内容拼接：用户改了规则就重新解析，
   * 没改就一直用（配置对象是每次 updateConfig 生成的新对象，
   * 但 lines 数组的内容不变，所以这里比的是内容不是引用）。
   */
  _rules(ctx) {
    const lines = ctx.config?.rules ?? [];
    const key = Array.isArray(lines) ? lines.join('\u0000') : '';
    if (key !== ctx.scratch.src) {
      ctx.scratch.src = key;
      ctx.scratch.parsed = parseRules(lines);
      if (ctx.scratch.parsed.bad > 0) {
        ctx.log.warn(`关键词规则有 ${ctx.scratch.parsed.bad} 行格式不对（要写成 关键词=回复），已跳过`);
      }
      // 规则变了，冷却表的下标含义也变了：整体清掉比"猜哪个下标还是原来那条"安全
      ctx.scratch.last.clear();
    }
    return ctx.scratch.parsed.rules;
  },
};
