# Wave 2 Phase A:授权内核(数据模型 + effectiveGrants + 管理页)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec §10 Phase A——groups/group_members/ns_grants 数据模型、`server/authz.mjs` 单一决策函数、admin 组/授权/模式开关管理端点与页面、`/api/auth/me` grants 下发、自助 key ns 候选端点。

**Architecture:** schema 全走 CREATE IF NOT EXISTS + try-ALTER(惯例位置 index.mjs:169 user_clusters 之后);`server/authz.mjs` 纯函数核心 + db 注入(照 authorize.mjs 惯例),四态(直接授权/组授权/admin/open-allowlist)单测钉死;admin API 全部挂 `/api/admin/` 前缀地板;授权变更即级联清理孤儿(无外键体系,管理路由主动删)。

**Tech Stack:** Node + node:sqlite、node:test、Vue3 + Pinia(admin 页复刻 UserManagement.vue 范式)。

**Spec:** `docs/superpowers/specs/2026-09-05-usercenter-wave2-multitenancy-design.md` §1/§2/§3/§5/§10 Phase A

## Global Constraints

- 提交作者 `aliang-one <aliangdone@gmail.com>`(提交前核 user.email);英文信息;禁 Co-Authored-By 尾注;worktree 执行,`--no-ff` 合回,**实现者禁自行合并**(W2-0 T14 教训)。
- 零新依赖;node:sqlite 绑定禁 undefined(`?? null`);try-ALTER 在 CREATE 之后。
- **红线**:本计划不改 `/api/k8s/*` 透传、不碰网关执行(Phase B)、不降对话门(Phase D);authz.mjs 只被测试与 admin/my 端点消费,Phase B/C 才接入数据面。
- 消息双语:服务端键进 `server/messages/admin.mjs`(zh 基准);前端键 en/zh 同补;裸跑 `npm run i18n:check`。
- 门禁:`npm test` / `npm run test:unit -- --maxWorkers=2` / `npm run typecheck` / `npm run build` / 裸 `npm run i18n:check`。

---

### Task 1: 数据模型(schema + 索引)

**Files:**
- Modify: `server/index.mjs`(user_clusters CREATE 之后,:169 块后)
- Test: `server/authz.test.mjs`(新建,建库工厂供 T2 复用)

**Interfaces:**
- Produces: 表 `groups(id,name UNIQUE,createdAt,createdBy)` / `group_members(groupId,userId,addedBy,createdAt, PK(groupId,userId))` / `ns_grants(id,subjectType CHECK IN(user,group),subjectId,clusterId,namespace,level CHECK IN(view,operate),grantedBy,grantedAt, UNIQUE(subjectType,subjectId,clusterId,namespace))`;`clusters.nsAuthMode TEXT DEFAULT 'open'`(try-ALTER);索引 `idx_group_members_user ON group_members(userId)`。
- Test 工厂导出:`export function makeAuthzDb()`——建 platform_users/clusters/user_clusters/groups/group_members/ns_grants 五表(列同生产),供 T2/T3 测试 import。

