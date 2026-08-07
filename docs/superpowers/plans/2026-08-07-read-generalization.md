# 读通用化(path-based)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 MCP 读工具支持任意 kind/CRD:新增 `get_resource_yaml`(path-based GET,返 YAML)+ `list_resources` 加可选 `path`;抽 `assertPathInNs` 并收紧 `delete_resource` 的 path-ns。

**Architecture:** path-based(对齐 `delete_resource`)。`assertPathInNs(path, ns)` 解析 path 的 `/namespaces/<x>/` 强制 === 绑定 ns,集群级/他 ns → policy 拒。`get_resource_yaml` 用 `js-yaml` dump(去 managedFields,32KB 截断)。`list_resources` 的 `path` 优先(任意 kind),`kind` 快捷(6 kind)向后兼容。

**Tech Stack:** Node.js(`node:test` + `node:sqlite` + `node --check`),`js-yaml`(已有依赖)。零新依赖。

## Global Constraints

- **零新外部依赖**:`js-yaml` 已是依赖(`server/index.mjs` 已 import);测试 `node --test`;类型 `node --check`。
- **接线铁律**:新工具经 `runBoundedTool`(authorize→ns→reserve→SA-token→fn→finalize)。
- **ns 作用域**:`assertPathInNs(path, boundSA_namespace)` 解析 `/namespaces/<x>/`;集群级 path(无该段)或他 ns → `PermissionDeniedError('policy')`。ns-bound key = ns-scoped。
- **有界输出**:`get_resource_yaml` 的 YAML 截 `LOG_BYTE_MAX`(32768)+ `truncated` 标志(对齐 `get_pod_logs`)。
- `get_resource_yaml` 已在 `BOUNDED_TOOLS`(read 档自动含)——**不改 `authorize.mjs`**,只加 tool 实现 + registry 条目。
- **commit 风格**:`feat(mcp): …`,末尾 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- **测试命令**:`node --test server/api-key-tools.test.mjs`;回归 `npm test`。

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `server/api-key-tools.mjs` | runBoundedTool + tools | +`assertPathInNs` 导出;+`get_resource_yaml`;`list_resources` 加 path 分支;`delete_resource` 加 assertPathInNs;+`js-yaml` import |
| `server/api-key-tools.test.mjs` | tools 测试 | +assertPathInNs/get_resource_yaml/list(path)/delete(收紧) 用例 |
| `server/tool-registry.mjs` | 工具 metadata | +`get_resource_yaml` 条目;`list_resources` 描述加 path |

---

### Task 1: `assertPathInNs` helper + `delete_resource` 收紧

**Files:**
- Modify: `server/api-key-tools.mjs`(helper + delete_resource fn)
- Test: `server/api-key-tools.test.mjs`

**Interfaces:**
- Produces: `assertPathInNs(path, ns)`(命名导出,纯函数:无 `/namespaces/<x>/` → throw '集群级';`<x>!==ns` → throw '超出绑定 ns';否则通过)。`delete_resource` fn 首行调它。
- Consumes: `PermissionDeniedError`(已 import)。

- [ ] **Step 1: 写失败测试** — 追加到 `server/api-key-tools.test.mjs`(顶部 import 加 `assertPathInNs`):

