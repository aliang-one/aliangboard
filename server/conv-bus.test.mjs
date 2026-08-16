import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { emit, snapshot, snapshotsSize, subscribe, unsubscribe, dispose } from './conv-bus.mjs'

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

// ═══ 断流修复(2026-08-16):per-conv 快照——重连/晚连补齐 ═══
import { emit as _emit, snapshot as _snapshot, subscribe as _sub, dispose as _dispose } from './conv-bus.mjs'

test('snapshot: delta/step 累积;status running 重置新一轮;dispose 后保留;返回只读副本', () => {
  const events = []
  _sub('snap-conv', e => events.push(e))
  _emit('snap-conv', { type: 'status', status: 'running' })
  _emit('snap-conv', { type: 'delta', text: '回答' })
  _emit('snap-conv', { type: 'delta', text: '前半' })
  _emit('snap-conv', { type: 'step', step: { name: 'wb_list_resources' } })
  let s = _snapshot('snap-conv')
  assert.equal(s.content, '回答前半', 'delta 拼接')
  assert.equal(s.trace.length, 1, 'step 累积')
  assert.equal(s.steps, 1)
  assert.equal(s.status, 'running')
  // 副本只读:改副本不影响内部
  s.content = 'tampered'
  assert.equal(_snapshot('snap-conv').content, '回答前半')
  // done 终态:快照保留(重连仍可补齐)
  _emit('snap-conv', { type: 'status', status: 'done' })
  _dispose('snap-conv')
  s = _snapshot('snap-conv')
  assert.equal(s.status, 'done')
  assert.equal(s.content, '回答前半', 'dispose 后保留')
  // 新一轮 running 重置
  _emit('snap-conv', { type: 'status', status: 'running' })
  assert.equal(_snapshot('snap-conv').content, '', '新一轮清零')
  // approval 记录
  _emit('snap-conv', { type: 'approval', pending: { toolCallId: 't1', name: 'wb_scale', args: {} } })
  assert.equal(_snapshot('snap-conv').pending.name, 'wb_scale')
})

test('snapshot: 未 start 的 conv 返回 null', () => {
  assert.equal(_snapshot('never-started'), null)
})

// dev31 复查:快照 Map 容量上限——超限按插入序淘汰最旧,防长跑内存泄漏
test('snapshots 超上限淘汰最旧(≤256 条),活跃对话不被淘汰', () => {
  for (let i = 0; i < 300; i++) emit('conv-' + i, { type: 'status', status: 'done' })
  const s = snapshot('conv-0')
  assert.equal(s, null, '最旧的 conv-0 被淘汰')
  assert.notEqual(snapshot('conv-299'), null, '最新仍在')
  assert.ok(snapshotsSize() <= 256, '容量受控')
})
