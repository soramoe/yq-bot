/**
 * 表驱动路由。
 *
 * 二代是 54 个手写 `if (pathname === ...)` 分支，加接口时容易插错位置，
 * 而且匹配顺序变成隐式依赖（谁写在前面谁先命中）。这里换成一张表：
 * 声明即注册，匹配顺序只看注册顺序，一眼能看完。
 *
 * 支持两种模式：
 *   /api/events        精确匹配
 *   /api/room/:id      命名参数
 *
 * 不引第三方路由库：匹配逻辑不到 40 行，依赖不值得。
 */

/**
 * 把 `/api/room/:id` 编译成正则 + 参数名列表。
 * @param {string} pattern
 */
function compile(pattern) {
  if (!pattern.startsWith('/')) {
    throw new Error(`路由必须以 / 开头：${pattern}`);
  }

  const names = [];
  let source = '';

  for (const seg of pattern.split('/')) {
    if (!seg) continue;
    if (seg.startsWith(':')) {
      names.push(seg.slice(1));
      // 参数段不跨 `/`。[^/]+ 保证 `/api/room/` 后面必须有内容
      source += '/([^/]+)';
    } else {
      source += `/${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    }
  }

  // 允许结尾多一个 /，但不允许中间空段
  return { re: new RegExp(`^${source || '/'}/?$`), names };
}

/**
 * 把路径参数解码成人能看的字符串。
 *
 * 为什么要包一层：`new URL()` 对**不完整的多字节序列**（比如 `%E0%A4%A`）
 * 是照收不误的，而 `decodeURIComponent()` 会抛 `URIError`。
 * 不接住的话，一个拼错的地址会一路冒到 HTTP 层的兜底：
 * 500 + `internal_error` + 一整段堆栈 —— 服务器明明什么都没坏，
 * 却让人去翻服务端日志；而且本机任何进程拼个坏地址就能把日志刷满。
 *
 * 这是**请求方的错**，说清楚就够了。
 *
 * @param {string} raw
 * @returns {string}
 */
function decodeParam(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw Object.assign(new Error(`请求地址里有无法解码的部分：${raw}`), {
      status: 400,
      code: 'bad_path',
    });
  }
}

export class Router {
  constructor() {
    /** @type {{method:string, pattern:string, re:RegExp, names:string[], handler:Function}[]} */
    this.routes = [];
  }

  /**
   * @param {string} method
   * @param {string} pattern
   * @param {(ctx:object)=>any} handler
   */
  add(method, pattern, handler) {
    const { re, names } = compile(pattern);
    this.routes.push({ method: method.toUpperCase(), pattern, re, names, handler });
    return this;
  }

  get(pattern, handler) {
    return this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler);
  }

  put(pattern, handler) {
    return this.add('PUT', pattern, handler);
  }

  /**
   * @param {string} method
   * @param {string} pathname
   * @returns {{handler:Function, params:object, pattern:string}|{allow:string[]}|null}
   *   命中返回处理函数；路径存在但方法不对返回 allow 列表；都没有返回 null
   */
  match(method, pathname) {
    const allow = new Set();
    let pathHit = false;

    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathHit = true;
      if (r.method !== method) {
        allow.add(r.method);
        continue;
      }

      const params = Object.create(null);
      r.names.forEach((name, i) => {
        params[name] = decodeParam(m[i + 1] ?? '');
      });
      return { handler: r.handler, params, pattern: r.pattern };
    }

    // HEAD 当 GET 处理：浏览器和监控工具都会用
    if (method === 'HEAD' && allow.has('GET')) {
      const hit = this.match('GET', pathname);
      if (hit && hit.handler) return hit;
    }

    if (pathHit) {
      allow.add('OPTIONS');
      return { allow: [...allow] };
    }
    return null;
  }

  /** 调试用：把所有路由打出来 */
  list() {
    return this.routes.map((r) => `${r.method} ${r.pattern}`);
  }
}

export default Router;
