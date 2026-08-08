# 跨 namespace allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 per-key 单 namespace 放宽为 ns allowlist(`boundSA_namespace ∪ allowed_namespaces`),结构与 `tool_overrides` 同构;SA/RoleBinding 带外配置。

**Architecture:** `effectiveNamespaces(keyRow)`(lenient)+ `normalizeAllowedNamespaces(raw, boundNs)`(strict,ns 名 dns-label 校验),镜像 `effectiveTools`/`normalizeToolOverrides`。`runBoundedTool` ns 校验改用 allowlist;mint/PATCH/UI 承载。平台不建 RBAC 对象(带外 RoleBinding)。

**Tech Stack:** Node.js(`node:test` + `node:sqlite` + `node --check`),Vue 3 + vue-i18n。零新依赖。

## Global Constraints

- **零新外部依赖**;测试 `node --test`;类型 `node --check`;前端 `npm run build`;i18n `npm run i18n:check`(门禁,新文案经 `$t`,zh/en 对齐)。
- **结构镜像 `tool_overrides`**:`allowed_namespaces TEXT`(可空,幂等迁移)+ strict `normalizeAllowedNamespaces` + lenient `effectiveNamespaces` + mint/PATCH + UI。
- **boundSA 永远在 allowlist**:`effectiveNamespaces = unique([boundSA_namespace] ∪ parse(allowed_namespaces))`;`allowed_namespaces` 只存**额外** ns(不含 boundSA);损坏/缺 → 回退 `[boundSA_namespace]`(= 今天行为,向后兼容)。
- **ns 名校验**:RFC1123 dns-label(`/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/`,≤63)。
- **带外 RBAC**:平台不自动建 SA/RoleBinding;管理员在各 ns 建 RoleBinding(subject 跨 ns 引用 boundSA)。ns 拒 detail 指向配置 + RoleBinding 提示。
- **commit 风格**:`feat(auth): …` / `feat(ui): …` + `Co-Authored-By: Claude <noreply@anthropic.com>`。
- **测试命令**:`node --test server/<f>.test.mjs`;回归 `npm test`。

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `server/authorize.mjs` | 策略层 | +`effectiveNamespaces`/`normalizeAllowedNamespaces`(镜像 tool 版) |
| `server/authorize.test.mjs` | 策略测试 | +effectiveNamespaces/normalizeAllowedNamespaces 用例 |
| `server/auth-keys.mjs` | api_keys 表 + mint/list | +`allowed_namespaces` 列(幂等迁移)+ mintKey 校验/存 + listKeys 返回 |
| `server/auth-keys.test.mjs` | mint/list 测试 | +allowed_namespaces 落库/迁移用例 |
| `server/api-key-tools.mjs` | runBoundedTool | ns 校验改用 `effectiveNamespaces`(替换单 ns 检查) |
| `server/api-key-tools.test.mjs` | tools 测试 | +ns allowlist 放行/拒 用例 |
| `server/index.mjs` | 路由 | mint 透传 allowed_namespaces + PATCH /apikeys/:id/namespaces |
| `src/api/client.js` | 前端 HTTP | +`apikeys.updateNamespaces` |
| `src/components/common/NsAllowlistEditor.vue`(新) | ns 编辑器 | 新建(boundSA 永在 + 额外 ns 自由文本 chip) |
| `src/views/admin/ApiKeyManagement.vue` | API key UI | mint/编辑接 NsAllowlistEditor + 列表摘要 |
| `src/locales/zh.json`/`en.json` | 文案 | +nsAllowlist.* 键 |

---

### Task 1: `effectiveNamespaces` + `normalizeAllowedNamespaces`(authorize)

**Files:**
- Modify: `server/authorize.mjs`(加两个导出)
- Test: `server/authorize.test.mjs`

**Interfaces:**
- Produces: `effectiveNamespaces(keyRow) → Set<string>`(运行时,lenient,损坏→`[boundSA_namespace]`);`normalizeAllowedNamespaces(raw, boundNs) → string|null`(mint/PATCH 用,strict,返 JSON 串或 null)。
- Consumes: 无(第一个任务)。

- [ ] **Step 1: 写失败测试** — 追加到 `server/authorize.test.mjs`(顶部 import 加 `effectiveNamespaces, normalizeAllowedNamespaces`):

