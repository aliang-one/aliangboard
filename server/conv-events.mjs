// 对话终态 → bus 事件序列(纯函数,不依赖 bus 单例,便于单测)。
//
// 语义(brief Step 2):
//   pending_approval → [approval, status:paused, end](paused 也关 SSE;bus 不 dispose——resume 续用)
//   其他(done)     → [status:done, end] + dispose(done 才清理)
//
// 返回 { events: [...], dispose: boolean }。调用方负责按序 emit + 按 dispose 标志调 busDispose。
export function eventsForResult(out) {
  if (!out || typeof out !== 'object') return { events: [], dispose: false }
  if (out.status === 'pending_approval') {
    return {
      events: [
        { type: 'approval', pending: out.pending },
        { type: 'status', status: 'paused' },
        { type: 'end' },
      ],
      dispose: false,
    }
  }
  // done(以及其他终态——非 paused)都按 done 处理并 dispose;
  // truncated 透传(2026-09-03):收尾轮答案/旧硬断都带此标,前端亮「已达步数上限」
  return {
    events: [
      { type: 'status', status: 'done', truncated: !!out.truncated },
      { type: 'end' },
    ],
    dispose: true,
  }
}
