/**
 * 登录凭证的持久化。
 *
 * 一个文件：`data/auth.json`
 *
 * 三条硬要求：
 *
 * 1. **原子写**。先写 `.tmp` 再 rename。直接覆盖写，一旦在写一半时断电，
 *    下次启动就是"Cookie 文件损坏"，用户得重新扫码 —— 而这类失败
 *    偏偏只出现在关机/崩溃之后，最难联想到原因。
 *
 * 2. **不打日志**。整个模块不产生任何包含 Cookie 的字符串，
 *    对外只提供 describe()（脱敏摘要）。
 *
 * 3. **读取要能容错**。文件不存在、JSON 坏了、字段缺失，
 *    都应该退化成"未登录"，而不是让进程起不来。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { isComplete, missingFields, redactCookie, uidFromCookie } from './bili/cookie.mjs';

const FILE = 'auth.json';

export class AuthStore {
  /**
   * @param {{dataDir:string}} opts
   */
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.file = join(dataDir, FILE);
    /** @type {{cookie:string, uid:number, uname:string, face:string, savedAt:string}|null} */
    this.state = null;
    this.loadedAt = 0;
  }

  /** 从磁盘读一次。失败一律当作未登录。 */
  load() {
    try {
      if (!existsSync(this.file)) {
        this.state = null;
        return this;
      }
      const raw = readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);

      // 结构校验：宁可当作未登录，也不要把半截数据当有效凭证
      if (!data || typeof data.cookie !== 'string' || !isComplete(data.cookie)) {
        this.state = null;
        return this;
      }

      this.state = {
        cookie: data.cookie,
        uid: Number(data.uid) || uidFromCookie(data.cookie),
        uname: String(data.uname || ''),
        face: String(data.face || ''),
        savedAt: String(data.savedAt || ''),
      };
    } catch {
      this.state = null;
    }
    this.loadedAt = Date.now();
    return this;
  }

  /** 保存登录态。原子写 + 尽力收紧权限。 */
  save({ cookie, uid, uname, face }) {
    if (!isComplete(cookie)) {
      throw new Error(`凭证不完整，缺少：${missingFields(cookie).join('、')}`);
    }

    const state = {
      cookie,
      uid: Number(uid) || uidFromCookie(cookie),
      uname: String(uname || ''),
      face: String(face || ''),
      savedAt: new Date().toISOString(),
    };

    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);

    // Windows 上 chmod 基本无效，POSIX 上有效；失败不影响功能
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* ignore */
    }

    this.state = state;
    this.loadedAt = Date.now();
    return state;
  }

  /** 清除登录态（退登、或校验发现已失效） */
  clear() {
    this.state = null;
    try {
      if (existsSync(this.file)) unlinkSync(this.file);
    } catch {
      /* ignore */
    }
  }

  /** 只更新账号资料，不动 Cookie（扫码成功后补 uname/face 用） */
  patchProfile({ uname, face, uid }) {
    if (!this.state) return null;
    if (uname) this.state.uname = String(uname);
    if (face) this.state.face = String(face);
    if (uid) this.state.uid = Number(uid);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
    return this.state;
  }

  get cookie() {
    return this.state?.cookie || '';
  }

  get loggedIn() {
    return Boolean(this.state);
  }

  /**
   * 对外可见的状态。**不含 Cookie** —— 这是前端唯一允许拿到的形状。
   */
  status() {
    if (!this.state) return { loggedIn: false };
    return {
      loggedIn: true,
      uid: this.state.uid,
      uname: this.state.uname,
      face: this.state.face,
      savedAt: this.state.savedAt,
    };
  }

  /** 给日志用的脱敏摘要 */
  describe() {
    if (!this.state) return '未登录';
    return `已登录 ${this.state.uname || this.state.uid}（${redactCookie(this.state.cookie)}）`;
  }
}