```js
import {
  BOUNDED_TOOLS, DANGEROUS_TOOLS, tierTools,
  effectiveTools, normalizeToolOverrides,
  effectiveNamespaces, normalizeAllowedNamespaces,
  authorize, PermissionDeniedError, canIDecision, withPolicy,
} from './authorize.mjs'

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/authorize.test.mjs`
Expected: FAIL — `effectiveNamespaces`/`normalizeAllowedNamespaces` 未导出。

- [ ] **Step 3: 实现** — `server/authorize.mjs` 的 `normalizeToolOverrides` 之后加(与 ns 授权同区):

```js
// 运行时有效 namespace 集:lenient。损坏/缺 → 回退 [boundSA_namespace](fail-open,不锁死)。
// boundSA_namespace 永远在;allowed_namespaces 只存额外 ns。
export function effectiveNamespaces(keyRow) {
  const set = new Set([keyRow?.boundSA_namespace])
  const raw = keyRow?.allowed_namespaces
  if (!raw) return set
  let arr
  try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return set }
  if (Array.isArray(arr)) for (const ns of arr) if (typeof ns === 'string' && ns) set.add(ns)
  return set
}

// mint/PATCH 用:strict。ns 名 dns-label 校验;boundNS 运行时自动并入 → 不重复存。坏→抛。返 JSON 串或 null。
const NS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/  // K8s RFC1123 label
export function normalizeAllowedNamespaces(raw, boundNs) {
  if (raw == null) return null
  const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : null)  // 坏串让 JSON.parse 抛
  if (!arr) throw new Error('allowed_namespaces 必须是字符串数组')
  const out = []
  for (const ns of arr) {
    if (typeof ns !== 'string') throw new Error('allowed_namespaces 必须是字符串数组')
    if (!NS_NAME.test(ns) || ns.length > 63) throw new Error(`非法 namespace 名(需 dns-label,≤63): ${ns}`)
    if (ns !== boundNs && !out.includes(ns)) out.push(ns)  // boundNS 运行时自动并入,不重复存;dedup
  }
  return out.length ? JSON.stringify(out) : null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/authorize.test.mjs`
Expected: PASS(8 新用例 + 既有)。

- [ ] **Step 5: commit**

