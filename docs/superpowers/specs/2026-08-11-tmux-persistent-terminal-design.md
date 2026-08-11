# Tmux-backed Persistent Pod Terminal

**Date:** 2026-08-11
**Status:** Design (pending implementation plan)
**Owner:** frontend + gateway

## 1. Background & Problem

The platform lets users open a shell inside a pod (`InteractiveTerminal.vue` →
`execStream` WebSocket → gateway `handleExec` → `@kubernetes/client-node`
`Exec`). The intended UX:

- A long-running / blocking command (e.g. `python -m http.server`) keeps running
  and its interface stays visible.
- Minimizing a terminal and reopening it within the same browser session keeps
  the **same** running shell (the floating window uses `v-show`, so the
  WebSocket stays alive while minimized).
- To get another shell, the user opens a **new** terminal from the pod card.

This works **within a browser session**, but breaks across a **browser refresh**:

1. Refresh destroys the page → the `WebSocket` object is torn down (no reconnect
   logic in `execStream`, `src/api/client.js:271`).
2. Gateway `handleExec` (`server/index.mjs:547`) reacts to `ws.on('close')` by
   calling `stdin.end()` + `conn?.close()` → the K8s exec stream closes → the
   process inside the pod receives SIGHUP and **dies**.
3. Terminal **metadata** (which pod/container) is persisted to SQLite
  (`terminals` table, keyed by k8s session token) and restored on mount via
  `loadPersisted()` (`src/stores/terminals.js:36`) as `status:'minimized'`. But
   reopening the card runs `autoConnect` → a brand-new WebSocket → a brand-new
   `Exec().exec()` → a fresh empty shell. No running command, no scrollback.

**Net effect:** the taskbar chip survives a refresh, but the *live* terminal
(its running process and screen output) does not. The chip silently lies — it
looks like the same terminal but the work is gone. The same destruction happens
on any WebSocket drop (gateway restart, network blip, laptop sleep), not only on
manual refresh.

### Root cause

The exec session is **1:1 bound to a single WebSocket connection**, and there is
no backend session registry / reconnection / multiplexing layer. K8s `exec`
itself has no native "resume session" concept — each `Exec().exec()` spawns a new
process.

## 2. Goals & Non-Goals

**Goals**

- A terminal's running process and current screen survive: browser refresh,
  transient WebSocket drops, and gateway restart (as long as the pod is alive).
