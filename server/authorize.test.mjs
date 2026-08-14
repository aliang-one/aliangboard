// T5 测试:authorize 策略层 + withPolicy(纯函数,无 db/网络)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  BOUNDED_TOOLS, DANGEROUS_TOOLS, tierTools,
  effectiveTools, normalizeToolOverrides,
  effectiveNamespaces, normalizeAllowedNamespaces,
  authorize, PermissionDeniedError, canIDecision, withPolicy,
} from './authorize.mjs'
import { registry } from './tool-registry.mjs'

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

// --- effectiveTools: 运行时有效工具集(tier ∪ allow − deny,lenient) ---
test('effectiveTools: 无 override = tier 基', () => {
  const s = effectiveTools({ tier: 'read' })
  assert.ok(s.has('get_pod_logs')); assert.ok(!s.has('exec_pod'))
})
test('effectiveTools: allow 越过 tier(operator + exec_pod)', () => {
  const s = effectiveTools({ tier: 'operator', tool_overrides: JSON.stringify({ allow: ['exec_pod'] }) })
  assert.ok(s.has('exec_pod'), 'allow 把 admin 工具加给 operator')
  assert.ok(s.has('scale'), 'tier 基仍保留')
})
test('effectiveTools: deny 从 tier 减(admin − delete_resource)', () => {
  const s = effectiveTools({ tier: 'admin', tool_overrides: JSON.stringify({ deny: ['delete_resource'] }) })
  assert.ok(!s.has('delete_resource')); assert.ok(s.has('exec_pod'))
})
test('effectiveTools: 损坏 JSON → fail-open 到 tier(不空、不锁死 key)', () => {
  const s = effectiveTools({ tier: 'read', tool_overrides: '{not json' })
  assert.ok(s.has('get_pod_logs'))
  assert.equal(effectiveTools({ tier: 'admin', tool_overrides: 'garbage' }).has('exec_pod'), true)
})
test('effectiveTools: 未知 tier → 空(fail-closed 不变)', () => {
  assert.equal(effectiveTools({ tier: 'god' }).size, 0)
  assert.equal(effectiveTools({}).size, 0)
})

// --- normalizeToolOverrides: mint/update 用(strict,坏→抛) ---
test('normalizeToolOverrides: null/空对象 → null;合法 → 规范 JSON 串', () => {
  assert.equal(normalizeToolOverrides(null), null)
  assert.equal(normalizeToolOverrides(undefined), null)
  assert.equal(normalizeToolOverrides({}), null)
  assert.equal(normalizeToolOverrides({ allow: [] }), null)
  assert.equal(normalizeToolOverrides({ allow: ['exec_pod'] }), JSON.stringify({ allow: ['exec_pod'] }))
  assert.equal(normalizeToolOverrides({ deny: ['scale'] }), JSON.stringify({ deny: ['scale'] }))
})
test('normalizeToolOverrides: 校验未知名 / allow∩deny / 坏形状 → 抛', () => {
  assert.throws(() => normalizeToolOverrides({ allow: ['bogus_tool'] }), /未知工具/)
  assert.throws(() => normalizeToolOverrides({ allow: ['exec_pod'], deny: ['exec_pod'] }), /不能同时/)
  assert.throws(() => normalizeToolOverrides('not json'))
  assert.throws(() => normalizeToolOverrides({ allow: 'exec_pod' }), /字符串数组/)  // 非数组
})