```bash
git add server/authorize.mjs server/authorize.test.mjs
git commit -m "feat(auth): effectiveNamespaces + normalizeAllowedNamespaces(ns allowlist,镜像 tool 版)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `allowed_namespaces` 列 + mint/list 承载(auth-keys)

**Files:**
- Modify: `server/auth-keys.mjs`(schema + mintKey + listKeys)
- Test: `server/auth-keys.test.mjs`

**Interfaces:**
- Produces: `api_keys.allowed_namespaces TEXT` 列;`mintKey(db, {…, allowed_namespaces})` 校验(`normalizeAllowedNamespaces(raw, boundSA_namespace)`)+ 存;`listKeys` 返回该列。
- Consumes: `normalizeAllowedNamespaces` from Task 1。

- [ ] **Step 1: 写失败测试** — 追加到 `server/auth-keys.test.mjs`(沿用其 makeDb/mintKey/listKeys):

```js
test('mintKey: allowed_namespaces 合法 → 存 JSON 串;listKeys 回带', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'anydoor', boundSA_name: 'sa', allowed_namespaces: ['dev', 'staging'] })
  assert.equal(k.allowed_namespaces, JSON.stringify(['dev', 'staging']))
  assert.equal(listKeys(db)[0].allowed_namespaces, JSON.stringify(['dev', 'staging']))
})
test('mintKey: 无 allowed_namespaces → 列为 null(向后兼容)', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  assert.equal(k.allowed_namespaces, null); assert.equal(listKeys(db)[0].allowed_namespaces, null)
})
test('mintKey: 非法 ns 名 → 抛,不建 key', () => {
  const db = makeDb()
  assert.throws(() => mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', allowed_namespaces: ['BAD_ns'] }), /非法 namespace/)
  assert.equal(listKeys(db).length, 0, '失败不建 key')
})
test('schema 幂等: 二次 createApiKeysSchema 不报错', () => {
  const db = makeDb()
  assert.doesNotThrow(() => createApiKeysSchema(db))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/auth-keys.test.mjs`
Expected: FAIL — `allowed_namespaces` 列不存在。

- [ ] **Step 3: 实现** — `server/auth-keys.mjs`:

import 行扩(Task 1 的 normalizeAllowedNamespaces):
```js
import { normalizeToolOverrides, normalizeAllowedNamespaces } from './authorize.mjs'
```
`createApiKeysSchema` 加列(在 `tool_overrides TEXT` 之后)+ 幂等 ALTER:
```js
    tool_overrides TEXT,
    allowed_namespaces TEXT,
    label TEXT,
```
```js
  try { db.exec('ALTER TABLE api_keys ADD COLUMN allowed_namespaces TEXT') } catch { /* 列已存在 */ }
```
`mintKey` 解构 + 校验 + INSERT + 返回:
```js
  const { owner, clusterId, boundSA_namespace, boundSA_name, tier = 'read', label = null, createdBy = null, tool_overrides = null, allowed_namespaces = null } = input || {}
  // ... 既有 ...
  const overridesJson = normalizeToolOverrides(tool_overrides)  // strict: 坏→抛
  const allowedNsJson = normalizeAllowedNamespaces(allowed_namespaces, boundSA_namespace)
  // INSERT 加 allowed_namespaces 列与值:
  db.prepare(`INSERT INTO api_keys (id, keyHash, prefix, owner, clusterId, boundSA_namespace, boundSA_name, tier, tool_overrides, allowed_namespaces, label, createdBy, createdAt, revokedAt)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(
    id, hashKey(plaintext), plaintext.slice(0, 8), owner, clusterId, boundSA_namespace, boundSA_name, tier, overridesJson, allowedNsJson, label, createdBy, createdAt)
  return { id, plaintext, prefix: plaintext.slice(0, 8), owner, clusterId, boundSA_namespace, boundSA_name, tier, tool_overrides: overridesJson, allowed_namespaces: allowedNsJson, label, createdBy, createdAt }
```
`listKeys` SELECT 加列:
```js
  const sql = `SELECT id, prefix, owner, clusterId, boundSA_namespace, boundSA_name, tier, tool_overrides, allowed_namespaces, label, createdBy, createdAt, revokedAt
               FROM api_keys ${owner ? 'WHERE owner = ?' : ''} ORDER BY createdAt DESC`
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test server/auth-keys.test.mjs server/authorize.test.mjs`
Expected: PASS(4 新 + 既有;lookupKey 已 SELECT * 自动含新列)。

- [ ] **Step 5: commit**

```bash
git add server/auth-keys.mjs server/auth-keys.test.mjs
git commit -m "feat(auth): api_keys 加 allowed_namespaces 列 + mint/list 承载(幂等迁移)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `runBoundedTool` ns 校验改用 allowlist

**Files:**
- Modify: `server/api-key-tools.mjs`(runBoundedTool ns 检查)
- Test: `server/api-key-tools.test.mjs`

**Interfaces:**
- Produces: `runBoundedTool` ns 校验 = `effectiveNamespaces(keyRow).has(namespace)`(替换单 ns 检查)。
- Consumes: `effectiveNamespaces` from Task 1。

- [ ] **Step 1: 写失败测试** — 追加到 `server/api-key-tools.test.mjs`(沿用 makeDb/mockRequestFn/mintKey):

```js
// --- ns allowlist(effectiveNamespaces)---
test('ns allowlist: 额外 ns 在 allowlist → 放行(read key,跨 ns)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'anydoor', boundSA_name: 'sa', tier: 'read', allowed_namespaces: ['dev'] })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'dev' })  // dev 在 [anydoor,dev]
  assert.equal(out.kind, 'pods')  // 走通(ns 校验过 + fn 跑)
})
test('ns allowlist: ns 不在 allowlist → policy 拒(detail 命名请求 ns + 允许集)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'anydoor', boundSA_name: 'sa', tier: 'read', allowed_namespaces: ['dev'] })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'other' }), (e) =>
    e.reason === 'policy' && /'other'/.test(e.detail) && /anydoor/.test(e.detail) && /dev/.test(e.detail))
})
test('ns allowlist: 无 allowed_namespaces → 单 ns(向后兼容,他 ns 拒)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'anydoor', boundSA_name: 'sa', tier: 'read' })  // 无 allowed
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'other' }), (e) => e.reason === 'policy')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/api-key-tools.test.mjs`
Expected: FAIL — 额外 ns 'dev' 被单 ns 检查拒(allowlist 还没接)。

- [ ] **Step 3: 实现** — `server/api-key-tools.mjs`:

顶部 import 加(Task 1 的 effectiveNamespaces):
```js
import { authorize, PermissionDeniedError, effectiveTools, effectiveNamespaces } from './authorize.mjs'
```
(读该 import 行实际写法,合并而非重复 import。)

`runBoundedTool` 的 ns 检查(line ~82)替换——把:
```js
    if (namespace !== keyRow.boundSA_namespace) { finalizeAudit(db, intent, { result: 'denied', reason: 'policy' }); throw new PermissionDeniedError('policy', { tool, detail: `namespace '${namespace}' 超出该 API key 绑定作用域 '${keyRow.boundSA_namespace}'(绑定 ns 在 平台管理 → API Keys 配置)` }) }
