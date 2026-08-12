# Cluster Overview 真实化设计

- 日期:2026-08-12
- 分支:`worktree-cluster-overview-realtime`
- 状态:待实现

## 背景与根因

Cluster Overview 页顶部汇总数据(Total Nodes / Total Pods / Active Events / CPU% / Memory% 及趋势折线)是**写死的 mock 残留**,不是真实集群数据。

根因链(已通过代码追踪确认):

1. `src/stores/cluster.js` 的 `cluster` ref 初始值是 mock 时代硬编码假数据:`Production-Cluster-01` / `nodeCount:8` / `podCount:247` / `activeEvents:18` / `cpuUsage:62` / `memoryUsage:58` / `metricsAvailable:true`。
2. 这些汇总字段只有 `computeClusterMetrics()`(store.js)会用真实数据覆盖。
3. `computeClusterMetrics()` 只被 `refreshMetrics()` 调用。
4. `refreshMetrics()` 只被 `src/views/MonitoringCenter.vue:52` 调用(监控中心页)。
5. `ClusterOverview.vue` 自身只调 `store.fetchNodes()` / `store.fetchEvents()`(纯 fetcher,不写 `store.cluster`),登录/切集群(`switchCluster`/`setConnectedCluster`)也只更新 name/apiServer/version/status,不碰汇总数字。

→ 只要用户没先进入「监控中心」页,ClusterOverview 顶部就永远是 `8 / 247 / 18 / 62% / 58%`。而页面下方节点卡片(`fetchNodes`)和事件列表(`fetchEvents`)是真实的,与顶部对不上,暴露假数据。

此外,同一份 `cluster` 假初始值还被另外两处读,属**系统性残留**:

- `src/views/Settings.vue:145/149` — 显示 `nodeCount`/`podCount`(假)
- `src/views/Workloads.vue:212/223` — 显示集群 `cpuUsage%`/`podCount`(假)

`MonitoringCenter.vue` 也读 `cpuUsage/memoryUsage`,但靠 `refreshMetrics` 轮询覆盖,是真实的。`SideNavBar`/`AppLayout` 读 `name`/`version`(登录后被写真,问题小)。

这是 2026-08-09 删除 demo/mock 模式时漏删的 `cluster` 初始值(各 `xxxList` ref 当时已改 `ref([])`,唯独这个汇总 ref 漏改)。

环境约束:

- K8s `metrics.k8s.io` 只返回瞬时值,无历史。
- `server/` 网关是纯 K8s API 透传,没有 Prometheus / Thanos / 任何 range-query 历史源(grep 确认)。
- 因此「真实趋势」的天花板 = **session 内滚动采样**(监控中心已是如此:每 10s 采一点,滚动 30 点 ≈ 5min,喂 `MiniChart`)。真正 24h/7d/30d 回溯需先接 Prometheus,属另一独立工程,本设计不覆盖。

`MiniChart`(`src/components/common/MiniChart.vue`,零依赖,`series:number[]`,空数组自动不画线)已存在并被监控中心使用,可直接复用。

## 目标

- ClusterOverview 顶部三卡、CPU/Mem 百分比、趋势折线全部显示**真实数据**。
- 折线为 session 内真实滚动采样(复用监控中心范式 + `MiniChart`),去掉骗人的 `24h/7d/30d` 假按钮,换诚实标签。
- 顺手治好 `Settings.vue` / `Workloads.vue` 的同源假数据。
- 清掉 `store.cluster` 的 mock 初始值,让所有读者在无真实数据时诚实降级(`—`/0)。
- 不新增外部依赖;契合既定「服务端状态归 Vue Query」数据层路线。

## 非目标

- 不接 Prometheus / 不做真正的 24h/7d/30d 历史回溯(留待后续独立工程)。
- 不改 `MonitoringCenter.vue`(它已真实)。
- 不重构 `store.cluster` 的 name/version/apiServer/status(登录/切集群已写真)。

