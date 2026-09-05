import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEmptyEnvRow } from './envRows.js'

test('isEmptyEnvRow: 全空行 → true', () => {
  assert.equal(isEmptyEnvRow({ key: '', value: '' }, ['key', 'value']), true)
  assert.equal(isEmptyEnvRow({ name: '', cmName: '', key: '' }, ['name', 'cmName', 'key']), true)
  assert.equal(isEmptyEnvRow({ name: '  ', cmName: '', key: '' }, ['name', 'cmName', 'key']), true)
})

test('isEmptyEnvRow: 半填或全填 → false', () => {
  assert.equal(isEmptyEnvRow({ key: '', value: 'x' }, ['key', 'value']), false)
  assert.equal(isEmptyEnvRow({ name: 'A', cmName: '', key: '' }, ['name', 'cmName', 'key']), false)
  assert.equal(isEmptyEnvRow({ name: 'A', cmName: 'cm', key: 'k' }, ['name', 'cmName', 'key']), false)
})

test('isEmptyEnvRow: null 或缺字段 → true', () => {
  assert.equal(isEmptyEnvRow(null, ['key']), true)
  assert.equal(isEmptyEnvRow({}, ['key', 'value']), true)
})
