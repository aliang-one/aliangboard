// server/model-context.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { contextWindowFor, estTokens, estTokensFromCounts, countCjkChars, trimBudgetChars } from './model-context.mjs'

test('contextWindowFor:家族 substring 匹配(小写化)', () => {
  assert.equal(contextWindowFor('gpt-4o'), 128_000)
  assert.equal(contextWindowFor('gpt-4o-2024-11-20'), 128_000)
  assert.equal(contextWindowFor('gpt-4.1'), 1_000_000)
  assert.equal(contextWindowFor('gpt-5'), 1_000_000)
  assert.equal(contextWindowFor('o3-mini'), 200_000)
  assert.equal(contextWindowFor('claude-sonnet-4-6'), 200_000)
  assert.equal(contextWindowFor('deepseek-chat'), 128_000)
  assert.equal(contextWindowFor('deepseek-reasoner'), 128_000)
  assert.equal(contextWindowFor('qwen-max'), 128_000)
  assert.equal(contextWindowFor('qwen3-235b-a22b'), 128_000)
  assert.equal(contextWindowFor('qwen-long'), 10_000_000, 'qwen-long 例外:长上下文 10M,不被 qwen 家族吞')
  assert.equal(contextWindowFor('glm-4.5-air'), 128_000)
  assert.equal(contextWindowFor('moonshot-v1-8k'), 128_000)
  assert.equal(contextWindowFor('kimi-k2'), 128_000)
  assert.equal(contextWindowFor('gemini-2.0-flash'), 1_000_000)
  assert.equal(contextWindowFor('doubao-pro-32k'), 128_000)
  assert.equal(contextWindowFor('GPT-4O'), 128_000, '大小写不敏感')
})

test('contextWindowFor:未命中/空 → 默认 200k', () => {
  assert.equal(contextWindowFor('totally-unknown-model'), 200_000)
  assert.equal(contextWindowFor(''), 200_000)
  assert.equal(contextWindowFor(null), 200_000)
  assert.equal(contextWindowFor(undefined), 200_000)
})

// context-assembly-05(2026-09-07 审计批次三):CJK 感知估算。旧 chars/2 折中在纯中文上低估
// ~2 倍(中文≈1字/token 而非 2字/token)——willTrim 漏报、硬裁剪预算超发。模型:cjk≈1 token/字,
// 其余≈1 token/4字符。两入口:estTokens(文本)/estTokensFromCounts(装配侧按块累计计数)。
test('estTokens:CJK 感知——纯中文 1字/token、纯英文 4字符/token、混合加权', () => {
  assert.equal(estTokens(''), 0)
  assert.equal(estTokens('中'.repeat(100)), 100, '纯中文 ≈1 token/字(旧 chars/2 低估 2 倍)')
  assert.equal(estTokens('x'.repeat(100)), 25, '纯英文 ≈1 token/4字符')
  assert.equal(estTokens('中'.repeat(60) + 'x'.repeat(100)), 85, '混合加权(60 + ceil(100/4))')
  assert.equal(estTokens('abc'), 1, '非 CJK 向上取整')
})

test('estTokensFromCounts:计数入口(装配侧累计用;refs 估算等纯计数按非 CJK 计)', () => {
  assert.equal(estTokensFromCounts(0, 0), 0)
  assert.equal(estTokensFromCounts(100, 0), 100)
  assert.equal(estTokensFromCounts(0, 101), 26)   // ceil(101/4)
  assert.equal(estTokensFromCounts(60, 100), 85)
})

test('countCjkChars:CJK/非 CJK 字数分桶(CJK 统一表+假名+谚文+兼容区)', () => {
  assert.deepEqual(countCjkChars(''), { cjk: 0, other: 0 })
  assert.deepEqual(countCjkChars('hello world'), { cjk: 0, other: 11 })
  assert.deepEqual(countCjkChars('中文'), { cjk: 2, other: 0 })
  assert.deepEqual(countCjkChars('修复 nginx 503'), { cjk: 2, other: 10 })  // 12 字符,空格/ASCII 按非 CJK 计
})

// 三态预算判定:同窗口同字符量级下,纯中文不再被低估漏裁;英文/混合口径不再一刀切。
test('预算判定三态:中文超预算被识别(旧算法漏裁);英文/混合按加权口径', () => {
  const budgetTokens = Math.floor(128_000 * 0.7)  // 89_600(contextInfo 同款窗口 70%)
  // 纯中文 9 万字 = 9 万 token > 预算 → 裁(旧 chars/2 估 45k → 漏裁,真实已逼近窗口)
  assert.ok(estTokens('中'.repeat(90_000)) > budgetTokens, '纯中文超预算被识别')
  // 纯英文 32 万字符 = 8 万 token ≤ 预算 → 不裁
  assert.ok(estTokens('x'.repeat(320_000)) <= budgetTokens, '纯英文在预算内')
  // 混合 6 万中文 + 10 万英文 = 6 万 + 2.5 万 = 8.5 万 ≤ 预算 → 不裁(按加权而非一刀切)
  assert.ok(estTokens('中'.repeat(60_000) + 'x'.repeat(100_000)) <= budgetTokens, '混合按加权口径')
})

test('trimBudgetChars:按 CJK 最坏密度校准(1 token/字;旧 ×2 对纯中文超发 2 倍)', () => {
  assert.equal(trimBudgetChars(200_000), 140_000)   // 200k 窗口 → 140k token 预算 → 140k 字符(CJK 最坏)
  assert.equal(trimBudgetChars(128_000), 89_600)
  assert.equal(trimBudgetChars(1_000_000), 700_000)
})
