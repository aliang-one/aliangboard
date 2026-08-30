# 平台会话保留策略 + 用户中心会话列表分页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 平台会话过期自动回收 + 每用户数量上限(登录时踢最旧),用户中心会话列表前端分页。

**Architecture:** 新建纯函数模块 `server/platform-session-reaper.mjs`(依赖显式注入,便于单测);`index.mjs` 启动清一次 + 60s 定时 sweep;登录路由经 deps 注入调用 `enforceSessionCap`;前端 `UserProfile.vue` 复用现有 `Pagination.vue` 客户端切页。

**Tech Stack:** Node 25(node:sqlite `DatabaseSync`)+ node:test;前端 Vue 3 + vitest + @vue/test-utils。

**Spec:** `docs/superpowers/specs/2026-08-30-platform-session-retention-design.md`

## Global Constraints

- Node **25**(node:sqlite 硬依赖,勿降 22);`DatabaseSync` 拒绝 undefined/对象/数组绑定,写边界强制 `?? null`。
- 提交作者恒 `aliangone <aliangone@gmail.com>`,禁 Claude 尾注,禁改写已推送历史。提交命令统一用:`git -c commit.gpgsign=false commit --author="aliangone <aliangone@gmail.com>" -m "..."`。
- `docs/superpowers/` 被 gitignore 但有意入库:`git add -f`。
- TTL 判据不变:`now - createdAt > ttl`(绝对寿命,不改滑动窗口)。
- 被回收会话必须三处同清:内存 `platformSessions` + 表 `platform_sessions` + K8s 凭据(`sessions` Map + 表 `sessions`)。
- 上限 env `MAX_PLATFORM_SESSIONS_PER_USER` 默认 10;`<1` 视作关闭。
- 服务端测试跑法:`node --test server/<file>.test.mjs`(会被 `npm run test:server` 的 glob 自动收编);前端:`npx vitest run src/views/__tests__/UserProfile.test.js`。
- 本特性零新增 i18n 键(Pagination 组件键已有);仍跑 `npm run i18n:check` 守门。
- 当前分支 `feat/session-retention-pagination`(worktree 隔离),开工前 `git branch --show-current` 确认。

---

### Task 1: 服务端 reaper 模块 — `reapExpiredSessions`

**Files:**
- Create: `server/platform-session-reaper.mjs`
- Test: `server/platform-session-reaper.test.mjs`

**Interfaces:**
- Consumes: 无(纯函数,依赖注入)。
- Produces: `reapExpiredSessions({ platformSessions, db, sessions, now = Date.now(), ttlMs })` → `{ expired: number }`。Task 2/3 复用本模块内部 `removeSessionRecord` 语义(单会话三处回收)。

- [ ] **Step 1: 写失败测试**

新建 `server/platform-session-reaper.test.mjs`:

