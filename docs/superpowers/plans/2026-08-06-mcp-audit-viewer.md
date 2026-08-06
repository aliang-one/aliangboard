# MCP/API-key 审计查看器 + 调用来源标识 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `audit_log` 加调用来源标识(`source`: mcp/agent/direct),并建一个 admin 审计查看页(「最近活跃 key」面板 + 分页调用记录表 + 链完整性校验)。

**Architecture:** `source` 作为普通列加入 `audit_log`(**不进 `CORE_FIELDS` 哈希链**,保存量链 valid);三条调用路(callTool)显式传 source;两个纯读 helper(`activeKeys`/`queryAuditLog`,可单测)+ 三个薄 admin 端点;前端 `AuditTrail.vue` 用 `adminApi`+`ref`(对齐 admin 兄弟页),i18n 全覆盖。

**Tech Stack:** Node.js(`node:test` + `node:sqlite` + `node --check`),Vue 3 + vue-i18n(`useI18n`/`$t`),Vite。零新依赖。

## Global Constraints

- **零新外部依赖**:测试 `node --test`;类型 `node --check`;前端 `npm run build`;不引新库。
- **i18n 是门禁**:所有用户可见文案经 `$t`/`t`(`useI18n`),key 必须同时在 `src/locales/zh.json` 与 `en.json`;`npm run i18n:check` 必过(扫残存中文 + zh/en 键对齐)。
- **`source` 不进哈希链**:`audit_log.CORE_FIELDS` **不加** `source`;`writeAudit` 把 `source` 写入列但不参与 `canonical`/`rowHash`。保存量行(`source=NULL`)链不断。
- **source 取值**:`'mcp'`(`/mcp`)、`'agent'`(`/api/agent/chat` 经 tool-registry)、`'direct'`(`/api/key/<cluster>/call`)。`callTool` 默认 `'direct'`。
- **commit 风格**:`feat(audit): …` / `feat(ui): …`,末尾 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- **测试命令**:服务端 `npm run test:server`(或单文件 `node --test server/<f>.test.mjs`);前端 `npm run build` + `npm run i18n:check`。

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `server/audit.mjs` | 审计 writer + 读 helper + verify | +`source` 列(迁移)+ writeAudit 写 source;+`activeKeys`/`queryAuditLog`;CORE_FIELDS 不变 |
| `server/audit.test.mjs` | 审计测试 | +source 落库/链不断/迁移幂等;+activeKeys/queryAuditLog 用例 |
| `server/api-key-tools.mjs` | callTool + runBoundedTool + tools | callTool 加 source 形参;runBoundedTool intent 带 source;15 个 tool fn 透传 source |
| `server/api-key-tools.test.mjs` | tools 测试 | +callTool(...,source)→audit.source 用例 |
| `server/mcp.mjs` | MCP tools/call | callTool 传 `'mcp'` |
| `server/mcp.test.mjs` | MCP 测试 | +tools/call 传 source='mcp' 断言 |
| `server/tool-registry.mjs` | K8S exec 分派 | exec callTool 传 `'agent'` |
| `server/index.mjs` | 路由 | direct 路由传 `'direct'`;+3 个 admin 审计 GET 端点 |
| `src/api/client.js` | 前端 HTTP | +`adminApi.auditTrail.{active,list,verify}` |
| `src/views/admin/AuditTrail.vue`(新) | 审计查看页 | 新建(active 面板 + 表 + 详情 + verify) |
| `src/router/index.js` | 路由 | +admin/audit-trail 路由 |
| `src/components/layout/SideNavBar.vue` | 侧栏 | +审计 nav 项 |
| `src/locales/zh.json` / `en.json` | 文案 | +nav.auditTrail + auditTrail.* |

---

### Task 1: `source` 列 + writeAudit(audit 存储)

**Files:**
- Modify: `server/audit.mjs`(`createAuditSchema` + `writeAudit`)
- Test: `server/audit.test.mjs`

**Interfaces:**
- Produces: `audit_log.source TEXT` 列(可空);`writeAudit(db, entry)` 把 `entry.source` 落库;`CORE_FIELDS` 不变(`source` 不入哈希)。`verifyChain(db)` 不变(返回 `{valid,count}` 或 `{valid:false,brokenAt,reason}`)。
- Consumes: 无(第一个任务)。

- [ ] **Step 1: 写失败测试** — 追加到 `server/audit.test.mjs`(顶部 import 已有 `createAuditSchema, writeAudit, verifyChain`;沿用该文件既有 `makeDb` 辅助,若无可写 `const db = new DatabaseSync(':memory:'); createAuditSchema(db)`):