```js
import { resolveApiKey, createApiKeyTools, _clearIssuerCacheForTest, assertPathInNs } from './api-key-tools.mjs'
```
```js
// --- assertPathInNs(ns 作用域按 path 解析)---
test('assertPathInNs: 集群级 path(无 /namespaces/<x>/)→ 拒', () => {
  assert.throws(() => assertPathInNs('/api/v1/persistentvolumes/pv1', 'ns'), /集群级/)
  assert.throws(() => assertPathInNs('/apis/rbac.authorization.k8s.io/v1/clusterroles/admin', 'ns'), /集群级/)
})
test('assertPathInNs: 他 ns path → 拒(超出绑定 ns)', () => {
  assert.throws(() => assertPathInNs('/api/v1/namespaces/other/pods/p1', 'ns'), /超出绑定 ns other/)
})
test('assertPathInNs: 绑定 ns path → 通过', () => {
  assert.doesNotThrow(() => assertPathInNs('/apis/networking.k8s.io/v1/namespaces/ns/ingresses/foo', 'ns'))
  assert.doesNotThrow(() => assertPathInNs('/api/v1/namespaces/ns/pods/p1', 'ns'))
})

// --- delete_resource 收紧(path-ns 校验)---
test('delete_resource: path ns ≠ 绑定 ns → policy 拒(assertPathInNs)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(
    tools.callTool(k, cluster, 'delete_resource', { namespace: 'ns', path: '/api/v1/namespaces/other/pods/p1' }),
    (e) => e.code === 'PERMISSION_DENIED' && e.reason === 'policy',
  )
})
test('delete_resource: 集群级 path → policy 拒', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(
    tools.callTool(k, cluster, 'delete_resource', { namespace: 'ns', path: '/api/v1/persistentvolumes/pv1' }),
    (e) => e.reason === 'policy',
  )
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/api-key-tools.test.mjs`
Expected: FAIL — `assertPathInNs` 未导出;delete 他 ns path 不拒(当前 delete 只校验 namespace arg,path 直用)。

- [ ] **Step 3: 实现** — `server/api-key-tools.mjs`:

在 `safePodPath` 之后加 helper(命名导出,便于单测):
```js
// path-ns 作用域:解析 path 的 /namespaces/<x>/,强制 <x> === 绑定 ns;集群级 path 或他 ns → policy 拒。
// delete_resource 旧实现只校验 namespace arg、不校验 path 实际 ns —— 本 helper 补 policy 层闭环。
export function assertPathInNs(path, ns) {
  const m = String(path || '').match(/\/namespaces\/([^/]+)\//)
  if (!m) throw new PermissionDeniedError('policy', { detail: `path 非命名空间资源(集群级),ns 绑定 key 不允许: ${String(path).slice(0, 80)}` })
  if (m[1] !== ns) throw new PermissionDeniedError('policy', { detail: `path 命名空间 ${m[1]} 超出绑定 ns ${ns}` })
}
```

`delete_resource` fn 首行(在 `if (!a.path) throw ...` 之后)加:
```js
        assertPathInNs(a.path, keyRow.boundSA_namespace)
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test server/api-key-tools.test.mjs`
Expected: PASS(5 新用例 + 既有 delete 用例(path 与 ns 一致)仍绿)。

- [ ] **Step 5: commit**

