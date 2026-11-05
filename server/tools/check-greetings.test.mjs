/**
 * 招呼文案预设自检（只服务「自动打招呼」）。
 *
 * 预设不是"几段好看的文字"，它要同时满足三个硬约束：
 *   1. 长度可控：B站 普通弹幕上限 20 字。句子里一旦带 {用户}，昵称长度不可控，
 *      整句就可能超限被静默截断 —— 所以预设一律不写名字。
 *   2. 不与结构化 @ 重复写名字：文案里出现 @ 会变成「@小明 你好呀 小明」。
 *   3. **不漂移**：manifest 的 templates 默认值、设置页下拉、这里的断言
 *      必须都指向 greetings.js，不能各抄一份常量（靠人同步迟早会漂）。
 *
 * 手动点名（D63）已整体移除，这个文件不再测任何点名链路；
 * 侧栏没有面板这件事由 check-web 盯住。
 *
 * 关键断言配了反向验证：把一句改超长、改掉 manifest 标记、去掉前端引用，
 * 对应用例必须变红，确认不是碰巧通过。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  GREETING_PACKS,
  DEFAULT_PACK_ID,
  findPack,
  matchPack,
} from '../../web/core/greetings.js'
import { MAX_TEXT, prepareText } from '../bili/send.mjs'
import { render } from '../core/template.mjs'
import { nextGreeting } from '../../plugins/autocall/plugin.mjs'

const ROOT = process.cwd()
const src = (p) => readFileSync(join(ROOT, p), 'utf8')
const manifest = () => JSON.parse(src('plugins/autocall/manifest.json'))
const templatesField = () => manifest().config.find((f) => f.key === 'templates')

/* ══════════════════ 文案包本身 ══════════════════ */

test('预设：文案包结构完整，id 不重复', () => {
  assert.ok(GREETING_PACKS.length >= 4, '至少要有几套风格可选')
  const ids = new Set()
  for (const p of GREETING_PACKS) {
    assert.match(p.id, /^[a-z][a-z0-9-]{1,20}$/, `${p.id} 不是合法的预设 id`)
    assert.equal(ids.has(p.id), false, `预设 id 重复：${p.id}`)
    ids.add(p.id)
    assert.ok(p.name && p.desc, `${p.id} 缺名字或说明`)
    assert.ok(Array.isArray(p.lines) && p.lines.length >= 3, `${p.id} 至少 3 句`)
  }
})

test('预设：每句都不超弹幕上限、不写 @、不带 {用户}、无控制字符', () => {
  for (const p of GREETING_PACKS) {
    for (const line of p.lines) {
      assert.equal(typeof line, 'string')
      assert.equal(line, line.trim(), `${p.id}: 文案首尾不该有空格「${line}」`)
      assert.ok(line.length > 0)
      assert.ok(
        Array.from(line).length <= MAX_TEXT,
        `${p.id}: 「${line}」${Array.from(line).length} 字，超过弹幕上限 ${MAX_TEXT}`,
      )
      assert.equal(line.includes('@'), false, `${p.id}: 文案里不该写 @`)
      assert.equal(line.includes('{用户}'), false, `${p.id}: 预设不写名字，昵称长度不可控`)
      assert.doesNotMatch(line, /[\r\n\t\u0000-\u001f]/, `${p.id}: 不能有换行或控制字符`)
      // 真的走一遍发送前的截断检查，而不是只算长度
      assert.equal(prepareText(line, { max: MAX_TEXT }).truncated, false)
    }
  }
})

test('预设：句子都控制在 10 字内，给自定义文案留余量', () => {
  // 预设只是"出厂款"，用户完全可能在前后加点字。留足一半上限，
  // 改文案包时不至于一句就吃满 20 字。
  for (const p of GREETING_PACKS) {
    for (const line of p.lines) {
      assert.ok(
        Array.from(line).length <= 10,
        `${p.id}: 「${line}」${Array.from(line).length} 字，预设不该超过 10 字`,
      )
    }
  }
})

test('预设：默认 id 有效，未知 id 一律返回 null', () => {
  assert.ok(findPack(DEFAULT_PACK_ID), 'DEFAULT_PACK_ID 必须指向真实文案包')
  assert.equal(findPack('__nope__'), null)
})

test('预设：matchPack 只认完全一致，改过一句就是自定义', () => {
  const p = findPack(DEFAULT_PACK_ID)
  assert.equal(matchPack(p.lines), p)
  assert.equal(matchPack([...p.lines].reverse()), null, '顺序也算')
  assert.equal(matchPack(p.lines.slice(0, -1)), null, '少一句不算')
  const edited = [...p.lines]
  edited[0] = edited[0] + '！'
  assert.equal(matchPack(edited), null)
  assert.equal(matchPack([]), null)
  assert.equal(matchPack(null), null)
  // 前后空行 / 空格不影响判定（lines 控件会 trim + 丢空行）
  assert.equal(matchPack(['', ...p.lines.map((x) => `  ${x}  `), '']), p)
  // 每一套都能被反查出来，设置页才能正确显示"当前预设"
  for (const pack of GREETING_PACKS) assert.equal(matchPack(pack.lines), pack)
})

/* ══════════════════ 不漂移 ══════════════════ */

test('预设：manifest 默认文案 == 默认预设包，且带 presets 标记', () => {
  const f = templatesField()
  assert.equal(f.type, 'lines')
  assert.equal(f.presets, 'greetings', '设置页靠这个标记渲染「套用预设」下拉')
  assert.deepEqual(f.default, findPack(DEFAULT_PACK_ID).lines)
  assert.match(f.hint, /预设/)
})

test('预设：自检与设置页读同一份 URL，模块实例相同', async () => {
  const again = await import('../../web/core/greetings.js')
  assert.equal(again.GREETING_PACKS, GREETING_PACKS, '同一 URL 必须命中 ESM 缓存')
  assert.equal(again.DEFAULT_PACK_ID, DEFAULT_PACK_ID)
  // 设置页必须引用共享库，不能自己抄一份常量
  assert.match(src('web/views/settings.js'), /greetings\.js/)

  // 手动点名已移除：单句下拉那套导出不许回流成死代码
  assert.equal(again.QUICK_GREETINGS, undefined)
  assert.equal(again.DEFAULT_GREETING_ID, undefined)
  assert.equal(again.findGreeting, undefined)
})

/* ══════════════════ 自动打招呼能直接用 ══════════════════ */

test('预设：默认包可直接喂给自动打招呼，轮播不超长、不重复写 @', () => {
  const lines = findPack(DEFAULT_PACK_ID).lines
  const seen = []
  let cursor = 0
  for (let i = 0; i < lines.length * 2; i++) {
    const r = nextGreeting(lines, cursor, false)
    cursor = r.cursor
    seen.push(r.text)
    assert.equal(r.text.includes('@'), false)
    // 60 字昵称也不该把预设顶超限：预设不带 {用户}，render 之后长度不变
    const rendered = render(r.text, { 用户: '超长的昵称'.repeat(12) })
    assert.equal(rendered, r.text, '预设文案不该被昵称撑长')
    assert.equal(prepareText(rendered, { max: MAX_TEXT }).truncated, false)
  }
  assert.deepEqual(seen.slice(0, lines.length), lines, '第一轮按顺序说完')
  assert.deepEqual(seen.slice(lines.length), lines, '第二轮从头再来')
})
