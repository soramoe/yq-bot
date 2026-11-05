/**
 * 观测台访问口令。
 *
 * ## 先想清楚：一个只绑 127.0.0.1 的工具，为什么还要口令
 *
 * 因为它挡不住浏览器。任何一个你打开的网页，都能向 `127.0.0.1:8900`
 * 发 POST —— 服务只检查 Host 头（防 DNS 重绑定），不检查"谁让你发的"。
 * 也就是说，在你没关掉演练模式的情况下，一个恶意页面理论上能：
 * 关掉演练 → 改插件文案 → 切房间。这不是虚构场景，CSRF 就是这个形状。
 *
 * 两道防线，本模块是第二道：
 *
 * 1. **Origin 检查**（在 http/server.mjs）。跨站请求一定带 Origin，
 *    对不上就 403。默认就开着，不需要用户做任何事。
 * 2. **访问口令**（这里）。可选，默认关闭 —— 它挡的是"本机其它程序"，
 *    以及浏览器之外的 localhost 调用者。开了之后写操作要带
 *    `X-Access-Token` 头。
 *
 * ## 为什么用自定义头而不是 Cookie
 *
 * Cookie 会被浏览器自动带上，跨站请求也带 —— 那等于没防 CSRF。
 * 自定义头必须由 JS 显式设置，而跨域带自定义头会先发预检（OPTIONS），
 * 预检过不去，请求根本发不出去。所以「口令放在自定义头里」同时解决了
 * 「验证身份」和「挡住跨站」两件事。
 *
 * ## 为什么存哈希而不是明文
 *
 * 口令和 Cookie 同级：都是"拿到就能以你的身份操作"。而 `data/` 目录
 * 常常会被整个复制走（备份、换机器、发给别人看日志），
 * 存明文等于把口令一起送出去。scrypt 加盐之后，文件被拿走也没关系。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const FILE = 'access.json';

/** 派生密钥长度。64 字节 = 512 位，够用且不会让 scrypt 变慢 */
const KEY_LEN = 64;

/**
 * scrypt 参数。
 *
 * N=16384 在普通机器上约 50ms —— 对"人点一下解锁"完全无感，
 * 对暴力破解则是每秒 20 次的硬上限。再调高会让老机器明显卡顿，
 * 而这个口令保护的是本机工具，不值得。
 *
 * `maxmem` 必须显式给：默认上限是 32MB，而 N=16384,r=8 需要 128*N*r = 16MB
 * 加上开销刚好在边缘，机器不同会偶发抛 "memory limit exceeded"。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const MIN_LENGTH = 6;
export const MAX_LENGTH = 128;

/** 连续错几次开始退避 */
const FREE_TRIES = 5;
/** 退避时长。只挡"在线猜"，不锁死用户 —— 等半分钟就能再试 */
const BACKOFF_MS = 30_000;

/**
 * 口令强度检查。API 层和自检共用这一套规则，避免两边各写一遍。
 * @param {unknown} pw
 * @returns {string|null} 有问题返回人话，没问题返回 null
 */
export function passwordProblem(pw) {
  if (typeof pw !== 'string') return '口令必须是字符串';
  const s = pw.trim();
  if (s.length < MIN_LENGTH) return `口令至少 ${MIN_LENGTH} 位`;
  if (s.length > MAX_LENGTH) return `口令最多 ${MAX_LENGTH} 位`;
  // 纯空格、纯同一个字符这种，长度够了也没有意义
  if (new Set(s).size < 3) return '口令太单调了，换一个';
  return null;
}

export class AccessGuard {
  /**
   * @param {{dataDir:string}} opts
   */
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.file = join(dataDir, FILE);

    this.enabled = false;
    /** @type {Buffer|null} */
    this._hash = null;
    /** @type {Buffer|null} */
    this._salt = null;
    this.updatedAt = '';

    this._fails = 0;
    this._blockedUntil = 0;

