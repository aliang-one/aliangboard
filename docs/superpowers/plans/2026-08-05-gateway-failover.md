# 网关多 master 故障转移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网关自动发现控制面端点 + 请求故障转移（主端点挂→自动切其它 master）+ 候选端点跳过证书校验。

**Architecture:** 抽纯函数 `isFailoverEligible`/`currentEndpoint`（单测）；session 创建后 `discoverEndpoints` 发现控制面 IP → `session.endpoints[]` + `endpointIdx` + `insecureDispatcher`；`requestKubernetes` 重构为端点迭代（失败→下一个）；流式/exec 用当前端点；SQLite 持久化候选列表。

**Tech Stack:** Node.js（undici fetch/Agent）、better-sqlite3、原生 HTTP server。

## Global Constraints

- **候选端点跳过证书校验**：`rejectUnauthorized: false`（用户已确认）；复用原始 ca/cert/key。
- **故障转移触发**：网络错误（ECONNREFUSED/ECONNRESET/ETIMEDOUT 等）+ 5xx + 超时；**4xx 不触发**（立即抛）。
- **发现时机**：连接时一次性（probe 成功后）；不做周期 re-discovery。
- **流式/exec 不做透明转移**：用当前端点；客户端重连走 requestKubernetes → 故障转移生效。
- **不改前端**（cluster-health 的 Disconnected 天然反映 all-endpoints-fail）。
- 禁新增外部依赖。

---

## File Structure

**新增**
- `server/failover.js` — `isFailoverEligible(error)` + `currentEndpoint(session)` + `currentDispatcher(session)` 纯函数。

**修改**
- `server/index.mjs` — import failover helpers；`discoverEndpoints()`；session 扩展（endpoints/endpointIdx/insecureDispatcher）；`requestKubernetes` 重构（extract `requestOnce` + 端点迭代）；流式/exec 用 `currentEndpoint`/`currentDispatcher`；SQLite schema + persist + restore。
- `scripts/test.mjs` — 追加 `isFailoverEligible` 契约测试。

---

### Task 1: 纯函数 `isFailoverEligible` / `currentEndpoint` / `currentDispatcher` + 单测（TDD）

**Files:**
- Create: `server/failover.js`
- Test: `scripts/test.mjs`

**Interfaces:**
- Produces:
  - `isFailoverEligible(error) => boolean`：网络错误/5xx/超时 → true；4xx/null → false。
  - `currentEndpoint(session) => URL`：`session.endpoints[session.endpointIdx]`（fallback `session.apiServer`）。
  - `currentDispatcher(session) => UndiciAgent`：endpointIdx===0 → `session.dispatcher`；否则 `session.insecureDispatcher || session.dispatcher`。
- 从 `../server/failover.js` import。

- [ ] **Step 1: 写失败测试**

在 `scripts/test.mjs` 的"汇总"段（`const failed = ...` 之前）追加：

```js
// --- 网关故障转移：错误分类（网络错误/5xx→转移；4xx/null→不转移）---
import { isFailoverEligible } from '../server/failover.js'
test('isFailoverEligible：网络错误/5xx/超时→true；4xx/null→false', () => {
  assert.equal(isFailoverEligible({ code: 'ECONNREFUSED' }), true)
  assert.equal(isFailoverEligible({ code: 'ECONNRESET' }), true)
  assert.equal(isFailoverEligible({ code: 'ETIMEDOUT' }), true)
  assert.equal(isFailoverEligible({ code: 'ENOTFOUND' }), true)
  assert.equal(isFailoverEligible({ code: 'UND_ERR_SOCKET' }), true)
  assert.equal(isFailoverEligible({ name: 'AbortError' }), true)
  assert.equal(isFailoverEligible({ message: 'Request timed out' }), true)
  assert.equal(isFailoverEligible({ status: 503 }), true)
  assert.equal(isFailoverEligible({ status: 500 }), true)
  assert.equal(isFailoverEligible({ status: 404 }), false)
  assert.equal(isFailoverEligible({ status: 401 }), false)
  assert.equal(isFailoverEligible({ status: 409 }), false)
  assert.equal(isFailoverEligible(null), false)
  assert.equal(isFailoverEligible(undefined), false)
  assert.equal(isFailoverEligible({ message: 'some 4xx error', status: 403 }), false)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/test.mjs`
Expected: FAIL，报 `Cannot find module '../server/failover.js'`。

- [ ] **Step 3: 实现纯函数**

创建 `server/failover.js`：