```js
test('writeAudit: source 落库(source 列)', () => {
  const db = /* 既有 makeDb() */
  writeAudit(db, { keyId: 'k1', owner: 'a', clusterId: 'c1', tool: 'get_pod_logs', result: 'ok', source: 'mcp' })
  assert.equal(db.prepare('SELECT source FROM audit_log WHERE seq=1').get().source, 'mcp')
})
test('writeAudit: 缺 source → NULL', () => {
  const db = /* 既有 makeDb() */
  writeAudit(db, { tool: 't', result: 'ok' })
  assert.equal(db.prepare('SELECT source FROM audit_log WHERE seq=1').get().source, null)
})
test('迁移幂等: 二次 createAuditSchema 不报错', () => {
  const db = /* 既有 makeDb() */
  assert.doesNotThrow(() => createAuditSchema(db))
})
test('verifyChain: source 与无 source 行混合仍 valid(source 不在 CORE_FIELDS)', () => {
  const db = /* 既有 makeDb() */
  writeAudit(db, { tool: 't1', result: 'ok', source: null })
  writeAudit(db, { tool: 't2', result: 'ok', source: 'mcp' })
  writeAudit(db, { tool: 't3', result: 'ok', source: 'agent' })
  const v = verifyChain(db)
  assert.equal(v.valid, true)
})
```
> 读 `server/audit.test.mjs` 确认其 `makeDb`/import 形态后沿用;若该文件用 `DatabaseSync` 内存库 + `createAuditSchema`,直接复用。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/audit.test.mjs`
Expected: FAIL — `source` 列不存在(SQLite "no such column")。

- [ ] **Step 3: 实现** — `server/audit.mjs`:

`createAuditSchema` 的 CREATE 加 `source TEXT`,并在索引后加幂等 ALTER:
```js
export function createAuditSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'finalized',
    keyId TEXT, owner TEXT, clusterId TEXT, namespace TEXT, verb TEXT, resource TEXT, tool TEXT, result TEXT, reason TEXT, requestSummary TEXT,
    source TEXT,
    prevHash TEXT NOT NULL, hash TEXT NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_owner ON audit_log(owner)`)
  // 旧库(表已存在但无 source 列)补列;新库 CREATE 已带 → ALTER 抛「列已存在」,吞掉。
  try { db.exec('ALTER TABLE audit_log ADD COLUMN source TEXT') } catch { /* 列已存在 */ }
}
```
**`CORE_FIELDS` 不改**(确认仍为不含 source 的原数组)。`writeAudit` 的 INSERT 加 `source` 列与值:
```js
export function writeAudit(db, entry) {
  const prevHash = lastHash(db)
  const row = { ts: Date.now(), status: 'finalized', ...entry }
  const hash = rowHash(prevHash, row)
  const r = db.prepare(`INSERT INTO audit_log (ts,status,keyId,owner,clusterId,namespace,verb,resource,tool,result,reason,requestSummary,source,prevHash,hash)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.ts, row.status, row.keyId ?? null, row.owner ?? null, row.clusterId ?? null, row.namespace ?? null,
    row.verb ?? null, row.resource ?? null, row.tool ?? null, row.result ?? null, row.reason ?? null, row.requestSummary ?? null,
    row.source ?? null, prevHash, hash)
  return { seq: Number(r.lastInsertRowid), prevHash, hash }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/audit.test.mjs`
Expected: PASS(含 4 新用例 + 既有用例;`rowHash`/`canonical` 因 CORE_FIELDS 未变,存量行链不断)。

- [ ] **Step 5: 回归 audit 相关 + commit**

Run: `node --test server/audit.test.mjs server/api-key-tools.test.mjs`(既有 reserveAudit/finalizeAudit 经 writeAudit,新列可选默认 null,应仍绿)。
```bash
git add server/audit.mjs server/audit.test.mjs
git commit -m "feat(audit): audit_log 加 source 列(不进哈希链,保存量链 valid)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: source 透传 callTool → runBoundedTool → audit

**Files:**
- Modify: `server/api-key-tools.mjs`(`callTool` + `runBoundedTool` + 15 个 tool 方法)
- Test: `server/api-key-tools.test.mjs`

**Interfaces:**
- Produces: `callTool(keyRow, cluster, tool, args, source='direct')`;每个 tool 方法 `(keyRow, cluster, a, source) => runBoundedTool({..., source, ...})`;`runBoundedTool` 把 `source` 放进 `intent`(→ reserveAudit/finalizeAudit → writeAudit 落 `source` 列)。
- Consumes: Task 1 的 `writeAudit` 写 `source` 列。

- [ ] **Step 1: 写失败测试** — 追加到 `server/api-key-tools.test.mjs`(沿用其 `makeDb`/`mockRequestFn`/`mintKey`):

```js
// --- source 透传到 audit ---
test('callTool source: 传入 mcp → audit 行 source=mcp', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'ns' }, 'mcp')
  const row = db.prepare('SELECT source FROM audit_log ORDER BY seq DESC LIMIT 1').get()
  assert.equal(row.source, 'mcp')
})
test('callTool source: 默认 direct', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'ns' })
  assert.equal(db.prepare('SELECT source FROM audit_log ORDER BY seq DESC LIMIT 1').get().source, 'direct')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/api-key-tools.test.mjs`
Expected: FAIL — `source` 未透传(audit 行 source 为 NULL ≠ 'mcp')。

- [ ] **Step 3: 实现** — `server/api-key-tools.mjs`:

(a) `runBoundedTool` 解构加 `source`,放进 `intent`:
```js
async function runBoundedTool({ keyRow, cluster, tool, namespace, verb, resource, summary, source, fn }) {
  const intent = { keyId: keyRow.id, owner: keyRow.owner, clusterId: keyRow.clusterId, namespace, verb, resource, tool, source, requestSummary: summary }
  // ...其余不变(authorize / reserveAudit / fn / finalizeAudit 都用 intent,source 自动随行)
```

