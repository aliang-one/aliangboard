// server/sa-drift.test.mjs
// 漂移探测契约:托管 key 逐 ns 声明式比对(Role 规则/RoleBinding/CRB)+ per-probe 超时不计入 drift。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { probeSaDrift, stableStringify, platformNames, withTimeout } from './sa-drift.mjs'
import { roleRules } from './sa-provision.mjs'

const KEY = '11111111-2222-3333-4444-555555555555'
const SA_NAME = 'aliangboard-mcp-11111111'
const ROLE = 'aliangboard-mcp-read-11111111'
const managedRow = { id: KEY, tier: 'read', tool_overrides: null, allowed_namespaces: null, boundSA_namespace: 'ns1', boundSA_name: SA_NAME, saManaged: 1 }

// 假 apiserver:path 前缀命中返回 body;未命中抛 404;hang 前缀永不返回(测超时)。
function fakeApi(objects = {}, { hang = [] } = {}) {
  const calls = []
  const requestFn = async (ctx, path) => {
    calls.push(path)
    if (hang.some(p => path.startsWith(p))) await new Promise(() => {})
    const hit = Object.entries(objects).find(([p]) => path.startsWith(p))
    if (!hit) { const e = new Error('not found'); e.status = 404; throw e }
    return { body: hit[1] }
  }
  return { requestFn, calls }
}
const role = { rules: roleRules('read') }
const binding = {
  roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: ROLE },
  subjects: [{ kind: 'ServiceAccount', name: SA_NAME, namespace: 'ns1' }],
}
const GREEN = {
  [`/apis/rbac.authorization.k8s.io/v1/namespaces/ns1/roles/${ROLE}`]: role,
  [`/apis/rbac.authorization.k8s.io/v1/namespaces/ns1/rolebindings/${ROLE}`]: binding,
  '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/aliangboard-mcp-cani-11111111': {},
  '/apis/rbac.authorization.k8s.io/v1/clusterroles/aliangboard-mcp-cani': {},
}

test('stableStringify:对象键与数组元素均排序,顺序不敏感', () => {
  assert.equal(stableStringify({ b: 1, a: [2, 1] }), stableStringify({ a: [1, 2], b: 1 }))
  assert.notEqual(stableStringify({ a: [1, 2] }), stableStringify({ a: [1, 2, 3] }))
})

test('platformNames:三档 Role 名 + cani CR/CRB 名', () => {
  const names = platformNames(KEY)
  for (const t of ['read', 'operator', 'admin']) assert.ok(names.has(`aliangboard-mcp-${t}-11111111`))
  assert.ok(names.has('aliangboard-mcp-cani-11111111'))
  assert.ok(names.has('aliangboard-mcp-cani'))
})

test('托管 key 全绿 → status ok、零 issue', async () => {
  const { requestFn } = fakeApi(GREEN)
  const out = await probeSaDrift({ requestFn, callCtx: { apiServer: 'https://x' } }, { keyRow: managedRow })
  assert.equal(out.status, 'ok')
  assert.equal(out.issues.length, 0)
})

test('rules 顺序不同不算漂移(稳定序列化)', async () => {
  const shuffled = { rules: roleRules('read').map(r => ({ ...r, verbs: [...r.verbs].reverse() })).reverse() }
  const { requestFn } = fakeApi({ ...GREEN, [`/apis/rbac.authorization.k8s.io/v1/namespaces/ns1/roles/${ROLE}`]: shuffled })
  const out = await probeSaDrift({ requestFn, callCtx: { apiServer: 'https://x' } }, { keyRow: managedRow })
  assert.equal(out.status, 'ok')
})

