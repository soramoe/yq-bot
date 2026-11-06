/**
 * 离线授权：Ed25519 签名 + 机器码 + B 站 uid 绑定。
 *
 * 设计原则：**只做能解释清楚的检查**。
 * 签名不对、机器码不对、uid 不对、过期 —— 每种都能在页面上说清原因，
 * 而不是只显示一个"未授权"。用户看不懂的授权，最后都会变成客服工单。
 */
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, platform } from 'node:os';

export const LICENSE_PRODUCT = 'yuqing';

/** 过期后的宽限：还能说话，但页面会一直提示 */
export const LICENSE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** 没有授权文件时的试用天数 */
export const TRIAL_DAYS = 7;

/**
 * 内置公钥（Ed25519 SPKI DER，base64）。
 * 私钥在开发者自己手里，不进仓库、不进安装包。
 */
export const LICENSE_PUBLIC_KEY =
  'MCowBQYDK2VwAyEArnv4afncr4A/u8Vy5sTAWCfMEaLF+OmxRVL70yhzlxU=';

/** 参与签名的字段。顺序不重要，canonicalJson 会排序 */
export const LICENSE_FIELDS = Object.freeze([
  'v',
  'licenseId',
  'product',
  'edition',
  'customer',
  'uid',
  'machine',
  'maxRooms',
  'features',
  'issuedAt',
  'updatesUntil',
  'expiresAt',
  'trial',
]);

/** 稳定序列化：递归按键名排序，签出来的字节才可复现 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 只保留授权字段，防止往签名里塞别的东西 */
export function licensePayload(input) {
  const out = {};
  for (const key of LICENSE_FIELDS) out[key] = input?.[key] ?? null;
  return out;
}

export function publicKeyObject(base64 = LICENSE_PUBLIC_KEY) {
  return createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
}

export function verifyLicenseSignature(payload, signature, { publicKey = LICENSE_PUBLIC_KEY } = {}) {
  try {
    if (typeof signature !== 'string' || !signature) return false;
    const data = Buffer.from(canonicalJson(licensePayload(payload)), 'utf8');
    return verifySignature(null, data, publicKeyObject(publicKey), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** Windows MachineGuid；拿不到时退回主机名，至少不会全员同码 */
export function machineGuid() {
  if (platform() === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{16,})/);
      if (m) return m[1].toLowerCase();
    } catch {
      // 下面统一退回主机名
    }
  }
  return `${hostname()}-${platform()}`;
}

/** 每个安装目录一份；删了 data/ 就换码 —— 这正是我们想要的"拷走没用" */
export function ensureInstallId(dataDir) {
  const file = join(dataDir, 'install-id');
  try {
    const id = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{16,64}$/i.test(id)) return id.toLowerCase();
  } catch {
    // 没有就生成
  }
  const id = randomBytes(16).toString('hex');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, id, 'utf8');
  } catch {
    // 写不进去也要能返回一个值，下次启动会再生成
  }
  return id;
}

/** 机器码 = sha256(MachineGuid|installId)，页面上显示前 24 位 */
export function machineCode({ guid = machineGuid(), installId }) {
  return createHash('sha256').update(`${guid}|${installId}`).digest('hex');
}

export function shortMachineCode(code) {
  return String(code ?? '').slice(0, 24);
}