```bash
git add server/api-key-tools.mjs server/api-key-tools.test.mjs
git commit -m "feat(mcp): assertPathInNs + delete_resource 收紧 path-ns(policy 层闭环)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `get_resource_yaml`(path-based GET,返 YAML)

**Files:**
- Modify: `server/api-key-tools.mjs`(+import js-yaml、+tool)、`server/tool-registry.mjs`(+条目)
- Test: `server/api-key-tools.test.mjs`

**Interfaces:**
- Produces: tool `get_resource_yaml({namespace, path})` → `{kind, name, apiVersion, yaml, truncated, originalBytes, byteCap}`;read 档。
- Consumes: `assertPathInNs`(Task 1)、`runBoundedTool`、`requestFn`、`LOG_BYTE_MAX`。

- [ ] **Step 1: 写失败测试** — 追加到 `server/api-key-tools.test.mjs`:

```js
// --- get_resource_yaml(path-based,任意 kind/CRD)---
test('get_resource_yaml: path GET → YAML + managedFields 去噪;read 档可调', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (!init.method && /\/ingresses\/foo$/.test(path)) return { body: { kind: 'Ingress', apiVersion: 'networking.k8s.io/v1', metadata: { name: 'foo', managedFields: [{ x: 1 }] }, spec: { rules: [] } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'get_resource_yaml', { namespace: 'ns', path: '/apis/networking.k8s.io/v1/namespaces/ns/ingresses/foo' })
  assert.equal(out.kind, 'Ingress'); assert.equal(out.name, 'foo'); assert.equal(out.apiVersion, 'networking.k8s.io/v1')
  assert.match(out.yaml, /kind: Ingress/); assert.doesNotMatch(out.yaml, /managedFields/)
  assert.equal(out.truncated, false)
})
test('get_resource_yaml: 大对象截 32KB + truncated + originalBytes', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const big = { kind: 'ConfigMap', apiVersion: 'v1', metadata: { name: 'big' }, data: { blob: 'x'.repeat(60000) } }
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (!init.method && /\/configmaps\/big$/.test(path)) return { body: big }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'get_resource_yaml', { namespace: 'ns', path: '/api/v1/namespaces/ns/configmaps/big' })
  assert.equal(out.truncated, true)
  assert.ok(out.originalBytes > 32768, 'originalBytes 记原始大小')
  assert.ok(Buffer.byteLength(out.yaml, 'utf8') <= 32768 + 4, '截断后 yaml 不超上限')
})
test('get_resource_yaml: path ns 不符 / 集群级 → policy 拒', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'get_resource_yaml', { namespace: 'ns', path: '/api/v1/namespaces/other/pods/p1' }), (e) => e.reason === 'policy')
  await assert.rejects(tools.callTool(k, cluster, 'get_resource_yaml', { namespace: 'ns', path: '/api/v1/persistentvolumes/pv1' }), (e) => e.reason === 'policy')
})
test('get_resource_yaml: 缺 path → 报错', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'get_resource_yaml', { namespace: 'ns' }), /缺 path/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/api-key-tools.test.mjs`
Expected: FAIL — `未知工具: get_resource_yaml`。

- [ ] **Step 3: 实现** — `server/api-key-tools.mjs`:

顶部 import 加(在现有 import 块):
```js
import { dump as yamlDump } from 'js-yaml'
```

`tools` 对象内(`get_resource` 之后)加:
```js
    get_resource_yaml: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'get_resource_yaml', source, namespace: a.namespace, verb: 'get', resource: a.path || '?', summary: `get ${(a.path || '').slice(0, 80)}`,
      fn: async (saCtx) => {
        if (!a.path) throw new Error('get_resource_yaml 缺 path(K8s 资源路径,如 /apis/networking.k8s.io/v1/namespaces/default/ingresses/foo)')
        assertPathInNs(a.path, keyRow.boundSA_namespace)
        const { body } = await requestFn(saCtx, a.path)
        if (body?.metadata?.managedFields) delete body.metadata.managedFields // 去噪
        const full = yamlDump(body)
        const originalBytes = Buffer.byteLength(full, 'utf8')
        const truncated = originalBytes > LOG_BYTE_MAX
        const yaml = truncated ? Buffer.from(full, 'utf8').subarray(0, LOG_BYTE_MAX).toString('utf8') : full
        return { kind: body?.kind, name: body?.metadata?.name, apiVersion: body?.apiVersion, yaml, truncated, originalBytes, byteCap: LOG_BYTE_MAX }
      } }),
```

`server/tool-registry.mjs` 的 `K8S` 数组(`get_resource` 条目之后)加:
```js
  { name: 'get_resource_yaml', minTier: 'read', requiresApproval: false,
    description: '按 K8s 资源路径取完整对象并以 YAML 返回(去 managedFields,32KB 截断)。支持任意 kind/CRD(ingress/secret/networkpolicy/…),弥补 get_resource 仅 6 kind 的局限。path 须在绑定 namespace 内(集群级资源如 PV/Node 不支持)。path 从 list_resources(path 模式)结果取,或自构(如 /apis/networking.k8s.io/v1/namespaces/default/ingresses/foo)。',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, path: { type: 'string', description: 'K8s 资源路径(绑定 ns 内,从 list 取或自构)' } }, required: ['namespace', 'path'] } },
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test server/api-key-tools.test.mjs`
Expected: PASS(4 新用例 + 全回归)。

- [ ] **Step 5: commit**

```bash
git add server/api-key-tools.mjs server/api-key-tools.test.mjs server/tool-registry.mjs
git commit -m "feat(mcp): get_resource_yaml(path-based 任意 kind/CRD,返 YAML 32KB 截断)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `list_resources` 加 path(任意 kind)

