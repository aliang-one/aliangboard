# 数据模型简化与单一数据源（Data-Model Simplification）

- **日期**: 2026-08-06
- **状态**: Draft（待用户 review）
- **分支**: `feat/modular-data-model`（从最新 `main` 切出）
- **本轮重点**: 数据模型优先（直击「一个资源网页请求多个接口、拖慢渲染」）。组件模块化（pod 等）作为**独立后续计划**，本 spec 仅记录、不实现。

---

## 1. 背景与现状

前一轮「Vue Query 数据层重构」已**全部合入 `main`**：精简的 74 行 `src/composables/useK8sQuery.js`（`useResourceList` / `useResourceDetail` / `useWatchMerger`）、canonical 集群级 query key `['cluster', cid, <R>, name?]` + namespace `select()` 派生、约 **60% 列表/详情页已迁移**。基础良好。

但用户的 4 个目标（全局/局部分离 · 不加载他页数据 · 模块化 · 不重复请求）目前**只部分达成**。三个根因（均带证据）：

1. **首屏批量拉取（`src/stores/cluster.js:2281` `hydrateCoreResources`）**：每次进应用（`src/components/layout/AppLayout.vue:27`）并行拉 **12 类资源**（nodes / pods / deployments / statefulsets / daemonsets / replicasets / services / ingresses / events / node-metrics / pod-metrics + 扩展资源），**不论用户在哪个页**。`src/router/index.js:530` 已留注释「要改成各页按需加载」——正是本 spec 要做的。
2. **双数据源**：`cluster.js` 是 **3586 行的 god store**，管 27 类资源。同一对象同时存在 **Pinia store 列表** 与 **Vue Query 缓存**，编辑后两边短暂不一致，mutation 必须 `invalidateResource()` 兜两边。
3. **约 40% 页面仍直读 store + 详情页双取**：`PodDetail` / `WorkloadDetail` / `NsPods` / `NsWorkloads` / `Workloads` / `NsServiceDetail` / `NodeDetail` / `NamespaceDetail` / `MonitoringCenter` / `CrdDetail` / `CrdList` / RBAC 视图 / `NamespaceOverview` / `Namespaces` / `NsEvents` / `ClusterOverview` 仍读 store；详情页还存在 `useResourceDetail` + 裸 `api.k8s(...)` 双取（如 Service 详情拉 YAML）。

**关键事实（驱动「关键路径」决策）**：`TopNavBar.vue` 的**全局搜索**扫描 `podList / workloadList / serviceList / ingressList / configMapList / secretList / pvcList / nodeList / namespaceList`——这是 hydrate 要拉这么多资源的**真正原因**。而真正「常驻可见、首屏必需」的只有 `namespaceList`（命名空间选择器，TopNavBar + SideNavBar）与 `nodeList`（顶栏集群健康条 controlPlane/workers 计数）。

---

## 2. 目标（本轮）

- **G1 单一数据源**：Vue Query 成为所有 K8s 资源的**唯一读源**；删除 store 的资源 `ref` 列表与 ns 过滤 computed。
- **G2 不重复请求**：同一资源在一个页面、跨页面、跨 list↔detail 只请求一次（Query 缓存 + canonical key 去重）。
- **G3 不加载他页数据**：首屏只拉「关键路径」（namespaces + nodes），其余按页懒加载。
- **G4 渲染提速**：首次进入任意资源页，不再触发 12 路批量请求。
- **过程约束**：渐进、每步可回退、mock 可验证（不强依赖真机）。

## 3. 非目标（显式延后）

- **watch → setQueryData 合流**（pods/workloads 实时态）：需真实集群 runtime 验证，本轮维持现有轮询新鲜度，**显式延后**到有真机时单独做。
- **组件模块化**（Pod/Label/Event/Container 等共享组件抽取 + `NsWorkloadDetail` 2178 行拆分）：**独立后续计划**，本 spec 不实现。
- **gateway 聚合/批量端点**：降低网络开销靠客户端单源去重实现，不新增服务端端点（遵循 no-new-deps 政策）。
- `cluster.js` 按域拆分成多个 Pinia store：路线 C，风险超出本轮偏好，**不在本轮**（可作为收敛后的后续优化）。

---

## 4. 目标架构

