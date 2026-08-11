# Tmux-Backed Persistent Pod Terminal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pod terminals survive browser refresh / WebSocket drops / gateway restart by wrapping the exec'd shell in a per-card `tmux` session running inside the pod.

**Architecture:** All tmux *decisions and command-building* live in a new pure, fully unit-tested module `server/tmux-session.mjs`. The gateway (`server/index.mjs`) keeps only thin wiring: a cached tmux-availability probe, wrapping the exec command via `planExec(...)`, emitting one new WS control frame (`CH_MODE`) so the frontend can badge the card, kill-on-close, and a best-effort idle reaper. Frontend change is minimal: `execStream` carries a stable `sid` and dispatches the mode frame; `InteractiveTerminal` shows a badge.

**Tech Stack:** Node.js ESM (`node:**25**`, `@kubernetes/client-node`, `node:sqlite`), `node --test` for backend unit tests, Vue 3 + Pinia + xterm.js + vitest for frontend.

**Spec:** `docs/superpowers/specs/2026-08-11-tmux-persistent-terminal-design.md`

## Global Constraints

- **Runtime:** Node ESM on `node:25`; do not downgrade. `Date.now()` is allowed in server code (this is the app, not a workflow script).
- **i18n gate:** Every new UI string goes into BOTH `src/locales/en.json` and `src/locales/zh.json`; `npm run i18n:check` must pass (no residual Chinese in `src/`, keys aligned across locales). Badge strings are plain text (no `@`, no HTML) → plain `{{ }}` rendering.
- **Backend test wiring:** Any new `server/*.test.mjs` MUST be appended to the `test:server` script in `package.json` (chain of `node --test server/<file>`). Full suite: `npm test` (`test:server` then `test:unit`).
- **node:sqlite boundary:** (Not used here — no new DB columns.) If any DB write is added, coerce `undefined→null` and objects→JSON.
- **Reuse, don't fork:** The tmux probe and kill reuse the existing one-shot helper `execCapture(session, namespace, pod, container, command)` (`server/index.mjs:595`), which returns `{ stdout: Buffer, stderr: string, status: null }` and **throws** on exec-connection failure. Probe success = `stdout` non-empty.
- **Persistence semantics (why this works):** `tmux new-session -A` runs the shell as a child of a tmux *server* that lives in the pod. Closing the exec stream (refresh / WS drop) only ends tmux's *client* → tmux **detaches** the session; the session and its shell keep running. Reconnect with the same `-s <name>` re-attaches and redraws the visible screen.
- **Working directory:** All paths are relative to the worktree root `…/.claude/worktrees/tmux-terminal/` (branch `feat/tmux-terminal`). Run git with `git -C <worktree>` where `<worktree>` = the absolute path above.

## File Structure

**Create:**
- `server/tmux-session.mjs` — PURE helpers + decision logic. No Node-k8s, no WS, no DB. Fully unit-tested. Exports: `hashToken`, `tmuxLabel`, `tmuxSessionName`, `probeKey`, `tmuxProbeCommand`, `isTmuxPresent`, `tmuxKillCommand`, `tmuxAttachCommand`, `planExec`, `pickStaleSids`.
- `server/tmux-session.test.mjs` — `node --test` unit tests for every export above.
- `src/api/__tests__/execStream.test.js` — vitest test for the `sid` query param + `CH_MODE` dispatch.

**Modify:**
- `server/index.mjs` — `handleExec` wrapping + `CH_MODE` + probe cache + idle tracker (Task 2); kill-on-close in `DELETE /api/terminals/:id` (Task 3); idle sweeper (Task 4).
- `src/api/client.js` — `execStream`: add `sid` param + `onMode`/`CH_MODE`.
- `src/components/common/InteractiveTerminal.vue` — `sessionId` prop, `persistent` ref, `onMode`, title-bar badge.
- `src/components/terminal/TerminalWindow.vue` — pass `:session-id="terminal.id"`.
- `src/locales/{en,zh}.json` — new keys under `terminal`.
- `package.json` — append tmux test to `test:server`.

---

## Task 1: Pure tmux-session module (TDD)

**Files:**
- Create: `server/tmux-session.mjs`
- Create: `server/tmux-session.test.mjs`
- Modify: `package.json` (`test:server`)

**Interfaces:**
- Produces (consumed by Tasks 2–4): `planExec`, `tmuxKillCommand`, `tmuxLabel`, `tmuxSessionName`, `probeKey`, `tmuxProbeCommand`, `isTmuxPresent`, `pickStaleSids` — signatures pinned by the tests below.

