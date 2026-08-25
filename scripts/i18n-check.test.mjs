import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanSource, parity, extractKeyRefs, missingKeys, danglingKeyLiterals, duplicateKeys, valueIssues } from './i18n-check.mjs'

test('scanSource 报告模板/脚本中文，排除注释与 console', () => {
  const hits = scanSource('src/__tests__/fixtures/i18n/sample.vue') // [{ file, line, text }]
  const texts = hits.map(h => h.text)
  assert.ok(texts.some(t => t.includes('刷新')), '模板中文应被报告')
  assert.ok(texts.some(t => t.includes('创建失败')), '脚本中文应被报告')
  assert.ok(!texts.some(t => t.includes('这是注释')), '注释应排除')
  assert.ok(!texts.some(t => t.includes('调试日志')), 'console 应排除')
})

test('scanSource 干净文件返回空', () => {
  const hits = scanSource('src/__tests__/fixtures/i18n/clean.vue')
  assert.equal(hits.length, 0)
})

test('scanSource 剥离行尾/行内/独占行注释，仅报告真实文案', () => {
  const hits = scanSource('src/__tests__/fixtures/i18n/comments.vue')
  assert.equal(hits.length, 1, '只应有 1 处真实文案')
  assert.ok(hits[0].text.includes('真正的用户文案'), '应报告唯一的真实文案')
})

test('parity 返回 onlyZh/onlyEn 数组', () => {
  const { onlyZh, onlyEn } = parity()
  assert.ok(Array.isArray(onlyZh) && Array.isArray(onlyEn))
})

test('extractKeyRefs 抽取静态 t() 键', () => {
  const refs = extractKeyRefs('src/__tests__/fixtures/i18n/sample.vue').map(r => r.key)
  assert.ok(refs.includes('common.sync'), '应抽出 common.sync')
})

test('missingKeys 返回数组（引用但 locale 缺失的键）', () => {
  const m = missingKeys()
  assert.ok(Array.isArray(m))
  assert.ok(m.every(x => x.key && x.file), '每项有 key+file')
})

test('danglingKeyLiterals 返回数组（对象/变量里的点分键、locale 缺失）', () => {
  const d = danglingKeyLiterals()
  assert.ok(Array.isArray(d))
  assert.ok(d.every(x => x.key && x.file), '每项有 key+file')
})

test('duplicateKeys 报告同对象重复键（JSON.parse 静默丢前者）', () => {
  const d = duplicateKeys(['src/__tests__/fixtures/i18n/dup-locale.json'])
  const paths = d.map(x => x.path)
  assert.ok(paths.includes('nav.inner.a'), '嵌套重复键应被报告')
  assert.ok(paths.includes('nav'), '顶层重复键应被报告')
  assert.equal(d.length, 2, '只应有 2 处真实重复')
  assert.ok(d.every(x => x.file && x.line), '每项有 file+line')
})

test('duplicateKeys 对数组兄弟对象/字符串内花括号不误报', () => {
  const d = duplicateKeys(['src/__tests__/fixtures/i18n/dup-locale.json'])
  const paths = d.map(x => x.path)
  assert.ok(!paths.some(p => p.includes('items')), '数组兄弟对象的同名键不是重复')
  assert.ok(!paths.includes('nav.hint'), '值里的 {name} 不影响结构解析')
})

test('duplicateKeys 对真实 locale 文件返回空（回归）', () => {
  const d = duplicateKeys()
  assert.equal(d.length, 0)
})

test('valueIssues 检出占位符错位/裸@/顶层管道/断链/双空值', () => {
  const zh = {
    a: '保存 {name} 成功',
    b: "邮箱 {'@'} 支持",
    c: '普通',
    d: '引用 @:nav.title 与 @:c',
    e: '',
    f: ['一行', '二行'],
  }
  const en = {
    a: 'Saved {user} ok',
    b: 'email @ here',
    c: 'plain | pipe',
    d: 'ref @:nav.title and @:c',
    e: '',
    f: 'not array',
  }
  const v = valueIssues(zh, en)
  const has = (key, type) => v.some(x => x.key === key && x.type === type)
  assert.ok(has('a', 'phMismatch'), '占位符 {name} vs {user} 应报错')
  assert.ok(has('b', 'bareAt'), 'en 裸 @ 应报错')
  assert.ok(!v.some(x => x.key === 'b' && x.locale === 'zh' && x.type === 'bareAt'), "zh 的 {'@'} 转义不应报")
  assert.ok(has('c', 'pipe'), '顶层 | 应报错')
  assert.ok(has('d', 'brokenLink'), '@:nav.title 目标不存在应报错')
  assert.ok(!v.some(x => x.key === 'd' && /brokenLink/.test(x.type) && (x.detail || '').includes('c')), '存在的链接 @:c 不应报')
  assert.ok(has('e', 'emptyValue'), '双空值应报死键')
  assert.ok(has('f', 'arrayMismatch'), '数组 vs 字符串应报错')
})

test('valueIssues 干净键值返回空（含单侧空=有意省略）', () => {
  const zh = { a: '保存 {name}', b: '个', c: '链接 @:c 自身' }
  const en = { a: 'Save {name}', b: '', c: 'link @:c self' }
  const v = valueIssues(zh, en)
  assert.equal(v.length, 0, '单侧空(unitCount 模式)与合法链接不应报错')
})

test('valueIssues 对真实 locale 文件返回空（回归）', () => {
  const v = valueIssues()
  assert.equal(v.length, 0)
})
