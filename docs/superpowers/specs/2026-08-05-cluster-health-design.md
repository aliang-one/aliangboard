# 集群健康感知（前端）

- **日期**：2026-08-05
- **状态**：已确认，待实现
- **范围**：前端集群健康感知——从节点（尤其控制面）实时算出集群健康、单一真相源、全位置展示 + Critical 横幅、健康相关错误不再静默。
- **不在范围**：网关多 master 故障转移（自动发现 + 重试）是**独立子项目**（见 §7），本 spec 不含。
- **worktree**：`fix/yaml-blank`（实现前建议先把 YAML 修复合并到 main，再为本特性开新 worktree）

## 1. 背景与动机

用户场景：3 个 master 挂了主 master，网页却显示「集群状态正常」、操作保存不了也无明确提示。根因摸查：
- **`cluster.status` 是静态 `'Healthy'`**（`cluster.js:1460/1521`，连接成功即固定，**永不根据节点健康重算**）——这是"显示正常"的根本原因。
- `mapNode` 能识别 node-role（含 control-plane/master），但**无控制面健康汇总**（就绪控制面数/总数）。
- 核心写操作（CRUD）**有** notify；但 `refreshMetrics`/`hydrateExtended`/`hydrateCRDs`/`refetch` **静默吞错**。
- UI（Footer "Control Plane: Healthy"）展示的是**连接状态**，非控制面健康，具误导性。
- 数据组织合理，但 `cluster.status` 与 `nodeList` 真实健康**脱节**，无单一真相源。

**目标**：集群健康状态真实反映节点（尤其控制面）健康；单一真相源；全位置展示 + 异常横幅；周期检查跟上现实；健康相关错误不再静默。

## 2. 目标与非目标

### 目标
1. **单一真相源 `clusterHealth` computed**（store）：从 `nodeList` + `apiReachable` 实时算出；所有 UI 读它（替换静态 `cluster.status`）。
2. **控制面优先分级**：apiReachable=false → Disconnected；控制面有 NotReady → Critical；worker 有 NotReady → Degraded；否则 Healthy。
3. **`mapNode` 加 `isControlPlane`**（从 node-role 标签派生）。
4. **周期健康检查**：`refreshNodeHealth()` 每 10s 轻量重拉 `/api/v1/nodes` → 就地更新节点 Ready/NotReady + `apiReachable`；store 级 interval（connect 启 / disconnect 清）。
5. **全位置展示 + Critical 横幅**：TopNavBar 徽章、Footer（控制面 ready/total）、ClusterOverview 健康卡、AppLayout 顶部横幅（Critical/Disconnected）。
6. **健康相关错误不再静默**：`refreshNodeHealth` 失败 → Disconnected；`hydrateCoreResources` 拉节点失败 → 连接错误 + notify；子资源水合静默（无权限容忍）→ `console.warn`。

### 非目标（YAGNI）
- 不做网关多 master 故障转移（独立子项目，§7）。
- 不重构整个 store 数据组织（已合理；只加 `clusterHealth` 真相源）。
- Pod 级健康不进集群状态（节点级即可；Pod 异常在监控中心/告警已覆盖）。
- 不替换既有 `healthyNodes`/`totalNodes` 计算属性（保留兼容；`clusterHealth` 是上层汇总）。

## 3. 现状（关键代码位置）

- `src/stores/cluster.js`：
  - `cluster` ref（~77）：`status` 在 `setConnectedCluster`（~1460）设 `'Healthy'`，静态。
  - `mapNode`（~1499）：`status: Ready/NotReady`；`roles`（node-role 标签拼接）；**无 isControlPlane**。
  - `healthyNodes`/`totalNodes`（~156-157）：全局节点计数。
  - `hydrateCoreResources`（~1994）：拉 `/api/v1/nodes` 等；节点拉取失败无专门提示。
  - `refreshMetrics`/`hydrateExtendedResources`/`hydrateCRDs`/`refetch`：catch 静默。
- `src/components/layout/TopNavBar.vue`（~90,186）：`clusterStatusColor(status)` 用静态 `c.status`。
- `src/components/layout/AppLayout.vue`（~51 Footer）：`Control Plane: {{ store.cluster.status }}`。
- `src/views/ClusterOverview.vue`：集群摘要（用静态 status + healthyNodes）。