```js
// 网关故障转移辅助纯函数：错误分类 + 当前端点/dispatcher 选取。无副作用，便于单测。

// 是否应触发故障转移（网络错误 / 5xx / 超时；4xx 不触发——重试无意义）
export function isFailoverEligible(error) {
  if (!error) return false
  const code = error.code || ''
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true
  if (error.name === 'AbortError' || /timeout|aborted/i.test(error.message || '')) return true
  if (typeof error.status === 'number' && error.status >= 500) return true
  return false
}

// 当前活跃端点（故障转移后更新）
export function currentEndpoint(session) {
  if (session.endpoints && session.endpoints.length) return session.endpoints[session.endpointIdx || 0]
  return session.apiServer
}

// 当前端点对应的 dispatcher（原始端点→session.dispatcher；候选→insecureDispatcher）
export function currentDispatcher(session) {
  if (!session.endpointIdx || session.endpointIdx === 0) return session.dispatcher
  return session.insecureDispatcher || session.dispatcher
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/failover.js scripts/test.mjs
git commit -m "feat(failover): 抽 isFailoverEligible/currentEndpoint/currentDispatcher 纯函数 + 契约测试"
```

---

### Task 2: 自动发现 + session 扩展 + 持久化

**Files:**
- Modify: `server/index.mjs`（顶部 import；`discoverEndpoints` 新增；POST /api/session ~678；SQLite schema ~27-36；persistSession ~149-161；loadPersistedSessions ~164-175）

**Interfaces:**
- Consumes: `currentEndpoint`/`currentDispatcher`（Task 1）。
- Produces: `session.endpoints: URL[]`、`session.endpointIdx: number`、`session.insecureDispatcher: UndiciAgent`；`discoverEndpoints(session)` 函数。

- [ ] **Step 1: 引入 failover helpers**

在 `server/index.mjs` 顶部 import 段（其它 import 之后）加：

```js
import { currentEndpoint, currentDispatcher } from './failover.js'
```

- [ ] **Step 2: 新增 discoverEndpoints 函数**

在 `buildDispatcher` 之后（约 275 行后）插入：

```js
// 自动发现控制面端点：GET /api/v1/nodes → 过滤 control-plane → InternalIP → 候选 https://<ip>:<port>。
// 端口从原始 apiServer 继承；发现失败 → 只返回 [apiServer]（降级不阻断）。
async function discoverEndpoints(session) {
  try {
    const result = await requestKubernetes(session, '/api/v1/nodes?limit=500')
    const nodes = result.body?.items || []
    const port = session.apiServer.port || (session.apiServer.protocol === 'https:' ? '443' : '80')
    const seen = new Set([session.apiServer.origin])
    const candidates = []
    for (const node of nodes) {
      const labels = node.metadata?.labels || {}
      const isCP = labels['node-role.kubernetes.io/control-plane'] !== undefined || labels['node-role.kubernetes.io/master'] !== undefined
      if (!isCP) continue
      const ip = node.status?.addresses?.find(a => a.type === 'InternalIP')?.address
      if (!ip) continue
      const url = new URL(`${session.apiServer.protocol}//${ip}:${port}`)
      if (!seen.has(url.origin)) { seen.add(url.origin); candidates.push(url) }
    }
    const all = [session.apiServer, ...candidates]
    console.log(`[failover] 发现 ${all.length} 个端点: ${all.map(u => u.host).join(', ')}`)
    return all
  } catch (e) {
    console.warn('[failover] 控制面节点发现失败，使用单端点:', e?.message || e)
    return [session.apiServer]
  }
}
```

- [ ] **Step 3: POST /api/session 加发现 + session 扩展**

把 POST /api/session 中的 session 创建块（约 676-682）：

```js
      const dispatcher = buildDispatcher({ ca, cert, key, insecure })
      const sessionId = randomUUID()
      const session = { apiServer, authHeader, dispatcher, ca, cert, key, insecure, createdAt: Date.now() }
      const probe = await requestKubernetes(session, '/version')
      session.version = probe.body?.gitVersion || 'unknown'
      sessions.set(sessionId, session)
```

替换为（probe 后加发现 + insecureDispatcher + endpoints/endpointIdx）：

```js
      const dispatcher = buildDispatcher({ ca, cert, key, insecure })
      const sessionId = randomUUID()
      const session = { apiServer, authHeader, dispatcher, ca, cert, key, insecure, createdAt: Date.now() }
      const probe = await requestKubernetes(session, '/version')
      session.version = probe.body?.gitVersion || 'unknown'
      session.endpoints = await discoverEndpoints(session)
      session.endpointIdx = 0
      session.insecureDispatcher = buildDispatcher({ ca, cert, key, insecure: true })
      sessions.set(sessionId, session)
