// 把 SSE 事件归约成 chat turn 状态。纯函数,无副作用,便于测试。
// 事件类型(见 T7 SSE 端点 spec §4.1.4):hello | status | step | delta | approval | end。
// 入参 state 是 agentTurn 当前快照;返回新 state(不可变)。
export function applyStreamEvent(state, evt) {
  if (!evt || typeof evt !== 'object') return state
  switch (evt.type) {
    case 'hello':
      // hello 携带对话当前 status(running/done/failed);running → thinking(前端 spinner 态)
      return { ...state, status: evt.status === 'done' ? 'done' : evt.status === 'failed' ? 'error' : 'thinking' }
    case 'delta':
      // LLM 输出增量文本:拼接到 content
      return { ...state, content: (state.content || '') + (evt.text || '') }
    case 'step':
      // 工具调用 step:追加 trace
      return { ...state, trace: [...state.trace, evt.step] }
    case 'snapshot':
      // 服务端 gap 补齐(断线重连/晚连时一键吃齐此前 delta/step):整体替换而非追加,
      // 避免与连接恢复后到达的增量重复拼接
      return {
        ...state,
        content: evt.content ?? state.content,
        trace: evt.trace ?? state.trace,
        steps: evt.steps ?? state.steps,
      }
    case 'approval':
      // 工具待审批:置 pendingApproval + 切 pending_approval
      return { ...state, pendingApproval: evt.pending, status: 'pending_approval' }
    case 'status': {
      // 对话状态变更(running/paused/done/failed/cancelled)
      if (evt.status === 'done') return { ...state, status: 'done' }
      if (evt.status === 'paused') return { ...state, status: 'pending_approval' }
      if (evt.status === 'failed') return { ...state, status: 'error', error: evt.error || '' }
      // cancelled 不在纯函数里塞文案(此模块无 i18n):error 留空,消费方(WorkbenchChat)用 t() 补
      if (evt.status === 'cancelled') return { ...state, status: 'error', error: evt.error || '' }
      if (evt.status === 'running') return { ...state, status: 'thinking' }
      return state
    }
    case 'end':
      // SSE 连接终结;不改状态(终态由 status 事件决定)
      return state
    default:
      return state
  }
}
