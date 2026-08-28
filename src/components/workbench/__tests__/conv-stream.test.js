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

// 2026-08-25 交错渲染:assistant step(一轮完成)→ trace 得瘦身事件(content 平铺)+ 
// content/reasoning 清零——已完成轮文本活在 trace,当前轮从零累积,零重复零拼接。
import { applyStreamEvent as ase } from '../conv-stream'

test('assistant step:trace 得 {type,content,ts} 瘦身事件 + content/reasoning 清零', () => {
  let s = { status: 'thinking', content: '第一轮说了一半的话', reasoning: '思考1', trace: [], steps: 0 }
  s = ase(s, { type: 'step', step: { type: 'assistant', message: { role: 'assistant', content: '第一轮说了一半的话', tool_calls: [{ id: 'x' }] }, ts: 1756100000000 } })
  expect(s.trace.at(-1)).toEqual({ type: 'assistant', content: '第一轮说了一半的话', ts: 1756100000000 })
  expect(s.content).toBe('')
  expect(s.reasoning).toBe('')
})

test('assistant step 兼容本地瘦身形状(content 平铺)', () => {
  let s = { status: 'thinking', content: '', reasoning: '', trace: [], steps: 0 }
  s = ase(s, { type: 'step', step: { type: 'assistant', content: '平铺形状', ts: 1 } })
  expect(s.trace.at(-1)?.content).toBe('平铺形状')
})

test('tool step 仍正常累积,不受 assistant 清零影响', () => {
  let s = { status: 'thinking', content: '文本', reasoning: '', trace: [], steps: 0 }
  s = ase(s, { type: 'step', step: { type: 'tool', name: 'wb_exec', args: {}, result: { stdout: 'ok' }, ts: 2 } })
  expect(s.trace.at(-1).name).toBe('wb_exec')
  expect(s.content).toBe('文本')   // tool 事件不清文本
})

// 闪变修复(2026-08-25):snapshot 的空 content/reasoning 不得清空 live 流式文本——
// 服务端检查点 <200 字未落时 conv.content=''(或跨轮旧值),重连 snapshot 会把
// 正在流出的文本打空,下个 delta 又长回来 → 周期性消失/复现。
test('snapshot:空 content 不覆写 live 文本;有值才对齐', () => {
  let s = { status: 'thinking', content: '正在流式的文本', reasoning: '思考中', trace: [{ type: 'tool', name: 'x' }], steps: 1 }
  s = ase(s, { type: 'snapshot', content: '', reasoning: '', trace: [], steps: 5 })
  expect(s.content).toBe('正在流式的文本')   // 空 = 不覆写
  expect(s.reasoning).toBe('思考中')
  expect(s.trace).toEqual([{ type: 'tool', name: 'x' }])  // 空 trace 同样不覆写
  s = ase(s, { type: 'snapshot', content: '检查点文本', reasoning: 'r', trace: [{ type: 'tool', name: 'y' }], steps: 9 })
  expect(s.content).toBe('检查点文本')       // 非空 = 对齐
  expect(s.trace.length).toBe(1)
})

// ── 2026-08-28 终答丢失审计:交错渲染的对齐缺口 ──
// 交错模式终答显示唯一依赖 trace 的 assistant 终答块;对齐路径(SSE 终态 snapshot /
// pollOnce done)只对齐 content 不补块——SSE 死亡窗口后对齐到 done 时,终答(content)
// 在交错模式无处渲染(「最后一段没展示就结束了」的根因;刷新走消息级 trace 才完整)。
test('done:trace 有中间轮文本块但缺终答块 + content 非空 → 补终答块', () => {
  const state = {
    status: 'thinking',
    content: '最终答案全文',
    trace: [
      { type: 'assistant', content: '先看一下资源', ts: 1 },
      { type: 'tool', name: 'list', args: {}, result: 'ok', ts: 2 },
    ],
  }
  const next = applyStreamEvent(state, { type: 'status', status: 'done' })
  const last = next.trace[next.trace.length - 1]
  expect(last.type).toBe('assistant')
  expect(last.content).toBe('最终答案全文')
  // 中间块保留
  expect(next.trace).toHaveLength(3)
})

test('done:trace 末块已是终答(与 content 同文)→ 不重复追加', () => {
  const state = {
    status: 'thinking',
    content: '终答',
    trace: [
      { type: 'assistant', content: '中间轮', ts: 1 },
      { type: 'assistant', content: '终答', ts: 2 },
    ],
  }
  const next = applyStreamEvent(state, { type: 'status', status: 'done' })
  expect(next.trace).toHaveLength(2)
})

test('done:trace 无 assistant 文本块(回退布局)→ 不追加,content 由回退布局渲染', () => {
  const state = { status: 'thinking', content: '终答', trace: [{ type: 'tool', name: 'x', args: {}, result: 'ok', ts: 1 }] }
  const next = applyStreamEvent(state, { type: 'status', status: 'done' })
  expect(next.trace).toHaveLength(1)
})

test('done:content 为空(正常 SSE 路径,step.assistant 已清零)→ 不追加', () => {
  const state = { status: 'thinking', content: '', trace: [{ type: 'assistant', content: '中间轮', ts: 1 }] }
  const next = applyStreamEvent(state, { type: 'status', status: 'done' })
  expect(next.trace).toHaveLength(1)
})