- [ ] **Step 1: 写失败测试**(server/authz.test.mjs 先只放工厂 + schema 冒烟)

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
export function makeAuthzDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, username TEXT UNIQUE, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0, createdAt INTEGER)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT UNIQUE, apiServer TEXT NOT NULL, nsAuthMode TEXT DEFAULT 'open')`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, PRIMARY KEY(userId,clusterId))`)
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, createdBy TEXT)`)
  db.exec(`CREATE TABLE group_members (groupId TEXT NOT NULL, userId TEXT NOT NULL, addedBy TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(groupId,userId))`)
  db.exec(`CREATE TABLE ns_grants (id TEXT PRIMARY KEY, subjectType TEXT NOT NULL, subjectId TEXT NOT NULL, clusterId TEXT NOT NULL, namespace TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'view', grantedBy TEXT, grantedAt INTEGER NOT NULL, UNIQUE(subjectType,subjectId,clusterId,namespace))`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(userId)`)
  return db
}
test('schema:唯一约束生效(重复成员/重复授权均抛)', () => {
  const db = makeAuthzDb()
  db.prepare("INSERT INTO groups VALUES ('g1','grp-a',1,'root')").run()
  db.prepare("INSERT INTO group_members VALUES ('g1','u1',null,1)").run()
  assert.throws(() => db.prepare("INSERT INTO group_members VALUES ('g1','u1',null,2)").run())
  db.prepare("INSERT INTO ns_grants VALUES ('n1','group','g1','c1','team-a','view',null,1)").run()
  assert.throws(() => db.prepare("INSERT INTO ns_grants VALUES ('n2','group','g1','c1','team-a','operate',null,2)").run())
})
```

- [ ] **Step 2: 跑确认失败**(生产 index.mjs 无这些表——本任务测试用自建工厂先行;生产 schema 在 Step 3 落)
- [ ] **Step 3: 生产 schema**(index.mjs,user_clusters CREATE 块之后照抄测试工厂五段 + clusters try-ALTER)

```js
try { db.exec("ALTER TABLE clusters ADD COLUMN nsAuthMode TEXT NOT NULL DEFAULT 'open'") } catch { /* 列已存在 */ }
```

(生产 CREATE 用 IF NOT EXISTS 形态,列定义与测试工厂逐字一致;clusters 若 CREATE 已带 nsAuthMode 则 ALTER 吞「列已存在」。)

- [ ] **Step 4: `npm test` 确认无回归**;**Step 5: Commit** `feat(server): wave2 phase A schema — groups/group_members/ns_grants + clusters.nsAuthMode`

---

### Task 2: server/authz.mjs 单一决策函数

**Files:**
- Create: `server/authz.mjs`
- Test: `server/authz.test.mjs`(追加)

**Interfaces:**
- Produces(后续所有任务与 Phase B/C 唯一决策入口):
  - `effectiveGrants(db, principal) -> { role, clusters: Map<clusterId, { mode, ns: Map<ns, level> }> }`(admin → 全量标记 `mode:'admin'`)
  - `canAccessCluster(db, principal, clusterId) -> boolean`
  - `canAccessNs(db, principal, clusterId, namespace, needLevel) -> boolean`
  - `levelForRequest(method, subresource) -> 'view'|'operate'`(GET/HEAD → view;其余 → operate;exec/logs/portforward 子资源 → operate)
  - `sweepOrphanGrants(db) -> { members, grants }`(删 group_members/ns_grants 中 subject 不存在的行)
  - `principal = { userId, role } | null`(null=匿名 → 全拒)

- [ ] **Step 1: 写失败测试**(四态矩阵,spec §3)

```js
import { effectiveGrants, canAccessCluster, canAccessNs, levelForRequest, sweepOrphanGrants } from './authz.mjs'
// 夹具:u1(user,分配 c1,直接 grant team-a:view,组 g1(grant team-b:operate)成员);u2(分配 c1,无 grant);a1(admin);c1=allowlist,c2=open,u1 也分配 c2
test('四态:直接授权/组授权取高档/admin 全量/open 模式不参与', () => {
  const db = makeAuthzDb()
  seedGrants(db)  // 本文件内实现:按夹具插行 + clusters nsAuthMode c1='allowlist', c2='open'
  const g = effectiveGrants(db, { userId: 'u1', role: 'user' })
  assert.equal(g.clusters.get('c1').ns.get('team-a'), 'view')   // 直接
  assert.equal(g.clusters.get('c1').ns.get('team-b'), 'operate') // 组,高档
  assert.equal(canAccessNs(db, { userId: 'u1', role: 'user' }, 'c1', 'team-a', 'view'), true)
  assert.equal(canAccessNs(db, { userId: 'u1', role: 'user' }, 'c1', 'team-a', 'operate'), false) // 档位不足
  assert.equal(canAccessNs(db, { userId: 'u1', role: 'user' }, 'c1', 'team-x', 'view'), false)   // 未授权
  assert.equal(canAccessNs(db, { userId: 'u1', role: 'user' }, 'c2', 'anything', 'view'), true)  // open 模式全通
  assert.equal(canAccessCluster(db, { userId: 'u1', role: 'user' }, 'c1'), true)
  assert.equal(canAccessCluster(db, { userId: 'u1', role: 'user' }, 'c9'), false) // 未分配
  assert.equal(canAccessNs(db, { userId: 'a1', role: 'admin' }, 'c1', 'whatever', 'operate'), true)
  assert.equal(canAccessNs(db, null, 'c1', 'team-a', 'view'), false) // 匿名
})
test('sweepOrphanGrants:删用户/组后残留行被清', () => {
  const db = makeAuthzDb(); seedGrants(db)
  db.prepare("DELETE FROM platform_users WHERE id='u1'").run()
  db.prepare("DELETE FROM groups WHERE id='g1'").run()
  const r = sweepOrphanGrants(db)
  assert.ok(r.members >= 1 && r.grants >= 1)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM ns_grants WHERE subjectId IN ('u1','g1')").get().c, 0)
})
test('levelForRequest:GET→view;写→operate;exec 子资源→operate', () => {
  assert.equal(levelForRequest('GET'), 'view')
  assert.equal(levelForRequest('POST'), 'operate')
  assert.equal(levelForRequest('GET', 'exec'), 'operate')
  assert.equal(levelForRequest('GET', 'logs'), 'operate')
})
```

- [ ] **Step 2: 跑确认失败** → **Step 3: 实现**(模块全量;合成规则=spec §3:先查 user 变簇分配与 disabled(禁用→空 grants),admin → `{role:'admin', clusters:'ALL'}` 内部态,canXxx 对 admin 短路 true;ns 合并=直接∪组取高档;仅 allowlist 集群参与,open 直接 true;levelForRequest 表驱动常量 `const SUBRESOURCE_OPERATE = new Set(['exec','logs','portforward','attach']))` → **Step 4: 跑绿** → **Step 5: Commit** `feat(server): authz.mjs — single decision source (effectiveGrants/canAccessCluster/canAccessNs/levelForRequest) + orphan sweep`

---

### Task 3: admin 管理端点(组/成员/授权/模式开关)

**Files:**
- Modify: `server/routes/admin.mjs`(audit-log/verify 块后追加一节)
- Modify: `server/messages/admin.mjs`
- Test: `server/admin-authz.test.mjs`(新建,工厂照 admin-clusters-revoke.test.mjs)

**Interfaces:**
- Produces(全部 requireAdmin,`/api/admin/` 前缀地板已盖,守卫测试若要求字面量则补登记):
  - `GET /api/admin/groups` → `{ groups: [{id,name,createdAt,memberCount,grants}] }`
  - `POST /api/admin/groups {name}` → 409 重名(`admin.groupNameTaken`)
  - `DELETE /api/admin/groups/:id` → 级联删 members + 该组全部 ns_grants(`sweepOrphanGrants` 语义内联)
  - `POST /api/admin/groups/:id/members {userIds:[...]}` / `DELETE …/members/:userId` → 404 用户/组不存在(`admin.groupOrUserNotFound`)
  - `PUT /api/admin/grants {subjectType,subjectId,clusterId,namespaces:[{namespace,level}]}` → **全量替换该 subject+cluster 的 grants**;校验:user/group 存在、cluster 存在、namespace DNS 标签(复用 my-keys 同款正则)、level ∈ view|operate → 400 `admin.grantInvalid`
  - `PUT /api/admin/clusters/:id/ns-auth-mode {mode}` → mode ∈ open|allowlist → 更新 + `admin_cluster_nsmode` 审计
  - 每个变更端点 writeAudit(tool: admin_group_*/admin_grant_*/admin_cluster_nsmode)

- [ ] **Step 1: 写失败测试**(server/admin-authz.test.mjs:创建组/重名 409/成员增删/PUT grants 全量替换+非法 ns 400/不存在 subject 404/nsAuthMode 切换+非法 400/普通用户 401)
- [ ] **Step 2: 跑红** → **Step 3: 实现**(每个端点 5-15 行,照 ssh-session-policy/ users CRUD 既有形态;消息键:`admin.groupNameTaken` 组名已存在 / `admin.groupOrUserNotFound` 组或用户不存在 / `admin.grantInvalid` 授权参数非法 / `admin.nsModeInvalid` 模式须为 open 或 allowlist) → **Step 4: 跑绿 + `node --test server/route-auth-map.test.mjs`** → **Step 5: Commit** `feat(server): admin group/grant/ns-mode management endpoints`

---

### Task 4: /me grants 下发 + grantable-ns + client.js

**Files:**
- Modify: `server/routes/auth.mjs`(GET /api/auth/me 块 :79-84;GET /api/my/keys 前加 grantable-ns;deps 增注入不需要——authz 直接 import)
- Modify: `server/routes/my-keys.mjs`(POST 签发校验加 ns 候选检查)
- Modify: `src/api/client.js`(authApi.grantableNs;adminApi.groups/grants/nsMode)
- Test: `server/auth-selfservice.test.mjs`(追加)

**Interfaces:**
- Produces:
  - GET /api/auth/me 响应追加 `grants: { clusters: { [clusterId]: { mode, namespaces: [{namespace,level}] } } }`(**仅展示**;由 authz.effectiveGrants 序列化,admin → `{ role:'admin' }`)
  - `GET /api/my/grantable-ns?clusterId=` → `{ namespaces: [{namespace,level}] }`(allowlist=本人该集群 ns;open=409 `auth.grantableOpenCluster`——open 集群全员可用,无自助 key ns 限制语义,Phase C 一并裁)
  - my-keys POST 增:非 admin 且该集群 allowlist → namespace ∉ 本人 grants → 403 `mykeys.nsForbidden`(zh「该 namespace 未授权给你」/ en "Namespace not granted to you")

- [ ] **Step 1: 失败测试**(me 带 grants 形状;grantable-ns allowlist 返回本人 ns / open 返回 409;my-keys allowlist 集群签发未授权 ns → 403、授权 ns → 200)→ **Step 2 红** → **Step 3 实现**(auth.mjs:`const az = effectiveGrants(db, { userId: ps.userId, role: ps.role })` 序列化 Map→数组;grantable-ns 从 grants 取该集群 namespaces;my-keys 在集群门后加 `canAccessNs(db, { userId: ps.userId, role: ps.role }, clusterId, namespace, tier === 'read' ? 'view' : 'operate')` 不可用则 403——**这条同时落实 spec §6.1 的签发收口**) → **Step 4 绿** → **Step 5: Commit** `feat(server): /me grants payload + grantable-ns + self-service key ns entitlement check`(+ client.js 一并)

---

### Task 5: admin 管理页(组与授权)

**Files:**
- Create: `src/views/admin/GroupsGrants.vue`
- Modify: `src/router/index.js`(admin/users 旁加 `path: 'admin/groups'`,同款 meta)、SideNavBar 平台管理分组(admin/users 邻位加项)、`src/api/client.js` 已由 T4 提供
- Modify: `src/locales/en.json` / `zh.json`
- Test: `src/views/admin/__tests__/GroupsGrants.test.js`(新建)

**Interfaces:**
- Consumes: T3 全部端点(adminApi 新命名空间,与 T4 client.js 改动同一提交面)。
- Produces: 页面两栏——左「组」列表(新建/删除/展开成员管理:成员清单+按用户添加(input username→查 adminApi.users.list 匹配 id)+成员移除);右「ns 授权」编辑器(选主体组/用户 → 选集群 → ns 多选(input 逐个添加,DNS 校验)+ view/operate 每行档位切换 + 保存=PUT 全量替换);顶部说明条:**open 集群不提供 namespace 隔离**(复刻 Settings.vue admin tab 门控与卡片范式,数据加载 onMounted + 失败 notify;复刻 UserManagement.vue 的表格+行操作范式)。i18n 键:`admin.authz.*`(title/groups/members/grants/newGroup/cluster/nsAdd/level view→只读 operate→可操作/save/deleted/风险提示 openNoIsolation 等约 14 键,en/zh 全配)。

- [ ] **Step 1: 失败测试**(挂载拉 groups;新建组调 POST;选组展开成员;添加成员调 POST members;grants 保存调 PUT 且 payload 全量替换形状;open 提示条文案渲染)→ **Step 2 红** → **Step 3 实现**(组件 ≤300 行,范式照 UserManagement.vue/Settings.vue;adminApi 扩展归并此任务提交) → **Step 4 绿 + build + 裸 i18n:check** → **Step 5: Commit** `feat(admin): groups & ns-grants management page with open-mode risk notice`

---

### Task 6: 门禁收口

- [ ] **Step 1:** `npm test`;`npm run test:unit -- --maxWorkers=2`;`npm run typecheck`;`npm run build`;裸 `npm run i18n:check`——全绿,唯一可豁免=记忆在案 flaky(隔离复跑记录)。
- [ ] **Step 2: 退出判据自检**(spec §10 Phase A):直接授权/组授权/admin/open-allowlist 四态单测齐(T2);授权对象不存在/ns 非法/集群不存在拒绝写入(T3 测试);索引与孤儿清理(T1/T2)。
- [ ] **Step 3: 合并**(控制器执行,实现者不合并)。

## 手测(重启网关)

① 新建组→加成员→对 allowlist 集群授 team-a:view → 成员在 /profile 看到 grants;② open 集群显示「未启用隔离」提示;③ 删组后其 ns_grants 行消失(自查 sqlite);④ /api/my/grantable-ns 对 open 集群 409。

## 非目标

网关执行/B 期解析器、wb 工具与 @mention 接入(C)、对话降门(D)、impersonation(E)——本计划交付后 Phase B/C/D/E 各自出计划。