(b) `callTool` 加 source 形参并传给 tool fn:
```js
async function callTool(keyRow, cluster, tool, args, source = 'direct') {
  const fn = tools[tool]
  if (!fn) throw new PermissionDeniedError('policy', { tool, detail: `未知工具: ${tool}` })
  return fn(keyRow, cluster, args || {}, source)
}
```

(c) **每个 tool 方法**加尾参 `source` 并在 `runBoundedTool({...})` 里加 `source,`。对全部 15 个工具做同一改动——`get_pod_logs / list_resources / get_resource / get_events / scale / restart / exec_pod / browse_files / read_file / apply_yaml / delete_resource / kubectl_debug / rollout_history / rollout_undo / update_image`。示例(read 档 + admin 档各一):

```js
    list_resources: async (keyRow, cluster, a, source) => {
      const kind = String(a.kind || 'pods').toLowerCase()
      const templ = LIST_PATH[kind]
      if (!templ) throw new PermissionDeniedError('policy', { tool: 'list_resources', detail: `不支持的 kind: ${kind}…` })
      return runBoundedTool({ keyRow, cluster, tool: 'list_resources', source, namespace: a.namespace, verb: 'list', resource: kind, summary: `kind=${kind}`,
        fn: async (saCtx) => { /* 原逻辑不变 */ } })
    },
```
```js
    rollout_undo: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'rollout_undo', source, namespace: a.namespace, verb: 'patch', resource: `Deployment/${a.name}/rollback`, summary: `deploy=${a.name} →rev=${a.toRevision}`,
      fn: async (saCtx) => { /* 原逻辑不变 */ } }),
```
> 注:`browse_files` / `read_file` / `apply_yaml` / `delete_resource` / `kubectl_undo`/`kubectl_debug` 等的 runBoundedTool 调用同样补 `source,`(箭头函数参数列加 `source`)。改动是机械一致的:每个工具「参数列 +`, source`」「runBoundedTool 对象 +`source,`」。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test server/api-key-tools.test.mjs`
Expected: PASS(2 新用例 + 全回归;既有用例不传 source → 默认 direct,audit 行 source=direct,不影响断言)。

- [ ] **Step 5: commit**

```bash
git add server/api-key-tools.mjs server/api-key-tools.test.mjs
git commit -m "feat(audit): callTool→runBoundedTool 透传 source(默认 direct)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 三条调用路写入各自 source

**Files:**
- Modify: `server/mcp.mjs`(tools/call)、`server/tool-registry.mjs`(K8S exec)、`server/index.mjs`(direct 路由)
- Test: `server/mcp.test.mjs`

**Interfaces:**
- Produces: MCP `tools/call` 传 `'mcp'`;agent(K8S exec)传 `'agent'`;direct `/api/key/<c>/call` 传 `'direct'`。
- Consumes: Task 2 的 `callTool(..., source)`。

- [ ] **Step 1: 写失败测试** — `server/mcp.test.mjs`:让 mockTools 的 callTool 捕获第 5 个参数并断言。读该文件确认 `mockTools` 形态(目前 `callTool: async (k,c,t,a) => ...`),改为捕获 source:
```js
test('tools/call: 经 MCP 路传 source=mcp 给 callTool', async () => {
  let captured = null
  const apiKeyTools = { ...mockTools(), callTool: async (k, c, t, a, source) => { captured = source; return { tool: t } } }
  await handleMcpMessage({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'list_resources', arguments: { namespace: 'ns' } } }, { keyRow: readKey, cluster, apiKeyTools })
  assert.equal(captured, 'mcp')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/mcp.test.mjs`
Expected: FAIL — `captured` 为 undefined(mcp.mjs 未传第 5 参)。

- [ ] **Step 3: 实现** — 三处:

`server/mcp.mjs` `handleMcpMessage` 的 tools/call:
```js
      const out = await apiKeyTools.callTool(keyRow, cluster, name, params?.arguments || {}, 'mcp')
```

`server/tool-registry.mjs` K8S 数组末尾的 `.map` exec:
```js
].map(t => ({ ...t, principal: 'k8s', exec: (ctx, args) => ctx.apiKeyTools.callTool(ctx.keyRow, ctx.cluster, t.name, args, 'agent') }))
```

`server/index.mjs` `/api/key/<cluster>/call` 路由内的 callTool:
```js
      const out = await apiKeyTools.callTool(keyRow, cluster, input.tool, input.args || {}, 'direct')
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test server/mcp.test.mjs server/api-key-tools.test.mjs server/workbench-agent.test.mjs`
Expected: PASS。`workbench-agent.test.mjs`(registry)用 `buildToolDefs`/`toolDefsFor`,不经 exec,不受影响。

- [ ] **Step 5: 语法 + commit**

