# 集群健康感知（前端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 集群健康状态真实反映节点（尤其控制面）健康——单一真相源 `clusterHealth` computed + 控制面优先分级 + 10s 周期检查 + 全位置展示 + Critical 横幅 + 健康相关错误不再静默。

**Architecture:** 抽无依赖纯函数 `computeClusterHealth`（可单测）；store 加 `apiReachable` ref + `clusterHealth` computed（复用纯函数）+ `mapNode.isControlPlane` + `refreshNodeHealth`/`startHealthCheck`（10s 轮询节点状态 + 可达性）；UI（TopNavBar/Footer/ClusterOverview/横幅）读 `clusterHealth` 替换静态 `cluster.status`。

**Tech Stack:** Vue 3 `<script setup>`、Pinia、Vite、原生 setInterval、零依赖 node 测试运行器（`scripts/test.mjs`）。

## Global Constraints

- **单一真相源**：`store.clusterHealth` computed 是集群健康唯一来源；所有 UI 读它（替换静态 `cluster.status`）。
- **控制面优先分级**：`apiReachable=false`/`!remoteMode`/空 nodeList → **Disconnected**；控制面有 NotReady → **Critical**；worker 有 NotReady → **Degraded**；否则 **Healthy**。
- **10s 周期检查**：`refreshNodeHealth()` 轻量重拉 `/api/v1/nodes` → 就地更新 nodeList 的 Ready/NotReady + `apiReachable=true`；失败 → `apiReachable=false`。store 级 interval（`setConnectedCluster` 启动）。
- **健康相关错误不再静默**：节点拉取失败 → notify；子资源水合静默 → `console.warn`（不刷屏）。
- 不改网关（多 master 故障转移是独立子项目）；不重构整个 store 数据组织；禁新增外部依赖。

---

## File Structure

**新增**
- `src/composables/useClusterHealth.js` — `computeClusterHealth({nodeList, apiReachable, remoteMode})` 纯函数。

**修改**
- `src/stores/cluster.js` — import 纯函数；`mapNode` 加 `isControlPlane`；`apiReachable` ref + `clusterHealth` computed；`refreshNodeHealth`/`startHealthCheck`/`stopHealthCheck`；`setConnectedCluster` 启动检查；hydrate 节点失败 notify；子资源 `console.warn`；导出 `clusterHealth`/`apiReachable`。
- `src/components/layout/TopNavBar.vue` — 徽章颜色改用 `clusterHealth.severity`。
- `src/components/layout/AppLayout.vue` — Footer 控制面/worker 就绪数 + 顶部 Critical/Disconnected 横幅。
- `src/views/ClusterOverview.vue` — 节点卡显示 `clusterHealth`（status + 控制面就绪）。
- `scripts/test.mjs` — 追加 `computeClusterHealth` 契约测试。

---

### Task 1: 纯函数 `computeClusterHealth` + 单测（TDD）

**Files:**
- Create: `src/composables/useClusterHealth.js`
- Test: `scripts/test.mjs`

**Interfaces:**
- Produces: `computeClusterHealth({ nodeList=[], apiReachable=true, remoteMode=true }) => { status, severity, reasons, controlPlane:{ready,total}, workers:{ready,total} }`。`status`: `'Healthy'|'Degraded'|'Critical'|'Disconnected'`；`severity`: `'ok'|'warn'|'crit'|'none'`。从 `../src/composables/useClusterHealth.js` import。

- [ ] **Step 1: 写失败测试**

在 `scripts/test.mjs` 的"汇总"段（`const failed = ...` 之前）追加：

