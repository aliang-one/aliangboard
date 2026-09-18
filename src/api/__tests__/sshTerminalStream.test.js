// sshTerminalStream 传输错误语义(2026-09-08 复查 P0):
// 浏览器对异常断开的既定事件序是 error → close。若 error 也走组件 onError,组件会先进入
// error 终态、随后 close 被拦截,自动重连被整个吞掉。契约:传输错误只经 onClose 决策;
// onError 仅保留给服务端 CH_ERROR 帧(不可恢复语义)。鉴权探针行为不变。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sshTerminalStream } from '../client.js'

let wsInstance = null
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this._l = {}; this.sent = []; this.closeArgs = null; wsInstance = this }
  set onmessage(fn) { this._l.message = fn }
  set onopen(fn) { this._l.open = fn }
  set onclose(fn) { this._l.close = fn }
  set onerror(fn) { this._l.error = fn }
  set binaryType(_) { /* noop */ }
  send(buf) { this.sent.push(new Uint8Array(buf)) }
  close(code, reason) { this.closeArgs = [code, reason]; this.readyState = 3 }
  emit(type, ev) { this._l[type]?.(ev) }
}

describe('sshTerminalStream', () => {
  beforeEach(() => {
    wsInstance = null
    globalThis.WebSocket = FakeWS
    globalThis.sessionStorage = { getItem: () => 'tok' }
  })
  afterEach(() => {
    delete globalThis.sessionStorage
    delete globalThis.WebSocket
  })

  it('传输错误(error→close 链)不触发 onError:重连决策归 onClose', () => {
    const events = []
    sshTerminalStream({
      serverId: 'sv1', sid: 'sid-1',
      onOpen: () => events.push('open'),
      onError: () => events.push('error'),
      onClose: () => events.push('close'),
    })
    wsInstance.emit('open')
    wsInstance.emit('error')      // 传输错误(网络断/中间层断):不是终态
    wsInstance.emit('close')      // close 随后必到,由它决定重连
    expect(events).toEqual(['open', 'close'])
  })

  it('CH_ERROR 帧(type 4)仍触发 onError(服务端不可恢复语义)', () => {
    const errors = []
    sshTerminalStream({ serverId: 'sv1', sid: 'sid-1', onError: m => errors.push(m) })
    const frame = new Uint8Array([4, ...new TextEncoder().encode('channel closed')])
    wsInstance.emit('message', { data: frame.buffer })
    expect(errors).toEqual(['channel closed'])
  })

  it('open 事件触发 onOpen(握手成功)', () => {
    let opened = false
    sshTerminalStream({ serverId: 'sv1', sid: 'sid-1', onOpen: () => { opened = true } })
    wsInstance.emit('open')
    expect(opened).toBe(true)
  })
})

// —— 客户端心跳看门狗(2026-09-18):路径静默中断的冻结窗从服务端 liveness 的 60-90s 压到 ≤30s ——
describe('sshTerminalStream 心跳看门狗', () => {
  beforeEach(() => {
    wsInstance = null
    globalThis.WebSocket = FakeWS
    globalThis.sessionStorage = { getItem: () => 'tok' }
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete globalThis.sessionStorage
    delete globalThis.WebSocket
  })

  it('每 15s 发心跳 ping(type 7);pong(type 8)持续应答则长活不误杀', () => {
    sshTerminalStream({ serverId: 'sv1', sid: 'sid-1' })
    wsInstance.readyState = 1
    wsInstance.emit('open')                    // open 重置 pong 基线
    vi.advanceTimersByTime(15000)
    expect(wsInstance.sent.filter(f => f[0] === 7)).toHaveLength(1)
    for (let i = 0; i < 8; i++) {              // 每 15s 应答一次,持续 2 分钟 → 存活
      wsInstance.emit('message', { data: new Uint8Array([8]).buffer })
      vi.advanceTimersByTime(15000)
    }
    expect(wsInstance.closeArgs).toBeNull()
    expect(wsInstance.sent.filter(f => f[0] === 7).length).toBeGreaterThanOrEqual(9)
  })

  it('>30s 无 pong → 主动 close(4000, client-stall),冻结窗 ≤45s 封顶', () => {
    sshTerminalStream({ serverId: 'sv1', sid: 'sid-1' })
    wsInstance.readyState = 1
    wsInstance.emit('open')
    vi.advanceTimersByTime(45000)   // t=15s/30s 两轮 ping 无应答;t=45s 判死
    expect(wsInstance.closeArgs).not.toBeNull()
    expect(wsInstance.closeArgs[0]).toBe(4000)
  })

  it('未 open(readyState 0)不发心跳;close 清心跳定时器(不泄漏)', () => {
    sshTerminalStream({ serverId: 'sv1', sid: 'sid-1' })
    vi.advanceTimersByTime(30000)
    expect(wsInstance.sent.filter(f => f[0] === 7)).toHaveLength(0)    // 连接未 open 不发
    wsInstance.readyState = 1
    wsInstance.emit('open')                                            // open 重置基线 → 15s 后正常发 ping
    vi.advanceTimersByTime(15000)
    expect(wsInstance.sent.filter(f => f[0] === 7)).toHaveLength(1)
    wsInstance.emit('close')
    const n = wsInstance.sent.length
    vi.advanceTimersByTime(60000)
    expect(wsInstance.sent.length).toBe(n)                             // 定时器已清:零新增
  })
})