### 4.1 单一数据源
- **读**：全部经 `useResourceList` / `useResourceDetail`（Vue Query）。
- **`cluster.js` 瘦身**为薄层：仅保留
  - mutation（`addX/updateX/deleteX`，走 server-side apply / merge-patch，既有 `remoteUpdate`/`remotePatch`/`applyResourceYaml` 链路不变）
  - 连接/认证态（`connectionState`、`cluster`、`clusterList`、`remoteMode`、`authMethod`）
  - `currentNamespace` 持久化 + `setNamespace`
  - 选择器 / YAML 生成（`generateYAML`、`yamlScalar`、selector match）/ secret 编码等纯工具
  - **删除**：27 类资源的 `ref` 列表、`nsX` 过滤 computed、`fetchX`（fetcher 逻辑搬到 api 模块，**保留 mock 分支**）。
- canonical 集群级 key + namespace `select()` 派生 —— 设计已正确，补齐剩余页面即可。

### 4.2 首屏「关键路径」（替换 12 路批量）
- **始终加载**（常驻可见）：`namespaces` + `nodes`，**共 2 个请求**。已核实 `src/composables/useClusterHealth.js` 的 `computeClusterHealth` 仅依赖 `nodeList`（Ready/controlPlane）+ `apiReachable`，**不依赖 metrics**——故 metrics 不在关键路径，按页懒加载（Node/Nodes 页、监控中心）。
- `nodes` 已具备 Query 基础：`fetchNodes`/`fetchNode`（cluster.js:1179/1193）已自包含（nodes + node-metrics → mapNode）并作为 Nodes/NodeDetail 的 Query fetcher。
- **其它一律按页懒加载**：进 pod 页才拉 pods，进 service 页才拉 services……首次进入任意资源页不再触发批量。
- `switchCluster`：`queryClient.clear()` + 关键路径预取（clusterId 在 key 里，Query 自动按新集群重取）。
- `node drain` / mutation 后：沿用既有 `invalidateQueries` 模式，不再 `hydrateCoreResources()`。

### 4.3 全局搜索改造（惰性，已选定）
搜索从「扫描内存全量列表」改为 **Query 消费者**：
- 搜「已缓存资源」即时出结果；
- 打开搜索框时，对**未缓存**资源**惰性补取**（每个被补取的资源随后访问其页面 = 缓存命中，零额外请求）；
- 首屏**不再**为搜索预加载所有资源。UX 取舍：首次搜索可能「边载边搜」（用户已知情并选定此方案）。

实现要点：TopNavBar 搜索源改为遍历各资源 query 的 `getQueryData()` / `useQuery`（enabled 由「搜索框是否打开」控制），未启用时零请求。

### 4.4 收敛双源（逐资源，可回退）
对每类资源 `R`，当其**所有读者**（views + composables + components + TopNavBar 搜索）都改为 Query 后：
1. fetcher 逻辑从 `store.fetchR` 搬到 api 模块（如 `src/api/resources.js` 或就近），**保留 `remoteMode` mock 分支**；`useResourceList/useResourceDetail` 的 `fetcher` 指向新 api 函数。
2. 删除 `store.RList`、`store.nsR` computed、`store.fetchR`、`store.getRByName`（详情读 Query 缓存或 detail query）。
3. `addR/updateR/deleteR` 只做远端 apply/patch + `queryClient.invalidateQueries(['cluster', cid, 'R'])`（或乐观 `setQueryData`）。不再写本地列表。
4. 删除 `prefillQueryCache`（Query 已是源，无需从 store 预填）。

### 4.5 干掉详情页双取
每个详情页**一个** `useResourceDetail`；YAML 直接取缓存对象的 `raw`，不再二次裸 `api.k8s(...)`。需审计替换的已知点：Service 详情（`NsServiceDetail.vue` 拉 YAML）、Pod 详情（`PodDetail.vue:230`）、Ingress/ConfigMap/Secret 等。对「打开 YAML tab 时要最新」的需求，用 `staleTime` + 聚焦重取满足，而非手动再拉。

---

## 5. 分阶段（每阶段独立可发版、mock 可验证、可回退）

