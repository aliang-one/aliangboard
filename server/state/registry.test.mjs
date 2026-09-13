// server/state/registry.test.mjs
// 登记处(统一轴向户口本):登记/快照聚合/值永不离开进程(红线:describe 只回聚合值)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerState, stateSnapshot, _clearRegistryForTest } from './registry.mjs'

test('登记与快照:按 domain/name 排序,describe 聚合值入快照', () => {
  _clearRegistryForTest()
  registerState({ name: 'zzStore', domain: 'auth', primitive: 'ttl', describe: () => ({ entries: 3 }) })
  registerState({ name: 'aaStore', domain: 'ssh', primitive: 'registered', describe: () => ({ ATTACHED: 1 }) })
  const snap = stateSnapshot()
  assert.equal(snap.length, 2)
  assert.equal(snap[0].name, 'zzStore')            // domain 'auth' < 'ssh'
  assert.equal(snap[0].entries, 3)
  assert.equal(snap[1].ATTACHED, 1)
})

test('重名登记 throw;describe 抛错降级为 {error} 不殃及其他', () => {
  _clearRegistryForTest()
  registerState({ name: 'x', domain: 'd', primitive: 'ttl', describe: () => ({ entries: 1 }) })
  assert.throws(() => registerState({ name: 'x', domain: 'd', primitive: 'ttl', describe: () => ({}) }))
  registerState({ name: 'bad', domain: 'd', primitive: 'ttl', describe: () => { throw new Error('boom') } })
  const snap = stateSnapshot()
  assert.ok(snap.find(s => s.name === 'bad').error.includes('boom'))
})

test('红线:快照输出不含 describe 返回的任何键值本体(只允许聚合字段)', () => {
  _clearRegistryForTest()
  const secret = 'tok_' + 'a'.repeat(40)
  registerState({ name: 's', domain: 'd', primitive: 'ttl', describe: () => ({ entries: 1 }) })
  assert.ok(!JSON.stringify(stateSnapshot()).includes(secret))
})
