import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execStream } from '../client.js'

// Capture the URL the code passes to `new WebSocket(url)` and expose a way to
// deliver inbound frames, so we can assert on the WS contract without a server.
let capturedUrl = ''
let wsInstance = null
class FakeWS {
  constructor(url) { this.url = url; capturedUrl = url; this.readyState = 1; this._l = {}; this.sent = []; this.closeArgs = null; wsInstance = this }
  set onmessage(fn) { this._l.message = fn }
  set onopen(fn) { this._l.open = fn }
  set onclose(fn) { this._l.close = fn }
  set onerror(fn) { this._l.error = fn }
  set binaryType(_) { /* noop */ }
  send(buf) { this.sent.push(new Uint8Array(buf)) }
  close(code, reason) { this.closeArgs = [code, reason]; this.readyState = 3 }
  emit(type, ev) { this._l[type]?.(ev) }
}

describe('execStream', () => {
  beforeEach(() => {
    capturedUrl = ''; wsInstance = null
    globalThis.WebSocket = FakeWS
    globalThis.sessionStorage = { getItem: () => 'tok' }
  })
  afterEach(() => {
    delete globalThis.sessionStorage
    delete globalThis.WebSocket
  })

  it('puts sid into the WS URL when provided', () => {
    execStream({ namespace: 'default', pod: 'web', command: 'sh', sid: 'term-1' })
    expect(capturedUrl).toMatch(/sid=term-1/)
  })

  it('omits sid when not provided (legacy callers stay non-persistent)', () => {
    execStream({ namespace: 'default', pod: 'web', command: 'sh' })
    expect(capturedUrl).not.toMatch(/sid=/)
  })

  it('puts auto=1 into the WS URL when auto is set (server probes best shell)', () => {
    execStream({ namespace: 'default', pod: 'web', command: 'sh', auto: true })
    expect(capturedUrl).toMatch(/auto=1/)
  })

  it('omits auto when not set (manual/ladder shell stays verbatim)', () => {
    execStream({ namespace: 'default', pod: 'web', command: 'bash' })
    expect(capturedUrl).not.toMatch(/auto=/)
  })

  it('dispatches a type-5 frame to onMode as {persistent}', () => {
    let mode = null
    execStream({ namespace: 'default', pod: 'web', command: 'sh', sid: 't', onMode: m => { mode = m } })
    const payload = new TextEncoder().encode(JSON.stringify({ persistent: true }))
    const frame = new Uint8Array([5, ...payload])
    wsInstance.emit('message', { data: frame.buffer })
    expect(mode).toEqual({ persistent: true })
  })
})

// 评审#4(2026-09-06):K8s token 过期时 exec WS 升级被拒,握手失败(未 open 即 close)须
// 触发 onHandshakeFailure——组件借此发廉价探针,让既有 401 拦截器走「清 session→选集群页」恢复。
describe('execStream handshake failure', () => {
  class CloseCodeWS extends FakeWS {
    constructor(url) { super(url); this.readyState = 0 }
    fireOpen() { this.readyState = 1; this._l.open?.() }
    fireClose(code) { this.readyState = 3; this._l.close?.({ code }) }
  }
  beforeEach(() => {
    // 本 describe 是顶层作用域:外层(套着 sessionStorage 桩的)beforeEach 不覆盖到这里
    globalThis.WebSocket = CloseCodeWS
    globalThis.sessionStorage = { getItem: () => 'tok' }
  })
  afterEach(() => {
    delete globalThis.WebSocket
    delete globalThis.sessionStorage
  })

  it('close before open fires onHandshakeFailure with the close code, then onClose', () => {
    const seen = []
    execStream({ namespace: 'd', pod: 'w', command: 'sh',
      onHandshakeFailure: code => seen.push(['hs', code]),
      onClose: () => seen.push(['close']) })
    wsInstance.fireClose(1008)
    expect(seen).toEqual([['hs', 1008], ['close']])
  })

  it('open then close does NOT fire onHandshakeFailure (normal session end)', () => {
    const seen = []
    execStream({ namespace: 'd', pod: 'w', command: 'sh',
      onHandshakeFailure: code => seen.push(['hs', code]),
      onClose: () => seen.push(['close']) })
    wsInstance.fireOpen()
    wsInstance.fireClose(1000)
    expect(seen).toEqual([['close']])
  })
})

// —— 客户端心跳看门狗(2026-09-18,与 sshTerminalStream 同款)——
describe('execStream 心跳看门狗', () => {
  beforeEach(() => {
    capturedUrl = ''; wsInstance = null
    globalThis.WebSocket = FakeWS
    globalThis.sessionStorage = { getItem: () => 'tok' }
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete globalThis.sessionStorage
    delete globalThis.WebSocket
  })

  it('每 15s 发心跳 ping(type 7);pong(type 8)续命;>30s 无 pong → close(4000)', () => {
    execStream({ namespace: 'default', pod: 'web', command: 'sh' })
    vi.advanceTimersByTime(15000)
    expect(wsInstance.sent.filter(f => f[0] === 7)).toHaveLength(1)
    wsInstance.emit('message', { data: new Uint8Array([8]).buffer })
    vi.advanceTimersByTime(15000)
    expect(wsInstance.sent.filter(f => f[0] === 7)).toHaveLength(2)
    vi.advanceTimersByTime(30000)   // 上一 pong 后 45s 无应答
    expect(wsInstance.closeArgs).not.toBeNull()
    expect(wsInstance.closeArgs[0]).toBe(4000)
  })

  it('close 清心跳定时器(不泄漏)', () => {
    execStream({ namespace: 'default', pod: 'web', command: 'sh' })
    wsInstance.emit('close')
    const n = wsInstance.sent.length
    vi.advanceTimersByTime(60000)
    expect(wsInstance.sent.length).toBe(n)
  })
})