    this.load();
  }

  /**
   * 从磁盘读。任何异常都退化成"没有口令"——
   * 一个坏掉的 access.json 不该把整个服务锁在门外。
   */
  load() {
    try {
      if (!existsSync(this.file)) {
        this._reset();
        return this;
      }
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));

      const salt = typeof raw?.salt === 'string' ? Buffer.from(raw.salt, 'hex') : null;
      const hash = typeof raw?.hash === 'string' ? Buffer.from(raw.hash, 'hex') : null;
      // 结构不全就当作没设过：宁可"口令没生效"，也不能"谁都进不来"
      if (raw?.enabled !== true || !salt?.length || hash?.length !== KEY_LEN) {
        this._reset();
        return this;
      }

      this.enabled = true;
      this._salt = salt;
      this._hash = hash;
      this.updatedAt = String(raw.updatedAt || '');
    } catch {
      this._reset();
    }
    return this;
  }

  _reset() {
    this.enabled = false;
    this._hash = null;
    this._salt = null;
    this.updatedAt = '';
    this._fails = 0;
    this._blockedUntil = 0;
  }

  /* ────────────────────────── 写 ────────────────────────── */

  /**
   * 设置（或修改）口令，并立即生效。
   *
   * 不返回任何含口令/哈希的东西 —— 调用方不需要，给了反而多一个泄露面。
   * @param {string} pw
   */
  setPassword(pw) {
    const bad = passwordProblem(pw);
    if (bad) throw Object.assign(new Error(bad), { status: 400, code: 'weak_password' });

    const salt = randomBytes(16);
    const hash = scryptSync(pw.trim(), salt, KEY_LEN, SCRYPT);

    mkdirSync(this.dataDir, { recursive: true });
    const next = {
      v: 1,
      enabled: true,
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      updatedAt: new Date().toISOString(),
    };
    this._write(next);

    this.enabled = true;
    this._salt = salt;
    this._hash = hash;
    this.updatedAt = next.updatedAt;
    this._fails = 0;
    this._blockedUntil = 0;

    return this.status();
  }

  /**
   * 关掉口令。**删文件而不是写 enabled:false** ——
   * 留着一份用不到的哈希，只会在下次出问题时让人怀疑"是不是它导致的"。
   */
  disable() {
    try {
      if (existsSync(this.file)) unlinkSync(this.file);
    } catch {
      /* 删不掉也要把内存状态改掉：否则界面说"已关闭"而实际还锁着 */
    }
    this._reset();
    return this.status();
  }

  _write(obj) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* Windows 上基本无效 */
    }
  }

  /* ────────────────────────── 校验 ────────────────────────── */

  /**
   * 校验口令。
   *
   * 未启用时**永远返回 true**：调用方不必到处判断 enabled，
   * 少一个分支就少一处"忘了判断导致误拦"的机会。
   *
   * 比较前 `trim()`，和 `setPassword()` 保持同一个口径。
   * 早先这里是原样比较、而设置时存的是 trim 过的值 —— 于是
   * 「用带首尾空格的口令设好，再用同样的口令解锁」会失败。
   * 界面里恰好两端都 trim 了，所以肉眼看不出来；但接口是公开的，
   * 脚本/curl 调一次就会撞上，而且失败信息是「口令不对」，
   * 用户只会以为自己记错了。口径必须只在一处定义。
   *
   * @param {unknown} token
   */
  verify(token) {
    if (!this.enabled) return true;

    if (Date.now() < this._blockedUntil) return false;

    const pw = typeof token === 'string' ? token.trim() : '';
    if (!pw) return false;

    // 长度先粗筛：口令超过 MAX_LENGTH 一定是错的，不必花 50ms 去算
    if (pw.length > MAX_LENGTH) {
      this._countFail();
      return false;
    }

    let ok = false;
    try {
      const got = scryptSync(pw, this._salt, KEY_LEN, SCRYPT);
      // 定长比较，不用 ===：字符串比较会在第一个不同字节提前返回，
      // 时间差足以让攻击者逐字节猜（虽然本机工具上这属于过度设计，
      // 但正确写法不比错误写法贵）
      ok = timingSafeEqual(got, this._hash);
    } catch {
      ok = false;
    }

    if (ok) {
      this._fails = 0;
      this._blockedUntil = 0;
    } else {
      this._countFail();
    }
    return ok;
  }

  _countFail() {
    this._fails++;
    if (this._fails >= FREE_TRIES) {
      // 退避后重置计数：否则用户等完 30 秒，试一次又立刻被锁
      this._fails = 0;
      this._blockedUntil = Date.now() + BACKOFF_MS;
    }
  }

  /** 还要被挡多少毫秒（0 表示没被挡）。给前端显示"稍等 N 秒" */
  lockedFor() {
    const left = this._blockedUntil - Date.now();
    return left > 0 ? left : 0;
  }

  /**
   * 对外状态。**绝不含 salt/hash**：这是唯一允许下发给前端的形状。
   */
  status() {
    return {
      enabled: this.enabled,
      updatedAt: this.updatedAt,
      minLength: MIN_LENGTH,
      lockedMs: this.lockedFor(),
    };
  }
}

export default AccessGuard;
