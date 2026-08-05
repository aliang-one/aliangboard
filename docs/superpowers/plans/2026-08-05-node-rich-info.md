# 节点信息丰富化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cluster Overview / 节点列表 / 节点详情三页统一展示更丰富的节点信息（角色与地址、系统与运行时、调度与健康、资源与负载）并美化。

**Architecture:** 新增一个**纯函数模块** `src/composables/useNodeFields.js` 抽取 `mapNode` 未覆盖的字段（可被零依赖测试运行器直接 import、TDD）。`stores/cluster.js` 的 `mapNode` 复用它（真实集群模式），`src/mock/cluster.js` 的预成型节点手工补齐同名字段（演示模式）。`podCount` 由 store 在节点/Pod 加载后统一回填。三个视图组件读取这些字段重渲染。不新增 API、不新增依赖。

**Tech Stack:** Vue 3.5（Composition API，`<script setup>`，纯 JS 无 TS）、Pinia 2.3、Vue Router 4.6、Tailwind 3.4、Vite 8；测试为自研零依赖运行器 `scripts/test.mjs`（`node:assert`）。

## Global Constraints

- **禁止新增外部依赖**：测试运行器零依赖；不得引入 vitest/jest/@vue/test-utils。UI 变更的自动化门禁只有 `npm run typecheck` 与 `npm run build`，行为靠人工校验。
- **mock 节点为预成型（前端形状）**，`mapNode` 产出**相同形状**。所有新增字段必须在 `mapNode`（真实模式）和 `src/mock/cluster.js`（演示模式）**两处同步**，字段名完全一致。
- 复用现有 Material 3 design tokens（`bg-surface-*`/`border-outline-*`/`text-primary`/`text-error` 等）与 Tailwind 间距，**不引入新设计体系**。
- 缺失 metrics 统一降级为 `—`（沿用 NodeDetail 既有模式）。
- 不改动 cordon/uncordon/drain 任何逻辑。
- `formatCpu` / `formatMem` 已从 `@/stores/cluster` 导出，直接复用，不要新建格式化函数。

---

## File Structure

| 文件 | 职责 | 本次改动 |
|---|---|---|
| `src/composables/useNodeFields.js` | **新建**。纯函数：从 K8s Node 对象抽取 `mapNode` 未覆盖的额外字段。无 Vue/Pinia 依赖，可被测试运行器 import。 | 新建 |
| `scripts/test.mjs` | 零依赖测试运行器 | 追加 `useNodeFields` 用例 |
| `src/stores/cluster.js` | Pinia store；`mapNode`、节点/Pod 加载流程 | `mapNode` 合入 `extractNodeExtra`；新增 `recountNodePods` 并在 init + hydrate 调用 |
| `src/mock/cluster.js` | 预成型演示数据 | 每个 mock 节点补齐新字段 + 绝对资源量 |
| `src/views/ClusterOverview.vue` | 集群概览页 | Node Health 卡片重构为「丰富卡片」（2 列） |
| `src/views/Nodes.vue` | 节点列表页 | slot 丰富 + 新增 `system`/`pods` slot |
| `src/composables/useTableColumns.js` | 表格列 catalog | `version`→`system`、新增 `pods` 列 |
| `src/views/NodeDetail.vue` | 节点详情页 | 头部/System Info/Taints 卡片/Pods 指标 |

---

## Task 1: 纯函数抽取模块 `useNodeFields.js`（TDD）

**Files:**
- Create: `src/composables/useNodeFields.js`
- Test: `scripts/test.mjs`（追加用例，import 新模块）

**Interfaces:**
- Produces: `shortenRuntime(raw: string|null) => string|null`；`normalizeTaints(taints: array|undefined) => Array<{key,value,effect}>`；`extractNodeExtra(item: K8sNode) => { externalIp, containerRuntime, containerRuntimeShort, arch, osType, taints, taintCount, podCapacity, podAllocatable, podCIDR }`。Task 2 的 `mapNode` 会展开 `...extractNodeExtra(item)`。

- [ ] **Step 1: 写失败测试** —— 在 `scripts/test.mjs` 顶部 import 区追加，并在文件内（其它 `test(...)` 旁）追加 4 个用例：

