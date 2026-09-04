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
export function tmuxAttachCommand({ tmuxBin = 'tmux', terminfoDir = '', confPath = '', label, name, cols, rows, shell }) {
  return withTermInfo(terminfoDir, [tmuxBin, ...(confPath ? ['-f', confPath] : []), '-L', label, 'new-session', '-A', '-s', name,
    '-x', String(cols || 80), '-y', String(rows || 24), '--', ...(shell && shell.length ? shell : ['sh'])])
}

// new-session -d: detached 建会话(不 attach)。handleExec 先用它探测 tmux 能否起 server+pane,
// 成功后再 attach;失败(只读/noexec/无 pty/server 崩)则降级一次性 exec。shell spread after `--`。
export function tmuxNewSessionDetached({ tmuxBin = 'tmux', terminfoDir = '', confPath = '', label, name, cols, rows, shell }) {
  return withTermInfo(terminfoDir, [tmuxBin, ...(confPath ? ['-f', confPath] : []), '-L', label, 'new-session', '-d', '-s', name,
    '-x', String(cols || 80), '-y', String(rows || 24), '--', ...(shell && shell.length ? shell : ['sh'])])
}

// 注入的 tmux conf 内容。tmux pane 内 TERM 默认取 default-terminal(裸 screen),
// 而注入的 terminfo 没有 s/screen 条目 → pane 里 shell 行编辑(上箭头等)错乱;
// 定到 screen-256color(tar 已含该条目,pane 应用还能拿到 256 色)。只在 new-session(server 启动)时被读。
export function tmuxConfContent() {
  // window-size largest(≥3.1):多客户端窗口尺寸不齐时按最大者——小窗口出留白,
  // 而不是把大窗口的 TUI 压扁(2026-09-04 症状2)
  return 'set -g default-terminal "screen-256color"\nset -g window-size largest\n'
}

// conf 注入目标候选:system/injected 两路共用,不必与二进制同目录(只要 pod 里可读)。
export function confDestCandidates() {
  return ['/dev/shm/.ab-tmux.conf', '/tmp/.ab-tmux.conf']
}

// has-session: 查会话是否存在(socket-only,但要 TMUX_TMPDIR 找对 socket)。退出码区分重连 vs 首次。
export function tmuxHasSessionCommand(label, name, tmuxBin = 'tmux', terminfoDir = '') {
  return withTermInfo(terminfoDir, [tmuxBin, '-L', label, 'has-session', '-t', name])
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

// Pure: which session names are past the idle TTL.
// tracker: Map<name, { token, lastActiveAt, attached?, ... }>。attached>0 豁免(2026-09-04):
// 旧口径只看键入续命,用户盯着静态屏/慢日志 30min 不敲键盘即被回收(「会话意外被关闭」主诉);
// 附着的会话直接豁免,未附着的照旧按时钟回收(无输出续命,无永生泄漏)。
export function pickStaleSids(now, tracker, ttlMs) {
  const out = []
  for (const [name, m] of tracker) {            // Map iterates as [key, value]
    if ((m.attached || 0) > 0) continue
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

// ---- shell 智能探测 ----
// 默认 exec 'sh' 在 Debian/Ubuntu 系镜像=dash,无任何 tab 补全;bash/zsh 才有 readline 完整体验。
// 单发探测:输出首个命中的 shell 名(一行);探测结果只允许白名单内的裸名字(防注入任意 argv)。
export const KNOWN_SHELLS = ['bash', 'zsh', 'ash', 'dash', 'sh']

export function isKnownShell(name) {
  return KNOWN_SHELLS.includes(String(name || '').trim())
}

export function shellProbeCommand() {
  const list = KNOWN_SHELLS.join(' ')
  return ['sh', '-c', `for s in ${list}; do command -v "$s" >/dev/null 2>&1 && { echo "$s"; exit 0; }; done; echo sh`]
}

// 探测输出 → shell 名:取首个非空行,白名单校验不过则回退 sh(与旧行为一致)。
export function pickShellFromProbe(stdout) {
  const out = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : ''
  const first = out.split('\n').map(l => l.trim()).find(l => l.length > 0) || ''
  return isKnownShell(first) ? first : 'sh'
}
