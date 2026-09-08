// 终端 WS 接线契约(connIds 模型,2026-09-05 方案 P1 Task6;2026-09-07 所有权收敛):
// sockets 真值在 TerminalService(terminal.connIds: Map<connId,{socket}>)且**唯一写入者**
// 是 service(service.attach 的 doAttach 登记 / service.detach 摘除+primary 顺延+转 DETACHED);
// wire 只做回放/上行分帧/drop→onDetach 回调,不写 connIds/primary。测试用 attach() 模拟
// service.attach 的登记步骤(doAttach 同款)。broadcast 按 connIds 扇出。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { attachSocketToSession, broadcastToSockets, markAlive, attachWsLiveness, createCloseSentinel, teardownOnOwnerGone } from './terminal-wire.mjs'
import { createRingBuffer } from './terminal-service.mjs'

const STDOUT = 1, RESIZE = 2, REPLAY = 6

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
    ping() {},
    close() {},
  }
}

function fakeSession({ channel } = {}) {
  return { ring: createRingBuffer(), connIds: new Map(), primary: null, channel: channel || null }
}

const decode = buf => ({ type: buf[0], text: buf.subarray(1).toString('utf8') })

// 模拟 service.attach 的 doAttach(登记+primary 置位)——生产接线在 handler 里先于
// attachSocketToSession 调用 service.attach;所有权收敛后 wire 不再做这份登记。
function attach(session, ws, connId = ws) {
  session.connIds.set(connId, { socket: ws, attachedAt: 0 })
  session.primary = ws
}

test('直播帧广播到所有附加 ws(含重连者):重连者先收 ring 快照再进直播', () => {
  const sent = []
  const send = (ws, type, payload) => sent.push([ws, type, payload])
  const session = fakeSession({ channel: { write() {}, setWindow() {} } })

  const ws1 = fakeWs()
  attach(session, ws1)
  attachSocketToSession(ws1, session, { send })
  assert.equal(sent.length, 0)   // 首连 ring 空 → 无回放

  session.ring.push('hello')
  broadcastToSockets(session, send, STDOUT, 'hello')
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], ws1)

  const ws2 = fakeWs()
  attach(session, ws2)
  attachSocketToSession(ws2, session, { send })
  const frames2 = sent.filter(([, t]) => t === REPLAY)
  assert.equal(frames2.length, 1)
  assert.equal(frames2[0][0], ws2)
  assert.equal(frames2[0][2].toString('utf8'), 'hello')

  broadcastToSockets(session, send, STDOUT, 'world')
  const live = sent.filter(([, t]) => t === STDOUT)
  assert.equal(live.length, 3)
  assert.ok(live[0][0] === ws1 && live[1][0] === ws1 && live[2][0] === ws2, '直播帧送达 ws1+ws2')
  assert.equal(live[2][2].toString('utf8'), 'world')
})

test('drop:onDetach 一次(幂等)且 wire 不直写 connIds/primary(清理归 service.detach)', () => {
  let detached = 0
  const send = () => {}
  const session = fakeSession()
  const ws = fakeWs()
  attach(session, ws)   // service.attach 语义登记
  attachSocketToSession(ws, session, { send, connId: ws, onDetach: () => { detached++ } })
  ws.emit('close')
  assert.equal(detached, 1)
  // 所有权:wire 不摘键不顺延——connIds/primary 原样(生产里由 onDetach→service.detach 清理)
  assert.equal(session.connIds.size, 1)
  assert.equal(session.primary, ws)
})

test('STDIN 写 channel 且 touch;RESIZE 仅 primary 生效并 touch', () => {
  const writes = [], windows = []
  const touches = { n: 0 }
  const session = fakeSession({ channel: { write: p => writes.push(p), setWindow: (r, c) => windows.push([r, c]) } })
  const ws = fakeWs()
  attach(session, ws, 'c1')   // 单附着:登记+primary=自己(service.attach 语义)
  attachSocketToSession(ws, session, { send: () => {}, touch: () => { touches.n++ }, connId: 'c1' })

  ws.emit('message', Buffer.concat([Buffer.from([STDOUT]), Buffer.from('ls\n')]))
  assert.deepEqual(writes.map(b => b.toString('utf8')), ['ls\n'])
  assert.equal(touches.n, 1)

  ws.emit('message', Buffer.concat([Buffer.from([RESIZE]), Buffer.from(JSON.stringify({ cols: 120, rows: 40 }))]))
  assert.deepEqual(windows, [[40, 120]])   // rows 在前(ssh2 setWindow(rows, cols, h, w))
  assert.equal(touches.n, 2)               // resize 也是活跃行为,须续期
})

