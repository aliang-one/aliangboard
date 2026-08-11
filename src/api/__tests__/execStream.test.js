import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execStream } from '../client.js'

// Capture the URL the code passes to `new WebSocket(url)` and expose a way to
// deliver inbound frames, so we can assert on the WS contract without a server.
let capturedUrl = ''
let wsInstance = null
class FakeWS {
  constructor(url) { this.url = url; capturedUrl = url; this.readyState = 1; this._l = {}; wsInstance = this }
  set onmessage(fn) { this._l.message = fn }
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

  it('dispatches a type-5 frame to onMode as {persistent}', () => {
    let mode = null
    execStream({ namespace: 'default', pod: 'web', command: 'sh', sid: 't', onMode: m => { mode = m } })
    const payload = new TextEncoder().encode(JSON.stringify({ persistent: true }))
    const frame = new Uint8Array([5, ...payload])
    wsInstance.emit('message', { data: frame.buffer })
    expect(mode).toEqual({ persistent: true })
  })
})
