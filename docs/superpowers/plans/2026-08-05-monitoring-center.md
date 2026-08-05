# 子项目 B：实时监控中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建独立 `/monitoring` 实时监控中心页（集群 CPU/内存 KPI + 真趋势、节点健康网格、Top Pods、事件流、告警面板），由轻量 `store.refreshMetrics()` 每 10s 轮询驱动。

**Architecture:** 从 `hydrateCoreResources` 抽出集群指标汇总尾段为 `computeClusterMetrics(metricsAvailable)`（hydrate 复用，行为不变）；新增 `refreshMetrics()`（只重拉 metrics.k8s.io → 就地更新 nodeList/podList 指标字段 → 调 computeClusterMetrics）；`MonitoringCenter.vue` 轮询 refreshMetrics + 本地滚动窗口喂 MiniChart。

**Tech Stack:** Vue 3 `<script setup>`、Pinia、Vite、原生 setInterval、MiniChart/ProgressBar/StatusChip。

## Global Constraints

- **实时，无历史**：基于 metrics-server 瞬时值 + 10s 轮询的分钟级滚动窗口（30 样本 ≈ 5min）；不做 24h/7d（留 Prometheus）。
- **不重拉 nodes/pods 列表**：refreshMetrics 只拉 metrics.k8s.io + 就地更新指标字段（结构不变）。
- **不改 hydrate 的 mapping 行为**：仅把「集群汇总尾段」抽成 `computeClusterMetrics` 供 hydrate 与 refreshMetrics 复用（纯重构，行为一致）。
- **轮询生命周期**：onMounted 启 setInterval + startEventWatch；onUnmounted 清 interval + stopEventWatch（无泄漏）。
- metrics-server 未就绪（`!cluster.metricsAvailable`）→ KPI 降级提示；未连集群 → 提示连接。
- 禁新增依赖；不改 ClusterOverview / NsWorkloadDetail 等既有展示。

---

## File Structure

**新增**
- `src/views/MonitoringCenter.vue` — 监控中心页（轮询 + 5 区块）。

**修改**
- `src/stores/cluster.js` — 抽 `computeClusterMetrics`（hydrate 复用）+ 新增导出 `refreshMetrics()`。
- `src/router/index.js` — 全局路由段加 `monitoring`。
- `src/components/layout/SideNavBar.vue` — `clusterPrimaryNav` 加「监控中心」入口。

---

### Task 1: store — 抽 computeClusterMetrics + 新增 refreshMetrics

**Files:**
- Modify: `src/stores/cluster.js`（hydrate 的汇总尾段 ~2074-2104；新增 computeClusterMetrics + refreshMetrics；return 导出）

**Interfaces:**
- Produces: `store.refreshMetrics()`（async；remoteMode 下重拉 metrics.k8s.io nodes+pods → 就地更新 nodeList/podList 指标字段 → 重算 cluster.cpuUsage/memoryUsage/trend）。内部 `computeClusterMetrics(metricsAvailable)`（hydrate + refreshMetrics 共用）。

**Discipline:** 只动 hydrate 的汇总尾段（抽成函数调用）+ 新增两个函数 + return 导出。**不碰** hydrate 的 mapping 行为（mapNode/mapPod 仍带 metric）、不碰 nodeMetricMap/podMetricMap 构建段（2025-2038）、不碰其它 CRUD。

- [ ] **Step 1: 新增 computeClusterMetrics 函数**

在 `src/stores/cluster.js` 中、`async function hydrateCoreResources` 定义**之前**（约 1993 行，`hydrateCoreResources` 上方），插入：

