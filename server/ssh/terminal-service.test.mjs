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
