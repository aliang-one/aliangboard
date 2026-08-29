// 会话回收策略纯逻辑(spec docs/superpowers/specs/2026-08-29-ssh-session-reap-policy-design.md):
// 表驱动钉死四条件命中/禁用/双时钟口径——尤其「无人附着不受输出续命」的防泄漏语义。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SESSION_POLICY_DEFAULT, isValidMinutes, resolvePolicy, shouldReapSession } from './reap-policy.mjs'

const min = 60000

test('默认策略:detached=10min(现状),attached/maxLifetime=0(禁用)', () => {
  assert.deepEqual(SESSION_POLICY_DEFAULT, { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 })
})

test('isValidMinutes:0–10080 整数合法;负数/小数/非数字/越界非法', () => {
  assert.equal(isValidMinutes(0), true)
  assert.equal(isValidMinutes(10080), true)
  assert.equal(isValidMinutes(-1), false)
  assert.equal(isValidMinutes(1.5), false)
  assert.equal(isValidMinutes('30'), false)
  assert.equal(isValidMinutes(10081), false)
})

test('resolvePolicy:设置值优先;无设置时 detached 走 env SSH_IDLE_REAP_MS;再走内置默认;非法值回落+不抛', () => {
  const warn = []
  const origWarn = console.warn
  console.warn = m => warn.push(String(m))
  try {
    assert.deepEqual(resolvePolicy(() => null, {}), SESSION_POLICY_DEFAULT)
    assert.deepEqual(resolvePolicy(() => null, { SSH_IDLE_REAP_MS: '300000' }), { detachedIdleMin: 5, attachedIdleMin: 0, maxLifetimeMin: 0 })
    assert.deepEqual(resolvePolicy(k => ({ 'ssh.session.detachedIdleMin': '30', 'ssh.session.attachedIdleMin': '15' })[k] ?? null, {}), { detachedIdleMin: 30, attachedIdleMin: 15, maxLifetimeMin: 0 })
    // 非法落库值(手改库):回落默认 + warn 提示,绝不抛
    assert.deepEqual(resolvePolicy(k => ({ 'ssh.session.maxLifetimeMin': 'abc' })[k] ?? null, {}), SESSION_POLICY_DEFAULT)
    assert.ok(warn.some(m => m.includes('maxLifetimeMin')))
  } finally { console.warn = origWarn }
})

test('shouldReapSession:max-lifetime 优先且无条件;0=禁用', () => {
  const s = { createdAt: 0, lastActiveAt: 0, lastOutputAt: 0, browserCount: 1 }
  assert.deepEqual(shouldReapSession(s, { detachedIdleMin: 0, attachedIdleMin: 0, maxLifetimeMin: 60 }, 61 * min), { reap: true, reason: 'max-lifetime' })
  // 恰在阈值内不回收
  assert.equal(shouldReapSession(s, { detachedIdleMin: 0, attachedIdleMin: 0, maxLifetimeMin: 60 }, 60 * min).reap, false)
})

test('shouldReapSession:detached-idle 只看 lastActiveAt——无主忙会话(tail -f 输出续命)X 分钟后照收', () => {
  const s = { createdAt: 0, lastActiveAt: 0, lastOutputAt: 59 * min, browserCount: 0 }   // 一直有输出
  assert.deepEqual(shouldReapSession(s, { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 }, 11 * min), { reap: true, reason: 'detached-idle' })
  // 有浏览器附着时不走 detached 分支
  assert.equal(shouldReapSession({ ...s, browserCount: 1 }, { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 }, 11 * min).reap, false)
})

test('shouldReapSession:attached-idle 看 max(lastActiveAt,lastOutputAt)——看日志/跑构建不误杀,静默挂机会被踢', () => {
  const policy = { detachedIdleMin: 0, attachedIdleMin: 30, maxLifetimeMin: 0 }
  // 输出流动(构建/日志):不回收
  assert.equal(shouldReapSession({ createdAt: 0, lastActiveAt: 0, lastOutputAt: 29 * min, browserCount: 1 }, policy, 30 * min).reap, false)
  // 完全静默(忘关的空终端):回收
  assert.deepEqual(shouldReapSession({ createdAt: 0, lastActiveAt: 0, lastOutputAt: 0, browserCount: 1 }, policy, 31 * min), { reap: true, reason: 'attached-idle' })
  // 输入续命同理
  assert.equal(shouldReapSession({ createdAt: 0, lastActiveAt: 29 * min, lastOutputAt: 0, browserCount: 1 }, policy, 30 * min).reap, false)
})