- [ ] **Step 1: Write the failing test file**

Create `server/tmux-session.test.mjs`:

```js
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
    'ab1-termC': { token: 't3', lastActiveAt: 4_999 },   // exactly ttl → not stale
  }
  assert.deepEqual(pickStaleSids(now, tracker, 5_000), ['ab1-termB'])
  assert.deepEqual(pickStaleSids(now, {}, 5_000), [])
})
```

- [ ] **Step 2: Run test to verify it fails (module missing)**

Run: `node --test server/tmux-session.test.mjs`
Expected: FAIL — `Cannot find module './tmux-session.mjs'`.

- [ ] **Step 3: Implement the pure module**

Create `server/tmux-session.mjs`:

```js
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

// Pure: which session names are past the idle TTL. tracker: { name: { token, lastActiveAt, ... } }
export function pickStaleSids(now, tracker, ttlMs) {
  return Object.entries(tracker)
    .filter(([, m]) => now - m.lastActiveAt > ttlMs)
    .map(([name]) => name)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/tmux-session.test.mjs`
Expected: PASS (all 11 tests).

- [ ] **Step 5: Wire into the suite**

In `package.json`, append to the `test:server` value, immediately before `&& node scripts/exec-bridge.test.mjs`:

```
&& node --test server/tmux-session.test.mjs
```

- [ ] **Step 6: Verify suite + commit**

Run: `npm run test:server`
Expected: PASS (existing tests + new tmux test).

```bash
git -C <worktree> add server/tmux-session.mjs server/tmux-session.test.mjs package.json
git -C <worktree> commit -m "feat(terminal): pure tmux-session module (decisions + command-building)"
```

---

## Task 2: Wrap handleExec (probe cache + planExec + CH_MODE + idle tracker)

**Files:**
- Modify: `server/index.mjs` (import; `CH_MODE`; probe cache + `isTmuxAvailable`; idle tracker; rewrite of `handleExec` exec-branch ~545–591)

**Interfaces:**
- Consumes (from Task 1): `planExec`, `probeKey`, `tmuxProbeCommand`, `isTmuxPresent`, `tmuxLabel`, `tmuxSessionName`.
- Produces (for Task 5/frontend): WS outbound control frame on channel `CH_MODE = 5`, payload JSON `{"persistent": true|false}`, emitted once per connect right after the plan is computed.
- Produces (for Task 4): module-level `idleTracker` Map (`tmuxSessionName → { token, ns, pod, container, terminalId, lastActiveAt }`), refreshed on attach and on inbound traffic.

- [ ] **Step 1: Add the import + constants + state**

Near the top of `server/index.mjs`, after the other `import` lines, add:

```js
import { planExec, probeKey, tmuxProbeCommand, isTmuxPresent, tmuxLabel, tmuxSessionName } from './tmux-session.mjs'
```

At the channel-constants block (`server/index.mjs:523–524`), extend the outbound set:

```js
const CH_STDIN = 1, CH_RESIZE = 2
const CH_STDOUT = 1, CH_STDERR = 2, CH_EXIT = 3, CH_ERROR = 4, CH_MODE = 5
```

Add probe cache + idle tracker near `k8sClient()` (around `server/index.mjs:487`):

```js
// tmux availability cache: probeKey -> { present, at }. TTL-bounded; cleared on error.
const tmuxProbeCache = new Map()
const TMUX_PROBE_TTL = Number(process.env.TMUX_PROBE_TTL_MS || 5 * 60 * 1000)

// idle reaper tracker: tmuxSessionName -> { token, ns, pod, container, terminalId, lastActiveAt }
const idleTracker = new Map()

async function isTmuxAvailable(session, namespace, pod, container) {
  const key = probeKey(namespace, pod, container)
  const hit = tmuxProbeCache.get(key)
  if (hit && Date.now() - hit.at < TMUX_PROBE_TTL) return hit.present
  let present = false
  try {
    present = isTmuxPresent(await execCapture(session, namespace, pod, container, tmuxProbeCommand()))
  } catch { present = false }
  tmuxProbeCache.set(key, { present, at: Date.now() })
  return present
}
```

- [ ] **Step 2: Rewrite `handleExec`**

Replace the body of `handleExec` (`server/index.mjs:545–591`) with:

```js
async function handleExec(ws, session, url) {
  const namespace = url.searchParams.get('namespace')
  const pod = url.searchParams.get('pod')
  if (!namespace || !pod) { wsSend(ws, CH_ERROR, '缺少 namespace / pod 参数'); return ws.close() }
  const container = url.searchParams.get('container') || ''
  const mode = url.searchParams.get('mode')   // 'attach' = 连接主进程 stdio；否则 exec 开新 shell
  const command = (url.searchParams.get('command') || '/bin/sh').trim().split(/\s+/)
  const tty = url.searchParams.get('tty') !== 'false'
  const sid = url.searchParams.get('sid') || ''           // 稳定会话标识 = 前端 terminal.id
  const token = url.searchParams.get('session') || ''     // k8s session token（WS 鉴权同一值）

  // 决定执行命令 + 持久性：tmux 可用且有 sid → 包成 new-session -A（attach-or-create）
  const present = mode === 'attach' ? false : await isTmuxAvailable(session, namespace, pod, container)
  const planned = planExec({ mode, tmuxPresent: present, sid, token, cols: 80, rows: 24, command })
  wsSend(ws, CH_MODE, JSON.stringify({ persistent: planned.persistent }))   // 告知前端是否持久（徽标）
  const sessionName = tmuxSessionName(token, sid)
  if (planned.persistent) idleTracker.set(sessionName, { token, ns: namespace, pod, container, terminalId: sid, lastActiveAt: Date.now() })
  const execCommand = planned.command

  const { KubeConfig, Exec, Attach } = await k8sClient()
  const kc = buildKubeConfig(KubeConfig, session)

  const stdout = new WsSink(CH_STDOUT, ws)
  const stderr = new WsSink(CH_STDERR, ws)
  const stdin = new PassThrough()
  let conn = null

  try {
    if (mode === 'attach') {
      conn = await new Attach(kc).attach(namespace, pod, container, stdout, stderr, stdin, tty)
    } else {
      conn = await new Exec(kc).exec(namespace, pod, container, execCommand, stdout, stderr, stdin, tty, status => {
        wsSend(ws, CH_EXIT, JSON.stringify({ status: status?.status || 'Success', code: status?.code ?? null }))
      })
    }
  } catch (error) {
    // 探测命中缓存但实际不可用（镜像刚换/缓存 stale）→ 失效缓存,下次重探
    if (planned.kind === 'tmux') tmuxProbeCache.delete(probeKey(namespace, pod, container))
    wsSend(ws, CH_ERROR, error?.message || `${mode === 'attach' ? 'attach' : 'exec'} 会话建立失败（容器可能未就绪或镜像内无 shell）`)
    return ws.close()
  }

  conn.on('close', () => { try { ws.close() } catch { /* noop */ } })
  conn.on('error', () => { try { ws.close() } catch { /* noop */ } })

  ws.on('message', data => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (!buf.length) return
    const type = buf[0]
    const payload = buf.subarray(1)
    if (type === CH_STDIN) {
      const m = planned.persistent ? idleTracker.get(sessionName) : null
      if (m) m.lastActiveAt = Date.now()
      try { stdin.write(payload) } catch { /* noop */ }
    }
    else if (type === CH_RESIZE) {
      try { const { cols, rows } = JSON.parse(payload.toString('utf8')); stdout.columns = cols; stdout.rows = rows; stdout.emit('resize') } catch { /* 帧格式错误 */ }
    }
  })
  ws.on('close', () => { try { stdin.end() } catch { /* noop */ }; try { conn?.close() } catch { /* noop */ } })
  ws.on('error', () => { try { conn?.close() } catch { /* noop */ } })
}
```

- [ ] **Step 3: Verify syntax + server smoke**

Run: `node --check server/index.mjs`
Expected: no syntax errors.

Run: `node server/index.mjs` in one terminal; in another `curl -s localhost:8787/api/health`. Stop the server once it responds.
Expected: server starts without throwing on the new import/state.

- [ ] **Step 4: Integration verification (the core guarantee)**

Against a real cluster, create a tmux-equipped pod:

```bash
kubectl run tmuxtest --image=nicolaka/netshoot -- sleep 3600
```

In the UI, open a terminal into `tmuxtest`, run `python3 -m http.server 8080` (blocks). Then:
1. The taskbar card shows a green "Persists / 会保留" badge.
2. Hit browser refresh. Reopen the card from the taskbar.
3. Expected: the `http.server` is **still running** — verify from a second terminal in the same pod: `curl -s localhost:8080` returns a directory listing.
4. Expected: the visible prompt / prior output is back (tmux redraws the screen on attach).
5. Resize check: resize the terminal window; `tmux` should follow (the pty SIGWINCH propagates). If output wraps/scrolls incorrectly, the fallback is to add an explicit `tmux resize-window` in the `CH_RESIZE` branch — note it as a follow-up if observed.

