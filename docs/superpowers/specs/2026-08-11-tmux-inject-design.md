# Tmux Binary Injection (方案 A) — Persistent Terminals for Any Shell Image

**Date:** 2026-08-11
**Status:** Design (pending implementation plan)
**Builds on:** `docs/superpowers/specs/2026-08-11-tmux-persistent-terminal-design.md` + `2026-08-11-tmux-scrollback-replay-design.md` (both merged to `main`).

## 1. Problem

The tmux persistent-terminal feature only persists when the target image **already has `tmux` on PATH**. Most production images (Alpine base, Debian/Ubuntu, `*:slim`, language runtimes) have a shell but **no tmux** → they degrade to the ephemeral one-shot exec (the original "刷新清空" problem). distroless/scratch (no shell) are out of scope for exec entirely (the platform routes them to kubectl-debug).

## 2. Goal

Make persistence work for **any pod that has a shell + a writable, executable corner** — without modifying workloads or requiring tmux in the image — by injecting a fully-static tmux binary into the pod at connect time, then reusing the existing tmux persistence machinery.

**Non-goals:** distroless/scratch (no shell — kubectl-debug handles those); read-only-rootfs pods where even `/tmp` and `/dev/shm` are unwritable+noexec (rare — degrade to ephemeral); non-amd64/arm64 architectures.

## 3. Detection chain (`resolveTmux`)

Replaces the existing boolean `isTmuxAvailable`. `resolveTmux(session, ns, pod, container) → { kind, bin }`:

1. **System tmux**: one-shot `command -v tmux` (existing `tmuxProbeCommand`) → stdout non-empty → `{ kind: 'system', bin: 'tmux' }`.
2. **Else inject**: one-shot `uname -m` → `archFromUname` → amd64/arm64 (or `null` → `{ kind:'none' }`). Read the bundled static binary `server/bin/tmux-<arch>` (`readTmuxBinary`); if the file is absent (binaries not committed yet) → `{ kind:'none' }` (graceful). For each candidate dest from `injectDestCandidates(arch)` (`/dev/shm/.ab-tmux-<arch>`, then `/tmp/.ab-tmux-<arch>`): `execInject` the binary bytes, then `verifyTmuxBin` (`<dest> -V` → stdout contains `tmux`). First dest that verifies → `{ kind:'injected', bin: dest }`.
3. **Else**: `{ kind:'none' }` → ephemeral + badge.

Result cached per `(namespace, pod, container)` in the existing `tmuxProbeCache`, now storing `{ kind, bin, at }` with the same TTL. `present = (kind === 'system' || kind === 'injected')`.

## 4. Injection mechanism (`execInject` + `verifyTmuxBin`)

Reuses the **proven `podfile-write` pattern** (`server/index.mjs:~1835`): open a one-shot K8s exec `['sh','-c','cat > "$1" && chmod +x "$1"','ab-inject', destPath]` with `stdin = <binary Buffer>`, `tty=false`; await `conn.on('close')`. Then `verifyTmuxBin` runs `execCapture([destPath, '-V'])` (raw) and checks stdout contains `tmux 3`/`tmux next-*`. Verification guards against: wrong arch (won't run), `noexec` mount (won't run), truncated/corrupt transfer.

The binary is read from the gateway filesystem via `readTmuxBinary(arch)` = `fs.readFileSync(path.join(import.meta.dirname, 'bin', 'tmux-'+arch))` (resolves to `/app/server/bin/tmux-<arch>` in the image, `…/server/bin/…` in dev). Missing file → `null` → `{ kind:'none' }`.

## 5. `tmuxBin` threading

The four command-builders in `server/tmux-session.mjs` and `planExec` gain a `tmuxBin` argument (**trailing optional, default `'tmux'`** — backward compatible, so existing callers keep working until the wiring tasks pass the resolved bin):

- `tmuxAttachCommand({ tmuxBin='tmux', label, name, cols, rows, shell })` → `[tmuxBin, '-L', label, 'new-session', '-A', …]`
- `tmuxCaptureCommand(tmuxBin='tmux', label, name, lines)` → `[tmuxBin, '-L', label, 'capture-pane', …]`
- `tmuxAttachOnlyCommand(tmuxBin='tmux', label, name)` → `[tmuxBin, '-L', label, 'attach-session', …]`
- `tmuxKillCommand(tmuxBin='tmux', label, name)` → `[tmuxBin, '-L', label, 'kill-session', …]`
- `planExec({ mode, tmuxPresent, tmuxBin='tmux', sid, token, cols, rows, command })` threads `tmuxBin` into `tmuxAttachCommand`.

**handleExec** uses `resolveTmux(...)` then `planExec({ tmuxPresent, tmuxBin: resolved.bin, … })`, and the reconnect path passes `resolved.bin` to `tmuxCaptureCommand`/`tmuxAttachOnlyCommand`.

