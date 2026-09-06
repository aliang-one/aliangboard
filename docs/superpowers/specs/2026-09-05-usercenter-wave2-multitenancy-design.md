# 用户中心 Wave 2 详细设计:组 + namespace 授权 + 授权传导

- 日期: 2026-09-05
- 修订: r2(2026-09-05 外部技术评审采纳:新增 §0.4 现状绕过与 Phase 0/W2-0 强制前置、§2.7 open 模式语义、§6.1 部分收权语义、§3 决策函数完整 API 面 + 索引/孤儿清理、§4 body-param 端点全覆盖、§6.3 detached runner 逐调用复检、§9 双用户负向矩阵、§10 各期退出判据);r3(2026-09-06 Phase E 落地增补:附录 C「Impersonation 信任面与开关」——kill-switch/探测语义/信任面声明/启用前清单/归因缺口)
- 状态: 待用户评审
- 父 spec: `docs/superpowers/specs/2026-09-04-usercenter-enterprise-design.md`(§2 公理 / §4 约束;本文档将 §4 从约束升格为可实施设计)
- 事实基础: 2026-09-05 三路代码审计(工作台隔离现状 / 枚举搜索面 / 授权机器复用评估),全部结论带 file:line,摘要见附录 A/B
- Wave 1 已合 main(3b19876):双类 key + resolveApiKey 实时收权(集群粗交集)+ 自助 key + 我的活动 + 五 tab 用户中心

---

## 0. 三问直答(用户 2026-09-05 提出的事项核查结论)

### 0.1 用户的 API key 权限 —— 已覆盖,Wave 2 补 ns 级交集

Wave 1 已落地:双类 key(用户 key `ownerUserId` 必填 / 服务 key 显式 scope);**实时收权单点**在 `resolveApiKey`(server/api-key-tools.mjs:29-43)——owner 被删/禁用即刻失效,owner 非 admin 须已分配 key 所绑集群(`user_clusters` 粗交集),鉴权门、`/api/key/*`、MCP 三面同过此单点;删户级联吊 key;lastUsed 双挂载(HTTP 门 + MCP)。

**Wave 2 增量(§6.1)**:ns 级交集——用户 key 生效 ns = `key 自身配置(boundSA_namespace ∪ allowed_namespaces) ∩ owner 实时 ns 授权(组 ∪ 个人)`。请求时求值,owner 缩权即刻生效,零同步。复用 `authorize.mjs` 纯函数(`effectiveNamespaces` 的 JSON 数组格式原样保留)。

### 0.2 用户的 Workspace 权限 / Workspace 之间有没有隔离 —— 项目已隔离,其余五面**没有**,Wave 2 修复

审计结论(server/routes/workbench-projects.mjs / workbench-conversations.mjs 全量核对):

| 面 | 现状 | 隔离判定 |
|---|---|---|
| 项目 CRUD/文件/commit/reconcile | platform 门 + **全操作 ownerId 校验**(:106,:123,:136-138),列表按 ownerId 过滤 | ✅ **用户隔离已就绪** |
| **对话 15 端点** | **全部 requireAdmin**(:139/:156/:190/:244/:270/:290/:344/:352/:374/:404/:421/:468/:477/:493/:508)——普通用户今天**完全用不了工作台对话**;写路径内嵌 ownership,但**读/流/删/改名/审批/取消无归属校验**(admin 之间全通) | ❌ admin-only 域 + admin 互访无归属 |
| 记录 records | requireAdmin,全量跨用户无归属过滤(:40-41,:43-54) | ❌ admin-only 全局池 |
| 知识 ledger | 读 platform(**任意 platform 用户可读任意集群台账**,:312-313)、写 admin;按 clusterId 全局池,不按项目/用户分 | ⚠️ 全局池(本 spec 裁决:维持,见 §6.2-D) |
| presence /conversations/active | requireAdmin + 全库无 userId 过滤(:343-344) | ❌ admin-only 全局池 |
| /search server 分支 | platform 门但**无 ownership 校验**(:270,:278-284) | ❌ 裂缝 |
| **wb_* 工具执行** | **零用户过滤**:工具直接用项目绑定集群的**平台级凭据**打 API(index.mjs:1219,:1243-1463,注释自认「不走 API key/tier」)——能发起对话者经 AI 即得集群全权(现状发起者均 admin 故未爆) | ❌ **最大隐患**,§6.3 |
| 审批链 | requireAdmin + CAS,无审批人字段,任何 admin 可批任何对话(:476-516) | ❌ admin 共池 |

### 0.3 不同用户对资源的访问、搜索会不会出问题 —— 会;Wave 2 v1 网关执行后 13 条通道中 5 条自动安全,4 条必须单独改造

13 条枚举/搜索通道全清单见附录 B。核心事实:**网关今天只做鉴权 class,零 ns 过滤**;所有 K8s 数据面用平台级集群凭据(`clusters.authHeader`);connect-cluster 签发的 k8sSession 携带全集群权限——这就是「只做 UI 过滤」绝不可交付的原因。

