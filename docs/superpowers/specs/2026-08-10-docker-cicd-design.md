# Docker 打包 + GitHub Actions 多架构 CI/CD 设计

日期：2026-08-10
分支：feat/workbench-cursor-chat（新起分支落代码）

## 1. 目标与范围

让 AliangBoard 可以：

1. **本地一键打包**：`docker build -t aliangboard .` 产出可独立运行的容器镜像（前端 + 网关单进程，无需外部静态服务器）。
2. **CI 自动构建**：仓库经 GitLab 镜像推到 GitHub 后，**只在 `main` 分支有推送时**，自动构建并推送多架构（amd64 + arm64）镜像到 GitHub Container Registry（ghcr.io）。

镜像目标仓库：`ghcr.io/<github-repo-owner>/aliangboard`（owner 用 `${{ github.repository_owner }}` 动态取，无需硬编码）。

### 关键现状（探查结论）

- `server/index.mjs` 是 **API-only**：所有未匹配路由最终 `return sendJson(res, 404, …)`（行 2092），**不服务任何静态文件**，也没有 SPA fallback。前端 `dist/` 被 `.gitignore`，目前生产无宿主。
- `/api/exec` 走 **WebSocket 升级**（同一 httpServer 的 `upgrade` 事件），`/api/portforward` 走 SPDY/WS 多路复用 —— 这意味着“谁代理流量谁必须保 WS upgrade”，是 nginx 方案的踩坑点。
- 服务器 shell-out **只有 `git`**（`workbench-repos.mjs` 的 `execFile('git', …)`），**无 `kubectl`** 子进程（K8s 操作全走 `@kubernetes/client-node` in-process）。→ 运行时镜像需装 `git`，不需 `kubectl`。
- 运行时状态：`data/aliangboard.db`（SQLite，**含凭据**）+ `data/workbench/`。必须挂卷，**禁止烤进镜像**。
- 服务器监听 `HOST`（默认 `127.0.0.1`）→ 容器内必须覆盖 `HOST=0.0.0.0`。
- **`import { DatabaseSync } from 'node:sqlite'`（行 25）是硬依赖**。该 built-in 在 Node 22/23 仍是 experimental（需 `--experimental-sqlite` 标志），到 Node 25 才无标志可用。本地开发跑 Node 25.4.0 无标志即可。→ 镜像 base 锁 **`node:25-alpine`**（与开发环境同 major，行为一致），不用 22-alpine。

## 2. 拓扑决策（已与用户确认）

**单进程 Node 同时服务 API + 静态前端。** 理由：

- 服务器已直接处理 `/api/exec` 的 WS —— 同一进程同源，**零代理配置、零 WS upgrade 踩坑**。
- 单进程、单容器、单镜像，最贴合用户“dockerfile 直接打包”诉求。
- 代价仅一处应用代码改动（~25 行静态服务）。

已否决：① nginx+Node 双进程单镜像（进程托管反模式 + WS upgrade 配置易错）；② 前后端双镜像（两个产物，部署复杂度上升，超出诉求）。

## 3. 触发与镜像标签决策（已与用户确认）

用户明确：**只在 `main` 分支打包**，不再用 `v*` 标签触发。

- 触发：`push.branches: [main]` + `workflow_dispatch`（手动兜底）。
- 因无 git tag，**不再产 semver 标签**。镜像标签：
  - `latest` —— 滚动，始终指向 main 最新构建。
  - `main` —— 同上，语义别名。
  - `sha-<7位短哈希>` —— **不可变、逐 commit**，供回滚/精确引用。
- 多架构 manifest：`linux/amd64,linux/arm64`，QEMU 仿真 arm64。

## 4. Dockerfile（多阶段）

```dockerfile
# syntax=docker/dockerfile:1

# ---- build：编译前端 dist/（含 devDeps：vite/tailwind/…）----
FROM node:25-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .                       # .dockerignore 已剔 node_modules/dist/data/.git 等
RUN npm run build              # → /app/dist

# ---- runtime：单进程 Node 服务 API + 静态 ----
FROM node:25-alpine
WORKDIR /app
RUN apk add --no-cache git     # workbench-repos 需要 git 二进制
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force   # 仅 dependencies
COPY server/ ./server/
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app/data   # 卷属主交 node
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
USER node                      # 非 root 运行（node:alpine 默认是 root）
EXPOSE 8787
VOLUME /app/data               # SQLite + workbench repos（含凭据，勿入镜像）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "server/index.mjs"]
```

