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
