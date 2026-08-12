# Cluster Overview 真实化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Cluster Overview 顶部汇总(Total Nodes/Pods/Events、CPU/Mem% 及趋势折线)显示真实集群数据,顺手治好 Settings/Workloads 同源假数据,清掉 `store.cluster` 的 mock 初始值。

**Architecture:** 把"从 Vue Query 缓存派生集群计数"抽成不依赖 vue/pinia 的纯函数 `deriveClusterCounts`(可被自研零依赖测试运行器直接 import 测);`computeClusterMetrics` 接入它(缓存优先,回退 store ref);ClusterOverview 复用 MonitoringCenter 的 session 内滚动采样范式(`refreshMetrics` + `cpuSeries/memSeries` + 现成 `MiniChart`),顶部数字直接读 Vue Query 列表长度,删除写死的 mock SVG 折线和 `24h/7d/30d` 假按钮。

**Tech Stack:** Vue 3 + Pinia + @tanstack/vue-query + Vite(纯 JS);测试 = 自研零依赖运行器 `scripts/test.mjs`(纯逻辑)+ vitest(store/组件);i18n = vue-i18n(zh/en 双语 + `npm run i18n:check` 三合一门禁)。

## Global Constraints

- **不新增外部依赖**(CLAUDE.md 依赖政策)。复用现成 `MiniChart.vue`、`useResourceList`、`refreshMetrics`。
- **纯逻辑测试用自研零依赖运行器** `scripts/test.mjs`(`import { strict as assert } from 'node:assert'`,自定义 `test(name, fn)`,import 纯 `.js` 模块);**不要**把纯逻辑放进 vitest。被测函数必须抽成不 import vue/pinia/@-alias 的独立模块(否则 node 跑不了)。
- **i18n 门禁**:`npm run i18n:check` 须过(残存中文 + zh/en 键对齐 + 引用键缺失三合一)。
- **类型/语法基线**:`npm run typecheck`(`node --check` 全 `.js/.mjs`;`.vue` 由 `npm run build` 覆盖,本计划用 vitest 挂载/手测代替)。
- **测试**:`npm test` = `test:server`(自研运行器 + `node --test server/*.test.mjs`)+ `test:unit`(vitest)。
- **分支**:在 worktree 分支 `worktree-cluster-overview-realtime` 内开发;每 task 末尾 commit。commit 前无需 `git branch --show-current`(已在隔离 worktree)。
- **rendering 坑**:本会话发现工具输出会把某些数字字面量错误回显(如 `30000` 显示成 `4430`)。验证数字时用 `python3 -c "...count(...)"` 这类程序化判断,**勿**肉眼读 grep 回显。

---

## File Structure

- **Create** `src/logic/clusterCounts.js` — 纯函数 `deriveClusterCounts(cache)`,从缓存快照派生 node/pod/event 计数。无 vue/pinia 依赖。
- **Modify** `src/stores/cluster.js` — `cluster` ref 初始值清诚实降级值;`computeClusterMetrics` 接入 `deriveClusterCounts`(queryClient 缓存优先,回退 store ref);顶部加 import。
- **Modify** `src/views/ClusterOverview.vue` — 加 `podsQuery`;趋势采样(`refreshMetrics` + `cpuSeries/memSeries` + `MiniChart`);顶部三卡读 list.length;删 `24h/7d/30d` 假按钮 + 写死 SVG path + `timeRange` ref。
- **Modify** `src/views/Workloads.vue` — `onMounted` 调一次 `store.refreshMetrics()`(让 cpuUsage/podCount 进页即真)。
- **Modify** `src/locales/zh.json` / `en.json` — `cluster` 命名空间新增 `liveWindow`。
- **Modify** `scripts/test.mjs` — 追加 `deriveClusterCounts` 用例。

---

## Task 1: deriveClusterCounts 纯函数 + 单测(TDD)

**Files:**
- Create: `src/logic/clusterCounts.js`
- Test: `scripts/test.mjs`(追加 import + 用例)

**Interfaces:**
- Produces: `deriveClusterCounts(cache: {nodes?:any[], pods?:any[], events?:any[]}) => {nodeCount: number|null, podCount: number|null, activeEvents: number|null}`。数组 → 取长度(空数组 = 0);非数组/缺省 → `null`(未命中,供调用方回退)。

- [ ] **Step 1: 写失败测试**

在 `scripts/test.mjs` 顶部 import 区追加(与其它 `import ... from '../src/...'` 同处):

