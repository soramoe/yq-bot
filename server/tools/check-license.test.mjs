import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalJson,
  evaluateLicense,
  licenseStatus,
  LICENSE_GRACE_MS,
  LICENSE_PUBLIC_KEY,
  machineCode,
  publicKeyObject,
  readLicenseFile,
} from '../core/license.mjs';
import { signLicense } from './license-issue.mjs';

const DAY = 24 * 60 * 60 * 1000;

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

function grant(keys, over = {}) {
  return signLicense({
    privateKey: keys.privateKey,
    machine: 'machine-a',
    uid: 100,
    publicKey: keys.publicKey,
    customer: '测试',
    days: 30,
    updatesDays: 365,
    now: 1_800_000_000_000,
    ...over,
  });
}

test('授权：canonicalJson 按键排序，同一份内容签名字节稳定', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
  assert.equal(canonicalJson({ a: 1 }), canonicalJson({ a: 1 }));
});

test('授权：签出来的文件能验过，字段完整', () => {
  const keys = keypair();
  const lic = grant(keys);
  const r = evaluateLicense({
    license: lic,
    machine: 'machine-a',
    uid: 100,
    publicKey: keys.publicKey,
    now: 1_800_000_000_000,
    graceMs: LICENSE_GRACE_MS,
  });
  assert.equal(r.state, 'valid');
  assert.equal(r.canSpeak, true);
  assert.equal(r.canUpdate, true);
  assert.equal(r.payload.licenseId, lic.licenseId);
  assert.equal(r.payload.product, 'yuqing');
});

test('授权：改一个字段签名就失效', () => {
  const keys = keypair();
  const lic = grant(keys);
  const forged = { ...lic, customer: '别人' };
  const r = evaluateLicense({ license: forged, machine: 'machine-a', uid: 100, now: 1_800_000_000_000, publicKey: keys.publicKey });
  assert.equal(r.state, 'invalid');
  assert.match(r.reason, /签名/);
  assert.equal(r.canSpeak, false);
});

test('授权：机器码不匹配、uid 不匹配都拒绝', () => {
  const keys = keypair();
  const lic = grant(keys);
  const wrongMachine = evaluateLicense({ license: lic, machine: 'machine-b', uid: 100, now: 1_800_000_000_000, publicKey: keys.publicKey });
  assert.equal(wrongMachine.state, 'invalid');
  assert.match(wrongMachine.reason, /机器/);

  const wrongUid = evaluateLicense({ license: lic, machine: 'machine-a', uid: 200, now: 1_800_000_000_000, publicKey: keys.publicKey });
  assert.equal(wrongUid.state, 'invalid');
  assert.match(wrongUid.reason, /uid/);
});

test('授权：过期后宽限期内还能说话，宽限结束就只读', () => {
  const keys = keypair();
  const now = 1_800_000_000_000;
  const lic = grant(keys, { days: 1, now: now - 2 * DAY });
  const grace = evaluateLicense({ license: lic, machine: 'machine-a', uid: 100, now, publicKey: keys.publicKey });
  assert.equal(grace.state, 'grace');
  assert.equal(grace.canSpeak, true);
  assert.ok(grace.graceDays >= 1);

  const dead = evaluateLicense({ license: lic, machine: 'machine-a', uid: 100, now: now + 30 * DAY, publicKey: keys.publicKey });
  assert.equal(dead.state, 'expired');
  assert.equal(dead.canSpeak, false);
});

test('授权：更新期过了不影响直播，只挡更新', () => {
  const keys = keypair();
  const now = 1_800_000_000_000;
  const lic = grant(keys, { updatesDays: 1, now: now - 10 * DAY });
  const r = evaluateLicense({ license: lic, machine: 'machine-a', uid: 100, now, publicKey: keys.publicKey });
  assert.equal(r.canSpeak, true);
  assert.equal(r.canUpdate, false);
  assert.match(r.reason, /更新期/);
});

test('授权：没有文件、坏文件、产品不对都按未授权处理', () => {
  const missing = evaluateLicense({ license: null, machine: 'm', uid: 1, now: 1 });
  assert.equal(missing.state, 'missing');
  assert.equal(missing.canSpeak, false);

  const keys = keypair();
  const lic = grant(keys, { machine: 'm', uid: 0 });
  const wrongProduct = evaluateLicense({ license: { ...lic, product: 'other' }, machine: 'm', uid: 1, now: 1, publicKey: keys.publicKey });
  assert.equal(wrongProduct.state, 'invalid');

  const dir = mkdtempSync(join(tmpdir(), 'yq-lic-'));
  assert.equal(readLicenseFile(dir), null);
  writeFileSync(join(dir, 'license.json'), '{not json', 'utf8');
  assert.equal(readLicenseFile(dir), null);
});

test('授权：机器码由 MachineGuid 与安装 id 共同决定，安装 id 变了机器码就变', () => {
  const a = machineCode({ guid: 'guid', installId: 'id-1' });
  const b = machineCode({ guid: 'guid', installId: 'id-2' });
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(publicKeyObject(LICENSE_PUBLIC_KEY));
  assert.equal(machineCode({ guid: 'guid', installId: 'id-1' }), a);
});

test('授权：licenseStatus 从目录读文件并评估', () => {
  const keys = keypair();
  const dir = mkdtempSync(join(tmpdir(), 'yq-lic-'));
  const lic = grant(keys, { machine: 'machine-a', uid: 100 });
  writeFileSync(join(dir, 'license.json'), JSON.stringify(lic), 'utf8');
  const status = licenseStatus({ dataDir: dir, machine: 'machine-a', uid: 100, now: 1_800_000_000_000, publicKey: keys.publicKey });
  assert.equal(status.state, 'valid');
  assert.equal(status.payload.uid, 100);
});