要点：
- **base = `node:25-alpine`**：因 `node:sqlite` 硬依赖（见 §1）。备选：`node:22-alpine` + `CMD ["node","--experimental-sqlite","server/index.mjs"]`，但与开发环境（25）行为可能有差，不推荐。
- 运行时 `npm ci --omit=dev`：只装 `dependencies`（ws/undici/@kubernetes/client-node/js-yaml 等），不装 vite/tailwind 等构建工具；node_modules 属 root，node 只读执行即可。
- **非 root**：显式 `USER node`（`node:alpine` 自带 uid 1000 的 `node` 用户，但默认仍以 root 跑）。先 `chown -R node:node /app/data` 再切用户：服务器启动会 `mkdirSync(/app/data)`、写 SQLite 与 workbench git repos，必须对 `/app/data` 可写。命名/匿名卷首挂时 Docker 会把镜像里 `/app/data` 的属主一并拷进卷，故 node 可写。
- `HEALTHCHECK` 调既有 `/api/health`（GET，行 819）。alpine 自带 `wget`。

## 5. server/index.mjs 静态服务改动（~25 行）

### 插入位置

`handle(req, res)` 末尾、最终 `return sendJson(res, 404, …)`（行 2092）**之前**。所有 `/api/*` 路由块都显式 `return`，所以到达此处的一定是非 API 请求（注释已说明，行 2090-2091）。

### 行为

- 仅处理 `GET`/`HEAD`；其他方法 → 落到既有 404 JSON。
- **守卫**：`url.pathname` 以 `/api` 开头 → 直接 `return false`（保留“未知 API 路由返 404 JSON”契约，不被 SPA fallback 吞掉）。
- 路径解析到 `dist/<pathname>`（`ALIANG_STATIC_DIR` 可覆盖，默认 `join(__dirname,'..','dist')`），**防穿越**：`normalize` 后必须仍 `startsWith(STATIC_DIR)`。
- 文件存在且是文件 → 流式输出，按扩展名给 MIME；`/assets/*`（Vite 哈希产物）给 `Cache-Control: public, max-age=31536000, immutable`。
- 目录或不存在 → 回 `dist/index.html`（SPA 客户端路由接管 `/workloads` 等前端路由）；`index.html` 本身 `Cache-Control: no-cache`。
- `HEAD` 只写 header、`res.end()`。

### 需扩展的既有 import

```js
// 行 26：node:fs 加 createReadStream、statSync
import { readFileSync, mkdirSync, chmodSync, createReadStream, statSync } from 'node:fs'
// 行 7：node:path 加 normalize、extname
import { dirname, join, normalize, extname } from 'node:path'
```
`__dirname`（行 37）已就绪。

### 参考实现（plan 阶段细化，保持此语义）

```js
const STATIC_DIR = process.env.ALIANG_STATIC_DIR || join(__dirname, '..', 'dist')
const MIME = {
  '.html': 'text/html; charset=utf-8',  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',    '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',              '.png': 'image/png',
  '.jpg': 'image/jpeg',                 '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',               '.woff': 'font/woff',
  '.woff2': 'font/woff2',               '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (url.pathname.startsWith('/api')) return false
  const rel = decodeURIComponent(url.pathname)
  const safe = normalize(join(STATIC_DIR, rel))
  if (!safe.startsWith(STATIC_DIR)) return false
  let filePath = safe, fallback = false
  try {
    const st = statSync(filePath)
    if (st.isDirectory()) { filePath = join(filePath, 'index.html') }
  } catch { filePath = join(STATIC_DIR, 'index.html'); fallback = true }
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return false
    const ct = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
    const head = { 'Content-Type': ct, 'Content-Length': st.size }
    if (filePath.endsWith('index.html')) head['Cache-Control'] = 'no-cache'
    else if (rel.startsWith('/assets/')) head['Cache-Control'] = 'public, max-age=31536000, immutable'
    res.writeHead(200, head)
    if (req.method === 'HEAD') { res.end(); return true }
    createReadStream(filePath).pipe(res)
    return true
  } catch { return false }
}
```

调用点（行 2092 前）：

```js
  // 非匹配 /api/* 路由兜底：GET/HEAD → 服务 dist/ 静态前端(SPA);其余维持 404 JSON
  if (serveStatic(req, res, url)) return
  // 兜底:未匹配的路由返 404……（既有注释保留）
  return sendJson(res, 404, { message: `not found: ${req.method} ${url.pathname}` })
```

## 6. `.dockerignore`

排除（不进构建上下文，加速 build、防凭据泄漏）：

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

保留（构建输入）：`src/ server/ scripts/ public/ index.html *.config.js vite.config.js package*.json`。
注意 `data/` **必须**排除（含 SQLite 凭据）。

## 7. `.github/workflows/docker.yml`（main → 多架构 ghcr）

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