test('error+close 连锁只 onDetach 一次(幂等):多附着计数不被双减', () => {
  let detached = 0
  const send = () => {}
  const session = fakeSession()
  const ws = fakeWs()
  attach(session, ws)
  // onDetach 内做 service.detach 同款清理(演示职责归属:清理由回调方执行)
  attachSocketToSession(ws, session, { send, onDetach: () => { detached++; session.connIds.delete(ws); session.primary = null } })
  ws.emit('error', new Error('boom'))
  ws.emit('close')
  assert.equal(detached, 1, 'error+close 连锁只算一次离开')
  assert.equal(session.connIds.size, 0)   // 由 onDetach 清理,非 wire 直写
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
  const writes = [], windows = []
  const session = fakeSession({ channel: { write: p => writes.push(p), setWindow: (r, c) => windows.push([r, c]) } })
  const send = () => {}
  const ws1 = fakeWs(), ws2 = fakeWs()
  attach(session, ws1)                         // service.attach 语义登记
  attachSocketToSession(ws1, session, { send })
  attach(session, ws2)
  attachSocketToSession(ws2, session, { send })
  // attach() 已置 primary=ws2(最新附着者)
  const resize = (ws, cols, rows) => ws.emit('message', Buffer.concat([Buffer.from([RESIZE]), Buffer.from(JSON.stringify({ cols, rows }))]))
  resize(ws1, 200, 60)
  assert.deepEqual(windows, [])
  resize(ws2, 120, 40)
  assert.deepEqual(windows, [[40, 120]])
  ws1.emit('message', Buffer.concat([Buffer.from([STDOUT]), Buffer.from('x')]))
  assert.deepEqual(writes.map(b => b.toString('utf8')), ['x'])   // 输入不仲裁
})

test('resize 仲裁:primary 断开顺延由 service.detach 完成;wire drop 仅回调 onDetach', () => {
  const windows = []
  const session = fakeSession({ channel: { write() {}, setWindow: (r, c) => windows.push([r, c]) } })
  const send = () => {}
  const ws1 = fakeWs(), ws2 = fakeWs()
  attach(session, ws1)
  attachSocketToSession(ws1, session, { send })
  attach(session, ws2)
  attachSocketToSession(ws2, session, { send })
  ws2.emit('close')                            // wire:仅 onDetach;primary 顺延=service.detach 职责
  session.primary = ws1                        // 模拟 service.detach 顺延后的真值
  ws1.emit('message', Buffer.concat([Buffer.from([RESIZE]), Buffer.from(JSON.stringify({ cols: 150, rows: 50 }))]))
  assert.deepEqual(windows, [[50, 150]])
})

// —— 回放尾部裁剪(2026-09-08 线上事故:4MB ring 全量回放 × 慢客户端 = 60-90s liveness 死亡螺旋)——
// 只回放尾部 maxBytes,行首对齐 + UTF-8 边界回退,杜绝从 ANSI/多字节序列中间起刀。
import { clampReplay } from './terminal-wire.mjs'

test('clampReplay:快照不超限时原样返回(同一 Buffer 引用)', () => {
  const snap = Buffer.from('hello world')
  assert.ok(clampReplay(snap, 1024) === snap)
})

test('clampReplay:超限裁尾并对齐到下一行首(丢弃不完整行)', () => {
  const lines = []
  for (let i = 0; i < 100; i++) lines.push(`line-${String(i).padStart(3, '0')}-padding-padding-padding\n`)
  const snap = Buffer.from(lines.join(''))
  const out = clampReplay(snap, 1024)
  assert.ok(out.length <= 1024, `裁后 ${out.length} 应 <= 1024`)
  const text = out.toString('utf8')
  assert.ok(text.startsWith('line-'), `裁后应从行首开始,实际开头:${JSON.stringify(text.slice(0, 12))}`)
  assert.ok(!text.startsWith('line-000'), '开头若干行应被丢弃')
})

test('clampReplay:尾部无换行时按字节裁剪并回退 UTF-8 续字节(中文不劈半)', () => {
  const head = Buffer.from('x'.repeat(2048))
  const cjk = Buffer.from('汉'.repeat(1024))   // 3072 字节,无换行
  const snap = Buffer.concat([head, cjk])
  const out = clampReplay(snap, 1000)
  assert.ok(out.length <= 1000)
  const text = out.toString('utf8')
  assert.ok(!text.includes('�'), `不得出现替换字符(UTF-8 劈半),实际:${text.slice(0, 5)}`)
  assert.ok(text.endsWith('汉汉汉') || text.endsWith('汉'), '尾部内容保真')
})

