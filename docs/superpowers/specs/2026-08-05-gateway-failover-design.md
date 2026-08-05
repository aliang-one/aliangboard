# 网关多 master 故障转移

- **日期**：2026-08-05
- **状态**：已确认，待实现
- **范围**：网关（server/index.mjs）层——自动发现控制面端点 + 请求故障转移 + 候选端点跳过证书校验。
- **worktree**：`feat/cluster-failover`（基于 main `b114e9e`）

## 1. 背景与动机

用户导入集群时常只配一个 master 地址。该 master 挂掉后，网关**所有请求失败**（单端点模型，无故障转移），导致"操作保存不了"。前端集群健康感知（已合并到 main）能**显示**这个问题（Disconnected/Critical），但操作仍不可用。

**目标**：网关自动发现集群的其余控制面节点地址，主端点挂了自动从其它 master 查询，让操作在 master 故障时**继续可用**。

## 2. 目标与非目标

### 目标
1. **自动发现**：连接时（probe 成功后）GET /api/v1/nodes → 过滤控制面节点 → 取 InternalIP → 候选端点列表。
2. **故障转移**：requestKubernetes 遇**网络错误/5xx/超时**→ 自动切到下一个候选端点重试；4xx 立即抛（重试无意义）。
3. **跳过证书校验**：候选端点（非原始配置端点）用 `rejectUnauthorized: false`（用户已确认），复用原始 ca/cert/key。
4. **持久化**：候选端点列表存 SQLite（session 恢复时还原）。
5. **流式/exec**：用当前端点（故障转移后的 endpointIdx），不透明转移（客户端重连触发 requestKubernetes → 故障转移生效）。

### 非目标（YAGNI）
- 不做周期性 re-discovery（连接时一次；新加 master 需重连）。
- 不做端点健康检查/冷却/blacklist（简单"失败试下一个"）。
- 不做流式透明转移（靠客户端 watch 重连）。
- 不做 per-endpoint 独立证书（复用 + 候选跳过校验）。
- 不改前端（cluster-health 的 Disconnected 天然反映 all-endpoints-fail）。

## 3. 现状（关键代码位置，server/index.mjs）

| 功能 | 行号 | 说明 |
|---|---|---|
| sessions Map | ~15 | 内存 session 存储 |
| SQLite sessions 表 | ~26-32 | 持久化 schema |
| normalizeServer() | ~233-239 | URL 解析（返回完整 URL 对象） |
| buildDispatcher() | ~269-275 | undici Agent（`rejectUnauthorized: !insecure` + ca/cert/key） |
| requestKubernetes() | ~277-300 | `target = new URL(path, session.apiServer)` → kubeFetch → 错误提取 |
| /api/session (POST) | ~650-690 | 创建 session：probe /version → 存 Map + SQLite |
| session 对象 | ~678 | `{ apiServer, authHeader, dispatcher, ca, cert, key, insecure, version, createdAt }` |
| persistSession() | ~149-161 | 写 SQLite |
| /api/k8s 路由 | ~995-1051 | 缓冲请求 → requestKubernetes；流式 → kubeFetch pipe |
| 流式 watch/follow | ~1003-1035 | `target = new URL(kubernetesPath, session.apiServer)` → pipe |
| /api/apply | ~710-720 | applyYaml → requestKubernetes PATCH |
| WebSocket/exec | ~405-452 | buildKubeConfig 用 session.apiServer |

**无重试/故障转移/多端点**——所有请求锁定 `session.apiServer`。

## 4. 设计

### 4.1 辅助：`currentEndpoint(session)` + `isFailoverEligible(error)`

```js
// 当前活跃端点（故障转移后更新）
function currentEndpoint(session) {
  return session.endpoints[session.endpointIdx]
}

// 是否应触发故障转移（网络错误 / 5xx / 超时；4xx 不触发）
function isFailoverEligible(error) {
  if (!error) return false
  const code = error.code || ''
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true
  if (error.name === 'AbortError' || /timeout|aborted/i.test(error.message || '')) return true
  if (error.status >= 500) return true   // 5xx 服务端错误
  return false
}
```

> `isFailoverEligible` 为纯函数，可抽到 `server/failover.js` 便于测试（见 §5）。

### 4.2 自动发现（session 创建后）

