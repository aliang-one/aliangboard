# TerminalService P1 实施计划(状态机 + connectionId + 清理入口收敛)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 终端生命周期唯一状态机(TerminalService)落地:七操作独占写、全部清理入口收敛、connectionId 复合键 attachments、二段式回收(注入时钟)、竞态回归测试套件。

**Architecture:** 新建 `server/ssh/terminal-service.mjs`(状态机 + Map<tid, terminal>,terminal 对象吸收原 registry extra 的 channel/release/ring/connIds);`createSshTerminalHandler(deps)` 把 index.mjs 内联 handler move-only 抽出(deps 注入,含 service);index.mjs 七处清理入口全部改走 service;`terminal-sessions.mjs` 退役(ring 工厂移入 service);`terminal-guard.test.mjs` 静态守卫让「禁止裸操作」可验收。

**Tech Stack:** node:test(服务端)+ vitest(前端,本计划不涉及)+ ws/ssh2(既有依赖,零新增)。

**Spec:** `docs/superpowers/specs/2026-09-05-terminal-lifecycle-design.md`(v2)

## Global Constraints

- 单进程不变式:不引入任何跨进程状态;SQLite 不动(P2 才有 catalog)。
- 依赖政策:零新增外部依赖。
- 已落地止血不得回归:closeIf 身份校验、入口哨兵(createCloseSentinel)、双振心跳、teardownOnOwnerGone 交棒、resize primary 仲裁、ring 字节上限。
- 提交作者 aliang-one <aliangdone@gmail.com>;提交信息英文;无 Claude 尾注。
- 门禁:`npm test`、`npm run test:unit -- --maxWorkers=2`、`npm run typecheck`、`npm run build` 全绿。

---

### Task 1: 状态机纯函数 + TerminalService 骨架(create/getOrCreate/状态转换)

**Files:**
- Create: `server/ssh/terminal-service.mjs`
- Test: `server/ssh/terminal-service.test.mjs`

**Interfaces:**
- Produces: `TERMINAL_TRANSITIONS`、`canTransition(from,to)`、`createTerminalService({now, ringMaxBytes, onTransition, onIrreversible})` → `{ getOrCreate, newTerminal, get, attach, detach, abandon, close, markLost, touch, markOutput, broadcast, sweep, reconcileOnBoot, closeByServer, list, attachments }`

- [ ] **Step 1: 写失败测试**

```js
// server/ssh/terminal-service.test.mjs(新文件,以下为文件头+本任务用例)
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { TERMINAL_TRANSITIONS, canTransition, createTerminalService } from './terminal-service.mjs'

test('转换表:spec §2 全边存在,非法边不存在', () => {
  assert.deepEqual(canTransition('CREATING', 'ATTACHED'), true)
  assert.deepEqual(canTransition('DETACHED_TIMEOUT', 'ATTACHED'), true)
  assert.deepEqual(canTransition('DETACHED_TIMEOUT', 'CLOSING'), true)
  assert.deepEqual(canTransition('CLOSING', 'DETACHED_TIMEOUT'), true)   // kill 失败回滚
  assert.deepEqual(canTransition('ATTACHED', 'DETACHED_TIMEOUT'), false) // 必须经 DETACHED
  assert.deepEqual(canTransition('CLOSED', 'ATTACHED'), false)
  assert.deepEqual(canTransition('LOST', 'ATTACHED'), false)
})

test('getOrCreate 单飞:同 tid 返回同一对象,factory 只执行一次;状态 CREATING', () => {
  const svc = createTerminalService({ now: () => 1000 })
  let made = 0
  const a = svc.getOrCreate('t1', () => { made++; return svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }) })
  const b = svc.getOrCreate('t1', () => { made++; return svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }) })
  assert.equal(made, 1)
  assert.equal(a.existing, false)
  assert.equal(b.existing, true)
  assert.equal(a.terminal, b.terminal)
  assert.equal(a.terminal.status, 'CREATING')
})

test('newTerminal 默认形状:connIds 空 Map/ring 存在/锚点 null/CREATING', () => {
  const svc = createTerminalService({ now: () => 1000 })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  assert.equal(t.status, 'CREATING')
  assert.equal(t.connIds.size, 0)
  assert.equal(t.detachedSince, null)
  assert.equal(t.backendIdleSince, null)
  assert.ok(typeof t.ring.push === 'function')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/ssh/terminal-service.test.mjs`
