# 用户中心 Wave 2 详细设计:组 + namespace 授权 + 授权传导

- 日期: 2026-09-05
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

---

## 1. 数据模型

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
6. **project 绑集群闸**:PUT /:id/cluster(workbench-projects.mjs:138 现仅校验归属)**追加** `user_clusters` 分配校验;对话运行时(workbench-agent.mjs:185,:277 重建 k8sSession 处)同检。

## 3. effectiveGrants:单一决策函数

新模块 `server/authz.mjs`(纯函数核心 + db 适配注入,照 authorize.mjs 惯例):

```
effectiveGrants(db, principal) -> { role, clusters: { [clusterId]: { mode, ns: Map<ns, 'view'|'operate'> } } }
canAccessNs(db, principal, clusterId, namespace, needLevel) -> boolean   // 便捷封装
principal = { kind:'user', userId, username, role }                      // 平台会话
         | { kind:'key', keyRow }                                        // → 归属用户实时 grants ∩ key 自身 ns 配置
```

- **请求时求值**(公理 4):每次判定现查 groups/group_members/ns_grants + platform_users.role/disabled;不落物化副本。
- **AI 不是主体**(公理 2):wb 工具/@mention/对话全部以发起用户为 principal;MCP 以 key 归属用户为 principal。
- 单一事实源:K8s 代理面、wb 工具面、@mention 面、key 面**全部调它**(公理 3);禁止各处自写判定。
- 性能:每请求 2-3 个索引查询(PK/UNIQUE 命中),与既有 platformUserFromRequest 逐请求复读惯例同级;如成瓶颈再加 5s 进程内缓存(keyed by user + grants 版本号),**先不加**(YAGNI)。

## 4. 网关执行 v1(allowlist 集群上)

**新写 `server/k8s-path.mjs` 反向解析器**(审计确认缺口):`parseApiPath(pathname) -> { clusterScope, namespace, resource, name, verbHint } | null`——基于 `KIND_API` 的 prefix 表 + `/apis/<group>/<version>/` 通配;未知路径 **fail-closed**(拒)。fieldSelector 中的 `namespace=`/`fieldSelector=metadata.namespace` 同步提取校验(注入面,新写)。

执行点:`server/index.mjs:2076` 路径剥离之后、上游转发之前,统一一道;`/api/k8s-watch` 在 `parseResources`(k8s-watch-mux.mjs)后按资源 ns 校验。

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

`resolveApiKey` 判定链追加(在现有 owner 存活 + 集群粗交集之后):owner 的 `effectiveGrants` 中该集群为 allowlist 时,key 的 `effectiveNamespaces` 与 owner 授权 ns **求交集**;交集为空 → null。实现为 authz.mjs 的 key-principal 路径,resolveApiKey 调它——**仍单点**,MCP 与 HTTP 门同享。服务 key(ownerUserId NULL)不受影响。`refetch`/重供给:授权变更后 key 的集群内 SA RBAC 由既有 drift 检测收敛(验收 §9.5)。

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

- **wb_* 工具**:tool-registry 枚举/操作类工具的执行实现(index.mjs:1243-1463)统一加 `canAccessNs(principal, project.clusterId, ns, levelByTool)`,ns 来源:工具参数显式 ns,或 `listResources` 类无 ns 调用 → **结果按授权 ns 过滤**(listApiPath 集群级调用改白名单内逐 ns 并集,或对响应 items 过滤——取响应过滤,与通道 1 同构);集群级 kind 工具对非 admin 在 allowlist 集群拒。工具执行凭据维持平台级(v1);v2 impersonation 后自动归真。
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

allowlist 集群上,组 A 成员 u1 对组 B 的 ns `team-b`:

1. UI:ns 下拉无 team-b;直达 URL 落 403 页;集群级导航页隐藏。
2. K8s API:任何 path/fieldSelector/watch 手法触达 team-b → 403 + denied 审计行(带 clusterId/namespace);`GET /namespaces` 响应无 team-b。
3. **伪造头**:携带 `Impersonate-User: x` 的入站请求被剥离后正常判定(漏洞复测用例)。
4. API key:u1 的 key boundNS=team-a 且 u1 无 team-b 授权 → 经 MCP/HTTP 触达 team-b 一律 denied;u1 被移出组 A 后即刻生效。
5. 集群内 RBAC:grants 变更后 RoleBinding 在漂移检测周期内收敛;u1 的请求在集群审计日志出现 `aliangboard:u-<id>`。
6. Workspace:u2(u1 的非 admin 同事)不可读/流/删/批 u1 的任何对话(403);records 只见自己的对话与统计;presence 不含他人;`/search` server 分支不泄露他人项目。
7. AI 面:u1 的对话 agent 调 wb_list_resources/wb_get_pod_logs 触达 team-b 被拒;@mention team-b 资源注入为空;普通用户现在**可以**正常使用工作台对话(降门后)且仅见自己项目。
8. 回归:`open` 模式集群行为与 Wave 1 逐字节一致(存量部署零感知);`npm test` / `test:unit` / `typecheck` / `i18n:check` / `build` 全绿;新端点全登记 ROUTE_AUTH;新 UI 文本双语齐。

## 10. 实施分期(每期独立可合、可验收)

| 期 | 内容 | 依赖 |
|---|---|---|
| **A** | 数据模型 + authz.mjs(effectiveGrants)+ admin 管理页(组/授权/模式开关)+ /me 下发 grants | 无 |
| **B** | k8s-path 反向解析器 + 网关执行(通道 1/2/3)+ denied 审计 + UI 403/导航适配 | A |
| **C** | 授权传导:key ns 交集(§6.1)+ wb 工具与 @mention 过滤(§6.3)+ Workspace 修复包(§6.2) | A,B |
| **D** | 对话 15 端点降门 + records/presence 开放(§6.2 A/B/C/F)——**必须在 C 合入后** | C |
| **E** | Impersonation v2(§7) | B |

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
