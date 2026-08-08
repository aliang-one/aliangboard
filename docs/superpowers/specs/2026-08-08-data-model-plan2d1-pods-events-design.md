# 数据模型 Plan 2d-1:pods + events 迁 Vue Query(加法 watch 桥接)

- **日期**:2026-08-08
- **分支**:`feat/data-model-pods`(从最新 `main` `61c424c` 切出)
- **目标**:把 pods/events 消费者(NsPods/PodDetail/WorkloadDetail/Workloads/NsEvents)迁 Vue Query,**加法 watch 桥接**保留实时更新。解锁 Plan 3 删 `hydrateCoreResources` 的 pods/events 卡点。

## 1. 背景

pods/events 是最后两个"核心 hydrate 消费者",且带 **live-watch**(startPodWatch/startEventWatch 更新 store 列表)。直接迁 Query 会让 live 更新丢失(只剩轮询)。本批用**加法桥接**:watch onMessage 在更新 store 的**同时**写 Query 缓存(`useWatchMerger`/`applyWatchEvent`,均已单测)。store 双写 → 无回归;Query 缓存 → NsPods/NsEvents 读 Query 享 live。

## 2. 目标

- **G1 单源**:NsPods/PodDetail/WorkloadDetail/Workloads/NsEvents 读 Vue Query。
- **G2 live 保留**:pods/events watch 经加法桥接写 Query 缓存,live 更新不丢失。
- **G3 过程**:加法(无回归)、mock 可验证、过 i18n:check。live 行为加法=无回归(需真机最终验证)。

## 3. 非目标

- 聚合页(ClusterOverview/MonitoringCenter/NamespaceOverview)+ namespaces = **Plan 2d-2**(无 watch)。
- 删 `hydrateCoreResources`(12→2 主收益)= **Plan 3**(2d 全部完成后)。
- workloads 已迁(2b-1);本批只补 WorkloadDetail/Workloads 中 pods/events 的关联读。

## 4. 设计

### 4.1 fetcher(新建,`cluster.js`)
- `fetchPods()`:`api.k8s('/api/v1/pods?limit=1000')` + pod-metrics → `mapPod(item, metricFor(name))`(带 raw/metrics)。metrics 容忍失败。
- `fetchPod(name, ns)`:单 pod(含 metrics)。
- `fetchEvents()`:`api.k8s('/api/v1/events?limit=1000')` → `mapEvent`(已有)。

### 4.2 加法 watch 桥接(核心)
- `startPodWatch` 的 onMessage:**保留**现有 `podList` 更新 + **新增** `queryClient.setQueryData(['cluster', cid, 'pods'], old => applyWatchEvent(old || [], evt.type, mapPod(evt.object)))`。
- `startEventWatch` 同理写 `['cluster', cid, 'events']`。
- cid = `remoteMode ? (currentCluster || 'cluster') : 'demo'`。
- `applyWatchEvent`(已单测)+ `mapPod`/`mapEvent`(已有)。

### 4.3 消费者迁移
- **NsPods**:`useResourceList({key:['cluster',cid,'pods'], fetcher:fetchPods, mock:store.podList, mockMode, select:ns 过滤})`;`startPodWatch`/`stopPodWatch` toggle 保留(podWatchLive),live 经桥接流入 Query。
- **PodDetail**:`useResourceDetail(fetchPod)` 主资源;events 面板用 events query(或保留 store.eventsFor);YAML 走 pod.raw(2a 已做)。
- **WorkloadDetail**:managed pods → pods query + select(workload 匹配);events → events query。
- **Workloads**(cluster-wide):workloadList 已 Query(2b-1);namespaceList → namespaces query(或保留 store — namespaces 在 2d-2)。
- **NsEvents**:`useResourceList({key:['cluster',cid,'events'], fetcher:fetchEvents, mock:store.eventList, mockMode, select:ns})`;event watch toggle 保留。

### 4.4 不动
- `hydrateCoreResources` 仍拉 pods/events(Plan 3 删);本批只迁消费者 + 加桥接。
- store podList/eventList ref 保留(watch 双写 + mock 种子)。

## 5. 约束 / 测试 / 风险
- i18n:fetcher/watch 桥接是纯逻辑;页面迁移保留 `t()`;门禁含 `npm run i18n:check`。
- 验证门:`npm test && npm run test:unit && npm run typecheck && npm run build && npm run i18n:check`。
- watch 桥接的 setQueryData 逻辑可单测(applyWatchEvent 已测,可加一个"watch event → query cache"的零依赖测试)。
- 风险:① pods watch 桥接 live 行为需真机(加法无回归);② WorkloadDetail 是大文件,仔细;③ metrics 关联(metrics-server 可能不可用,容忍 null)。

## 6. 执行序
T1 fetcher(fetchPods/fetchPod/fetchEvents) → T2 加法 watch 桥接(store) → T3 NsPods → T4 PodDetail → T5 WorkloadDetail → T6 NsEvents → T7 全量门禁。(Workloads 的 namespaceList 留 2d-2。)

## 7. 后续
Plan 2d-2:聚合页 + namespaces。Plan 3:删 `hydrateCoreResources`(12→2)。Plan 4:watch 完整合流(本批的加法桥接可在此收敛为单写)。