Expected: FAIL(import 不存在)

- [ ] **Step 3: 实现**

```js
// server/ssh/terminal-service.mjs(新文件)
// 终端生命周期唯一状态机(2026-09-05 方案 P1,spec §2):七操作独占写,全部幂等。
// 其余入口禁止裸 Map.delete/channel.close —— terminal-guard.test.mjs 静态守卫钉住。
import { createRingBuffer } from './terminal-sessions.mjs'   // Task 6 移入本文件后改本文件

export const TERMINAL_TRANSITIONS = {
  CREATING: ['ATTACHED', 'LOST', 'CLOSED'],
  ATTACHED: ['DETACHED', 'LOST', 'CLOSED'],
  DETACHED: ['ATTACHED', 'DETACHED_TIMEOUT', 'LOST', 'CLOSED'],
  DETACHED_TIMEOUT: ['ATTACHED', 'CLOSING', 'LOST', 'CLOSED'],
  CLOSING: ['CLOSED', 'DETACHED_TIMEOUT'],
  LOST: ['CLOSED'],
  CLOSED: [],
}
export const canTransition = (from, to) => (TERMINAL_TRANSITIONS[from] || []).includes(to)

export function createTerminalService({
  now = Date.now,
  ringMaxBytes = 4 * 1024 * 1024,
  onTransition = () => {},
  onIrreversible = () => {},
} = {}) {
  const map = new Map()

  function newTerminal({ id, owner, serverId, backend = 'ephemeral', title = '' }) {
    return {
      id, owner, serverId, backend, title,
      status: 'CREATING', lastError: null, statusVersion: 0,
      connIds: new Map(), primary: null,
      channel: null, release: null, ring: createRingBuffer(ringMaxBytes),
      ready: null, resolveReady: null, rejectReady: null, waiters: 0,
      createdAt: now(), lastActiveAt: now(),
      detachedSince: null, backendIdleSince: null,
      lastAttachAt: 0, lastDetachAt: 0, attachCount: 0,
    }
  }

  function getOrCreate(tid, factory) {
    let t = map.get(tid)
    if (t) return { terminal: t, existing: true }
    t = factory()
    map.set(tid, t)
    onTransition(tid, null, 'CREATING', 'create')
    return { terminal: t, existing: false }
  }

  function get(tid) { return map.get(tid) || null }

  return { map, newTerminal, getOrCreate, get, _transition: null }
}
```
(注:`transition`/其余操作在后续任务填充同一导出对象;`_transition` 占位本任务不需要,删除该行。)

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/ssh/terminal-service.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/ssh/terminal-service.mjs server/ssh/terminal-service.test.mjs
git commit -m "feat(terminal): state machine transitions + TerminalService skeleton"
```

---

### Task 2: attach/detach/touch/broadcast(复合键 attachments + 快速 F5 交棒)

**Files:**
- Modify: `server/ssh/terminal-service.mjs`
- Test: `server/ssh/terminal-service.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `getOrCreate/newTerminal/get`
- Produces: `attach(tid, connId, socket) → Promise<{ok, status, reason}>`、`detach(tid, connId, reason)`、`touch(tid)`、`markOutput(tid, chunk)`、`broadcast(tid, type, payload, send)`、`readyForOwner(tid) → {resolve, reject}`、`bindChannel(tid, channel)`、`attachments(tid) → Array<{connId, socket}>`

- [ ] **Step 1: 写失败测试**