```js
// 平台会话保留策略单测(2026-08-30 设计 §5):内存 Map + SQLite 内存库,注入式纯函数直测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { reapExpiredSessions } from './platform-session-reaper.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  // platform_sessions 与 index.mjs 同构;sessions 只需要 token 列(测 DELETE 命中)
  db.exec(`CREATE TABLE platform_sessions (
    token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
    createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT)`)
  db.exec('CREATE TABLE sessions (token TEXT PRIMARY KEY)')
  return db
}

function setup({ rows = [] } = {}) {
  const db = makeDb()
  const platformSessions = new Map()
  const sessions = new Map()
  for (const r of rows) {
    const rec = { token: r.token, userId: r.userId || 'u1', username: 'alice', role: 'user',
      createdAt: r.createdAt, lastSeenAt: r.lastSeenAt ?? null, k8sSessionToken: r.k8s ?? null }
    platformSessions.set(r.token, rec)
    db.prepare('INSERT INTO platform_sessions (token,userId,username,role,createdAt,k8sSessionToken,lastSeenAt) VALUES (?,?,?,?,?,?,?)')
      .run(rec.token, rec.userId, rec.username, rec.role, rec.createdAt, rec.k8sSessionToken, rec.lastSeenAt)
    if (r.k8s) sessions.set(r.k8s, { apiServer: 'https://k8s.example' })
  }
  return { db, platformSessions, sessions }
}

test('reap:过期会话三处回收(内存 Map + platform_sessions 表 + K8s 凭据)', () => {
  const now = 1_000_000
  const ttl = 8 * 60 * 60 * 1000
  const { db, platformSessions, sessions } = setup({ rows: [
    { token: 't-old', createdAt: now - ttl - 1, k8s: 'k-old' },
    { token: 't-fresh', createdAt: now - 1000 },
  ] })
  const { expired } = reapExpiredSessions({ platformSessions, db, sessions, now, ttlMs: ttl })
  assert.equal(expired, 1)
  assert.equal(platformSessions.has('t-old'), false)
  assert.equal(platformSessions.has('t-fresh'), true)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_sessions').get().c, 1)
  assert.equal(sessions.has('k-old'), false, 'K8s 凭据应一并回收')
})

test('reap:恰好等于 TTL 不过期(判据为严格大于,与懒删除一致)', () => {
  const now = 1_000_000
  const ttl = 8 * 60 * 60 * 1000
  const { db, platformSessions } = setup({ rows: [{ token: 't-edge', createdAt: now - ttl }] })
  const { expired } = reapExpiredSessions({ platformSessions, db, sessions: new Map(), now, ttlMs: ttl })
  assert.equal(expired, 0)
  assert.equal(platformSessions.has('t-edge'), true)
})

test('reap:db 不可用时跳过该条不中断整批(内存仍清)', () => {
  const now = 1_000_000
  const { db, platformSessions, sessions } = setup({ rows: [
    { token: 't-a', createdAt: now - 1 }, { token: 't-b', createdAt: now - 2 },
  ] })
  // 闭包一个会抛错的 db 代理:DELETE 语句失败,内存删除照常
  const badDb = { prepare: (sql) => { if (sql.includes('DELETE FROM platform_sessions')) throw new Error('db down'); return db.prepare(sql) } }
  const { expired } = reapExpiredSessions({ platformSessions, db: badDb, sessions, now, ttlMs: 1000 })
  assert.equal(expired, 2)
  assert.equal(platformSessions.size, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/platform-session-reaper.test.mjs`
Expected: FAIL(模块不存在,`Cannot find module './platform-session-reaper.mjs'`)

- [ ] **Step 3: 最小实现**

新建 `server/platform-session-reaper.mjs`:

```js
// 平台会话保留策略(2026-08-30 设计 §3):过期回收 + 每用户数量上限。
// 纯函数模块,platformSessions/sessions/db 显式注入,便于单测(auth-selfservice 同款模式)。
// 过期判据与 index.mjs platformUserFromRequest 的懒删除完全一致:now - createdAt > ttl(绝对寿命)。

// 单会话三处回收:内存 platformSessions + platform_sessions 表 + 该会话接入的 K8s 凭据。
// 与改密/吊销路径同款;懒删除此前缺第 3 步,这里统一补齐。单条 DB 失败不抛(内存已清,下轮 sweep 兜底)。
function removeSessionRecord(platformSessions, db, sessions, token) {
  const rec = platformSessions.get(token)
  platformSessions.delete(token)
  try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(token) } catch { /* 表缺失/库不可用 */ }
  const k8sTok = rec?.k8sSessionToken
  if (k8sTok) {
    sessions.delete(k8sTok)
    try { db.prepare('DELETE FROM sessions WHERE token=?').run(k8sTok) } catch { /* 同上 */ }
  }
}

// 回收全部过期会话(启动一次 + 60s sweep 兜底),返回清理条数。
export function reapExpiredSessions({ platformSessions, db, sessions, now = Date.now(), ttlMs }) {
  let expired = 0
  for (const [token, rec] of Array.from(platformSessions)) {
    try {
      if (now - rec.createdAt > ttlMs) { removeSessionRecord(platformSessions, db, sessions, token); expired++ }
    } catch { /* 单条失败不中断整批 */ }
  }
  return { expired }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/platform-session-reaper.test.mjs`
