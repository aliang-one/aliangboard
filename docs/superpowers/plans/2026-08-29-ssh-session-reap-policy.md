# SSH 会话回收策略可配置化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SSH 终端会话的自动关闭策略(三阈值:无人附着闲置/挂机踢/最长存活)做成 admin 可配置、≤60s 生效、无需重启。

**Architecture:** 纯函数策略模块(`shouldReapSession`)+ registry 增 `reapByPolicy`(替代固定阈值的 `reapIdle`)+ 60s sweep 每跳现读 `platform_settings` + `/api/admin/ssh-session-policy` GET/PUT(照 podfile-config 模式)+ Settings 页新「SSH」tab。

**Tech Stack:** 零依赖纯逻辑 + node:test(server)、vitest + @vue/test-utils(前端)。

**Spec:** `docs/superpowers/specs/2026-08-29-ssh-session-reap-policy-design.md`

## Global Constraints

- 禁止新增外部依赖(CLAUDE.md 依赖政策)
- 提交作者恒 `aliangone <aliangone@gmail.com>`;**禁止** Co-Authored-By 尾注;禁改写已推送历史
- 所有 UI 文案 zh/en 双语同步(`npm run i18n:check` 六项全 0 是门禁);服务端 WS 消息进 `server/messages/ssh.mjs` 双语表
- 新端点 `/api/admin/ssh-session-policy` 落在 ROUTE_AUTH `/api/admin/` admin 前缀内(免登记,守卫测试会验证)
- 分钟阈值合法域 **0–10080**(0=该条件禁用);全 0 = 永不自动关闭
- 时钟口径(spec §2.2,非对称,勿「统一」):detached-idle 只看 `lastActiveAt`;attached-idle 看 `max(lastActiveAt, lastOutputAt)`
- 每任务红→绿→提交;全绿标准:`npm test` + `npm run test:unit` + `npm run i18n:check` + `npm run typecheck`

---

### Task 1: 策略纯逻辑模块 `server/ssh/reap-policy.mjs`

**Files:**
- Create: `server/ssh/reap-policy.mjs`
- Test: `server/ssh/reap-policy.test.mjs`

**Interfaces:**
- Produces(后续任务依赖,签名精确):
  - `SESSION_POLICY_DEFAULT` → `{ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 }`
  - `isValidMinutes(v)` → boolean(整数 0–10080)
  - `resolvePolicy(getFn, env)` → `{ detachedIdleMin, attachedIdleMin, maxLifetimeMin }`;`getFn(key)` 读设置,`env` 即 `process.env`(识别 `SSH_IDLE_REAP_MS` ms→分钟向下取整,仅作 detached 兜底);非法落库值 console.warn 后回落
  - `shouldReapSession(session, policy, now)` → `{ reap: boolean, reason: 'detached-idle'|'attached-idle'|'max-lifetime'|null }`;session 需含 `{ createdAt, lastActiveAt, lastOutputAt, browserCount }`

- [ ] **Step 1: 写失败测试** `server/ssh/reap-policy.test.mjs`:

