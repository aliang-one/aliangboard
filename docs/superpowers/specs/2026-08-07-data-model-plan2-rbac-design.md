# 数据模型 Plan 2b：RBAC 迁 Vue Query

- **日期**: 2026-08-07
- **状态**: Draft（待用户 review）
- **分支**: `feat/data-model-plan2-rbac`（从 `main` `0e3fab8` 切出，含 data-model Plan 1、组件 Plan 1、i18n、Plan 2a admin classes）
- **本批目标**: 把 RBAC 4 资源(roles/clusterroles、rolebindings、clusterrolebindings、serviceaccounts)的全部消费者迁到 Vue Query 单源,并从 `hydrateExtendedResources` 剔除这 5 个 fetch → **首屏少 ~5 个请求**。前置把 `hydrateExtendedResources` 重构为键控 map,让剔除不再错位。

---

## 1. 背景与定位

承接 `docs/superpowers/specs/data-model-audit.md` 的安全阶段排序与 Plan 2a（admin classes）的样板。RBAC 是 Plan 2 剩余里**最大的一批**:4 资源、7 个消费页(3 个多资源总览 + 4 个详情)、roles/clusterroles 合一列表、SA 有 `DeployApp` 向导消费者。

`main` 现状:RBAC 5 个资源在 `hydrateExtendedResources` 每次进应用批量拉(serviceaccounts 下标 4;roles 11、rolebindings 12、clusterroles 13、clusterrolebindings 14)。这 5 个条目**分散在数组中段**(非尾部),用位置下标 `items(i)` 引用——直接删会错位。故先重构为键控 map。

## 2. 目标（本批）

- **G1 单源**:RBAC 4 资源的全部消费者(3 总览页 + 4 详情页 + DeployApp SA 下拉)改读 Vue Query。
- **G2 剔除 hydrate**:5 个 RBAC fetch 从 `hydrateExtendedResources` 移除 → 首屏 -5 请求。
- **G3 hydrate 键控重构**:把 `hydrateExtendedResources` 从位置下标改为命名键控(零行为变更),使本批及后续(pods/events)剔除不再错位。
- **G4 过程**:逐资源、每步可回退、mock 可验证;不引入硬编码中文(过 `i18n:check`)。

## 3. 非目标（显式延后）

- **pods / events / 聚合页 / namespaces**:Plan 2c/3(解锁 Plan 3 删 core hydrate)。本批不动。
- **`cluster.js` 上帝对象拆分**:Plan 5。本批只加 fetcher、重构 hydrate、剔除条目;不删 store 列表 ref(nsRoles 等 computed 迁后变 dead,Plan 5 清)。
- **RBAC 业务逻辑/权限语义不变**:仅改数据来源(store → Query)。

---

## 4. 前置：`hydrateExtendedResources` 键控重构（T1）

当前:
```js
const reqs = await Promise.allSettled([ api.k8s(...), ... 19 项 ])
const items = i => (reqs[i].status === 'fulfilled' ? reqs[i].value?.items : null) || []
configMapList.value = items(0).map(mapConfigMap)
... // 位置下标赋值
```
重构为命名键控(零行为变更):
```js
const fetchers = {
  configmaps: () => api.k8s('/api/v1/configmaps?limit=5000'),
  secrets: () => api.k8s('/api/v1/secrets?limit=5000'),
  ... // 每资源一个命名 thunk
}
const out = {}
await Promise.all(Object.entries(fetchers).map(async ([k, fn]) => {
  try { out[k] = (await fn())?.items || [] } catch { out[k] = [] }
}))
configMapList.value = out.configmaps.map(mapConfigMap)
... // 命名赋值
return { failed: ... } // 失败计数语义保持
```
之后剔除任一资源 = 删其 fetchers 条目 + 其赋值行,**无错位**。纯重构:既不增删资源、也不改 mapX/赋值顺序;mock 模式不受影响(函数顶部 `if (!remoteMode.value) return` 不变)。

## 5. 每资源计划

`mapRole(item, scope)` / `mapRoleBinding(item)` / `mapServiceAccount(item)` 已存在(箭头函数),fetcher 是机械包装(仿 `fetchServices`;roles 合端点仿 `fetchWorkloads`)。getter 全部已有(`getRoleByName`/`getRoleBindingByName`/`getServiceAccountByName`/`getClusterRoleByName`/`getClusterRoleBindingByName`)作详情 mock 兜底。