Run: `node --check server/mcp.mjs && node --check server/tool-registry.mjs && node --check server/index.mjs`
```bash
git add server/mcp.mjs server/mcp.test.mjs server/tool-registry.mjs server/index.mjs
git commit -m "feat(audit): 三路调用写入 source(mcp/agent/direct)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 审计读 helper(activeKeys + queryAuditLog)

**Files:**
- Modify: `server/audit.mjs`(+两个导出)、`server/audit.test.mjs`
- Interfaces:
  - Produces: `activeKeys(db, { windowSec=900, source=null }) → [{keyId,label,owner,clusterId,count,lastTs,ok,denied,error}]`(近 windowSec 秒、可选 source 过滤、按 lastTs DESC,label LEFT JOIN `api_keys`);`queryAuditLog(db, { keyId,owner,clusterId,tool,result,source,since,until,page=1,size=50 }) → {items,total,page,size}`(size 钳 1..200,按 ts DESC)。

- [ ] **Step 1: 写失败测试** — `server/audit.test.mjs`(用内存库 + createApiKeysSchema 建 api_keys 以便 join label):
```js
import { DatabaseSync } from 'node:sqlite'
import { createAuditSchema, writeAudit, activeKeys, queryAuditLog } from './audit.mjs'
import { createApiKeysSchema } from './auth-keys.mjs'

function makeAudDb() { const db = new DatabaseSync(':memory:'); createAuditSchema(db); createApiKeysSchema(db); return db }

test('activeKeys: 近 window 按 key 聚合 + source 过滤 + label join', () => {
  const db = makeAudDb()
  db.prepare("INSERT INTO api_keys (id,keyHash,prefix,owner,clusterId,boundSA_namespace,boundSA_name,tier,createdAt,revokedAt) VALUES ('k1','h','p','alice','c1','ns','sa','read',0,NULL)").run()
  const now = Date.now()
  writeAudit(db, { keyId:'k1', owner:'alice', clusterId:'c1', tool:'list_resources', result:'ok', source:'mcp', ts: now-60_000 })
  writeAudit(db, { keyId:'k1', owner:'alice', clusterId:'c1', tool:'scale', result:'denied', source:'agent', ts: now-30_000 })
  writeAudit(db, { keyId:'k1', owner:'alice', clusterId:'c1', tool:'get', result:'error', source:'mcp', ts: now-10_000 })
  writeAudit(db, { keyId:'k1', owner:'alice', clusterId:'c1', tool:'old', result:'ok', source:'mcp', ts: now-10_000_000 }) // 超出 window
  const all = activeKeys(db, { windowSec: 900 })
  assert.equal(all.length, 1); assert.equal(all[0].keyId, 'k1'); assert.equal(all[0].label, null || 'p' ? all[0].label : null)
  assert.equal(all[0].count, 3); assert.equal(all[0].ok, 1); assert.equal(all[0].denied, 1); assert.equal(all[0].error, 1)
  const mcpOnly = activeKeys(db, { windowSec: 900, source: 'mcp' })
  assert.equal(mcpOnly[0].count, 2)
})
test('queryAuditLog: 过滤 + 分页 + ts DESC + size 钳制', () => {
  const db = makeAudDb()
  for (let i=0;i<5;i++) writeAudit(db, { keyId:'k1', tool:'t', result:'ok', source:'mcp', ts: 1000+i })
  const r = queryAuditLog(db, { source:'mcp', page:1, size:2 })
  assert.equal(r.total, 5); assert.equal(r.items.length, 2); assert.ok(r.items[0].ts >= r.items[1].ts, 'DESC')
  assert.equal(queryAuditLog(db, { size: 9999 }).size, 200, 'size 钳到 200')
  assert.equal(queryAuditLog(db, { result: 'denied' }).total, 0)
})
```
> `writeAudit` 的 entry 若带 `ts` 用之(改 writeAudit 接受 entry.ts 覆盖?现 writeAudit 用 `row={ts:Date.now(),...entry}` → entry.ts 会覆盖默认,OK,测试可控时间)。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/audit.test.mjs`
Expected: FAIL — `activeKeys`/`queryAuditLog` 未导出。

