/**
 * 一键更新的"执行半步"：下载、校验、备份、替换、回滚。
 *
 * 这里刻意只做能被自检覆盖的纯文件操作，不碰进程：
 *   - 停服务、等进程退出、重启、健康检查都在 `server/tools/update-apply.mjs`；
 *   - 这个模块被 API 和 CLI 共用，测试可以在临时目录里反复跑。
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

/** 更新包上限。录播素材之类不能混进来 */
export const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;

/** 更新包会覆盖的顶层条目（data/ 永远不在里面） */
export const REPLACE_ITEMS = Object.freeze([
  'server',
  'web',
  'plugins',
  'docs',
  'package.json',
  'package-lock.json',
  'README.md',
  '.gitignore',
]);

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * @returns {string} 空串表示包没问题，否则是人话错误
 */
export function packageProblem(buffer, { sha256 = '', size = 0 } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return '更新包是空的';
  if (buffer.length > MAX_PACKAGE_BYTES) return '更新包太大了（超过 100MB）';
  if (size && buffer.length !== size) {
    return `更新包大小不对（应为 ${size} 字节，实际 ${buffer.length} 字节）`;
  }
  if (sha256 && sha256Hex(buffer) !== String(sha256).toLowerCase()) {
    return '更新包校验失败（sha256 对不上，可能没下完整）';
  }
  return '';
}

/**
 * 下载更新包。只允许 https：更新源可以被配置成任意地址，
 * 明文下载再校验 sha 也不是不行，但"先下明文再验"没有意义 ——
 * 攻击者能改包就能改清单里的 sha。https 是底线。
 */
export async function downloadPackage({ url, fetchImpl = globalThis.fetch, timeoutMs = 180_000 }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('更新包地址不是合法 URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('更新包只从 https 下载');

  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
    headers: { accept: 'application/gzip, application/octet-stream' },
  });
  if (!res?.ok) throw new Error(`下载更新包失败：HTTP ${res?.status ?? '?'}`);

  // fetch 会跟随重定向；起始地址是 https 不代表最终落点也是。
  // 只要落地不是 https，就按明文下载处理，直接拒绝。
  if (res.url) {
    let finalUrl;
    try {
      finalUrl = new URL(res.url);
    } catch {
      throw new Error('更新包下载的最终地址不可信');
    }
    if (finalUrl.protocol !== 'https:') {
      throw new Error('更新包下载被重定向到非 https 地址');
    }
  }

  const declared = Number(res.headers?.get?.('content-length') ?? 0);
  if (declared > MAX_PACKAGE_BYTES) throw new Error('更新包太大了（超过 100MB）');

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_PACKAGE_BYTES) throw new Error('更新包太大了（超过 100MB）');
  return buffer;
}

/** 把现有条目移动进备份目录（移动而不是复制：失败时也能原样移回） */
export function backupAndReplace({ root, staging, items = REPLACE_ITEMS, backupDir }) {
  mkdirSync(backupDir, { recursive: true });

  // 只记录真正动过的条目：回滚时绝不能碰"包里没有、本来也没动"的东西
  const touched = [];
  const rollback = () => {
    for (const item of touched.reverse()) {
      const current = join(root, item);
      const saved = join(backupDir, item);
      if (existsSync(current)) rmSync(current, { recursive: true, force: true });
      if (existsSync(saved)) renameSync(saved, current);
    }
  };

  for (const item of items) {
    const current = join(root, item);
    const saved = join(backupDir, item);
    const incoming = join(staging, item);
    if (!existsSync(incoming)) continue;

    const hadCurrent = existsSync(current);
    if (hadCurrent) {
      try {
        renameSync(current, saved);
      } catch (err) {
        rollback();
        throw new Error(`备份 ${item} 失败：${err?.message ?? err}`);
      }
    }

    touched.push(item);
    try {
      cpSync(incoming, current, { recursive: true });
    } catch (err) {
      rollback();
      throw new Error(`替换 ${item} 失败：${err?.message ?? err}`);
    }
  }

  // 依赖只增不减地合并：不删 node_modules 里用户自己装的东西。
  // 合并失败也要把代码回滚回去，否则进程下次启动就是"代码新了、依赖没跟上"。
  const incomingModules = join(staging, 'node_modules');
  if (existsSync(incomingModules)) {
    try {
      cpSync(incomingModules, join(root, 'node_modules'), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      rollback();
      throw new Error(`合并依赖失败：${err?.message ?? err}`);
    }
  }

  return touched;
}

/** 健康检查失败时整批还原 */
export function restoreBackup({ root, backupDir, items = REPLACE_ITEMS }) {
  for (const item of items) {
    const current = join(root, item);
    const saved = join(backupDir, item);
    if (existsSync(current)) rmSync(current, { recursive: true, force: true });
    if (existsSync(saved)) renameSync(saved, current);
  }
}

/** 失败后旧版本还躺在这里；保留最近两份方便人工排查 */
export function pruneBackups(backupsRoot, keep = 2) {
  if (!existsSync(backupsRoot)) return;
  const dirs = readdirSync(backupsRoot)
    .filter((name) => /^\d{8}-\d{6}$/.test(name))
    .filter((name) => {
      try {
        return statSync(join(backupsRoot, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  while (dirs.length > keep) {
    const name = dirs.shift();
    rmSync(join(backupsRoot, name), { recursive: true, force: true });
  }
}

/** 包解压后的顶层条目里，哪些是我们允许替换的 */
export function plannedItems(staging, items = REPLACE_ITEMS) {
  return items.filter((item) => existsSync(join(staging, item)));
}
