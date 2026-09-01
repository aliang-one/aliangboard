# Workload 拓扑 Tab 整体修复与增强设计(拓扑图优化)

- 日期:2026-09-01
- 分支:`worktree-feat+topology-overhaul`(worktree 隔离,完成后 `--no-ff` 合回 main)
- 范围:`NsWorkloadDetail.vue` Topology Tab(Ingress → Service → Workload → Pods)+ 其入口弹窗 + 数据面
- 来源:2026-09-01 拓扑图功能审计(18 项发现,A 正确性 5 / B 状态 2 / C 表达力 7 / D 小项 4)

## 0. 背景

拓扑 Tab 现状为四列流水线卡片(Ingress 规则 / Service / 本负载 / Pods),列间悬浮 "+" 入口两个弹窗(expose 建 Service、ingress-map 绑路由)。判定逻辑单源 `src/logic/workloadMeta.js`(selector 承重墙防线),数据走 Vue Query(`useResourceList`)+ family watch 多路复用单通道。

审计发现的系统性缺陷:共享 Ingress 规则张冠李戴(A1)、CronJob 标签面取错(A2)、计数不一致(A3)、前缀兜底吞并(A4)、端口校验缺口(A5)、加载态与空态混淆(B1)、网络层无降级轮询(B2),以及一批表达力缺口(无 RS 层 / 无 PDB·NetPol·HPA·PVC 附挂 / 无规则⇄Service 联动 / 无 Endpoints 可见性 / CronJob 卡语义错位等)。

## 1. 方案选型

三个备选:**① 四列流水线增强**(保持骨架,列内列间增强)、② 真·拓扑图画布(SVG/echarts graph,工程量大数倍、详情页 tab 内交互过重)、③ 纵向分层树(表达力最弱)。

**裁决:①**。与全站 IA 一致、watch 数据面已齐、改动可控可测、不引新依赖;②③ 列为被否备选存档。

## 2. 架构

```
src/composables/useWorkloadTopology.js        ← 新:拓扑域组合式(查询 + computed + 动作 + 弹窗状态)
src/logic/topology.js                          ← 新:纯函数层(零依赖,自研运行器可测)
src/components/common/WorkloadTopologyTab.vue  ← 新:拓扑 Tab 纯展示组件(props 进,动作调 store)
src/views/NsWorkloadDetail.vue                 ← 瘦身:拓扑查询/computed/模板段迁出,Network Tab 与弹窗改读 topo.*
```

- **`logic/topology.js`(纯函数,不含 Vue/Pinia 依赖)**:
  | 函数 | 契约 | 修复项 |
  |---|---|---|
  | `filterOwnIngressRules(relatedIngresses, relatedServiceNames)` | 入参为**已筛相关**的 Ingress 列表;返回 `{ ownRules, otherCount, others }`;`ownRules` 仅含 `backend.service.name ∈ relatedServiceNames` 的路径(含 `defaultBackend` 命中 → `host:'*'` 一条);`others` 为被排除规则所属 Ingress 名集合 | A1 |
  | `podTemplateLabels(raw)` | CronJob → `spec.jobTemplate.spec.template.metadata.labels`;其余 → `spec.template.metadata.labels`;缺 shape → `{}`。**落位 `workloadMeta.js`**(selector 承重墙同域) | A2 |
  | `classifyServiceDrift(svc, tplLabels, actualPods, endpoints)` | 返回 `'broken' \| 'pending-break' \| null`;`broken`=selector ⊄ 模板 labels 且(⊄ 实际 Pod labels 或 Endpoints ready=0);`pending-break`=⊄ 模板但 ⊆ 实际 Pod labels 且 Endpoints 有地址 | C7 |
  | `groupPodsByReplicaSet(pods, replicaSets)` | 按 `pod.raw.metadata.ownerReferences`(controller=true, kind=ReplicaSet)分组;无 owner → `'ungrouped'` 组;组含 `{ rsName, ready, desired, pods }` | C1 |
  | `podsByPrefixFallback(pods, wlName, allWorkloads)` | ① 边界收紧为 `wlName + '-'`;② 最长前缀让渡——存在更长负载名前缀匹配时让渡给该负载 | A4 |
  | `endpointsForService(endpoints, svcName)` | 返回 `{ ready, notReady, total }`;未命中 → `null` | C4 |
  | `latestOwnedRs(replicaSets)` | creationTimestamp 最新者为「新」;其余 desired=0 且 ready=0 → 置灰候选 | C1 |
  | `volumesAndPullSecretsFromPodSpec(podSpec)` | 提取 PVC(`persistentVolumeClaim.claimName`)与 imagePullSecrets,形状对齐 `configRefs` 的 `{kind,name}` | C2 |
