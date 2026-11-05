/**
 * OBS 直播挂件自检。
 *
 * 挂件没有按钮、没有人盯着看，错了也只能等主播发现「数字怎么不动」。
 * 所以把最容易错的两类东西钉住：
 *
 *   1. 口径：电池怎么换元、时长怎么进位、舰长/SC 的文案；
 *   2. 接线：页面里的 id、脚本引用、预缓存清单，少一个就是白屏或旧版本。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { SHELL_SEEDS } from '../../web/core/sw-policy.js'

const OVERLAY = new URL('../../web/overlay.js', import.meta.url)
const { applyOverlayOptions, clearsGifts, durationText, giftLine, moneyText, parseOverlayOptions } =
  await import(OVERLAY.href)

const webFile = (name) => readFileSync(new URL(`../../web/${name}`, import.meta.url), 'utf8')

test('挂件金额：10 电池 = 1 元，整数不带小数点', () => {
  assert.equal(moneyText(0), '¥0')
  assert.equal(moneyText(100), '¥10')
  assert.equal(moneyText(105), '¥10.5')
  assert.equal(moneyText(-5), '¥0')
  assert.equal(moneyText('250'), '¥25')
})

test('挂件时长：不足一小时不显示小时，超过一小时补零', () => {
  assert.equal(durationText(0), '00:00')
  assert.equal(durationText(65_000), '01:05')
  assert.equal(durationText(3_723_000), '1:02:03')
  assert.equal(durationText(-1), '00:00')
})

test('挂件礼物行：礼物带数量和金额', () => {
  const line = giftLine({
    type: 'GIFT',
    payload: { uname: '甲', giftName: '火箭', num: 2, battery: 200 },
  })
  assert.deepEqual(line, { who: '甲', what: '火箭 ×2', amount: '¥20', kind: 'gift' })
})

test('挂件礼物行：舰长区分开通与续费', () => {
  const renew = giftLine({
    type: 'GUARD_BUY',
    payload: { uname: '乙', guardLevel: 3, isRenew: true, battery: 1980 },
  })
  assert.deepEqual(renew, { who: '乙', what: '续费舰长', amount: '¥198', kind: 'guard' })

  const fresh = giftLine({
    type: 'GUARD_BUY',
    payload: { uname: '乙', guardLevel: 1, battery: 19_980 },
  })
  assert.equal(fresh.what, '开通总督')
})

test('挂件礼物行：SC 和匿名回落', () => {
  const sc = giftLine({
    type: 'SUPER_CHAT',
    payload: { uname: '', text: '你好', battery: 300 },
  })
  assert.deepEqual(sc, { who: '匿名', what: '醒目留言', amount: '¥30', kind: 'sc' })
})

test('挂件礼物行：非付费事件不进礼物列', () => {
  assert.equal(giftLine({ type: 'DANMAKU', payload: { text: '路过' } }), null)
  assert.equal(giftLine(null), null)
})

test('挂件开播清理：真开播清空上一场，启动校准的 synthetic 不清', () => {
  assert.equal(clearsGifts({ type: 'LIVE_START', payload: {} }), true)
  assert.equal(clearsGifts({ type: 'LIVE_START', payload: { synthetic: true } }), false)
  assert.equal(clearsGifts({ type: 'LIVE_START', payload: { inferred: true } }), true)
  assert.equal(clearsGifts({ type: 'LIVE_END', payload: {} }), false)
  assert.equal(clearsGifts(null), false)
})

test('挂件页面：该有的节点和脚本一个不少', () => {
  const html = webFile('overlay.html')
  for (const id of [
    'ov-dot',
    'ov-room',
    'ov-sub',
    'ov-danmaku',
    'ov-viewers',
    'ov-enter',
    'ov-gift',
    'ov-sc',
    'ov-paid',
    'ov-paid-list',
    'ov-gifts',
    'ov-gift-list',
    'ov-goal',
    'ov-goal-text',
    'ov-goal-fill',
    'ov-bigspend',
    'ov-offline',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`)
  }
  assert.match(html, /src="\/overlay\.js"/)
  assert.match(html, /href="\/overlay\.css"/)
})

test('挂件样式：透明底、不挡鼠标', () => {
  const css = webFile('overlay.css')
  assert.match(css, /background:\s*transparent/)
  assert.match(css, /pointer-events:\s*none/)
})

test('挂件脚本：连的是同源 WS，付费榜走日志接口', () => {
  const js = webFile('overlay.js')
  assert.match(js, /\/ws\?after=/)
  assert.match(js, /\/api\/patrons\?days=0&limit=5/)
  assert.match(js, /giftGoalBattery/, '目标进度条要读 brief 里的目标')
  assert.match(js, /ov-goal-fill/)
  assert.match(js, /export function moneyText/)
  assert.match(js, /export function durationText/)
  assert.match(js, /export function giftLine/)
})

test('挂件入口在 Service Worker 预缓存清单里', () => {
  assert.ok(SHELL_SEEDS.includes('/overlay.html'), 'SHELL_SEEDS 缺 /overlay.html')
})

test('挂件外观：非法参数回落默认，不白屏', () => {
  assert.deepEqual(parseOverlayOptions(''), { theme: 'default', scene: 'full', hide: [] })
  assert.deepEqual(parseOverlayOptions('?theme=nope&scene=wide&hide=xxx'), {
    theme: 'default',
    scene: 'full',
    hide: [],
  })
})

test('挂件外观：主题、场景、隐藏项都认', () => {
  const o = parseOverlayOptions('?theme=light&scene=compact&hide=gifts,paid,gifts')
  assert.equal(o.theme, 'light')
  assert.equal(o.scene, 'compact')
  assert.deepEqual(o.hide, ['gifts', 'paid'])
})

test('挂件外观：参数落到 document 和根节点上', () => {
  const attrs = {}
  const doc = {
    documentElement: { setAttribute: (k, v) => (attrs[k] = v) },
  }
  const classes = new Set()
  const root = {
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v
    },
    classList: { add: (c) => classes.add(c) },
  }
  applyOverlayOptions({ theme: 'warm', scene: 'minimal', hide: ['gift'] }, root, doc)
  assert.equal(attrs['data-theme'], 'warm')
  assert.equal(root.attrs['data-scene'], 'minimal')
})

test('挂件样式：主题变量与隐藏规则都在', () => {
  const css = webFile('overlay.css')
  assert.match(css, /html\[data-theme='light'\]/)
  assert.match(css, /html\[data-theme='warm'\]/)
  assert.match(css, /html\[data-theme='mono'\]/)
  assert.match(css, /\[data-scene='compact'\]/)
  assert.match(css, /ov-hide-gifts/)
})