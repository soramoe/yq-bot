/**
 * 本地签发台：双击「签发授权.bat」后打开一个只监听本机的网页，
 * 填机器码/uid/天数就能生成 license.json。
 *
 * 为什么单独起一个进程，而不是塞进机器人：
 *   - 私钥只在开发者机器上，签发是离线动作，和直播进程无关；
 *   - 机器人服务是常驻的，签发台用完就该关掉，减少私钥被顺手点开的机会。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadPrivateKey, signLicense, validateSignRequest } from './license-issue.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, 'license-studio.html');
const DEFAULT_PORT = 8910;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function openBrowser(url) {
  if (process.platform !== 'win32') return;
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // 打不开就自己复制地址
  }
}

function filenameOf(req) {
  const raw = String(req.customer || '').trim() || (req.uid ? String(req.uid) : 'customer');
  const who = raw.replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'customer';
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `license-${who}-${day}.json`;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('请求太大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createStudioServer({ privateKey, port = DEFAULT_PORT } = {}) {
  let key = privateKey;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        send(res, 200, readFileSync(PAGE), 'text/html; charset=utf-8');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sign') {
        const body = await readJson(req);
        const input = validateSignRequest(body);
        key = key ?? loadPrivateKey();
        const license = signLicense({ privateKey: key, ...input });
        send(res, 200, JSON.stringify({
          ok: true,
          filename: filenameOf(input),
          license,
          summary: {
            machine: license.machine,
            uid: license.uid,
            customer: license.customer,
            edition: license.edition,
            maxRooms: license.maxRooms,
            expiresAt: license.expiresAt,
            updatesUntil: license.updatesUntil,
          },
        }));
        return;
      }
      send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
    } catch (err) {
      send(res, 400, JSON.stringify({ ok: false, error: err.message || String(err) }));
    }
  });
  return server;
}

async function main() {
  const argPort = process.argv.find((a) => a.startsWith('--port='));
  const port = argPort ? Number(argPort.slice(7)) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口不合法');

  const server = createStudioServer({ port });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`签发台已启动：${url}`);
    console.log('只监听本机；签完关掉窗口即可。');
    openBrowser(url);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`签发台启动失败：${err.message}`);
    process.exit(1);
  });
}
