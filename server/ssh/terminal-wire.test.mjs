// 终端 WS 广播语义单测(Critical #1 修复的安全网):
// 同一 sid 的多个浏览器 ws 都必须收到 channel 直播帧;重连 ws 先拿 CH_REPLAY 快照再进直播;
// 断开的 ws 不再收到广播。spawn 网关无法模拟真 shell,故对抽出的接线辅助做纯逻辑单测。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { attachSocketToSession, broadcastToSockets } from './terminal-wire.mjs'
import { createRingBuffer } from './terminal-sessions.mjs'

const STDOUT = 1, RESIZE = 2, REPLAY = 6

// 最小 ws 桩:on/off 注册监听,send 收帧
function fakeWs() {
  const listeners = {}
  const frames = []
  return {
    listeners, frames,
    on(ev, fn) { (listeners[ev] ||= []).push(fn) },
    emit(ev, ...args) { for (const fn of listeners[ev] || []) fn(...args) },
    send(buf) { frames.push(buf) },
  }
}

function fakeSession({ channel } = {}) {
  const session = { ring: createRingBuffer(), extra: { sockets: new Set(), channel: channel || null } }
  return session
}

const decode = buf => ({ type: buf[0], text: buf.subarray(1).toString('utf8') })

test('直播帧广播到所有附加 ws(含重连者)', () => {
  const sent = []
  const send = (ws, type, payload) => sent.push([ws, type, payload])
  const session = fakeSession({ channel: { write() {}, setWindow() {} } })

  const ws1 = fakeWs()
  attachSocketToSession(ws1, session, { send })
  assert.equal(sent.length, 0)   // 首连 ring 空 → 无回放

  // channel data 的真实顺序:先入 ring 再广播
  session.ring.push('hello')
  broadcastToSockets(session, send, STDOUT, 'hello')
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], ws1)

  // 刷新重连:第二个 ws 先收快照再进直播
  const ws2 = fakeWs()
  attachSocketToSession(ws2, session, { send })
  const frames2 = sent.filter(([, t]) => t === REPLAY)
  assert.equal(frames2.length, 1)
  assert.equal(frames2[0][0], ws2)
  assert.equal(frames2[0][2].toString('utf8'), 'hello')

  broadcastToSockets(session, send, STDOUT, 'world')
  const live = sent.filter(([, t]) => t === STDOUT)
  // 3 帧直播:'hello'→ws1;'world'→ws1、ws2(两个 ws 都收到,按身份比对)
  assert.equal(live.length, 3)
  assert.ok(live[0][0] === ws1 && live[1][0] === ws1 && live[2][0] === ws2, '直播帧送达 ws1+ws2')
  assert.equal(live[2][2].toString('utf8'), 'world')
})

test('断开的 ws 不再收广播,且触发 onDetach', () => {
  let detached = 0
  const send = () => {}
  const session = fakeSession()
  const ws = fakeWs()
  attachSocketToSession(ws, session, { send, onDetach: () => { detached++ } })
  ws.emit('close')
  assert.equal(detached, 1)
  assert.equal(session.extra.sockets.size, 0)
  let hit = 0
  broadcastToSockets(session, () => { hit++ }, STDOUT, 'x')
  assert.equal(hit, 0)
})

test('STDIN 写 channel 且 touch;RESIZE 映射 setWindow(rows, cols) 且 touch', () => {
  const writes = [], windows = []
  const touches = { n: 0 }
  const session = fakeSession({ channel: { write: p => writes.push(p), setWindow: (r, c) => windows.push([r, c]) } })
  const ws = fakeWs()
  attachSocketToSession(ws, session, { send: () => {}, touch: () => { touches.n++ } })

  ws.emit('message', Buffer.concat([Buffer.from([STDOUT]), Buffer.from('ls\n')]))
  assert.deepEqual(writes.map(b => b.toString('utf8')), ['ls\n'])
  assert.equal(touches.n, 1)

  ws.emit('message', Buffer.concat([Buffer.from([RESIZE]), Buffer.from(JSON.stringify({ cols: 120, rows: 40 }))]))
  assert.deepEqual(windows, [[40, 120]])   // rows 在前(ssh2 setWindow(rows, cols, h, w))
  assert.equal(touches.n, 2)               // resize 也是活跃行为,须续期
})

test('空帧忽略;replay 缺省仅在有内容时发', () => {
  const session = fakeSession()
  const ws = fakeWs()
  const sends = []
  attachSocketToSession(ws, session, { send: (w, t, p) => sends.push(t) })
  ws.emit('message', Buffer.from([]))
  assert.equal(sends.length, 0)
  assert.equal(session.ring.lineCount(), 0)
})
