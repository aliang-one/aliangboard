# Tmux Binary Injection (方案 A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tmux terminal persistence work for any shell-having pod (not just tmux-equipped images) by injecting a fully-static tmux binary at connect time.

**Architecture:** A new `resolveTmux` (in `server/index.mjs`, replacing `isTmuxAvailable`) runs a detection chain — system `tmux` → else detect arch + inject a bundled static binary into `/dev/shm`/`/tmp` + verify → else ephemeral — and returns `{kind, bin}`, cached per pod. The command-builders + `planExec` (pure, in `tmux-session.mjs`) gain a trailing-optional `tmuxBin` so the resolved binary path threads through to every tmux command. Binaries live in `server/bin/` (shipped by the existing `COPY server/`); code degrades to ephemeral if they're absent.

**Tech Stack:** Node.js ESM (`node:25`), `@kubernetes/client-node`, `node --test` for backend unit tests.

**Spec:** `docs/superpowers/specs/2026-08-11-tmux-inject-design.md`

## Global Constraints

- **Runtime:** Node ESM on Node 25 (`import.meta.dirname` is available).
- **Backend tests:** `node:test` + `node:assert`. `server/tmux-session.test.mjs` is already wired into `test:server` — add tests there (no `package.json` change).
- **Reuse, don't fork:** `execCapture(session, namespace, pod, container, command, raw=false)` (`server/index.mjs:~666`; returns `{stdout: Buffer, stderr, status:null}`, throws on connection failure). The podfile-write inject pattern at `server/index.mjs:~1835` (`exec.exec(... ['sh','-c','cat > "$1"','podfile-write', path], null, null, stdin, false)`). `buildKubeConfig`, `k8sClient`, `tmuxProbeCache` (`:505`), `TMUX_PROBE_TTL` (`:506`).
- **No frontend, i18n, DB, or Dockerfile changes.** Binaries ship via the existing `COPY server/`.
- **`tmuxBin` is a trailing-optional param defaulting to `'tmux'`** on every command-builder + `planExec`, so existing callers (and existing B tests) keep working unchanged until the wiring tasks pass the resolved bin.
- **Working directory:** all paths relative to the worktree root `…/.claude/worktrees/tmux-inject/` (branch `feat/tmux-inject`). Git via `git -C <worktree>`.

## File Structure

**Modify:**
- `server/tmux-session.mjs` — add `tmuxBin` to the 4 command builders + `planExec`; add pure `archFromUname`, `injectDestCandidates`.
- `server/tmux-session.test.mjs` — new tests for `archFromUname`, `injectDestCandidates`, `tmuxBin` threading.
- `server/index.mjs` — add `readTmuxBinary`, `execInject`, `verifyTmuxBin`, `resolveTmux`; replace `isTmuxAvailable` usage; extend `tmuxProbeCache` to `{kind,bin,at}`; thread `resolved.bin` through `handleExec`, the DELETE handler, and the idle sweeper.

**Create:**
- `server/bin/LICENSE-tmux` — ISC license text (tmux upstream).
- `server/bin/README.md` — how the two static binaries are produced + the exact filenames/arch mapping.

---

## Task 1: Pure helpers — `tmuxBin` threading + arch/dest helpers (TDD)

**Files:**
- Modify: `server/tmux-session.mjs` (4 builders + `planExec`; new `archFromUname`, `injectDestCandidates`)
- Modify: `server/tmux-session.test.mjs` (extend import; new tests)

**Interfaces:**
- Produces (consumed by Tasks 2–3): `archFromUname(s) → 'amd64'|'arm64'|null`; `injectDestCandidates(arch) → string[]`; and the builders/`planExec` now accept trailing-optional `tmuxBin` (default `'tmux'`).

- [ ] **Step 1: Add the 2 new pure helpers**

In `server/tmux-session.mjs`, append:

```js
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
```

- [ ] **Step 2: Add trailing-optional `tmuxBin` to the 4 builders + `planExec`**

Change these in `server/tmux-session.mjs`:

