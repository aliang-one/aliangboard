# Tmux Scrollback Replay on Reconnect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On reconnect to an existing tmux-backed terminal, replay the session's scrollback history (with ANSI/colors) into xterm before attaching the live stream, so the user sees prior output instead of just the current screen.

**Architecture:** All new logic is pure and unit-tested in `server/tmux-session.mjs` (3 helpers). The gateway's `handleExec` persistent branch gains one capture step before the streaming exec: `execCapture(capture-pane)` doubles as the existence probe — non-empty stdout ⇒ replay the bytes as a stdout frame then `attach-session`; empty/errored ⇒ `new-session -A` as today. Frontend and i18n: zero changes.

**Tech Stack:** Node.js ESM (`node:25`), `@kubernetes/client-node`, `node --test` for backend unit tests.

**Spec:** `docs/superpowers/specs/2026-08-11-tmux-scrollback-replay-design.md`

## Global Constraints

- **Runtime:** Node ESM on Node 25.
- **Backend tests:** `node:test` + `node:assert`. `server/tmux-session.test.mjs` is already wired into `test:server` — add tests there (no `package.json` change). Run `npm run test:server` to confirm.
- **Reuse, don't fork:** `execCapture(session, namespace, pod, container, command)` (`server/index.mjs:654`) — returns `{ stdout: Buffer, stderr: string, status: null }`, **throws** on exec-connection failure (does NOT surface exit code). Also reuse `wsSend` (`:580`), `CH_STDOUT=1` (`:575`), and existing `tmuxLabel`/`tmuxSessionName`/`tmuxAttachCommand` from `./tmux-session.mjs`.
- **`handleExec`** is at `server/index.mjs:589`; the persistent branch sets `execCommand = planned.command` (which is `tmuxAttachCommand`, i.e. `new-session -A`) just before the streaming `new Exec(kc).exec(... execCommand ...)`.
- **No frontend, i18n, or DB changes.** No new WS channels (reuse `CH_STDOUT=1` for the replay bytes).
- **Working directory:** all paths relative to the worktree root `…/.claude/worktrees/tmux-scrollback/` (branch `feat/tmux-scrollback`). Git via `git -C <worktree>`.

## File Structure

**Modify:**
- `server/tmux-session.mjs` — add 3 pure helpers: `tmuxCaptureCommand`, `tmuxAttachOnlyCommand`, `hasHistoryFromCapture`.
- `server/tmux-session.test.mjs` — unit tests for the 3 new helpers.
- `server/index.mjs` — extend the import; add `TMUX_SCROLLBACK_LINES` config; in `handleExec`'s persistent branch, run capture→replay before the streaming exec.

---

## Task 1: Pure helpers + tests (TDD)

**Files:**
- Modify: `server/tmux-session.mjs` (add 3 exports after the existing `pickStaleSids`)
- Modify: `server/tmux-session.test.mjs` (extend the import; add 3 tests)

**Interfaces:**
- Produces (consumed by Task 2): `tmuxCaptureCommand(label, name, lines) → string[]`; `tmuxAttachOnlyCommand(label, name) → string[]`; `hasHistoryFromCapture(captureResult) → boolean`.

- [ ] **Step 1: Extend the test import + write the 3 failing tests**

In `server/tmux-session.test.mjs`, add the three new names to the existing `import { … } from './tmux-session.mjs'` line:

```js
import {
  hashToken, tmuxLabel, tmuxSessionName, probeKey,
  tmuxProbeCommand, isTmuxPresent, tmuxKillCommand, tmuxAttachCommand,
  planExec, pickStaleSids,
  tmuxCaptureCommand, tmuxAttachOnlyCommand, hasHistoryFromCapture,
} from './tmux-session.mjs'
```

Append these 3 tests at the end of the file:

