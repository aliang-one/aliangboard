# API key 托管 SA RBAC 漂移检测 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** health 端点对每把未吊销 API key 做 RBAC 漂移探测(欠配 + 超配),前端红绿点升级三态,黄点一键修复。

**Architecture:** 新纯逻辑模块 `server/sa-drift.mjs`(requestFn 注入,同 `sa-provision.mjs` 契约);`server/routes/admin.mjs` 的 health 路由在既有 `probeSa`(SA GET)之后追加 `probeDrift`,合并出 `rbac` 字段;`server/index.mjs` 注入 dep;前端 `ApiKeyManagement.vue` 三态点。**对 spec §1 签名的一处细化:SA 探测留在路由的 `probeSa`,sa-drift 模块专注 RBAC 比对,`probeSaDrift` 直接返回 `rbac` 对象**(`{status, issues[]}`,短路的 `unknown` 状态由路由兜)。

**Tech Stack:** Node 25(node:test / node:sqlite)、Vue 3 script setup、vitest + @vue/test-utils。零新依赖。

**Spec:** `docs/superpowers/specs/2026-08-27-apikey-sa-rbac-drift-detection.md`

## Global Constraints

- 提交:作者恒 `aliangone <aliangone@gmail.com`(repo config 已设,勿改);**禁止** Co-Authored-By Claude 尾注。
- i18n:zh/en 双语同步新增,`npm run i18n:check` 必须过;键名沿用 `admin.apiKeys.*` 的 camelCase。
- 不新增任何 npm 依赖。
- 完工判据:`npm test` + `npm run test:unit` + `npm run typecheck` 全绿。
- 在独立 worktree 执行(用户既定流程);`docs/superpowers` 提交须 `git add -f`。
- 复用单一事实源:`roleRules` / `rbacTier` / `TIERS` / `effectiveNamespaces`(均已有 export),禁止新造规则表。

---

### Task 1: `server/sa-drift.mjs` 核心比对(托管 key 欠配探测 + per-probe 超时)

**Files:**
- Create: `server/sa-drift.mjs`
- Test: `server/sa-drift.test.mjs`

**Interfaces:**
- Consumes: `roleRules(tier)`、`rbacTier(keyRow)`、`TIERS`(from `./sa-provision.mjs`);`effectiveNamespaces(keyRow)`(from `./authorize.mjs`)
- Produces(Task 2/3 依赖):
  - `probeSaDrift({ requestFn, callCtx, timeoutMs }, { keyRow, shared })` → `Promise<{ status: 'ok'|'drift'|'over'|'unknown', issues: [{ type, ns, name?, detail? }] }>`;`timeoutMs` 缺省读 `process.env.HEALTH_PROBE_TIMEOUT_MS` 或 5000;`shared` 缺省 `{}`
  - `stableStringify(value)` → 排序后的 JSON 串(对象键与数组元素均排序)
  - `platformNames(keyId)` → `Set<string>`,该 key 的全部平台命名(三档 Role/RoleBinding 名 + per-key cani CRB 名 + 共享 cani ClusterRole 名)

- [ ] **Step 1: 写失败测试**

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/sa-drift.test.mjs`
Expected: FAIL,`Cannot find module './sa-drift.mjs'`

- [ ] **Step 3: 最小实现**

```js
// server/sa-drift.mjs
// RBAC 漂移探测(spec: docs/superpowers/specs/2026-08-27-apikey-sa-rbac-drift-detection.md):
//   托管 key 逐 ns 声明式比对平台供给对象(Role 规则/RoleBinding/CRB) + 外来绑定扫描(超配);
//   BYO 只探「ns 内有无绑定引用该 SA」。全部复用 sa-provision/authorize 既有导出,零新事实源。
//   per-probe 超时:Promise.race 包裹,超时记 probe-error 不计 drift(防网络抖动永久黄)。
// requestFn 注入(同 sa-provision.mjs 契约),纯逻辑可单测。
import { roleRules, rbacTier, TIERS } from './sa-provision.mjs'
import { effectiveNamespaces } from './authorize.mjs'