test('attachSocketToSession:replayMaxBytes 生效时回放帧含截断提示且不超限;缺省不裁剪', () => {
  const session = fakeSession()
  session.ring.push('z'.repeat(4096))          // 4KB ring
  const sent = []
  const send = (ws, type, payload) => sent.push({ type, payload })

  const ws1 = fakeWs()
  attach(session, ws1)
  attachSocketToSession(ws1, session, { send, replayMaxBytes: 1024 })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, REPLAY)
  assert.ok(sent[0].payload.length <= 1024, `回放帧 ${sent[0].payload.length} 应 <= 1024`)
  assert.ok(sent[0].payload.includes(Buffer.from('回放已截断')), '截断时前置提示')

  const session2 = fakeSession()
  session2.ring.push('z'.repeat(4096))
  const sent2 = []
  const ws2 = fakeWs()
  attach(session2, ws2)
  attachSocketToSession(ws2, session2, { send: (w, t, p) => sent2.push({ type: t, payload: p }) })
  assert.equal(sent2.length, 1)
  assert.equal(sent2[0].payload.length, 4096, '缺省 replayMaxBytes 不裁剪(向后兼容)')
})

// —— WS 关闭原因可观测(2026-09-08 排查盲区:连接被杀时网关侧零日志,谁关的分不清)——
// close 带 code/reason、error 带消息,一行落 stdout;error+close 连锁只记第一因。
test('drop 落一行关闭日志:close 记 code/reason,error 优先记 error(连锁静默)', t => {
  const logs = []
  t.mock.method(console, 'log', (...a) => logs.push(a.join(' ')))
  const send = () => {}
  const session = fakeSession()
  session.id = 'ssh-test-sid'
  const ws = fakeWs()
  attach(session, ws)
  attachSocketToSession(ws, session, { send, onDetach: () => {} })

  ws.emit('close', 1006, Buffer.from('abnormal'))
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes('ssh-test-sid'), `日志应含 sid:${logs[0]}`)
  assert.ok(logs[0].includes('code=1006') && logs[0].includes('abnormal'), `日志应含 close code/reason:${logs[0]}`)

  logs.length = 0
  const ws2 = fakeWs()
  const session2 = fakeSession()
  session2.id = 'ssh-test-sid2'
  attach(session2, ws2)
  attachSocketToSession(ws2, session2, { send, onDetach: () => {} })
  ws2.emit('error', new Error('ECONNRESET boom'))
  ws2.emit('close', 1006, Buffer.from(''))
  assert.equal(logs.length, 1, 'error+close 连锁只记第一因(error)')
  assert.ok(logs[0].includes('ECONNRESET'), `日志应含 error 消息:${logs[0]}`)
})

// —— liveness 终结可观测(2026-09-08 复查#5:terminate 也表现为 1006,与中间层断连不可区分)——
// 默认 onDead 在 terminate 前先落一行元数据日志:terminalId / missedPongs / bufferedAmount,
// 事后 grep 即可回答「是不是网关心跳误杀」。
test('attachWsLiveness 默认 onDead:terminate 前记 terminalId/missedPongs/bufferedAmount', t => {
  const logs = []
  t.mock.method(console, 'log', (...a) => logs.push(a.join(' ')))
  const terminated = []
  const ws = {
    terminalId: 'ssh-liv-1', isAlive: true, missedPongs: 0, bufferedAmount: 4096,
    ping() { ws.isAlive = false },   // 模拟「发出 ping 但永远没有 pong 回来」
    terminate() { terminated.push('yes') },
  }
  const fakeServer = { clients: new Set([ws]) }
  const { sweep, stop } = attachWsLiveness(fakeServer, { intervalMs: 3_600_000 })
  try {
    sweep(); sweep(); sweep()   // 3 轮:置 false→ping / miss=1→reping / miss=2→terminate
    assert.deepEqual(terminated, ['yes'])
    assert.equal(logs.length, 1)
    assert.ok(logs[0].includes('ssh-liv-1') && logs[0].includes('missedPongs=2') && logs[0].includes('buffered=4096'), `元数据齐全:${logs[0]}`)
  } finally { stop() }
})
