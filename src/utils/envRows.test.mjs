import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEmptyEnvRow, firstDuplicateEnvName } from './envRows.js'

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

test('firstDuplicateEnvName: 跨三处重复 → 返回该名', () => {
  assert.equal(
    firstDuplicateEnvName([{ key: 'FOO', value: '1' }], [{ name: 'FOO', cmName: 'cm', key: 'k' }], []),
    'FOO',
  )
  assert.equal(
    firstDuplicateEnvName([], [{ name: 'BAR', cmName: 'cm', key: 'k' }], [{ name: 'BAR', secretName: 's', key: 'k' }]),
    'BAR',
  )
})

test('firstDuplicateEnvName: 单处内部重复 → 返回该名', () => {
  assert.equal(firstDuplicateEnvName([{ key: 'A' }, { key: 'A' }], [], []), 'A')
  assert.equal(firstDuplicateEnvName([], [], [{ name: 'B' }, { name: 'B' }]), 'B')
})

test('firstDuplicateEnvName: trim 后同名也算重复', () => {
  assert.equal(firstDuplicateEnvName([{ key: 'A' }], [{ name: ' A' }], []), 'A')
})

test('firstDuplicateEnvName: 无重复或全空名 → null', () => {
  assert.equal(firstDuplicateEnvName([{ key: 'A' }], [{ name: 'B' }], [{ name: 'C' }]), null)
  assert.equal(firstDuplicateEnvName([{ key: '' }, { key: ' ' }], [], []), null)
  assert.equal(firstDuplicateEnvName(), null)
})