- **自动安全**(网关执行后):`/api/k8s/*` 透传、`/api/k8s-watch` WS、namespace 列表、顶栏 Cmd+K 全局搜索(前端过滤通道 1 的数据)、32 个列表页(同前)——共 5 条。
- **必须单独改造**:`@mention` 注入(`ref-fetch.mjs:46-49` 无权限检查;**`workbench-conversations.mjs:79` 还有第二份平行实现 buildRefsContext,两处都要改**)、wb_* 工具执行层(tool-registry 枚举类工具直连集群)、`connect-cluster` 后的会话凭据语义(v2 impersonation 解决)、`/api/admin/clusters/:id/namespaces`(admin-only,普通用户 ns 候选须改走白名单派生)。
- **已安全**:`/api/my-clusters`(集群门)、`/api/my/activity`(本人)、`/api/my/keys`(ns 粒度)、SSH 服务器面(exposeToAi 闸,ns 无关,host 已脱敏)。

### 0.4 现状授权绕过(W2-0 的事实基础,2026-09-05 二轮审核逐条核实)

1. **K8s session 无归属**:sessions 表只有 token/apiServer/凭据列(index.mjs:106-117),无 userId/clusterId——服务端无从知道某个 K8s session 属于谁、连的哪个集群,请求时也无法复检。
2. **取消集群分配零吊销**:PUT /api/admin/users/:id/clusters(admin.mjs:679-690)只 DELETE+INSERT user_clusters,**不调 revokeUserSessions**——被取消分配的用户存量 K8s session 活满 8h TTL(改密/禁用/删户的级联不覆盖此路径)。
3. **Workspace 集群门残缺**:项目创建(可自带 cluster)与 reconcile/commit 均不校验发起者是否仍被分配该集群;绑定(PUT :id/cluster)亦无(workbench-projects.mjs:138 只查项目归属)。
4. **浏览器 token 仓库全局键**:`aliangboard.session`(client.js:6)不按账号隔离;登出有 clearSession,但任何绕过登出的路径(旧标签页/异常流程)残留可用 token(服务端 8h 内有效)。
5. **自助 key 的 ns 自由输入**:my-keys.mjs:36-43 只查集群分配,namespace 任意——用户可在已分配集群的**任意 ns** 供给托管 SA(least privilege 违例;open 模式下不算提权,allowlist 模式下必须封)。

**结论:以上是今天(与 Wave 2 特性无关)就存在的绕过面。W2-0 作为强制前置先关闭(§10 Phase 0),完成前不得降对话门、不得实施 groups/ns grants。**

---

```sql
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL, createdBy TEXT);
CREATE TABLE IF NOT EXISTS group_members (
  groupId TEXT NOT NULL, userId TEXT NOT NULL,
  addedBy TEXT, createdAt INTEGER NOT NULL,
  PRIMARY KEY (groupId, userId));
CREATE TABLE IF NOT EXISTS ns_grants (
  id TEXT PRIMARY KEY,
  subjectType TEXT NOT NULL CHECK (subjectType IN ('user','group')),
  subjectId TEXT NOT NULL,            -- platform_users.id | groups.id
  clusterId TEXT NOT NULL,
  namespace TEXT NOT NULL,            -- DNS label;不支持通配(v1)
  level TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','operate')),
  grantedBy TEXT, grantedAt INTEGER NOT NULL,
  UNIQUE (subjectType, subjectId, clusterId, namespace));
-- clusters 表加列(try-ALTER,惯例位置 index.mjs:190 之后):
ALTER TABLE clusters ADD COLUMN nsAuthMode TEXT NOT NULL DEFAULT 'open';
```

- 组**平铺**,无嵌套;不做空间层(Rancher Project/KubeSphere Workspace)——多选 ns 授权顶住批量需求,schema 留演化位。
- `nsAuthMode` 按集群切换:`'open'`(现状,人人全 ns,默认——升级零感知)/ `'allowlist'`(白名单模式)。
- 授权解析顺序:**合并去重取高档**——`effectiveNs(user, cluster) = max(level) over (该用户直接 grants ∪ 该用户所属组 grants)`,仅 `nsAuthMode='allowlist'` 的集群参与;admin 恒全量。
- 迁移全部 try-ALTER / CREATE IF NOT EXISTS,遵守「ALTER 必须在 CREATE 之后」顺序不变式(index.mjs:182-184 注释)。

## 2. 授权语义(裁决固化)

