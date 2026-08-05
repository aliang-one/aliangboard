# 子项目 B：实时监控中心

- **日期**：2026-08-05
- **状态**：已确认，待实现
- **范围**：子项目 B（独立 `/monitoring` 页 + 轻量 metrics 刷新）。子项目 A 已完成；本 spec 不含 A。
- **worktree**：`feat/storage-monitoring`（基于 main `6f7304f`）

## 1. 背景与动机

平台已集成 metrics-server（节点 + Pod 瞬时 CPU/内存），但展示**分散**：`ClusterOverview` 是带**假 SVG 装饰趋势图**的准 dashboard，`Nodes`/`NodeDetail`/`PodDetail`/`NsWorkloadDetail` 各有零散指标，事件流在 `NsEvents`（按 ns）。没有一个**中心化、实时、专业**的监控入口"监听平台动向"。

且 store **无轻量 metrics 刷新**——指标重算只在 `hydrateCoreResources`（重，重拉所有核心资源）里发生，不适合高频轮询。`useMetricsHistory` 是单 ns + 一组 pod 的工作负载级轮询，不能直接做集群级趋势。

**关键约束**：metrics-server 只给**当前瞬时值，无历史**。本子项目做**实时**监控中心（瞬时值 + 分钟级轮询趋势窗口），不做 24h/7d 历史（那需 Prometheus，子项目 C）。

## 2. 目标与非目标

### 目标
1. 新建独立 `/monitoring` 页 `MonitoringCenter.vue` + 集群级侧边栏入口。
2. store 新增 `refreshMetrics()`：从 `hydrateCoreResources` 抽出 metrics 刷新为共享逻辑（只拉 metrics.k8s.io + 重算指标，不重拉 nodes/pods 列表），hydrate 复用（DRY）。
3. 页面 onMounted 轮询 refreshMetrics（10s），本地维护集群 CPU/内存滚动窗口（30 样本 ≈ 5min）→ MiniChart 真趋势；onUnmount 停。
4. 区块：集群资源 KPI（CPU/内存 % + 真趋势）、节点健康网格、Top Pods（CPU/内存）、事件流（集群级实时 + Warning 高亮）、告警面板（高 CPU 节点 / 失败 Pod / 未就绪 Deployment）。
5. metrics-server 未就绪时降级展示。

### 非目标（YAGNI）
- 不做历史趋势（24h/7d，需 Prometheus，留子项目 C）。
- 不替换 `ClusterOverview`（保留作集群摘要；监控中心是独立专业页）。
- 不改 `NsWorkloadDetail` 等既有指标展示。
- 不引入图表库（复用 MiniChart）、不引入轮询库（原生 setInterval）。

## 3. 现状（关键代码位置）

- `src/stores/cluster.js`：
  - `hydrateCoreResources`（约 1994）：`Promise.allSettled` 拉 metrics.k8s.io `/nodes`（2008）+ `/pods`（2009）等；约 2026-2101 做 `metricsAvailable`/`nodeMetricMap`/`podMetricMap`/`nodeMetric`/`podMetric` helper/`cluster.cpuUsage`+`memoryUsage`+trend（vs `prevClusterMetrics`）/ 写回 `cluster.value`。
  - `mapNode`（约 1468）/`mapPod`（约 1493）：用 `nodeMetric`/`podMetric` 算 `cpu`/`memory`/`usedCpu`/`usedMem`。
  - `refreshPods`（1060）存在（重拉 pod 列表）；**无 `refreshMetrics`**。
  - `store.cluster`：`metricsAvailable`/`cpuUsage`/`memoryUsage`/`cpuTrend`/`memoryTrend`/...
  - `store.eventList`（集群级，`/api/v1/events?limit=1000`）+ `startEventWatch`/`stopEventWatch`/`eventsFor`。
