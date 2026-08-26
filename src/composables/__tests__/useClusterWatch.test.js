import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWatchController, WATCH_BACKOFF_BASE_MS, WATCH_DEGRADED_RETRY_MS } from '../useClusterWatch'
import { recordListRv, getListRv, clearWatchRegistry } from '../watchRegistry'

beforeEach(() => { vi.useFakeTimers(); clearWatchRegistry() })
afterEach(() => vi.useRealTimers())

// 假 connect:捕获 handlers,由测试主动触发 onOpen/onError/onClose 模拟流断开
function makeFakeConnect() {
  const calls = []
  const connect = handlers => {
    const h = { handlers, aborted: false, abort: () => { h.aborted = true } }
    calls.push(h)
    return h
  }
  return { connect, calls }
}

describe('createWatchController', () => {
  it('start 后连接成功 → live;正常 stop 调 abort', () => {
    const { connect, calls } = makeFakeConnect()
    const states = []
    const c = createWatchController({ connect, relist: vi.fn(), onState: s => states.push(s) })
    c.start()
    expect(states).toEqual(['reconnecting'])     // start 即「连接中」,首次 onOpen 才 live
    calls[0].handlers.onOpen()
    expect(states).toEqual(['reconnecting', 'live'])
    c.stop()
    expect(calls[0].aborted).toBe(true)
  })

  it('断流按指数退避重连:1s→2s→4s;恢复即回 live 且计数清零', () => {
    const { connect, calls } = makeFakeConnect()
    const c = createWatchController({ connect, relist: vi.fn(), onState: vi.fn() })
    c.start(); calls[0].handlers.onOpen()
    calls[0].handlers.onError(new Error('x'))          // 失败1 → 1s 后重连
    vi.advanceTimersByTime(WATCH_BACKOFF_BASE_MS - 1); expect(calls.length).toBe(1)
    vi.advanceTimersByTime(1); expect(calls.length).toBe(2)
    calls[1].handlers.onError(new Error('x'))          // 失败2 → 2s
    vi.advanceTimersByTime(1999); expect(calls.length).toBe(2)
    vi.advanceTimersByTime(1); expect(calls.length).toBe(3)
    calls[2].handlers.onOpen()                          // 恢复
    calls[2].handlers.onError(new Error('x'))          // 又从 1s 起退避(计数已清零)
    vi.advanceTimersByTime(WATCH_BACKOFF_BASE_MS); expect(calls.length).toBe(4)
    c.stop()
  })

  it('410 不计失败:先 relist 再重开', async () => {
    const { connect, calls } = makeFakeConnect()
    const relist = vi.fn()
    const states = []
    const c = createWatchController({ connect, relist, onState: s => states.push(s) })
    c.start(); calls[0].handlers.onOpen()
    calls[0].handlers.onError(Object.assign(new Error('gone'), { status: 410 }))
    await vi.advanceTimersByTimeAsync(0)               // 微任务 flushed
    expect(relist).toHaveBeenCalledTimes(1)
    expect(states).toContain('reconnecting')
    calls[1].handlers.onOpen()
    expect(states[states.length - 1]).toBe('live')
    c.stop()
  })

  it('连续 5 次失败 → degraded;降级期 60s 重试,成功回 live', () => {
    const { connect, calls } = makeFakeConnect()
    const states = []
    const c = createWatchController({ connect, relist: vi.fn(), onState: s => states.push(s) })
    c.start()
    for (let i = 0; i < 5; i++) { calls[i].handlers.onError(new Error('x')); vi.advanceTimersByTime(WATCH_DEGRADED_RETRY_MS) }
    expect(states).toContain('degraded')
    expect(calls.length).toBe(6)                        // 第 6 次 = 降级重试
    calls[5].handlers.onOpen()
    expect(states[states.length - 1]).toBe('live')
    c.stop()
  })

  it('stop 后的迟到回调不再驱动状态机', () => {
    const { connect, calls } = makeFakeConnect()
    const states = []
    const c = createWatchController({ connect, relist: vi.fn(), onState: s => states.push(s) })
    c.start(); calls[0].handlers.onOpen()
    c.stop()
    calls[0].handlers.onError(new Error('late'))
    vi.advanceTimersByTime(WATCH_DEGRADED_RETRY_MS * 3)
    expect(calls.length).toBe(1)
    expect(states).toEqual(['reconnecting', 'live', 'off'])  // stop 现在会复位 off(F1)
  })

  it('stop 复位状态为 off;迟到的 onOpen 不得复活 live', () => {
    const { connect, calls } = makeFakeConnect()
    const states = []
    const c = createWatchController({ connect, relist: vi.fn(), onState: s => states.push(s) })
    c.start(); calls[0].handlers.onOpen()
    c.stop()
    expect(c.state).toBe('off')
    expect(states[states.length - 1]).toBe('off')
    calls[0].handlers.onOpen()                            // 迟到 onOpen
    expect(c.state).toBe('off')
    expect(states).toEqual(['reconnecting', 'live', 'off'])
  })
})

describe('watchRegistry', () => {
  it('list RV 按路径登记/读取;空值不覆盖', () => {
    recordListRv('/api/v1/pods', '100')
    recordListRv('/api/v1/pods', undefined)
    expect(getListRv('/api/v1/pods')).toBe('100')
    expect(getListRv('/apis/apps/v1/deployments')).toBe('')
  })
})
