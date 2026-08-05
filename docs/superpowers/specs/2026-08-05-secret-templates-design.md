# Secret 模板化创建 + 类型感知展示

- **日期**：2026-08-05
- **状态**：已确认，待实现
- **范围**：Secret 创建模板化（8 种预设模板）+ 详情页类型感知展示。

## 1. 背景与动机

当前 Secret 创建只有简单 type 文本输入 + 通用 key-value。用户需要手动构造 `.dockerconfigjson`、TLS 证书 key 名（`tls.crt`/`tls.key`）等格式化数据——容易出错。

**目标**：提供 8 种常见 Secret 模板，每种有类型化表单（而非通用 key-value），自动生成正确格式的 K8s Secret data。详情页按 type 智能展示（解析 Docker registry 信息、TLS 证书主题等）。

## 2. 8 种模板

| # | 模板 | K8s Type | 表单字段 | 自动生成 |
|---|---|---|---|---|
| 1 | **通用 Opaque** | Opaque | 自由 key-value 列表 | 直接 data |
| 2 | **Docker 仓库凭证** | kubernetes.io/dockerconfigjson | registry（快捷：Docker Hub/ghcr.io/registry.gitlab.io/gcr.io/自定义）+ username + password + email | `.dockerconfigjson` base64(JSON) |
| 3 | **TLS 证书** | kubernetes.io/tls | tls.crt (textarea) + tls.key (textarea) | `tls.crt` + `tls.key` |
| 4 | **SSH 认证密钥** | kubernetes.io/ssh-auth | ssh-privatekey (textarea) + 可选 known_hosts (textarea) | `ssh-privatekey` + 可选 `known_hosts` |
| 5 | **基本认证** | kubernetes.io/basic-auth | username + password | `username` + `password` |
| 6 | **Git Token** | Opaque | 服务选择（GitHub→`GITHUB_TOKEN`/GitLab→`GITLAB_TOKEN`/Gitea→`GITEA_TOKEN`/自定义）+ token 值 | 对应 key = token |
| 7 | **数据库连接** | Opaque | 模式选择（单 URL / 拆分字段）+ DB_HOST/PORT/USER/PASSWORD/NAME | 对应 keys |
| 8 | **云厂商凭证 (AWS)** | Opaque | AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION | 3 个 keys |

### Git Token 模板细节
- 服务下拉：GitHub / GitLab / Gitea / 自定义
- 选 GitHub → key = `GITHUB_TOKEN`，提示「scopes: repo / read:packages / read:org」
- 选 GitLab → key = `GITLAB_TOKEN`，提示「scopes: api / read_repository / read_registry」
- key 名可手改（自定义模式）

### Docker 模板细节
- registry 输入框旁加快捷按钮：`Docker Hub` / `ghcr.io` / `registry.gitlab.io` / `gcr.io` / `自定义`
- 点击快捷按钮 → 自动填 registry URL
- ghcr.io / registry.gitlab.io → 提示「password 用 PAT（需 read:packages / read_registry scope）」
- 表单值 → `{auths:{registry:{username,password,email,auth:base64(user:pass)}}}` → JSON.stringify → base64 → `.dockerconfigjson`

## 3. 设计

### 3.1 `src/composables/useSecretTemplates.js`

导出 `SECRET_TEMPLATES` 数组 + `detectSecretTemplate(secret)` 函数。

每模板结构：
```js
{
  id: 'docker',
  label: 'Docker 仓库凭证',
  icon: 'dock',
  k8sType: 'kubernetes.io/dockerconfigjson',
  description: '私有镜像仓库拉取凭证（Docker Hub / ghcr.io / registry.gitlab.io 等）',
  fields: [
    { key: 'server', label: 'Registry URL', type: 'text', placeholder: 'https://index.docker.io/v1/', hint: '...' },
    { key: 'username', label: '用户名', type: 'text' },
    { key: 'password', label: '密码/PAT', type: 'password' },
    { key: 'email', label: '邮箱', type: 'text', optional: true },
  ],
  quickFills: [  // 仅 Docker 模板有
    { label: 'Docker Hub', server: 'https://index.docker.io/v1/' },
    { label: 'GitHub', server: 'ghcr.io' },
    { label: 'GitLab', server: 'registry.gitlab.io' },
    { label: 'GCR', server: 'gcr.io' },
  ],
  buildData: (form) => {  // form = {server, username, password, email}
    const auth = Buffer.from(`${form.username}:${form.password}`).toString('base64')
    const config = { auths: { [form.server]: { username: form.username, password: form.password, email: form.email || '', auth } } }
    return { '.dockerconfigjson': JSON.stringify(config) }
  },
  // 详情页类型感知摘要
  parseSummary: (data) => {
    // 解析 .dockerconfigjson → { registries: [{server, username}] }
  },
}
```

