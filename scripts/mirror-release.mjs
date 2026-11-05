#!/usr/bin/env node
/**
 * 把 GitHub Release 的更新包搬到镜像目录。
 *
 * 两种落点：
 *   --dir  <本地目录>     直接写文件（适合 nginx / Caddy 静态目录）
 *   --s3   <bucket>       S3 兼容对象存储（R2 / MinIO / AWS / OSS·COS 的 S3 接口）
 *
 * 镜像约定和程序里一致：`latest.json` + 同名更新包。
 * 只搬运，不改内容；sha256 / size 在下载后仍会校验。
 *
 * 例：
 *   node scripts/mirror-release.mjs --dir D:\mirror\yq --base https://mirror.example.com/yq
 *   node scripts/mirror-release.mjs --s3 yq-mirror --endpoint https://xxx.r2.cloudflarestorage.com --region auto
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;

/* ────────────────────────── 纯函数 ────────────────────────── */

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, text) {
  return createHmac('sha256', key).update(text).digest();
}

/** S3 要求 RFC3986：encodeURIComponent 不编码 !'()*，这里补上 */
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKeyPath(key) {
  return String(key)
    .split('/')
    .map(encodeRfc3986)
    .join('/');
}

/**
 * 生成 S3 兼容的 SigV4 PUT 请求。返回可直接 fetch 的 url/headers。
 *
 * @param {object} opts
 * @param {string} opts.endpoint 例如 https://acc.r2.cloudflarestorage.com
 * @param {string} opts.bucket
 * @param {string} opts.key 对象键（可含 /，会按段编码）
 * @param {Buffer|string} opts.body
 * @param {string} opts.accessKey
 * @param {string} opts.secretKey
 * @param {string} [opts.region] 默认 auto（R2 用 auto，AWS 用具体区域）
 * @param {string} [opts.contentType]
 * @param {Date} [opts.now] 自检固定时间用
 */
export function signS3Put({
  endpoint,
  bucket,
  key,
  body,
  accessKey,
  secretKey,
  region = 'auto',
  contentType = 'application/octet-stream',
  now = new Date(),
}) {
  if (!endpoint) throw new Error('缺少 endpoint');
  if (!bucket) throw new Error('缺少 bucket');
  if (!key) throw new Error('缺少对象键');
  if (!accessKey || !secretKey) throw new Error('缺少 S3 access key / secret key');

  const base = String(endpoint).trim().replace(/\/+$/, '');
  const u = new URL(base);
  const host = u.host;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const payloadHash = sha256Hex(buf);

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const date = amzDate.slice(0, 8);
  const canonicalUri = `/${encodeRfc3986(bucket)}/${encodeKeyPath(key)}`;

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    url: `${base}${canonicalUri}`,
    headers: {
      'content-type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: buf,
  };
}

/** 把旧包按修改时间从新到旧排，保留前 keep 个（至少保留当前这个） */
export function pickKeep(files, keep) {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sorted.slice(0, Math.max(1, Math.floor(keep)));
}

/** 从清单校验出要下载的包信息（和客户端同口径） */
export function packageFromManifest(manifest) {
  const version = String(manifest?.version ?? '').replace(/^v/i, '');
  if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error('清单里的 version 不合法');
  const download = String(manifest?.download ?? '').trim();
  if (!download) throw new Error('清单没有 download 字段');
  const sha256 = String(manifest?.sha256 ?? '').trim().toLowerCase();
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('清单里的 sha256 不是 64 位十六进制');
  const size = Number(manifest?.size ?? 0);
  if (!Number.isInteger(size) || size <= 0) throw new Error('清单里的 size 不合法');
  if (size > MAX_PACKAGE_BYTES) throw new Error('更新包超过 100MB');

  let name = '';
  try {
    name = new URL(download).pathname.split('/').pop() ?? '';
  } catch {
    throw new Error('清单里的 download 不是合法 URL');
  }
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('更新包文件名不合法');
  return { version, download, sha256, size, name };
}

/* ────────────────────────── 抓取 / 落盘 ────────────────────────── */

