// SSH 终端 WS handler 契约(2026-09-05 v1.0.25 预推审计 #1/#4 修复批次):
// 此前本文件无任何测试——handler 调用了 service 上不存在的 bindRelease(每开终端必 TypeError,
// SSH 终端全死),且 client.shell 不受 isOwner 门控(冷连接竞态双 shell 覆盖绑定/误杀活会话,
// v1.0.24 的 2026-08-28 守卫在重写中丢失)。本文件用「真 service + 可控假 pool」钉死两条契约。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { createTerminalService } from './terminal-service.mjs'
import { createSshTerminalHandler } from './terminal-handler.mjs'

const CH = { ERROR: 4, STDIN: 1, RESIZE: 2, REPLAY: 6, STDOUT: 1 }
const URL_FOR = tid => new URL(`ws://gw/?serverId=s1&sid=${tid}&cols=80&rows=24`)
const tick = () => new Promise(r => setImmediate(r))

function makeWs() {
  const ws = new EventEmitter()
  ws.frames = []
  ws.closed = false
  ws.send = (type, payload) => ws.frames.push({ type, payload })
  ws.close = () => { ws.closed = true }
  return ws
}

function makeChannel(label) {
  const ch = new EventEmitter()
  ch.label = label
  ch.closed = false
  ch.close = () => { ch.closed = true }
  ch.write = () => {}
  ch.setWindow = () => {}
  ch.stderr = new EventEmitter()
  return ch
}

// 可控池:每次 acquire 挂起一个等待者(模拟最长 15s 的 SSH 握手窗口),测试用 grant(i) 手动放行。
// grant 返回 shell 句柄,回调 fire() 手动触发(真实 SSH 的 shell 建链可达秒级=强杀窗口)。
function makePool() {
  const shells = []
  const waiters = []
  return {
    shells, waiters,
    acquire() {
      return new Promise(resolve => {
        const release = () => { release.called = true }
        release.called = false
        waiters.push({ release, resolve })
      })
    },
    grant(i = 0, { manual = false } = {}) {
      const w = waiters.splice(i, 1)[0]
      if (!w) throw new Error('no pending acquire')
      // shell 句柄在 client.shell() 真被调用时才创建/计数(manual 模式=回调手持不自动 fire)
      const client = {
        _handle: null,
        shell(opts, cb) {
          const ch = makeChannel(`sh${shells.length + 1}`)
          client._handle = { channel: ch, release: w.release, fire(err = null) { queueMicrotask(() => cb(err, ch)) } }
          shells.push(client._handle)
          return client._handle
        },
      }
      w.resolve({ client, release: w.release })
      // 有界轮询:非属主永不调 shell,无上限的 setImmediate 轮询会撑住事件循环使进程无法退出
      const waitShell = () => new Promise(res => { let n = 0; (function check() { if (client._handle) return res(client._handle); if (++n > 200) return res(null); setImmediate(check) })() })
      if (manual) return waitShell()
      return waitShell().then(h => { if (h) h.fire() })
    },
  }
}

function makeHarness() {
  const pool = makePool()
  const service = createTerminalService()
  const handler = createSshTerminalHandler({
    service, sshPool: pool,
    writeAudit: () => {},
    wsSend: (ws, type, payload) => ws.send(type, payload),
    lookupServer: id => ({ id }),
    CH,
  })
  return { service, pool, handler }
}

const PS = { userId: 'u1', username: 'u1' }

test('阻断#1 回归:创建分支 bindRelease 把池句柄挂上终端(此前调用不存在的方法,每开终端必 TypeError)', async () => {
  const { service, pool, handler } = makeHarness()
  const ws = makeWs()
  const p = handler(ws, PS, URL_FOR('t1'))
  await tick()
  pool.grant(0)                                        // 放行握手(否则 handler 永远卡在 acquire)
  await p
  const t = service.get('t1')
  assert.ok(t, '终端已建')
  assert.equal(typeof t.release, 'function', '池句柄已挂(bindRelease 契约)')
  assert.equal(pool.shells.length, 1)
  assert.ok(ws.frames.every(f => f.type !== CH.ERROR), '建连无错误帧')
})

test('阻断#4:冷连接竞态——握手窗口内同 sid 第二连接不开第二条 shell,两者附着同一通道', async () => {
  const { service, pool, handler } = makeHarness()
  const wsA = makeWs(), wsB = makeWs()
  const pa = handler(wsA, PS, URL_FOR('t1'))
  await tick()                                          // A:get→null → 卡在 acquire(waiters=[A])
  const pb = handler(wsB, PS, URL_FOR('t1'))
  await tick()                                          // B:同样卡在 acquire(waiters=[A,B])
  pool.grant(1)                                         // 先放行 B:B 的 getOrCreate 创建终端 → 属主 → shell#1
  await pb; await tick()
  pool.grant(0)                                         // 再放行 A:拿到 B 建的既有终端 → 非属主
  await pa; await tick()
  assert.equal(pool.shells.length, 1, '同 sid 全程只有一条 shell')
  const t = service.get('t1')
  assert.equal(t.connIds.size, 2, 'A、B 都附着到同一条 shell')
  assert.equal(wsA.frames.some(f => f.type === CH.ERROR), false, 'A 无错误帧')
})

test('阻断#4 补充:CREATING 窗口期的第二连接排队等 ready,不开 shell', async () => {
  const { service, pool, handler } = makeHarness()
  // 预置:属主已建 CREATING 终端(正在握手/acquire 中,shell 未开)
  const svc = service
  svc.getOrCreate('t9', () => svc.newTerminal({ id: 't9', owner: PS.username, serverId: 's1' }))
  const wsLate = makeWs()
  const pLate = handler(wsLate, PS, URL_FOR('t9'))       // 第二连接:session 已存在(CREATING)
  await tick()
  assert.equal(pool.shells.length, 0, '迟到者不开 shell')
  assert.equal(service.get('t9').waiters, 1, '迟到者已排队等 ready')
  svc.readyForOwner('t9').resolve()                      // 属主侧 ready(真实流程=shell 起来后 resolve)
  await pLate
  assert.equal(service.get('t9').connIds.size, 1, 'ready 后迟到者附着成功')
})

test('评审#2:CREATING 强杀窗口——迟到的 shell 回调关闭新通道,绝不绑上残尸', async () => {
  const { service, pool, handler } = makeHarness()
  const ws = makeWs()
  const p = handler(ws, PS, URL_FOR('t1'))
  await tick()
  const sh = await pool.grant(0, { manual: true })   // 握手归:shell 已创建,但建链回调手持(真实可达秒级)
  await tick()                             // handler 前进到 attach(CREATING)排队等 ready
  const t = service.get('t1')
  assert.equal(t.status, 'CREATING')
  const r = service.close('t1', { force: true })   // admin 强杀正落在建链窗口内
  assert.equal(r.ok, true)
  assert.equal(t.status, 'CLOSED')
  assert.equal(sh.release.called, true, 'releaseBackend 已还池句柄')
  sh.fire()                                // 迟到回调:活通道回来了
  await Promise.race([p, new Promise(r2 => setTimeout(r2, 50))])
  assert.equal(sh.channel.closed, true, '迟到通道被守卫立即关闭(否则永不关闭直至池连接死亡)')
  assert.equal(service.get('t1').channel, null, '残尸身上不得绑定活通道')
  assert.equal(sh.release.called, true, 'release 仍只调一次(评审#1 幂等)')
})