```js
async function discoverEndpoints(session) {
  try {
    const result = await requestKubernetesRaw(session, '/api/v1/nodes?limit=500')
    const nodes = result.body?.items || result.items || []
    const port = session.apiServer.port || (session.apiServer.protocol === 'https:' ? '443' : '80')
    const cpIPs = []
    for (const node of nodes) {
      const labels = node.metadata?.labels || {}
      const isCP = labels['node-role.kubernetes.io/control-plane'] !== undefined || labels['node-role.kubernetes.io/master'] !== undefined
      if (!isCP) continue
      const ip = node.status?.addresses?.find(a => a.type === 'InternalIP')?.address
      if (ip) cpIPs.push(ip)
    }
    // 候选 = 控制面 IP + 原始端口；去重（排除原始 apiServer 的 host）
    const candidates = cpIPs
      .map(ip => new URL(`${session.apiServer.protocol}//${ip}:${port}`))
      .filter(u => u.origin !== session.apiServer.origin)
    return [session.apiServer, ...candidates]
  } catch {
    return [session.apiServer]   // 发现失败 → 只用原始端点
  }
}
```

> `requestKubernetesRaw` = 现有 requestKubernetes 的"单端点不转移"版本（用 session.apiServer + session.dispatcher），供发现阶段使用（发现时还没有多端点）。

### 4.3 session 扩展

创建 session 时（POST /api/session，probe 成功后）：
```js
session.endpoints = await discoverEndpoints(session)
session.endpointIdx = 0
session.insecureDispatcher = buildDispatcher({ ca: session.ca, cert: session.cert, key: session.key, insecure: true })   // 候选端点专用（跳过证书）
```

- `session.dispatcher`（原始，用户 insecure 设定）用于 `endpoints[0]`（原始端点）。
- `session.insecureDispatcher`（强制 insecure:true）用于 `endpoints[1+]`（候选端点）。

### 4.4 requestKubernetes 故障转移（核心重构）

```js
async function requestKubernetes(session, path, init = {}) {
  const errors = []
  const max = (session.endpoints || [session.apiServer]).length
  for (let attempt = 0; attempt < max; attempt++) {
    const idx = (session.endpointIdx + attempt) % max
    const endpoint = session.endpoints[idx]
    const dispatcher = idx === 0 ? session.dispatcher : session.insecureDispatcher
    try {
      const target = new URL(path, endpoint)
      const headers = { accept: 'application/json', ...(init.headers || {}) }
      if (session.authHeader) headers.authorization = session.authHeader
      if (init.body && !headers['content-type']) headers['content-type'] = 'application/json'
      const response = await kubeFetch(target, { ...init, headers, dispatcher, signal: AbortSignal.timeout(Number(process.env.K8S_REQUEST_TIMEOUT || 15000)) })
      // 成功 → 缓存当前端点
      if (attempt > 0) session.endpointIdx = idx
      // 既有后处理（parse body + !ok 抛错）
      // ... （现有逻辑不变）
      return { status, body, headers }
    } catch (e) {
      if (isFailoverEligible(e) && attempt < max - 1) { errors.push(`${endpoint.host}: ${e.message}`); continue }
      if (isFailoverEligible(e)) throw Object.assign(new Error(`所有端点不可达（${max}个）：${errors.join('; ')}`), { status: 503, details: errors })
      throw e   // 4xx / 非 failover 错误 → 立即抛
    }
  }
}
```

> 4xx（error.status < 500）不触发转移（`isFailoverEligible` 返回 false → 立即抛）。
> 所有端点失败 → 503 汇总错误（前端 notify 显示"所有端点不可达"）。

### 4.5 流式 + exec + apply 用当前端点

- 流式（watch/follow，~1003-1035）：`new URL(kubernetesPath, currentEndpoint(session))`（替代 `session.apiServer`）。流式不做迭代；连接断 → 客户端重连 → requestKubernetes → 故障转移。
- WebSocket/exec（buildKubeConfig）：`server: currentEndpoint(session).origin`（替代 `session.apiServer.origin`）。
- applyYaml：走 requestKubernetes（已含故障转移）。

### 4.6 持久化（SQLite）

- sessions 表加列 `endpoints TEXT`（JSON 数组 of URL origins）+ `endpointIdx INTEGER DEFAULT 0`。
- persistSession：序列化 `endpoints.map(u => u.origin)` + endpointIdx。
- restoreSession：反序列化 `endpoints = JSON.parse(row.endpoints).map(o => new URL(o))`；重建 insecureDispatcher。

> API Server 列改名？不——保留 `apiServer` 列（= endpoints[0] origin，兼容旧 session）。`endpoints` 为新增列（旧 session 无 → fallback `[session.apiServer]`）。

## 5. 测试

- **纯函数单测**（`scripts/test.mjs` 或 `exec-bridge.test.mjs`）：`isFailoverEligible` 覆盖：ECONNREFUSED→true、ETIMEDOUT→true、AbortError→true、status 503→true、status 404→false、status 401→false、null→false。
- **手动验证**（`npm run server` + 可控集群）：
  - 连接（配一个 master 地址）→ gateway 日志显示发现的候选端点数。
  - 停掉该 master 的 kube-apiserver → 前端操作（刷新列表/查看 YAML）仍成功（gateway 自动切到候选）→ 前端 clusterHealth 仍 Healthy（refreshNodeHealth 成功）。
  - 停掉所有 master → 操作失败 + notify"所有端点不可达" + clusterHealth Disconnected。
- `npm run typecheck && npm run build`：无新增错误（server 改动不影响前端 build；但跑 build 确保 server 路径引用不破坏）。
- 现有 exec-bridge.test.mjs 回归（session 创建 / k8s 代理 / apply 仍工作）。

## 6. 涉及文件清单

**修改**
- `server/index.mjs` — `isFailoverEligible` + `currentEndpoint` + `discoverEndpoints` + session 扩展（endpoints/endpointIdx/insecureDispatcher）+ requestKubernetes 故障转移迭代 + 流式/exec 用 currentEndpoint + SQLite schema/persist/restore。

**新增（可选）**
- `server/failover.js` — 若抽 `isFailoverEligible` 纯函数便于单测。