```js
// 会话回收策略纯逻辑(spec docs/superpowers/specs/2026-08-29-ssh-session-reap-policy-design.md):
// 表驱动钉死四条件命中/禁用/双时钟口径——尤其「无人附着不受输出续命」的防泄漏语义。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SESSION_POLICY_DEFAULT, isValidMinutes, resolvePolicy, shouldReapSession } from './reap-policy.mjs'

const min = 60000

test('默认策略:detached=10min(现状),attached/maxLifetime=0(禁用)', () => {
  assert.deepEqual(SESSION_POLICY_DEFAULT, { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 })
})

test('isValidMinutes:0–10080 整数合法;负数/小数/非数字/越界非法', () => {
  assert.equal(isValidMinutes(0), true)
  assert.equal(isValidMinutes(10080), true)
  assert.equal(isValidMinutes(-1), false)
  assert.equal(isValidMinutes(1.5), false)
  assert.equal(isValidMinutes('30'), false)
  assert.equal(isValidMinutes(10081), false)
})

test('resolvePolicy:设置值优先;无设置时 detached 走 env SSH_IDLE_REAP_MS;再走内置默认;非法值回落+不抛', () => {
  const warn = []
  const origWarn = console.warn
  console.warn = m => warn.push(String(m))
  try {
    assert.deepEqual(resolvePolicy(() => null, {}), SESSION_POLICY_DEFAULT)
    assert.deepEqual(resolvePolicy(() => null, { SSH_IDLE_REAP_MS: '300000' }), { detachedIdleMin: 5, attachedIdleMin: 0, maxLifetimeMin: 0 })
    assert.deepEqual(resolvePolicy(k => ({ 'ssh.session.detachedIdleMin': '30', 'ssh.session.attachedIdleMin': '15' })[k] ?? null, {}), { detachedIdleMin: 30, attachedIdleMin: 15, maxLifetimeMin: 0 })
    // 非法落库值(手改库):回落默认 + warn 提示,绝不抛
    assert.deepEqual(resolvePolicy(k => ({ 'ssh.session.maxLifetimeMin': 'abc' })[k] ?? null, {}), SESSION_POLICY_DEFAULT)
    assert.ok(warn.some(m => m.includes('maxLifetimeMin')))
  } finally { console.warn = origWarn }
})

test('shouldReapSession:max-lifetime 优先且无条件;0=禁用', () => {
  const s = { createdAt: 0, lastActiveAt: 0, lastOutputAt: 0, browserCount: 1 }
  assert.deepEqual(shouldReapSession(s, { detachedIdleMin: 0, attachedIdleMin: 0, maxLifetimeMin: 60 }, 61 * min), { reap: true, reason: 'max-lifetime' })
  // 恰在阈值内不回收
  assert.equal(shouldReapSession(s, { detachedIdleMin: 0, attachedIdleMin: 0, maxLifetimeMin: 60 }, 60 * min).reap, false)
})

test('shouldReapSession:detached-idle 只看 lastActiveAt——无主忙会话(tail -f 输出续命)X 分钟后照收', () => {
  const s = { createdAt: 0, lastActiveAt: 0, lastOutputAt: 59 * min, browserCount: 0 }   // 一直有输出
  assert.deepEqual(shouldReapSession(s, { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 }, 11 * min), { reap: true, reason: 'detached-idle' })
  // 有浏览器附着时不走 detached 分支
  assert.equal(shouldReapSession({ ...s, browserCount: 1 }, { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 }, 11 * min).reap, false)
})

test('shouldReapSession:attached-idle 看 max(lastActiveAt,lastOutputAt)——看日志/跑构建不误杀,静默挂机会被踢', () => {
  const policy = { detachedIdleMin: 0, attachedIdleMin: 30, maxLifetimeMin: 0 }
  // 输出流动(构建/日志):不回收
  assert.equal(shouldReapSession({ createdAt: 0, lastActiveAt: 0, lastOutputAt: 29 * min, browserCount: 1 }, policy, 30 * min).reap, false)
  // 完全静默(忘关的空终端):回收
  assert.deepEqual(shouldReapSession({ createdAt: 0, lastActiveAt: 0, lastOutputAt: 0, browserCount: 1 }, policy, 31 * min), { reap: true, reason: 'attached-idle' })
  // 输入续命同理
  assert.equal(shouldReapSession({ createdAt: 0, lastActiveAt: 29 * min, lastOutputAt: 0, browserCount: 1 }, policy, 30 * min).reap, false)
})
```

- [ ] **Step 2: 跑测试确认红**:`node --test server/ssh/reap-policy.test.mjs` → FAIL(模块不存在)

- [ ] **Step 3: 最小实现** `server/ssh/reap-policy.mjs`:

```js
// SSH 会话回收策略(2026-08-29 spec:docs/superpowers/specs/2026-08-29-ssh-session-reap-policy-design.md)
// 三阈值全局策略,分钟单位,0=该条件禁用,全 0=永不自动关闭;判定为纯函数(时钟注入可测)。
export const SESSION_POLICY_DEFAULT = { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 }
export const SESSION_POLICY_MAX_MIN = 10080   // 0~7 天

export function isValidMinutes(v) {
  return Number.isInteger(v) && v >= 0 && v <= SESSION_POLICY_MAX_MIN
}

// 设置值 > env SSH_IDLE_REAP_MS(ms→分钟向下取整,仅 detached 兜底,兼容旧环境变量)> 内置默认。
// 非法落库值(手改库)warn 后按缺省处理,绝不抛(sweep 里抛=清道夫死)。
export function resolvePolicy(getFn, env = {}) {
  const envMs = Number(env.SSH_IDLE_REAP_MS)
  const envFallback = Number.isFinite(envMs) && envMs > 0 ? Math.floor(envMs / 60000) : undefined
  const read = (key, fallback) => {
    const raw = getFn?.(key)
    if (raw == null) return fallback
    const n = Number(raw)
    if (!isValidMinutes(n)) { console.warn(`[ssh] 非法会话策略值 ${key}=${raw},按缺省处理`); return fallback }
    return n
  }
  return {
    detachedIdleMin: read('ssh.session.detachedIdleMin', envFallback ?? SESSION_POLICY_DEFAULT.detachedIdleMin),
    attachedIdleMin: read('ssh.session.attachedIdleMin', SESSION_POLICY_DEFAULT.attachedIdleMin),
    maxLifetimeMin: read('ssh.session.maxLifetimeMin', SESSION_POLICY_DEFAULT.maxLifetimeMin),
  }
}

// 判定。时钟口径刻意非对称(spec §2.2):
//  - detached-idle 只看 lastActiveAt:无人看管即闲置,输出续命防「无主 tail -f 永生」
//  - attached-idle 看 max(lastActiveAt, lastOutputAt):输出流动=有事发生,不误杀看日志/跑构建
export function shouldReapSession(session, policy, now = Date.now()) {
  if (policy.maxLifetimeMin > 0 && now - session.createdAt > policy.maxLifetimeMin * 60000) return { reap: true, reason: 'max-lifetime' }
  if (policy.detachedIdleMin > 0 && session.browserCount === 0 && now - session.lastActiveAt > policy.detachedIdleMin * 60000) return { reap: true, reason: 'detached-idle' }
  const act = Math.max(session.lastActiveAt ?? 0, session.lastOutputAt ?? 0)
  if (policy.attachedIdleMin > 0 && session.browserCount > 0 && now - act > policy.attachedIdleMin * 60000) return { reap: true, reason: 'attached-idle' }
  return { reap: false, reason: null }
}
```