test('Role 缺失 / 规则被改 / binding subjects 错 / CRB 缺失 → 各记一条 drift', async () => {
  const cases = [
    { name: 'role-missing', objects: { ...GREEN, [`/apis/rbac.authorization.k8s.io/v1/namespaces/ns1/roles/${ROLE}`]: undefined } },
    { name: 'role-rules', objects: { ...GREEN, [`/apis/rbac.authorization.k8s.io/v1/namespaces/ns1/roles/${ROLE}`]: { rules: roleRules('read').map((r, i) => i === 0 ? { ...r, verbs: [...r.verbs, 'delete'] } : r) } } },
    { name: 'binding-subjects', objects: { ...GREEN, [`/apis/rbac.authorization.k8s.io/v1/namespaces/ns1/rolebindings/${ROLE}`]: { ...binding, subjects: [{ kind: 'ServiceAccount', name: 'other', namespace: 'ns1' }] } } },
    { name: 'crb-missing', objects: { ...GREEN, '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/aliangboard-mcp-cani-11111111': undefined } },
  ]
  for (const c of cases) {
    const objects = Object.fromEntries(Object.entries(c.objects).filter(([, v]) => v !== undefined))
    const { requestFn } = fakeApi(objects)
    const out = await probeSaDrift({ requestFn, callCtx: { apiServer: 'https://x' } }, { keyRow: managedRow })
    assert.equal(out.status, 'drift', c.name)
    assert.ok(out.issues.some(i => i.type === c.name), `${c.name}: ${JSON.stringify(out.issues)}`)
  }
})

test('探测超时 → probe-error,不计入 drift(status 仍 ok)', async () => {
  const { requestFn } = fakeApi(GREEN, { hang: [`/apis/rbac.authorization.k8s.io/v1/namespaces/ns1/roles/`] })
  const out = await probeSaDrift({ requestFn, callCtx: { apiServer: 'https://x' }, timeoutMs: 50 }, { keyRow: managedRow })
  assert.equal(out.status, 'ok')
  assert.ok(out.issues.some(i => i.type === 'probe-error'))
})

test('withTimeout 直测:值/错误透传,挂死按 ms reject;省略 ms 走默认也不影响即回请求', async () => {
  await withTimeout(Promise.resolve('v'), 50).then(v => assert.equal(v, 'v'))          // 值透传
  await withTimeout(Promise.reject(new Error('boom')), 50).catch(e => assert.equal(e.message, 'boom')) // 错误透传不吞
  await assert.rejects(withTimeout(new Promise(() => {}), 50), /probe timeout after 50ms/) // 挂死 → 超时 reject
  await withTimeout(Promise.resolve(1))                                                  // 默认 ms 参数存在且不延迟即回
})

// —— Task 2 追加测试 ——
const listBody = (items) => ({ items })
const nsListPath = '/apis/rbac.authorization.k8s.io/v1/namespaces/ns1/rolebindings'
const crbListPath = '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'

test('外来 RoleBinding 引用我们的 SA → over(平台命名不误报)', async () => {
  const objects = {
    ...GREEN,
    [nsListPath]: listBody([
      { metadata: { name: ROLE }, subjects: binding.subjects },                        // 平台绑定:不报
      { metadata: { name: 'aliangboard-mcp-11111111-admin' }, subjects: binding.subjects }, // 外来(命名不合规序):报
    ]),
    [crbListPath]: listBody([]),
  }
  const { requestFn } = fakeApi(objects)
  const out = await probeSaDrift({ requestFn, callCtx: { apiServer: 'https://x' } }, { keyRow: managedRow })
  assert.equal(out.status, 'over')
  assert.ok(out.issues.some(i => i.type === 'foreign-binding' && i.name === 'aliangboard-mcp-11111111-admin'))
})

test('外来 ClusterRoleBinding 引用我们的 SA → over', async () => {
  const objects = {
    ...GREEN,
    [nsListPath]: listBody([{ metadata: { name: ROLE }, subjects: binding.subjects }]),
    [crbListPath]: listBody([
      { metadata: { name: 'aliangboard-mcp-cani-11111111' }, subjects: binding.subjects }, // 平台 CRB:不报
      { metadata: { name: 'evil-crb' }, subjects: [{ kind: 'ServiceAccount', name: SA_NAME, namespace: 'ns1' }] },
    ]),
  }
  const { requestFn } = fakeApi(objects)
  const out = await probeSaDrift({ requestFn, callCtx: { apiServer: 'https://x' } }, { keyRow: managedRow })
  assert.equal(out.status, 'over')
  assert.ok(out.issues.some(i => i.type === 'foreign-crb' && i.name === 'evil-crb'))
})