```js
  // 集群级 CPU/内存汇总（按 nodeList 的 used/alloc）+ 与上次对比的趋势 + cluster.value 更新。
  // 入参 metricsAvailable：调用前 nodeList/podList 的 metric 字段须已就绪
  // （hydrate 经 mapNode/mapPod 设置；refreshMetrics 就地更新）。hydrate 与 refreshMetrics 共用本函数。
  function computeClusterMetrics(metricsAvailable) {
    let cpuUsage = null, memoryUsage = null
    if (metricsAvailable) {
      let usedCpu = 0, allocCpu = 0, usedMem = 0, allocMem = 0
      for (const n of nodeList.value) {
        if (n.usedCpu != null) usedCpu += n.usedCpu
        if (n.allocCpu > 0) allocCpu += n.allocCpu
        if (n.usedMem != null) usedMem += n.usedMem
        if (n.allocMem > 0) allocMem += n.allocMem
      }
      cpuUsage = allocCpu > 0 ? Math.min(100, Math.round((usedCpu / allocCpu) * 100)) : null
      memoryUsage = allocMem > 0 ? Math.min(100, Math.round((usedMem / allocMem) * 100)) : null
    }
    const trendOf = (cur, prev) => {
      if (cur == null || prev == null) return { trend: '—', up: false }
      const d = cur - prev
      return { trend: (d >= 0 ? '+' : '') + d.toFixed(1) + '%', up: d > 0 }
    }
    const cpuT = trendOf(cpuUsage, prevClusterMetrics.cpu)
    const memT = trendOf(memoryUsage, prevClusterMetrics.mem)
    prevClusterMetrics = { cpu: cpuUsage, mem: memoryUsage }
    cluster.value = {
      ...cluster.value,
      nodeCount: nodeList.value.length,
      podCount: podList.value.length,
      activeEvents: eventList.value.length,
      metricsAvailable,
      cpuUsage, memoryUsage,
      cpuTrend: cpuT.trend, cpuTrendUp: cpuT.up,
      memoryTrend: memT.trend, memoryTrendUp: memT.up,
    }
  }
```

- [ ] **Step 2: hydrate 改为调用 computeClusterMetrics**

把 `hydrateCoreResources` 中的汇总尾段（从 `// 集群级 CPU/内存：按节点用量 / allocatable 汇总；与上次水合对比得出趋势` 到其 `cluster.value = { ... }` 结束的 `}`，约 2074-2104）整体替换为：

```js
    // 集群级 CPU/内存：按节点用量 / allocatable 汇总；与上次水合对比得出趋势
    computeClusterMetrics(metricsAvailable)
```

- [ ] **Step 3: 新增 refreshMetrics 函数**

在 `refreshPods` 函数（约 1060）附近，或 `hydrateCoreResources` 之后，插入：

```js
  // 轻量 metrics 刷新：只重拉 metrics.k8s.io nodes+pods → 就地更新现有 nodeList/podList 指标字段 → 重算集群汇总。
  // 供监控中心高频轮询；不重拉 nodes/pods 列表（结构不变）。失败静默（保留上次 metricsAvailable，下次全量 hydrate 纠正）。
  async function refreshMetrics() {
    if (!remoteMode.value) return
    try {
      const [nodeMetricsData, podMetricsData] = await Promise.all([
        api.k8s('/apis/metrics.k8s.io/v1beta1/nodes'),
        api.k8s('/apis/metrics.k8s.io/v1beta1/pods'),
      ])
      const metricsAvailable = Boolean(nodeMetricsData && podMetricsData)
      const nodeMetricMap = new Map()
      for (const it of (nodeMetricsData?.items || [])) nodeMetricMap.set(it.metadata?.name, { cpuMilli: cpuToMilli(it.usage?.cpu), memKi: memToKi(it.usage?.memory) })
      const podMetricMap = new Map()
      for (const it of (podMetricsData?.items || [])) {
        let cpuMilli = 0, memKi = 0
        for (const c of (it.containers || [])) { cpuMilli += cpuToMilli(c.usage?.cpu); memKi += memToKi(c.usage?.memory) }
        podMetricMap.set(`${it.metadata?.namespace}/${it.metadata?.name}`, { cpuMilli, memKi })
      }
      const pct = (used, alloc) => (used != null && alloc > 0 ? Math.min(100, Math.round((used / alloc) * 100)) : null)
      for (const n of nodeList.value) {
        const m = metricsAvailable ? (nodeMetricMap.get(n.name) || null) : null
        n.usedCpu = m ? m.cpuMilli : null
        n.usedMem = m ? m.memKi : null
        n.cpu = pct(n.usedCpu, n.allocCpu)
        n.memory = pct(n.usedMem, n.allocMem)
      }
      for (const p of podList.value) {
        const m = metricsAvailable ? (podMetricMap.get(`${p.namespace}/${p.name}`) || null) : null
        p.usedCpu = m ? m.cpuMilli : null
        p.usedMem = m ? m.memKi : null
        p.cpu = p.usedCpu != null ? `${Math.round(p.usedCpu)}m/${Math.round(p.reqCpu)}m` : null
        p.memory = p.usedMem != null ? `${Math.round(p.usedMem / 1024)}Mi/${Math.round(p.reqMem / 1024)}Mi` : null
      }
      computeClusterMetrics(metricsAvailable)
    } catch { /* 静默：保留上次 metricsAvailable */ }
  }
```