**kill-on-close (DELETE) + idle sweeper** call `resolveTmux(session, ns, pod, container)` (cache hit is ~free) to obtain `bin`, then `tmuxKillCommand(bin, label, name)`. (The `-L <label>` socket is shared regardless of which tmux binary talks to it; the injected server is reachable from the same client family.)

## 6. Cache invalidation

A cached `{kind:'injected', bin:'/dev/shm/.ab-tmux-<arch>'}` becomes stale when the pod restarts (`/dev/shm` cleared). The streaming exec (`tmux new-session`/`attach`) then fails → the existing stale-cache path (`tmuxProbeCache.delete(probeKey)` on exec failure when `planned.kind === 'tmux'`) fires → next connect re-resolves → re-injects (idempotent: `cat` overwrites). If re-injection itself can't verify (e.g. RO-rootfs+noexec), `resolveTmux` returns `{kind:'none'}` and the connect degrades to ephemeral — no loop.

## 7. Binary artifacts + licensing

- `server/bin/tmux-amd64`, `server/bin/tmux-arm64` — fully-static (musl-static) tmux, built from upstream tmux source (ISC license). ~1–2 MB each.
- `server/bin/LICENSE-tmux` — tmux's ISC notice, bundled per license terms.
- **Dockerfile: zero change** — existing `COPY server/` ships `server/bin/` into the image at `/app/server/bin/`. Every image variant (amd64 and arm64 builds) carries BOTH binaries → cross-arch exec works.
- **Sourcing**: produced once from upstream source (out of the per-task implementation loop; committed as artifacts). Until committed, the code degrades to `{kind:'none'}` via the `fs.existsSync` check in `readTmuxBinary` — so the feature can be built + tested before the binaries land.

## 8. Frontend / i18n / DB

**Zero change.** `CH_MODE {persistent:true|false}` unchanged; injection is transparent to the user (no new badge tier — YAGNI; persistence is persistence).

## 9. Edge cases & limitations

- **RO-rootfs where /tmp AND /dev/shm are noexec/unwritable**: tmux socket (`/tmp/tmux-<uid>/`) and/or the binary can't be placed → inject verifies fail or `new-session` fails → degrade to ephemeral. Rare; v1 accepts.
- **No shell (distroless)**: inject exec can't run `cat` → `{kind:'none'}` → ephemeral (kubectl-debug is the separate path).
- **Unsupported arch (armv7, s390x, ppc64le)**: no bundled binary → `{kind:'none'}`.
- **Corrupt/truncated transfer**: `verifyTmuxBin` (`-V`) fails → try next dest → `{kind:'none'}`.
- **Per-connect overhead**: first connect to a no-tmux pod pays: `uname -m` + inject (cat ~2 MB) + verify. Cached afterward (TTL). Reconnect to an already-injected pod = cache hit (no re-inject).

## 10. Testing

**Pure (`server/tmux-session.mjs` + `tmux-session.test.mjs`):**
- `archFromUname`: `x86_64`/`amd64`→`amd64`; `aarch64`/`arm64`→`arm64`; `armv7l`/`s390x`/empty→`null`.
- `injectDestCandidates('amd64')` → `['/dev/shm/.ab-tmux-amd64','/tmp/.ab-tmux-amd64']`.
- Command builders accept `tmuxBin` (default `'tmux'`): `tmuxKillCommand('L','N','/dev/shm/.ab-tmux-amd64')` → `['/dev/shm/.ab-tmux-amd64','-L','L','kill-session','-t','N']`; existing 2-arg calls still yield `['tmux',…]`.
- `planExec({ …, tmuxBin:'/dev/shm/.ab-tmux-x' })` threads the bin into the attach command.

**Integration (real cluster, deferred to controller/manual):**
- Against an Alpine pod (no tmux): first connect injects (verify `ls /dev/shm/.ab-tmux-*`), `persistent:true` badge, `python -m http.server` survives refresh.
- Against a tmux-equipped pod: still uses system tmux (no injection).
- Kill-on-close + idle reap work on an injected (no-system-tmux) pod.
- Cross-arch: gateway execs into a pod of the other arch → injects the matching binary.

## 11. File-level change summary

| File | Change |
|---|---|
| `server/tmux-session.mjs` | add `archFromUname`, `injectDestCandidates`; add trailing `tmuxBin='tmux'` to the 4 command builders + `planExec` |
| `server/tmux-session.test.mjs` | tests for the above; update existing builder tests for the new optional param |
| `server/index.mjs` | add `readTmuxBinary`, `execInject`, `verifyTmuxBin`, `resolveTmux` (impure, reuse `execCapture`); `handleExec` uses `resolveTmux`; `DELETE` + idle sweeper use `resolveTmux` for the kill bin; `tmuxProbeCache` stores `{kind,bin,at}` |
| `server/bin/tmux-amd64`, `tmux-arm64`, `LICENSE-tmux` | committed static artifacts (last step; code degrades without them) |
| Dockerfile / frontend / i18n / DB | none |
