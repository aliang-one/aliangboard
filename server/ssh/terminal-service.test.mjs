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

test('attach CREATING:登记等待者等 ready;ready 后 CREATING→ATTACHED 且 waiters 归零', async () => {
  const svc = createTerminalService({ now: () => 1000 })
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
  const released = []
  const svc = createTerminalService({ now: () => 1000 })
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

test('detach:未知 connId no-op;最后一个 attachment 消失 → DETACHED(detached_since=now);primary 顺延', async () => {
  let clock = 1000
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {})
  svc.readyForOwner('t1').resolve()
  const s1 = { close() {} }, s2 = { close() {} }
  await svc.attach('t1', 'c1', s1); await svc.attach('t1', 'c2', s2)
  clock = 2000
  svc.detach('t1', 'c1')
  assert.equal(t.primary, s2)                    // primary 顺延给剩余 attachment
  svc.detach('t1', 'c1')                         // 幂等:未知 connId no-op
  svc.detach('t1', 'c2', 'ws-close')
  assert.equal(t.status, 'DETACHED')
  assert.equal(t.detachedSince, 2000)
})

test('detach 后重新 attach:DETACHED→ATTACHED 且锚点清空', async () => {
  let clock = 1000
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {}); svc.readyForOwner('t1').resolve()
  await svc.attach('t1', 'c1', { close() {} })
  svc.detach('t1', 'c1'); clock = 5000
  svc.attach('t1', 'c2', { close() {} })
  assert.equal(t.status, 'ATTACHED')
  assert.equal(t.detachedSince, null)
  assert.equal(t.backendIdleSince, null)
})

test('broadcast:到达全部 attachment;markOutput 入 ring', async () => {
  const svc = createTerminalService({ now: () => 1000 })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {}); svc.readyForOwner('t1').resolve()
  const seen = []
  await svc.attach('t1', 'c1', { close() {}, send(type, payload) { seen.push([type, payload]) } })
  svc.markOutput('t1', Buffer.from('hi'))
  svc.broadcast('t1', 9, Buffer.from('x'))
  assert.equal(t.ring.snapshot().toString(), 'hi')
  assert.equal(seen.length, 1)
})

