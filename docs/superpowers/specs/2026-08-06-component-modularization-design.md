# 组件模块化 Plan 1：抽取共用展示组件（Component Modularization）

- **日期**: 2026-08-06
- **状态**: Draft（待用户 review）
- **分支**: `feat/component-modularization`（从最新 `main` 切出）
- **本轮目标**: 抽取纯展示、低风险、高回报的共用组件 + 一个格式化 composable，直击「pod 等共用组件模块化」原诉求；详情页随之自然缩水。

---

## 1. 背景与现状

仓库已有成熟的「展示组件 + composable」模式：`src/components/common/`（35 个，如 `PodCard`/`StatusChip`/`YamlEditor`/`DataTable`/`Modal`）+ `src/composables/`（20 个，如 `usePod`/`usePorts`/`useYaml`）。但一批高频 UI 仍以**内联 markup**散落在多个视图，造成重复 + 让详情页膨胀：

| 重复模式 | 出现处 | 当前形态 |
|---|---|---|
| Label/Annotation 标签 | 13 文件 | `<span v-for="(val,key) in obj.labels" class="px-2 py-1 bg-surface-container rounded text-body-sm border border-outline-variant">` 逐字复制 |
| 事件渲染 | 8 文件 | `v-for event in events` → icon + reason + time + message 各写一遍（`mapEvent` 已统一数据形） |
| 容器列表 | 详情页 | 渲染逻辑重复（抽取逻辑 `usePod.podContainers()` 已存在，只渲染没统一） |
| CPU/mem 格式化 | 4 文件 + store | `cpuToMilli/memToKi/formatCpu/formatMem` 在 `cluster.js`（27/36/50/51），`parseCpu` 又本地复制在 `NsResourceQuotas.vue:88` |

同时存在超大文件：`NsWorkloadDetail.vue`（2178 行）、`NsServiceDetail.vue`（943）、`NsIngressDetail.vue`（620）、`PodDetail.vue`（610）——其体积很大程度来自上述重复段的内联。

---

## 2. 目标（本轮）

- **G1 消除重复**：把 Label/Annotation/Event/Container 的渲染收敛到共享组件，CPU/mem 格式化收敛到 composable。
- **G2 详情页瘦身**：替换后 `NsServiceDetail`/`NsIngressDetail`/`PodDetail` 等的重复段被一行组件调用取代。
- **G3 过程约束**：渐进、逐件逐页、可回退、mock 可验证（全前端展示，无需真机）。

## 3. 非目标（显式延后）

- **`NsWorkloadDetail.vue`（2178 行）拆分** → Plan 2。理由：高风险，且最好等本轮组件**先存在**，拆分子组件时直接复用，风险更低。
- **`YamlEditor` 外壳封装（28 文件）** → Plan 3。需先评估 28 处用法的一致性（各页 save/apply 逻辑差异）。
- **`PodTable` + watch 抽象（7 文件）** → Plan 3。Pod 实时 watch 与 live 集群耦合，不在本轮。
- **后端 `server/index.mjs`（1801 行）单体拆分** → 独立计划，与前端解耦。
- 不改任何业务逻辑、不改数据层（与 data-model 计划解耦）。

---

## 4. 设计：5 个新建件

放在 `src/components/common/`（沿用 `PodCard`/`StatusChip` 约定）+ `src/composables/`。

### 4.1 `LabelChips.vue`（只读展示）
- **props**: `labels: { type: Object, default: () => ({}) }`、`emptyText: { type: String, default: '' }`。
- **行为**: 渲染 `<span v-for="(val,key) in labels" :key="key" class="px-2 py-1 bg-surface-container rounded text-body-sm border border-outline-variant">{{ key }}: {{ val }}</span>`（样式类**逐字保留**）；`labels` 空且 `emptyText` 给定时显示之。
- **不负责编辑**：可编辑标签仍用既存 `TagInput`。`LabelChips` 纯只读。

### 4.2 `AnnotationList.vue`（只读展示）
- **props**: `annotations: { type: Object, default: () => ({}) }`、`emptyText: String`。
- **行为**: 等宽键值列表（`font-mono`，多行 `annotation` 如 `nginx` 配置需保留换行 → 用 `whitespace-pre-wrap`）；与 `LabelChips` 成对用在详情页。

### 4.3 `EventList.vue`（展示 + 一个具名插槽）
- **props**: `events: { type: Array, default: () => [] }`（元素为 `mapEvent` 输出：`{type,reason,message,count,time,icon,color,relatedKind,relatedName,relatedNamespace,_ts}`）、`max: { type: Number, default: 0 }`（>0 时只显示前 max 条）。
- **具名插槽 `#action`**: 作用域 `{ event }`，供页面放"跳转关联资源"的页特定路由（不同页 router 目标不同，故用插槽而非 prop）。
- **行为**: `v-for event in (max? events.slice(0,max) : events)` → 图标圆点(`event.icon`/`event.color`) + `reason` + `time` + `message`，统一既有 PodDetail 的版式。