async function fetchBuffer(url, { fetchImpl = globalThis.fetch, timeoutMs = 180_000, allowHttp = false } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new Error(`只从 https 下载：${url}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!res?.ok) throw new Error(`请求失败：HTTP ${res?.status ?? '?'}（${url}）`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉清单 + 包，校验后写进本地镜像目录。
 * 返回 { manifest, version, name, mirrorUrl, dir }。
 */
export async function publishToDir({
  manifestUrl,
  dir,
  base = '',
  keep = 5,
  fetchImpl = globalThis.fetch,
  allowHttp = false,
  log = (m) => console.log(m),
} = {}) {
  if (!manifestUrl) throw new Error('缺少清单地址（--manifest）');
  if (!dir) throw new Error('缺少目录（--dir）');

  log(`[1/4] 读清单：${manifestUrl}`);
  const raw = await fetchBuffer(manifestUrl, { fetchImpl, allowHttp, timeoutMs: 30_000 });
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('清单不是合法 JSON');
  }
  const pkg = packageFromManifest(manifest);

  log(`[2/4] 下载 v${pkg.version}：${pkg.download}`);
  const body = await fetchBuffer(pkg.download, { fetchImpl, allowHttp });
  if (body.length !== pkg.size) throw new Error(`包大小不对：拿到 ${body.length}，清单写 ${pkg.size}`);
  if (pkg.sha256 && sha256Hex(body) !== pkg.sha256) throw new Error('sha256 对不上，包可能下坏了');

  const root = resolve(dir);
  mkdirSync(root, { recursive: true });

  log(`[3/4] 写入 ${root}`);
  const tmpPkg = join(root, `${pkg.name}.tmp`);
  writeFileSync(tmpPkg, body);
  renameSync(tmpPkg, join(root, pkg.name));
  // latest.json 最后换：换的时候包一定已经就位
  const tmpLatest = join(root, 'latest.json.tmp');
  writeFileSync(tmpLatest, raw);
  renameSync(tmpLatest, join(root, 'latest.json'));

  log(`[4/4] 清理旧包（保留 ${keep} 个）`);
  const packs = readdirSync(root)
    .filter((n) => /^yuyue3-.*\.tar\.gz$/i.test(n))
    .map((n) => ({ name: n, mtimeMs: statSync(join(root, n)).mtimeMs }));
  const keepSet = new Set(pickKeep(packs, keep).map((f) => f.name));
  for (const f of packs) {
    if (!keepSet.has(f.name)) {
      rmSync(join(root, f.name), { force: true });
      log(`       删掉旧包 ${f.name}`);
    }
  }

  const mirrorUrl = `${String(base).replace(/\/+$/, '')}/latest.json`;
  log(`完成：${pkg.name}`);
  if (base) log(`镜像地址：${String(base).replace(/\/+$/, '')}`);
  return { manifest, version: pkg.version, name: pkg.name, dir: root, mirrorUrl };
}

/** 上传到 S3 兼容存储 */
export async function publishToS3({
  manifestUrl,
  bucket,
  endpoint,
  region = 'auto',
  prefix = '',
  accessKey,
  secretKey,
  fetchImpl = globalThis.fetch,
  log = (m) => console.log(m),
  allowHttp = false,
} = {}) {
  if (!manifestUrl) throw new Error('缺少清单地址（--manifest）');
  if (!bucket) throw new Error('缺少 bucket（--s3）');
  if (!endpoint) throw new Error('缺少 endpoint（--endpoint）');

  log(`[1/3] 读清单：${manifestUrl}`);
  const raw = await fetchBuffer(manifestUrl, { fetchImpl, allowHttp, timeoutMs: 30_000 });
  const manifest = JSON.parse(raw.toString('utf8'));
  const pkg = packageFromManifest(manifest);

  log(`[2/3] 下载 v${pkg.version}：${pkg.download}`);
  const body = await fetchBuffer(pkg.download, { fetchImpl, allowHttp });
  if (body.length !== pkg.size) throw new Error(`包大小不对：拿到 ${body.length}，清单写 ${pkg.size}`);
  if (pkg.sha256 && sha256Hex(body) !== pkg.sha256) throw new Error('sha256 对不上，包可能下坏了');

  const keyOf = (name) => [prefix.replace(/^\/+|\/+$/g, ''), name].filter(Boolean).join('/');

  log(`[3/3] 上传 ${bucket}/${keyOf(pkg.name)}`);
  for (const [name, bytes, type] of [
    [pkg.name, body, 'application/gzip'],
    ['latest.json', raw, 'application/json'],
  ]) {
    const req = signS3Put({
      endpoint,
      bucket,
      key: keyOf(name),
      body: bytes,
      accessKey,
      secretKey,
      region,
      contentType: type,
    });
    const res = await fetchImpl(req.url, { method: 'PUT', headers: req.headers, body: req.body });
    if (!res?.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error(`上传 ${name} 失败：HTTP ${res?.status ?? '?'} ${detail}`);
    }
    log(`       ${name} ✓`);
  }

  return { manifest, version: pkg.version, name: pkg.name, key: keyOf(pkg.name) };
}

/* ────────────────────────── CLI ────────────────────────── */

function argOf(name, fallback = '') {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? String(argv[i + 1] ?? '') : fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function defaultManifest() {
  try {
    const cfg = JSON.parse(readFileSync('data/app.json', 'utf8'));
    return String(cfg.updateUrl ?? '');
  } catch {
    return '';
  }
}

function usage() {
  console.log(`用法：
  node scripts/mirror-release.mjs --dir <目录> [选项]
  node scripts/mirror-release.mjs --s3 <bucket> --endpoint <S3 地址> [选项]

选项：
  --manifest <url>   更新清单地址；默认读 data/app.json 的 updateUrl
  --dir <路径>       本地镜像目录（nginx / Caddy 的静态目录）
  --s3 <bucket>      S3 兼容桶名
  --endpoint <url>   S3 endpoint（R2: https://<账号>.r2.cloudflarestorage.com）
  --region <region>  S3 区域，默认 auto
  --prefix <path>    对象键前缀（例如 yq）
  --base <url>       镜像的公开地址，只用于打印提示
  --keep <n>         本地保留几个旧包，默认 5
  --dry-run          只检查，不写不传
  --allow-http       允许 http 源（只用于本地自检，别对公网用）

环境变量：S3_ACCESS_KEY / S3_SECRET_KEY`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag('help') || argv.length === 0) return usage();

  const manifestUrl = argOf('manifest') || defaultManifest();
  const dir = argOf('dir');
  const bucket = argOf('s3');
  const endpoint = argOf('endpoint');
  const region = argOf('region', 'auto');
  const prefix = argOf('prefix');
  const base = argOf('base');
  const keep = Number(argOf('keep', '5')) || 5;
  const allowHttp = hasFlag('allow-http');

  if (!manifestUrl) {
    console.error('没有清单地址：用 --manifest 指定，或在 data/app.json 里配 updateUrl');
    process.exitCode = 2;
    return;
  }
  if (!dir && !bucket) {
    console.error('要么 --dir <目录>，要么 --s3 <bucket> --endpoint <url>');
    process.exitCode = 2;
    return;
  }

  if (hasFlag('dry-run')) {
    const raw = await fetchBuffer(manifestUrl, { allowHttp });
    const pkg = packageFromManifest(JSON.parse(raw.toString('utf8')));
    console.log(`[dry-run] 会发布 v${pkg.version} / ${pkg.name} / ${pkg.size} 字节`);
    return;
  }

  if (dir) {
    const r = await publishToDir({ manifestUrl, dir, base, keep, allowHttp });
    if (base) console.log(`\n把维护页「更新镜像」填成：${base.replace(/\/+$/, '')}`);
    else console.log(`\n把 ${r.dir} 交给静态服务器后，镜像地址填那个 https 目录`);
    return;
  }

  const accessKey = process.env.S3_ACCESS_KEY ?? '';
  const secretKey = process.env.S3_SECRET_KEY ?? '';
  if (!accessKey || !secretKey) {
    console.error('缺少 S3_ACCESS_KEY / S3_SECRET_KEY 环境变量');
    process.exitCode = 2;
    return;
  }
  await publishToS3({ manifestUrl, bucket, endpoint, region, prefix, accessKey, secretKey, allowHttp });
  console.log('\n把维护页「更新镜像」填成桶/前缀对应的 https 地址');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`失败：${err.message}`);
    process.exitCode = 1;
  });
}
