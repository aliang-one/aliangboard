// sshTerminalStream 传输错误语义(2026-09-08 复查 P0):
// 浏览器对异常断开的既定事件序是 error → close。若 error 也走组件 onError,组件会先进入
// error 终态、随后 close 被拦截,自动重连被整个吞掉。契约:传输错误只经 onClose 决策;
// onError 仅保留给服务端 CH_ERROR 帧(不可恢复语义)。鉴权探针行为不变。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sshTerminalStream } from '../client.js'

let wsInstance = null
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this._l = {}; wsInstance = this }
  set onmessage(fn) { this._l.message = fn }
  set onopen(fn) { this._l.open = fn }
  set onclose(fn) { this._l.close = fn }
  set onerror(fn) { this._l.error = fn }
  set binaryType(_) { /* noop */ }
  send() { /* noop */ }
  close() { this.readyState = 3 }
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