If the badge shows "Lost on refresh / 刷新不保留" instead: the image lacks tmux on PATH — verify `kubectl exec tmuxtest -- command -v tmux` returns a path; if empty, pick an image that ships tmux.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add server/index.mjs
git -C <worktree> commit -m "feat(terminal): wrap exec in per-card tmux session; emit CH_MODE; track idle"
```

---

## Task 3: Kill-on-close in DELETE handler

**Files:**
- Modify: `server/index.mjs` — `DELETE /api/terminals/:id` branch (`server/index.mjs:1672–1674`)

**Interfaces:**
- Consumes (Task 1): `tmuxLabel`, `tmuxSessionName`, `tmuxKillCommand`; existing `execCapture`, `sessionFromRequest`.
- Produces: a closed card also kills its tmux session inside the pod (so it doesn't linger forever).

- [ ] **Step 1: Extend the import**

Add `tmuxKillCommand` to the Task-2 import line, so it reads:

```js
import { planExec, probeKey, tmuxProbeCommand, isTmuxPresent, tmuxLabel, tmuxSessionName, tmuxKillCommand } from './tmux-session.mjs'
```

- [ ] **Step 2: Replace the DELETE branch**

In the `if (req.method === 'DELETE')` block inside the `/api/terminals/:id` route, replace:

```js
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM terminals WHERE id = ? AND sessionToken = ?').run(id, token)
        return sendJson(res, 200, { ok: true })
      }
```

with:

```js
      if (req.method === 'DELETE') {
        // 取行（含 ns/pod/container）以便 best-effort 杀掉 pod 内的 tmux 会话
        const row = db.prepare('SELECT namespace, podName, container FROM terminals WHERE id = ? AND sessionToken = ?').get(id, token)
        db.prepare('DELETE FROM terminals WHERE id = ? AND sessionToken = ?').run(id, token)
        idleTracker.delete(tmuxSessionName(token, id))
        if (row) {
          try {
            await execCapture(session, row.namespace, row.podName, row.container || '',
              tmuxKillCommand(tmuxLabel(token), tmuxSessionName(token, id)))
          } catch { /* pod 已不在 / 无 tmux —— 忽略 */ }
        }
        return sendJson(res, 200, { ok: true })
      }
```

- [ ] **Step 3: Verify syntax + run unit suite**

Run: `node --check server/index.mjs` → no errors.
Run: `npm run test:server` → PASS (no regression).

- [ ] **Step 4: Integration verification**

With the `tmuxtest` pod and an open persistent terminal, click the card's close (×).
Expected: the session for that card is gone — `kubectl exec tmuxtest -- pgrep -fa http.server` returns nothing (the server was a child of the killed tmux session).

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add server/index.mjs
git -C <worktree> commit -m "feat(terminal): kill tmux session on card close"
```

---

## Task 4: Idle-TTL reaper (best-effort)

**Files:**
- Modify: `server/index.mjs` — add a periodic sweeper at server startup, next to the other startup timers (near the DB schema setup ~line 120).

**Interfaces:**
- Consumes (Task 1): `pickStaleSids`, `tmuxKillCommand`, `tmuxLabel`; existing `execCapture`, `sessions` Map, `db`.

- [ ] **Step 1: Extend the import**

Add `pickStaleSids` to the import line, so it reads:

```js
import { planExec, probeKey, tmuxProbeCommand, isTmuxPresent, tmuxLabel, tmuxSessionName, tmuxKillCommand, pickStaleSids } from './tmux-session.mjs'
```

- [ ] **Step 2: Add the reaper**

Add (once, at server startup — after `db` and `sessions` are initialized):

```js
// 空闲回收：超过 IDLE_TTL 未活动的 tmux 会话 best-effort 杀掉并删行。
// 已知限制：计时在 gateway 内存,重启后已空闲的会话需等下次 attach-再离开才计时,或等 pod 重启。
const IDLE_TTL_MS = Number(process.env.IDLE_TTL_MS || 30 * 60 * 1000)
const idleSweeper = setInterval(() => {
  ;(async () => {
    const now = Date.now()
    for (const name of pickStaleSids(now, idleTracker, IDLE_TTL_MS)) {
      const meta = idleTracker.get(name)
      idleTracker.delete(name)
      if (!meta) continue
      const session = sessions.get(meta.token)
      if (session) {
        try { await execCapture(session, meta.ns, meta.pod, meta.container || '', tmuxKillCommand(tmuxLabel(meta.token), name)) }
        catch { /* pod 不在 / token 已过期 —— 忽略 */ }
      }
      try { db.prepare('DELETE FROM terminals WHERE id = ? AND sessionToken = ?').run(meta.terminalId, meta.token) } catch { /* noop */ }
    }
  })()
}, 60 * 1000)
idleSweeper.unref()
```