```
换成:
```js
    const allowedNs = effectiveNamespaces(keyRow)
    if (!allowedNs.has(namespace)) { finalizeAudit(db, intent, { result: 'denied', reason: 'policy' }); throw new PermissionDeniedError('policy', { tool, detail: `namespace '${namespace}' 不在该 key 允许的 namespace 集([${[...allowedNs].join(', ')}]);绑定 ns + 额外 ns 在 平台管理 → API Keys 配置,SA 的各 ns RoleBinding 自建` }) }
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test server/api-key-tools.test.mjs`
Expected: PASS(3 新用例 + 全回归;既有单 ns 用例(boundSA==ns)仍绿——effectiveNamespaces 含 boundSA)。

- [ ] **Step 5: commit**

```bash
git add server/api-key-tools.mjs server/api-key-tools.test.mjs
git commit -m "feat(auth): runBoundedTool ns 校验改用 effectiveNamespaces allowlist

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 端点(mint 透传 + PATCH /namespaces)+ client

**Files:**
- Modify: `server/index.mjs`、`src/api/client.js`

**Interfaces:**
- Produces: `POST /api/admin/apikeys` 透传 `allowed_namespaces`;`PATCH /api/admin/apikeys/:id/namespaces`(body `{allowed_namespaces}` → `normalizeAllowedNamespaces(input, key.boundSA_namespace)` + UPDATE,不重签);`adminApi.apikeys.updateNamespaces`。
- Consumes: `normalizeAllowedNamespaces` from Task 1。

- [ ] **Step 1: index.mjs mint 透传** — mint 路由(约 index.mjs:1660 的 `tool_overrides: input.tool_overrides ?? null` 旁)加:
```js
        allowed_namespaces: input.allowed_namespaces ?? null,
```

- [ ] **Step 2: 新增 PATCH /namespaces 路由** — 紧邻 PATCH /overrides 路由之后插入(需先查 key 取 boundSA_namespace 给校验):
```js
  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/admin\/apikeys\/[^/]+\/namespaces$/)) {
    const ps = requireAdmin(req, res); if (!ps) return
    try {
      const id = decodeURIComponent(url.pathname.split('/')[4])
      const input = await readBody(req)
      const key = db.prepare('SELECT boundSA_namespace FROM api_keys WHERE id = ? AND revokedAt IS NULL').get(id)
      if (!key) return sendJson(res, 404, { message: 'API key 不存在或已吊销' })
      const json = normalizeAllowedNamespaces(input.allowed_namespaces, key.boundSA_namespace)  // strict: 坏→抛
      db.prepare('UPDATE api_keys SET allowed_namespaces = ? WHERE id = ?').run(json, id)
      return sendJson(res, 200, { ok: true, id, allowed_namespaces: json })
    } catch (e) { return sendJson(res, e.status || 400, { message: e.message || '更新 ns allowlist 失败' }) }
  }
```
(顶部 import 加 `normalizeAllowedNamespaces` 到既有 authorize import 行。)

