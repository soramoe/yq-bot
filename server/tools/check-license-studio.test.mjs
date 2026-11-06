import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStudioServer } from './license-studio.mjs';
import { loadPrivateKey } from './license-issue.mjs';
import { evaluateLicense } from '../core/license.mjs';

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

async function withServer(keys, fn) {
  const server = createStudioServer({ privateKey: keys.privateKey, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('签发台：页面能打开，带着机器码输入位置', async () => {
  const keys = keypair();
  await withServer(keys, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /授权签发台/);
    assert.match(html, /id="machine"/);
    assert.match(html, /api\/sign/);
  });
});

test('签发台：机器码不对直接拒绝，不会调签名', async () => {
  const keys = keypair();
  await withServer(keys, async (base) => {
    const res = await fetch(`${base}/api/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machine: 'abc', uid: '1' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /64 位/);
  });
});

test('签发台：机器码 + uid + 天数签出来的授权能验过', async () => {
  const keys = keypair();
  await withServer(keys, async (base) => {
    const res = await fetch(`${base}/api/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        machine: 'a'.repeat(64),
        uid: '1970515035',
        customer: '测试客户',
        edition: 'personal',
        days: 30,
        updatesDays: 365,
        maxRooms: 1,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.filename, /^license-.*\.json$/);
    const checked = evaluateLicense({
      license: body.license,
      machine: 'a'.repeat(64),
      uid: 1970515035,
      now: body.license.issuedAt + 1000,
      publicKey: keys.publicKey,
    });
    assert.equal(checked.state, 'valid');
    assert.equal(checked.canSpeak, true);
  });
});

test('签发台：授权天数超范围、版本不认识都要说人话', async () => {
  const keys = keypair();
  await withServer(keys, async (base) => {
    const tooLong = await fetch(`${base}/api/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machine: 'b'.repeat(64), days: 99999 }),
    });
    assert.equal(tooLong.status, 400);
    assert.match((await tooLong.json()).error, /36500/);

    const badEdition = await fetch(`${base}/api/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machine: 'b'.repeat(64), edition: 'vip' }),
    });
    assert.equal(badEdition.status, 400);
    assert.match((await badEdition.json()).error, /personal/);
  });
});

test('私钥：--key 给的路径必须真的被读到', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'yq-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = join(dir, 'explicit.pem');
  writeFileSync(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const loaded = loadPrivateKey({ file: pem, env: {} });
  assert.equal(loaded.asymmetricKeyType, 'ed25519');
  // 签一个字节再用这把钥匙对应的公钥验：验不过就说明加载的不是它
  const sig = sign(null, Buffer.from('x'), loaded);
  assert.ok(verify(null, Buffer.from('x'), publicKey, sig), '--key 加载到的必须是指定那把私钥');
});

test('私钥：--key 指向不存在的文件要当场报错，不许静默退回默认位置', () => {
  const missing = join(tmpdir(), 'yq-key-not-here-9f2a.pem');
  assert.throws(() => loadPrivateKey({ file: missing, env: {} }), /私钥文件不存在/);
});
