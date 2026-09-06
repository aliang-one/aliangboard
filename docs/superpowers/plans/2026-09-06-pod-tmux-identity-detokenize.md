# Pod 终端 tmux 身份去 token 化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pod 持久终端的 tmux socket/session 身份从「会轮换的 K8s token」改锚到「稳定的平台 userId」,并以轮换墓碑表解 rekey 死结——根治「chip 还在,内容变成新 shell」。

**Architecture:** 纯函数签名不变仅换锚(`session.userId`,遗留会话回退 token);轮换/TTL 过期不再硬删 session 行,先落 `rotated_sessions(token,userId,rotatedAt)` 墓碑再删;`isKnownSessionToken` 接受墓碑,并新增属主校验(墓碑化后旧 token 可出示,须防猜 token 吸他人记录)。

**Tech Stack:** Node 25( node:sqlite)+ node:test(服务端)/ vitest+happy-dom(前端,本批不涉前端)。

**Spec:** `docs/superpowers/specs/2026-09-06-pod-tmux-identity-detokenize-design.md`

## Global Constraints

- 零新外部依赖(仓库宪法);服务端测试用 node:test + `node:sqlite`(`:memory:`),前端 vitest。
- 提交作者恒为 `aliang-one <aliangdone@gmail.com>`;提交信息英文;禁 `Co-Authored-By` 尾注。
- 全部开发在 worktree 分支,完成后 `--no-ff` 合回 main;门禁 = `npm run test:server` / `test:unit` / `typecheck` / `build` 四道真实退出码。
- 墓碑保留 7 天(与 SESSION_POLICY_MAX_MIN=10080、记录保留口径对齐)。
- 遗留兼容:userId 为 NULL/缺失的旧会话,锚回退 token(行为等同现状);rekey 属主校验对「双方均无 userId」放行(保持旧可迁),任一方有 userId 则必须相等。

---

### Task 1: tmux-session 锚语义文档 + 锚无关性契约测试

**Files:**
- Modify: `server/tmux-session.mjs:1-25`(hashToken/tmuxLabel/tmuxSessionName 的文档注释)
- Test: `server/tmux-session.test.mjs`(追加)

**Interfaces:**
- Consumes: 既有 `hashToken(anchor)`、`tmuxLabel(anchor)`、`tmuxSessionName(anchor, sid)`(签名不变)
- Produces: 无新接口;钉死「锚=平台 userId,确定性 + 用户间互异」契约,供 Task 3/4 换锚后回归

- [ ] **Step 1: 追加锚无关性测试(此为契约钉,预期直接绿——函数本就锚无关)**

```js
// ===== 2026-09-06 身份去 token 化(spec 2026-09-06-pod-tmux-identity-detokenize):锚=平台 userId =====
test('锚语义:同锚确定性且跨 token 上下文稳定;不同锚互异;名字内嵌 label 前缀', async () => {
  const m = await import('./tmux-session.mjs')
  // 同一 userId,无论当前 K8s token 是什么(token 不再入参)——轮换前后名不变
  assert.equal(m.tmuxLabel('user-uuid-1'), m.tmuxLabel('user-uuid-1'))
  assert.equal(m.tmuxSessionName('user-uuid-1', 'term-1'), m.tmuxSessionName('user-uuid-1', 'term-1'))
  // 不同用户互异(socket 隔离语义保持)
  assert.notEqual(m.tmuxLabel('user-uuid-1'), m.tmuxLabel('user-uuid-2'))
  assert.notEqual(m.tmuxSessionName('user-uuid-1', 'term-1'), m.tmuxSessionName('user-uuid-2', 'term-1'))
  // 名字形状:label 前缀 + '-' + sid(tracker 全局键唯一性依赖)
  assert.ok(m.tmuxSessionName('user-uuid-1', 'term-1').startsWith(m.tmuxLabel('user-uuid-1') + '-term-1'))
})
```

- [ ] **Step 2: 运行确认(预期 PASS;若 FAIL 说明函数被误改)**

Run: `node --test server/tmux-session.test.mjs`
Expected: 全 PASS(含既有 34 例)

- [ ] **Step 3: 更新 tmux-session.mjs 头注锚语义**

`tmuxLabel`/`tmuxSessionName` 的注释改为:

```js
// tmux socket label: per-user isolation. 锚 = 平台 userId(稳定 UUID,2026-09-06 去 token 化:
// token 会随 TTL/重连集群轮换,uid 不会;旧调用传 token 的写法已全部换锚,遗留回退见 index.mjs)。
export function tmuxLabel(anchor) {
  return 'ab' + hashToken(anchor)
}

// tmux session name: label + stable card id. sid = frontend terminal.id.
export function tmuxSessionName(anchor, sid) {
  return `${tmuxLabel(anchor)}-${sid}`
}
```

