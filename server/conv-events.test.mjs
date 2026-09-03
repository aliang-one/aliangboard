import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { eventsForResult } from './conv-events.mjs'

test('pending_approval → approval + paused + end,不 dispose', () => {
  const { events, dispose } = eventsForResult({
    status: 'pending_approval',
    pending: { toolCallId: 'tc1', name: 'apply_project_manifests' },
  })
  assert.equal(dispose, false)
  assert.equal(events.length, 3)
  assert.deepEqual(events[0], { type: 'approval', pending: { toolCallId: 'tc1', name: 'apply_project_manifests' } })
  assert.deepEqual(events[1], { type: 'status', status: 'paused' })
  assert.deepEqual(events[2], { type: 'end' })
})

test('done → status:done + end,dispose', () => {
  const { events, dispose } = eventsForResult({ status: 'done', content: 'hello' })
  assert.equal(dispose, true)
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], { type: 'status', status: 'done', truncated: false })
  assert.deepEqual(events[1], { type: 'end' })
})

test('无 status 字段默认走 done 路径(兜底)', () => {
  // agent 终答通常 status:done;无 status 视为终态,按 done 处理 + dispose
  const { events, dispose } = eventsForResult({ content: 'ans' })
  assert.equal(dispose, true)
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], { type: 'status', status: 'done', truncated: false })
})

test('done + truncated → status 事件透传 truncated(2026-09-03 收尾轮标识)', () => {
  const { events } = eventsForResult({ status: 'done', content: 'ans', truncated: true })
  assert.deepEqual(events[0], { type: 'status', status: 'done', truncated: true })
})

test('null/undefined 入参 → 空事件 + 不 dispose(防御)', () => {
  assert.deepEqual(eventsForResult(null), { events: [], dispose: false })
  assert.deepEqual(eventsForResult(undefined), { events: [], dispose: false })
})

test('pendingApproval 的 pending 字段透传(undefined 也安全)', () => {
  const { events } = eventsForResult({ status: 'pending_approval' })
  assert.deepEqual(events[0], { type: 'approval', pending: undefined })
})

test('pending=null 时透传(显式空)', () => {
  // 已驳回场景:agent 可能 pending=null
  const { events, dispose } = eventsForResult({ status: 'pending_approval', pending: null })
  assert.equal(dispose, false)
  assert.deepEqual(events[0], { type: 'approval', pending: null })
})