- [ ] **Step 3: 实现** — `server/audit.mjs` 末尾加:
```js
// 近 windowSec 秒、按 key 聚合(可选 source 过滤);label LEFT JOIN api_keys。给「最近活跃 key」面板。
export function activeKeys(db, { windowSec = 900, source = null } = {}) {
  const since = Date.now() - Math.min(Math.max(Number(windowSec) || 900, 1), 86400) * 1000
  const sql = `SELECT a.keyId, k.label, a.owner, a.clusterId, COUNT(*) AS count, MAX(a.ts) AS lastTs,
      SUM(CASE WHEN a.result='ok' THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN a.result='denied' THEN 1 ELSE 0 END) AS denied,
      SUM(CASE WHEN a.result='error' THEN 1 ELSE 0 END) AS error
    FROM audit_log a LEFT JOIN api_keys k ON k.id = a.keyId
    WHERE a.ts > ? AND a.keyId IS NOT NULL ${source ? 'AND a.source = ?' : ''}
    GROUP BY a.keyId ORDER BY lastTs DESC`
  const rows = source ? db.prepare(sql).all(since, source) : db.prepare(sql).all(since)
  return rows.map(r => ({ keyId: r.keyId, label: r.label, owner: r.owner, clusterId: r.clusterId,
    count: Number(r.count) || 0, lastTs: Number(r.lastTs), ok: Number(r.ok) || 0, denied: Number(r.denied) || 0, error: Number(r.error) || 0 }))
}

// 分页调用流水(多过滤器可选,size 钳 1..200,ts DESC)。
export function queryAuditLog(db, { keyId, owner, clusterId, tool, result, source, since, until, page = 1, size = 50 } = {}) {
  size = Math.min(Math.max(Number(size) || 50, 1), 200)
  page = Math.max(Number(page) || 1, 1)
  const where = []; const params = []
  if (keyId) { where.push('keyId = ?'); params.push(keyId) }
  if (owner) { where.push('owner = ?'); params.push(owner) }
  if (clusterId) { where.push('clusterId = ?'); params.push(clusterId) }
  if (tool) { where.push('tool = ?'); params.push(tool) }
  if (result) { where.push('result = ?'); params.push(result) }
  if (source) { where.push('source = ?'); params.push(source) }
  if (since != null) { where.push('ts >= ?'); params.push(Number(since)) }
  if (until != null) { where.push('ts <= ?'); params.push(Number(until)) }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM audit_log ${clause}`).get(...params).c) || 0
  const items = db.prepare(`SELECT * FROM audit_log ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size)
  return { items, total, page, size }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/audit.test.mjs`
Expected: PASS(2 新用例 + 既有)。注意修一下 Step1 测试里 `label` 断言为合理值(INSERT 未给 label → null):把那行改为 `assert.equal(all[0].label, null)`。

- [ ] **Step 5: commit**

```bash
git add server/audit.mjs server/audit.test.mjs
git commit -m "feat(audit): activeKeys + queryAuditLog 读 helper(可单测)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: admin 审计端点 + 前端 client 方法

**Files:**
- Modify: `server/index.mjs`(import + 3 个 GET 路由)、`src/api/client.js`(+`adminApi.auditTrail`)

**Interfaces:**
- Produces: `GET /api/admin/audit-log/active?window=&source=`、`GET /api/admin/audit-log?key=&owner=&cluster=&tool=&result=&source=&since=&until=&page=&size=`、`GET /api/admin/audit-log/verify`(均 `requireAdmin`);`adminApi.auditTrail.{active,list,verify}`。
- Consumes: Task 4 的 `activeKeys`/`queryAuditLog` + 既有 `verifyChain`。

- [ ] **Step 1: 加 import** — `server/index.mjs` 顶部 audit 的 import 行(现 `import { reserveAudit, finalizeAudit } from './audit.mjs'` 之类)扩为含新导出:
```js
import { reserveAudit, finalizeAudit, activeKeys, queryAuditLog, verifyChain } from './audit.mjs'
```
(读该行实际写法,合并而非重复 import。)

- [ ] **Step 2: 加 3 个 GET 路由** — 紧邻既有 admin 路由区(如 `/api/admin/apikeys` 段附近)插入:
```js
  if (req.method === 'GET' && url.pathname === '/api/admin/audit-log/active') {
    const ps = requireAdmin(req, res); if (!ps) return
    const windowSec = Math.min(Math.max(Number(url.searchParams.get('window')) || 900, 1), 86400)
    const source = url.searchParams.get('source') || null
    return sendJson(res, 200, { active: activeKeys(db, { windowSec, source }) })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/audit-log') {
    const ps = requireAdmin(req, res); if (!ps) return
    const q = url.searchParams
    const out = queryAuditLog(db, {
      keyId: q.get('key') || undefined, owner: q.get('owner') || undefined, clusterId: q.get('cluster') || undefined,
      tool: q.get('tool') || undefined, result: q.get('result') || undefined, source: q.get('source') || undefined,
      since: q.get('since') || undefined, until: q.get('until') || undefined,
      page: q.get('page') || undefined, size: q.get('size') || undefined,
    })
    return sendJson(res, 200, out)
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/audit-log/verify') {
    const ps = requireAdmin(req, res); if (!ps) return
    return sendJson(res, 200, verifyChain(db))
  }
```

- [ ] **Step 3: 加 client 方法** — `src/api/client.js` 的 `adminApi` 对象(与 `apikeys` 同级)加:
```js
  auditTrail: {
    active: (params = {}) => platformHttp.request(`/api/admin/audit-log/active?${new URLSearchParams(params)}`),
    list: (params = {}) => platformHttp.request(`/api/admin/audit-log?${new URLSearchParams(params)}`),
    verify: () => platformHttp.request('/api/admin/audit-log/verify'),
  },
```

- [ ] **Step 4: 语法 + 回归**

Run: `node --check server/index.mjs && node --test server/audit.test.mjs && node --test server/mcp.test.mjs`
Expected: 语法过;测试全绿(端点薄,逻辑在 Task 4 helper 已测)。

- [ ] **Step 5: commit**

```bash
git add server/index.mjs src/api/client.js
git commit -m "feat(audit): admin 审计端点(active/log/verify)+ client 方法

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: AuditTrail.vue 审计页 + 路由/导航/i18n

**Files:**
- Create: `src/views/admin/AuditTrail.vue`
- Modify: `src/router/index.js`、`src/components/layout/SideNavBar.vue`、`src/locales/zh.json`、`src/locales/en.json`

**Interfaces:**
- Consumes: `adminApi.auditTrail.{active,list,verify}`(Task 5);`DataTable`/`Modal`/`useI18n`/`notify`(既有)。
- Produces: 审计页(`/admin/audit-trail`),active 面板 + 调用记录表 + 行详情 + 完整性徽章;i18n 全覆盖。

- [ ] **Step 1: i18n 键** — `src/locales/zh.json` 与 `en.json` 同步加(两文件键必须对齐,否则 `i18n:check` 失败):
```jsonc
// zh.json → "nav" 段加:
"auditTrail": "审计",
// zh.json 新增顶层段(或并入既有结构):
"auditTrail": {
  "title": "MCP / API-key 调用审计",
  "subtitle": "所有 API-key 鉴权的工具调用(含被拒);链式哈希防篡改",
  "activeTitle": "最近活跃 key",
  "window": "时间窗",
  "win15": "15 分钟", "win30": "30 分钟", "win6h": "6 小时",
  "sourceAll": "全部来源", "sourceMcp": "MCP", "sourceAgent": "Agent", "sourceDirect": "直接调用",
  "empty": "近 {window} 无活跃 key",
  "calls": "调用", "last": "最近",
  "logTitle": "调用记录",
  "filters": "过滤",
  "colTs": "时间", "colOwner": "归属", "colSource": "来源", "colCluster": "集群",
  "colNamespace": "命名空间", "colTool": "工具", "colResource": "对象", "colResult": "结果", "colReason": "原因",
  "resultOk": "成功", "resultDenied": "拒绝", "resultError": "错误",
  "detail": "详情", "summary": "摘要", "chain": "链哈希", "seq": "序号",
  "verifyBtn": "校验链完整性", "verifyOk": "链完整 ✓", "verifyBad": "链断裂 ✗(seq {seq})",
  "refresh": "刷新", "prev": "上一页", "next": "下一页", "noData": "无记录"
}
```
> `en.json` 加同结构键、英文值(如 `"auditTrail": "Audit"`、`"title": "MCP / API-key Call Audit"` …)。两文件键集必须一致。

- [ ] **Step 2: 路由** — `src/router/index.js` admin 段(`AdminLlmConfig` 之后、`]` 之前)加:
```js
      {
        path: 'admin/audit-trail',
        name: 'AdminAuditTrail',
        component: () => import('@/views/admin/AuditTrail.vue'),
        meta: { titleKey: 'nav.auditTrail', icon: 'shield', scope: 'global', requireAdmin: true }
      },
```

- [ ] **Step 3: 侧栏** — `src/components/layout/SideNavBar.vue` 平台管理段(`llmConfig` 项之后)加:
```js
  { icon: 'shield', labelKey: 'nav.auditTrail', route: '/admin/audit-trail' },
```

- [ ] **Step 4: 创建 AuditTrail.vue** — 参照 `src/views/admin/ApiKeyManagement.vue` 的结构(`useI18n`/`adminApi`/`ref`/`onMounted`/`DataTable`/`Modal`)。`<script setup>` 核心:
```js
import { ref, onMounted, computed } from 'vue'
import { adminApi } from '@/api/client'
import { useI18n } from 'vue-i18n'
import { notify } from '@/composables/useToast'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'

const { t } = useI18n()
const loading = ref(false)
const active = ref([])
const log = ref({ items: [], total: 0, page: 1, size: 50 })
const verify = ref(null)
const detail = ref(null)

const winSec = ref(900)
const actSource = ref('')           // '' = all
const f = ref({ owner: '', tool: '', result: '', source: '', key: '', cluster: '' })
const page = ref(1)
const WIN_OPTS = [{ v: 900, k: 'win15' }, { v: 1800, k: 'win30' }, { v: 21600, k: 'win6h' }]
const SRC_OPTS = [{ v: '', k: 'sourceAll' }, { v: 'mcp', k: 'sourceMcp' }, { v: 'agent', k: 'sourceAgent' }, { v: 'direct', k: 'sourceDirect' }]
const RESULT_OPTS = [{ v: '', k: 'sourceAll' }, { v: 'ok', k: 'resultOk' }, { v: 'denied', k: 'resultDenied' }, { v: 'error', k: 'resultError' }]

const headers = [
  { key: 'ts', label: t('auditTrail.colTs') },
  { key: 'owner', label: t('auditTrail.colOwner') },
  { key: 'source', label: t('auditTrail.colSource') },
  { key: 'clusterId', label: t('auditTrail.colCluster') },
  { key: 'namespace', label: t('auditTrail.colNamespace') },
  { key: 'tool', label: t('auditTrail.colTool') },
  { key: 'resource', label: t('auditTrail.colResource') },
  { key: 'result', label: t('auditTrail.colResult') },
]
const fmt = ts => ts ? new Date(Number(ts)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-'
const rel = ts => { const s = Math.round((Date.now() - Number(ts)) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m` : `${Math.floor(s/3600)}h` }
const SRC_BADGE = { mcp: 'bg-primary/10 text-primary', agent: 'bg-status-warning/10 text-status-warning', direct: 'bg-surface-container-high text-on-surface-variant' }
const RESULT_STYLE = { ok: 'bg-status-running/10 text-status-running', denied: 'bg-status-warning/10 text-status-warning', error: 'bg-error/10 text-error' }

