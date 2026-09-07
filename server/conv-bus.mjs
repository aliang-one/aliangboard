import { EventEmitter } from 'node:events'

// per-convId 事件总线。生产者:run/resumeConversation(detached);消费者:SSE 端点。
// 模块级单例——一个进程内所有对话共享。
const bus = new EventEmitter()
bus.setMaxListeners(100) // 同一 conv 可能多个 SSE 客户端(断线重连期间)

// cancel-races-07(2026-09-07 审计批次三):per-conv 增量快照机制整体退役。2026-08-16 断流
// 修复引入的 emit 同步累积快照(每事件维护 content/trace/steps,256 会话容量上限)在 SSE
// 重连补齐改读 DB(turnSnapshot:conv.content/reasoning 检查点 + conv.trace 按轮切割,覆盖
// run+审批 resume 全程,2026-08-25 闪变续修)之后成了纯死代码——路由侧早已无人消费
// busSnapshot(grep 全仓:唯一 import 在 index.mjs 装配链上原样透传后弃置),却仍对每条
// delta/step 事件做全量快照维护(写放大)+ 常驻 256 会话内存 + 与 DB 口径双源漂移。删除:
// 中段 delta 补齐的正确通路 = 订阅先行(建连即订阅,同步执行不漏事件)+ 快照读库前同步
// flush 在途检查点(cancel-races-05,零滞后窗口)。emit 现在只做事件分发。
export function emit(convId, event) { bus.emit(convId, event) }
export function subscribe(convId, fn) { bus.on(convId, fn) }
export function unsubscribe(convId, fn) { bus.off(convId, fn) }
export function dispose(convId) { bus.removeAllListeners(convId) }
