// server/state/kernel.test.mjs
// ttlStore:过期惰性判(读即删过期项)/值自带 exp 优先/无 exp 按插入时戳/FIFO cap/purgeFuse。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTtlStore } from './kernel.mjs'
import { stateSnapshot } from './registry.mjs'

test('值自带 exp 优先:past-exp 播种读即 miss,事后突变 exp 同样生效(兼容现有票据测试)', () => {
  let t = 1000
  const s = createTtlStore({ name: 't1', domain: 'test', ttlMs: 5000, now: () => t })
  s.set('k', { userId: 'u', exp: 800 })                       // past-exp 播种
  assert.equal(s.has('k'), false)
  s.set('k2', { userId: 'u' })                                // 无 exp → 插入时戳+ttl
  assert.equal(s.has('k2'), true)
  s.get('k2').exp = 1500; t = 1500                            // 事后突变(oidc-routes.test:286 同款)
  assert.equal(s.has('k2'), false, '过期项读即删')
  assert.equal(s.size, 0)
})

test('无 exp 值按插入时戳过期;ttlMs=null 永不过期', () => {
  let t = 0
  const s = createTtlStore({ name: 't2', domain: 'test', ttlMs: 100, now: () => t })
  s.set('a', { v: 1 }); t = 99; assert.equal(s.get('a')?.v, 1)
  t = 100; assert.equal(s.get('a'), undefined, 'now >= exp 即过期')
  const forever = createTtlStore({ name: 't3', domain: 'test', ttlMs: null, now: () => t })
  forever.set('b', { v: 2 }); t = 1e12
  assert.equal(forever.get('b')?.v, 2)
})

test('FIFO cap:超 cap 逐最旧(插入序)', () => {
  const s = createTtlStore({ name: 't4', domain: 'test', ttlMs: null, cap: 2, now: () => 0 })
  s.set('a', {}); s.set('b', {}); s.set('c', {})
  assert.equal(s.size, 2)
  assert.equal(s.has('a'), false, '最旧的 a 被逐')
  assert.equal(s.has('c'), true)
})

test('purgeFuse:超限顺手清过期项(oidcStates 1000 保险丝语义)', () => {
  const s = createTtlStore({ name: 't5', domain: 'test', ttlMs: 60000, purgeFuse: 3, now: () => 0 })
  for (let i = 0; i < 3; i++) s.set(`dead-${i}`, { exp: -1 })
  s.set('live', {})
  assert.equal(s.size, 1, 'dead 全清只留 live')
  assert.equal(s.has('live'), true)
})

test('purgeExpired/snapshot:getdel/del/clear', () => {
  let t = 0
  const s = createTtlStore({ name: 't6', domain: 'test', ttlMs: 100, getdel: true, now: () => t })
  s.set('x', { v: 1 }); s.set('y', { exp: -1 })
  assert.deepEqual(s.snapshot(), { entries: 2, ttlMs: 100, cap: null, purgeFuse: null, expired: 1 })
  assert.equal(s.purgeExpired(), 1)
  assert.equal(s.get('x')?.v, 1)
  assert.equal(s.has('x'), false, 'getdel 读即删')
  s.set('z', {}); s.clear(); assert.equal(s.size, 0)
})

// —— 控制机构 rider(Task 1-2 复审):registry 红线「值不出进程」必须有真测试 ——
test('红线(真):哨兵 token 入 store,stateSnapshot 有计数、无键值本体', () => {
  const secret = 'tok_' + 'x'.repeat(40)
  const s = createTtlStore({ name: 'redlineProbe', domain: 'test', ttlMs: 60000, now: () => 0 })
  s.set(secret, { token: secret, exp: 60000 })
  const json = JSON.stringify(stateSnapshot())
  const probe = JSON.parse(json).find(e => e.name === 'redlineProbe')
  assert.ok(probe, '登记可见')
  assert.equal(probe.entries, 1)
  assert.ok(!json.includes(secret), '键与值本体不得出现在快照')
})
