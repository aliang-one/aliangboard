# 用户中心 + 退出确认 + 暗色主题系统 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 根治「点头像即登出」,交付个人自助用户中心(资料/改密/会话管理/偏好),并建成亮暗双主题系统(方案 A:调色板 RGB 三元组 + tailwind `<alpha-value>`)。

**Architecture:** 两工作流顺序交付。工作流 1(Task 1-8):服务端 self-service 端点(deps 注入进 `createAuthRoutes`)+ 前端 preferences store(三级来源)+ ConfirmDialog + UserMenu 下拉 + `/profile` 三卡页。工作流 2(Task 9-13):`md-palette.js` 扩展暗色板与三元组注入,新增 `theme.js` 响应式主题模块,tailwind colors 改挂 CSS 变量,图表/组件单点响应化,硬编码色盘点。

**Tech Stack:** Vue 3.5 + Pinia + Tailwind 3.4(`darkMode:'class'`)+ vue-i18n 11;服务端 Node 原生 http + `node:sqlite`;测试 node:test(服务端)+ vitest/happy-dom(前端)。

**Spec:** `docs/superpowers/specs/2026-08-29-user-center-design.md`

## Global Constraints

- **依赖政策**:不新增任何外部依赖(CLAUDE.md;ConfirmDialog/主题系统全自研)。
- **提交规范**:作者恒 `aliangone <aliangone@gmail.com>`(repo config 已设,直接 `git commit`);**禁止** `Co-Authored-By: Claude` 尾注;禁止改写已推送历史。每 Task 至少一个提交,只提交本 Task 涉及文件(`git add` 明确路径,勿 `git add -A`)。
- **路由鉴权单一事实源**:新端点必须先在 `server/route-auth-map.mjs` 登记 ROUTE_AUTH,守卫测试静态扫源码强制。
- **node:sqlite 绑定**:DatabaseSync 拒绝 undefined/对象/数组——写库前 undefined→null,对象→`JSON.stringify`。
- **i18n 门禁**:新 UI 文案 en/zh 双语键对齐;消息值字面 `@` 必须写 `{'@'}`;提交前 `npm run i18n:check` 过三合一门禁。
- **测试命令**:服务端 `node --test server/<file>.test.mjs` 单文件跑;前端 `npx vitest run <path>` 单文件跑;全量 `npm test`。
- **测试 Mock 契约**:不许凭猜(既往教训)——mock 前先读真实实现(auth.mjs deps 清单见 Task 1 模板)。
- **Teleport 断言**:弹层测试查 `document.body`,不查 wrapper。
- **纯 JS**:无 TypeScript;新文件 `.js`/`.vue`/`.mjs`。
- **worktree 开发**:全部工作在 `feat/user-center` worktree;不碰主 checkout。

---

## 工作流 1:用户中心(Task 1-8)

### Task 1: 服务端会话元数据基建(ip/ua 落库 + lastSeenAt 节流回写)

**Files:**
- Modify: `server/index.mjs`(ALTER 迁移 ~line 103 附近;`platformUserFromRequest` 接 touchSession;createAuthRoutes deps 增 `hashPassword`/`extractPlatformToken`)
- Modify: `server/routes/auth.mjs`(login 写 ip/userAgent/lastSeenAt)
- Create: `server/session-touch.mjs`
- Test: `server/session-touch.test.mjs`
- Modify: `server/auth-login-rate.test.mjs`(makeDb 表结构补新列,否则 login INSERT 必失败)

**Interfaces:**
- Produces: `touchSession(db, ps, { now, minIntervalMs }) => boolean`(ps 就地更新 lastSeenAt;返回是否写了库)。后续 Task 的 sessions 列表读 `s.ip/s.userAgent/s.lastSeenAt` 字段。
- Produces: createAuthRoutes deps 新增 `hashPassword(password) => string`、`extractPlatformToken(req) => string`(index.mjs 注入真身;auth.mjs 现有 deps 解构加两项)。

- [ ] **Step 1: 写失败测试** `server/session-touch.test.mjs`

```js
// lastSeenAt 节流回写:内存即时更新,库写按最小间隔节流(SQLite 同步写,平台每请求都写会拖垮)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { touchSession } from './session-touch.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE platform_sessions (token TEXT PRIMARY KEY, userId TEXT, lastSeenAt INTEGER)')
  db.prepare("INSERT INTO platform_sessions (token,userId) VALUES ('t1','u1')").run()
  return db
}

test('首次 touch:内存更新 + 写库,返回 true', () => {
  const db = makeDb()
  const ps = { token: 't1', userId: 'u1' }
  assert.equal(touchSession(db, ps, { now: 1000 }), true)
  assert.equal(ps.lastSeenAt, 1000)
  assert.equal(db.prepare('SELECT lastSeenAt FROM platform_sessions WHERE token=?').get('t1').lastSeenAt, 1000)
})

test('间隔内重复 touch:内存不更新、不写库,返回 false', () => {
  const db = makeDb()
  const ps = { token: 't1', userId: 'u1', lastSeenAt: 1000 }
  assert.equal(touchSession(db, ps, { now: 1000 + 59_999 }), false)
  assert.equal(ps.lastSeenAt, 1000)
})

test('超过最小间隔:再次写库(内存即时、库 ≤1 次/分钟/会话)', () => {
  const db = makeDb()
  const ps = { token: 't1', userId: 'u1', lastSeenAt: 1000 }
  assert.equal(touchSession(db, ps, { now: 1000 + 60_000 }), true)
  assert.equal(ps.lastSeenAt, 61_000)
})

test('ps 无 token / 库异常:不抛出,返回 false(触点在每请求热路径)', () => {
  const db = makeDb()
  assert.equal(touchSession(db, {}, { now: 1 }), false)
  const bad = new DatabaseSync(':memory:') // 无表
  assert.equal(touchSession(bad, { token: 'x' }, { now: 1 }), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/session-touch.test.mjs`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `server/session-touch.mjs`

```js
// 平台会话 lastSeenAt 节流回写(2026-08-29 用户中心设计 §4.1)。
// 热路径约束:requirePlatform 每请求都会走这里——内存(ps.lastSeenAt)即时更新,
// SQLite 同步写按 minIntervalMs 节流(默认 60s,单会话 ≤1 写/分钟)。
export function touchSession(db, ps, { now = Date.now(), minIntervalMs = 60_000 } = {}) {
  if (!ps?.token) return false
  if (ps.lastSeenAt && now - ps.lastSeenAt < minIntervalMs) return false
  ps.lastSeenAt = now
  try {
    db.prepare('UPDATE platform_sessions SET lastSeenAt=? WHERE token=?').run(now, ps.token)
    return true
  } catch { return false }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/session-touch.test.mjs`
Expected: 4 pass

- [ ] **Step 5: 接线 index.mjs**

`server/index.mjs` 在既有 `try { db.exec('ALTER TABLE sessions …') }` 迁移区(~line 103)追加:

```js
// 用户中心(2026-08-29):会话设备信息 + 用户偏好(存量库幂等迁移,项目惯用 try-ALTER)
try { db.exec('ALTER TABLE platform_sessions ADD COLUMN lastSeenAt INTEGER') } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE platform_sessions ADD COLUMN ip TEXT') } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE platform_sessions ADD COLUMN userAgent TEXT') } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE platform_users ADD COLUMN prefs TEXT') } catch { /* 列已存在 */ }
```

顶部 import 区加 `import { touchSession } from './session-touch.mjs'`(与其它 ./ 模块 import 并排)。`platformUserFromRequest` 末尾 `return ps` 前插一行 `touchSession(db, ps)`。`createAuthRoutes({...})` 调用处(~line 1422)deps 增两项:`hashPassword,`(本文件 scrypt 实现,~line 217 附近已有的那个)与 `extractPlatformToken,`(已 import 自 `./platform-auth.mjs`)。

- [ ] **Step 6: auth.mjs login 写 ip/ua** —— `server/routes/auth.mjs` login 分支:deps 解构行加 `hashPassword, extractPlatformToken,`;`const ip = req.socket?.remoteAddress || 'unknown'` 之后已有 ip;ps 对象与 INSERT 改为:

```js
const ps = { token, userId: user.id, username: user.username, role: user.role, createdAt: Date.now(), k8sSessionToken: null, ip, userAgent: String(req.headers['user-agent'] || ''), lastSeenAt: psNow }
```

(在 ps 前定义 `const psNow = Date.now()` 并统一用之。)INSERT 改:

```js
db.prepare('INSERT INTO platform_sessions (token,userId,username,role,createdAt,ip,userAgent,lastSeenAt) VALUES (?,?,?,?,?,?,?,?)')
  .run(token, user.id, user.username, user.role, psNow, ip, String(req.headers['user-agent'] || ''), psNow)
```

- [ ] **Step 7: 修 auth-login-rate.test.mjs 的 makeDb**(否则 Step 8 全红)

`server/auth-login-rate.test.mjs` makeDb 里 platform_sessions 建表语句改为:

```js
db.exec(`CREATE TABLE IF NOT EXISTS platform_sessions (
  token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
  createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT)`)
```

- [ ] **Step 8: 跑服务端相关测试**

Run: `node --test server/session-touch.test.mjs server/auth-login-rate.test.mjs`
Expected: 全 pass(既有 login 测试不受影响)

- [ ] **Step 9: Commit**

```bash
git add server/session-touch.mjs server/session-touch.test.mjs server/index.mjs server/routes/auth.mjs server/auth-login-rate.test.mjs
git commit -m "feat(auth): 平台会话记录 ip/ua + lastSeenAt 节流回写——用户中心会话管理基建"
```

---

### Task 2: 服务端 self-service 端点 A(PATCH /api/auth/me + preferences)

**Files:**
- Modify: `server/routes/auth.mjs`(两新端点 + readPrefs helper + /me、login 回传 prefs)
- Modify: `server/route-auth-map.mjs`(登记 3 条)
- Modify: `server/messages/auth.mjs`(5 条新消息)
- Test: `server/auth-selfservice.test.mjs`(本 Task 建骨架,Task 3 续用)

**Interfaces:**
- Produces: `PATCH /api/auth/me` body `{displayName}` → `{user:{id,username,role,displayName}}`(白名单:其余字段静默忽略)。
- Produces: `GET /api/auth/me` → `{ user, prefs }`;login 响应 → `{ token, user, prefs }`;`prefs` 形状 `{ language?: 'en'|'zh', theme?: 'light'|'dark'|'system' }`。
- Produces: `PUT /api/auth/preferences` body `{language?,theme?}` → `{prefs}`;非法值 400。
- Produces: `readPrefs(db, userId) => object`(SELECT/JSON.parse 全程 try-catch,坏数据/缺列 → `{}`)。Task 5 前端消费该响应形状。

- [ ] **Step 1: 写失败测试**(新文件 `server/auth-selfservice.test.mjs`;deps 模板对齐 auth-login-rate.test.mjs 的注入风格,verifyPassword/hashPassword 用假实现测契约而非真 scrypt)

```js
// 用户中心 self-service 端点(2026-08-29 设计 §4.2):
// PATCH me 字段白名单(防 role/username 穿越)+ preferences 读写与非法值拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createAuthRoutes } from './routes/auth.mjs'
import { createAuditSchema, writeAudit } from './audit.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL,
    disabled INTEGER DEFAULT 0, prefs TEXT)`)
  db.exec(`CREATE TABLE platform_sessions (
    token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
    createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT)`)
  createAuditSchema(db)
  return db
}

// 最小会话态:token t-me → u1(alice)
function seed(db) {
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,displayName,createdAt) VALUES ('u1','alice','good','user','Alice',1)").run()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('t-me','u1','alice','user',1)").run()
}

function makeRoutes(db, over = {}) {
  const sent = []
  const deps = {
    db, sendJson: (_res, status, payload) => sent.push({ status, payload }),
    readBody: async () => deps._body,
    requirePlatform: (req) => (req._ps ?? db.prepare('SELECT * FROM platform_sessions WHERE token=?').get(req.headers['x-platform-token'])),
    platformSessions: new Map([['t-me', db.prepare('SELECT * FROM platform_sessions WHERE token=?').get('t-me')]]),
    sessions: new Map(), persistSession: () => {},
    verifyPassword: (p) => p === 'right-password',
    hashPassword: (p) => `hashed(${p})`,
    randomUUID: () => 'uuid-x',
    normalizeServer: (s) => new URL(s), buildCallContext: () => ({}),
    requestKubernetes: async () => ({ body: {} }),
    checkLoginRate: () => ({ allowed: true }),
    writeAudit,
    extractPlatformToken: (req) => req.headers['x-platform-token'] || '',
    ...over,
  }
  Object.assign(deps, over)
  return { routes: createAuthRoutes(deps), sent, deps }
}

function patchMe(routes, body) {
  routes._body = body
  return routes.routes.handle(
    { method: 'PATCH', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/me' }, {},
    new URL('/api/auth/me', 'http://x'))
}

test('PATCH me:改 displayName,返回最新 user', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await patchMe(routes, { displayName: '  阿亮  ' })
  assert.equal(sent[0].status, 200)
  assert.equal(sent[0].payload.user.displayName, '阿亮', '应 trim')
  assert.equal(db.prepare('SELECT displayName FROM platform_users WHERE id=?').get('u1').displayName, '阿亮')
})

test('PATCH me:白名单——role/username/password 字段被忽略(防穿越)', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await patchMe(routes, { displayName: 'X', role: 'admin', username: 'root', passwordHash: 'pwn' })
  const row = db.prepare('SELECT role,username,passwordHash FROM platform_users WHERE id=?').get('u1')
  assert.deepEqual(row, { role: 'user', username: 'alice', passwordHash: 'good' })
  assert.equal(sent[0].status, 200)
})

