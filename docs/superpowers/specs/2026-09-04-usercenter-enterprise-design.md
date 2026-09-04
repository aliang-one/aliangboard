# 用户中心企业化 · 总路线 + Wave 1 设计 + Wave 2 架构约束

- 日期: 2026-09-04
- 状态: 待用户评审
- 裁决来源: 2026-09-04「用户中心的细化」会话。现状盘点与正统性验证由 ultracode 工作流完成(6 agent 盘点 + 3 agent 逐字核对 K8s 官方文档与四平台官方 docs,88 次工具调用)。
- 关联: `src/views/UserProfile.vue`(现状 203 行单页三卡)、`server/routes/auth.mjs`、`server/auth-keys.mjs`、`server/route-auth-map.mjs`

---

## 0. 背景与已裁决事项

**目标形态**: 开源产品(对标 Kuboard/Rancher),企业化分波次推进——用户 2026-09-04 裁决。

**现状盘点结论**(已逐行核实,含批评者抽查): 身份**底座强**——会话双写(内存+SQLite,重启不掉线)、8h 绝对 TTL、每用户上限、改密/admin 禁用/降级/删户/重置五路全部级联吊销会话并回收派生 K8s 凭据、scrypt、ip|username 令牌桶防爆破、链式哈希审计、ROUTE_AUTH 单一事实源。**个人域窄**——UserProfile 单页三卡(资料/安全/偏好),偏好仅 language+theme 两键;人类用户在 namespace 维度无任何限制(共享 admin 集群凭据);无 MFA/SSO/个人令牌/头像/email。

**正统性验证结论**(详见附录 A): 「组 + namespace 授权」是 K8s 官方与 Rancher/KubeSphere/Portainer/Kuboard 一致的正统模型;执行层的修正裁决——**网关执行是过渡态,「impersonation 注入身份 + 集群原生 RBAC 执行」是正统终态、必做项**(Rancher 原话: enforcement is performed by Kubernetes)。

**授权传导裁决**: API key、Workspace 项目、AI 工具与搜索三面全部受使用者权限约束(§4.5);项目组共享纳入 Wave 2。

---

## 1. 四波总路线

| 波次 | 主题 | 内容 | 风险 |
|---|---|---|---|
| **Wave 1** | 个人域补全 | tab 化 + 我的活动 + 访问令牌 + 偏好丰富化 + 头像 + 会话卡补强 + 密码策略可配置 | 低,纯增量 |
| **Wave 2** | 组 + ns 授权 + 授权传导 | 本地组/组员/ns 授权表、网关执行、授权传导(key/工作台/AI/搜索)、impersonation 终态 | 中,动数据面 |
| **Wave 3** | 安全加固 | TOTP MFA + step-up 重认证 + admin 会话治理 + 个人 kubeconfig | 中高,动登录链路 |
| **Wave 4** | 企业身份 | OIDC → LDAP/组映射 → SCIM | 高,从零建 |

**顺序理由**: Wave 1 全部是加法,不碰登录链路;多租户授权(企业第一门槛)插队为 Wave 2,MFA 顺移 Wave 3——kubeconfig 下载在 ns 授权落地后价值更大(下载的是裁剪过的凭据);OIDC 之前必须先有 MFA 与会话治理,组模型按本地建,Wave 4 只换供给来源(IdP claims),授权模型不动。

---

## 2. 设计公理(全体系承重墙,任何波次不得违背)

1. **派生身份 ⊆ 主身份**: key、AI 会话产出、kubeconfig 等一切派生物的权限永不超出其归属用户的实时权限。
2. **AI 不是主体**: AI 永不拥有独立权限;每次工具调用都代表一个主体(用户平台会话,或 API key → 归属用户)。
3. **单一决策函数,三个执行面**: 一个 `effectiveGrants(principal)` 模块;K8s 代理面 / wb 工具+MCP 面 / 搜索与枚举面全部调它,禁止各写一套。
4. **请求时求值**: 权限变更即时生效,不落物化副本(唯一例外: 集群侧 RBAC 绑定,依赖既有漂移检测/自愈)。