Expected: PASS(3 tests)

- [ ] **Step 5: 提交**

```bash
git add server/platform-session-reaper.mjs server/platform-session-reaper.test.mjs
git -c commit.gpgsign=false commit --author="aliangone <aliangone@gmail.com>" -m "feat(auth): 平台会话过期回收 reaper(三处同清:内存+表+K8s 凭据)"
```

---

### Task 2: 同模块追加 `enforceSessionCap`

**Files:**
- Modify: `server/platform-session-reaper.mjs`
- Test: `server/platform-session-reaper.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `removeSessionRecord`(模块内私有)。
- Produces: `enforceSessionCap({ platformSessions, db, sessions, userId, owner, max, keepToken, now = Date.now(), writeAudit })` → `{ evicted: number }`。Task 3 的登录路由经 deps 注入调用,`keepToken` = 新登录 token,`owner` = `user.username`(审计 owner 与既有条目一致用用户名)。

- [ ] **Step 1: 追加失败测试**

在 `server/platform-session-reaper.test.mjs` 顶部 import 行改为:

```js
import { reapExpiredSessions, enforceSessionCap } from './platform-session-reaper.mjs'
```

并在 `makeDb` 中建审计表(import 与 schema 沿用 audit.mjs):

```js
import { createAuditSchema, writeAudit } from './audit.mjs'
```

`makeDb()` 末尾(`return db` 之前)加一行:

```js
  createAuditSchema(db)
```

文件末尾追加测试:

```js
test('cap:超限踢最久未活跃,keepToken 永不踢', () => {
  const { db, platformSessions, sessions } = setup({ rows: [
    { token: 't-a', createdAt: 1, lastSeenAt: 100 },
    { token: 't-b', createdAt: 2, lastSeenAt: 300 },
    { token: 't-keep', createdAt: 3, lastSeenAt: 500 },
  ] })
  const { evicted } = enforceSessionCap({ platformSessions, db, sessions, userId: 'u1', owner: 'alice', max: 2, keepToken: 't-keep', now: 600, writeAudit })
  assert.equal(evicted, 1)
  assert.equal(platformSessions.has('t-a'), false, '最久未活跃的应被踢')
  assert.equal(platformSessions.has('t-b'), true)
  assert.equal(platformSessions.has('t-keep'), true, '本会话永不踢')
})

test('cap:lastSeenAt 缺省回退 createdAt 排序', () => {
  const { db, platformSessions } = setup({ rows: [
    { token: 't-a', createdAt: 50 },              // 无 lastSeenAt → 回退 50,最旧
    { token: 't-b', createdAt: 100 },
    { token: 't-keep', createdAt: 200 },
  ] })
  const { evicted } = enforceSessionCap({ platformSessions, db, sessions: new Map(), userId: 'u1', owner: 'alice', max: 2, keepToken: 't-keep', now: 300 })
  assert.equal(evicted, 1)
  assert.equal(platformSessions.has('t-a'), false)
})

test('cap:被踢会话 K8s 凭据回收 + 审计写入 platform_session_evict', () => {
  const { db, platformSessions, sessions } = setup({ rows: [
    { token: 't-a', createdAt: 1, lastSeenAt: 10, k8s: 'k-a' },
    { token: 't-keep', createdAt: 2, lastSeenAt: 500 },
  ] })
  enforceSessionCap({ platformSessions, db, sessions, userId: 'u1', owner: 'alice', max: 1, keepToken: 't-keep', now: 600, writeAudit })
  assert.equal(sessions.has('k-a'), false)
  const row = db.prepare("SELECT owner,tool,requestSummary FROM audit_log WHERE tool='platform_session_evict'").get()
  assert.ok(row, '应写审计')
  assert.equal(row.owner, 'alice')
  assert.match(row.requestSummary, /evicted=1/)
})