**Files:**
- Modify: `server/api-key-tools.mjs`(list_resources 加 path 分支)、`server/tool-registry.mjs`(描述)
- Test: `server/api-key-tools.test.mjs`

**Interfaces:**
- Produces: `list_resources({namespace, kind?, path?})`——`path` 优先(GET list 端点,slim 项含 `path`);`kind` 快捷(6 kind)不变。
- Consumes: `assertPathInNs`(Task 1)、`LIST_MAX`、`requestFn`。

- [ ] **Step 1: 写失败测试** — 追加到 `server/api-key-tools.test.mjs`:

```js
// --- list_resources(path 模式:任意 kind)---
test('list_resources(path): 列任意 kind,slim 项含 path 便于 get_resource_yaml', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (/\/namespaces\/[^/]+\/ingresses$/.test(path)) return { body: { items: [
      { kind: 'Ingress', apiVersion: 'networking.k8s.io/v1', metadata: { name: 'foo' } },
      { kind: 'Ingress', apiVersion: 'networking.k8s.io/v1', metadata: { name: 'bar' } },
    ] } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'list_resources', { namespace: 'ns', path: '/apis/networking.k8s.io/v1/namespaces/ns/ingresses' })
  assert.equal(out.kind, '(path)'); assert.equal(out.count, 2); assert.equal(out.returned, 2)
  assert.equal(out.items[0].name, 'foo'); assert.equal(out.items[0].kind, 'Ingress')
  assert.match(out.items[0].path, /\/namespaces\/ns\/ingresses\/foo$/)
})
test('list_resources(path): path ns 不符 → policy 拒', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'list_resources', { namespace: 'ns', path: '/apis/networking.k8s.io/v1/namespaces/other/ingresses' }), (e) => e.reason === 'policy')
})
test('list_resources(kind): 既有 6-kind 快捷回归(pods)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'ns' })
  assert.equal(out.kind, 'pods'); assert.ok(out.count >= 1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/api-key-tools.test.mjs`
Expected: FAIL — path 模式走 kind 分支 → `不支持的 kind: undefined`(或 pods 默认),不返 ingress。

- [ ] **Step 3: 实现** — `server/api-key-tools.mjs` 的 `list_resources` 改为 path 优先:

```js
    list_resources: async (keyRow, cluster, a, source) => {
      if (a.path) {
        return runBoundedTool({ keyRow, cluster, tool: 'list_resources', source, namespace: a.namespace, verb: 'list', resource: a.path, summary: `path=${a.path.slice(0, 80)}`,
          fn: async (saCtx) => {
            assertPathInNs(a.path, keyRow.boundSA_namespace)
            const { body } = await requestFn(saCtx, a.path)
            const all = body?.items || []
            const items = all.slice(0, LIST_MAX).map(it => ({ name: it.metadata?.name, kind: it.kind, apiVersion: it.apiVersion, path: `${a.path}/${it.metadata?.name}` }))
            return { kind: '(path)', count: all.length, returned: items.length, items }
          } })
      }
      const kind = String(a.kind || 'pods').toLowerCase()
      const templ = LIST_PATH[kind]
      if (!templ) throw new PermissionDeniedError('policy', { tool: 'list_resources', detail: `不支持的 kind: ${kind}(骨架:pods/services/configmaps/deployments/statefulsets/daemonsets);或用 path 列任意 kind` })
      return runBoundedTool({ keyRow, cluster, tool: 'list_resources', source, namespace: a.namespace, verb: 'list', resource: kind, summary: `kind=${kind}`,
        fn: async (saCtx) => {
          const { body } = await requestFn(saCtx, templ.replace('%ns%', enc(a.namespace)))
          const all = body?.items || []
          const items = all.slice(0, LIST_MAX).map(it => kind === 'pods' ? slimPod(it) : WORKLOADS.includes(kind) ? slimWorkload(it) : { name: it.metadata?.name })
          return { kind, count: all.length, returned: items.length, items }
        } })
    },
```

