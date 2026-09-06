# Wave 2 Phase C+D:授权传导 + 对话降门 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** C=授权传导(key 请求时 ns ∩、wb 工具与 @mention 执行面过滤、detached runner 逐调用复检、records/presence/search 归属收口、审批归属);D=工作台对话 15 端点降门 requirePlatform + owner 链。**硬顺序:D 的降门提交必须在 C 全部合入之后**(同分支内按任务序,Review 即门槛)。

**Architecture:** key 面在 `resolveApiKey` 判定链尾接 `canAccessNs`(已单点);wb 工具在 `buildWbCtx` 的工具工厂注入 principal,执行器入口统一 `canAccessNs`;@mention 两份实现共用新 helper `assertRefAccess`;工作台端点降门 + `assertProjectOwnership` 链。

**Tech Stack:** Node + node:sqlite、node:test;前端零改动(D 的前端行为随服务端放开自然生效)。

**Spec:** wave2 spec §4.5/§6.1/§6.2/§6.3;审计锚点(2026-09-05 盘点,行号可能漂移,以内容搜索为准):
- 对话 15 端点 requireAdmin:workbench-conversations.mjs(:139 ai-config 除外 → 维持 admin;:156/:190/:244/:270/:290/:344/:352/:374/:404/:421/:468/:477/:493/:508 降门)
- records :40-41;presence active :343-344;summary :65-97;search server 分支 :270/:278-284
- wb 工具 index.mjs:1243-1463(listResources/getPodLogs/execInPod/scale/restart/updateImage/rolloutUndo/describe/getResource/getEvents/wb_top/wb_read_pod_file);actor 流 :155/:247(run/resumeConversation)
- @mention:ref-fetch.mjs:46-49 + workbench-conversations.mjs:79(buildRefsContext)

## Global Constraints

- 提交作者/英文/无尾注/worktree/实现者禁合并(同前)。
- 红线:①`requireAdmin`→`requirePlatform` 只允许出现在本计划明确列出的对话端点;`/ai-config`、`/records` 的全局统计与审计明细、ledger 写路径维持 admin。②key 面改动仅 resolveApiKey 判定链,服务 key(ownerUserId NULL)零影响。③提示词不算执行——一切强制在执行器。
- open 模式集群:canAccessNs 恒 true(Phase A 语义),故本计划全部门在 open 集群零行为变化;allowlist 集群才生效。
- 消息双语:wbc.* 新键进 server/messages/wbc.mjs。

---

### Task 1: key 请求时 ns 部分收权

