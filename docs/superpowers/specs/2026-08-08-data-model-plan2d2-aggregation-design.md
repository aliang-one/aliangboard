# 数据模型 Plan 2d-2:聚合页 + Namespaces 迁 Vue Query

- **日期**: 2026-08-08
- **分支**: `feat/data-model-aggregation`(从 `main` `ad6d93d` 切出)
- **目标**: 把最后一批 hydrate 消费者(聚合页 + namespaces)迁 Vue Query,**解锁 Plan 3 删 `hydrateCoreResources`(12→2 首屏主收益)**。

## 1. 背景

Plan 2a-2d-1 已迁 admin/RBAC/CRD/pods/events 到 Query。剩余 hydrate 消费者:聚合页(ClusterOverview/MonitoringCenter/NamespaceOverview)+ Namespaces/NamespaceDetail。这些页面读**多资源**(汇总视图)。所有底层资源(nodes/pods/events/workloads/services/ingresses)已有 fetcher。本批迁这些页面 + 新建 `fetchNamespaces`。

## 2. 目标

- **G1 单源**:5 个页面读 Vue Query(多 query 派生)。
- **G2 sync 按钮**:`hydrateCoreResources()` sync → `queryClient.invalidateQueries`(不再手动 hydrate)。
- **G3 解锁 Plan 3**:全部 hydrate 消费者迁完 → Plan 3 可删 `hydrateCoreResources`。

## 3. 非目标

- 删 `hydrateCoreResources` = Plan 3(本批只迁消费者)。
- namespace pods/services 计数:从已有 query 派生或显示 "—"。
- store god-object 拆分 = Plan 5。

## 4. 设计

### 4.1 `fetchNamespaces()`(新建)
`api.k8s('/api/v1/namespaces')` → 映射(name/status/age/labels)。pods/services 计数不在 fetcher 里算(需 pods+services 数据);页面从自己的 query 派生,或显示 "—"。

### 4.2 聚合页迁移(多 query 派生)
- **ClusterOverview**:`useResourceList(nodes)` + `useResourceList(events)`;clusterHealth 从 nodes 算(已有 useClusterHealth)。
- **MonitoringCenter**:`useResourceList(nodes)` + `useResourceList(pods)` + `useResourceList(workloads)` + `useResourceList(events)`;refreshMetrics + eventWatch toggle 保留。
- **NamespaceOverview**:`useResourceList(workloads, select:ns)` + `useResourceList(services, select:ns)` + `useResourceList(ingresses, select:ns)`。

### 4.3 Namespaces 迁移
- **Namespaces.vue**:`useResourceList(namespaces)`;sync 按钮 → `queryClient.invalidateQueries({ predicate: q => q.queryKey[0] === 'cluster' })`。
- **NamespaceDetail.vue**:`useResourceDetail(fetchNamespace)` 或 list-query find;services/workloads query;sync → invalidate。

### 4.4 约束
- 零行为变更(namespace 计数 → "—" 或 query 派生);mock 可验证;i18n:check。

## 5. 执行序
T1 fetchNamespaces → T2 ClusterOverview → T3 MonitoringCenter → T4 NamespaceOverview → T5 Namespaces + NamespaceDetail → T6 全量门禁。

## 6. 后续
**Plan 3**:删 `hydrateCoreResources`(首屏 12→2)+ 全局搜索惰性(Plan 1 设计已定)。