## 4. 设计

### 4.1 `mapNode` 加 `isControlPlane`
```js
const roleList = Object.keys(item.metadata?.labels || {})
  .filter(k => k.startsWith('node-role.kubernetes.io/'))
  .map(k => k.split('/')[1])
const isControlPlane = roleList.some(r => r === 'control-plane' || r === 'master')
return { /* 现有字段 */ , roles: roleList.join(',') || 'worker', isControlPlane }
```

### 4.2 `clusterHealth` computed（单一真相源）
```js
const apiReachable = ref(true)   // 由 refreshNodeHealth 维护
const clusterHealth = computed(() => {
  const cp = nodeList.value.filter(n => n.isControlPlane)
  const cpReady = cp.filter(n => n.status === 'Ready')
  const workers = nodeList.value.filter(n => !n.isControlPlane)
  const wReady = workers.filter(n => n.status === 'Ready')
  if (!remoteMode.value || !apiReachable.value || !nodeList.value.length) {
    return { status: 'Disconnected', severity: 'none', reasons: ['API 不可达或未连接'],
             controlPlane: { ready: cpReady.length, total: cp.length }, workers: { ready: wReady.length, total: workers.length } }
  }
  if (cp.length && cpReady.length < cp.length) {
    return { status: 'Critical', severity: 'crit', reasons: [`控制面 ${cpReady.length}/${cp.length} 就绪`],
             controlPlane: { ready: cpReady.length, total: cp.length }, workers: { ready: wReady.length, total: workers.length } }
  }
  if (wReady.length < workers.length) {
    return { status: 'Degraded', severity: 'warn', reasons: [`worker ${wReady.length}/${workers.length} 就绪`],
             controlPlane: { ready: cpReady.length, total: cp.length }, workers: { ready: wReady.length, total: workers.length } }
  }
  return { status: 'Healthy', severity: 'ok', reasons: [],
           controlPlane: { ready: cpReady.length, total: cp.length }, workers: { ready: wReady.length, total: workers.length } }
})
```
> 边界：`cp.length === 0`（未检测到控制面，如 role 标签缺失）→ 跳过 Critical 判定，按 worker 判定 Degraded/Healthy（reasons 附"未检测到控制面节点"）。
> 导出 `clusterHealth`、`apiReachable`。

### 4.3 周期健康检查 `refreshNodeHealth()`（10s）
```js
let healthTimer = null
async function refreshNodeHealth() {
  if (!remoteMode.value) return
  try {
    const data = await api.k8s('/api/v1/nodes?limit=500')
    const byName = new Map((data?.items || []).map(it => [it.metadata?.name, it]))
    for (const n of nodeList.value) {
      const item = byName.get(n.name)
      if (item) {
        const ready = item.status?.conditions?.find(c => c.type === 'Ready')
        n.status = ready?.status === 'True' ? 'Ready' : 'NotReady'   // 就地更新，不碰 metrics/raw
      }
    }
    apiReachable.value = true
  } catch { apiReachable.value = false }
}
function startHealthCheck() { if (healthTimer || !remoteMode.value) return; refreshNodeHealth(); healthTimer = setInterval(refreshNodeHealth, 10000) }
function stopHealthCheck() { if (healthTimer) clearInterval(healthTimer); healthTimer = null }
```
- 连接成功（`setConnectedCluster` / `hydrateCoreResources` 首次成功后）调 `startHealthCheck()`；断开/登出（`remoteMode=false`）调 `stopHealthCheck()` + `apiReachable=false`。
- 只更新现有 nodeList 项的 `status`（轻量、不重置 metrics/raw）；节点增删由全量 hydrate 处理。

### 4.4 展示（全位置 + Critical 横幅）
- **TopNavBar 徽章**：颜色由 `clusterHealth.severity`（ok=绿 primary / warn=黄 tertiary-container / crit=红 error / none=灰 on-surface-variant）；tooltip 显示 status + reasons。替换现有 `clusterStatusColor(c.status)`。
- **Footer（AppLayout）**：`控制面 {{ cp.ready }}/{{ cp.total }} · worker {{ w.ready }}/{{ w.total }} · {{ status }}`，替换 `Control Plane: {{ store.cluster.status }}`。
- **ClusterOverview**：新增/改健康卡——大状态徽章 + 控制面就绪 + worker 就绪 + reasons 列表（替代静态 status 展示）。
- **AppLayout 顶部横幅**：`v-if="clusterHealth.status === 'Critical' || clusterHealth.status === 'Disconnected'"`，红色横幅：`⚠ 控制面异常 {{cp.ready}}/{{cp.total}}` 或 `⚠ API 不可达/已断开`。