- [ ] **Step 3: client 方法** — `src/api/client.js` 的 `apikeys` 对象(`updateOverrides` 之后)加:
```js
    updateNamespaces: (id, allowed_namespaces) => platformHttp.request(`/api/admin/apikeys/${encodeURIComponent(id)}/namespaces`, { method: 'PATCH', body: JSON.stringify({ allowed_namespaces }) }),
```

- [ ] **Step 4: 语法 + 回归**

Run: `node --check server/index.mjs && node --test server/auth-keys.test.mjs server/api-key-tools.test.mjs`
Expected: 语法过;测试全绿(端点薄,逻辑在 Task 1/2 已测)。

- [ ] **Step 5: commit**

```bash
git add server/index.mjs src/api/client.js
git commit -m "feat(auth): mint 透传 allowed_namespaces + PATCH /apikeys/:id/namespaces(不重签)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: UI — NsAllowlistEditor + ApiKeyManagement 接线 + i18n

**Files:**
- Create: `src/components/common/NsAllowlistEditor.vue`
- Modify: `src/views/admin/ApiKeyManagement.vue`、`src/locales/zh.json`、`src/locales/en.json`

**Interfaces:**
- Consumes: `adminApi.apikeys.updateNamespaces`(Task 4)。
- Produces: `NsAllowlistEditor`(props `boundNs`+`modelValue`=额外 ns 数组,emits `update:modelValue`);mint/编辑复用。

- [ ] **Step 1: i18n 键** — `src/locales/zh.json` + `en.json` 同步加(nav 段无需;新顶层段 `nsAllowlist`):
```jsonc
// zh.json
"nsAllowlist": {
  "title": "namespace 允许集", "boundAlways": "绑定(始终允许)", "addPlaceholder": "+ 额外 namespace(回车追加)",
  "invalid": "namespace 名非法(dns-label,≤63)", "dup": "已添加", "summary": "允许 ns"
}
// en.json 同结构英文值
```

- [ ] **Step 2: 创建 NsAllowlistEditor.vue** — `src/components/common/NsAllowlistEditor.vue`(boundSA 永远 chip + 额外 ns 自由文本 chip):
```vue
<script setup>
// ns allowlist 编辑器:boundSA_namespace 永远在(不可删)+ 额外 ns 自由文本 chip。v-model 一个「额外 ns」数组。
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
const props = defineProps({ boundNs: { type: String, default: '' }, modelValue: { type: Array, default: () => [] } })
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()
const input = ref('')
const NS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const extra = computed(() => props.modelValue || [])
function commit(next) { emit('update:modelValue', next) }
function add() {
  const v = input.value.trim()
  if (!v) return
  if (!NS_NAME.test(v) || v.length > 63 || v === props.boundNs) { input.value = ''; return }
  if (extra.value.includes(v)) { input.value = ''; return }
  commit([...extra.value, v]); input.value = ''
}
function remove(ns) { commit(extra.value.filter(x => x !== ns)) }
</script>
<template>
  <div class="bg-surface-container-low border border-outline-variant rounded-lg p-sm flex flex-col gap-xs">
    <div class="flex flex-wrap gap-1 items-center">
      <span class="px-1.5 py-0.5 rounded text-body-xs font-mono bg-primary/15 text-primary">{{ boundNs }}</span>
      <span class="text-body-xs text-on-surface-variant">{{ t('nsAllowlist.boundAlways') }}</span>
      <span v-for="ns in extra" :key="ns" class="px-1.5 py-0.5 rounded text-body-xs font-mono bg-status-running/15 text-status-running flex items-center gap-0.5">
        {{ ns }}<button type="button" @click="remove(ns)" class="hover:text-error">×</button>
      </span>
      <input v-model="input" @keydown.enter.prevent="add" :placeholder="t('nsAllowlist.addPlaceholder')"
        class="bg-transparent border-b border-outline-variant text-body-xs font-mono px-1 py-0.5 outline-none focus:border-primary min-w-[12rem]" />
    </div>
  </div>
