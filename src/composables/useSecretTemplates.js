// Secret 预设模板：8 种常见类型，每种含类型化表单字段 + buildData(formData)→{key:value}。
// detectSecretTemplate(secret) 按类型+data keys 判定模板（供详情页摘要卡）。
// 纯 JS（buildData 用 Buffer 做 base64 auth），便于 scripts/test.mjs 直接 import。
//
// labelKey/descriptionKey/hintKey/fields[].labelKey 存 i18n 键（secretTemplate.* 命名空间）——
// 保持模块纯净（不引 @/i18n），消费方（NsSecretDetail/CreateResourceDialog）渲染时 t(...Key) 翻译。
// test.mjs 只校验 buildSecretData/detectSecretTemplate 的数据形态，不读 label 文案，故存键不影响。

const GIT_SERVICES = {
  github: { key: 'GITHUB_TOKEN', hintKey: 'secretTemplate.gitScopeGithub' },
  gitlab: { key: 'GITLAB_TOKEN', hintKey: 'secretTemplate.gitScopeGitlab' },
  gitea: { key: 'GITEA_TOKEN', hintKey: 'secretTemplate.gitScopeGitea' },
  custom: { key: 'token', hintKey: 'secretTemplate.gitScopeCustom' },
}

export const SECRET_TEMPLATES = [
  {
    id: 'opaque', labelKey: 'secretTemplate.opaque', icon: 'description', k8sType: 'Opaque',
    descriptionKey: 'secretTemplate.opaqueDesc',
    fields: [{ key: 'data', labelKey: '', type: 'keyvalue' }],
  },
  {
    id: 'docker', labelKey: 'secretTemplate.docker', icon: 'dock', k8sType: 'kubernetes.io/dockerconfigjson',
    descriptionKey: 'secretTemplate.dockerDesc',
    fields: [
      { key: 'server', labelKey: 'secretTemplate.registryUrl', type: 'text', placeholder: 'https://index.docker.io/v1/' },
      { key: 'username', labelKey: 'common.name', type: 'text' },
      { key: 'password', labelKey: 'secretTemplate.passwordOrPat', type: 'password' },
      { key: 'email', labelKey: 'secretTemplate.emailOptional', type: 'text', optional: true },
    ],
    quickFills: [
      { label: 'Docker Hub', server: 'https://index.docker.io/v1/' },
      { label: 'GitHub', server: 'ghcr.io', hintKey: 'secretTemplate.quickFillGithub' },
      { label: 'GitLab', server: 'registry.gitlab.io', hintKey: 'secretTemplate.quickFillGitlab' },
      { label: 'GCR', server: 'gcr.io' },
    ],
  },
  {
    id: 'tls', labelKey: 'secretTemplate.tls', icon: 'lock', k8sType: 'kubernetes.io/tls',
    descriptionKey: 'secretTemplate.tlsDesc',
    fields: [
      { key: 'cert', labelKey: 'secretTemplate.certPem', type: 'textarea', placeholder: '-----BEGIN CERTIFICATE-----\n...' },
      { key: 'key', labelKey: 'secretTemplate.keyPem', type: 'textarea', placeholder: '-----BEGIN PRIVATE KEY-----\n...' },
    ],
  },
  {
    id: 'ssh', labelKey: 'secretTemplate.ssh', icon: 'key', k8sType: 'kubernetes.io/ssh-auth',
    descriptionKey: 'secretTemplate.sshDesc',
    fields: [
      { key: 'privatekey', labelKey: 'secretTemplate.sshPrivateKey', type: 'textarea', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----\n...' },
      { key: 'known_hosts', labelKey: 'secretTemplate.knownHostsOptional', type: 'textarea', optional: true, placeholder: 'github.com ssh-ed25519 AAAA...' },
    ],
  },
  {
    id: 'basic-auth', labelKey: 'secretTemplate.basicAuth', icon: 'person', k8sType: 'kubernetes.io/basic-auth',
    descriptionKey: 'secretTemplate.basicAuthDesc',
    fields: [
      { key: 'username', labelKey: 'common.name', type: 'text' },
      { key: 'password', labelKey: 'secretTemplate.password', type: 'password' },
    ],
  },
  {
    id: 'git-token', labelKey: 'secretTemplate.gitToken', icon: 'cloud_sync', k8sType: 'Opaque',
    descriptionKey: 'secretTemplate.gitTokenDesc',
    fields: [
      { key: 'service', labelKey: 'secretTemplate.gitService', type: 'select', options: Object.entries(GIT_SERVICES).map(([v, { hintKey }]) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1), hintKey })) },
      { key: 'token', labelKey: 'secretTemplate.tokenValue', type: 'password' },
    ],
  },
  {
    id: 'aws', labelKey: 'secretTemplate.aws', icon: 'cloud', k8sType: 'Opaque',
    descriptionKey: 'secretTemplate.awsDesc',
    fields: [
      { key: 'access_key_id', label: 'AWS_ACCESS_KEY_ID', type: 'text' },
      { key: 'secret_access_key', label: 'AWS_SECRET_ACCESS_KEY', type: 'password' },
      { key: 'region', label: 'AWS_REGION', type: 'text', placeholder: 'us-east-1' },
    ],
  },
  {
    id: 'db', labelKey: 'secretTemplate.db', icon: 'database', k8sType: 'Opaque',
    descriptionKey: 'secretTemplate.dbDesc',
    fields: [
      { key: 'mode', labelKey: 'secretTemplate.dbFormat', type: 'select', options: [{ value: 'split', labelKey: 'secretTemplate.dbModeSplit' }, { value: 'url', labelKey: 'secretTemplate.dbModeUrl' }] },
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
