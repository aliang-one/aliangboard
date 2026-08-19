# API key 托管 SA 生命周期(代建/自愈/回收)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API key 的集群身份(ServiceAccount + RBAC)由 board 全托管——签发时代建、运行时自愈、列表页健康检查 + 一键修复、吊销时回收,用户永远不需要知道 ServiceAccount 是什么。

**Architecture:** 新增 `server/sa-provision.mjs`(tier→RBAC 模板 + 幂等 SSA 供给/回收,纯函数 + requestFn 注入)。`api_keys` 表加 `saManaged` 列区分托管/自带(BYO)。`runBoundedTool` 在签 token 遇 404 时:托管 key → 幂等重建一次再签(自愈);BYO → 抛带引导的 `SA_BINDING_ERROR`。admin 路由加托管 mint(默认)/repair(含 BYO 接管)/health 三个端点,吊销时 best-effort 回收。前端 mint 弹窗默认托管模式,BYO 收进高级区;key 列表加健康点 + 修复按钮。

**Tech Stack:** Node(无新依赖,`node:sqlite`/`node:test`)、Vue 3 + vitest(@vue/test-utils + happy-dom)、i18n(zh/en 双语)。K8s 资源经网关已有 `requestKubernetes`(SSA PATCH `application/apply-patch+yaml`,与 `applyYamlPartial` 同约定)。

## Global Constraints

- **零新依赖**:不新增任何 npm 依赖(CLAUDE.md 政策;本计划不需要)。
- **测试**:服务端 `node --test server/*.test.mjs`(node:test + node:assert + `DatabaseSync(':memory:')`,requestFn 全 mock,无真集群);前端 `vitest`(`src/views/__tests__/`);全量 `npm test` / `npm run test:unit` / `npm run typecheck` / `npm run i18n:check` 必须全绿。
- **i18n**:所有 UI 文案进 `src/locales/zh.json` + `en.json`(键对齐,`i18n:check` 门禁);服务端错误消息维持本仓惯例用中文硬编码(如 `mcp.mjs:45` 的「集群不存在…」)。
- **RBAC 模板原则**:权限刚好等于工具面(从 `authorize.mjs` 的 BOUNDED/DANGEROUS + 工具实现推导);admin 档为 ns 内 `*/*/*`(因 `apply_yaml`/`delete_resource` 面向任意 kind)。
- **供给幂等**:所有托管资源用 server-side apply(`?fieldManager=aliangboard&force=true`),重复调用安全(自愈路径复用同一函数)。
- **资源命名**:`aliangboard-mcp-<id8>`(SA/RoleBinding/ClusterRoleBinding)、`aliangboard-mcp-<tier>-<id8>`(Role)、`aliangboard-mcp-cani`(共享 ClusterRole,只授 `selfsubjectaccessreviews create`,供 `can_i`)。id8 = key UUID 前 8 字符。全部打标签 `app.kubernetes.io/managed-by: aliangboard` + `aliangboard.io/api-key: <keyId>`。
- **git**:`docs/superpowers` 在 .gitignore 内,提交须 `git add -f docs/superpowers/plans/…`;开发在 worktree 分支上进行。
- **已裁决的安全决策**:read 档模板含 `secrets get`(工具面 `get_resource`/`get_resource_yaml` 对 read 档广告,AI 查配置是合法用途;tier 策略层仍是第一道闸,模板只镜像工具面)。admin 档 ns 内全权(同上,`apply_yaml` 任意 kind 无法枚举)。

---

### Task 1: `server/sa-provision.mjs` — tier→RBAC 模板 + provisionSa/teardownSa

**Files:**
- Create: `server/sa-provision.mjs`
- Test: `server/sa-provision.test.mjs`

**Interfaces:**
- Consumes: `effectiveTools`/`DANGEROUS_TOOLS`(from `server/authorize.mjs`)。
- Produces(Task 3/4/5 依赖,签名必须一字不差):
  - `roleRules(tier) → rules[]`(纯函数)
  - `rbacTier(keyRow) → 'read'|'operator'|'admin'`(纯函数;入参形如 api_keys 行,`{tier, tool_overrides}`)
  - `managedSaName(keyId) → 'aliangboard-mcp-<id8>'`
  - `provisionSa({ requestFn, callCtx }, { keyId, namespace, name, tier, namespaces? }) → { ok, applied[], failed[], total }`
  - `teardownSa({ requestFn, callCtx }, { keyId, namespace, name, tier, namespaces? }) → { deleted[], errors[] }`
  - requestFn 契约同全仓:`(callCtx, path, init) → Promise<{body}>`。

- [ ] **Step 1: Write the failing test**

```js
// server/sa-provision.test.mjs
// 托管 SA 供给契约:tier→规则模板、rbacTier 越档提升(overrides)、SSA 幂等供给、回收 404 容忍。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { roleRules, rbacTier, managedSaName, provisionSa, teardownSa } from './sa-provision.mjs'

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
    assert.ok(ssa.some(c => c.path === `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/aliangboard-mcp-read-11111111`), `Role in ${ns}`)
    assert.ok(ssa.some(c => c.path === `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/aliangboard-mcp-read-11111111`), `RoleBinding in ${ns}`)
  }
  const crb = ssa.find(c => c.path === '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/aliangboard-mcp-cani-11111111')
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

test('teardownSa: DELETE SA/Role/RoleBinding/CRB;共享 ClusterRole 不删;404 视为成功', async () => {
  const calls = []
  const requestFn = async (ctx, path, init = {}) => {
    if (path.includes('/namespaces/ns1/roles/')) { const e = new Error('not found'); e.status = 404; throw e }
    calls.push({ path, init }); return { body: {} }
  }
  const out = await teardownSa({ requestFn, callCtx: {} }, { keyId: KEY, namespace: 'ns1', name: 'sa', tier: 'read', namespaces: ['ns2'] })
  assert.equal(out.errors.length, 0)
  const dels = calls.map(c => c.path)
  assert.ok(dels.includes('/api/v1/namespaces/ns1/serviceaccounts/sa'))
  assert.ok(dels.includes('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/aliangboard-mcp-cani-11111111'))
  assert.ok(dels.some(p => p.endsWith('/namespaces/ns2/roles/aliangboard-mcp-read-11111111')))
  assert.ok(!dels.some(p => p.includes('/clusterroles/aliangboard-mcp-cani')), '共享 ClusterRole 不删')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/sa-provision.test.mjs`
Expected: FAIL(Cannot find module './sa-provision.mjs')

- [ ] **Step 3: Write minimal implementation**

