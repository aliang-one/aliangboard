import { EventEmitter } from 'node:events'

// per-convId 事件总线。生产者:run/resumeConversation(detached);消费者:SSE 端点。
// 模块级单例——一个进程内所有对话共享。
const bus = new EventEmitter()
bus.setMaxListeners(100) // 同一 conv 可能多个 SSE 客户端(断线重连期间)

// per-conv 增量快照(2026-08-16 断流修复):emit 时同步累积 content/trace/steps。
// 动机:gap 期间的事件在 EventSource (重)建连前已 emit,而 conv.content 只在 done 落库——
// 不补齐则断连/晚连客户端的中段 delta 永久丢失("回答到一半就没有后续流式")。
// SSE 端点连上时先订阅再发快照(两者同步执行,Node 单线程无竞态:不漏不重)。
// status=running(每轮首个事件)自动重置新一轮;dispose 只摘监听器、快照保留
// (终态后重连仍可补齐全量输出)。
const snapshots = new Map()

export function emit(convId, event) {
  const e = event
  if (e && typeof e === 'object') {
    if (e.type === 'status' && e.status === 'running') {
      snapshots.set(convId, { content: '', trace: [], steps: 0, status: 'running', error: '', pending: null })
    } else {
      const s = snapshots.get(convId) || { content: '', trace: [], steps: 0, status: '', error: '', pending: null }
      if (e.type === 'delta') s.content = (s.content || '') + (e.text || '')
      else if (e.type === 'step') { s.trace = [...(s.trace || []), e.step]; s.steps = (s.steps || 0) + 1 }
      else if (e.type === 'status') { s.status = e.status; if (e.error) s.error = e.error }
      else if (e.type === 'approval' && e.pending) s.pending = e.pending
      snapshots.set(convId, s)
    }
  }
  bus.emit(convId, event)
}

// 当前快照(只读副本;无则 null)。供 SSE 端点连上时补齐。
export function snapshot(convId) {
  const s = snapshots.get(convId)
  return s ? { ...s, trace: [...(s.trace || [])] } : null
}
export function subscribe(convId, fn) { bus.on(convId, fn) }
export function unsubscribe(convId, fn) { bus.off(convId, fn) }
export function dispose(convId) { bus.removeAllListeners(convId) /* 快照保留:终态后重连补齐 */ }