```js
import { deriveClusterCounts } from '../src/logic/clusterCounts.js'
```

在文件末尾(最后一个 `test(...)` 之后、汇总输出之前)追加:

```js
// --- 集群汇总计数:从 Vue Query 缓存快照派生(computeClusterMetrics 用)---
test('deriveClusterCounts: 数组取长度(含空数组=0)', () => {
  assert.deepEqual(
    deriveClusterCounts({ nodes: [{}, {}], pods: [{}], events: [{}, {}, {}] }),
    { nodeCount: 2, podCount: 1, activeEvents: 3 }
  )
  assert.deepEqual(
    deriveClusterCounts({ nodes: [], pods: [], events: [] }),
    { nodeCount: 0, podCount: 0, activeEvents: 0 }
  )
})

test('deriveClusterCounts: 非数组/缺省 → null(未命中,供调用方回退)', () => {
  assert.deepEqual(deriveClusterCounts(), { nodeCount: null, podCount: null, activeEvents: null })
  assert.deepEqual(
    deriveClusterCounts({ nodes: null, pods: 'oops', events: undefined }),
    { nodeCount: null, podCount: null, activeEvents: null }
  )
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test.mjs`
Expected: 两个新用例 FAIL,错误含 `Cannot find module .../src/logic/clusterCounts.js`。

- [ ] **Step 3: 写最小实现**

Create `src/logic/clusterCounts.js`:

```js
// 集群汇总计数纯函数:从 Vue Query 缓存快照派生 node/pod/event 数量。
// 不依赖 vue/pinia/@-alias,可被 scripts/test.mjs(node 直跑)直接 import 测试。
// 语义:数组 → 命中(取长度,空数组 = 0);非数组/缺省 → null(未命中,供调用方 ?? 回退 store ref)。
export function deriveClusterCounts(cache = {}) {
  const len = v => (Array.isArray(v) ? v.length : null)
  return {
    nodeCount: len(cache.nodes),
    podCount: len(cache.pods),
    activeEvents: len(cache.events),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test.mjs`
Expected: 全部 PASS(含两个新用例)。

- [ ] **Step 5: Commit**

```bash
git add src/logic/clusterCounts.js scripts/test.mjs
git commit -m "feat(cluster): deriveClusterCounts 纯函数 + 单测(从缓存派生集群计数)"
```

---

## Task 2: store.cluster 初始值清理 + computeClusterMetrics 接入

**Files:**
- Modify: `src/stores/cluster.js`(顶部 import 区、`cluster` ref 初始值 `:61-76`、`computeClusterMetrics` `:1089-1120`)

**Interfaces:**
- Consumes: `deriveClusterCounts`(Task 1)。
- Produces: `store.cluster.nodeCount/podCount/activeEvents` 现在由真实 Vue Query 缓存派生(computeClusterMetrics 调用时);初始值为 `0`(不再 mock 8/247/18)。

- [ ] **Step 1: 加 import**

在 `src/stores/cluster.js` 顶部 import 区(其它 `@/composables/...` import 附近)加:

```js
import { deriveClusterCounts } from '@/logic/clusterCounts'
```

- [ ] **Step 2: 清 cluster ref 初始值**

把 `cluster` ref 初始值(`:61-76`)整段替换为:

```js
  const cluster = ref({
    name: '',
    version: 'k8s v1.28.2',
    apiServer: 'https://api.prod-cluster.kubezen.io:6443',
    status: 'Healthy',
    nodeCount: 0,
    podCount: 0,
    activeEvents: 0,
    cpuUsage: null,
    cpuTrend: '—',
    cpuTrendUp: null,
    memoryUsage: null,
    memoryTrend: '—',
    memoryTrendUp: null,
    metricsAvailable: false,
  })
```

> 说明(对 reviewer):`name` 清 `''`(避免未连接时骗显 `Production-Cluster-01`)。`version`/`apiServer`/`status` 按 spec 保留初始值——登录/切集群时 `setConnectedCluster`(`:1043`)/`switchCluster`(`:1022`)会立即用真实值覆盖,且未连接被路由门 `!currentCluster` 拦截,保留风险可接受。数字/trend/metricsAvailable 清成诚实降级值(本 task 核心目的)。

- [ ] **Step 3: computeClusterMetrics 计数改从缓存派生**

在 `computeClusterMetrics`(`:1089`)内,找到末尾的 `cluster.value = { ...cluster.value, nodeCount: nodeList.value.length, podCount: podList.value.length, activeEvents: eventList.value.length, ... }`。在 `cluster.value = {` 之前插入缓存派生:

```js
    const _cid = currentCluster.value || 'cluster'
    const counts = deriveClusterCounts({
      nodes: queryClient.getQueryData(['cluster', _cid, 'nodes']),
      pods: queryClient.getQueryData(['cluster', _cid, 'pods']),
      events: queryClient.getQueryData(['cluster', _cid, 'events']),
    })
```

并把 `cluster.value` 赋值里的三行计数来源改为(其余 cpuUsage/memoryUsage/trend/metricsAvailable 行**不动**):

```js
      nodeCount: counts.nodeCount ?? nodeList.value.length,
      podCount: counts.podCount ?? podList.value.length,
      activeEvents: counts.activeEvents ?? eventList.value.length,
```

> `queryClient` 已在 `:13` import;`currentCluster` 是 store ref(`:111`)。`??` 语义:缓存命中(数组,含空)用缓存值;缓存未命中(`null`)回退 store ref(hydrate 填的 nodeList 真;pods/events ref 在 Vue Query 路线下可能为 0,见 spec §6)。

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: PASS(`cluster.js` 是 `.js`,`node --check` 通过)。

- [ ] **Step 5: 确认 store 测试未回归**

Run: `npm run test:unit -- src/stores/__tests__`
Expected: 现有 store 测试全 PASS(初始值改动不影响 generateYAML/crud 等已测逻辑)。

- [ ] **Step 6: Commit**

```bash
git add src/stores/cluster.js
git commit -m "feat(cluster): store.cluster 初始值清诚实降级 + computeClusterMetrics 从缓存派生计数"
```

---

## Task 3: i18n 新增 cluster.liveWindow

**Files:**
- Modify: `src/locales/zh.json`(`cluster` 命名空间,`:321` 起)
- Modify: `src/locales/en.json`(同键)

**Interfaces:**
- Produces: `cluster.liveWindow`(zh/en),供 Task 4 ClusterOverview 引用。

- [ ] **Step 1: zh.json 加键**

在 `src/locales/zh.json` 的 `"cluster": {` 对象内(任意键之间,如 `metricsUnavailableHint` 之后)加一行:

```json
    "liveWindow": "会话内 · 最近 5min",
```

- [ ] **Step 2: en.json 加键**

在 `src/locales/en.json` 的 `"cluster": {` 对象内同位置加:

```json
    "liveWindow": "Session · last 5min",
```

- [ ] **Step 3: i18n 门禁**

Run: `npm run i18n:check`
Expected: PASS(zh/en 键对齐、无残存中文、无引用缺失)。

> `cluster.timeAgo`/`timeNow` 键**保留不动**(Task 4 会移除 ClusterOverview 对它们的引用,但键保留无害,`i18n:check` 不报"未引用键";移除键属跨视图清理,本计划不做以降风险)。

- [ ] **Step 4: Commit**

```bash
git add src/locales/zh.json src/locales/en.json
git commit -m "i18n(cluster): 新增 liveWindow(会话内趋势窗标签)"
```

---

## Task 4: ClusterOverview.vue 真实化

**Files:**
- Modify: `src/views/ClusterOverview.vue`(`<script setup>` `:1-42`、template 顶部三卡 `:57/:70/:81`、resource usage 卡 header `:100-113`、CPU 图 `:127-134`、Memory 图 `:147-154`)

**Interfaces:**
- Consumes: `store.cluster.cpuUsage/memoryUsage/metricsAvailable`(Task 2 后由 `refreshMetrics` 写真);`store.fetchPods()`;`MiniChart`;`cluster.liveWindow`(Task 3)。
- Produces: ClusterOverview 顶部三卡 = `nodeList.length`/`podList.length`/`eventList.length`;CPU/Mem 折线 = session 内真实滚动采样。

- [ ] **Step 1: 改 `<script setup>` imports 与删 timeRange**

把 `:2` 的 `import { ref, computed } from 'vue'` 改为:

```js
import { ref, computed, onMounted, onUnmounted } from 'vue'
```

在 ProgressBar import 之后(`:5` 后)加:

```js
import MiniChart from '@/components/common/MiniChart.vue'
```

删除 `:10` 的 `const timeRange = ref('24h')`。

- [ ] **Step 2: 加 podsQuery + podList**

在 `nodeList` computed(`:21`)之后加:

```js
const podsQuery = useResourceList({
  key: ['cluster', cid.value, 'pods'],
  fetcher: () => store.fetchPods(),
  options: { refetchInterval: 30000 },
})
const podList = computed(() => podsQuery.data.value || [])
```