要点：
- `${{ secrets.GITHUB_TOKEN }}` 由 Actions 自动注入，**无需手动配 secret**。
- 首次推送后，ghcr 包默认随仓库可见性；个人/组织设置里可调 public/private。
- `cache-from/to: type=gha` 走 Actions 缓存，二次构建加速。
- `type=sha,format=short,prefix=sha-` → 每次产 `sha-abc1234` 不可变标签。

## 8. 本地构建与运行（无需 CI）

```bash
docker build -t aliangboard .
docker run -d --name aliangboard \
  -p 8787:8787 \
  -v aliangboard-data:/app/data \
  aliangboard
# 浏览器开 http://localhost:8787
```

单架构本地构建用默认 builder 即可；要本地验多架构需 `docker buildx create --use` + `--platform linux/amd64,linux/arm64`（可选，CI 已覆盖）。

## 9. 环境变量与卷参考（运行时）

| 变量/卷 | 默认 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0`（镜像内设） | 监听地址，容器必须 0.0.0.0 |
| `PORT` | `8787` | 监听端口 |
| `ALIANG_DB` | `/app/data/aliangboard.db` | SQLite 库路径（在卷内） |
| `ALIANG_WORKBENCH_DIR` | `/app/data/workbench` | workbench git repos（在卷内） |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | 可选，首次启种子 admin；不设走 UI 引导 |
| `ALIANG_STATIC_DIR` | `/app/dist` | 静态前端目录（一般不动） |
| `CORS_ORIGIN` | `*` | 同源时无关；跨域调 API 才用 |
| 卷 `/app/data` | — | **必须挂**，否则重启丢库 |

## 10. 测试

仓库零依赖政策：不引 e2e 框架。验证策略：

1. **`npm run typecheck` + `npm run build`**：在 Dockerfile build stage 已跑 `npm run build`，.vue/语法错误会被 Vite 拦下。
2. **静态服务单测（自研零依赖运行器）**：新增 `server/static.test.mjs`，覆盖 `serveStatic`：① `/api/x` 不被吞（返 false → 落 404）；② `GET /` → index.html（200, no-cache）；③ `GET /assets/a.js`（存在）→ 200 + immutable；④ 路径穿越 `GET /../package.json` → false；⑤ 不存在前端路由 `/workloads` → 回 index.html；⑥ `POST /` → false。加入 `scripts/test.mjs` 的 `test:server` 链。
3. **冒烟（手动/CI 后续）**：`docker build` + `docker run` + `curl /api/health` + `curl /`（见 HTML）+ 浏览器开 SPA 路由刷新不 404。
4. **多架构**：CI 首次绿即证 arm64+amd64 都构建成功；本地 `docker run --platform linux/arm64` 在 amd64 机上靠 rosetta/qemu 抽验（可选）。

## 11. 权衡与显式不做（YAGNI）

- **不做**：test-gating job（CI 只打包，不跑全量 `npm test`）、`:edge`/其他分支构建、镜像签名/SBOM/provenance、Docker Hub 双推。任一项后续易加。
- **prod deps 体积**：vue/pinia/vue-query/prismjs 等在 `dependencies`，`--omit=dev` 仍会装（运行时不用，~几 MB 浪费）。把它们挪 devDeps 是独立、风险更高的改动，本次不做。
- **`:latest` 在每次 main 推送滚动**：与用户确认的语义；需“可回滚”时用 `sha-<short>` 标签。
- **Node 25 非 LTS**：因 `node:sqlite` 硬依赖而选；若后续 `node:sqlite` 在 22 LTS 稳定下放，可降到 `node:22-alpine` 省体积/获 LTS。
- **ghcr 要求小写 owner**：`ghcr.io/${{ github.repository_owner }}/aliangboard` 中 owner 含大写字母会 push 失败。若镜像到 GitHub 的 owner 非全小写，plan 需加一步把 owner 转小写（`repo_owner_lc=$(echo "${{ github.repository_owner }}" | tr A-Z a-z)`）再用于 `images:`。镜像名 `aliangboard` 已是小写，无虞。

## 12. 落地清单（供 writing-plans 展开）

1. 新增 `Dockerfile`（§4）。
2. 新增 `.dockerignore`（§6）。
3. 改 `server/index.mjs`：扩 import + 加 `STATIC_DIR/MIME/serveStatic` + 调用点（§5）。
4. 新增 `server/static.test.mjs` 并挂入 `scripts/test.mjs`（§10）。
5. 新增 `.github/workflows/docker.yml`（§7）。
6. README 追加「容器部署」一节（构建/运行/卷/env），§8+§9 内容。
7. 验证：`npm run typecheck && npm test`、本地 `docker build`+`docker run` 冒烟。
