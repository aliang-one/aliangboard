import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  hashToken, tmuxLabel, tmuxSessionName, probeKey,
  tmuxProbeCommand, isTmuxPresent, tmuxKillCommand, tmuxAttachCommand,
  planExec, pickStaleSids,
  tmuxCaptureCommand, tmuxAttachOnlyCommand, hasHistoryFromCapture,
  archFromUname, injectDestCandidates, withTermInfo,
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
  const tracker = new Map([
    ['ab1-termA', { token: 't1', lastActiveAt: 9_000 }],   // fresh
    ['ab1-termB', { token: 't2', lastActiveAt: 1_000 }],   // stale
    ['ab1-termC', { token: 't3', lastActiveAt: 5_000 }],   // exactly ttl → not stale
  ])
  assert.deepEqual(pickStaleSids(now, tracker, 5_000), ['ab1-termB'])
  assert.deepEqual(pickStaleSids(now, new Map(), 5_000), [])
})

test('tmuxCaptureCommand: capture-pane -e -p -S -lines -t name (depth floored at 1)', () => {
  assert.deepEqual(tmuxCaptureCommand('abDEADBEEF', 'abDEADBEEF-t1', 2000),
    ['tmux', '-L', 'abDEADBEEF', 'capture-pane', '-e', '-p', '-S', '-2000', '-t', 'abDEADBEEF-t1'])
  assert.equal(tmuxCaptureCommand('L', 'N', 0)[7], '-1', 'lines floored to 1 → -S -1')
})

test('tmuxAttachOnlyCommand: attach-session -t name (no -A, no new-session)', () => {
  assert.deepEqual(tmuxAttachOnlyCommand('abDEADBEEF', 'abDEADBEEF-t1'),
    ['tmux', '-L', 'abDEADBEEF', 'attach-session', '-t', 'abDEADBEEF-t1'])
})

test('hasHistoryFromCapture: true iff stdout is a non-empty trimmed Buffer', () => {
  assert.equal(hasHistoryFromCapture({ stdout: Buffer.from('Serving HTTP on 0.0.0.0 port 8080\n') }), true)
  assert.equal(hasHistoryFromCapture({ stdout: Buffer.from('  \n \t ') }), false)
  assert.equal(hasHistoryFromCapture({ stdout: Buffer.alloc(0) }), false)
  assert.equal(hasHistoryFromCapture({ stdout: 'not-a-buffer' }), false, 'non-Buffer stdout → false')
  assert.equal(hasHistoryFromCapture({}), false)
  assert.equal(hasHistoryFromCapture(null), false)
})

test('archFromUname: x86_64/amd64 → amd64; aarch64/arm64 → arm64; else null', () => {
  assert.equal(archFromUname('x86_64'), 'amd64')
  assert.equal(archFromUname('AMD64'), 'amd64')
  assert.equal(archFromUname('aarch64'), 'arm64')
  assert.equal(archFromUname('arm64\n'), 'arm64')
  assert.equal(archFromUname('armv7l'), null)
  assert.equal(archFromUname('s390x'), null)
  assert.equal(archFromUname(''), null)
  assert.equal(archFromUname(null), null)
})

test('injectDestCandidates: /dev/shm first (RO-rootfs-safe), then /tmp', () => {
  assert.deepEqual(injectDestCandidates('amd64'), ['/dev/shm/.ab-tmux-amd64', '/tmp/.ab-tmux-amd64'])
})

test('command builders accept trailing tmuxBin (default tmux, backward-compat)', () => {
  assert.deepEqual(tmuxKillCommand('L', 'N'), ['tmux', '-L', 'L', 'kill-session', '-t', 'N'])
  assert.deepEqual(tmuxKillCommand('L', 'N', '/dev/shm/.ab-tmux-amd64'),
    ['/dev/shm/.ab-tmux-amd64', '-L', 'L', 'kill-session', '-t', 'N'])
  assert.deepEqual(tmuxAttachOnlyCommand('L', 'N', '/x/tmux'),
    ['/x/tmux', '-L', 'L', 'attach-session', '-t', 'N'])
  assert.deepEqual(tmuxCaptureCommand('L', 'N', 2000, '/x/tmux')[0], '/x/tmux')
  assert.deepEqual(tmuxAttachCommand({ tmuxBin: '/x/tmux', label: 'L', name: 'N', cols: 80, rows: 24, shell: ['sh'] })[0], '/x/tmux')
})

test('planExec threads tmuxBin into the attach command', () => {
  const r = planExec({ mode: null, tmuxPresent: true, tmuxBin: '/dev/shm/.ab-tmux-arm64', sid: 't1', token: 'tok', cols: 80, rows: 24, command: ['sh'] })
  assert.equal(r.persistent, true)
  assert.equal(r.command[0], '/dev/shm/.ab-tmux-arm64', 'planExec uses the injected bin as argv[0]')
})

test('withTermInfo: passthrough when no terminfoDir; prepend env when set', () => {
  assert.deepEqual(withTermInfo('', ['tmux', '-V']), ['tmux', '-V'])
  assert.deepEqual(withTermInfo('/dev/shm/.ab-terminfo', ['/x/tmux', '-L', 'ab1']),
    ['env', 'TERMINFO=/dev/shm/.ab-terminfo', 'TERM=xterm-256color', '/x/tmux', '-L', 'ab1'])
})

test('tty builders thread terminfoDir; kill does NOT (socket-only)', () => {
  // no terminfoDir → no env prefix (backward compat)
  assert.deepEqual(tmuxAttachOnlyCommand('L', 'N', '/x/tmux'), ['/x/tmux', '-L', 'L', 'attach-session', '-t', 'N'])
  // terminfoDir → env prefix on attach / capture / new-session
  assert.deepEqual(tmuxAttachOnlyCommand('L', 'N', '/x/tmux', '/d/.ti'),
    ['env', 'TERMINFO=/d/.ti', 'TERM=xterm-256color', '/x/tmux', '-L', 'L', 'attach-session', '-t', 'N'])
  assert.equal(tmuxCaptureCommand('L', 'N', 2000, '/x/tmux', '/d/.ti')[0], 'env')
  assert.equal(tmuxAttachCommand({ tmuxBin: '/x/tmux', terminfoDir: '/d/.ti', label: 'L', name: 'N', cols: 80, rows: 24, shell: ['sh'] })[0], 'env')
  // kill ignores terminfoDir entirely (no tty) — still 3-arg shape
  assert.deepEqual(tmuxKillCommand('L', 'N', '/x/tmux'), ['/x/tmux', '-L', 'L', 'kill-session', '-t', 'N'])
})

test('planExec threads terminfoDir into the attach command', () => {
  const r = planExec({ mode: null, tmuxPresent: true, tmuxBin: '/x/tmux', terminfoDir: '/d/.ti', sid: 't1', token: 'tok', cols: 80, rows: 24, command: ['sh'] })
  assert.equal(r.command[0], 'env', 'env prefix applied when terminfoDir set')
  assert.equal(r.command[1], 'TERMINFO=/d/.ti')
})