- [ ] **Step 3: 加趋势采样(移植 MonitoringCenter.vue:42-61)**

在 `hasPressure` 函数之后(`<script setup>` 末尾、`</script>` 之前)加:

```js
// 趋势采样:每 10s refreshMetrics + 收 cluster CPU/Mem 到 30 点滚动窗口喂 MiniChart(移植自 MonitoringCenter)
const cpuSeries = ref([])
const memSeries = ref([])
const SAMPLE_MAX = 30
let metricsTimer = null
async function tick() {
  try {
    await store.refreshMetrics()
    const cpu = store.cluster.cpuUsage
    const mem = store.cluster.memoryUsage
    if (cpu != null) cpuSeries.value = [...cpuSeries.value, cpu].slice(-SAMPLE_MAX)
    if (mem != null) memSeries.value = [...memSeries.value, mem].slice(-SAMPLE_MAX)
  } catch { /* 静默:保留上次 series */ }
}
onMounted(() => { tick(); metricsTimer = setInterval(tick, 10000) })
onUnmounted(() => { if (metricsTimer) clearInterval(metricsTimer) })
```

- [ ] **Step 4: 顶部三卡数字改读 list.length**

template 中三处替换:
- `:57` `{{ store.cluster.nodeCount }}` → `{{ nodeList.length }}`
- `:70` `{{ store.cluster.podCount }}` → `{{ podList.length }}`
- `:81` `{{ store.cluster.activeEvents }}` → `{{ eventList.length }}`

- [ ] **Step 5: resource usage 卡 header 删假按钮、换 liveWindow**

把 `:100-113` 的 `<div class="flex items-center gap-sm">...24h/7d/30d...</div>` 整段替换为:

```html
            <div class="flex items-center gap-sm">
              <span v-if="!store.cluster.metricsAvailable" class="flex items-center gap-xs text-xs text-tertiary-container bg-tertiary-container/10 px-sm py-xs rounded-full" :title="$t('cluster.metricsUnavailableHint')">
                <span class="material-symbols-outlined text-sm">sensors_off</span> {{ $t('cluster.metricsUnavailable') }}
              </span>
              <span class="text-xs text-on-surface-variant">{{ $t('cluster.liveWindow') }}</span>
            </div>
```

(即删掉原 `<div class="flex gap-xs"><span v-for="range in ['24h','7d','30d']" ...>` 那块,换成单个 `liveWindow` 标签;`metricsUnavailable` 提示保留。)

- [ ] **Step 6: CPU 图换 MiniChart**

把 `:127-134`(外层 `<div class="h-32 ...">` 含写死 `<svg><path>` + 下方 `timeAgo/timeNow` 行)整段替换为:

```html
              <div class="h-32 w-full">
                <MiniChart :series="cpuSeries" color="var(--md-sys-color-primary)" :height="128" />
              </div>
```

- [ ] **Step 7: Memory 图换 MiniChart**

把 `:147-154`(Memory 的外层 `<div class="h-32 ...">` 含写死 `<svg><path>` + `timeAgo/timeNow` 行)整段替换为:

```html
              <div class="h-32 w-full">
                <MiniChart :series="memSeries" color="var(--md-sys-color-primary)" :height="128" />
              </div>
```

- [ ] **Step 8: typecheck + i18n 门禁**

Run: `npm run typecheck && npm run i18n:check`
Expected: PASS。(`.vue` 不在 typecheck 范围,但 `timeAgo/timeNow` 引用已移除、`liveWindow` 引用已有键,i18n:check 过。)

- [ ] **Step 9: 手测挂载(可选,若无集群环境则跳过)**

若有集群环境:`npm run dev` 打开 Cluster Overview,确认:顶部三卡数字 = 真实节点/Pod/事件数;CPU/Mem 折线随时间生长;无 `24h/7d/30d` 按钮。若无环境,依赖 Task 6 的构建验证。

- [ ] **Step 10: Commit**

```bash
git add src/views/ClusterOverview.vue
git commit -m "feat(cluster-overview): 顶部汇总+趋势折线真实化(复用 MiniChart,删假按钮/写死曲线)"
```

---

## Task 5: Workloads.vue onMounted 触发 refreshMetrics

**Files:**
- Modify: `src/views/Workloads.vue`(`<script setup>` `:2` import、`onMounted` 新增)

