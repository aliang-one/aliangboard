// T15 测试:per-key token bucket(burst / refill / 独立)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createRateLimiter } from './rate-limit.mjs'

test('burst: 容量内全放,超容量拒(retryAfter>0)', () => {
  const rl = createRateLimiter({ capacity: 3, refillPerSec: 1 })
  assert.equal(rl.check('k1').allowed, true)
  assert.equal(rl.check('k1').allowed, true)
  assert.equal(rl.check('k1').allowed, true)
  const d = rl.check('k1')
  assert.equal(d.allowed, false, '第 4 次应拒(容量 3)')
  assert.ok(d.retryAfter >= 1, '应有 retryAfter')
})

test('refill: 耗尽后等时间补充 → 再次放行', async () => {
  const rl = createRateLimiter({ capacity: 2, refillPerSec: 100 }) // 高补充率,省测试时间
  rl.check('k1'); rl.check('k1')
  assert.equal(rl.check('k1').allowed, false, '耗尽')
  await new Promise(r => setTimeout(r, 30)) // 30ms × 100/s ≈ 3 token(封顶 capacity)
  assert.equal(rl.check('k1').allowed, true, '补充后放行')
})

test('per-key 独立: A 耗尽不影响 B', () => {
  const rl = createRateLimiter({ capacity: 1, refillPerSec: 1 })
  assert.equal(rl.check('A').allowed, true)
  assert.equal(rl.check('A').allowed, false, 'A 耗尽')
  assert.equal(rl.check('B').allowed, true, 'B 仍有自己的桶')
})

test('reset: 清空所有桶', () => {
  const rl = createRateLimiter({ capacity: 1, refillPerSec: 1 })
  rl.check('A'); rl.check('B')
  assert.equal(rl._size(), 2)
  rl.reset()
  assert.equal(rl._size(), 0)
  // reset 后 A 重新有满桶
  assert.equal(rl.check('A').allowed, true)
})

test('remaining: 递减到 0', () => {
  const rl = createRateLimiter({ capacity: 3, refillPerSec: 0 }) // 不补充,看递减
  assert.equal(rl.check('k').remaining, 2)
  assert.equal(rl.check('k').remaining, 1)
  assert.equal(rl.check('k').remaining, 0)
  assert.equal(rl.check('k').allowed, false)
})
