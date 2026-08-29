import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createRingBuffer, createTerminalRegistry } from './terminal-sessions.mjs'

test('环形缓冲:超 maxLines 丢最老行;snapshot 为字节拼接;中文 UTF-8 完整', () => {
  const rb = createRingBuffer(3)
  rb.push('a\n'); rb.push('bb\n'); rb.push('ccc\n'); rb.push('中文\n'); rb.push('e\n')
  const snap = rb.snapshot().toString('utf8')
  assert.deepEqual(snap.split('\n').filter(Boolean), ['ccc', '中文', 'e'])
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
  const reg = createTerminalRegistry({ idleReapMs: 600000, now: () => t })
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

test('reapIdle: 仅回收「无浏览器 且 空闲超阈」;close 即刻回收;touch 续命', () => {
  let t = 1000
  const reg = createTerminalRegistry({ idleReapMs: 600000, now: () => t })
  const reaped = []
  const s = reg.ensure('a', {}, () => ({ channel: 1 }))
  reg.attach('a')
  t = 1000 + 500000; reg.touch('a')          // 有浏览器:不回收
  reg.reapIdle(x => reaped.push(x.sid))
  assert.equal(reaped.length, 0)
  reg.detachBrowser('a')
  t = 1000 + 500000 + 590000
  reg.reapIdle(x => reaped.push(x.sid))       // 距 lastActive 不满 10min
  assert.equal(reaped.length, 0)
  t += 20000                                   // 突破 10min
  reg.reapIdle(x => reaped.push(x.sid))
  assert.deepEqual(reaped, ['a'])
  assert.equal(reg.get('a'), null)
  // close 即刻
  const s2 = reg.ensure('b', {}, () => ({}))
  let closed = false
  reg.close('b', () => { closed = true })
  assert.ok(closed); assert.equal(reg.get('b'), null); assert.ok(s2)
})
