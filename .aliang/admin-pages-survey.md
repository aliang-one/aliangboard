# Admin 页面现状盘点（Survey）

> ⚠️ **本盘点已过时（2026-08-02 核注）**：以下「死按钮/桩」结论已被 commit 4ebe2f4「管理页接线」推翻——**Settings.Components 已实查 `/readyz`+`componentstatuses`（非 mock）、Custom Columns 已接 useTableColumns、RBAC Create/edit/delete、Configuration edit/delete/create、Clusters.Sync→hydrateCoreResources 均已 `@click` 接线**。本文件保留作历史快照，判断现状请以 `src/` 代码 + 记忆 [[kuboard-parity-features]] 为准。
> 同期新增：APIServices / Mutating & Validating Webhooks / ReplicaSets / CSINodes 列表页（`ClusterResourceList.vue`，路由 `/admin/*`），CR 实例 CRUD（`CrdDetail`），Gateway kubeconfig/client-cert 登录，can-i SelfSubjectAccessReview。

> 目的：盘点 AliangBoard 中「管理类 / 系统级」页面的现状（功能、真实通路 vs 桩、缺口），作为后续改造依据。
> 生成日期：2026-07-30
> 依据来源：重新阅读 `src/router/index.js`、`src/components/layout/{SideNavBar,TopNavBar}.vue`、各管理类 `src/views/*.vue`、`src/stores/cluster.js`、`README.md`。结论以当前代码为准。

---

## 0. 范围界定：本仓没有「Admin 专区」

- 导航（`SideNavBar.vue`）只有两组：全局 `CLUSTER` 列表 + `NAMESPACE` 作用域分组；**无独立的 Admin 分组**。
- 全仓唯一的 "Admin" 字样是顶栏用户头像旁的**纯展示文本**（`TopNavBar.vue:180`，写死 `Admin` + 头像 `A`），不代表角色。
- 不存在 board 级「用户 / 角色管理」：登录主体就是持有 Token/Basic Auth 的 K8s ServiceAccount，无平台账号体系。
- 因此本文把「admin 页面」理解为：**用于管理系统与集群级访问 / 配置的页面**（区别于「按 Namespace 浏览工作负载」），逐页盘点。

## 1. 现状矩阵

图例：🟢 真实通路可用（已接 API/store）｜🟡 部分真实（有死按钮/桩）｜🔴 桩或硬编码 mock

| 页面 | 路由 / 文件 | 作用域 | 现状 | 关键证据 |
| --- | --- | --- | --- | --- |
| Settings | `/settings` `Settings.vue` | global | 🟡 | 见 §2.1 |
| Configuration | `/configuration` `Configuration.vue` | global | 🟡（基本是桩） | 见 §2.2 |
| Clusters（集群管理） | `/clusters` `Clusters.vue` | global | 🟢 | 见 §2.3 |
| Audit Logs（活动记录） | `/audit-logs` `AuditLogs.vue` | global | 🟢 | 见 §2.4 |
| RBAC | `/rbac` `RBAC.vue` | global | 🟡 | 见 §2.5 |
| 权限模拟 can-i | `/rbac/can-i` `RbacCanI.vue` | global | 🟢 | 见 §2.6 |
| Nodes（运维） | `/nodes` `Nodes.vue` | global | 🟢 | 见 §3 |
| PriorityClasses | `/priorityclasses` `PriorityClasses.vue` | global | 🟢 | §3 |
| IngressClasses | `/ingressclasses` `IngressClasses.vue` | global | 🟢 | §3 |
| RuntimeClasses | `/runtimeclasses` `RuntimeClasses.vue` | global | 🟢 | §3 |
| CRDs | `/crds` `CrdList.vue` | global | 🟢 | §3 |
| Namespaces | `/namespaces` `Namespaces.vue` | global | 🟢 | §3 |

## 2. 平台 / 系统管理页（核心 admin）

### 2.1 Settings 🟡（`Settings.vue`，约 143 行）

四个 Tab：

- **General**：展示集群信息（name / version / apiServer / status / nodeCount / podCount），全部来自 `store.cluster.*` —— **真实**。
- **Components**：`components` 为**硬编码 mock**（`Settings.vue:15-22`，6 个组件恒为 `Healthy` + 静态 endpoint），**未接** `/api/v1/componentstatuses` 或 healthz。🔴
- **API Server**：endpoint 来自 store（真实），但「TLS Client Certificates / v1」为**静态文本**。
- **Custom Columns**：四个资源的「Edit Columns」按钮**无 `@click`**，纯 UI 桩，无持久化。🔴

**缺口**：① Components 改为真实组件状态；② Custom Columns 实现可勾选列并持久化（localStorage）；③ 整页无任何可写设置落盘。

### 2.2 Configuration 🟡（`Configuration.vue`，约 142 行）— 基本是桩 / 已被取代