- [ ] **Step 4: 跑测试确认绿**:`node --test server/ssh/reap-policy.test.mjs` → 全 PASS

- [ ] **Step 5: 提交**

```bash
git add server/ssh/reap-policy.mjs server/ssh/reap-policy.test.mjs
git commit -m "feat(ssh): 会话回收策略纯逻辑模块——三阈值(0=禁用)+ resolvePolicy 设置>env>默认 + shouldReapSession 双时钟非对称判定"
```

---

### Task 2: registry 扩展(createdAt/lastOutputAt/markOutput/reapByPolicy)

**Files:**
- Modify: `server/ssh/terminal-sessions.mjs`
- Test: `server/ssh/terminal-sessions.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `shouldReapSession`
- Produces:
  - `ensure(sid, meta, factory)` 产出的 session 含 `createdAt`(ensure 时刻)与 `lastOutputAt: 0`
  - `markOutput(sid)` → 更新 `lastOutputAt = now()`
  - `list()` 每行增 `createdAt`、`lastOutputAt`
  - `reapByPolicy(policy, onReap)` → 替代 `reapIdle`:`onReap(session, reason)`;**移除** `reapIdle` 与 `idleReapMs` 构造参数(全仓唯一调用方是 index.mjs sweep,Task 3 迁移;测试用例同步迁移)

- [ ] **Step 1: 写失败测试**(追加到 `terminal-sessions.test.mjs`;并把既有 `reapIdle` 用例改写为 `reapByPolicy` 语义——旧用例的 `createTerminalRegistry({ idleReapMs: 600000 })` 改 `createTerminalRegistry({})`,判定阈值走 policy 参数):

```js
test('createdAt/lastOutputAt:ensure 打点;markOutput 续 lastOutputAt;list 透出', () => {
  let t = 1000
  const reg = createTerminalRegistry({ now: () => t })
  reg.ensure('a', { serverId: 'sv', userId: 'u' }, () => ({}))
  assert.equal(reg.get('a').createdAt, 1000)
  assert.equal(reg.get('a').lastOutputAt, 0)
  t = 5000; reg.markOutput('a')
  assert.equal(reg.get('a').lastOutputAt, 5000)
  const row = reg.list().find(r => r.sid === 'a')
  assert.equal(row.createdAt, 1000)
  assert.equal(row.lastOutputAt, 5000)
})

