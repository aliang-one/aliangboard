# MCP rollout 补全 + 每工具覆盖 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接通 `rollout_history`/`rollout_undo`/`update_image` 三个 K8s 工具(MCP 底座 8/11),并在 tier 之上加每工具覆盖(`tool_overrides`:有效工具集 = `tierTools(tier) ∪ allow − deny`)。

**Architecture:** 复用既有「接线模板」:gateway 函数注入 → `tools.X(runBoundedTool 全链 admin 档 + SA RBAC + 审计)` → `tool-registry` 条目 + 测试。覆盖逻辑集中在 `authorize.mjs` 的新 `effectiveTools(keyRow)`(单一真源),三处广告路径(MCP tools/list、agent offering)统一改用它。延后 `attach`/`port_forward`/`upload_file` 并登记理由。

**Tech Stack:** Node.js(`node:test` + `node:sqlite` + `node --check`),Vue 3 + Vite。零新依赖。

## Global Constraints

- **零新外部依赖**:测试用自研零依赖运行器 + `node --test`;类型用 `node --check`。不引 vitest/jest/ts(已裁决例外仅 @tanstack/vue-query + vitest/happy-dom)。
- **测试命令**:服务端 `npm test`(含 `node --test server/*.test.mjs`);前端单测 `npm run test:unit`;类型/语法 `npm run typecheck`;`.vue` 由 `npm run build` 覆盖。
- **commit 风格**:`feat(mcp): 中文描述`(或 `feat(auth)/feat(ui)`),末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- **接线铁律**:每个 admin 工具经 `runBoundedTool`(authorize→ns 作用域→reserve 审计→现签 SA token→fn→finalize),结构性 enforcement——fn 只拿 `saCtx`,无原始 dispatcher。
- **tier 模型**:read/operator/admin;`tierTools` 导出不变(现有测试保持绿);每 key 绑定**单个** namespace(`boundSA_namespace`),ns 作用域检查在 `runBoundedTool` 内不变。
- **覆盖语义**:`allow` 可越过 tier(如 operator+exec_pod),真授权由绑定 SA 的 K8s RBAC 兜底;损坏 JSON → fail-open 到 tier(不锁死 key)。

## File Structure

| 文件 | 职责 | 本轮改动 |
|------|------|----------|
| `server/authorize.mjs` | 策略层(单一 chokepoint) | +`effectiveTools`/`normalizeToolOverrides`;`authorize()` 改用它;`BOUNDED_TOOLS` 加 `rollout_history`;延后工具注释 |
| `server/authorize.test.mjs` | 策略测试 | +`effectiveTools`/`normalizeToolOverrides` 用例 |
| `server/auth-keys.mjs` | api_keys 表 + mint/list | +列 `tool_overrides`;mint 校验+存;listKeys 返回该列 |
| `server/auth-keys.test.mjs`(新) | mint/list 覆盖存储测试 | 新建 |
| `server/api-key-tools.mjs` | runBoundedTool + tools | +`rollout_history`/`rollout_undo`/`update_image` 三工具 |
| `server/api-key-tools.test.mjs` | tools 测试 | +三工具用例;扩 mockRequestFn |
| `server/tool-registry.mjs` | 工具 metadata + 分派 | +三工具 registry 条目;+`toolDefsFor(names)` |
| `server/mcp.mjs` | 外部 MCP tools/list | `tierTools`→`effectiveTools` |
| `server/agent-runner.mjs` | 内部 agent offering | offering 改用 `effectiveTools`+`toolDefsFor` |
| `server/index.mjs` | 路由 | mint 传 overrides;+PATCH overrides 端点 |
| `src/api/client.js` | 前端 HTTP | +`apikeys.updateOverrides` |
| `src/views/admin/ApiKeyManagement.vue` | API key 管理 UI | mint 加覆盖编辑;列表展示+编辑覆盖 |

---

### Task 1: `effectiveTools` + `normalizeToolOverrides`(authorize 策略核心)

**Files:**
- Modify: `server/authorize.mjs`(authorize 函数 + 新增两个导出)
- Test: `server/authorize.test.mjs`

**Interfaces:**
- Produces: `effectiveTools(keyRow) → Set<string>`(运行时有效工具集,lenient,损坏→tier);`normalizeToolOverrides(raw) → string|null`(mint/update 用,strict,坏→抛,返回存库的 JSON 串)。`authorize(keyRow, tool)` 内部由 `tierTools(...).includes` 改为 `effectiveTools(keyRow).has`。
- Consumes: 既有 `tierTools`/`BOUNDED_TOOLS`/`DANGEROUS_TOOLS`(均不变,仍导出)。

- [ ] **Step 1: 写失败测试** — 追加到 `server/authorize.test.mjs`(顶部 import 加 `effectiveTools, normalizeToolOverrides`):

```js
import {
  BOUNDED_TOOLS, DANGEROUS_TOOLS, tierTools,
  effectiveTools, normalizeToolOverrides,
  authorize, PermissionDeniedError, canIDecision, withPolicy,
} from './authorize.mjs'

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/authorize.test.mjs`
Expected: FAIL — `effectiveTools`/`normalizeToolOverrides` 未导出(not exported)。

- [ ] **Step 3: 实现** — 在 `server/authorize.mjs` 的 `authorize` 函数**之前**插入两个函数,并改 `authorize` 一行:

```js
// 运行时有效工具集:lenient。损坏/缺 override → 回退 tier(fail-open 到 tier,不锁死 key)。
// keyRow.tool_overrides 来自 DB(TEXT 串)或内存对象,两者都兼容。
export function effectiveTools(keyRow) {
  const set = new Set(tierTools(keyRow?.tier))
  const raw = keyRow?.tool_overrides
  if (!raw) return set
  let ov
  try { ov = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return set }
  if (!ov || typeof ov !== 'object' || Array.isArray(ov)) return set
  if (Array.isArray(ov.allow)) for (const t of ov.allow) if (typeof t === 'string') set.add(t)
  if (Array.isArray(ov.deny)) for (const t of ov.deny) if (typeof t === 'string') set.delete(t)
  return set
}

// mint/update 用:strict。坏形状/未知名/allow∩deny → 抛。返回存库的规范 JSON 串(空→null)。
// 已知工具宇宙 = BOUNDED ∪ DANGEROUS(恰好 K8s 工具全集;工作台工具不受覆盖管辖)。
export function normalizeToolOverrides(raw) {
  if (raw == null) return null
  const ov = typeof raw === 'string' ? JSON.parse(raw) : raw  // 坏串让 JSON.parse 抛
  if (!ov || typeof ov !== 'object' || Array.isArray(ov)) throw new Error('tool_overrides 必须是 {allow?,deny?} 对象')
  const allow = Array.isArray(ov.allow) ? ov.allow : (ov.allow == null ? [] : null)
  const deny = Array.isArray(ov.deny) ? ov.deny : (ov.deny == null ? [] : null)
  if (!allow || !deny) throw new Error('tool_overrides allow/deny 必须是字符串数组')
  const known = new Set([...BOUNDED_TOOLS, ...DANGEROUS_TOOLS])
  for (const t of [...allow, ...deny]) if (!known.has(t)) throw new Error(`tool_overrides 含未知工具: ${t}`)
  const both = allow.filter(t => deny.includes(t))
  if (both.length) throw new Error(`tool_overrides 工具不能同时 allow 与 deny: ${both.join(',')}`)
  const out = {}
  if (allow.length) out.allow = allow
  if (deny.length) out.deny = deny
  return Object.keys(out).length ? JSON.stringify(out) : null
}
```