</template>
```

- [ ] **Step 3: ApiKeyManagement.vue 接线** — 参照既有 ToolOverrideEditor 接线(import + mint/edit state + doMint payload + 编辑 modal)。script 加:
```js
import NsAllowlistEditor from '@/components/common/NsAllowlistEditor.vue'
const mintExtraNs = ref([])        // mint 用
const editExtraNs = ref([])        // edit 用
const nsSummary = k => {
  const extra = k.allowed_namespaces ? (() => { try { return JSON.parse(k.allowed_namespaces) } catch { return [] } })() : []
  return extra.length ? `+ ${extra.join(', ')}` : ''
}
function openNsEditor(k) {  // 复用既有 showOverrideModal 模式,或并入同一编辑 modal
  editingKey.value = k
  editExtraNs.value = k.allowed_namespaces ? (() => { try { return JSON.parse(k.allowed_namespaces) } catch { return [] } })() : []
  showNsModal.value = true
}
async function saveNamespaces() {
  try { await adminApi.apikeys.updateNamespaces(editingKey.value.id, editExtraNs.value); notify('success', 'ns allowlist 已更新'); showNsModal.value = false; load() }
  catch (e) { notify('error', e.message || '更新失败') }
}
```
doMint payload 加:`allowed_namespaces: mintExtraNs.value.length ? mintExtraNs.value : null`;mint modal 内 `<NsAllowlistEditor :bound-ns="mintForm.boundSA_namespace" v-model="mintExtraNs" />`(tier select 之后)。

> 读 `ApiKeyManagement.vue` 实际结构,把 NsAllowlistEditor 接进既有 mint Modal + 加一个 ns 编辑 Modal(或并入既有覆盖编辑 Modal)。列表加「允许 ns」列摘要(`nsSummary`)。所有文案 `$t`。

- [ ] **Step 4: 校验 — i18n + typecheck + build**

Run: `npm run i18n:check && npm run typecheck && npm run build`
Expected: i18n:check 过(0 残存/对齐);typecheck 过;build 编译 `NsAllowlistEditor.vue` + `ApiKeyManagement.vue` 成功。

- [ ] **Step 5: commit**

```bash
git add src/components/common/NsAllowlistEditor.vue src/views/admin/ApiKeyManagement.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(ui): API key 管理加 ns allowlist 编辑(NsAllowlistEditor,mint+编辑复用)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 全量验证

**Files:** 无代码改动(验证)。

- [ ] **Step 1: 全量验证**

Run: `npm test && npm run i18n:check && npm run typecheck && npm run build`
Expected:
- `npm test`:server(node:test 含 authorize/auth-keys/api-key-tools)+ vitest 全绿。
- `i18n:check`:0 残存,zh/en 对齐。
- `typecheck`:`node --check` 全过。
- `build`:Vite 构建成功。

- [ ] **Step 2: commit(若有调整则一并;否则跳过)**

---

## Self-Review(写完后自查,已修正)

**1. Spec 覆盖:**
- effectiveNamespaces/normalizeAllowedNamespaces → Task 1 ✓
- allowed_namespaces 列 + mint/list → Task 2 ✓
- runBoundedTool ns 校验 → Task 3 ✓
- mint 透传 + PATCH /namespaces + client → Task 4 ✓
- UI(NsAllowlistEditor + 接线 + i18n)→ Task 5 ✓
- 全量验证(i18n 门禁)→ Task 6 ✓
- 带外 RBAC provisioning(不建对象)→ 非目标,无 task;ns 拒 detail 指向 RoleBinding(Task 3)✓

**2. 类型/签名一致性:**
- `effectiveNamespaces(keyRow) → Set` Task 1 定义、Task 3 消费 `.has` ✓
- `normalizeAllowedNamespaces(raw, boundNs) → string|null` Task 1 定义、Task 2(mintKey)+ Task 4(PATCH)消费 ✓
- `allowed_namespaces` 列贯穿 mint/list/lookupKey/PATCH/UI ✓

**3. 无占位:** 各步含可执行代码/命令;UI 组件完整;mock 沿用既有;PATCH 需查 key 取 boundSA_namespace(显式)。

**4. 已知简化(非占位):**
- UI ns 编辑器自由文本(不拉集群 ns 列表)——MVP,管理员知 ns 名。
- ns 名校验 dns-label + ≤63(K8s RFC1123 label);不校验 ns 是否真存在(apiserver/RoleBinding 兜底)。
- `effectiveNamespaces` 损坏回退 `[boundSA]`(fail-open 到单 ns,同 `effectiveTools` 哲学)。
