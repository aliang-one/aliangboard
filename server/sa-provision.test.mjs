// server/sa-provision.test.mjs
// 托管 SA 供给契约:tier→规则模板、rbacTier 越档提升(overrides)、SSA 幂等供给、回收 404 容忍。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { roleRules, rbacTier, managedSaName, provisionSa, teardownSa, sweepStaleTierBindings } from './sa-provision.mjs'

const KEY = '11111111-2222-3333-4444-555555555555'

test('managedSaName: UUID 前 8 位,dns-label 安全', () => {
  assert.equal(managedSaName(KEY), 'aliangboard-mcp-11111111')
})

test('roleRules: read=只读工具面(pods/log/events/工作负载/网络/secret get);operator=+patch+scale;admin=ns 内全权', () => {
  const read = roleRules('read')
  assert.ok(read.some(r => r.apiGroups.includes('') && r.resources.includes('pods') && r.resources.includes('pods/log') && r.verbs.includes('get')))
  assert.ok(read.some(r => r.resources.includes('secrets') && r.verbs.length === 1 && r.verbs[0] === 'get'))
  assert.ok(read.some(r => r.apiGroups.includes('apps') && r.resources.includes('replicasets')))  // rollout_history 需要
  const op = roleRules('operator')
  assert.ok(op.some(r => r.apiGroups.includes('apps') && r.resources.includes('deployments/scale') && r.verbs.includes('patch')))
  assert.deepEqual(roleRules('admin'), [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }])
})

test('rbacTier: tier 直传;overrides 放行 DANGEROUS 工具 → admin;只放行 scale/restart → operator+', () => {
  assert.equal(rbacTier({ tier: 'read' }), 'read')
  assert.equal(rbacTier({ tier: 'operator' }), 'operator')
  assert.equal(rbacTier({ tier: 'read', tool_overrides: '{"allow":["update_image"]}' }), 'admin')
  assert.equal(rbacTier({ tier: 'read', tool_overrides: '{"allow":["scale"]}' }), 'operator')
})

test('provisionSa: SSA PATCH(fieldManager=aliangboard)+ 标签 + 每 ns Role/RoleBinding + can-i ClusterRole/CRB', async () => {
  const calls = []
  const requestFn = async (ctx, path, init = {}) => { calls.push({ path, init }); return { body: {} } }
  const out = await provisionSa({ requestFn, callCtx: {} }, { keyId: KEY, namespace: 'ns1', name: managedSaName(KEY), tier: 'read', namespaces: ['ns2'] })
  assert.equal(out.ok, true)
  assert.equal(out.total, 7) // SA + 2×(Role+RoleBinding) + ClusterRole + ClusterRoleBinding
  const ssa = calls.filter(c => c.init.method === 'PATCH')
  assert.ok(ssa.every(c => c.path.includes('fieldManager=aliangboard&force=true') && c.init.headers['content-type'] === 'application/apply-patch+yaml'))
  const sa = ssa.find(c => c.path.startsWith('/api/v1/namespaces/ns1/serviceaccounts/'))
  assert.equal(JSON.parse(sa.init.body).metadata.labels['aliangboard.io/api-key'], KEY)
  for (const ns of ['ns1', 'ns2']) {
    assert.ok(ssa.some(c => c.path.startsWith(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/aliangboard-mcp-read-11111111`)), `Role in ${ns}`)
    assert.ok(ssa.some(c => c.path.startsWith(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/aliangboard-mcp-read-11111111`)), `RoleBinding in ${ns}`)
  }
  const crb = ssa.find(c => c.path.startsWith('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/aliangboard-mcp-cani-11111111'))
  const crbBody = JSON.parse(crb.init.body)
  assert.equal(crbBody.roleRef.name, 'aliangboard-mcp-cani')
  assert.equal(crbBody.subjects[0].kind, 'ServiceAccount')
})

test('provisionSa: 部分失败 → {ok:false, failed 带标签},不抛', async () => {
  const requestFn = async (ctx, path, init = {}) => {
    if (path.includes('/clusterrolebindings/')) { const e = new Error('forbidden'); e.status = 403; throw e }
    return { body: {} }
  }
  const out = await provisionSa({ requestFn, callCtx: {} }, { keyId: KEY, namespace: 'ns1', name: 'sa', tier: 'read' })
  assert.equal(out.ok, false)
  assert.equal(out.failed.length, 1)
  assert.equal(out.failed[0].kind, 'ClusterRoleBinding')
})

test('teardownSa: DELETE SA + 三档名 Role/RoleBinding + CRB;共享 ClusterRole 不删;404 视为成功', async () => {
  const calls = []
  const requestFn = async (ctx, path, init = {}) => {
    if (path.endsWith('/namespaces/ns2/roles/aliangboard-mcp-admin-11111111')) { const e = new Error('not found'); e.status = 404; throw e }
    calls.push({ path, init }); return { body: {} }
  }
  const out = await teardownSa({ requestFn, callCtx: {} }, { keyId: KEY, namespace: 'ns1', name: 'sa', tier: 'read', namespaces: ['ns2'] })
  assert.equal(out.errors.length, 0)
  const dels = calls.map(c => c.path)
  assert.ok(dels.includes('/api/v1/namespaces/ns1/serviceaccounts/sa'))
  assert.ok(dels.includes('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/aliangboard-mcp-cani-11111111'))
  for (const t of ['read', 'operator', 'admin']) for (const ns of ['ns1', 'ns2']) {
    if (t === 'admin' && ns === 'ns2') continue // 该路径模拟 404(容忍,不计 errors)
    assert.ok(dels.includes(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/aliangboard-mcp-${t}-11111111`), `${ns} ${t} role`)
    assert.ok(dels.includes(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/aliangboard-mcp-${t}-11111111`), `${ns} ${t} rb`)
  }
  assert.ok(!dels.some(p => p.includes('/clusterroles/aliangboard-mcp-cani')), '共享 ClusterRole 不删')
})

test('sweepStaleTierBindings: keepTier 保留,其余两档 Role/RoleBinding 删;404 容忍', async () => {
  const calls = []
  const requestFn = async (ctx, path, init = {}) => {
    if (path.endsWith('/namespaces/ns2/rolebindings/aliangboard-mcp-operator-11111111')) { const e = new Error('not found'); e.status = 404; throw e }
    calls.push({ path, init }); return { body: {} }
  }
  const out = await sweepStaleTierBindings({ requestFn, callCtx: {} }, { keyId: KEY, namespace: 'ns1', keepTier: 'read', namespaces: ['ns2'] })
  assert.equal(out.errors.length, 0, '404 容忍不计 errors')
  const dels = calls.map(c => c.path)
  for (const t of ['operator', 'admin']) for (const ns of ['ns1', 'ns2']) {
    if (t === 'operator' && ns === 'ns2') continue // 该路径模拟 404
    assert.ok(dels.includes(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/aliangboard-mcp-${t}-11111111`), `${ns} ${t} role`)
    assert.ok(dels.includes(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/aliangboard-mcp-${t}-11111111`), `${ns} ${t} rb`)
  }
  assert.ok(!dels.some(p => p.includes('aliangboard-mcp-read-')), 'keepTier 档不删')
  assert.ok(!dels.some(p => p.includes('serviceaccounts')), 'SA 不在 sweep 范围')
  assert.ok(!dels.some(p => p.includes('clusterrolebindings')), 'CRB 不在 sweep 范围')
})