**反模式教训(来自同侪实证,设计必须显式规避)**:
- 共享 SA 是主流明文否定的反模式(Rancher: 每用户一个仅含 impersonate 权限的 SA,单一共享账号被攻破即可 impersonate 他人提权)——现状(全平台共享 admin 集群凭据)即此反模式,Wave 2 v2 步是迁移不是加固。
- **CVE-2021-31999(8.8 分)**: Rancher 代理本应剥离客户端伪造的 `Impersonate-*` 头,被 hop-by-hop Connection 头走私绕过 → 本网关实现必须**无条件剥离入站 `Impersonate-*` / `X-Remote-*` 头**,进验收标准。
- 本地登录常开使 MFA 形同虚设(Rancher #26759)→ Wave 3 MFA 必须裁决本地密码是否留 break-glass 并在 UI 明示。
- 自建角色工厂会 fork 出与 K8s RBAC 平行的影子权限体系 → 只做 view/operate 两档,不做自定义角色。

---

## 3. Wave 1 详细设计: 个人域补全

### 3.1 IA: 单页三卡 → tab 化

`UserProfile.vue` 拆为壳 + 5 个子组件目录(建议 `src/components/userCenter/`): **资料 / 安全 / 偏好 / 活动 / 访问令牌**。tab 状态走路由 query(`?tab=security`),可直达、可分享;缺省 `profile`。现有三卡内容迁入对应 tab,行为不变(UserProfile.test.js 既有 10 契约迁移跟随)。新增两个重分区后垂直堆叠不可持续,此为 tab 化时机。

### 3.2 「我的活动」tab

- 新端点 `GET /api/my/activity`,ROUTE_AUTH 登记 **platform** class。按**当前用户 username** 过滤 `audit_log`(owner 为 username 字符串,现状即此),复用既有分页与过滤器模式;时间窗口 v1 固定 90 天(UI 明示),事件类型过滤(登录/改密/会话吊销/工作台/MCP 调用等,按现有 tool 字段聚类)。
- 只读。普通用户第一次能看到自己的登录历史、失败尝试、被吊销记录、AI/MCP 调用记录——审计数据早已全量在记,此为近零成本关闭的最大缺口。
- 不提供导出(Wave 3 再议),不显示他人记录。

### 3.3 「访问令牌」tab: 个人 API key 自助(双类 key 第一天形态)

**schema**(全部 try-ALTER 幂等迁移,项目惯例):
- `api_keys` 加 `ownerUserId`(NULL = 服务 key/存量);`lastUsedAt`、`lastUsedIp`(请求时懒更新,session-touch 式节流回写)。

**key 两类**(裁决: 双类并存,勿回改存量语义):
- **用户 key**(新,自助签发): `ownerUserId` 必填=签发者。**生效权限 = key 显式配置 ∩ owner 实时权限**。Wave 1 交集为集群粗版: key 可用集群 ⊆ owner 的 `user_clusters` 分配(单点判断,置于 key 鉴权路径)。ns 级交集随 Wave 2 授权模型生效。自助签发 tier 上限 = operator(admin 可发全部 tier);TTL 默认 30d、上限 90d(平台设置,admin 可调);明文仅签发时回显一次(沿用现有)。用户可在 tab 内列自己的、吊自己的;admin 在 ApiKeyManagement 可见全部、可吊任意(列增 owner 展示)。
- **服务 key**(存量): `ownerUserId` 为 NULL,显式 scope,仅 admin 可建——保护现有 MCP 集成不被创建者个人权限变化误杀(等价 GitHub「用户 PAT vs App 安装」之分)。

**级联**: 删户/禁用用户 → 级联吊销其名下全部用户 key(与现有会话级联同路径收口,补「owner 是自由文本、删户 key 不随动」的洞)。

**新端点**(全部 ROUTE_AUTH 登记 platform): `POST /api/my/keys`、`GET /api/my/keys`、`DELETE /api/my/keys/:id`。归属过滤保证只能操作自己的。

### 3.4 偏好丰富化

`preferences` store 与服务端 `prefs` JSON(现有 8 列中的 prefs 列,try-ALTER 迁移已有)新增键:
- `landingView`: 登录/连接集群后的落地页(候选: 集群总览(现状默认)/ 工作台 / 上次访问);消费点为登录后跳转逻辑。
- `defaultClusterId`、`defaultNamespace`: 进入集群域时的默认上下文(auto-connect 与 ns 选择器初值)。
- `rowsPerPage`: DataTable 全局默认行数,DataTable 单点读取;各视图显式传参者不被覆盖。

**砍掉**(裁决): 日期格式(收益低)、YAML 编辑器键位(自研 CodeTextarea 无键位概念)。

### 3.5 头像

- 存 **SQLite blob**(裁决: 遵守单库不变式,不引入第二存储路径): `platform_users` 加 `avatar`(BLOB)+ `avatarMime`(TEXT)。
- `PATCH /api/auth/me` 扩展接受头像(base64,≤200KB,png/jpeg/webp);前端 canvas 裁剪压缩至 256×256 再传;服务端再校验大小与 mime 白名单。
- 读取: `GET /api/auth/me/avatar`,platform class,走请求头鉴权(前端 fetch → objectURL,不用 `<img src>` 裸链,避免 query token 进访问日志);ETag 缓存。无头像回退首字母圆(UserMenu/UserProfile 两处消费)。

### 3.6 会话卡补强

- 显示 `createdAt`(服务端已回传、前端丢弃——批评者抓到的真缺口),行内格式「登录于 … · 最近活跃 …」。
- 加手动刷新钮(onMounted 单次 → 可重拉)。
- 吊销语义不变(当前行无吊销钮、防自锁 400 契约保持)。

### 3.7 密码策略可配置

- `platform_settings` 新键 `auth.passwordPolicy`: `{ minLength, requireMixed, requireDigit, requireSymbol }`;默认 `{8, false, false, false}`——**默认行为与现状完全一致**(升级零感知)。
- `password-policy.mjs` 保持纯函数: `isPasswordOk(pwd, policy)` 改为策略注入;三路调用方(自助改密 `auth.mjs`、admin 建户/重置 `admin.mjs`)读 settings 后传入,单源不变。
- admin 设置页(Settings.vue)增策略编辑块。
- 客户端校验(UserProfile 三字段)同步消费策略(挂载时拉取)。

### 3.8 Wave 1 非目标(明确不做)

email/忘记密码自助恢复(牵出整条 SMTP 链路,价值/成本比差,Wave 4 后再议)、通知偏好、个人态漫游(自建列/草稿/已读标记服务端化——列为 Wave 3+ backlog)、kubeconfig 下载、MFA。

### 3.9 Wave 1 验收标准

1. `/profile?tab=activity` 直达活动 tab;普通用户可见 90 天内自己的登录/改密/吊销/调用记录,看不到任何他人行。
2. 普通用户自助签发 key: 明文仅一次;其集群范围超出自身 `user_clusters` 分配的部分不生效(交集验证);删户后 key 全部失效;`lastUsedAt` 在调用后出现。
3. 服务 key(存量)行为零变化;admin 列表可见 owner。
4. 头像上传 256×256 后,顶栏 UserMenu 与资料卡同步显示;>200KB 或非法 mime 被拒;清空回退首字母。
5. 偏好四键持久化(双写 localStorage + PUT preferences),换浏览器登录后跟随账号;`rowsPerPage` 改变 DataTable 默认。
6. 密码策略默认不改变任何现状;admin 调成严格档后,改密/建户/重置三路同时生效。
7. `npm test` / `npm run test:unit` / `npm run typecheck` / `npm run i18n:check` 全绿;新端点全部登记 ROUTE_AUTH(守卫测试强制);新 UI 文本 en/zh 双语齐。

---

## 4. Wave 2 架构约束: 组 + ns 授权 + 授权传导

> 本节为约束与裁决固化;Wave 2 开工前出独立详细 spec + 实施计划。

### 4.1 数据模型

```
groups(id, name, createdAt)
group_members(groupId, userId, UNIQUE(groupId,userId))
ns_grants(id, subjectType user|group, subjectId, clusterId,
          namespace, level view|operate,
          grantedBy, grantedAt, UNIQUE(subjectType,subjectId,clusterId,namespace))
user_clusters 保留(集群粗门禁,语义不变)
```

- 组**平铺**,不做嵌套;K8s 不存 Group 对象(组只是认证层产出的字符串),故本地 groups 表将来接 OIDC claims 供给时授权模型零改动。
- **不做空间层**(Rancher Project/KubeSphere Workspace): v1 组 → ns 直接授权,与 Portainer/Kuboard 同构;多选 ns 授权 UI 顶住批量需求。schema 已留演化位(将来加 projects 表,ns_grants 加引用即可)。

### 4.2 授权语义(裁决)

- **按集群切模式开关**: 每集群 `nsAuthMode: open(现状全开) | allowlist`,默认 open——升级零感知,admin 对多租户集群逐个开启,避免把存量用户锁死。
- **两档 level**: `view`(只读动词集)/ `operate`(读写)。不做自定义角色(反模式教训,§2)。
- **集群级资源**(Nodes/PV/StorageClass/ClusterRole/CRD 等): 非 admin 整域隐藏(导航不出现),不做 ns 级细授权。
- admin 恒全量,不受 ns_grants 约束。

### 4.3 执行 v1: 网关执行(DB 单一事实源)

- 提取: 复用 `kind-paths.mjs` 路径语法,从请求路径 + `fieldSelector` 提取目标 namespace;WS/watch 流同检(`k8s-watch-mux`)。
- 强制: allowlist 集群上,白名单外 ns 一律 403(拒绝也写审计);`GET /namespaces` 列表**过滤响应**只回授权项;写动词按 level 档位映射。
- UI 适配: ns 下拉/导航只出授权项;直达 URL 落 403 页;`effectiveGrants` 随 `/api/auth/me` 下发供前端渲染。
- **只有 UI 过滤、没有网关强制的版本不交付**。

### 4.4 执行 v2(必做收尾,非可选加固): impersonation + 集群 RBAC

- 网关转发加 `Impersonate-User: aliangboard:u-<userId>` + `Impersonate-Group: aliangboard:team-<groupId>`(命名对齐 Rancher 惯例;内部 ID 为主,可读名走 Extra 头,对齐其 v2.6 审计实践)。
- 集群内按**组**建 Role/RoleBinding(view/operate 两套,复用托管 SA 的供给 + 漂移检测/自愈机器);绑定按组不按人,供给成本随组数不随人数。
- **无条件剥离入站 `Impersonate-*` / `X-Remote-*` 头**(CVE-2021-31999 教训,进验收)。
- 信任面说明: impersonation 授权不可 namespace 限定(ClusterRole,1.36 前无可收窄),网关凭据成为集群级全权委托——与现状(已持集群 admin 凭据)同级,**不扩大信任面**,如实写进部署文档。
- 收益: apiserver 成为第二执行点,集群审计归到真人(现状: 所有人类操作都算同一 SA 头上)。

### 4.5 授权传导(三面一函数)

- **决策函数**: `effectiveGrants(principal)` 单源;principal = 用户平台会话 | API key(→ 归属用户实时 grants ∩ key 显式配置)。请求时求值(公理 4)。
- **API key 面**: 用户 key 生效权限 = 显式配置 ∩ owner 实时 grants(升级 Wave 1 的集群粗交集为 ns 级);禁用/删户/缩权即刻生效;删户级联吊 key。
- **wb 工具 + MCP 面**: 全部 wb_* 工具执行器入口过 `effectiveGrants`(ns 类工具逐调用检;枚举类工具过滤候选集);MCP 路径经 key → owner 同检。**提示词级限制不算执行**(prompt injection 可穿),一切在工具执行器强制。
- **@mention 引用面**: `fetchRefContext`/`buildRefsContext` 注入 LLM 前,每个 ref 过同一决策函数——堵「界面看不见、AI 却引用得到」通道。
- **搜索面**: 权限过滤发生在**枚举源**,不发生在搜索框——搜索框的候选集必须来自已授权查询(反例: 全量列表 + 逐项判权 = 时序绕过/缓存/新资源三重漏)。走 K8s 代理的搜索经 4.3 免费正确;项目搜索 = owner ∪ 共享组;服务器搜索维持 exposeToAi 闸(服务器绑组留后续)。
- **Workspace**: 项目 `visibility: private | group` + 可见组列表(读扩展;写仍 owner+admin);**对话 requireAdmin×16 语义裂缝收口**为 owner-scoped(动前先核实现状意图)。
- **缓存残留**: 授权收缩后 Vue Query 缓存短暂残留 → 403 触发修剪;必要时 grants 版本号,可后置。

### 4.6 Wave 2 非目标

硬多租户(ns 模型不覆盖 CRD/StorageClass/Node/Webhook 等,真硬隔离 = 独立集群/vcluster,由多集群产品形态接住: 给租户分独立集群)、自定义角色、空间层、组嵌套、NetworkPolicy 类数据面隔离自动化。

### 4.7 Wave 2 验收标准(五条路全堵)

1. allowlist 集群上,A组成员对 B 组 ns:UI 导航不出现、直达 403、K8s API 直调 403、AI 工具调用被拒、@mention 引用为空。
2. `GET /namespaces` 仅回授权项;WS/watch 对未授权 ns 建流被拒。
3. 用户 key 在 owner 缩权后即刻失效对应 ns;删户 key 全灭。
4. v2 后集群审计日志出现 `aliangboard:u-<id>`;伪造 `Impersonate-User` 头的入站请求被剥离(漏洞复测用例)。
5. 授权变更后,集群内 RoleBinding 在漂移检测周期内收敛。

---

## 5. Wave 3/4 锚点(不在本 spec 展开)

- **Wave 3**: TOTP(用户自选启用 + admin 强制策略 + 恢复码;本地密码是否留 break-glass 须显式裁决并 UI 明示)、敏感操作 step-up 重认证、admin 会话可见性/强制下线、个人 kubeconfig 下载(**随平台会话吊销而死** + ns 裁剪——Rancher 30 天长效 token 是被批评的教训不是目标)。
- **Wave 4**: 通用 OIDC(本地登录开关 + break-glass admin)→ LDAP/组映射 → SCIM;IdP claims 接管 groups 供给,授权模型不动。

---

## 6. 证据附录 A: 正统性验证(2026-09-04,逐字核对官方文档)

| 断言 | 结论 | 来源 |
|---|---|---|
| RBAC subjects 原生 `kind: Group` | ✅ supported | kubernetes.io/docs/reference/access-authn-authz/rbac/ |
| Impersonate-User/-Group/-Extra/-Uid + impersonate verb;authentication proxy 形态获官方陈述 | ✅ supported | kubernetes.io/docs/reference/access-authn-authz/user-impersonation/ ; …/authentication/ |
| Authenticating reverse proxy(X-Remote-*)与 impersonation 是两种机制 | ✅(本网关走 impersonation 路线,免改 apiserver 旗标) | 同上 authentication 页 |
| namespace = 官方团队隔离边界 | ✅ supported | kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/ |
| 软/硬多租户光谱;ns+RBAC 是软多租户标准解 | ✅ supported | kubernetes.io/docs/concepts/security/multi-tenancy/ |
| Rancher: 组可绑全局/集群/项目角色;Project = group of namespaces,权限授在 project 级 | ✅ supported | ranchermanager.docs.rancher.com(manage-users-and-groups;projects-and-namespaces) |
| Rancher 代理只做认证+impersonation 注入,逐请求执行由 kube-apiserver 完成 | ✅(修正了「代理层自判 RBAC」的初版说法) | 同上 architecture 页 |
| Rancher: Impersonate-User = 内部 ID u-xxxx,v2.6 起审计补记外部名;共享 SA 被官方否定 | ✅ supported | 同上 + issues #55596 |
| KubeSphere: platform/cluster/workspace/project 四级,iam.kubesphere.io CRD 由 ks-apiserver 判;kubeconfig 按登录用户生成、权限随用户 | ✅ supported | dev-guide.kubesphere.io(access-control);docs.kubesphere.co(toolbox kubeconfig) |
| Portainer: 用户/团队→endpoint→ns grant + 固定角色,但**仅 Business 版**(CE 无权限限制);kubeconfig 指回 Portainer | ✅ supported | docs.portainer.io(kubernetes-roles-and-bindings) |
| Kuboard: 用户/用户组 + 全局/集群/名称空间三档 RoleBinding,官方推荐绑组 | ✅ supported | kuboard.cn/learning(auth-namespace;SSO 授权页) |
| CVE-2021-31999: 代理须剥离 Impersonate-*,否则 hop-by-hop 走私 | ✅ supported | github.com/rancher/rancher/security/advisories/GHSA-pvxj-25m6-7vqr |