```js
test('attach CREATING:登记等待者等 ready;ready 后 CREATING→ATTACHED 且 waiters 归零', async () => {
  let clock = 1000
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  const p = svc.attach('t1', 'c1', { close() {} })
  assert.equal(t.waiters, 1)
  svc.bindChannel('t1', {})
  const ready = svc.readyForOwner('t1')
  ready.resolve()
  const res = await p
  assert.deepEqual(res, { ok: true, status: 'ATTACHED', reason: null })
  assert.equal(t.waiters, 0)
  assert.equal(t.status, 'ATTACHED')
})

test('attach CREATING 中 ready 失败:等待者收到 {ok:false, status:LOST},终端 LOST 且资源释放', async () => {
  let clock = 1000
  const released = []
  const svc = createTerminalService({ now: () => clock, onIrreversible: () => {} })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  t.release = () => released.push('pool')
  const p = svc.attach('t1', 'c1', { close() { released.push('ws') } })
  svc.bindChannel('t1', {})
  svc.readyForOwner('t1').reject(new Error('shell failed'))
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.status, 'LOST')
  assert.deepEqual(released, ['pool', 'ws'])
})

test('detach:未知 connId no-op;最后一个 attachment 消失 → DETACHED(detached_since=now);primary 顺延', () => {
  let clock = 1000
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {})
  svc.readyForOwner('t1').resolve()
  const s1 = { close() {} }, s2 = { close() {} }
  svc.attach('t1', 'c1', s1); svc.attach('t1', 'c2', s2)
  clock = 2000
  svc.detach('t1', 'c1')
  assert.equal(t.primary, s2)                    // primary 顺延给剩余 attachment
  svc.detach('t1', 'c1')                         // 幂等:未知 connId no-op
  svc.detach('t1', 'c2', 'ws-close')
  assert.equal(t.status, 'DETACHED')
  assert.equal(t.detachedSince, 2000)
})

test('detach 后重新 attach:DETACHED→ATTACHED 且锚点清空', () => {
  let clock = 1000
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {}); svc.readyForOwner('t1').resolve()
  svc.attach('t1', 'c1', { close() {} })
  svc.detach('t1', 'c1'); clock = 5000
  svc.attach('t1', 'c2', { close() {} })
  assert.equal(t.status, 'ATTACHED')
  assert.equal(t.detachedSince, null)
  assert.equal(t.backendIdleSince, null)
})

test('broadcast:到达全部 attachment;markOutput 入 ring', () => {
  const svc = createTerminalService({ now: () => 1000 })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {}); svc.readyForOwner('t1').resolve()
  const seen = []
  svc.attach('t1', 'c1', { close() {}, send(type, payload) { seen.push([type, payload]) } })
  svc.markOutput('t1', Buffer.from('hi'))
  svc.broadcast('t1', 9, Buffer.from('x'))
  assert.equal(t.ring.snapshot().toString(), 'hi')
  assert.equal(seen.length, 1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/ssh/terminal-service.test.mjs`
Expected: 新用例 FAIL(attach is not a function)

- [ ] **Step 3: 实现(service 内追加)**