```js
// 顶部 import 区追加（与现有 import 同段）：
import { shortenRuntime, normalizeTaints, extractNodeExtra } from '../src/composables/useNodeFields.js'

// 文件内用例区追加：
test('shortenRuntime 去掉容器运行时 scheme 前缀', () => {
  assert.equal(shortenRuntime('containerd://1.6.18'), '1.6.18')
  assert.equal(shortenRuntime('docker://24.0.7'), '24.0.7')
  assert.equal(shortenRuntime('cri-o://1.28.1'), '1.28.1')
  assert.equal(shortenRuntime(null), null)
  assert.equal(shortenRuntime('1.6.18'), '1.6.18') // 无前缀原样返回
})

test('normalizeTaints 归一化为 {key,value,effect}，缺 value 视为空串', () => {
  assert.deepEqual(normalizeTaints(undefined), [])
  assert.deepEqual(normalizeTaints([{ key: 'dedicated', value: 'gpu', effect: 'NoSchedule' }]),
    [{ key: 'dedicated', value: 'gpu', effect: 'NoSchedule' }])
  assert.deepEqual(normalizeTaints([{ key: 'node.kubernetes.io/unreachable', effect: 'NoExecute' }]),
    [{ key: 'node.kubernetes.io/unreachable', value: '', effect: 'NoExecute' }])
})

test('extractNodeExtra 抽取 mapNode 未覆盖字段', () => {
  const item = {
    status: {
      nodeInfo: { containerRuntimeVersion: 'containerd://1.6.18', architecture: 'amd64', operatingSystem: 'linux' },
      addresses: [{ type: 'InternalIP', address: '10.0.1.10' }, { type: 'ExternalIP', address: '1.2.3.4' }],
      capacity: { pods: '110' },
      allocatable: { pods: '110' },
    },
    spec: { podCIDR: '10.42.0.0/24', taints: [{ key: 'k', effect: 'NoSchedule' }] },
  }
  const e = extractNodeExtra(item)
  assert.equal(e.externalIp, '1.2.3.4')
  assert.equal(e.containerRuntime, 'containerd://1.6.18')
  assert.equal(e.containerRuntimeShort, '1.6.18')
  assert.equal(e.arch, 'amd64')
  assert.equal(e.osType, 'linux')
  assert.equal(e.taintCount, 1)
  assert.equal(e.podCapacity, 110)
  assert.equal(e.podAllocatable, 110)
  assert.equal(e.podCIDR, '10.42.0.0/24')
})

test('extractNodeExtra 对空对象全部降级为 null/[]', () => {
  const e = extractNodeExtra({})
  assert.equal(e.externalIp, null)
  assert.equal(e.containerRuntime, null)
  assert.equal(e.containerRuntimeShort, null)
  assert.equal(e.arch, null)
  assert.equal(e.osType, null)
  assert.equal(e.taintCount, 0)
  assert.deepEqual(e.taints, [])
  assert.equal(e.podCapacity, null)
  assert.equal(e.podAllocatable, null)
  assert.equal(e.podCIDR, null)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL，报 `Cannot find module '../src/composables/useNodeFields.js'`（或导出未定义）。

- [ ] **Step 3: 实现模块** —— 创建 `src/composables/useNodeFields.js`：

```js
// 从 K8s Node 对象抽取 mapNode 未覆盖的「丰富节点信息」字段。
// 纯函数、无 Vue/Pinia 依赖，故可被零依赖测试运行器 scripts/test.mjs 直接 import；
// stores/cluster.js 的 mapNode 会展开 ...extractNodeExtra(item) 复用同一份逻辑。

// 容器运行时短名：去掉 'containerd://' / 'docker://' / 'cri-o://' 等 scheme 前缀
export function shortenRuntime(raw) {
  if (raw == null) return null
  const s = String(raw)
  const i = s.indexOf('://')
  return i >= 0 ? s.slice(i + 3) : s
}

// 归一化 taints 为 {key,value,effect}；缺 value 视为空串
export function normalizeTaints(taints) {
  if (!Array.isArray(taints)) return []
  return taints.map(t => ({ key: t.key ?? '', value: t.value ?? '', effect: t.effect ?? '' }))
}

const toInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null }

