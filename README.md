# AliangBoard

AliangBoard 是一个 Vue 3 Kubernetes 管理面板。项目同时包含前端和一个零额外运行时依赖的 Node.js Kubernetes API Gateway。

## 已接入真实集群的能力

- Bearer Token 或 Basic Auth 连接验证
- 会话恢复与退出登录
- 全量资源同步：Namespace、Node、Pod、Deployment、StatefulSet、DaemonSet、Service、Ingress、Endpoints、Event、ConfigMap、Secret、PVC、PV、StorageClass、IngressClass、RuntimeClass、PriorityClass、NetworkPolicy、HPA、ResourceQuota、LimitRange、Role / ClusterRole、ServiceAccount、RoleBinding / ClusterRoleBinding、PDB，以及 CRD 与自定义资源实例
- 结构化创建表单（ConfigMap / Secret / PVC / PV / StorageClass / Ingress / Service / IngressClass / RuntimeClass / PriorityClass / NetworkPolicy / HPA / ResourceQuota / LimitRange / Role / ServiceAccount / RoleBinding / ClusterRoleBinding / PDB / Namespace）通过 Server-Side Apply 落库
- 列表删除（乐观删除 + 失败回滚 + 全局错误提示）落库
- Pod 删除与真实日志读取（支持多容器选择）
- Deployment / StatefulSet 扩缩容、滚动重启、回滚（kubectl rollout undo）
- Node Cordon、Uncordon 和基于 `policy/v1 Eviction` 的 Drain
- Pod Exec 终端（kubectl exec，xterm.js 实时双向，终端尺寸自适应）—— 浏览器 WebSocket ↔ Gateway ↔ K8s（`@kubernetes/client-node` 处理 SPDY/WS 协议升级）
- 端口转发（kubectl port-forward）：Service / Deployment 自动经 endpoints 解析到后端 Pod，在网关本机开本地监听
- Pod 文件浏览（kubectl cp 语义：列目录 / 预览 / 下载 / 上传），基于一次性 exec 落地真实容器文件
- Pod 调试容器注入（kubectl debug / Ephemeral Containers）：向无 shell / distroless Pod 注入临时容器排查问题，注入后即可在终端进入该容器
- Pod Attach（kubectl attach）：连接容器主进程 stdio，区别于 exec 开新 shell
- 资源归属拓扑：沿 ownerReferences 解析归属链（Pod→ReplicaSet→Deployment…），可点击跳转
- Events 实时推送（events?watch=true）与按 involvedObject 过滤；审计页以集群 Events 作为活动记录
- CronJob 手动触发（kubectl create job --from）；通用资源导出 YAML（kubectl get -o yaml）
- 顶栏全局搜索：跨资源 / 跨命名空间检索并跳转
- 多集群：已连接集群持久化，可一键切换（重新水合）或移除
- API Discovery 驱动的 Server-Side Apply（kubectl edit / apply 语义）
- 部署向导支持一次应用多份 YAML 文档
- 连接真实集群后自动清除 Mock 数据，确保只展示集群真实状态；未连接时仍保留 Mock 数据，便于界面开发

## 环境要求

- Node.js 20+
- 能访问目标 Kubernetes API Server 的网络
- 具备所需 Kubernetes RBAC 权限的 Token 或账号

## 启动

先启动 API Gateway：

```bash
npm run server
```

再启动前端：

```bash
npm run dev
```

Vite 会把 `/api` 请求代理到 `http://127.0.0.1:8787`。

生产构建：

```bash
npm run build
```

## 配置

后端环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | API Gateway 监听地址 |
| `PORT` | `8787` | API Gateway 监听端口 |
| `CORS_ORIGIN` | `*` | 允许的前端来源，生产环境应设置为实际域名 |
| `SESSION_TTL_MS` | `28800000` | 内存会话有效期，默认 8 小时 |
| `K8S_REQUEST_TIMEOUT` | `15000` | Kubernetes API 请求超时，单位毫秒 |
| `K8S_ALLOWED_HOSTS` | 空 | 逗号分隔的 API Server 主机允许列表 |
| `K8S_INSECURE_SKIP_TLS_VERIFY` | `false` | 是否跳过集群证书验证，只应用于开发环境 |
| `PORT_FORWARD_HOST` | `127.0.0.1` | 端口转发本地监听地址（同 kubectl port-forward；仅本机可达，浏览器需能访问） |

前端环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | 空 | API Gateway 的完整地址；同源部署时保持为空 |
| `ALIANGBOARD_API_URL` | `http://127.0.0.1:8787` | Vite 开发代理目标 |

开发环境连接使用自签名证书的集群时，可以临时运行：

```bash
K8S_INSECURE_SKIP_TLS_VERIFY=true npm run server
```

生产环境不要跳过 TLS 校验，应为 API Gateway 配置可信 CA，并设置 `K8S_ALLOWED_HOSTS` 和准确的 `CORS_ORIGIN`。

## 权限建议

不要使用长期有效的 `cluster-admin` Token。建议创建专用 ServiceAccount，并按实际功能授予：

- 资源的 `get`、`list`、`watch`
- 需要编辑的资源的 `create`、`update`、`patch`、`delete`
- Pod 日志的 `get`
- Pod eviction 的 `create`
- Node 运维需要的 `patch`
- Pod Exec 终端的 `pods/exec`（`create`）
- 端口转发的 `pods/portforward`（`get` / `create`）
- 调试容器注入的 `pods/ephemeralcontainers`（`update`）
- Pod Attach 的 `pods/attach`（`create`）
- CronJob 手动触发的 `jobs`（`create`）

API Gateway 只在内存中保存集群凭据和会话，重启后所有登录会话都会失效。生产环境若需要多实例部署，应将会话和加密后的集群凭据迁移到专用存储。

## 当前边界

- Pod Exec 终端、端口转发、文件浏览仅在连接真实集群时生效（演示数据模式下为模拟 / 只读）。
- 端口转发在网关本机开本地 TCP 监听（默认 `127.0.0.1`，同 kubectl port-forward）；当 Dashboard 部署在远端主机时，浏览器无法直接访问该端口，需自行 SSH 端口转发等。
- Exec 终端默认执行 `/bin/sh`（可通过组件 `command` 属性调整）；distroless 等无 shell 镜像可用「kubectl debug」注入带 shell 的临时容器进入（需集群 K8s 1.25+，已默认启用 EphemeralContainers）。
- 多集群切换复用网关内存中的会话；Gateway 重启后会话失效，已保存集群需重新登录。会话凭据仅存于浏览器 localStorage，请勿在共享设备使用。
- 「审计日志」页以集群 Events 作为活动记录展示；完整的用户级审计（who/verb/IP/HTTP code）需集群开启 audit logging 并对接日志后端，标准 K8s API 不直接提供。
- Helm、GitOps、告警尚未接入。
- HPA / PDB 等依赖特定 API 版本（如 autoscaling/v2、policy/v1），低版本集群上对应创建会失败并以 toast 提示。