```js
test('tmuxCaptureCommand: capture-pane -e -p -S -lines -t name (depth floored at 1)', () => {
  assert.deepEqual(tmuxCaptureCommand('abDEADBEEF', 'abDEADBEEF-t1', 2000),
    ['tmux', '-L', 'abDEADBEEF', 'capture-pane', '-e', '-p', '-S', '-2000', '-t', 'abDEADBEEF-t1'])
  assert.equal(tmuxCaptureCommand('L', 'N', 0)[6], '-1', 'lines floored to 1 → -S -1')
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/tmux-session.test.mjs`
Expected: FAIL — `tmuxCaptureCommand is not defined` (the 3 new exports don't exist yet).

- [ ] **Step 3: Implement the 3 helpers**

Append to `server/tmux-session.mjs` (after `pickStaleSids`):

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/tmux-session.test.mjs`
Expected: PASS — all existing tests + the 3 new ones.

- [ ] **Step 5: Run the full server suite (no regression) + commit**

Run: `npm run test:server`
Expected: PASS (no regressions).

```bash
git -C <worktree> add server/tmux-session.mjs server/tmux-session.test.mjs
git -C <worktree> commit -m "feat(terminal): pure tmux capture/attach-only/hasHistory helpers for scrollback replay"
```

---

## Task 2: Gateway replay-on-reconnect wiring

**Files:**
- Modify: `server/index.mjs` — import line (`:29`); add `TMUX_SCROLLBACK_LINES` near the other config; `handleExec` persistent branch (`:589`).

**Interfaces:**
- Consumes (from Task 1): `tmuxCaptureCommand`, `tmuxAttachOnlyCommand`, `hasHistoryFromCapture`.
- Produces: on reconnect, scrollback bytes are emitted on `CH_STDOUT` (channel 1) before the live `attach-session` stream. Frontend needs no change.

- [ ] **Step 1: Extend the import**

`server/index.mjs:29` currently:
```js
import { planExec, probeKey, tmuxProbeCommand, isTmuxPresent, tmuxLabel, tmuxSessionName, tmuxKillCommand, pickStaleSids } from './tmux-session.mjs'
```
Change to:
```js
import { planExec, probeKey, tmuxProbeCommand, isTmuxPresent, tmuxLabel, tmuxSessionName, tmuxKillCommand, pickStaleSids, tmuxCaptureCommand, tmuxAttachOnlyCommand, hasHistoryFromCapture } from './tmux-session.mjs'
```

- [ ] **Step 2: Add the depth config**

Near the existing `TMUX_PROBE_TTL` / `IDLE_TTL_MS` config declarations (search for `TMUX_PROBE_TTL`), add:

```js
const TMUX_SCROLLBACK_LINES = Number(process.env.TMUX_SCROLLBACK_LINES || 2000)
```

- [ ] **Step 3: Add the capture→replay step in `handleExec`'s persistent branch**

In `handleExec` (`server/index.mjs:589`), find this line (a few lines below the `planExec` call):

```js
  const execCommand = planned.command
```

Replace that single line with:

```js
  let execCommand = planned.command   // 默认 new-session -A(create-or-attach)
  if (planned.persistent) {
    // 增强 B:重连回放 scrollback。capture-pane 兼任存在性探测(execCapture 不返回退出码)。
    const label = tmuxLabel(token)
    try {
      const cap = await execCapture(session, namespace, pod, container, tmuxCaptureCommand(label, sessionName, TMUX_SCROLLBACK_LINES))
      if (hasHistoryFromCapture(cap)) {
        wsSend(ws, CH_STDOUT, cap.stdout)                         // 回放历史 → xterm
        execCommand = tmuxAttachOnlyCommand(label, sessionName)   // 续接已存在会话
      }
    } catch { /* 会话不存在/捕获失败 → 保持 new-session -A */ }
  }
```

(Nothing else in `handleExec` changes. `execCommand` then flows into the existing `new Exec(kc).exec(namespace, pod, container, execCommand, stdout, stderr, stdin, tty, …)` exactly as before. `sessionName`, `tmuxLabel`, `execCapture`, `wsSend`, `CH_STDOUT` are all already in scope.)

- [ ] **Step 4: Verify syntax + no regression**

Run: `node --check server/index.mjs` → no errors.
Run: `npm run test:server` → PASS (no regression).

- [ ] **Step 5: Integration verification (DEFERRED to controller — no kubectl here)**

Against a real cluster with a tmux image (e.g. `kubectl run tmuxtest --image=nicolaka/netshoot -- sleep 3600`): open a terminal → `for i in 1 2 3; do echo line$i; done` → browser refresh → reopen the card → scrollback shows `line1/2/3`; a first-time open of a fresh card prints the prompt once (not duplicated). The implementer CANNOT run this — note it as deferred to the controller.

- [ ] **Step 6: Commit**

```bash
git -C <worktree> add server/index.mjs
git -C <worktree> commit -m "feat(terminal): replay tmux scrollback into xterm on reconnect"
```

---

## Final verification

- [ ] `npm run test:server` → green (incl. the 3 new helper tests).
- [ ] `node --check server/index.mjs` → clean.
- [ ] Deferred to controller (real cluster): reconnect shows prior `echo` output; first-open prompt not duplicated; `attach` mode and no-tmux images unchanged (no replay, no regression).
