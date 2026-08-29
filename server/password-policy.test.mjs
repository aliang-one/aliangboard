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