**Interfaces:**
- Consumes: `store.refreshMetrics()`(已存在)。
- Produces: Workloads 顶部 `cpuUsage`/`podCount`(`:212/:223`)进页即真(Task 2 后 `computeClusterMetrics` 从缓存派生 + `refreshMetrics` 触发)。

- [ ] **Step 1: 扩展 vue import**

把 `src/views/Workloads.vue:2` 的 `import { ref, computed } from 'vue'` 改为:

```js
import { ref, computed, onMounted } from 'vue'
```

- [ ] **Step 2: 加 onMounted 调 refreshMetrics**

在 `<script setup>` 内、`store`/`cid` 定义之后(约 `:25` 之后)加:

```js
// 进页即触发 metrics 拉取 + 集群汇总刷新,让顶部 CPU%/podCount 显示真实值(computeClusterMetrics 从缓存派生)
onMounted(() => { store.refreshMetrics().catch(() => {}) })
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/views/Workloads.vue
git commit -m "feat(workloads): onMounted 触发 refreshMetrics,顶部 CPU%/podCount 真实化"
```

---

## Task 6: 全量验证 + 收尾

**Files:** 无(仅验证)。

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: `test:server`(自研运行器含 `deriveClusterCounts` 用例 + `node --test server/*`)+ `test:unit`(vitest 全绿)。如有失败,定位修复后重跑。

- [ ] **Step 2: typecheck + i18n 门禁**

Run: `npm run typecheck && npm run i18n:check`
Expected: PASS。

- [ ] **Step 3: 构建冒烟(覆盖 .vue 语法)**

Run: `npm run build`
Expected: 构建成功(Vite 编译 `ClusterOverview.vue`/`Workloads.vue`/`cluster.js` 无语法/模板错误)。如失败,修复。

- [ ] **Step 4: 自检——三处假数据均已治好**

用程序化检查(避免回显渲染坑)确认改动落盘:
```bash
W=$(pwd)
python3 -c "
import re
s=open('$W/src/stores/cluster.js').read()
m=re.search(r'const cluster = ref\(\{(.*?)\}\)', s, re.S).group(1)
print('cluster 初始 nodeCount 行:', 'nodeCount: 0' in m and 'OK(清零)' or 'FAIL')
print('cluster 初始 podCount 行 :', 'podCount: 0' in m and 'OK(清零)' or 'FAIL')
co=open('$W/src/views/ClusterOverview.vue').read()
print('ClusterOverview 无 timeRange:', 'timeRange' not in co and 'OK' or 'FAIL(残留)')
print('ClusterOverview 用 MiniChart:', 'MiniChart' in co and 'OK' or 'FAIL')
print('ClusterOverview 无写死 path :', 'M0,80 Q50,70' not in co and 'OK' or 'FAIL(残留)')
"
```
Expected: 全部 OK。

- [ ] **Step 5: 若 Step 1-4 有修复则 commit;否则跳过**

```bash
git status --short   # 确认有无未提交修复
# 若有:git add -A && git commit -m "test(cluster-overview): 全量验证修复"
```

- [ ] **Step 6: 更新 memory(收尾)**

本特性完成后,在 `~/.claude/projects/.../memory/` 新增一条 `project` memory 记录「Cluster Overview 真实化已合 worktree 分支(待合 main)」,要点:store.cluster mock 初始值漏删是根因;deriveClusterCounts 纯函数从 Vue Query 缓存派生计数;折线 session 内采样复用 MiniChart;关联 [[mock-demo-mode-removed]] [[frontend-data-layer-refactor]]。同步更新 MEMORY.md 索引。

---

## Self-Review 记录

- **Spec 覆盖**:§1 初始值清理 → Task 2;§1 computeClusterMetrics 缓存派生 → Task 1+2;§2 ClusterOverview → Task 4;§3 Workloads → Task 5(Settings 零代码,受益于 Task 2);§4 i18n → Task 3;§5 测试 → Task 1(纯函数)+ Task 6(全量);§6 边界 → Task 2 说明 + 风险。全覆盖。
- **占位扫描**:无 TBD/TODO;每 step 含真实代码或命令。
- **类型一致**:`deriveClusterCounts` 签名在 Task 1 定义、Task 2 消费,返回 `{nodeCount,podCount,activeEvents}` 字段名一致;`MiniChart :series` 与 `cpuSeries/memSeries`(number[])匹配。
- **偏离 spec**:`version`/`apiServer`/`status` 按 spec 保留(spec §1);`timeAgo/timeNow` 键保留(降风险,spec §4 允许"实现时确认")——均在对应 task 注明。
