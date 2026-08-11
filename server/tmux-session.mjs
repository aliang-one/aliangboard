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

export function tmuxKillCommand(label, name) {
  return ['tmux', '-L', label, 'kill-session', '-t', name]
}

// -A = attach if session exists, else create. shell array is spread after `--`.
export function tmuxAttachCommand({ label, name, cols, rows, shell }) {
  return ['tmux', '-L', label, 'new-session', '-A', '-s', name,
    '-x', String(cols || 80), '-y', String(rows || 24), '--', ...(shell && shell.length ? shell : ['sh'])]
}

// Decide the exec command + persistence flag for a connect.
// command is the array the frontend chose (e.g. ['sh']); returned command is what K8s exec runs.
export function planExec({ mode, tmuxPresent, sid, token, cols, rows, command }) {
  if (mode === 'attach') return { persistent: false, kind: 'attach', command }
  if (!tmuxPresent) return { persistent: false, kind: 'ephemeral', command }
  if (!sid) return { persistent: false, kind: 'ephemeral', command }
  return {
    persistent: true,
    kind: 'tmux',
    command: tmuxAttachCommand({ label: tmuxLabel(token), name: tmuxSessionName(token, sid), cols, rows, shell: command }),
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
export function tmuxCaptureCommand(label, name, lines) {
  return ['tmux', '-L', label, 'capture-pane', '-e', '-p', '-S', String(-Math.max(1, lines)), '-t', name]
}

// attach-session 到「已存在」的会话(不带 -A / 不新建)。重连回放后续接实时流用。
export function tmuxAttachOnlyCommand(label, name) {
  return ['tmux', '-L', label, 'attach-session', '-t', name]
}

// capture 兼任存在性探测(execCapture 不返回退出码):stdout 非空 ⇒ 会话有历史(重连)。
export function hasHistoryFromCapture(captureResult) {
  const out = captureResult?.stdout
  return !!out && Buffer.isBuffer(out) && out.toString('utf8').trim().length > 0
}
