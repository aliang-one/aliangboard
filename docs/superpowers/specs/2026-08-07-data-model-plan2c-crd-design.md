# 数据模型 Plan 2c：CRD 迁 Vue Query（实例懒加载）

- **日期**: 2026-08-07
- **状态**: Draft（设计已口头认可）
- **分支**: `feat/data-model-crd`（从最新 `main` 切出）
- **本批目标**: 把 CRD 列表/详情迁到 Vue Query,**实例改懒加载**,剔除 `hydrateCRDs` 的 N+1 拉取(1 定义列表 + 每 CRD 一实例列表)→ **首屏最多 −(N+1) 请求**(N=CRD 数,常 10–30+)。

---

## 1. 背景与定位

承接 Plan 2a/2b(admin + RBAC 迁 Query)。CRD 是 Plan 2 剩余里**最有价值的单个剔除**:`hydrateCRDs()` 每次进应用拉 1 个 CRD 定义列表 + **每个 CRD 一个实例列表**(`/apis/{group}/{version}/{plural}?limit=500`),不论用户是否看 CRD。这是 hydrate 里最贵的调用。`crd.instances`(由它填充)目前只供 `CrdList.totalInstances`(汇总统计)与 `CrdDetail` 的 instances tab 使用。

## 2. 目标

- **G1 单源**:CrdList/CrdDetail 读 Vue Query。
- **G2 消除 N+1**:`fetchCRDs()` 只拉定义;实例由 `CrdDetail` **懒加载**(只拉当前 CRD 的实例)。
- **G3 剔除 hydrate**:删 `hydrateCRDs()` 调用 → 首屏 −(N+1) 请求。
- **G4 过程**:零行为变更(除下述 totalInstances)、mock 可验证、过 i18n:check。

## 3. 非目标

- pods/events/聚合/namespaces(Plan 2d,解锁 Plan 3)。
- CRD 业务语义不变;`crInstancePath`/`applyCRYaml`/`deleteCRInstance`/`refreshCRDInstances` 行为不变。

## 4. 设计

### 4.1 fetcher(新建,`cluster.js`)
- `fetchCRDs()`:`api.k8s('/apis/apiextensions.k8s.io/v1/customresourcedefinitions?limit=500')` → mapCRD(**不含 instances**,但**保留 `_plural`** 供实例路径用)。映射逻辑搬自 `hydrateCRDs`(name/group/version/kind/scope/namespaced/description/_plural)。
- `fetchCRD(name)`:单个 CRD 定义(`.../customresourcedefinitions/{name}`),同 mapCRD(保留 _plural)。
- `fetchCRInstances(crd)`:`api.k8s('/apis/{crd.group}/{crd.version}/{crd._plural}?limit=500')` → 实例列表(复用 `hydrateCRDs` 的 instance 映射:name/namespace/status/age/spec/labels/annotations)。失败容忍(RBAC/无实例 → [])。
- `mapCRD`/instance 映射逻辑**从 `hydrateCRDs` 抽出**为可复用纯函数(供 fetcher 用)。

### 4.2 CrdList.vue
- `useResourceList({ key:['cluster',cid,'crds'], fetcher:()=>store.fetchCRDs(), mock:store.crdList, mockMode, options:{refetchInterval:30000} })` + `crds` computed。
- `filteredCrds` 改读 `crds`。
- `totalInstances`:实例不再随列表加载 → 显示 **"—"**(或移除该统计卡)。CRD 数(`crds.length`)保留。

### 4.3 CrdDetail.vue
- 主资源:`useResourceDetail({ key:['cluster',cid,'crds',name], fetcher:()=>store.fetchCRD(name), mock:store.getCRDByName(name), mockMode })` → `crd = data.value ?? store.getCRDByName(name)`。
- 实例:一个 instances query,**enabled 依赖 crd 就绪**:`useResourceList({ key:['cluster',cid,'crds',name,'instances'], fetcher:()=>store.fetchCRInstances(crd.value), mock:crd.value?.instances||[], mockMode, enabled:!!crd.value })` → `instances` computed。
- instances tab + count(`crd.instances?.length`)改读 `instances`。
- `crInstancePath`/`applyCRYaml`/`deleteCRInstance`/`refreshCRDInstances` 不变;`refreshCRDInstances` 改为 invalidate instances query(或 refetch)。

### 4.4 剔除
- 删 `hydrateCRDs()` 调用点(`hydrateCoreResources` 末尾的 `hydrateCRDs().catch(...)`)+ 函数体(或保留函数不调,Plan 5 清)。store `crdList` ref 保留(mock 种子 + Query mock 用)。

## 5. 约束 / 测试 / 风险

- i18n:fetcher 纯逻辑;页面迁移保留 `t()`;门禁含 `npm run i18n:check`。
- 验证门:`npm test && npm run test:unit && npm run typecheck && npm run build && npm run i18n:check`。fetcher 薄包装不写新单测。
- 剔除前 grep 全仓 `crdList|getCRDByName|crd\.instances|\.instances` 确认无残留消费者(只剩 mock:/fallback/Query 派生)。
- **UX 变更(已认可)**:CrdList 不再显示全局实例总数(→ "—");实例改为进 CrdDetail 才加载(首次进 instances tab 有一次加载)。
- 风险:CRD 实例列表路径依赖 `_plural`(fetchCRD 须保留);crd 未就绪时 instances query `enabled:false`(不空请求)。

## 6. 执行序

T1 抽 mapCRD + 3 fetcher → T2 CrdList(totalInstances→—) → T3 CrdDetail(定义+懒实例) → T4 剔除 hydrateCRDs(grep 门禁) → T5 全量门禁。

## 7. 后续

Plan 2d:pods/events/聚合/namespaces → 解锁 Plan 3(删 `hydrateCoreResources`,首屏 12→2 主收益)。Plan 4 watch 合流(需真机)。Plan 5 拆 cluster.js。