- `src/composables/useMetricsHistory.js`：ns + podNames 作用域的 5s 轮询 + 30 样本窗口；导出 `toMilli`/`toMi`。**不适合集群级**，仅作模式参考。
- `src/components/common/MiniChart.vue`：props `series:number[]`/`refLines`/`color`/`height`/`label`/`unit`；SVG 折线/面积。
- `src/components/common/ProgressBar.vue`、`StatusChip.vue`：可复用。
- `src/views/NsEvents.vue`：`startEventWatch` 实时事件流模式（参考）。
- `src/views/ClusterOverview.vue`：现有准 dashboard（假 SVG 趋势，60-123），**不改**，但监控中心替代其"监控"角色。

## 4. 设计

### 4.1 路由 / 导航
- `src/router/index.js`：集群级（scope: global）加 `{ path: '/monitoring', name: 'MonitoringCenter', component: () => import('@/views/MonitoringCenter.vue') }`。
- `src/components/layout/SideNavBar.vue`：`clusterPrimaryNav` 加 `{ icon: 'monitoring', label: '监控中心', route: '/monitoring' }`（放 Cluster Overview 之后）。

### 4.2 store `refreshMetrics()`（新 + DRY 抽取）
把 `hydrateCoreResources` 中"处理 metrics"那段（约 2026-2101）抽成内部函数 `applyClusterMetrics(nodeMetricsData, podMetricsData)`：
- 重建 `nodeMetricMap`/`podMetricMap`（模块作用域，与现有一致）。
- 计算 `metricsAvailable`/`cpuUsage`/`memoryUsage`/trend（vs `prevClusterMetrics`，复用现有 `trendOf`）。
- **重映射** `nodeList`（用新 `nodeMetric` 重跑 `mapNode`）/`podList`（重跑 `mapPod`）以刷新 `cpu`/`memory`/`usedCpu`/`usedMem`。
- 写回 `cluster.value`（metricsAvailable/cpuUsage/memoryUsage/trend）。

`hydrateCoreResources` 改为：拉 metrics 后调 `applyClusterMetrics(nodeMetricsData, podMetricsData)`（行为不变，纯重构）。

新增导出 `refreshMetrics()`：
```js
async function refreshMetrics() {
  if (!remoteMode.value) return
  try {
    const [nodeMetricsData, podMetricsData] = await Promise.all([
      api.k8s('/apis/metrics.k8s.io/v1beta1/nodes'),
      api.k8s('/apis/metrics.k8s.io/v1beta1/pods'),
    ])
    applyClusterMetrics(nodeMetricsData, podMetricsData)
  } catch { /* 静默：cluster.metricsAvailable 由 applyClusterMetrics 在数据缺失时置 false */ }
}
```
在 store return 导出 `refreshMetrics`。

### 4.3 实时轮询（页面内）
`MonitoringCenter.vue` `<script setup>`：
```js
const cpuSeries = ref([])
const memSeries = ref([])
const lastRefresh = ref('')
let timer = null
const MAX = 30
async function tick() {
  await store.refreshMetrics()
  cpuSeries.value = [...cpuSeries.value, store.cluster.cpuUsage].slice(-MAX)
  memSeries.value = [...memSeries.value, store.cluster.memoryUsage].slice(-MAX)
  lastRefresh.value = new Date().toLocaleTimeString()
}
onMounted(() => { tick(); timer = setInterval(tick, 10000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
```
> 注：`store.cluster.cpuUsage` 为 `null`（metrics 不可用）时不推入窗口（或推入但 MiniChart 过滤非正数——MiniChart 已 filter `> 0`，故 null/0 自动不绘点）。