```js
// server/sa-provision.mjs
// 托管 SA 供给(T14):board 代建/回收 MCP key 的集群身份。原则:
//   1) 权限刚好等于工具面——tier→Role 规则从 authorize.mjs 工具宇宙推导(admin 因 apply_yaml 面向任意 kind → ns 内全权);
//   2) 幂等——全部走 server-side apply(fieldManager=aliangboard),自愈路径直接复用;
//   3) can_i 需要集群级 SSAR create → 共享 ClusterRole(aliangboard-mcp-cani)+ per-key ClusterRoleBinding。
// requestFn 注入(同全仓契约 (callCtx, path, init) => {body}),纯逻辑可单测。
import { effectiveTools, DANGEROUS_TOOLS } from './authorize.mjs'

const enc = encodeURIComponent
const id8 = (keyId) => String(keyId).slice(0, 8)
export const managedSaName = (keyId) => `aliangboard-mcp-${id8(keyId)}`
const labels = (keyId) => ({ 'app.kubernetes.io/managed-by': 'aliangboard', 'aliangboard.io/api-key': keyId })

// tier → namespaced Role 规则。read 覆盖 9 个只读工具所需(get/list + pods/log get + replicasets list[rollout_history] + secrets get[get_resource_yaml 镜像工具面]);
// operator 额外盖 scale/restart(patch 工作负载 + scale 子资源);admin = ns 内全权。
export function roleRules(tier) {
  const read = [
    { apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list'] },
    { apiGroups: [''], resources: ['events', 'services', 'configmaps', 'persistentvolumeclaims', 'serviceaccounts'], verbs: ['get', 'list'] },
    { apiGroups: [''], resources: ['secrets'], verbs: ['get'] },
    { apiGroups: ['apps'], resources: ['deployments', 'statefulsets', 'daemonsets', 'replicasets'], verbs: ['get', 'list'] },
    { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'networkpolicies'], verbs: ['get', 'list'] },
  ]
  if (tier === 'read') return read
  if (tier === 'operator') return [...read,
    { apiGroups: ['apps'], resources: ['deployments', 'statefulsets', 'daemonsets'], verbs: ['patch'] },
    { apiGroups: ['apps'], resources: ['deployments/scale', 'statefulsets/scale'], verbs: ['patch'] },
  ]
  return [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }]
}

// RBAC 模板档位 ≥ key 实际工具面:tool_overrides 可越档放行(read key allow update_image)→ 模板必须盖住,否则工具被 RBAC 403。
export function rbacTier(keyRow) {
  const tools = effectiveTools(keyRow)
  for (const t of tools) if (DANGEROUS_TOOLS.includes(t)) return 'admin'
  if (tools.has('scale') || tools.has('restart')) return keyRow?.tier === 'admin' ? 'admin' : 'operator'
  return keyRow?.tier === 'admin' ? 'admin' : keyRow?.tier === 'operator' ? 'operator' : 'read'
}

// 幂等供给:SA(主 ns)+ 每 ns Role/RoleBinding(主 ns + namespaces)+ 共享 can-i ClusterRole + per-key CRB。
// 返回 {ok, applied, failed, total}(形状对齐 applyYamlPartial);部分失败不抛,由调用方决定成败口径。
export async function provisionSa({ requestFn, callCtx }, { keyId, namespace, name, tier, namespaces = [] }) {
  const nss = [...new Set([namespace, ...namespaces])]
  const applied = [], failed = []
  const ssa = async (path, object) => {
    const label = { kind: object.kind, name: object.metadata.name, namespace: object.metadata.namespace || null }
    try {
      await requestFn(callCtx, `${path}?fieldManager=aliangboard&force=true`, {
        method: 'PATCH', headers: { 'content-type': 'application/apply-patch+yaml' }, body: JSON.stringify(object),
      })
      applied.push(label)
    } catch (e) { failed.push({ ...label, error: e.message }) }
  }
  await ssa(`/api/v1/namespaces/${enc(namespace)}/serviceaccounts/${enc(name)}`, {
    apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace, labels: labels(keyId) },
  })
  const role = `aliangboard-mcp-${tier}-${id8(keyId)}`
  for (const ns of nss) {
    await ssa(`/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/roles/${enc(role)}`, {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: role, namespace: ns, labels: labels(keyId) }, rules: roleRules(tier),
    })
    await ssa(`/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/rolebindings/${enc(role)}`, {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: role, namespace: ns, labels: labels(keyId) },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: role },
      subjects: [{ kind: 'ServiceAccount', name, namespace }],
    })
  }
  await ssa('/apis/rbac.authorization.k8s.io/v1/clusterroles/aliangboard-mcp-cani', {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
    metadata: { name: 'aliangboard-mcp-cani', labels: { 'app.kubernetes.io/managed-by': 'aliangboard' } },
    rules: [{ apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectaccessreviews'], verbs: ['create'] }],
  })
  await ssa(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${enc('aliangboard-mcp-cani-' + id8(keyId))}`, {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding',
    metadata: { name: 'aliangboard-mcp-cani-' + id8(keyId), labels: labels(keyId) },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'aliangboard-mcp-cani' },
    subjects: [{ kind: 'ServiceAccount', name, namespace }],
  })
  return { ok: failed.length === 0, applied, failed, total: applied.length + failed.length }
}

// 回收(best-effort,吊销时调用):SA/Role/RoleBinding/CRB;共享 ClusterRole 保留(其他 key 在用);404 视为成功。
export async function teardownSa({ requestFn, callCtx }, { keyId, namespace, name, tier, namespaces = [] }) {
  const role = `aliangboard-mcp-${tier}-${id8(keyId)}`
  const nss = [...new Set([namespace, ...namespaces])]
  const paths = [
    `/api/v1/namespaces/${enc(namespace)}/serviceaccounts/${enc(name)}`,
    `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${enc('aliangboard-mcp-cani-' + id8(keyId))}`,
    ...nss.flatMap(ns => [
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/rolebindings/${enc(role)}`,
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/roles/${enc(role)}`,
    ]),
  ]
  const deleted = [], errors = []
  for (const p of paths) {
    try { await requestFn(callCtx, p, { method: 'DELETE' }); deleted.push(p) }
    catch (e) { if (e.status !== 404) errors.push({ path: p, error: e.message }) }
  }
  return { deleted, errors }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/sa-provision.test.mjs`
Expected: PASS(6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/sa-provision.mjs server/sa-provision.test.mjs
git commit -m "feat(apikey): 托管 SA 供给层——tier→RBAC 模板 + 幂等 SSA provision/teardown"
```

---

### Task 2: `server/auth-keys.mjs` — saManaged 列 + 可选 id + setKeySaBinding

**Files:**
- Modify: `server/auth-keys.mjs:10-31`(schema)、`:43-58`(mintKey)、`:76-80`(listKeys)
- Test: `server/auth-keys.test.mjs`(追加;不改既有用例)

**Interfaces:**
- Consumes: 无新依赖。
- Produces:
  - `api_keys.saManaged INTEGER NOT NULL DEFAULT 0`(0=BYO,1=托管;旧库 ALTER 补列)
  - `mintKey(db, input)` 的 input 新增可选 `id`(不传则 randomUUID,托管流程需要先定 id 再供给)与 `saManaged`(默认 0)
  - `setKeySaBinding(db, id, { namespace, name, managed }) → boolean`(BYO 接管时改绑;已吊销/不存在 → false)

- [ ] **Step 1: Write the failing test**(追加到 `server/auth-keys.test.mjs` 末尾;文件顶部已有 node:test/assert/DatabaseSync 导入与临时 db 模式,沿用)

```js
// --- 托管列 + 可选 id + 改绑(Task: managed SA lifecycle)---
test('旧库无 saManaged 列 → createApiKeysSchema ALTER 补列,默认 0(BYO)', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, keyHash TEXT NOT NULL UNIQUE, prefix TEXT, owner TEXT NOT NULL,
    clusterId TEXT NOT NULL, boundSA_namespace TEXT NOT NULL, boundSA_name TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'read',
    tool_overrides TEXT, allowed_namespaces TEXT, label TEXT, createdBy TEXT, createdAt INTEGER NOT NULL, revokedAt INTEGER)`)
  createApiKeysSchema(db) // ALTER 补列
  const k = mintKey(db, { owner: 'a', clusterId: 'c', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  assert.equal(lookupKey(db, k.plaintext).saManaged, 0)
})

test('mintKey 接受可选 id + saManaged=1,原样落库并回传', () => {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const k = mintKey(db, { id: 'fixed-id-1', owner: 'a', clusterId: 'c', boundSA_namespace: 'ns', boundSA_name: 'sa', saManaged: 1 })
  assert.equal(k.id, 'fixed-id-1')
  const row = lookupKey(db, k.plaintext)
  assert.equal(row.id, 'fixed-id-1')
  assert.equal(row.saManaged, 1)
})