`server/tool-registry.mjs` 的 `list_resources` 描述更新(在末尾加 path 说明):
```js
  { name: 'list_resources', minTier: 'read', requiresApproval: false,
    description: '列出 namespace 内资源(slim 名单)。两种用法:(a) kind ∈ pods/services/configmaps/deployments/statefulsets/daemonsets(快捷,slim 含 phase/ready 等);(b) path 给 list 端点列任意 kind/CRD(如 /apis/networking.k8s.io/v1/namespaces/default/ingresses),slim 项含 path 便于 get_resource_yaml。path 须在绑定 ns 内。capped 200。',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, kind: { type: 'string' }, path: { type: 'string', description: 'list 端点(任意 kind,path 模式,优先于 kind)' } }, required: ['namespace'] } },
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test server/api-key-tools.test.mjs`
Expected: PASS(3 新用例 + 全回归;既有 kind 用例不传 path → 走 kind 分支不变)。

- [ ] **Step 5: commit**

```bash
git add server/api-key-tools.mjs server/api-key-tools.test.mjs server/tool-registry.mjs
git commit -m "feat(mcp): list_resources 加 path(任意 kind/CRD,slim 项含 path)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 全量验证

**Files:** 无代码改动(验证)。

- [ ] **Step 1: 全量验证**

Run: `npm test && npm run typecheck && npm run build`
Expected:
- `npm test`:所有 server `*.test.mjs` + vitest PASS(含新 assertPathInNs/get_resource_yaml/list(path)/delete 用例)。
- `typecheck`:`node --check` 全过(含 `js-yaml` import)。
- `build`:Vite 构建成功(本轮无前端改动,纯回归)。

- [ ] **Step 2: commit(若有 lint/格式调整则一并;否则跳过)**

---

## Self-Review(写完后自查,已修正)

**1. Spec 覆盖:**
- get_resource_yaml(path GET→YAML,32KB 截断,ns 收紧)→ Task 2 ✓
- list_resources 加 path(slim 项含 path,kind 快捷不变)→ Task 3 ✓
- assertPathInNs helper + delete 收紧 → Task 1 ✓
- 不改 authorize(get_resource_yaml 已在 BOUNDED)→ 各 task 均未触 authorize ✓
- 不做 can_i/patch/跨 ns → 非 target,无 task ✓

**2. 类型/签名一致性:**
- `assertPathInNs(path, ns)` Task 1 定义(命名导出),Task 2/3 消费 ✓
- `get_resource_yaml`/`list_resources` 经 `runBoundedTool({...,source})`(source 是上轮已加的形参,TDD 既有)✓
- `LOG_BYTE_MAX`=32768 复用(Task 2);`LIST_MAX`=200 复用(Task 3)✓

**3. 无占位:** 各步含可执行代码/命令;mock 用 wrapper 拦 path(与既有 rollout 用例同构);registry 条目完整。

**4. 已知简化(非占位):**
- `get_resource_yaml` 返 `{yaml}` + metadata(不返原 object,省 token;AI 需结构化可自行 parse)。
- list path slim 项 path = `${listPath}/${name}`(raw,未 encode;展示用,AI 取时按需 encode)。
- assertPathInNs throw 在 fn 内(after reserveAudit)→ 审计记 error 而非 denied(语义小瑕疵,可接受;双层 ns 校验目的达成)。
