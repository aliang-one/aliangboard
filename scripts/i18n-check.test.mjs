import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanSource, parity, extractKeyRefs, missingKeys } from './i18n-check.mjs'

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
