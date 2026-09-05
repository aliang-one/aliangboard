# W2-0:关闭现有授权绕过 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Wave 2 spec §10 Phase 0——K8s session 归属化与逐请求复检、取消集群分配/删集群即吊销存量会话、Workspace 三处集群门、浏览器 token 账号切换不复用、双用户负向测试夹具、WorkbenchChat CAS flaky 确定性——**不改对话 requireAdmin,不实施 groups/ns grants**。

**Architecture:** 服务端三层:①`sessions` 表加归属列(userId/clusterId),connect-cluster 落戳,持久化往返跟随;②新 `server/session-guard.mjs` 纯函数逐请求复检(用户禁用/失去分配即会话失效),挂进 `sessionFromRequest` 单点;③`server/session-revoke.mjs` 增 `revokeUserClusterSessions`/`revokeClusterSessions` 双路径吊销(platform_sessions 链 + sessions.userId 直查),admin 两个变更点接线。前端仅 auth store 登录/登出的 token 清理。零依赖、零 UI 变化。

**Tech Stack:** Node + node:sqlite(try-ALTER)、node:test(服务端)、vitest + happy-dom(前端 auth store)。

**Spec:** `docs/superpowers/specs/2026-09-05-usercenter-wave2-multitenancy-design.md` §0.4 + §2.6 + §10 Phase 0(含七个子项与退出判据)

## Global Constraints

- **范围红线**:不修改 `workbench-conversations.mjs` 的任何 requireAdmin;不创建 groups/group_members/ns_grants;不做 nsAuthMode。
- 提交作者恒 `aliang-one <aliangdone@gmail.com>`(提交前 `git config user.email` 复核);英文提交信息;**禁止** `Co-Authored-By` 尾注;worktree 分支执行,完成后 `--no-ff` 合回 main。
- 零新增依赖;node:sqlite 绑定值禁止 `undefined`(一律 `?? null`);try-ALTER 必须在 CREATE TABLE 之后(顺序不变式,index.mjs:182-184 注释)。
- 服务端用户可见消息走 `msg(req,'wbp.*')`(`server/messages/wbp.mjs` 双语,zh 为基准)。
- 门禁:`npm test`、`npm run test:unit -- --maxWorkers=2`、`npm run typecheck`、`npm run build`、裸跑 `npm run i18n:check`(禁 tail 管道);新端点零(Route 无新增),既有 ROUTE_AUTH 不动。
- 兼容红线:旧库升级路径(sessions 已有行、无新列)必须无损;无归属的存量 session(升级前落库)行为不变(活到 TTL),只是不受新复检约束——**不得在升级时批量杀存量会话**。
- 性能红线:逐请求复检 = 每 K8s 请求最多 2 个索引查询,与 platformUserFromRequest 逐请求复读同级;禁止加缓存(YAGNI,Phase A 再议)。

---

### Task 1: sessions 归属列 + connect-cluster 落戳

**Files:**
- Modify: `server/index.mjs:115-118`(sessions try-ALTER)、`server/index.mjs:383-393`(stmtUpsert + persistSession)、`server/index.mjs:409-416`(loadPersistedSessions 映射)
- Modify: `server/routes/auth.mjs:252-264`(connect-cluster 落戳)
- Test: `server/auth-selfservice.test.mjs`(追加;该文件已有 createAuthRoutes 路由级测试工厂)

**Interfaces:**
- Produces: sessions 新列 `userId TEXT` / `clusterId TEXT`;`persistSession(token, session)` 落库两列(取 `session.userId ?? null` / `session.clusterId ?? null`);connect-cluster 构造的 k8sSession 对象携带 `userId: ps.userId` 与 `clusterId: cluster.id`(内存对象与持久化行一致)。Task 2/3 消费这两个字段;旧库旧行(userId NULL)行为不变。

- [ ] **Step 1: 写失败测试**(auth-selfservice.test.mjs 追加;沿用该文件 makeRoutes 工厂——`persistSession` 已在 deps,改为可捕获的 spy)

