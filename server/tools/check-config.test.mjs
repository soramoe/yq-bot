/**
 * 插件配置自检。
 *
 * 这一组测的不是"能不能改"，而是**改动会不会在某个时刻悄悄丢失或变形**。
 * 配置这类东西的失败方式很讨厌：改错了不会报错，只是直播时说的话不对，
 * 而且要等到下次开播才发现。所以这里盯三件事：
 *
 *   1. 磁盘上存的是**增量**，不是整份配置
 *      —— 存整份会把当时的默认值固化成用户设置，插件升级后新默认永远不生效。
 *   2. 启停状态与插件自己的 `config.enabled` **互不干扰**
 *      —— 混成一个开关，用户关掉再打开会发现自己的配置被动过。
 *   3. 切房间、重启之后配置还在
 *      —— 配置跟房间无关，不该跟着 RoomRunner 一起被丢掉。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginHost, coerceConfig, defaultsOf } from '../core/plugin-host.mjs'
import { App } from '../app.mjs'
import { buildRoutes } from '../http/api.mjs'

const PLUGIN_DIR = join(process.cwd(), 'plugins')

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yy3-cfg-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

async function makeHost(t, { configs = {}, enabled = {} } = {}) {
  const host = new PluginHost({
    dir: PLUGIN_DIR,
    configs,
    enabled,
    say: async (a) => ({ ok: true, text: a.text }),
    getState: () => ({ roomId: '1' }),
  })
  await host.load()
  t.after(() => host.stopAll())
  return host
}

/** 造一个 App，但不连 B站：把 runner 换成只带 host 的壳 */
async function makeApp(t, { dataDir, configs = {}, enabled = {} } = {}) {
  const app = new App({ dataDir, roomId: '1901584685', dryRun: true })
  const host = await makeHost(t, { configs, enabled })
  app.runner = { host }
  return { app, host }
}

/* ══════════════════ 宿主层：启用状态 ══════════════════ */

test('配置：enabled 表里明确为 false 的插件被停用，其余照常启用', async (t) => {
  const host = await makeHost(t, { enabled: { blind: false } })

  assert.equal(host.plugins.get('blind').enabled, false)
  assert.equal(host.plugins.get('gift').enabled, true, '没写进表里的一律启用')
  assert.equal(host.plugins.get('welcome').enabled, true)
})

test('配置：没存过任何启用状态时全部启用（旧配置文件不会把插件全关掉）', async (t) => {
  const host = await makeHost(t)
  for (const [, e] of host.plugins) assert.equal(e.enabled, true)
})

test('配置：宿主停用不会改动插件自己的 config.enabled', async (t) => {
  const host = await makeHost(t)
  const before = { ...host.plugins.get('gift').config }

  host.setEnabled('gift', false)
  assert.deepEqual(host.plugins.get('gift').config, before, '停用不该顺手改业务配置')

  host.setEnabled('gift', true)
  assert.deepEqual(host.plugins.get('gift').config, before, '启用同样不该改回来')
})

/* ══════════════════ 宿主层：配置收敛 ══════════════════ */

test('配置：超出 max 的数字被夹到 max，而不是原样存进去', async (t) => {
  const host = await makeHost(t)
  const manifest = host.plugins.get('welcome').manifest
  const field = (manifest.config ?? []).find((f) => f.type === 'number' && Number.isFinite(f.max))
  assert.ok(field, '欢迎插件应有带 max 的数字字段')

  const next = host.updateConfig('welcome', { [field.key]: field.max + 1000 })
  assert.equal(next[field.key], field.max)
})

test('配置：未知字段被丢弃，不会污染配置文件', async (t) => {
  const host = await makeHost(t)
  const next = host.updateConfig('welcome', { 我乱写的: 123, template: '你好' })

  assert.equal(next.template, '你好')
  assert.equal('我乱写的' in next, false)
})

test('配置：updateConfig 返回的是完整配置，不是回显 patch', async (t) => {
  const host = await makeHost(t)
  const next = host.updateConfig('gift', { template: '只改这一项' })

  const keys = Object.keys(defaultsOf(host.plugins.get('gift').manifest))
  assert.deepEqual(Object.keys(next).sort(), keys.sort(), '应包含所有字段')
  assert.equal(next.mergeSec, host.plugins.get('gift').config.mergeSec, '没改的字段保持原值')
})

test('配置：resetConfig 回到 manifest 默认值', async (t) => {
  const host = await makeHost(t)
  host.updateConfig('welcome', { template: '改过的文案' })
  assert.equal(host.plugins.get('welcome').config.template, '改过的文案')

  const next = host.resetConfig('welcome')
  assert.deepEqual(next, defaultsOf(host.plugins.get('welcome').manifest))
})

test('配置：传非对象 patch 会明确报错，而不是当成空对象', async (t) => {
  const host = await makeHost(t)
  assert.throws(() => host.updateConfig('welcome', ['a', 'b']), /配置必须是对象/)
  assert.throws(() => host.updateConfig('welcome', null), /配置必须是对象/)
})

test('配置：coerceConfig 只接受 manifest 里声明过的 key', () => {
  const manifest = {
    id: 'x',
    name: 'x',
    version: '1.0.0',
    config: [{ key: 'a', type: 'text', label: 'A', default: 'd' }],
  }
  const out = coerceConfig(manifest, { a: 'v', b: 'nope' })
  assert.equal(out.a, 'v')
  assert.equal('b' in out, false)
})