(原「one socket per platform user / k8s token」措辞删除 token 部分。)

- [ ] **Step 4: 运行测试 + Commit**

Run: `node --test server/tmux-session.test.mjs` → PASS

```bash
git add server/tmux-session.mjs server/tmux-session.test.mjs
git commit -m "refactor(tmux): document identity anchor as platform userId (contract pinned)"
```

---

### Task 2: window-records 墓碑/属主原语 + isKnownSessionToken 扩展

**Files:**
- Modify: `server/window-records.mjs`(isKnownSessionToken 及新增三个函数)
- Test: `server/window-records.test.mjs`(freshDb 扩 DDL + 追加用例)

**Interfaces:**
- Consumes: 既有 `isKnownSessionToken(db, token)`
- Produces(后续 Task 3/4/5 依赖,名字与签名逐字):
  - `tombstoneSession(db, token, userId, now)` — INSERT OR REPLACE rotated_sessions
  - `sessionTokenOwner(db, token)` — 返回 userId 字符串或 null(live sessions 行优先,其次墓碑行)
  - `tombstoneExpiredSessions(db, cutoff, now)` — 把 sessions 表 createdAt<cutoff 的行落墓碑(有 userId 的)
  - `purgeRotatedSessions(db, now, retentionMs)` — 删 rotatedAt < now-retentionMs 的墓碑
  - `isKnownSessionToken(db, token, now = Date.now())` — 追加第三参(默认 now),墓碑须在 7d 内;既有两参调用兼容

- [ ] **Step 1: freshDb 扩 DDL + 追加 RED 测试**

`server/window-records.test.mjs` 的 `freshDb()` 增补(在 return db 前):

```js
  try { db.exec(`ALTER TABLE sessions ADD COLUMN userId TEXT`) } catch { /* 列已存在 */ }
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, userId TEXT, createdAt INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS rotated_sessions (token TEXT PRIMARY KEY, userId TEXT NOT NULL, rotatedAt INTEGER NOT NULL)`)
```

(与 index.mjs:122 的 try-ALTER 同款;node:sqlite 的 exec 同步执行,直接 try/catch。)

追加用例(文件尾;import 行补 `tombstoneSession, sessionTokenOwner, tombstoneExpiredSessions, purgeRotatedSessions`):

```js
const DAY = 24 * 60 * 60 * 1000

test('墓碑:tombstoneSession 落表;isKnownSessionToken 接受 7 天内墓碑、拒 7 天外', () => {
  const db = freshDb()
  const now = 100 * DAY
  tombstoneSession(db, 'rot-1', 'user-1', now)
  tombstoneSession(db, 'rot-old', 'user-1', now - 8 * DAY)
  assert.equal(isKnownSessionToken(db, 'rot-1', now), true)
  assert.equal(isKnownSessionToken(db, 'rot-old', now), false)
  assert.equal(isKnownSessionToken(db, 'unknown', now), false)
})

test('sessionTokenOwner:live 行优先于墓碑;都没有 → null', () => {
  const db = freshDb()
  const now = 100 * DAY
  db.prepare('INSERT INTO sessions (token, userId, createdAt) VALUES (?,?,?)').run('live', 'user-live', now)
  tombstoneSession(db, 'rot-1', 'user-rot', now)
  assert.equal(sessionTokenOwner(db, 'live'), 'user-live')
  assert.equal(sessionTokenOwner(db, 'rot-1'), 'user-rot')
  assert.equal(sessionTokenOwner(db, 'ghost'), null)
})

test('tombstoneExpiredSessions:过期行逐行落墓碑(无 userId 的旧行跳过)后由调用方删行', () => {
  const db = freshDb()
  const now = 100 * DAY
  db.prepare('INSERT INTO sessions (token, userId, createdAt) VALUES (?,?,?)').run('exp-1', 'user-1', now - 9 * DAY)
  db.prepare('INSERT INTO sessions (token, userId, createdAt) VALUES (?,?,?)').run('exp-legacy', null, now - 9 * DAY)
  db.prepare('INSERT INTO sessions (token, userId, createdAt) VALUES (?,?,?)').run('fresh', 'user-2', now)
  tombstoneExpiredSessions(db, now - 8 * DAY, now)
  assert.equal(sessionTokenOwner(db, 'exp-1'), 'user-1')
  assert.equal(sessionTokenOwner(db, 'exp-legacy'), null)   // 旧行无 userId:不落墓碑
  assert.equal(sessionTokenOwner(db, 'fresh'), null)        // 未过期不落
})