- [ ] **Step 4: 导出 refreshMetrics**

在 store return 对象里 `refreshPods,`（约 3273）所在行附近加入 `refreshMetrics,`（与 refreshPods 同段）：

```js
    refreshPods,
    refreshMetrics,
```

- [ ] **Step 5: typecheck + build + test**

Run: `npm run typecheck && npm run build && node scripts/test.mjs`
Expected: 无新增错误；测试仍全绿（纯函数测试不受影响；本任务无新增纯函数）。

- [ ] **Step 6: 提交**

```bash
git add src/stores/cluster.js
git commit -m "feat(monitoring): 抽 computeClusterMetrics + 新增 refreshMetrics 轻量指标刷新"
```

---

### Task 2: 路由 + 侧边栏入口

**Files:**
- Modify: `src/router/index.js`（全局路由段，约 38 行 ClusterOverview 之后）
- Modify: `src/components/layout/SideNavBar.vue`（`clusterPrimaryNav`，含子项目 A 加的「存储」项）

- [ ] **Step 1: 加 /monitoring 路由**

在 `src/router/index.js` 全局路由段，`ClusterOverview` 路由块（`path: 'cluster'`，约 33-38）之后插入：

```js
      {
        path: 'monitoring',
        name: 'MonitoringCenter',
        component: () => import('@/views/MonitoringCenter.vue'),
        meta: { title: '监控中心', icon: 'monitoring', scope: 'global' }
      },
```

- [ ] **Step 2: SideNavBar 加入口**

`src/components/layout/SideNavBar.vue` 的 `clusterPrimaryNav`（子项目 A 后已含「存储」），在「存储」之后加「监控中心」：

```js
const clusterPrimaryNav = [
  { icon: 'dashboard', label: 'Cluster Overview', route: '/cluster' },
  { icon: 'dns', label: 'Nodes', route: '/nodes' },
  { icon: 'folder_open', label: 'Namespaces', route: '/namespaces' },
  { icon: 'storage', label: '存储', route: '/storage' },
  { icon: 'monitoring', label: '监控中心', route: '/monitoring' },
]
```

- [ ] **Step 3: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误（`MonitoringCenter.vue` 尚未创建，路由 import 会延迟加载——build 不要求文件存在？**若 build 报找不到 MonitoringCenter.vue**，先创建一个占位空组件 `src/views/MonitoringCenter.vue`（`<template><div class="p-md text-on-surface">监控中心（待实现）</div></template>`），Task 3 会替换它）。

- [ ] **Step 4: 提交**

```bash
git add src/router/index.js src/components/layout/SideNavBar.vue
# 若 Step 3 创建了占位组件，一并 add
git commit -m "feat(monitoring): 加 /monitoring 路由 + 集群级侧边栏入口"
```

---

### Task 3: MonitoringCenter.vue — 指标仪表盘（轮询 + KPI + 节点网格 + Top Pods）

**Files:**
- Create/Replace: `src/views/MonitoringCenter.vue`

**Interfaces:**
- Consumes: `store.refreshMetrics()`、`store.cluster.{cpuUsage,memoryUsage,cpuTrend,cpuTrendUp,memoryTrend,memoryTrendUp,metricsAvailable,nodeCount,podCount}`、`store.nodeList`、`store.podList`、`store.remoteMode`。
- Produces: 监控中心页（指标部分；事件/告警在 Task 4 加）。

- [ ] **Step 1: 创建 MonitoringCenter.vue（指标仪表盘）**

创建 `src/views/MonitoringCenter.vue`（若 Task 2 建了占位，替换其全部内容）：