- **ConfigMaps / Secrets** 两个 Tab：`DataTable` 数据来自 `store.configMapList/secretList`（真实），行点击有详情 Modal；但行内 **edit / delete 按钮无 `@click`**、顶部 **「Create New」无 `@click`**。🔴（有数据，无操作）
- **ResourceQuotas / LimitRanges / HPA** 三个 Tab：均为**空状态占位**，其中 ResourceQuotas 引导去 `/namespaces`，其余「Create」按钮无 `@click`。🔴
- **结论**：该全局页功能基本停留在 UI 壳，**真实 CRUD 已落在 Namespace 作用域页**（`NsConfigMaps` / `NsSecrets` / `NsResourceQuotas` / `NsLimitRanges` / `NsHPA` 均有真实 create + 经 `applyResourceYaml` 的结构化编辑）。该全局页属「遗留 / 半成品」，建议要么接线、要么移除。

### 2.3 Clusters（集群管理）🟢（`Clusters.vue`）

- 真实：列出已保存集群 `store.clusterList`，支持 **切换**（`switchCluster` `cluster.js:1142`）、**移除**（`removeSavedClusterStore` `:1155`，仅删列表不影响当前会话）、**进入概览**、搜索过滤、StatusChip 状态映射。✓
- 「添加集群」→ 跳 `/login`。✓
- **缺口**：顶部 **「Sync」按钮无 `@click`**（🔴 死按钮）；凭据仅存浏览器 localStorage，Gateway 重启后需重新登录（README「当前边界」已述）。

### 2.4 Audit Logs（活动记录）🟢（`AuditLogs.vue`）

- 真实：以集群 **Events** 作为活动记录展示（`store.eventList` + `startEventWatch` `cluster.js:1379`，`onMounted` 启动实时 watch，有 LIVE 指示）；统计（total/normal/warning）、按 type 过滤、按 reason/message/resource 搜索、点击 related 资源跳转详情。✓
- 诚实标注边界：K8s 标准 API 不直接暴露审计日志（需集群开启 audit logging 并对接日志后端），README「当前边界」同步说明。

### 2.5 RBAC 🟡（`RBAC.vue`）

- 真实：Roles / ClusterRoleBindings / ServiceAccounts 三 Tab，数据来自 `store.roleList/clusterRoleBindingList/saList`，行点击跳对应 Detail；顶部「权限模拟」按钮 → `RbacCanI`。✓
- **缺口**：顶部 **「Create Role」无 `@click`**、行内 **edit/delete 无 `@click`**（🔴）。真实 RBAC 创建/编辑已在 Namespace 作用域 `NsRBAC` + 各 Detail 页（经 `applyResourceYaml`）落地。

### 2.6 权限模拟 can-i 🟢（`RbacCanI.vue`）

- 真实：`store.checkAccess`（`cluster.js:2740`）基于已同步的 Role/ClusterRole/Binding 规则做**客户端推演**，返回 `allowed/matchedBy/rule`；subject 由现有 Binding 自动补全、namespace 由 namespaceList 补全。✓
- 注意：这是**客户端规则推演**，非 `SelfSubjectAccessReview`（服务端真值）。对当前登录用户的真实判定可后续接入 SSAR 补强。

## 3. 集群级资源 admin（cluster-scoped 真实 CRUD，🟢）

均为真实创建 / 删除（经 `applyResourceYaml` / `generateYAML` 契约）+ YAML 查看：

- **Nodes** `/nodes`：Cordon / Uncordon / Drain（`cordonNode` / `uncordonNode` + `policy/v1 Eviction`）真实；Drain 按钮跳 NodeDetail。
- **PriorityClasses** `/priorityclasses`：`addPriorityClass` / `deletePriorityClass` + `generateExtraYAML`。
- **IngressClasses** `/ingressclasses`：`addIngressClass` / `deleteIngressClass` + `generateYAML`。
- **RuntimeClasses** `/runtimeclasses`：`addRuntimeClass` / `deleteRuntimeClass` + `generateYAML`。
- **CRDs** `/crds`、**Namespaces** `/namespaces`：真实列表 / 详情 / 创建。

## 4. 横切观察

- **死按钮模式**（有 UI 无 `@click`）：`Settings`(Custom Columns)、`Configuration`(全部 edit/delete/create)、`RBAC`(Create/edit/delete)、`Clusters`(Sync)。后续接线需遵循 `applyResourceYaml` 契约（`generateYAML` 无损 + per-kind mapper + `updateXxx`）。
- **被取代 / 半成品**：全局 `Configuration`、`Settings` 两页停留在壳/静态 mock，真实能力已下沉到 Namespace 作用域页与各 Detail 页。
- **无平台账号体系**：无 board 级用户/角色/会话管理页；登录态即 K8s 凭据会话（仅内存 + localStorage）。
- can-i 为客户端推演；Audit 为 Events 代理（已诚实标注边界）。

## 5. 后续改造建议（供排期，不在本次盘点范围）

1. **Settings.Components** 接入真实组件健康（componentstatuses / healthz）；**Custom Columns** 实现勾选 + localStorage 持久化。
2. **Configuration 全局页**：接线或移除（避免与 Namespace 作用域 CRUD 重复 / 误导）。
3. **RBAC 全局页**：接线 Create / 行内 edit·delete，或统一收敛到 Detail 页 + `NsRBAC`。
4. **Clusters.Sync**：接线（触发重新水合 / 状态刷新）。
5. **can-i**：可选接入 `SelfSubjectAccessReview` 取得当前用户服务端真值。
