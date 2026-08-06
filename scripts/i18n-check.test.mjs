import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanSource, parity } from './i18n-check.mjs'

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