### 4.4 区块（template）
1. **Header**：「监控中心」+ `LIVE` 徽章（轮询中）+ `上次刷新 {{ lastRefresh }}` + 手动刷新按钮（调 `tick`）。
2. **KPI 卡（4 列）**：
   - CPU：`store.cluster.cpuUsage%` + `<MiniChart :series="cpuSeries" color="var(--md-sys-color-primary)" />` + 趋势箭头（cpuTrend）。
   - 内存：同（memoryUsage/memSeries）。
   - 节点健康：`readyNodes/totalNodes`（从 nodeList）。
   - 异常计数：`failedPods + warningEvents`（computed）。
   - `!store.cluster.metricsAvailable` 时 CPU/内存卡降级显示「metrics-server 未就绪」。
3. **节点健康网格**：`v-for node in nodeList`，每节点卡片：名 + StatusChip + CPU ProgressBar + Mem ProgressBar（复用 `node.cpu`/`node.memory`）。可点击跳 NodeDetail。
4. **Top Pods（tab CPU/内存）**：`topPods = computed(() => [...store.podList].sort(by usedCpu or usedMem).slice(0,10))`；表格 Pod/ns/CPU/Mem。
5. **事件流**：`onMounted` 启 `store.startEventWatch()`（集群级），`onUnmounted` `stopEventWatch()`；展示最近 50，Warning 行高亮（`type==='Warning'`）。过滤 normal/warning toggle。
6. **告警面板**：`highCpuNodes`（cpu>80）、`failedPods`（status Failed）、`notReadyDeployments`（workloadList 中 ready<desired）—— 列出可点击跳转。

### 4.5 边界与错误处理
- `!remoteMode`（未连集群）：refreshMetrics 直接 return；页面显示"请先连接集群"。
- metrics-server 未就绪（`!cluster.metricsAvailable`）：CPU/内存 KPI 降级；MiniChart 窗口可能空（不强推 null）。
- 轮询报错：refreshMetrics 内 catch 静默；页面不崩（available 自然 false）。
- 页面卸载：clearInterval + stopEventWatch。
- 空集群：各区块空状态。

### 4.6 复用
- `MiniChart`（series/refLines/color）、`ProgressBar`、`StatusChip`、`DataTable`（Top Pods 表）。
- events watch 模式参考 `NsEvents.vue`。
- `useMetricsHistory` 的 `toMilli`/`toMi` 不直接用（store 内 `cpuToMilli`/`memToKi` 已有）。

## 5. 测试

- 项目无前端测试框架 → 主要靠**手动验证**（`npm run dev` + 集群有 metrics-server）：
  - 进 `/monitoring`：KPI 卡显示真实 CPU/内存 %；MiniChart 随轮询画出趋势线（10s 一更新）。
  - 节点网格 CPU/内存随轮询变化；Top Pods 排序正确。
  - 事件流实时推送（Warning 高亮）。
  - 告警面板：构造高 CPU 节点/失败 Pod/未就绪 Deployment → 出现。
  - 离开页面：轮询 + eventWatch 停止（无泄漏）。
  - metrics-server 缺失：降级提示。
- `npm run typecheck && npm run build`：无新增错误。
- `applyClusterMetrics` 抽取为内部函数后，**行为应与原 hydrate 内联逻辑完全一致**（纯重构，通过 hydrate 路径回归——连接集群后指标展示与抽取前一致）。可选：若 `applyClusterMetrics` 能做成无 Vue 依赖的纯函数（入参 metrics 数据 + nodeList/podList，出 usage/maps），可加 `scripts/test.mjs` 契约测试；但因其依赖模块作用域 `prevClusterMetrics`/`cpuToMilli` 等，不强求，视抽取结果定。

## 6. 涉及文件清单

**新增**
- `src/views/MonitoringCenter.vue` —— 监控中心页（轮询 + 5 区块）。

**修改**
- `src/stores/cluster.js` —— 抽 `applyClusterMetrics` 内部函数（hydrate 复用）+ 新增导出 `refreshMetrics()`。
- `src/router/index.js` —— 加 `/monitoring` 路由（scope: global）。
- `src/components/layout/SideNavBar.vue` —— `clusterPrimaryNav` 加「监控中心」入口。