/** 读 data/license.json；坏文件返回 null，不抛 */
export function readLicenseFile(dataDir) {
  const file = join(dataDir, 'license.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 评估一份已经解析出来的 license。
 *
 * @returns {{state:string,reason:string,canSpeak:boolean,canUpdate:boolean,payload:object|null,graceDays:number}}
 */
export function evaluateLicense({ license, machine, uid, now = Date.now(), graceMs = LICENSE_GRACE_MS, publicKey = LICENSE_PUBLIC_KEY } = {}) {
  const fail = (state, reason, extra = {}) => ({
    state,
    reason,
    canSpeak: false,
    canUpdate: false,
    payload: null,
    graceDays: 0,
    ...extra,
  });

  if (!license || typeof license !== 'object') return fail('missing', '没有找到授权文件');
  if (license.product !== LICENSE_PRODUCT) return fail('invalid', '授权文件不是给这个产品的');

  const payload = licensePayload(license);
  if (!verifyLicenseSignature(payload, license.signature, { publicKey })) {
    return fail('invalid', '授权文件的签名不对，可能被改过');
  }
  if (String(payload.machine ?? '') !== String(machine ?? '')) {
    return fail('invalid', '授权文件和这台机器不匹配');
  }
  const boundUid = Number(payload.uid) || 0;
  const currentUid = Number(uid) || 0;
  if (boundUid > 0 && currentUid > 0 && boundUid !== currentUid) {
    return fail('invalid', `授权绑定的是 uid ${boundUid}，当前登录的是 ${currentUid}`);
  }

  const times = {
    issuedAt: Number(payload.issuedAt) || 0,
    updatesUntil: Number(payload.updatesUntil) || 0,
    expiresAt: Number(payload.expiresAt) || 0,
  };

  let canSpeak = true;
  let state = 'valid';
  let reason = '';
  let graceDays = 0;

  if (times.expiresAt > 0) {
    const left = times.expiresAt - now;
    if (left <= -graceMs) {
      return fail('expired', '授权已过期，程序进入只读模式', { payload, graceDays: 0 });
    }
    if (left <= 0) {
      state = 'grace';
      graceDays = Math.max(1, Math.ceil((graceMs - Math.abs(left)) / 86400000));
      reason = `授权已过期，还剩 ${graceDays} 天宽限，之后只能看不能发`;
    }
  }

  const canUpdate = times.updatesUntil <= 0 || now <= times.updatesUntil;
  if (!canUpdate && !reason) reason = '更新期已过，当前版本可以继续用，但检查/安装新版本会被拒绝';

  return { state, reason, canSpeak, canUpdate, payload, graceDays, times };
}

export function licenseStateLabel(state) {
  switch (state) {
    case 'valid': return '已授权';
    case 'trial': return '试用中';
    case 'grace': return '宽限期（还能播，尽快续费）';
    case 'expired': return '已过期（只读）';
    case 'missing': return '未授权';
    default: return '授权无效';
  }
}

/**
 * 没有授权文件时的 7 天试用。
 *
 * 试用期从第一次启动评估开始算，存 data/trial.json。删掉这个文件可以重置，
 * 客户端授权本来只能做到"提高门槛"，真正的约束在更新与售后。
 */
export function trialStatus({ dataDir, now = Date.now() } = {}) {
  const file = join(dataDir, 'trial.json');
  let startedAt = 0;
  try {
    startedAt = Number(JSON.parse(readFileSync(file, 'utf8')).startedAt) || 0;
  } catch {
    startedAt = 0;
  }
  if (!startedAt) {
    startedAt = now;
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ startedAt }, null, 2), 'utf8');
    } catch {
      // 写不进去就按"刚开始"算这一次，下次再说
    }
  }
  const left = startedAt + TRIAL_DAYS * 86400000 - now;
  if (left <= 0) {
    return {
      state: 'expired',
      reason: '试用已结束，导入授权文件后恢复；现在只能看，不能发言',
      canSpeak: false,
      canUpdate: true,
      payload: null,
      graceDays: 0,
    };
  }
  return {
    state: 'trial',
    reason: `试用还剩 ${Math.ceil(left / 86400000)} 天，导入授权文件后不再倒计时`,
    canSpeak: true,
    canUpdate: true,
    payload: null,
    graceDays: 0,
  };
}

/** 一次性把文件读出来并评估，App 启动时用 */
export function licenseStatus({ dataDir, machine, uid, now = Date.now(), publicKey = LICENSE_PUBLIC_KEY } = {}) {
  return evaluateLicense({ license: readLicenseFile(dataDir), machine, uid, now, publicKey });
}
