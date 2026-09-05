import test from 'node:test'
import assert from 'node:assert/strict'
import { isPasswordOk } from './password-policy.mjs'

test('≥8 位通过;<8 位拒绝;空/非字符串拒绝', () => {
  assert.equal(isPasswordOk('12345678'), true)
  assert.equal(isPasswordOk('1234567'), false)
  assert.equal(isPasswordOk(''), false)
  assert.equal(isPasswordOk(null), false)
  assert.equal(isPasswordOk(undefined), false)
})

import { DEFAULT_PASSWORD_POLICY, normalizePolicy, resolvePasswordPolicy, firstFailedRule } from './password-policy.mjs'

test('默认档与历史行为逐字一致:仅长度≥8', () => {
  assert.equal(firstFailedRule('short', DEFAULT_PASSWORD_POLICY), 'minLength')
  assert.equal(firstFailedRule('longenough', DEFAULT_PASSWORD_POLICY), null)
  assert.equal(firstFailedRule(undefined), 'minLength')
  assert.equal(firstFailedRule(123), 'minLength')
})

test('规则档位:mixed/digit/symbol 按开关生效,关则不判', () => {
  const p = { minLength: 8, requireMixed: true, requireDigit: true, requireSymbol: true }
  assert.equal(firstFailedRule('alllowercase1!', p), 'mixed')
  assert.equal(firstFailedRule('NoDigits!!', p), 'digit')
  assert.equal(firstFailedRule('NoSymbol11Aa', p), 'symbol')
  assert.equal(firstFailedRule('Good1!aA', p), null)
  // 关掉的规则不判:全小写长密码在默认档通过
  assert.equal(firstFailedRule('alllowercase', { minLength: 8, requireMixed: false, requireDigit: false, requireSymbol: false }), null)
})

test('normalizePolicy:逐字段回退默认,minLength 钳 [8,128]', () => {
  assert.deepEqual(normalizePolicy(null), DEFAULT_PASSWORD_POLICY)
  assert.deepEqual(normalizePolicy('garbage'), DEFAULT_PASSWORD_POLICY)
  assert.deepEqual(normalizePolicy({ minLength: 3, requireMixed: 'yes' }), { minLength: 8, requireMixed: true, requireDigit: false, requireSymbol: false })
  assert.equal(normalizePolicy({ minLength: 999 }).minLength, 128)
})

test('resolvePasswordPolicy:读 settings JSON,坏 JSON 回默认', () => {
  assert.deepEqual(resolvePasswordPolicy(() => null), DEFAULT_PASSWORD_POLICY)
  assert.deepEqual(resolvePasswordPolicy(() => '{"minLength":12,"requireDigit":true}'), { minLength: 12, requireMixed: false, requireDigit: true, requireSymbol: false })
  assert.deepEqual(resolvePasswordPolicy(() => 'not-json'), DEFAULT_PASSWORD_POLICY)
  assert.deepEqual(resolvePasswordPolicy(() => { throw new Error('db gone') }), DEFAULT_PASSWORD_POLICY)
})