## 设计

### §1 数据模型与初始值清理 — `src/stores/cluster.js`

- `cluster` ref 数字汇总字段初始值改为诚实降级值:
  - `nodeCount: 0`,`podCount: 0`,`activeEvents: 0`
  - `cpuUsage: null`,`memoryUsage: null`
  - `cpuTrend: '—'`,`memoryTrend: '—'`,`cpuTrendUp: null`,`memoryTrendUp: null`
  - `metricsAvailable: false`
  - `name: ''`(未连接时空,不再骗显 `Production-Cluster-01`)
  - `version`/`apiServer`/`status`:保留现有初始值(登录后被写真)
- `computeClusterMetrics(metricsAvailable)` 的**计数来源改为 Vue Query 缓存**:
  - `nodeCount` ← `queryClient.getQueryData(['cluster', cid, 'nodes'])?.length`(回退 `nodeList.value.length`)
  - `podCount` ← `queryClient.getQueryData(['cluster', cid, 'pods'])?.length`(回退 `podList.value.length`)
  - `activeEvents` ← `queryClient.getQueryData(['cluster', cid, 'events'])?.length`(回退 `eventList.value.length`)
  - 其中 `cid = currentCluster.value || 'cluster'`
  - CPU/Mem% 算法不变(仍按 `nodeList` 的 used/alloc 聚合;trend 与 `metricsAvailable` 逻辑不变)
  - 效果:**任何页拉过对应 list,汇总即真**;`Settings`/`Workloads` 不必各自加 query。

### §2 ClusterOverview.vue — 主改动

- 新增 `podsQuery`:`useResourceList({ key:['cluster', cid, 'pods'], fetcher: () => store.fetchPods(), options:{ refetchInterval:30000 } })`,`podList = computed(() => podsQuery.data.value || [])`。
- 新增趋势采样(移植 `MonitoringCenter.vue:42-61`):
  - `const cpuSeries = ref([])`,`const memSeries = ref([])`,`const MAX = 30`,`let timer = null`
  - `async function tick()`:调 `await store.refreshMetrics()`,取 `store.cluster.cpuUsage/memoryUsage`,`!= null` 则 push 并 `.slice(-MAX)`。
  - `onMounted`:`tick()` + `timer = setInterval(tick, 10000)`。
  - `onUnmounted`:`clearInterval(timer)`。
- 顶部三卡数值:`store.cluster.nodeCount/podCount/activeEvents` → **`nodeList.length` / `podList.length` / `eventList.length`**。
- CPU/Mem 卡:数值仍读 `store.cluster.cpuUsage/memoryUsage`(被 `refreshMetrics` 写真);`!= null` 时显示 `x%` + trend,否则 `—`。
- 折线:删除写死的 `<svg><path d="M0,80 Q50,70 ...">`(`ClusterOverview.vue:127-131`、`:147-151`),换成 `<MiniChart :series="cpuSeries" color="var(--md-sys-color-primary)" :height="128" />` / `<MiniChart :series="memSeries" color="var(--md-sys-color-primary)" :height="128" />`。
- 删除 `24h/7d/30d` 切换按钮(`:104-112`)及 `timeRange` ref;换成静态诚实标签 `{{ $t('cluster.liveWindow') }}`。
- `metricsAvailable === false` 时:CPU/Mem 卡显示 `—`,MiniChart `series` 为空(不画线),保留现有「metrics 不可用」横幅(`:101-103`)。

### §3 Workloads.vue / Settings.vue — 顺手治

- 两页继续读 `store.cluster.cpuUsage/podCount/nodeCount`,因 §1 的 `computeClusterMetrics` 从缓存派生 + `refreshMetrics` 触发,**自动变真**。
- `Workloads.vue`:`onMounted` 触发一次 `store.refreshMetrics()`(进页即真,无需等别处拉数据)。`Workloads.vue:205` 的 nodeHealth 用 `store.totalNodes/healthyNodes`(真),不动。
- `Settings.vue`:**零代码改动**;未拉过 list 时显示 `0`/`—`(诚实,优于假 8/247)。