### 4.5 健康相关错误不再静默
- `refreshNodeHealth` 失败 → `apiReachable=false` → clusterHealth=Disconnected（已含，§4.3）。
- `hydrateCoreResources` 拉**节点**（nodeData）失败 → `connectionState='error'` + `notify('error', '节点列表拉取失败：…')`（确保水合失败可见，不只 namespace 失败才报）。
- 写操作（remoteCreate/Update/Patch/Delete）已 `notify('error', …)`（保留，确认含 K8s 返回原因——gateway `requestKubernetes` 已抛 `message`）。
- 子资源水合静默（`hydrateExtendedResources`/`hydrateCRDs`/`refetch` 无权限容忍）→ 改为 `console.warn(e)`（便于排查，不打扰用户；不改成 notify，避免权限受限场景刷屏）。

## 5. 测试

- 项目无前端测试框架 → 主要手动验证（`npm run dev` + 一个可控集群）：
  - 让一个控制面节点 NotReady（如 stop kubelet）→ 10s 内 TopNavBar 徽章变红、横幅出现、ClusterOverview 健康卡 Critical、Footer 显示控制面 X/Y。
  - 让一个 worker 节点 NotReady → Degraded（黄），无横幅。
  - 全部 Ready → Healthy（绿）。
  - 断开/API 不可达 → Disconnected（灰 + 横幅）。
  - 写操作在集群 Critical 时仍尝试（错误 notify 含原因）。
- `npm run typecheck && npm run build`：无新增错误。
- 可选：把 `clusterHealth` 的判定逻辑抽成纯函数（入参 nodeList + apiReachable + remoteMode）→ `scripts/test.mjs` 契约测试（控制面/worker/Disconnected/无控制面 各场景）。

## 6. 涉及文件清单

**修改**
- `src/stores/cluster.js` — `mapNode` 加 `isControlPlane`；新增 `apiReachable` ref + `clusterHealth` computed + `refreshNodeHealth`/`startHealthCheck`/`stopHealthCheck` + 连接/断开钩子；hydrate 节点失败 notify；子资源 `console.warn`；导出 `clusterHealth`/`apiReachable`。
- `src/components/layout/TopNavBar.vue` — 徽章颜色改用 `clusterHealth.severity` + tooltip。
- `src/components/layout/AppLayout.vue` — Footer 改控制面/worker 就绪数 + status；加 Critical/Disconnected 顶部横幅。
- `src/views/ClusterOverview.vue` — 健康卡改用 `clusterHealth`（status + 控制面/worker + reasons）。

**新增（可选）**
- `src/composables/useClusterHealth.js` — 若把 `clusterHealth` 判定抽成纯函数（`computeClusterHealth({nodeList, apiReachable, remoteMode})`）便于单测。

## 7. 未来子项目（不在本 spec）：网关多 master 故障转移

用户要求：导入集群时配置常只有一个 master 地址，希望自动发现其余 master 地址，主端点挂了自动从其它 master 查询（治"操作保存不了"）。已确认可行，**作为独立子项目**：
- 网关（`server/index.mjs`）层：连接后 `GET /api/v1/nodes` → 过滤 control-plane → 取 InternalIP → 候选 `https://<ip>:6443`，存 session。
- `/api/k8s` 请求：优先当前端点；连接级失败（ECONNREFUSED/超时/5xx）→ 重试下一个候选 → 缓存可用端点。
- **证书**：对同集群发现的候选端点跳过校验（`rejectUnauthorized:false`，已与用户确认接受）。
- 前提：初始配置端点能通才能发现；端口假设 6443（可配）。
- 与本 spec 关系：本 spec 的 `clusterHealth`（Disconnected 反映所有端点失败）+ 故障转移互补——前者展示，后者保操作可用。