async function loadActive() { try { const r = await adminApi.auditTrail.active({ window: winSec.value, ...(actSource.value ? { source: actSource.value } : {}) }); active.value = r.active || [] } catch (e) { notify('error', e.message) } }
async function loadLog() {
  loading.value = true
  try {
    const params = { page: page.value, size: log.value.size }
    for (const k of ['owner', 'tool', 'result', 'source', 'key', 'cluster']) { const v = f.value[k]; if (v) params[k === 'key' ? 'key' : k] = v }
    const r = await adminApi.auditTrail.list(params); log.value = { ...r, size: log.value.size }
  } catch (e) { notify('error', e.message) } finally { loading.value = false }
}
async function doVerify() { try { verify.value = await adminApi.auditTrail.verify() } catch (e) { notify('error', e.message) } }
function refresh() { loadActive(); loadLog() }
function openDetail(row) { detail.value = row }
const totalPages = computed(() => Math.max(1, Math.ceil(log.value.total / log.value.size)))

onMounted(() => { refresh() })
```
模板(active 面板 + 表 + 详情 Modal + verify 徽章),所有文案 `t(...)`:
```html
<template>
  <section class="animate-fade-in p-md">
    <div class="flex items-center justify-between mb-md">
      <div><h2 class="text-headline-lg font-bold text-on-surface">{{ t('auditTrail.title') }}</h2>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('auditTrail.subtitle') }}</p></div>
      <div class="flex items-center gap-sm">
        <button @click="doVerify" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">{{ t('auditTrail.verifyBtn') }}</button>
        <span v-if="verify" class="text-body-xs" :class="verify.valid ? 'text-status-running' : 'text-error'">
          {{ verify.valid ? t('auditTrail.verifyOk') : t('auditTrail.verifyBad', { seq: verify.brokenAt }) }}
        </span>
        <button @click="refresh" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm">{{ t('auditTrail.refresh') }}</button>
      </div>
    </div>

    <!-- 最近活跃 key 面板 -->
    <div class="mb-md">
      <div class="flex items-center gap-md mb-sm">
        <span class="text-label-caps text-on-surface-variant">{{ t('auditTrail.activeTitle') }}</span>
        <select v-model.number="winSec" @change="loadActive" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm">
          <option v-for="o in WIN_OPTS" :key="o.v" :value="o.v">{{ t('auditTrail.' + o.k) }}</option>
        </select>
        <select v-model="actSource" @change="loadActive" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm">
          <option v-for="o in SRC_OPTS" :key="o.v" :value="o.v">{{ t('auditTrail.' + o.k) }}</option>
        </select>
      </div>
      <div v-if="!active.length" class="text-body-sm text-on-surface-variant py-md">{{ t('auditTrail.empty', { window: winSec >= 3600 ? Math.round(winSec/3600)+'h' : Math.round(winSec/60)+'m' }) }}</div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-sm">
        <div v-for="a in active" :key="a.keyId" class="bg-surface-container-low border border-outline-variant rounded-lg p-md">
          <div class="flex items-center justify-between">
            <span class="font-mono text-body-sm font-semibold">{{ a.label || a.owner }}</span>
            <span class="text-body-xs text-on-surface-variant">{{ t('auditTrail.last') }} {{ rel(a.lastTs) }}</span>
          </div>
          <div class="text-body-xs text-on-surface-variant mt-xs">{{ a.owner }} · {{ a.clusterId }}</div>
          <div class="flex items-center gap-md mt-sm">
            <span class="text-body-sm font-semibold">{{ a.count }}</span>
            <div class="flex-1 h-1.5 rounded-full bg-surface-container-high overflow-hidden flex">
              <div class="bg-status-running h-full" :style="{ width: pct(a.ok, a.count) + '%' }"></div>
              <div class="bg-status-warning h-full" :style="{ width: pct(a.denied, a.count) + '%' }"></div>
              <div class="bg-error h-full" :style="{ width: pct(a.error, a.count) + '%' }"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 调用记录表 -->
    <div class="flex flex-wrap items-center gap-xs mb-sm">
      <input v-model="f.owner" :placeholder="t('auditTrail.colOwner')" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm w-32" />
      <input v-model="f.key" placeholder="keyId" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm w-32 font-mono" />
      <input v-model="f.cluster" :placeholder="t('auditTrail.colCluster')" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm w-28" />
      <input v-model="f.tool" :placeholder="t('auditTrail.colTool')" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm w-36 font-mono" />
      <select v-model="f.result" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm">
        <option v-for="o in RESULT_OPTS" :key="o.v" :value="o.v">{{ t('auditTrail.' + o.k) }}</option>
      </select>
      <select v-model="f.source" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm">
        <option v-for="o in SRC_OPTS" :key="o.v" :value="o.v">{{ t('auditTrail.' + o.k) }}</option>
      </select>
      <button @click="page = 1; loadLog()" class="px-md py-1 bg-primary text-on-primary rounded-lg text-body-sm">go</button>
    </div>

    <DataTable :headers="headers" :rows="log.items">
      <template #ts="{ row }"><span class="text-body-xs text-on-surface-variant font-mono">{{ fmt(row.ts) }}</span></template>
      <template #source="{ row }"><span v-if="row.source" class="px-1.5 py-0.5 rounded text-body-xs font-mono" :class="SRC_BADGE[row.source]">{{ row.source }}</span><span v-else class="text-body-xs text-on-surface-variant/50">—</span></template>
      <template #result="{ row }"><span class="px-1.5 py-0.5 rounded text-body-xs font-semibold" :class="RESULT_STYLE[row.result]">{{ t('auditTrail.result' + (row.result ? row.result[0].toUpperCase()+row.result.slice(1) : '')) }}</span></template>
      <template #resource="{ row }"><button @click="openDetail(row)" class="font-mono text-body-xs text-primary hover:underline text-left">{{ row.resource || '—' }}</button></template>
    </DataTable>

    <div class="flex items-center justify-between mt-sm">
      <span class="text-body-xs text-on-surface-variant">{{ log.total }} · {{ page }}/{{ totalPages }}</span>
      <div class="flex gap-xs">
        <button :disabled="page<=1" @click="page--; loadLog()" class="px-sm py-1 border border-outline-variant rounded-lg text-body-sm disabled:opacity-40">{{ t('auditTrail.prev') }}</button>
        <button :disabled="page>=totalPages" @click="page++; loadLog()" class="px-sm py-1 border border-outline-variant rounded-lg text-body-sm disabled:opacity-40">{{ t('auditTrail.next') }}</button>
      </div>
    </div>

    <Modal :modelValue="!!detail" @update:modelValue="v => { if (!v) detail = null }" :title="t('auditTrail.detail')" width="max-w-lg">
      <div v-if="detail" class="flex flex-col gap-xs text-body-sm font-mono">
        <div><span class="text-on-surface-variant">{{ t('auditTrail.seq') }}:</span> {{ detail.seq }}</div>
        <div><span class="text-on-surface-variant">{{ t('auditTrail.colTool') }}:</span> {{ detail.tool }}</div>
        <div><span class="text-on-surface-variant">{{ t('auditTrail.summary') }}:</span> {{ detail.requestSummary || '—' }}</div>
        <div><span class="text-on-surface-variant">{{ t('auditTrail.colReason') }}:</span> {{ detail.reason || '—' }}</div>
        <div class="break-all"><span class="text-on-surface-variant">{{ t('auditTrail.chain') }}:</span> {{ detail.prevHash?.slice(0,16) }} → {{ detail.hash?.slice(0,16) }}</div>
      </div>
    </Modal>
  </section>