```js
// --- 集群健康判定：控制面优先分级（Disconnected/Critical/Degraded/Healthy）---
import { computeClusterHealth } from '../src/composables/useClusterHealth.js'
test('computeClusterHealth：控制面优先分级', () => {
  const cp = st => ({ isControlPlane: true, status: st })
  const w = st => ({ isControlPlane: false, status: st })
  // Healthy：控制面全 Ready + worker 全 Ready
  let h = computeClusterHealth({ nodeList: [cp('Ready'), cp('Ready'), w('Ready')], apiReachable: true, remoteMode: true })
  assert.equal(h.status, 'Healthy'); assert.equal(h.severity, 'ok')
  assert.equal(h.controlPlane.total, 2); assert.equal(h.controlPlane.ready, 2); assert.equal(h.workers.total, 1)
  // 控制面有 NotReady → Critical
  h = computeClusterHealth({ nodeList: [cp('Ready'), cp('NotReady'), w('Ready')], apiReachable: true, remoteMode: true })
  assert.equal(h.status, 'Critical'); assert.equal(h.severity, 'crit'); assert.equal(h.controlPlane.ready, 1)
  // worker NotReady（控制面全 Ready）→ Degraded
  h = computeClusterHealth({ nodeList: [cp('Ready'), w('Ready'), w('NotReady')], apiReachable: true, remoteMode: true })
  assert.equal(h.status, 'Degraded'); assert.equal(h.severity, 'warn'); assert.equal(h.workers.ready, 1)
  // apiReachable=false → Disconnected（即使节点全 Ready）
  assert.equal(computeClusterHealth({ nodeList: [cp('Ready')], apiReachable: false, remoteMode: true }).status, 'Disconnected')
  // !remoteMode → Disconnected
  assert.equal(computeClusterHealth({ nodeList: [cp('Ready')], apiReachable: true, remoteMode: false }).status, 'Disconnected')
  // 空 nodeList → Disconnected
  assert.equal(computeClusterHealth({ nodeList: [], apiReachable: true, remoteMode: true }).status, 'Disconnected')
  // 无控制面（role 标签缺失，isControlPlane 全 false）→ 按 worker 判定 Degraded
  h = computeClusterHealth({ nodeList: [w('Ready'), w('NotReady')], apiReachable: true, remoteMode: true })
  assert.equal(h.status, 'Degraded'); assert.equal(h.controlPlane.total, 0)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/test.mjs`
Expected: FAIL，报 `Cannot find module '../src/composables/useClusterHealth.js'`。

- [ ] **Step 3: 实现纯函数**

创建 `src/composables/useClusterHealth.js`：

```js
// 集群健康判定纯函数：从节点列表 + API 可达性算出 {status, severity, reasons, controlPlane, workers}。
// 控制面优先分级：不可达/未连接/空 → Disconnected；控制面有 NotReady → Critical；
// worker 有 NotReady → Degraded；否则 Healthy。无依赖，便于 scripts/test.mjs 直接 import。
export function computeClusterHealth({ nodeList = [], apiReachable = true, remoteMode = true } = {}) {
  const cp = nodeList.filter(n => n.isControlPlane)
  const cpReady = cp.filter(n => n.status === 'Ready')
  const workers = nodeList.filter(n => !n.isControlPlane)
  const wReady = workers.filter(n => n.status === 'Ready')
  const base = { controlPlane: { ready: cpReady.length, total: cp.length }, workers: { ready: wReady.length, total: workers.length } }
  if (!remoteMode || !apiReachable || !nodeList.length) {
    return { status: 'Disconnected', severity: 'none', reasons: ['API 不可达或未连接'], ...base }
  }
  if (cp.length && cpReady.length < cp.length) {
    return { status: 'Critical', severity: 'crit', reasons: [`控制面 ${cpReady.length}/${cp.length} 就绪`], ...base }
  }
  if (wReady.length < workers.length) {
    return { status: 'Degraded', severity: 'warn', reasons: [`worker ${wReady.length}/${workers.length} 就绪`], ...base }
  }
  return { status: 'Healthy', severity: 'ok', reasons: [], ...base }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/test.mjs`
Expected: PASS（`✓ N/N 用例全部通过`）。

- [ ] **Step 5: 提交**

```bash
git add src/composables/useClusterHealth.js scripts/test.mjs
git commit -m "feat(cluster-health): 抽 computeClusterHealth 纯函数 + 契约测试"
```

---

### Task 2: store — mapNode.isControlPlane + apiReachable + clusterHealth + 周期检查 + 错误提示

**Files:**
- Modify: `src/stores/cluster.js`（顶部 import；`mapNode` ~1534；`healthyNodes` 段 ~156；`refreshPods` 段 ~1060；`setConnectedCluster` ~1504；`hydrateCoreResources` ~2094；子资源 catch；return 导出 ~3274/3332）

**Interfaces:**
- Consumes: `computeClusterHealth`（Task 1）。
- Produces: `mapNode` 返回对象新增 `isControlPlane: boolean`；store 新增 `apiReachable` ref + `clusterHealth` computed（导出）；内部 `refreshNodeHealth`/`startHealthCheck`/`stopHealthCheck`。

**Discipline:** 只加健康感知相关：mapNode isControlPlane、apiReachable/clusterHealth、refreshNodeHealth/lifecycle、setConnectedCluster hook、hydrate 节点 notify、子资源 console.warn、导出。**不碰** CRUD、mapPod、generateYAML、computeClusterMetrics、metrics 路径等无关逻辑。

