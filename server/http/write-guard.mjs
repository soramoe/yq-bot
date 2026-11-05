/**
 * 写操作的统一闸门。
 *
 * ## 为什么放在 HTTP 层，而不是每个路由里各写一遍
 *
 * 这里才知道 `req.method`，而且**新增写接口会自动被保护**。
 * 如果保护写在各个 handler 里，加一个 `/api/xxx` 却忘了加保护，
 * 结果没有任何提示 —— 这类漏洞不会自己暴露，只会在某天被人利用。
 *
 * ## 两道检查，顺序不能反
 *
 * 1. **Origin**：先挡"谁让你发的"。任何网页都能向 127.0.0.1 发 POST，
 *    但浏览器会在跨站请求里带上真实的 Origin，而 JS 改不了它。
 *    所以"Origin 对不上"就是"这个请求不是我们自己的页面发的"。
 * 2. **访问口令**：再验证"你有没有权限"。默认不启用 —— 因为 Origin
 *    检查已经把 CSRF 挡住了，口令是给"本机其它程序"和"不在浏览器里
 *    但能连 localhost 的东西"准备的。
 *
 * 顺序不能反：先要口令再查 Origin 的话，一个跨站请求会先触发
 * scrypt（50ms CPU），等于给攻击者一个廉价的 CPU 放大器。
 */

/**
 * 不需要口令的写接口。
 *
 * 只有解锁本身 —— 否则一旦设了口令，就再也没有入口能把它打开。
 * **注意：Origin 检查对它们仍然生效**，所以"跨站偷偷设口令"这条路是堵死的。
 */
const OPEN_PATHS = new Set(['/api/access/unlock']);

/**
 * 检查 Origin。
 *
 * 返回 null = 放行；否则返回错误描述。
 *
 * 没有 Origin 的请求（curl、脚本、Node 客户端）放行：它们不受浏览器
 * 同源策略约束，伪造 Origin 也毫无意义 —— 能连 localhost 的进程本来
 * 就能直接读 `data/auth.json`，在这里挡它纯属自欺。
 *
 * @param {string|undefined} origin
 * @param {number} port
 * @returns {{status:number, code:string, message:string}|null}
 */
export function checkOrigin(origin, port) {
  if (!origin) return null;

  const value = String(origin).trim().toLowerCase();
  // sandboxed iframe 和 file:// 会给出字面量 "null"：一律拒绝
  if (value === 'null') {
    return { status: 403, code: 'bad_origin', message: '拒绝来自本地文件的跨源请求' };
  }

  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);

  if (!allowed.has(value)) {
    return {
      status: 403,
      code: 'bad_origin',
      message: `只接受本机页面发起的写操作（收到 Origin: ${value}）`,
    };
  }
  return null;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {{app:any, port:number, pathname:string}} ctx
 * @returns {{status:number, code:string, message:string}|null}
 */
export function guardWrite(req, { app, port, pathname }) {
  const method = String(req.method ?? 'GET').toUpperCase();
  // 只读方法不管。GET 不该改状态；项目里唯一的"GET 有副作用"
  // 是 /api/reconcile，而它只读日志、只返回结果。
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  const originBad = checkOrigin(req.headers.origin, port);
  if (originBad) return originBad;

  if (OPEN_PATHS.has(pathname)) return null;

  const guard = app?.access;
  if (!guard?.enabled) return null;

  if (guard.verify(req.headers['x-access-token'])) return null;

  const left = guard.lockedFor();
  if (left > 0) {
    return {
      status: 429,
      code: 'locked',
      message: `连续输错了，请等 ${Math.ceil(left / 1000)} 秒再试`,
    };
  }
  return { status: 401, code: 'locked_out', message: '需要访问口令（在侧栏「访问口令」里解锁）' };
}

export default guardWrite;