const enc = encodeURIComponent
const id8 = (keyId) => String(keyId).slice(0, 8)
const DEFAULT_TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS) || 5000

// 稳定序列化:对象键与数组元素均排序 → 顺序不敏感的深比对基底。
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).sort().join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

// 该 key 的平台命名全集(三档 Role/RoleBinding + per-key cani CRB + 共享 cani ClusterRole)。
// 外来绑定判定 = subjects 引用我们的 SA 且名字不在此集合。
export function platformNames(keyId) {
  const s = new Set(TIERS.map(t => `aliangboard-mcp-${t}-${id8(keyId)}`))
  s.add(`aliangboard-mcp-cani-${id8(keyId)}`)
  s.add('aliangboard-mcp-cani')
  return s
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`probe timeout after ${ms}ms`)), ms))])

function issue(type, extra = {}) { return { type, ...extra } }

export async function probeSaDrift({ requestFn, callCtx, timeoutMs = DEFAULT_TIMEOUT_MS }, { keyRow, shared = {} }) {
  const issues = []
  const get = async (path) => {
    try { const { body } = await withTimeout(requestFn(callCtx, path), timeoutMs); return { ok: true, body } }
    catch (e) { return { ok: false, status: e.status, error: e.message } }
  }
  const nss = [...effectiveNamespaces(keyRow)]
  const tier = rbacTier(keyRow)
  const role = `aliangboard-mcp-${tier}-${id8(keyRow.id)}`

  if (keyRow.saManaged) {
    for (const ns of nss) {
      const r = await get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/roles/${enc(role)}`)
      if (!r.ok) {
        if (r.status === 404) issues.push(issue('role-missing', { ns, name: role }))
        else issues.push(issue('probe-error', { ns, detail: r.error }))
        continue
      }
      if (stableStringify(r.body.rules) !== stableStringify(roleRules(tier))) issues.push(issue('role-rules', { ns, name: role }))
      const b = await get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/rolebindings/${enc(role)}`)
      if (!b.ok) { b.status === 404 ? issues.push(issue('binding-missing', { ns, name: role })) : issues.push(issue('probe-error', { ns, detail: b.error })); continue }
      const subjOk = b.body.subjects?.some(s => s.kind === 'ServiceAccount' && s.name === keyRow.boundSA_name && s.namespace === keyRow.boundSA_namespace)
      const refOk = b.body.roleRef?.name === role && b.body.roleRef?.kind === 'Role'
      if (!subjOk || !refOk) issues.push(issue('binding-subjects', { ns, name: role }))
    }
    const crb = await get(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${enc('aliangboard-mcp-cani-' + id8(keyRow.id))}`)
    if (!crb.ok) crb.status === 404 ? issues.push(issue('crb-missing', { name: 'aliangboard-mcp-cani-' + id8(keyRow.id) })) : issues.push(issue('probe-error', { detail: crb.error }))
  } else {
    // Task 2 实现(BYO:ns 内有无绑定引用该 SA)
  }
  const status = issues.some(i => !['probe-error', 'foreign-binding', 'foreign-crb'].includes(i.type)) ? 'drift'
    : issues.some(i => i.type === 'foreign-binding' || i.type === 'foreign-crb') ? 'over' : 'ok'
  return { status, issues }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/sa-drift.test.mjs`
Expected: PASS(6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/sa-drift.mjs server/sa-drift.test.mjs
git commit -m "feat(datalayer): sa-drift 核心比对——托管 key 逐 ns Role/Binding/CRB 声明式探测+稳定序列化+per-probe 超时"
```

---

### Task 2: 外来绑定扫描(超配)+ BYO 探测 + shared 去重缓存

**Files:**
- Modify: `server/sa-drift.mjs`(BYO 分支 + 外来扫描 + list 走 shared)
- Test: `server/sa-drift.test.mjs`(追加)

**Interfaces:**
- Consumes: Task 1 的 `probeSaDrift` / `platformNames`
- Produces: `probeSaDrift` 完整语义(spec §1):`foreign-binding` / `foreign-crb` / `byo-no-binding` issue;`shared` 缓存(同 cluster 同 ns 的 rolebinding list、clusterrolebindings list、cani ClusterRole GET 只发一次)

- [ ] **Step 1: 追加失败测试**

```js
// —— 追加到 server/sa-drift.test.mjs ——
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
  assert.equal(calls.filter(p => p.startsWith(nsListPath)).length, 1)
  assert.equal(calls.filter(p => p.startsWith(crbListPath)).length, 1)
  assert.equal(calls.filter(p => p.startsWith('/apis/rbac.authorization.k8s.io/v1/clusterroles/aliangboard-mcp-cani')).length, 1)
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
```

- [ ] **Step 2: 跑测试确认新用例失败**

Run: `node --test server/sa-drift.test.mjs`
Expected: 新 5 个 FAIL(外来绑定无 issue / BYO 空 / shared 计数 > 1 / cani 缺失不报);旧 6 个仍 PASS

- [ ] **Step 3: 实现补全**

在 `server/sa-drift.mjs` 中:

3a. 加 shared 单飞 helper(放在 `withTimeout` 之后):

```js
// 一次 health 调用内的共享缓存:同 apiServer 的 ns rolebinding list / CRB list / cani CR GET 只发一次;失败不缓存。
function sharedGet(shared, key, make) {
  if (!shared[key]) {
    const p = make().catch(e => { delete shared[key]; throw e })
    shared[key] = p
  }
  return shared[key]
}
```

3b. `probeSaDrift` 内,`const nss = ...` 之后加:

```js
  const apiServer = String(callCtx?.apiServer || '')
  // list 的 404 视为空(与 teardown 容忍语义一致);其他错误(超时/403)→ null → probe-error。
  const listNs = (ns) => sharedGet(shared, `nslist|${apiServer}|${ns}`, async () =>
    (await withTimeout(requestFn(callCtx, `/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/rolebindings`), timeoutMs))?.body?.items || [])
    .catch(e => e?.status === 404 ? [] : null)
  const listCrb = () => sharedGet(shared, `crblist|${apiServer}`, async () =>
    (await withTimeout(requestFn(callCtx, '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'), timeoutMs))?.body?.items || [])
    .catch(e => e?.status === 404 ? [] : null)
  const refUs = (item) => (item.subjects || []).some(s => s.kind === 'ServiceAccount' && s.name === keyRow.boundSA_name && s.namespace === keyRow.boundSA_namespace)
```

3c. 托管分支的 `if (keyRow.saManaged) {` 末尾(per-key CRB 探测之后)加外来扫描 + 共享 cani ClusterRole 探测:

```js
    // 共享 cani ClusterRole(每 cluster 一次,走 shared):所有 key 的 can_i 都依赖它
    await sharedGet(shared, `cani|${apiServer}`, async () =>
      withTimeout(requestFn(callCtx, '/apis/rbac.authorization.k8s.io/v1/clusterroles/aliangboard-mcp-cani'), timeoutMs))
      .catch(e => { e?.status === 404 ? issues.push(issue('crb-missing', { name: 'aliangboard-mcp-cani' })) : issues.push(issue('probe-error', { detail: e?.message || 'cani ClusterRole 探测失败' })) })
    // 外来绑定扫描(超配):subjects 引用我们的 SA 且名字非平台命名 → 报告不处理
    const mine = platformNames(keyRow.id)
    for (const ns of nss) {
      const items = await listNs(ns)
      if (items == null) { issues.push(issue('probe-error', { ns, detail: 'rolebinding list 失败' })); continue }
      for (const item of items) if (refUs(item) && !mine.has(item.metadata?.name)) issues.push(issue('foreign-binding', { ns, name: item.metadata?.name }))
    }
    const crbItems = await listCrb()
    if (crbItems == null) issues.push(issue('probe-error', { detail: 'clusterrolebinding list 失败' }))
    else for (const item of crbItems) if (refUs(item) && !mine.has(item.metadata?.name)) issues.push(issue('foreign-crb', { name: item.metadata?.name }))
```

3d. BYO 分支替换空注释:

```js
  } else {
    // BYO:平台不拥有 RBAC,只探「ns 内有无任何绑定引用该 SA」;无 → 引导自建或接管。超配扫描跳过(一切外来皆合法)。
    for (const ns of nss) {
      const items = await listNs(ns)
      if (items == null) { issues.push(issue('probe-error', { ns, detail: 'rolebinding list 失败' })); continue }
      if (!items.some(refUs)) issues.push(issue('byo-no-binding', { ns }))
    }
  }
```

- [ ] **Step 4: 跑测试确认全通过**

Run: `node --test server/sa-drift.test.mjs`
Expected: PASS(11 tests)

- [ ] **Step 5: Commit**

```bash
git add server/sa-drift.mjs server/sa-drift.test.mjs
git commit -m "feat(datalayer): sa-drift 外来绑定扫描+BYO 探测+shared 去重——超配可见,同 cluster list 单飞"
```

---

### Task 3: health 路由接线(`rbac` 字段)+ index.mjs 注入

**Files:**
- Modify: `server/routes/admin.mjs:365-375`(health 路由块)
- Modify: `server/index.mjs`(deps 对象,`probeSa` 之后 ~1379 行)
- Test: `server/apikey-sa-repair.test.mjs`(扩 harness + 追加用例)

**Interfaces:**
- Consumes: Task 1/2 的 `probeSaDrift`
- Produces: `GET /api/admin/apikeys/health` 响应元素新增 `rbac: { status, issues[] }`;`saOk=false` 时 `rbac.status='unknown'`(短路);dep 名 `probeDrift(row, keyRow, shared)`

- [ ] **Step 1: 追加失败测试**

`server/apikey-sa-repair.test.mjs` 的 `makeHarness` 增加可注入 drift(deps 那块加一行):

```js
    probeDrift: async (row, keyRow, shared) => (typeof drift === 'function' ? drift(keyRow) : { status: 'ok', issues: [] }),
```

(`makeHarness({ probe, drift, ... } = {})` 签名同步加 `drift`。)文件末尾追加:

```js
test('health:透传 rbac 字段;SA 挂 → unknown 短路且不跑 drift;probeDrift 抛错不阻塞', async () => {
  const h = makeHarness({ drift: () => ({ status: 'drift', issues: [{ type: 'role-missing', ns: 'ns' }] }) })
  mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa-a', saManaged: 1 })
  await h.call('GET', '/api/admin/apikeys/health')
  const x = h.sent[0].json.health[0]
  assert.equal(x.rbac.status, 'drift')
  assert.equal(x.rbac.issues[0].type, 'role-missing')

  let driftRan = 0
  const h2 = makeHarness({ probe: async () => ({ ok: false, detail: 'not found' }), drift: async () => { driftRan++; return { status: 'ok', issues: [] } } })
  mintKey(h2.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa-b', saManaged: 1 })
  await h2.call('GET', '/api/admin/apikeys/health')
  assert.equal(h2.sent[0].json.health[0].rbac.status, 'unknown') // SA 探测失败短路
  assert.equal(driftRan, 0)                                       // 短路 = 不调 drift

  const h3 = makeHarness({ drift: () => { throw new Error('boom') } })
  mintKey(h3.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa-c', saManaged: 1 })
  await h3.call('GET', '/api/admin/apikeys/health')
  assert.equal(h3.sent[0].status, 200)
  assert.equal(h3.sent[0].json.health[0].rbac.status, 'unknown') // drift 抛错兜底,列表照常
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/apikey-sa-repair.test.mjs`
Expected: 新用例 FAIL(`rbac` undefined)

- [ ] **Step 3: 实现**

3a. `server/routes/admin.mjs` health 路由块整体替换为:

```js
    // SA 健康(列表页红绿点):轻量 GET 每把未吊销 key 的绑定 SA;SA 在 → 追加 RBAC 漂移探测(rbac 字段)。
    if (req.method === 'GET' && url.pathname === '/api/admin/apikeys/health') {
      const ps = requireAdmin(req, res); if (!ps) return true
      if (!deps.probeSa || !deps.getCluster) { sendJson(res, 200, { health: [] }); return true }
      const keys = listKeys(db).filter(k => !k.revokedAt)
      const shared = {} // 本次调用的共享缓存:同 cluster 的 rolebinding/CRB list 只发一次
      const health = await Promise.all(keys.map(async k => {
        const r = await deps.probeSa(deps.getCluster(k.clusterId), k.boundSA_namespace, k.boundSA_name)
        let rbac = { status: 'unknown', issues: [] } // SA 不可达 → 短路 unknown(红点已足够)
        if (r && r.ok && deps.probeDrift) {
          try { rbac = (await deps.probeDrift(deps.getCluster(k.clusterId), k, shared)) || rbac } catch { /* 漂移探测失败不阻塞列表 */ }
        }
        return { id: k.id, prefix: k.prefix, boundSA: `${k.boundSA_namespace}/${k.boundSA_name}`, managed: !!k.saManaged, tier: k.tier, ok: !!(r && r.ok), detail: r?.detail || null, rbac }
      }))
      sendJson(res, 200, { health })
      return true
    }
```

3b. `server/index.mjs`:顶部 import 区加 `import { probeSaDrift } from './sa-drift.mjs'`;deps 对象 `probeSa` 项之后加:

```js
    probeDrift: async (row, keyRow, shared) => {
      if (!row) return { status: 'unknown', issues: [] }
      return probeSaDrift({ requestFn: requestKubernetes, callCtx: buildCallContext({ apiServer: row.apiServer, authHeader: row.authHeader, ca: row.ca, cert: row.cert, key: row.key, insecure: !!row.insecure }) }, { keyRow, shared })
    },
```

- [ ] **Step 4: 跑测试确认全通过**

Run: `node --test server/apikey-sa-repair.test.mjs server/sa-drift.test.mjs && npm test`
Expected: PASS(全仓测试不回归)

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.mjs server/index.mjs server/apikey-sa-repair.test.mjs
git commit -m "feat(gateway): health 端点接 RBAC 漂移探测——rbac 字段透传/SA 挂短路 unknown/共享缓存单飞"
```

---

### Task 4: 前端三态点 + i18n + vitest

**Files:**
- Modify: `src/views/admin/ApiKeyManagement.vue`(script 加 helpers;template 186 行点样式/title、189 行按钮条件)
- Modify: `src/locales/zh.json`、`src/locales/en.json`(`admin.apiKeys` 段 `repairTakeover` 之后插 `drift` 子对象)
- Test: `src/views/__tests__/ApiKeyManagement.rbac-drift.test.js`(新建)

**Interfaces:**
- Consumes: health 响应的 `rbac.status/issues[]`(Task 3);组件内已有 `t`(useI18n)、`saHealth` ref
- Produces: 组件逻辑层导出 `dotColor(h)` / `dotTitle(h)` / `needsRepair(row)`(script setup 顶层绑定,vitest 经 `w.vm.*` 断言)

- [ ] **Step 1: 写失败测试**

```js
// 漂移三态契约:绿=ok且无漂移;黄=ok但 drift/over;红=!ok。黄 drift 出修复、over 不出;title 含 i18n 明细。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const rows = [
  { id: 'k1', prefix: 'p1', owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa1', saManaged: 1, tier: 'read', createdAt: 1 },
  { id: 'k2', prefix: 'p2', owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa2', saManaged: 1, tier: 'read', createdAt: 2 },
  { id: 'k3', prefix: 'p3', owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa3', saManaged: 1, tier: 'read', createdAt: 3 },
  { id: 'k4', prefix: 'p4', owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa4', saManaged: 0, tier: 'read', createdAt: 4 },
]
const healthMock = vi.fn(async () => ({ health: [
  { id: 'k1', boundSA: 'ns/sa1', managed: true, ok: true, rbac: { status: 'ok', issues: [] } },
  { id: 'k2', boundSA: 'ns/sa2', managed: true, ok: true, rbac: { status: 'drift', issues: [{ type: 'role-missing', ns: 'help-friends' }] } },
  { id: 'k3', boundSA: 'ns/sa3', managed: true, ok: true, rbac: { status: 'over', issues: [{ type: 'foreign-binding', ns: 'nursor', name: 'x-admin' }] } },
  { id: 'k4', boundSA: 'ns/sa4', managed: false, ok: false, detail: 'ServiceAccount 不存在' },
] }))

vi.mock('@/api/client', () => ({
  adminApi: {
    apikeys: {
      list: vi.fn(async () => ({ apikeys: rows })),
      create: vi.fn(), remove: vi.fn(), updateOverrides: vi.fn(), updateNamespaces: vi.fn(),
      health: () => healthMock(), repairSa: vi.fn(async () => ({ ok: true })),
    },
    clusters: { list: vi.fn(async () => ({ clusters: [] })) },
  },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { username: 'admin', role: 'admin' } }) }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ tableColumns: () => [] }) }))

import ApiKeyManagement from '../admin/ApiKeyManagement.vue'

beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

function mountView() {
  return mount(ApiKeyManagement, {
    global: { plugins: [i18n], stubs: { Modal: true, DataTable: true, ToolOverrideEditor: true, NsAllowlistEditor: true } },
  })
}

const byId = (w, id) => ({ row: rows.find(r => r.id === id), h: w.vm.saHealth[id] })

test('三态:k1 绿 / k2 黄 / k3 黄 / k4 红;旧网关无 rbac 字段 → ok 即绿', async () => {
  const w = mountView()
  await flushPromises()
  const { dotColor } = w.vm
  expect(dotColor(byId(w, 'k1').h)).toBe('#10b981')
  expect(dotColor(byId(w, 'k2').h)).toBe('#f59e0b')
  expect(dotColor(byId(w, 'k3').h)).toBe('#f59e0b')
  expect(dotColor(byId(w, 'k4').h)).toBe('#dc2626')
  expect(dotColor({ ok: true })).toBe('#10b981') // 无 rbac 字段(旧网关)退化两态
  expect(dotColor(undefined)).toContain('outline-variant') // 无数据灰
})

test('修复条件:k2(drift)要修、k3(over)不出、k4(红)要修、k1 不出', async () => {
  const w = mountView()
  await flushPromises()
  const { needsRepair } = w.vm
  expect(needsRepair(byId(w, 'k2').row)).toBe(true)
  expect(needsRepair(byId(w, 'k3').row)).toBe(false)
  expect(needsRepair(byId(w, 'k4').row)).toBe(true)
  expect(needsRepair(byId(w, 'k1').row)).toBe(false)
})

test('title:issue 明细(i18n+ns)拼接;over 追加 foreignHint', async () => {
  const w = mountView()
  await flushPromises()
  const { dotTitle } = w.vm
  const t2 = dotTitle(byId(w, 'k2').h)
  expect(t2).toContain('help-friends')
  const t3 = dotTitle(byId(w, 'k3').h)
  expect(t3).toContain('nursor/x-admin')
  expect(t3).toContain(i18n.global.t('admin.apiKeys.drift.foreignHint'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:unit -- src/views/__tests__/ApiKeyManagement.rbac-drift.test.js`
Expected: FAIL(`w.vm.dotColor is not a function`)

- [ ] **Step 3: 实现**

3a. `ApiKeyManagement.vue` script(`saHealth` 定义块之后)加:

```js
// 漂移三态(spec 2026-08-27):绿=ok且无漂移;黄=ok但 RBAC drift/over;红=SA 不可达。旧网关无 rbac → 退化两态。
const camelize = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
const dotColor = (h) => !h ? 'var(--md-sys-color-outline-variant, #9ca3af)' : !h.ok ? '#dc2626' : (h.rbac?.status && h.rbac.status !== 'ok') ? '#f59e0b' : '#10b981'
const dotTitle = (h) => {
  if (!h) return ''
  const issues = (h.rbac?.issues || []).map(i => `${t(`admin.apiKeys.drift.${camelize(i.type)}`)}${i.ns ? ` (${i.ns}${i.name ? '/' + i.name : ''})` : ''}`)
  return [h.detail, ...issues, h.rbac?.status === 'over' ? t('admin.apiKeys.drift.foreignHint') : ''].filter(Boolean).join('\n')
}
const needsRepair = (row) => { const h = saHealth.value[row.id]; return !!(h && (!h.ok || h.rbac?.status === 'drift')) }
```

3b. template 替换(`boundSA` slot 内两行):

```html
          <span class="inline-block w-2 h-2 rounded-full shrink-0" :style="{ background: dotColor(saHealth[row.id]) }" :title="dotTitle(saHealth[row.id])"></span>
```

与

```html
          <button v-if="needsRepair(row)" data-testid="sa-repair" class="text-body-xs text-primary underline underline-offset-2" @click="repairSa(row)">{{ row.saManaged ? $t('admin.apiKeys.repair') : $t('admin.apiKeys.repairTakeover') }}</button>
```

3c. i18n:两个 locale 的 `admin.apiKeys` 段 `"repairTakeover"` 行之后插入(zh.json / en.json 同结构):

```json
      "drift": {
        "roleMissing": "缺少平台 Role",
        "roleRules": "平台 Role 规则与当前权限档不符",
        "bindingMissing": "缺少平台 RoleBinding",
        "bindingSubjects": "RoleBinding 未绑定到该 key 的 SA",
        "crbMissing": "缺少 can-i 所需 ClusterRole/ClusterRoleBinding",
        "foreignBinding": "外来 RoleBinding 引用了该 SA(超配)",
        "foreignCrb": "外来 ClusterRoleBinding 引用了该 SA(超配)",
        "byoNoBinding": "该命名空间无 RoleBinding 引用此 SA(自管身份,请自建或接管)",
        "probeError": "探测超时/失败,结果可能不完整",
        "foreignHint": "外来绑定不属于平台托管,「修复」不会清理,去留请人工决定"
      },
```

en.json 对应英文:

```json
      "drift": {
        "roleMissing": "Platform Role missing",
        "roleRules": "Platform Role rules do not match current tier",
        "bindingMissing": "Platform RoleBinding missing",
        "bindingSubjects": "RoleBinding not bound to this key's SA",
        "crbMissing": "Missing ClusterRole/ClusterRoleBinding required by can-i",
        "foreignBinding": "Foreign RoleBinding references this SA (over-granted)",
        "foreignCrb": "Foreign ClusterRoleBinding references this SA (over-granted)",
        "byoNoBinding": "No RoleBinding references this SA in the namespace (self-managed: create one or take over)",
        "probeError": "Probe timed out/failed; result may be incomplete",
        "foreignHint": "Foreign bindings are not platform-managed; Repair will not remove them — decide manually"
      },
```

- [ ] **Step 4: 全量验证**

Run: `npm run test:unit -- src/views/__tests__/ApiKeyManagement.rbac-drift.test.js src/views/__tests__/ApiKeyManagement.sa-health.test.js && npm run i18n:check && npm run typecheck`
Expected: 新旧测试全 PASS(既有 sa-health 测试不回归——其 mock 无 rbac 字段,走两态退化路径);i18n 门禁过

- [ ] **Step 5: Commit**

```bash
git add src/views/admin/ApiKeyManagement.vue src/locales/zh.json src/locales/en.json src/views/__tests__/ApiKeyManagement.rbac-drift.test.js
git commit -m "feat(admin): API key 健康点三态化——黄灯=RBAC 漂移/超配,title 明细+over 不出修复链接"
```

---

## 收尾(执行完四个 Task 后)

- [ ] `npm test && npm run test:unit && npm run typecheck` 三绿
- [ ] 手测项记入交付说明(需真集群):删 ns 的 Role 看黄灯 + 一键修复回绿;手工绑 admin CR 看超配提示;拔网线看 probe-error 不挂页面