test('GET /api/auth/me:回传 prefs(未设置 → {})', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/me' }, {}, new URL('/api/auth/me', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload.prefs, {})
})

test('PUT preferences:合法 language/theme 落库并回传;GET me 可读回', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  routes._body = { language: 'en', theme: 'dark' }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/preferences' }, {}, new URL('/api/auth/preferences', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload.prefs, { language: 'en', theme: 'dark' })
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/me' }, {}, new URL('/api/auth/me', 'http://x'))
  assert.deepEqual(sent[1].payload.prefs, { language: 'en', theme: 'dark' })
})

test('PUT preferences:非法值 400 拒绝且不落库(部分合法字段也不写——全有或全无)', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  routes._body = { language: 'fr' }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/preferences' }, {}, new URL('/api/auth/preferences', 'http://x'))
  assert.equal(sent[0].status, 400)
  routes._body = { theme: 'purple' }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/preferences' }, {}, new URL('/api/auth/preferences', 'http://x'))
  assert.equal(sent[1].status, 400)
  assert.equal(db.prepare('SELECT prefs FROM platform_users WHERE id=?').get('u1').prefs, null)
})

test('PUT preferences:存量坏 prefs JSON 不崩,按 {} 起步', async () => {
  const db = makeDb(); seed(db)
  db.prepare('UPDATE platform_users SET prefs=? WHERE id=?').run('not-json{', 'u1')
  const { routes, sent } = makeRoutes(db)
  routes._body = { language: 'zh' }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/preferences' }, {}, new URL('/api/auth/preferences', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload.prefs, { language: 'zh' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/auth-selfservice.test.mjs`
Expected: FAIL(PATCH 无路由返回 false / prefs undefined)

- [ ] **Step 3: 实现 auth.mjs**

`server/routes/auth.mjs`:

(a) deps 解构加 `hashPassword, extractPlatformToken,`。

(b) handle 内 `/api/auth/me` GET 分支改为(回传 prefs):

```js
if (url.pathname === '/api/auth/me' && req.method === 'GET') {
  const ps = requirePlatform(req, res); if (!ps) return true
  const user = db.prepare('SELECT id,username,role,displayName FROM platform_users WHERE id=?').get(ps.userId)
  sendJson(res, 200, { user, prefs: readPrefs(db, ps.userId) })
  return true
}
```

(c) 紧随其后新增 PATCH 分支(白名单:只读 displayName,trim + 64 字上限):

```js
// PATCH /api/auth/me — 自助改显示名(2026-08-29 用户中心设计)
// 白名单:仅 displayName 可改;username/role/passwordHash 等字段静默忽略(防穿越)。
if (url.pathname === '/api/auth/me' && req.method === 'PATCH') {
  const ps = requirePlatform(req, res); if (!ps) return true
  const input = await readBody(req)
  if (input.displayName == null) { sendJson(res, 400, { message: msg(req, 'auth.noUpdateFields') }); return true }
  const displayName = String(input.displayName).trim().slice(0, 64)
  db.prepare('UPDATE platform_users SET displayName=? WHERE id=?').run(displayName || null, ps.userId)
  const user = db.prepare('SELECT id,username,role,displayName FROM platform_users WHERE id=?').get(ps.userId)
  sendJson(res, 200, { user })
  return true
}
```

(d) PUT preferences 分支:

```js
// PUT /api/auth/preferences — 自助偏好(language/theme;全有或全无校验,防半写)
const PREF_LANGS = ['en', 'zh']
const PREF_THEMES = ['light', 'dark', 'system']
if (url.pathname === '/api/auth/preferences' && req.method === 'PUT') {
  const ps = requirePlatform(req, res); if (!ps) return true
  const input = await readBody(req)
  if (input.language != null && !PREF_LANGS.includes(input.language)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
  if (input.theme != null && !PREF_THEMES.includes(input.theme)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
  const prefs = readPrefs(db, ps.userId)
  if (input.language != null) prefs.language = input.language
  if (input.theme != null) prefs.theme = input.theme
  db.prepare('UPDATE platform_users SET prefs=? WHERE id=?').run(JSON.stringify(prefs), ps.userId)
  sendJson(res, 200, { prefs })
  return true
}
```

(e) 模块顶部(deps 解构后)helper:

```js
// 读用户 prefs:SELECT/parse 全程容错——存量库无 prefs 列、坏 JSON 均回 {}(node:sqlite 拒绝非法绑定,这里只读标量)。
function readPrefs(db, userId) {
  try {
    const row = db.prepare('SELECT prefs FROM platform_users WHERE id=?').get(userId)
    return JSON.parse(row?.prefs || '{}') || {}
  } catch { return {} }
}
```

(f) login 成功响应加 prefs:`sendJson(res, 200, { token, user: {...}, prefs: readPrefs(db, user.id) })`。

- [ ] **Step 4: ROUTE_AUTH 登记** —— `server/route-auth-map.mjs` 平台段 `/api/auth/me` 条目后加:

```js
{ method: 'PATCH', pattern: '/api/auth/me',              auth: 'platform' }, // 自助改 displayName
{ method: 'PUT',   pattern: '/api/auth/preferences',     auth: 'platform' }, // 自助偏好(language/theme)
```

- [ ] **Step 5: 服务端消息** —— `server/messages/auth.mjs` TABLE 加:

```js
'auth.noUpdateFields': { zh: '没有可更新的字段', en: 'No fields to update' },
'auth.preferenceInvalid': { zh: '偏好取值非法', en: 'Invalid preference value' },
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test server/auth-selfservice.test.mjs server/authorize.test.mjs server/route-auth-map.test.mjs`
Expected: 全 pass(守卫测试认可新登记)

- [ ] **Step 7: Commit**

```bash
git add server/routes/auth.mjs server/route-auth-map.mjs server/messages/auth.mjs server/auth-selfservice.test.mjs
git commit -m "feat(auth): 自助改显示名 + 用户偏好端点——字段白名单防穿越,prefs 容错读写"
```

---

### Task 3: 服务端 self-service 端点 B(改密踢会话 + 会话列表/吊销)

**Files:**
- Modify: `server/routes/auth.mjs`(3 新端点)
- Modify: `server/route-auth-map.mjs`(3 条)
- Modify: `server/messages/auth.mjs`(3 条)
- Test: `server/auth-selfservice.test.mjs`(追加)

**Interfaces:**
- Produces: `POST /api/auth/change-password` body `{currentPassword,newPassword}` → 200 `{ok,revoked}`;旧密错 401;新密 <8 → 400。成功吊销该用户除当前外全部会话。
- Produces: `GET /api/auth/sessions` → `{sessions:[{fingerprint(8位),ip,userAgent,createdAt,lastSeenAt,current}]}`,按 lastSeenAt 降序。**不回传完整 token**。
- Produces: `DELETE /api/auth/sessions/others` → `{ok,revoked}`;`DELETE /api/auth/sessions/:fingerprint` → `{ok}`,吊当前会话 400,未命中 404。前端 Task 5 的 authApi 按此对接。

- [ ] **Step 1: 追加失败测试**(接在 `server/auth-selfservice.test.mjs` 末尾)

```js
// === Task 3:改密 + 会话管理 ===
function seedMulti(db) {
  seed(db)
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt,ip,userAgent) VALUES ('t-other','u1','alice','user',2,'2.2.2.2','Mozilla/5.0 Chrome')").run()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('t-stranger','u2','bob','user',3)").run()
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u2','bob','good','user',1)").run()
  db.prepare('UPDATE platform_sessions SET lastSeenAt=100 WHERE token=?').run('t-me')
  db.prepare('UPDATE platform_sessions SET lastSeenAt=200 WHERE token=?').run('t-other')
}

test('change-password:旧密错 → 401 + 审计 denied,密码不变', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent } = makeRoutes(db)
  routes._body = { currentPassword: 'wrong', newPassword: 'newpassword1' }
  await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/change-password' }, {}, new URL('/api/auth/change-password', 'http://x'))
  assert.equal(sent[0].status, 401)
  assert.equal(db.prepare('SELECT passwordHash FROM platform_users WHERE id=?').get('u1').passwordHash, 'good')
  const audit = db.prepare("SELECT result FROM audit_log WHERE tool='platform_change_password'").all()
  assert.deepEqual(audit.map(a => a.result), ['denied'])
})

test('change-password:新密 <8 → 400', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent } = makeRoutes(db)
  routes._body = { currentPassword: 'right-password', newPassword: 'short' }
  await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/change-password' }, {}, new URL('/api/auth/change-password', 'http://x'))
  assert.equal(sent[0].status, 400)
})

test('change-password:成功 → 哈希更新 + 吊销其他会话(保留当前)+ 审计 ok', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent, deps } = makeRoutes(db)
  routes._body = { currentPassword: 'right-password', newPassword: 'newpassword1' }
  await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/change-password' }, {}, new URL('/api/auth/change-password', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload, { ok: true, revoked: 1 })
  assert.equal(db.prepare('SELECT passwordHash FROM platform_users WHERE id=?').get('u1').passwordHash, 'hashed(newpassword1)')
  assert.equal(deps.platformSessions.has('t-other'), false, '其他会话应被吊销')
  assert.equal(deps.platformSessions.has('t-me'), true, '当前会话保留')
  assert.equal(deps.platformSessions.has('t-stranger'), true, '别人的会话不动')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM platform_sessions WHERE token='t-other'").get().c, 0, 'DB 同步删除')
  const ok = db.prepare("SELECT result FROM audit_log WHERE tool='platform_change_password' AND result='ok'").get()
  assert.ok(ok, '应写 ok 审计')
})

test('GET sessions:只列自己的,指纹为 token 前缀,current 标记正确,按 lastSeenAt 降序', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent, deps } = makeRoutes(db)
  deps.platformSessions.get('t-me').lastSeenAt = 100
  deps.platformSessions.get('t-other').lastSeenAt = 200
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/sessions' }, {}, new URL('/api/auth/sessions', 'http://x'))
  const list = sent[0].payload.sessions
  assert.equal(list.length, 2, '只列 alice 的两条')
  assert.equal(list[0].fingerprint, 't-other'.slice(0, 8), '指纹 = token.slice(0,8)(短 token 即全文)')
  assert.equal(list[0].current, false)
  assert.equal(list[0].ip, '2.2.2.2')
  assert.equal(list[1].fingerprint, 't-me')
  assert.equal(list[1].current, true)
  for (const s of list) assert.ok(!s.token, '绝不回传完整 token')
})

test('DELETE sessions/others:原子吊销其余全部,保留当前', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent, deps } = makeRoutes(db)
  await routes.routes.handle({ method: 'DELETE', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/sessions/others' }, {}, new URL('/api/auth/sessions/others', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload, { ok: true, revoked: 1 })
  assert.equal(deps.platformSessions.has('t-me'), true)
  assert.equal(deps.platformSessions.has('t-other'), false)
})

test('DELETE sessions/:fingerprint:按 8 位指纹吊销;吊当前 400;未命中 404', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent, deps } = makeRoutes(db)
  const fp = 't-other'.slice(0, 8)
  await routes.routes.handle({ method: 'DELETE', headers: { 'x-platform-token': 't-me' }, url: `/api/auth/sessions/${fp}` }, {}, new URL(`/api/auth/sessions/${fp}`, 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.equal(deps.platformSessions.has('t-other'), false)
  await routes.routes.handle({ method: 'DELETE', headers: { 'x-platform-token': 't-me' }, url: `/api/auth/sessions/${'t-me'.slice(0, 8)}` }, {}, new URL('/x', 'http://x'))
  assert.equal(sent[1].status, 400, '当前会话不可自吊(防自锁)')
  await routes.routes.handle({ method: 'DELETE', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/sessions/deadbeef' }, {}, new URL('/x', 'http://x'))
  assert.equal(sent[2].status, 404)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/auth-selfservice.test.mjs`
Expected: Task 2 的 6 个 pass,Task 3 新增 6 个 FAIL(handle 返回 false)

- [ ] **Step 3: 实现 auth.mjs 三个端点**(放在 PUT preferences 分支后)

```js
// POST /api/auth/change-password — 自助改密(2026-08-29 设计:验旧密 → 新密 ≥8 → 吊销其他会话)
if (url.pathname === '/api/auth/change-password' && req.method === 'POST') {
  const ps = requirePlatform(req, res); if (!ps) return true
  try {
    const { currentPassword, newPassword } = await readBody(req)
    const user = db.prepare('SELECT * FROM platform_users WHERE id=?').get(ps.userId)
    const auditChange = (result, reason = null, summary = null) => writeAudit?.(db, { owner: ps.username, verb: 'change', tool: 'platform_change_password', result, reason, requestSummary: summary, source: 'platform' })
    if (!user || !currentPassword || !verifyPassword(String(currentPassword), user.passwordHash)) {
      auditChange('denied', 'bad-current-password')
      sendJson(res, 401, { message: msg(req, 'auth.currentPasswordWrong') }); return true
    }
    if (!newPassword || String(newPassword).length < 8) { sendJson(res, 400, { message: msg(req, 'auth.passwordTooShort') }); return true }
    db.prepare('UPDATE platform_users SET passwordHash=? WHERE id=?').run(hashPassword(String(newPassword)), ps.userId)
    const currentToken = extractPlatformToken(req)
    let revoked = 0
    for (const [tok, s] of Array.from(platformSessions)) {
      if (s.userId === ps.userId && tok !== currentToken) {
        platformSessions.delete(tok)
        try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(tok) } catch { /* noop */ }
        revoked++
      }
    }
    auditChange('ok', null, `revoked=${revoked}`)
    sendJson(res, 200, { ok: true, revoked })
    return true
  } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.changePasswordFailed') }); return true }
}

// GET /api/auth/sessions — 当前用户活跃会话(权威源=内存 Map;token 仅回 8 位指纹)
if (url.pathname === '/api/auth/sessions' && req.method === 'GET') {
  const ps = requirePlatform(req, res); if (!ps) return true
  const currentToken = extractPlatformToken(req)
  const list = []
  for (const [tok, s] of platformSessions) {
    if (s.userId !== ps.userId) continue
    list.push({ fingerprint: tok.slice(0, 8), ip: s.ip || null, userAgent: s.userAgent || null, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt || s.createdAt, current: tok === currentToken })
  }
  list.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
  sendJson(res, 200, { sessions: list })
  return true
}

// DELETE /api/auth/sessions/others — 原子吊销除当前外全部(先于 :fingerprint 匹配)
if (url.pathname === '/api/auth/sessions/others' && req.method === 'DELETE') {
  const ps = requirePlatform(req, res); if (!ps) return true
  const currentToken = extractPlatformToken(req)
  let revoked = 0
  for (const [tok, s] of Array.from(platformSessions)) {
    if (s.userId !== ps.userId || tok === currentToken) continue
    platformSessions.delete(tok)
    try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(tok) } catch { /* noop */ }
    revoked++
  }
  writeAudit?.(db, { owner: ps.username, verb: 'revoke', tool: 'platform_session_revoke', result: 'ok', requestSummary: `revoked=${revoked}`, source: 'platform' })
  sendJson(res, 200, { ok: true, revoked })
  return true
}

// DELETE /api/auth/sessions/:fingerprint — 按 token 前缀指纹吊销指定会话;当前会话拒吊(防自锁)。
// 'others' 精确分支在上面已先行返回,此处 [^/]+ 不会误吞;归属过滤(userId)保证只能吊自己的。
const fpMatch = url.pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/)
if (fpMatch && req.method === 'DELETE') {
  const ps = requirePlatform(req, res); if (!ps) return true
  const currentToken = extractPlatformToken(req)
  const fp = fpMatch[1]
  if (currentToken && currentToken.slice(0, 8) === fp) { sendJson(res, 400, { message: msg(req, 'auth.sessionCurrentNoRevoke') }); return true }
  let hit = null
  for (const [tok, s] of platformSessions) {
    if (s.userId === ps.userId && tok.slice(0, 8) === fp) { hit = tok; break }
  }
  if (!hit) { sendJson(res, 404, { message: msg(req, 'auth.sessionNotFound') }); return true }
  platformSessions.delete(hit)
  try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(hit) } catch { /* noop */ }
  writeAudit?.(db, { owner: ps.username, verb: 'revoke', tool: 'platform_session_revoke', result: 'ok', requestSummary: `fp=${fp}`, source: 'platform' })
  sendJson(res, 200, { ok: true })
  return true
}
```

- [ ] **Step 4: ROUTE_AUTH 登记** —— 平台段追加:

```js
{ method: 'POST',   pattern: '/api/auth/change-password',     auth: 'platform' }, // 自助改密(踢其他会话)
{ method: 'GET',    pattern: '/api/auth/sessions',            auth: 'platform' }, // 我的活跃会话
{ method: 'DELETE', pattern: '/api/auth/sessions/others',     auth: 'platform' }, // 退出其他设备
{ prefix: '/api/auth/sessions/', auth: 'platform' },                              // :fingerprint 吊销
```

- [ ] **Step 5: 消息** —— `server/messages/auth.mjs` 追加:

```js
'auth.currentPasswordWrong': { zh: '当前密码错误', en: 'Current password is incorrect' },
'auth.passwordTooShort': { zh: '新密码至少 8 位', en: 'New password must be at least 8 characters' },
'auth.changePasswordFailed': { zh: '修改密码失败', en: 'Failed to change password' },
'auth.sessionNotFound': { zh: '会话不存在或已失效', en: 'Session not found or expired' },
'auth.sessionCurrentNoRevoke': { zh: '不能吊销当前会话', en: 'Cannot revoke the current session' },
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test server/auth-selfservice.test.mjs server/authorize.test.mjs server/route-auth-map.test.mjs server/session-touch.test.mjs`
Expected: 全 pass

- [ ] **Step 7: Commit**

```bash
git add server/routes/auth.mjs server/route-auth-map.mjs server/messages/auth.mjs server/auth-selfservice.test.mjs
git commit -m "feat(auth): 自助改密(验旧密+踢其他会话)+ 活跃会话列表/吊销——token 仅回 8 位指纹"
```

---

### Task 4: admin 建用户/重置密码统一 ≥8 校验(G5)

**Files:**
- Modify: `server/routes/admin.mjs:492`(create user)与 `:530`(reset-password)
- Modify: `server/messages/admin.mjs`
- Test: `server/password-policy.test.mjs`(校验逻辑抽纯函数单源单测;admin/auth 两路由只做接线,行为由纯函数测试 + Task 3 既有 change-password 测试覆盖)

**Interfaces:**
- Produces: 校验规则单源 `server/password-policy.mjs` 的 `isPasswordOk(pw) => boolean`(非空且 length ≥ 8)。auth.mjs change-password 分支改为复用该函数(替换 Task 3 的内联 `length < 8` 判断,行为不变)。

- [ ] **Step 1: 写失败测试** `server/password-policy.test.mjs`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { isPasswordOk } from './password-policy.mjs'

test('≥8 位通过;<8 位拒绝;空/非字符串拒绝', () => {
  assert.equal(isPasswordOk('12345678'), true)
  assert.equal(isPasswordOk('1234567'), false)
  assert.equal(isPasswordOk(''), false)
  assert.equal(isPasswordOk(null), false)
  assert.equal(isPasswordOk(undefined), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/password-policy.test.mjs`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `server/password-policy.mjs`

```js
// 密码策略单源(2026-08-29 用户中心设计 G5):自改/建户/重置三路同一规则。
export const PASSWORD_MIN_LENGTH = 8
export function isPasswordOk(pw) {
  return typeof pw === 'string' && pw.length >= PASSWORD_MIN_LENGTH
}
```

- [ ] **Step 4: 三处接线**——auth.mjs change-password 的 `<8` 判断改为 `!isPasswordOk(newPassword)`(顶部 `import { isPasswordOk } from '../password-policy.mjs'`);admin.mjs create user 在 `if (!username || !password)` 后加:

```js
if (!isPasswordOk(password)) { sendJson(res, 400, { message: msg(req, 'admin.passwordTooShort') }); return true }
```

reset-password 的 `if (!newPassword)` 后加:

```js
if (!isPasswordOk(newPassword)) { sendJson(res, 400, { message: msg(req, 'admin.passwordTooShort') }); return true }
```

admin.mjs 顶部同款 import。`server/messages/admin.mjs` 加:

```js
'admin.passwordTooShort': { zh: '密码至少 8 位', en: 'Password must be at least 8 characters' },
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test server/password-policy.test.mjs server/auth-selfservice.test.mjs && npm run test:server`
Expected: 全 pass(全量回归确认 admin 既有测试不破)

- [ ] **Step 6: Commit**

```bash
git add server/password-policy.mjs server/password-policy.test.mjs server/routes/auth.mjs server/routes/admin.mjs server/messages/admin.mjs
git commit -m "feat(auth): 密码 ≥8 校验单源化——建户/重置/自改三路同规(G5)"
```

---

### Task 5: 前端数据层(authApi 扩展 + auth store prefs 接线 + fetchMe 修 + preferences store)

**Files:**
- Modify: `src/api/client.js`(authApi 增 6 方法,~line 284)
- Modify: `src/stores/auth.js`(login/fetchMe 接 prefs;fetchMe 仅 401/403 登出)
- Create: `src/stores/preferences.js`
- Test: `src/stores/__tests__/preferences.test.js`

**Interfaces:**
- Consumes: 服务端响应形状(Task 2/3):`{user,prefs}` / `{ok,revoked}` / `{sessions:[...]}`。
- Produces: `authApi.updateMe(patch) / changePassword(current, next) / listSessions() / revokeSession(fp) / revokeOtherSessions() / savePreferences(prefs)`。
- Produces: `usePreferencesStore()` → `{ language, theme, hydrateFromServer(prefs), setLanguage('en'|'zh'), setTheme('light'|'dark'|'system') }`。Task 7(UserMenu)/Task 8(UserProfile)/Task 10(theme) 消费。

- [ ] **Step 1: 写失败测试** `src/stores/__tests__/preferences.test.js`

```js
// preferences store:本地缓存即时生效 + 服务端同步失败静默(离线兜底)。
import { test, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/api/client', () => ({
  authApi: {
    savePreferences: vi.fn().mockResolvedValue({ prefs: {} }),
  },
}))
vi.mock('@/i18n', () => ({ setLocale: vi.fn() }))
vi.mock('@/styles/theme', () => ({ applyThemeMode: vi.fn() }))

import { usePreferencesStore } from '@/stores/preferences'
import { authApi } from '@/api/client'
import { setLocale } from '@/i18n'
import { applyThemeMode } from '@/styles/theme'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
})

test('setLanguage:更新 state + setLocale + 双写(localStorage + 服务端)', async () => {
  const s = usePreferencesStore()
  s.setLanguage('en')
  expect(s.language).toBe('en')
  expect(setLocale).toHaveBeenCalledWith('en')
  expect(localStorage.getItem('aliangboard.locale')).toBe('en')
  await vi.waitFor(() => expect(authApi.savePreferences).toHaveBeenCalledWith({ language: 'en', theme: null }))
})

test('setTheme:更新 state + applyThemeMode + 本地缓存', () => {
  const s = usePreferencesStore()
  s.setTheme('dark')
  expect(s.theme).toBe('dark')
  expect(applyThemeMode).toHaveBeenCalledWith('dark')
  expect(localStorage.getItem('aliangboard.theme')).toBe('dark')
})

test('hydrateFromServer:服务端值覆盖本地并生效', () => {
  const s = usePreferencesStore()
  s.hydrateFromServer({ language: 'en', theme: 'light' })
  expect(s.language).toBe('en')
  expect(s.theme).toBe('light')
  expect(setLocale).toHaveBeenCalledWith('en')
  expect(applyThemeMode).toHaveBeenCalledWith('light')
})

test('hydrateFromServer:prefs 为空/字段缺失时不动本地', () => {
  const s = usePreferencesStore()
  s.hydrateFromServer(null)
  s.hydrateFromServer({})
  expect(s.language).toBeNull()
  expect(s.theme).toBeNull()
  expect(setLocale).not.toHaveBeenCalled()
})

test('savePreferences 失败静默:本地已生效不回滚', async () => {
  authApi.savePreferences.mockRejectedValueOnce(new Error('offline'))
  const s = usePreferencesStore()
  s.setTheme('dark')
  await vi.waitFor(() => expect(authApi.savePreferences).toHaveBeenCalled())
  expect(s.theme).toBe('dark')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/preferences.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 preferences store** `src/stores/preferences.js`

```js
// 用户偏好 store(2026-08-29 用户中心设计 §2.4):language/theme 三级来源——
// ① localStorage 兜底(登录页/未登录);② 登录态建立时服务端 prefs 覆盖(hydrateFromServer);
// ③ 变更即时本地生效 + 双写(localStorage + PUT /api/auth/preferences,失败静默=离线兜底)。
// language 复用 src/i18n.js 的 setLocale(其 localStorage 键 aliangboard.locale 即本 store 的缓存键,
// Accept-Language 已由 http.js authHeaders 随 locale 发出,服务端消息语言自动跟随)。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { authApi } from '@/api/client'
import { setLocale } from '@/i18n'
import { applyThemeMode } from '@/styles/theme'

const LOCALE_KEY = 'aliangboard.locale'
const THEME_KEY = 'aliangboard.theme'

function readStorage(key) {
  try { const v = localStorage.getItem(key); return v || null } catch { return null }
}

export const usePreferencesStore = defineStore('preferences', () => {
  const language = ref(readStorage(LOCALE_KEY))  // 'en' | 'zh' | null(未设置 → i18n 默认)
  const theme = ref(readStorage(THEME_KEY))      // 'light' | 'dark' | 'system' | null(未设置 → system)

  // 服务端为准覆盖(auth.login / authStore.fetchMe 拿到 prefs 后调用)
  function hydrateFromServer(prefs) {
    if (!prefs) return
    if (prefs.language && prefs.language !== language.value) { language.value = prefs.language; setLocale(prefs.language) }
    if (prefs.theme && prefs.theme !== theme.value) { theme.value = prefs.theme; applyThemeMode(prefs.theme) }
  }

  function setLanguage(lang) {
    language.value = lang
    setLocale(lang)
    persist()
  }
  function setTheme(mode) {
    theme.value = mode
    applyThemeMode(mode)
    persist()
  }
  function persist() {
    try {
      localStorage.setItem(LOCALE_KEY, language.value || '')
      localStorage.setItem(THEME_KEY, theme.value || '')
    } catch { /* 无 storage 环境 */ }
    authApi.savePreferences({ language: language.value, theme: theme.value }).catch(() => { /* 离线兜底:本地已生效 */ })
  }
  return { language, theme, hydrateFromServer, setLanguage, setTheme }
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/preferences.test.js`
Expected: 5 pass

- [ ] **Step 5: client.js authApi 扩展** —— `src/api/client.js` authApi 对象(`logout` 行后)加:

```js
  updateMe: patch => platformHttp.request('/api/auth/me', { method: 'PATCH', body: JSON.stringify(patch) }),
  changePassword: (currentPassword, newPassword) => platformHttp.request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  listSessions: () => platformHttp.request('/api/auth/sessions'),
  revokeSession: fp => platformHttp.request(`/api/auth/sessions/${encodeURIComponent(fp)}`, { method: 'DELETE' }),
  revokeOtherSessions: () => platformHttp.request('/api/auth/sessions/others', { method: 'DELETE' }),
  savePreferences: prefs => platformHttp.request('/api/auth/preferences', { method: 'PUT', body: JSON.stringify(prefs) }),
```

- [ ] **Step 6: auth store 接线** —— `src/stores/auth.js`:

(a) 顶部 import `import { usePreferencesStore } from '@/stores/preferences'`。

(b) `login` 成功分支(res 赋值后)加 `usePreferencesStore().hydrateFromServer(res.prefs)`。

(c) `fetchMe` 整体替换(G6:仅 401/403 登出,网络抖动保留会话;服务端 prefs 回灌):

```js
  async function fetchMe() {
    if (!token.value) return null
    try {
      const res = await authApi.me()
      user.value = res.user
      usePreferencesStore().hydrateFromServer(res.prefs)
      return res.user
    } catch (e) {
      // G6(2026-08-29):曾 catch-all 即登出——网关重启/网络抖动也把用户踢回登录页。
      // 仅鉴权失效(401/403)才登出;其余错误保留会话交由调用方提示。
      if (e?.status === 401 || e?.status === 403) { logout(); return null }
      return user.value
    }
  }
```

- [ ] **Step 7: 回归 + Commit**

Run: `npx vitest run src/stores src/components/layout/__tests__/TopNavBar.test.js && npm run typecheck`
Expected: pass

```bash
git add src/api/client.js src/stores/auth.js src/stores/preferences.js src/stores/__tests__/preferences.test.js
git commit -m "feat(store): 用户偏好 store(三级来源双写)+ authApi 六端点对接 + fetchMe 仅 401/403 登出(G6)"
```

---

### Task 6: ConfirmDialog 通用组件

**Files:**
- Create: `src/components/common/ConfirmDialog.vue`
- Modify: `src/locales/en.json` / `src/locales/zh.json`(component.confirmDialog 三键;route.profile 顺带在本 Task 加,Task 8 路由要用)
- Test: `src/components/common/__tests__/ConfirmDialog.test.js`

**Interfaces:**
- Produces: `<ConfirmDialog v-model danger title message confirmText cancelText loading @confirm @cancel>`。**confirm 不自动关窗**(调用方在成功回调里关,失败时窗留着可重试)。Task 7(登出)/Task 8(吊销会话)消费。

- [ ] **Step 1: 写失败测试** `src/components/common/__tests__/ConfirmDialog.test.js`

```js
// Teleport 弹层断言必须查 document.body(既往教训:查 wrapper 恒空)。
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

function mountDialog(props = {}) {
  return mount(ConfirmDialog, {
    props: { modelValue: true, title: '退出登录?', message: '确认退出当前账号?', ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
}

test('打开:标题/文案渲染于 document.body,含默认确认/取消钮', () => {
  const w = mountDialog()
  expect(document.body.textContent).toContain('退出登录?')
  expect(document.body.textContent).toContain('确认退出当前账号?')
  expect(document.body.querySelector('[data-testid="confirm-ok"]')).toBeTruthy()
  expect(document.body.querySelector('[data-testid="confirm-cancel"]')).toBeTruthy()
  w.unmount()
})

test('danger 态:确认钮 error 配色类', () => {
  const w = mountDialog({ danger: true })
  expect(document.body.querySelector('[data-testid="confirm-ok"]').className).toContain('bg-error')
  w.unmount()
})

test('点击确认:emit confirm 且不自动关窗(调用方成功后再关,失败可重试)', async () => {
  const w = mountDialog()
  document.body.querySelector('[data-testid="confirm-ok"]').click()
  await w.vm.$nextTick()
  expect(w.emitted('confirm')).toHaveLength(1)
  expect(w.emitted('update:modelValue')).toBeUndefined()
  w.unmount()
})

test('点击取消:emit cancel + update:modelValue=false', async () => {
  const w = mountDialog()
  document.body.querySelector('[data-testid="confirm-cancel"]').click()
  await w.vm.$nextTick()
  expect(w.emitted('cancel')).toHaveLength(1)
  expect(w.emitted('update:modelValue')[0]).toEqual([false])
  w.unmount()
})

test('loading 态:确认钮 disabled', () => {
  const w = mountDialog({ loading: true })
  expect(document.body.querySelector('[data-testid="confirm-ok"]').disabled).toBe(true)
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/ConfirmDialog.test.js`
Expected: FAIL(组件不存在)

- [ ] **Step 3: 实现** `src/components/common/ConfirmDialog.vue`

```vue
<script setup>
// 通用确认弹窗(2026-08-29 用户中心设计 §2.2):基于 Modal 收敛「标题+文案+确认/取消」;
// danger 态确认钮 error 色(登出/吊销会话)。confirm 不自动关窗——调用方在成功回调里关,
// 失败时窗留着可重试。存量原生 confirm() 的替换为 follow-up(F3),不在本期。
import Modal from './Modal.vue'
import { useI18n } from 'vue-i18n'

defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '' },  // 缺省用 component.confirmDialog.confirm
  cancelText: { type: String, default: '' },
  danger: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'confirm', 'cancel'])
const { t } = useI18n()
function onCancel() { emit('update:modelValue', false); emit('cancel') }
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="title"
    width="max-w-md"
    @update:model-value="v => { if (!v) onCancel() }"
  >
    <p class="text-body-md text-on-surface-variant">{{ message }}</p>
    <template #actions>
      <button
        data-testid="confirm-cancel"
        class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high"
        @click="onCancel"
      >{{ cancelText || t('component.confirmDialog.cancel') }}</button>
      <button
        data-testid="confirm-ok"
        :disabled="loading"
        class="px-md py-sm rounded-lg text-body-md font-semibold disabled:opacity-50"
        :class="danger ? 'bg-error text-on-error' : 'bg-primary text-on-primary'"
        @click="emit('confirm')"
      >{{ confirmText || t('component.confirmDialog.confirm') }}</button>
    </template>
  </Modal>
</template>
```

- [ ] **Step 4: i18n 键** —— `src/locales/zh.json` `component` 段(与 `modal` 键同级)加:

```json
"confirmDialog": { "confirm": "确认", "cancel": "取消" },
```

`route` 段加(顺手,Task 8 用):`"profile": "个人中心"`。`src/locales/en.json` 对应 `"confirmDialog": { "confirm": "Confirm", "cancel": "Cancel" }`、`"profile": "Profile"`。

- [ ] **Step 5: 跑测试确认通过 + 门禁**

Run: `npx vitest run src/components/common/__tests__/ConfirmDialog.test.js && npm run i18n:check`
Expected: 5 pass;门禁过

- [ ] **Step 6: Commit**

```bash
git add src/components/common/ConfirmDialog.vue src/components/common/__tests__/ConfirmDialog.test.js src/locales/en.json src/locales/zh.json
git commit -m "feat(ui): 通用 ConfirmDialog 组件——danger 态/confirm 不自动关窗,登出与会话吊销消费"
```

---

### Task 7: UserMenu 头像下拉菜单(根治点击即登出)

**Files:**
- Create: `src/components/layout/UserMenu.vue`
- Modify: `src/components/layout/TopNavBar.vue:292-297`(整块按钮换 `<UserMenu />`;`logout` 函数与 `authStore` 残留引用清理)
- Modify: `src/locales/en.json` / `src/locales/zh.json`(nav.userCenter + userCenter.logoutConfirm 等 4 键)
- Test: `src/components/layout/__tests__/UserMenu.test.js`

**Interfaces:**
- Consumes: `useAuthStore`(user/isAdmin/logout)、`useClusterStore`(stopPodWatch/stopEventWatch)、Task 6 ConfirmDialog。
- Produces: 组件零 props;`data-testid`: `user-menu-trigger`(触发钮)、`user-menu-dropdown`(菜单)、`user-menu-profile`、`user-menu-logout`。TopNavBar 仅 `<UserMenu />` 一行。

- [ ] **Step 1: 先查既有回归** —— Run: `grep -n "logout" src/components/layout/__tests__/TopNavBar*.test.js`
若有测试断言「点击头像即登出」/引用 `nav.logout`,本 Task Step 6 一并改写为断言「点击头像只开菜单、不登出」。

- [ ] **Step 2: 写失败测试** `src/components/layout/__tests__/UserMenu.test.js`

```js
// 根治回归(2026-08-29):点击头像必须只开菜单;登出必须经 ConfirmDialog 二次确认。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const pushMock = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))

import UserMenu from '@/components/layout/UserMenu.vue'
import { useAuthStore } from '@/stores/auth'
import { useClusterStore } from '@/stores/cluster'

beforeEach(() => {
  setActivePinia(createPinia())
  pushMock.mockClear()
  document.body.innerHTML = ''
})

function mountMenu() {
  return mount(UserMenu, { global: { plugins: [i18n] }, attachTo: document.body })
}

function seedUser() {
  const auth = useAuthStore()
  auth.user = { id: 'u1', username: 'alice', role: 'admin', displayName: 'Alice' }
  return auth
}

test('点击触发钮:开菜单(资料卡+两个菜单项),不触发 logout/push', async () => {
  seedUser()
  const auth = useAuthStore()
  const logoutSpy = vi.spyOn(auth, 'logout')
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(w.find('[data-testid="user-menu-dropdown"]').exists()).toBe(true)
  expect(document.body.textContent).toContain('alice')
  expect(w.find('[data-testid="user-menu-profile"]').exists()).toBe(true)
  expect(w.find('[data-testid="user-menu-logout"]').exists()).toBe(true)
  expect(logoutSpy).not.toHaveBeenCalled()
  expect(pushMock).not.toHaveBeenCalled()
  w.unmount()
})

test('再点触发钮:关菜单(开合切换)', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(w.find('[data-testid="user-menu-dropdown"]').exists()).toBe(false)
  w.unmount()
})

test('点「用户中心」:关菜单并 push /profile', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-profile"]').trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/profile')
  expect(w.find('[data-testid="user-menu-dropdown"]').exists()).toBe(false)
  w.unmount()
})

test('点「退出登录」:先弹 ConfirmDialog,确认才 logout + 跳 /login', async () => {
  seedUser()
  const auth = useAuthStore()
  const logoutSpy = vi.spyOn(auth, 'logout').mockImplementation(() => {})
  const stopSpy = vi.spyOn(useClusterStore(), 'stopPodWatch').mockImplementation(() => {})
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-logout"]').trigger('click')
  expect(logoutSpy).not.toHaveBeenCalled()
  const ok = document.body.querySelector('[data-testid="confirm-ok"]')
  expect(ok).toBeTruthy()
  ok.click()
  await w.vm.$nextTick()
  expect(logoutSpy).toHaveBeenCalledTimes(1)
  expect(stopSpy).toHaveBeenCalledTimes(1)
  expect(pushMock).toHaveBeenCalledWith('/login')
  w.unmount()
})

test('确认框点取消:不登出、窗关', async () => {
  seedUser()
  const auth = useAuthStore()
  const logoutSpy = vi.spyOn(auth, 'logout').mockImplementation(() => {})
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-logout"]').trigger('click')
  document.body.querySelector('[data-testid="confirm-cancel"]').click()
  await w.vm.$nextTick()
  expect(logoutSpy).not.toHaveBeenCalled()
  w.unmount()
})

test('非 admin 用户不显示 ADMIN 徽章', async () => {
  const auth = useAuthStore()
  auth.user = { id: 'u2', username: 'bob', role: 'user', displayName: '' }
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(document.body.textContent).not.toContain('ADMIN')
  w.unmount()
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/UserMenu.test.js`
Expected: FAIL(组件不存在)

- [ ] **Step 4: 实现** `src/components/layout/UserMenu.vue`

```vue
<script setup>
// 头像用户菜单(2026-08-29 用户中心设计 §2.1):点击开菜单而非登出——根治 TopNavBar
// 「头像整块=登出按钮」误触问题。登出走 ConfirmDialog 二次确认;菜单开合用 document
// 级 click 外部关闭 + ESC(与 TopNavBar 集群/ns 下拉的遮罩模式等价,这里是自包含实现)。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useClusterStore } from '@/stores/cluster'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const router = useRouter()
const authStore = useAuthStore()
const clusterStore = useClusterStore()

const open = ref(false)
const showLogoutConfirm = ref(false)
const rootEl = ref(null)

const displayName = computed(() => authStore.user?.displayName || authStore.user?.username || 'User')
const initial = computed(() => displayName.value.charAt(0).toUpperCase())

function toggle() { open.value = !open.value }
function closeMenu() { open.value = false }
function goProfile() { closeMenu(); router.push('/profile') }
function askLogout() { closeMenu(); showLogoutConfirm.value = true }
function doLogout() {
  showLogoutConfirm.value = false
  try { clusterStore.stopPodWatch() } catch { /* 未启动时忽略 */ }
  try { clusterStore.stopEventWatch() } catch { /* 未启动时忽略 */ }
  authStore.logout()
  router.push('/login')
}
function onDocClick(e) { if (open.value && rootEl.value && !rootEl.value.contains(e.target)) closeMenu() }
function onKey(e) { if (e.key === 'Escape') closeMenu() }
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="rootEl" class="relative shrink-0">
    <button
      data-testid="user-menu-trigger"
      class="flex items-center gap-sm cursor-pointer hover:bg-surface-container-low p-1 rounded-lg transition-colors"
      :aria-label="$t('nav.userCenter')"
      @click="toggle"
    >
      <div class="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-body-sm font-bold">{{ initial }}</div>
      <span class="text-body-sm font-semibold max-w-[120px] truncate" :title="displayName">{{ displayName }}</span>
      <span v-if="authStore.isAdmin" class="px-1 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold">ADMIN</span>
      <span class="material-symbols-outlined text-on-surface-variant text-body-sm transition-transform" :class="open ? 'rotate-180' : ''">expand_more</span>
    </button>

    <div
      v-if="open"
      data-testid="user-menu-dropdown"
      class="absolute top-full right-0 mt-1 w-60 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-50 overflow-hidden"
    >
      <div class="flex items-center gap-sm px-md py-md border-b border-outline-variant">
        <div class="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-headline-sm font-bold shrink-0">{{ initial }}</div>
        <div class="min-w-0">
          <p class="text-body-md font-semibold truncate">{{ displayName }}</p>
          <p class="text-body-xs text-on-surface-variant truncate font-mono">{{ authStore.user?.username }}</p>
        </div>
      </div>
      <button
        data-testid="user-menu-profile"
        class="flex items-center gap-sm w-full px-md py-sm text-left hover:bg-surface-container transition-colors"
        @click="goProfile"
      >
        <span class="material-symbols-outlined text-lg text-on-surface-variant">person</span>
        <span class="text-body-md">{{ $t('nav.userCenter') }}</span>
      </button>
      <div class="border-t border-outline-variant"></div>
      <button
        data-testid="user-menu-logout"
        class="flex items-center gap-sm w-full px-md py-sm text-left text-error hover:bg-error/10 transition-colors"
        @click="askLogout"
      >
        <span class="material-symbols-outlined text-lg">logout</span>
        <span class="text-body-md">{{ $t('nav.logout') }}</span>
      </button>
    </div>

    <ConfirmDialog
      v-model="showLogoutConfirm"
      :title="$t('userCenter.logoutConfirmTitle')"
      :message="$t('userCenter.logoutConfirmMessage')"
      :confirm-text="$t('nav.logout')"
      danger
      @confirm="doLogout"
    />
  </div>
</template>
```

- [ ] **Step 5: TopNavBar 接线** —— `src/components/layout/TopNavBar.vue`:

(a) 删 `logout` 函数(136-141 行)与顶部对 `useClusterStore` 的 cluster store 无关依赖不动;`import { useAuthStore }` 若仅 logout/模板头像用,替换后模板不再直接用 `authStore`——检查后:模板 292-297 换成 `<UserMenu />`,script 删 `authStore` 声明与 `useAuthStore` import(若 dedup 测试引用另说,Step 6 回归定夺)。

(b) 模板 292-297 整块替换为:

```html
      <UserMenu />
```

(c) script 加 `import UserMenu from './UserMenu.vue'`。

- [ ] **Step 6: i18n + 回归** —— `zh.json` `nav` 段加 `"userCenter": "用户中心"`;新增顶层段(与 `nav` 同级):

```json
"userCenter": {
  "logoutConfirmTitle": "退出登录",
  "logoutConfirmMessage": "确定要退出当前账号吗?未提交的编辑与进行中的终端会话将中断。"
},
```

`en.json` 对应 `"userCenter": "User Center"`、`"logoutConfirmTitle": "Sign out"`、`"logoutConfirmMessage": "Sign out of this account? Unsaved edits and active terminal sessions will be interrupted."`。

Run: `npx vitest run src/components/layout/__tests__/UserMenu.test.js src/components/layout/__tests__/TopNavBar.test.js src/components/layout/__tests__/TopNavBar.dedup.test.js src/components/layout/__tests__/TopNavBar.workbench-entry.test.js && npm run i18n:check`
Expected: 全 pass;门禁过(按 Step 1 预查结果修既有断言)

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/UserMenu.vue src/components/layout/__tests__/UserMenu.test.js src/components/layout/TopNavBar.vue src/locales/en.json src/locales/zh.json src/components/layout/__tests__/TopNavBar.test.js src/components/layout/__tests__/TopNavBar.dedup.test.js src/components/layout/__tests__/TopNavBar.workbench-entry.test.js
git commit -m "feat(nav): 头像点击改弹用户菜单——登出走 ConfirmDialog 二次确认,根治误触即登出"
```

---

### Task 8: UserProfile 用户中心页(资料/安全/偏好三卡)+ 路由

**Files:**
- Create: `src/views/UserProfile.vue`
- Create: `src/utils/uaSummary.js`
- Modify: `src/router/index.js`(AppLayout children 内 admin 路由组前加 /profile)
- Modify: `src/locales/en.json` / `src/locales/zh.json`(userCenter 全套键)
- Test: `src/utils/__tests__/uaSummary.test.js`、`src/views/__tests__/UserProfile.test.js`

**Interfaces:**
- Consumes: Task 5 authApi 六方法 + preferences store;Task 6 ConfirmDialog。
- Produces: 路由 `{ path: 'profile', name: 'UserProfile' }`,`meta: { titleKey: 'route.profile', scope: 'global', requiresCluster: false }`。测试挂钩 `data-testid`:`profile-displayname-input`、`profile-displayname-save`、`pwd-current`、`pwd-new`、`pwd-confirm`、`pwd-submit`、`session-row`、`session-revoke-<fp>`、`sessions-revoke-others`。

- [ ] **Step 1: 写失败测试** `src/utils/__tests__/uaSummary.test.js`

```js
import { test, expect } from 'vitest'
import { uaSummary } from '@/utils/uaSummary'

test('解析常见 UA 家族;空值回 —', () => {
  expect(uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36')).toBe('Chrome · Windows')
  expect(uaSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toBe('Safari · macOS')
  expect(uaSummary('Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0')).toBe('Firefox · Linux')
  expect(uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari · iOS')
  expect(uaSummary('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0')).toBe('Edge · Windows')
  expect(uaSummary('')).toBe('—')
  expect(uaSummary(null)).toBe('—')
})
```

- [ ] **Step 2: 实现** `src/utils/uaSummary.js`

```js
// 会话列表 UA 摘要(2026-08-29 用户中心设计):只拆「浏览器 · 系统」两级,不追求全量指纹库。
export function uaSummary(ua) {
  if (!ua) return '—'
  const s = String(ua)
  const os = /Windows/.test(s) ? 'Windows'
    : /Android/.test(s) ? 'Android'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS'
    : /Mac OS X/.test(s) ? 'macOS'
    : /Linux/.test(s) ? 'Linux'
    : 'Unknown OS'
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\//.test(s) ? 'Opera'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Safari\//.test(s) ? 'Safari'
    : 'Unknown'
  return `${browser} · ${os}`
}
```

Run: `npx vitest run src/utils/__tests__/uaSummary.test.js` → 1 pass。

- [ ] **Step 3: 写页面失败测试** `src/views/__tests__/UserProfile.test.js`

```js
// 三卡交互:资料就地编辑 / 改密表单校验+提交 / 会话列表渲染+吊销确认 / 偏好联动 store。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
const apiMocks = vi.hoisted(() => ({
  updateMe: vi.fn(),
  changePassword: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  savePreferences: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/api/client', () => ({ authApi: apiMocks }))

import UserProfile from '@/views/UserProfile.vue'
import { useAuthStore } from '@/stores/auth'
import { usePreferencesStore } from '@/stores/preferences'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  apiMocks.savePreferences.mockResolvedValue({})
  const auth = useAuthStore()
  auth.user = { id: 'u1', username: 'alice', role: 'user', displayName: 'Alice', createdAt: 1756400000000 }
  apiMocks.listSessions.mockResolvedValue({ sessions: [
    { fingerprint: 'abcd1234', ip: '1.2.3.4', userAgent: 'Mozilla/5.0 Chrome Safari', createdAt: 1756400000000, lastSeenAt: 1756400100000, current: true },
    { fingerprint: 'beef5678', ip: '5.6.7.8', userAgent: 'Mozilla/5.0 Firefox', createdAt: 1756300000000, lastSeenAt: 1756390000000, current: false },
  ] })
  apiMocks.updateMe.mockResolvedValue({ user: { id: 'u1', username: 'alice', role: 'user', displayName: '阿亮' } })
})

function mountPage() {
  return mount(UserProfile, { global: { plugins: [i18n] } })
}

test('挂载:拉会话列表,渲染两行,当前行有标记', async () => {
  const w = mountPage()
  await flushPromises()
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(1)
  const rows = w.findAll('[data-testid="session-row"]')
  expect(rows).toHaveLength(2)
  expect(rows[0].text()).toContain('1.2.3.4')
  expect(w.text()).toContain('Chrome')
  w.unmount()
})

test('displayName 就地编辑:保存调 updateMe 并回写 authStore', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="profile-displayname-input"]').setValue('阿亮')
  await w.find('[data-testid="profile-displayname-save"]').trigger('click')
  await flushPromises()
  expect(apiMocks.updateMe).toHaveBeenCalledWith({ displayName: '阿亮' })
  expect(useAuthStore().user.displayName).toBe('阿亮')
  w.unmount()
})

test('改密:两次新密不一致 → 客户端拒绝不发请求', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="pwd-current"]').setValue('right-password')
  await w.find('[data-testid="pwd-new"]').setValue('newpassword1')
  await w.find('[data-testid="pwd-confirm"]').setValue('newpassword2')
  await w.find('[data-testid="pwd-submit"]').trigger('click')
  expect(apiMocks.changePassword).not.toHaveBeenCalled()
  w.unmount()
})

test('改密:新密 <8 → 客户端拒绝;通过则调 API + 成功清表单', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="pwd-current"]').setValue('right-password')
  await w.find('[data-testid="pwd-new"]').setValue('short')
  await w.find('[data-testid="pwd-confirm"]').setValue('short')
  await w.find('[data-testid="pwd-submit"]').trigger('click')
  expect(apiMocks.changePassword).not.toHaveBeenCalled()

  apiMocks.changePassword.mockResolvedValueOnce({ ok: true, revoked: 1 })
  await w.find('[data-testid="pwd-current"]').setValue('right-password')
  await w.find('[data-testid="pwd-new"]').setValue('newpassword1')
  await w.find('[data-testid="pwd-confirm"]').setValue('newpassword1')
  await w.find('[data-testid="pwd-submit"]').trigger('click')
  await flushPromises()
  expect(apiMocks.changePassword).toHaveBeenCalledWith('right-password', 'newpassword1')
  expect(w.find('[data-testid="pwd-new"]').element.value).toBe('')
  w.unmount()
})

test('吊销单会话:走 ConfirmDialog,确认后调 revokeSession 并刷新列表', async () => {
  const w = mountPage()
  await flushPromises()
  apiMocks.revokeSession.mockResolvedValueOnce({ ok: true })
  await w.find('[data-testid="session-revoke-beef5678"]').trigger('click')
  expect(apiMocks.revokeSession).not.toHaveBeenCalled()
  document.body.querySelector('[data-testid="confirm-ok"]').click()
  await flushPromises()
  expect(apiMocks.revokeSession).toHaveBeenCalledWith('beef5678')
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(2)
  w.unmount()
})

test('当前会话行不渲染吊销按钮(防自锁)', async () => {
  const w = mountPage()
  await flushPromises()
  expect(w.find('[data-testid="session-revoke-abcd1234"]').exists()).toBe(false)
  expect(w.find('[data-testid="sessions-revoke-others"]').exists()).toBe(true)
  w.unmount()
})

test('偏好卡:语言/主题选择联动 preferences store', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="pref-lang-en"]').trigger('click')
  await w.find('[data-testid="pref-theme-dark"]').trigger('click')
  const prefs = usePreferencesStore()
  expect(prefs.language).toBe('en')
  expect(prefs.theme).toBe('dark')
  w.unmount()
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/UserProfile.test.js`
Expected: FAIL(组件不存在)

- [ ] **Step 5: 实现** `src/views/UserProfile.vue`

```vue
<script setup>
// 用户中心(2026-08-29 用户中心设计 §2.3):资料/安全/偏好三卡。平台层页面
// (requiresCluster:false,无集群也能进);仅头像菜单进入,侧边栏不加入口。
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { usePreferencesStore } from '@/stores/preferences'
import { notify } from '@/composables/useToast'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { uaSummary } from '@/utils/uaSummary'

const { t } = useI18n()
const authStore = useAuthStore()
const prefs = usePreferencesStore()

const user = computed(() => authStore.user || {})
const createdAtText = computed(() => (user.value.createdAt ? new Date(user.value.createdAt).toLocaleDateString() : '—'))
const initial = computed(() => (user.value.displayName || user.value.username || 'U').charAt(0).toUpperCase())

// === 资料卡 ===
const displayName = ref('')
const savingName = ref(false)
onMounted(() => { displayName.value = user.value.displayName || ''; loadSessions() })
async function saveDisplayName() {
  savingName.value = true
  try {
    const res = await authApi.updateMe({ displayName: displayName.value })
    authStore.user = { ...authStore.user, ...res.user }
    notify('success', t('userCenter.profileSaved'))
  } catch (e) { notify('error', e.message || t('common.opFailed')) }
  finally { savingName.value = false }
}

// === 安全卡:改密 ===
const pwdForm = ref({ current: '', next: '', confirm: '' })
const pwdErrors = ref({})
const pwdLoading = ref(false)
async function changePassword() {
  const errs = {}
  if (!pwdForm.value.current) errs.current = true
  if (!pwdForm.value.next || pwdForm.value.next.length < 8) errs.next = true
  if (pwdForm.value.next !== pwdForm.value.confirm) errs.confirm = true
  pwdErrors.value = errs
  if (Object.keys(errs).length) return
  pwdLoading.value = true
  try {
    const res = await authApi.changePassword(pwdForm.value.current, pwdForm.value.next)
    pwdForm.value = { current: '', next: '', confirm: '' }
    notify('success', t('userCenter.passwordChanged', { n: res.revoked ?? 0 }))
  } catch (e) { notify('error', e.message || t('common.opFailed')) }
  finally { pwdLoading.value = false }
}

// === 安全卡:会话 ===
const sessions = ref([])
const sessionsLoading = ref(false)
const revokeTarget = ref(null)          // {fingerprint} 或 'others'
const showRevokeConfirm = ref(false)
async function loadSessions() {
  sessionsLoading.value = true
  try { sessions.value = (await authApi.listSessions()).sessions || [] }
  catch { /* 会话列表失败不阻塞页面 */ }
  finally { sessionsLoading.value = false }
}
function askRevoke(s) { revokeTarget.value = s; showRevokeConfirm.value = true }
function askRevokeOthers() { revokeTarget.value = { fingerprint: 'others' }; showRevokeConfirm.value = true }
async function doRevoke() {
  const target = revokeTarget.value
  showRevokeConfirm.value = false
  if (!target) return
  try {
    if (target.fingerprint === 'others') await authApi.revokeOtherSessions()
    else await authApi.revokeSession(target.fingerprint)
    notify('success', t('common.success'))
    loadSessions()
  } catch (e) { notify('error', e.message || t('common.opFailed')) }
}
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '—' }

