// server/sa-provision.test.mjs
// 托管 SA 供给契约:tier→规则模板、rbacTier 越档提升(overrides)、SSA 幂等供给、回收 404 容忍。
// W2 Phase E(Task 3):组级 RoleBinding 供给(view/operate 两档 + SSRR-create)、teardown、
// grants→绑定计划(groupBindingPlan/keepSet)、漂移清扫(sweepGroupBindings)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { roleRules, rbacTier, managedSaName, provisionSa, teardownSa, sweepStaleTierBindings, sweepNsBindings,
  groupRoleName, groupRoleRules, provisionGroupBindings, teardownGroupBindings, sweepGroupBindings,
  groupBindingPlan, groupBindingKeepSet } from './sa-provision.mjs'

const KEY = '11111111-2222-3333-4444-555555555555'
const GROUP = 'g1g1g1g1-2222-3333-4444-555555555555'
const GROUP2 = 'h2h2h2h2-2222-3333-4444-555555555555'
const SSRR_RULE = { apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectrulesreviews'], verbs: ['create'] }

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

test('sweepNsBindings: ns allowlist 移除 ns 后清残留——指定 ns 三档名 Role/RoleBinding 全删;SA/CRB/保留 ns 不动;404 容忍', async () => {
  const calls = []
  const requestFn = async (ctx, path, init = {}) => {
    if (path.endsWith('/namespaces/gone/rolebindings/aliangboard-mcp-admin-11111111')) { const e = new Error('not found'); e.status = 404; throw e }
    calls.push({ path, init }); return { body: {} }
  }
  const out = await sweepNsBindings({ requestFn, callCtx: {} }, { keyId: KEY, namespaces: ['gone'] })
  assert.equal(out.errors.length, 0, '404 容忍不计 errors')
  const dels = calls.map(c => c.path)
  assert.equal(dels.length, 5, 'gone ns 三档 × Role+RoleBinding = 6 条,其中 1 条 404 不入 calls')
  for (const t of ['read', 'operator']) {
    assert.ok(dels.includes(`/apis/rbac.authorization.k8s.io/v1/namespaces/gone/roles/aliangboard-mcp-${t}-11111111`), `gone ${t} role`)
    assert.ok(dels.includes(`/apis/rbac.authorization.k8s.io/v1/namespaces/gone/rolebindings/aliangboard-mcp-${t}-11111111`), `gone ${t} rb`)
  }
  assert.ok(!dels.some(p => p.includes('/namespaces/ns1/')), '保留 ns 不动')
  assert.ok(!dels.some(p => p.includes('serviceaccounts')), 'SA 不在 sweep 范围')
  assert.ok(!dels.some(p => p.includes('clusterrolebindings')), 'CRB 不在 sweep 范围')
})

// ===== W2 Phase E(Task 3):组级 RoleBinding =====

test('groupRoleName/groupRoleRules:两档命名 + SSRR-create 规则(两档都要——impersonation 探测器以被代理身份打 SSRR)', () => {
  assert.equal(groupRoleName('view', GROUP), 'aliangboard-group-view-g1g1g1g1')
  assert.equal(groupRoleName('operate', GROUP), 'aliangboard-group-operate-g1g1g1g1')
  const view = groupRoleRules('view')
  const operate = groupRoleRules('operate')
  assert.deepEqual(view.at(-1), SSRR_RULE, 'view 档必含 SSRR-create')
  assert.deepEqual(operate.at(-1), SSRR_RULE, 'operate 档必含 SSRR-create')
  // tier 映射:view → read 模板;operate → operator 模板(只读集 + patch/scale)
  assert.equal(view.length, roleRules('read').length + 1)
  assert.equal(operate.length, roleRules('operator').length + 1)
  assert.ok(operate.some(r => r.resources?.includes('deployments/scale') && r.verbs?.includes('patch')))
  assert.ok(!view.some(r => r.resources?.includes('deployments/scale')))
})

test('provisionGroupBindings:每 ns Role+RoleBinding(SSA/labels/subjects kind=Group);ns 去重;返回 {ok,created,failed}', async () => {
  const calls = []
  const requestFn = async (ctx, path, init = {}) => { calls.push({ path, init }); return { body: {} } }
  const out = await provisionGroupBindings({ requestFn, callCtx: {} }, { groupId: GROUP, tier: 'view', namespaces: ['ns1', 'ns2', 'ns1'] })
  assert.equal(out.ok, true)
  assert.equal(out.created.length, 4, 'ns1 去重 → 2 ns × (Role+RoleBinding)')
  assert.equal(out.failed.length, 0)
  const ssa = calls.filter(c => c.init.method === 'PATCH')
  assert.ok(ssa.every(c => c.path.includes('fieldManager=aliangboard&force=true') && c.init.headers['content-type'] === 'application/apply-patch+yaml'))
  for (const ns of ['ns1', 'ns2']) {
    const role = ssa.find(c => c.path === `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/aliangboard-group-view-g1g1g1g1?fieldManager=aliangboard&force=true`)
    assert.ok(role, `Role in ${ns}`)
    const roleBody = JSON.parse(role.init.body)
    assert.equal(roleBody.kind, 'Role')
    assert.equal(roleBody.metadata.labels['aliangboard.io/group'], GROUP)
    assert.equal(roleBody.metadata.labels['aliangboard.io/tier'], 'view')
    assert.equal(roleBody.metadata.labels['app.kubernetes.io/managed-by'], 'aliangboard')
    assert.deepEqual(roleBody.rules.at(-1), SSRR_RULE)
    const rb = ssa.find(c => c.path === `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/aliangboard-group-view-g1g1g1g1?fieldManager=aliangboard&force=true`)
    assert.ok(rb, `RoleBinding in ${ns}`)
    const rbBody = JSON.parse(rb.init.body)
    assert.deepEqual(rbBody.subjects, [{ kind: 'Group', name: `aliangboard:team-${GROUP}`, apiGroup: 'rbac.authorization.k8s.io' }])
    assert.equal(rbBody.roleRef.kind, 'Role')
    assert.equal(rbBody.roleRef.name, 'aliangboard-group-view-g1g1g1g1')
    assert.equal(rbBody.metadata.labels['aliangboard.io/group'], GROUP)
  }
  assert.ok(!calls.some(c => c.path.includes('serviceaccounts') || c.path.includes('clusterrole')), '组供给不建 SA/ClusterRole/CRB')
})

test('provisionGroupBindings:409/AlreadyExists 视为已就绪(ok 保 true);其余失败入 failed 不抛', async () => {
  const conflict = async (ctx, path, init = {}) => {
    if (path.includes('/rolebindings/')) { const e = new Error('roles.rbac.authorization.k8s.io "x" already exists'); e.status = 409; throw e }
    return { body: {} }
  }
  const out409 = await provisionGroupBindings({ requestFn: conflict, callCtx: {} }, { groupId: GROUP, tier: 'view', namespaces: ['ns1'] })
  assert.equal(out409.ok, true, '409/already-exists 幂等视为已就绪')
  assert.equal(out409.created.length, 2)
  const forbidden = async (ctx, path, init = {}) => {
    if (path.includes('/roles/')) { const e = new Error('forbidden'); e.status = 403; throw e }
    return { body: {} }
  }
  const out403 = await provisionGroupBindings({ requestFn: forbidden, callCtx: {} }, { groupId: GROUP, tier: 'view', namespaces: ['ns1'] })
  assert.equal(out403.ok, false)
  assert.equal(out403.failed.length, 1)
  assert.equal(out403.failed[0].kind, 'Role')
  assert.equal(out403.failed[0].error, 'forbidden')
})

test('teardownGroupBindings:两档名 Role+RoleBinding 全删(tier 变更残留);404 容忍;namespaces 空则不动', async () => {
  const calls = []
  const requestFn = async (ctx, path, init = {}) => {
    if (path.endsWith('/namespaces/ns2/roles/aliangboard-group-operate-g1g1g1g1')) { const e = new Error('not found'); e.status = 404; throw e }
    calls.push({ path, init }); return { body: {} }
  }
  const out = await teardownGroupBindings({ requestFn, callCtx: {} }, { groupId: GROUP, namespaces: ['ns1', 'ns2'] })
  assert.equal(out.errors.length, 0, '404 容忍')
  const dels = calls.map(c => c.path)
  for (const t of ['view', 'operate']) for (const ns of ['ns1', 'ns2']) {
    if (t === 'operate' && ns === 'ns2') continue
    assert.ok(dels.includes(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/aliangboard-group-${t}-g1g1g1g1`), `${ns} ${t} role`)
    assert.ok(dels.includes(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/aliangboard-group-${t}-g1g1g1g1`), `${ns} ${t} rb`)
  }
  const quiet = await teardownGroupBindings({ requestFn: async (...a) => { calls.push({ path: a[1] }); return { body: {} } }, callCtx: {} }, { groupId: GROUP })
  assert.equal(quiet.deleted.length, 0, 'namespaces 省略 → 跳过(调用方恒传)')
})

test('groupBindingPlan/keepSet:tier=组内最高档(operate>view);ns 去重合并;keepSet 键=ns 值=期望 Role 名集合', () => {
  const rows = [
    { subjectId: GROUP, namespace: 'app', level: 'view' },
    { subjectId: GROUP, namespace: 'ops', level: 'operate' },
    { subjectId: GROUP2, namespace: 'app', level: 'view' },
  ]
  const plan = groupBindingPlan(rows)
  assert.deepEqual(plan.get(GROUP), { tier: 'operate', namespaces: ['app', 'ops'] }, '同组多 ns 取最高档')
  assert.deepEqual(plan.get(GROUP2), { tier: 'view', namespaces: ['app'] })
  const keep = groupBindingKeepSet(rows)
  assert.deepEqual(keep.get('app'), new Set(['aliangboard-group-operate-g1g1g1g1', 'aliangboard-group-view-h2h2h2h2']))
  assert.deepEqual(keep.get('ops'), new Set(['aliangboard-group-operate-g1g1g1g1']))
  assert.deepEqual(groupBindingPlan([]).size, 0)
})

test('sweepGroupBindings:label 选择列 Role/RoleBinding,keep 外删 keep 内留;list 失败记 errors 不删该类;404 容忍', async () => {
  const calls = []
  const clusterItems = {
    [`/apis/rbac.authorization.k8s.io/v1/namespaces/nsA/roles?labelSelector=${encodeURIComponent('app.kubernetes.io/managed-by=aliangboard,aliangboard.io/group')}`]: { items: [
      { metadata: { name: 'aliangboard-group-view-g1g1g1g1' } },   // keep
      { metadata: { name: 'aliangboard-group-operate-g1g1g1g1' } }, // 降档残留 → 删
      // 无组标签的对象本不会出现在 label-selector 过滤后的 list 里 → 永不误删他人 Role
    ] },
    [`/apis/rbac.authorization.k8s.io/v1/namespaces/nsA/rolebindings?labelSelector=${encodeURIComponent('app.kubernetes.io/managed-by=aliangboard,aliangboard.io/group')}`]: { items: [
      { metadata: { name: 'aliangboard-group-operate-g1g1g1g1' } },
    ] },
    [`/apis/rbac.authorization.k8s.io/v1/namespaces/nsB/roles?labelSelector=${encodeURIComponent('app.kubernetes.io/managed-by=aliangboard,aliangboard.io/group')}`]: { items: [
      { metadata: { name: 'aliangboard-group-operate-h2h2h2h2' } },
    ] },
  }
  const requestFn = async (ctx, path, init = {}) => {
    calls.push({ path, init })
    if (init.method === 'DELETE') {
      if (path.endsWith('/namespaces/nsA/roles/aliangboard-group-operate-g1g1g1g1')) { const e = new Error('gone'); e.status = 404; throw e }
      return { body: {} }
    }
    if (clusterItems[path]) return { body: clusterItems[path] }
    if (path.startsWith('/apis/rbac.authorization.k8s.io/v1/namespaces/nsB/rolebindings')) { const e = new Error('boom'); throw e } // nsB list 失败
    return { body: { items: [] } }
  }
  const keep = new Map([['nsA', new Set(['aliangboard-group-view-g1g1g1g1'])], ['nsB', new Set(['aliangboard-group-operate-h2h2h2h2'])]])
  const out = await sweepGroupBindings({ requestFn, callCtx: {} }, { keep })
  // nsA roles:operate 残留 404(容忍不入 errors);nsA rolebindings:operate 残留删成功;
  // nsB roles:operate 在 keep → 不删;nsB rolebindings list 失败 → errors
  assert.equal(out.errors.length, 1)
  assert.equal(out.errors[0].namespace, 'nsB')
  assert.deepEqual(out.deleted, ['/apis/rbac.authorization.k8s.io/v1/namespaces/nsA/rolebindings/aliangboard-group-operate-g1g1g1g1'])
  assert.ok(!calls.some(c => c.init.method === 'DELETE' && c.path.includes('/namespaces/nsB/')), 'list 失败的 ns 不删')
  assert.ok(!calls.some(c => c.init.method === 'DELETE' && c.path.includes('aliangboard-group-view-g1g1g1g1')), 'keep 内不删')
})
