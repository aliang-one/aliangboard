// server/sa-drift.test.mjs
// 漂移探测契约:托管 key 逐 ns 声明式比对(Role 规则/RoleBinding/CRB)+ per-probe 超时不计入 drift。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { probeSaDrift, stableStringify, platformNames } from './sa-drift.mjs'
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