</template>
```
加一个 `pct` 辅助:`const pct = (n, total) => total ? Math.round((n/total)*100) : 0`。

- [ ] **Step 5: 校验 — i18n + typecheck + build**

Run: `npm run i18n:check && npm run typecheck && npm run build`
Expected: i18n:check 过(无残存中文 + zh/en 键对齐);typecheck(node --check)过;build 编译 `AuditTrail.vue` 成功。

- [ ] **Step 6: commit**

```bash
git add src/views/admin/AuditTrail.vue src/router/index.js src/components/layout/SideNavBar.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(ui): AuditTrail 审计页(active 面板 + 调用记录表 + 链校验,i18n 全覆盖)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 全量验证 + 记忆更新

**Files:** 无代码改动(验证 + 记忆)。

- [ ] **Step 1: 全量验证**

Run: `npm test && npm run i18n:check && npm run typecheck && npm run build`
Expected:
- `npm test`:server(node:test,含 audit/api-key-tools/mcp)+ vitest 全绿。
- `i18n:check`:无残存中文,zh/en 键对齐。
- `typecheck`:node --check 全过。
- `build`:Vite 构建成功。

- [ ] **Step 2: 更新项目记忆** — 更新 `~/.claude/projects/-home-liang-MyProgram-AiProject-aliangboard/memory/mcp-audit-viewer-need.md`:把「待建」改为「已建(分支 feat/mcp-audit-viewer,<HEAD7>)」+ 记 source 标识(mcp/agent/direct,不入哈希链)。