test('purgeRotatedSessions:清 rotatedAt 早于保留窗的墓碑', () => {
  const db = freshDb()
  const now = 100 * DAY
  tombstoneSession(db, 'keep', 'u', now - 3 * DAY)
  tombstoneSession(db, 'drop', 'u', now - 9 * DAY)
  purgeRotatedSessions(db, now, 7 * DAY)
  assert.equal(sessionTokenOwner(db, 'keep'), 'u')
  assert.equal(sessionTokenOwner(db, 'drop'), null)
})
```

- [ ] **Step 2: 运行确认 RED**

Run: `node --test server/window-records.test.mjs`
Expected: 新用例 FAIL(import 缺函数)/既有用例 PASS

- [ ] **Step 3: 实现 window-records.mjs**

```js
const ROTATED_TTL_MS = 7 * 24 * 60 * 60 * 1000   // 墓碑保留:与会话策略上限/记录保留三方对齐(lifecycle O1)

// 轮换墓碑(2026-09-06 spec):轮换/TTL 过期不再裸删 session 行——先落墓碑再删,
// rekey 的 isKnownSessionToken 才能认得「刚轮换的 token」(CSO #11 当场删行曾使其恒 403)。
export function tombstoneSession(db, token, userId, now = Date.now()) {
  if (!token) return
  db.prepare('INSERT OR REPLACE INTO rotated_sessions (token, userId, rotatedAt) VALUES (?,?,?)')
    .run(String(token), userId == null ? '' : String(userId), Number(now) || Date.now())
}

// 归属解析:live sessions 行优先(带 userId 列,W2-0),其次墓碑。都无 → null。
export function sessionTokenOwner(db, token) {
  const t = String(token || '')
  if (!t) return null
  try {
    const live = db.prepare('SELECT userId FROM sessions WHERE token = ?').get(t)
    if (live) return live.userId ?? null
    const tomb = db.prepare('SELECT userId FROM rotated_sessions WHERE token = ?').get(t)
    return tomb?.userId ?? null
  } catch { return null }
}

// TTL 过期行落墓碑(有 userId 的才落;旧行 userId 为 NULL 跳过——无属主不可迁)。
// 调用方(会话清扫器)随后照常删行。
export function tombstoneExpiredSessions(db, cutoff, now = Date.now()) {
  try {
    const rows = db.prepare('SELECT token, userId FROM sessions WHERE createdAt < ?').all(cutoff)
    for (const r of rows) if (r.token && r.userId) tombstoneSession(db, r.token, r.userId, now)
  } catch { /* 表未建等:清扫器不抛 */ }
}

export function purgeRotatedSessions(db, now = Date.now(), retentionMs = ROTATED_TTL_MS) {
  try { db.prepare('DELETE FROM rotated_sessions WHERE rotatedAt < ?').run(Number(now) - retentionMs) } catch { /* noop */ }
}

export function isKnownSessionToken(db, token, now = Date.now()) {
  const t = String(token || '')
  if (!t) return false
  try {
    if (db.prepare('SELECT token FROM sessions WHERE token = ?').get(t)) return true
    const tomb = db.prepare('SELECT userId, rotatedAt FROM rotated_sessions WHERE token = ?').get(t)
    if (!tomb) return false
    return (Number(now) - tomb.rotatedAt) <= ROTATED_TTL_MS
  } catch { return false }
}
```

(原 isKnownSessionToken 的 `SELECT token FROM sessions WHERE token=?` 保留为第一分支;ROTATED_TTL_MS 常量导出与否由实现者定——Plan 不依赖其导出。)

- [ ] **Step 4: 运行确认 GREEN(既有 rekey/isKnown 用例须全绿)**

Run: `node --test server/window-records.test.mjs`
Expected: PASS(新 4 例 + 既有全绿)

- [ ] **Step 5: Commit**

```bash
git add server/window-records.mjs server/window-records.test.mjs
git commit -m "feat(window-records): rotation tombstones + token owner resolution for rekey recovery"
```

---

### Task 3: schema 建表 + 轮换/TTL 双写墓碑(index.mjs + auth.mjs)

**Files:**
- Modify: `server/index.mjs`(~219 既有 CREATE 表区;~2320 sessionSweeper)
- Modify: `server/routes/auth.mjs`(~349-353 connect-cluster 轮换)

**Interfaces:**
- Consumes: Task 2 的 `tombstoneSession / tombstoneExpiredSessions / purgeRotatedSessions`(index.mjs 顶部 import)
- Produces: `rotated_sessions` 表(boot 建表);轮换与 TTL 过期行均留墓碑

- [ ] **Step 1: index.mjs 建表(紧邻既有 `CREATE TABLE IF NOT EXISTS platform_settings` 区)**

```js
try { db.exec('CREATE TABLE IF NOT EXISTS rotated_sessions (token TEXT PRIMARY KEY, userId TEXT NOT NULL, rotatedAt INTEGER NOT NULL)') } catch { /* 已存在 */ }
```

- [ ] **Step 2: auth.mjs connect-cluster 轮换落墓碑再删**

现状(auth.mjs ~350-353):

```js
        const oldTok = ps.k8sSessionToken
        if (oldTok) { sessions.delete(oldTok); try { db.prepare('DELETE FROM sessions WHERE token=?').run(oldTok) } catch { /* noop */ } }