```js
  function readyForOwner(tid) {
    const t = map.get(tid)
    if (!t) return { resolve() {}, reject() {} }
    if (!t.ready) {
      t.ready = new Promise((resolve, reject) => { t.resolveReady = resolve; t.rejectReady = reject })
    }
    return { resolve: () => t.resolveReady?.({ status: t.status }), reject: e => t.rejectReady?.(e) }
  }
  function bindChannel(tid, channel) { const t = map.get(tid); if (t) t.channel = channel }

  function doAttach(t, connId, socket) {
    const prev = t.connIds.get(connId)
    if (prev && prev.socket !== socket) { try { prev.socket.close() } catch { /* noop */ } }   // 同 connId 接管
    const first = t.connIds.size === 0
    t.connIds.set(connId, { socket, attachedAt: now() })
    t.primary = socket
    t.lastAttachAt = now(); t.attachCount++; t.lastActiveAt = now()
    if (first || t.status === 'CREATING') transition(t, 'ATTACHED', 'attach')
  }

  async function attach(tid, connId, socket) {
    const t = map.get(tid)
    if (!t) return { ok: false, status: 'CLOSED', reason: 'unknown-terminal' }
    if (t.status === 'CLOSED' || t.status === 'LOST' || t.status === 'CLOSING')
      return { ok: false, status: t.status, reason: t.lastError || 'terminal-' + t.status }
    const prev = t.connIds.get(connId)
    if (prev && prev.socket !== socket) { try { prev.socket.close() } catch { /* noop */ } }
    if (t.status === 'CREATING') {
      t.waiters++
      try {
        await t.ready
      } catch (e) {
        return { ok: false, status: 'LOST', reason: String(e?.message || e) }
      } finally { t.waiters = Math.max(0, t.waiters - 1) }
      if (t.status === 'CLOSED' || t.status === 'LOST') return { ok: false, status: t.status, reason: t.lastError || '' }
    }
    doAttach(t, connId, socket)
    return { ok: true, status: t.status, reason: null }
  }

  function detach(tid, connId, reason = 'detach') {
    const t = map.get(tid); if (!t) return
    const a = t.connIds.get(connId)
    if (!a) return                                        // 未知 connId:no-op(幂等)
    t.connIds.delete(connId)
    if (t.primary === a.socket) t.primary = ([...t.connIds.values()][0] || {}).socket || null
    t.lastDetachAt = now()
    if (t.connIds.size === 0) transition(t, 'DETACHED', reason)
  }

  function touch(tid) { const t = map.get(tid); if (t) t.lastActiveAt = now() }
  function markOutput(tid, chunk) { const t = map.get(tid); if (t) t.ring.push(chunk) }
  function broadcast(tid, type, payload, send = (socket, ty, pl) => socket.send?.(ty, pl)) {
    const t = map.get(tid); if (!t) return
    for (const a of t.connIds.values()) { try { send(a.socket, type, payload) } catch { /* noop */ } }
  }
  function attachments(tid) { return [...(map.get(tid)?.connIds || []).values()] }
```
(`transition` 依赖 Task 1 引入;`newTerminal` 的 ring 依赖既有 createRingBuffer。)

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/ssh/terminal-service.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/ssh/terminal-service.mjs server/ssh/terminal-service.test.mjs
git commit -m "feat(terminal): attach/detach with composite-key attachments + single-flight create"
```

---

### Task 3: abandon / markLost / close(软护栏)/ releaseBackend

**Files:**
- Modify: `server/ssh/terminal-service.mjs`
- Test: `server/ssh/terminal-service.test.mjs`

**Interfaces:**
- Produces: `abandon(tid, connId)`、`markLost(tid, reason)`、`close(tid, {reason, actor, force}) → {ok}|{ok:false,error}`、`claimClose(tid) → boolean`、`closeByServer(serverId, reason)`、`markDead? 不需要(LOST/CLOSED 即死)`

- [ ] **Step 1: 写失败测试**

```js
test('abandon:CREATING 无等待者 → LOST(create-abandoned) + 资源释放;有等待者 → 交棒 no-op', async () => {
  let clock = 1000
  const released = []
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  t.release = () => released.push('pool')
  const p = svc.attach('t1', 'c1', { close() {} })       // 等待者
  svc.abandon('t1', 'c0')                                // 属主连接断开
  assert.equal(t.status, 'CREATING')                     // 交棒:不拆
  svc.bindChannel('t1', {}); svc.readyForOwner('t1').resolve()
  await p
  assert.equal(t.status, 'ATTACHED')                     // 等待者接管成功

  const { terminal: t2 } = svc.getOrCreate('t2', () => svc.newTerminal({ id: 't2', owner: 'u', serverId: 'sv' }))
  t2.release = () => released.push('pool2')
  svc.abandon('t2', 'cX')                                // 无等待者 → LOST
  assert.equal(t2.status, 'LOST')
  assert.deepEqual(released, ['pool', 'pool2'])
})

test('close 软护栏:ATTACHED 且 60s 内活跃 → terminal-active;force 越过;幂等', () => {
  let clock = 100_000
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {}); svc.readyForOwner('t1').resolve()
  svc.attach('t1', 'c1', { close() {} })
  let closed = 0
  t.release = () => closed++
  const r1 = svc.close('t1', { reason: 'explicit' })     // 刚活跃 → 软护栏
  assert.equal(r1.ok, false); assert.equal(r1.error, 'terminal-active')
  const r2 = svc.close('t1', { reason: 'explicit', force: true })
  assert.equal(r2.ok, true)
  assert.equal(t.status, 'CLOSED')
  assert.equal(closed, 1)                                // releaseBackend 恰一次
  const r3 = svc.close('t1', { reason: 'again' })        // 幂等
  assert.equal(r3.ok, true)
  assert.equal(closed, 1)
})

test('markLost:资源释放 + lastError;CLOSING→DETACHED_TIMEOUT 回滚边', () => {
  let clock = 1000
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  t.release = () => {}
  svc.markLost('t1', 'backend failed')
  assert.equal(t.status, 'LOST')
  assert.equal(t.lastError, 'backend failed')
  // CLOSING 回滚边
  const { terminal: u } = svc.getOrCreate('t2', () => svc.newTerminal({ id: 't2', owner: 'u', serverId: 'sv' }))
  u.status = 'DETACHED_TIMEOUT'
  assert.equal(canTransition('CLOSING', 'DETACHED_TIMEOUT'), true)
})

