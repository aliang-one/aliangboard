import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { emit, subscribe, unsubscribe, dispose } from './conv-bus.mjs'

test('subscribe 收到 emit 的事件', () => {
  const got = []
  const fn = e => got.push(e)
  subscribe('t1', fn)
  emit('t1', { type: 'delta', text: 'a' })
  assert.deepEqual(got, [{ type: 'delta', text: 'a' }])
  unsubscribe('t1', fn)
})

test('unsubscribe 后不再收到', () => {
  const got = []
  const fn = e => got.push(e)
  subscribe('t2', fn)
  unsubscribe('t2', fn)
  emit('t2', { type: 'delta', text: 'b' })
  assert.equal(got.length, 0)
})

test('多订阅者都收到', () => {
  const a = [], b = []
  const fa = e => a.push(e), fb = e => b.push(e)
  subscribe('t3', fa); subscribe('t3', fb)
  emit('t3', { type: 'status' })
  assert.equal(a.length, 1); assert.equal(b.length, 1)
  dispose('t3')
})

test('dispose 清理该 convId 所有监听', () => {
  const got = []
  subscribe('t4', e => got.push(e))
  dispose('t4')
  emit('t4', { type: 'end' })
  assert.equal(got.length, 0)
})