```js
export function tmuxKillCommand(label, name, tmuxBin = 'tmux') {
  return [tmuxBin, '-L', label, 'kill-session', '-t', name]
}

export function tmuxAttachCommand({ tmuxBin = 'tmux', label, name, cols, rows, shell }) {
  return [tmuxBin, '-L', label, 'new-session', '-A', '-s', name,
    '-x', String(cols || 80), '-y', String(rows || 24), '--', ...(shell && shell.length ? shell : ['sh'])]
}

export function planExec({ mode, tmuxPresent, tmuxBin = 'tmux', sid, token, cols, rows, command }) {
  if (mode === 'attach') return { persistent: false, kind: 'attach', command }
  if (!tmuxPresent) return { persistent: false, kind: 'ephemeral', command }
  if (!sid) return { persistent: false, kind: 'ephemeral', command }
  return {
    persistent: true,
    kind: 'tmux',
    command: tmuxAttachCommand({ tmuxBin, label: tmuxLabel(token), name: tmuxSessionName(token, sid), cols, rows, shell: command }),
  }
}

export function tmuxCaptureCommand(label, name, lines, tmuxBin = 'tmux') {
  return [tmuxBin, '-L', label, 'capture-pane', '-e', '-p', '-S', String(-Math.max(1, lines)), '-t', name]
}

export function tmuxAttachOnlyCommand(label, name, tmuxBin = 'tmux') {
  return [tmuxBin, '-L', label, 'attach-session', '-t', name]
}
```

(Existing callers that omit `tmuxBin` still get `'tmux'` → backward compatible.)

- [ ] **Step 3: Write the new failing tests**

In `server/tmux-session.test.mjs`, extend the import to include `archFromUname, injectDestCandidates`, then append:

```js
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
```

- [ ] **Step 4: Run tests → fail (helpers missing / signatures)**

