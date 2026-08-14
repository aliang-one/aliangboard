// useRequiredFields:表单必填校验 composable(API Key 签发表单校验模式的通用化)。
import { test, expect } from 'vitest'
import { useRequiredFields } from '../useRequiredFields'

test('validate:trim 后非空判定 + errors 填充', () => {
  const { errors, validate } = useRequiredFields()
  const ok = validate({ a: ' x ', b: '   ', c: '' }, ['a', 'b', 'c'])
  expect(ok).toBe(false)
  expect(errors.value).toEqual({ b: true, c: true })
})

test('validate:全填 → true,errors 清空', () => {
  const { errors, validate } = useRequiredFields()
  validate({ a: '' }, ['a'])
  expect(errors.value.a).toBe(true)
  expect(validate({ a: 'ok' }, ['a'])).toBe(true)
  expect(errors.value).toEqual({})
})

test('clear/reset', () => {
  const { errors, validate, clear, reset } = useRequiredFields()
  validate({ a: '' }, ['a'])
  clear('a')
  expect(errors.value.a).toBeUndefined()
  validate({ a: '' }, ['a'])
  reset()
  expect(errors.value).toEqual({})
})
