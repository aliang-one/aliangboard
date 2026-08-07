# 数据模型 Plan 2（第一批）：RBAC + CRD + 管理类迁 Vue Query

- **日期**: 2026-08-06
- **状态**: Draft（待用户 review）
- **分支**: `feat/data-model-plan2`（从最新 `main` `50023d6` 切出，含 data-model Plan 1、组件模块化 Plan 1、及并行合入的 i18n 全量改造）
- **本批目标**: 把 RBAC + CRD + 管理类(PriorityClass/IngressClass/RuntimeClass) 页面迁到 Vue Query 单源,顺带迁 `DeployApp` 向导的 priorityClass/SA 两处读取,**从 `hydrateExtendedResources`/`hydrateCRDs` 剔除 8 个资源 → 首屏少 ~8 个请求**。

---

## 1. 背景与定位

承接 `docs/superpowers/specs/data-model-audit.md` 的安全阶段排序:Plan 2 = 迁剩余 store-reading 页面到 Vue Query(为 Plan 3 删 `hydrateCoreResources` 解锁)。Plan 2 整体 ~20 页、多数资源缺 Query-ready fetcher,故**按资源族分批**。本批是第一批,选最干净的扩展资源族。

`main` 现状:`hydrateExtendedResources` 每次进应用并行拉 **19 个**扩展资源 + `hydrateCRDs` 异步拉 CRD,不论用户在哪个页。本批迁完的 8 个资源改为"页面/向导按需自取",从批量拉取里剔除。

**用户明确**:不追求"严格不加载其他数据/零双取",**优先往前推**。故本批对 `DeployApp` 向导的两处读取一并迁 Query(而非保守地推迟剔除),让 8 个资源全部干净剔除。

## 2. 目标（本批）

- **G1 单源**:RBAC + CRD + 管理类页面(及 DeployApp 两处)改为经 `useResourceList`/`useResourceDetail` 读 Vue Query。
- **G2 剔除 hydrate**:8 个资源从 `hydrateExtendedResources`/`hydrateCRDs` 移除 → 首屏请求 -8。
- **G3 过程**:逐资源、每步可回退、mock 可验证;不引入硬编码中文(过 `i18n:check`)。

## 3. 非目标（显式延后）

- **pods / events / 聚合页(ClusterOverview/MonitoringCenter/NamespaceOverview)/ namespaces**:后续批次(pods/events 有 live-watch 张力,聚合页读多资源)——这些是 Plan 3 删 core hydrate 的关键卡点,本批不动。
- **`DeployApp` 全量向导迁移**:本批只迁它的 priorityClass + nsServiceAccounts **两处读取**,不重构向导其余部分。
- **`cluster.js` 上帝对象拆分**:Plan 5。本批只加 fetcher、剔 hydrate,不删 store 列表 ref(nsRoles 等 computed 暂留,迁后变 dead code,Plan 5 清)。
- 已迁资源(configmaps/secrets/services/...)仍留在 hydrateExtended(其消费者含 DeployApp/Configuration 等向导,本批不碰)。

---

## 4. 每资源计划

fetcher 新建 = `api.k8s(endpoint) → items.map(mapX)`(`mapRole`/`mapRoleBinding`/`mapServiceAccount`/`mapCRD`/`mapPriorityClass`/`mapIngressClass`/`mapRuntimeClass` 均已存在,箭头函数形式)。`mapX` 已存在,fetcher 是机械包装。

| 资源 | 新建 fetcher | 消费者(全量迁) | 剔除 hydrate |
|---|---|---|---|
| CRD | `fetchCRDs`、`fetchCRD(name)` | CrdList, CrdDetail | ✅ 删 `hydrateCRDs()` 调用 |
| runtimeClass | `fetchRuntimeClasses` | RuntimeClasses | ✅ hydrateExtended |
| ingressClass | `fetchIngressClasses` | IngressClasses, **NsIngressDetail**(已迁页,补一个 ingressClass query) | ✅ hydrateExtended |
| roles/clusterroles(roleList 合 clusterrole) | `fetchRoles` | RBAC, NsRoleBindingDetail | ✅ hydrateExtended |
| rolebindings | `fetchRoleBindings` | RbacCanI | ✅ hydrateExtended |
| clusterrolebindings | `fetchClusterRoleBindings` | ClusterRoleDetail, NsRBAC, RbacCanI, RBAC | ✅ hydrateExtended |
| priorityClass | `fetchPriorityClasses` | PriorityClasses, **DeployApp**(下拉读取迁 Query) | ✅ hydrateExtended |
| serviceAccounts | `fetchServiceAccounts`(+ `fetchServiceAccount(name,ns)` 详情) | NsRBAC, NsServiceAccountDetail, NsRoleDetail(via nsRoleBindings), **DeployApp**(nsServiceAccounts 迁 Query) | ✅ hydrateExtended |