Run: `node --test server/tmux-session.test.mjs`
Expected: FAIL — `archFromUname is not defined` (before Step 1's edit is applied) / or the new `tmuxBin` assertions fail if you ran tests before Step 2. (Do Step 1+2 edits first, then this step confirms RED only if you order it before; either way, run before+after to show RED→GREEN.)

- [ ] **Step 5: Run tests → pass**

Run: `node --test server/tmux-session.test.mjs`
Expected: PASS — all existing tests (B's) still green + the 4 new tests.

- [ ] **Step 6: Full suite + commit**

Run: `npm run test:server` → PASS (no regression).

```bash
git -C <worktree> add server/tmux-session.mjs server/tmux-session.test.mjs
git -C <worktree> commit -m "feat(terminal): tmuxBin threading + arch/dest helpers for binary injection"
```

---

## Task 2: `resolveTmux` + injection + `handleExec` wiring

**Files:**
- Modify: `server/index.mjs` — add imports; add `readTmuxBinary`/`execInject`/`verifyTmuxBin`/`resolveTmux`; replace `isTmuxAvailable` usage in `handleExec`; extend `tmuxProbeCache`.

**Interfaces:**
- Consumes (Task 1): `archFromUname`, `injectDestCandidates`, and the `tmuxBin`-aware builders/`planExec`.
- Produces: `resolveTmux(session, namespace, pod, container) → { kind: 'system'|'injected'|'none', bin: string }`, used by `handleExec` (this task) and by DELETE/sweeper (Task 3).

- [ ] **Step 1: Extend the import + add fs/path imports**

`server/index.mjs` top — add to the `./tmux-session.mjs` import: `archFromUname, injectDestCandidates`. Also add (if not already present):

```js
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
```

- [ ] **Step 2: Add `readTmuxBinary`, `execInject`, `verifyTmuxBin`, `resolveTmux`**

Place these near `isTmuxAvailable` (`server/index.mjs:~534`). Keep `isTmuxAvailable` for now (Task 3 still references the cache shape transitionally — actually it will be unused after this task; you may delete it).

```js
// 读取随镜像打包的静态 tmux 二进制(server/bin/tmux-<arch>)。缺失 → null(resolveTmux 降级为 ephemeral)。
function readTmuxBinary(arch) {
  const p = join(import.meta.dirname, 'bin', `tmux-${arch}`)
  try { return existsSync(p) ? readFileSync(p) : null } catch { return null }
}

// 把二进制字节经一次性 exec 灌进 pod(cat > dest && chmod +x)。复用 podfile-write 的 stdin 注入模式。
async function execInject(session, namespace, pod, container, bytes, destPath) {
  const { KubeConfig, Exec } = await k8sClient()
  const kc = buildKubeConfig(KubeConfig, session)
  const exec = new Exec(kc)
  const stdin = new PassThrough()
  try {
    const conn = await exec.exec(namespace, pod, container, ['sh', '-c', 'cat > "$1" && chmod +x "$1"', 'ab-inject', destPath], null, null, stdin, false)
    stdin.end(bytes)                       // 写完二进制 + EOF,让 cat 收尾
    await new Promise(resolve => conn.on('close', resolve))
    return true
  } catch { return false }
}

// 验证注入的二进制能跑:<dest> -V 输出含 "tmux <ver>"。
async function verifyTmuxBin(session, namespace, pod, container, binPath) {
  try {
    const r = await execCapture(session, namespace, pod, container, [binPath, '-V'], true)  // raw
    return /tmux\s+\d/.test(r?.stdout?.toString('utf8') || '')
  } catch { return false }
}

// 决定持久化用的 tmux:系统有 → system;否则探测架构 + 注入 → injected;否则 none。
async function resolveTmux(session, namespace, pod, container) {
  const key = probeKey(namespace, pod, container)
  const hit = tmuxProbeCache.get(key)
  if (hit && Date.now() - hit.at < TMUX_PROBE_TTL) return hit.res
  let res = { kind: 'none', bin: 'tmux' }
  try {
    if (isTmuxPresent(await execCapture(session, namespace, pod, container, tmuxProbeCommand()))) res = { kind: 'system', bin: 'tmux' }
  } catch { /* probe 失败 → 尝试注入 */ }
  if (res.kind === 'none') {
    let arch = null
    try { arch = archFromUname((await execCapture(session, namespace, pod, container, ['uname', '-m'])).stdout.toString('utf8')) } catch { /* */ }
    const binary = arch ? readTmuxBinary(arch) : null
    if (arch && binary) {
      for (const dest of injectDestCandidates(arch)) {
        if (await execInject(session, namespace, pod, container, binary, dest) && await verifyTmuxBin(session, namespace, pod, container, dest)) {
          res = { kind: 'injected', bin: dest }; break
        }
      }
    }
  }
  tmuxProbeCache.set(key, { res, at: Date.now() })
  return res
}
```

- [ ] **Step 3: Wire `handleExec` to `resolveTmux`**

In `handleExec`, replace these lines:

```js
  const present = mode === 'attach' ? false : await isTmuxAvailable(session, namespace, pod, container)
  const planned = planExec({ mode, tmuxPresent: present, sid, token, cols: 80, rows: 24, command })
```

with:

```js
  const resolved = mode === 'attach' ? { kind: 'none', bin: 'tmux' } : await resolveTmux(session, namespace, pod, container)
  const present = resolved.kind === 'system' || resolved.kind === 'injected'
  const planned = planExec({ mode, tmuxPresent: present, tmuxBin: resolved.bin, sid, token, cols: 80, rows: 24, command })
```

And in the reconnect capture block (B's block), pass `resolved.bin` to the capture + attach-only calls. Replace:

```js
      const cap = await execCapture(session, namespace, pod, container, tmuxCaptureCommand(label, sessionName, TMUX_SCROLLBACK_LINES), true)
```

with:

```js
      const cap = await execCapture(session, namespace, pod, container, tmuxCaptureCommand(label, sessionName, TMUX_SCROLLBACK_LINES, resolved.bin), true)
```

and replace:

```js
        execCommand = tmuxAttachOnlyCommand(label, sessionName)
```

with:

```js
        execCommand = tmuxAttachOnlyCommand(label, sessionName, resolved.bin)
```

- [ ] **Step 4: Verify syntax + no regression**

Run: `node --check server/index.mjs` → no errors.
Run: `npm run test:server` → PASS (no regression; no new unit tests — `resolveTmux` is impure, integration-tested later).

- [ ] **Step 5: Integration check is deferred to controller (no kubectl here)**

Note in the report: against an Alpine pod (no tmux), first connect should inject + show `persistent:true` badge; against a tmux pod, system tmux still used. The implementer cannot run this.

- [ ] **Step 6: Commit**

```bash
git -C <worktree> add server/index.mjs
git -C <worktree> commit -m "feat(terminal): inject static tmux when image lacks it (resolveTmux + handleExec wiring)"
```

---

## Task 3: Kill-on-close + idle reaper use `resolveTmux` for the bin

**Files:**
- Modify: `server/index.mjs` — DELETE `/api/terminals/:id` handler + idle sweeper.

**Interfaces:**
- Consumes (Task 2): `resolveTmux(session, namespace, pod, container) → {kind, bin}`; `tmuxKillCommand(label, name, tmuxBin)` (Task 1).

- [ ] **Step 1: DELETE handler — resolve bin before kill**

In the `DELETE` branch of `/api/terminals/:id`, replace:

```js
        if (row) {
          try {
            await execCapture(session, row.namespace, row.podName, row.container || '',
              tmuxKillCommand(tmuxLabel(token), tmuxSessionName(token, id)))
          } catch { /* pod 已不在 / 无 tmux —— 忽略 */ }
        }
```

with:

```js
        if (row) {
          try {
            const { bin } = await resolveTmux(session, row.namespace, row.podName, row.container || '')
            await execCapture(session, row.namespace, row.podName, row.container || '',
              tmuxKillCommand(tmuxLabel(token), tmuxSessionName(token, id), bin))
          } catch { /* pod 已不在 / 无 tmux —— 忽略 */ }
        }
```

- [ ] **Step 2: Idle sweeper — resolve bin before kill**

In the idle sweeper's per-stale-sid body, replace:

```js
      const session = sessions.get(meta.token)
      if (session) {
        try { await execCapture(session, meta.ns, meta.pod, meta.container || '', tmuxKillCommand(tmuxLabel(meta.token), name)) }
        catch { /* pod 不在 / token 已过期 —— 忽略 */ }
      }
```

with:

```js
      const session = sessions.get(meta.token)
      if (session) {
        try {
          const { bin } = await resolveTmux(session, meta.ns, meta.pod, meta.container || '')
          await execCapture(session, meta.ns, meta.pod, meta.container || '', tmuxKillCommand(tmuxLabel(meta.token), name, bin))
        } catch { /* pod 不在 / token 已过期 —— 忽略 */ }
      }
```

- [ ] **Step 3: Verify + commit**

Run: `node --check server/index.mjs` → no errors.
Run: `npm run test:server` → PASS.

```bash
git -C <worktree> add server/index.mjs
git -C <worktree> commit -m "feat(terminal): kill-on-close + idle reap use resolved tmux bin (injected-aware)"
```

---

## Task 4: Binary artifacts — LICENSE + README (binaries committed by controller)

**Files:**
- Create: `server/bin/LICENSE-tmux`
- Create: `server/bin/README.md`

**Why this task exists:** the two static binaries (`tmux-amd64`, `tmux-arm64`) are produced offline from upstream tmux source (the implementer cannot cross-build them here). The code already degrades to `{kind:'none'}` when they're absent (`readTmuxBinary` → null). This task lands the license + a sourcing doc so the feature is documentation-complete; the controller commits the actual binaries separately.

- [ ] **Step 1: Create `server/bin/LICENSE-tmux`**

The ISC license text used by tmux upstream (full text):

```text
tmux is Copyright (c) 2007 Nicholas Marriott <nicholas.marriott@gmail.com>
and contributors (see the AUTHORS file in the upstream source for the full list).

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Source: https://github.com/tmux/tmux (ISC). Binaries here are static
builds produced from upstream release tag <TMUX_TAG> with musl, for
amd64 and arm64.
```

(Replace `<TMUX_TAG>` with the actual tag the controller builds from — e.g. `3.4` — when the binaries are produced. If unknown at this step, write `3.4` as the current target and let the controller correct it.)

- [ ] **Step 2: Create `server/bin/README.md`**

```markdown
# Bundled static tmux binaries

`tmux-amd64`, `tmux-arm64` — fully-static (musl) tmux, used by the gateway to
inject into pods whose image lacks tmux (see
`docs/superpowers/specs/2026-08-11-tmux-inject-design.md`).

## How to produce (one-time, offline)

From a host with Docker + buildx (or natively on each arch):

```sh
git clone --branch 3.4 https://github.com/tmux/tmux && cd tmux
# static build against musl (requires musl + musl-dev / or a musl-based image)
./configure --disable-shared CFLAGS='-static -s' && make
cp tmux ../tmux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
```

Repeat for the other arch (or cross-compile). Commit both files here, plus
keep `LICENSE-tmux` (ISC) alongside. The Dockerfile's `COPY server/` ships
them into `/app/server/bin/` — no Dockerfile change needed.

The gateway reads them via `readTmuxBinary(arch)` (`server/index.mjs`); if a
file is missing, `resolveTmux` degrades to `{kind:'none'}` (ephemeral) for
that arch.
```

- [ ] **Step 3: Verify the degrade path + commit**

Run: `node --check server/index.mjs` → no errors (artifacts are data; this just confirms nothing broke). `npm run test:server` → PASS. Confirm `server/bin/` contains LICENSE-tmux + README.md (the two `.ab-tmux-*` binaries are NOT present yet — that's expected; the controller adds them).

```bash
git -C <worktree> add server/bin/LICENSE-tmux server/bin/README.md
git -C <worktree> commit -m "docs(terminal): bundled-tmux LICENSE + sourcing README (binaries added by controller)"
```

---

## Final verification

- [ ] `npm run test:server` → green (incl. new helper tests).
- [ ] `node --check server/index.mjs` → clean.
- [ ] Deferred to controller (real cluster): Alpine pod injects + persists; tmux pod uses system tmux; kill-on-close + idle reap work on injected sessions; cross-arch exec injects matching binary.
- [ ] Controller follow-up: produce + commit `server/bin/tmux-amd64` + `tmux-arm64` (per README), then re-verify injection live.