- Each terminal **card** maps to exactly one persistent shell session
  (per-card scope — matches today's mental model).
- When the image has no `tmux`, degrade gracefully to today's one-shot exec and
  tell the user that terminal will not survive refresh.
- Reap sessions so they do not accumulate forever inside pods.

**Non-Goals (v1)**

- Full scrollback history replay into xterm on reconnect (only the visible
  screen + live process are preserved). See §11 optional enhancement B.
- Persistent `attach` mode (kubectl attach to PID 1). It connects to the
  container's primary process stdio and cannot be tmux-wrapped; it stays
  one-shot by necessity.
- Cross-user shared sessions, session renaming, multi-pane/split terminals.
- Cleaning up orphaned sessions left by a gateway crash without an in-memory
  tracker (accepted limitation, §9).

## 3. Locked Decisions

| Decision | Choice |
|---|---|
| Persistence mechanism | `tmux` running **inside the pod**; gateway execs into it |
| Session scope | **Per terminal card** (session id = `terminal.id`) |
| Reconnect mechanism | **A — single exec `tmux new-session -A`** (attach-or-create); preserves live process + visible screen |
| No-tmux behavior | **Auto-fallback to one-shot exec + "not persistent" badge** |
| Reaping | **Kill on card close** + **idle TTL (default 30 min unattached)** |

## 4. Architecture

The change is **gateway-centric**: tmux wrapping happens inside `handleExec`.
The frontend contract is almost unchanged — it only carries a stable session id
and reacts to one new control frame.

```
Browser (xterm)  ──WS──▶  Gateway handleExec  ──exec──▶  Pod
                              │                            │
                              │ if exec mode + tmux present:│
                              │   tmux -L <label>           │
                              │     new-session -A -s <sid> │──▶ tmux server (persists)
                              │     -x <cols> -y <rows>     │      │
                              │     -- <shell>              │      └── inner shell (persists)
                              │                             │
                              │ WS close ≠ process death    │
                              │   (tmux server keeps shell) │
                              │                             │
                              │ reconnect (refresh): same   │
                              │   sid → tmux attaches back  │
```

Why tmux-in-pod (not a gateway-side session registry):

- The process must outlive the gateway's WebSocket **and** the gateway process
  itself (gateway restart must not kill shells). tmux runs in the pod, so it
  survives gateway restart; only pod death clears it (acceptable — pod restart
  kills everything anyway).
- tmux's own client/scrollback keeps the visible screen; `new-session -A`
  reattaches to the live session.
- Avoids building a multiplexer, auth, buffering, and reaping for foreign
  processes in the gateway — tmux already does all of this.

## 5. Session Naming & Isolation

Different platform users can exec into the **same pod** as the **same uid**
(e.g. root). tmux's default socket is shared per-uid, so we must namespace.

- **Socket label (per-user isolation):** `tmux -L ab<hash(token)[:8]>`
- **Session name:** `ab<hash(token)[:8]>-<terminal.id>`

where `token` is the **k8s session token** — the same token that keys the
`terminals` SQLite table and authenticates the exec WS
(`server/index.mjs:1636`, `:1643`, WS upgrade at `:2116`). Consequences:

- Card and tmux session share a lifetime: both orphan together on re-login (new
  k8s token). This is consistent — a re-login already can't see old cards.
- Different platform users → different token hash → different tmux socket →
  cannot see or attach each other's sessions even if names were guessed.
- Same user, multiple cards → same socket, distinct session names → independent
  shells.

`hash` = first 8 hex chars of a sha256 of the token. Stable for a given token.

## 6. Connect Sequence (`handleExec`, exec mode only)

Pseudocode for the new path (unchanged for `mode === 'attach'`):

```
1. availability probe (cached per (namespace,pod,container)):
     cache key: `${namespace}/${pod}/${container}`
     if miss: one-shot exec `command -v tmux` → cache 'yes'|'no' (TTL, clear on error)
2. if 'no' (or attach mode):
     → original one-shot exec path
     → after upgrade, emit control frame {persistent:false} (CH_MODE)
3. if 'yes':
     label = `ab${hash(token)[:8]}`
     sid   = `ab${hash(token)[:8]}-${url.searchParams.get('sid') || random}`
     cols,rows = last CH_RESIZE for this WS, else 80x24
     // single streaming exec; -A = "attach if session exists, else create"
     exec = `tmux -L <label> new-session -A -s <sid> -x <cols> -y <rows> -- <command>`
     → run as the K8s Exec command (stream exactly as today)
     → after upgrade, emit control frame {persistent:true} (CH_MODE)
     → mark idle-tracker[sid] = now (attached)
```

Notes:

- `tmux new-session -A` is the whole reconnect mechanism: session exists →
  attach (the `-- <command>` is ignored); absent → create with that shell. One
  streaming exec, no separate `has-session` probe.
- The frontend's existing auto-fallback (sh→bash→ash on no-output-then-exit,
  `InteractiveTerminal.vue:88`) keeps working transparently: if the chosen
  shell is absent, the session it created ends at once — tmux destroys a session
  when its last pane's command exits — so the next attempt with `-A` creates a
  fresh one instead of reattaching to a dead pane.
- `sid` **must be stable** across reconnects for the same card. It is sent by
  the frontend as a WS query param `sid=<terminal.id>`. If absent (e.g. legacy
  caller), gateway falls back to a random sid — that session won't survive
  refresh, equivalent to today.