```js
test('connect-cluster:签发的 K8s session 携带 userId+clusterId(persistSession 落戳)', async () => {
  const db = makeDb(); seed(db)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT, apiServer TEXT NOT NULL,
    authHeader TEXT, ca TEXT, cert TEXT, key TEXT, insecure INTEGER DEFAULT 0, version TEXT)`)
  db.prepare(`INSERT INTO clusters (id,name,apiServer) VALUES ('c1','prod','https://k8s:6443')`).run()
  // 按该文件工厂的 over 机制注入:persistSession spy + requestKubernetes stub(version 探测)
  const persisted = []
  const routes = makeRoutes(db, { _persistSession: (tok, s) => persisted.push({ tok, s }), _requestKubernetes: async () => ({ body: { gitVersion: 'v1.30' } }) })
  const sent2 = []
  await routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' } },
    { writeHead() {}, end(p) { sent2.push(JSON.parse(p)) } },
    new URL('http://x/api/connect-cluster'), /* readBody 由 deps._body 提供: {clusterId:'c1'} */)
  // 断言(以该文件实际 sendJson 捕获方式对号):响应 200 且
  // persisted[0].s.userId === 'u1' && persisted[0].s.clusterId === 'c1'
})
```

(执行者按该文件既有 `deps._body` 注入 body `{clusterId:'c1'}`、按既有 sent 捕获方式断言 200;`persistSession` 若工厂里是 no-op,改为通过 `over._deps` 覆盖并可捕获。断言核心:`persistSession` 收到的 session 对象含 `userId==='u1'`、`clusterId==='c1'`。)

- [ ] **Step 2: 跑确认失败**(persistSession 收到的对象无 userId)
- [ ] **Step 3: 实现**

`server/index.mjs:118` 之后(endpointIdx ALTER 旁):

```js
try { db.exec('ALTER TABLE sessions ADD COLUMN userId TEXT') } catch { /* 列已存在 */ }   // W2-0:归属(谁连的)
try { db.exec('ALTER TABLE sessions ADD COLUMN clusterId TEXT') } catch { /* 列已存在 */ } // W2-0:哪个集群
```

`stmtUpsert`(index.mjs:383-385)扩两列:

```js
const stmtUpsert = db.prepare('INSERT OR REPLACE INTO sessions (token, apiServer, authHeader, ca, cert, key, insecure, version, createdAt, endpoints, endpointIdx, userId, clusterId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
```

`persistSession`(:386-393)run 尾部追加 `session.userId ?? null, session.clusterId ?? null`(11→13 个绑定)。

`loadPersistedSessions`(:410-416)session 对象追加两行:

```js
        userId: r.userId || undefined,
        clusterId: r.clusterId || undefined,
```

`server/routes/auth.mjs` connect-cluster(:252,k8sSession 构造处):

```js
        const k8sSession = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now(), userId: ps.userId, clusterId: cluster.id }
```

- [ ] **Step 4: 跑确认通过**(该测试文件 + `node --test server/session-lifecycle.test.mjs` 若存在)
- [ ] **Step 5: Commit**

```bash
git add server/index.mjs server/routes/auth.mjs server/auth-selfservice.test.mjs
git commit -m "feat(server): stamp k8s sessions with userId+clusterId (schema, persist, reload, connect-cluster)"
```

---

### Task 2: session-guard 逐请求复检

**Files:**
- Create: `server/session-guard.mjs`
- Modify: `server/index.mjs:457-466`(sessionFromRequest 挂 guard)
- Test: Create `server/session-guard.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 session.userId/clusterId。
- Produces: `sessionOwnerValid(db, session) -> boolean`——`session.userId` 为空(存量无归属会话)→ true(兼容,活到 TTL);`platform_users` 无此 id 或 `disabled=1` → false;`session.clusterId` 非空且该用户**非 admin**且 `user_clusters` 无 (userId,clusterId) → false;其余 true。读库异常 fail-closed(false)。

- [ ] **Step 1: 写失败测试**(server/session-guard.test.mjs)