| 阶段 | 内容 | 完成判据 / 验证 |
|---|---|---|
| **P0 审计 + 加法脚手架** | ① 形式化「双源清单」（每资源：Query-only / dual / store-only）；② 新增 `useCriticalResources()`（namespaces + nodes）**加法接入，不动 hydrate**。（clusterHealth 不依赖 metrics，已核实） | mock 渲染 + `useK8sQuery.test.js` 扩单测；typecheck/build 绿 |
| **P1 关键路径 + 惰性搜索 + 移除批量** | AppLayout 挂载 / TopNavBar 刷新改用 `useCriticalResources`；TopNavBar 搜索改 Query 惰性（enabled=搜索框开）；`switchCluster` 改 `queryClient.clear()`+预取；**移除 `hydrateCoreResources`/`hydrateExtendedResources`**（保留极小关键路径）；删 `prefillQueryCache` | mock+单测+build；**首屏请求 12→2–3**（可手动在 mock/网络面板计数） |
| **P2 迁完剩余 ~40% 页面** | 逐页改 `useResourceList/useResourceDetail`：`PodDetail`、`WorkloadDetail`、`NsPods`、`NsWorkloads`、`Workloads`、`NsServiceDetail`、`NodeDetail`、`NamespaceDetail`、`NamespaceOverview`、`Namespaces`、`NsEvents`、`ClusterOverview`、`MonitoringCenter`、`CrdDetail`/`CrdList`、RBAC 视图 | 每页 PR 级；mock 渲染 + 该页相关单测 |
| **P3 逐资源收敛双源、瘦身 store** | 对每个「读者已全 Query」的资源：fetcher 搬 api（保 mock）→删 store 列表/computed/fetchX→mutation 改 invalidate-only | 逐资源可回退；每删一类跑全量 `npm test`+`test:unit`+`typecheck`+`build`；`cluster.js` 行数持续下降 |
| **P4 详情页双取审计清除** | 全量审计 views 内 `api.k8s(...)`，替换为缓存 `raw` 读取 | mock 渲染 + 单测 |

> 每阶段结束都需：`npm test` + `npm run test:unit` + `npm run typecheck` + `npm run build` 全绿；mock 模式（`remoteMode=false`）渲染正确即视为通过。任一阶段可独立 revert。

---

## 6. 新鲜度 / 错误处理 / 测试

- **新鲜度**：维持混合 A——列表 30s / 详情 15s 轮询 + 窗口聚焦刷新 + mutation `invalidateQueries`。watch 合流延后（见非目标）。
- **错误**：沿用 Query `isLoading/isError/isFetching` 三态；`switchCluster` 失败 → `connectionState='error'`（既有）；mutation 失败 → 既有 `remoteUpdate` 回滚 + notify。不引入新模式。
- **测试**：
  - 单元：vitest（`src/composables/__tests__/useK8sQuery.test.js` 已存在，P0/P1 扩 `useCriticalResources` 与搜索惰性的用例）+ `scripts/test.mjs` 自研零依赖运行器覆盖 store 纯逻辑。
  - 类型/语法：`npm run typecheck`（`node --check` 全 .js/.mjs，.vue 由 `npm run build` 覆盖）。
  - mock 模式回归：每阶段在 `remoteMode=false` 下逐页点查渲染。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 移除 hydrate 后，某处隐藏读者仍读 store 列表 → 空数据 | P0 形式化清单 + 每资源删除前 grep 全仓读者；P2 先迁读者、P3 才删列表，顺序保证 |
| `clusterHealth` 依赖 node-metrics 未察觉 → 健康条降级 | 已核实：`computeClusterHealth` 仅依赖 `nodeList`+`apiReachable`，不需 metrics（风险消除） |
| mock 分支在 fetcher 搬迁时遗漏 → mock 模式空 | 搬迁时逐资源验证 `remoteMode=false` 渲染；api 函数保留 mock 分支或经 Query `mock` 参数注入 |
| 惰性搜索首次体验「边载边搜」被感知为变慢 | 打开搜索框时显示「正在补充更多结果…」；已缓存即时出（用户已知情选定） |
| 中间态（P2→P3）部分资源仍双源 | 可接受：仍正常工作，只是尚未瘦身；逐资源收敛 |
| watch 延后 → pods/workloads 新鲜度退步？ | 否：维持轮询，与现状一致，无回归 |

---

## 8. 后续（独立计划，不在本轮）

1. **watch → setQueryData 合流**（pods/workloads，需真机）。
2. **组件模块化**：抽取 `LabelChips` / `AnnotationList` / `PodTable`+`PodStatusFilter` / `EventTable` / `ContainerList` / `ResourceFormat` composable / `ResourceYamlView` 外壳 / `OwnerReferenceLink`；拆分 `NsWorkloadDetail.vue`（2178 行）/ `DeployApp.vue`（1501 行）等超大文件。已有可复用样板（`PodCard` / `StatusChip` / `usePod.js`）。
3. （可选）`cluster.js` 按域拆分为多个 Pinia store。
