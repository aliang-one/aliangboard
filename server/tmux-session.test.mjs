import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  hashToken, tmuxLabel, tmuxSessionName, probeKey,
  tmuxProbeCommand, isTmuxPresent, tmuxKillCommand, tmuxAttachCommand,
  planExec, pickStaleSids,
} from './tmux-session.mjs'

test('hashToken: first 8 hex of sha256, stable', () => {
  assert.equal(hashToken('tok-A').length, 8)
  assert.match(hashToken('tok-A'), /^[0-9a-f]{8}$/)
  assert.equal(hashToken('tok-A'), hashToken('tok-A'), 'stable for same input')
  assert.notEqual(hashToken('tok-A'), hashToken('tok-B'), 'differs for different input')
})

test('tmuxLabel / tmuxSessionName: ab-prefixed, label prefixes name', () => {
  assert.equal(tmuxLabel('tok-A'), 'ab' + hashToken('tok-A'))
  assert.equal(tmuxSessionName('tok-A', 'term-1'), tmuxLabel('tok-A') + '-term-1')
  assert.notEqual(tmuxLabel('tok-A'), tmuxLabel('tok-B'), 'different users → different labels')
})

test('probeKey: stable per (ns,pod,container)', () => {
  assert.equal(probeKey('default', 'web-1', 'main'), 'default/web-1/main')
  assert.notEqual(probeKey('default', 'web-1', 'main'), probeKey('default', 'web-2', 'main'))
})

test('tmuxProbeCommand: sh -c "command -v tmux"', () => {
  assert.deepEqual(tmuxProbeCommand(), ['sh', '-c', 'command -v tmux'])
})

test('isTmuxPresent: true iff stdout has non-empty trimmed output', () => {
  assert.equal(isTmuxPresent({ stdout: Buffer.from('/usr/bin/tmux') }), true)
  assert.equal(isTmuxPresent({ stdout: Buffer.from('  \n ') }), false)
  assert.equal(isTmuxPresent({ stdout: Buffer.alloc(0) }), false)
  assert.equal(isTmuxPresent({}), false)
  assert.equal(isTmuxPresent(null), false)
})

test('tmuxKillCommand: tmux -L <label> kill-session -t <name>', () => {
  assert.deepEqual(tmuxKillCommand('abDEADBEEF', 'abDEADBEEF-term-1'),
    ['tmux', '-L', 'abDEADBEEF', 'kill-session', '-t', 'abDEADBEEF-term-1'])
})

test('tmuxAttachCommand: new-session -A with size + shell spread after --', () => {
  assert.deepEqual(tmuxAttachCommand({ label: 'abDEADBEEF', name: 'abDEADBEEF-term-1', cols: 80, rows: 24, shell: ['sh'] }),
    ['tmux', '-L', 'abDEADBEEF', 'new-session', '-A', '-s', 'abDEADBEEF-term-1', '-x', '80', '-y', '24', '--', 'sh'])
  const custom = tmuxAttachCommand({ label: 'L', name: 'N', cols: 100, rows: 30, shell: ['bash', '-l'] })
  assert.deepEqual(custom.slice(-2), ['bash', '-l'])
})

test('planExec: attach mode → ephemeral, command unchanged', () => {
  const r = planExec({ mode: 'attach', tmuxPresent: true, sid: 's1', token: 'tok', cols: 80, rows: 24, command: ['/bin/sh'] })
  assert.equal(r.persistent, false)
  assert.equal(r.kind, 'attach')
  assert.deepEqual(r.command, ['/bin/sh'])
})

test('planExec: exec + no tmux → ephemeral fallback, command unchanged', () => {
  const r = planExec({ mode: null, tmuxPresent: false, sid: 's1', token: 'tok', cols: 80, rows: 24, command: ['sh'] })
  assert.equal(r.persistent, false)
  assert.equal(r.kind, 'ephemeral')
  assert.deepEqual(r.command, ['sh'])
})

test('planExec: exec + tmux but no sid → ephemeral (cannot persist without stable sid)', () => {
  const r = planExec({ mode: null, tmuxPresent: true, sid: '', token: 'tok', cols: 80, rows: 24, command: ['sh'] })
  assert.equal(r.persistent, false)
  assert.equal(r.kind, 'ephemeral')
  assert.deepEqual(r.command, ['sh'])
})

test('planExec: exec + tmux + sid → persistent tmux wrap', () => {
  const r = planExec({ mode: null, tmuxPresent: true, sid: 'term-1', token: 'tok-A', cols: 80, rows: 24, command: ['sh'] })
  assert.equal(r.persistent, true)
  assert.equal(r.kind, 'tmux')
  assert.deepEqual(r.command, tmuxAttachCommand({ label: tmuxLabel('tok-A'), name: tmuxSessionName('tok-A', 'term-1'), cols: 80, rows: 24, shell: ['sh'] }))
})

test('pickStaleSids: returns names whose lastActiveAt older than ttl', () => {
  const now = 10_000
  const tracker = {
    'ab1-termA': { token: 't1', lastActiveAt: 9_000 },   // fresh
    'ab1-termB': { token: 't2', lastActiveAt: 1_000 },   // stale
    'ab1-termC': { token: 't3', lastActiveAt: 5_000 },   // exactly ttl → not stale
  }
  assert.deepEqual(pickStaleSids(now, tracker, 5_000), ['ab1-termB'])
  assert.deepEqual(pickStaleSids(now, {}, 5_000), [])
})