test('cap:未超限不踢不审计;max<1 视作关闭', () => {
  const { db, platformSessions } = setup({ rows: [
    { token: 't-a', createdAt: 1 }, { token: 't-b', createdAt: 2 },
  ] })
  const r1 = enforceSessionCap({ platformSessions, db, sessions: new Map(), userId: 'u1', owner: 'alice', max: 5, keepToken: 't-b', now: 10, writeAudit })
  assert.equal(r1.evicted, 0)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tool='platform_session_evict'").get().c, 0)
  const r2 = enforceSessionCap({ platformSessions, db, sessions: new Map(), userId: 'u1', owner: 'alice', max: 0, keepToken: 't-b', now: 10, writeAudit })
  assert.equal(r2.evicted, 0, 'max<1 = 关闭上限')
  assert.equal(platformSessions.size, 2)
})
```

- [ ] **Step 2: 跑测试确认新测试失败**

Run: `node --test server/platform-session-reaper.test.mjs`
Expected: FAIL(`enforceSessionCap` 未导出)

- [ ] **Step 3: 追加实现**

在 `server/platform-session-reaper.mjs` 末尾追加:

```js
// 每用户会话数量上限(2026-08-30 设计 §3.1):登录建新会话后调用,超 max 从最久未活跃开始踢。
// keepToken(刚登录的会话)永不踢;max<1 视作关闭。被踢会话经 removeSessionRecord 三处同清。
export function enforceSessionCap({ platformSessions, db, sessions, userId, owner, max, keepToken, now = Date.now(), writeAudit }) {
  if (!max || max < 1) return { evicted: 0 }
  const mine = []
  for (const [token, rec] of platformSessions) {
    if (rec.userId !== userId) continue
    mine.push({ token, lastActive: rec.lastSeenAt ?? rec.createdAt ?? 0 })
  }
  if (mine.length <= max) return { evicted: 0 }
  mine.sort((a, b) => a.lastActive - b.lastActive)  // 最久未活跃在前
  let evicted = 0
  for (const { token } of mine) {
    if (mine.length - evicted <= max) break
    if (token === keepToken) continue
    try {
      removeSessionRecord(platformSessions, db, sessions, token)
      evicted++
    } catch { /* 单条失败不中断 */ }
  }
  if (evicted > 0) {
    try {
      writeAudit?.(db, { owner: owner ?? String(userId ?? ''), verb: 'revoke', tool: 'platform_session_evict',
        result: 'ok', requestSummary: `evicted=${evicted} max=${max}`, source: 'platform' })
    } catch { /* 审计失败不阻断 */ }
  }
  return { evicted }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/platform-session-reaper.test.mjs`
Expected: PASS(7 tests)

- [ ] **Step 5: 提交**

```bash
git add server/platform-session-reaper.mjs server/platform-session-reaper.test.mjs
git -c commit.gpgsign=false commit --author="aliangone <aliangone@gmail.com>" -m "feat(auth): 每用户平台会话数量上限 enforceSessionCap(踢最久未活跃+审计)"
```

---

### Task 3: 接线 — 登录挂钩 + 启动/定时 sweep + env 配置

**Files:**
- Modify: `server/routes/auth.mjs:8-15`(deps 解构)、`:53-62`(登录体)
- Modify: `server/index.mjs:73`(env)、`:1445-1451`(deps 传参)、`:2240-2242`(启动接线)
- Test: `server/auth-selfservice.test.mjs`(makeRoutes deps + 追加登录 cap 测试)

**Interfaces:**
- Consumes: Task 2 的 `enforceSessionCap`(签名见 Task 2 Produces);`reapExpiredSessions`(签名见 Task 1 Produces)。
- Produces: 运行时行为——登录超限自动踢旧;启动 + 60s sweep 清过期。无新导出。

- [ ] **Step 1: 写失败的登录集成测试**

`server/auth-selfservice.test.mjs` 顶部追加 import:

```js
import { enforceSessionCap } from './platform-session-reaper.mjs'
```

`makeRoutes` 的 `deps` 对象中(`checkLoginRate: () => ({ allowed: true }),` 之后)追加两个键:

```js
    enforceSessionCap, maxPlatformSessionsPerUser: 10,
```

文件末尾追加测试:

```js
// === 会话保留(2026-08-30 设计 §3.2):登录超限踢旧 + cap 失败不阻断 ===

test('登录:会话数超上限,踢最久未活跃的旧会话,本会话保留', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent, deps } = makeRoutes(db, { maxPlatformSessionsPerUser: 1 })
  routes._body = { username: 'alice', password: 'right-password' }
  await routes.routes.handle({ method: 'POST', headers: { 'user-agent': 'vitest' }, url: '/api/auth/login' }, {}, new URL('/api/auth/login', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.equal(sent[0].payload.token, 'uuid-x')
  assert.equal(deps.platformSessions.has('t-me'), false, '旧会话(lastSeenAt 回退 createdAt=1)应被踢')
  assert.equal(deps.platformSessions.has('uuid-x'), true)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_sessions WHERE userId=?').get('u1').c, 1)
})

test('登录:cap 强制抛异常不阻断登录(降级不踢)', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db, { enforceSessionCap: () => { throw new Error('boom') } })
  routes._body = { username: 'alice', password: 'right-password' }
  await routes.routes.handle({ method: 'POST', headers: { 'user-agent': 'vitest' }, url: '/api/auth/login' }, {}, new URL('/api/auth/login', 'http://x'))
  assert.equal(sent[0].status, 200, '登录应成功')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/auth-selfservice.test.mjs`
Expected: 第 1 个新测试 FAIL(`t-me` 仍在——路由还没调 `enforceSessionCap`);第 2 个可能 PASS(deps 未解构该键时 `enforceSessionCap` 为 undefined,可选链吞掉异常路径未走到——以 Step 4 实现后双绿为准)

- [ ] **Step 3: 实现登录挂钩**

`server/routes/auth.mjs` — deps 解构(第 13 行 `checkLoginRate, writeAudit,`)改为:

```js
    checkLoginRate, writeAudit,
    enforceSessionCap, maxPlatformSessionsPerUser,
```

登录体内,`db.prepare('INSERT INTO platform_sessions ...').run(...)` 之后、`auditLogin('ok')` 之前插入:

```js
        // 会话数量上限(2026-08-30 设计 §3.2):超出踢最久未活跃的旧会话,刚建的本会话永不踢;
        // 被踢会话的 K8s 凭据由 enforceSessionCap 一并回收。强制失败不阻断登录(降级不踢)。
        try {
          enforceSessionCap?.({ platformSessions, db, sessions, userId: user.id, owner: user.username,
            max: maxPlatformSessionsPerUser, keepToken: token, now: psNow, writeAudit })
        } catch (e) { console.error('[auth] 会话上限强制失败(降级不踢):', e?.message || e) }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/auth-selfservice.test.mjs`
Expected: PASS(全部,含既有用例)

- [ ] **Step 5: index.mjs 接线(env + deps + 启动/定时 sweep)**

`server/index.mjs` 五处改动:

① 第 43 行 import 区追加(与 `touchSession` import 相邻):

```js
import { reapExpiredSessions } from './platform-session-reaper.mjs'
```

② 第 73 行 `const sessionTtl = ...` 之后追加:

```js
// 每用户平台会话保留上限(2026-08-30 设计 §3.3):登录时超出踢最久未活跃;<1 视作关闭。
const maxPlatformSessionsPerUser = Number(process.env.MAX_PLATFORM_SESSIONS_PER_USER || 10)
```

③ 第 1445-1451 行 `createAuthRoutes({...})` deps 中 `checkLoginRate, writeAudit,` 改为:

```js
    checkLoginRate, writeAudit, enforceSessionCap, maxPlatformSessionsPerUser,
```

并在同文件 import `createAuthRoutes` 处(第 42 行附近)确认 `enforceSessionCap` 可达——`createAuthRoutes` 定义在 `handle()` 内部闭包,deps 对象引用模块级导入的 `enforceSessionCap` 即可,无需额外改动(import 已在①加上)。

④ 第 2242 行 `loadPersistedPlatformSessions()` 之后追加:

```js
// 会话保留(2026-08-30 设计 §3.2):启动清一次过期僵尸,60s sweep 兜底(与 SSH terminal sweep 同模式,.unref 不阻退出)。
// ttl 每跳现读 env(热更新语义,回退启动值);整体异常跳过本轮,60s 后重试。
reapExpiredSessions({ platformSessions, db, sessions, ttlMs: sessionTtl })
setInterval(() => {
  try {
    reapExpiredSessions({ platformSessions, db, sessions, ttlMs: Number(process.env.SESSION_TTL_MS || sessionTtl) })
  } catch (e) { console.error('[auth] platform session reap failed:', e?.message || e) }
}, 60000).unref?.()
```

⑤(无需)`/api/connect-cluster` 复用既有平台会话,不新建,不挂钩。

- [ ] **Step 6: 全量服务端测试 + 语法检查**

Run: `node --check server/index.mjs && npm run test:server`
Expected: 无语法错误;全部 PASS(新 reaper 测试被 `server/*.test.mjs` glob 自动收编)

- [ ] **Step 7: 提交**

```bash
git add server/routes/auth.mjs server/index.mjs server/auth-selfservice.test.mjs
git -c commit.gpgsign=false commit --author="aliangone <aliangone@gmail.com>" -m "feat(auth): 会话保留接线——登录超限踢旧+启动/60s sweep 清过期+MAX_PLATFORM_SESSIONS_PER_USER"
```

---

### Task 4: 前端会话列表分页(UserProfile.vue)

**Files:**
- Modify: `src/views/UserProfile.vue`(script 会话区 + template 列表区)
- Test: `src/views/__tests__/UserProfile.test.js`

**Interfaces:**
- Consumes: `src/components/common/Pagination.vue`(props `total/pageSize/currentPage`,emit `page-change`(payload=页码));i18n 键 `component.pagination.*`(已存在,零新增)。
- Produces: 用户中心会话列表分页行为。`data-testid="sessions-pagination"` 挂在 Pagination 根元素(fallthrough)。

- [ ] **Step 1: 写失败测试**

`src/views/__tests__/UserProfile.test.js` 末尾追加:

```js
// === 会话列表分页(2026-08-30 设计 §4) ===
function makeSessions(n) {
  return Array.from({ length: n }, (_, i) => ({
    fingerprint: `fp${String(i).padStart(2, '0')}`, ip: `10.0.0.${i}`, userAgent: 'Mozilla/5.0 Chrome',
    createdAt: 1756400000000, lastSeenAt: 1756400000000 + i, current: false,
  }))
}

test('会话分页:>10 条出现分页条,首屏切前 10 条,翻页看剩余', async () => {
  apiMocks.listSessions.mockResolvedValue({ sessions: makeSessions(12) })
  const w = mountPage()
  await flushPromises()
  expect(w.findAll('[data-testid="session-row"]')).toHaveLength(10)
  const pag = w.find('[data-testid="sessions-pagination"]')
  expect(pag.exists()).toBe(true)
  await pag.findAll('button')[1].trigger('click')   // 下一页(Pagination 只有 prev/next 两按钮)
  expect(w.findAll('[data-testid="session-row"]')).toHaveLength(2)
  expect(w.findAll('[data-testid="session-row"]')[0].text()).toContain('10.0.0.10')
  w.unmount()
})

test('会话分页:≤10 条不显示分页条', async () => {
  const w = mountPage()
  await flushPromises()
  expect(w.findAll('[data-testid="session-row"]')).toHaveLength(2)
  expect(w.find('[data-testid="sessions-pagination"]').exists()).toBe(false)
  w.unmount()
})

test('会话分页:末页吊销后页码收敛(clamp),不悬空', async () => {
  apiMocks.listSessions.mockResolvedValue({ sessions: makeSessions(11) })
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="sessions-pagination"]').findAll('button')[1].trigger('click')
  expect(w.findAll('[data-testid="session-row"]')).toHaveLength(1)
  apiMocks.revokeSession.mockResolvedValueOnce({ ok: true })
  apiMocks.listSessions.mockResolvedValue({ sessions: makeSessions(10) })   // 重拉后只剩 10 条
  await w.find('[data-testid="session-revoke-fp10"]').trigger('click')
  document.body.querySelector('[data-testid="confirm-ok"]').click()
  await flushPromises()
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(2)
  expect(w.findAll('[data-testid="session-row"]')).toHaveLength(10)
  // 页码收敛回第 1 页:首行是 fp00
  expect(w.findAll('[data-testid="session-row"]')[0].text()).toContain('10.0.0.0')
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/UserProfile.test.js`
Expected: 新增 3 测试 FAIL(无 `sessions-pagination` 元素;第 3 个在翻页后找不到 1 条——仍是 10 条)

- [ ] **Step 3: 实现**

`src/views/UserProfile.vue` — script 区改动:

import 区追加:

```js
import Pagination from '@/components/common/Pagination.vue'
```

「安全卡:会话」区(`const sessions = ref([])` 附近)追加:

```js
// 会话列表分页(2026-08-30 设计 §4):客户端切片,>pageSize 才显示分页条;吊销重拉后页码收敛。
const currentPage = ref(1)
const pageSize = 10
const totalPages = computed(() => Math.max(1, Math.ceil(sessions.value.length / pageSize)))
const pagedSessions = computed(() => sessions.value.slice((currentPage.value - 1) * pageSize, currentPage.value * pageSize))
function clampPage() { currentPage.value = Math.min(currentPage.value, totalPages.value) }
```

`loadSessions` 的 `try { sessions.value = ... }` 行之后、`catch` 之前不动;在 `finally` 里追加(收编页码):

```js
  finally { sessionsLoading.value = false; clampPage() }
```

template 区两处改动:

`<div v-for="s in sessions"` 改为:

```html
        <div v-for="s in pagedSessions" :key="s.fingerprint" data-testid="session-row"
```

列表 `</div>`(v-else 容器闭合)之后、安全卡 `</div>` 之前追加分页条:

```html
      <Pagination v-if="sessions.length > pageSize" data-testid="sessions-pagination"
        class="mt-sm" :total="sessions.length" :page-size="pageSize" :current-page="currentPage"
        @page-change="(p) => (currentPage = p)" />
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/views/__tests__/UserProfile.test.js && npm run i18n:check`
Expected: 全部 PASS;i18n 门禁通过(零新增键)

- [ ] **Step 5: 提交**

```bash
git add src/views/UserProfile.vue src/views/__tests__/UserProfile.test.js
git -c commit.gpgsign=false commit --author="aliangone <aliangone@gmail.com>" -m "feat(user-center): 会话列表分页(>10 条出分页条,吊销后页码收敛)"
```

---

## 收尾(全任务完成后)

- [ ] `npm test` 全量跑通(服务端 + 前端)。
- [ ] 手测清单(需真机,来自 spec §7):造 >10 会话登录踢旧 / 插过期行重启被清 / 60s sweep 清过期 / 分页条显隐与翻页 / 末页吊销收敛 / 被踢设备 K8s 凭据 401。
- [ ] 用 superpowers:requesting-code-review 走终审,再按 finising-a-development-branch 决定合并。
