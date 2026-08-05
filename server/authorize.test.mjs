// T5 测试:authorize 策略层 + withPolicy(纯函数,无 db/网络)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  BOUNDED_TOOLS, DANGEROUS_TOOLS, tierTools,
  authorize, PermissionDeniedError, canIDecision, withPolicy,
} from './authorize.mjs'

// --- tier → toolset ---
test('tierTools: read=有界只读;operator=read+scale/restart;admin=全部(含危险);未知=空(fail-closed)', () => {
  const read = tierTools('read')
  const op = tierTools('operator')
  const admin = tierTools('admin')
  assert.ok(read.includes('get_pod_logs') && read.includes('can_i'), 'read 含只读')
  assert.ok(!read.includes('scale') && !read.includes('exec_pod'), 'read 不含 scale/exec')
  assert.ok(op.includes('scale') && op.includes('restart'), 'operator 含 scale/restart')
  assert.ok(!op.includes('exec_pod'), 'operator 不含危险')
  assert.ok(admin.includes('exec_pod') && admin.includes('apply_yaml') && admin.includes('scale'), 'admin 含全部')
  assert.deepEqual(tierTools('god'), [], '未知 tier fail-closed → 空')
})

// --- authorize ---
test('authorize: read 可读、不可 scale/exec', () => {
  const read = { tier: 'read' }
  assert.equal(authorize(read, 'get_pod_logs').allowed, true)
  assert.equal(authorize(read, 'scale').allowed, false)
  assert.equal(authorize(read, 'scale').reason, 'policy')
  assert.equal(authorize(read, 'exec_pod').allowed, false)
})

test('authorize: operator 可 scale(有界写),不可 exec', () => {
  const op = { tier: 'operator' }
  assert.equal(authorize(op, 'scale').allowed, true)
  assert.equal(authorize(op, 'exec_pod').allowed, false)
  assert.equal(authorize(op, 'exec_pod').reason, 'policy')
})

test('authorize: admin 可危险工具', () => {
  const admin = { tier: 'admin' }
  assert.equal(authorize(admin, 'exec_pod').allowed, true)
  assert.equal(authorize(admin, 'apply_yaml').allowed, true)
})

test('authorize: 吊销 / 无 key → revoked(fail-closed)', () => {
  assert.equal(authorize({ tier: 'admin', revokedAt: 123 }, 'get_pod_logs').allowed, false)
  assert.equal(authorize({ tier: 'admin', revokedAt: 123 }, 'get_pod_logs').reason, 'revoked')
  assert.equal(authorize(null, 'get_pod_logs').reason, 'revoked')
})

test('authorize: 未知 tier → policy 拒(fail-closed,不漏放)', () => {
  assert.equal(authorize({ tier: 'god' }, 'get_pod_logs').allowed, false)
  assert.equal(authorize({ tier: 'god' }, 'get_pod_logs').reason, 'policy')
})

// --- PermissionDeniedError ---
test('PermissionDeniedError: code/reason/extra', () => {
  const e = new PermissionDeniedError('policy', { tool: 'exec_pod' })
  assert.equal(e.code, 'PERMISSION_DENIED')
  assert.equal(e.reason, 'policy')
  assert.equal(e.tool, 'exec_pod')
})

// --- canIDecision: policy AND rbac 合取 ---
test('canIDecision: 策略 AND rbac 合取(两者皆真才 allowed)', () => {
  assert.equal(canIDecision(true, true).allowed, true)
  assert.equal(canIDecision(true, false).allowed, false, 'rbac 拒 → 不 allowed')
  assert.equal(canIDecision(false, true).allowed, false, '策略拒 → 不 allowed')
  assert.equal(canIDecision(false, false).allowed, false)
  // 透传分项(AI 能看到是哪边拒)
  assert.deepEqual(canIDecision(true, false), { allowed: false, policy: true, rbac: false })
})

// --- withPolicy ---
test('withPolicy: 允许时调 handler 并透传 ctx/params', async () => {
  const handler = async (ctx, params) => ({ ok: true, ns: ctx.keyRow.boundSA_namespace, pod: params.pod })
  const fn = withPolicy('get_pod_logs', handler)
  const out = await fn({ keyRow: { tier: 'read', boundSA_namespace: 'ns1' } }, { pod: 'p1' })
  assert.deepEqual(out, { ok: true, ns: 'ns1', pod: 'p1' })
})

test('withPolicy: 拒绝时抛 PermissionDeniedError(reason+tool),handler 不被调', async () => {
  let called = false
  const fn = withPolicy('exec_pod', async () => { called = true })
  await assert.rejects(
    () => fn({ keyRow: { tier: 'read' } }, {}),
    (err) => { assert.equal(err.code, 'PERMISSION_DENIED'); assert.equal(err.reason, 'policy'); assert.equal(err.tool, 'exec_pod'); return true }
  )
  assert.equal(called, false, '拒绝时 handler 不应被调')
})

test('withPolicy: 吊销 key → revoked 拒', async () => {
  const fn = withPolicy('get_pod_logs', async () => 'should-not-run')
  await assert.rejects(() => fn({ keyRow: { tier: 'admin', revokedAt: 1 } }, {}), (e) => e.reason === 'revoked')
})
