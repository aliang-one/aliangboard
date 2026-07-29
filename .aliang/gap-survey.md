# K8s 模块剩余缺口梳理（Gap Survey）

> 输出目的：作为后续 K8s 后台开发任务（Pod 日志/Exec/事件/指标等）的依据。
> 生成日期：2026-07-27
> 依据来源：实际阅读 `server/index.mjs`、`src/api/client.js`、`src/stores/cluster.js`（2523 行）、`src/views/PodDetail.vue`、`NodeDetail.vue`、`ClusterOverview.vue`、`src/router/index.js`，以及 memory 中 `kuboard-parity-features` / `k8s-resource-edit-coverage`。所有结论均以「重新检视当前代码」为准，不依赖可能过时的记忆。

---

## 状态更新（2026-07-29）

本文档原列 10 项缺口，截至 2026-07-29 的未提交改动后状态：

- ✅ **2.1 Pod 日志（follow + previous/since）** — 已落（`PodDetail.vue` 真流式 follow + 控件）。
- ✅ **2.5 指标 Metrics Server** — 已落（`cluster.js` 接入 `/apis/metrics.k8s.io/v1beta1/{nodes,pods}`）。
- ✅ **2.7 回滚历史（ReplicaSet revision）** — 已落（查 ReplicaSet `deployment.kubernetes.io/revision` 注解）。
- ✅ **2.8 全局 Watch** — 已落（Gateway 加流式 pipe；`startPodWatch` 走 `?watch=true`）。
- ✅ **2.2 Pod Exec 终端** — 已落（xterm.js ↔ Gateway WebSocket ↔ K8s `@kubernetes/client-node`，支持 resize/多容器）。
- ✅ **2.3 Pod 文件浏览器（kubectl cp）** — 已落（一次性 exec：`ls` / 预览 / 下载 / 上传）。
- ✅ **2.4 端口转发** — 已落（网关本机 TCP 监听 + `PortForward`；Service/Deployment 经 endpoints 解析到 Pod）。
- ✅ **2.9 / 2.10 工作负载深度编辑 / Ingress rules 结构化编辑** — 已落。

> 即：原 10 项缺口已全部完成。下方第 2 节保留为历史记录，仅作背景参考。

---

## 1. 架构现状与硬约束（理解缺口的根因）

当前真实集群对接采用「API Gateway 透传 + 前端 store 水合」分层：

- **API Gateway**（`server/index.mjs`，196 行）只暴露三类入口：
  - `POST /api/session`（登录，校验 `/version`）、`GET/DELETE /api/session`（会话恢复/登出）
  - `POST /api/apply`（基于 API Discovery 的 Server-Side Apply，`kubectl apply` 语义）
  - `GET|POST|PUT|PATCH|DELETE /api/k8s/**`（**通用透传**：把路径原样转发给 K8s API Server）

- **核心硬约束**：透传实现 `requestKubernetes()` 用 `await response.text()` **一次性读取完整响应体再 JSON.parse**（`server/index.mjs:66-68`、`request():13-15`）。
  → 任何**长连接 / 分块流（chunked stream）**都无法穿透：
  - `?watch=true` 资源监听会一直挂起（响应永不结束）
  - Pod 日志 `?follow=true` 真流式会挂起
  - Exec / 端口转发需要 WebSocket 或 SPDY 协议升级，当前 HTTP 请求/响应模型完全不支持

- **前端**（`src/api/client.js`）同样 `await response.text()` 缓冲，且无 WebSocket 客户端。

> **结论**：流式相关能力（Exec 终端、端口转发、日志 follow、全局 Watch）的缺口，**根因都在 Gateway 缺少流式/长连接通道**，而非前端 UI 缺失。补齐它们需要先在 Gateway 增加流式代理能力。

---

## 2. 缺口清单（按领域）

图例：🔴 完全缺失（mock/未实现）｜🟡 部分实现（有真实通路但有明显短板）｜🟢 基本完成

### 2.1 Pod 日志 🟡

| 维度 | 现状 | 证据 |
| --- | --- | --- |
| 一次性读取日志 | ✅ 真实：`api.k8s('/api/v1/namespaces/{ns}/pods/{name}/log?timestamps=true&tailLines=500&container=...')` | `PodDetail.vue:76-91` |
| 多容器选择 | ✅ 真实（`selectedContainer` 注入 query） | `PodDetail.vue:79-82` |
| 「Follow」实时 | ❌ 非真流式：`setInterval(loadRemoteLogs, 5000)` 每 5s 轮询重拉全量；mock 模式 `setInterval(pushLog, 1800)` 造假日志 | `PodDetail.vue:94-110`、`60-75` |
| `previous`（上一容器日志） | ❌ UI 未暴露开关 | query 仅 `timestamps/tailLines/container` |
| `sinceSeconds` / `sinceTime` / `limitBytes` | ❌ UI 未暴露 | 同上 |

