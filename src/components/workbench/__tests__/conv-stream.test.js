// Task 8 Step 1: applyStreamEvent 纯函数单测(无 EventSource 依赖,纯输入→输出)。
import { test, expect } from 'vitest'
import { applyStreamEvent } from '../conv-stream'

const fresh = () => ({ status: 'thinking', content: '', trace: [], steps: 0, denied: [], truncated: false, pendingApproval: null, error: '' })

test('hello 事件:对齐 status(running → thinking)', () => {
  const s = applyStreamEvent(fresh(), { type: 'hello', status: 'running' })
  expect(s.status).toBe('thinking')
})

test('hello 事件:done/failed 直接映射', () => {
  expect(applyStreamEvent(fresh(), { type: 'hello', status: 'done' }).status).toBe('done')
  expect(applyStreamEvent(fresh(), { type: 'hello', status: 'failed' }).status).toBe('error')
})

test('delta 事件:拼接到 content', () => {
  let s = fresh()
  s = applyStreamEvent(s, { type: 'delta', text: '你' })
  s = applyStreamEvent(s, { type: 'delta', text: '好' })
  expect(s.content).toBe('你好')
})

test('delta 事件:缺 text 字段不炸(空字符串兜底)', () => {
  const s = applyStreamEvent(fresh(), { type: 'delta' })
  expect(s.content).toBe('')
})

test('step(tool)事件:追加 trace', () => {
  let s = fresh()
  s = applyStreamEvent(s, { type: 'step', step: { type: 'tool', name: 'list_resources', args: {}, result: 'x' } })
  expect(s.trace).toHaveLength(1)
  expect(s.trace[0].name).toBe('list_resources')
})

test('approval 事件:置 pendingApproval + 切 pending_approval', () => {
  const s = applyStreamEvent(fresh(), { type: 'approval', pending: { toolCallId: 'c1', name: 'scale', args: {} } })
  expect(s.pendingApproval.name).toBe('scale')
  expect(s.status).toBe('pending_approval')
})

test('status=done 事件:置 done', () => {
  const s = applyStreamEvent(fresh(), { type: 'status', status: 'done' })
  expect(s.status).toBe('done')
})

test('status=paused 事件:置 pending_approval', () => {
  const s = applyStreamEvent(fresh(), { type: 'status', status: 'paused' })
  expect(s.status).toBe('pending_approval')
})

test('status=running 事件:置 thinking', () => {
  let s = { ...fresh(), status: 'done' }
  s = applyStreamEvent(s, { type: 'status', status: 'running' })
  expect(s.status).toBe('thinking')
})

test('status=failed 带 error', () => {
  const s = applyStreamEvent(fresh(), { type: 'status', status: 'failed', error: 'boom' })
  expect(s.status).toBe('error')
  expect(s.error).toBe('boom')
})

test('status=failed 缺 error 字段:兜底空串', () => {
  const s = applyStreamEvent(fresh(), { type: 'status', status: 'failed' })
  expect(s.status).toBe('error')
  expect(s.error).toBe('')
})

test('end 事件:不改状态(由 status 决定终态)', () => {
  const before = fresh()
  const after = applyStreamEvent(before, { type: 'end' })
  expect(after).toEqual(before)
})

test('未知事件类型:原样返回 state', () => {
  const before = fresh()
  const after = applyStreamEvent(before, { type: 'whatever', foo: 'bar' })
  expect(after).toEqual(before)
})

test('null/非对象事件:原样返回 state', () => {
  const before = fresh()
  expect(applyStreamEvent(before, null)).toEqual(before)
  expect(applyStreamEvent(before, 'string')).toEqual(before)
})

test('不可变性:返回新对象,不修改原 state', () => {
  const before = fresh()
  const after = applyStreamEvent(before, { type: 'delta', text: 'x' })
  expect(before.content).toBe('')  // 原 state 不被修改
  expect(after).not.toBe(before)
})