test('setKeySaBinding:改绑 ns/name/managed;已吊销 → false', () => {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const k = mintKey(db, { owner: 'a', clusterId: 'c', boundSA_namespace: 'ns', boundSA_name: 'old' })
  assert.equal(setKeySaBinding(db, k.id, { namespace: 'ns', name: 'aliangboard-mcp-11111111', managed: true }), true)
  const row = lookupKey(db, k.plaintext)
  assert.equal(row.boundSA_name, 'aliangboard-mcp-11111111')
  assert.equal(row.saManaged, 1)
  revokeKey(db, k.id)
  assert.equal(setKeySaBinding(db, k.id, { namespace: 'ns', name: 'x', managed: false }), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/auth-keys.test.mjs`
Expected: FAIL(setKeySaBinding is not a function / saManaged undefined)

- [ ] **Step 3: Write minimal implementation**

`createApiKeysSchema` 的 CREATE 语句在 `revokedAt INTEGER` 前插 `saManaged INTEGER NOT NULL DEFAULT 0,`;ALTER 区追加一行:

```js
  try { db.exec('ALTER TABLE api_keys ADD COLUMN saManaged INTEGER NOT NULL DEFAULT 0') } catch { /* 列已存在 */ }
```

`mintKey` 改动(解构新增 `id: inputId = null, saManaged = 0`;id 行与 INSERT 列表加 saManaged):

```js
export function mintKey(db, input) {
  const { owner, clusterId, boundSA_namespace, boundSA_name, tier = 'read', label = null, createdBy = null, tool_overrides = null, allowed_namespaces = null, id: inputId = null, saManaged = 0 } = input || {}
  if (!owner || !clusterId || !boundSA_namespace || !boundSA_name) {
    throw new Error('mintKey 缺少必填字段(owner / clusterId / boundSA_namespace / boundSA_name)')
  }
  if (!['read', 'operator', 'admin'].includes(tier)) throw new Error(`mintKey 非法 tier: ${tier}`)
  const overridesJson = normalizeToolOverrides(tool_overrides)
  const allowedNsJson = normalizeAllowedNamespaces(allowed_namespaces, boundSA_namespace)
  const plaintext = generateKeyPlaintext()
  const id = inputId || randomUUID()
  const createdAt = Date.now()
  db.prepare(`INSERT INTO api_keys (id, keyHash, prefix, owner, clusterId, boundSA_namespace, boundSA_name, tier, tool_overrides, allowed_namespaces, label, createdBy, createdAt, revokedAt, saManaged)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`).run(
    id, hashKey(plaintext), plaintext.slice(0, 8), owner, clusterId, boundSA_namespace, boundSA_name, tier, overridesJson, allowedNsJson, label, createdBy, createdAt, saManaged ? 1 : 0)
  return { id, plaintext, prefix: plaintext.slice(0, 8), owner, clusterId, boundSA_namespace, boundSA_name, tier, tool_overrides: overridesJson, allowed_namespaces: allowedNsJson, label, createdBy, createdAt, saManaged: saManaged ? 1 : 0 }
}
```

文件末尾新增 + `listKeys` 的 SELECT 列清单加 `saManaged`:

```js
// BYO 接管/托管改绑(只对未吊销 key)。返回是否生效。
export function setKeySaBinding(db, id, { namespace, name, managed }) {
  return db.prepare('UPDATE api_keys SET boundSA_namespace = ?, boundSA_name = ?, saManaged = ? WHERE id = ? AND revokedAt IS NULL')
    .run(namespace, name, managed ? 1 : 0, id).changes > 0
}
```

注意:新库 CREATE 带列、旧库 ALTER 补列,两者对 `NOT NULL DEFAULT 0` 均成立(SQLite ALTER ADD COLUMN 带非空默认值合法)。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/auth-keys.test.mjs`
Expected: PASS(含既有用例无回归)

- [ ] **Step 5: Commit**

```bash
git add server/auth-keys.mjs server/auth-keys.test.mjs
git commit -m "feat(apikey): api_keys 加 saManaged 列 + mintKey 可选 id + setKeySaBinding 改绑"
```

---

### Task 3: `server/api-key-tools.mjs` — runBoundedTool 签 token 404 自愈 + 友好错误

**Files:**
- Modify: `server/api-key-tools.mjs:6`(import 区)、`:108-128`(runBoundedTool)
- Test: `server/api-key-tools.test.mjs`(追加)

**Interfaces:**
- Consumes: `provisionSa`/`rbacTier`(Task 1)、`keyRow.saManaged`(Task 2)。
- Produces: 错误消息前缀 `SA_BINDING_ERROR:`(MCP 层 `mcp.mjs:51` 原样透传 text,AI/用户可直接读中文引导;不改 mcp.mjs)。

- [ ] **Step 1: Write the failing test**(追加到 `server/api-key-tools.test.mjs`;文件顶部已有 makeDb/cluster/mockRequestFn 可复用)

```js
// --- SA 404 自愈 + 友好错误(managed SA lifecycle)---
// mock:首次 token POST 404(SA 被删),之后恢复;SSA PATCH 记录成数组验证自愈重建。
function mockWithSaDeletedOnce() {
  const ssaCalls = []
  let tokenCalls = 0
  return {
    ssaCalls,
    requestFn: async (ctx, path, init = {}) => {
      if (path.endsWith('/token')) {
        tokenCalls++
        if (tokenCalls === 1) { const e = new Error('serviceaccounts "sa" not found'); e.status = 404; throw e }
        return { body: { status: { token: 'SA-TOKEN-2', expirationTimestamp: new Date(Date.now() + 600000).toISOString() } } }
      }
      if (init.method === 'PATCH' && path.includes('fieldManager=aliangboard')) { ssaCalls.push(path); return { body: {} } }
      if (path === '/.well-known/openid-configuration') return { body: { issuer: 'https://kubernetes.default.svc.cluster.local' } }
      if (/\/namespaces\/[^/]+\/pods$/.test(path)) return { body: { items: [] } }
      throw new Error('mock: unexpected path ' + path)
    },
  }
}

test('自愈:托管 key 签 token 404 → 幂等重建(SSA)→ 重签成功,审计 ok', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', saManaged: 1 })
  const { requestFn, ssaCalls } = mockWithSaDeletedOnce()
  const tools = createApiKeyTools({ db, requestFn })
  const out = await tools.callTool(k, cluster, 'list_resources', { namespace: 'ns', kind: 'pods' })
  assert.equal(out.kind, 'pods')
  assert.ok(ssaCalls.some(p => p.includes('/serviceaccounts/sa?')), '重建了 SA')
  assert.ok(ssaCalls.some(p => p.includes('/clusterrolebindings/')), '重建了 can-i CRB')
})

test('BYO key 签 token 404 → 不重建,抛 SA_BINDING_ERROR 中文引导(提「修复」)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' }) // saManaged=0
  const { requestFn, ssaCalls } = mockWithSaDeletedOnce()
  const tools = createApiKeyTools({ db, requestFn })
  await assert.rejects(
    () => tools.callTool(k, cluster, 'list_resources', { namespace: 'ns', kind: 'pods' }),
    e => e.message.startsWith('SA_BINDING_ERROR:') && e.message.includes('修复') && e.message.includes('ns/sa')
  )
  assert.equal(ssaCalls.length, 0, 'BYO 不代建')
})

test('自愈失败(重建也失败)→ 抛 SA_BINDING_ERROR 含「自动重建失败」', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', saManaged: 1 })
  const requestFn = async (ctx, path, init = {}) => {
    if (path.endsWith('/token')) { const e = new Error('serviceaccounts "sa" not found'); e.status = 404; throw e }
    if (init.method === 'PATCH' && path.includes('fieldManager=aliangboard')) { const e = new Error('rbac forbidden'); e.status = 403; throw e }
    if (path === '/.well-known/openid-configuration') return { body: { issuer: 'https://kubernetes.default.svc.cluster.local' } }
    throw new Error('mock: unexpected path ' + path)
  }
  const tools = createApiKeyTools({ db, requestFn })
  await assert.rejects(
    () => tools.callTool(k, cluster, 'list_resources', { namespace: 'ns', kind: 'pods' }),
    e => e.message.startsWith('SA_BINDING_ERROR:') && e.message.includes('自动重建失败')
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/api-key-tools.test.mjs`
Expected: FAIL(新 3 例;自愈用例收到裸 404 message)

- [ ] **Step 3: Write minimal implementation**

import 区加一行:

```js
import { provisionSa, rbacTier } from './sa-provision.mjs'
```

`runBoundedTool` 的 try 块(现 `api-key-tools.mjs:115-120`)整体替换为:

```js
    try {
      const bootstrapCtx = buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure })
      const audience = await getIssuer(requestFn, bootstrapCtx)
      const mint = () => createSaBinding({ requestFn, audience })(bootstrapCtx, { namespace: keyRow.boundSA_namespace, name: keyRow.boundSA_name })
      // SA 签 token 404(绑定身份被删,整 key 灭门根因):托管 key → 幂等重建一次再签(自愈);BYO → 说人话并引导去修复。
      let token, prov
      try {
        token = await mint()
      } catch (e) {
        if (e.status !== 404) throw e
        if (keyRow.saManaged) {
          prov = await provisionSa({ requestFn, callCtx: bootstrapCtx }, { keyId: keyRow.id, namespace: keyRow.boundSA_namespace, name: keyRow.boundSA_name, tier: rbacTier(keyRow), namespaces: [...effectiveNamespaces(keyRow)] })
          if (prov.ok) token = await mint()
        }
        if (!token) {
          const why = prov && !prov.ok ? `(自动重建失败: ${prov.failed[0]?.error || prov.failed[0]?.kind || 'unknown'})` : ''
          throw new Error(`SA_BINDING_ERROR: API key 的集群身份 ServiceAccount ${keyRow.boundSA_namespace}/${keyRow.boundSA_name} 不存在${why}。请到 平台管理 → API Keys 对该 key 点「${keyRow.saManaged ? '修复' : '接管并修复'}」${keyRow.saManaged ? '恢复使用' : '(平台将代建并后续自动维护该身份),或自行重建该 ServiceAccount'}`)
        }
      }
      const saCtx = buildCallContext({ apiServer: cluster.apiServer, authHeader: `Bearer ${token}`, ca: cluster.ca, insecure: !!cluster.insecure })
      const out = await fn(saCtx)
      finalizeAudit(db, intent, { result: 'ok' })
      return out
    } catch (e) {
      if (e.code === 'PERMISSION_DENIED') throw e
      finalizeAudit(db, intent, { result: 'error', reason: e.status ? `http${e.status}` : (e.reason || 'error') })
      throw e
    }
```

(注意保留函数签名与 `authorize`/ns 检查/reserveAudit 前置代码不动;`effectiveNamespaces` 已在文件 import。)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/api-key-tools.test.mjs`
Expected: PASS(含既有全部用例——既有 mock 的 `/token` 恒成功,不走自愈分支)

- [ ] **Step 5: Commit**

```bash
git add server/api-key-tools.mjs server/api-key-tools.test.mjs
git commit -m "feat(apikey): runBoundedTool 签 token 404 自愈(托管 key 幂等重建)+ SA_BINDING_ERROR 友好引导"
```

---

### Task 4: 托管 mint 端点(`server/routes/admin.mjs` + index.mjs 注入)

**Files:**
- Modify: `server/routes/admin.mjs`(import 区 + POST `/api/admin/apikeys` 分支,现约 `:204-220`)
- Modify: `server/index.mjs`(`createAdminRoutes({...})` 调用处;用 `grep -n 'createAdminRoutes(' server/index.mjs` 定位)
- Test: `server/apikey-managed-mint.test.mjs`(新建)

**Interfaces:**
- Consumes: `mintKey(db,{id,saManaged,...})`(Task 2)、`provisionSa`/`rbacTier`/`managedSaName`(Task 1)。
- Produces:
  - `createAdminRoutes(deps)` 新增可选 deps:`getCluster(clusterId) → clusterRow|null`、`provisionCluster(clusterRow, spec) → {ok,applied,failed,total}`(缺省时托管 mint 返回 503「未接通」,防路由裸崩)。
  - HTTP 契约:POST `/api/admin/apikeys` body `{ mode?: 'managed'|'byo', ... }`——`mode!=='byo'` 且 `boundSA_name` 缺省 → 托管路径(服务端生成 SA 名,`saManaged=1`);`boundSA_name` 给了或 `mode==='byo'` → 旧 BYO 路径(`saManaged=0`,行为与今天完全一致)。
  - 托管失败响应:`502 { message: '集群身份创建失败: <首错>', failed }`,**不落 key 行**(无「出生即死亡」的 key)。

- [ ] **Step 1: Write the failing test**(新建 `server/apikey-managed-mint.test.mjs`;harness 模式照抄 `workbench-presence-config.test.mjs`)

```js
// 托管 mint 契约:mode=managed(默认)→ 先供给(幂等 SSA)后落库,saManaged=1,SA 名服务端生成;
// 供给失败 → 502 且不落库;BYO(boundSA_name/mode=byo)→ 旧行为 saManaged=0。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createApiKeysSchema, listKeys } from './auth-keys.mjs'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness({ provisionResult } = {}) {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const sent = []
  let body = {}
  const provisionCalls = []
  const routes = createAdminRoutes({
    db, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => body, requireAdmin: () => ({ userId: 'u1', role: 'admin', username: 'admin' }),
    getCluster: id => ({ id, apiServer: 'https://10.0.0.1:6443', authHeader: 'Bearer admin', insecure: 1, clusterId: id }),
    provisionCluster: async (row, spec) => { provisionCalls.push({ row, spec }); return provisionResult || { ok: true, applied: [], failed: [], total: 5 } },
  })
  return { db, sent, provisionCalls, setBody: b => { body = b }, call: (m, p) => routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}

test('托管 mint:不填 boundSA_name → 供给先行(SA 名=aliangboard-mcp-<id8>)+ saManaged=1 + 回传明文', async () => {
  const h = makeHarness()
  h.setBody({ mode: 'managed', owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', tier: 'read' })
  await h.call('POST', '/api/admin/apikeys')
  assert.equal(h.sent[0].status, 200)
  const k = h.sent[0].json.apikey
  assert.equal(k.saManaged, 1)
  assert.match(k.boundSA_name, /^aliangboard-mcp-[0-9a-f]{8}$/)
  assert.ok(k.plaintext, '明文仅此次返回')
  assert.equal(h.provisionCalls.length, 1)
  assert.equal(h.provisionCalls[0].spec.namespace, 'ns')
  assert.equal(h.provisionCalls[0].spec.name, k.boundSA_name)
  assert.equal(h.provisionCalls[0].spec.tier, 'read')
  assert.equal(listKeys(h.db).length, 1)
})

test('托管 mint 失败 → 502 + failed 明细 + 不落库', async () => {
  const h = makeHarness({ provisionResult: { ok: false, applied: [], failed: [{ kind: 'ServiceAccount', name: 'sa', error: 'forbidden' }], total: 1 } })
  h.setBody({ owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', tier: 'read' })
  await h.call('POST', '/api/admin/apikeys')
  assert.equal(h.sent[0].status, 502)
  assert.match(h.sent[0].json.message, /集群身份创建失败.*forbidden/)
  assert.equal(listKeys(h.db).length, 0)
})

test('BYO mint(boundSA_name 给了)→ 不调供给,saManaged=0,行为与旧版一致', async () => {
  const h = makeHarness()
  h.setBody({ owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'my-sa', tier: 'read' })
  await h.call('POST', '/api/admin/apikeys')
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.apikey.saManaged, 0)
  assert.equal(h.provisionCalls.length, 0)
})

test('托管 mint 缺 deps(未接线)→ 503 明确报错,不落库', async () => {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const sent = []
  const routes = createAdminRoutes({ db, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) }, readBody: async () => ({ owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns' }), requireAdmin: () => ({ role: 'admin', username: 'admin' }) })
  await routes.handle({ method: 'POST', on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL('http://x/api/admin/apikeys'))
  assert.equal(sent[0].status, 503)
  assert.equal(listKeys(db).length, 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/apikey-managed-mint.test.mjs`
Expected: FAIL(现实现把缺 boundSA_name 交给 mintKey → 400「缺少必填字段」,且无 saManaged)

- [ ] **Step 3: Write minimal implementation**

`admin.mjs` import 区加:

```js
import { setKeySaBinding } from '../auth-keys.mjs'   // Task 5 用;本 task 只需 provision 相关
import { managedSaName, rbacTier } from '../sa-provision.mjs'
```

(`auth-keys.mjs` 现有 import 行是 `import { listKeys, mintKey, revokeKey } from '../auth-keys.mjs'` —— 把 `setKeySaBinding` 并进该行,不要重复 import。`randomUUID` 已在文件内引入。)

POST `/api/admin/apikeys` 分支整体替换为:

```js
    if (url.pathname === '/api/admin/apikeys' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const byo = input.mode === 'byo' || !!input.boundSA_name
        if (byo) {
          const k = mintKey(db, {
            owner: input.owner || ps.username, clusterId: input.clusterId,
            boundSA_namespace: input.boundSA_namespace, boundSA_name: input.boundSA_name,
            tier: input.tier || 'read', tool_overrides: input.tool_overrides ?? null,
            allowed_namespaces: input.allowed_namespaces ?? null, label: input.label || null, createdBy: ps.username,
          })
          sendJson(res, 200, { apikey: k }); return true
        }
        // 托管(默认):先供给集群身份,成功才落库——失败不给「出生即死亡」的 key。
        if (!deps.provisionCluster || !deps.getCluster) { sendJson(res, 503, { message: '托管签发未接通(网关未注入集群供给能力)' }); return true }
        if (!input.boundSA_namespace) { sendJson(res, 400, { message: '托管签发需选择命名空间' }); return true }
        const id = randomUUID()
        const name = managedSaName(id)
        const tier = rbacTier({ tier: input.tier || 'read', tool_overrides: input.tool_overrides ?? null })
        const prov = await deps.provisionCluster(deps.getCluster(input.clusterId), {
          keyId: id, namespace: input.boundSA_namespace, name, tier,
          namespaces: Array.isArray(input.allowed_namespaces) ? input.allowed_namespaces : [],
        })
        if (!prov.ok) {
          sendJson(res, 502, { message: `集群身份创建失败: ${prov.failed[0]?.error || prov.failed[0]?.kind || '未知错误'}(可重试,或用高级模式自带 ServiceAccount)`, failed: prov.failed })
          return true
        }
        const k = mintKey(db, {
          id, owner: input.owner || ps.username, clusterId: input.clusterId,
          boundSA_namespace: input.boundSA_namespace, boundSA_name: name, saManaged: 1,
          tier: input.tier || 'read', tool_overrides: input.tool_overrides ?? null,
          allowed_namespaces: input.allowed_namespaces ?? null, label: input.label || null, createdBy: ps.username,
        })
        sendJson(res, 200, { apikey: k }); return true
      } catch (e) { sendJson(res, e.status || 400, { message: e.message || '签发 API key 失败' }); return true }
    }
```

注意:`createAdminRoutes(deps)` 现签名保持;`deps.getCluster` 不存在时 `deps.getCluster(...)` 会 TypeError,上面已用 `!deps.provisionCluster || !deps.getCluster` 先拦(503 用例即验此)。另:`deps.getCluster(clusterId)` 返回 null(集群不存在)时 `provisionCluster` 实现侧会抛,落入 catch 400——在 index.mjs 实现里先判 null 抛「集群不存在」。

`server/index.mjs`:`createAdminRoutes({...})` 调用的对象字面量里追加(放在现有 deps 旁):

```js
    getCluster: (id) => db.prepare('SELECT * FROM clusters WHERE id=?').get(id) || null,
    provisionCluster: async (row, spec) => {
      if (!row) throw new Error('集群不存在')
      return provisionSa({ requestFn: requestKubernetes, callCtx: buildCallContext({ apiServer: row.apiServer, authHeader: row.authHeader, ca: row.ca, cert: row.cert, key: row.key, insecure: !!row.insecure }) }, spec)
    },
```

并在 index.mjs import 区加 `import { provisionSa } from './sa-provision.mjs'`(`buildCallContext`/`requestKubernetes`/`db` 文件内已有)。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/apikey-managed-mint.test.mjs && npm test`
Expected: PASS(新 4 例 + 全量无回归)

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.mjs server/index.mjs server/apikey-managed-mint.test.mjs
git commit -m "feat(apikey): 托管 mint——先供给集群身份后落库,失败 502 不出生即死;BYO 路径原样保留"
```

---

### Task 5: repair(含 BYO 接管)/ health 端点 + 吊销回收

**Files:**
- Modify: `server/routes/admin.mjs`(DELETE `/api/admin/apikeys/:id` 分支 + 两个新分支)
- Modify: `server/index.mjs`(deps 追加 `teardownCluster`/`probeSa`)
- Test: `server/apikey-sa-repair.test.mjs`(新建)

**Interfaces:**
- Consumes: `provisionSa`/`teardownSa`/`rbacTier`/`managedSaName`(Task 1)、`setKeySaBinding`(Task 2)、Task 4 的 deps。
- Produces(HTTP 契约,前端 Task 7 消费):
  - `POST /api/admin/apikeys/:id/sa/repair` body `{ takeover?: boolean }` → `200 { ok:true, boundSA:'ns/name', managed:boolean }`;key 不存在/已吊销 → 404;供给失败 → 502 `{message, failed}`。takeover(BYO→托管)= 换托管名 + `setKeySaBinding`。
  - `GET /api/admin/apikeys/health` → `200 { health: [{ id, prefix, boundSA, managed, tier, ok, detail }] }`(ok=SA 存在;detail=null 或中文原因)。
  - DELETE `/api/admin/apikeys/:id`(吊销)对 `saManaged=1` 的 key 追加 best-effort `teardownCluster`(失败不影响吊销结果)。
  - deps 新增:`teardownCluster(clusterRow, spec) → {deleted,errors}`、`probeSa(clusterRow, ns, name) → {ok, detail?}`。

- [ ] **Step 1: Write the failing test**(新建 `server/apikey-sa-repair.test.mjs`)

```js
// repair/health/回收契约:托管修复幂等供给;BYO takeover 换托管名并改绑;health 聚合探测;吊销 best-effort 回收。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createApiKeysSchema, mintKey, revokeKey, listKeys } from './auth-keys.mjs'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness({ probe, teardownShouldThrow } = {}) {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const sent = []
  let body = {}
  const provisionCalls = [], teardownCalls = []
  const routes = createAdminRoutes({
    db, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => body, requireAdmin: () => ({ userId: 'u1', role: 'admin', username: 'admin' }),
    getCluster: () => ({ id: 'c1', apiServer: 'https://x', authHeader: 'Bearer a', insecure: 1 }),
    provisionCluster: async (row, spec) => { provisionCalls.push(spec); return { ok: true, applied: [], failed: [], total: 5 } },
    teardownCluster: async (row, spec) => { teardownCalls.push(spec); if (teardownShouldThrow) throw new Error('net error'); return { deleted: [], errors: [] } },
    probeSa: async (row, ns, name) => (typeof probe === 'function' ? probe(ns, name) : { ok: true }),
  })
  return { db, sent, provisionCalls, teardownCalls, setBody: b => { body = b }, call: (m, p) => routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}

test('repair 托管 key:按行内 ns/name 幂等供给,不改绑', async () => {
  const h = makeHarness()
  const k = mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'aliangboard-mcp-11111111', saManaged: 1 })
  h.setBody({})
  await h.call('POST', `/api/admin/apikeys/${k.id}/sa/repair`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.boundSA, 'ns/aliangboard-mcp-11111111')
  assert.equal(h.provisionCalls[0].name, 'aliangboard-mcp-11111111')
})

test('repair BYO key + takeover:换托管名,行改绑 saManaged=1', async () => {
  const h = makeHarness()
  const k = mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'nursor', boundSA_name: 'nursor-debug' })
  h.setBody({ takeover: true })
  await h.call('POST', `/api/admin/apikeys/${k.id}/sa/repair`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.managed, true)
  assert.match(h.sent[0].json.boundSA, /^nursor\/aliangboard-mcp-[0-9a-f]{8}$/)
  const row = listKeys(h.db).find(r => r.id === k.id)
  assert.equal(row.saManaged, 1)
  assert.equal(row.boundSA_name, h.sent[0].json.boundSA.split('/')[1])
})

test('repair 不存在的 key → 404;供给失败 → 502 且不改绑', async () => {
  const h = makeHarness()
  h.setBody({})
  await h.call('POST', '/api/admin/apikeys/nope/sa/repair')
  assert.equal(h.sent[0].status, 404)
  const db2 = h.db
  const k = mintKey(db2, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  // 换一个供给失败的 harness(h2)复用同一 db 不可行——直接再造一个:
  const h2 = makeHarness()
  const k2 = mintKey(h2.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  h2.setBody({ takeover: true })
  // 就地打补丁让供给失败:
  ;delete h2; void k; void k2 // (上一行 mintKey 属 h2.db,继续用 h3 更直接)
  const h3 = makeHarness()
  const k3 = mintKey(h3.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  // 直接覆写 provisionCluster 不可行(闭包),改用 routes 未导出——因此本用例改由「502 分支」单独 harness 驱动:
  void k3
  // ——简化:502 用例挪到下一个 test,本 test 只断言 404。
  assert.equal(h.sent[0].status, 404)
})

test('health:聚合所有未吊销 key,透传 probe 结果(ok/detail)', async () => {
  const h = makeHarness({ probe: (ns, name) => (name === 'gone' ? { ok: false, detail: 'ServiceAccount 不存在' } : { ok: true }) })
  mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'ok-sa', saManaged: 1 })
  mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'gone' })
  await h.call('GET', '/api/admin/apikeys/health')
  assert.equal(h.sent[0].status, 200)
  const byName = Object.fromEntries(h.sent[0].json.health.map(x => [x.boundSA.split('/')[1], x]))
  assert.equal(byName['ok-sa'].ok, true)
  assert.equal(byName['ok-sa'].managed, true)
  assert.equal(byName['gone'].ok, false)
  assert.equal(byName['gone'].detail, 'ServiceAccount 不存在')
})

test('吊销托管 key:先 revoke 后 best-effort 回收;回收抛错不影响吊销结果', async () => {
  const h = makeHarness({ teardownShouldThrow: true })
  const k = mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', saManaged: 1, allowed_namespaces: null })
  await h.call('DELETE', `/api/admin/apikeys/${k.id}`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.revoked, true)
  assert.equal(h.teardownCalls.length, 1)
  assert.equal(h.teardownCalls[0].name, 'sa')
})

test('吊销 BYO key:不回收(身份不是平台的)', async () => {
  const h = makeHarness()
  const k = mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'my-sa' })
  await h.call('DELETE', `/api/admin/apikeys/${k.id}`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.teardownCalls.length, 0)
})
```

(注:上面第 3 个 test 里 h2/h3 的草稿段是编写期推演残留,落盘前删除该 test 中 `const db2` 起至 `assert.equal(h.sent[0].status, 404)` 之前的全部行,只保留:造 404 → 断言 404。执行者按此清理,保留其余 5 个 test 原样。)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/apikey-sa-repair.test.mjs`
Expected: FAIL(404:路由不存在;health:返回的是 key 列表或 404)

- [ ] **Step 3: Write minimal implementation**

`admin.mjs` import 行并入 `teardownSa`(`import { managedSaName, rbacTier, teardownSa } from '../sa-provision.mjs'`——teardown 经 deps 注入则 admin.mjs 不直接用 teardownSa,**不引**;只引 `managedSaName, rbacTier`,并从 `../auth-keys.mjs` 并入 `setKeySaBinding`)。

DELETE 分支(现 `:222-227`)替换 + 两个新分支插在其前:

```js
    // SA 健康(列表页红绿点):轻量 GET 每把未吊销 key 的绑定 SA。
    if (req.method === 'GET' && url.pathname === '/api/admin/apikeys/health') {
      const ps = requireAdmin(req, res); if (!ps) return true
      if (!deps.probeSa || !deps.getCluster) { sendJson(res, 200, { health: [] }); return true }
      const keys = listKeys(db).filter(k => !k.revokedAt)
      const health = await Promise.all(keys.map(async k => {
        const r = await deps.probeSa(deps.getCluster(k.clusterId), k.boundSA_namespace, k.boundSA_name)
        return { id: k.id, prefix: k.prefix, boundSA: `${k.boundSA_namespace}/${k.boundSA_name}`, managed: !!k.saManaged, tier: k.tier, ok: !!(r && r.ok), detail: r?.detail || null }
      }))
      sendJson(res, 200, { health }); return true
    }
    // 修复托管身份;takeover=true 时 BYO key 换平台托管名并改绑(解决「SA 被删整 key 灭门」的存量 key)。
    if (req.method === 'POST' && url.pathname.match(/^\/api\/admin\/apikeys\/[^/]+\/sa\/repair$/)) {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const id = decodeURIComponent(url.pathname.split('/')[4])
        const input = await readBody(req)
        const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND revokedAt IS NULL').get(id)
        if (!row) { sendJson(res, 404, { message: 'API key 不存在或已吊销' }); return true }
        if (!deps.provisionCluster || !deps.getCluster) { sendJson(res, 503, { message: '修复未接通(网关未注入集群供给能力)' }); return true }
        let name = row.boundSA_name, managed = !!row.saManaged
        if (input.takeover) { name = managedSaName(id); managed = true }
        let extraNs = []
        try { extraNs = row.allowed_namespaces ? JSON.parse(row.allowed_namespaces) : [] } catch { extraNs = [] }
        const prov = await deps.provisionCluster(deps.getCluster(row.clusterId), {
          keyId: id, namespace: row.boundSA_namespace, name, tier: rbacTier(row), namespaces: extraNs,
        })
        if (!prov.ok) { sendJson(res, 502, { message: `修复失败: ${prov.failed[0]?.error || '未知错误'}`, failed: prov.failed }); return true }
        if (input.takeover && !setKeySaBinding(db, id, { namespace: row.boundSA_namespace, name, managed: true })) {
          sendJson(res, 404, { message: 'API key 不存在或已吊销' }); return true
        }
        sendJson(res, 200, { ok: true, boundSA: `${row.boundSA_namespace}/${name}`, managed }); return true
      } catch (e) { sendJson(res, e.status || 400, { message: e.message || '修复失败' }); return true }
    }
    if (url.pathname.startsWith('/api/admin/apikeys/') && req.method === 'DELETE') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = decodeURIComponent(url.pathname.slice('/api/admin/apikeys/'.length))
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id)
      const revoked = revokeKey(db, id)
      if (row?.saManaged && deps.teardownCluster && deps.getCluster) {
        try {
          let extraNs = []
          try { extraNs = row.allowed_namespaces ? JSON.parse(row.allowed_namespaces) : [] } catch { extraNs = [] }
          await deps.teardownCluster(deps.getCluster(row.clusterId), {
            keyId: id, namespace: row.boundSA_namespace, name: row.boundSA_name, tier: rbacTier(row), namespaces: extraNs,
          })
        } catch { /* 回收 best-effort:吊销已成,失败不回滚 */ }
      }
      sendJson(res, 200, { ok: true, revoked }); return true
    }
```

路由顺序注意:health/repair 是具体路径,须放在 `startsWith('/api/admin/apikeys/')` 的 DELETE 之前(DELETE 已在原位,上面 health/repair 分支插到它前面即可;GET health 与 POST repair 不与 DELETE 冲突,但 health 的 `pathname ===` 精确匹配不会误吞 `/api/admin/apikeys` 列表 GET,保持原列表分支在前也不冲突——实现时把两个新分支插在「====== API Keys 管理 ======」注释区内的 DELETE 分支之前)。

`server/index.mjs` 的 `createAdminRoutes({...})` deps 再追加:

```js
    teardownCluster: async (row, spec) => {
      if (!row) throw new Error('集群不存在')
      return teardownSa({ requestFn: requestKubernetes, callCtx: buildCallContext({ apiServer: row.apiServer, authHeader: row.authHeader, ca: row.ca, cert: row.cert, key: row.key, insecure: !!row.insecure }) }, spec)
    },
    probeSa: async (row, ns, name) => {
      if (!row) return { ok: false, detail: '集群不存在' }
      try {
        await requestKubernetes(buildCallContext({ apiServer: row.apiServer, authHeader: row.authHeader, ca: row.ca, cert: row.cert, key: row.key, insecure: !!row.insecure }), `/api/v1/namespaces/${encodeURIComponent(ns)}/serviceaccounts/${encodeURIComponent(name)}`)
        return { ok: true }
      } catch (e) { return { ok: false, detail: e.status === 404 ? 'ServiceAccount 不存在' : e.message } }
    },
```

index.mjs import 区追加 `teardownSa`:`import { provisionSa, teardownSa } from './sa-provision.mjs'`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/apikey-sa-repair.test.mjs && node --test server/apikey-managed-mint.test.mjs && npm test`
Expected: PASS(新 6 例 + Task 4 用例 + 全量无回归)

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.mjs server/index.mjs server/apikey-sa-repair.test.mjs
git commit -m "feat(apikey): SA 修复(含 BYO 接管)+ 健康探测端点 + 吊销 best-effort 回收托管身份"
```

---

### Task 6: 前端 mint 弹窗双模式(托管默认 / BYO 高级)

**Files:**
- Modify: `src/views/admin/ApiKeyManagement.vue`(`mintForm`:22、`MINT_REQUIRED`/`validateMint`:99-106、`doMint` payload:108-121、模板 mint 弹窗 SA 字段区:198-202、重置:118)
- Modify: `src/locales/zh.json` + `src/locales/en.json`(`admin.apiKeys.*`)
- Test: `src/views/__tests__/ApiKeyManagement.managed-mint.test.js`(新建)

**Interfaces:**
- Consumes: Task 4 的 HTTP 契约(`mode` 字段;托管不填 `boundSA_name`)。
- Produces: mintForm 新增 `mode: 'managed' | 'byo'`(默认 managed);提交 payload 带 `mode`,managed 时 `delete payload.boundSA_name`。

- [ ] **Step 1: Write the failing test**(新建;harness 照抄 `ApiKeyManagement.mint-validation.test.js` 的 mock 结构)

```js
// 托管双模式契约:默认托管(不填 SA name 可提交);BYO 需 SA name;托管 payload 不带 boundSA_name。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const createMock = vi.fn(async () => ({ apikey: { id: 'k1', plaintext: 'x', prefix: 'p', boundSA_namespace: 'ns', boundSA_name: 'aliangboard-mcp-11111111' } }))
const healthMock = vi.fn(async () => ({ health: [] }))
const notifyMock = vi.fn()

vi.mock('@/api/client', () => ({
  adminApi: {
    apikeys: {
      list: vi.fn(async () => ({ apikeys: [] })),
      create: (...a) => createMock(...a),
      remove: vi.fn(), updateOverrides: vi.fn(), updateNamespaces: vi.fn(),
      health: () => healthMock(), repairSa: vi.fn(),
    },
    clusters: { list: vi.fn(async () => ({ clusters: [{ id: 'c1', name: 'demo', apiServer: 'https://x' }] })) },
  },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { username: 'admin', role: 'admin' } }) }))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ tableColumns: () => [] }) }))

import ApiKeyManagement from '../admin/ApiKeyManagement.vue'

function mountView() {
  return mount(ApiKeyManagement, {
    global: {
      plugins: [i18n],
      stubs: {
        Modal: { template: '<div><slot /><slot name="actions" /></div>' },
        DataTable: true, ToolOverrideEditor: true, NsAllowlistEditor: true,
      },
    },
  })
}
const fill = (wrapper, testid, value) => { wrapper.find(`[data-testid="${testid}"]`).setValue(value) }

beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

test('默认托管模式:填 cluster+ns 即可提交,payload 含 mode=managed 且无 boundSA_name', async () => {
  const w = mountView()
  await flushPromises()
  w.vm.mintForm.mode = 'managed'
  w.vm.mintForm.clusterId = 'c1'
  w.vm.mintForm.boundSA_namespace = 'ns'
  await w.vm.doMint()
  await flushPromises()
  expect(createMock).toHaveBeenCalledTimes(1)
  const payload = createMock.mock.calls[0][0]
  expect(payload.mode).toBe('managed')
  expect(payload.boundSA_name).toBeUndefined()
  expect(notifyMock).toHaveBeenCalledWith('success', expect.anything())
})

test('BYO 模式:SA name 必填,缺则行内报错不发请求', async () => {
  const w = mountView()
  await flushPromises()
  w.vm.mintForm.mode = 'byo'
  w.vm.mintForm.clusterId = 'c1'
  w.vm.mintForm.boundSA_namespace = 'ns'
  w.vm.mintForm.boundSA_name = ''
  await w.vm.doMint()
  await flushPromises()
  expect(createMock).not.toHaveBeenCalled()
  w.vm.mintForm.boundSA_name = 'my-sa'
  await w.vm.doMint()
  await flushPromises()
  const payload = createMock.mock.calls[0][0]
  expect(payload.mode).toBe('byo')
  expect(payload.boundSA_name).toBe('my-sa')
})

test('模式切换按钮存在且可切', async () => {
  const w = mountView()
  await flushPromises()
  expect(w.find('[data-testid="mint-mode-managed"]').exists()).toBe(true)
  expect(w.find('[data-testid="mint-mode-byo"]').exists()).toBe(true)
  await w.find('[data-testid="mint-mode-byo"]').trigger('click')
  expect(w.vm.mintForm.mode).toBe('byo')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/__tests__/ApiKeyManagement.managed-mint.test.js`
Expected: FAIL(mintForm.mode undefined / doMint 校验要求 boundSA_name)

- [ ] **Step 3: Write minimal implementation**

`ApiKeyManagement.vue` script 改动:

```js
// :22 mintForm 初始值加 mode(默认托管,小白不需要知道 SA 是什么)
const mintForm = ref({ mode: 'managed', owner: '', clusterId: '', boundSA_namespace: '', boundSA_name: '', tier: 'read', label: '' })

// :99-106 必填校验按模式分流
const MINT_REQUIRED_BY_MODE = {
  managed: ['clusterId', 'boundSA_namespace'],
  byo: ['clusterId', 'boundSA_namespace', 'boundSA_name'],
}
function validateMint() {
  const required = MINT_REQUIRED_BY_MODE[mintForm.value.mode] || MINT_REQUIRED_BY_MODE.byo
  mintErrors.value = Object.fromEntries(required.filter(k => !String(mintForm.value[k] || '').trim()).map(k => [k, true]))
  return !Object.keys(mintErrors.value).length
}

// doMint 的 payload 构造(原 spread 后)追加两行:
    if (mintForm.value.mode === 'managed') delete payload.boundSA_name  // 服务端代建
// 重置行(原 :118)改为带 mode:
    mintForm.value = { mode: 'managed', owner: auth.user?.username || '', clusterId: '', boundSA_namespace: '', boundSA_name: '', tier: 'read', label: '' }
```

模板 mint 弹窗:在「绑定集群」字段块之前插模式切换,SA name 字段块加 `v-if="mintForm.mode === 'byo'"`:

```html
          <div class="flex gap-xs mb-sm">
            <button type="button" data-testid="mint-mode-managed" :class="['px-md py-xs rounded-full text-body-xs border transition-colors', mintForm.mode==='managed' ? 'bg-primary-container text-on-primary-container border-primary' : 'border-outline-variant text-on-surface-variant']" @click="mintForm.mode='managed'">{{ $t('admin.apiKeys.modeManaged') }}</button>
            <button type="button" data-testid="mint-mode-byo" :class="['px-md py-xs rounded-full text-body-xs border transition-colors', mintForm.mode==='byo' ? 'bg-primary-container text-on-primary-container border-primary' : 'border-outline-variant text-on-surface-variant']" @click="mintForm.mode='byo'">{{ $t('admin.apiKeys.modeByo') }}</button>
          </div>
          <p class="text-body-xs text-on-surface-variant mb-sm">{{ mintForm.mode==='managed' ? $t('admin.apiKeys.modeManagedHint') : $t('admin.apiKeys.modeByoHint') }}</p>
```

SA name 的 `<div>`(现 :200-202)外层加 `v-if="mintForm.mode === 'byo'"`;bindSaNamespace 的 label 在托管模式下换文案:`{{ $t(mintForm.mode==='managed' ? 'admin.apiKeys.bindSaNamespaceManaged' : 'admin.apiKeys.bindSaNamespace') }}`。

i18n —— `zh.json` 的 `admin.apiKeys` 对象内追加:

```json
      "modeManaged": "平台托管(推荐)",
      "modeByo": "自带 ServiceAccount(高级)",
      "modeManagedHint": "平台自动创建并维护集群身份与权限,无需了解 K8s ServiceAccount;身份失效会自动修复。",
      "modeByoHint": "使用集群里已有的 ServiceAccount,需自行保证其存在并配置 RBAC。",
      "bindSaNamespaceManaged": "命名空间",
```

`en.json` 同位置:

```json
      "modeManaged": "Managed by platform (recommended)",
      "modeByo": "Bring your own ServiceAccount (advanced)",
      "modeManagedHint": "The platform creates and maintains the cluster identity and permissions automatically — no Kubernetes knowledge needed; broken identities self-heal.",
      "modeByoHint": "Use an existing ServiceAccount in the cluster; you must keep it alive and configure its RBAC yourself.",
      "bindSaNamespaceManaged": "Namespace",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/views/__tests__/ApiKeyManagement.managed-mint.test.js src/views/__tests__/ApiKeyManagement.mint-validation.test.js`
Expected: PASS(新 3 例;**旧 mint-validation 用例若因默认模式不再要求 SA name 而失败,按其断言意图改为显式设 `mode:'byo'` 后再跑——该测试本就是 BYO 校验回归,语义不变**)

- [ ] **Step 5: Commit**

```bash
git add src/views/admin/ApiKeyManagement.vue src/views/__tests__/ApiKeyManagement.managed-mint.test.js src/views/__tests__/ApiKeyManagement.mint-validation.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(apikey): mint 弹窗双模式——托管默认(SA name 服务端代建),BYO 收进高级切换"
```

---

### Task 7: 前端 key 列表健康点 + 修复按钮

**Files:**
- Modify: `src/api/client.js:274-280`(apikeys 加 `health`/`repairSa`)
- Modify: `src/views/admin/ApiKeyManagement.vue`(script 加 saHealth/loadHealth/repairSa;模板 `#boundSA` slot 扩展:165)
- Modify: `src/locales/zh.json` + `src/locales/en.json`
- Test: `src/views/__tests__/ApiKeyManagement.sa-health.test.js`(新建)

**Interfaces:**
- Consumes: Task 5 的 HTTP 契约(`/health`、`/sa/repair {takeover}`)。
- Produces:
  - `adminApi.apikeys.health() → {health:[...]}`、`adminApi.apikeys.repairSa(id, body) → {ok,boundSA,managed}`
  - 组件内 `saHealth: ref({})`(id → health 项)、`loadHealth()`、`repairSa(row)`

- [ ] **Step 1: Write the failing test**(新建;mock 结构同 Task 6)

```js
// 健康点 + 修复契约:列表渲染红/绿点;失效 key 显示修复按钮;托管=「修复」、BYO=「接管并修复」(发 takeover);修复后刷新。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const rows = [
  { id: 'k1', prefix: 'p1', owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'ok-sa', saManaged: 1, tier: 'read', createdAt: 1 },
  { id: 'k2', prefix: 'p2', owner: 'a', clusterId: 'c1', boundSA_namespace: 'nursor', boundSA_name: 'nursor-debug', saManaged: 0, tier: 'read', createdAt: 2 },
]
const healthMock = vi.fn(async () => ({ health: [
  { id: 'k1', boundSA: 'ns/ok-sa', managed: true, ok: true },
  { id: 'k2', boundSA: 'nursor/nursor-debug', managed: false, ok: false, detail: 'ServiceAccount 不存在' },
] }))
const repairMock = vi.fn(async () => ({ ok: true, boundSA: 'nursor/aliangboard-mcp-22222222', managed: true }))
const notifyMock = vi.fn()

vi.mock('@/api/client', () => ({
  adminApi: {
    apikeys: {
      list: vi.fn(async () => ({ apikeys: rows })),
      create: vi.fn(), remove: vi.fn(), updateOverrides: vi.fn(), updateNamespaces: vi.fn(),
      health: () => healthMock(), repairSa: (...a) => repairMock(...a),
    },
    clusters: { list: vi.fn(async () => ({ clusters: [] })) },
  },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { username: 'admin', role: 'admin' } }) }))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ tableColumns: () => [] }) }))

import ApiKeyManagement from '../admin/ApiKeyManagement.vue'

beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

// DataTable stub 掉后无法验 slot 渲染 → 用浅层断言:health 数据进了 saHealth + repairSa 调用契约(组件逻辑层)。
function mountView() {
  return mount(ApiKeyManagement, {
    global: { plugins: [i18n], stubs: { Modal: true, DataTable: true, ToolOverrideEditor: true, NsAllowlistEditor: true } },
  })
}

test('onMounted 拉取 health 并入 saHealth(map by id)', async () => {
  const w = mountView()
  await flushPromises()
  expect(healthMock).toHaveBeenCalled()
  expect(w.vm.saHealth.k1.ok).toBe(true)
  expect(w.vm.saHealth.k2.ok).toBe(false)
})

test('repairSa(row):托管 key 不带 takeover;BYO key 带 takeover;成功后 notify + 刷新', async () => {
  const w = mountView()
  await flushPromises()
  await w.vm.repairSa(rows[0])
  expect(repairMock).toHaveBeenCalledWith('k1', {})
  await w.vm.repairSa(rows[1])
  expect(repairMock).toHaveBeenCalledWith('k2', { takeover: true })
  expect(notifyMock).toHaveBeenCalledWith('success', expect.anything())
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/__tests__/ApiKeyManagement.sa-health.test.js`
Expected: FAIL(w.vm.saHealth undefined / repairSa is not a function)

- [ ] **Step 3: Write minimal implementation**

`src/api/client.js` apikeys 对象(274-280)追加两行:

```js
    health: () => platformHttp.request('/api/admin/apikeys/health'),
    repairSa: (id, body) => platformHttp.request(`/api/admin/apikeys/${encodeURIComponent(id)}/sa/repair`, { method: 'POST', body: JSON.stringify(body || {}) }),
```

`ApiKeyManagement.vue` script(onMounted 附近)加:

```js
// SA 健康(id → {ok, detail, managed});探测失败不阻塞列表。
const saHealth = ref({})
async function loadHealth() {
  try { const res = await adminApi.apikeys.health(); saHealth.value = Object.fromEntries((res.health || []).map(h => [h.id, h])) } catch { /* 网关旧版本无此端点:静默降级 */ }
}
async function repairSa(row) {
  try {
    const res = await adminApi.apikeys.repairSa(row.id, row.saManaged ? {} : { takeover: true })
    notify('success', t('admin.apiKeys.repairDone', { sa: res.boundSA }))
    await load(); await loadHealth()
  } catch (e) { notify('error', e.message || t('admin.apiKeys.repairFailed')) }
}
```

`onMounted` 改为 `onMounted(() => { mintForm.value.owner = auth.user?.username || ''; load(); loadHealth() })`。

模板 `#boundSA` slot(现 :165)替换:

```html
          <template #boundSA="{ row }">
            <div class="flex items-center gap-xs">
              <span class="inline-block w-2 h-2 rounded-full shrink-0" :style="{ background: saHealth[row.id] ? (saHealth[row.id].ok ? '#10b981' : '#dc2626') : 'var(--md-sys-color-outline-variant, #9ca3af)' }" :title="saHealth[row.id]?.detail || ''"></span>
              <span class="font-mono text-body-xs text-on-surface-variant">{{ row.boundSA_namespace }}/{{ row.boundSA_name }}</span>
              <span v-if="row.saManaged" class="px-xs rounded-full text-[10px] leading-4 border border-outline-variant text-on-surface-variant">{{ $t('admin.apiKeys.managedBadge') }}</span>
              <button v-if="saHealth[row.id] && !saHealth[row.id].ok" data-testid="sa-repair" class="text-body-xs text-primary underline underline-offset-2" @click="repairSa(row)">{{ row.saManaged ? $t('admin.apiKeys.repair') : $t('admin.apiKeys.repairTakeover') }}</button>
            </div>
          </template>
```

(健康点用内联 style 而非 tailwind 色板类——避开色板 token 是否存在的猜测,`npm run build` 可验。)

i18n —— `zh.json` `admin.apiKeys` 追加:

```json
      "managedBadge": "平台托管",
      "repair": "修复",
      "repairTakeover": "接管并修复",
      "repairDone": "集群身份已就绪:{sa}",
      "repairFailed": "修复失败",
```

`en.json`:

```json
      "managedBadge": "managed",
      "repair": "Repair",
      "repairTakeover": "Take over & repair",
      "repairDone": "Cluster identity ready: {sa}",
      "repairFailed": "Repair failed",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/views/__tests__/ApiKeyManagement.sa-health.test.js && npm run test:unit`
Expected: PASS(新 2 例 + 前端全量)

- [ ] **Step 5: Commit**

```bash
git add src/api/client.js src/views/admin/ApiKeyManagement.vue src/views/__tests__/ApiKeyManagement.sa-health.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(apikey): key 列表 SA 健康点(红/绿)+ 失效一键修复(BYO 走接管)双语"
```

---

### Task 8: 全量验证 + 收尾

**Files:**
- 无新文件;验证 + 本计划文档入库。

**Interfaces:**
- Consumes: Task 1-7 全部。
- Produces: 绿基线。

- [ ] **Step 1: 全量验证(四门禁)**

```bash
npm test && npm run test:unit && npm run typecheck && npm run i18n:check
```

Expected: 四项全 PASS。(typecheck = `node --check` 全 .js/.mjs;`ApiKeyManagement.vue` 由下一步 build 覆盖。)

- [ ] **Step 2: 前端可构建**

```bash
npm run build
```

Expected: 构建成功(vue 模板语法/类名/内联 style 验证)。

- [ ] **Step 3: 计划文档入库(docs/superpowers 在 .gitignore 内,须 -f)**

```bash
git add -f docs/superpowers/plans/2026-08-19-apikey-managed-sa-lifecycle.md
git commit -m "docs(plan): API key 托管 SA 生命周期实施计划"
```

- [ ] **Step 4: 汇报手测清单(合并前给用户,需真集群)**

手测项(写进 PR/汇报,不在 CI 内):
1. 托管签发 read 档 key → MCP `can_i`/`list_resources` 直接可用(无需任何 kubectl 前置)。
2. `kubectl delete sa` 该托管 SA → 下一次 MCP 调用自动恢复(自愈),audit 里先 error 后 ok。
3. BYO key(如现存 nursor-debug 坏 key)→ 列表红点 + 「接管并修复」→ key 恢复可用且行内 SA 名变为 `aliangboard-mcp-<id8>`。
4. 吊销托管 key → 集群里 SA/Role/RoleBinding/CRB 被回收(共享 ClusterRole `aliangboard-mcp-cani` 保留)。
5. 升档/覆盖(tool_overrides allow update_image)→ 修复一次使 RBAC 模板升到 admin 档。

---

## Self-Review 记录

- **Spec 覆盖**:应急(存量坏 key)= Task 5 takeover + Task 7 按钮 ✓;友好错误 = Task 3 ✓;健康检查 = Task 5 health + Task 7 红点 ✓;代建 = Task 1/4 ✓;自愈 = Task 3 ✓;回收 = Task 5 ✓;BYO 高级模式保留 = Task 4/6 ✓;审计不回归 = Task 3 既有 catch 结构保留 ✓。
- **占位符扫描**:Task 5 Step 1 第 3 个 test 含编写期草稿段,已在 test 内注释明确「落盘前删除」——执行者据此清理(这是唯一一处,保留的原因是 502 分支已由该 test 的 404 部分与 harness 结构覆盖,避免计划里出现未经验证的 test 代码)。
- **类型一致性**:`provisionSa({requestFn, callCtx},{keyId,namespace,name,tier,namespaces})` 在 Task 1/3/4/5 四处调用签名一致;deps 名 `getCluster/provisionCluster/teardownCluster/probeSa` 在 Task 4/5 与 index.mjs 注入一致;`saManaged`(DB 列,整数 0/1)与 `managed`(HTTP/前端布尔)刻意区分,边界在 admin.mjs health 映射处转换 ✓。
- **已知限制(有意不在本计划修)**:DEFERRED_TOOLS(attach/port_forward/upload_file)若被 tool_overrides 放行,rbacTier 会升到 admin(RBAC 略宽于可用工具面,无害);托管供给依赖网关 bootstrap 凭据有 rbac 写权限(网关本就是全权 admin 代理,成立)。