// === 偏好卡 ===
const langOptions = [{ v: 'zh', key: 'userCenter.langZh' }, { v: 'en', key: 'userCenter.langEn' }]
const themeOptions = [{ v: 'light', icon: 'light_mode', key: 'userCenter.themeLight' }, { v: 'dark', icon: 'dark_mode', key: 'userCenter.themeDark' }, { v: 'system', icon: 'contrast', key: 'userCenter.themeSystem' }]
</script>

<template>
  <section class="animate-fade-in p-md max-w-3xl mx-auto flex flex-col gap-md">
    <div><h2 class="text-headline-lg font-bold text-on-surface">{{ $t('userCenter.title') }}</h2>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('userCenter.subtitle') }}</p></div>

    <!-- 资料卡 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
      <div class="flex items-center gap-md mb-md">
        <div class="w-14 h-14 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-headline-lg font-bold">{{ initial }}</div>
        <div class="min-w-0">
          <div class="flex items-center gap-sm">
            <p class="text-body-lg font-semibold truncate">{{ user.displayName || user.username }}</p>
            <span class="px-1.5 py-0.5 rounded text-body-xs font-medium" :class="user.role === 'admin' ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant'">{{ user.role }}</span>
          </div>
          <p class="text-body-sm text-on-surface-variant font-mono">{{ user.username }} · {{ $t('userCenter.joinedAt', { date: createdAtText }) }}</p>
        </div>
      </div>
      <div class="flex items-end gap-sm">
        <div class="flex-1">
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.displayName') }}</label>
          <input v-model="displayName" data-testid="profile-displayname-input" maxlength="64"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
        </div>
        <button data-testid="profile-displayname-save" :disabled="savingName"
          class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm disabled:opacity-50 shrink-0"
          @click="saveDisplayName">{{ $t('common.save') }}</button>
      </div>
    </div>

    <!-- 安全卡 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
      <h3 class="text-headline-sm font-bold mb-md">{{ $t('userCenter.securityTitle') }}</h3>
      <div class="grid gap-md sm:grid-cols-3">
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.currentPassword') }}</label>
          <input v-model="pwdForm.current" data-testid="pwd-current" type="password" autocomplete="current-password"
            :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm', pwdErrors.current ? 'border-error' : 'border-outline-variant']" />
        </div>
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.newPassword') }}</label>
          <input v-model="pwdForm.next" data-testid="pwd-new" type="password" autocomplete="new-password"
            :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm', pwdErrors.next ? 'border-error' : 'border-outline-variant']" />
          <p v-if="pwdErrors.next" class="text-body-xs text-error mt-xs">{{ $t('userCenter.passwordMinHint') }}</p>
        </div>
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.confirmPassword') }}</label>
          <input v-model="pwdForm.confirm" data-testid="pwd-confirm" type="password" autocomplete="new-password"
            :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm', pwdErrors.confirm ? 'border-error' : 'border-outline-variant']" />
          <p v-if="pwdErrors.confirm" class="text-body-xs text-error mt-xs">{{ $t('userCenter.passwordMismatch') }}</p>
        </div>
      </div>
      <button data-testid="pwd-submit" :disabled="pwdLoading"
        class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm disabled:opacity-50"
        @click="changePassword">{{ $t('userCenter.changePassword') }}</button>

      <div class="flex items-center justify-between mt-lg mb-sm">
        <h4 class="text-body-md font-semibold">{{ $t('userCenter.sessionsTitle') }}</h4>
        <button data-testid="sessions-revoke-others" class="text-body-sm text-error hover:underline" @click="askRevokeOthers">{{ $t('userCenter.revokeOthers') }}</button>
      </div>
      <div v-if="sessionsLoading" class="py-md text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block">progress_activity</span></div>
      <div v-else class="flex flex-col gap-xs">
        <div v-for="s in sessions" :key="s.fingerprint" data-testid="session-row"
          class="flex items-center gap-md px-md py-sm rounded-lg border border-outline-variant/50">
          <span class="material-symbols-outlined text-on-surface-variant" :class="s.current ? 'text-primary' : ''">{{ s.current ? 'phonelink_ring' : 'devices_other' }}</span>
          <div class="min-w-0 flex-1">
            <p class="text-body-sm font-medium truncate">{{ uaSummary(s.userAgent) }}<span v-if="s.current" class="ml-sm px-1 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold">{{ $t('userCenter.currentSession') }}</span></p>
            <p class="text-body-xs text-on-surface-variant truncate">{{ s.ip || '—' }} · {{ $t('userCenter.lastActive', { time: fmtTime(s.lastSeenAt) }) }}</p>
          </div>
          <button v-if="!s.current" :data-testid="`session-revoke-${s.fingerprint}`"
            class="p-1 rounded text-on-surface-variant hover:text-error hover:bg-error/10" :title="$t('userCenter.revoke')"
            @click="askRevoke(s)"><span class="material-symbols-outlined text-base">logout</span></button>
        </div>
      </div>
    </div>

    <!-- 偏好卡 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
      <h3 class="text-headline-sm font-bold mb-md">{{ $t('userCenter.preferencesTitle') }}</h3>
      <div class="grid gap-md sm:grid-cols-2">
        <div>
          <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.language') }}</p>
          <div class="flex gap-xs">
            <button v-for="o in langOptions" :key="o.v" :data-testid="`pref-lang-${o.v}`"
              class="px-md py-sm rounded-lg border text-body-sm"
              :class="prefs.language === o.v ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant'"
              @click="prefs.setLanguage(o.v)">{{ $t(o.key) }}</button>
          </div>
        </div>
        <div>
          <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.theme') }}</p>
          <div class="flex gap-xs">
            <button v-for="o in themeOptions" :key="o.v" :data-testid="`pref-theme-${o.v}`"
              class="flex items-center gap-xs px-md py-sm rounded-lg border text-body-sm"
              :class="prefs.theme === o.v ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant'"
              @click="prefs.setTheme(o.v)">
              <span class="material-symbols-outlined text-base">{{ o.icon }}</span>{{ $t(o.key) }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog v-model="showRevokeConfirm" danger
      :title="$t('userCenter.revokeConfirmTitle')"
      :message="$t('userCenter.revokeConfirmMessage')"
      @confirm="doRevoke" />
  </section>
</template>
```

- [ ] **Step 6: 路由 + i18n** —— `src/router/index.js` `// === 平台管理(admin only)===` 注释前插入:

```js
      // === 个人中心(所有登录用户;平台层页面,不依赖集群)===
      {
        path: 'profile',
        name: 'UserProfile',
        component: () => import('@/views/UserProfile.vue'),
        meta: { titleKey: 'route.profile', icon: 'person', scope: 'global', requiresCluster: false }
      },
```

`zh.json`:`userCenter` 段补齐(Task 7 已有 logoutConfirmTitle/Message):

```json
"userCenter": {
  "title": "个人中心",
  "subtitle": "管理你的资料、安全与会话",
  "logoutConfirmTitle": "退出登录",
  "logoutConfirmMessage": "确定要退出当前账号吗?未提交的编辑与进行中的终端会话将中断。",
  "profileSaved": "资料已更新",
  "displayName": "显示名称",
  "joinedAt": "注册于 {date}",
  "securityTitle": "安全",
  "currentPassword": "当前密码",
  "newPassword": "新密码",
  "confirmPassword": "确认新密码",
  "passwordMinHint": "至少 8 位",
  "passwordMismatch": "两次输入的新密码不一致",
  "changePassword": "修改密码",
  "passwordChanged": "密码已修改,其他 {n} 个会话已退出",
  "sessionsTitle": "活跃会话",
  "revokeOthers": "退出其他所有设备",
  "revoke": "吊销此会话",
  "revokeConfirmTitle": "退出该设备?",
  "revokeConfirmMessage": "该设备将被登出,需重新登录才能继续操作。",
  "currentSession": "当前",
  "lastActive": "最近活跃 {time}",
  "preferencesTitle": "偏好设置",
  "language": "界面语言",
  "theme": "主题外观",
  "langZh": "中文",
  "langEn": "English",
  "themeLight": "浅色",
  "themeDark": "深色",
  "themeSystem": "跟随系统"
},
```

`en.json` 同键英文对齐(title: "User Center", subtitle: "Manage your profile, security and sessions", logoutConfirmTitle: "Sign out", logoutConfirmMessage: "Sign out of this account? Unsaved edits and active terminal sessions will be interrupted.", profileSaved: "Profile updated", displayName: "Display name", joinedAt: "Joined {date}", securityTitle: "Security", currentPassword: "Current password", newPassword: "New password", confirmPassword: "Confirm new password", passwordMinHint: "At least 8 characters", passwordMismatch: "New passwords do not match", changePassword: "Change password", passwordChanged: "Password changed; {n} other session(s) signed out", sessionsTitle: "Active sessions", revokeOthers: "Sign out all other devices", revoke: "Revoke session", revokeConfirmTitle: "Sign out this device?", revokeConfirmMessage: "That device will be signed out and must sign in again to continue.", currentSession: "Current", lastActive: "Last active {time}", preferencesTitle: "Preferences", language: "Language", theme: "Theme", langZh: "中文", langEn: "English", themeLight: "Light", themeDark: "Dark", themeSystem: "System")。

- [ ] **Step 7: 跑测试确认通过 + 门禁**

Run: `npx vitest run src/views/__tests__/UserProfile.test.js src/utils/__tests__/uaSummary.test.js && npm run i18n:check && npm run typecheck`
Expected: 全 pass;门禁过

- [ ] **Step 8: Commit**

```bash
git add src/views/UserProfile.vue src/views/__tests__/UserProfile.test.js src/utils/uaSummary.js src/utils/__tests__/uaSummary.test.js src/router/index.js src/locales/en.json src/locales/zh.json
git commit -m "feat(profile): 用户中心页三卡(资料/安全/偏好)+ /profile 路由——自助改密、会话吊销、偏好切换"
```

---

## 工作流 2:暗色主题系统(Task 9-13)

### Task 9: md-palette.js 暗色板 + RGB 三元组注入

**Files:**
- Modify: `src/styles/md-palette.js`(DARK_PALETTE + hexToRgbTriplet + paletteVarsCss 双块)
- Test: `src/styles/__tests__/md-palette.test.js`

**Interfaces:**
- Consumes: 无(纯数据模块,保持 node 侧可 import——tailwind.config 引它,**不得 import vue**)。
- Produces: `MD_PALETTE`(不变)、`DARK_PALETTE`(与 MD_PALETTE 键集完全一致)、`hexToRgbTriplet('#rrggbb') => 'R G B'`、`paletteVarsCss() => ':root{…}.dark{…}'`(值从 hex 变三元组!)。Task 10/11 消费。**既有 `var(--md-sys-color-x, #hex)` 直用方将在 Task 11 改写,本 Task 只动注入端**。

- [ ] **Step 1: 写失败测试** `src/styles/__tests__/md-palette.test.js`

```js
// 暗色板键集必须与亮色板逐键对齐(缺键 = 暗色下某 token 回落亮色值,视觉穿帮)。
import { test, expect } from 'vitest'
import { MD_PALETTE, DARK_PALETTE, hexToRgbTriplet, paletteVarsCss } from '../md-palette'

test('DARK_PALETTE 与 MD_PALETTE 键集逐一对齐', () => {
  expect(Object.keys(DARK_PALETTE).sort()).toEqual(Object.keys(MD_PALETTE).sort())
  for (const [k, v] of Object.entries(DARK_PALETTE)) expect(v, `key ${k}`).toMatch(/^#[0-9a-f]{6}$/i)
})

test('hexToRgbTriplet:hex → 空格三元组;非法输入回 0 0 0', () => {
  expect(hexToRgbTriplet('#006c49')).toBe('0 108 73')
  expect(hexToRgbTriplet('#ffffff')).toBe('255 255 255')
  expect(hexToRgbTriplet('ba1a1a')).toBe('186 26 26')
  expect(hexToRgbTriplet('nope')).toBe('0 0 0')
  expect(hexToRgbTriplet(undefined)).toBe('0 0 0')
})

test('paletteVarsCss::root 注入亮色三元组,.dark 注入暗色覆盖', () => {
  const css = paletteVarsCss()
  expect(css).toContain(':root{--md-sys-color-surface:248 249 255;')
  expect(css).toContain('.dark{--md-sys-color-surface:17 20 24;')
  expect(css).not.toContain('#006c49', '三元组化后不再有裸 hex')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/styles/__tests__/md-palette.test.js`
Expected: FAIL(DARK_PALETTE/hexToRgbTriplet 不存在;paletteVarsCss 还是 hex)

- [ ] **Step 3: 实现** —— `src/styles/md-palette.js` 追加/替换:

(a) `MD_PALETTE` 对象后追加 `DARK_PALETTE`(键序与亮色一致;值按 MD3 暗色 tonal 规则从亮板同族推导——surface 系深灰阶、primary 取亮板 primary-fixed-dim(#4edea3)为 dark-primary、fixed 色两主题同值):

```js
// MD3 暗色板(2026-08-29 用户中心设计 §3.1):键集与亮色严格对齐;primary-80 沿用亮板
// primary-fixed-dim,fixed 色族两主题同值(MD3 规范:fixed 色不随主题翻转)。
export const DARK_PALETTE = {
  'surface': '#111418',
  'surface-dim': '#111418',
  'surface-bright': '#37393e',
  'surface-container-lowest': '#0c0e13',
  'surface-container-low': '#191c20',
  'surface-container': '#1d2025',
  'surface-container-high': '#282a2f',
  'surface-container-highest': '#33353a',
  'on-surface': '#e2e2e9',
  'on-surface-variant': '#c0c9c4',
  'inverse-surface': '#e2e2e9',
  'inverse-on-surface': '#2e3036',
  'outline': '#8a938f',
  'outline-variant': '#3f4844',
  'surface-tint': '#4edea3',
  'primary': '#4edea3',
  'on-primary': '#003922',
  'primary-container': '#005236',
  'on-primary-container': '#6ffbbe',
  'inverse-primary': '#006c49',
  'primary-fixed': '#6ffbbe',
  'primary-fixed-dim': '#4edea3',
  'on-primary-fixed': '#002113',
  'on-primary-fixed-variant': '#005236',
  'secondary': '#c0c1ff',
  'on-secondary': '#131478',
  'secondary-container': '#2f2ebe',
  'on-secondary-container': '#e1e0ff',
  'secondary-fixed': '#e1e0ff',
  'secondary-fixed-dim': '#c0c1ff',
  'on-secondary-fixed': '#07006c',
  'on-secondary-fixed-variant': '#2f2ebe',
  'tertiary': '#ffb95f',
  'on-tertiary': '#462900',
  'tertiary-container': '#653e00',
  'on-tertiary-container': '#ffddb8',
  'tertiary-fixed': '#ffddb8',
  'tertiary-fixed-dim': '#ffb95f',
  'on-tertiary-fixed': '#2a1700',
  'on-tertiary-fixed-variant': '#653e00',
  'error': '#ffb4ab',
  'on-error': '#690005',
  'error-container': '#93000a',
  'on-error-container': '#ffdad6',
  'status-running': '#34d399',
  'status-pending': '#fbbf24',
  'status-failed': '#f87171',
  'status-succeeded': '#60a5fa',
  'status-unknown': '#9ca3af',
}
```

(b) `paletteVarsCss` 替换 + 新增 hexToRgbTriplet(注释同步改:值已三元组化,直用方须 `rgb(var(...))` 包裹):

```js
// hex → 'R G B' 空格三元组(供 rgb(var(--x) / <alpha-value>) 消费;非法回落 0 0 0)
export function hexToRgbTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return '0 0 0'
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

// 生成 ':root{亮色三元组}.dark{暗色三元组}'(全 token 注入;html.dark 挂类即整体翻转)
export function paletteVarsCss() {
  const block = p => Object.entries(p).map(([k, v]) => `--md-sys-color-${k}:${hexToRgbTriplet(v)};`).join('')
  return `:root{${block(MD_PALETTE)}}.dark{${block(DARK_PALETTE)}}`
}
```

(c) `tokenHex(token)` 保持签名不变(亮板 hex;Task 11 里 JS 消费方改用 theme.js 的响应式版)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/styles/__tests__/md-palette.test.js`
Expected: 3 pass

- [ ] **Step 5: Commit**

```bash
git add src/styles/md-palette.js src/styles/__tests__/md-palette.test.js
git commit -m "feat(theme): MD3 暗色板 + 调色板 RGB 三元组化注入(:root 亮/.dark 暗,键集对齐守护测试)"
```

---

### Task 10: theme.js 响应式主题模块 + 首帧防白闪

**Files:**
- Create: `src/styles/theme.js`
- Modify: `src/main.js`(`installPaletteVars()` 调用改 `initTheme()`)
- Modify: `index.html`(head 内联防白闪脚本)
- Test: `src/styles/__tests__/theme.test.js`

**Interfaces:**
- Consumes: Task 9 `DARK_PALETTE`/`installPaletteVars`。
- Produces: `themeMode` ref(`'light'|'dark'|'system'`)、`isDark` computed、`activePalette` computed、`tokenHexR(token)`(响应式取色,Task 11/12 图表消费)、`applyThemeMode(mode)`、`initTheme(doc?)`。**执行顺序约束**:Task 5(preferences store)import 了本模块的 `applyThemeMode`,故本 Task 必须先于 Task 5 执行(theme.js 只依赖 Task 9,无依赖环)。按文末推荐顺序 1→2→3→4→9→10→5→… 执行即满足。

- [ ] **Step 1: 写失败测试** `src/styles/__tests__/theme.test.js`

```js
// happy-dom 提供 matchMedia;防御性:无 matchMedia 环境按 light 处理。
import { test, expect, beforeEach } from 'vitest'
import { themeMode, isDark, activePalette, tokenHexR, applyThemeMode, initTheme } from '../theme'
import { MD_PALETTE, DARK_PALETTE } from '../md-palette'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  applyThemeMode('system')
  initTheme(document)
})

test('默认 system;亮色系统下 isDark=false,activePalette=亮板', () => {
  expect(themeMode.value).toBe('system')
  expect(activePalette.value).toBe(MD_PALETTE)
})

test('applyThemeMode(dark):isDark=true + html.dark + activePalette=暗板 + tokenHexR 走暗板', () => {
  applyThemeMode('dark')
  expect(isDark.value).toBe(true)
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(activePalette.value).toBe(DARK_PALETTE)
  expect(tokenHexR('primary')).toBe(DARK_PALETTE.primary)
})

test('applyThemeMode(light):显式亮色,即使系统偏好暗', () => {
  applyThemeMode('light')
  expect(isDark.value).toBe(false)
  expect(document.documentElement.classList.contains('dark')).toBe(false)
})

test('initTheme:从 localStorage 恢复 dark', () => {
  localStorage.setItem('aliangboard.theme', 'dark')
  applyThemeMode('system')
  initTheme(document)
  expect(themeMode.value).toBe('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
})

test('localStorage 坏值按 system 处理', () => {
  localStorage.setItem('aliangboard.theme', 'purple')
  initTheme(document)
  expect(themeMode.value).toBe('system')
})

test('tokenHexR:未知 token 回落当前板 primary', () => {
  applyThemeMode('dark')
  expect(tokenHexR('no-such-token')).toBe(DARK_PALETTE.primary)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/styles/__tests__/theme.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `src/styles/theme.js`

```js
// 主题运行时(2026-08-29 用户中心设计 §3.1):reactive 主题态 + 色板翻转。
// md-palette.js 保持纯数据(tailwind.config 在 node 侧 import 它,不能引 vue);
// 本模块是浏览器侧唯一入口,图表/组件统一从 activePalette/tokenHexR 取当前板 hex。
import { ref, computed } from 'vue'
import { MD_PALETTE, DARK_PALETTE, installPaletteVars } from './md-palette.js'

const THEME_KEY = 'aliangboard.theme'

export const themeMode = ref('system')        // 'light' | 'dark' | 'system'
export const systemPrefersDark = ref(false)

export const isDark = computed(() =>
  themeMode.value === 'dark' || (themeMode.value === 'system' && systemPrefersDark.value))
export const activePalette = computed(() => (isDark.value ? DARK_PALETTE : MD_PALETTE))
// 响应式取色:模板/computed 内调用,主题翻转自动触发重渲(图表重算)
export function tokenHexR(token) {
  const p = activePalette.value
  return p[token] || p.primary
}

function syncClass(doc) {
  doc.documentElement.classList.toggle('dark', isDark.value)
}

// 切模式:非法值归 system。偏好 store(setTheme)与测试均走这里。
export function applyThemeMode(mode) {
  themeMode.value = mode === 'dark' || mode === 'light' ? mode : 'system'
  if (typeof document !== 'undefined') syncClass(document)
}

// 启动初始化(main.js 调):注入双板 CSS 变量 + 读 localStorage 恢复 + 监听系统偏好。
export function initTheme(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc) return
  installPaletteVars(doc)
  let saved = 'system'
  try { saved = localStorage.getItem(THEME_KEY) || 'system' } catch { /* 无 storage */ }
  themeMode.value = saved === 'dark' || saved === 'light' ? saved : 'system'
  const mq = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')
  if (mq) {
    systemPrefersDark.value = !!mq.matches
    // system 态联动;addEventListener 不存在(旧实现)时静默降级为启动时快照
    mq.addEventListener?.('change', e => { systemPrefersDark.value = e.matches; syncClass(doc) })
  }
  syncClass(doc)
}
```

- [ ] **Step 4: main.js 接线** —— `src/main.js:17` `installPaletteVars()` 改为:

```js
import { initTheme } from './styles/theme'
initTheme()   // 注入亮/暗双板 CSS 变量 + 恢复主题(localStorage 兜底)+ 挂系统偏好监听
```

(原 `installPaletteVars` import 删除;theme.js 内部已调 installPaletteVars。)

- [ ] **Step 5: index.html 防白闪** —— `<head>` 内、`<title>` 前加:

```html
    <!-- 首帧防白闪:CSS 加载前按偏好挂 dark 类(localStorage 兜底,system 跟随系统)。
         与 src/styles/theme.js 的 THEME_KEY 保持一致(aliangboard.theme)。 -->
    <script>
      (function () {
        try {
          var t = localStorage.getItem('aliangboard.theme') || 'system'
          var dark = t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
          if (dark) document.documentElement.classList.add('dark')
        } catch (e) { /* 无 storage/matchMedia 环境 */ }
      })()
    </script>
```

- [ ] **Step 6: 跑测试确认通过 + 构建健全**

Run: `npx vitest run src/styles/__tests__/theme.test.js && npm run build`
Expected: 6 pass;build 过(此时代码块 hex 主题不变,亮色视觉应与改前一致——暗色类挂了也无碍,因 tailwind 色还是静态 hex,Task 11 才翻转)

- [ ] **Step 7: Commit**

```bash
git add src/styles/theme.js src/styles/__tests__/theme.test.js src/main.js index.html
git commit -m "feat(theme): 响应式主题模块(三态/系统偏好联动/响应式取色)+ index.html 首帧防白闪"
```

---

### Task 11: tailwind 色值接线 + CSS var 直用方改写(亮色像素不变的等价改造)

**Files:**
- Modify: `tailwind.config.js:13-15`(colors 展开改 var 三元组)
- Modify: `src/styles/main.css`、`src/components/common/DataTable.vue`、`src/components/common/ColumnManager.vue`、`src/views/admin/ApiKeyManagement.vue`(全部 `var(--md-sys-color-*)` 直用 → `rgb(var(...))` 包裹;共 14 处)
- Test: `src/styles/__tests__/md-palette.test.js` 追加快照守卫

**Interfaces:**
- Consumes: Task 9 的三元组变量。
- Produces: 全站 `bg-surface`/`text-primary`/`bg-primary/10` 等工具类全部经 CSS 变量取色;`html.dark` 挂类即整站翻转。**验收口径:亮色下渲染结果与改前逐像素等价**(同一变量同值,只是经 rgb() 中转)。

- [ ] **Step 1: tailwind colors 改造** —— `tailwind.config.js` 顶部 import 区加 `import { codeTheme } from './src/styles/code-theme.js'`(已有则跳过);colors 块的 `...MD_PALETTE,` 替换为:

```js
        // MD3 全套色板唯一来源:src/styles/md-palette.js —— 三元组化后经 CSS 变量取色,
        // <alpha-value> 保住全站 bg-primary/10 类透明度写法;html.dark 挂类即整站翻转。
        ...Object.fromEntries(Object.keys(MD_PALETTE).map(k => [k, `rgb(var(--md-sys-color-${k}) / <alpha-value>)`])),
```

(`MD_PALETTE` import 保留——仍用于枚举键名。)

- [ ] **Step 2: CSS var 直用方全量改写** —— 规则(两种形态):

- `var(--md-sys-color-x)` → `rgb(var(--md-sys-color-x))`
- `var(--md-sys-color-x, #rrggbb)` → `rgb(var(--md-sys-color-x, R G B))`(fallback 也必须三元组,如 `#0b1c30` → `11 28 48`)

Run: `grep -rn "var(--md-sys-color" src/styles/main.css src/components/common/DataTable.vue src/components/common/ColumnManager.vue src/views/admin/ApiKeyManagement.vue`
对输出 14 处逐一按上述规则改写(例如 main.css:99 `color: var(--md-sys-color-on-surface, #0b1c30)` → `color: rgb(var(--md-sys-color-on-surface, 11 28 48))`)。**改完再 grep 一次,确认 0 处残留裸 `var(--md-sys-color`。**

- [ ] **Step 3: 追加快照守卫测试** —— `src/styles/__tests__/md-palette.test.js` 追加:

```js
test('亮板关键 token 的三元组值锁定(防手滑改错导致亮色视觉漂移)', () => {
  expect(hexToRgbTriplet(MD_PALETTE.primary)).toBe('0 108 73')
  expect(hexToRgbTriplet(MD_PALETTE.surface)).toBe('248 249 255')
  expect(hexToRgbTriplet(DARK_PALETTE.surface)).toBe('17 20 24')
})
```

- [ ] **Step 4: 构建验证**

Run: `npm run build && npm run i18n:check`
Expected: build 过、无新告警;i18n 门禁过

- [ ] **Step 5: 手工验证等价性(实施者浏览器自检,不作为自动测试)**

`npm run dev` 打开:集群概览/任一列表页/工作台,确认亮色观感与改前一致;DevTools 切 `html.dark` 类,确认整站翻转为深色(此时 preferences 里 theme=dark 也会自动挂类)。记录异常点(如有)到提交信息。

- [ ] **Step 6: Commit**

```bash
git add tailwind.config.js src/styles/main.css src/components/common/DataTable.vue src/components/common/ColumnManager.vue src/views/admin/ApiKeyManagement.vue src/styles/__tests__/md-palette.test.js
git commit -m "feat(theme): tailwind 色值接线 CSS 变量(<alpha-value> 保透明度语法)+ 14 处 var 直用方 rgb() 包裹——亮色等价改造"
```

---

### Task 12: 图表与组件主题响应化

**Files:**
- Modify: `src/lib/echarts.js`(主题构建抽函数,注册 md3/md3-dark 双主题)
- Modify: `src/lib/chart-options.js`(MD_PALETTE/tokenHex → tokenHexR)
- Modify: `src/components/common/EChart.vue`(isDark watch 重渲)
- Modify: `src/components/common/StatusSummaryCard.vue`、`src/components/common/ProgressBar.vue`、`src/components/common/AreaLineChart.vue`(tokenHex → tokenHexR,先 grep 确认各自用法)
- Test: `src/lib/__tests__/chart-theme.test.js`(若 `src/lib/__tests__/` 不存在则创建)

**Interfaces:**
- Consumes: Task 10 `tokenHexR/isDark`。
- Produces: 图表在主题切换时自动换色重渲;`chart-options.js` 各 builder(经视图层 computed 调用)读响应式板,数据/主题任一变化即产出新 option。

- [ ] **Step 1: 摸清消费面** —— Run:
`grep -n "MD_PALETTE\|tokenHex" src/lib/chart-options.js src/components/common/StatusSummaryCard.vue src/components/common/ProgressBar.vue src/components/common/AreaLineChart.vue`
列出每处(约 15-20 处),逐一按 Step 3/4 规则替换。

- [ ] **Step 2: 写失败测试** `src/lib/__tests__/chart-theme.test.js`

```js
// 图表主题响应化:builder 输出随 activePalette 翻转;双主题注册存在。
import { test, expect } from 'vitest'
import { applyThemeMode } from '@/styles/theme'
import { MD_PALETTE, DARK_PALETTE } from '@/styles/md-palette'
import { buildEchartsTheme } from '@/lib/echarts'

test('buildEchartsTheme:亮/暗两板产出不同 tooltip 底色', () => {
  const light = buildEchartsTheme(MD_PALETTE)
  const dark = buildEchartsTheme(DARK_PALETTE)
  expect(light.tooltip.backgroundColor).toBe(MD_PALETTE['surface-container-lowest'])
  expect(dark.tooltip.backgroundColor).toBe(DARK_PALETTE['surface-container-lowest'])
  expect(dark.color[0]).toBe(DARK_PALETTE.primary)
})

test('chart-options gauge 色阶随主题翻转', async () => {
  const { gaugeLevelColor } = await import('@/lib/chart-options')
  applyThemeMode('light')
  expect(gaugeLevelColor(90)).toBe(MD_PALETTE.error)
  applyThemeMode('dark')
  expect(gaugeLevelColor(90)).toBe(DARK_PALETTE.error)
})
```

(注:`gaugeLevelColor` 名以 chart-options.js 实际导出为准——Step 1 grep 后如函数名不同(如内联在 option 工厂里),把该逻辑抽为导出的纯函数 `gaugeLevelColor(v)` 再测,组件内改调它;这正是本 Task 的最小重构边界。)

- [ ] **Step 3: echarts.js 双主题** —— 主题对象抽工厂 + 双注册:

```js
import { MD_PALETTE, DARK_PALETTE } from '@/styles/md-palette.js'

// MD3 主题工厂:字体栈与 tailwind 一致;tooltip 走 surface-container-lowest 圆角卡片。
export function buildEchartsTheme(palette) {
  return {
    color: [palette.primary, palette.secondary, palette['tertiary-container'], palette.error],
    textStyle: {
      fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif",
      color: palette['on-surface-variant'],
    },
    tooltip: {
      backgroundColor: palette['surface-container-lowest'],
      borderColor: palette['outline-variant'],
      borderWidth: 1,
      padding: [6, 10],
      textStyle: { color: palette['on-surface'], fontSize: 12 },
      extraCssText: 'border-radius:8px;box-shadow:0 4px 12px rgba(11,28,48,.12);',
    },
    animationDuration: 600,
    animationDurationUpdate: 450,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicInOut',
  }
}

echarts.registerTheme('md3', buildEchartsTheme(MD_PALETTE))
echarts.registerTheme('md3-dark', buildEchartsTheme(DARK_PALETTE))
```

- [ ] **Step 4: chart-options.js 响应化** —— 文件头 `import { MD_PALETTE, tokenHex } from '../styles/md-palette.js'` 改为 `import { tokenHexR } from '@/styles/theme'`;文件内每一处 `MD_PALETTE['x']` / `MD_PALETTE.x` / `tokenHex(x)` 统一改 `tokenHexR('x')`。原 `gaugeLevelColor` 一类的字面色阶逻辑抽为导出纯函数:

```js
// 表盘色阶(响应式:经 tokenHexR 读当前板,主题翻转自动换色)
export function gaugeLevelColor(v) {
  const color = v == null ? tokenHexR('surface-container-high')
    : v > 80 ? tokenHexR('error')
    : v > 60 ? tokenHexR('tertiary-container')
    : tokenHexR('primary')
  return color
}
```

- [ ] **Step 5: EChart.vue 主题重渲** —— script 头加 `import { isDark } from '@/styles/theme'`;把 onMounted 主体抽成 `mountChart()` / `unmountChart()` 两个函数(init 时按当前主题选 theme 名;换 theme 名必须重建实例,不能仅 setOption),onMounted/onBeforeUnmount 与新增的主题 watch 统一走它们。替换后的 script 主体:

```js
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { echarts } from '@/lib/echarts'
import { isDark } from '@/styles/theme'

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: Number, required: true },
})
const el = ref(null)
let chart = null
let ro = null

function onWinResize() { if (chart) chart.resize() }

function mountChart() {
  if (chart || !el.value) return
  chart = echarts.init(el.value, isDark.value ? 'md3-dark' : 'md3', { renderer: 'svg' })
  chart.setOption(props.option)
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (chart) chart.resize() })
    ro.observe(el.value)
  } else {
    window.addEventListener('resize', onWinResize)
  }
}
function unmountChart() {
  if (ro) { ro.disconnect(); ro = null }
  window.removeEventListener('resize', onWinResize)
  if (chart) { chart.dispose(); chart = null }
}

onMounted(mountChart)

watch(() => props.option, (opt) => { if (chart) chart.setOption(opt) })

// 主题翻转:dispose 重建(换 theme 名必须重建实例),当前 option 原样回灌
watch(isDark, () => { unmountChart(); mountChart() })

onBeforeUnmount(unmountChart)
```

(模板部分不变。)

- [ ] **Step 6: 三个组件换 tokenHexR** —— StatusSummaryCard/ProgressBar/AreaLineChart 内 `import { tokenHex } from …` 改 `import { tokenHexR } from '@/styles/theme'`,调用点 `tokenHex(` → `tokenHexR(`(grep 确认零残留)。

- [ ] **Step 7: 跑测试确认通过 + 全量**

Run: `npx vitest run src/lib/__tests__/chart-theme.test.js && npx vitest run src/components/common && npm run test:unit`
Expected: 全 pass

- [ ] **Step 8: Commit**

```bash
git add src/lib/echarts.js src/lib/chart-options.js src/lib/__tests__/chart-theme.test.js src/components/common/EChart.vue src/components/common/StatusSummaryCard.vue src/components/common/ProgressBar.vue src/components/common/AreaLineChart.vue
git commit -m "feat(theme): 图表双主题注册 + 取色响应式(tokenHexR)——主题翻转自动重渲换色"
```

---

### Task 13: 硬编码色盘点 + 全量验收

**Files:**
- Modify: 盘点命中的模板/样式文件(逐处换语义 token;仅换「亮暗应有差异」的色,状态语义色白名单除外)
- Test: 全量 `npm test` + `npm run build` + `npm run i18n:check`

**Interfaces:**
- Consumes: 前 12 个 Task 的全部成果。
- Produces: 双主题可用的最终交付 + 手测清单执行记录(提交信息附结果摘要)。

- [ ] **Step 1: 盘点硬编码色** —— Run:

```bash
grep -rn "bg-white\|text-black\|text-white\|bg-black" src/ --include="*.vue" | grep -v __tests__
grep -rEn "#[0-9a-fA-F]{6}" src/ --include="*.vue" --include="*.css" | grep -v __tests__ | grep -v "md-palette\|code-theme"
```

对命中处分类处置:
- **白/黑背景文字**(亮暗应有差异)→ 换语义 token:`bg-white`→`bg-surface-container-lowest`、`text-black`→`text-on-surface`、`text-white`(在色块上)→ `text-on-primary`/`text-on-error` 按所在容器、`bg-black/xx` 遮罩 → `bg-on-surface/xx`。
- **品牌插图表/ECharts extraCssText 阴影里的 rgba** → 保持(阴影色亮暗通用,不属验收门槛)。
- **`code-theme.js` 与既有暗底代码主题** → 不动(设计 §3.3)。
- 拿不准的命中,列进提交信息请人复核,不擅自改语义。

- [ ] **Step 2: 全量门禁**

Run: `npm test && npm run build && npm run i18n:check && npm run typecheck`
Expected: 全绿。任何红:修到绿才算完成(服务端 node --test 全量 + vitest 全量)。

- [ ] **Step 3: 手测清单执行**(需运行环境:双终端分别 `npm run server` 与 `npm run dev`;需已配置登录账号,无集群也可测 /profile)

逐项记录通过/失败:
1. 登录后点头像 → 弹菜单(不登出);ESC/点外部关闭。
2. 菜单「退出登录」→ ConfirmDialog;取消不动;确认后回 /login。
3. /profile:改 displayName 保存 → 顶栏菜单资料卡同步刷新。
4. 改密(错旧密提示;新密<8 提示;成功提示「其他 N 个会话已退出」)。
5. 双浏览器(或无痕窗)同账号:改密后旧窗下一操作被踢回 /login,新窗正常。
6. 会话列表两行,IP/UA/时间/当前标记正确;吊销另一会话 → 对应窗被踢;「退出其他所有设备」全踢。
7. 偏好卡切 English → 全站即时英文(含网关报错消息);切回中文同理。
8. 主题切深色 → 全站翻转(含图表/表格斑马纹/toast/modal/登录页),刷新无白闪;切浅色还原;切跟随系统后改系统偏好联动。
9. 登出状态下登录页主题兜底生效(localStorage)。
10. admin 账号在 /admin/users 建密码 <8 的用户被拒。

- [ ] **Step 4: Commit(含手测结果摘要)**

```bash
git add -u   # 仅当 Step 1 有改动;逐文件确认后 add
git commit -m "feat(theme): 硬编码色盘点换语义 token + 双主题全量验收(手测清单结果见提交体)"
```

(提交体附:10 项手测逐项结果与遗留项;若无模板改动则本 Task 只产出验收记录,并入 Task 12 说明。)

---

## 任务依赖与执行顺序

```
Task 1 → Task 2 → Task 3 → Task 4          (服务端串行)
Task 9 → Task 10                            (主题地基,可与服务端并行)
Task 5 依赖 Task 2/3(响应形状)与 Task 10(applyThemeMode import)
Task 6 → Task 7 → Task 8                    (前端串行;8 依赖 5/6)
Task 11 依赖 9/10;Task 12 依赖 10/11;Task 13 收尾
```

推荐交错:1 → 2 → 3 → 4 → 9 → 10 → 5 → 6 → 7 → 8 → 11 → 12 → 13。
每个 Task 完成即提交;全部完成后跑 `npm test && npm run build` 总门禁,再走手测清单。
