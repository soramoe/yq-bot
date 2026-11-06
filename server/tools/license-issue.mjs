/**
 * 签发离线授权文件（只给开发者用，不随产品分发）。
 *
 * 私钥来源，按优先级：
 *   1. 环境变量 LICENSE_PRIVATE_KEY（PEM 文本）
 *   2. 环境变量 LICENSE_PRIVATE_KEY_FILE（PEM 文件路径）
 *   3. ~/.yuqing/license-private.pem
 *
 * 例：
 *   node server/tools/license-issue.mjs --uid 1970515035 --machine a1b2c3 \
 *     --customer 某某 --edition personal --days 0 --updates-days 365 \
 *     --max-rooms 1 --out license.json
 */
import { createPrivateKey, sign as signPayload } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, licensePayload, LICENSE_PRODUCT } from '../core/license.mjs';

const DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 36_500;

/** 签发台/命令行共用的输入校验，返回整理好的参数。 */
export function validateSignRequest(body = {}) {
  const machine = String(body.machine ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(machine)) throw new Error('机器码要是 64 位十六进制（页面上复制完整的那一串）');

  const rawUid = String(body.uid ?? '').trim();
  if (rawUid && !/^\d{1,20}$/.test(rawUid)) throw new Error('uid 只能填数字，或者留空不绑账号');
  const uid = rawUid ? Number(rawUid) : 0;

  const customer = String(body.customer ?? '').trim();
  if (customer.length > 40) throw new Error('客户名最多 40 个字');

  const edition = String(body.edition ?? 'personal');
  if (!['personal', 'studio'].includes(edition)) throw new Error('版本只能是 personal 或 studio');

  const days = body.days === undefined || body.days === '' ? 0 : Number(body.days);
  if (!Number.isInteger(days) || days < 0 || days > MAX_DAYS) throw new Error('授权天数要是 0 到 36500 的整数（0 = 永久）');

  const updatesDays = body.updatesDays === undefined || body.updatesDays === '' ? 365 : Number(body.updatesDays);
  if (!Number.isInteger(updatesDays) || updatesDays < 0 || updatesDays > MAX_DAYS) throw new Error('更新期要是 0 到 36500 的整数（0 = 永久更新）');

  const maxRooms = body.maxRooms === undefined || body.maxRooms === '' ? 1 : Number(body.maxRooms);
  if (!Number.isInteger(maxRooms) || maxRooms < 1 || maxRooms > 50) throw new Error('房间数要是 1 到 50 的整数');

  let features = [];
  if (Array.isArray(body.features)) {
    features = body.features.map((f) => String(f).trim()).filter(Boolean).slice(0, 20);
  } else if (typeof body.features === 'string' && body.features.trim()) {
    features = body.features.split(',').map((f) => f.trim()).filter(Boolean).slice(0, 20);
  }

  return { machine, uid, customer, edition, days, updatesDays, maxRooms, features };
}

/** 默认位置：开发者本机，`license-keygen.mjs` 写的就是这里 */
export const DEFAULT_KEY_FILE = join(homedir(), '.yuqing', 'license-private.pem');

export function loadPrivateKey({ pem, file, env = process.env } = {}) {
  // 显式给的来源必须先于默认位置生效。
  // 早先这里收下了 `file`（即 `--key`）却从不读它，于是「指了 A 私钥、
  // 实际拿 ~/.yuqing 里那把 B 私钥签」会静默发生 —— 签出来的文件看着完全正常。
  if (pem) return createPrivateKey(pem);
  if (file) {
    if (!existsSync(file)) throw new Error(`私钥文件不存在：${file}`);
    return createPrivateKey(readFileSync(file, 'utf8'));
  }
  const text =
    env.LICENSE_PRIVATE_KEY ||
    (env.LICENSE_PRIVATE_KEY_FILE ? readFileSync(env.LICENSE_PRIVATE_KEY_FILE, 'utf8') : '') ||
    (existsSync(DEFAULT_KEY_FILE) ? readFileSync(DEFAULT_KEY_FILE, 'utf8') : '');
  if (!text) {
    throw new Error(
      `没有找到私钥：用 --key 指定，或设置 LICENSE_PRIVATE_KEY / LICENSE_PRIVATE_KEY_FILE，或放到 ${DEFAULT_KEY_FILE}`,
    );
  }
  return createPrivateKey(text);
}

/**
 * 组装并签名一份授权。纯函数，自检直接调。
 */
export function signLicense({
  privateKey,
  licenseId,
  customer = '',
  uid = 0,
  machine,
  edition = 'personal',
  maxRooms = 1,
  features = [],
  days = 0,
  updatesDays = 365,
  now = Date.now(),
}) {
  if (!machine) throw new Error('缺少 machine（机器码）');
  if (uid && !/^\d{1,20}$/.test(String(uid))) throw new Error('uid 不合法');
  const payload = licensePayload({
    v: 1,
    licenseId: licenseId ?? `YQ-${new Date(now).toISOString().slice(0, 10)}-${Math.random().toString(16).slice(2, 6)}`,
    product: LICENSE_PRODUCT,
    edition,
    customer: String(customer ?? '').trim(),
    uid: Number(uid) || 0,
    machine: String(machine),
    maxRooms: Math.max(1, Math.floor(Number(maxRooms) || 1)),
    features: Array.isArray(features) ? features.map(String) : [],
    issuedAt: now,
    updatesUntil: updatesDays > 0 ? now + updatesDays * DAY : 0,
    expiresAt: days > 0 ? now + days * DAY : 0,
    trial: false,
  });
  const signature = signPayload(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64');
  return { ...payload, signature };
}

function parseArgs(argv) {
  const out = { features: [], maxRooms: 1, days: 0, updatesDays: 365, edition: 'personal' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    const take = () => {
      i += 1;
      return value;
    };
    switch (key) {
      case '--uid': out.uid = Number(take()); break;
      case '--machine': out.machine = take(); break;
      case '--customer': out.customer = take(); break;
      case '--edition': out.edition = take(); break;
      case '--days': out.days = Number(take()); break;
      case '--updates-days': out.updatesDays = Number(take()); break;
      case '--max-rooms': out.maxRooms = Number(take()); break;
      case '--features': out.features = String(take() ?? '').split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--license-id': out.licenseId = take(); break;
      case '--out': out.out = take(); break;
      case '--key': out.keyFile = take(); break;
      default:
        if (key.startsWith('--')) throw new Error(`不认识的参数：${key}`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.machine) {
    console.error('用法：node server/tools/license-issue.mjs --machine <机器码> [--uid 123] [--days 365] [--key 私钥.pem] [--out license.json]');
    process.exit(2);
  }
  const privateKey = loadPrivateKey({ file: args.keyFile });
  const license = signLicense({ privateKey, ...args });
  const text = `${JSON.stringify(license, null, 2)}\n`;
  if (args.out) {
    writeFileSync(args.out, text, 'utf8');
    console.log(`已写入 ${args.out}`);
    console.log(`  机器码 ${args.machine}`);
    console.log(`  uid    ${license.uid || '不绑定'}`);
    console.log(`  功能    ${license.features.join(',') || '全部'}`);
    console.log(`  到期    ${license.expiresAt ? new Date(license.expiresAt).toLocaleString() : '永久'}`);
    console.log(`  更新期  ${license.updatesUntil ? new Date(license.updatesUntil).toLocaleDateString() : '永久'}`);
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`签发失败：${err.message}`);
    process.exit(1);
  });
}