改 `authorize`(把 `tierTools(keyRow.tier).includes(tool)` 换成 `effectiveTools(keyRow).has(tool)`):

```js
export function authorize(keyRow, tool) {
  if (!keyRow || keyRow.revokedAt) return { allowed: false, reason: 'revoked' }
  return effectiveTools(keyRow).has(tool)
    ? { allowed: true }
    : { allowed: false, reason: 'policy' }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/authorize.test.mjs`
Expected: PASS(含新增 6 个用例 + 既有 `authorize`/`tierTools` 用例仍绿——既有 keyRow 无 `tool_overrides` → 回退 tier)。

- [ ] **Step 5: commit**

```bash
git add server/authorize.mjs server/authorize.test.mjs
git commit -m "feat(auth): effectiveTools + normalizeToolOverrides(tier ∪ allow − deny,单一真源)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: schema 迁移 + mint/list 承载 `tool_overrides`(auth-keys)

**Files:**
- Modify: `server/auth-keys.mjs`(schema + mintKey + listKeys)
- Test: `server/auth-keys.test.mjs`(新建)

**Interfaces:**
- Consumes: `normalizeToolOverrides` from Task 1。
- Produces: `api_keys.tool_overrides TEXT` 列(可空);`mintKey(db, {…, tool_overrides})` 校验后存;`listKeys(db)` 返回行含 `tool_overrides`;`lookupKey` 已 `SELECT *` 自动含。

- [ ] **Step 1: 写失败测试** — 新建 `server/auth-keys.test.mjs`:

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createApiKeysSchema, mintKey, listKeys, lookupKey, generateKeyPlaintext } from './auth-keys.mjs'

function makeDb() { const db = new DatabaseSync(':memory:'); createApiKeysSchema(db); return db }

test('mintKey: tool_overrides 合法 → 存规范 JSON 串;listKeys/lookupKey 回带', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin', tool_overrides: { deny: ['delete_resource'] } })
  assert.equal(k.tool_overrides, JSON.stringify({ deny: ['delete_resource'] }))
  const row = listKeys(db)[0]
  assert.equal(row.tool_overrides, JSON.stringify({ deny: ['delete_resource'] }))
  const byLookup = lookupKey(db, k.plaintext)
  assert.equal(byLookup.tool_overrides, JSON.stringify({ deny: ['delete_resource'] }))
})

test('mintKey: 无 tool_overrides → 列为 null', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  assert.equal(k.tool_overrides, null)
  assert.equal(listKeys(db)[0].tool_overrides, null)
})

test('mintKey: 非法 tool_overrides(未知名/allow∩deny)→ 抛,不建 key', () => {
  const db = makeDb()
  assert.throws(() => mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tool_overrides: { allow: ['bogus'] } }), /未知工具/)
  assert.throws(() => mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tool_overrides: { allow: ['exec_pod'], deny: ['exec_pod'] } }), /不能同时/)
  assert.equal(listKeys(db).length, 0, '失败不建 key')
})

test('schema 幂等: 重复 createApiKeysSchema 不报错(tool_overrides 列已存在)', () => {
  const db = makeDb()
  assert.doesNotThrow(() => createApiKeysSchema(db))  // 二次调用
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tool_overrides: { allow: ['scale'] } })
  assert.ok(k.id)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/auth-keys.test.mjs`
Expected: FAIL — `tool_overrides` 列不存在(SQLite error: no such column)。

- [ ] **Step 3: 实现** — 改 `server/auth-keys.mjs`:

顶部加 import:
```js
import { normalizeToolOverrides } from './authorize.mjs'
```

