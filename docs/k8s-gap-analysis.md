# AliangBoard 与真实 Kubernetes 的差距分析

> 本报告整合「能力清单 / 声明核验 / 差距分类 / 修复路线图」为单一文档，结论先行。
> 证据基准：`main` 分支当前工作树（2026-08-07）。所有 `file:line` 均为本次实地核对所得，非转录记忆。
> 核对方式：直读 `server/index.mjs`（Node `http` + `ws`，`undici` 透传真实 K8s API）与 `src/stores/cluster.js`（资源水合/CRUD），逐条比对 README「已接入真实集群的能力」与「当前边界」。

---

## 0. 顶部摘要（结论先行）

AliangBoard 的网关是**真实 K8s API 的透明代理**（`server/index.mjs:1456` 起 `/api/k8s/*` 透传），而非 Mock 驱动。绝大多数「读 / 写 / 运维」能力直连 apiserver，README 的核心声明**经核实属实**。差距集中在三个方向：**可观测深度（指标维度薄）、部分批处理资源无专属管理页、生态集成缺失（Helm/GitOps/告警）**——这三类 README「当前边界」均已诚实声明。

| 域 | 定性 | 一句话结论 |
|---|---|---|
| 资源读 / 列表 / 详情（27+ kind） | ✅ 真实达标 | 核心资源全部走真实 K8s API（`cluster.js:2271` / `2386`） |
| 结构化创建表单（21+ kind） | ✅ 真实达标 | SSA 落库，`generateYAML` 覆盖 service/ingress/cm/secret/pvc/pv/sc/workload/np/hpa/rq/lr/role/sa 等（`cluster.js:2505+`） |
| Pod 运维（exec/attach/logs/cp/debug） | ✅ 真实达标 | 全部直连 apiserver，exec 走 WS（`server/index.mjs:1785`），attach `:561`，cp `:1251/:1216`，ephemeral `:657/:1369` |
| 工作负载生命周期（scale/restart/rollback） | ✅ 真实达标 | scale `cluster.js:999`、rollout undo `:1041` |
| 节点运维（cordon/uncordon/drain） | ✅ 真实达标 | 真实 `policy/v1 Eviction`（`cluster.js:1558` + `:1569`） |
| 端口转发 / can-i(SSAR) / 多集群 / 拓扑 | ✅ 真实达标 | portforward `server/index.mjs:1188`、SSAR `RbacCanI.vue:58` |
| 可观测（MonitoringCenter） | ⚠️ 部分受限 | 仅 metrics-server 的 CPU/内存，30 样本滚动窗（≈5min），**无网络/磁盘 IO、无历史回看、无告警** |
| Job / CronJob 管理 | ⚠️ 部分受限 | 走通用 Workload 通道 + CronJob 触发，**不在全局水合、无专属列表/详情页** |
| 工作负载深度编辑 | ⚠️ 部分受限 | 编辑仅 image/replicas/labels/tier；env/probes/卷/调度仅创建向导支持（`cluster.js:865`） |
| 审计 | ⚠️ 部分受限 | AuditLogs 页展示集群 Events，非用户级 who/verb/IP 审计（README:111） |
| `/clusters` 集群卡片计数 | ⚠️ 部分受限 | localStorage 驱动、假默认、无真实 node/pod 计数（`cluster.js:102`）；真实计数仅在 `/admin/clusters` |
| Helm / GitOps / 告警 / 服务网格 | ❌ 缺失 | README:112 已声明未接入；服务网格为非目标 |

**一句话总评**：作为一个纯 JS（Vue3 + Node `http`，零重运行时依赖）自研 K8s 面板，AliangBoard 在「资源 CRUD + Pod/节点运维 + 多集群」主干上已达到对标 Lens/Kuboard 的真实可用程度；与「真实 K8s 完整生态」的差距主要是**生态工具链集成**与**指标/批处理资源的深度**，而非协议正确性。

---

## 1. 能力清单（已落地、经核实为真实）