**Files:** Modify `server/api-key-tools.mjs`(resolveApiKey 尾部)、`server/authz.test.mjs` 或新建 `server/key-ns-intersect.test.mjs`
**Interfaces:** Produces: resolveApiKey 第四段——owner 非 admin 且 key 所绑集群 nsAuthMode='allowlist' 时:key effectiveNamespaces ∩ owner effectiveGrants 该集群 ns;交集空 → null;否则在 keyRow 上挂 `row._nsScope = Set`(交集)。消费方(api-key-tools assertPathInNs/MCP)Phase C+ 一并接 _nsScope;本任务先落判定与 null 语义。
- [ ] Step 1 失败测试(allowlist:owner 失去 key 全部 ns → null;部分 ns → key 存活且 _nsScope=交集;open 集群/服务 key/admin → 无 _nsScope 且行为不变) → Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(server): request-time key ns intersection with owner grants (partial revocation)`

### Task 2: assertProjectOwnership + assertClusterEntitlement helper 收口(workbench-projects.mjs)

**Files:** Modify `server/routes/workbench-projects.mjs`;Test 追加 workbench-projects-gates.test.mjs
**Interfaces:** Produces: 导出式 helper `assertProjectOwnership(ps, p) -> boolean`(owner 或 admin)与 `clusterEntitled`(已在,复用);records/presence/summary/search 复用。
- 本任务把 Task 3-5 需要的查询 helper 备齐:`listConversationsByOwner(db, userId)`(JOIN projects WHERE ownerId)。
- Step 1-5:helper + 单测 → Commit `refactor(server): project ownership helpers for workbench propagation`

### Task 3: records/presence/search-server/summary 收口(Phase C Workspace 修复包)

**Files:** Modify `server/routes/workbench-projects.mjs`;messages/wbc 或 wbp(新键)
**Interfaces:**
- records(:40-41):requireAdmin → requirePlatform;conversations 明细与 counts 加 ownerId 过滤(ps.role!=='admin' 时);全局 storage/审计明细分支维持 admin(前端已有 isAdmin 分支)。
- presence /conversations/active(:343-344):requirePlatform + listActiveConversations 加 ownerId 过滤(非 admin)。
- summary(:65-97):非 admin 分支 totals 按 listProjects(userId) 约束(现状隐式,补显式 + 测试)。
- /search server 分支(:270,:278-284):platform 门内补 ownership(server 行所属 project 须 ps 拥有或 admin)。
- 新消息:`wbc.ownerOnly` zh「无权访问该资源」/ en "Not your resource"(如需)。
- [ ] TDD:四组负向(u2 不可见 u1 的 records/active/search 行;admin 全量) → Commit `feat(server): owner-scope records/presence/summary/search in workbench`

### Task 4: 审批归属

**Files:** Modify `server/routes/workbench-conversations.mjs`(approve/deny :477/:493)、`server/workbench-conversations.mjs`(pendingApproval 结构,若落库处)
**Interfaces:** approve/deny:requirePlatform + 会话所属 project owner 或 admin 才可;`approverId`(ps.userId)+ `approvedAt` 落 pendingApproval;审计照旧(actor 已带)。deny/cancel 同权。
- [ ] TDD:u2 approve u1 对话 → 403;owner → 200 且 approverId 落库 → Commit `feat(server): approval ownership + approver attribution`

### Task 5: wb 工具执行面过滤

**Files:** Modify `server/index.mjs`(buildWbCtx 工具实现 :1243-1463)、`server/workbench-agent.mjs`(actor 扩展)
**Interfaces:**
- run/resumeConversation 的 actor 增 `userId`(路由处传 ps.userId;workbench-conversations.mjs 各调用点)+ `ps.role`;buildWbCtx 接收 principal。
- 每个 ns 型工具实现体首行:`if (!canAccessNs(db, { userId: actor.userId, role: actor.role }, project.clusterId, args.namespace, levelForRequest(...))) throw new PermissionDeniedError(...)`;listResources 无 ns → 结果按授权 ns 过滤(items.metadata.namespace ∈ grants;open/allowlist-admin 全量);集群级 kind(wb_top/metrics)非 admin + allowlist → 拒。
- PermissionDeniedError 从 authorize.mjs import;wb 工具错误已走 {error} 形状。
- [ ] TDD:server 级 — 构造 buildWbCtx 依赖桩,allowlist 夹具下 u1(仅 team-a)调 getPodLogs(team-b) 拒 / listResources 只回 team-a / exec team-b 拒;open 集群全通。 → Commit `feat(server): wb tool executor enforces owner grants (per-call, detached-runner safe)`

### Task 6: @mention 两份实现共用门

**Files:** Modify `server/ref-fetch.mjs`、`server/routes/workbench-conversations.mjs`(buildRefsContext)
**Interfaces:** 新导出(helper 放 ref-fetch.mjs):`assertRefAccess(db, principal, ref, projectClusterId)` — ref.kind==='server' → true(维持 exposeToAi 闸);k8s ref → canAccessNs(view)。两处拉取循环内逐 ref 调用,不过 → 跳过该 ref(注入为空,不中断)。
- [ ] TDD:allowlist 下 team-b 的 @pod 注入为空、team-a 正常;open 全通;两份实现同测 → Commit `feat(server): @mention refs gated through single access helper (both implementations)`

### Task 7: 对话 15 端点降门(Phase D;**前置:Task 1-6 已 commit**)

**Files:** Modify `server/routes/workbench-conversations.mjs`;messages/wbc.mjs
**Interfaces:**
- 14 端点(:156/:190/:244/:270/:290/:344/:352/:374/:404/:421/:468/:477/:493/:508)`requireAdmin` → `requirePlatform`;`/ai-config`(:139)维持 admin。
- 每端点在既有 ownership 检查(写路径已有)之外,**读/流/删/改名/审批/取消/列表/active** 全部走 `assertProjectOwnership`(列表/active 经 Task 3 的 owner 过滤,单查端点逐个校验)。
- cluster entitlement:对话运行(:190 创建消息触发 run)与 regenerate,在既有 clusterEntitled 语义上校验 project.clusterId。
- 新消息:`wbc.noProjectAccess` 复用 wbp.noProjectAccess 亦可(裁决:复用 wbp 键)。
- [ ] TDD:w20-negative.test.mjs 风格 — u2 对 u1 对话的 GET/stream/DELETE/PATCH/approve/deny/cancel 全 403;u1 全通;admin 全通;open 集群普通用户可完整对话(降门验证);ai-config 仍 admin 403。 → Commit `feat(server): workbench conversations downshift to platform auth with owner chains (Phase D)`

### Task 8: 门禁收口 + 手测清单

- [ ] `npm test`;`npm run test:unit -- --maxWorkers=2`;typecheck;build;裸 i18n:check。全绿。
- [ ] 手测(网关重启):普通用户完整走通工作台(建项目→绑 allowlist 集群→对话→@mention→审批);A组成员在 allowlist 集群 wb_list_resources 仅见授权 ns;u2 触达 u1 对话/记录全 403;admin 全量回归。

## 非目标
impersonation/组 RoleBinding(Phase E);服务器 per-user 白名单;个人 kubeconfig;ledger 租户化(维持全局池裁决)。
