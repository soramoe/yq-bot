/**
 * 一键更新的执行进程。
 *
 * 由 server 在确认更新后以 detached 方式拉起，职责：
 *   1. 等旧进程退出（运行中的文件在 Windows 上换不掉）
 *   2. 校验包 → 解压到临时目录
 *   3. 备份现有代码 → 替换 → 启动 → 健康检查
 *   4. 健康检查不过：还原备份、把旧版本重新拉起来
 *
 * 这个脚本不依赖 server 里的任何运行态；服务挂了也能单独跑。
 *
 * 用法：
 *   node server/tools/update-apply.mjs --root <安装目录> --archive <包>
 *     --sha256 <校验值> --pid <旧进程> --port 8900 --version 0.3.0
 */

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { extractTarGz } from '../core/release-tar.mjs';
import {
  MAX_PACKAGE_BYTES,
  backupAndReplace,
  packageProblem,
  plannedItems,
  pruneBackups,
  restoreBackup,
} from '../core/update-apply.mjs';

const args = process.argv.slice(2);
const opt = {
  root: '',
  archive: '',
  sha256: '',
  pid: 0,
  port: 8900,
  version: '',
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opt.root = String(args[++i] ?? '');
  else if (a === '--archive') opt.archive = String(args[++i] ?? '');
  else if (a === '--sha256') opt.sha256 = String(args[++i] ?? '');
  else if (a === '--pid') opt.pid = Number(args[++i] ?? 0);
  else if (a === '--port') opt.port = Number(args[++i] ?? 8900);
  else if (a === '--version') opt.version = String(args[++i] ?? '');
}

const root = opt.root;
const logFile = root ? join(root, 'data', 'update.log') : '';

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    if (logFile) {
      mkdirSync(join(root, 'data'), { recursive: true });
      appendFileSync(logFile, line + '\n');
    }
  } catch {
    /* 日志写不了也不能阻止更新 */
  }
}

function fail(message, code = 1) {
  log(`失败：${message}`);
  process.exit(code);
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function waitOldExit(pid, timeoutMs = 60_000) {
  const started = Date.now();
  while (alive(pid)) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function startServer() {
  const out = openSync(join(root, 'data', 'service.out.log'), 'a');
  const err = openSync(join(root, 'data', 'service.err.log'), 'a');
  const child = spawn(process.execPath, [join(root, 'server', 'main.mjs')], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  closeSync(out);
  closeSync(err);
  return child;
}

async function healthy(port, timeoutMs = 30_000) {
  const started = Date.now();
  const url = `http://127.0.0.1:${port}/api/status`;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json();
        if (data?.ok || data?.version) return true;
      }
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  if (!root || !opt.archive) return fail('参数不完整：需要 --root 和 --archive', 2);
  if (!opt.version || !/^v?\d+(\.\d+){0,3}$/i.test(opt.version)) return fail('版本号不合法', 2);
  if (!existsSync(opt.archive)) return fail(`找不到更新包：${opt.archive}`);

  log(`开始更新到 v${opt.version}（包：${opt.archive}）`);

  if (!(await waitOldExit(opt.pid))) {
    return fail('旧进程 60 秒内没有退出，放弃更新（没有改动任何文件）');
  }

  let buffer;
  try {
    buffer = readFileSync(opt.archive);
  } catch (err) {
    return fail(`读不到更新包：${err?.message ?? err}`);
  }
  if (buffer.length > MAX_PACKAGE_BYTES) return fail('更新包超过 100MB，拒绝安装');
  const problem = packageProblem(buffer, { sha256: opt.sha256 });
  if (problem) return fail(problem);

  const workRoot = join(root, 'data', 'updates');
  const staging = join(workRoot, `staging-${stamp()}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    mkdirSync(staging, { recursive: true });
    const { count } = extractTarGz(buffer, staging);
    log(`解压完成：${count} 个文件`);
  } catch (err) {
    return fail(`解压失败：${err?.message ?? err}`);
  }

  const items = plannedItems(staging);
  if (!items.length) return fail('更新包里没有可替换的文件（server/web/plugins 都不在）');
  log(`将替换：${items.join(', ')}`);

  const backupDir = join(root, 'data', 'backups', stamp());
  let touched = [];
  try {
    touched = backupAndReplace({ root, staging, items, backupDir });
    log(`已备份到 ${backupDir}`);
  } catch (err) {
    return fail(err?.message ?? String(err));
  }

  log('启动新版本…');
  let child = null;
  try {
    child = startServer();
  } catch (err) {
    log(`新版本启动失败：${err?.message ?? err}，开始回滚`);
    try {
      restoreBackup({ root, backupDir, items: touched });
    } catch (restoreErr) {
      log(`还原失败：${restoreErr?.message ?? restoreErr}，请手动从 ${backupDir} 恢复`);
      process.exit(1);
    }
    try {
      startServer();
    } catch (again) {
      log(`旧版本也起不来：${again?.message ?? again}`);
    }
    process.exit(1);
  }

  if (await healthy(opt.port)) {
    log(`更新成功：v${opt.version} 已在 ${opt.port} 端口运行`);
    pruneBackups(join(root, 'data', 'backups'), 2);
    rmSync(staging, { recursive: true, force: true });
    process.exit(0);
  }

  log('新版本健康检查失败，开始回滚');
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  try {
    restoreBackup({ root, backupDir, items: touched });
  } catch (err) {
    log(`还原失败：${err?.message ?? err}，请手动从 ${backupDir} 恢复`);
    process.exit(1);
  }
  log('代码已还原，重新启动旧版本…');
  try {
    startServer();
  } catch (err) {
    log(`旧版本起不来：${err?.message ?? err}，请手动执行启动脚本`);
    process.exit(1);
  }
  if (await healthy(opt.port)) log('回滚成功，旧版本已恢复');
  else log('回滚后旧版本也没起来，请手动执行启动脚本并查看 data/service.err.log');
  process.exit(1);
}

main().catch((err) => fail(`未捕获错误：${err?.message ?? err}`, 3));