### 1.1 资源读写与同步
- **核心资源水合**：`cluster.js:2271-2284` `hydrateCoreResources` 并发拉取 nodes / pods / namespaces / deployments / statefulsets / daemonsets / replicasets / services / ingresses / events / nodes.metrics / pods.metrics——全部 `api.k8s()` 透传至真实 apiserver。
- **扩展资源水合**：`cluster.js:2386-2405` `hydrateExtendedResources` 拉取 configmaps / secrets / pvc / endpoints / serviceaccounts / resourcequotas / limitranges / pv / networkpolicies / hpa / pdb / roles / rolebindings / clusterroles / clusterrolebindings / storageclasses。容忍 RBAC 403（`:2408-2409` 逐项 catch）。
- **CRD + 自定义资源实例**：`cluster.js:2434` `hydrateCRDs`；CR 实例 CRUD 走通用 SSA（`cluster.js` `applyCRYaml`/`deleteCRInstance`，README:10）。
- **结构化创建表单**：`generateYAML` 覆盖 `cluster.js:2505`(service) / `:2550`(ingress) / `:2594`(configmap) / `:2615`(secret) / `:2630`(pvc) / `:2648`(pv) / `:2666`(storageclass) / `:2684`(workload: deploy/sts/ds/job/cronjob) / `:2777`(networkpolicy) / `:2810`(hpa) / `:2838`(resourcequota) / `:2858`(limitrange) / `:2881`(role) / `:2893`(serviceaccount)，外加 rolebinding(`:1425`) / clusterrolebinding(`:1463`) / pdb(`:1496`) / ingressclass(`:781`) / runtimeclass(`:800`) / priorityclass(`:1514`)。
- **通用 YAML 编辑（kubectl edit 语义）**：详情页 YamlEditor `@save` → `applyResourceYaml` → `/api/apply`（SSA）。28 个详情页接入 YamlEditor。
- **集群级资源浏览器**：`ClusterResourceList.vue:22-65` 一组件驱动 APIServices / Mutating+Validating Webhooks / ReplicaSets / CSINodes（路由 `router/index.js:160-184`）。

### 1.2 Pod 运维（全部直连真实 apiserver）
- **Exec 终端**：WebSocket `/api/exec`（`server/index.mjs:1785`），`@kubernetes/client-node` 处理 SPDY/WS 升级。
- **Attach**：`server/index.mjs:561-563` `new Attach(kc).attach(...)`（kubectl attach 语义）。
- **日志**：流式透传 `follow=true`（`server/index.mjs:1492` 起 isStreaming 分支），多容器选择（Pod `containers` 数组 `cluster.js:1777`）。
- **文件浏览（kubectl cp）**：`server/index.mjs:1251` `/api/podfile/*`（列/预览/下载/上传，一次性 exec 落地容器文件）；`:1216` `/api/pvcfile/*`。
- **调试容器注入（kubectl debug）**：`server/index.mjs:1369` `/api/pod/debug` → `attachEphemeral` `:657`（`pods/ephemeralcontainers` update）。
- **Pod 删除**：透传 DELETE（乐观删除 + 回滚 + 全局错误提示，README:11）。

### 1.3 工作负载生命周期
- **扩缩容**：`cluster.js:999` `scaleWorkload`（PATCH `/scale`）。
- **滚动重启**：定点 patch template 注解触发。
- **回滚（rollout undo）**：`cluster.js:1041` `rollbackWorkload`，按目标 ReplicaSet 完整 template 还原（revision 注解来自 `:2278` replicasets 拉取）。

### 1.4 节点运维
- **Cordon / Uncordon**：`cluster.js:1531` / `:1544`（PATCH `unschedulable`）。
- **Drain**：`cluster.js:1558` cordon 后逐 Pod 创建 `policy/v1 Eviction`（`:1569`）——真实驱逐语义，非模拟。

### 1.5 网络 / 端口转发 / 镜像
- **端口转发**：`server/index.mjs:1188` `/api/portforward`，Service/Deployment 经 endpoints 解析到后端 Pod，网关本机开本地监听。
- **镜像仓库版本选择器**：`server/index.mjs:1406` `/api/registry/tags`（registry v2，支持自签/明文回退/basic auth）。