- The availability probe is a **one-shot exec** (no tty, capture exit code),
  run via the same kube client and credentials as the main exec, cached per
  `(namespace,pod,container)`.

## 7. Resize

- The existing `CH_RESIZE` path (`server/index.mjs` `ws.on('message')` handler)
  drives K8s exec's pty resize, which sends SIGWINCH to the pty tmux's client is
  attached to. tmux perceives the new client size and resizes its window.
- **v1 relies on this pty SIGWINCH path.** If testing shows tmux windows don't
  follow resize, add an explicit `tmux -L <label> resize-window -t <sid> -x C -y
  R` in the resize handler. (Decision deferred to implementation/testing — not a
  design fork.)

## 8. Fallback (no tmux) & Badge

- When the probe says no tmux (or mode is attach), the gateway runs the original
  one-shot exec and immediately emits a **control frame** so the card can badge
  itself.
- New WS channel: `CH_MODE = 5` (outbound, server→client). Payload is a tiny
  JSON: `{"persistent": true|false}`.
- Frontend `InteractiveTerminal.vue`:
  - Receives `onMode` via `execStream`; stores `persistent` in a ref.
  - Title bar shows a badge:
    - persistent true → `✓` "会保留" (green / primary)
    - persistent false → `⚠` "刷新不保留" (warning)
  - Badge appears only while the card is connected (driven by the live frame).
    The minimized taskbar chip shows no badge in v1 (simplification).

## 9. Reaping

**Kill on card close** (reliable, no in-memory state needed):

- `DELETE /api/terminals/:id` (`server/index.mjs:1672`) — after deleting the row,
  run a one-shot exec `tmux -L <label> kill-session -t <sid>` in the pod using
  the same k8s credentials, best-effort (swallow errors: pod may already be
  gone). `sid` is reconstructed deterministically from `hash(token)` + the row's
  `id`.
- Also kill on **clean shell exit**: when the inner shell exits (tmux session
  ends), the exec stream closes naturally; no extra action needed.

**Idle TTL** (best-effort, default 30 min):

- Gateway keeps an in-memory map `sid → lastActiveAt` (refreshed on attach and
  on any inbound traffic for that sid).
- A periodic sweeper (e.g. every 60s) kills+deletes any `sid` whose
  `lastActiveAt` is older than `IDLE_TTL_MS` (env-configurable, default
  30 min).
- Killing requires the k8s token for that sid → store `token` (or enough to
  rebuild kube creds) alongside `lastActiveAt`. Since the k8s session may have
  expired by then, best-effort: if the token is no longer valid in `sessions`,
  skip (the session will be cleaned by pod restart or a future attach).

**Known limitation (explicit):** the idle tracker is in gateway memory. A
gateway restart loses it, so sessions that were already idle before the restart
won't be reaped until they are attached-again-then-left-idle, or until the pod
restarts. We deliberately do **not** sweep all pods of all clusters on startup
(too expensive). Kill-on-close remains the dependable path.

## 10. Frontend Changes (minimal)

- `src/api/client.js` `execStream`:
  - Add `sid` param → set as WS query param `sid`.
  - Handle new outbound channel `CH_MODE` (type 5) → call new `onMode` callback.
- `src/components/common/InteractiveTerminal.vue`:
  - Accept `sessionId` prop (default `''`); pass to `execStream`.
  - Add `onMode` handler → `persistent` ref → badge in the title bar.
  - `TerminalWindow.vue` passes `terminal.id` as `sessionId`.
- `src/components/terminal/TerminalWindow.vue`:
  - `<InteractiveTerminal :session-id="terminal.id" ... />`
- No store changes required (the existing `terminal.id` is the sid).

**i18n (gate: `npm run i18n:check` must pass — add keys to BOTH
`src/locales/en.json` and `zh.json`, under the `terminal` namespace at
`zh.json:2920`):**