- [ ] **Step 1: 引入纯函数**

`src/stores/cluster.js` 顶部 `@/composables/...` import 段追加：

```js
import { computeClusterHealth } from '@/composables/useClusterHealth'
```

- [ ] **Step 2: mapNode 加 isControlPlane**

把 `mapNode` 中（约 1542-1545）这一段：

```js
    return {
      name: item.metadata?.name,
      status: ready?.status === 'True' ? 'Ready' : 'NotReady',
      roles: Object.keys(item.metadata?.labels || {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]).join(',') || 'worker',
```

替换为（抽出 roleList 派生 isControlPlane）：

```js
    const roleList = Object.keys(item.metadata?.labels || {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1])
    return {
      name: item.metadata?.name,
      status: ready?.status === 'True' ? 'Ready' : 'NotReady',
      roles: roleList.join(',') || 'worker',
      isControlPlane: roleList.some(r => r === 'control-plane' || r === 'master'),
```

- [ ] **Step 3: apiReachable + clusterHealth computed**

在 `healthyNodes`/`totalNodes` computed（约 156-157）之后追加：

```js
  const apiReachable = ref(true)
  const clusterHealth = computed(() => computeClusterHealth({
    nodeList: nodeList.value, apiReachable: apiReachable.value, remoteMode: remoteMode.value,
  }))
```

- [ ] **Step 4: refreshNodeHealth / start / stop**

在 `refreshPods`（约 1060）之前（或 `refreshMetrics` 附近）插入：

```js
  // 周期健康检查：轻量重拉 /api/v1/nodes → 就地更新 nodeList 的 Ready/NotReady + apiReachable。
  // 失败 → apiReachable=false（clusterHealth 转 Disconnected）。只更新现有节点状态，不碰 metrics/raw；节点增删由全量 hydrate 处理。
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
          n.status = ready?.status === 'True' ? 'Ready' : 'NotReady'
        }
      }
      apiReachable.value = true
    } catch { apiReachable.value = false }
  }
  function startHealthCheck() {
    if (healthTimer || !remoteMode.value) return
    refreshNodeHealth()
    healthTimer = setInterval(refreshNodeHealth, 10000)
  }
  function stopHealthCheck() { if (healthTimer) clearInterval(healthTimer); healthTimer = null }
```

- [ ] **Step 5: setConnectedCluster 启动检查**

把 `setConnectedCluster` 末尾（约 1516-1523，`cluster.value = { ...status: 'Healthy', }` 之后、函数闭合 `}` 之前）：

```js
    cluster.value = {
      ...cluster.value,
      name,
      apiServer: info.apiServer,
      version: info.version || cluster.value.version,
      status: 'Healthy',
    }
  }
```

替换为（末尾加 `startHealthCheck()`）：

```js
    cluster.value = {
      ...cluster.value,
      name,
      apiServer: info.apiServer,
      version: info.version || cluster.value.version,
      status: 'Healthy',
    }
    apiReachable.value = true
    startHealthCheck()
  }
```

> 说明：store 无显式 disconnect 路径（`remoteMode` 不会置 false）；interval 在登出/页面重载时自然消亡。`stopHealthCheck` 供未来 disconnect 钩子使用。

- [ ] **Step 6: hydrate 节点拉取失败 notify**

在 `hydrateCoreResources` 中 `const nodeData = valueAt(0)`（约 2094）之后追加：

```js
    if (!nodeData && remoteMode.value) notify('error', '节点列表拉取失败：集群可能不可达或 RBAC 缺乏 nodes 读权限')
```

- [ ] **Step 7: 子资源水合静默 → console.warn**

把以下 3 处空 `catch` 改为 `console.warn`（用 grep 定位）：
- `try { await hydrateExtendedResources() } catch { /* 容错：部分资源无权限时忽略 */ }` → `catch (e) { console.warn('[hydrate] 扩展资源部分失败:', e?.message || e) }`
- `hydrateCRDs().catch(() => {})` → `hydrateCRDs().catch(e => console.warn('[hydrate] CRD 拉取失败:', e?.message || e))`
- `refetch` 函数里的 `catch { /* 忽略刷新失败（如该类资源无权限） */ }` → `catch (e) { console.warn('[refetch] 刷新失败:', path, e?.message || e) }`

（用 `grep -nE "catch \{\s*/\* (容错|忽略)" src/stores/cluster.js` 定位精确行。）

- [ ] **Step 8: 导出 clusterHealth / apiReachable**

