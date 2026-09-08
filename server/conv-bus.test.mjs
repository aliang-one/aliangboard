import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { emit, subscribe, unsubscribe, dispose } from './conv-bus.mjs'

// cancel-races-07(2026-09-07 审计批次三):emit 的 per-conv 快照累积机制已整体退役
// (零消费方的死代码——SSE 重连补齐走 DB(turnSnapshot)+ 建连前 flushCheckpoint;见
// conv-bus.mjs 头注)。本文件锁定退役后的表面积:纯事件分发(subscribe/unsubscribe/dispose)。

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

// 退役守卫:emit 大量事件不再有任何按 convId 的累积状态(旧快照 Map 的内存/写放大源)。
// 以 dispose 后再 emit 不炸 + 高频 emit 快速完成为行为面;结构性无快照由源码形态保证
// (模块不再导出 snapshot/snapshotsSize——import 即编译期锁定,缺导出直接 SyntaxError)。
test('高频 emit 无累积副作用(快照机制退役后 emit 只做分发)', () => {
  const got = []
  subscribe('t5', e => got.push(e))
  for (let i = 0; i < 1000; i++) emit('t5', { type: 'delta', text: 'x' })
  assert.equal(got.length, 1000, '分发不丢事件')
  dispose('t5')
})