```vue
<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { useRouter } from 'vue-router'
import MiniChart from '@/components/common/MiniChart.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import StatusChip from '@/components/common/StatusChip.vue'

const store = useClusterStore()
const router = useRouter()

// 实时轮询：每 10s 刷新 metrics + 收集集群 CPU/内存到 30 样本滚动窗口（≈5min）喂 MiniChart
const cpuSeries = ref([])
const memSeries = ref([])
const lastRefresh = ref('')
const sampling = ref(false)
let timer = null
const MAX = 30
async function tick() {
  sampling.value = true
  try {
    await store.refreshMetrics()
    const cpu = store.cluster.cpuUsage
    const mem = store.cluster.memoryUsage
    if (cpu != null) cpuSeries.value = [...cpuSeries.value, cpu].slice(-MAX)
    if (mem != null) memSeries.value = [...memSeries.value, mem].slice(-MAX)
    lastRefresh.value = new Date().toLocaleTimeString()
  } finally { sampling.value = false }
}
onMounted(() => { tick(); timer = setInterval(tick, 10000) })
onUnmounted(() => { if (timer) clearInterval(timer) })

// KPI 派生
const readyNodes = computed(() => store.nodeList.filter(n => n.status === 'Ready').length)
const failedPods = computed(() => store.podList.filter(p => p.status === 'Failed').length)
const warningEvents = computed(() => store.eventList.filter(e => e.type === 'warning').length)   // mapEvent 把 type 小写化为 normal|warning

// Top Pods（tab 切换 CPU/内存）
const topMetric = ref('cpu')
const topPods = computed(() => {
  const key = topMetric.value === 'cpu' ? 'usedCpu' : 'usedMem'
  return [...store.podList]
    .filter(p => p[key] != null && p[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .slice(0, 10)
})
</script>

<template>
  <section class="animate-fade-in">
    <!-- Header -->
    <div class="flex items-end justify-between mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary">monitoring</span> 监控中心
          <span class="inline-flex items-center gap-0.5 px-2 py-0.5 bg-error/10 text-error text-xs rounded-full font-medium"><span class="w-1.5 h-1.5 rounded-full bg-error animate-pulse"></span>LIVE</span>
        </h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">实时集群指标 · 10s 轮询 · 上次刷新 {{ lastRefresh || '—' }}</p>
      </div>
      <button @click="tick" :disabled="sampling" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant rounded-lg hover:bg-surface-container-low disabled:opacity-40">
        <span class="material-symbols-outlined text-base" :class="sampling ? 'animate-spin' : ''">refresh</span> 刷新
      </button>
    </div>

    <!-- 未连接 / 指标不可用 提示 -->
    <div v-if="!store.remoteMode" class="rounded-lg border border-outline-variant bg-surface-container-low p-md text-on-surface-variant text-body-sm mb-md">请先连接集群。</div>
    <div v-else-if="!store.cluster.metricsAvailable" class="rounded-lg border border-tertiary-container/40 bg-tertiary-container/10 p-md text-on-surface-variant text-body-sm mb-md flex items-center gap-sm">
      <span class="material-symbols-outlined text-base">warning</span> metrics-server 未就绪，实时指标暂不可用（节点/工作负载的其它状态仍可看）。
    </div>

    <!-- KPI 卡 -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-sm mb-md">
      <!-- CPU -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <p class="text-label-caps text-on-surface-variant">集群 CPU</p>
        <div class="flex items-end gap-xs mt-xs">
          <span class="text-display-md font-bold text-primary">{{ store.cluster.cpuUsage == null ? '—' : store.cluster.cpuUsage + '%' }}</span>
          <span v-if="store.cluster.cpuTrendUp != null" class="text-xs mb-xs" :class="store.cluster.cpuTrendUp ? 'text-error' : 'text-tertiary-container'">{{ store.cluster.cpuTrend }}</span>
        </div>
        <MiniChart :series="cpuSeries" color="var(--md-sys-color-primary)" :height="48" />
      </div>
      <!-- 内存 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <p class="text-label-caps text-on-surface-variant">集群内存</p>
        <div class="flex items-end gap-xs mt-xs">
          <span class="text-display-md font-bold text-tertiary-container">{{ store.cluster.memoryUsage == null ? '—' : store.cluster.memoryUsage + '%' }}</span>
          <span v-if="store.cluster.memoryTrendUp != null" class="text-xs mb-xs" :class="store.cluster.memoryTrendUp ? 'text-error' : 'text-tertiary-container'">{{ store.cluster.memoryTrend }}</span>
        </div>
        <MiniChart :series="memSeries" color="var(--md-sys-color-tertiary-container)" :height="48" />
      </div>
      <!-- 节点健康 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <p class="text-label-caps text-on-surface-variant">节点健康</p>
        <div class="flex items-end gap-xs mt-xs">
          <span class="text-display-md font-bold" :class="readyNodes === store.nodeList.length ? 'text-tertiary-container' : 'text-error'">{{ readyNodes }}/{{ store.nodeList.length }}</span>
        </div>
        <p class="text-xs text-on-surface-variant mt-sm">Ready 节点</p>
      </div>
      <!-- 异常计数 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <p class="text-label-caps text-on-surface-variant">异常</p>
        <div class="flex items-end gap-xs mt-xs">
          <span class="text-display-md font-bold" :class="(failedPods + warningEvents) > 0 ? 'text-error' : 'text-tertiary-container'">{{ failedPods + warningEvents }}</span>
        </div>
        <p class="text-xs text-on-surface-variant mt-sm">{{ failedPods }} 失败 Pod · {{ warningEvents }} Warning 事件</p>
      </div>
    </div>

    <!-- 节点健康网格 -->
    <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md mb-md">
      <h3 class="text-body-sm font-semibold mb-sm flex items-center gap-xs"><span class="material-symbols-outlined text-primary text-base">dns</span> 节点健康</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-sm">
        <button v-for="n in store.nodeList" :key="n.name" @click="router.push({ name: 'NodeDetail', params: { name: n.name } })" class="text-left rounded-lg border border-outline-variant/60 p-sm hover:border-primary hover:bg-primary-container/5 transition-colors">
          <div class="flex items-center justify-between gap-xs mb-xs">
            <span class="font-mono text-body-sm text-on-surface truncate">{{ n.name }}</span>
            <StatusChip :status="n.status" size="sm" />
          </div>
          <div class="flex items-center gap-xs text-xs text-on-surface-variant mb-0.5"><span class="w-10">CPU</span><ProgressBar :value="n.cpu || 0" class="flex-1" /></div>
          <div class="flex items-center gap-xs text-xs text-on-surface-variant"><span class="w-10">Mem</span><ProgressBar :value="n.memory || 0" class="flex-1" /></div>
        </button>
      </div>
      <p v-if="!store.nodeList.length" class="text-center text-on-surface-variant text-body-sm py-md">无节点</p>
    </div>

    <!-- Top Pods -->
    <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
      <div class="flex items-center justify-between mb-sm">
        <h3 class="text-body-sm font-semibold flex items-center gap-xs"><span class="material-symbols-outlined text-primary text-base">trending_up</span> Top Pods</h3>
        <div class="flex gap-xs">
          <button @click="topMetric = 'cpu'" class="px-2 py-0.5 text-xs rounded" :class="topMetric === 'cpu' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'">CPU</button>
          <button @click="topMetric = 'mem'" class="px-2 py-0.5 text-xs rounded" :class="topMetric === 'mem' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'">内存</button>
        </div>
      </div>
      <div v-if="topPods.length" class="divide-y divide-outline-variant/20">
        <button v-for="(p, i) in topPods" :key="p.namespace + '/' + p.name" @click="router.push({ name: 'PodDetail', params: { namespace: p.namespace, name: p.name } })" class="w-full flex items-center gap-sm py-1.5 hover:bg-surface-container-low rounded px-sm text-left">
          <span class="text-xs text-on-surface-variant w-6">{{ i + 1 }}</span>
          <span class="font-mono text-body-sm text-on-surface flex-1 truncate">{{ p.name }}</span>
          <span class="text-xs text-on-surface-variant">{{ p.namespace }}</span>
          <span class="font-mono text-xs text-primary font-medium">{{ topMetric === 'cpu' ? (p.usedCpu + 'm') : (Math.round(p.usedMem / 1024) + 'Mi') }}</span>
        </button>
      </div>
      <p v-else class="text-center text-on-surface-variant text-body-sm py-md">暂无 Pod 用量数据</p>
    </div>
  </section>
</template>
```

