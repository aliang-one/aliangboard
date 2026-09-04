import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createRingBuffer, createTerminalRegistry } from './terminal-sessions.mjs'

test('环形缓冲:按字节封顶,超限丢最老块;snapshot 为原始字节拼接', () => {
  const rb = createRingBuffer(10)
  rb.push('12345'); rb.push('67890')
  assert.equal(rb.byteLength(), 10)
  rb.push('abc')                                // 13 > 10 → 丢最老块 '12345'
  assert.equal(rb.byteLength(), 8)
  assert.equal(rb.snapshot().toString('utf8'), '67890abc')
  rb.push('')                                   // 空块 no-op
  assert.equal(rb.byteLength(), 8)
})

test('环形缓冲:单块超预算保尾截断(无换行大流/超长单行不打爆堆,2026-09-04 P1)', () => {
  const rb = createRingBuffer(8)
  rb.push('abcdefghij')                         // 10 > 8 → 保尾 8 字节
  assert.equal(rb.byteLength(), 8)
  assert.equal(rb.snapshot().toString('utf8'), 'cdefghij')
})

test('环形缓冲:原始字节保真——ANSI/CRLF/无换行流不被按行切分重排(回放不再失真)', () => {
  const rb = createRingBuffer(1024)
  rb.push('\x1b[2J\x1b[H画屏\r\n无换行')
  rb.push('续流\x1b[1A')
  assert.equal(rb.snapshot().toString('utf8'), '\x1b[2J\x1b[H画屏\r\n无换行续流\x1b[1A')
})

test('环形缓冲:跨块 UTF-8 多字节字符完整(Buffer 边界切在字符中间不丢字节)', () => {
  const rb = createRingBuffer(1024)
  const full = Buffer.from('中文abc', 'utf8')
  rb.push(full.subarray(0, 4))                  // '中' + '文'首字节
  rb.push(full.subarray(4))
  assert.equal(rb.snapshot().toString('utf8'), '中文abc')
})

test('registry: ensure 复用同 sid(工厂只调一次);attach/detach 维护 browserCount', () => {
  let made = 0
  const reg = createTerminalRegistry({})
  const s1 = reg.ensure('sid1', { serverId: 'sv', userId: 'u' }, () => { made++; return { channel: 'x' } })
  const s2 = reg.ensure('sid1', { serverId: 'sv', userId: 'u' }, () => { made++; return {} })
  assert.equal(made, 1)
  assert.equal(s1.extra.channel, 'x')
  reg.attach('sid1')
  assert.equal(reg.get('sid1').browserCount, 1)
  reg.attach('sid1'); reg.detachBrowser('sid1')
  assert.equal(reg.get('sid1').browserCount, 1)
  assert.equal(reg.attach('nope'), null)
})

test('list: 存活会话快照含属主/附着数/空闲时长,供观测端点与任务栏对账', () => {
  let t = 5000
  const reg = createTerminalRegistry({ now: () => t })
  reg.ensure('s1', { serverId: 'sv1', userId: 'alice' }, () => ({}))
  reg.ensure('s2', { serverId: 'sv2', userId: 'bob' }, () => ({}))
  reg.attach('s1')                       // alice 在看
  t += 120000                            // s2 无人附着,已空闲 2min
  const rows = reg.list()
  assert.equal(rows.length, 2)
  const s1 = rows.find(r => r.sid === 's1')
  const s2 = rows.find(r => r.sid === 's2')
  assert.deepEqual(
    { sid: s1.sid, serverId: s1.serverId, userId: s1.userId, browserCount: s1.browserCount, idleMs: s1.idleMs },
    { sid: 's1', serverId: 'sv1', userId: 'alice', browserCount: 1, idleMs: 120000 },
  )
  assert.equal(s2.browserCount, 0)
  assert.equal(s2.idleMs, 120000)
  // close 后从列表消失
  reg.close('s2')
  assert.equal(reg.list().length, 1)
})

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

test('reapByPolicy: 仅回收「无浏览器 且 空闲超阈」;close 即刻回收;touch 续命', () => {
  let t = 1000
  const reg = createTerminalRegistry({ now: () => t })
  const policy = { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 }
  const reaped = []
  const s = reg.ensure('a', {}, () => ({ channel: 1 }))
  reg.attach('a')
  t = 1000 + 500000; reg.touch('a')          // 有浏览器:不回收
  reg.reapByPolicy(policy, x => reaped.push(x.sid))
  assert.equal(reaped.length, 0)
  reg.detachBrowser('a')
  t = 1000 + 500000 + 590000
  reg.reapByPolicy(policy, x => reaped.push(x.sid))       // 距 lastActive 不满 10min
  assert.equal(reaped.length, 0)
  t += 20000                                   // 突破 10min
  reg.reapByPolicy(policy, x => reaped.push(x.sid))
  assert.deepEqual(reaped, ['a'])
  assert.equal(reg.get('a'), null)
  // close 即刻
  const s2 = reg.ensure('b', {}, () => ({}))
  let closed = false
  reg.close('b', () => { closed = true })
  assert.ok(closed); assert.equal(reg.get('b'), null); assert.ok(s2)
})
