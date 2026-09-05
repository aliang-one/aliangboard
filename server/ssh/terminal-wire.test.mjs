// 终端 WS 广播语义单测(Critical #1 修复的安全网):
// 同一 sid 的多个浏览器 ws 都必须收到 channel 直播帧;重连 ws 先拿 CH_REPLAY 快照再进直播;
// 断开的 ws 不再收到广播。spawn 网关无法模拟真 shell,故对抽出的接线辅助做纯逻辑单测。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { attachSocketToSession, broadcastToSockets, markAlive, attachWsLiveness, createCloseSentinel, teardownOnOwnerGone } from './terminal-wire.mjs'
import { createRingBuffer } from './terminal-sessions.mjs'

const STDOUT = 1, RESIZE = 2, REPLAY = 6

// 最小 ws 桩:on/off 注册监听,send 收帧
function fakeWs() {
  const listeners = {}
  const frames = []
  return {
    listeners, frames,
    on(ev, fn) { (listeners[ev] ||= []).push(fn) },
    once(ev, fn) { const g = (...a) => { this.off?.(ev, g); fn(...a) }; (listeners[ev] ||= []).push(g) },
    off(ev, fn) { const l = listeners[ev]; if (l) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1) } },
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

test('error+close 连锁触发只 detach 一次(幂等):多浏览器会话的 browserCount 不被双减', () => {
  // 真实 ws 库在异常断开时先 emit 'error' 再 emit 'close',drop 若不设防会对同一 socket
  // 减两次 browserCount:两浏览器附着的会话一个出错即被打到 0 → idle 清道夫误杀活会话。
  let detached = 0
  const send = () => {}
  const session = fakeSession()
  const ws = fakeWs()
  attachSocketToSession(ws, session, { send, onDetach: () => { detached++ } })
  ws.emit('error', new Error('boom'))
  ws.emit('close')
  assert.equal(detached, 1, 'error+close 连锁只算一次离开')
  assert.equal(session.extra.sockets.size, 0)
})

test('空帧忽略;replay 缺省仅在有内容时发', () => {
  const session = fakeSession()
  const ws = fakeWs()
  const sends = []
  attachSocketToSession(ws, session, { send: (w, t, p) => sends.push(t) })
  ws.emit('message', Buffer.from([]))
  assert.equal(sends.length, 0)
  assert.equal(session.ring.byteLength(), 0)
})

test('resize 仲裁:仅 primary(最新附着者)的 RESIZE 落 channel;STDIN 不受仲裁', () => {
  // 多浏览器窗口尺寸不同时,共享 pty 若谁都能 resize 就是「最后说话的人赢」——TUI 被反复压扁
  // (2026-09-04 症状2)。仲裁语义对齐 tmux latest:最新附着者定尺寸,其余只看。
  const writes = [], windows = []
  const session = fakeSession({ channel: { write: p => writes.push(p), setWindow: (r, c) => windows.push([r, c]) } })
  const send = () => {}
  const ws1 = fakeWs(), ws2 = fakeWs()
  attachSocketToSession(ws1, session, { send })
  attachSocketToSession(ws2, session, { send })
  const resize = (ws, cols, rows) => ws.emit('message', Buffer.concat([Buffer.from([RESIZE]), Buffer.from(JSON.stringify({ cols, rows }))]))
  resize(ws1, 200, 60)                        // ws1 已非 primary → 忽略
  assert.deepEqual(windows, [])
  resize(ws2, 120, 40)                        // primary 生效
  assert.deepEqual(windows, [[40, 120]])
  ws1.emit('message', Buffer.concat([Buffer.from([STDOUT]), Buffer.from('x')]))
  assert.deepEqual(writes.map(b => b.toString('utf8')), ['x'])   // 输入不仲裁
})

test('resize 仲裁:primary 断开顺延给剩余附着者;全员离开后 resize 不落', () => {
  const windows = []
  const session = fakeSession({ channel: { write() {}, setWindow: (r, c) => windows.push([r, c]) } })
  const send = () => {}
  const ws1 = fakeWs(), ws2 = fakeWs()
  attachSocketToSession(ws1, session, { send })
  attachSocketToSession(ws2, session, { send })
  ws2.emit('close')                           // primary 离开 → ws1 顺延
  ws1.emit('message', Buffer.concat([Buffer.from([RESIZE]), Buffer.from(JSON.stringify({ cols: 150, rows: 50 }))]))
  assert.deepEqual(windows, [[50, 150]])
  ws1.emit('close')
  ws1.emit('message', Buffer.concat([Buffer.from([RESIZE]), Buffer.from(JSON.stringify({ cols: 80, rows: 24 }))]))
  assert.deepEqual(windows, [[50, 150]])      // 已无附着者:不再落
})