// 抽取 mapNode 未覆盖的额外字段；任何缺失字段降级为 null / []，由视图自行降级展示
export function extractNodeExtra(item) {
  const info = item?.status?.nodeInfo || {}
  const addresses = item?.status?.addresses || []
  const findAddr = type => addresses.find(a => a?.type === type)?.address || null
  const taints = normalizeTaints(item?.spec?.taints)
  return {
    externalIp: findAddr('ExternalIP'),
    containerRuntime: info.containerRuntimeVersion || null,
    containerRuntimeShort: shortenRuntime(info.containerRuntimeVersion),
    arch: info.architecture || null,
    osType: info.operatingSystem || null,
    taints,
    taintCount: taints.length,
    podCapacity: toInt(item?.status?.capacity?.pods),
    podAllocatable: toInt(item?.status?.allocatable?.pods),
    podCIDR: item?.spec?.podCIDR || null,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（新增 4 个用例全绿，原有用例不受影响）。

- [ ] **Step 5: 提交**

```bash
git add src/composables/useNodeFields.js scripts/test.mjs
git commit -m "feat(node): 抽取节点丰富信息为纯函数 useNodeFields（含测试）"
```

---

## Task 2: store 接入 —— `mapNode` 合入新字段 + `podCount` 回填

**Files:**
- Modify: `src/stores/cluster.js`

**Interfaces:**
- Consumes: Task 1 的 `extractNodeExtra`（`import { extractNodeExtra } from '@/composables/useNodeFields'`）。
- Produces: 每个节点对象额外带上 `externalIp/containerRuntime/containerRuntimeShort/arch/osType/taints/taintCount/podCapacity/podAllocatable/podCIDR/podCount`。Task 3–6 的视图直接读这些字段。

- [ ] **Step 1: 在 `mapNode` 返回值合入 `extractNodeExtra`**

定位 `mapNode`（约 `src/stores/cluster.js:1468`）。在文件顶部 import 区（已有 `@/mock/cluster` 等 import 处）追加：

```js
import { extractNodeExtra } from '@/composables/useNodeFields'
```

把 `mapNode` 的 `return { ... }` 改为在末尾展开额外字段（保留现有全部字段不变）：

```js
    return {
      name: item.metadata?.name,
      status: ready?.status === 'True' ? 'Ready' : 'NotReady',
      roles: Object.keys(item.metadata?.labels || {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]).join(',') || 'worker',
      version: item.status?.nodeInfo?.kubeletVersion || '—',
      os: item.status?.nodeInfo?.osImage || '—',
      kernel: item.status?.nodeInfo?.kernelVersion || '—',
      ip: item.status?.addresses?.find(a => a.type === 'InternalIP')?.address || '—',
      age: ageOf(item.metadata?.creationTimestamp),
      unschedulable: Boolean(item.spec?.unschedulable),
      conditions: Object.fromEntries((item.status?.conditions || []).map(c => [c.type, c.status === 'True'])),
      cpu: pct(usedCpu, allocCpu),
      memory: pct(usedMem, allocMem),
      usedCpu, usedMem, allocCpu, allocMem,
      ...extractNodeExtra(item),
    }
```

- [ ] **Step 2: 新增 `recountNodePods` 并在 mock init + hydrate 调用**

在 `mapNode` 附近新增纯逻辑函数（操作 store 内已有的 `nodeList` / `podList`）：

```js
// 按 pod.node 统计每个节点上的 Pod 数，回填到 nodeList（mock 种子与真实水合后都调用）
function recountNodePods() {
  const counts = {}
  for (const p of podList.value) {
    const n = p.node
    if (n) counts[n] = (counts[n] || 0) + 1
  }
  nodeList.value = nodeList.value.map(n => ({ ...n, podCount: counts[n.name] || 0 }))
}
```

调用点：
1. **mock init**：在 store setup 函数末尾（所有 `ref(...)` 初始化之后、`return` 之前）调用一次 `recountNodePods()`，让演示模式节点带 `podCount`。
2. **真实水合**：在 `hydrateCoreResources` 里 `nodeList.value = nodeData.items.map(...)`（约 `src/stores/cluster.js:2010`）所在的赋值段之后、函数返回前，调用 `recountNodePods()`（此时 `podList` 也已水合）。

> 实现者注意：确认 `mapPod` 产出的 pod 对象带 `node` 字段（现状 NodeDetail 用 `p.node` 过滤，已验证存在）。若水合流程中 pods 与 nodes 在不同 `await` 段赋值，把 `recountNodePods()` 放在两者都赋值完成之后。

- [ ] **Step 3: 校验**

Run: `npm run typecheck`
Expected: 通过（无类型/引用错误）。
Run: `npm test`
Expected: PASS（Task 1 用例仍绿）。

> 行为验证（podCount 正确、新字段出现在节点上）依赖 Task 3 mock + Task 4–6 视图，在后续任务的人工校验中确认。

- [ ] **Step 4: 提交**

```bash
git add src/stores/cluster.js
git commit -m "feat(node): mapNode 合入丰富字段 + podCount 回填"
```

---

## Task 3: 演示数据补齐（`src/mock/cluster.js`）

**Files:**
- Modify: `src/mock/cluster.js`（`export const nodes = [...]`，约第 37–45 行）

**Interfaces:**
- Consumes: 无（手工数据）。字段名必须与 Task 1/2 产出**完全一致**。
- Produces: 演示模式下每个节点带齐全的新字段，供 Task 4–6 视图渲染。

- [ ] **Step 1: 给 8 个 mock 节点补字段**

对 `nodes` 数组里**每个**节点对象追加下列字段（保留现有字段不动；`pods` 旧字段可留可删，`podCount` 由 store recount 覆盖，不读它）。按节点填入：

| 节点 | arch | externalIp | containerRuntime | taints | podCIDR | podCapacity | allocCpu(m) | allocMem(Ki) | usedCpu(m) | usedMem(Ki) |
|---|---|---|---|---|---|---|---|---|---|---|
| master-node-01 | amd64 | 203.0.113.10 | containerd://1.7.0 | `[{key:'node-role.kubernetes.io/control-plane',effect:'NoSchedule'}]` | 10.42.0.0/24 | 110 | 4000 | 16777216 | 720 | 5368709 |
| worker-node-01 | amd64 | 203.0.113.11 | containerd://1.6.18 | `[]` | 10.42.1.0/24 | 110 | 8000 | 33554432 | 3600 | 19461571 |
| worker-node-02 | amd64 | null | containerd://1.6.18 | `[]` | 10.42.2.0/24 | 110 | 8000 | 33554432 | 4960 | 23823647 |
| worker-node-03 | arm64 | null | containerd://1.6.18 | `[]` | 10.42.3.0/24 | 110 | 8000 | 33554432 | 3040 | 15099494 |
| worker-node-04 | amd64 | null | containerd://1.6.18 | `[]` | 10.42.4.0/24 | 110 | 8000 | 33554432 | 6240 | 27514635 |
| worker-node-05 | amd64 | null | containerd://1.6.18 | `[]` | 10.42.5.0/24 | 110 | 8000 | 33554432 | 4080 | 21139292 |
| worker-node-06 | arm64 | null | containerd://1.6.18 | `[{key:'node.kubernetes.io/unreachable',effect:'NoExecute'}]` | 10.42.6.0/24 | 110 | 8000 | 33554432 | null | null |

> **worker-node-06 额外改动**：把既有 `cpu: 0, memory: 0` 改为 `cpu: null, memory: null`（NotReady 节点现实中无 metrics）。这样三页的 CPU/内存都会走 `—` 降级分支，验证「指标不可用」路径。
| gpu-node-01 | amd64 | null | containerd://1.6.18 | `[{key:'nvidia.com/gpu',value:'present',effect:'NoSchedule'}]` | 10.42.7.0/24 | 110 | 16000 | 67108864 | 5440 | 34896609 |

每个节点同时追加（同值，省得每行重复）：`containerRuntimeShort`（去掉 `://` 前缀，如 `1.6.18` / `1.7.0`）、`osType: 'linux'`、`taintCount`（= 该节点 taints 数组长度）、`podAllocatable: 110`。

> 说明：`usedCpu/usedMem` 与现有 `cpu/memory` 百分比一致（used = round(pct% × alloc)）；worker-node-06 是 NotReady，`usedCpu/usedMem` 设为 `null`，演示「指标不可用降级 —」。arch 混入两个 arm64（worker-03、worker-06）。

例如 master-node-01 改后：
```js
{ name: 'master-node-01', status: 'Ready', roles: 'master', version: 'v1.28.2', cpu: 18, memory: 32, os: 'Ubuntu 22.04', kernel: '5.15.0', ip: '10.0.1.10', age: '245d',
  conditions: { Ready: true, DiskPressure: false, MemoryPressure: false, PIDPressure: false, NetworkUnavailable: false },
  externalIp: '203.0.113.10', containerRuntime: 'containerd://1.7.0', containerRuntimeShort: '1.7.0', arch: 'amd64', osType: 'linux',
  taints: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }], taintCount: 1,
  podCIDR: '10.42.0.0/24', podCapacity: 110, podAllocatable: 110,
  usedCpu: 720, allocCpu: 4000, usedMem: 5368709, allocMem: 16777216 },
```

- [ ] **Step 2: 校验**

Run: `npm run typecheck` && `npm run build`
Expected: 通过。
Run: `npm run dev`，打开 `/cluster`，确认概览卡片**仍能渲染**（此任务尚未改视图，但节点对象多了字段不应报错；卡片此时还是旧样式）。

- [ ] **Step 3: 提交**

```bash
git add src/mock/cluster.js
git commit -m "feat(node): mock 节点补齐全丰富字段与绝对资源量"
```

---

## Task 4: Cluster Overview 节点区重构为「丰富卡片」（`src/views/ClusterOverview.vue`）

**Files:**
- Modify: `src/views/ClusterOverview.vue`（`<script setup>` import 区 + Node Health 网格约第 126–161 行）

**Interfaces:**
- Consumes: 节点的 `roles/status/ip/externalIp/os/arch/version/containerRuntimeShort/cpu/memory/usedCpu/allocCpu/usedMem/allocMem/podCount/unschedulable/conditions/taintCount`；`formatCpu`/`formatMem`。

- [ ] **Step 1: import `formatCpu`/`formatMem`**

`<script setup>` 顶部现有 `import { useClusterStore } from '@/stores/cluster'`，改为：

```js
import { useClusterStore, formatCpu, formatMem } from '@/stores/cluster'
```

- [ ] **Step 2: 替换 Node Health 网格（含列数 3→2）**

把模板里 `<!-- Node Health Grid -->` 整段（`<div class="flex flex-col gap-sm">` ... 到对应闭合 `</div>`，约第 126–161 行）替换为：

```vue
        <!-- Node Health Grid -->
        <div class="flex flex-col gap-sm">
          <div class="flex justify-between items-center px-md">
            <span class="text-body-sm font-semibold">Node Health</span>
            <router-link to="/nodes" class="text-primary font-semibold flex items-center gap-xs text-body-sm">
              View all nodes <span class="material-symbols-outlined text-md">arrow_forward</span>
            </router-link>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-sm">
            <router-link
              v-for="node in store.nodeList.slice(0, 6)"
              :key="node.name"
              :to="`/nodes/${node.name}`"
              class="bg-surface-container-lowest p-md rounded-xl border border-outline-variant hover:border-primary hover:shadow-card-hover transition-all group"
            >
              <!-- 头部：角色徽标 + 状态点 -->
              <div class="flex justify-between items-center mb-xs">
                <span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant capitalize">{{ node.roles }}</span>
                <span class="w-2 h-2 rounded-full animate-pulse-status" :class="node.status === 'Ready' ? 'bg-primary-container' : 'bg-error'"></span>
              </div>
              <h4 class="text-body-lg font-bold truncate">{{ node.name }}</h4>
              <!-- IP · OS · 架构 -->
              <div class="flex items-center gap-xs mt-xs text-xs">
                <span class="font-mono text-primary">{{ node.ip }}</span>
                <span v-if="node.externalIp" class="font-mono text-on-surface-variant/70">· {{ node.externalIp }}</span>
              </div>
              <p class="text-xs text-on-surface-variant mt-xs">{{ node.os }}<span v-if="node.arch"> · {{ node.arch }}</span></p>
              <p class="font-mono text-code-sm text-on-surface-variant/80 mt-xs">kubelet {{ node.version }}<span v-if="node.containerRuntimeShort"> · {{ node.containerRuntimeShort }}</span></p>
              <!-- 资源 -->
              <div class="flex flex-col gap-xs mt-md">
                <div>
                  <div class="flex justify-between text-xs mb-1">
                    <span class="text-on-surface-variant">CPU</span>
                    <span class="font-mono text-on-surface-variant">{{ node.cpu != null ? (node.usedCpu != null ? formatCpu(node.usedCpu) + '/' + formatCpu(node.allocCpu) : node.cpu + '%') : '—' }}</span>
                  </div>
                  <ProgressBar v-if="node.cpu != null" :value="node.cpu" />
                  <div v-else class="h-1.5 bg-surface-container-high rounded-full"></div>
                </div>
                <div>
                  <div class="flex justify-between text-xs mb-1">
                    <span class="text-on-surface-variant">Memory</span>
                    <span class="font-mono text-on-surface-variant">{{ node.memory != null ? (node.usedMem != null ? formatMem(node.usedMem) + '/' + formatMem(node.allocMem) : node.memory + '%') : '—' }}</span>
                  </div>
                  <ProgressBar v-if="node.memory != null" :value="node.memory" />
                  <div v-else class="h-1.5 bg-surface-container-high rounded-full"></div>
                </div>
              </div>
              <!-- 底部：Pod 数 · 调度状态 -->
              <div class="mt-md flex items-center justify-between text-xs">
                <span class="text-on-surface-variant flex items-center gap-xs"><span class="material-symbols-outlined text-sm">view_in_ar</span>{{ node.podCount ?? 0 }} pods</span>
                <span class="font-medium flex items-center gap-xs" :class="node.unschedulable ? 'text-tertiary-container' : 'text-primary'">
                  <span class="material-symbols-outlined text-sm">{{ node.unschedulable ? 'lock' : 'check_circle' }}</span>{{ node.unschedulable ? 'Cordoned' : 'Schedulable' }}
                </span>
              </div>
              <!-- 芯片：状态 + 压力条件 + 污点 -->
              <div class="mt-sm flex flex-wrap gap-xs">
                <StatusChip :status="node.status === 'Ready' ? 'Ready' : 'NotReady'" size="sm" />
                <span v-if="node.conditions?.DiskPressure" class="px-1.5 py-0.5 bg-error-container/30 text-error text-xs rounded">DiskPressure</span>
                <span v-if="node.conditions?.MemoryPressure" class="px-1.5 py-0.5 bg-error-container/30 text-error text-xs rounded">MemoryPressure</span>
                <span v-if="node.conditions?.PIDPressure" class="px-1.5 py-0.5 bg-error-container/30 text-error text-xs rounded">PIDPressure</span>
                <span v-if="node.taintCount" class="px-1.5 py-0.5 bg-tertiary-container/20 text-tertiary-container text-xs rounded">{{ node.taintCount }} taint{{ node.taintCount > 1 ? 's' : '' }}</span>
              </div>
            </router-link>
          </div>
        </div>
```

- [ ] **Step 3: 人工校验**

Run: `npm run dev`，打开 `/cluster`：
- 网格变 2 列；每张卡片显示角色徽标、状态点、名称、内网 IP（+外网 IP 若有）、OS·架构、kubelet·runtime、CPU/内存条带**绝对用量**与百分比、Pod 数、Schedulable/Cordoned、底部芯片（Ready + 压力警告 + taints）。
- worker-node-06（NotReady）的 CPU/内存显示 `—`（因 usedCpu/usedMem 为 null），状态点红，带 `unreachable` taint 芯片。
- gpu-node-01 带 `nvidia.com/gpu` taint 芯片；master 带 `control-plane` taint。

- [ ] **Step 4: 提交**

```bash
git add src/views/ClusterOverview.vue
git commit -m "feat(node): Cluster Overview 节点卡片重构为丰富信息卡（2 列）"
```

---

## Task 5: 节点列表列丰富（`Nodes.vue` + `useTableColumns.js`）

**Files:**
- Modify: `src/composables/useTableColumns.js`（`nodes` catalog，约第 13–25 行）
- Modify: `src/views/Nodes.vue`（slot 模板）

**Interfaces:**
- Consumes: 节点的 `roles/ip/externalIp/status/conditions/taintCount/os/version/containerRuntimeShort/arch/cpu/usedCpu/allocCpu/memory/usedMem/allocMem/podCount/podCapacity`。

- [ ] **Step 1: catalog 改列** —— `useTableColumns.js` 里 `key: 'nodes'` 的 `columns` 改为（`version`→`system`、`actions` 前插入 `pods`）：

```js
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'status', label: 'Status' },
      { key: 'roles', label: 'Role' },
      { key: 'system', label: 'System' },
      { key: 'cpu', label: 'CPU' },
      { key: 'memory', label: 'Memory' },
      { key: 'pods', label: 'Pods' },
      { key: 'age', label: 'Age' },
      { key: 'actions', label: 'Actions', align: 'right' },
    ],
```

> 说明：localStorage 里若用户曾隐藏旧 `version` 列，重命名为 `system` 后视为新列（缺省显示），可接受。

- [ ] **Step 2: `Nodes.vue` 丰富 slot** —— 把现有 `#name`/`#status`/`#cpu`/`#memory`/`#version` slot 替换/重命名如下，并新增 `#system`、`#pods`：

```vue
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <div class="w-8 h-8 rounded bg-surface-container flex items-center justify-center text-on-surface-variant">
            <span class="material-symbols-outlined">dns</span>
          </div>
          <div>
            <span class="font-semibold text-on-surface text-body-md block">{{ row.name }}</span>
            <span class="font-mono text-code-sm text-on-surface-variant">{{ row.ip }}<span v-if="row.externalIp" class="text-on-surface-variant/60"> · {{ row.externalIp }}</span></span>
          </div>
        </div>
      </template>
      <template #status="{ row }">
        <div class="flex flex-col gap-xs">
          <StatusChip :status="row.status === 'Ready' ? 'Ready' : 'NotReady'" />
          <div class="flex gap-xs">
            <span v-if="row.conditions?.DiskPressure" class="px-1 py-0.5 bg-error-container/30 text-error text-xs rounded" title="DiskPressure">Disk</span>
            <span v-if="row.conditions?.MemoryPressure" class="px-1 py-0.5 bg-error-container/30 text-error text-xs rounded" title="MemoryPressure">Mem</span>
            <span v-if="row.conditions?.PIDPressure" class="px-1 py-0.5 bg-error-container/30 text-error text-xs rounded" title="PIDPressure">PID</span>
            <span v-if="row.taintCount" class="px-1 py-0.5 bg-tertiary-container/20 text-tertiary-container text-xs rounded" title="Taints">{{ row.taintCount }} taint{{ row.taintCount > 1 ? 's' : '' }}</span>
          </div>
        </div>
      </template>
      <template #roles="{ row }">
        <span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant capitalize">{{ row.roles }}</span>
      </template>
      <template #system="{ row }">
        <div class="flex flex-col">
          <span class="text-body-sm text-on-surface truncate max-w-[14rem]">{{ row.os }}</span>
          <span class="font-mono text-code-sm text-on-surface-variant">{{ row.version }}<span v-if="row.containerRuntimeShort"> · {{ row.containerRuntimeShort }}</span><span v-if="row.arch"> · {{ row.arch }}</span></span>
        </div>
      </template>
      <template #cpu="{ row }">
        <div class="w-28">
          <ProgressBar v-if="row.cpu != null" :value="row.cpu" :show-label="true" />
          <span v-else class="text-on-surface-variant">—</span>
          <p v-if="row.usedCpu != null" class="font-mono text-xs text-on-surface-variant/70 -mt-1">{{ formatCpu(row.usedCpu) }}/{{ formatCpu(row.allocCpu) }}</p>
        </div>
      </template>
      <template #memory="{ row }">
        <div class="w-28">
          <ProgressBar v-if="row.memory != null" :value="row.memory" :show-label="true" />
          <span v-else class="text-on-surface-variant">—</span>
          <p v-if="row.usedMem != null" class="font-mono text-xs text-on-surface-variant/70 -mt-1">{{ formatMem(row.usedMem) }}/{{ formatMem(row.allocMem) }}</p>
        </div>
      </template>
      <template #pods="{ row }">
        <span class="text-body-sm font-medium text-on-surface">{{ row.podCount ?? 0 }}<span v-if="row.podCapacity" class="text-on-surface-variant/60"> / {{ row.podCapacity }}</span></span>
      </template>
```

`#version` slot 整段删除（列已改名为 `system`）。`#actions` 不变。

- [ ] **Step 3: `Nodes.vue` import `formatCpu`/`formatMem`**

`<script setup>` 顶部 `import { useClusterStore } from '@/stores/cluster'` 改为：

```js
import { useClusterStore, formatCpu, formatMem } from '@/stores/cluster'
```

- [ ] **Step 4: 人工校验**

Run: `npm run dev`，打开 `/nodes`：
- 列：Name(IP+外网IP) / Status(芯片+压力+taint 小芯片) / Role / System(OS + kubelet·runtime·arch) / CPU(条+绝对量) / Memory(条+绝对量) / Pods(count/capacity) / Age / Actions。
- worker-node-06 的 CPU/Memory 显示 `—`（无绝对量）。
- 进 Settings 页可勾选隐藏新列（catalog 联动）。

- [ ] **Step 5: 提交**

```bash
git add src/views/Nodes.vue src/composables/useTableColumns.js
git commit -m "feat(node): 节点列表丰富列（system/pods + 绝对资源量 + 压力/污点芯片）"
```

---

## Task 6: 节点详情丰富（`src/views/NodeDetail.vue`）

**Files:**
- Modify: `src/views/NodeDetail.vue`（头部 + System Info 面板 + Resource Usage 卡 + 新增 Taints 卡）

**Interfaces:**
- Consumes: 节点的 `roles/arch/containerRuntimeShort/externalIp/osType/podCIDR/podCount/podCapacity/taints/taintCount`（`formatCpu`/`formatMem` 已 import）。

- [ ] **Step 1: 头部补角色/架构/运行时** —— 头部既有 `{{ node.os }} · {{ node.kernel }}` 行（约第 78 行）改为：

```vue
              <span class="text-xs text-on-surface-variant">{{ node.os }} · {{ node.kernel }}</span>
              <span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant capitalize">{{ node.roles }}</span>
              <span v-if="node.arch" class="text-xs text-on-surface-variant">{{ node.arch }}</span>
              <span v-if="node.containerRuntimeShort" class="font-mono text-xs text-on-surface-variant">{{ node.containerRuntimeShort }}</span>
```

（保留其后的 CORDONED 徽标不变。）

- [ ] **Step 2: System Info 面板补行** —— 在 System Info 面板的 `<div class="px-md py-sm space-y-sm">` 内，现有行之间插入新行（最终顺序：OS / Kernel / Kubelet / **Container Runtime** / **Architecture** / **OS Type** / Role / Internal IP / **External IP** / **Pod CIDR** / Age / Pods / Schedulable）：

```vue
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Container Runtime</span><span class="font-mono text-xs">{{ node.containerRuntimeShort || node.containerRuntime || '—' }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Architecture</span><span class="text-body-sm font-medium">{{ node.arch || '—' }}</span></div>
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">OS Type</span><span class="text-body-sm font-medium capitalize">{{ node.osType || '—' }}</span></div>
```

在 Internal IP 行之后插入：

```vue
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">External IP</span><span class="font-mono text-xs text-primary">{{ node.externalIp || '—' }}</span></div>
```

在 Age 行之前（或之后）插入：

```vue
            <div class="flex justify-between"><span class="text-xs text-on-surface-variant">Pod CIDR</span><span class="font-mono text-xs">{{ node.podCIDR || '—' }}</span></div>
```

- [ ] **Step 3: Resource Usage 卡补 Pods 指标** —— 该卡现有 `grid-cols-2`（CPU/内存），改为 `grid-cols-3` 并追加第三个指标块（放在内存块之后）：

```vue
          <div v-if="node.cpu != null || node.memory != null" class="grid grid-cols-3 gap-md p-md">
            <!-- ...既有 CPU、Memory 两块不动... -->
            <div>
              <ProgressBar :value="node.podCapacity ? Math.min(100, Math.round(((node.podCount ?? 0) / node.podCapacity) * 100)) : 0" size="lg" show-label label="Pods" />
              <p class="font-mono text-xs text-on-surface-variant mt-1">{{ node.podCapacity ? Math.min(100, Math.round(((node.podCount ?? 0) / node.podCapacity) * 100)) + '% used' : '—' }}</p>
              <p class="font-mono text-xs text-on-surface-variant/70 -mt-1">{{ node.podCount ?? 0 }} / {{ node.podCapacity ?? '—' }}</p>
            </div>
          </div>
```

- [ ] **Step 4: 新增 Taints 卡片** —— System Info 卡片所在的右栏（`lg:col-span-4`）是 `flex flex-col gap-sm`，在 System Info 卡片之后追加：

```vue
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">block</span>
            <span class="text-body-sm font-semibold">Taints</span>
            <span class="text-xs text-on-surface-variant ml-auto">{{ node.taintCount ?? 0 }}</span>
          </div>
          <div v-if="node.taints && node.taints.length" class="px-md py-sm space-y-sm">
            <div v-for="(t, i) in node.taints" :key="i" class="flex justify-between gap-md">
              <span class="font-mono text-xs text-on-surface truncate">{{ t.key }}{{ t.value ? '=' + t.value : '' }}</span>
              <span class="px-1.5 py-0.5 bg-tertiary-container/20 text-tertiary-container text-xs rounded whitespace-nowrap">{{ t.effect }}</span>
            </div>
          </div>
          <div v-else class="px-md py-sm text-xs text-on-surface-variant flex items-center gap-xs">
            <span class="material-symbols-outlined text-base">check_circle</span> No taints
          </div>
        </div>
```

- [ ] **Step 5: 人工校验**

Run: `npm run dev`，逐个进节点详情页：
- 头部带角色/架构/运行时；System Info 多了 Container Runtime / Architecture / OS Type / External IP / Pod CIDR 行。
- Resource Usage 三列（CPU/Memory/Pods），Pods 显示 `count/capacity` 与百分比。
- 右栏多 Taints 卡：master/gpu/worker-06 列出对应污点，其它显示 "No taints"。
- worker-node-06（NotReady）的 Resource Usage 仍走「指标不可用」降级分支（cpu/mem 均 null）。

- [ ] **Step 6: 提交**

```bash
git add src/views/NodeDetail.vue
git commit -m "feat(node): 节点详情补系统信息/Taints 卡/Pods 指标"
```

---

## Task 7: 全量回归与收尾

**Files:** 无（仅校验）。

- [ ] **Step 1: 自动化门禁**

Run: `npm test` → 全绿（含 Task 1 新用例）。
Run: `npm run typecheck` → 通过。
Run: `npm run build` → 构建成功。

- [ ] **Step 2: 人工全链路走查（演示模式）**

Run: `npm run dev`：
- `/cluster`：6 张丰富卡片 2 列，worker-06 降级 `—`，taint/压力芯片正确。
- `/nodes`：9 列齐全，绝对资源量、Pods、压力/taint 小芯片正确；Settings 可隐藏新列。
- `/nodes/master-node-01`：头部/System Info/Taints/Pods 指标齐全。
- `/nodes/worker-node-06`：NotReady 降级正确，Taints 卡显示 `unreachable:NoExecute`。

- [ ] **Step 3: cordon/drain 回归**

在 `/nodes` 或详情页对某节点执行 cordon → 卡片/行的 Schedulable 变 Cordoned；uncordon 还原。（逻辑未改，仅确认未坏。）drain 弹窗仍显示受影响 Pod 数（用 `podCount`/nodePods 一致）。

- [ ] **Step 4: 收尾提交（如有零散改动）**

```bash
git add -A
git commit -m "chore(node): 丰富信息收尾"
```

---

## Self-Review 结论

- **Spec 覆盖**：四类信息（角色与地址 / 系统与运行时 / 调度与健康 / 资源与负载）在三页均有对应任务——Overview(Task4)、列表(Task5)、详情(Task6)；数据层(Task1+2)、mock(Task3) 支撑。`podCIDR` 已在 Task1 的 `extractNodeExtra` 与 Task3 mock 覆盖。无遗漏。
- **占位符**：无 TBD/TODO；UI 步骤均给了完整代码块；mock 给了完整字段表。
- **类型/命名一致性**：字段名（`externalIp/containerRuntime/containerRuntimeShort/arch/osType/taints/taintCount/podCapacity/podAllocatable/podCIDR/podCount/usedCpu/allocCpu/usedMem/allocMem`）在 Task1 产出、Task2 合入、Task3 mock、Task4–6 视图消费处完全一致。catalog 列键 `system`/`pods` 与 `Nodes.vue` slot 名一致。