1. **按集群切模式**:默认 `open` 保存量兼容;admin 在集群管理页对多租户集群逐个开 `allowlist`。
2. **两档 level**:`view`(GET/LIST/WATCH 类动词)/ `operate`(写动词 + exec/logs/portforward 等子资源)。**不做自定义角色**(影子 RBAC 反模式)。
3. **admin 恒全量**,不受 grants 约束。
4. **集群级资源**(nodes/pv/storageclasses/clusterroles/crd 等):allowlist 模式下**非 admin 整域 403**(导航隐藏,附录 B 通道 1 的集群级 path 一律拒)。
5. **ns 列表**:allowlist 集群的 `GET /api/v1/namespaces` **过滤响应**只回授权项(非 admin);`open` 模式原样。
6. **project 集群门(W2-0 起)**:项目创建带 cluster、PUT /:id/cluster 绑定、reconcile/commit 运行时——三处都校验发起者(项目 owner)对该集群的 `user_clusters` 分配(admin 豁免),失效即拒。
7. **open 模式不是多租户隔离(必须显式声明)**:`nsAuthMode=open` 是兼容迁移态——该集群下被分配用户默认可见全部 ns,**不提供租户隔离**;只有 `allowlist` 集群才算启用 ns 隔离。落地:①部署/产品文档明示两态语义与迁移路径;②管理后台对 open 集群显示安全状态标识与风险提示(「未启用 namespace 隔离」);③生产多租户集群必须显式切 allowlist。

## 3. effectiveGrants:单一决策函数

新模块 `server/authz.mjs`(纯函数核心 + db 适配注入,照 authorize.mjs 惯例):

```
effectiveGrants(db, principal) -> { role, clusters: { [clusterId]: { mode, ns: Map<ns, 'view'|'operate'> } } }
canAccessCluster(db, principal, clusterId) -> boolean          // user_clusters 门(admin 豁免)
canAccessNs(db, principal, clusterId, namespace, needLevel) -> boolean
levelForRequest(method, path) -> 'view' | 'operate'            // 方法+子资源 → 档位,单源映射表
principal = { kind:'user', userId, username, role }             // 平台会话
         | { kind:'key', keyRow }                               // → 归属用户实时 grants ∩ key 自身 ns 配置
```

- **判定合成**:普通用户须**同时**通过 `canAccessCluster` 与 `canAccessNs`;admin 恒全量;直接授权与组授权合并取最高档;授权对象不存在/ns 非法/集群不存在 → 拒(写路径)或拒访(读路径),fail-closed。
- **索引**:group_members 加 `idx_group_members_user(userId)`(「用户在哪些组」反向查);ns_grants 的 UNIQUE(subjectType,subjectId,clusterId,namespace) 前缀已覆盖 subject 查询。
- **孤儿清理**:库无外键体系——删除用户/组的管理路由必须级联删 group_members / ns_grants 行(照 user_clusters 级联先例),并提供 admin 启动/周期 sweep 兜底。
- **请求时求值**(公理 4):每次判定现查 groups/group_members/ns_grants + platform_users.role/disabled;不落物化副本;删除用户、禁用、移出组、删授权立即生效,不依赖前端 grants。
- **AI 不是主体**(公理 2):wb 工具/@mention/对话全部以发起用户为 principal;MCP 以 key 归属用户为 principal。
- 单一事实源:K8s 代理面、wb 工具面、@mention 面、key 面**全部调它**(公理 3);禁止各处自写判定。
- 性能:每请求 2-3 个索引查询(PK/UNIQUE 命中),与既有 platformUserFromRequest 逐请求复读惯例同级;如成瓶颈再加 5s 进程内缓存(keyed by user + grants 版本号),**先不加**(YAGNI)。

## 4. 网关执行 v1(allowlist 集群上)

**新写 `server/k8s-path.mjs` 反向解析器**(审计确认缺口):`parseApiPath(pathname) -> { clusterScope, namespace, resource, name, subresource } | null`——基于 `KIND_API` 的 prefix 表 + `/apis/<group>/<version>/` 通配;识别 namespaced / cluster-scoped / subresource 三态;**路径规范化前置**:拒绝 `..`、反斜杠、双重编码(%252F 等)、空段与异常路径(解析失败=拒);未知路径对非 admin **fail-closed**。fieldSelector 中的 `namespace=`/`metadata.namespace` 同步提取校验(注入面,新写)。

**覆盖面(二轮审核修正,不止透传)**——allowlist 集群上的 session 面全部入口,分两类:
- **path 型**(解析器判):`/api/k8s/*` 透传、`/api/k8s-watch` WS、`/api/resource/tree`;
- **body/query 型**(解析器看不到,逐端点声明 ns 来源,authz.mjs 提供 `nsSource` 适配):`POST /api/apply`、`POST /api/pod/debug`、`POST /api/cronjob/trigger`、`/api/portforward`(建转发的 body ns)、`/api/podfile/`、`/api/pvcfile/`、`/api/terminals`、`/api/file-browsers`(pod 级 → ns+pod 校验)、`POST /api/registry/tags`(ns 无关但集群门适用)。每一处都是今天**未经授权检查的 K8s 出口**,B 期出口零遗漏为硬验收。

**头剥离**:入站 `Impersonate-*` / `X-Remote-*` 无条件剥离(与执行同道,先剥后判;CVE-2021-31999)。**denied 审计**:每次拒绝写审计,记 user/cluster/namespace/path/method(平台侧开始填 clusterId/namespace 列)。