```js
// W2-0 §0.4-1/2:K8s session 逐请求复检——禁用/失去分配即刻失效;无归属存量会话兼容放行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { sessionOwnerValid } from './session-guard.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0)`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT)`)
  return db
}

test('复检矩阵:禁用→false;失配分配→false;admin 不看分配;无归属→true(兼容);db 异常→false', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO platform_users VALUES ('u1','user',0)`).run()
  db.prepare(`INSERT INTO platform_users VALUES ('u2','user',1)`).run()
  db.prepare(`INSERT INTO platform_users VALUES ('a1','admin',0)`).run()
  db.prepare(`INSERT INTO user_clusters VALUES ('u1','c1')`).run()
  const s = (userId, clusterId) => ({ userId, clusterId })
  assert.equal(sessionOwnerValid(db, s('u1', 'c1')), true)     // 正常
  assert.equal(sessionOwnerValid(db, s('u2', 'c1')), false)    // 禁用
  assert.equal(sessionOwnerValid(db, s('u1', 'c9')), false)    // 失去分配
  assert.equal(sessionOwnerValid(db, s('a1', 'c9')), true)     // admin 豁免
  assert.equal(sessionOwnerValid(db, s(undefined, undefined)), true) // 存量无归属
  assert.equal(sessionOwnerValid(db, s('ghost', 'c1')), false) // 用户已删
  assert.equal(sessionOwnerValid(makeDb(), s('u1', 'c1')), false) // 表不存在 = fail-closed
})
```

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**

```js
// K8s session 逐请求归属复检(W2-0 §0.4):会话凭据是 bearer 型,归属列让服务端能判
// 「持有人是否仍有效」。对齐 resolveApiKey 的实时收权语义(请求时求值,公理 4)。
// 无归属的存量会话(升级前落库)兼容放行——活到 TTL,升级不批量杀会话。
export function sessionOwnerValid(db, session) {
  if (!db || !session?.userId) return true
  try {
    const u = db.prepare('SELECT role, disabled FROM platform_users WHERE id=?').get(session.userId)
    if (!u || u.disabled) return false
    if (u.role !== 'admin' && session.clusterId) {
      const assigned = db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(session.userId, session.clusterId)
      if (!assigned) return false
    }
    return true
  } catch { return false }
}
```

`server/index.mjs` sessionFromRequest(:457-466)TTL 块之后、`return session` 之前:

```js
  if (session && !sessionOwnerValid(db, session)) {
    sessions.delete(token)
    removePersistedSession(token)
    return null
  }
```

(import 增 `sessionOwnerValid` from './session-guard.mjs'。失效会话同 TTL 路径三处同清:内存 + 库。)

- [ ] **Step 4: 跑确认通过** `node --test server/session-guard.test.mjs` + `npm test`
- [ ] **Step 5: Commit**

```bash
git add server/session-guard.mjs server/session-guard.test.mjs server/index.mjs
git commit -m "feat(server): per-request k8s session ownership re-check (disabled/unassigned users lose sessions immediately)"
```

---

### Task 3: 取消分配 / 删集群 → 吊销存量 K8s session

**Files:**
- Modify: `server/session-revoke.mjs`(增两个函数)
- Modify: `server/routes/admin.mjs:679-690`(PUT clusters 计算移除集并吊销)、`server/routes/admin.mjs:293-296`(DELETE cluster 吊销该集群全部会话)
- Test: `server/session-revoke.test.mjs`(若无则新建)、`server/admin-clusters-revoke.test.mjs`(新建)

**Interfaces:**
- Consumes: Task 1 的 sessions.userId/clusterId 列;既有 `revokeUserSessions` 同款签名风格。
- Produces:
  - `revokeUserClusterSessions({ db, sessions, platformSessions }, userId, clusterIds) -> number`——吊销该用户在指定集群上的全部 K8s session。双路径:①直查 `sessions` 表 `WHERE userId=? AND clusterId IN (…)`;
  ②platform_sessions 链兜底(存量无归属行:该用户每个 platform session 的 k8sSessionToken,其 sessions 行 clusterId 命中或**行缺失但内存对象命中**)。内存 Map 同步删;被吊 token 若是某 platform_session 的 k8sSessionToken,置 `k8sSessionToken=NULL`(platform session 本身存活)。
  - `revokeClusterSessions({ db, sessions, platformSessions }, clusterId) -> number`——删集群时吊销**所有用户**在该集群的 session(同款双路径,不限 user)。

- [ ] **Step 1: 写失败测试**(server/session-revoke.test.mjs;无则新建,模式同 session-guard.test.mjs)

```js
import { revokeUserClusterSessions, revokeClusterSessions } from './session-revoke.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_sessions (token TEXT PRIMARY KEY, userId TEXT, k8sSessionToken TEXT)`)
  db.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, userId TEXT, clusterId TEXT)`)
  return db
}

test('revokeUserClusterSessions:只吊该用户该集群;platform 链兜底;k8sSessionToken 置空;platform session 存活', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO sessions VALUES ('k-a1','u1','c1')`).run()   // 目标
  db.prepare(`INSERT INTO sessions VALUES ('k-a2','u1','c2')`).run()   // 他集群,保留
  db.prepare(`INSERT INTO sessions VALUES ('k-b1','u2','c1')`).run()   // 他人,保留
  db.prepare(`INSERT INTO platform_sessions VALUES ('p1','u1','k-legacy')`).run() // 链式兜底目标(sessions 表无行)
  const sessions = new Map([['k-a1', { userId: 'u1', clusterId: 'c1' }], ['k-b1', { userId: 'u2', clusterId: 'c1' }],
    ['k-legacy', { clusterId: 'c1' }]])   // legacy:表无行、内存有
  const platformSessions = new Map([['p1', { userId: 'u1', k8sSessionToken: 'k-legacy' }]])
  const n = revokeUserClusterSessions({ db, sessions, platformSessions }, 'u1', ['c1'])
  assert.equal(n, 2)                                          // k-a1(直查)+ k-legacy(链兜底)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 2)   // k-a2/k-b1 留
  assert.equal(sessions.has('k-a1'), false); assert.equal(sessions.has('k-legacy'), false); assert.equal(sessions.has('k-b1'), true)
  assert.equal(db.prepare('SELECT k8sSessionToken FROM platform_sessions WHERE token=?').get('p1').k8sSessionToken, null)
})