在 store return 的计算属性段（`healthyNodes, totalNodes,` 约 3274 那行）追加 `clusterHealth, apiReachable,`：

```js
    runningPods, pendingPods, failedPods, healthyNodes, totalNodes, clusterHealth, apiReachable,
```

- [ ] **Step 9: typecheck + build + test**

Run: `npm run typecheck && npm run build && node scripts/test.mjs`
Expected: 无新增错误；测试全绿。

- [ ] **Step 10: 提交**

```bash
git add src/stores/cluster.js
git commit -m "feat(cluster-health): store 暴露 clusterHealth(控制面优先分级) + 10s 周期检查 + 节点失败 notify"
```

---

### Task 3: TopNavBar 徽章 + AppLayout Footer & Critical 横幅

**Files:**
- Modify: `src/components/layout/TopNavBar.vue`（`clusterStatusColor` ~90；徽章 ~186）
- Modify: `src/components/layout/AppLayout.vue`（Footer ~46-62；加横幅）

**Interfaces:**
- Consumes: `store.clusterHealth`（Task 2）。

- [ ] **Step 1: TopNavBar 徽章颜色改用 clusterHealth**

把 `TopNavBar.vue` 的 `clusterStatusColor`（约 89-94）：

```js
// 集群状态 → 圆点颜色
function clusterStatusColor(status) {
  if (status === 'Healthy') return 'bg-primary'
  if (status === 'Degraded') return 'bg-error'
  return 'bg-on-surface-variant'
}
```

替换为（按 clusterHealth.severity；用当前集群名查 store.clusterHealth）：

```js
// 集群健康 → 圆点颜色（来自 store.clusterHealth，控制面优先分级）
function clusterStatusColor(severity) {
  if (severity === 'ok') return 'bg-primary'
  if (severity === 'warn') return 'bg-tertiary-container'
  if (severity === 'crit') return 'bg-error'
  return 'bg-on-surface-variant'
}
function healthOf(name) {
  return store.clusterHealth   // 单连接下全局 clusterHealth；多集群下拉里均显示当前活跃集群健康
}
```

把徽章那行（约 186）：

```html
                <span class="w-2 h-2 rounded-full shrink-0" :class="clusterStatusColor(c.status)"></span>
```

替换为：

```html
                <span class="w-2 h-2 rounded-full shrink-0" :class="clusterStatusColor(c.name === store.currentCluster ? store.clusterHealth.severity : 'none')" :title="c.name === store.currentCluster ? (store.clusterHealth.reasons.join('；') || 'Healthy') : c.status"></span>
```

> 当前活跃集群用 `store.clusterHealth`；下拉里其它已保存集群仍用其静态 `c.status`（无实时健康）。

- [ ] **Step 2: AppLayout Footer 改控制面/worker 就绪数**

把 `AppLayout.vue` Footer（约 49-56）：

```html
          <div class="flex items-center gap-sm">
            <span class="w-2 h-2 bg-primary-container rounded-full animate-pulse-status"></span>
            <span class="text-body-sm text-on-surface-variant">Control Plane: {{ store.cluster.status }}</span>
          </div>
          <div class="flex items-center gap-sm">
            <span class="w-2 h-2 bg-primary-container rounded-full"></span>
            <span class="text-body-sm text-on-surface-variant">Nodes: {{ store.healthyNodes }}/{{ store.totalNodes }} Online</span>
          </div>
```

替换为（用 clusterHealth；圆点颜色随 severity）：

```html
          <div class="flex items-center gap-sm">
            <span class="w-2 h-2 rounded-full" :class="{ 'bg-primary': store.clusterHealth.severity === 'ok', 'bg-tertiary-container': store.clusterHealth.severity === 'warn', 'bg-error': store.clusterHealth.severity === 'crit', 'bg-on-surface-variant': store.clusterHealth.severity === 'none' }"></span>
            <span class="text-body-sm text-on-surface-variant">集群: {{ store.clusterHealth.status }} · 控制面 {{ store.clusterHealth.controlPlane.ready }}/{{ store.clusterHealth.controlPlane.total }} · worker {{ store.clusterHealth.workers.ready }}/{{ store.clusterHealth.workers.total }}</span>
          </div>
```

- [ ] **Step 3: AppLayout 加 Critical/Disconnected 顶部横幅**

在 `AppLayout.vue` 的 `<main>`（或 `<router-view>` 容器）**之前**插入横幅（找到 Footer 之前的 `<main class=...>` 起始处，或 `<div class="flex-1 ...">` 主内容容器起始处，在其上方插入）：