```

改为:

```js
        const oldTok = ps.k8sSessionToken
        if (oldTok) {
          // 轮换墓碑(2026-09-06 spec):先落 rotated_sessions 再删行,rekey 才认得刚轮换的 token
          try { tombstoneSession(db, oldTok, ps.userId, Date.now()) } catch { /* noop */ }
          sessions.delete(oldTok); try { db.prepare('DELETE FROM sessions WHERE token=?').run(oldTok) } catch { /* noop */ }
        }
```

(auth.mjs 顶部 import:`import { tombstoneSession } from '../window-records.mjs'`——注意 auth.mjs 在 `server/routes/` 下,相对路径 `../window-records.mjs`。)

- [ ] **Step 3: sessionSweeper TTL 过期落墓碑 + 墓碑 7d 清扫**

现状(index.mjs ~2320-2326):

```js
    const cutoff = Date.now() - sessionTtl
    db.prepare('DELETE FROM sessions WHERE createdAt < ?').run(cutoff)
    db.prepare('DELETE FROM platform_sessions WHERE createdAt < ?').run(cutoff)
```

改为:

```js
    const cutoff = Date.now() - sessionTtl
    tombstoneExpiredSessions(db, cutoff, Date.now())          // 先墓碑(有 userId 的过期行)再删
    db.prepare('DELETE FROM sessions WHERE createdAt < ?').run(cutoff)
    db.prepare('DELETE FROM platform_sessions WHERE createdAt < ?').run(cutoff)
    purgeRotatedSessions(db, Date.now())                      // 墓碑 7d 保留窗
```

(index.mjs 顶部 import 补 `tombstoneExpiredSessions, purgeRotatedSessions`,与 Task 2 产物同名。)

- [ ] **Step 4: 语法与既有测试**

Run: `node --check server/index.mjs && node --check server/routes/auth.mjs && node --test server/window-records.test.mjs`
Expected: 全过

- [ ] **Step 5: Commit**

```bash
git add server/index.mjs server/routes/auth.mjs
git commit -m "feat(auth): rotation tombstones (rotated_sessions) so rekey survives token rotation"
```

---

### Task 4: 身份换锚(handleExec / DELETE / sweeper / tracker)

**Files:**
- Modify: `server/index.mjs`(~909-910 handleExec;~925 tracker set;~695-711 sweeper;~2000-2009 DELETE)

**Interfaces:**
- Consumes: `tmuxLabel/tmuxSessionName`(Task 1 契约);`session.userId`(K8s session 对象,W2-0 起携带;遗留行可能缺失)
- Produces: tmux 身份全部由 `userId || token` 锚派生;tracker meta 增 `userId` 字段

- [ ] **Step 1: handleExec 换锚(~909-910)**

```js
  // 身份锚(2026-09-06 去 token 化):平台 userId 稳定,token 轮换不再撕裂 tmux 身份。
  // 遗留会话(WS2-0 前落库)无 userId → 回退 token(行为等同旧版,重连集群后自愈为新锚)。
  const identity = session.userId || token
  const label = tmuxLabel(identity)
  const sessionName = tmuxSessionName(identity, sid)
```

- [ ] **Step 2: tracker set 存 userId(~925)**

现状:

```js
      else idleTracker.set(sessionName, { token, ns: namespace, pod, container, terminalId: sid, lastActiveAt: Date.now(), attached: 1 })
```

改为(增 userId,保留 token 供审计回溯):

```js
      else idleTracker.set(sessionName, { token, userId: identity, ns: namespace, pod, container, terminalId: sid, lastActiveAt: Date.now(), attached: 1 })