test('BYO:ns 内无绑定引用该 SA → byo-no-binding 计 drift;有 → ok', async () => {
  const byoRow = { ...managedRow, saManaged: 0, boundSA_name: 'nursor-debug' }
  const empty = await probeSaDrift({ requestFn: fakeApi({ [nsListPath]: listBody([]), [crbListPath]: listBody([]) }).requestFn, callCtx: { apiServer: 'https://x' } }, { keyRow: byoRow })
  assert.equal(empty.status, 'drift')
  assert.ok(empty.issues.some(i => i.type === 'byo-no-binding' && i.ns === 'ns1'))
  const bound = await probeSaDrift({
    requestFn: fakeApi({
      [nsListPath]: listBody([{ metadata: { name: 'user-made' }, subjects: [{ kind: 'ServiceAccount', name: 'nursor-debug', namespace: 'ns1' }] }]),
      [crbListPath]: listBody([]),
    }).requestFn, callCtx: { apiServer: 'https://x' },
  }, { keyRow: byoRow })
  assert.equal(bound.status, 'ok')
})

test('shared 去重:同 cluster 两把 key 同 ns,rolebinding list 只发一次', async () => {
  const key2 = { ...managedRow, id: '99999999-2222-3333-4444-555555555555', tier: 'read' }
  const objects = {
    ...GREEN,
    [nsListPath]: listBody([{ metadata: { name: ROLE }, subjects: binding.subjects }]),
    [crbListPath]: listBody([]),
    [`/apis/rbac.authorization.k8s.io/v1/namespaces/ns1/roles/aliangboard-mcp-read-99999999`]: role,
    [`/apis/rbac.authorization.k8s.io/v1/namespaces/ns1/rolebindings/aliangboard-mcp-read-99999999`]: { ...binding, roleRef: { ...binding.roleRef, name: 'aliangboard-mcp-read-99999999' } },
    '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/aliangboard-mcp-cani-99999999': {},
  }
  const { requestFn, calls } = fakeApi(objects)
  const shared = {}
  await probeSaDrift({ requestFn, callCtx: { apiServer: 'https://x' } }, { keyRow: managedRow, shared })
  await probeSaDrift({ requestFn, callCtx: { apiServer: 'https://x' } }, { keyRow: key2, shared })
  // 精确匹配:list 端点路径恰为 nsListPath/crbListPath(无 query 无后缀);startsWith 会误计逐 item GET。
  assert.equal(calls.filter(p => p === nsListPath).length, 1)
  assert.equal(calls.filter(p => p === crbListPath).length, 1)
  assert.equal(calls.filter(p => p === '/apis/rbac.authorization.k8s.io/v1/clusterroles/aliangboard-mcp-cani').length, 1)
})

test('共享 cani ClusterRole 缺失 → crb-missing(所有 key 的 can_i 同坏)', async () => {
  const objects = {
    ...GREEN,
    [nsListPath]: listBody([{ metadata: { name: ROLE }, subjects: binding.subjects }]),
    [crbListPath]: listBody([]),
  }
  delete objects['/apis/rbac.authorization.k8s.io/v1/clusterroles/aliangboard-mcp-cani']
  const { requestFn } = fakeApi(objects)
  const out = await probeSaDrift({ requestFn, callCtx: { apiServer: 'https://x' } }, { keyRow: managedRow })
  assert.equal(out.status, 'drift')
  assert.ok(out.issues.some(i => i.type === 'crb-missing' && i.name === 'aliangboard-mcp-cani'))
})