### 1.6 RBAC / 多集群 / 拓扑 / 触发
- **can-i（服务端真值）**：`RbacCanI.vue:58-63` `store.checkAccessServer` → `selfsubjectaccessreviews`；保留本地规则推演。
- **资源归属拓扑**：`server/index.mjs:1439` `/api/resource_tree`（沿 ownerReferences）。
- **CronJob 手动触发**：`server/index.mjs:1391` `/api/cronjob/trigger`（`kubectl create job --from` 语义）。
- **多集群切换/重连**：`cluster.js:102` clusterList（localStorage 持久化）+ `hydrateCoreResources` 重水合。

### 1.7 平台底座（API-key / MCP / Agent / 审计）
- API-key 工具路由：`server/index.mjs:1063` `/api/key/*`；MCP：`:789`；Agent：`:795`；审计 `:1687`（active/log/verify，哈希链）。此层独立于 K8s 资源管理，本次仅记录其存在，不展开。

---

## 2. 声明核验（README「已接入」逐条比对代码）

| README 声明（行号） | 核实证据 | 结论 |
|---|---|---|
| Token/Basic/kubeconfig 连接（:7） | `server/index.mjs` `/api/session` 支持 token/basic/kubeconfig，undici dispatcher 透传 ca/cert/key | ✅ 真实 |
| 全量资源同步（:9） | `cluster.js:2271` / `:2386` 真实 API 列表 | ✅ 真实（27+ kind，见 §3-G8 Job/CronJob 注） |
| 结构化创建 SSA（:10） | `cluster.js` `generateYAML` + `remoteCreate` 走 `/api/apply` | ✅ 真实（21+ kind） |
| 列表删除乐观+回滚（:11） | `remoteDelete` + 回滚闭包 | ✅ 真实 |
| Pod 删除 + 真实日志（多容器）（:12） | DELETE 透传 + `follow` 流式 + containers 数组 | ✅ 真实 |
| 扩缩容/滚动重启/回滚（:13） | `cluster.js:999` / `:1041` | ✅ 真实 |
| Cordon/Uncordon/Drain（Eviction）（:14） | `cluster.js:1531/1544/1558` + `:1569` eviction | ✅ 真实 |
| Exec 终端（:15） | `server/index.mjs:1785` WS | ✅ 真实 |
| 端口转发（:16） | `server/index.mjs:1188` | ✅ 真实 |
| 文件浏览 kubectl cp（:17） | `server/index.mjs:1251/1216` | ✅ 真实 |
| 调试容器注入（:18） | `server/index.mjs:1369/657` | ✅ 真实 |
| Pod Attach（:19） | `server/index.mjs:561` | ✅ 真实 |
| 资源拓扑 ownerReferences（:20） | `server/index.mjs:1439` | ✅ 真实 |
| Events 实时 watch + 过滤（:21） | isStreaming `watch=true` 透传 `server/index.mjs:1492` | ✅ 真实 |
| CronJob 手动触发 + 导出 YAML（:22） | `server/index.mjs:1391` + k8s 透传 `-o yaml` | ✅ 真实 |
| 顶栏全局搜索（:23） | 跨资源/命名空间检索 | ✅ 真实 |
| Namespace 应用分层（:24） | `useLayering.js` 启发式 + `layer.aliangboard.io` label | ✅ 真实 |
| 多集群切换/移除（:25） | `cluster.js:102` + `switchCluster` | ✅ 真实 |
| API Discovery 驱动 SSA（:26） | `/api/apply` server-side apply | ✅ 真实 |
| 部署向导多 YAML 文档（:27） | `/api/apply` 多文档 | ✅ 真实（注：原子性见 §3-G9，已于 2026-08-07 修复为部分成功语义） |
| 连真实集群清 Mock（:28） | `remoteMode` 分支 | ✅ 真实 |

**README「当前边界」逐条核验（:107-113）**：exec/portforward/文件浏览仅真实集群生效（✓ 一致）、端口转发本机监听（✓ 一致）、exec 默认 `/bin/sh` + ephemeral 容器（✓ 一致）、会话仅内存+localStorage（✓ 一致）、审计页=集群 Events（✓ 一致）、Helm/GitOps/告警未接入（✓ 一致，见 §3-G1）、HPA/PDB 依赖 autoscaling/v2·policy/v1（✓ 一致，`cluster.js:2398-2399` 硬编 v2/v1）。