| 请求形态 | allowlist 模式行为 |
|---|---|
| ns-scoped path(`/namespaces/<ns>/...`) | `canAccessNs(user, cluster, ns, levelByVerb)` 不通过 → 403 + **denied 审计**(复用 api-key-tools.mjs:116-121 的 intent/finalize shape,平台侧开始填 clusterId/namespace 列——现状平台路由从不填,小改) |
| 集群级 path | 非 admin → 403(裁决 §2.4) |
| `GET /api/v1/namespaces` | 过滤响应只回授权项 |
| watch/流式 | 建流前校验;建流后**不做**逐事件过滤(事件源自授权范围) |
| CRD / 未知路径 | fail-closed 403(admin 放行) |

**写动词映射**:`operate` = POST/PUT/PATCH/DELETE + exec/logs/portforward 子资源;`view` = GET 类。方法→动词表新写,单源放 authz.mjs。

## 5. UI 适配

- `GET /api/auth/me` 响应追加 `grants`(effectiveGrants 结果,前端渲染用;**仅展示用,安全判定恒在服务端**);authStore 持有。
- ns 下拉:allowlist 集群下拉项 = 服务端过滤后的列表(通道 3 已裁);不再依赖前端删减。
- 直达未授权 ns URL → 现有错误条改 403 语义页(「无权访问该 namespace」+ 返回按钮);导航:集群级页面(Nodes/PV/CRD/RBAC 等)对非 admin 在 allowlist 集群隐藏(SideNavBar 按 grants 裁剪)。
- Vue Query 缓存残留:403 触发该 query 失效;不做全局版本号(YAGNI)。
- admin 管理页新增:**组管理**(CRUD+成员)、**ns 授权编辑**(按组/按用户,多选 ns + view/operate 两档,复用 NsAllowlistEditor 交互范式)、集群表单加 `nsAuthMode` 开关。

## 6. 授权传导(公理 1-3 的落地)

### 6.1 API key:ns 级交集

`resolveApiKey` 判定链追加(在现有 owner 存活 + 集群粗交集之后):owner 的 `effectiveGrants` 中该集群为 allowlist 时,key 生效 ns = **按 ns 逐项求交**——`key 的 effectiveNamespaces ∩ owner 授权 ns`,交集为空 → 整 key 失效;owner 失去某一个 ns 只收窄该 ns,**其余 ns 继续有效**(部分收权,不做「一失全失」)。**档位映射**:read key 至少需要该 ns 的 `view` grant;operator key 需要 `operate` grant——不足即按该 ns 不可用处理。实现为 authz.mjs 的 key-principal 路径,resolveApiKey 调它——**仍单点**,MCP 与 HTTP 门同享。

**自助签发收口**:签发表单的 ns 候选 = 本人当前有权访问的 ns(A 期起由 `/api/my/grantable-ns` 之类端点下发;grants 不存在时即无候选);服务端照判,双保险。**服务 key(ownerUserId NULL)明确定位为平台级凭据**:不随任何个人变化,仅 admin 创建/轮换/吊销,审计独立标注——与用户 key 的生命周期彻底分离。授权变更后 key 的集群内 SA RBAC 由既有 drift 检测收敛(验收 §9.5)。

### 6.2 Workspace 隔离修复包(对话降门的前置)

按审计 0.2 表逐项:

- **A. 对话 15 端点降门**:`requireAdmin` → `requirePlatform`,并统一走「conversation → project → owner」链式归属校验(新 helper `assertProjectOwnership(ps, projectId)`);**读/流/删/改名/审批/取消全部补归属**(现状仅写路径有)。`/ai-config`(透明面板)维持 admin——它是平台策略审计面。
- **B. records 开放为本人域**:requirePlatform + 全查询 `JOIN projects WHERE ownerId=?`;counts 按 ownerId 过滤;全局 storage 统计与审计明细仍 admin-only(前端已有 isAdmin 分支)。
- **C. presence/active 按 ownerId 过滤**(JOIN projects);summary 的 totals 语义钉死为「本人 + admin 全局」(现状已隐式如此,补测试钉住)。
- **D. ledger 语义裁决:维持「按集群全局池,读 platform / 写 admin」**——知识库是平台级资产而非租户资产(Kuboard/Headlamp 同构);租户收敛留待真实需求。`_platform` learnings 池维持 agent 内部读写。
- **E. /search server 分支补 ownership 校验**(与 GET :id 同门)。
- **F. 审批归属**:pendingApproval 增加 `approverId`(批准时落库)+ 审批权 = 项目 owner 或 admin;审批动作写审计带 actor(现状已有 owner 字段,补 clusterId/namespace 不适用则省略)。

**顺序硬约束:§6.3 的工具/引用执行面过滤必须先于或同批于 A 降门**——降门把 wb 工具暴露给普通用户,而工具今天用平台级集群凭据零过滤(审计 0.2 最后行)。**绝不允许「先降门后补过滤」的中间态上 main。**