// --- effectiveNamespaces: 运行时有效 namespace 集(boundSA ∪ allowed,lenient) ---
test('effectiveNamespaces: 无 allowed → [boundSA]', () => {
  const s = effectiveNamespaces({ boundSA_namespace: 'anydoor' })
  assert.ok(s.has('anydoor')); assert.equal(s.size, 1)
})
test('effectiveNamespaces: boundSA ∪ 额外 ns', () => {
  const s = effectiveNamespaces({ boundSA_namespace: 'anydoor', allowed_namespaces: JSON.stringify(['dev', 'staging']) })
  assert.ok(s.has('anydoor') && s.has('dev') && s.has('staging')); assert.equal(s.size, 3)
})
test('effectiveNamespaces: 损坏 JSON → 回退 [boundSA](fail-open,不锁死)', () => {
  const s = effectiveNamespaces({ boundSA_namespace: 'anydoor', allowed_namespaces: '{bad' })
  assert.ok(s.has('anydoor')); assert.equal(s.size, 1, '损坏回退到单 ns')
})
test('effectiveNamespaces: 数组含非字符串 → 跳过', () => {
  const s = effectiveNamespaces({ boundSA_namespace: 'anydoor', allowed_namespaces: JSON.stringify(['dev', 123]) })
  assert.ok(s.has('dev') && s.has('anydoor') && !s.has('123'))
})
test('normalizeAllowedNamespaces: null → null;valid 额外 ns → JSON 串(不含 boundNS)', () => {
  assert.equal(normalizeAllowedNamespaces(null, 'anydoor'), null)
  assert.equal(normalizeAllowedNamespaces(['dev', 'staging'], 'anydoor'), JSON.stringify(['dev', 'staging']))
})
test('normalizeAllowedNamespaces: boundNS 在输入里 → 剔除(运行时自动并入);dedup', () => {
  assert.equal(normalizeAllowedNamespaces(['anydoor', 'dev'], 'anydoor'), JSON.stringify(['dev']), 'boundNS 不重复存')
  assert.equal(normalizeAllowedNamespaces(['dev', 'dev'], 'anydoor'), JSON.stringify(['dev']), 'dedup')
})
test('normalizeAllowedNamespaces: 非法 ns 名 / 坏形状 → 抛', () => {
  assert.throws(() => normalizeAllowedNamespaces(['Bad_NS'], 'anydoor'), /非法 namespace/)
  assert.throws(() => normalizeAllowedNamespaces(['dev' .repeat(64).slice(0,64)], 'anydoor'), /非法 namespace/, '>63 拒')
  assert.throws(() => normalizeAllowedNamespaces('notarray', 'anydoor'))
  assert.throws(() => normalizeAllowedNamespaces([123], 'anydoor'), /字符串数组/)
})

// --- 守卫:注册表 ↔ authorize 宇宙同步(2026-08-14 审计 P0) ---
// 背景:describe_resource/rollout_status 在 tool-registry/api-key-tools 注册实现,却未登记进
// BOUNDED_TOOLS/DANGEROUS_TOOLS → effectiveTools 全 tier 不含 → MCP tools/list 不广告、tools/call
// 全拒、tool_overrides 也救不了(normalizeToolOverrides 拒未知名),而 agent 系统提示词还在教
// LLM 首选 describe_resource → 死工具 + agent 撞墙。守卫测试防再犯。
test('守卫: tool-registry 全部 k8s 工具 ∈ BOUNDED∪DANGEROUS(注册即可达,无死工具)', () => {
  const universe = new Set([...BOUNDED_TOOLS, ...DANGEROUS_TOOLS])
  const missing = registry.all().filter(t => t.principal === 'k8s' && !universe.has(t.name)).map(t => t.name)
  assert.deepEqual(missing, [], `注册但不在 authorize 宇宙(全 tier 调不了): ${missing.join(',')}`)
})

test('守卫: authorize 宇宙 ⊆ 注册表 k8s 工具 ∪ 显式延后(未知名不悬空)', () => {
  const registered = new Set(registry.all().filter(t => t.principal === 'k8s').map(t => t.name))
  const deferred = new Set(['attach', 'port_forward', 'upload_file']) // spec 文档登记的 3 个延后
  const dangling = [...BOUNDED_TOOLS, ...DANGEROUS_TOOLS].filter(n => !registered.has(n) && !deferred.has(n))
  assert.deepEqual(dangling, [], `宇宙里的名既无实现也无延后登记: ${dangling.join(',')}`)
})

test('守卫: DEFERRED_TOOLS 导出=文档登记的 3 个延后工具(机器可查,不靠注释)', async () => {
  const { DEFERRED_TOOLS } = await import('./authorize.mjs')
  assert.deepEqual([...DEFERRED_TOOLS].sort(), ['attach', 'port_forward', 'upload_file'])
})

test('tierTools: describe_resource/rollout_status ∈ read(此前漏登记=全 tier 死工具)', () => {
  assert.ok(tierTools('read').includes('describe_resource'))
  assert.ok(tierTools('read').includes('rollout_status'))
  assert.equal(authorize({ tier: 'read' }, 'describe_resource').allowed, true)
  assert.equal(authorize({ tier: 'read' }, 'rollout_status').allowed, true)
  assert.equal(authorize({ tier: 'admin' }, 'rollout_status').allowed, true)
})