| 资源 | 新建 fetcher | 消费者(全量迁) |
|---|---|---|
| **roles/clusterroles**(roleList 合一) | `fetchRoles`(合 `/apis/rbac.../v1/roles` + `/clusterroles`,mapRole Namespace/Cluster)+ `fetchRole(name,ns)` + `fetchClusterRole(name)` | `NsRoleDetail`(主:getRoleByName;关:nsRoleBindings)、`NsRoleBindingDetail`(主:getRoleBindingByName;关:getRoleByName/roleList)、`RBAC.vue`(roleList)、`NsRBAC`(nsRoles/clusterRoles) |
| **rolebindings** | `fetchRoleBindings` + `fetchRoleBinding(name,ns)` | `RbacCanI`、`NsRBAC`(nsRoleBindings)、`NsRoleDetail`/`NsServiceAccountDetail`(关:nsRoleBindings)、`NsRoleBindingDetail`(主) |
| **clusterrolebindings** | `fetchClusterRoleBindings` + `fetchClusterRoleBinding(name)` | `ClusterRoleDetail`(关:clusterRoleBindingList)、`RbacCanI`、`NsRBAC`、`RBAC.vue` |
| **serviceaccounts** | `fetchServiceAccounts` + `fetchServiceAccount(name,ns)` | `NsServiceAccountDetail`(主)、`NsRBAC`(nsServiceAccounts)、`RBAC.vue`(saList)、**DeployApp**(nsServiceAccounts 下拉) |

## 6. 迁移模式

- **列表/总览页**(`NsRBAC`/`RBAC.vue`/`RbacCanI`):每资源一个 `useResourceList`(`key:['cluster',cid,'<R>']`,`fetcher:()=>store.fetchX()`,`mock:store.XList`,`mockMode`,`select` 做 ns 过滤)。现多资源 computed(如 `NsRBAC` 的 `currentTabList`/`clusterRoleOptions`)改为从各 query 派生。
- **详情页**:主资源 `useResourceDetail`(`key:['cluster',cid,'<R>',name]`,`fetcher:store.fetchX(name[,ns])`,`mock:store.getXByName(...)`,`pc = data.value ?? store.getXByName(...)`);关联资源(如 `NsRoleDetail` 的 nsRoleBindings 面板)用一个 `useResourceList` + `select` 过滤。
- **ns 派生**:`nsRoles`/`nsRoleBindings`/`nsServiceAccounts`/`clusterRoles` → 对应 query 的 `select` 过滤(scope/namespace)。
- **roles 合一**:`fetchRoles` 返回 `[...roles.map(r=>mapRole(r,'Namespace')), ...clusterroles.map(r=>mapRole(r,'Cluster'))]`(与现 hydrate 一致);`nsRoles` select = `scope==='Namespace' && ns`;`clusterRoles` select = `scope==='Cluster'`。
- **DeployApp SA**:加 `serviceAccountsQuery`;`availableServiceAccounts = computed(() => (q.data.value||[]).filter(ns).map(s=>s.name))`。其余 DeployApp store 读不动。
- **剔除**:从(已键控的)`hydrateExtendedResources` 删 roles/clusterroles/rolebindings/clusterrolebindings/serviceaccounts 五个 fetchers 条目 + 五个赋值行。

## 7. 约束：i18n

`main` 全量 i18n 化 + `scripts/i18n-check.mjs`。本批:fetcher/hydrate 重构是纯逻辑(无 UI 文本);页面迁移保留既有 `t()`;新增文案走 `t()`。验证门含 `npm run i18n:check`(0 残留)。

## 8. 测试 / 验证门

每资源迁完:
```bash
npm test && npm run test:unit && npm run typecheck && npm run build && npm run i18n:check
```
- fetcher 是 api.k8s 薄包装,不写新单测(与 fetchServices 一致);hydrate 键控重构是纯重构,既有 store 单测兜底。
- mock 模式(`remoteMode=false`)逐页渲染回归。
- 剔除前 grep 全仓 `roleList|roleBindingList|clusterRoleBindingList|saList|nsRoles|nsRoleBindings|nsServiceAccounts|clusterRoles|getRoleByName|getRoleBindingByName|getClusterRoleByName|getClusterRoleBindingByName|getServiceAccountByName` 确认无残留 display 消费者(只剩 `mock:`/`?? 兜底),照搬 Plan 2a T4 的安全门。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| hydrate 键控重构改坏既有赋值 | 纯重构:不增删资源、不改 mapX/顺序;mock 模式回归 + 既有 store 单测;逐资源迁完再剔除 |
| RBAC 总览页多资源、改漏某 query | 逐页核对 `store.XList` 读取点全替换;grep 门禁兜底 |
| 详情页"关联资源"读取复杂 | 主资源用 `useResourceDetail`,关联用 `useResourceList`+select;逐详情页在 plan 里细化 |
| roles 合一列表 scope 过滤错 | `nsRoles`/`clusterRoles` select 严格按 scope;与现 ns-computed 行为对齐 |
| 剔除下标错位 | **前置键控重构**消除该风险(本批核心收益之一) |
| SA/DeployApp 双取 | DeployApp SA 迁 Query 后即可剔除;无遗留双取 |

## 10. 执行序（Plan 内逐资源）

T1 hydrate 键控重构 → T2 roles/clusterroles → T3 rolebindings → T4 clusterrolebindings → T5 serviceaccounts(含 DeployApp) → T6 剔除 5 资源 → T7 全量门禁。每资源一个独立可发版单元。

## 11. 后续

- Plan 2c/3:pods/events(含 watch→setQueryData 最小桥接)+ 聚合页 + namespaces → 解锁 Plan 3 删 `hydrateCoreResources`(12→2 主收益)。
- Plan 4:watch 合流(需真机)。Plan 5:拆 cluster.js 上帝对象。