test('reapByPolicy:按 reason 回收并传给 onReap;策略全 0 永不回收', () => {
  let t = 0
  const reg = createTerminalRegistry({ now: () => t })
  reg.ensure('busy', { serverId: 'sv', userId: 'u' }, () => ({}))
  reg.ensure('quiet', { serverId: 'sv', userId: 'u' }, () => ({}))
  t = 20 * 60000
  reg.markOutput('busy')                       // 无主但输出流动
  const reaped = []
  reg.reapByPolicy({ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 }, (s, reason) => reaped.push([s.sid, reason]))
  // busy:lastActiveAt=0 已超 10min,输出不续命 → detached-idle;quiet 同为 detached-idle
  assert.deepEqual(reaped.sort((a, b) => a[0].localeCompare(b[0])), [['busy', 'detached-idle'], ['quiet', 'detached-idle']].sort((a, b) => a[0].localeCompare(b[0])))
  assert.equal(reg.get('busy'), null)
  // 全 0 策略:什么都不收
  reg.ensure('z', { serverId: 'sv', userId: 'u' }, () => ({}))
  reg.reapByPolicy({ detachedIdleMin: 0, attachedIdleMin: 0, maxLifetimeMin: 0 }, () => reaped.push('never'))
  assert.equal(reg.get('z')?.sid, 'z')
})
```

同时把旧用例 `'reapIdle: 仅回收…'` 整体替换为等价 `reapByPolicy` 版本(`attach` 后不回收 → `detach` 后未满阈不回收 → 超阈回收,阈值全部经 policy 传入:`{ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 }`,时钟逻辑不变)。

- [ ] **Step 2: 跑测试确认红**:`node --test server/ssh/terminal-sessions.test.mjs` → FAIL(reapByPolicy/markOutput/createdAt 不存在)

- [ ] **Step 3: 实现** `terminal-sessions.mjs`:

```js
import { shouldReapSession } from './reap-policy.mjs'
```

`createTerminalRegistry({ now = Date.now } = {})`(删 `idleReapMs` 参数);`ensure` 的 session 字面量改为:

```js
s = { sid, serverId: meta.serverId || '', userId: meta.userId || '', ring: createRingBuffer(), browserCount: 0, lastActiveAt: now(), createdAt: now(), lastOutputAt: 0, extra: {} }
```

新增:

```js
function markOutput(sid) { const s = map.get(sid); if (s) s.lastOutputAt = now() }
```

`reapIdle` 整体替换为:

```js
  // 策略化回收(2026-08-29 spec):阈值来自每跳现读的全局策略,判定纯函数见 reap-policy.mjs
  function reapByPolicy(policy, onReap) {
    for (const [sid, s] of map) {
      const { reap, reason } = shouldReapSession(s, policy, now())
      if (reap) { map.delete(sid); try { onReap?.(s, reason) } catch {} }
    }
  }
```

导出行:`reapIdle` 改 `reapByPolicy`;`list()` 的 map 增 `createdAt: s.createdAt, lastOutputAt: s.lastOutputAt`。

- [ ] **Step 4: 跑测试确认绿**:`node --test server/ssh/terminal-sessions.test.mjs` → 全 PASS

- [ ] **Step 5: 提交**

```bash
git add server/ssh/terminal-sessions.mjs server/ssh/terminal-sessions.test.mjs
git commit -m "feat(ssh): registry 增 createdAt/lastOutputAt/markOutput,reapIdle→reapByPolicy(策略入参化,onReap 带 reason)"
```

---

### Task 3: sweep 接线 + channel 输出打点 + 回收告知(server/index.mjs)

**Files:**
- Modify: `server/index.mjs`(约 2100-2108 sweep 段、2143-2148 shell data 段)
- Modify: `server/messages/ssh.mjs`(告知文案两键)
- Test: 无新 spawn 测试(sweep 定时器不可注入;判定逻辑已被 Task 1/2 纯逻辑覆盖;广播/审计路径归手测清单)

**Interfaces:**
- Consumes: Task 1 `resolvePolicy`、Task 2 `reapByPolicy`;既有 `broadcastToSockets`/`wsSend`/`CH_ERROR`/`writeAudit`
- Produces: sweep 每跳 `getSshSessionPolicy()` 现读;Task 4 的 admin GET 端点复用同一 helper

- [ ] **Step 1: import** — `server/index.mjs` 头部:`import { msg, t } from './messages.mjs'`(若 msg 已按其它方式导入则并列加 `t`);新增 `import { resolvePolicy } from './ssh/reap-policy.mjs'`

- [ ] **Step 2: 策略 helper**(放在 `getSshfileLimitBytes` 旁,同款注释风格):

```js
// SSH 会话回收策略(2026-08-29 spec):设置>env SSH_IDLE_REAP_MS>内置默认;每跳现读,改动 ≤60s 生效
const getSshSessionPolicy = () => resolvePolicy(getSetting, process.env)
```

- [ ] **Step 3: 改造 sweep**(替换 `createTerminalRegistry({ idleReapMs: … })` 为 `createTerminalRegistry()`,及现 `setInterval(() => sshTerminals.reapIdle(…))` 段):

```js
const sshTerminals = createTerminalRegistry()
// 60s sweep:每跳现读策略(改设置 ≤60s 生效,无需重启);命中即回收(关 channel+还池句柄+审计),
// 有附着浏览器的(attached-idle/max-lifetime)先广播告知再关。detached-idle 无人可告,直接收。
setInterval(() => {
  try {
    sshTerminals.reapByPolicy(getSshSessionPolicy(), (s, reason) => {
      if (s.extra?.sockets?.size > 0) {
        const key = reason === 'max-lifetime' ? 'ssh.reapedMaxLifetime' : 'ssh.reapedAttached'
        try { broadcastToSockets(s, wsSend, CH_ERROR, t('zh', key)) } catch { /* 告知失败不阻断回收 */ }
      }
      try { s.extra?.channel?.close?.() } catch {}
      try { s.extra?.release?.() } catch {}
      writeAudit(db, { owner: s.userId, verb: 'close', tool: 'ssh_terminal', result: 'ok', reason,
        requestSummary: `server=${s.serverId} sid=${s.sid}`, source: 'platform' })
    })
  } catch (e) { console.error('[ssh] reap sweep failed:', e?.message || e) }
}, 60000).unref?.()
```

注:`t('zh', …)` 固定中文是既有 WS 文案口径(WS 帧语言随浏览器是全仓已知遗留),消息表仍双语维护。

- [ ] **Step 4: channel 输出打点** — shell 回调内 `channel.on('data')` 与 `channel.stderr?.on?.('data')` 两处,`session.ring.push(d)` 前各加一行:

```js
        sshTerminals.markOutput(sid)