```

- [ ] **Step 4: SQLite schema 加列**

在 `db.exec(CREATE TABLE sessions...)` 之后（约 35 行后）加 ALTER（兼容已有表）：

```js
try { db.exec('ALTER TABLE sessions ADD COLUMN endpoints TEXT') } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN endpointIdx INTEGER DEFAULT 0') } catch { /* 列已存在 */ }
```

更新 `stmtUpsert`（约 36 行），加 endpoints + endpointIdx：

```js
const stmtUpsert = db.prepare('INSERT OR REPLACE INTO sessions (token, apiServer, authHeader, ca, cert, key, insecure, version, createdAt, endpoints, endpointIdx) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
```

- [ ] **Step 5: persistSession 加 endpoints/endpointIdx**

把 `persistSession`（约 149-161）的 `stmtUpsert.run(...)`：

```js
    stmtUpsert.run(
      token,
      session.apiServer.toString(),
      session.authHeader || null,
      session.ca || null, session.cert || null, session.key || null,
      session.insecure ? 1 : 0,
      session.version || null,
      session.createdAt || Date.now(),
    )
```

替换为（加 endpoints JSON + endpointIdx）：

```js
    stmtUpsert.run(
      token,
      session.apiServer.toString(),
      session.authHeader || null,
      session.ca || null, session.cert || null, session.key || null,
      session.insecure ? 1 : 0,
      session.version || null,
      session.createdAt || Date.now(),
      JSON.stringify((session.endpoints || [session.apiServer]).map(u => u.toString())),
      session.endpointIdx || 0,
    )
```

- [ ] **Step 6: loadPersistedSessions 还原 endpoints/insecureDispatcher**

在 `loadPersistedSessions`（约 167-175）的 session 重建块中，在 `apiServer: normalizeServer(r.apiServer),` 之后加：

```js
        endpoints: r.endpoints ? JSON.parse(r.endpoints).map(s => new URL(s)) : [normalizeServer(r.apiServer)],
        endpointIdx: r.endpointIdx || 0,
        insecureDispatcher: buildDispatcher({ ca: r.ca, cert: r.cert, key: r.key, insecure: true }),
```

（`loadPersistedSessions` 中的 `dispatcher` 重建行之后紧接加上 `insecureDispatcher` 重建。实现者读 `loadPersistedSessions` 全函数确保位置正确。）

- [ ] **Step 7: typecheck + build + test**

Run: `npm run typecheck && npm run build && node scripts/test.mjs`
Expected: 无新增错误；测试全绿。

- [ ] **Step 8: 提交**

```bash
git add server/index.mjs
git commit -m "feat(failover): 自动发现控制面端点 + session 扩展(endpoints/endpointIdx/insecureDispatcher) + SQLite 持久化"
```

---

### Task 3: requestKubernetes 故障转移迭代 + 流式/exec 用当前端点

**Files:**
- Modify: `server/index.mjs`（`requestKubernetes` ~277-300；`discoverEndpoints` 更新调 `requestOnce`；流式 ~1006；WebSocket/exec buildKubeConfig）

**Interfaces:**
- Consumes: `isFailoverEligible`（Task 1）；`session.endpoints/endpointIdx/dispatcher/insecureDispatcher`（Task 2）。
- Produces: `requestOnce(session, endpoint, path, init)` 内部函数；`requestKubernetes` 成为端点迭代包装。

- [ ] **Step 1: 引入 isFailoverEligible**

在 `server/index.mjs` 顶部 import 段（Task 2 已加 `currentEndpoint, currentDispatcher`）更新为：

```js
import { isFailoverEligible, currentEndpoint, currentDispatcher } from './failover.js'
```

- [ ] **Step 2: 重构 requestKubernetes 为 requestOnce + 端点迭代**

把 `requestKubernetes`（约 277-300）整体替换为（提取 `requestOnce` + failover 迭代）：

```js
// 单端点请求（不转移）：给指定 endpoint 发一次请求，返回 {status, headers, body}，失败抛错。
async function requestOnce(session, endpoint, path, init = {}) {
  const target = new URL(path, endpoint)
  const headers = { accept: 'application/json', ...(init.headers || {}) }
  if (session.authHeader) headers.authorization = session.authHeader
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json'
  const dispatcher = (endpoint === session.apiServer) ? session.dispatcher : (session.insecureDispatcher || session.dispatcher)
  const response = await kubeFetch(target, {
    ...init, headers, dispatcher,
    signal: AbortSignal.timeout(Number(process.env.K8S_REQUEST_TIMEOUT || 15000)),
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!response.ok) {
    const message = body?.message || body?.reason || `Kubernetes API 返回 HTTP ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.details = body
    throw error
  }
  return { status: response.status, headers: response.headers, body }
}

// 故障转移包装：按 session.endpoints 迭代；网络错误/5xx/超时 → 试下一个；4xx 立即抛。
async function requestKubernetes(session, path, init = {}) {
  const endpoints = (session.endpoints && session.endpoints.length) ? session.endpoints : [session.apiServer]
  const errors = []
  for (let attempt = 0; attempt < endpoints.length; attempt++) {
    const idx = (session.endpointIdx + attempt) % endpoints.length
    const endpoint = endpoints[idx]
    try {
      const result = await requestOnce(session, endpoint, path, init)
      if (attempt > 0) { session.endpointIdx = idx; console.log(`[failover] 切换到端点 ${endpoint.host}`) }
      return result
    } catch (e) {
      if (isFailoverEligible(e) && attempt < endpoints.length - 1) {
        errors.push(`${endpoint.host}: ${e.message}`)
        console.warn(`[failover] 端点 ${endpoint.host} 失败 (${e.message || e.code})，尝试下一个...`)
        continue
      }
      if (isFailoverEligible(e) && errors.length) {
        throw Object.assign(new Error(`所有端点不可达（${endpoints.length}个）：${[...errors, `${endpoint.host}: ${e.message}`].join('; ')}`), { status: 503, details: errors })
      }
      throw e
    }
  }
}
```

- [ ] **Step 3: discoverEndpoints 改用 requestOnce**

把 Task 2 新增的 `discoverEndpoints` 中的 `await requestKubernetes(session, '/api/v1/nodes?limit=500')` 改为 `await requestOnce(session, session.apiServer, '/api/v1/nodes?limit=500')`（避免 discoverEndpoints 调用 failover 版 requestKubernetes 时 session.endpoints 未就绪的循环问题）。

- [ ] **Step 4: 流式请求用当前端点**

把流式路径（约 1006）：

```js
      const target = new URL(kubernetesPath, session.apiServer)
      const upstream = await kubeFetch(target, {
        method: 'GET',
        headers: { accept: 'application/json', ...(session.authHeader ? { authorization: session.authHeader } : {}) },
        dispatcher: session.dispatcher,
```

替换为（用 `currentEndpoint` + `currentDispatcher`）：

```js
      const target = new URL(kubernetesPath, currentEndpoint(session))
      const upstream = await kubeFetch(target, {
        method: 'GET',
        headers: { accept: 'application/json', ...(session.authHeader ? { authorization: session.authHeader } : {}) },
        dispatcher: currentDispatcher(session),
```

- [ ] **Step 5: WebSocket/exec 用当前端点**

在 `server/index.mjs` 中 grep `session.apiServer` 找 WebSocket/exec 相关的 `buildKubeConfig` 或 `server:` 构建处（约 405-452），把引用 `session.apiServer` 的地方改为 `currentEndpoint(session)`（尤其是 `server: session.apiServer.origin` 或 `new URL(..., session.apiServer)` 形式）。dispatcher 同理改 `currentDispatcher(session)`。

用 `grep -n 'session\.apiServer' server/index.mjs` 定位所有剩余引用，逐一评估是否需改为 `currentEndpoint(session)`（requestKubernetes 内部已改；session 创建/持久化里的 apiServer 保持原样——是原始端点存储）。

- [ ] **Step 6: typecheck + build + test**

Run: `npm run typecheck && npm run build && node scripts/test.mjs`
Expected: 无新增错误；测试全绿。

- [ ] **Step 7: 提交**

```bash
git add server/index.mjs
git commit -m "feat(failover): requestKubernetes 端点迭代（网络错误/5xx→切换）+ 流式/exec 用当前端点"
```

---

## Self-Review（计划编写后自检，已修正）

- **Spec coverage**：① isFailoverEligible/currentEndpoint/currentDispatcher 纯函数+单测（Task 1）② 自动发现+session 扩展+持久化（Task 2）③ requestKubernetes 端点迭代+流式/exec（Task 3）④ 4xx 不转移（isFailoverEligible false → 立即抛）⑤ 候选跳过证书（insecureDispatcher insecure:true）⑥ 流式/exec 用当前端点（Task 3 Step 4/5）——全覆盖。
- **Placeholder scan**：无 TBD/TODO。Task 3 Step 5 用 grep 定位 exec 路径的 apiServer 引用（该路径代码结构需实现者定位，给了明确 grep 指令）。
- **Type consistency**：`isFailoverEligible(error)=>bool`（Task 1）→ requestKubernetes 迭代调用（Task 3）；`currentEndpoint(session)=>URL`/`currentDispatcher(session)=>Agent`（Task 1）→ 流式/exec 使用（Task 3）；`session.endpoints/endpointIdx/insecureDispatcher`（Task 2）→ requestOnce/discoverEndpoints 使用（Task 3）。字段名一致。
- **循环依赖避免**：discoverEndpoints 调 `requestOnce`（单端点，不读 session.endpoints），不是 `requestKubernetes`（failover 版会读 session.endpoints）。Task 3 Step 3 明确处理。
- **SQLite 兼容**：ALTER TABLE ADD COLUMN（兼容已有库）+ stmtUpsert 更新为 11 参数。
