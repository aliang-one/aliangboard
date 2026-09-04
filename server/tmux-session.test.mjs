import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  hashToken, tmuxLabel, tmuxSessionName, probeKey,
  tmuxProbeCommand, isTmuxPresent, tmuxKillCommand, tmuxAttachCommand,
  planExec, pickStaleSids,
  tmuxCaptureCommand, tmuxAttachOnlyCommand, tmuxNewSessionDetached, tmuxHasSessionCommand, hasHistoryFromCapture,
  archFromUname, injectDestCandidates, withTermInfo,
  shellProbeCommand, pickShellFromProbe, isKnownShell,
  tmuxConfContent, confDestCandidates,
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
    ['env', 'TERMINFO=/dev/shm/.ab-terminfo', 'TMUX_TMPDIR=/dev/shm', 'TERM=xterm-256color', '/x/tmux', '-L', 'ab1'])
  // terminfoDir without /.ab-terminfo suffix → tmpDir = terminfoDir as-is (no strip)
  assert.equal(withTermInfo('/d/.ti', ['/x/tmux'])[2], 'TMUX_TMPDIR=/d/.ti')
})

test('tty builders thread terminfoDir; kill does NOT (socket-only)', () => {
  // no terminfoDir → no env prefix (backward compat)
  assert.deepEqual(tmuxAttachOnlyCommand('L', 'N', '/x/tmux'), ['/x/tmux', '-L', 'L', 'attach-session', '-t', 'N'])
  // terminfoDir → env prefix on attach / capture / new-session
  assert.deepEqual(tmuxAttachOnlyCommand('L', 'N', '/x/tmux', '/d/.ti'),
    ['env', 'TERMINFO=/d/.ti', 'TMUX_TMPDIR=/d/.ti', 'TERM=xterm-256color', '/x/tmux', '-L', 'L', 'attach-session', '-t', 'N'])
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

test('tmuxNewSessionDetached: new-session -d (detached create) with env prefix', () => {
  // no terminfoDir → plain (no env)
  assert.deepEqual(tmuxNewSessionDetached({ tmuxBin: '/x/tmux', label: 'L', name: 'N', cols: 80, rows: 24, shell: ['sh'] }),
    ['/x/tmux', '-L', 'L', 'new-session', '-d', '-s', 'N', '-x', '80', '-y', '24', '--', 'sh'])
  // with terminfoDir → env prefix + -d (not -A)
  const c = tmuxNewSessionDetached({ tmuxBin: '/dev/shm/.ab-tmux-amd64', terminfoDir: '/dev/shm/.ab-terminfo', label: 'ab1', name: 's1', cols: 100, rows: 30, shell: ['bash'] })
  assert.equal(c[0], 'env')
  assert.equal(c.at(-1), 'bash')
  assert.ok(c.includes('-d'), 'detached (-d), not -A')
  assert.ok(!c.includes('-A'), 'must NOT have -A')
})

test('tmuxHasSessionCommand: has-session -t name (with env for socket dir)', () => {
  assert.deepEqual(tmuxHasSessionCommand('L', 'N', '/x/tmux'),
    ['/x/tmux', '-L', 'L', 'has-session', '-t', 'N'])
  const c = tmuxHasSessionCommand('L', 'N', '/dev/shm/.ab-tmux-amd64', '/dev/shm/.ab-terminfo')
  assert.equal(c[0], 'env')
  assert.ok(c.includes('TMUX_TMPDIR=/dev/shm'), 'sets TMUX_TMPDIR so it finds the injected socket')
  assert.ok(c.includes('has-session'))
})

// ---- confPath:tmux 只在 new-session 启动 server 时读 conf,只有 new-session 系构造器需要 -f ----
// 目的:pane 内 TERM 默认是 tmux default-terminal(裸 screen),注入 terminfo 里没有该条目 →
// shell 行编辑(方向键)错乱。conf 把 default-terminal 定到 screen-256color(tar 已含该条目)。

test('tmuxConfContent: set -g default-terminal "screen-256color"', () => {
  const c = tmuxConfContent()
  assert.match(c, /set -g default-terminal "screen-256color"/)
})

test('tmuxNewSessionDetached: confPath → -f <conf> 紧跟 tmuxBin(含 env 前缀时在 env 之后)', () => {
  const plain = tmuxNewSessionDetached({ tmuxBin: '/x/tmux', confPath: '/d/.ab-tmux.conf', label: 'L', name: 'N', cols: 80, rows: 24, shell: ['sh'] })
  assert.deepEqual(plain.slice(0, 4), ['/x/tmux', '-f', '/d/.ab-tmux.conf', '-L'])
  const envied = tmuxNewSessionDetached({ tmuxBin: '/x/tmux', terminfoDir: '/d/.ti', confPath: '/d/.ab-tmux.conf', label: 'L', name: 'N', cols: 80, rows: 24, shell: ['sh'] })
  assert.deepEqual(envied.slice(0, 7), ['env', 'TERMINFO=/d/.ti', 'TMUX_TMPDIR=/d/.ti', 'TERM=xterm-256color', '/x/tmux', '-f', '/d/.ab-tmux.conf'])
})

test('tmuxAttachCommand: confPath → -f <conf> 紧跟 tmuxBin;无 confPath 时不变', () => {
  const c = tmuxAttachCommand({ tmuxBin: '/x/tmux', confPath: '/d/.ab-tmux.conf', label: 'L', name: 'N', cols: 80, rows: 24, shell: ['bash'] })
  assert.deepEqual(c.slice(0, 4), ['/x/tmux', '-f', '/d/.ab-tmux.conf', '-L'])
  const noConf = tmuxAttachCommand({ label: 'L', name: 'N', cols: 80, rows: 24, shell: ['sh'] })
  assert.ok(!noConf.includes('-f'), 'no confPath → no -f flag (backward compat)')
})

test('confDestCandidates: /dev/shm 优先(RO-rootfs 可写),/tmp 兜底;system/injected 两路共用', () => {
  assert.deepEqual(confDestCandidates(), ['/dev/shm/.ab-tmux.conf', '/tmp/.ab-tmux.conf'])
})

// ---- shell 智能探测：默认 sh 在 Debian 系镜像=dash,无 tab 补全;探测改用 bash 优先 ----

test('shellProbeCommand: 单发探测,按优先级输出首个命中的 shell 名', () => {
  const c = shellProbeCommand()
  assert.equal(c[0], 'sh')
  assert.equal(c[1], '-c')
  // 优先级链必须 bash 在前(sh/dash 无补全);输出为单个 shell 名
  assert.match(c[2], /^for s in bash/)
  assert.ok(c[2].includes('command -v'))
})

test('pickShellFromProbe: 按优先级取输出行,回退 sh', () => {
  assert.equal(pickShellFromProbe(Buffer.from('bash\n')), 'bash')
  assert.equal(pickShellFromProbe(Buffer.from('ash\n')), 'ash')
  assert.equal(pickShellFromProbe(Buffer.from('  zsh \n')), 'zsh')
  // 空输出/异常 → sh(与旧行为一致)
  assert.equal(pickShellFromProbe(Buffer.alloc(0)), 'sh')
  assert.equal(pickShellFromProbe(Buffer.from('   \n')), 'sh')
  assert.equal(pickShellFromProbe(null), 'sh')
  assert.equal(pickShellFromProbe(undefined), 'sh')
  // 多行(理论上不会发生,防御) → 取首个非空行
  assert.equal(pickShellFromProbe(Buffer.from('\nzsh\nbash\n')), 'zsh')
  // 探测输出了未知 shell 名 → 不透传,回退 sh(防注入任意 argv)
  assert.equal(pickShellFromProbe(Buffer.from('bash; rm -rf /\n')), 'sh')
  assert.equal(pickShellFromProbe(Buffer.from('/bin/bash\n')), 'sh')
})

test('isKnownShell: 只认可白名单内的 shell 名', () => {
  assert.equal(isKnownShell('bash'), true)
  assert.equal(isKnownShell('zsh'), true)
  assert.equal(isKnownShell('ash'), true)
  assert.equal(isKnownShell('dash'), true)
  assert.equal(isKnownShell('sh'), true)
  assert.equal(isKnownShell(''), false)
  assert.equal(isKnownShell('/bin/bash'), false)
  assert.equal(isKnownShell('bash -l'), false)
})

test('tmuxConfContent: window-size largest——多客户端不同窗口尺寸不互相压扁(2026-09-04 症状2)', () => {
  const c = tmuxConfContent()
  assert.match(c, /set -g default-terminal "screen-256color"/)
  assert.match(c, /set -g window-size largest/)
})

test('pickStaleSids: attached>0 豁免——正在看的终端不被「30min 无键入」误杀', () => {
  const now = 10_000
  const tracker = new Map([
    ['ab1-busy', { token: 't1', lastActiveAt: 1_000, attached: 1 }],   // 超时但有人附着
    ['ab1-idle', { token: 't2', lastActiveAt: 1_000, attached: 0 }],   // 超时且无人
    ['ab1-noflag', { token: 't3', lastActiveAt: 1_000 }],              // 旧 meta 无字段:视为无人
  ])
  assert.deepEqual(pickStaleSids(now, tracker, 5_000), ['ab1-idle', 'ab1-noflag'])
})