> **核验结论**：README 全部 22 条「已接入」声明与 7 条「边界」声明**与代码一致，无夸大**。本报告 §3 的差距是对 README 边界的**细化与补充**，不存在矛盾（详见 §5 自检②）。

---

## 3. 差距分类（每条含 证据 / 定性 / 优先级 / 依赖）

定性图例：✅真实达标 · ⚠️部分受限 · ❌缺失。
优先级：P0 阻断/安全 · P1 高 · P2 中 · P3 低。

### 3.1 生态工具链集成（README:112 已声明未接入）

| ID | 差距 | 定性 | 证据(file:line) | 优先级 | 依赖 |
|---|---|---|---|---|---|
| G1 | **Helm**：无 release 管理 / 无 values 渲染 / 无 rollback | ❌缺失 | 全仓无 helm 依赖或路由（`grep helm src/ server/` 仅命中 layering/mock） | P2 | 引入 helm SDK 或对接 tiller-less |
| G2 | **GitOps**：无 ArgoCD/Flux 同步状态展示 | ❌缺失 | 无 argocd/flux 引用 | P3 | 选定 GitOps 引擎后接 Application CR |
| G3 | **告警**：无 Alertmanager / 无告警规则 / 无静默 | ❌缺失 | `grep alertmanager src/`（非 mock/非 locales）为空 | P2 | Prometheus/Alertmanager 数据源 |

### 3.2 可观测深度（最显著的「部分」差距）

| ID | 差距 | 定性 | 证据(file:line) | 优先级 | 依赖 |
|---|---|---|---|---|---|
| G4 | **指标维度薄**：仅 CPU/内存（metrics-server），无网络 RX/TX、无磁盘 IO | ⚠️部分 | `MonitoringCenter.vue:14-15` 仅 cpu/mem series；`grep -rE 'rxBytes\|txBytes\|networkIO' src/` 空；指标源 `cluster.js:2282-2283` 仅 nodes.metrics/pods.metrics | P1 | kubelet `/metrics/cadvisor`（需额外 RBAC）或接 Prometheus |
| G5 | **无历史回看**：仅 30 样本滚动窗（≈5min 实时），无时间范围查询 | ⚠️部分 | `MonitoringCenter.vue:15` `.slice(-MAX)`；无时序存储 | P2 | 时序库（Prometheus/VM） |
| G6 | **无聚合监控大屏**：无 Prometheus/Grafana 嵌入或 datasource 抽象 | ⚠️部分 | `MonitoringCenter.vue` 全自研 MiniChart（纯 SVG） | P3 | G4/G5 先行 |

### 3.3 批处理资源（Job/CronJob）管理深度

| ID | 差距 | 定性 | 证据(file:line) | 优先级 | 依赖 |
|---|---|---|---|---|---|
| G7 | **Job/CronJob 不在全局水合**：工作负载列表永不显示 Job/CronJob（namespace 详情的 jobs 计数恒为 0） | ⚠️部分 | `cluster.js:296` 注释明确「不在 hydrateCoreResources」；workloadList 仅由 deploy/sts/ds 构建（`:2339-2344`）；`:245` jobs 计数依赖未填充的 workloadList | P1 | — |
| G8 | **无专属 Job/CronJob 列表/详情页**：无 Job 执行历史、无 CronJob schedule 视图、无 suspend/resume、无 Job 日志聚合 | ⚠️部分 | `ls src/views/ \| grep -iE 'job\|cron'` 为空；仅 `cluster.js:298/908-909/2704-2722` 通用通道 + `:1391` 触发 | P2 | G7 |

### 3.4 编辑深度与一致性