test('不可变性:step 事件 trace 为新数组,不修改原 trace', () => {
  const before = fresh()
  const after = applyStreamEvent(before, { type: 'step', step: { name: 'x' } })
  expect(before.trace).toHaveLength(0)  // 原 trace 不被修改
  expect(after.trace).not.toBe(before.trace)  // 新数组
  expect(after.trace).toHaveLength(1)
})

// 断流修复:snapshot 事件整体替换(gap 补齐),不与已收 delta 重复拼接
test('snapshot: 整体替换 content/trace/steps(重连补齐,非追加)', () => {
  let state = { status: 'thinking', content: '旧半句', trace: [{ name: 'a' }], steps: 1 }
  state = applyStreamEvent(state, { type: 'snapshot', content: '服务端全量', trace: [{ name: 'a' }, { name: 'b' }], steps: 2 })
  expect(state.content).toBe('服务端全量')
  expect(state.trace.length).toBe(2)
  expect(state.steps).toBe(2)
  // 缺字段时保留现有值
  state = applyStreamEvent(state, { type: 'snapshot' })
  expect(state.content).toBe('服务端全量')
})

// dev27: tool_start 瞬态(running 态 chip)——入列、配对移除、终态/审批清残留
test('tool_start 入 trace;对应 tool 到达时按 name 配对移除再追加', () => {
  let s = fresh()
  s = applyStreamEvent(s, { type: 'step', step: { type: 'tool', name: 'a', result: 'r1' } })
  s = applyStreamEvent(s, { type: 'step', step: { type: 'tool_start', name: 'b', args: { x: 1 } } })
  expect(s.trace.map(x => x.type)).toEqual(['tool', 'tool_start'])
  s = applyStreamEvent(s, { type: 'step', step: { type: 'tool', name: 'b', result: 'r2' } })
  expect(s.trace.map(x => x.type)).toEqual(['tool', 'tool'])
  expect(s.trace[1].result).toBe('r2')
})

test('终态/审批事件清 tool_start 残留(execTool 抛错直 failed 等)', () => {
  let s = applyStreamEvent(fresh(), { type: 'step', step: { type: 'tool_start', name: 'wb_exec' } })
  s = applyStreamEvent(s, { type: 'status', status: 'failed', error: 'boom' })
  expect(s.trace).toHaveLength(0)
  s = applyStreamEvent(s, { type: 'step', step: { type: 'tool_start', name: 'wb_exec' } })
  s = applyStreamEvent(s, { type: 'approval', pending: { toolCallId: '1', name: 'wb_exec', args: {} } })
  expect(s.trace).toHaveLength(0)
  expect(s.status).toBe('pending_approval')
})

// dev32: reasoning(深思考推理流)——增量拼接/快照恢复/终态保留(供折叠回看)
test('reasoning 事件拼接到 reasoning;snapshot 恢复;终态保留', () => {
  let s = fresh()
  s = applyStreamEvent(s, { type: 'reasoning', text: '先想 ' })
  s = applyStreamEvent(s, { type: 'reasoning', text: '再想' })
  expect(s.reasoning).toBe('先想 再想')
  s = applyStreamEvent(s, { type: 'snapshot', content: '答', reasoning: '服务端快照推理', trace: [], steps: 1 })
  expect(s.reasoning).toBe('服务端快照推理')
  s = applyStreamEvent(s, { type: 'status', status: 'done' })
  expect(s.reasoning).toBe('服务端快照推理', '终态不清 reasoning(折叠区可回看)')
})

test('status failed 事件:error 含 HTML(上游网关错误体)时净化为单行文本', () => {
  const s = applyStreamEvent(fresh(), {
    type: 'status', status: 'failed',
    error: 'LLM HTTP 502: <html>\r\n<head><title>502 Bad Gateway</title></head>\r\n</html>',
  })
  expect(s.status).toBe('error')
  expect(s.error).not.toContain('<')
  expect(s.error).toContain('502 Bad Gateway')
})
