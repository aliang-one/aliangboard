import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { TERMINAL_TRANSITIONS, canTransition, createTerminalService } from './terminal-service.mjs'

test('转换表:spec §2 全边存在,非法边不存在', () => {
  assert.deepEqual(canTransition('CREATING', 'ATTACHED'), true)
  assert.deepEqual(canTransition('DETACHED_TIMEOUT', 'ATTACHED'), true)
  assert.deepEqual(canTransition('DETACHED_TIMEOUT', 'CLOSING'), true)
  assert.deepEqual(canTransition('CLOSING', 'DETACHED_TIMEOUT'), true)   // kill 失败回滚
  assert.deepEqual(canTransition('ATTACHED', 'DETACHED_TIMEOUT'), false) // 必须经 DETACHED
  assert.deepEqual(canTransition('CLOSED', 'ATTACHED'), false)
  assert.deepEqual(canTransition('LOST', 'ATTACHED'), false)
})

test('getOrCreate 单飞:同 tid 返回同一对象,factory 只执行一次;状态 CREATING', () => {
  const svc = createTerminalService({ now: () => 1000 })
  let made = 0
  const a = svc.getOrCreate('t1', () => { made++; return svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }) })
  const b = svc.getOrCreate('t1', () => { made++; return svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }) })
  assert.equal(made, 1)
  assert.equal(a.existing, false)
  assert.equal(b.existing, true)
  assert.equal(a.terminal, b.terminal)
  assert.equal(a.terminal.status, 'CREATING')
})

test('newTerminal 默认形状:connIds 空 Map/ring 存在/锚点 null/CREATING', () => {
  const svc = createTerminalService({ now: () => 1000 })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  assert.equal(t.status, 'CREATING')
  assert.equal(t.connIds.size, 0)
  assert.equal(t.detachedSince, null)
  assert.equal(t.backendIdleSince, null)
  assert.ok(typeof t.ring.push === 'function')
})

test('attach CREATING:登记等待者等 ready;ready 后 CREATING→ATTACHED 且 waiters 归零', async () => {
  const svc = createTerminalService({ now: () => 1000 })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  const p = svc.attach('t1', 'c1', { close() {} })
  assert.equal(t.waiters, 1)
  svc.bindChannel('t1', {})
  const ready = svc.readyForOwner('t1')
  ready.resolve()
  const res = await p
  assert.deepEqual(res, { ok: true, status: 'ATTACHED', reason: null })
  assert.equal(t.waiters, 0)
  assert.equal(t.status, 'ATTACHED')
})

test('attach CREATING 中 ready 失败:等待者收到 {ok:false, status:LOST},终端 LOST 且资源释放', async () => {
  const released = []
  const svc = createTerminalService({ now: () => 1000 })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  t.release = () => released.push('pool')
  const p = svc.attach('t1', 'c1', { close() { released.push('ws') } })
  svc.bindChannel('t1', {})
  svc.readyForOwner('t1').reject(new Error('shell failed'))
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.status, 'LOST')
  assert.deepEqual(released, ['pool', 'ws'])
})

test('detach:未知 connId no-op;最后一个 attachment 消失 → DETACHED(detached_since=now);primary 顺延', async () => {
  let clock = 1000
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {})
  svc.readyForOwner('t1').resolve()
  const s1 = { close() {} }, s2 = { close() {} }
  await svc.attach('t1', 'c1', s1); await svc.attach('t1', 'c2', s2)
  clock = 2000
  svc.detach('t1', 'c1')
  assert.equal(t.primary, s2)                    // primary 顺延给剩余 attachment
  svc.detach('t1', 'c1')                         // 幂等:未知 connId no-op
  svc.detach('t1', 'c2', 'ws-close')
  assert.equal(t.status, 'DETACHED')
  assert.equal(t.detachedSince, 2000)
})

test('detach 后重新 attach:DETACHED→ATTACHED 且锚点清空', async () => {
  let clock = 1000
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {}); svc.readyForOwner('t1').resolve()
  await svc.attach('t1', 'c1', { close() {} })
  svc.detach('t1', 'c1'); clock = 5000
  svc.attach('t1', 'c2', { close() {} })
  assert.equal(t.status, 'ATTACHED')
  assert.equal(t.detachedSince, null)
  assert.equal(t.backendIdleSince, null)
})

test('broadcast:到达全部 attachment;markOutput 入 ring', async () => {
  const svc = createTerminalService({ now: () => 1000 })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {}); svc.readyForOwner('t1').resolve()
  const seen = []
  await svc.attach('t1', 'c1', { close() {}, send(type, payload) { seen.push([type, payload]) } })
  svc.markOutput('t1', Buffer.from('hi'))
  svc.broadcast('t1', 9, Buffer.from('x'))
  assert.equal(t.ring.snapshot().toString(), 'hi')
  assert.equal(seen.length, 1)
})