| ID | 差距 | 定性 | 证据(file:line) | 优先级 | 依赖 |
|---|---|---|---|---|---|
| G9 | **部署 `/api/apply` 原子性**：多资源 apply 历史上非原子（成功资源残留）；**已于 2026-08-07 修复**为「逐资源 try/catch，仅全失败才 422」 | ⚠️→✅ | `server/index.mjs` applyYaml 逐资源；`cluster.js` `applyResourceYaml` 解析 partial。**注：服务端需重启才生效** | P0(已修) | 重启后端 |
| G10 | **工作负载编辑远浅于创建向导**：编辑仅 image/replicas/labels/tier；env/resources/probes/卷/调度仅创建支持 | ⚠️部分 | `cluster.js:865-873` remotePatch 仅定点改 metadata.labels/spec.replicas/spec.template.image；注释 `:850`「Job/CronJob 不支持定点编辑回退仅本地」 | P2 | — |
| G11 | **ClusterRole/ClusterRoleBinding/Namespace 仅 YAML 编辑**（无结构化表单） | ⚠️部分 | createXxx 存在但无结构化 update 表单分支（`cluster.js:1376-1463`） | P3 | — |

### 3.5 集群/平台层数据真实性

| ID | 差距 | 定性 | 证据(file:line) | 优先级 | 依赖 |
|---|---|---|---|---|---|
| G12 | **`/clusters` 页假数据**：localStorage 驱动、`status‖'Healthy'`/`distribution‖'Kubernetes'` 假默认、无真实 node/pod 计数（真实探测仅在 `/admin/clusters`） | ⚠️部分 | `cluster.js:102-103` clusterList；真实探测 `server/cluster-probe.mjs` 仅接 `/api/admin/clusters` | P1 | 前端数据层重构（Vue Query，进行中） |
| G13 | **审计为集群 Events**：非用户级 who/verb/IP/HTTP code | ⚠️部分 | `AuditLogs.vue`；README:111 已声明（标准 K8s API 不提供） | P2 | 集群开启 audit logging + 日志后端 |

### 3.6 集群范围资源浏览器覆盖

| ID | 差距 | 定性 | 证据(file:line) | 优先级 | 依赖 |
|---|---|---|---|---|---|
| G14 | **部分集群级资源无专属浏览器**：Lease / FlowSchema / PriorityLevelConfiguration / CertificateSigningRequest / ValidatingAdmissionPolicy(1.30) 等无列表页（可通过通用 YAML/SSA 通道操作，但无浏览） | ⚠️部分 | `ClusterResourceList.vue:22-65` 仅覆盖 apiservices/webhooks/replicasets/csinodes | P3 | 扩展 KINDS 字典 |

> 说明：CR 实例（含 VolumeSnapshot/CiliumNetworkPolicy 等 88+ CRD）经通用 CRD 路径 CRUD，**不计为缺失**；Ingress rules（`NsIngressDetail.vue:87`）与 NetworkPolicy rules（`NsNetworkPolicyDetail.vue:132/209/250`）**现已结构化编辑**（早先记忆标注为「仅 YAML」已过时，本次实地核对修正）。

---

## 4. 修复路线图（按依赖与收益排序）

### Phase 0 — 已完成 / 收尾（无新开发）
- [x] **G9** apply 原子性（2026-08-07 已修复，待重启后端验证）
- [x] 5 视图白屏（`SelectCluster.vue:9` 等，已补 `useI18n`）

### Phase 1 — 真实性收敛（P1，消除「假数据 / 看不见」）
1. **G12** `/clusters` 页接真实探测：复用 `server/cluster-probe.mjs`，让 localStorage 驱动的 clusterList 显示真实 status/nodeCount/podCount。依赖前端数据层重构（Vue Query，`docs/superpowers/specs/data-model-audit.md`）。
2. **G7** Job/CronJob 纳入工作负载水合：在 `hydrateCoreResources`(:2271) 增加 batch/v1 jobs/cronjobs 拉取，或在 Workloads 列表页改惰性 Query 消费（与数据层 Plan 3 一并做）。
3. **G4** 指标维度扩展：新增 kubelet `/metrics/cadvisor` 抓取网络/磁盘（网关新端点，需 RBAC `nodes/metrics`）。

### Phase 2 — 深度补齐（P2）
4. **G8** 专属 Job/CronJob 列表+详情页（执行历史/schedule/suspend/Job 日志聚合）。
5. **G3** 告警：接 Alertmanager `/api/v2/alerts` + 静默管理。
6. **G10** 工作负载深度编辑：复用 DeployApp 向导的字段映射，支撑 env/resources/probes/卷/调度的定点编辑。
7. **G13** 用户级审计：网关侧已记录 MCP/API-key 调用（`server/audit.mjs`），补「最近活跃 key / who-verb-IP」视图（仓库已有 `docs/superpowers/plans/2026-08-06-mcp-audit-viewer.md` 待建）。
8. **G5/G6** 时序回看：引入 Prometheus datasource 抽象。