### 6.3 AI 工具与 @mention 执行面(搜索三问的核心)

- **wb_* 工具**:tool-registry 枚举/操作类工具的执行实现(index.mjs:1243-1463)统一加 `canAccessNs(principal, project.clusterId, ns, levelByTool)`,ns 来源:工具参数显式 ns,或 `wb_list_resources` 类无 ns 调用 → **结果按授权 ns 过滤**(响应 items 过滤,与通道 1 同构);集群级 kind 工具对非 admin 在 allowlist 集群拒。工具执行凭据维持平台级(v1);v2 impersonation 后自动归真。
- **detached runner 逐调用复检(二轮审核)**:后台/恢复执行链(workbench-agent.mjs runConversation:155 / resumeConversation:247)的 actor 目前只带 username——扩展为携带 `conversationId/projectId/ownerUserId/clusterId` 的执行上下文,**每次工具调用、每次引用读取、每次 K8s 访问都以 ownerUserId 现查实时授权**;用户运行中被禁用/移出组/失去 ns 授权,后续调用立即拒绝。`/api/workbench/search` 的 K8s 分支与 server 分支同补 project ownership + cluster entitlement;reconcile 走授权后的上下文(§2.6 运行时检)。**不得把当前管理员身份误当项目 owner**(审批/续跑统一以 conv→project.ownerId 为准)。
- **@mention 两份实现都改**:`ref-fetch.mjs:46-49` 与 `workbench-conversations.mjs:79`(buildRefsContext)在拉取前过 `canAccessNs`(ref 带 ns 时)与集群分配校验;`@server` ref 维持 exposedOnly + host 脱敏(**per-user 服务器白名单明确不做**,留 Wave 3+ 决策)。
- **提示词限制不算执行**(公理 2):一切强制在上述执行器,不依赖 system prompt。

### 6.4 搜索(枚举源原则的重申)

搜索框自身永不判权;候选集必须来自已授权查询。通道 1→4/5 链条经 §4 自动安全;通道 6/7 经 §6.3;通道 8-13 现状已安全或 ns 无关(附录 B)。**新增枚举面的验收惯例:凡新列表/搜索端点,PR 必须说明其候选集的授权来源**(写进 CLAUDE.md 架构约束,随本波落地)。

## 7. Impersonation v2(正统终态,必做收尾)

- 网关向下游转发附加 `Impersonate-User: aliangboard:u-<userId>` + `Impersonate-Group: aliangboard:team-<groupId>`(组粒度;可读名走 `Impersonate-Extra-Displayname`)。
- 集群内按**组**供给 RoleBinding(主体 kind=Group):`sa-provision.mjs` 抽 `subjectOf(spec)` 变体或新增 `provisionGroupBindings`(roleRules/rbacTier/teardown/sweep 骨架全复用;命名 `aliangboard-group-<tier>-<groupId8>`,labels 带 groupId 供 drift 清扫);绑定由 grants 变更驱动 + 既有漂移检测兜底。
- **无条件剥离入站 `Impersonate-*` / `X-Remote-*` 头**(CVE-2021-31999 教训)——执行点与 §4 同一道,先剥后判。
- 信任面声明:impersonate 权限不可 ns 限定(ClusterRole),网关凭据为集群级全权委托——与现状同级,不扩大信任面;写进部署文档。
- 收益:apiserver 成为第二执行点;集群审计归到真人(`aliangboard:u-<id>`,对齐 Rancher v2.6 审计实践)。

## 8. 非目标(明确不做)

硬多租户(独立集群/vcluster 由多集群产品形态接住)、自定义角色、空间层(Project/Workspace)、组嵌套、ns 通配授权、NetworkPolicy 类数据面隔离自动化、per-user SSH 服务器白名单、kubeconfig 下载(Wave 3)、OIDC 组供给(Wave 4——届时 IdP claims 只换 group_members 的供给来源,授权模型零改动)。

## 9. 验收标准

**双用户负向矩阵(固定夹具,自动化测试钉死)**:`u1 → group-a → team-a(view)`;`u2 → group-b → team-b(operate)`;`c1 = allowlist`。至少覆盖:

1. u1 触达 team-b:GET/POST/PATCH/DELETE/logs/exec/watch/portforward **全部 403**;`GET /namespaces` 不含 team-b。
2. 绕过手法全堵:URL 直达、fieldSelector 注入、双重编码、`..` 路径、未知路径 → 均拒。
3. u1 的 key 失去 team-a 授权后**立即拒绝**;部分收权:失去 team-a 但仍有 team-c 时 key 对 team-c 继续可用。
4. u1 失去 c1 集群分配后,**存量浏览器 token 立即失效**(W2-0 验收)。
5. u1 不能把 Workspace 绑定/创建/reconcile 到未分配集群(W2-0 验收)。
6. u1 不能读/流/审批/删除 u2 的任何对话(D 期验收)。
7. 普通用户的搜索、@mention、AI 工具不能看到 team-b(C 期验收);admin 维持全量。
8. `open` 模式兼容保持,测试明确标注「不提供租户隔离」;service key 行为独立不受个人变化影响。
9. 登出后切换账号不能复用前一账号 token(浏览器与服务端两侧)。

