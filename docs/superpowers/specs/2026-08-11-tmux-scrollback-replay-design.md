# Tmux Scrollback Replay on Reconnect (Enhancement B)

**Date:** 2026-08-11
**Status:** Design (pending implementation plan)
**Builds on:** `docs/superpowers/specs/2026-08-11-tmux-persistent-terminal-design.md` (merged to `main` at `9644123`)

## 1. Goal

When a user reconnects to an **existing** tmux-backed terminal (after browser refresh / WS drop / gateway restart), replay the tmux session's scrollback history (with colors/ANSI) into xterm **before** attaching the live stream — so the user sees their previous commands and output, not just the current visible screen.

**Non-goals (unchanged from parent feature):** full alt-screen-app fidelity (vim/less/top), replay for `attach` mode or no-tmux ephemeral fallback, configurable per-session depth UI.

## 2. Scope (when replay applies)

| Connect scenario | Replay? |
|---|---|
| Persistent (tmux) session, **reconnect** (session already exists) | ✅ capture-pane → stream → attach |
| Persistent (tmux) session, **first connect** (session absent) | ❌ `new-session -A` as today (nothing to replay; avoids double-printing the prompt) |
| `attach` mode (kubectl attach to PID 1) | ❌ no tmux → nothing captured |
| No-tmux ephemeral fallback | ❌ nothing persisted → nothing to replay |

## 3. Mechanism (gateway `handleExec`, persistent branch)

Today the persistent branch runs a single streaming exec:
`tmux -L <label> new-session -A -s <name> -x <cols> -y <rows> -- <shell>`
(`-A` = attach if exists, else create).

Enhanced sequence (**`capture-pane` doubles as the existence probe** — see Rationale):

1. **One-shot capture** `tmux -L <label> capture-pane -e -p -S -<DEPTH> -t <name>` via `execCapture` → returns scrollback bytes (with ANSI escapes) if the session exists; errors / empty stdout if absent.
2. **Capture yielded history (reconnect)** → emit the bytes as a stdout frame (channel `CH_STDOUT = 1`) on the WS (frontend `term.write` renders it), then open the streaming exec `tmux -L <label> attach-session -t <name>` for live I/O.
3. **Capture empty/errored (first connect, session absent)** → run `new-session -A ...` as the streaming exec (identical to today; no replay).

`-e` preserves colors/escape sequences for faithful replay. `-S -<DEPTH>` captures up to DEPTH lines above the visible viewport. `-p` prints to stdout.

**Rationale (why capture doubles as the probe):** the existing one-shot helper `execCapture` does not surface the process exit code (`has-session` exits 0/1) — only stdout/stderr. Reusing `capture-pane` as the probe avoids a shell-wrapped `has-session` (injection surface) and avoids extending the shared `execCapture` (blast radius). Empty-pane misdetect (rare, e.g. right after `clear`) falls through to `new-session -A`, which attaches to the existing session — harmless (no replay that turn, normal attach).

## 4. Frontend

**Zero changes.** Capture output arrives as normal stdout frames; `xterm.write` already renders stdout. Side effects: `gotOutput` becomes `true` on reconnect (so the shell-auto-fallback logic does not misfire — correct, since the shell is alive). The persistence badge (`CH_MODE`) logic is unchanged.

## 5. New pure helpers (`server/tmux-session.mjs`)

All unit-testable, added alongside the existing exports:

- `tmuxCaptureCommand(label, name, lines)` → `['tmux','-L',label,'capture-pane','-e','-p','-S',String(-Math.max(1, lines)),'-t',name]`
- `tmuxAttachOnlyCommand(label, name)` → `['tmux','-L',label,'attach-session','-t',name]`
- `hasHistoryFromCapture(captureResult)` → `true` iff `captureResult.stdout` is a non-empty (trimmed) Buffer. This is the existence probe (see §3 rationale).

The gateway (`handleExec`) persistent branch consumes these: `execCapture(tmuxCaptureCommand)` → `hasHistoryFromCapture` → if true, emit stdout + `tmuxAttachOnlyCommand` (reconnect); else `tmuxAttachCommand` (create, unchanged).

## 6. Configuration (env-overridable, no new required config)

- `TMUX_SCROLLBACK_LINES` — default `2000`. Capture depth for `capture-pane -S -<N>`.
- `TMUX_PROBE_TTL_MS` (existing) unchanged.

## 7. Edge cases & known limitations

- **Alt-screen apps (vim/less/top) left open on reconnect:** `capture-pane -e` replays their current screen; the live `attach` then takes over. Minor visual seam at the handoff; accepted for v1.
- **Output produced between capture and attach:** a tiny window of new output is not in the captured history, but `attach` redraws the current screen and live streaming resumes immediately — impact negligible.
- **`has-session` true but session just created (race):** `capture-pane` returns the prompt/empty → harmless (frontend renders a prompt, then attach continues).
- **Performance:** reconnect costs +1 `has-session` one-shot exec + +1 `capture-pane` one-shot exec (both fast, non-streaming); first connect costs +1 `has-session` only. The streaming exec still runs once per connect.
- **Large history:** bounded by DEPTH (2000). Transferring ~hundreds of KB on reconnect is acceptable (not a hot path).

## 8. Testing

**Pure (unit):**
- `tmuxCaptureCommand` (with `-e`/`-S -lines`/`-t name`), `tmuxAttachOnlyCommand` — exact argv.
- `hasHistoryFromCapture`: non-empty Buffer → true; empty/whitespace Buffer → false; missing/null → false.

**Integration (real cluster, deferred to controller/manual):**
- In a tmux image: open terminal → `for i in 1 2 3; do echo line$i; done` → browser refresh → reopen → scrollback shows `line1/2/3` (with color if the command produced ANSI).
- First connect: prompt appears exactly once (not duplicated by a capture of a fresh session).
- `attach` mode + no-tmux image: behavior unchanged (no replay).

## 9. File-level change summary

| File | Change |
|---|---|
| `server/tmux-session.mjs` | add `tmuxCaptureCommand`, `tmuxAttachOnlyCommand`, `hasHistoryFromCapture` |
| `server/tmux-session.test.mjs` | unit tests for the 3 new exports |
| `server/index.mjs` `handleExec` (persistent branch) | `execCapture(capture-pane)` → `hasHistoryFromCapture` → reconnect (emit stdout + `tmuxAttachOnlyCommand` streaming) or create (`tmuxAttachCommand`, unchanged) |
| (none) frontend, i18n, DB | unchanged |