### 4.4 `ContainerList.vue`（展示）
- **props**: `containers: { type: Array, default: () => [] }`（元素为 `usePod.podContainers()` 输出：`{name,image,pullPolicy,state,ready,restartCount,started,startTime,…}`）。
- **行为**: 统一渲染容器名/镜像/状态(`state`)/重启次数；版式对齐 `NsWorkloadDetail`/`PodDetail` 现有容器段。
- **依赖**: 仅渲染；抽取逻辑仍由页面调 `usePod.podContainers(pod)` 后传入。

### 4.5 `useResourceFormat.js`（composable，纯函数）
- **导出**: `cpuToMilli(q)`、`memToKi(q)`、`formatCpu(milli)`、`formatMem(ki)`、`parseCpu(str)`、`parseMem(str)`、`formatRatio(used,total,fmt)`。
- **来源**: 从 `cluster.js:27/36/50/51` 搬迁（含 `NsResourceQuotas.vue:88` 本地 `parseCpu`）；`cluster.js` 改为 `import { cpuToMilli, memToKi } from '@/composables/useResourceFormat'` 以保持 store 内部行为不变；视图改从 `useResourceFormat` 取 `formatCpu/formatMem/parseCpu/parseMem`。
- **纯函数 → 零依赖运行器单测**（仿 `dumpResourceYaml`）。

---

## 5. 采用策略（逐件、逐页、可回退）

每个件的落地两步：
1. **建件 + 单测**（组件 vitest，composable 零依赖运行器）。
2. **逐页替换内联 markup**：一页一个可回退步骤；替换时**样式类逐字保留**，避免视觉回归；每页 `typecheck` + `build` + mock 渲染验证。

采用范围（典型采用页，非穷尽）：
- `LabelChips`/`AnnotationList`：`WorkloadDetail`、`PodDetail`、`NsServiceDetail`、`NsConfigMapDetail`、`NsSecretDetail`、`NamespaceOverview`、`PVDetail`（只读处）等。
- `EventList`：`PodDetail`、`WorkloadDetail`、`NsServiceDetail`、`NsEvents`、`NodeDetail` 等。
- `ContainerList`：`PodDetail`、`NsWorkloadDetail`（及后续拆分）等。
- `useResourceFormat`：`Nodes`、`NodeDetail`、`NsWorkloadDetail`、`NsResourceQuotas` 等。

> 单个 plan 不强求一次替换全部 13/8 处；按件推进，每件覆盖其主要采用页即可，剩余采用可作为该件的收尾步骤或并入 Plan 2 的 `NsWorkloadDetail` 拆分。

---

## 6. 分阶段（每阶段独立可发版、mock 可验证、可回退）

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| **P0** | `useResourceFormat` composable：搬迁纯函数 + `cluster.js` 改 import + 零依赖单测 + 视图改引用 | 零依赖单测绿；store 行为不变；typecheck/build 绿 |
| **P1** | `LabelChips` + `AnnotationList`：建件 + vitest 单测 + 采用到主要详情页 | vitest 绿；采用页 mock 渲染一致；typecheck/build 绿 |
| **P2** | `EventList`：建件 + 单测（含 `#action` 插槽）+ 采用 | 同上 |
| **P3** | `ContainerList`：建件 + 单测 + 采用 | 同上 |
| **P4** | 全量门禁 `npm test && npm run test:unit && npm run typecheck && npm run build`；确认详情页行数下降 | 全绿 |

> 每阶段：组件 vitest 单测 + composable 零依赖单测 + `typecheck` + `build` + mock 渲染回归。任一阶段可独立 revert。

---

## 7. 测试

- **组件**：vitest + `@vue/test-utils` + happy-dom（mount，断言从 props 正确渲染标签/事件/容器；空对象降级到 `emptyText`；`max` 截断；`#action` 插槽透传 `event`）。
- **`useResourceFormat`**：`scripts/test.mjs` 零依赖运行器（各后缀 CPU/mem 解析、格式化、空值降级、往返）。
- **采用回归**：每页 `npm run typecheck` + `npm run build`（.vue 由 build 覆盖）+ mock 模式逐页点查渲染（视觉一致）。

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 替换内联 markup 时样式类丢失 → 视觉回归 | 样式类**逐字保留**进组件；每采用页 mock 渲染 + build 验证 |
| `useResourceFormat` 动 `cluster.js` 影响 store 行为 | 只搬函数、不改逻辑；`cluster.js` 继续从新模块 import 同一函数；零依赖单测 + 既有 store 单测兜底 |
| `EventList`/`ContainerList` 各页版式略有差异 | 先按主流版式（PodDetail/NsWorkloadDetail）定型；少数差异页用插槽/prop 兼容，不强求一刀切 |
| 采用不全面（留个别内联处） | 可接受：按件覆盖主要采用页；剩余并入 Plan 2 |

---

## 9. 后续（独立计划）

1. **Plan 2**：拆 `NsWorkloadDetail.vue`（2178 行）为子组件（届时直接复用本轮 `EventList`/`ContainerList`/`LabelChips`）。
2. **Plan 3**：`YamlEditor` 外壳封装（28 文件，先评估一致性）+ `PodTable`/watch 抽象（7 文件）。
3. **独立**：后端 `server/index.mjs`（1801 行）按域拆 router 模块。