test('abandon:CREATING 无等待者 → LOST(create-abandoned) + 资源释放;有等待者 → 交棒 no-op', async () => {
  const released = []
  const svc = createTerminalService({ now: () => 1000 })
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
  svc.abandon('t2', 'cX')                                // CREATING 无等待者 → LOST + releaseBackend
  assert.equal(t2.status, 'LOST')
  assert.ok(released.includes('pool2'))
  const late = await svc.attach('t2', 'cz', { close() {} })   // LOST 后 attach 拒绝
  assert.equal(late.ok, false)
  assert.equal(late.status, 'LOST')
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

test('markLost:资源释放 + lastError', () => {
  const svc = createTerminalService({ now: () => 1000 })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.markLost('t1', 'backend failed')
  assert.equal(t.status, 'LOST')
  assert.equal(t.lastError, 'backend failed')
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

test('二段 sweep:阶段一 DETACHED→DETACHED_TIMEOUT;阶段二→CLOSED;注入时钟毫秒级穷举', async () => {
  let clock = 0
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', {}); svc.readyForOwner('t1').resolve()
  await svc.attach('t1', 'c1', { close() {} })
  clock = 10 * 60 * 1000
  svc.detach('t1', 'c1')                                  // detachedSince=10min
  const policy = { detachedIdleMin: 10, backendIdleMin: 10080 }
  clock = 20 * 60 * 1000 + 1                              // +10min+1ms:阶段一(严格大于阈值)
  let ev = svc.sweep(policy, clock)
  assert.equal(t.status, 'DETACHED_TIMEOUT')
  assert.deepEqual(ev, [{ tid: 't1', action: 'timeout-stage1' }])
  clock = 25 * 60 * 1000                                  // 未到 7 天
  ev = svc.sweep(policy, clock)
  assert.equal(t.status, 'DETACHED_TIMEOUT')
  clock = t.backendIdleSince + 10080 * 60 * 1000 + 1      // 阶段二:自 backend_idle_since 起 7 天
  ev = svc.sweep(policy, clock)
  assert.deepEqual(ev, [{ tid: 't1', action: 'timeout-stage2' }])
  assert.equal(t.status, 'CLOSED')
})

test('sweep 不动 ATTACHED/CREATING;boot 对账:ATTACHED→DETACHED(锚点=bootAt),CREATING→LOST', async () => {
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
  // a 锚点=bootAt(5min);+11min 时距 boot 11min>10min → 阶段一(锚点自 boot 起算,未被顺延)
  const ev = svc.sweep({ detachedIdleMin: 10, backendIdleMin: 10080 }, clock + 11 * 60 * 1000)
  assert.deepEqual(ev, [{ tid: 'ta', action: 'timeout-stage1' }])
})

test('markBackendFailed:LOST + releaseBackend + 等待者 attach 全收 {ok:false, LOST}', async () => {
  const released = []
  const svc = createTerminalService({ now: () => 1000 })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  t.release = () => released.push('pool')
  const ws = { close() { released.push('ws') } }
  const p = svc.attach('t1', 'c1', ws)
  svc.markBackendFailed('t1', new Error('shell failed'))
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.status, 'LOST')
  assert.equal(res.reason, 'shell failed')
  assert.deepEqual(released, ['pool', 'ws'])
})

// ===== 2026-09-05 v1.0.25 预推审计四阻断修复批次 =====

test('阻断#1:bindRelease 把池句柄挂上终端,LOST 时 releaseBackend 调用之', async () => {
  const released = []
  const svc = createTerminalService({ now: () => 1000 })
  const release = () => released.push('pool')
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindRelease('t1', release)
  assert.equal(t.release, release)
  assert.deepEqual(released, [])                       // 活着不释放
  svc.markLost('t1', 'channel-closed')
  assert.deepEqual(released, ['pool'])                 // LOST → releaseBackend → release()
})

test('阻断#2:CLOSED/LOST 残尸超观测窗被 sweep 驱逐出 map(默认 30min,policy 可覆写)', async () => {
  let clock = 0
  const svc = createTerminalService({ now: () => clock })
  const a = svc.getOrCreate('a', () => svc.newTerminal({ id: 'a', owner: 'u', serverId: 'sv' })).terminal
  const b = svc.getOrCreate('b', () => svc.newTerminal({ id: 'b', owner: 'u', serverId: 'sv' })).terminal
  svc.markLost('a', 'x')
  svc.close('b')
  clock = 29 * 60 * 1000
  svc.sweep({}, clock)                                 // 未到 30min:保留(幂等/对账窗口)
  assert.equal(svc.map.size, 2)
  assert.equal(svc.close('b').ok, true)                // 宽限窗内二次 close 仍幂等 {ok:true}
  clock = 31 * 60 * 1000
  svc.sweep({}, clock)                                 // 默认墓碑窗 30min → 驱逐
  assert.equal(svc.map.size, 0)
  assert.deepEqual(svc.list(), [])
  // policy 覆写窗长
  const c = svc.getOrCreate('c', () => svc.newTerminal({ id: 'c', owner: 'u', serverId: 'sv' })).terminal
  svc.markLost('c', 'x')
  svc.sweep({ closedTombstoneMin: 5 }, clock + 6 * 60 * 1000)
  assert.equal(svc.map.size, 0)
})

test('阻断#3a:最长寿命硬上限——任何活态超龄 CAS 关闭(policy.maxLifetimeMin 重新生效)', async () => {
  let clock = 0
  const svc = createTerminalService({ now: () => clock })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', { close() {} }); svc.readyForOwner('t1').resolve()
  await svc.attach('t1', 'c1', { close() {} })
  clock = 4 * 60 * 1000
  svc.sweep({ maxLifetimeMin: 5 }, clock)
  assert.equal(t.status, 'ATTACHED')                   // 未超龄不动
  clock = 5 * 60 * 1000 + 1
  const ev = svc.sweep({ maxLifetimeMin: 5 }, clock)
  assert.equal(t.status, 'CLOSED')
  assert.deepEqual(ev, [{ tid: 't1', action: 'reaped-max-lifetime' }])
})

test('阻断#3b:挂机回收回归——ATTACHED 静默超限关闭,输出=活动续命(非对称时钟口径)', async () => {
  // markOutput 须记 lastOutputAt(输出=活动;attachedIdle 看 max(lastActive,lastOutput))
  let clock = 0
  const mk = () => createTerminalService({ now: () => clock })
  const svc0 = mk()
  const { terminal: t } = svc0.getOrCreate('t1', () => svc0.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  clock = 6 * 60 * 1000
  svc0.markOutput('t1', Buffer.from('build ok'))
  assert.equal(t.lastOutputAt, clock)
  // 场景隔离(独立 service):输出后静默 1min → 续命;6min → 超限回收
  const svc = mk()
  const { terminal: u } = svc.getOrCreate('t2', () => svc.newTerminal({ id: 't2', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t2', { close() {} }); svc.readyForOwner('t2').resolve()
  await svc.attach('t2', 'c2', { close() {} })
  clock = 5 * 60 * 1000; svc.markOutput('t2', Buffer.from('x'))
  clock = 6 * 60 * 1000 + 1
  const ev = svc.sweep({ attachedIdleMin: 5 }, clock)  // 距最后输出 1min:续命,不回收
  assert.equal(u.status, 'ATTACHED')
  assert.deepEqual(ev, [])
  clock += 5 * 60 * 1000                               // 距最后输出 6min:超限
  const ev2 = svc.sweep({ attachedIdleMin: 5 }, clock)
  assert.equal(u.status, 'CLOSED')
  assert.deepEqual(ev2, [{ tid: 't2', action: 'reaped-attached-idle' }])
})

// ===== 2026-09-05 评审批(v1025-fixbatch-review)#1/#3/#5 =====

test('评审#1:releaseBackend 幂等——LOST 后再 force-close/closeByServer,pool release 只调一次', async () => {
  let clock = 0
  const svc = createTerminalService({ now: () => clock })
  let releases = 0
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', { close() {} }); svc.readyForOwner('t1').resolve()
  await svc.attach('t1', 'c1', { close() {} })
  svc.bindRelease('t1', () => { releases++ })
  svc.markLost('t1', 'channel-closed')          // 第一次 releaseBackend(release #1)
  assert.equal(releases, 1)
  const r = svc.close('t1', { force: true })    // close 不跳过 LOST → 二次 transition → 不得二跳
  assert.equal(r.ok, true)
  assert.equal(t.status, 'CLOSED')
  assert.equal(releases, 1, 'release 幂等:残尸二次转换不得再还池句柄(pool.mjs 是裸 refs--)')
  svc.closeByServer('sv')                       // closeByServer 只跳过 CLOSED——LOST 场景同理
  assert.equal(releases, 1)
})

test('评审#3:进入终态即弃 ring(≤4MB 不占墓碑窗);残尸 markOutput 安全不抛', () => {
  const svc = createTerminalService({ now: () => 1000 })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.markOutput('t1', Buffer.from('data'))
  svc.markLost('t1', 'x')
  assert.equal(t.ring, null, '终态即弃 ring(lifecycle spec)')
  svc.markOutput('t1', Buffer.from('late'))     // 残尸输出(迟到回调)不得炸
})

test('评审#5:onIrreversible 收窄到 CLOSED/LOST——attach/detach 不再刷 verb:close 审计行', async () => {
  const events = []
  const svc = createTerminalService({ now: () => 1000, onIrreversible: e => events.push(e.event) })
  const { terminal: t } = svc.getOrCreate('t1', () => svc.newTerminal({ id: 't1', owner: 'u', serverId: 'sv' }))
  svc.bindChannel('t1', { close() {} }); svc.readyForOwner('t1').resolve()
  await svc.attach('t1', 'c1', { close() {} })   // CREATING→ATTACHED
  svc.detach('t1', 'c1')                         // ATTACHED→DETACHED
  svc.markLost('t1', 'x')                        // DETACHED→LOST
  assert.deepEqual(events, ['LOST'], '分级审计:只有不可逆终态进审计,高频 attach/detach 走行内字段')
})