`createApiKeysSchema` 加列 + 幂等 ALTER(新库 CREATE 里带列;旧库 ALTER 补):
```js
export function createApiKeysSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    keyHash TEXT NOT NULL UNIQUE,
    prefix TEXT,
    owner TEXT NOT NULL,
    clusterId TEXT NOT NULL,
    boundSA_namespace TEXT NOT NULL,
    boundSA_name TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'read',
    tool_overrides TEXT,
    label TEXT,
    createdBy TEXT,
    createdAt INTEGER NOT NULL,
    revokedAt INTEGER
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner)`)
  // 旧库(表已存在但无该列)补列;新库 CREATE 已带 → ALTER 抛「列已存在」,吞掉。
  try { db.exec('ALTER TABLE api_keys ADD COLUMN tool_overrides TEXT') } catch { /* 列已存在 */ }
}
```

`mintKey` 接收 + 校验 + 存 + 返回:
```js
export function mintKey(db, input) {
  const { owner, clusterId, boundSA_namespace, boundSA_name, tier = 'read', label = null, createdBy = null, tool_overrides = null } = input || {}
  if (!owner || !clusterId || !boundSA_namespace || !boundSA_name) {
    throw new Error('mintKey 缺少必填字段(owner / clusterId / boundSA_namespace / boundSA_name)')
  }
  if (!['read', 'operator', 'admin'].includes(tier)) throw new Error(`mintKey 非法 tier: ${tier}`)
  const overridesJson = normalizeToolOverrides(tool_overrides)  // strict: 坏→抛
  const plaintext = generateKeyPlaintext()
  const id = randomUUID()
  const createdAt = Date.now()
  db.prepare(`INSERT INTO api_keys (id, keyHash, prefix, owner, clusterId, boundSA_namespace, boundSA_name, tier, tool_overrides, label, createdBy, createdAt, revokedAt)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(
    id, hashKey(plaintext), plaintext.slice(0, 8), owner, clusterId, boundSA_namespace, boundSA_name, tier, overridesJson, label, createdBy, createdAt)
  return { id, plaintext, prefix: plaintext.slice(0, 8), owner, clusterId, boundSA_namespace, boundSA_name, tier, tool_overrides: overridesJson, label, createdBy, createdAt }
}
```

`listKeys` 的 SELECT 加列:
```js
export function listKeys(db, { owner } = {}) {
  const sql = `SELECT id, prefix, owner, clusterId, boundSA_namespace, boundSA_name, tier, tool_overrides, label, createdBy, createdAt, revokedAt
               FROM api_keys ${owner ? 'WHERE owner = ?' : ''} ORDER BY createdAt DESC`
  return owner ? db.prepare(sql).all(owner) : db.prepare(sql).all()
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/auth-keys.test.mjs`
Expected: PASS(4 用例)。

- [ ] **Step 5: 回归确认 authorize 测试 + api-key-tools 测试不受列新增影响**

Run: `node --test server/authorize.test.mjs server/api-key-tools.test.mjs`
Expected: PASS(`lookupKey`/`mintKey` 调用因新列可选、默认 null,既有用例无 override 仍绿)。

- [ ] **Step 6: commit**

```bash
git add server/auth-keys.mjs server/auth-keys.test.mjs
git commit -m "feat(auth): api_keys 加 tool_overrides 列 + mint/list 承载(幂等迁移)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `rollout_history` 工具(read 档:列 ReplicaSet revisions)

**Files:**
- Modify: `server/api-key-tools.mjs`(+工具)、`server/authorize.mjs`(BOUNDED_TOOLS 加名)、`server/tool-registry.mjs`(+条目)
- Test: `server/api-key-tools.test.mjs`(+用例 + 扩 mockRequestFn)

**Interfaces:**
- Produces: 工具 `rollout_history`——args `{namespace, name}`,返回 `{namespace, deployment, currentRevision, revisions:[{revision,image,current,createdAt}]}`;经 `runBoundedTool`(read 档)。
- Consumes: `requestFn`、`runBoundedTool`、`enc`(已存在)。

- [ ] **Step 1: 写失败测试** — 在 `server/api-key-tools.test.mjs` 顶部 `mockRequestFn` 增加 `deployment`/`replicasets` 形参与两个 handler(放于现有 `events` handler 之后、`throw` 之前):

```js
function mockRequestFn({ logBody = 'line1\nline2\nline3', deployment = null, replicasets = null } = {}) {
  return async (ctx, path, init = {}) => {
    if (init.method === 'PATCH' && path.endsWith('/scale')) return { body: { spec: { replicas: JSON.parse(init.body).spec.replicas } } }
    if (init.method === 'PATCH') return { body: { ok: true } }
    if (init.method === 'DELETE') return { body: { kind: 'Status', status: 'Success' } }
    if (path === '/.well-known/openid-configuration') return { body: { issuer: 'https://kubernetes.default.svc.cluster.local' } }
    if (path.endsWith('/token')) return { body: { status: { token: 'SA-TOKEN', expirationTimestamp: new Date(Date.now() + 600000).toISOString() } } }
    if (path.includes('/log')) return { body: logBody }
    if (/\/namespaces\/[^/]+\/pods$/.test(path)) return { body: { items: [{ metadata: { name: 'p1' }, status: { phase: 'Running', containerStatuses: [{ name: 'c1', ready: true }] } }, { metadata: { name: 'p2' }, status: { phase: 'Pending' } }] } }
    if (/\/namespaces\/[^/]+\/deployments$/.test(path)) return { body: { items: [{ metadata: { name: 'd1' }, spec: { replicas: 2 }, status: { readyReplicas: 2, updatedReplicas: 2 } }] } }
    if (/\/namespaces\/[^/]+\/pods\/[^/]+$/.test(path)) return { body: { metadata: { name: 'p1', managedFields: [{ x: 1 }] }, status: { phase: 'Running' } } }
    if (/\/namespaces\/[^/]+\/events/.test(path)) return { body: { items: [{ reason: 'BackOff', type: 'Warning', message: 'x'.repeat(400), lastTimestamp: '2026-01-01T00:00:00Z' }] } }
    // --- 新增:Deployment 单体 GET(非 PATCH)+ ReplicaSet 列表(rollout 用)---
    if (init.method !== 'PATCH' && /\/namespaces\/[^/]+\/deployments\/[^/]+$/.test(path)) return { body: deployment || {
      metadata: { name: 'd1', uid: 'uid-d1', annotations: { 'deployment.kubernetes.io/revision': '2' } },
      spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:2' }] } } } } }
    if (/\/namespaces\/[^/]+\/replicasets$/.test(path)) return { body: { items: replicasets || [
      { metadata: { name: 'd1-rs2', uid: 'rs2', ownerReferences: [{ uid: 'uid-d1', kind: 'Deployment', controller: true }], annotations: { 'deployment.kubernetes.io/revision': '2' }, creationTimestamp: '2026-08-06T02:00:00Z' }, spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:2' }] } } } },
      { metadata: { name: 'd1-rs1', uid: 'rs1', ownerReferences: [{ uid: 'uid-d1', kind: 'Deployment', controller: true }], annotations: { 'deployment.kubernetes.io/revision': '1' }, creationTimestamp: '2026-08-06T01:00:00Z' }, spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:1' }] } } } },
    ] } }
    throw new Error('mock: unexpected path ' + path)
  }
}
```

在文件末尾追加用例:
```js
// --- rollout_history(read 档:列 ReplicaSet revisions)---
test('rollout_history(read happy): 列 revisions,降序,current 标记', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'rollout_history', { namespace: 'ns', name: 'd1' })
  assert.equal(out.deployment, 'd1')
  assert.equal(out.currentRevision, '2')
  assert.equal(out.revisions.length, 2)
  assert.equal(out.revisions[0].revision, '2', '降序')
  assert.equal(out.revisions[0].current, true)
  assert.equal(out.revisions[1].revision, '1')
  assert.equal(out.revisions[1].image, 'img:1')
})
test('rollout_history: 只列该 Deployment 的 RS(ownerReference 过滤)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const otherRs = { metadata: { name: 'other-rs', ownerReferences: [{ uid: 'uid-other', kind: 'Deployment', controller: true }], annotations: { 'deployment.kubernetes.io/revision': '5' } }, spec: { template: { spec: { containers: [{ name: 'x', image: 'x' }] } } } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn({ replicasets: [otherRs] }) })
  const out = await tools.callTool(k, cluster, 'rollout_history', { namespace: 'ns', name: 'd1' })
  assert.equal(out.revisions.length, 0, '不属于 d1 的 RS 被过滤')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/api-key-tools.test.mjs`
Expected: FAIL — `未知工具: rollout_history`(callTool 派发不到)。

- [ ] **Step 3: 实现** — `server/api-key-tools.mjs` 的 `tools` 对象内(如 `get_events` 之后)加:

```js
    rollout_history: async (keyRow, cluster, a) => runBoundedTool({
      keyRow, cluster, tool: 'rollout_history', namespace: a.namespace, verb: 'get', resource: `Deployment/${a.name}/rollout`, summary: `deploy=${a.name}`,
      fn: async (saCtx) => {
        const dp = (await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/deployments/${enc(a.name)}`)).body
        if (!dp) throw new Error(`Deployment ${a.name} 不存在`)
        const uid = dp.metadata?.uid
        const curRev = dp.metadata?.annotations?.['deployment.kubernetes.io/revision'] || null
        const { body } = await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/replicasets`)
        const revisions = (body?.items || [])
          .filter(rs => (rs.metadata?.ownerReferences || []).some(o => o.uid === uid && o.kind === 'Deployment'))
          .map(rs => ({
            revision: rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || null,
            image: rs.spec?.template?.spec?.containers?.[0]?.image || null,
            current: rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] === curRev,
            createdAt: rs.metadata?.creationTimestamp || null,
          }))
          .sort((x, y) => (Number(y.revision) || 0) - (Number(x.revision) || 0))
        return { namespace: a.namespace, deployment: a.name, currentRevision: curRev, revisions }
      } }),
```

`server/authorize.mjs` 的 `BOUNDED_TOOLS` 末尾加 `'rollout_history'`:
```js
export const BOUNDED_TOOLS = ['list_resources', 'get_resource', 'get_pod_logs', 'get_events', 'can_i', 'get_resource_yaml', 'scale', 'restart', 'rollout_history']
```

`server/tool-registry.mjs` 的 `K8S` 数组末尾(最后一个工具后)加条目:
```js
  { name: 'rollout_history', minTier: 'read', requiresApproval: false,
    description: '列出 Deployment 的滚动发布历史(ReplicaSet revisions:image / 当前 revision 标记 / 创建时间),按 revision 降序。先调它看可回滚的 revision,再 rollout_undo。',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, name: { type: 'string', description: 'Deployment 名' } }, required: ['namespace', 'name'] } },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/api-key-tools.test.mjs`
Expected: PASS(含 2 新用例;既有用例因 mockRequestFn 向后兼容仍绿——新形参有默认值)。

- [ ] **Step 5: commit**

```bash
git add server/api-key-tools.mjs server/api-key-tools.test.mjs server/authorize.mjs server/tool-registry.mjs
git commit -m "feat(mcp): 接通 rollout_history(底座补全 7/11,read 档列 RS revisions)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `rollout_undo` 工具(admin 档:回滚到 revision)

**Files:**
- Modify: `server/api-key-tools.mjs`(+工具)、`server/tool-registry.mjs`(+条目;`rollout_undo` 已在 DANGEROUS_TOOLS)
- Test: `server/api-key-tools.test.mjs`(+用例)

**Interfaces:**
- Produces: 工具 `rollout_undo`——args `{namespace, name, toRevision}`,取目标 RS template PATCH 回 Deployment;返回 `{undone, toRevision, previousImage, newImage}`;经 `runBoundedTool`(admin 档,人审)。
- Consumes: Task 3 的 mockRequestFn(已支持 deployment GET + replicasets list)。

- [ ] **Step 1: 写失败测试** — 在 `server/api-key-tools.test.mjs` 末尾追加:

```js
// --- rollout_undo(admin 档:回滚到 revision)---
test('rollout_undo(admin happy): PATCH deployment template 成目标 RS template', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let patched = null
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (init.method === 'PATCH' && /\/deployments\/[^/]+$/.test(path)) { patched = JSON.parse(init.body); return { body: { ok: true } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'rollout_undo', { namespace: 'ns', name: 'd1', toRevision: 1 })
  assert.equal(out.undone, 'd1'); assert.equal(out.toRevision, 1)
  assert.equal(out.previousImage, 'img:2'); assert.equal(out.newImage, 'img:1')
  assert.deepEqual(patched, { spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:1' }] } } } }, 'PATCH 成 revision1 的 template')
  const rows = db.prepare('SELECT result FROM audit_log ORDER BY seq').all()
  assert.equal(rows[rows.length - 1].result, 'ok')
})
test('rollout_undo: 缺 toRevision → 报错;revision 不存在 → 报错;read 档 → policy 拒', async () => {
  const db = makeDb()
  const admin = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  const read = mintKey(db, { owner: 'b', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(admin, cluster, 'rollout_undo', { namespace: 'ns', name: 'd1' }), /toRevision/)
  await assert.rejects(tools.callTool(admin, cluster, 'rollout_undo', { namespace: 'ns', name: 'd1', toRevision: 99 }), /不存在/)
  await assert.rejects(tools.callTool(read, cluster, 'rollout_undo', { namespace: 'ns', name: 'd1', toRevision: 1 }), (e) => e.reason === 'policy')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/api-key-tools.test.mjs`
Expected: FAIL — `未知工具: rollout_undo`。

- [ ] **Step 3: 实现** — `server/api-key-tools.mjs` 的 `tools` 对象内(`rollout_history` 之后)加:

```js
    rollout_undo: async (keyRow, cluster, a) => runBoundedTool({
      keyRow, cluster, tool: 'rollout_undo', namespace: a.namespace, verb: 'patch', resource: `Deployment/${a.name}/rollback`, summary: `deploy=${a.name} →rev=${a.toRevision}`,
      fn: async (saCtx) => {
        if (a.toRevision == null || a.toRevision === '') throw new Error('rollout_undo 缺 toRevision(先 rollout_history 看 revisions)')
        const dp = (await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/deployments/${enc(a.name)}`)).body
        if (!dp) throw new Error(`Deployment ${a.name} 不存在`)
        const prevImage = dp.spec?.template?.spec?.containers?.[0]?.image || null
        const { body } = await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/replicasets`)
        const target = (body?.items || []).find(rs => rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] === String(a.toRevision))
        if (!target) throw new Error(`revision ${a.toRevision} 不存在`)
        const newImage = target.spec?.template?.spec?.containers?.[0]?.image || null
        await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/deployments/${enc(a.name)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/strategic-merge-patch+json' },
          body: JSON.stringify({ spec: { template: target.spec.template } }),
        })
        return { undone: a.name, toRevision: Number(a.toRevision), previousImage: prevImage, newImage }
      } }),
```

