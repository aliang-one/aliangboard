import { test, expect } from 'vitest'
import { firstFailedRule, DEFAULT_PASSWORD_POLICY, failedRuleMessageKey } from '@/utils/passwordRules'

test('镜像服务端规则:长度/mixed/digit/symbol', () => {
  expect(firstFailedRule('short')).toBe('minLength')
  expect(firstFailedRule('longenough')).toBeNull()
  const p = { minLength: 8, requireMixed: true, requireDigit: true, requireSymbol: true }
  expect(firstFailedRule('alllowercase1!', p)).toBe('mixed')
  expect(firstFailedRule('NoDigits!!', p)).toBe('digit')
  expect(firstFailedRule('NoSymbol11Aa', p)).toBe('symbol')
  expect(firstFailedRule('Good1!aA', p)).toBeNull()
})

test('failedRuleMessageKey:映射 i18n 键', () => {
  expect(failedRuleMessageKey('minLength')).toBe('userCenter.pwdNeedMin')
  expect(failedRuleMessageKey('mixed')).toBe('userCenter.pwdNeedMixed')
  expect(failedRuleMessageKey('digit')).toBe('userCenter.pwdNeedDigit')
  expect(failedRuleMessageKey('symbol')).toBe('userCenter.pwdNeedSymbol')
})