```

- [ ] **Step 5: 告知文案** — `server/messages/ssh.mjs` 增两键(spec §3.4 的 `reapedDetached` 不落表:detached 无附着浏览器,广播永不发生,死键):

```js
  'ssh.reapedAttached':   { zh: '会话因长时间无活动被策略关闭', en: 'Session closed by policy after inactivity' },
  'ssh.reapedMaxLifetime':{ zh: '会话达到最长存活时间,被策略关闭', en: 'Session closed by max-lifetime policy' },
```

- [ ] **Step 6: 验证** — `npm run test:server` 全绿(既有 ws-handshake/routes 用例不得破);`node --check server/index.mjs` 过

- [ ] **Step 7: 提交**

```bash
git add server/index.mjs server/messages/ssh.mjs
git commit -m "feat(ssh): sweep 接策略化回收——每跳现读策略(≤60s 生效),attached 命中先广播告知再收,channel 输出打点续命"
```

---

### Task 4: 策略读写 admin 端点(GET/PUT + 校验 + 审计)

**Files:**
- Modify: `server/routes/admin.mjs`(podfile-config 段之后)
- Modify: `server/index.mjs:1448` 附近 `createAdminRoutes({...})` 注入 `getSshSessionPolicy`、`writeAudit`(检查既有注入表,缺哪个补哪个)
- Modify: `server/messages/admin.mjs`(校验失败文案)
- Test: Create `server/ssh/session-policy-routes.test.mjs`

**Interfaces:**
- Consumes: Task 1 `resolvePolicy`(经 index.mjs `getSshSessionPolicy` 注入);admin.mjs 既有 `requireAdmin/sendJson/readBody/getSetting/setSetting/msg`
- Produces: `GET /api/admin/ssh-session-policy` → `{ detachedIdleMin, attachedIdleMin, maxLifetimeMin }`;`PUT`(body 部分键,省略键保持现值)→ `{ ok: true, policy }`;越界/非整数 → 400 `{ message }`

- [ ] **Step 1: 写失败测试** `server/ssh/session-policy-routes.test.mjs`(spawn 模式逐字照 `server/ssh/routes.test.mjs`:PORT 取 47000+随机、ALIANG_DB 指向 mkdtemp、ADMIN_USERNAME/PASSWORD、waitUp、cleanup 测试 SIGKILL+rmSync):在 CRUD 用例位置放:

```js
test('SSH 会话策略:GET 空态=默认;PUT 部分更新;越界 400;非 admin 401', { timeout: 60000 }, async () => {
  await waitUp()
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }

  // 空态=内置默认
  assert.deepEqual(await (await fetch(`${BASE}/api/admin/ssh-session-policy`, { headers: H })).json(),
    { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 })

  // 部分更新:只动 attached,其余保持
  const put1 = await (await fetch(`${BASE}/api/admin/ssh-session-policy`, { method: 'PUT', headers: H,
    body: JSON.stringify({ attachedIdleMin: 30 }) })).json()
  assert.deepEqual(put1.policy, { detachedIdleMin: 10, attachedIdleMin: 30, maxLifetimeMin: 0 })

  // 全量更新 + 0=禁用语义可写回
  const put2 = await (await fetch(`${BASE}/api/admin/ssh-session-policy`, { method: 'PUT', headers: H,
    body: JSON.stringify({ detachedIdleMin: 0, attachedIdleMin: 0, maxLifetimeMin: 720 }) })).json()
  assert.deepEqual(put2.policy, { detachedIdleMin: 0, attachedIdleMin: 0, maxLifetimeMin: 720 })

  // 越界/非整数 → 400
  for (const bad of [{ detachedIdleMin: -1 }, { maxLifetimeMin: 10081 }, { attachedIdleMin: 1.5 }, { attachedIdleMin: 'x' }]) {
    const r = await fetch(`${BASE}/api/admin/ssh-session-policy`, { method: 'PUT', headers: H, body: JSON.stringify(bad) })
    assert.equal(r.status, 400, JSON.stringify(bad))
  }
  // 失败请求不得污染已存值
  assert.deepEqual((await (await fetch(`${BASE}/api/admin/ssh-session-policy`, { headers: H })).json()),
    { detachedIdleMin: 0, attachedIdleMin: 0, maxLifetimeMin: 720 })

  // 无 token → 401(requireAdmin 在分支内)
  assert.equal((await fetch(`${BASE}/api/admin/ssh-session-policy`)).status, 401)
})
```

- [ ] **Step 2: 跑测试确认红**:`node --test server/ssh/session-policy-routes.test.mjs` → FAIL(GET 404)

- [ ] **Step 3: 实现** — `server/routes/admin.mjs`:destructure 增 `getSshSessionPolicy, writeAudit`;podfile-config PUT 之后插入:

```js
    // ====== SSH 会话回收策略(2026-08-29 spec):三阈值全局,分钟,0=禁用;改动 ≤60s 随 sweep 生效 ======
    if (url.pathname === '/api/admin/ssh-session-policy' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, getSshSessionPolicy())
      return true
    }
    if (url.pathname === '/api/admin/ssh-session-policy' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        // 部分更新语义:仅校验并落库出现的键;省略键保持现值
        const keys = ['detachedIdleMin', 'attachedIdleMin', 'maxLifetimeMin']
        for (const k of keys) {
          if (input[k] === undefined) continue
          if (!isValidMinutes(input[k])) { sendJson(res, 400, { message: msg(req, 'admin.sshPolicyInvalid', { field: k }) }); return true }
        }
        for (const k of keys) if (input[k] !== undefined) setSetting(`ssh.session.${k}`, String(input[k]))
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'ssh_session_policy', result: 'ok', requestSummary: JSON.stringify(input), source: 'platform' })
        sendJson(res, 200, { ok: true, policy: getSshSessionPolicy() })
        return true
      } catch (e) { sendJson(res, 400, { message: e.message }); return true }
    }