allowlist 集群上,组 A 成员 u1 对组 B 的 ns `team-b`(端到端):

1. UI:ns 下拉无 team-b;直达 URL 落 403 页;集群级导航页隐藏。
2. K8s API:任何 path/fieldSelector/watch 手法触达 team-b → 403 + denied 审计行(带 user/cluster/namespace/path/method);`GET /namespaces` 响应无 team-b。
3. **伪造头**:携带 `Impersonate-User: x` 的入站请求被剥离后正常判定(漏洞复测用例)。
4. 集群内 RBAC:grants 变更后 RoleBinding 在漂移检测周期内收敛;u1 的请求在集群审计日志出现 `aliangboard:u-<id>`。
5. 回归:`open` 模式集群行为与 Wave 1 逐字节一致(存量部署零感知);`npm test` / `test:unit` / `typecheck` / `i18n:check` / `build` 全绿;新端点全登记 ROUTE_AUTH;新 UI 文本双语齐。

## 10. 实施分期(每期独立可合、可验收;带退出判据)

| 期 | 内容 | 前置 | 退出判据(不满足不得进下期) |
|---|---|---|---|
| **W2-0** | **关闭现有授权绕过**:①sessions 写入 userId+clusterId(try-ALTER),connect-cluster 落戳;②每请求复检用户状态 + user_clusters(对齐 resolveApiKey 惯例);③取消集群分配即吊销该用户对应 K8s session(admin.mjs:679 补 revoke,双路径:platform_sessions 链 + sessions.userId);④Workspace 创建/绑定/reconcile 集群门(§2.6);⑤浏览器 token 处置(登出全清 + 账号切换不复用,测试钉);⑥双用户负向测试夹具落地;⑦WorkbenchChat CAS flaky 改确定性(时钟/状态注入)或显式隔离——**稳定测试基线是全波前置**。**不做**:对话降门、groups/ns grants。 | 无 | 取消分配后旧 token 立即失效;负向矩阵 W2-0 子集全绿;门禁稳定全绿(无已知 flaky 干扰) |
| **A** | 数据模型 + authz.mjs(effectiveGrants/canAccessCluster/canAccessNs/levelForRequest + 索引 + 孤儿清理)+ admin 管理页(组/授权/模式开关 + open 风险提示)+ /me 下发 grants + 自助 key ns 候选端点 | W2-0 | 直接授权/组授权/admin/open-allowlist 四态单测齐 |
| **B** | k8s-path 反向解析器(含路径规范化)+ 网关执行(path 型 + body 型全清单 §4)+ ns 列表过滤 + watch 建流校验 + 未知路径 fail-closed + 头剥离 + denied 审计 | A | **不存在任何未经授权检查的 K8s 出口**(逐端点清单核对) |
| **C** | key ns 部分收权(§6.1)+ wb 工具/detached runner/@mention 过滤(§6.3)+ Workspace 修复包(§6.2 B/C/E) | A,B | 工具与引用用平台级凭据也读不到未授权 ns(负向矩阵子集全绿) |
| **D** | 对话 15 端点降门 + owner 链 + records/presence 开放 + 审批归属(§6.2 A/F) | **C 合入是硬前提** | C 未完成禁止合入;u2 全矩阵不可触达 u1 域 |
| **E** | Impersonation v2 + 组级 RoleBinding + 漂移收敛 + 集群审计身份 | B | v1 网关授权 + 伪造头测试通过 |

**全波硬规则**:实现者不得自行合并 main;每期独立审查;C 未完成不得放开对话门。

**W2-0 之外的既有欠账(不阻塞但须记账)**:`/api/my-clusters` 追加 ns 授权信息下发(A 期);spec §3.2 的事件类型(tool)过滤器(activity tab 前端);admin keys UI owner 列。

---

## 附录 A:授权机器复用评估(2026-09-05 审计)

| 组件 | 判定 | 说明 |
|---|---|---|
| authorize.mjs 全套(authorize/effectiveTools/effectiveNamespaces/normalizeAllowedNamespaces/PermissionDeniedError) | **直接复用** | 纯函数;ns 配置 JSON 数组格式保留;人类授权合并两源后构造同形输入 |
| sa-provision.mjs(provisionSa/teardown/sweep×2/rbacTier/roleRules) | **小改** | subjects 硬编码 ServiceAccount(:67,:79)→ 抽 subjectOf(spec) 或平行 provisionGroupBindings;命名/labels 带 groupId;rules 骨架全复用 |
| resolveApiKey 判定链 + touchKeyUsage | **直接复用** | Wave 1 产物;ns 交集插入其调用 authz.mjs |
| authGate / ROUTE_AUTH / 门=地板惯例 | **直接复用** | 新路由照登记;workbench 混合层先例(route-auth-map.mjs:65-66) |
| audit writeAudit/finalizeAudit | **直接复用** | denied shape 照 api-key-tools.mjs:116-121;平台侧开始填 clusterId/namespace |
| try-ALTER 迁移惯例 | **直接复用** | 位置 index.mjs:190 之后;守顺序不变式 |
| kind-paths.mjs | **缺口新写** | 只有正向构造(listApiPath/getApiPath);反向解析器、fieldSelector、watch 判定全缺(附录 B) |