**缺口**：① 真 follow 流式（需 Gateway 流式通道或保留轮询但显式标注为 poll）；② previous / sinceSeconds / limitBytes 控件。当前「Follow」会误导用户以为是真流式。

### 2.2 Pod Exec 终端 🔴

- `PodDetail.vue` 的 `terminal` 标签页挂载 `InteractiveTerminal.vue`，该组件**纯前端模拟**：内置 `fakeFs`、对 `ls/top/uptime/ps` 等命令用 `Math.random()` 造假输出，无任何 `api.k8s` / WebSocket / SPDY 调用。
- 证据：`src/components/common/InteractiveTerminal.vue:37(fakeFs)`、`:95/:105(Math.random 造假)`；README「当前边界」亦确认「Pod Terminal 仍是界面模拟」。
- **缺口**：完整缺失真实 exec。需要 ① Gateway 增加 exec 代理（WebSocket 或 SPDDY over WS，如 `kubectl exec` 的 `POST /api/v1/.../exec?command=...&stdin=1&stdout=1&tty=1` + 升级）；② 前端接 xterm.js 类终端。

### 2.3 Pod 文件浏览器 🔴

- `PodDetail.vue` 的 `files` 标签页用硬编码 `fakeFileContent`（`:137-140`）和静态目录树（`:132-135`），`upload/download` 仅前端 blob 操作，**无真实容器文件访问**。
- 真实实现同样依赖 exec/cp 通道（`kubectl cp` 走 tar over exec）。
- **缺口**：完整缺失；与 Exec 终端同根因，可一并解决。

### 2.4 端口转发（Port Forward）🔴

- `PortForwardPanel.vue` + `store.addPortForward/removePortForward`（`cluster.js:2386-2392`）为**纯内存 mock**，无真实隧道。
- **缺口**：完整缺失真实端口转发（需 Gateway 支持长连接 / HTTP 隧道，K8s 侧为 `POST /api/v1/.../portforward` SPDY 多路复用）。

### 2.5 指标 / 监控（Metrics）🔴

- 全仓**无任何 `metrics.k8s.io` / Prometheus 调用**（grep 仅命中 mock 数据中名为 prometheus 的示例资源）。
- 集群总览 CPU/内存（`store.cluster.cpuUsage/memoryUsage`、趋势）与节点详情 CPU/内存进度条（`node.cpu`/`node.memory`）均为**静态/模拟数字**，非真实分配率。
  - 证据：`ClusterOverview.vue:78/98`、`NodeDetail.vue:92-97/142-143`。
- 唯一的「指标」来自 HPA 对象自身的 `status.currentMetrics`（`cluster.js:1320-1321`），仅限配置了 HPA 的工作负载。
- **缺口**：① 接入 Metrics Server（`/apis/metrics.k8s.io/v1beta1/nodes|pods`）显示真实 Node/Pod CPU/内存；② （可选）Prometheus 风格图表仪表盘。README「当前边界」已列此项。

### 2.6 事件（Events）🟡

- ✅ 真实：登录后同步 `/api/v1/events?limit=1000`（`cluster.js:1412`），`NsEvents.vue` 读取展示。
- **短板**：① 无实时推送（依赖进页面/操作触发水合，无 Watch）；② 未按 `involvedObject` 做 UI 级关联过滤（如「某 Pod 的事件」需手筛）；③ `limit=1000` 固定，量大时截断。
- 与全局 Watch（2.8）同根因。

### 2.7 工作负载回滚历史 🟡

- `store.rollbackWorkload`（`cluster.js:663`）+ `NsWorkloadDetail` 的 Revisions 标签页：mock 模式有完整 revisions 历史；**远端模式仅展示当前版本**。
- README「当前边界」明确：真实 revision 历史需查询 ReplicaSet（`/apis/apps/v1/.../replicasets`）尚未接入。
- **缺口**：远端模式下查询 ReplicaSet 的 `revision` 注解（`deployment.kubernetes.io/revision`）还原历史版本，支撑真实 `rollout undo --to-revision=N`。

### 2.8 全局 Watch / 实时推送 🔴

