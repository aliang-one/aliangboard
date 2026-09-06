import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execStream } from '../client.js'

// Capture the URL the code passes to `new WebSocket(url)` and expose a way to
// deliver inbound frames, so we can assert on the WS contract without a server.
let capturedUrl = ''
let wsInstance = null
class FakeWS {
  constructor(url) { this.url = url; capturedUrl = url; this.readyState = 1; this._l = {}; wsInstance = this }
  set onmessage(fn) { this._l.message = fn }
  set onopen(fn) { this._l.open = fn }
  set onclose(fn) { this._l.close = fn }
  set onerror(fn) { this._l.error = fn }
  set binaryType(_) { /* noop */ }
  send() { /* noop */ }
  close() { this.readyState = 3 }
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
