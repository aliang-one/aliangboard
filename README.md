# AliangBoard

<!-- CI / ghcr badge 在首次推送 main 分支后才会点亮 -->
[![CI](https://github.com/aliangone/aliangboard/actions/workflows/docker.yml/badge.svg)](https://github.com/aliangone/aliangboard/actions/workflows/docker.yml)
[![ghcr](https://img.shields.io/badge/ghcr-aliangboard-blue)](https://github.com/aliangone/aliangboard/pkgs/container/aliangboard)
[![Node](https://img.shields.io/badge/node-25%2B-339933)](https://nodejs.org)
[![Vue](https://img.shields.io/badge/vue-3-42b883)](https://vuejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

> 开源、AI 原生的 Kubernetes 管理面板 —— 自然语言运维 + 全量多集群管理。

AliangBoard 把大模型变成集群里的操作员:内置 **Agent 工作台**与 **MCP server**,你可以用自然语言让模型查 Pod 日志、调试容器、回滚发布、改资源。同时它是一个完整的 K8s 面板,覆盖全量资源生命周期、exec / 端口转发 / 调试容器注入 / 多集群切换。

前端 Vue 3 + Vite + Pinia(纯 JS,无 TypeScript),后端 Node 透传网关(零额外运行时依赖)。

## ✨ 特性

- 🤖 **AI 运维**:Agent 工作台 + MCP server,自然语言操作集群(写操作必人审)
- 🗂 **全量资源**:30+ 资源同步 / 结构化创建表单 / Server-Side Apply / YAML 导出
- 🖥 **Pod 深度运维**:exec 终端 · port-forward · 文件浏览(上传/下载) · kubectl debug 注入 · attach
- 🔁 **发布与节点**:扩缩容 · 滚动重启 · 回滚(rollout undo) · Node cordon/drain
- 🔌 **多集群**:一键切换、持久化、重新登录
- 🔍 **全局搜索 + 资源归属拓扑(ownerReferences)+ Events watch**
- 🏷 **Namespace 应用分层**:按展现层 / 网关 / 微服务 / 中间件 / 持久层 等归类工作负载

## 📸 截图

<!-- TODO: 补 2–4 张截图(登录页 / 资源列表 / exec 终端 / Agent 工作台),放到 docs/ 或仓库根,替换下面的占位:
![Agent 工作台](docs/screenshot-agent.png)
-->

_待补充_

## 🤖 AI 工作台与 MCP

AliangBoard 把大模型变成集群操作员,有两条路径。

### 内置 Agent 工作台

在管理后台「Agent Console」直接和集群对话。Agent 经绑定的 ServiceAccount 调用一组 K8s 工具:

- **只读(免审批)**:查 Pod 日志 · 列/取资源与 YAML · 看 Events · `can-i` 自检 RBAC · rollout 历史
- **运维(需人审)**:扩缩容(1..20,禁 scale 到 0) · 滚动重启
- **管理(需人审)**:exec 命令 · 读/浏览容器文件 · apply / delete 资源 · 更新镜像 · kubectl debug 注入 · 回滚到指定 revision

**写操作一律走人审 checkpoint** —— Agent 提议,你点确认才执行,不会静默改集群。

### MCP Server(接外部 AI)

AliangBoard 同时是一个 **MCP server**(`POST /mcp`,Streamable HTTP,API key 鉴权),把同一组工具暴露给 Claude Code 等外部 AI 客户端:

```bash
claude mcp add --transport http aliangboard {HOST}/mcp \
  --header "Authorization: Bearer <YOUR_API_KEY>"
```

移除:`claude mcp remove aliangboard`

### LLM 接入(Bring Your Own)

Agent 走 **OpenAI 兼容协议**。在管理后台「LLM 配置」填 `baseURL` + `apiKey` + `model`,或设环境变量 `LLM_BASE_URL` / `LLM_MODEL`。OpenAI、DeepSeek、通义千问、GLM、本地 vLLM / Ollama(开 OpenAI 兼容端点)均可接入。

### 安全模型

- 每个 API key **绑定一个 ServiceAccount**,工具调用受该 SA 的 K8s RBAC 约束
- 工具分 **read / operator / admin** 三档,minTier 过滤每个 key 的可用工具
- 写操作 + 工作台文件写入 **必须人审**
- 全量调用写入**审计日志**(who / verb / 资源 / HTTP code)

## 🚀 快速开始

### 方式一:Docker(推荐)

镜像发布在 GHCR(首次推送 main 后可用):

```bash
docker pull ghcr.io/aliangone/aliangboard:latest
docker run -d --name aliangboard \
  -p 8787:8787 \
  -v aliangboard-data:/app/data \
  ghcr.io/aliangone/aliangboard:latest
```

或本地构建:

```bash
docker build -t aliangboard .
docker run -d --name aliangboard -p 8787:8787 -v aliangboard-data:/app/data aliangboard
```

浏览器打开 `http://localhost:8787` 即可。SQLite 库与工作台 git 仓库持久化在 `aliangboard-data` 卷中,**包含凭据,请妥善保管**。

### 方式二:从源码运行

需要 Node.js 25+(`server` 用 `node:sqlite` 内置模块,25 才免标志可用)。

```bash
git clone <repo-url> aliangboard && cd aliangboard
npm install
npm run server   # 终端 1:API Gateway
npm run dev      # 终端 2:前端 dev server(Vite 代理 /api → 127.0.0.1:8787)
```

生产构建:`npm run build`(产物在 `dist/`,网关 `server/static.mjs` 同源服务)。

## 已接入真实集群的能力

- Bearer Token 或 Basic Auth 连接验证
- 会话恢复与退出登录
- 全量资源同步:Namespace、Node、Pod、Deployment、StatefulSet、DaemonSet、Service、Ingress、Endpoints、Event、ConfigMap、Secret、PVC、PV、StorageClass、IngressClass、RuntimeClass、PriorityClass、NetworkPolicy、HPA、ResourceQuota、LimitRange、Role / ClusterRole、ServiceAccount、RoleBinding / ClusterRoleBinding、PDB,以及 CRD 与自定义资源实例
- 结构化创建表单(ConfigMap / Secret / PVC / PV / StorageClass / Ingress / Service / IngressClass / RuntimeClass / PriorityClass / NetworkPolicy / HPA / ResourceQuota / LimitRange / Role / ServiceAccount / RoleBinding / ClusterRoleBinding / PDB / Namespace)通过 Server-Side Apply 落库
- 列表删除(乐观删除 + 失败回滚 + 全局错误提示)
- Pod 删除与真实日志读取(支持多容器选择)
- Deployment / StatefulSet 扩缩容、滚动重启、回滚(kubectl rollout undo)
- Node Cordon、Uncordon 和基于 `policy/v1 Eviction` 的 Drain
- Pod Exec 终端(kubectl exec,xterm.js 实时双向,终端尺寸自适应)—— 浏览器 WebSocket ↔ Gateway ↔ K8s(`@kubernetes/client-node` 处理 SPDY/WS 协议升级)
- 端口转发(kubectl port-forward):Service / Deployment 自动经 endpoints 解析到后端 Pod,在网关本机开本地监听
- Pod 文件浏览(kubectl cp 语义:列目录 / 预览 / 下载 / 上传),基于一次性 exec 落地真实容器文件
- Pod 调试容器注入(kubectl debug / Ephemeral Containers):向无 shell / distroless Pod 注入临时容器排查问题,注入后即可在终端进入该容器
- Pod Attach(kubectl attach):连接容器主进程 stdio,区别于 exec 开新 shell
- 资源归属拓扑:沿 ownerReferences 解析归属链(Pod→ReplicaSet→Deployment…),可点击跳转
- Events 实时推送(events?watch=true)与按 involvedObject 过滤;审计页以集群 Events 作为活动记录
- CronJob 手动触发(kubectl create job --from);通用资源导出 YAML(kubectl get -o yaml)
- 顶栏全局搜索:跨资源 / 跨命名空间检索并跳转
- Namespace 应用分层:按 展现层 / 网关 / 微服务层(业务·支持服务·杂项)/ 中间件 / 持久层 / 存储 / 监控层 归类工作负载·Service·Ingress(默认启发式,可用 label `layer.aliangboard.io` 精确覆盖)
- 多集群:已连接集群持久化,可一键切换或移除
- API Discovery 驱动的 Server-Side Apply(kubectl edit / apply 语义)
- 部署向导支持一次应用多份 YAML 文档

## 环境要求

- **Node.js 25+**(开发 / 源码运行)—— `server/index.mjs` 使用内置 `node:sqlite`(`import { DatabaseSync } from 'node:sqlite'`),该模块在 22–24 仍为 experimental(需 `--experimental-sqlite` 标志),25 起免标志可用。Docker 镜像已用 `node:25-alpine`,无需关心。
- 能访问目标 Kubernetes API Server 的网络
- 具备所需 Kubernetes RBAC 权限的 Token 或账号

## 配置

后端环境变量:

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | API Gateway 监听地址 |
| `PORT` | `8787` | API Gateway 监听端口 |
| `CORS_ORIGIN` | `*` | 允许的前端来源,生产环境应设置为实际域名 |
| `SESSION_TTL_MS` | `28800000` | 内存会话有效期,默认 8 小时 |
| `K8S_REQUEST_TIMEOUT` | `15000` | Kubernetes API 请求超时,单位毫秒 |
| `K8S_ALLOWED_HOSTS` | 空 | 逗号分隔的 API Server 主机允许列表 |
| `K8S_INSECURE_SKIP_TLS_VERIFY` | `false` | 是否跳过集群证书验证,只应用于开发环境 |
| `PORT_FORWARD_HOST` | `127.0.0.1` | 端口转发本地监听地址(同 kubectl port-forward;仅本机可达,浏览器需能访问) |
| `LLM_BASE_URL` | 空 | LLM 的 OpenAI 兼容 baseURL(也可在管理后台「LLM 配置」里设) |
| `LLM_MODEL` | 空 | LLM 模型名(也可在管理后台设) |

前端环境变量:

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | 空 | API Gateway 的完整地址;同源部署时保持为空 |
| `ALIANGBOARD_API_URL` | `http://127.0.0.1:8787` | Vite 开发代理目标 |

开发环境连接使用自签名证书的集群时,可以临时运行:

```bash
K8S_INSECURE_SKIP_TLS_VERIFY=true npm run server
```

生产环境不要跳过 TLS 校验,应为 API Gateway 配置可信 CA,并设置 `K8S_ALLOWED_HOSTS` 和准确的 `CORS_ORIGIN`。

## 权限建议

不要使用长期有效的 `cluster-admin` Token。建议创建专用 ServiceAccount,并按实际功能授予:

- 资源的 `get`、`list`、`watch`
- 需要编辑的资源的 `create`、`update`、`patch`、`delete`
- Pod 日志的 `get`
- Pod eviction 的 `create`
- Node 运维需要的 `patch`
- Pod Exec 终端的 `pods/exec`(`create`)
- 端口转发的 `pods/portforward`(`get` / `create`)
- 调试容器注入的 `pods/ephemeralcontainers`(`update`)
- Pod Attach 的 `pods/attach`(`create`)
- CronJob 手动触发的 `jobs`(`create`)

API Gateway 默认在内存中保存集群凭据和会话,重启后所有登录会话都会失效(容器部署时凭据持久化在 `/app/data` 卷)。生产环境若需要多实例部署,应将会话和加密后的集群凭据迁移到专用存储。

## 容器部署

仓库提供多阶段 `Dockerfile`:单进程 Node 同时服务前端静态文件与 API Gateway,开箱即用。

容器相关变量(覆盖同名后端变量):

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 容器内监听地址(镜像已设,勿改回 127.0.0.1) |
| `PORT` | `8787` | 监听端口 |
| `ALIANG_DB` | `/app/data/aliangboard.db` | SQLite 库路径(位于卷内) |
| `ALIANG_WORKBENCH_DIR` | `/app/data/workbench` | 工作台 git 仓库目录(位于卷内) |
| `ALIANG_STATIC_DIR` | `/app/dist` | 前端静态目录(一般无需改动) |

> 运行时镜像基于 `node:25-alpine`(`node:sqlite` 硬依赖),内置 `git`(工作台 repo 存储需要)。以非 root 用户 `node` 运行。

### CI 自动发布

推送到 GitHub `main` 分支时,`.github/workflows/docker.yml` 会自动构建 `linux/amd64` + `linux/arm64` 多架构镜像并发布到 GitHub Container Registry:

```
ghcr.io/aliangone/aliangboard:latest
ghcr.io/aliangone/aliangboard:main
ghcr.io/aliangone/aliangboard:sha-<7位提交哈希>
```

`sha-<哈希>` 标签不可变,可用于精确回滚。认证使用内置 `GITHUB_TOKEN`,无需额外配置 secret。

## 当前边界

- Pod Exec 终端、端口转发、文件浏览仅在连接真实集群时生效;未连接集群时相关入口为空状态。
- 端口转发在网关本机开本地 TCP 监听(默认 `127.0.0.1`,同 kubectl port-forward);当 Dashboard 部署在远端主机时,浏览器无法直接访问该端口,需自行 SSH 端口转发等。
- Exec 终端默认执行 `/bin/sh`(可通过组件 `command` 属性调整);distroless 等无 shell 镜像可用「kubectl debug」注入带 shell 的临时容器进入(需集群 K8s 1.25+,已默认启用 EphemeralContainers)。
- 多集群切换复用网关中的会话;Gateway 重启后会话失效,已保存集群需重新登录。会话凭据仅存于浏览器 localStorage,请勿在共享设备使用。
- 「审计日志」页以集群 Events 作为活动记录展示;完整的用户级审计(who/verb/IP/HTTP code)需集群开启 audit logging 并对接日志后端,标准 K8s API 不直接提供。
- Helm、GitOps、告警尚未接入。
- HPA / PDB 等依赖特定 API 版本(如 autoscaling/v2、policy/v1),低版本集群上对应创建会失败并以 toast 提示。

## 🛠 技术栈

**前端** — Vue 3 · Vite · Pinia · Vue Router · @tanstack/vue-query · vue-i18n · xterm.js · marked · DOMPurify(纯 JS,无 TypeScript)

**后端** — Node.js 25(`node:sqlite` 内置)· @kubernetes/client-node · 零额外运行时依赖的透明 K8s API 网关

**测试** — 服务端 / 纯逻辑用自研零依赖运行器 + `node --test`;前端单测用 vitest + @vue/test-utils + happy-dom

**打包** — 单个多阶段 Docker 镜像(`node:25-alpine`),单进程同源服务 API + SPA

## 🤝 贡献

欢迎 Issue 和 PR。本地开发:

```bash
npm install
npm run server     # API Gateway
npm run dev        # 前端
npm test           # 服务端 + 纯逻辑测试
npm run test:unit  # 前端单测(vitest)
npm run typecheck  # node --check 语法基线
```

## License

[Apache License 2.0](./LICENSE)。允许商业使用、修改、分发与私用,只需保留版权与免责声明。
