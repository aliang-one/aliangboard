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

API Gateway 只在内存中保存集群凭据和会话，重启后所有登录会话都会失效。生产环境若需要多实例部署，应将会话和加密后的集群凭据迁移到专用存储。

## 当前边界

- Pod Terminal 仍是界面模拟，真实 Exec 需要增加 WebSocket/SPDY 流代理。
- 指标图仍使用现有展示模型，尚未接入 Metrics Server 或 Prometheus。
- Helm、GitOps、告警和持久化审计尚未接入。
- 列表刷新依赖进入页面 / 操作触发的水合；尚未实现全局 Watch 实时推送。
- HPA / PDB 等依赖特定 API 版本（如 autoscaling/v2、policy/v1），低版本集群上对应创建会失败并以 toast 提示。
- 工作负载「滚动发布历史 / 回滚」在远端模式下仅展示当前版本（真实 revision 历史需查询 ReplicaSet，尚未接入）。