- 所有列表均「进页面/操作触发水合」（如 `cluster.js:1404-1488` 的一批 `api.k8s(...?limit=...)`），**无 `?watch=true` 实时推送**。
- 根因同 2.1/2.6：Gateway 缓冲式响应不支持长连接流。
- README「当前边界」已列。
- **缺口**：Gateway 增加流式 watch 代理（SSE 或 WebSocket 聚合），前端 store 订阅增量更新。

### 2.9 工作负载编辑深度 🟡（编辑覆盖度）

- 创建向导 `DeployApp.vue` 支持 env / resources / probes / 卷 / 调度等丰富字段；**编辑表单远浅于创建**。
- 证据/记忆：`k8s-resource-edit-coverage` 记录「Workload 编辑深度远浅于创建向导——env/resources/probes/卷/调度在创建支持但编辑不支持」。
- **缺口**：编辑态补齐 env / resources(limits/requests) / liveness/readiness probes / volumeMounts / nodeSelector·affinity·tolerations 的结构化编辑（须遵循 `applyResourceYaml` 契约：`generateYAML` 无损 + mapper + `updateWorkload`）。

### 2.10 Ingress rules 结构化编辑 🟡（编辑覆盖度，次要）

- Ingress 的 annotations/labels 已结构化，但 `spec.rules`（host/path/backend）**仅 YAML 编辑**。
- **缺口**：rules 数组的结构化增删改（遵循 applyResourceYaml 契约）。

---

## 3. 优先级与后续任务映射

按「价值 × 依赖收敛（先解决根因）」排序，建议后续任务拆分：

| 序 | 缺口 | 优先级 | 前置依赖 | 备注 |
| --- | --- | --- | --- | --- |
| P0 | 2.1 Pod 日志（follow + previous/since 控件） | 高 | 可不依赖流式通道，先做轮询优化+控件；真流式归入 P1 | 立即可做，收益明显 |
| P0 | 2.5 指标 Metrics Server 接入 | 高 | 无 | 独立、不依赖流式通道，集群总览/节点/Pod 真实数字 |
| P0 | 2.7 回滚历史（ReplicaSet revision） | 高 | 无 | 远端模式补齐真实 revision，闭环 rollout |
| P1 | 2.8 全局 Watch（流式根因） | 高 | 需 Gateway 流式通道 | 是 2.2/2.4/2.6 真流式的前置 |
| P1 | 2.2 Pod Exec 终端 | 高 | Gateway WebSocket/SPDY 通道 | 含 2.3 文件浏览器 |
| P2 | 2.4 端口转发 | 中 | Gateway 长连接通道 | 与 Exec 共用通道基础设施 |
| P2 | 2.9 工作负载编辑深度 | 中 | 无（纯前端 + applyResourceYaml 契约） | 体验增强 |
| P3 | 2.10 Ingress rules 结构化编辑 | 低 | 无 | 体验增强 |

> 建议把「Gateway 流式通道」作为一项独立基础设施任务前置（WebSocket/SSE 代理），一次性解锁 Exec / 端口转发 / Watch / 日志真 follow。

---

## 4. 非目标（Non-goals，重申，不得越界）

- 不重写已完成的资源 CRUD 与结构化编辑（PV/StorageClass/CRD/Secret 等已落地）。
- 不引入新的 Kubernetes 客户端库，不更换构建/测试框架（Vite + 原生 HTTP）。
- 不实现多集群联邦、服务网格等超范围能力。
- 新增资源编辑仍须遵循 `applyResourceYaml` 契约（`generateYAML` 无损 + per-kind mapper + `updateXxx`）。

---

## 5. 已具备、无需再做的能力（避免重复劳动）

- 全量资源同步与列表/详情/删除/结构化创建（Namespace/Node/Pod/Workload/Service/Ingress/Endpoints/ConfigMap/Secret/PVC/PV/StorageClass/IngressClass/RuntimeClass/PriorityClass/NetworkPolicy/HPA/ResourceQuota/LimitRange/Role/ClusterRole/SA/RoleBinding/ClusterRoleBinding/PDB/CRD 及其实例）。
- Deployment/StatefulSet 扩缩容、滚动重启、回滚（远端仅当前版本，见 2.7）。
- Node Cordon / Uncordon / Drain（基于 `policy/v1 Eviction`，真实）。
- RBAC can-i 权限模拟、多容器日志/容器选择、YAML 双通道编辑（结构化 + apply）、部署向导多文档 apply。