- [ ] **Step 3: Verify + integration check**

Run: `node --check server/index.mjs` → no errors. `npm run test:server` → PASS.

Quick TTL check (optional): start the server with `IDLE_TTL_MS=5000`, open a persistent terminal, leave it unattached >5s without closing, then confirm the session is killed (`kubectl exec tmuxtest -- pgrep -fa http.server` empty) and the taskbar chip disappears (row deleted). Then run normally without the env override.

- [ ] **Step 4: Commit**

```bash
git -C <worktree> add server/index.mjs
git -C <worktree> commit -m "feat(terminal): best-effort idle reaper for tmux sessions"
```

---

## Task 5: Frontend — sid + CH_MODE + badge + i18n (vitest)

**Files:**
- Modify: `src/api/client.js` (`execStream` ~262)
- Modify: `src/components/common/InteractiveTerminal.vue` (props ~17, openStream ~67, template ~169)
- Modify: `src/components/terminal/TerminalWindow.vue` (~108)
- Modify: `src/locales/en.json`, `src/locales/zh.json` (`terminal` ns)
- Create: `src/api/__tests__/execStream.test.js`

**Interfaces:**
- Consumes (Task 2 contract): WS query param `sid`; outbound frame channel `5` = JSON `{persistent: bool}`.

- [ ] **Step 1: Write the failing vitest test**

Create `src/api/__tests__/execStream.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execStream } from '../client.js'

// Capture the URL the code passes to `new WebSocket(url)` and expose a way to
// deliver inbound frames, so we can assert on the WS contract without a server.
let capturedUrl = ''
let wsInstance = null
class FakeWS {
  constructor(url) { this.url = url; capturedUrl = url; this.readyState = 1; this._l = {}; wsInstance = this }
  set onmessage(fn) { this._l.message = fn }
  set onclose(fn) { this._l.close = fn }
  set onerror(fn) { this._l.error = fn }
  set binaryType(_) { /* noop */ }
  send() { /* noop */ }
  close() { this.readyState = 3 }
  emit(type, ev) { this._l[type]?.(ev) }
}

describe('execStream', () => {
  beforeEach(() => {
    capturedUrl = ''; wsInstance = null
    globalThis.WebSocket = FakeWS
    globalThis.sessionStorage = { getItem: () => 'tok' }
  })
  afterEach(() => {
    delete globalThis.sessionStorage
    delete globalThis.WebSocket
  })

  it('puts sid into the WS URL when provided', () => {
    execStream({ namespace: 'default', pod: 'web', command: 'sh', sid: 'term-1' })
    expect(capturedUrl).toMatch(/sid=term-1/)
  })

  it('omits sid when not provided (legacy callers stay non-persistent)', () => {
    execStream({ namespace: 'default', pod: 'web', command: 'sh' })
    expect(capturedUrl).not.toMatch(/sid=/)
  })

  it('dispatches a type-5 frame to onMode as {persistent}', () => {
    let mode = null
    execStream({ namespace: 'default', pod: 'web', command: 'sh', sid: 't', onMode: m => { mode = m } })
    const payload = new TextEncoder().encode(JSON.stringify({ persistent: true }))
    const frame = new Uint8Array([5, ...payload])
    wsInstance.emit('message', { data: frame.buffer })
    expect(mode).toEqual({ persistent: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api/__tests__/execStream.test.js`
Expected: FAIL — `sid` not in URL; `onMode` never called (no channel-5 branch).

- [ ] **Step 3: Modify `execStream` (`src/api/client.js`)**

Change the signature and param building (currently ~`client.js:262–271`):

```js
export function execStream({ namespace, pod, container = '', command = '/bin/sh', tty = true, attach = false, sid = '', onStdout, onStderr, onExit, onError, onClose, onMode } = {}) {
  const token = getSessionToken()
  const proto = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws'
  const host = globalThis.location?.host || '127.0.0.1:8787'
  const params = new URLSearchParams({ namespace, pod, tty: tty ? 'true' : 'false' })
  if (container) params.set('container', container)
  if (attach) params.set('mode', 'attach')
  else if (command) params.set('command', command)
  if (token) params.set('session', token)
  if (sid) params.set('sid', sid)
  const ws = new WebSocket(`${proto}://${host}/api/exec?${params}`)