// —— WS 存活探测(2026-09-04 事故①)——
// ws 库不感知半开 TCP(合盖/休眠/代理断链不发 close):浏览器静默消失后 drop 不触发,
// browserCount 卡 ≥1 → detached-idle 回收永不生效 → shell+ring+池句柄永久泄漏。
test('WS 存活探测:连续两次未应答 ping 才 onDead(双振,复审 F2);pong 续活;stop 可停', () => {
  const terminated = []
  const clients = new Set()
  // onDead(ws.terminate) 后 ws 库会因 'close' 把连接移出 clients——桩里用 delete 模拟
  const liveness = attachWsLiveness({ clients }, {
    intervalMs: 30000,
    onDead: ws => { terminated.push(ws); clients.delete(ws) },
  })

  const mk = () => { const ws = fakeWs(); ws.ping = () => {}; return ws }
  const good = mk(), bad = mk()
  markAlive(good); markAlive(bad)
  clients.add(good); clients.add(bad)

  liveness.sweep(); good.emit('pong')    // 轮 1:全部 ping → good 按协议回 pong
  liveness.sweep(); good.emit('pong')    // 轮 2:bad 首次漏 pong(missed=1,双振未满)→ 不杀;good 照常回 pong
  assert.deepEqual(terminated, [])
  liveness.sweep()                       // 轮 3:bad 连续两次未应答(missed=2)→ terminate
  assert.deepEqual(terminated, [bad])
  assert.equal(clients.has(good), true)

  liveness.sweep(); good.emit('pong')    // 轮 4-5:good 每轮 ping 后回 pong,持续不误杀
  liveness.sweep()
  assert.deepEqual(terminated, [bad])
  liveness.stop()
})

test('markAlive:打标是跟踪前提——未 markAlive 的连接没有 pong 监听,两轮后照收(接线必须打标)', () => {
  const terminated = []
  const clients = new Set()
  const liveness = attachWsLiveness({ clients }, { intervalMs: 30000, onDead: ws => terminated.push(ws) })
  const late = fakeWs(); late.ping = () => {}
  clients.add(late)                      // 未 markAlive(isAlive undefined)
  liveness.sweep()                       // 首轮:undefined !== false → 只 ping 不误杀
  assert.deepEqual(terminated, [])
  liveness.sweep()                       // 次轮:missed=1,双振未满
  assert.deepEqual(terminated, [])
  liveness.sweep()                       // 三轮:missed=2 → 收(协议层自动 pong 不经过我们的监听)
  assert.deepEqual(terminated, [late])
  liveness.stop()
})

// —— 入口关闭哨兵(2026-09-04 复审 F1)——
// 建连链路有长 await(池握手 15s/shell 建立/tmux 探测),真正的 close 监听要到最后接线才有
// ——窗口内的关闭事件直接丢失(EventEmitter 不重放),handler 继续走完 → 计数卡死 → 泄漏。
test('close 哨兵:attach 前的 close/error 均置位 gone;幂等;dispose 后不再跟随', () => {
  const ws = fakeWs()
  const sentinel = createCloseSentinel(ws)
  assert.equal(sentinel.gone, false)
  ws.emit('error', new Error('x'))
  assert.equal(sentinel.gone, true)
  ws.emit('close')                       // 幂等:重复事件仍是同一布尔
  assert.equal(sentinel.gone, true)

  const ws2 = fakeWs()
  const s2 = createCloseSentinel(ws2)
  s2.dispose()                           // 接线(drop)接管后拆哨兵
  ws2.emit('close')
  assert.equal(s2.gone, false)
})

test('close 哨兵:close 先于 error 也置位(两事件竞发只走一个布尔)', () => {
  const ws = fakeWs()
  const sentinel = createCloseSentinel(ws)
  ws.emit('close')
  ws.emit('error', new Error('late'))
  assert.equal(sentinel.gone, true)
})


// —— 属主建连断开的处置(复审二 P1)——
test('teardownOnOwnerGone:无人等待才拆;有等待 extra.ready 的重连者则交棒', () => {
  assert.equal(teardownOnOwnerGone(0), true)
  assert.equal(teardownOnOwnerGone(undefined), true)   // 旧会话对象无该字段:视为无人等待
  assert.equal(teardownOnOwnerGone(1), false)
  assert.equal(teardownOnOwnerGone(2), false)
})
