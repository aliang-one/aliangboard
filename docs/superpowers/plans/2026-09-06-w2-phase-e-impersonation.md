# Wave 2 Phase E:Impersonation 终态(下游身份注入 + 组级 RoleBinding + 审计归真人)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox steps.

**Goal:** 网关向下游 K8s 转发时注入 `Impersonate-User: aliangboard:u-<userId>` + `Impersonate-Group: aliangboard:team-<groupId>` 组头;allowlist 集群按组供给 Group-subject Role/RoleBinding(view/operate 两档);集群审计日志从此归到真人身份。v1 网关授权保持不变(gateK8sSession 仍是第一执行点)。

**Architecture:** ①`requestOnce`(server/index.mjs:571,所有 K8s 出站的单点)读取 `session.impersonate`(字符串数组),非空则并入 headers——注入点在唯一出站函数,透传/watch/exec/portforward/wb 工具自动全覆盖;②connect-cluster 签发 k8sSession 时从 platform session 携带 `impersonate` 字段(平台身份→K8s 身份的唯一映射点:`['aliangboard:u-<userId>', ...groups.map(g=>'aliangboard:team-'+g)]`);③admin 凭据路径(平台运维:probe/台账/托管 SA 供给)**不注入**(session 无 impersonate 字段即无头);④组 RoleBinding 供给复用 sa-provision 骨架新增 `provisionGroupBindings`(subjects kind=Group)+ grants 变更驱动 + 启动 drift sweep;⑤exec WS 的 k8s client 构造点同样带 impersonate 头。

