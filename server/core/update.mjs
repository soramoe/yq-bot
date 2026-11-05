/**
 * 更新检查。
 *
 * ## 只提示，不自动覆盖
 *
 * 自动更新对"直播间挂着跑"的工具有天然吸引力，但代价是这个：
 * 半夜更新失败 → 第二天开播发现机器人起不来，而你不知道为什么。
 * 这个项目的每一处设计都在避免"静默坏掉"，所以这里**只检查、只提示**，
 * 装不装、什么时候装，由人决定。
 *
 * ## 更新源可配置，默认没有
 *
 * 三代没有发布到 npm，也没有固定的 GitHub Release —— 编一个写死的地址
 * 等于让它永远 404，用户只会看到"检查失败"这种毫无信息量的提示。
 * 所以默认 `updateUrl` 为空，检查时明确返回「尚未配置更新源」，
 * 而不是假装检查过了。
 *
 * 更新源格式（一个 JSON，放哪都行，能 GET 到就行）：
 *
 *   { "version": "0.3.0", "notes": "改了什么", "url": "下载页" }
 *
 * ## 失败不抛异常
 *
 * 这个接口的失败概率远高于成功（没网、源挂了、格式不对）。
 * 抛异常会让前端弹一个红色错误——但"检查更新失败"不是错误，
 * 是**没有结果**。所以一律返回 `{ok:false, error:'人话'}`。
 */

/** 默认缓存 5 分钟：点两下不该发两次请求 */
const CACHE_MS = 5 * 60_000;

/** 超时。更新源可能是境外主机，但 8 秒还没响应就没必要等了 */
const TIMEOUT_MS = 8000;

/**
 * 版本比较。
 *
 * 只做**数字段比较**：`1.10.0 > 1.9.0`（字符串比较会得出相反结论，
 * 这是最容易踩的坑）。预发布标记（`-beta.1`）一律忽略 ——
 * 这个项目不用预发布版本号，为它写一套 semver 是浪费。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} a>b 返回正数
 */
export function compareVersion(a, b) {
  const pick = (v) =>
    String(v ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0] // 丢掉预发布后缀
      .split('.')
      .map((x) => Number.parseInt(x, 10))
      .map((x) => (Number.isFinite(x) ? x : 0));

  const x = pick(a);
  const y = pick(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 校验更新源返回的 JSON。
 * @returns {{version:string, notes:string, url:string}|null}
 */
export function parseManifest(data) {
  if (!data || typeof data !== 'object') return null;
  const version = String(data.version ?? '').trim();
  // 只认 "数字.数字..." 这种形状：一个乱七八糟的 version 会让
  // "有新版本吗"这个判断变成随机的
  if (!/^\d+(\.\d+){0,3}$/.test(version.replace(/^v/i, ''))) return null;
  return {
    version,
    notes: String(data.notes ?? '').slice(0, 2000),
    url: String(data.url ?? '').slice(0, 500),
  };
}

export class UpdateChecker {
  /**
   * @param {object} opts
   * @param {string} opts.current 当前版本（来自 package.json）
   * @param {() => string} [opts.getUrl] 每次现取：用户改配置后立刻生效，不用重启
   * @param {typeof fetch} [opts.fetchImpl] 自检注入用
   * @param {number} [opts.cacheMs]
   * @param {number} [opts.timeoutMs]
   */
  constructor({ current, getUrl, fetchImpl = globalThis.fetch, cacheMs = CACHE_MS, timeoutMs = TIMEOUT_MS }) {
    this.current = String(current ?? '0.0.0');
    this.getUrl = getUrl ?? (() => '');
    this.fetchImpl = fetchImpl;
    this.cacheMs = cacheMs;
    this.timeoutMs = timeoutMs;

    this._cache = null;
    this._inflight = null;
  }

  /** 上次结果（含"没配置"这种结论）。给页面首屏用，不发请求 */
  snapshot() {
    if (!this._cache) return null;
    return { ...this._cache, cached: true };
  }

  /**
   * 检查更新。
   *
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<{configured:boolean, current:string, latest?:string|null,
   *   hasUpdate?:boolean, notes?:string, url?:string, checkedAt?:number,
   *   error?:string, hint?:string, cached?:boolean}>}
   */
  async check({ force = false } = {}) {
    const url = String(this.getUrl() ?? '').trim();

    // 没配更新源：明确说出来，并且不缓存 —— 用户随时可能填上，
    // 缓存一个"没配置"的结论会让填完之后还要等 5 分钟才生效
    if (!url) {
      return {
        configured: false,
        current: this.current,
        hint: '还没有配置更新源。在 data/app.json 里填 updateUrl（一个返回版本 JSON 的地址）',
      };
    }

    if (!force && this._cache && this._cache.source === url && Date.now() - this._cache.checkedAt < this.cacheMs) {
      return { ...this._cache, cached: true };
    }

    // 并发保护：连点两下只发一次请求。返回同一个 Promise 而不是
    // 直接拒绝 —— 用户只是想看看，没必要让他看到"忙"
    if (this._inflight) return this._inflight;

    this._inflight = this._doCheck(url).finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  async _doCheck(url) {
    const checkedAt = Date.now();

    // scheme 白名单：file:// 之类不该出现在这里，
    // 而且 http 明文能接受（本机/内网源），https 更好
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { configured: true, current: this.current, checkedAt, error: '更新源地址不是合法 URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { configured: true, current: this.current, checkedAt, error: '更新源只支持 http/https' };
    }

    let res;
    try {
      res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json' },
        // 更新源可能是 CDN，给一个不会引起困惑的 UA
        // （有些源会拒绝默认的 undici UA）
        // 注意：不带任何账号信息
      });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return {
        configured: true,
        current: this.current,
        checkedAt,
        error: timeout ? `更新源 ${this.timeoutMs / 1000} 秒没响应` : `连不上更新源：${err?.message ?? '未知错误'}`,
      };
    }

    if (!res?.ok) {
      return {
        configured: true,
        current: this.current,
        checkedAt,
        error: `更新源返回 HTTP ${res?.status ?? '?'}`,
      };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return { configured: true, current: this.current, checkedAt, error: '更新源返回的不是合法 JSON' };
    }

    const manifest = parseManifest(data);
    if (!manifest) {
      return {
        configured: true,
        current: this.current,
        checkedAt,
        error: '更新源格式不对：需要 { "version": "0.3.0" } 这样的 JSON',
      };
    }

    const result = {
      configured: true,
      current: this.current,
      latest: manifest.version,
      hasUpdate: compareVersion(manifest.version, this.current) > 0,
      notes: manifest.notes,
      url: manifest.url,
      source: url,
      checkedAt,
    };
    this._cache = result;
    return result;
  }
}

export default UpdateChecker;