- [ ] **Step 2: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。若 ProgressBar 不接受 `value` prop 或无 `class`，查 `src/components/common/ProgressBar.vue` props 适配（它被 Nodes.vue 用作 `<ProgressBar :value="row.cpu" />`，一致）。

- [ ] **Step 3: 提交**

```bash
git add src/views/MonitoringCenter.vue
git commit -m "feat(monitoring): 监控中心指标仪表盘（轮询+KPI+节点网格+Top Pods）"
```

---

### Task 4: MonitoringCenter.vue — 事件流 + 告警面板

**Files:**
- Modify: `src/views/MonitoringCenter.vue`（扩展 script + template）

**Interfaces:**
- Consumes: `store.startEventWatch()` / `store.stopEventWatch()` / `store.eventList`（集群级）、`store.workloadList`。

- [ ] **Step 1: script 扩展（事件 watch 生命周期 + 派生）**

把 `onMounted` / `onUnmounted` 两行扩展为含事件 watch：

```js
onMounted(() => { tick(); timer = setInterval(tick, 10000); store.startEventWatch() })
onUnmounted(() => { if (timer) clearInterval(timer); store.stopEventWatch() })
```

在 `topPods` computed 之后追加：

```js
// 事件流（集群级，warning 过滤）
const eventFilter = ref('all')   // all | warning
const recentEvents = computed(() => {
  const list = store.eventList
  const filtered = eventFilter.value === 'warning' ? list.filter(e => e.type === 'warning') : list   // type 小写
  return filtered.slice(0, 50)
})
// 告警面板
const highCpuNodes = computed(() => store.nodeList.filter(n => n.cpu != null && n.cpu >= 80))
const notReadyWorkloads = computed(() => store.workloadList.filter(w => w.status !== 'Running'))
```