### §4 i18n(`src/locales/zh.json` / `en.json`)

- 新增 `cluster.liveWindow`:zh `"会话内 · 最近 5min"`,en `"Session · last 5min"`。
- 复用现有 `cluster.metricsUnavailable` / `cluster.metricsUnavailableHint`。
- 折线 x 轴的 `cluster.timeAgo` / `cluster.timeNow` 若实现后不再被引用则移除(实现时确认;移除须同步 zh/en 并过 `i18n:check`)。
- 须过 `npm run i18n:check` 三合一门禁(残留中文 + 键对齐 + 引用键缺失)。

### §5 测试

- 纯逻辑单测(自研零依赖运行器,`scripts/test.mjs` / `node --test`):为 `computeClusterMetrics` 的计数派生写单测 —— 造 `queryClient` 缓存(nodes/pods/events 各若干)+ 断言 `cluster.value.nodeCount/podCount/activeEvents` 正确;缓存空时回退 0。
  - 若 `computeClusterMetrics` 当前是 store 内闭包函数不便直接测,则将其计数逻辑抽成模块级纯函数(入参:缓存快照 + metricsAvailable,出参:汇总对象)再测,符合项目「纯逻辑优先零依赖运行器」约定。
- `npm run typecheck`(`node --check` 全 .js/.mjs;.vue 由 build 覆盖)。
- `npm run i18n:check`。
- `npm test` 全绿。

### §6 边界与降级

- metrics server 缺失 → `cpuUsage/memoryUsage = null` → 卡显示 `—`、MiniChart 空不画线、`metricsAvailable=false` 显示提示横幅(复用监控中心同款降级)。
- 切集群 `queryClient.clear()` → 缓存空,汇总回 `0/—`,随各页重拉转真。
- 趋势上限 = session 内,`cluster.liveWindow` 标签诚实明示,不伪装长时段。
- `name === ''`(未连接)→ 副标题 `{{ store.cluster.name }}` 显示空,可接受(路由门已 `!currentCluster` 拦截未连接)。

## 影响文件清单

| 文件 | 改动 |
|------|------|
| `src/stores/cluster.js` | `cluster` 初始值清诚实值;`computeClusterMetrics` 计数改从 queryClient 缓存派生(或抽纯函数 + 单测) |
| `src/views/ClusterOverview.vue` | 加 `podsQuery`;趋势采样 + `MiniChart`;顶部三卡读 list.length;删假按钮 + 写死 path |
| `src/views/Workloads.vue` | `onMounted` 调 `store.refreshMetrics()`(一行) |
| `src/views/Settings.vue` | 无代码改动(受益于 §1) |
| `src/locales/zh.json` / `en.json` | 新增 `cluster.liveWindow`;可能移除 `timeAgo/timeNow` |
| 新增单测文件(`src/stores/__tests__/` 或 `scripts/`) | `computeClusterMetrics` 计数派生单测 |

## 风险

- **`computeClusterMetrics` 改造**:需保证 metrics(CPU/Mem%)计算路径不变,只改计数字段来源;抽纯函数时注意 `prevClusterMetrics`(趋势对比)状态保留在 store 闭包内,不能丢。
- **podCount 准确性依赖 pods 缓存**:仅当某页拉过 `['cluster',cid,'pods']` 才准;ClusterOverview 与监控中心都会拉。Settings 进入前若无人拉过则显示 0/—(可接受,诚实)。
- **采样定时器生命周期**:`onUnmounted` 必须清 `setInterval`,否则离开页面后仍轮询(泄漏)。与监控中心同款写法,风险低。
- **i18n 键移动**:移除 `timeAgo/timeNow` 须确认无其它视图引用,否则 `i18n:check` 报引用键缺失。