`server/tool-registry.mjs` 的 `K8S` 数组加条目:
```js
  { name: 'rollout_undo', minTier: 'admin', requiresApproval: true,
    description: '把 Deployment 回滚到指定 revision(kubectl rollout undo --to-revision=N 语义):取目标 ReplicaSet 的完整 template PATCH 回 Deployment。admin 档:内置 agent 需人审 / 外部 MCP 走 admin key。先 rollout_history 取 revision。',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, name: { type: 'string', description: 'Deployment 名' }, toRevision: { type: 'number', description: '目标 revision(从 rollout_history 结果取)' } }, required: ['namespace', 'name', 'toRevision'] } },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/api-key-tools.test.mjs`
Expected: PASS(2 新用例 + 全回归)。

- [ ] **Step 5: commit**

```bash
git add server/api-key-tools.mjs server/api-key-tools.test.mjs server/tool-registry.mjs
git commit -m "feat(mcp): 接通 rollout_undo(底座补全 8/11,admin 档回滚到 revision)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: `update_image` 工具(admin 档:set image)

**Files:**
- Modify: `server/api-key-tools.mjs`(+工具)、`server/tool-registry.mjs`(+条目;`update_image` 已在 DANGEROUS_TOOLS)
- Test: `server/api-key-tools.test.mjs`(+用例)

**Interfaces:**
- Produces: 工具 `update_image`——args `{namespace, kind, name, container, image}`,先 GET 校验容器名,再 strategic-merge-patch 镜像;返回 `{kind, name, container, previousImage, newImage}`;经 `runBoundedTool`(admin 档)。
- Consumes: `GET_PATH`、`WORKLOADS`(已存在)、Task 3 的 mockRequestFn。

- [ ] **Step 1: 写失败测试** — 在 `server/api-key-tools.test.mjs` 末尾追加:

```js
// --- update_image(admin 档:set image)---
test('update_image(admin happy): PATCH 容器镜像,返 previous/new', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let patched = null
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (init.method === 'PATCH' && /\/deployments\/[^/]+$/.test(path)) { patched = JSON.parse(init.body); return { body: { ok: true } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'update_image', { namespace: 'ns', kind: 'deployments', name: 'd1', container: 'c1', image: 'img:9' })
  assert.equal(out.newImage, 'img:9'); assert.equal(out.previousImage, 'img:2')
  assert.deepEqual(patched, { spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:9' }] } } } })
})
test('update_image: 不支持 kind / 容器不存在 → 报错;read 档 → policy 拒', async () => {
  const db = makeDb()
  const admin = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  const read = mintKey(db, { owner: 'b', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(admin, cluster, 'update_image', { namespace: 'ns', kind: 'ingresses', name: 'x', container: 'c', image: 'i' }), /仅支持/)
  await assert.rejects(tools.callTool(admin, cluster, 'update_image', { namespace: 'ns', kind: 'deployments', name: 'd1', container: 'nope', image: 'i' }), /不存在/)
  await assert.rejects(tools.callTool(read, cluster, 'update_image', { namespace: 'ns', kind: 'deployments', name: 'd1', container: 'c1', image: 'i' }), (e) => e.reason === 'policy')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/api-key-tools.test.mjs`
Expected: FAIL — `未知工具: update_image`。

- [ ] **Step 3: 实现** — `server/api-key-tools.mjs` 的 `tools` 对象内(`rollout_undo` 之后)加:

```js
    update_image: async (keyRow, cluster, a) => {
      const kind = String(a.kind || '').toLowerCase()
      return runBoundedTool({ keyRow, cluster, tool: 'update_image', namespace: a.namespace, verb: 'patch', resource: `${kind}/${a.name}`, summary: `${kind}/${a.name} ${a.container}=${(a.image || '').slice(0, 40)}`,
        fn: async (saCtx) => {
          if (!WORKLOADS.includes(kind)) throw new Error(`update_image 仅支持 ${WORKLOADS.join('/')},不是 ${kind}`)
          if (!a.container) throw new Error('update_image 缺 container')
          if (!a.image) throw new Error('update_image 缺 image')
          const getter = GET_PATH[kind]
          const cur = (await requestFn(saCtx, getter(a.namespace, a.name))).body
          if (!cur) throw new Error(`${kind}/${a.name} 不存在`)
          const containers = cur?.spec?.template?.spec?.containers || []
          const targetC = containers.find(c => c.name === a.container)
          if (!targetC) throw new Error(`容器 ${a.container} 不存在于 ${kind}/${a.name}(有: ${containers.map(c => c.name).join(',')})`)
          await requestFn(saCtx, getter(a.namespace, a.name), {
            method: 'PATCH', headers: { 'content-type': 'application/strategic-merge-patch+json' },
            body: JSON.stringify({ spec: { template: { spec: { containers: [{ name: a.container, image: a.image }] } } } }),
          })
          return { kind, name: a.name, container: a.container, previousImage: targetC.image || null, newImage: a.image }
        } })
    },
```

`server/tool-registry.mjs` 的 `K8S` 数组加条目:
```js
  { name: 'update_image', minTier: 'admin', requiresApproval: true,
    description: '更新工作负载某容器的镜像(kubectl set image 语义)。先校验容器名存在再 strategic-merge-patch。admin 档:需人审/admin key。kind: deployments/statefulsets/daemonsets。',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, kind: { type: 'string', enum: ['deployments', 'statefulsets', 'daemonsets'] }, name: { type: 'string' }, container: { type: 'string' }, image: { type: 'string', description: '新镜像,如 nginx:1.25' } }, required: ['namespace', 'kind', 'name', 'container', 'image'] } },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/api-key-tools.test.mjs`
Expected: PASS(2 新用例 + 全回归)。

- [ ] **Step 5: commit**

```bash
git add server/api-key-tools.mjs server/api-key-tools.test.mjs server/tool-registry.mjs
git commit -m "feat(mcp): 接通 update_image(底座补全:11 个 admin/read stub 全接通)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 把 `effectiveTools` 接进广告路径(MCP tools/list + agent offering)

**Files:**
- Modify: `server/tool-registry.mjs`(+`toolDefsFor`)、`server/mcp.mjs`(tools/list)、`server/agent-runner.mjs`(offering)
- Test: `server/tool-registry` 用例补在 `server/workbench-agent.test.mjs`;`server/mcp.test.mjs` 既有用例无 override 仍绿

**Interfaces:**
- Produces: `registry.toolDefsFor(names) → toolDef[]`(按显式名字集取 def,忽略 minTier——使覆盖能把 admin 工具暴露给 operator key);MCP `tools/list` 与 agent offering 改用 `effectiveTools(keyRow)`。
- Consumes: `effectiveTools` from Task 1。

- [ ] **Step 1: 写失败测试** — 在 `server/workbench-agent.test.mjs` 追加(顶部 import 已有 `registry`):

```js
test('registry.toolDefsFor: 按显式名字集取 def(忽略 minTier,使覆盖可越过 tier)', () => {
  const defs = registry.toolDefsFor(['get_pod_logs', 'exec_pod'])
  const names = defs.map(t => t.function.name)
  assert.ok(names.includes('get_pod_logs'))
  assert.ok(names.includes('exec_pod'))
  assert.equal(defs[0].type, 'function')
  // 未知名静默忽略(不抛)
  assert.equal(registry.toolDefsFor(['bogus_name']).length, 0)
  // 支持传 Set
  assert.ok(registry.toolDefsFor(new Set(['scale'])).map(t => t.function.name).includes('scale'))
})
```

在 `server/mcp.test.mjs` 追加一个覆盖场景(顶部已有 `readKey`/`opKey`;`mockTools` 见该文件):
```js
test('tools/list(覆盖): effectiveTools allow 把 admin 工具暴露给 read key', async () => {
  const readWithAllow = { ...readKey, tool_overrides: JSON.stringify({ allow: ['exec_pod'] }) }
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { keyRow: readWithAllow, cluster, apiKeyTools: mockTools() })
  const names = r.result.tools.map(t => t.name)
  assert.ok(names.includes('exec_pod'), 'allow 越过 tier 出现在 tools/list')
})
```
> 注:`mockTools().listTools()` 需含 `exec_pod`(若不含,在该 test 内用 `apiKeyTools: { listTools: () => [...], callTool: ... }` 内联;`tools/list` 只用 `listTools()`。读 `server/mcp.test.mjs` 确认 `mockTools` 的 `listTools` 返回集,若不含 exec_pod 则内联覆盖。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/workbench-agent.test.mjs server/mcp.test.mjs`
Expected: FAIL — `registry.toolDefsFor` 不是函数;`tools/list` 未含覆盖的 exec_pod。

- [ ] **Step 3: 实现 `registry.toolDefsFor`** — `server/tool-registry.mjs` 的 `registry` 对象内(`toolDefsForTier` 之后)加:

```js
  // 按显式名字集取 def(忽略 minTier):供 effectiveTools(per-key 覆盖)用——覆盖可越过 tier。
  // 未知名静默忽略(不抛);接受数组或 Set。
  toolDefsFor: (names) => { const set = names instanceof Set ? names : new Set(names); return ENTRIES.filter(t => set.has(t.name)).map(toDef) },
```

- [ ] **Step 4: 实现 mcp.mjs tools/list** — `server/mcp.mjs`:改 import 与 tools/list:

```js
import { effectiveTools } from './authorize.mjs'   // 原来是 tierTools
```
```js
  if (method === 'tools/list') {
    const allowed = effectiveTools(keyRow)         // 原来是 tierTools(keyRow.tier)
    const tools = apiKeyTools.listTools().filter(t => allowed.has(t)).map(t => ({ name: t, ...TOOL_META[t] }))  // .has 替 .includes
    return ok(id, { tools })
  }
```

- [ ] **Step 5: 实现 agent-runner offering** — `server/agent-runner.mjs`:

顶部加 import:
```js
import { effectiveTools } from './authorize.mjs'
```
`createAgentRunner` 内把第 17 行改为按 effectiveTools 取 def(`buildToolDefs(tier)` 保持不变——仅测试用):
```js
  const toolDefs = [
    ...(keyRow ? registry.toolDefsFor(effectiveTools(keyRow)) : []),
    ...(workbench ? registry.workbenchToolDefs() : []),
  ]
```

- [ ] **Step 6: 跑测试确认通过 + 全回归**

Run: `node --test server/workbench-agent.test.mjs server/mcp.test.mjs server/agent-runner.test.mjs`
Expected: PASS。`agent-runner.test.mjs` 测的是 `buildToolDefs(tier)`(未改)→ 绿;`mcp.test.mjs` 既有 `readKey`/`opKey` 无 `tool_overrides` → `effectiveTools` 回退 tierTools → 绿。

- [ ] **Step 7: commit**

```bash
git add server/tool-registry.mjs server/mcp.mjs server/agent-runner.mjs server/workbench-agent.test.mjs server/mcp.test.mjs
git commit -m "feat(auth): 广告路径(MCP tools/list + agent offering)接 effectiveTools(per-key 覆盖生效)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 端点(mint 传 overrides + PATCH overrides)

**Files:**
- Modify: `server/index.mjs`(mint 路由 + 新 PATCH 路由)
- Test: 手测/集成(端点薄,逻辑在 mintKey/normalizeToolOverrides 已单测);补一个 PATCH 端点解析测试可选——这里用 `node --check` 守语法 + 跑全量回归兜底

**Interfaces:**
- Produces: `POST /api/admin/apikeys` 透传 `tool_overrides`;`PATCH /api/admin/apikeys/:id/overrides`(body `{tool_overrides}`)→ 校验+更新,不重签 secret。
- Consumes: `normalizeToolOverrides` from Task 1、`mintKey` from Task 2。

- [ ] **Step 1: 加 import** — `server/index.mjs` 顶部 authorize 相关 import 行(若无则新增):

```js
import { normalizeToolOverrides } from './authorize.mjs'
```

- [ ] **Step 2: mint 路由透传** — 改 `POST /api/admin/apikeys`(约 index.mjs:1627)的 `mintKey(db, {...})` 加一行 `tool_overrides`:

```js
      const k = mintKey(db, {
        owner: input.owner || ps.username,
        clusterId: input.clusterId,
        boundSA_namespace: input.boundSA_namespace,
        boundSA_name: input.boundSA_name,
        tier: input.tier || 'read',
        tool_overrides: input.tool_overrides ?? null,
        label: input.label || null,
        createdBy: ps.username,
      })
```

- [ ] **Step 3: 新增 PATCH overrides 路由** — 紧挨 DELETE 路由(约 index.mjs:1640)之前插入:

```js
  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/admin\/apikeys\/[^/]+\/overrides$/)) {
    const ps = requireAdmin(req, res); if (!ps) return
    try {
      const id = decodeURIComponent(url.pathname.split('/')[4])
      const input = await readBody(req)
      const json = normalizeToolOverrides(input.tool_overrides)  // strict: 坏→抛
      const changes = db.prepare('UPDATE api_keys SET tool_overrides = ? WHERE id = ? AND revokedAt IS NULL').run(json, id).changes
      if (!changes) return sendJson(res, 404, { message: 'API key 不存在或已吊销' })
      return sendJson(res, 200, { ok: true, id, tool_overrides: json })
    } catch (e) { return sendJson(res, e.status || 400, { message: e.message || '更新覆盖失败' }) }
  }
```

- [ ] **Step 4: 语法 + 全回归**

Run: `node --check server/index.mjs && node --test server/*.test.mjs`
Expected: `node --check` 通过;全部 server 测试 PASS。

- [ ] **Step 5: commit**

```bash
git add server/index.mjs
git commit -m "feat(auth): mint 透传 tool_overrides + PATCH /apikeys/:id/overrides(不重签)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: UI——mint 覆盖编辑 + 列表展示/编辑覆盖

**Files:**
- Modify: `src/views/admin/ApiKeyManagement.vue`、`src/api/client.js`

**Interfaces:**
- Consumes: `POST /api/admin/apikeys`(带 `tool_overrides`)、`PATCH .../overrides`(Task 7)。
- Produces: mint modal 内「高级:工具覆盖」编辑器(deny=tier 内关掉的;allow=tier 外打开的);列表多一列展示覆盖摘要 + 「编辑」入口(modal 调 PATCH)。

- [ ] **Step 1: client 加方法** — `src/api/client.js` 的 `apikeys` 对象(`remove` 之后)加:

```js
    updateOverrides: (id, tool_overrides) => platformHttp.request(`/api/admin/apikeys/${encodeURIComponent(id)}/overrides`, { method: 'PATCH', body: JSON.stringify({ tool_overrides }) }),
```

- [ ] **Step 2: 给 ApiKeyManagement.vue `<script setup>` 加状态与目录** — 在 `mintForm` 定义后追加:

```js
// 工具目录(镜像 server tierTools;仅 K8s 工具,覆盖管辖范围)
const TOOL_CATALOG = {
  read: ['get_pod_logs', 'list_resources', 'get_resource', 'get_events', 'rollout_history'],
  operator: ['get_pod_logs', 'list_resources', 'get_resource', 'get_events', 'rollout_history', 'scale', 'restart'],
  admin: ['get_pod_logs', 'list_resources', 'get_resource', 'get_events', 'rollout_history', 'scale', 'restart', 'exec_pod', 'browse_files', 'read_file', 'apply_yaml', 'delete_resource', 'kubectl_debug', 'rollout_undo', 'update_image'],
}
const ALL_TOOLS = TOOL_CATALOG.admin
const tierDefault = tier => TOOL_CATALOG[tier] || []
// mint 覆盖状态:denySet(tier 内被关掉的)/allowSet(tier 外打开的)
const denySet = ref(new Set())
const allowSet = ref(new Set())
function resetOverrideEditor(tier) {
  denySet.value = new Set(); allowSet.value = new Set()
}
function buildOverridesPayload() {
  const allow = [...allowSet.value]; const deny = [...denySet.value]
  const ov = {}; if (allow.length) ov.allow = allow; if (deny.length) ov.deny = deny
  return Object.keys(ov).length ? ov : null
}
// 列表展示:把 DB 的 tool_overrides 串解析成摘要
const overrideSummary = k => {
  if (!k.tool_overrides) return ''
  let ov; try { ov = JSON.parse(k.tool_overrides) } catch { return '(损坏)' }
  const parts = []; (ov.allow || []).forEach(t => parts.push(`+${t}`)); (ov.deny || []).forEach(t => parts.push(`−${t}`))
  return parts.join(' ') || ''
}

// 编辑既有 key 覆盖
const showOverrideModal = ref(false)
const editingKey = ref(null)
const editDeny = ref(new Set()); const editAllow = ref(new Set())
function openOverrideEditor(k) {
  editingKey.value = k; editDeny.value = new Set(); editAllow.value = new Set()
  if (k.tool_overrides) { try { const ov = JSON.parse(k.tool_overrides); (ov.allow || []).forEach(t => editAllow.value.add(t)); (ov.deny || []).forEach(t => editDeny.value.add(t)) } catch { /* 损坏→空 */ } }
  showOverrideModal.value = true
}
async function saveOverrides() {
  const allow = [...editAllow.value]; const deny = [...editDeny.value]
  const ov = {}; if (allow.length) ov.allow = allow; if (deny.length) ov.deny = deny
  try { await adminApi.apikeys.updateOverrides(editingKey.value.id, Object.keys(ov).length ? ov : null); notify('success', '覆盖已更新'); showOverrideModal.value = false; load() }
  catch (e) { notify('error', e.message || '更新失败') }
}
```

- [ ] **Step 3: doMint 发送 + reset** — 改 `doMint` 与打开 mint modal 处带上覆盖:

`doMint` 内 `adminApi.apikeys.create(mintForm.value)` 改为:
```js
    const payload = { ...mintForm.value, tool_overrides: buildOverridesPayload() }
    const res = await adminApi.apikeys.create(payload)
```
打开 mint modal 的按钮 `@click="showMintModal = true"` 改 `@click="showMintModal = true; resetOverrideEditor(mintForm.tier)"`。

- [ ] **Step 4: mint modal 模板加覆盖编辑器** — 在 mint Modal 内 tier `<select>` 块之后插入(`onchange` 同步重置 editor 时保留已选需另写,这里切换 tier 重置——简单可靠):

```html
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">高级:工具覆盖(tier 之上 ± 每工具)</label>
          <div class="bg-surface-container-low border border-outline-variant rounded-lg p-sm flex flex-col gap-xs">
            <div class="flex flex-wrap gap-1">
              <span class="text-body-xs text-on-surface-variant w-full">{{ mintForm.tier }} 档默认(关掉=deny):</span>
              <button v-for="t in tierDefault(mintForm.tier)" :key="t" type="button"
                @click="denySet.has(t) ? denySet.delete(t) : denySet.add(t); denySet = new Set(denySet)"
                class="px-1.5 py-0.5 rounded text-body-xs font-mono"
                :class="denySet.has(t) ? 'bg-error/15 text-error line-through' : 'bg-primary/10 text-primary'">{{ t }}</button>
            </div>
            <div class="flex flex-wrap gap-1">
              <span class="text-body-xs text-on-surface-variant w-full">越过 tier 追加(打开=allow):</span>
              <button v-for="t in ALL_TOOLS.filter(x => !tierDefault(mintForm.tier).includes(x))" :key="t" type="button"
                @click="allowSet.has(t) ? allowSet.delete(t) : allowSet.add(t); allowSet = new Set(allowSet)"
                class="px-1.5 py-0.5 rounded text-body-xs font-mono"
                :class="allowSet.has(t) ? 'bg-status-running/20 text-status-running font-semibold' : 'bg-surface-container-high text-on-surface-variant'">{{ t }}</button>
            </div>
            <p class="text-body-xs text-on-surface-variant">⚠️ allow 可越过 tier,但 SA 的真实 RBAC 才决定能否执行(策略放行、RBAC 拒→审计 error)。</p>
          </div>
        </div>
```

- [ ] **Step 5: 列表加覆盖列 + 编辑入口** — `headers` 数组在 `tier` 后加 `{ key: 'overrides', label: '覆盖' }`;DataTable 内加具名插槽:

```html
      <template #overrides="{ row }">
        <span v-if="overrideSummary(row)" class="font-mono text-body-xs text-on-surface-variant">{{ overrideSummary(row) }}</span>
        <span v-else class="text-body-xs text-on-surface-variant/50">—</span>
      </template>
```
`actions` 插槽内在吊销按钮前加编辑按钮:
```html
        <button v-if="!row.revokedAt" @click.stop="openOverrideEditor(row)" class="p-1 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary" title="编辑工具覆盖"><span class="material-symbols-outlined text-base">tune</span></button>
```

- [ ] **Step 6: 编辑覆盖 Modal** — 在明文展示 Modal 之后追加(复用 tierDefault/editDeny/editAllow):

```html
    <Modal v-model="showOverrideModal" :title="`编辑工具覆盖 · ${editingKey?.prefix}…`" width="max-w-xl">
      <div v-if="editingKey" class="flex flex-col gap-md">
        <p class="text-body-xs text-on-surface-variant">tier=<b>{{ editingKey.tier }}</b>;SA={{ editingKey.boundSA_namespace }}/{{ editingKey.boundSA_name }}。改完无需重签 key。</p>
        <div class="flex flex-wrap gap-1">
          <span class="text-body-xs text-on-surface-variant w-full">{{ editingKey.tier }} 档默认(关掉=deny):</span>
          <button v-for="t in tierDefault(editingKey.tier)" :key="t" type="button"
            @click="editDeny.has(t) ? editDeny.delete(t) : editDeny.add(t); editDeny = new Set(editDeny)"
            class="px-1.5 py-0.5 rounded text-body-xs font-mono"
            :class="editDeny.has(t) ? 'bg-error/15 text-error line-through' : 'bg-primary/10 text-primary'">{{ t }}</button>
        </div>
        <div class="flex flex-wrap gap-1">
          <span class="text-body-xs text-on-surface-variant w-full">越过 tier 追加(打开=allow):</span>
          <button v-for="t in ALL_TOOLS.filter(x => !tierDefault(editingKey.tier).includes(x))" :key="t" type="button"
            @click="editAllow.has(t) ? editAllow.delete(t) : editAllow.add(t); editAllow = new Set(editAllow)"
            class="px-1.5 py-0.5 rounded text-body-xs font-mono"
            :class="editAllow.has(t) ? 'bg-status-running/20 text-status-running font-semibold' : 'bg-surface-container-high text-on-surface-variant'">{{ t }}</button>
        </div>
      </div>
      <template #actions>
        <button @click="showOverrideModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
        <button @click="saveOverrides" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">保存</button>
      </template>
    </Modal>
```

- [ ] **Step 7: 前端校验 — typecheck + build + unit**

Run: `npm run typecheck && npm run build`
Expected: `node --check` 全过;`npm run build` 成功(覆盖 `.vue` 编译)。

- [ ] **Step 8: commit**

```bash
git add src/api/client.js src/views/admin/ApiKeyManagement.vue
git commit -m "feat(ui): API key 管理加每工具覆盖编辑(mint + 列表展示/编辑,调 PATCH)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: 延后工具登记 + 全量验证

**Files:**
- Modify: `server/authorize.mjs`(`DANGEROUS_TOOLS` 上方注释)

- [ ] **Step 1: 登记延后理由** — `server/authorize.mjs` 的 `DANGEROUS_TOOLS` 定义上方加注释:

```js
// 延后接通(对 stateless MCP 价值低/风险高,见 docs/superpowers/specs/2026-08-06-mcp-rollout-and-per-tool-override-design.md「显式延后」):
//   attach(streaming)、port_forward(网关主机 TCP 监听,外部 AI 拿到不可达 localhost)、upload_file(exec 写文件,转义/注入面大)。
// 这些名留在 DANGEROUS_TOOLS 以保持 tier 组合的完整性;未实现 → 不进 apiKeyTools.listTools() → tools/list 自然不广告。
export const DANGEROUS_TOOLS = ['exec_pod', 'attach', 'browse_files', 'read_file', 'upload_file', 'port_forward', 'kubectl_debug', 'rollout_undo', 'apply_yaml', 'delete_resource', 'update_image']
```

- [ ] **Step 2: 全量验证(三套)**

Run: `npm test && npm run typecheck && npm run build`
Expected:
- `npm test`:所有 server `*.test.mjs` PASS(含 authorize/auth-keys/api-key-tools/mcp/workbench-agent/agent-runner + 自研运行器纯逻辑)。
- `npm run typecheck`:`node --check` 全 `.js`/`.mjs` 通过。
- `npm run build`:Vite 构建成功(`.vue` 编译覆盖)。

- [ ] **Step 3: (可选)前端单测** — 若 `ApiKeyManagement.vue` 有 vitest 用例则跑;无则跳过(UI 改动以 build 兜底)。

Run: `npm run test:unit 2>/dev/null || true`

- [ ] **Step 4: commit**

```bash
git add server/authorize.mjs
git commit -m "docs(mcp): 登记 attach/port_forward/upload_file 延后理由(stateless MCP 适配性)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 5: 更新项目记忆** — 更新 `~/.claude/projects/.../memory/apikey-mcp-agent-base.md` 第 35 行「6/11」→「11/11 已接通(rollout_history/rollout_undo/update_image 本轮)+ 每工具覆盖(tool_overrides)已上线;延后 attach/port_forward/upload_file」。

---

## Self-Review(写完后自查,已修正)

**1. Spec 覆盖:**
- 三个新工具(rollout_history/rollout_undo/update_image)→ Task 3/4/5 ✓
- `tool_overrides` 列 + 组合语义(tier ∪ allow − deny)→ Task 1/2 ✓
- 三处广告路径改用 effectiveTools(MCP/agent/registry)→ Task 6 ✓
- 校验(未知名/allow∩deny/坏形状)→ Task 1 normalizeToolOverrides ✓
- mint 接受 + PATCH 不重签 + listKeys 返回 → Task 2/7 ✓
- UI(mint 编辑 + 列表展示/编辑)→ Task 8 ✓
- 延后 3 个登记理由 → Task 9 ✓
- 损坏 JSON fail-open 到 tier → Task 1 effectiveTools ✓

**2. 类型/签名一致性:**
- `effectiveTools(keyRow) → Set` 在 Task 1 定义,Task 6 三处消费均用 `.has`/`toolDefsFor(set)` ✓
- `normalizeToolOverrides(raw) → string|null` 在 Task 1 定义,Task 2 mintKey + Task 7 端点消费 ✓
- `registry.toolDefsFor(names)` Task 6 定义,接受数组或 Set ✓
- `mintKey` 返回 `tool_overrides` 字段贯穿 listKeys/lookupKey ✓

**3. 无占位符:** 所有步骤含可执行代码或确切命令;mockRequestFn 扩展完整;无 "TODO/类似 Task N"。

**4. 已知简化(非占位):**
- agent chat 端点的 system prompt 仍按 `tier` 判 canWrite(Task 7 未改)——属建议性文案,实际能力由 offering(effectiveTools)与 approval 门判定;覆盖让 operator 越权 admin 工具时,文案可能偏保守,但不影响正确性。后续可按 `effectiveTools` 精化(非本轮范围)。
- `TOOL_CATALOG`(Task 8)与 server `tierTools` 镜像重复——UI 配置用,工具名稳定;若后续工具增减需双改(可接受)。