## 附录 B:13 条枚举/搜索通道清单(2026-09-05 审计)

| # | 通道 | 入口 | 现状过滤 | Wave 2 后 |
|---|---|---|---|---|
| 1 | /api/k8s/* 透传 | index.mjs:2036,:2076,:2126 | 无 | §4 拦截/过滤 ✅自动 |
| 2 | /api/k8s-watch WS | index.mjs:2041-2068 + k8s-watch-mux | 无 | §4 建流校验 ✅自动 |
| 3 | namespaces 列表 | 通道 1(admin 端点 admin-only 不可达) | 无 | 响应过滤 ✅自动 |
| 4 | 顶栏 Cmd+K 搜索 | TopNavBar.vue:80-92 + globalSearch.js(前端过滤) | 继承通道 1 | ✅自动 |
| 5 | 32 列表页 | cluster.js fetchers → 通道 1 | 继承通道 1 | ✅自动 |
| 6 | @mention 注入 | ref-fetch.mjs:30,:46-49 + workbench-conversations.mjs:79(**第二份实现**) | **无** | §6.3 两处都改 |
| 7 | wb_* 工具 | tool-registry.mjs:112-147 + index.mjs:1243-1463 | **无**(平台级凭据) | §6.3 执行器过滤 |
| 8 | /api/my-clusters、connect-cluster | auth.mjs:296-341 | 集群门 ✅(会话凭据仍全集群 → v2 解决) | 追加 ns 信息下发 |
| 9 | /api/admin/* | route-auth-map.mjs:64 | admin-only ✅ | 不变 |
| 10 | /api/my/keys | my-keys.mjs:25-60 | key 自身 ns + SA RBAC ✅ | §6.1 ∩ owner grants |
| 11 | /api/my/activity | auth.mjs:223-236 | 本人+90d ✅ | 不变 |
| 12 | SSH 服务器面 | ref-fetch.mjs:34 + ssh/agent-bridge.mjs:32-42(exposeToAi 闸,host 脱敏) | exposed 闸 ✅,ns 无关 | 维持;per-user 白名单不做 |
| 13 | 用户审计面 | /api/my/activity | 本人 ✅ | 不变 |

## 附录 C:Impersonation 信任面与开关(2026-09-06,Phase E 落地增补)

Phase E(§7)已落地:身份随会话携带(`impersonate.mjs` buildImpersonation:User=`aliangboard:u-<userId>`、Group=`aliangboard:team-<groupId>`、可读名走 `Impersonate-Extra-Displayname`)、probe-gated 单点注入(requestOnce/流式 watch 透传/watch-mux 出站路径;exec/pf 的 client-node 路径**不注入**,final-review Critical 3 裁决,见 C.5 归因缺口)、组级 RoleBinding 供给与漂移清扫(`sa-provision.mjs` provisionGroupBindings/teardownGroupBindings/sweepGroupBindings,由 admin grants/ns-auth-mode/删组驱动 + 启动兜底)。本附录固化运维面事实。

### C.1 总开关(kill-switch)语义

- 键:`platform_settings.impersonation.enabled`,**仅当值严格等于 `'1'` 时生效;默认关**(未置键 = 关)。admin 经 sqlite 直接置键(无 admin UI):
  ```sql
  INSERT OR REPLACE INTO platform_settings (key,value,updatedAt) VALUES ('impersonation.enabled','1',strftime('%s','now')*1000);
  ```
- **关 → 开:无需重启**。开关关闭时不发探测、不写探测缓存;置 `'1'` 后下一请求 kick 即真探测该集群,探测通过即开始注入。
- **开 → 关:须重启网关收口**。探测结果按 clusterId 缓存在内存 Map,置回关不清缓存(裁定可接受的取舍);重启即清零回到「关」稳态。
- 关闭态零副作用:不发 SSRR、不注入任何 `Impersonate-*` 头,行为与 Phase D 完全一致。

### C.2 SSRR 探测语义(每集群一次)

- 探测请求:`POST /apis/authorization.k8s.io/v1/selfsubjectrulesreviews`,**显式自带本会话的 impersonate 头**——不带头的 2xx 证明不了 impersonate 通道;`spec.namespace: 'default'` 仅作探测载体(K8s 必填字段),不承载授权语义。
- 结果按 clusterId 缓存(内存,重启清零,受网关单进程不变式保护;在途 Promise 去重):
  - **2xx** → 凭据可 impersonate,该集群后续 egress 注入身份;
  - **401/403** → 确定性「凭据无 impersonate 权」,缓存 false 不再打扰 apiserver(直到重启)。注意 403 的归因有两义(凭据无 impersonate 权 ∥ 被代理身份缺 SSRR-create),首个发起探测的用户身份会影响该集群的缓存结果;
  - **5xx/网络错误** → 瞬态,不缓存,下一请求重试。
- **凭据侧前提**:impersonate 权限不可 ns 限定(apiserver 的 impersonate 动词挂在 users/groups 上,需 ClusterRole 级),凭据录入者责任——平台不供给网关凭据自身的 impersonate 权(非目标)。
- **身份侧前提(PE-A 终审关键项)**:探测以被代理身份发起,组身份必须能 `create selfsubjectrulesreviews`,否则探测恒 403、impersonation 永不激活——组 Role(view/operate 两档)均已内嵌 SSRR-create 规则;这也覆盖了硬化集群解除 `system:basic-user` 绑定的场景。

### C.3 信任面声明

**启用 impersonation 不扩大信任面,与现状同级。**论据:

1. 网关凭据本就是集群级全权委托(今天所有平台请求即以该凭据全权打 apiserver);impersonation 只是把「apiserver 看到的主体」从网关凭据换成真实平台用户,**收窄**apiserver 实际放行的动作(被代理身份的 RBAC ⊆ 网关凭据的 RBAC)。
2. 网关侧第一执行点(v1 网关授权 + 头剥离)原样保留:入站 `Impersonate-*`/`X-Remote-*` 无条件剥离(CVE-2021-31999),allowlist 集群的 ns 授权判定在网关先走一遍——impersonation 是**第二执行点 + 审计归真**,双层结构,v1 gate 不移除。
3. 集群侧组 RoleBinding 只落在 ns_grants 授权范围内(仅 allowlist 集群双写;open 集群不写——不隔离,绑定无意义)。

**已知精度取舍**:组绑定 tier 按「组+集群」取最高档(operate > view),ns 粒度由绑定落位承担——同组在 ns1=view、ns2=operate 时,apiserver 侧 ns1 也是 operate 档。经平台的实际可达面由 v1 网关门按 ns_grants 精确收紧(apiserver 档位 ⊇ 网关档位),无净放权;仅当攻击者绕过网关直连 apiserver 且持有网关凭据时才会触达粗粒度差——而那已经是凭据泄露域,非本设计引入。

### C.4 启用前检查单(逐项过,缺一不启用)

1. 目标集群已切 `allowlist`(open 集群无隔离语义,不启用);
2. 组 RoleBinding 已供给:admin 保存一次组授权(PUT /api/admin/grants)或切换 ns-auth-mode 即触发;重启由启动 sweep **清理**漂移(仅删不补建;失败的供给须重新保存一次组授权自愈);抽查 `kubectl get role,rolebinding -l aliangboard.io/group -n <ns>`;
3. 探测身份可过 SSRR-create:组 Role 规则已含 `selfsubjectrulesreviews create`(C.2);
4. 网关凭据确有 impersonate 权(以 admin token 录入的凭据通常有;没有则保持关——探测会确定性 403 并缓存 false,零打扰);
5. 置 `impersonation.enabled='1'`,任意列表请求后集群侧核验:`kubectl get clusterrolebindings` 无关,看 apiserver 审计日志/事件中出现 `aliangboard:u-<userId>`;伪造头复测(w2b 用例:入站 Impersonate-User 被剥离后正常判定)。

### C.5 归因缺口(未 impersonate 的出站路径,记账为未来工作)

以下路径**各自持有独立凭据、不走平台会话身份**,apiserver 审计仍归到其凭据主体,不归到发起用户:

| 路径 | 现状凭据 | 归真计划 |
|---|---|---|
| wb_* 工具执行(wb-ctx/buildWbCtx 直连) | 项目绑定集群的平台级凭据 | 未来:以发起用户(或 ownerUserId)构造 impersonated ctx |
| @mention 引用注入(ref-fetch.mjs) | 同上,平台级凭据 | 同上 |
| API-key / MCP 面 | key 绑定的 SA 自身凭据(托管或 BYO) | 不适用 impersonation——SA 即身份,审计已归 key(owner 维度在平台审计链) |
| exec/portforward WS(client-node 路径;watch 的流式透传/watch-mux 是会话路径,仍 probe-gated 注入,无缺口) | 未注入(client-node 限 user-only,集群侧仅 Group 绑定——注入即 403;归因缺口,见 C.5) | 待 client-node 支持 Impersonate-Group 头,或集群侧供给 user-subject 绑定后恢复注入 |

在这些路径归真前,**平台审计链仍是完整归因源**(writeAudit 按人记录),apiserver 侧归真是增量而非替代。