- [ ] **Step 2: template 追加事件流 + 告警面板**

在 `<section>` 内、Top Pods 的 `</div>` 之后、`</section>` 之前追加：

```html
    <!-- 事件流 + 告警（两列）-->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-sm mt-md">
      <!-- 事件流 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <div class="flex items-center justify-between mb-sm">
          <h3 class="text-body-sm font-semibold flex items-center gap-xs"><span class="material-symbols-outlined text-primary text-base">notifications_active</span> 事件流 <span class="text-xs text-on-surface-variant font-normal">集群级 · 最近 50</span></h3>
          <div class="flex gap-xs">
            <button @click="eventFilter = 'all'" class="px-2 py-0.5 text-xs rounded" :class="eventFilter === 'all' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'">全部</button>
            <button @click="eventFilter = 'warning'" class="px-2 py-0.5 text-xs rounded" :class="eventFilter === 'warning' ? 'bg-error text-on-error' : 'text-on-surface-variant hover:bg-surface-container-low'">Warning</button>
          </div>
        </div>
        <div class="flex flex-col gap-xs max-h-96 overflow-y-auto">
          <div v-for="(e, i) in recentEvents" :key="e.uid || i" class="flex items-start gap-sm p-xs rounded" :class="e.type === 'warning' ? 'bg-error/5' : ''">
            <span class="material-symbols-outlined text-base shrink-0" :class="e.type === 'warning' ? 'text-error' : 'text-on-surface-variant'">{{ e.icon }}</span>
            <div class="min-w-0 flex-1">
              <p class="text-body-sm text-on-surface truncate"><span class="font-mono text-primary">{{ e.relatedName || '—' }}</span> {{ e.reason || e.message }}</p>
              <p class="text-xs text-on-surface-variant">{{ e.relatedKind || e.type }} · {{ e.namespace || '—' }} · {{ e.age }}</p>
            </div>
          </div>
          <p v-if="!recentEvents.length" class="text-center text-on-surface-variant text-body-sm py-md">暂无事件</p>
        </div>
      </div>

      <!-- 告警面板 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <h3 class="text-body-sm font-semibold mb-sm flex items-center gap-xs"><span class="material-symbols-outlined text-error text-base">crisis_alert</span> 告警</h3>
        <div class="flex flex-col gap-sm">
          <div v-if="highCpuNodes.length">
            <p class="text-xs text-on-surface-variant mb-xs">高 CPU 节点（≥80%）</p>
            <button v-for="n in highCpuNodes" :key="n.name" @click="router.push({ name: 'NodeDetail', params: { name: n.name } })" class="w-full flex items-center justify-between px-sm py-1 bg-error/5 rounded hover:bg-error/10">
              <span class="font-mono text-body-sm text-on-surface">{{ n.name }}</span><span class="text-xs text-error font-medium">{{ n.cpu }}%</span>
            </button>
          </div>
          <div v-if="failedPods">
            <p class="text-xs text-on-surface-variant mb-xs">失败 Pod（{{ failedPods }}）</p>
            <button v-for="p in store.podList.filter(p => p.status === 'Failed').slice(0, 5)" :key="p.namespace + '/' + p.name" @click="router.push({ name: 'PodDetail', params: { namespace: p.namespace, name: p.name } })" class="w-full flex items-center justify-between px-sm py-1 bg-error/5 rounded hover:bg-error/10">
              <span class="font-mono text-body-sm text-on-surface truncate">{{ p.name }}</span><span class="text-xs text-on-surface-variant">{{ p.namespace }}</span>
            </button>
          </div>
          <div v-if="notReadyWorkloads.length">
            <p class="text-xs text-on-surface-variant mb-xs">未就绪工作负载（{{ notReadyWorkloads.length }}）</p>
            <button v-for="w in notReadyWorkloads.slice(0, 5)" :key="w.namespace + '/' + w.name" @click="router.push({ name: 'WorkloadDetail', params: { type: w.type, name: w.name } })" class="w-full flex items-center justify-between px-sm py-1 bg-error/5 rounded hover:bg-error/10">
              <span class="font-mono text-body-sm text-on-surface truncate">{{ w.name }}</span><span class="text-xs text-on-surface-variant">{{ w.type }} · {{ w.replicas }}</span>
            </button>
          </div>
          <p v-if="!highCpuNodes.length && !failedPods && !notReadyWorkloads.length" class="text-center text-tertiary-container text-body-sm py-md flex items-center justify-center gap-xs"><span class="material-symbols-outlined text-base">check_circle</span> 一切正常</p>
        </div>
      </div>
    </div>
```