```

import 行:`import { isValidMinutes } from '../ssh/reap-policy.mjs'`。`server/index.mjs` 的 `createAdminRoutes({...})` 注入 `getSshSessionPolicy, writeAudit`。`server/messages/admin.mjs` 增:

```js
  'admin.sshPolicyInvalid': { zh: '非法的策略值:{field}(须为 0–10080 的整数分钟)', en: 'Invalid policy value: {field} (must be an integer 0–10080 minutes)' },
```

- [ ] **Step 4: 跑测试确认绿**:`node --test server/ssh/session-policy-routes.test.mjs` → 全 PASS;`node --test server/route-auth-map.test.mjs` → PASS(守卫确认前缀覆盖)

- [ ] **Step 5: 提交**

```bash
git add server/routes/admin.mjs server/index.mjs server/messages/admin.mjs server/ssh/session-policy-routes.test.mjs
git commit -m "feat(ssh): /api/admin/ssh-session-policy GET/PUT——三阈值部分更新+0-10080 校验+审计,sweep 现读同源"
```

---

### Task 5: client.js API + Settings 页「SSH」tab + i18n + 组件测试

**Files:**
- Modify: `src/api/client.js`(adminApi.podfileConfig 之后)
- Modify: `src/views/Settings.vue`(tabs 数组、onMounted、script 段、template 卡)
- Modify: `src/locales/zh.json` / `src/locales/en.json`(settings 命名空间)
- Test: Create `src/views/__tests__/Settings.ssh-policy.test.js`

**Interfaces:**
- Consumes: Task 4 端点形状 `{ detachedIdleMin, attachedIdleMin, maxLifetimeMin }`
- Produces: `adminApi.sshSessionPolicy.get()` / `.update(patch)`;Settings 页 `ssh` tab

- [ ] **Step 1: 写失败测试** `src/views/__tests__/Settings.ssh-policy.test.js`:

```js
// Settings SSH 策略卡契约:admin 可见、读取回填、保存发 PUT、失败提示。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { adminApi } from '@/api/client'
import Settings from '../Settings.vue'

vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: null, clusters: [] }) }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ catalog: { value: [] }, resetAll: vi.fn() }) }))