> 8 个资源全部剔除。RBAC 详情页(NsRoleDetail/NsRoleBindingDetail/NsServiceAccountDetail/ClusterRoleDetail)用对应 `useResourceDetail` + `getXByName` mock 兜底。

## 5. 迁移模式（沿用已迁页 NsConfigMaps/NsServices 样板）

- **列表页**:
  ```js
  const q = useResourceList({
    key: ['cluster', cid.value, '<resource>'],
    fetcher: () => store.fetchX(),
    mock: store.XList,
    mockMode: !store.remoteMode,
    select: list => list.filter(x => x.namespace === currentNs.value), // ns 级资源
    options: { refetchInterval: store.remoteMode ? 30000 : false },
  })
  ```
- **详情页**:`useResourceDetail({ key:['cluster',cid,'<R>',name], fetcher:()=>store.fetchX(name,ns), mock: store.getXByName(...), mockMode })`,模板用 `data.value ?? store.getXByName(...)` 兜底。
- **RBAC ns 过滤**:现 `nsRoles`/`nsRoleBindings`/`nsServiceAccounts` computed 改为 query 的 `select` 派生(canonical key + select,与已迁页一致)。
- **DeployApp 两处**:`store.priorityClassList` / `store.nsServiceAccounts` 的读取改为对应 query 的 `data`(或 `useResourceList` + select)。
- **剔除 hydrate**:从 `hydrateExtendedResources` 的 `Promise.all` 删对应 `api.k8s(...)` 与 `XList.value = items(i).map(mapX)` 赋值;CRD 删 `hydrateCRDs()` 调用(及其结果消费)。

## 6. 约束：i18n

`main` 已全量 i18n 化(硬编码中文 → `t()` 键),并引入 `scripts/i18n-check.mjs`。本批:
- 新建 fetcher 是纯逻辑(cluster.js),无 UI 文本 → 天然合规。
- 页面迁移**保留既有 i18n**;新增任何可见文案必须经 `t()`,不得硬编码中文。
- 验证门加 `npm run i18n:check`(须 0 残留)。

## 7. 测试 / 验证门

每资源迁完跑:
```bash
npm test && npm run test:unit && npm run typecheck && npm run build && npm run i18n:check
```
- `npm test`:零依赖运行器 + server 测试(含 `i18n-check.test`)+ vitest。fetcher 是 api.k8s 薄包装,不写新单测;既有 store/逻辑不变。
- mock 模式(`remoteMode=false`)逐页渲染回归(种子仍在,页面经 mock 分支渲染)。
- 剔除验证:剔除后 mock 模式相关页仍正常自取;首屏 hydrate 请求计数下降(可在网络面板/mock 计数确认 -8)。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| RBAC 页面互锁(NsRBAC/RBAC 同时读多个 RBAC 资源) | 逐资源推进;每资源迁完即剔除、可回退 |
| DeployApp 向导改动 | 只动 priorityClass + nsServiceAccounts 两处读取,不重构向导;mock 渲染回归 |
| 剔除后某隐藏消费者空数据 | 消费者清单已 grep 全仓(views/components/composables)核实;剔除前再 grep 该资源确认无遗漏 |
| i18n 回归 | 门禁加 `i18n:check`;迁移保留既有 `t()` |
| mock 种子 vs 剔除 | mock 模式不走 hydrate、读种子;fetcher 的 `mock:store.XList` 用种子,渲染不变 |

## 9. 执行序（Plan 内逐资源，每资源一个可发版单元）

CRD → runtimeClass → ingressClass → priorityClass(含 DeployApp) → roles → rolebindings → clusterrolebindings → serviceAccounts(含 DeployApp)。每单元:新建 fetcher → 迁消费者 → 剔除 hydrate → 门禁。

## 10. 后续批次（不在本批）

- Plan 2b:pods/events(含 watch→setQueryData 最小桥接)+ 聚合页 + namespaces → 解锁 Plan 3 删 core hydrate(12→2 主收益)。
- Plan 3:删 `hydrateCoreResources` + 全局搜索惰性。
- Plan 4:watch 合流(需真机)。Plan 5:拆 cluster.js 上帝对象。
