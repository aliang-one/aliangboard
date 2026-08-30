# 工作台无集群可用 + 项目后绑集群 设计

日期:2026-08-30
状态:已评审(用户裁定定位=完整工作台+后绑集群,全局粒度沿项目维度)

## 1. 背景与目标

现状:工作台路由 `requiresCluster: false` 本可进,但 `createProject` 硬性要求 `clusterId`(workbench-projects.mjs:166),且 repo 路径以 clusterId 为文件系统命名空间——没有集群的用户实际完全用不了工作台。

目标:没有集群的用户也能建项目、用工作台(对话/项目文件草稿/SSH 运维/知识沉淀);项目建后可随时绑定集群,绑定即时解锁全部 K8s 工具,已写好的 manifests 草稿可直接 apply。

无集群场景工具矩阵(用户确认):

| 可用 | 工具 |
|------|------|
| ✅ 对话本身 | LLM 聊天/项目记忆/上下文余量 |
| ✅ 项目文件 | `read_project_file` / `write_project_file`(manifests 草稿) |
| ✅ 知识沉淀 | `propose_learning`(未绑定项目落平台级经验池) |
| ✅ SSH 全族 | `wb_ssh_exec` / `wb_ssh_read_file` / `read_server_ledger` / `write_server_notes`(与 K8s 集群无关) |
| ❌ 排除 16 个 | 调查 8(`wb_list_resources`/`wb_get_pod_logs`/`wb_describe_resource`/`wb_get_resource`/`wb_get_events`/`wb_rollout_status`/`wb_read_pod_file`/`wb_top`)+ 运维 5(`wb_scale`/`wb_restart`/`wb_update_image`/`wb_rollout_undo`/`wb_exec`)+ `bootstrap_ledger`/`apply_project_manifests`/`read_ledger` |

(K8s 族 19 个 principal:'k8s' 工具是 MCP/API-key 场景,工作台 agent 本就不挂,不在矩阵内。)

## 2. 数据与路径

### 2.1 项目表

- `workbench_projects.clusterId` 改**可空**:`createProject` 去掉 clusterId 必填校验(NULL = 未绑定)。
- 存量项目全部有 clusterId,行为零变化,无数据迁移。

### 2.2 repo 路径(单源 helper)

新增 `projectRepoPath(project)`(workbench-projects.mjs,repo 路径唯一事实源),路径方案由项目表新列 **`repoRoot`**(TEXT)决定——不靠文件系统探测、不靠时间推断:

- `repoRoot` 为 NULL(全部存量行):旧路径 `<WORKBENCH_DIR>/<clusterId>/projects/<id>`——只读兼容,不搬家。
- `repoRoot = 'projects'`(本特性起的新项目):`<WORKBENCH_DIR>/projects/<projectId>`——与集群无关,绑定/换绑/解绑都不动文件,绑集群后仍走此路径(repoRoot 创建即定,永不变)。
- 建表迁移:try-ALTER 加列,须置于 CREATE TABLE 之后(仓库既有两次踩坑的教训)。

### 2.3 learnings 落点

- 未绑定项目:`propose_learning`/`appendLearning` 写平台级 `<WORKBENCH_DIR>/_platform/learnings.md`(全局经验池,与集群无关)。
- 绑定集群后:`appendLearning` 走该集群 `<clusterId>/cluster-context/learnings.md`(现有逻辑);历史内容不搬迁。
- `readLedger` 闭包对未绑定项目返回引导文案(「项目未绑定集群:可写 manifests 草稿、SSH 运维;绑定集群后此处为集群能力台账」)——属纵深兜底:`read_ledger` 工具在未绑定项目里已被 excludeTools 裁剪(§3),正常路径 LLM 调不到它;闭包文案只防直调/未来接线遗漏。

## 3. 工具与提示词

- `buildWbCtx(project)`:clusterId NULL → `k8sSession = null`(分支已存在);K8s 依赖闭包维持现有友好报错双保险(工具被裁剪后 LLM 看不到,报错只防直调)。
- `runConversation` 的 `excludeTools` 叠加(现值:`exposedCount === 0 ? Set(ssh 4 工具) : null`):
  - 未绑定项目 → `new Set([...16 个 K8s 依赖工具名])`(与 SSH 零暴露的 4 工具集取并集语义:两条件各自贡献要排除的名字)。
  - 绑定项目 → 维持现状(仅 SSH 零暴露规则)。
- 系统提示词维持全局配置烘焙(conv.system 建对话时定型),不按绑定状态分叉;工具可见性靠 per-run toolDefs 裁剪。

## 4. 绑定/解绑

### 4.1 端点

- `PUT /api/workbench/projects/:id/cluster`,body `{ clusterId: "<id>" }` 或 `{ clusterId: null }`(解绑)。
- 权限:admin 或项目 owner(他人 403);绑定目标集群必须存在于 clusters 表(400/404 校验)。
- ROUTE_AUTH:落在既有 `/api/workbench/` 前缀登记内(守卫测试验证,勿因新端点未登记而 404)。
- 语义:仅更新 `workbench_projects.clusterId`(**解绑不动 manifests/repo/对话**);写入审计(verb 'write', tool 'workbench_project_cluster', requestSummary 含 projectId+clusterId)。
- 下一轮对话即时生效:k8sSession per-run 现建、excludeTools per-run 现读。

### 4.2 前端

- 项目列表/详情:「绑定集群/换绑」下拉(列出平台已有集群;未绑定项目显示「未绑定集群」徽章)。
- Chat 顶部能力提示条:未绑定时显示(「当前未绑定集群:可写 manifests 草稿、SSH 运维;绑定集群后可调查/apply」+ 绑定入口);绑定后消失。
- i18n zh/en 双语全量;无集群用户进入工作台的空态页给「创建项目(无需集群)」主入口。

## 5. 安全与审计

- 绑定动作本身进审计;wb_* 工具审计的 `clusterId` 允许 NULL(审计表列可空,写边界 NULL 直传合法)。
- 解绑不清理历史审计;SSH 工具仍随各服务器审批策略;绑定后 K8s 工具走项目集群凭据(与现状同)。
- conv.system 不携带凭据;绑定状态不改变任何凭据可见性。

## 6. 测试

| 层 | 用例 |
|----|------|
| 纯逻辑 | `projectRepoPath`:存量(NULL 之外)旧路径 / 新项目新路径 / 绑定后路径不变 |
| 服务端 | createProject 无 clusterId 可建;绑定/解绑端点权限矩阵(admin/owner 通过,他人 403,不存在集群 400);绑定前后 buildWbCtx k8sSession 与 excludeTools 工具清单(未绑定=恰缺 16 个并含 SSH 零暴露叠加) |
| 前端 | 项目卡徽章与绑定下拉;chat 能力提示条显隐;i18n 对齐 |

## 7. 明确不做(YAGNI)

- 存量 repo 搬家(旧路径只读兼容)
- 多集群项目(一项目一集群,解绑重绑=换绑)
- 未绑定项目的假数据/试用集群
- MCP/API-key 场景的无集群语义(它们天然以 key+SA 为前提,不在本特性范围)