// auth.user 是响应式 ref(src/stores/auth.js:79 返回形态),mount 前在 pinia 上赋值 { role: 'admin' }
// 即 isAdmin=true → admin tabs(含 ssh)参与渲染。
async function mountAdminAndAuth() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth')
  useAuthStore().user = { role: 'admin' }
  return mount(Settings, { global: { plugins: [pinia, i18n] } })
}

beforeEach(() => { vi.restoreAllMocks(); localStorage.clear() })

test('admin:SSH tab 可见、进页拉策略回填、保存发全量 PUT', async () => {
  const get = vi.spyOn(adminApi.sshSessionPolicy, 'get').mockResolvedValue({ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 })
  const update = vi.spyOn(adminApi.sshSessionPolicy, 'update').mockResolvedValue({ ok: true, policy: { detachedIdleMin: 0, attachedIdleMin: 30, maxLifetimeMin: 0 } })
  const w = await mountAdminAndAuth()
  await flushPromises()
  expect(get).toHaveBeenCalled()
  const tab = w.findAll('button').find(b => b.text() === 'SSH')
  expect(tab).toBeTruthy()
  await tab.trigger('click')
  await flushPromises()
  const inputs = w.findAll('input[type="number"]')
  expect(inputs.length).toBe(3)
  const save = w.findAll('button').find(b => b.text().includes('保存'))
  await save.trigger('click')
  await flushPromises()
  expect(update).toHaveBeenCalledWith({ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 })
})

test('保存失败(400)→ 不崩,错误 notify', async () => {
  vi.spyOn(adminApi.sshSessionPolicy, 'get').mockResolvedValue({ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 })
  vi.spyOn(adminApi.sshSessionPolicy, 'update').mockRejectedValue(new Error('invalid'))
  const w = await mountAdminAndAuth()
  await flushPromises()
  const tab = w.findAll('button').find(b => b.text() === 'SSH')
  await tab.trigger('click')
  await flushPromises()
  const save = w.findAll('button').find(b => b.text().includes('保存'))
  await expect(save.trigger('click').then(() => flushPromises())).resolves.toBeUndefined()
})
```

(实现者注:若 `settings.tabs.ssh` 的 zh 文案不恰为 `'SSH'`,tab 查找改用 `b.text().includes(<文案>)`;若 preferences/ColumnManager 顶层依赖在 happy-dom 报错,照 cluster 的 mock 方式补 `vi.mock('@/stores/preferences', …)`。)

- [ ] **Step 2: 跑测试确认红**:`npx vitest run src/views/__tests__/Settings.ssh-policy.test.js` → FAIL(sshSessionPolicy undefined / tab 不存在)

- [ ] **Step 3: 实现 client.js** — `adminApi` 内 `podfileConfig` 之后:

```js
  // SSH 会话回收策略(2026-08-29):GET 回显三阈值;PUT 部分更新(省略键保持现值)→ { ok, policy }
  sshSessionPolicy: {
    get: () => platformHttp.request('/api/admin/ssh-session-policy'),
    update: patch => platformHttp.request('/api/admin/ssh-session-policy', { method: 'PUT', body: JSON.stringify(patch) }),
  },
```

- [ ] **Step 4: 实现 Settings.vue** —

tabs 数组追加(admin 段):`...(auth.isAdmin ? [{ key: 'ssh', label: t('settings.tabs.ssh'), icon: 'dns' }] : []),`

onMounted 追加:`if (auth.isAdmin) { …; loadSshPolicy() }`

script 段(照 transfers 段风格):

```js
// === SSH 会话回收策略 (admin only;2026-08-29 spec) ===
const sshPolicy = ref({ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 })
const sshPolicySaving = ref(false)
async function loadSshPolicy() {
  try { sshPolicy.value = await adminApi.sshSessionPolicy.get() } catch { /* 非 admin 静默 */ }
}
async function saveSshPolicy() {
  sshPolicySaving.value = true
  try {
    const r = await adminApi.sshSessionPolicy.update({
      detachedIdleMin: Number(sshPolicy.value.detachedIdleMin) || 0,
      attachedIdleMin: Number(sshPolicy.value.attachedIdleMin) || 0,
      maxLifetimeMin: Number(sshPolicy.value.maxLifetimeMin) || 0,
    })
    sshPolicy.value = r.policy; notify('success', t('settings.sshPolicySaved'))
  } catch (e) { notify('error', e.message || t('settings.sshPolicyInvalid')) }
  finally { sshPolicySaving.value = false }
}
```

template(transfers 卡之后,同款卡片骨架):

```html
        <!-- SSH 会话回收策略 tab (admin only;2026-08-29 spec) -->
        <div v-if="activeTab === 'ssh'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">dns</span>
            <span class="text-body-sm font-semibold">{{ t('settings.sshPolicyTitle') }}</span>
          </div>
          <div class="p-md space-y-md">
            <div v-for="f in [['detachedIdleMin', 'sshPolicyDetachedLabel'], ['attachedIdleMin', 'sshPolicyAttachedLabel'], ['maxLifetimeMin', 'sshPolicyMaxLifetimeLabel']]" :key="f[0]" class="flex items-center gap-sm">
              <label class="text-body-sm text-on-surface-variant shrink-0 w-56">{{ t('settings.' + f[1]) }}</label>
              <input v-model="sshPolicy[f[0]]" type="number" min="0" max="10080" class="w-32 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              <span class="text-body-xs text-on-surface-variant">{{ t('settings.sshPolicyUnit') }}</span>
            </div>
            <button @click="saveSshPolicy" :disabled="sshPolicySaving" class="px-sm py-1 rounded-md bg-primary text-primary text-xs font-semibold hover:opacity-90 disabled:opacity-50">{{ t('common.save') }}</button>
            <p class="text-body-xs text-on-surface-variant">{{ t('settings.sshPolicyHint') }}</p>
            <p class="text-body-xs text-error/80">{{ t('settings.sshPolicyNeverHint') }}</p>
          </div>
        </div>
