// Pure helpers + decision logic for tmux-backed persistent terminals.
// No k8s / WebSocket / DB access here — everything is unit-testable.
// Wrapping/wiring lives in server/index.mjs (handleExec, DELETE handler, idle sweeper).

import { createHash } from 'node:crypto'

export function hashToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex').slice(0, 8)
}

// tmux socket label: per-user isolation (one socket per platform user / k8s token).
export function tmuxLabel(token) {
  return 'ab' + hashToken(token)
}

// tmux session name: label + stable card id. sid = frontend terminal.id.
export function tmuxSessionName(token, sid) {
  return `${tmuxLabel(token)}-${sid}`
}

export function probeKey(namespace, pod, container) {
  return `${namespace}/${pod}/${container || ''}`
}

// `command -v tmux` via sh: prints the path (exit 0) iff tmux is on PATH.
export function tmuxProbeCommand() {
  return ['sh', '-c', 'command -v tmux']
}

// probe success iff stdout has non-empty trimmed output
export function isTmuxPresent(probeResult) {
  const out = probeResult?.stdout
  return !!out && Buffer.isBuffer(out) && out.toString('utf8').trim().length > 0
}

// 最小镜像无 terminfo 库 → tmux 报 "can't find terminfo database";只读 /tmp 的 pod → tmux 建不了 socket。
// 有 terminfoDir 时给命令前缀 env TERMINFO/TMUX_TMPDIR/TERM:TMUX_TMPDIR 取注入用的可写基目录
// (= terminfoDir 去掉 /.ab-terminfo 后缀),让 socket 也落到 /dev/shm 之类可写处。kill 纯 socket,不用。
export function withTermInfo(terminfoDir, argv) {
  if (!terminfoDir) return argv
  const tmpDir = terminfoDir.replace(/\/\.ab-terminfo$/, '')
  return ['env', `TERMINFO=${terminfoDir}`, `TMUX_TMPDIR=${tmpDir}`, 'TERM=xterm-256color', ...argv]
}

export function tmuxKillCommand(label, name, tmuxBin = 'tmux') {
  return [tmuxBin, '-L', label, 'kill-session', '-t', name]
}

// -A = attach if session exists, else create. shell array is spread after `--`.
export function tmuxAttachCommand({ tmuxBin = 'tmux', terminfoDir = '', label, name, cols, rows, shell }) {
  return withTermInfo(terminfoDir, [tmuxBin, '-L', label, 'new-session', '-A', '-s', name,
    '-x', String(cols || 80), '-y', String(rows || 24), '--', ...(shell && shell.length ? shell : ['sh'])])
}

// Decide the exec command + persistence flag for a connect.
// command is the array the frontend chose (e.g. ['sh']); returned command is what K8s exec runs.
export function planExec({ mode, tmuxPresent, tmuxBin = 'tmux', terminfoDir = '', sid, token, cols, rows, command }) {
  if (mode === 'attach') return { persistent: false, kind: 'attach', command }
  if (!tmuxPresent) return { persistent: false, kind: 'ephemeral', command }
  if (!sid) return { persistent: false, kind: 'ephemeral', command }
  return {
    persistent: true,
    kind: 'tmux',
    command: tmuxAttachCommand({ tmuxBin, terminfoDir, label: tmuxLabel(token), name: tmuxSessionName(token, sid), cols, rows, shell: command }),
  }
}

// Pure: which session names are past the idle TTL. tracker: Map<name, { token, lastActiveAt, ... }>
export function pickStaleSids(now, tracker, ttlMs) {
  const out = []
  for (const [name, m] of tracker) {            // Map iterates as [key, value]
    if (now - m.lastActiveAt > ttlMs) out.push(name)
  }
  return out
}

// capture-pane: -e 保留 ANSI/颜色; -p 输出到 stdout; -S -lines 抓 viewport 上方 lines 行历史。
export function tmuxCaptureCommand(label, name, lines, tmuxBin = 'tmux', terminfoDir = '') {
  return withTermInfo(terminfoDir, [tmuxBin, '-L', label, 'capture-pane', '-e', '-p', '-S', String(-Math.max(1, lines)), '-t', name])
}

// attach-session 到「已存在」的会话(不带 -A / 不新建)。重连回放后续接实时流用。
export function tmuxAttachOnlyCommand(label, name, tmuxBin = 'tmux', terminfoDir = '') {
  return withTermInfo(terminfoDir, [tmuxBin, '-L', label, 'attach-session', '-t', name])
}

// capture 兼任存在性探测(execCapture 不返回退出码):stdout 非空 ⇒ 会话有历史(重连)。
export function hasHistoryFromCapture(captureResult) {
  const out = captureResult?.stdout
  return !!out && Buffer.isBuffer(out) && out.toString('utf8').trim().length > 0
}

// Map `uname -m` output to our bundled arch, or null if unsupported.
export function archFromUname(unameOutput) {
  const s = String(unameOutput || '').trim().toLowerCase()
  if (s === 'x86_64' || s === 'amd64') return 'amd64'
  if (s === 'aarch64' || s === 'arm64') return 'arm64'
  return null
}

// Writable+exec candidate dests for the injected binary (prefer /dev/shm — survives RO rootfs).
export function injectDestCandidates(arch) {
  return [`/dev/shm/.ab-tmux-${arch}`, `/tmp/.ab-tmux-${arch}`]
}
