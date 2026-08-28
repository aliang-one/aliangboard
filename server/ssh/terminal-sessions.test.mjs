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