`detectSecretTemplate(secret)`：按 `secret.type` + data keys 匹配模板（dockerconfigjson → docker; tls.crt+tls.key → tls; ssh-privatekey → ssh; 等）。返回模板 id 或 'opaque'。

### 3.2 CreateResourceDialog Secret 表单增强

当前 Secret 表单（`secretForm = {name, type, data:[{key,value}]}`）替换为：

1. **模板选择器**（顶部）：8 个卡片（icon + label + description），点击选中。
2. **动态表单**（下方）：根据选中模板的 `fields` 渲染（text / password / textarea / select）。
   - Opaque → 现有 key-value 列表。
   - Docker → registry（带 quickFill 按钮）+ username + password + email。
   - Git Token → 服务下拉 + token password。
   - 等等。
3. **创建**：`template.buildData(formData)` → data → `store.addSecret({name, type: template.k8sType, data})` → base64 编码 → POST。

### 3.3 NsSecretDetail 类型感知展示

Data tab 顶部加**类型摘要卡**（`detectSecretTemplate(secret)` 判定）：
- Docker → 解析 `.dockerconfigjson` → 显示「Registry: ghcr.io | 用户: myuser | 密码: •••••」（密码掩码 + reveal）。
- TLS → 解析 `tls.crt` → 显示「主题: CN=example.com | 签发: Let's Encrypt | 过期: 2026-12-01」（用 `forge` 或 `crypto.X509Certificate`）。
- SSH → 显示「类型: ssh-ed25519 | 指纹: SHA256:xxxx...yyyy」（从私钥头识别类型 + 首尾字符指纹）。
- Basic auth → 显示「用户: admin | 密码: •••••」。
- Git Token → 显示「key: GITHUB_TOKEN | 值: •••••」。
- 无匹配 → 不显示摘要卡（直接 key-value）。

摘要卡下方保留**现有 key-value 编辑**（可增删改，base64 编解码不变）。

### 3.4 TLS 证书解析

Node.js `crypto.X509Certificate`（零依赖，Node 15.6+）：
```js
import crypto from 'node:crypto'
// 服务端 gateway（server/index.mjs）解析 TLS → 返回摘要
// 或前端用 forge（新增依赖）→ 不推荐（YAGNI，只在 gateway 做）
```

前端无法直接用 `crypto.X509Certificate`（浏览器无 node:crypto）。方案：
- **方案 A（推荐）**：gateway 加 `/api/k8s/.../tls-info` 解析端点 → 前端调 gateway → 解析 X509。但增加 gateway 复杂度。
- **方案 B（简化）**：前端只做基础解析（base64 decode cert → 正则提取 CN/issuer/expiry from PEM text）。不完美但零依赖。
- **方案 C（YAGNI）**：TLS 摘要只显示「TLS 证书 + 私钥」（不解析主题/过期）。后续再加。

**推荐 C**（先不解析 PEM；摘要卡只标识「这是一个 TLS Secret」+ key 列表 `tls.crt` / `tls.key`）。避免 gateway 改动 + PEM 正则脆弱。

## 4. 涉及文件清单

**新增**
- `src/composables/useSecretTemplates.js` — 8 种模板定义 + buildData + detectSecretTemplate + parseSummary。

**修改**
- `src/components/common/CreateResourceDialog.vue` — Secret 表单：模板选择器 + 动态字段 + buildData 创建。
- `src/views/NsSecretDetail.vue` — Data tab 顶部类型摘要卡。

## 5. 测试

- `useSecretTemplates.js` 纯函数（buildData/detect）→ `scripts/test.mjs` 契约测试（docker JSON 格式、tls key 名、ssh key 名、detectSecretTemplate 各类型）。
- 手动验证（`npm run dev` + 集群）：选模板 → 填字段 → 创建 → K8s Secret 格式正确；详情页显示类型摘要卡。
- `npm run typecheck && npm run build`。