```

In the `ws.onmessage` handler, add a branch for channel 5 (currently only handles 1–4):

```js
    else if (type === 5) { try { onMode?.(JSON.parse(utf8.decode(payload) || '{}')) } catch { onMode?.({}) } }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/api/__tests__/execStream.test.js`
Expected: PASS.

- [ ] **Step 5: Add the badge to `InteractiveTerminal.vue`**

Add a prop (next to the existing props ~line 20):

```js
  sessionId: { type: String, default: '' },
```

Add a `persistent` ref near the other refs (~line 28):

```js
const persistent = ref(null)   // null=未知, true=持久(tmux), false=一次性(无 tmux / attach)
```

Reset it at the top of `connect()` (next to the other resets ~line 113):

```js
  persistent.value = null
```

In `openStream()`, pass `sid` + `onMode` into the `execStream({...})` call (~line 71):

```js
  stream = execStream({
    namespace: props.namespace,
    pod: props.podName,
    container: props.container,
    command: cmd.value,
    attach: props.attach,
    sid: props.sessionId,
    onStdout: d => { gotOutput = true; term.write(d) },
    onStderr: d => { gotOutput = true; term.write(d) },
    onExit: s => { if (my === gen) handleEnd(s?.status, s?.code) },
    onError: m => { if (my === gen) handleEnd(undefined, undefined, m) },
    onClose: () => { if (my === gen && status.value !== 'error' && status.value !== 'closed') handleEnd() },
    onMode: m => { persistent.value = !!m?.persistent },
  })
```

In the template title bar (~line 169, right after the `podName:container · cmd` span), add the badge:

```vue
          <span v-if="persistent === true" class="text-body-xs text-primary ml-xs" :title="t('terminal.persistentHint')">✓ {{ t('terminal.persistentBadge') }}</span>
          <span v-else-if="persistent === false" class="text-body-xs text-tertiary ml-xs" :title="t('terminal.ephemeralHint')">⚠ {{ t('terminal.ephemeralBadge') }}</span>
```

- [ ] **Step 6: Pass `sessionId` from `TerminalWindow.vue`**

At the `<InteractiveTerminal>` usage (~line 108), add the attribute:

```vue
    :session-id="terminal.id"
```

- [ ] **Step 7: Add i18n keys to BOTH locales**

In `src/locales/zh.json` inside the `"terminal": { … }` block (`zh.json:2920`):

```json
      "persistentBadge": "会保留",
      "persistentHint": "此终端由 tmux 承载,刷新浏览器/断线后命令继续运行",
      "ephemeralBadge": "刷新不保留",
      "ephemeralHint": "该镜像内无 tmux,终端不会在刷新后保留",
```

In `src/locales/en.json` inside the matching `"terminal": { … }` block:

```json
      "persistentBadge": "Persists",
      "persistentHint": "Backed by tmux — commands survive refresh / reconnect",
      "ephemeralBadge": "Lost on refresh",
      "ephemeralHint": "Image has no tmux — this terminal won't survive refresh",
```

- [ ] **Step 8: Verify gates**

Run: `npm run i18n:check` → PASS.
Run: `npx vitest run` → PASS (incl. new execStream test).
Run: `npm run typecheck` → PASS.

- [ ] **Step 9: Commit**

```bash
git -C <worktree> add src/api/client.js src/api/__tests__/execStream.test.js src/components/common/InteractiveTerminal.vue src/components/terminal/TerminalWindow.vue src/locales/en.json src/locales/zh.json
git -C <worktree> commit -m "feat(terminal): frontend sid + persistence badge + i18n"
```

---

## Final verification

- [ ] `npm test` (full `test:server` + `test:unit`) → green.
- [ ] `npm run i18n:check` → green.
- [ ] Manual end-to-end against `tmuxtest` (netshoot): open → run blocking `python3 -m http.server 8080` → refresh → reopen → still running + current screen visible; close card → session killed; idle >TTL → reaped.
- [ ] Distroless/no-tmux pod: badge shows "Lost on refresh", shell works for the session, process dies on refresh.
- [ ] Two platform users into the same root pod: each sees only their own tmux socket/sessions (`-L ab<hash>` isolation).