```

- [ ] **Step 3: sweeper 换锚(~709-711)**

```js
          const clients = await execCapture(session, meta.ns, meta.pod, meta.container || '', tmuxListClientsCommand(tmuxLabel(meta.userId || meta.token), name, bin))
          if (String(clients?.stdout || '').trim() !== '') continue
          await execCapture(session, meta.ns, meta.pod, meta.container || '', tmuxKillCommand(tmuxLabel(meta.userId || meta.token), name, bin))
```

(同函数内 `const session = sessions.get(meta.token)` 保持不变——杀 tmux 的 exec 凭据仍用建连时的 token 上下文;token 失效时 catch 忽略=既有语义。)

- [ ] **Step 4: DELETE 路径换锚(~2000-2009)**

```js
        const identity = session.userId || token
        idleTracker.delete(tmuxSessionName(identity, id))
        if (row) {
          try {
            const { bin } = await resolveTmux(session, row.namespace, row.podName, row.container || '')
            await execCapture(session, row.namespace, row.podName, row.container || '',
              tmuxKillCommand(tmuxLabel(identity), tmuxSessionName(identity, id), bin))
          } catch { /* pod 已不在 / 无 tmux —— 忽略 */ }
        }
```

(注:重连集群+rekey 成功后,记录的归属 token 已是新 token,而 `session` 就是新 token 的会话——同锚 ✓。)

- [ ] **Step 5: 语法 + 全链路既有测试**

Run: `node --check server/index.mjs && node --test server/tmux-session.test.mjs && node --test server/ssh/terminal-handler.test.mjs`
Expected: PASS(SSH 侧不受影响)

- [ ] **Step 6: Commit**

```bash
git add server/index.mjs
git commit -m "refactor(pod-terminal): tmux identity anchored to platform userId (token rotation no longer splits sessions)"
```

---

### Task 5: rekey 属主校验

**Files:**
- Modify: `server/index.mjs`(~1960-1974 rekey 路由)
- Modify: `server/window-records.test.mjs`(sessionTokenOwner 语义已被 Task 2 覆盖;此处补路由级断言依赖的语义说明,不新增文件)

**Interfaces:**
- Consumes: Task 2 的 `sessionTokenOwner(db, token)`;`req.abSession.userId`(W2-0)

- [ ] **Step 1: rekey 路由加属主校验(~1965 后)**

```js
      if (!isKnownSessionToken(db, input.from)) {
        return sendJson(res, 403, { message: msg(req, 'api.rekeySourceUnknown') })
      }
      // 属主校验(2026-09-06 spec §3):墓碑化后旧 token 可被出示,须防「猜 token 吸收他人记录」。
      // 双方均无 userId(WS2-0 前遗留)放行=保持旧可迁;任一方有 userId 则必须相等。
      const fromOwner = sessionTokenOwner(db, input.from)
      const myId = session.userId || null
      if (fromOwner && myId && fromOwner !== myId) {
        return sendJson(res, 403, { message: msg(req, 'api.rekeySourceUnknown') })
      }
```

(index.mjs 顶部 import 补 `sessionTokenOwner`,来自 `./window-records.mjs`——查既有 import 行是否已引 isKnownSessionToken/rekeyWindowRecords,同行追加。)

- [ ] **Step 2: 既有 rekey 用例回归**

Run: `node --test server/window-records.test.mjs`(rekey 单测不涉路由属主,应全绿)
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/index.mjs
git commit -m "feat(rekey): owner check on presented token (tombstones make old tokens presentable)"
```

---

### Task 6: 全链路门禁 + 真机手测清单

**Files:**
- 无新改动;本任务 = 验收门

- [ ] **Step 1: 四道门禁(真实退出码)**

```bash
npm run test:server; echo $?
npm run test:unit; echo $?
npm run typecheck; echo $?
npm run build; echo $?
```

Expected: 全 0。注意:大负载期(并行会话各跑门禁)spawn 类用例充满噪声,失败项一律隔离复跑定性再动手。

- [ ] **Step 2: --no-ff 合回 main + dist 重建 + 网关重启提示**

- [ ] **Step 3: 真机手测清单(推送 v1.0.25 的前置)**

1. 开 Pod 终端 → 重连集群(轮换 token)→ 回到终端点恢复:shell 历史仍在(身份不再撕裂)——本设计的验收主断言
2. 同上之后任务栏 rekey 不再报 403(记录跟随迁移)
3. SSH 终端全链路回归(前几批修复):开/关/重连/强杀/新标签页
4. 刷新页面:minimized 窗口不自动建连;点 chip 恢复即连
5. K8s token 过期场景:终端引导到集群选择页(而非 shell 梯子全失败)
6. 设置→终端与会话:四阈值改值 ≤1 分钟生效
