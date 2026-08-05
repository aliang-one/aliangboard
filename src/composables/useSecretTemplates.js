// Secret 预设模板：8 种常见类型，每种含类型化表单字段 + buildData(formData)→{key:value}。
// detectSecretTemplate(secret) 按类型+data keys 判定模板（供详情页摘要卡）。
// 纯 JS（buildData 用 Buffer 做 base64 auth），便于 scripts/test.mjs 直接 import。

const GIT_SERVICES = {
  github: { key: 'GITHUB_TOKEN', hint: 'scopes: repo / read:packages / read:org' },
  gitlab: { key: 'GITLAB_TOKEN', hint: 'scopes: api / read_repository / read_registry' },
  gitea: { key: 'GITEA_TOKEN', hint: '自建 Gitea 服务' },
  custom: { key: 'token', hint: '自定义 Git 服务' },
}

export const SECRET_TEMPLATES = [
  {
    id: 'opaque', label: '通用 Opaque', icon: 'description', k8sType: 'Opaque',
    description: '自由键值对（最常见）',
    fields: [{ key: 'data', label: '', type: 'keyvalue' }],
  },
  {
    id: 'docker', label: 'Docker 仓库凭证', icon: 'dock', k8sType: 'kubernetes.io/dockerconfigjson',
    description: '私有镜像拉取（Docker Hub / ghcr.io / registry.gitlab.io 等）',
    fields: [
      { key: 'server', label: 'Registry URL', type: 'text', placeholder: 'https://index.docker.io/v1/' },
      { key: 'username', label: '用户名', type: 'text' },
      { key: 'password', label: '密码 / PAT', type: 'password' },
      { key: 'email', label: '邮箱（可选）', type: 'text', optional: true },
    ],
    quickFills: [
      { label: 'Docker Hub', server: 'https://index.docker.io/v1/' },
      { label: 'GitHub', server: 'ghcr.io', hint: 'username=GitHub 用户名，password=PAT（read:packages）' },
      { label: 'GitLab', server: 'registry.gitlab.io', hint: 'password=Deploy Token / PAT（read_registry）' },
      { label: 'GCR', server: 'gcr.io' },
    ],
  },
  {
    id: 'tls', label: 'TLS 证书', icon: 'lock', k8sType: 'kubernetes.io/tls',
    description: 'HTTPS 证书 + 私钥（Ingress TLS）',
    fields: [
      { key: 'cert', label: '证书 (PEM)', type: 'textarea', placeholder: '-----BEGIN CERTIFICATE-----\n...' },
      { key: 'key', label: '私钥 (PEM)', type: 'textarea', placeholder: '-----BEGIN PRIVATE KEY-----\n...' },
    ],
  },
  {
    id: 'ssh', label: 'SSH 认证密钥', icon: 'key', k8sType: 'kubernetes.io/ssh-auth',
    description: 'Git Deploy Key / SSH 认证',
    fields: [
      { key: 'privatekey', label: 'SSH 私钥', type: 'textarea', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----\n...' },
      { key: 'known_hosts', label: 'known_hosts（可选）', type: 'textarea', optional: true, placeholder: 'github.com ssh-ed25519 AAAA...' },
    ],
  },
  {
    id: 'basic-auth', label: '基本认证', icon: 'person', k8sType: 'kubernetes.io/basic-auth',
    description: '用户名 + 密码（htpasswd / 简单认证）',
    fields: [
      { key: 'username', label: '用户名', type: 'text' },
      { key: 'password', label: '密码', type: 'password' },
    ],
  },
  {
    id: 'git-token', label: 'Git Token', icon: 'cloud_sync', k8sType: 'Opaque',
    description: 'GitHub / GitLab / Gitea 访问令牌（CI/CD、GitOps）',
    fields: [
      { key: 'service', label: 'Git 服务', type: 'select', options: Object.entries(GIT_SERVICES).map(([v, { hint }]) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1), hint })) },
      { key: 'token', label: 'Token 值', type: 'password' },
    ],
  },
  {
    id: 'aws', label: 'AWS 凭证', icon: 'cloud', k8sType: 'Opaque',
    description: 'AWS Access Key（外部云操作、S3、IRSA 等）',
    fields: [
      { key: 'access_key_id', label: 'AWS_ACCESS_KEY_ID', type: 'text' },
      { key: 'secret_access_key', label: 'AWS_SECRET_ACCESS_KEY', type: 'password' },
      { key: 'region', label: 'AWS_REGION', type: 'text', placeholder: 'us-east-1' },
    ],
  },
  {
    id: 'db', label: '数据库连接', icon: 'database', k8sType: 'Opaque',
    description: '数据库连接参数',
    fields: [
      { key: 'mode', label: '格式', type: 'select', options: [{ value: 'split', label: '拆分字段' }, { value: 'url', label: '单 URL' }] },
      { key: 'host', label: 'DB_HOST', type: 'text', placeholder: 'db.example.com' },
      { key: 'port', label: 'DB_PORT', type: 'text', placeholder: '5432' },
      { key: 'name', label: 'DB_NAME', type: 'text', placeholder: 'myapp' },
      { key: 'user', label: 'DB_USER', type: 'text' },
      { key: 'password', label: 'DB_PASSWORD', type: 'password' },
    ],
  },
]

