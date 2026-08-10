# Docker 打包 + GitHub Actions 多架构 CI/CD 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AliangBoard 可 `docker build` 一键产出单进程自包含镜像（Node 同时服务 API + 静态前端），并在推送到 GitHub `main` 分支时自动构建 amd64+arm64 多架构镜像发布到 ghcr.io。

**Architecture:** 多阶段 Dockerfile（build 阶段编 `dist/`，runtime 阶段仅装 prod deps + `git` + `dist/` + `server/`，非 root 运行）。静态前端服务抽成无副作用模块 `server/static.mjs`（`server/index.mjs` 只 import + 一行调用），便于单测且不触发整服务启动。GitHub Actions 用 docker/buildx + QEMU 产多架构 manifest，`GITHUB_TOKEN` 免密推 ghcr。

**Tech Stack:** Node 25（`node:sqlite` 硬依赖）、Vite、`node:test`/`node:assert`（服务端零依赖测试）、Docker buildx、GitHub Actions（docker/* actions 套件）。

## Global Constraints

（每个任务的隐含前提，逐条抄自 spec `docs/superpowers/specs/2026-08-10-docker-cicd-design.md`）

- **不新增外部依赖**（CLAUDE.md 依赖政策）。Dockerfile/CI 只用既有依赖；测试用 `node:test` + `node:assert`。
- **运行时 base = `node:25-alpine`**：`server/index.mjs:25` `import { DatabaseSync } from 'node:sqlite'` 是硬依赖，22/23 需 `--experimental-sqlite` 标志、25 才无标志。**不要**改成 node:22-alpine。
- **静态服务不得吞掉 `/api/*`**：未知 API 路由必须维持既有 `sendJson(res,404,…)` JSON 契约（`serveStatic` 内 `/api` 前缀守卫）。
- **`data/` 永不进镜像**（含 SQLite 凭据）。`.dockerignore` 必须排除；Dockerfile 用 `VOLUME /app/data`。
- **分支纪律**：所有改动落在新分支 `feat/docker-cicd`（从 `main` 切）。**不要**在 `feat/workbench-cursor-chat` 上提交（该分支有 11 个未提交的无关改动，记忆约定不做 stash/reset 手术）。提交信息走仓库惯例（`feat:` / `docs(spec):` / `chore:` + 中文摘要，结尾 `Co-Authored-By: Claude <noreply@anthropic.com>`）。
- 监听地址：镜像内必须 `HOST=0.0.0.0`（服务器默认 `127.0.0.1`，见 `server/index.mjs:30`）。
- 运行时需 `git` 二进制（`server/workbench-repos.mjs` shell-out `git`），**不需** `kubectl`（K8s 走 `@kubernetes/client-node` in-process）。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `server/static.mjs` | 无副作用纯模块：`MIME` 映射 + `serveStatic(req,res,url,{root})`（GET/HEAD 读 root，防穿越，SPA fallback 到 index.html）。可被单测直接 import。 | 新建 |
| `server/static.test.mjs` | `serveStatic` 单测（`node:test`）：`/`→index.html、`/assets/*`→immutable、未知路由→SPA fallback、`/api/*`→false、路径穿越→false、POST→false、HEAD→无 body、无 root→false。 | 新建 |
| `package.json` | 把 `server/static.test.mjs` 挂进 `test:server` 的 `node --test …` 链。 | 改 |
| `server/index.mjs` | import `serveStatic`；定义 `STATIC_DIR`；在末尾 404 兜底前一行调用 `serveStatic(req,res,url,{root:STATIC_DIR})`。 | 改 |
| `Dockerfile` | 多阶段：build 编 `dist/`；runtime `node:25-alpine` + `git` + `npm ci --omit=dev` + `dist/` + `server/`，非 root，HEALTHCHECK，VOLUME。 | 新建 |
| `.dockerignore` | 排除 node_modules/dist/data/.git/本地工具目录/tests/screenshots/docs/*.md 等。 | 新建 |
| `.github/workflows/docker.yml` | `main` 分支推送（+ `workflow_dispatch`）→ QEMU + buildx 多架构（amd64,arm64）→ 推 ghcr，标签 `latest`/`main`/`sha-<短>`。 | 新建 |
| `README.md` | 追加「容器部署」一节（构建/运行/卷/env）。 | 改 |

---

## Task 1: 抽出 `server/static.mjs` 静态服务模块（TDD）

**Files:**
- Create: `server/static.mjs`
- Create: `server/static.test.mjs`
- Modify: `package.json`（`test:server` 脚本）

**Interfaces:**
- Produces: `serveStatic(req, res, url, { root })` → `boolean`（`true`=已写响应命中；`false`=未命中交调用方兜底）。`MIME` 为扩展名→Content-Type 的对象。`req` 只用 `req.method`；`res` 需支持 `writeHead(status,headers)`、`end()`、可作 `createReadStream().pipe()` 目标（即 Writable）；`url` 只用 `url.pathname`。

- [ ] **Step 1: 切分支并提交 spec**

当前在 `feat/workbench-cursor-chat`（有无关未提交改动，不要动它）。从 `main` 切新分支；spec 文件是 untracked，会随 checkout 带过来。

```bash
git checkout main
git checkout -b feat/docker-cicd
git add docs/superpowers/specs/2026-08-10-docker-cicd-design.md
git commit -m "$(cat <<'EOF'
docs(spec): Docker 打包 + GitHub Actions 多架构 CI/CD 设计

单进程 Node 服务 API+静态;node:25-alpine(node:sqlite);main 分支触发;amd64+arm64→ghcr。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: 写失败测试 `server/static.test.mjs`**

```js
// 静态前端服务(serveStatic)单测:无副作用纯模块,临时目录验。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Writable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveStatic } from './static.mjs'

// 假 res:记录 writeHead,接收 pipe/end 的字节。
function makeRes() {
  const chunks = []
  let status = null
  const headers = {}
  const res = new Writable({ write(c, _enc, cb) { chunks.push(c); cb() } })
  res.writeHead = (s, h) => { status = s; Object.assign(headers, h || {}) }
  const realEnd = res.end.bind(res)
  res.end = (d) => { if (d != null) chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)); res.writableEnded = true; realEnd() }
  res.__state = () => ({ status, headers, body: Buffer.concat(chunks).toString('utf8') })
  return res
}

let root, sibling, base
test('setup 临时静态目录', () => {
  base = mkdtempSync(join(tmpdir(), 'static-'))
  root = join(base, 'dist')
  sibling = join(base, 'dist-evil') // 同级目录,验穿越守卫的「前缀精确匹配」
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'assets'), { recursive: true })
  mkdirSync(sibling, { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>SPA</title>')
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(sibling, 'secret.txt'), 'TOPSECRET')
})

test('GET / → index.html,200,no-cache', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET' }, res, new URL('/', 'http://x'), { root })
  assert.equal(hit, true)
  const { status, headers, body } = res.__state()
  assert.equal(status, 200)
  assert.equal(headers['Content-Type'], 'text/html; charset=utf-8')
  assert.equal(headers['Cache-Control'], 'no-cache')
  assert.match(body, /SPA/)
})

test('GET /assets/app.js → 200, immutable 缓存', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET' }, res, new URL('/assets/app.js', 'http://x'), { root })
  assert.equal(hit, true)
  const { status, headers, body } = res.__state()
  assert.equal(status, 200)
  assert.equal(headers['Content-Type'], 'text/javascript; charset=utf-8')
  assert.equal(headers['Cache-Control'], 'public, max-age=31536000, immutable')
  assert.equal(body, 'console.log(1)')
})

test('GET 未知前端路由 /workloads → SPA fallback(index.html, no-cache)', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET' }, res, new URL('/workloads', 'http://x'), { root })
  assert.equal(hit, true)
  const { status, headers, body } = res.__state()
  assert.equal(status, 200)
  assert.equal(headers['Cache-Control'], 'no-cache')
  assert.match(body, /SPA/)
})

test('/api/* 不被静态吞掉 → false,不写响应(交 404 JSON 兜底)', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET' }, res, new URL('/api/whatever', 'http://x'), { root })
  assert.equal(hit, false)
  assert.equal(res.__state().status, null, '不应写任何响应头')
})

test('路径穿越 /../dist-evil/secret.txt → false,不泄露同级文件', () => {
  const res = makeRes()
  // 用裸对象模拟「含 .. 的 pathname」直击 normalize 守卫(真实 URL 已折叠 ..,此处为纵深防御)
  const hit = serveStatic({ method: 'GET' }, res, { pathname: '/../dist-evil/secret.txt' }, { root })
  assert.equal(hit, false, '前缀匹配必须带分隔符,否则会读到 dist-evil 同级文件')
  assert.equal(res.__state().status, null)
})

test('POST / → false(非 GET/HEAD,维持 404)', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'POST' }, res, new URL('/', 'http://x'), { root })
  assert.equal(hit, false)
})

test('HEAD / → 200 header 但无 body', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'HEAD' }, res, new URL('/', 'http://x'), { root })
  assert.equal(hit, true)
  const { status, body } = res.__state()
  assert.equal(status, 200)
  assert.equal(body, '', 'HEAD 不返 body')
})

test('无 root → false(未配静态目录,直接兜底)', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET' }, res, new URL('/', 'http://x'), {})
  assert.equal(hit, false)
})

test('teardown', () => { rmSync(base, { recursive: true, force: true }) })
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test server/static.test.mjs`
Expected: FAIL —— `Cannot find module './static.mjs'`（模块还没建）。

- [ ] **Step 4: 写最小实现 `server/static.mjs`**

```js
// 生产静态前端服务(SPA):/api/* 未命中时,GET/HEAD 读 dist/,文件不存在则回 index.html 交客户端路由。
// 独立无副作用模块:便于单测,且 server/index.mjs import 时不会触发整服务启动(DB/listen 等)。
// 安全:① 仅 GET/HEAD;② /api 前缀交调用方走 404 JSON;③ 路径 normalize 后必须仍在 root 之内(前缀带分隔符,防 /dist 与 /dist-evil 误命中)。
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

// 返回 true = 已写响应(命中);false = 未命中(交调用方走 404 兜底)。
// req: { method };res: ServerResponse(writeHead/end/可被 pipe);url: { pathname };opts.root: dist 绝对路径。
export function serveStatic(req, res, url, { root } = {}) {
  if (!root) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (url.pathname.startsWith('/api')) return false

  const rel = decodeURIComponent(url.pathname)
  const rootNorm = root.endsWith('/') ? root.slice(0, -1) : root
  const safe = normalize(join(rootNorm, rel))
  if (safe !== rootNorm && !safe.startsWith(rootNorm + '/')) return false // 防穿越(带分隔符)

  let filePath = safe
  try {
    const st = statSync(filePath)
    if (st.isDirectory()) filePath = join(filePath, 'index.html')
  } catch {
    filePath = join(rootNorm, 'index.html') // SPA fallback:未知前端路由交客户端路由
  }

  let st
  try { st = statSync(filePath) } catch { return false }
  if (!st.isFile()) return false

  const ct = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
  const headers = { 'Content-Type': ct, 'Content-Length': st.size }
  if (filePath.endsWith('index.html')) headers['Cache-Control'] = 'no-cache'
  else if (rel.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'

  res.writeHead(200, headers)
  if (req.method === 'HEAD') { res.end(); return true }
  createReadStream(filePath).pipe(res)
  return true
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test server/static.test.mjs`
Expected: PASS（全部 9 个 test）。

- [ ] **Step 6: 挂进 `test:server` 链**

修改 `package.json` 的 `scripts.test:server`：在末尾 `&& node --test scripts/i18n-check.test.mjs` **之前**插入 `&& node --test server/static.test.mjs`。结果形如：

```
... && node --test server/reconcile.test.mjs && node --test server/static.test.mjs && node --test scripts/i18n-check.test.mjs
```

- [ ] **Step 7: 跑全量测试 + typecheck**

Run: `npm run typecheck && npm test`
Expected: 全绿（含新增 `server/static.test.mjs`，且不破坏既有用例）。

- [ ] **Step 8: 提交**

```bash
git add server/static.mjs server/static.test.mjs package.json
git commit -m "$(cat <<'EOF'
feat(server): 抽出 static.mjs 静态前端服务模块(SPA)+ 单测

无副作用纯模块,GET/HEAD 读 dist/、防穿越、未知路由回 index.html;/api 前缀交 404 兜底保留 API JSON 契约。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 把 `serveStatic` 接入 `server/index.mjs`

**Files:**
- Modify: `server/index.mjs`（import 区 ~行 24；路径常量 ~行 42；末尾兜底 行 2090-2094）

**Interfaces:**
- Consumes: `serveStatic(req,res,url,{root})` from Task 1（签名见上）。

- [ ] **Step 1: 加 import**

在 `server/index.mjs` 第 24 行 `import { reconcileProject } from './reconcile.mjs'` 之后新增一行：

```js
import { serveStatic } from './static.mjs'
```

- [ ] **Step 2: 定义 `STATIC_DIR`**

在第 42 行 `const WORKBENCH_DIR = process.env.ALIANG_WORKBENCH_DIR || join(__dirname, '..', 'data', 'workbench')` 之后新增：

```js
const STATIC_DIR = process.env.ALIANG_STATIC_DIR || join(__dirname, '..', 'dist')
```

- [ ] **Step 3: 在 404 兜底前调用 `serveStatic`**

找到 `server/index.mjs` 末尾这段（约行 2090-2094）：

```js
  // 兜底:未匹配的路由返 404。否则 handle() 直接 return、响应永不结束 → 前端 fetch 挂起
  // (如旧 gateway 缺新端点时,LLM 配置页一直转圈)。所有路由块都显式 return,此处只在无匹配时触发。
  return sendJson(res, 404, { message: `not found: ${req.method} ${url.pathname}` })
```

在「`// 兜底:未匹配的路由返 404…`」注释**之前**插入：

```js
  // 非匹配 /api/* 路由兜底:GET/HEAD → 服务 dist/ 静态前端(SPA);其余维持 404 JSON。
  if (serveStatic(req, res, url, { root: STATIC_DIR })) return

```

（保持既有 404 注释与 `return sendJson(...)` 原样不动。）

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: PASS（`node --check server/index.mjs` 无语法错）。

- [ ] **Step 5: 构建前端 dist（静态服务的根）**

Run: `npm run build`
Expected: 产出 `dist/index.html` + `dist/assets/*`。

- [ ] **Step 6: 冒烟——启动服务,curl 三种路径**

后台启服务并验：

```bash
PORT=8787 node server/index.mjs &
SVC=$!
sleep 1
echo "--- /api/health (API:JSON) ---"; curl -s http://127.0.0.1:8787/api/health
echo "--- / (前端:index.html) ---"; curl -s http://127.0.0.1:8787/ | head -3
echo "--- /random-spa-route (SPA fallback) ---"; curl -s http://127.0.0.1:8787/random-spa-route | head -3
echo "--- /api/nonexistent (未知 API 仍 404 JSON) ---"; curl -s http://127.0.0.1:8787/api/nonexistent
kill $SVC
```

Expected：
- `/api/health` → 既有 JSON。
- `/` → `<!doctype html>` 开头的 SPA HTML。
- `/random-spa-route` → 同样回 SPA HTML（客户端路由接管）。
- `/api/nonexistent` → `{"message":"not found: GET /api/nonexistent"}`（JSON，**未被静态吞掉**）。

- [ ] **Step 7: 提交**

```bash
git add server/index.mjs
git commit -m "$(cat <<'EOF'
feat(server): index.mjs 接入静态前端服务(/api 未命中→dist/ SPA)

/api/* 路由不动;仅 GET/HEAD 非 API 路径走 serveStatic,生产同源服务前端+API。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `Dockerfile` + `.dockerignore`

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: Task 2 的 `serveStatic`（镜像里 `dist/` 由 build 阶段产出 → `STATIC_DIR=/app/dist` 命中）。

- [ ] **Step 1: 写 `.dockerignore`**

```
node_modules
dist
data
.git
.gitignore
.playwright-mcp
.claude
.gstack
.superpowers
.aliang
tests
screenshots
docs
*.md
.crud-rework-report.md
.vscode
.idea
.DS_Store
*.log
```

（保留构建输入：`src/ server/ scripts/ public/ index.html *.config.js vite.config.js package*.json`。）

- [ ] **Step 2: 写 `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

# ---- build：编译前端 dist/（含 devDeps：vite/tailwind/…）----
FROM node:25-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime：单进程 Node 服务 API + 静态 ----
FROM node:25-alpine
WORKDIR /app
RUN apk add --no-cache git
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/ ./server/
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
USER node
EXPOSE 8787
VOLUME /app/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "server/index.mjs"]
```

- [ ] **Step 3: 本地构建镜像**

> 需要 Docker daemon。如环境无 docker，跳过 Step 3-5 并在 PR 说明（CI 会兜底构建）。

Run: `docker build -t aliangboard:smoke .`
Expected: 构建成功，末阶段 `RUN npm run build` 产出 dist、runtime 阶段装 git + prod deps 完毕。

- [ ] **Step 4: 冒烟——跑容器,curl**

```bash
docker rm -f aliang-smoke 2>/dev/null
docker run -d --name aliang-smoke -p 8788:8787 -v aliangboard-smoke-data:/app/data aliangboard:smoke
sleep 2
echo "--- health ---"; curl -s http://127.0.0.1:8788/api/health
echo "--- / (前端) ---"; curl -s http://127.0.0.1:8788/ | head -3
echo "--- 非 root 验证 ---"; docker exec aliang-smoke id
docker rm -f aliang-smoke
```

Expected：
- `/api/health` → JSON。
- `/` → SPA HTML。
- `id` → `uid=1000(node)…`（非 root）。

- [ ] **Step 5: 验多架构 buildx 可解析（可选,本地不实际推）**

Run: `docker buildx ls >/dev/null 2>&1 && echo "buildx ok" || docker buildx create --use`
（仅确认 buildx 可用；实际多架构构建在 CI 跑。）

- [ ] **Step 6: 提交**

```bash
git add Dockerfile .dockerignore
git commit -m "$(cat <<'EOF'
feat(docker): 多阶段 Dockerfile + .dockerignore,单进程自包含镜像

node:25-alpine(node:sqlite);装 git(workbench);npm ci --omit=dev 瘦运行时;非 root + HEALTHCHECK + VOLUME /app/data。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `.github/workflows/docker.yml`（main → 多架构 ghcr）

**Files:**
- Create: `.github/workflows/docker.yml`

- [ ] **Step 1: 写 workflow**

```yaml
name: build-and-publish-image

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up QEMU（arm64 仿真）
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Docker meta（标签）
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/aliangboard
          tags: |
            type=raw,value=latest
            type=raw,value=main
            type=sha,format=short,prefix=sha-

      - name: Build and push（amd64+arm64）
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: YAML 语法校验（用既有 js-yaml 依赖,零新增）**

Run:
```bash
node --input-type=module -e "import {load} from 'js-yaml'; import {readFileSync} from 'node:fs'; load(readFileSync('.github/workflows/docker.yml','utf8')); console.log('YAML OK')"
```
Expected: 输出 `YAML OK`（解析无误）。

- [ ] **Step 3: （若 owner 可能含大写）加小写化保护**

若镜像到 GitHub 的 owner 不保证全小写，在 `login` 步骤前加一步把 owner 转小写并用于 `images`：

```yaml
      - name: Lowercase owner
        id: owner
        run: echo "lc=$(echo '${{ github.repository_owner }}' | tr '[:upper:]' '[:lower:]')" >> "$GITHUB_OUTPUT"
```
并把 metadata-action 的 `images:` 改成 `ghcr.io/${{ steps.owner.outputs.lc }}/aliangboard`。

> owner 已全小写则跳过本步（默认走 `${{ github.repository_owner }}`）。

- [ ] **Step 4: 提交**

```bash
git add .github/workflows/docker.yml
git commit -m "$(cat <<'EOF'
ci: main 分支推送自动构建 amd64+arm64 镜像并推 ghcr

QEMU+buildx 多架构;GITHUB_TOKEN 免密;标签 latest/main/sha-<短>;gha 缓存。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: README 追加「容器部署」一节

**Files:**
- Modify: `README.md`（在「## 当前边界」之前插入新章节）

- [ ] **Step 1: 插入新章节**

在 `README.md` 的「## 当前边界」（约行 105）**之前**插入：

```markdown
## 容器部署

仓库提供多阶段 `Dockerfile`：单进程 Node 同时服务前端静态文件与 API Gateway，开箱即用。

本地构建并运行：

```bash
docker build -t aliangboard .
docker run -d --name aliangboard \
  -p 8787:8787 \
  -v aliangboard-data:/app/data \
  aliangboard
```

浏览器打开 `http://localhost:8787` 即可。SQLite 库与 workbench git 仓库持久化在 `aliangboard-data` 卷中，**包含凭据，请妥善保管**。

> 运行时镜像基于 `node:25-alpine`（`node:sqlite` 硬依赖），内置 `git`（工作台 repo 存储需要）。以非 root 用户 `node` 运行。

容器相关变量（覆盖同名后端变量）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 容器内监听地址（镜像已设，勿改回 127.0.0.1） |
| `PORT` | `8787` | 监听端口 |
| `ALIANG_DB` | `/app/data/aliangboard.db` | SQLite 库路径（位于卷内） |
| `ALIANG_WORKBENCH_DIR` | `/app/data/workbench` | 工作台 git 仓库目录（位于卷内） |
| `ALIANG_STATIC_DIR` | `/app/dist` | 前端静态目录（一般无需改动） |

### CI 自动发布

推送到 GitHub `main` 分支时，`.github/workflows/docker.yml` 会自动构建 `linux/amd64` + `linux/arm64` 多架构镜像并发布到 GitHub Container Registry：

```
ghcr.io/<你的-github-owner>/aliangboard:latest
ghcr.io/<你的-github-owner>/aliangboard:main
ghcr.io/<你的-github-owner>/aliangboard:sha-<7位提交哈希>
```

`sha-<哈希>` 标签不可变，可用于精确回滚。认证使用内置 `GITHUB_TOKEN`，无需额外配置 secret。

```

- [ ] **Step 2: 校验 README 无破损**

Run: `npm run typecheck`（不影响 .md，仅作 sanity）；目测 markdown 代码围栏闭合。
Expected: 无异常。

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(readme): 新增容器部署章节(构建/运行/卷/env/CI 发布)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 完成验收（全任务后）

- [ ] `npm run typecheck && npm test` 全绿。
- [ ] 本地 `docker build -t aliangboard .` + `docker run` 冒烟通过（需 docker）。
- [ ] `.github/workflows/docker.yml` YAML 校验通过。
- [ ] 推 `feat/docker-cicd` 到 GitHub 后，开 PR；合并到 `main` 触发一次 CI，确认 ghcr 出现 `latest`/`main`/`sha-*` 三标签且 amd64+arm64 均构建成功。
- [ ] 在 ghcr 包设置里把可见性按需调为 public/private。

## Self-Review（写完后自查结果）

- **Spec 覆盖**：spec §4 Dockerfile→Task 3；§5 静态服务→Task 1+2；§6 .dockerignore→Task 3；§7 workflow→Task 4；§8-9 README→Task 5；§10 测试→Task 1 单测 + 各任务冒烟。无遗漏。
- **无占位符**：所有代码块均为完整可执行内容，无 TBD/「类似上任务」。
- **类型/签名一致**：`serveStatic(req,res,url,{root})→boolean` 在 Task 1（定义）、Task 2（调用）一致；`MIME` 仅 Task 1 内部用。
- **spec 偏离已记录**：静态服务从「inline 进 index.mjs」改为「抽 `server/static.mjs` 模块」（可测、无副作用），优于 spec 原案，已在 Task 1 注释与文件结构表说明。