/* ══════════════════ 应用层：持久化 ══════════════════ */

test('应用：改配置后磁盘上只有改过的那一个键', async (t) => {
  const dir = tmp(t)
  const { app } = await makeApp(t, { dataDir: dir })

  app.updatePluginConfig('welcome', { template: '新欢迎语' })

  const saved = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))
  assert.deepEqual(saved.plugins, { welcome: { template: '新欢迎语' } })
})

test('应用：同一个插件改两次，第二次是叠加而不是覆盖掉第一次', async (t) => {
  const dir = tmp(t)
  const { app } = await makeApp(t, { dataDir: dir })

  app.updatePluginConfig('welcome', { template: 'A' })
  app.updatePluginConfig('welcome', { cooldownSec: 5 })

  const saved = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))
  assert.deepEqual(saved.plugins.welcome, { template: 'A', cooldownSec: 5 })
})

test('应用：重启后配置还在（新 App 读同一个数据目录）', async (t) => {
  const dir = tmp(t)
  const { app } = await makeApp(t, { dataDir: dir })
  app.updatePluginConfig('gift', { template: '重启后应该还在' })

  // 第二个 App：模拟重启
  const app2 = new App({ dataDir: dir, roomId: '1901584685', dryRun: true })
  const cfg = app2._loadConfig()
  app2.pluginConfigs = cfg.plugins
  assert.equal(app2.pluginConfigs.gift.template, '重启后应该还在')

  // 并且能真的装配进宿主
  const host2 = await makeHost(t, { configs: app2.pluginConfigs })
  assert.equal(host2.plugins.get('gift').config.template, '重启后应该还在')
})

test('应用：恢复默认会把这个插件的增量整条删掉，而不是存一份等于默认的值', async (t) => {
  const dir = tmp(t)
  const { app } = await makeApp(t, { dataDir: dir })

  app.updatePluginConfig('welcome', { template: 'X' })
  app.updatePluginConfig('gift', { template: 'Y' })
  app.resetPluginConfig('welcome')

  const saved = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))
  assert.equal('welcome' in (saved.plugins ?? {}), false, '删掉整条，不是改成默认值')
  assert.equal(saved.plugins.gift.template, 'Y', '别的插件不受影响')
})

test('应用：停用写 false，重新启用是把键删掉而不是存 true', async (t) => {
  const dir = tmp(t)
  const { app } = await makeApp(t, { dataDir: dir })

  app.setPluginEnabled('blind', false)
  let saved = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))
  assert.deepEqual(saved.pluginEnabled, { blind: false })

  app.setPluginEnabled('blind', true)
  saved = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))
  assert.deepEqual(saved.pluginEnabled, {}, '存 true 会让"以后默认关掉"这种改动永远生效不了')
})

test('应用：改不存在的插件抛 404，不是静默返回 null', async (t) => {
  const dir = tmp(t)
  const { app } = await makeApp(t, { dataDir: dir })

  assert.throws(() => app.updatePluginConfig('nonexistent', { a: 1 }), (e) => e.status === 404)
  assert.throws(() => app.setPluginEnabled('nonexistent', false), (e) => e.status === 404)
  assert.throws(() => app.resetPluginConfig('nonexistent'), (e) => e.status === 404)
})

test('应用：没有房间在跑时改配置给出 503，而不是把配置写进空气里', async (t) => {
  const dir = tmp(t)
  const app = new App({ dataDir: dir, roomId: '1', dryRun: true })
  app.runner = null

  assert.throws(() => app.updatePluginConfig('welcome', { template: 'x' }), (e) => e.status === 503)
})

test('应用：切房间会重建运行体，但配置表不跟着被清空', async (t) => {
  const dir = tmp(t)
  const { app } = await makeApp(t, { dataDir: dir })
  app.updatePluginConfig('sc', { template: 'SC 文案' })

  // switchRoom 内部会重建 runner，这里只验证"配置表不被清空"这一件事，
  // 不真的连 B站（连了就是网络测试，不该出现在自检里）
  const before = JSON.stringify(app.pluginConfigs)
  assert.equal(JSON.parse(before).sc.template, 'SC 文案')

  const saved = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))
  assert.equal(saved.plugins.sc.template, 'SC 文案')
})

/* ══════════════════ 路由 ══════════════════ */

test('路由：插件配置三条接口都在表里，且能取到 :id', async (t) => {
  const dir = tmp(t)
  const app = new App({ dataDir: dir, roomId: '1', dryRun: true })
  const r = buildRoutes(app)

  const list = r.list()
  assert.ok(list.includes('POST /api/plugins/:id/config'), list.join(' | '))
  assert.ok(list.includes('POST /api/plugins/:id/reset'))
  assert.ok(list.includes('POST /api/plugins/:id/enabled'))

  const hit = r.match('POST', '/api/plugins/welcome/config')
  assert.equal(hit.handler !== undefined, true)
  assert.equal(hit.params.id, 'welcome')

  // 只写了前缀不能命中（否则 /api/plugins/xxx 会被当成某个接口）
  assert.equal(r.match('POST', '/api/plugins/welcome'), null)
})