```html
    <!-- 集群健康横幅：Critical / Disconnected -->
    <div v-if="store.clusterHealth.status === 'Critical' || store.clusterHealth.status === 'Disconnected'"
      class="px-lg py-sm flex items-center gap-sm text-on-error bg-error/10 border-b border-error/30 text-body-sm">
      <span class="material-symbols-outlined text-base">crisis_alert</span>
      <span v-if="store.clusterHealth.status === 'Critical'">控制面异常：{{ store.clusterHealth.controlPlane.ready }}/{{ store.clusterHealth.controlPlane.total }} 就绪 · {{ store.clusterHealth.reasons.join('；') }}</span>
      <span v-else>集群不可达或未连接：{{ store.clusterHealth.reasons.join('；') }}</span>
    </div>
```

> 实现者：定位主内容容器（`<main>` 或包裹 `<router-view>` 的 `<div>`）的起始标签，在其**正上方**插入该横幅 `<div>`，确保横幅在内容顶部、Footer 之上。

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。

- [ ] **Step 5: 提交**

```bash
git add src/components/layout/TopNavBar.vue src/components/layout/AppLayout.vue
git commit -m "feat(cluster-health): TopNavBar 徽章 + Footer 控制面就绪数 + Critical/Disconnected 横幅"
```

---

### Task 4: ClusterOverview 节点卡显示 clusterHealth

**Files:**
- Modify: `src/views/ClusterOverview.vue`（节点卡 ~34-43）

**Interfaces:**
- Consumes: `store.clusterHealth`（Task 2）。

- [ ] **Step 1: 节点卡显示健康状态 + 控制面就绪**

把 ClusterOverview 节点卡的"Operational"行（约 38-40）：

```html
          <p class="text-body-sm text-primary flex items-center gap-xs mt-xs">
            <span class="material-symbols-outlined text-base">check_circle</span> {{ store.healthyNodes }}/{{ store.totalNodes }} Operational
          </p>
```

替换为（按 clusterHealth.severity 着色 + 显示状态/控制面）：

```html
          <p class="text-body-sm flex items-center gap-xs mt-xs"
            :class="{ 'text-primary': store.clusterHealth.severity === 'ok', 'text-tertiary-container': store.clusterHealth.severity === 'warn', 'text-error': store.clusterHealth.severity === 'crit' || store.clusterHealth.severity === 'none' }">
            <span class="material-symbols-outlined text-base">{{ store.clusterHealth.severity === 'ok' ? 'check_circle' : 'warning' }}</span>
            {{ store.clusterHealth.status }} · 控制面 {{ store.clusterHealth.controlPlane.ready }}/{{ store.clusterHealth.controlPlane.total }}
          </p>
```

- [ ] **Step 2: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。

- [ ] **Step 3: 提交**

```bash
git add src/views/ClusterOverview.vue
git commit -m "feat(cluster-health): ClusterOverview 节点卡显示 clusterHealth(状态+控制面就绪)"
```

---

## Self-Review（计划编写后自检，已修正）

- **Spec coverage**：① clusterHealth computed 单一真相源（Task 2）② 控制面优先分级（Task 1 纯函数 + Task 2 computed）③ mapNode isControlPlane（Task 2）④ refreshNodeHealth 10s（Task 2）⑤ 全位置展示（Task 3 TopNavBar/Footer/横幅 + Task 4 ClusterOverview）⑥ Critical 横幅（Task 3）⑦ 健康相关错误不静默（Task 2 节点 notify + 子资源 console.warn）——全覆盖。
- **Placeholder scan**：无 TBD/TODO；每步含可执行代码或精确 grep 定位。Task 3 Step 3 横幅插入点用文字指明（主内容容器起始处上方）——因 AppLayout 结构需实现者定位，给了明确锚点。
- **Type consistency**：`computeClusterHealth({nodeList, apiReachable, remoteMode})`（Task 1）→ store `clusterHealth` computed 调用它（Task 2）→ UI 读 `store.clusterHealth.{status,severity,reasons,controlPlane,workers}`（Task 3/4）。字段名一致。`mapNode.isControlPlane`（Task 2）→ 纯函数 `n.isControlPlane`（Task 1 测试用 cp/w 工厂）。
- **生命周期**：`startHealthCheck` 在 `setConnectedCluster` 启动（Task 2 Step 5）；store 无 disconnect 路径，interval 重载消亡；`stopHealthCheck` 供未来（已在 Task 2 Step 4 注明）。