- [ ] **Step 3: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。（若 `store.workloadList` 项无 `status`/`replicas`/`type`/`name`/`namespace` 字段——它们在 mapWorkload 中存在，确认即可。）

- [ ] **Step 4: 提交**

```bash
git add src/views/MonitoringCenter.vue
git commit -m "feat(monitoring): 监控中心加事件流（集群级 watch）+ 告警面板"
```

---

## Self-Review（计划编写后自检，已修正）

- **Spec coverage**：① 路由 + 侧边栏入口（Task 2）② store refreshMetrics + computeClusterMetrics 抽取（Task 1）③ 页面轮询 + 滚动窗口 MiniChart（Task 3）④ KPI/节点网格/Top Pods（Task 3）⑤ 事件流 + 告警面板（Task 4）⑥ 降级（!remoteMode/!metricsAvailable，Task 3 模板）⑦ 生命周期清理（Task 3 polling + Task 4 eventWatch 的 onUnmounted）——全覆盖。
- **Placeholder scan**：无 TBD/TODO；每步含可执行代码。Task 2 Step 3 给了占位组件降级方案（若 build 因缺文件失败）。
- **Type consistency**：`store.refreshMetrics()`（Task 1 导出）→ 页面 `tick` 调用（Task 3）；`store.cluster.{cpuUsage,memoryUsage,cpuTrend,cpuTrendUp,memoryTrend,memoryTrendUp,metricsAvailable}`（computeClusterMetrics 写）→ KPI 卡读（Task 3）；`store.startEventWatch/stopEventWatch`（既有）→ Task 4 调用；事件字段用 mapEvent 实际产出：`e.type`(小写 normal|warning)/`e.reason`/`e.message`/`e.relatedName`/`e.relatedKind`/`e.icon`/`e.uid`/`e.namespace`/`e.age`（mapEvent 把 involvedObject 展平为 relatedKind/relatedName；无 involvedObject 字段）。warningEvents/recentEvents 过滤用 `e.type === 'warning'`。
- **行为不变性**：Task 1 把 hydrate 的汇总尾段**整体**抽成 computeClusterMetrics 并原地调用（同一段逻辑、同一作用域变量 nodeList/eventList/prevClusterMetrics/cluster），无行为差异；refreshMetrics 是新增独立路径。
- **ProgressBar 用法**：Task 3 用 `<ProgressBar :value="n.cpu || 0" />`，与 Nodes.vue 既有用法一致。