### Phase 3 — 生态与长尾（P3）
9. **G1** Helm release 管理（SDK 或 tiller-less）。
10. **G2** GitOps 同步状态（ArgoCD/Flux Application CR 只读展示）。
11. **G11/G14** 结构化编辑与集群级资源浏览器补齐（Lease/APF/CSR 等）。

---

## 5. 自检与边界

### 自检① —— 每个差距条目四要素完整性
§3 全部 14 条差距（G1–G14）均含：**证据(file:line)**（实地核对，非转录）、**定性**（✅真实/⚠️部分/❌缺失）、**优先级**（P0–P3）、**依赖**（含外部前置或内部任务 ID）。✅ 通过。

### 自检② —— 与 README「当前边界」一致性
- README「已接入」22 条（:5-28）逐条核验**全部属实**（§2 表）。
- README「当前边界」7 条（:107-113）**与代码一致，无矛盾**。
- §3 差距是 README 边界的**细化**：
  - G1-G3（Helm/GitOps/告警）= README:112「Helm、GitOps、告警尚未接入」的展开 ✅ 一致。
  - G13（审计）= README:111 的展开 ✅ 一致。
  - HPA/PDB 版本依赖 = README:113 ✅ 一致（`cluster.js:2398-2399` 硬编 autoscaling/v2、policy/v1）。
  - **G4-G8/G10/G12/G14 为 README 未单列的「部分」项**（README 未声明它们「完整」，故非矛盾，属补充披露）。本报告在 §0 摘要与 §3 已显式标注为「⚠️部分受限」，与 README「已接入」表述无冲突。
- **对早先内部记忆的修正**（非 README 矛盾）：Ingress rules / NetworkPolicy rules 现已结构化编辑（`NsIngressDetail.vue:87`、`NsNetworkPolicyDetail.vue:132`），早先「仅 YAML」结论已过时，本报告以代码为准。✅ 通过。

### 自检③ —— 未修改可执行代码
- 本任务为只读分析 + 单一文档产出。**全程未修改 `src/` / `server/` / `scripts/` 任何可执行代码**。
- 预期 `git status` 仅新增 `docs/k8s-gap-analysis.md`（本文件）。
- 注：会话开始时 `git status` 已存在的 `src/**` / `server/index.mjs` 等「M / ??」项（如 `server/cluster-probe.mjs`、5 视图白屏修复、apply 原子性修复）为**本任务之前的既有改动**（README 声明核验依赖这些已落地修复），非本次产生。最终 `git status` 以实跑结果为准（见下方验证）。

### 边界声明（本报告不覆盖）
- **平台底座（API-key / MCP / Agent / 审计链）**不在「与真实 K8s 差距」范畴，仅 §1.7 记录其存在，未做深度核验。
- **未连真实集群实测**：本次为**静态代码核对 + README 声明比对**，未在真实集群上端到端跑用例（G9 的运行时行为依据既有的 2026-08-07 QA 实测记录，标注「需重启后端验证」）。
- **依赖与版本敏感**：HPA/PDB/EphemeralContainers 等依赖集群 K8s 版本（README:113、:109），低版本集群对应能力会失败——属环境前提，非代码缺陷。

### 关于「Allowed roots: …/workspace」与产出路径
- 任务契约 `Allowed roots` 字段为 `…/workspace`，但**该目录当前不存在**，且任务描述与自检要求明确：「整合为单一 `docs/k8s-gap-analysis.md`」「`git status` 应仅 docs/ 有新增」。二者均指向仓库 `docs/`。
- 为满足**自检③的硬性要求**（git status 仅 docs/ 新增），本文件写在 `docs/k8s-gap-analysis.md`（而非 `workspace/`）。若需改落 `workspace/`，请以 `goal_replan_required` 反馈，但这将使自检③无法成立。此处显式说明该字段与任务体/自检要求的出入，未擅自忽略任一约束。
