# 数据模型 Plan 3:删 hydrateCoreResources → 首屏 12→2

- **日期**: 2026-08-08
- **分支**: `feat/data-model-plan3`(从 `main` `55fd5b0` 切出)
- **目标**: 把 `hydrateCoreResources`(12 请求)缩小为 `hydrateCriticalResources`(namespaces+nodes,2 请求),全局搜索改惰性,**首屏 23→13**(2 critical + 11 extended;extended 在 Plan 5 清)。

## 1. 背景

Plan 2a-2d 全部完成:admin/RBAC/CRD/pods/events/aggregation/namespaces 全量迁 Vue Query。`hydrateCoreResources`(12 core fetches)是**唯一剩余的批量首屏拉取**。本计划把它缩为 2(namespaces+nodes)。

## 2. 目标

- **G1 首屏 12→2**:`hydrateCoreResources` → `hydrateCriticalResources`(仅 namespaces+nodes)。
- **G2 全局搜索惰性化**:TopNavBar 搜索改 Query 消费者(打开 → enable queries → 搜缓存)。
- **G3 调用者更新**:AppLayout mount / switchCluster / node drain / mutation / Clusters.vue / NsWorkloadDetail → critical/invalidate。
- **G4 删 prefillQueryCache**:Query 已是单源,无需从 store 预填。

## 3. 非目标

- `hydrateExtendedResources`(11)暂留(Plan 5 清)。
- store god-object 拆分(Plan 5)。
- NsWorkloadDetail 拆分(组件 Plan 2)。

## 4. 设计

### 4.1 `hydrateCriticalResources()`(替代 `hydrateCoreResources`)
```js
async function hydrateCriticalResources(opts = {}) {
  if (!remoteMode.value) return
  if (!opts.silent) connectionState.value = 'loading'
  const [nodeData, namespaceData] = await Promise.allSettled([
    api.k8s('/api/v1/nodes'),
    api.k8s('/api/v1/namespaces'),
  ])
  const nodes = nodeData.status === 'fulfilled' ? nodeData.value?.items : null
  const namespaces = namespaceData.status === 'fulfilled' ? namespaceData.value?.items : null
  if (!nodes && remoteMode.value) notify('error', '节点拉取失败')
  if (!namespaces) {
    if (!opts.silent) connectionState.value = 'error'
    throw new Error('无法读取 Namespace')
  }
  if (nodes?.items || nodes) nodeList.value = (nodes?.items || nodes || []).map(item => mapNode(item, null))
  if (namespaces) namespaceList.value = namespaces.map(item => ({
    name: item.metadata?.name, status: item.status?.phase || 'Unknown',
    age: ageOf(item.metadata?.creationTimestamp), labels: item.metadata?.labels || {},
  }))
  // 校验持久化的 currentNamespace
  if (currentNamespace.value && namespaceList.value.length
      && !namespaceList.value.some(n => n.name === currentNamespace.value)) {
    setNamespace(namespaceList.value[0].name)
  }
  if (!opts.silent) connectionState.value = 'connected'
  return { failed: [nodeData, namespaceData].filter(r => r.status === 'rejected').length }
}
```
- 不拉 pods/workloads/services/ingresses/events/replicasets/metrics → 页面 Query 自取。
- 不调 `hydrateExtendedResources`(暂留但不在 critical 里调;改为 AppLayout 单独调或页面自取)。
  **重要决策**:hydrateExtended 的 11 个 fetch 仍需在 AppLayout mount 时调(未迁页面如 DeployApp/Configuration 依赖)。所以 AppLayout mount 调 `hydrateCriticalResources()` + `hydrateExtendedResources()`,总计 2+11=13(比原 12+11=23 少 10)。

### 4.2 AppLayout mount
```js
// BEFORE:
store.hydrateCoreResources({ silent: true }).then(() => store.prefillQueryCache())
// AFTER:
store.hydrateCriticalResources({ silent: true }).then(() => store.hydrateExtendedResources()).catch(() => {})
```
删 `prefillQueryCache()` 调用(Query 已是单源)。

### 4.3 TopNavBar 搜索惰性化
- 搜索源改为 Query:getQueryData 各资源 key;搜索框打开时 enableResourceQueries(触发未缓存资源的 fetch)。
- 不再 `v-for in store.XList`;改读 Query 缓存。
- clusterRoleOptions 等 dropdown 同理(已有 Query from 2b-1)。

### 4.4 switchCluster
```js
// BEFORE: await hydrateCoreResources()
// AFTER:  queryClient.clear(); await hydrateCriticalResources(); await hydrateExtendedResources()
```

### 4.5 其他调用者
- **node drain (cluster.js:1605)**:→ `queryClient.invalidateQueries` + `hydrateCriticalResources`(刷 nodes)。
- **mutation (cluster.js:3171)**:→ `queryClient.invalidateQueries`。
- **Clusters.vue sync**:→ `invalidateAllClusterQueries`。
- **NsWorkloadDetail refresh**:→ `invalidateAllClusterQueries`。

### 4.6 删除
- `hydrateCoreResources` 函数(被 `hydrateCriticalResources` 替代)。
- `prefillQueryCache` 函数(无人调用)。

## 5. 约束 / 测试 / 风险
- 零行为变更(除首屏请求减少 + 搜索惰性化 UX)。
- mock 模式:hydrate 函数 early-return(remoteMode=false);页面从 Query mock param 渲染。
- 需**真机验证**:首屏只发 2+11=13 请求(原 23);搜索打开后惰性加载;switchCluster 清缓存后重建。
- clusterHealth 从 critical 写的 store.nodeList 读(OK);ns selector 从 store.namespaceList(OK)。

## 6. 执行序
T1 hydrateCriticalResources + 删 hydrateCore → T2 AppLayout mount + prefillQueryCache 删除 → T3 switchCluster + node drain + mutation → T4 TopNavBar 搜索惰性化 → T5 Clusters.vue + NsWorkloadDetail sync → T6 全量门禁。

## 7. 后续
Plan 5:逐资源剔除 hydrateExtendedResources(迁 Configuration/Network/Storage/DeployApp 等剩余页面后)→ 最终首屏 2(仅 namespaces+nodes)。组件 Plan 2:拆 NsWorkloadDetail。
