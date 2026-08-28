// server/model-context.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { contextWindowFor, estTokens, trimBudgetChars } from './model-context.mjs'

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

test('estTokens:chars/2 向上取整(中文≈1字/token、英文≈4字符/token 折中)', () => {
  assert.equal(estTokens(0), 0)
  assert.equal(estTokens(100), 50)
  assert.equal(estTokens(101), 51)
})

test('trimBudgetChars:窗口 70% 折算字符(×2 反向估算)', () => {
  assert.equal(trimBudgetChars(200_000), 280_000)   // 200k 窗口 → 140k token 预算 → 280k 字符
  assert.equal(trimBudgetChars(128_000), 179_200)
  assert.equal(trimBudgetChars(1_000_000), 1_400_000)
})