test('claimClose:CAS 同步认领,仅 DETACHED_TIMEOUT 可认领一次', () => {
  const svc = createTerminalService({ now: () => 1000 })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  t.status = 'DETACHED_TIMEOUT'
  assert.equal(svc.claimClose('t1'), true)
  assert.equal(t.status, 'CLOSING')
  assert.equal(svc.claimClose('t1'), false)              // 已认领
  const { terminal: u } = svc.getOrCreate('t2', () => svc.newTerminal({ id: 't2', owner: 'u', serverId: 'sv' }))
  assert.equal(svc.claimClose('t2'), false)              // 非 DETACHED_TIMEOUT
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/ssh/terminal-service.test.mjs`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现(service 内追加)**

```js
  function releaseBackend(t) {
    try { t.channel?.close?.() } catch { /* noop */ }
    try { t.release?.() } catch { /* noop */ }
    for (const a of t.connIds.values()) { try { a.socket.close() } catch { /* noop */ } }
    t.connIds.clear()
    t.primary = null
  }

  function markLost(tid, reason) {
    const t = map.get(tid); if (!t) return
    t.lastError = String(reason || '')
    if (transition(t, 'LOST', reason)) releaseBackend(t)
  }

  function claimClose(tid) {
    const t = map.get(tid)
    if (!t || t.status !== 'DETACHED_TIMEOUT' || t.closing) return false
    t.closing = true
    transition(t, 'CLOSING', 'reaped-backend-idle')
    return true
  }

  function close(tid, { reason = 'explicit', force = false } = {}) {
    const t = map.get(tid); if (!t) return { ok: false, error: 'unknown-terminal' }
    if (t.status === 'CLOSED') return { ok: true }
    if (t.closing) return { ok: true }
    if (!force && t.status === 'ATTACHED' && now() - t.lastActiveAt < 60_000)
      return { ok: false, error: 'terminal-active' }
    t.closing = true
    transition(t, 'CLOSED', reason)
    return { ok: true }
  }

  function abandon(tid, connId) {
    const t = map.get(tid); if (!t) return
    if (t.status !== 'CREATING') { detach(tid, connId, 'abandon'); return }
    if ((t.waiters || 0) > 0) return                 // 交棒:等待中的重连者接管
    t.lastError = 'create-abandoned'
    if (transition(t, 'LOST', 'create-abandoned')) releaseBackend(t)
  }

  function closeByServer(serverId, reason = 'server-deleted') {
    for (const t of map.values()) {
      if (t.serverId !== serverId || t.status === 'CLOSED') continue
      t.closing = true
      transition(t, 'CLOSED', reason)
    }
  }
```
(注意:`transition` 内对 CLOSED/LOST 调 releaseBackend —— 与各分支的显式释放合流,靠 `released` 断言恰一次校验;实现时把 releaseBackend 收敛为只在 transition 内调用,分支里不再手工调,避免双释放。)

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/ssh/terminal-service.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/ssh/terminal-service.mjs server/ssh/terminal-service.test.mjs
git commit -m "feat(terminal): abandon/markLost/close with soft-guard, CAS claim, release invariants"
```

---

### Task 4: 二段式 sweep(注入时钟)+ boot 对账 + readyForOwner 化

**Files:**
- Modify: `server/ssh/terminal-service.mjs`
- Test: `server/ssh/terminal-service.test.mjs`

**Interfaces:**
- Produces: `sweep(policy, nowTs) → [{tid, action}]`(action ∈ timeout-stage1/timeout-stage2)、`reconcileOnBoot(bootAt) → {reattached, lost}`

- [ ] **Step 1: 写失败测试**

```js
test('二段 sweep:阶段一 DETACHED→DETACHED_TIMEOUT;阶段二(backendIdleMin)→CLOSED;注入时钟毫秒级穷举', () => {
  let clock = 0
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {}); svc.readyForOwner('t1').resolve()
  svc.attach('t1', 'c1', { close() {} })
  clock = 10 * 60 * 1000
  svc.detach('t1', 'c1')                                  // detachedSince=10min
  const policy = { detachedIdleMin: 10, backendIdleMin: 10080 }
  clock = 20 * 60 * 1000                                  // +10min:阶段一
  let ev = svc.sweep(policy, clock)
  assert.equal(t.status, 'DETACHED_TIMEOUT')
  assert.deepEqual(ev, [{ tid: 't1', action: 'timeout-stage1' }])
  clock = 25 * 60 * 1000                                  // 未到 7 天
  ev = svc.sweep(policy, clock)
  assert.equal(t.status, 'DETACHED_TIMEOUT')
  clock = 7 * 24 * 60 * 60 * 1000 + 1                     // 阶段二
  ev = svc.sweep(policy, clock)
  assert.deepEqual(ev, [{ tid: 't1', action: 'timeout-stage2' }])
  assert.equal(t.status, 'CLOSED')
})

test('sweep 不动 ATTACHED/CREATING;boot 对账:ATTACHED→DETACHED(锚点=bootAt),CREATING→LOST', () => {
  let clock = 0
  const svc = createTerminalService({ now: () => clock })
  const a = svc.getOrCreate('ta', () => svc.newTerminal({ id: 'ta', owner: 'u', serverId: 'sv' })).terminal
  const c = svc.getOrCreate('tc', () => svc.newTerminal({ id: 'tc', owner: 'u', serverId: 'sv' })).terminal
  a.status = 'ATTACHED'; c.status = 'CREATING'
  clock = 5 * 60 * 1000
  const r = svc.reconcileOnBoot(clock)
  assert.equal(a.status, 'DETACHED')
  assert.equal(a.detachedSince, clock)
  assert.equal(a.backendIdleSince, clock)
  assert.equal(c.status, 'LOST')
  assert.equal(svc.sweep({ detachedIdleMin: 10, backendIdleMin: 10080 }, clock + 11 * 60 * 1000).length, 0) // a 锚点=boot,未满
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/ssh/terminal-service.test.mjs`
Expected: sweep/reconcileOnBoot FAIL

- [ ] **Step 3: 实现**

```js
  function sweep(policy = {}, nowTs = now()) {
    const s1 = (policy.detachedIdleMin || 0) * 60000
    const s2 = (policy.backendIdleMin || 0) * 60000
    const events = []
    for (const t of map.values()) {
      if (t.status === 'DETACHED' && s1 > 0 && nowTs - (t.detachedSince ?? nowTs) > s1) {
        transition(t, 'DETACHED_TIMEOUT', 'reaped-detached-idle')
        events.push({ tid: t.id, action: 'timeout-stage1' })
      } else if (t.status === 'DETACHED_TIMEOUT' && s2 > 0 && nowTs - (t.backendIdleSince ?? nowTs) > s2) {
        if (claimClose(t.id)) {
          transition(t, 'CLOSED', 'reaped-backend-idle')
          events.push({ tid: t.id, action: 'timeout-stage2' })
        }
      }
    }
    return events
  }

  function reconcileOnBoot(bootAt) {
    let reattached = 0, lost = 0
    for (const t of map.values()) {
      if (t.status === 'CREATING') { t.lastError = 'gateway-restart'; transition(t, 'LOST', 'gateway-restart'); lost++ ; continue }
      if (t.status === 'ATTACHED' || t.status === 'DETACHED' || t.status === 'DETACHED_TIMEOUT') {
        t.status = 'DETACHED'
        t.detachedSince = bootAt
        t.backendIdleSince = bootAt
        reattached++
      }
    }
    return { reattached, lost }
  }
```
(注入时钟:sweep(policy, nowTs) 显式收时刻;index 接线只做 `setInterval(() => service.sweep(getSshSessionPolicy(), Date.now()), 60000)`。)

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/ssh/terminal-service.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/ssh/terminal-service.mjs server/ssh/terminal-service.test.mjs
git commit -m "feat(terminal): two-stage sweep with injectable clock + boot reconcile"
```

---

### Task 5: handler move-only 抽取(createSshTerminalHandler(deps))

**Files:**
- Create: `server/ssh/terminal-handler.mjs`
- Modify: `server/index.mjs`(删除内联 handleSshTerminal,改为工厂调用;handleExec 本任务不动)

**Interfaces:**
- Produces: `createSshTerminalHandler({ sshPool, registry, writeAudit, wsSend, CH }) → async (ws, ps, url)`。
  依赖注入清单(与现内联实现逐项对应):`sshPool.acquire`、`registry(get/ensure/attach/detachBrowser/touch/markOutput/close/closeIf)`、`writeAudit(db,{...})`、`wsSend(ws,type,payload)`、`CH.{ERROR,STDIN,RESIZE,REPLAY,STDOUT}`。`createCloseSentinel/attachSocketToSession/teardownOnOwnerGone` 由本文件直接 import terminal-wire(与现内联一致)。

- [ ] **Step 1: 机械搬移**

把 server/index.mjs 的 `async function handleSshTerminal(ws, ps, url) {...}` 整体移动到
`server/ssh/terminal-handler.mjs`,包成工厂;**逻辑零改动**(git diff 逐行核),闭包引用全部改为
`deps.X`。文件头注释写明「move-only 提交,后续任务在此文件收敛到 TerminalService」。

- [ ] **Step 2: index.mjs 接线**

```js
import { createSshTerminalHandler } from './ssh/terminal-handler.mjs'
const handleSshTerminal = createSshTerminalHandler({
  sshPool, registry: sshTerminals, writeAudit, wsSend,
  CH: { ERROR: CH_ERROR, STDIN: CH_STDIN, RESIZE: CH_RESIZE, REPLAY: CH_REPLAY, STDOUT: CH_STDOUT },
})
```

- [ ] **Step 3: 验证零回归**

Run: `npm test`(全量)
Expected: 全绿;`git diff server/index.mjs` 确认仅删除被搬移函数+新增工厂调用。

- [ ] **Step 4: Commit**

```bash
git add server/ssh/terminal-handler.mjs server/index.mjs
git commit -m "refactor(ssh): extract terminal handler behind deps factory (move-only)"
```

---

### Task 6: index.mjs 清理入口收敛到 TerminalService + registry 退役

**Files:**
- Modify: `server/ssh/terminal-service.mjs`(吸收 registry 语义:list/attach 计数/primary)、`server/index.mjs`、`server/ssh/terminal-wire.mjs`(sockets 源改 service.attachments)
- Delete: `server/ssh/terminal-sessions.mjs`、`server/ssh/terminal-sessions.test.mjs`(用例迁移至 terminal-service.test.mjs:ring 工厂移入 service 后改 import)

**Interfaces:**
- Produces: service 增 `listByServer(serverId)`、`killSession(tid, reason)`(=force close+backend release,替代 killSshSession 依赖)、`createRingBuffer`(自 terminal-sessions 移入)。

- [ ] **Step 1: 7 处入口逐一映射(改前对照,改后逐条勾)**

| # | 现状入口 | 改为 |
|---|---|---|
| ① index.mjs channel 'close' | `sshTerminals.close(sid)` | `service.channelClosed(sid, session)`(内部身份守卫+closeIf 语义收编) |
| ② shellFail | `closeIf(sid, session, …)` | `service.failCreation(sid, session, err)` |
| ③ bail3 属主断开 | `closeIf + 双审计` | `service.abandonOrHandover(sid, session, …)`(waiters 交棒语义内聚) |
| ④ 60s reapByPolicy | registry 内 map.delete | `service.sweep(policy, Date.now())` |
| ⑤ killSshSession(sessions/:sid DELETE) | `sshTerminals.close` | `service.close(tid, {force:true, reason:'manual-kill'})` |
| ⑥ closeSshServerSessions | `closeByServer` | `service.closeByServer(serverId, 'server-deleted')` |
| ⑦ drop → detachBrowser | wire 内 | `service.detach(tid, connId)`(wire 的 attachSocketToSession 签名带 connId) |

- [ ] **Step 2: 逐项改造 + 迁移 terminal-sessions 用例**

`createRingBuffer` 移入 terminal-service.mjs(terminal-wire.test/其他引用同步改 import);
registry 的 closeIf/attach 等价用例并入 terminal-service.test.mjs(已有,核对不缺项后删除旧文件)。

- [ ] **Step 3: 跑全量**

Run: `npm test && npm run test:unit -- --maxWorkers=2`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add -A server/ssh server/index.mjs
git commit -m "refactor(ssh): converge all cleanup entries into TerminalService; retire registry"
```

---

### Task 7: terminal-guard 静态守卫测试

**Files:**
- Create: `server/ssh/terminal-guard.test.mjs`

- [ ] **Step 1: 写守卫(本测试天然应绿——Task 6 已收敛;若红即收敛遗漏)**

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 「禁止裸操作」静态守卫(2026-09-05 方案 P1):sshTerminals/registry 的销毁语义只允许
// 出现在 terminal-service.mjs。模式与 route-auth/overflow-guard 同款。
const ROOT = 'server'
const ALLOWED = /terminal-service\.mjs$/
const PATTERNS = [/\.close\(/, /closeIf\(/, /closeByServer\(/, /reapByPolicy\(/, /Map\.delete\(/]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.mjs') && !p.includes('test')) yield p
  }
}

test('terminal-guard:销毁语义仅存在于 terminal-service.mjs', () => {
  const violations = []
  for (const file of walk(ROOT)) {
    if (ALLOWED.test(file)) continue
    const src = readFileSync(file, 'utf8')
    if (!src.includes('sshTerminals') && !src.includes('registry')) continue
    for (const re of PATTERNS) {
      if (re.test(src)) violations.push(`${file}: ${re}`)
    }
  }
  assert.deepEqual(violations, [])
})
```

- [ ] **Step 2: 跑守卫**

Run: `node --test server/ssh/terminal-guard.test.mjs`
Expected: PASS(若红=Task 6 收敛遗漏,回去补)

- [ ] **Step 3: Commit**

```bash
git add server/ssh/terminal-guard.test.mjs
git commit -m "test(ssh): static guard — destruction semantics live only in TerminalService"
```

---

### Task 8: 竞态回归脚本(handler 级,fake channel 延迟注入)

**Files:**
- Test: `server/ssh/terminal-handler.race.test.mjs`

- [ ] **Step 1: 写三条竞态用例(deps 全假,确定性事件注入而非 sleep)**

```js
// 假池:acquire 可挂起直到测试放行;假 channel:close 事件可延迟 emit。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createSshTerminalHandler } from '../terminal-handler.mjs'
import { createTerminalService } from '../terminal-service.mjs'

function makeDeps() {
  const svc = createTerminalService({ now: () => 1000 })
  const frames = []
  let releaseAcquire
  const channel = {
    listeners: {}, on(ev, fn) { (this.listeners[ev] ||= []).push(fn) },
    emit(ev, ...a) { for (const fn of this.listeners[ev] || []) fn(...a) },
    close() { this.emit('close') }, setWindow() {}, write() {},
  }
  const deps = {
    service: svc,
    sshPool: { acquire: () => new Promise(r => { releaseAcquire = r({ client: { shell: (o, cb) => cb(null, channel) }, release: () => {} }) }) },
    registry: svc,                                   // Task 6 后 handler 直用 service
    writeAudit: () => {}, wsSend: () => {},
    CH: { ERROR: 4, STDIN: 1, RESIZE: 2, REPLAY: 6, STDOUT: 1 },
  }
  return { svc, deps, channel, frames, gate: () => new Promise(r => { releaseAcquire = r }) }
}
```
三条用例(每条独立 deps):①ws 在 acquire gate 放行前 close → handler 返回后 registry 无残留(哨兵 bail);②延迟 close:handler 完成接线后 300ms 才 emit channel close 且期间同 sid 重连 → 新会话存活(closeIf/身份守卫);③双 detach:同 connId 两次 detach → 计数不双减。
(注:②需要 fake 第二条 ws 走 handler 两次——用同一 deps、不同 ws 桩与 url 即可。)

- [ ] **Step 2: 跑测试**

Run: `node --test server/ssh/terminal-handler.race.test.mjs`
Expected: PASS(①②③全绿;任何 flaky = 竞态未真正闭合,修实现不许修测试时序)

- [ ] **Step 3: Commit**

```bash
git add server/ssh/terminal-handler.race.test.mjs
git commit -m "test(ssh): deterministic race scripts for connect-window teardown"
```

---

### Task 9: 收尾门禁

- [ ] `npm test && npm run test:unit -- --maxWorkers=2 && npm run typecheck && npm run build` 全绿
- [ ] `git log --oneline` 核对 8 个提交(T1-T8)+ 身份/尾注合规
- [ ] worktree 合回 main(--no-ff),主仓重跑全量门禁,重建 dist

## Self-Review 记录

- spec 覆盖:§2 状态机(T1-T4)、§2 七操作(T2/T3)、清理入口收敛+守卫(T6/T7)、竞态回归(T8)、
  handler 抽缝(T5)。§5 catalog/§6 REST 属 P2,不在本计划(与 spec §8 分期一致)。
- 已知留白:CH_STATE 帧(P2)、tmux(P3)——spec 已标注。
- 类型一致性:`attach(tid, connId, socket)` 在 T2 定义、T5/T8 消费;`readyForOwner` 仅 T2 内部
  (handler 经 `svc.readyForOwner`)。