- **`useWorkloadTopology({ workload, namespace, pollInterval, managedPods })`**:签名显式注入四个页面已有量——`workloads`/`pods` 两查询**留在页面**(多 Tab 共用),`pollInterval`(部署感知自适应轮询 ref,页面计算后传入)与 `managedPods`(C7 分类需实际 Pod labels)作只读入参。现 services/ingresses/pdbs/netpols 四查询迁入;新增三条——
  - `replicasets`:`fetchReplicaSets(ns)`(`/apis/apps/v1/namespaces/<ns>/replicasets?limit=500`),mapper `{name, namespace, desired: spec.replicas, ready: status.readyReplicas\|\|0, hash: metadata.labels['pod-template-hash'], raw}`;`enabled: type==='Deployment'`
  - `endpoints`:`fetchEndpoints(ns)`(`/api/v1/namespaces/<ns>/endpoints`),mapper `{name, namespace, ready, notReady, addresses}`
  - `hpas`:复用现有 `fetchHPAs()`(cluster 级)+ ns select
  - **六条查询统一 `refetchInterval: pollInterval`**(live/reconnecting→false,降级→30s,部署中→3s)——B2 修复,新鲜度单轨
  - 收编动作与弹窗状态:`repairServiceSelector` / `saveExpose` / `saveIngressMap` / `openExpose` / `openIngressMap` / `showExposeModal` / `showIngressMapModal` / `mapConflict` / 相关 form refs
- **`WorkloadTopologyTab.vue`**:props = `topo`(组合式返回包)+ `workload` + `canMutate`;hover 联动状态自持;卡片动作直调 `topo.*`。expose/ingress-map **弹窗模板留页面**(Network Tab 共触发),状态读 `topo.*`。
- **一致性**:同一 Vue Query key 组合式与页面不再重复挂载;Network Tab(`relatedServices`/`relatedIngresses`/`openIngressMap`)与 `workloadEvents`(managedPods)全部改读 `topo.*`,语义不变。

## 3. 缺陷修法映射

### 3.1 正确性(A 组)

- **A1 Ingress 列张冠李戴**:列内渲染 `topo.ownRules`;被排除规则合并为列尾一行「+N 条其他应用路由」(点击跳对应 Ingress 详情,`others` 提供跳转目标)。修复「有任意规则指向本负载的 Ingress,其全部规则被算进本负载流量路径」。
- **A2 CronJob 标签面**:`podLabels` computed 改调 `podTemplateLabels(workload.raw)`;全部消费面同步换源——`relatedServices` / `driftedServices` / `identitySel` / `labelConsumers` / saveMeta / saveTemplate 守卫面。**plan 阶段必须 grep 全部 `podLabels` 与 `spec?.template?.metadata?.labels` 直读点核对**,防漏接(教训:分母类契约改动必 grep 全部计算面)。回退语义不变:模板无 labels → `identitySelector` 的 `{app: name}` 兜底。
- **A3 Service 列头计数**:列头 = `relatedServices.length + driftedServices.length`;有失配时追加 `+K⚠` 徽标。
- **A4 前缀兜底吞并**:`managedPods` 兜底分支改走 `podsByPrefixFallback`;`workloadEvents`/批量删除 universe 同源自动受益。
- **A5 端口校验缺口**:`saveIngressMap` 起手校验 `servicePort` 非空(空 → `notify('error')` + 保留弹窗);追加/新建两模式同检;删除新建模式 `Number(...) || 80` 静默兜底,与 `hostsToK8sSpec` 生成层不变式对齐。

### 3.2 状态与新鲜度(B 组)

- **B1 加载态**:三列空态前判查询状态——相关查询 `isPending` → shimmer 骨架行(复用 `animate-pulse` 惯例);`isSuccess` 且空 → 现有「无 XX」空态。各列独立判定。
- **B2 降级轮询**:见 §2 组合式——六条查询统一 `pollInterval` 门控,修掉「Service/Ingress 侧永不自动刷新」双轨。

### 3.3 表达力(C 组)

