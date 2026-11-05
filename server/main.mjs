/**
 * 入口：把各层装起来，然后什么都不做（等信号）。
 *
 * 这个文件刻意保持很短 —— 二代 `index.mjs` 3775 行的教训是，
 * 一旦入口里开始写业务，它就会一直长下去。这里只允许出现"装配"和"退出"。
 *
 * 用法：
 *   npm start                      # 用上次记住的房间，演练模式
 *   npm start -- --room 12345      # 指定房间
 *   npm start -- --live            # 真实发送（会真的弹幕！）
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { App } from './app.mjs';
import { createHttpServer } from './http/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/* ────────────────────── 参数 ────────────────────── */

function parseArgs(argv) {
  const out = { room: undefined, port: 8900, dryRun: undefined, plugins: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--room') out.room = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--live') out.dryRun = false;
    else if (a === '--dry-run' || a === '--dryrun') out.dryRun = true;
    else if (a === '--no-plugins') out.plugins = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      console.error(`未知参数：${a}`);
      out.help = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`渔情LiveBot

  npm start                      用上次记住的房间（演练模式）
  npm start -- --room 12345      指定房间
  npm start -- --live            真实发送模式（会真的发弹幕）
  npm start -- --port 8900       换端口
  npm start -- --no-plugins      不加载插件，只看事件流
`);
  process.exit(0);
}

if (args.room !== undefined && !/^\d{1,12}$/.test(String(args.room))) {
  console.error(`房间号必须是纯数字：${args.room}`);
  process.exit(1);
}

if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
  console.error(`端口不合法：${args.port}`);
  process.exit(1);
}

/* ────────────────────── 日志 ────────────────────── */

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = {
  debug: (...a) => {
    if (process.env.YUYUE_DEBUG) console.log(stamp(), '[debug]', ...a);
  },
  info: (...a) => console.log(stamp(), ...a),
  warn: (...a) => console.warn(stamp(), '[warn]', ...a),
  error: (...a) => console.error(stamp(), '[error]', ...a),
};

/* ────────────────────── 启动 ────────────────────── */

const app = new App({
  dataDir: join(root, 'data'),
  roomId: args.room ?? '1901584685',
  dryRun: args.dryRun !== false,
  pluginsDir: args.plugins ? join(root, 'plugins') : null,
  log,
});

const started = await app.start({
  roomFromCli: args.room !== undefined,
  dryRunFromCli: args.dryRun !== undefined,
});

const server = createHttpServer({ app, webRoot: join(root, 'web'), port: args.port, log });

await new Promise((resolve, reject) => {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      reject(new Error(`端口 ${args.port} 已被占用，换一个：npm start -- --port 8901`));
    } else {
      reject(err);
    }
  });
  // 只绑 127.0.0.1：这是本机工具，不该出现在局域网上
  server.listen(args.port, '127.0.0.1', resolve);
});

/* ────────────────────── PID 文件 ────────────────────── */

/**
 * 写 PID 文件，给启停脚本用。
 *
 * 为什么需要：Windows 上没法按命令行找进程 —— `wmic` 在新版系统已经移除，
 * 而"按端口找 PID"漏掉两种情况：
 *   1. 进程起来了但还没绑定端口（启动中的几秒里点停止，会漏掉它）；
 *   2. 端口被别的程序先占了，自己退出了，但调用方只看到"端口有人"。
 * 有 PID 文件就能精确地结束"我启动的那一个进程"，而不是猜。
 *
 * 只在监听成功之后写：启动失败不该留下任何痕迹，否则下次停止会去杀一个
 * 早就死掉的号码，而那个号码可能已经被系统分给了别的进程。
 */
const PID_FILE = join(root, 'data', 'run.pid');

function dropPidFile() {
  try {
    const cur = readFileSync(PID_FILE, 'utf8').trim();
    // 只删自己写的：防止「旧的进程正在退出」把「新进程刚写的」删掉
    if (cur === String(process.pid)) unlinkSync(PID_FILE);
  } catch {
    /* 文件不在就算了，退出路径上不该再抛 */
  }
}

const brief = app.brief();
const pluginCount = brief?.plugins?.length ?? 0;

try {
  writeFileSync(PID_FILE, String(process.pid));
} catch (err) {
  // 写不进去只影响"能不能精确停止"，不影响服务本身，所以不中断启动
  log.warn(`PID 文件写不进去（不影响运行）：${err.message}`);
}
console.log('');
console.log(`  渔情LiveBot v${app.version}`);
console.log(`  房间   ${brief?.roomId ?? app.roomId}${brief?.title ? ` · ${brief.title}` : ''}`);
console.log(`  模式   ${brief?.dryRun ? '演练（不会真的发弹幕）' : '真实发送'}`);
console.log(`  插件   ${pluginCount} 个${args.plugins ? '' : '（已禁用）'}`);
console.log(`  页面   http://127.0.0.1:${args.port}`);
console.log('');
console.log('  Ctrl+C 退出');
console.log('');

/* ────────────────────── 退出 ────────────────────── */

let closing = false;

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${signal}，正在收尾…`);

  // 先停 HTTP，让页面立刻断开；再停房间，把日志文件关干净
  await new Promise((resolve) => server.close(resolve));
  await app.stop();

  dropPidFile();
  console.log('已退出');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 未捕获异常：先记下来再退出。静默退出会让人以为"程序自己没了"
process.on('uncaughtException', (err) => {
  log.error(`未捕获异常：${err?.stack ?? err}`);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  log.error(`未处理的 Promise 拒绝：${err?.stack ?? err}`);
});