// form → { key: value }（纯文本，base64 由 store.addSecret 编码）
export function buildSecretData(templateId, form) {
  switch (templateId) {
    case 'opaque':
      return Object.fromEntries((form.data || []).filter(d => d.key).map(d => [d.key, d.value]))
    case 'docker': {
      const auth = Buffer.from(`${form.username}:${form.password}`).toString('base64')
      const config = { auths: { [form.server]: { username: form.username, password: form.password, email: form.email || '', auth } } }
      return { '.dockerconfigjson': JSON.stringify(config) }
    }
    case 'tls':
      return { 'tls.crt': form.cert, 'tls.key': form.key }
    case 'ssh': {
      const data = { 'ssh-privatekey': form.privatekey }
      if (form.known_hosts) data.known_hosts = form.known_hosts
      return data
    }
    case 'basic-auth':
      return { username: form.username, password: form.password }
    case 'git-token': {
      const conf = GIT_SERVICES[form.service] || GIT_SERVICES.custom
      return { [conf.key]: form.token }
    }
    case 'aws':
      return { AWS_ACCESS_KEY_ID: form.access_key_id, AWS_SECRET_ACCESS_KEY: form.secret_access_key, AWS_REGION: form.region }
    case 'db':
      if (form.mode === 'url') return { DATABASE_URL: `postgresql://${form.user}:${form.password}@${form.host}:${form.port || 5432}/${form.name}` }
      return { DB_HOST: form.host, DB_PORT: form.port || '5432', DB_NAME: form.name, DB_USER: form.user, DB_PASSWORD: form.password }
    default: return {}
  }
}

// 按 type + data keys 判定模板
export function detectSecretTemplate(secret) {
  if (!secret) return 'opaque'
  const type = secret.type || 'Opaque'
  const data = secret.data || {}
  if (type === 'kubernetes.io/dockerconfigjson') return 'docker'
  if (type === 'kubernetes.io/tls') return 'tls'
  if (type === 'kubernetes.io/ssh-auth') return 'ssh'
  if (type === 'kubernetes.io/basic-auth') return 'basic-auth'
  if (type === 'Opaque') {
    if ('GITHUB_TOKEN' in data || 'GITLAB_TOKEN' in data || 'GITEA_TOKEN' in data || ('token' in data && Object.keys(data).length === 1)) return 'git-token'
    if ('AWS_ACCESS_KEY_ID' in data) return 'aws'
    if ('DATABASE_URL' in data || ('DB_HOST' in data && 'DB_USER' in data)) return 'db'
  }
  return 'opaque'
}
