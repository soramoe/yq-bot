// 生成一对新的授权密钥。私钥写到 ~/.yuqing/license-private.pem，公钥打印出来。
// 已有私钥时默认拒绝覆盖，确认要换新密钥再跑 `--force`（旧密钥签的授权会全部失效）。
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(homedir(), '.yuqing');
const file = join(dir, 'license-private.pem');
const force = process.argv.includes('--force');

if (existsSync(file) && !force) {
  console.error(`私钥已存在：${file}`);
  console.error('换密钥会让旧授权全部失效。确认要换，再加 --force 重跑。');
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

console.log(`私钥：${file}`);
console.log('公钥 base64（填到 server/core/license.mjs 的 LICENSE_PUBLIC_KEY）：');
console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
console.log('');
console.log('记得：私钥不要进仓库、不要进 CI、不要放网盘同步目录。');