- **C1 RS 中间层(仅 Deployment)**:Workload 卡内挂 RS chips(`[rs/web-7f9 3/3]`,`latestOwnedRs` 标新,死亡 RS 置灰,点击跳 revisions Tab);Pods 列按 `groupPodsByReplicaSet` 分组,组头 = RS 名 + ready 数,旧 RS 组降透明度,无 owner Pod 归「未分组」。非 Deployment 类型不渲染 RS 区。
- **C2 附挂节点**:Workload 卡——HPA chip(匹配 `spec.scaleTargetRef.kind+name`,显示 min→max 与当前目标,跳 `NsHPADetail`,路由已核)+ PVC chip(跳 `NsPVCDetail`)+ imagePullSecrets(顺补 `configRefs` 漏提 IPS 的既有缺口);Service 卡——PDB / NetPol chips(归属判据复用 `labelConsumers` 精度语义:selector/podSelector ⊆ 模板 labels),PDB 允许 disruptive 时警示色,点击跳 `NsPDBDetail` / `NsNetworkPolicyDetail`(路由已核)。
- **C3 列间悬停联动**:规则卡 hover → 高亮 `serviceName` 匹配的 Service 卡(失配卡警示色);反向同理。`hoveredSvc` ref + class 绑定,无新依赖;触摸端不降级(点击仍跳转)。
- **C4 Endpoints 可见性**:Service 卡副行 `ready/total endpoints`(ready=0 警示色);endpoints 数据缺失(权限)时不渲染该行。
- **C5 STS governing service / 无 selector 说明**:StatefulSet 时 `spec.serviceName` 命中的 Service 卡加「主」徽标;Service 列全空态补一句「无 selector 的 Service(ExternalName/自管 Endpoints)不在此列」。
- **C6 CronJob/Job 卡语义**:CronJob 卡 replicas/image 行换为 `schedule` cron 串 + suspend 徽标;Job 卡显示 completions(succeeded/total)。
- **C7 drift 文案分型**:两个警示档——红「已断,Endpoints 为空」/ 黄「滚动后将断」(`classifyServiceDrift`);「一键修复」按钮两档均在。

### 3.4 小项(D 组)

- **D1** `openExpose` 无容器端口声明时不再猜 `80→8080`,端口行置空由用户填写,`saveExpose` 校验非空拦截。
- **D2** 列内可点卡片 button 化(键盘可达 + focus 环;装饰性元素除外)。
- **D3** 失配卡 title 补判据说明(启发式:selector 值含负载名)。
- **D4** 列头计数语义统一:「N 路由 / M Service / K Pod」。

## 4. 错误处理

- 新查询失败:沿用 `useResourceList` 全局策略(retry 1),失败态按空数组降级渲染。
- endpoints / replicasets 拉取 403(权限):对应行/区不渲染,主链(Ingress→Service→Workload→Pods)不受影响。
- `repairServiceSelector` / `saveExpose` / `saveIngressMap`:保持既有 `{ok}` 契约处理(失败保留弹窗、错误 toast 由 store 层 notify)。

## 5. 测试策略

- **纯函数 → 自研零依赖运行器**(`logic/topology.js` 全函数 + `workloadMeta.podTemplateLabels`):覆盖 CronJob / 多 RS 并存 / 前缀让渡 / defaultBackend / 半坏 endpoints / 空模板兜底等边界。
- **组件级 → vitest**(扩展现有 `NsWorkloadDetail.selector-guard.test.js` 挂载模式):拓扑 Tab 渲染断言——A1 过滤与「+N」行、A3 计数与 ⚠ 徽标、B1 骨架 vs 空态、CronJob 卡 schedule、hover 联动 class、RS 分组、C7 两档文案。
- **回归锁**:A2 换源后现有 selector-guard 全套必须全绿(守卫面换源不换语义)。
- **门禁全家桶**:`npm test` + `npm run test:unit` + `npm run typecheck` + `npm run i18n:check` + `npm run build`。

## 6. i18n

新增 UI 文案全部 zh/en 双份进 `src/locales/*.json`(`workload.topology.*` 命名空间续延),过 `npm run i18n:check` 门禁(含 `{'@'}` 转义与 v-html 约定)。

## 7. 交付形态

worktree 分支 `worktree-feat+topology-overhaul` 上 SDD 分任务执行;门禁全绿 + 手测清单核验后 `--no-ff` 合回 main(用户 2026-08-30 约定);提交作者恒 `aliangone <aliangone@gmail.com>`,禁 Claude 尾注。

## 8. 非目标

- 不做拓扑图画布/拖拽缩放(被否备选②)。
- 不扩网关 family watch 通道(7→8 路 HPA watch;HPA/RS/Endpoints 走轮询已够)。
- 不动 Network Tab 结构与 ownerReferences 归属链组件 `ResourceTopology.vue`(PodDetail)。
- 不在本特性内完成 NsWorkloadDetail 整体拆分(仅迁出拓扑域一角)。
