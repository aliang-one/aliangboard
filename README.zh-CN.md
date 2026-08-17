[English](README.md) | **简体中文**

# AliangBoard

[![CI](https://github.com/aliang-one/aliangboard/actions/workflows/docker.yml/badge.svg)](https://github.com/aliang-one/aliangboard/actions/workflows/docker.yml)
[![ghcr](https://img.shields.io/badge/ghcr-aliangboard-blue)](https://github.com/aliang-one/aliangboard/pkgs/container/aliangboard)
[![Node](https://img.shields.io/badge/node-25%2B-339933)](https://nodejs.org)
[![Vue](https://img.shields.io/badge/vue-3-42b883)](https://vuejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

> 开源的 AI 原生 Kubernetes 管理面板——在完整的多集群管理之上,用自然语言操作集群。

AliangBoard 把大模型变成集群里的操作员:通过内置的 **Agent 工作台**与 **MCP 服务**,你可以用自然语言查看 Pod 日志、调试容器、回滚发布或修改资源。同时它也是一款完整的 Kubernetes 面板,覆盖资源全生命周期、exec / 端口转发 / 调试容器注入与多集群切换。

一句话技术栈:Vue 3 + Vite + Pinia 前端(纯 JS,无 TypeScript)+ Node 透明 Kubernetes API 网关(零额外运行时依赖)。

## ✨ 功能特性

### 🤖 AI 运维

- Agent 工作台 + MCP 服务(Streamable HTTP、API-key 认证)
- 工具分级:读(免审批)/ 运维 / 管理(需人工审批);写操作一律人工审批
- 全量审计日志(谁 / 动作 / 资源 / HTTP 状态码)
- 对话可挂到后台,随时从悬浮入口重新打开

### 🔌 集群与多集群

- Bearer Token / Basic Auth 连接校验、会话恢复、登出
- 已连接集群持久化保存;一键切换或移除

### 🗂 资源全生命周期

- 同步 30+ 类资源;结构化创建表单(内置 20 种)经 Server-Side Apply 持久化
- YAML 编辑 / 导出;乐观删除、失败可回滚;多文档 YAML 一次性 apply
- 资源覆盖表(见下)

| 分类 | 资源 |
|---|---|
| 核心工作负载 | Pod · Deployment · StatefulSet · DaemonSet |
| 网络 | Service · Ingress · Endpoints · NetworkPolicy · IngressClass |
| 配置与存储 | ConfigMap · Secret · PVC · PV · StorageClass |
| RBAC | Role · ClusterRole · RoleBinding · ClusterRoleBinding · ServiceAccount |
| 集群与策略 | Namespace · Node · Event · RuntimeClass · PriorityClass · ResourceQuota · LimitRange · PDB |
| 弹性伸缩 | HPA |
| 扩展 | CRD 与自定义资源(API 发现驱动) |

### 🖥 Pod 深度操作

- exec 终端(xterm.js,**tmux 加持:刷新页面不掉线**)
- attach · 端口转发(Service / Deployment 经 endpoints 解析到后端 Pod)
- 文件浏览(带进度的上传 / 下载)· kubectl debug 注入(临时容器)

### 🔁 发布与节点运维

- 扩缩容 · 滚动重启 · 回滚 · CronJob 手动触发
- 节点封锁 / 解封 / 驱逐(policy/v1 Eviction)

### 🔍 导航与洞察

- 全局搜索(跨资源、跨命名空间)· ownerReferences 归属拓扑,可点击跳转
- 事件实时 watch + involvedObject 过滤
- 命名空间应用分层(展现层 / 网关 / 微服务 / 中间件 / 持久层,默认启发式识别,可用标签 `layer.aliangboard.io` 精确指定)
- 指标图表(CPU / 内存采样,15 分钟持久化窗口)

## 📸 截图

<!-- TODO: 补充 2–4 张截图(登录页 / 资源列表 / exec 终端 / Agent 工作台),存放到 docs/ 或仓库根目录后嵌入此处。 -->

## 🚀 快速开始

### Kubernetes(推荐)

一条命令安装到 `aliangboard` 命名空间(NodePort 暴露,1Gi PVC 由默认 StorageClass 动态供给):

```bash
kubectl apply -f https://raw.githubusercontent.com/aliang-one/aliangboard/main/deployment.yaml
kubectl -n aliangboard get svc aliangboard   # 从 PORT(S) 列读 NodePort,如 8787:31234/TCP
```

在浏览器打开 `http://<任意节点 IP>:<NodePort>`。

- 默认管理员 `admin` / `admin`——仅在首次启动时经 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 播种(播种后再改环境变量无效);生产环境 apply 前请先设置强口令
- 面板数据(API key、集群凭据、审计日志、工作台仓库)持久化在 `aliangboard-data` PVC;SQLite 存储为单副本——请勿调大 `replicas`
- 在 Kubernetes 集群内运行时,API 地址可填 `https://kubernetes.default.svc`,但默认 ServiceAccount 没有 RBAC 权限(会得到 403):请自建具备所需 RBAC 的 ServiceAccount,用 `kubectl create token` 获取 token,并提供集群 CA 证书(或用不安全选项跳过校验,仅限开发环境)
- 卸载会删除全部数据:`kubectl delete ns aliangboard`(命名空间删除会级联删除 PVC)

### Docker

镜像发布在 GHCR:

```bash
docker pull ghcr.io/aliang-one/aliangboard:latest
docker run -d --name aliangboard \
  -p 8787:8787 \
  -v aliangboard-data:/app/data \
  ghcr.io/aliang-one/aliangboard:latest
```

或本地构建:

```bash
docker build -t aliangboard .
docker run -d --name aliangboard -p 8787:8787 -v aliangboard-data:/app/data aliangboard
```

在浏览器打开 `http://localhost:8787`。SQLite 数据库与工作台 git 仓库持久化在 `aliangboard-data` 卷中——**其中含凭据,请妥善保管**。

### 源码运行

需要 Node.js 25+(服务端使用内置 `node:sqlite` 模块,Node 25 起免 flag;22–24 为实验特性,需加 `--experimental-sqlite`)。另需能访问目标 Kubernetes API server 的网络,以及具备所需 RBAC 权限的 token 或账号。

```bash
git clone https://github.com/aliang-one/aliangboard.git aliangboard && cd aliangboard
npm install
npm run server   # 终端 1:API 网关
npm run dev      # 终端 2:前端 dev server(Vite 将 /api 代理到 127.0.0.1:8787)
```

生产构建:`npm run build`(产物在 `dist/`,由网关的 `server/static.mjs` 同源伺服)。

## 🤖 AI 工作台与 MCP

AliangBoard 通过两条路径把大模型变成集群操作员。

### 内置 Agent 工作台

在管理后台的「Agent 控制台」里直接与集群对话。Agent 经绑定的 ServiceAccount 调用一组 Kubernetes 工具:

- **读取(免审批)**:Pod 日志 · 资源列表 / 详情与 YAML · 事件 · `can-i` RBAC 自检 · 发布历史
- **运维(需人工审批)**:扩缩容(1..20,不可缩到 0)· 滚动重启
- **管理(需人工审批)**:执行命令 · 读取 / 浏览容器文件 · apply / 删除资源 · 更新镜像 · kubectl debug 注入 · 回滚到指定版本

**每一次写操作都要过人工审批关**——Agent 提议,你确认,不会有任何改动在你不知情时落到集群上。

### MCP 服务(面向外部 AI 客户端)

AliangBoard 同时也是一个 **MCP 服务**(`POST /mcp`,Streamable HTTP、API-key 认证),把同一套工具暴露给 Claude Code 等外部 AI 客户端:

```bash
claude mcp add --transport http aliangboard {HOST}/mcp \
  --header "Authorization: Bearer <YOUR_API_KEY>"
```

移除:`claude mcp remove aliangboard`

### 自带大模型

Agent 走 **OpenAI 兼容协议**。在管理后台「LLM 设置」里填写 `baseURL` + `apiKey` + `model`,或设置环境变量 `LLM_BASE_URL` / `LLM_MODEL`。OpenAI、DeepSeek、Qwen、GLM,以及本地 vLLM / Ollama(OpenAI 兼容端点)均可使用。

### 安全模型

- 每个 API key **绑定一个 ServiceAccount**;工具调用受该 SA 的 Kubernetes RBAC 约束
- 工具按 **读 / 运维 / 管理** 三级分层;`minTier` 过滤每个 key 可用的工具
- 写操作与工作台文件写入**一律需人工审批**
- 每次调用都记入**审计日志**(谁 / 动作 / 资源 / HTTP 状态码)

## ⚙️ 配置

后端环境变量:

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | API 网关监听地址 |
| `PORT` | `8787` | API 网关监听端口 |
| `CORS_ORIGIN` | `*` | 允许的前端来源;生产环境请设置为实际域名 |
| `SESSION_TTL_MS` | `28800000` | 内存会话有效期,默认 8 小时 |
| `K8S_REQUEST_TIMEOUT` | `15000` | Kubernetes API 请求超时,单位毫秒 |
| `K8S_ALLOWED_HOSTS` | 空 | API server 主机白名单,逗号分隔 |
| `K8S_INSECURE_SKIP_TLS_VERIFY` | `false` | 跳过集群证书校验;仅限开发环境使用 |
| `PORT_FORWARD_HOST` | `127.0.0.1` | 端口转发本地监听地址(与 kubectl port-forward 相同;只监听网关主机本地,浏览器须能访问到) |
| `LLM_BASE_URL` | 空 | OpenAI 兼容的 LLM baseURL(也可在管理后台「LLM 设置」中配置) |
| `LLM_MODEL` | 空 | LLM 模型名(也可在管理后台配置) |

前端环境变量:

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | 空 | API 网关完整地址;同源部署请留空 |
| `ALIANGBOARD_API_URL` | `http://127.0.0.1:8787` | Vite 开发代理目标 |

开发期要连接自签名证书的集群,可临时运行:

```bash
K8S_INSECURE_SKIP_TLS_VERIFY=true npm run server
```

生产环境请勿跳过 TLS 校验;应改为给 API 网关配置可信 CA,并设置 `K8S_ALLOWED_HOSTS` 与准确的 `CORS_ORIGIN`。

## 🔐 RBAC 建议

不要使用长期有效的 `cluster-admin` token。请创建专用 ServiceAccount,只授予实际使用所需的最小权限:

- 资源的 `get`、`list`、`watch`
- 需要编辑的资源上的 `create`、`update`、`patch`、`delete`
- Pod 日志的 `get`
- Pod 驱逐的 `create`
- 节点操作的 `patch`
- exec 终端的 `pods/exec`(`create`)
- 端口转发的 `pods/portforward`(`get` / `create`)
- 调试容器注入的 `pods/ephemeralcontainers`(`update`)
- pod attach 的 `pods/attach`(`create`)
- CronJob 手动触发的 `jobs`(`create`)

API 网关默认把集群凭据与会话保存在内存中,重启后所有登录会话丢失(容器部署时凭据持久化在 `/app/data` 卷中)。多实例生产部署请把会话与加密后的集群凭据迁移到专用存储。

## 🐳 容器部署与发布

仓库自带多阶段 `Dockerfile`:单个 Node 进程同时伺服前端静态文件与 API 网关,开箱即用。

容器内变量(同名时覆盖后端变量):

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 容器内监听地址(镜像已设置;请勿改回 127.0.0.1) |
| `PORT` | `8787` | 监听端口 |
| `ALIANG_DB` | `/app/data/aliangboard.db` | SQLite 数据库路径(卷内) |
| `ALIANG_WORKBENCH_DIR` | `/app/data/workbench` | 工作台 git 仓库目录(卷内) |
| `ALIANG_STATIC_DIR` | `/app/dist` | 前端静态目录(一般无需修改) |

> 运行镜像基于 `node:25-alpine`(`node:sqlite` 硬性要求),内置 `git`(工作台仓库需要),以非 root 用户 `node` 运行。

### 发布与 CI

- 构建仅由推送 `v*` 标签(如 `v1.2.3`)或从 Actions 页面手动 `workflow_dispatch` 触发;普通 push 不构建镜像
- GHCR 上发布的镜像标签:
  - `ghcr.io/aliang-one/aliangboard:latest`——跟随最新发布
  - `ghcr.io/aliang-one/aliangboard:1.2.3`——不可变 semver 精确锁定
  - `ghcr.io/aliang-one/aliangboard:1.2`——随每次 minor 发布滚动更新
- 多平台 `linux/amd64` + `linux/arm64`;认证使用内置 `GITHUB_TOKEN`,无需额外 secrets
- 历史镜像由 cleanup 工作流自动清理
- 当前发布版本:`v1.0.3`

## ⚠️ 已知限制

- exec 终端、端口转发、文件浏览仅在连接真实集群后可用;未连接时相关入口显示空态
- 端口转发在网关主机上开启本地 TCP 监听(默认 `127.0.0.1`,与 kubectl port-forward 相同)。面板跑在远程主机时,浏览器无法直达该端口——请用 SSH 隧道等方式访问
- exec 终端默认运行 `/bin/sh`(可经组件的 `command` prop 调整);distroless 等无 shell 镜像请用 kubectl debug 注入带 shell 的临时容器(需 Kubernetes 1.25+;EphemeralContainers 默认开启)
- 多集群切换复用网关会话;网关重启后会话丢失,已保存的集群需重新登录。会话凭据仅存于浏览器 localStorage——请勿在共用设备上使用
- 「审计」页展示的是集群 Events 作为活动记录;完整的用户级审计(谁 / 动作 / IP / HTTP 状态码)需要集群审计日志接入日志后端——标准 Kubernetes API 不提供
- Helm、GitOps 与告警尚未集成
- HPA / PDB 依赖特定 API 版本(如 autoscaling/v2、policy/v1);在旧集群上相应创建会失败并弹 toast 提示
- 部署在 Kubernetes 集群内时,端口转发监听开在面板 Pod 的网络命名空间中,浏览器无法直达;该能力面向 Docker / 源码部署,集群内安装暂不可用(后续可能提供网关侧代理)

## 🛠 技术栈

**前端** — Vue 3 · Vite · Pinia · Vue Router · @tanstack/vue-query · vue-i18n · xterm.js · marked · DOMPurify(纯 JS,无 TypeScript)

**后端** — Node.js 25(内置 `node:sqlite`)· @kubernetes/client-node · 透明 Kubernetes API 网关,零额外运行时依赖

**测试** — 服务端与纯逻辑测试跑自研零依赖运行器 + `node --test`;前端单测用 vitest + @vue/test-utils + happy-dom

**打包** — 单个多阶段 Docker 镜像(`node:25-alpine`),一个进程同源伺服 API + SPA

## 🤝 参与贡献

欢迎 Issue 与 PR。本地开发:

```bash
npm install
npm run server     # API 网关
npm run dev        # 前端
npm test           # 服务端 + 纯逻辑测试
npm run test:unit  # 前端单测(vitest)
npm run typecheck  # node --check 语法基线
```

**双语同步约定**:任何对 `README.md` 的修改,必须在同一个 PR 中同步更新 `README.zh-CN.md`。

## 许可证

[Apache License 2.0](./LICENSE)。允许商业使用、修改、分发与私用,但须保留版权与许可声明。