test('revokeClusterSessions:删集群时全用户该集群全吊', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO sessions VALUES ('k1','u1','c9')`).run()
  db.prepare(`INSERT INTO sessions VALUES ('k2','u2','c9')`).run()
  db.prepare(`INSERT INTO sessions VALUES ('k3','u2','c1')`).run()
  const sessions = new Map([['k1', { clusterId: 'c9' }], ['k2', { clusterId: 'c9' }], ['k3', { clusterId: 'c1' }]])
  assert.equal(revokeClusterSessions({ db, sessions }, 'c9'), 2)
  assert.equal(sessions.has('k3'), true)
})
```

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**(session-revoke.mjs 追加;风格对齐既有 revokeUserSessions)

```js
// W2-0:取消集群分配 / 删除集群 → 吊销存量 K8s session。双路径:
// ①新归属列直查;②存量无归属行走 platform_sessions.k8sSessionToken 链 + 内存 clusterId 兜底。
export function revokeUserClusterSessions({ db, sessions, platformSessions }, userId, clusterIds) {
  const targets = (clusterIds || []).filter(Boolean)
  if (!db || !targets.length) return 0
  const removed = new Set()
  let rows = []
  try { rows = db.prepare(`SELECT token FROM sessions WHERE userId=? AND clusterId IN (${targets.map(() => '?').join(',')})`).all(userId, ...targets) } catch { rows = [] }
  for (const r of rows) removed.add(r.token)
  // platform 链兜底:该用户全部 platform session 的 k8s token,内存对象 clusterId 命中即吊(存量行表里可能无)
  let ps = []
  try { ps = db.prepare('SELECT token, k8sSessionToken FROM platform_sessions WHERE userId=?').all(userId) } catch { ps = [] }
  for (const r of ps) {
    if (!r.k8sSessionToken || removed.has(r.k8sSessionToken)) continue
    const mem = sessions?.get(r.k8sSessionToken)
    if (mem && targets.includes(mem.clusterId)) removed.add(r.k8sSessionToken)
  }
  for (const tok of removed) {
    try { db.prepare('DELETE FROM sessions WHERE token=?').run(tok) } catch { /* noop */ }
    sessions?.delete(tok)
    try { db.prepare('UPDATE platform_sessions SET k8sSessionToken=NULL WHERE k8sSessionToken=?').run(tok) } catch { /* noop */ }
    if (platformSessions) for (const [t, s] of Array.from(platformSessions)) if (s?.k8sSessionToken === tok) s.k8sSessionToken = null
  }
  return removed.size
}

export function revokeClusterSessions({ db, sessions, platformSessions }, clusterId) {
  if (!db || !clusterId) return 0
  const removed = new Set()
  let rows = []
  try { rows = db.prepare('SELECT token FROM sessions WHERE clusterId=?').all(clusterId) } catch { rows = [] }
  for (const r of rows) removed.add(r.token)
  if (sessions) for (const [tok, s] of Array.from(sessions)) if (s?.clusterId === clusterId) removed.add(tok)
  for (const tok of removed) {
    try { db.prepare('DELETE FROM sessions WHERE token=?').run(tok) } catch { /* noop */ }
    sessions?.delete(tok)
    try { db.prepare('UPDATE platform_sessions SET k8sSessionToken=NULL WHERE k8sSessionToken=?').run(tok) } catch { /* noop */ }
    if (platformSessions) for (const [t, s] of Array.from(platformSessions)) if (s?.k8sSessionToken === tok) s.k8sSessionToken = null
  }
  return removed.size
}
```

`server/routes/admin.mjs` PUT clusters(:682-687 之间):

```js
      const old = db.prepare('SELECT clusterId FROM user_clusters WHERE userId=?').all(userId).map(r => r.clusterId)
      db.prepare('DELETE FROM user_clusters WHERE userId=?').run(userId)
      if (Array.isArray(clusterIds)) {
        const stmt = db.prepare('INSERT INTO user_clusters (userId,clusterId,assignedBy,assignedAt) VALUES (?,?,?,?)')
        for (const cid of clusterIds) stmt.run(userId, cid, ps.username, Date.now())
      }
      // W2-0:被移除的集群 → 立即吊销该用户的存量 K8s session(§0.4-2)
      const removed = old.filter(cid => !(Array.isArray(clusterIds) && clusterIds.includes(cid)))
      const revokedSessions = revokeUserClusterSessions({ db, sessions, platformSessions }, userId, removed)
```

writeAudit 的 requestSummary 追加 ` revokedSessions=${revokedSessions}`。import 增 `revokeUserClusterSessions, revokeClusterSessions`(来自 '../session-revoke.mjs',与既有 revokeUserSessions 同处)。

DELETE cluster(admin.mjs:295 `DELETE FROM user_clusters WHERE clusterId=?` 旁):

```js
      const revokedSessions = revokeClusterSessions({ db, sessions, platformSessions }, id)
```

(同端点 writeAudit requestSummary 追加同一字段;确认该 admin 路由 deps 已含 `sessions, platformSessions`——Task 14 前的 adminRoutes 构造已传,缺失则补。)

- [ ] **Step 4: 路由级集成测试**(server/admin-clusters-revoke.test.mjs 新建;沿用 admin 测试工厂模式——requireAdmin stub + 真实内存 db + admin.mjs 完整 deps 子集):PUT /api/admin/users/u1/clusters 从 `['c1']` 改 `[]` → sessions 表中 u1@c1 行消失、platform_sessions.k8sSessionToken 置 NULL、响应 200。跑绿。
- [ ] **Step 5: Commit**

```bash
git add server/session-revoke.mjs server/session-revoke.test.mjs server/admin-clusters-revoke.test.mjs server/routes/admin.mjs
git commit -m "feat(server): revoke k8s sessions on cluster unassign/cluster-delete (dual-path: ownership column + platform-session chain)"
```

---

### Task 4: Workspace 集群门(创建/绑定/reconcile/commit)

**Files:**
- Modify: `server/routes/workbench-projects.mjs`(POST 创建 :124 旁、PUT :id/cluster :213、commit :242 旁、reconcile :253 旁)
- Modify: `server/messages/wbp.mjs`(1 个新键)
- Test: 该文件对应的既有路由测试文件(执行者 `ls server/ | grep workbench-projects` 定位;若不存在则新建 `server/workbench-projects-gates.test.mjs`,工厂模式同 admin-clusters-revoke.test.mjs)

**Interfaces:**
- Consumes: 无新依赖(纯 user_clusters 查询)。
- Produces: 局部 helper `assertClusterEntitlement(db, ps, clusterId) -> true | 'forbidden'`(admin 恒 true;clusterId 空视为 true=未绑定;否则查 user_clusters)——四个门共用同一 helper,禁各写一份。新消息键 `wbp.clusterForbidden`(zh「该集群未分配给你」/ en "This cluster is not assigned to you")。

- [ ] **Step 1: 写失败测试**(核心四例)

```js
test('Workspace 集群门:非分配用户创建/绑定/绑定态 reconcile 全 403;admin 豁免', async () => {
  // 夹具:clusters c1/c2;u1 仅分配 c1;项目 p1(owner u1,绑定 c1)
  // ① POST /api/workbench/projects {name:'x', clusterId:'c2'} → 403 wbp.clusterForbidden,且库中无该项目
  // ② PUT /api/workbench/projects/p1/cluster {clusterId:'c2'} → 403,p1.clusterId 仍 'c1'
  // ③ POST /api/workbench/projects/p1/reconcile → 403(把 user_clusters 中 u1-c1 删除后)
  // ④ admin(role:'admin')同三操作 → 200
  // ⑤ PUT cluster {clusterId:''}(解绑)→ 200 无论如何
})
```

(执行者按该文件既有路由测试工厂展开为四条独立 test;断言 status 403 + payload.message 为 zh 文案 + 库状态未变。)

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**(workbench-projects.mjs)

helper(放在 handler 内 `clusterNameOf` 旁):

```js
      // W2-0 §2.6:项目域集群门——发起者(项目 owner)须仍被分配该集群;admin 豁免;空 clusterId(未绑定)放行
      const clusterEntitled = (ps0, cid) => {
        if (!cid || ps0.role === 'admin') return true
        return !!db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(ps0.userId, cid)
      }
```

四处接线:
1. POST 创建(`:124` 的 clusters 存在性检查后):`if (!clusterEntitled(ps, input.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }`
2. PUT :id/cluster(`:215` 存在性检查后):`if (cid && !clusterEntitled(ps, cid)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }`
3. commit 与 reconcile(两块各自在 ownership 检查之后):`if (!clusterEntitled(ps, p.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }`

`server/messages/wbp.mjs` TABLE 增:

```js
  'wbp.clusterForbidden': { zh: '该集群未分配给你', en: 'This cluster is not assigned to you' },
```

- [ ] **Step 4: 跑确认通过** + `npm test`
- [ ] **Step 5: Commit**

```bash
git add server/routes/workbench-projects.mjs server/messages/wbp.mjs <对应测试文件>
git commit -m "feat(server): workspace cluster entitlement gates on project create/bind/commit/reconcile"
```

---

### Task 5: 浏览器 token 生命周期(登出全清 + 账号切换不复用)

**Files:**
- Modify: `src/api/client.js`(session 区,:30-48 旁)
- Modify: `src/stores/auth.js`(login 与 logout)
- Test: `src/stores/__tests__/auth.test.js`(若无则新建)

**Interfaces:**
- Produces: `purgeSession()`(client.js 导出)——移除 `sessionKey` 与 `prevSessionKey` 两个存储位,**不暂存**(与 clearSession 的「暂存供 rekey」语义相反);`auth.login()` 成功后调它(账号切换:上一账号的 K8s token 与暂存一律不留);`auth.logout()` 追加 `clearStashedSession()`(登出暂存旧 token 会让下个账号同集群重连时把 A 的窗口记录 rekey 给 B——跨账号泄漏,一并堵)。

- [ ] **Step 1: 写失败测试**(src/stores/__tests__/auth.test.js 新建;mock `@/api/client` 的 login/logout/saveSession/clearSession/getSessionToken/getStashedSession/clearStashedSession/rekeyApi 全套——照 UserProfile.test.js 的 vi.hoisted 工厂;localStorage 用 happy-dom 真实实现)

```js
test('login 成功即清上一账号残留:sessionKey 与 prevSessionKey 双清(purge,不暂存)', async () => {
  localStorage.setItem('aliangboard.session', 'A-k8s-token')
  localStorage.setItem('aliangboard.prevSession', 'A-old-token')
  apiMocks.login.mockResolvedValue({ token: 'p-tok', user: { id: 'u2', username: 'bob', role: 'user' }, prefs: {} })
  const auth = useAuthStore()
  await auth.login('bob', 'pw')
  expect(localStorage.getItem('aliangboard.session')).toBe(null)
  expect(localStorage.getItem('aliangboard.prevSession')).toBe(null)
  expect(localStorage.getItem('aliangboard.platform')).toBe('p-tok')
})

test('logout 清暂存:prevSessionKey 不残留(防下账号同集群 rekey 继承窗口记录)', async () => {
  localStorage.setItem('aliangboard.platform', 'p-tok')
  localStorage.setItem('aliangboard.prevSession', 'A-old-token')
  const auth = useAuthStore()
  auth.token = 'p-tok'; auth.user = { id: 'u1', username: 'alice', role: 'user' }; auth.k8sToken = 'k1'
  auth.logout()
  expect(localStorage.getItem('aliangboard.prevSession')).toBe(null)
  expect(localStorage.getItem('aliangboard.session')).toBe(null)
})
```

(若 auth store 现有测试文件在别处,放同处;i18n 无涉及。)

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**

client.js(clearStashedSession 之后):

```js
// 账号切换专用(W2-0 §0.4-4):双键全清且不暂存——与 clearSession(暂存供同集群 rekey)语义相反。
// 登录成功时调用:上一账号的 K8s token/暂存一律不留,防跨账号复用与窗口记录继承。
export function purgeSession() {
  try { sessionStorage.removeItem(sessionKey); localStorage.removeItem(sessionKey); localStorage.removeItem(prevSessionKey) } catch { /* 存储不可用静默 */ }
}
```

auth.js login()(token 赋值与 localStorage.setItem('aliangboard.platform', …) 之后、hydrate 之前):

```js
    purgeSession()   // W2-0:登录即清上一账号 K8s token 与暂存(账号切换不复用)
```

auth.js logout()(clearSession() 之后):

```js
    clearStashedSession()   // W2-0:登出不留暂存(防下账号同集群 rekey 继承窗口记录)
```

(import 行补 purgeSession/clearStashedSession——client.js 导出确认。)

- [ ] **Step 4: 跑确认通过** `npx vitest run src/stores/__tests__/auth.test.js --maxWorkers=2` + 全量 unit
- [ ] **Step 5: Commit**

```bash
git add src/api/client.js src/stores/auth.js src/stores/__tests__/auth.test.js
git commit -m "feat(web): purge browser k8s tokens on login and clear rekey stash on logout (no cross-account reuse)"
```

---

### Task 6: WorkbenchChat CAS flaky 确定性

**Files:**
- Modify: `src/components/workbench/__tests__/WorkbenchChat.approval.test.js`(仅测试文件)

**Interfaces:**
- Produces: 该文件在 `--maxWorkers=2` 连续 5 次全绿 + 全量套件 3 次全绿。**这是全波门禁可信度的前置**(spec §10 W2-0 子项⑦)。

- [ ] **Step 1: 复现**:先复跑定位 5 次全量/单文件交替,记录失败用例名与报错形态(预期为审批 CAS 用例:paused 状态竞态或前态残留)。
- [ ] **Step 2: 按仓库已知两类根因逐一排查并修**(memory 在案):
  1. **状态污染**:该文件若有追加的顶层 test 未继承 beforeEach → 把公共夹具重建(beforeEach 里 `vi.clearAllMocks()` 后**必须重新 seed 所有 mockResolvedValue**——clearAllMocks 不清实现)逐 test 补齐;
  2. **CAS 时序**:审批断言若依赖异步状态落库,用 `await vi.waitFor(() => expect(...), { timeout: 2000 })`(或既有 flushPromises 循环)替换裸 expect;禁止 sleep。
  3. 仍复现 → 该用例加 `{ retry: 2 }` 并注释 `// W2-0:已知审批 CAS 并发窗口,确定性修复随 Wave 2 D 期审批归属重构`。
- [ ] **Step 3: 验证**:`npx vitest run src/components/workbench/__tests__/WorkbenchChat.approval.test.js --maxWorkers=2` 连续 5 次;全量 `npm run test:unit -- --maxWorkers=2` 连续 2 次。全绿才过。
- [ ] **Step 4: Commit**

```bash
git add src/components/workbench/__tests__/WorkbenchChat.approval.test.js
git commit -m "test(workbench): stabilize approval CAS flake — full state reseed per test + explicit CAS await (retry as last resort)"
```

---

### Task 7: 双用户负向矩阵(W2-0 子集)

**Files:**
- Create: `server/w20-negative.test.mjs`

**Interfaces:**
- Consumes: Task 1-4 全部产物 + session-guard + 两个 revoke 函数。
- Produces: spec §9 负向矩阵的 W2-0 子集(§9 双用户夹具 1/3/4/5 条),作为 Phase A/B/C 后续子集的模板文件。

- [ ] **Step 1: 写测试**(node:test,真实内存 db + 三个路由工厂真实拼接;夹具:clusters c1/c2;platform_users u1(user)/u2(user,未分配)/a1(admin);u1→c1 分配;sessions 表含 u1@c1 行 + platform_sessions 链)

```js
// W2-0 双用户负向矩阵(spec §9 夹具的 Phase-0 子集):
// u1(分配 c1)/ u2(未分配)/ a1(admin);u1 的 K8s token 在失去分配后必须立即死。
// 覆盖:①复检矩阵(session-guard 全档)②取消分配吊销(admin PUT 集群路由级)
// ③Workspace 三门(创建带未分配集群 / 绑定未分配 / 失配后 reconcile)④admin 豁免 ⑤登出清暂存语义的
// 服务端对应物(吊销后旧 token 401)。
```

(执行者按 Task 2/3/4 的测试实体化为本文件的四条 test;断言一律「401/403 + 库状态不变/已变」双向钉。此文件是 Phase A/B/C 负向子集的追加落点,头部注释保留夹具说明。)

- [ ] **Step 2: 跑确认通过**(T1-4 已绿则此为集成拼装;任何红=前四任务的接缝 bug,回报而非本任务内修)
- [ ] **Step 3: Commit**

```bash
git add server/w20-negative.test.mjs
git commit -m "test(server): W2-0 dual-user negative matrix — ownership re-check, unassign revocation, workspace cluster gates, admin bypass"
```

---

### Task 8: 全量门禁收口 + 合并

**Files:** 无新改动(收口验证 + 合并)

- [ ] **Step 1: 门禁全量**(全部裸跑,禁 tail 管道,记录各自 exit code):

```bash
npm test
npm run test:unit -- --maxWorkers=2
npm run typecheck
npm run build
npm run i18n:check
```

- [ ] **Step 2: 稳定性复核**:`npm run test:unit -- --maxWorkers=2` 再连续 2 次(Task 6 验收);`npm test` 若唯一失败是既有 flaky,隔离复跑该文件并记录——**本计划验收标准是无可复现失败**。
- [ ] **Step 3: 退出判据自检**(spec §10 Phase 0 逐条):取消分配后旧 token 立即失效(Task 3/7 测试证据);Workspace 三门(Task 4);账号切换不复用(Task 5);负向矩阵 W2-0 子集全绿(Task 7);门禁稳定全绿(Task 6+8)。
- [ ] **Step 4: 合并**:worktree 分支 `--no-ff` 合回 main(合并前 `git log main..HEAD` 核对区间;实现者**不得自行合并**——由控制器或经用户确认执行)。

---

## 手测清单(合并后;网关重启)

1. admin 把 u1 的集群分配从 c1 改为空 → u1 已打开的集群页下一次请求即 401 被踢到选集群页(u1 无需重登平台)。
2. u1 在 c1 上有项目并 reconcile 过 → admin 取消分配后,u1 对该项目点 reconcile → 403 toast「该集群未分配给你」。
3. u1 登出 → u2 同浏览器登录 → u2 看不到 u1 的终端/文件浏览窗口记录(无 rekey 继承)。
4. 升级兼容:用旧库(有存量 sessions 行)启动 → 存量会话仍可用至 TTL,日志无 ALTER 报错。
