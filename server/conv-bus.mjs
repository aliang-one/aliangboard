import { EventEmitter } from 'node:events'

// per-convId 事件总线。生产者:run/resumeConversation(detached);消费者:SSE 端点。
// 模块级单例——一个进程内所有对话共享。
const bus = new EventEmitter()
bus.setMaxListeners(100) // 同一 conv 可能多个 SSE 客户端(断线重连期间)

export function emit(convId, event) { bus.emit(convId, event) }
export function subscribe(convId, fn) { bus.on(convId, fn) }
export function unsubscribe(convId, fn) { bus.off(convId, fn) }
export function dispose(convId) { bus.removeAllListeners(convId) }