```

- [ ] **Step 5: i18n 双语** — `zh.json`/`en.json` settings 段(`"tabs"` 子对象加 `ssh`;正文加七键):

```json
"tabs": { …, "ssh": "SSH" },
"sshPolicyTitle": "SSH 会话回收策略",
"sshPolicyDetachedLabel": "无人附着闲置回收",
"sshPolicyAttachedLabel": "挂机回收(有浏览器但无活动)",
"sshPolicyMaxLifetimeLabel": "最长存活硬上限",
"sshPolicyUnit": "分钟(0 = 关闭)",
"sshPolicyHint": "改动自动生效(≤1 分钟),无需重启。「无人附着」指所有浏览器都断开后的保活窗口;「挂机回收」把有窗口但完全静默的终端也定时收掉,跑构建/看日志(有输出)不会被误杀。",
"sshPolicyNeverHint": "三项全部设为 0 = 永不自动关闭:会话将保留到手动终止或网关重启,请注意资源与安全风险。",
"sshPolicySaved": "SSH 会话策略已保存",
"sshPolicyInvalid": "策略保存失败"
```

```json
"tabs": { …, "ssh": "SSH" },
"sshPolicyTitle": "SSH Session Reap Policy",
"sshPolicyDetachedLabel": "Reap when detached & idle",
"sshPolicyAttachedLabel": "Reap idle sessions (attached but silent)",
"sshPolicyMaxLifetimeLabel": "Max session lifetime",
"sshPolicyUnit": "minutes (0 = off)",
"sshPolicyHint": "Changes take effect automatically (≤1 min), no restart needed. “Detached” means all browsers have disconnected (keepalive/replay window); “idle reap” also collects attached terminals that are fully silent — active output (builds, logs) keeps them alive.",
"sshPolicyNeverHint": "Setting all three to 0 disables auto-close entirely: sessions live until manually terminated or gateway restart. Mind the resource & security implications.",
"sshPolicySaved": "SSH session policy saved",
"sshPolicyInvalid": "Failed to save SSH session policy"
```

- [ ] **Step 6: 跑测试确认绿**:`npx vitest run src/views/__tests__/Settings.ssh-policy.test.js` → PASS;`npm run i18n:check` → 六项全 0

- [ ] **Step 7: 提交**

```bash
git add src/api/client.js src/views/Settings.vue src/locales/zh.json src/locales/en.json src/views/__tests__/Settings.ssh-policy.test.js
git commit -m "feat(ssh): Settings 页 SSH 会话策略卡——三阈值分钟输入+永不关闭警示,adminApi.sshSessionPolicy 对接"
```

---

### Task 6: 全量门禁 + 手测清单落档

- [ ] **Step 1:** `npm test`(server+unit 全量)、`npm run i18n:check`、`npm run typecheck` 全绿
- [ ] **Step 2:** `git status` 干净;`git log --oneline -6` 六提交(作者 aliangone、无尾注)
- [ ] **Step 3:** 手测清单追加到记忆(网关须重启一次使 Task 2/3 生效;此后策略改动无需重启):①改 detached=1min,断开浏览器 → 1 分钟后 /api/ssh/sessions 应空;②attached=1min,开终端静置 → 1 分钟被踢且终端有告知文案;③开 `tail -f` 静置 → 不被挂机踢;④maxLifetime=2min → 不论活跃 2 分钟必关;⑤全 0 → 永不回收;⑥任务栏未跟踪 chip 对旧会话照常工作(回归)