- [ ] **Step 3: commit(若有 README/文档变更则一并;否则跳过)**

---

## Self-Review(写完后自查,已修正)

**1. Spec 覆盖:**
- source 列 + 不入哈希链 → Task 1 ✓
- callTool/runBoundedTool/15 tool 透传 → Task 2 ✓
- 三路 mcp/agent/direct → Task 3 ✓
- active/log/verify 端点 + helper → Task 4+5 ✓
- AuditTrail.vue(active 面板 + 表 + 详情 + verify)+ router + nav + i18n → Task 6 ✓
- 全量验证(i18n 门禁)→ Task 7 ✓

**2. 类型/签名一致性:**
- `callTool(keyRow, cluster, tool, args, source='direct')` 贯穿 Task 2/3 ✓
- `activeKeys(db,{windowSec,source})` / `queryAuditLog(db,{...})` Task 4 定义、Task 5 端点消费 ✓
- `verifyChain` 返回 `{valid,count}` / `{valid:false,brokenAt,reason}` —— UI 用 `verify.brokenAt`(Task 6 与之一致)✓

**3. 无占位:** 各步含可执行代码/命令;UI 模板完整(含 `pct` 辅助);i18n 键两文件对齐要求明确。

**4. 已知简化(非占位):**
- 三路中 direct 路由其实由 callTool 默认 `'direct'` 覆盖,Task 3 仍显式传以清晰。
- agent(tool-registry)与 direct 路由的 source 不单独单测(字面量;mcp 路 + api-key-tools callTool 已覆盖「source 到 audit」的端到端)。
- 活跃面板 window 选项 900/1800/21600s(15m/30m/6h);`active` 端点 window 钳到 [1,86400]。