- `terminal.persistentBadge` — "会保留" / "Persists"
- `terminal.ephemeralBadge` — "刷新不保留" / "Lost on refresh"
- `terminal.ephemeralHint` (tooltip) — explains why (image has no tmux)

Per project conventions (`@` sign escaping, `v-html` for HTML in messages — see
memory): these values are plain text, no `@` and no HTML, so plain `{{ }}`
rendering is fine.

## 11. Data & Contract Changes

- WS query param: `sid` (optional; defaults to random → non-persistent).
- WS outbound channel: `CH_MODE = 5`, payload `{"persistent": bool}`.
- No DB schema change. The `terminals` row's `id` is reused as the tmux session
  id; nothing new persisted.
- Config: `IDLE_TTL_MS` (default 1_800_000), `TMUX_PROBE_TTL_MS` (default
  300_000) — both env-overridable, no new required config.

## 12. File-Level Change Summary

| File | Change |
|---|---|
| `server/index.mjs` `handleExec` (~547) | probe + tmux `new-session -A` wrap; emit CH_MODE; refresh idle tracker |
| `server/index.mjs` channels (~525) | add `CH_MODE = 5`; new helper to run one-shot exec (probe/kill) |
| `server/index.mjs` `DELETE /api/terminals/:id` (~1672) | best-effort `kill-session` after row delete |
| `server/index.mjs` startup | idle-TTL sweeper timer + `sid→{token,lastActiveAt}` map |
| `src/api/client.js` `execStream` (~262) | `sid` param + `onMode`/CH_MODE handling |
| `src/components/common/InteractiveTerminal.vue` | `sessionId` prop, `onMode`, badge |
| `src/components/terminal/TerminalWindow.vue` (~108) | pass `:session-id="terminal.id"` |
| `src/locales/{en,zh}.json` `terminal` ns | 3 new keys |

## 13. Testing

**Backend unit:**

- `hash(token)` determinism + collision behavior.
- `new-session -A` behavior: session exists (→ attach, shell command ignored)
  vs absent (→ create).
- Shell-fallback path: absent shell creates a session that ends immediately →
  next `-A` attempt recreates cleanly (no dead-pane reattach).
- Probe cache: miss → exec, hit → no exec, error → invalidation.
- No-tmux path emits `CH_MODE {persistent:false}` and runs plain exec.
- Idle sweeper: kills+deletes stale sid; skips when token expired.

**Integration (with a tmux-equipped test pod):**

1. Open card → run `python -m http.server` (blocking) → confirm output streams.
2. Drop the WS (simulate refresh: close + reopen with same `sid`) → reconnect
   attaches → `http.server` **still running** (verify via a second exec `pgrep`
   or by hitting the server), visible screen restored.
3. Close the card → `tmux has-session -t <sid>` returns false (killed).
4. Open a card against a distroless/no-tmux image → badge shows "刷新不保留",
   shell still works for the session, process dies on WS close.
5. Two platform users → same pod/root → each sees only their own session.

**Frontend:**

- Badge toggles correctly on `onMode`.
- `terminal.id` threaded as `sid` end-to-end.

## 14. Optional Enhancements (out of scope for v1)

- **B. Full scrollback replay** — two-phase connect: one-shot
  `tmux capture-pane -p -S -2000` streamed to the WS stdout channel, then
  `attach`. Restores full history into xterm on every reconnect. Cost: extra K8s
  round-trip + backend ordering. Defer unless users ask.
- Per-user socket keyed on **stable platform userId** instead of (rotating) k8s
  token, so a re-login could reattach to prior sessions. Requires also re-keying
  the `terminals` table on userId — larger change; skip unless needed.
- A startup orphan sweep that, for each recently-used (pod,container), lists
  `tmux -L <label> list-sessions` and kills unknown names. Cheap only if scoped;
  defer.