**Tech Stack:** Node + node:sqlite、node:test。零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-05-usercenter-wave2-multitenancy-design.md` §7 + §10 Phase E

## Global Constraints

- 提交作者 `aliang-one <aliangdone@gmail.com>`(提交前核);英文信息;禁 Co-Authored-By 尾注;worktree 执行 `--no-ff` 合回;**实现者禁自行合并**。
- 零新依赖;node:sqlite 绑定禁 undefined;try-ALTER 在 CREATE 后。
- **身份命名约定(spec §7)**:User=`aliangboard:u-<userId>`;Group=`aliangboard:team-<groupId>`;可读名走 `Impersonate-Extra-Displayname: <username>`。
- **信任面红线**:网关凭据须具备集群级 impersonate 权限——**不假设**:admin 凭据可能是普通 token(无 impersonate 权)。因此注入必须是**可降级**的:启动/连接时探测一次(`SelfSubjectRulesReview` 或对 allowlist 集群首请求带头发一次试探),探测失败 → 该集群不注入 + console.warn(回到 v1 网关授权,不破坏功能);探测成功才常驻注入。探测结果按 clusterId 缓存在内存。
- **兼容红线**:open 集群与 legacy 无归属 session 行为不变(impersonate 字段照带——open 集群也注入,身份归真不挑模式;但探测失败的集群全模式不注入)。admin 平台用户的平台凭据路径(requestKubernetes by clusters row)不注入。
- 伪造头剥离(Phase B :1281)保持——先剥客户端伪造,再注入网关自己的。
- 消息双语(如需新键);门禁全家(npm test / test:unit / typecheck / build / 裸 i18n:check)。

---

### Task 1: impersonate 探测器 + k8sSession 携带身份

**Files:**
- Create: `server/impersonate.mjs`
- Modify: `server/routes/auth.mjs`(connect-cluster ~:252 构造 k8sSession 处)
- Test: Create `server/impersonate.test.mjs`

**Interfaces:**
- Produces:
  - `impersonateHeadersFor(session) -> { 'impersonate-user': string, 'impersonate-group'?: string[], 'impersonate-extra-displayname'?: string } | {}`——纯函数:session.impersonate 为空数组/undefined → `{}`;非空 → 头对象(node http 头小写;group 单值时也是数组形态或单字符串——取数组,undici 支持)。
  - `buildImpersonation(db, userId) -> string[]`——`['aliangboard:u-<userId>', ...该用户 groups.map(g => 'aliangboard:team-' + g.id)]`;用户不存在/禁用 → `[]`。
  - `createImpersonationProbe({ requestKubernetes }) -> { ensureProbed(session) -> Promise<boolean> }`——按 `session.clusterId` 缓存探测结果(内存 Map,重启清零可接受);探测 = 对 `/apis/authorization.k8s.io/v1/selfsubjectrulesreviews` 发一次带 impersonate 头的 POST,403 → false(凭据无 impersonate 权),2xx → true;网络错误 → false(保守)。**probing 只对 allowlist+open 都做**——身份归真是全局目标;但失败仅降级。
- connect-cluster:构造 k8sSession 时 `impersonate: buildImpersonation(db, ps.userId)`(admin 平台用户也带——admin 归真同理所应当;legacy ps 无 userId 不会走到这里)。注意 platform_sessions 行已存 k8sSessionToken——impersonate 只在内存 session 对象,不持久化(重启后 loadPersistedSessions 重建时**从 platform_sessions.userId 重新 build**——在 loadPersistedSessions 里补一行:`if (r.userId) session.impersonate = buildImpersonation(db, r.userId)`)。

- [ ] Step 1 失败测试:`buildImpersonation`(有组用户/无组/ghost);`impersonateHeadersFor`(空→{};单组→两头;多组→group 数组;displayname);probe(403→false 缓存;2xx→true 缓存;同 cluster 只探测一次——requestFn 计数)。connect-community 集成:auth-selfservice 工厂断言 persistSession 收到的 session.impersonate 含 `aliangboard:u-u1`。
- Step 2 红 → Step 3 实现 → Step 4 绿 + npm test → Step 5 Commit `feat(server): impersonation identity carried on k8s sessions (user+groups, probe-cached per cluster)`

### Task 2: requestOnce 注入 + exec WS 注入 + 降级探测接线

**Files:**
- Modify: `server/index.mjs`(requestOnce :571-576;exec WS k8s client 构造 ~:2291 后;k8s-watch mux 的 fetchUpstream 构造处;portforward 的 client)
- Test: `server/impersonate.test.mjs` 追加 + `server/w2b-coverage.test.mjs` 追加源码断言

**Interfaces:**
- Consumes: Task 1 全部。
- Produces:
  - requestOnce:`const imp = session.impersonate?.length ? impersonateHeadersFor(session) : {}` → `Object.assign(headers, imp)`。**仅当该集群探测通过**——探测状态查询:`impersonationProbe.isProbed(session.clusterId) === true` 才注入;false/未知 → 不注(保守:探测在 connect-cluster 后台异步做,未完成前先不注,完成后注)。
  - exec WS / k8s-watch / portforward:这些走 @kubernetes/client-node 或独立 fetch——找到各自构造请求头处,同样条件注入(exec WS 的 KubeConfig 可用 `kubeConfig.applyToFetchOptions` 前手动加 headers,或 exec.exec 的第 4-8 参之外的 header 通道——**执行者读 @kubernetes/client-node 用法,选最小侵入点**;若 client 库不支持自定义头 → 该路径跳过注入并在代码注释记录,不影响验收[exec 走 v1 门已足够])。
  - probe 接线:connect-cluster 成功后 fire-and-forget `ensureProbed(k8sSession)`(不阻塞连接;结果缓存后后续请求生效)。
- [ ] Step 1 失败测试:impersonate.test——requestOnce 形状用纯函数 `mergeImpersonate(headers, session, probed)` 测(注入/不注/覆盖优先级:显式 init.headers 不被覆盖);w2b-coverage 源码断言 requestOnce 含 `impersonateHeadersFor(` 调用。
- Step 2-5 → Commit `feat(server): inject impersonation headers on k8s egress (probe-gated, single-point requestOnce + exec/watch/pf paths)`

### Task 3: 组级 RoleBinding 供给(provisionGroupBindings)

**Files:**
- Modify: `server/sa-provision.mjs`(新增导出)
- Test: `server/sa-provision.test.mjs` 追加(或新建 group-bindings.test.mjs)

**Interfaces:**
- Produces: `provisionGroupBindings({ requestFn, callCtx }, { groupId, tier: 'view'|'operate', namespaces: string[] }) -> Promise<{ ok, created, failed }>`——对每个 ns 建 `Role aliangboard-group-<tier>-<gid8>`(rules=roleRules(tier 映射: view→read 集, operate→read+write 集——复用 roleRules 的 tier 语义,view 视作 read)+ `RoleBinding`(subjects: `[{ kind: 'Group', name: 'aliangboard:team-<groupId>', apiGroup: 'rbac.authorization.k8s.io' }]`,labels 带 `aliangboard.io/group: <groupId>` 供清扫)。幂等(已存在跳过)。`teardownGroupBindings({ requestFn, callCtx }, { groupId, namespaces })` 删除该组全部绑定(labels 选择)。
- **驱动**:admin 端点 PUT /api/admin/grants(Task A 的全量替换)在事务提交后 fire-and-forget 对受影响 (cluster, subject) 逐组供给(仅 subjectType='group' 且集群 allowlist);PUT ns-auth-mode 切到 allowlist 时对全部组 grants 触发一轮。失败仅 console.warn(漂移 sweep 兜底)。
- **sweep**:新增 `sweepGroupBindings({ requestFn, callCtx }, { keep: Map<ns, Set<gid8>> })`——labels 选择 `aliangboard.io/group` 存在但不在 keep 集 → 删;挂进既有启动 sweep 调度点(sweepOrphanGrants 旁,每 24h 或启动时一次;读既有调度惯例)。

- [ ] Step 1 失败测试:provision 幂等/subjects kind=Group/labels;teardown 按 labels;驱动(admin-authz 测试:PUT grants 后 provision stub 被调,参数=组+ns 列表);sweep(keep 外删、keep 内留)。
- Step 2-5 → Commit `feat(server): group-scoped RoleBinding provisioning driven by grants (idempotent + drift sweep)`

### Task 4: 集群审计身份验证 + 文档 + 门禁收口

**Files:**
- Modify: `docs/`(部署文档段落:deployment README 或 docs/superpowers/specs 附录——写「信任面声明」:impersonate 权限不可 ns 限定、网关凭据为集群级全权委托、与现状同级不扩大;探测降级语义)。
- Test: `server/impersonate.test.mjs` 端到端形状断言(头集合完整:u-/team-/extra-displayname)。

- [ ] Step 1 手测脚本(交控制器):重启网关 → 连接 allowlist 集群(凭据需有 impersonate 权,admin token 通常有;没有则验证降级 warn)→ UI 任意列表请求 → 集群侧 `kubectl get clusterrolebindings -o json | jq` 或 audit log 查 `aliangboard:u-<id>` 出现;伪造头复测(Phase B 用例回归)。
- Step 2 全量门禁(npm test / test:unit / typecheck / build / 裸 i18n:check)。
- Step 3 退出判据自检:spec §10 E 行——v1 网关授权与伪造头测试通过(既有 w2b/k8s-gate 测试全绿即证)。
- Step 4 合并(控制器)。

## 非目标
双写 RBAC 到 open 集群(open 不隔离,绑定无意义);impersonation 权限本身的供给(凭据录入者责任,文档声明);ConversationLevel 审计 UI(已有 my/activity);v1 gate 移除(**保留为第一执行点**——impersonation 是第二道+审计归真,双层)。
