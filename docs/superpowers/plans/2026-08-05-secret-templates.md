# Secret 模板化创建 + 类型感知展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secret 创建支持 8 种预设模板（类型化表单自动生成 data）+ 详情页按 type 显示摘要卡。

**Architecture:** 新建 `useSecretTemplates.js`（8 模板定义 + buildData + detect）；CreateResourceDialog Secret 表单加模板选择器 + 动态字段；NsSecretDetail Data tab 顶部加类型摘要卡。

**Tech Stack:** Vue 3 `<script setup>`、Tailwind CSS。

## Global Constraints

- 不改 Secret 列表页、YAML tab、annotations/labels tab。
- 不加 Service Account Token / Bootstrap Token 模板。
- TLS 不做 PEM 解析（YAGNI，摘要只标识 key 列表）。
- 禁新增依赖（prismjs 已加；本特性不需额外依赖）。

---

### Task 1: `useSecretTemplates.js` composable + 单测（TDD）

**Files:** Create: `src/composables/useSecretTemplates.js` | Test: `scripts/test.mjs`

**Interfaces:**
- Produces: `SECRET_TEMPLATES`（8 模板数组，每含 id/label/icon/k8sType/fields/buildData/quickFills?/parseSummary?）; `detectSecretTemplate(secret)` → template id 或 'opaque'。

- [ ] **Step 1: 写失败测试**

在 `scripts/test.mjs` 的"汇总"段之前追加：

```js
import { SECRET_TEMPLATES, detectSecretTemplate, buildSecretData } from '../src/composables/useSecretTemplates.js'
test('buildSecretData: Docker 模板生成 .dockerconfigjson JSON', () => {
  const data = buildSecretData('docker', { server: 'ghcr.io', username: 'user', password: 'pat123', email: 'a@b.com' })
  assert.ok('.dockerconfigjson' in data, '应有 .dockerconfigjson key')
  const parsed = JSON.parse(data['.dockerconfigjson'])
  assert.ok('auths' in parsed, 'JSON 应含 auths')
  assert.ok('ghcr.io' in parsed.auths, 'auths 应含 ghcr.io')
  assert.equal(parsed.auths['ghcr.io'].username, 'user')
  assert.equal(parsed.auths['ghcr.io'].password, 'pat123')
  assert.ok(parsed.auths['ghcr.io'].auth, '应有 auth base64')
})
test('buildSecretData: TLS 模板 tls.crt + tls.key', () => {
  const data = buildSecretData('tls', { cert: 'CERTPEM', key: 'KEYPEM' })
  assert.deepEqual(data, { 'tls.crt': 'CERTPEM', 'tls.key': 'KEYPEM' })
})
test('buildSecretData: SSH 模板 ssh-privatekey + 可选 known_hosts', () => {
  assert.deepEqual(buildSecretData('ssh', { privatekey: 'SSHKEY' }), { 'ssh-privatekey': 'SSHKEY' })
  assert.deepEqual(buildSecretData('ssh', { privatekey: 'SSHKEY', known_hosts: 'HOSTS' }), { 'ssh-privatekey': 'SSHKEY', known_hosts: 'HOSTS' })
})
test('buildSecretData: basic-auth username+password', () => {
  assert.deepEqual(buildSecretData('basic-auth', { username: 'admin', password: 'pass' }), { username: 'admin', password: 'pass' })
})
test('buildSecretData: git-token GitHub→GITHUB_TOKEN', () => {
  const data = buildSecretData('git-token', { service: 'github', token: 'ghp_xxx' })
  assert.deepEqual(data, { GITHUB_TOKEN: 'ghp_xxx' })
  const data2 = buildSecretData('git-token', { service: 'gitlab', token: 'glpat-xxx' })
  assert.deepEqual(data2, { GITLAB_TOKEN: 'glpat-xxx' })
})
test('buildSecretData: Opaque 直接 key-value', () => {
  assert.deepEqual(buildSecretData('opaque', { data: [{ key: 'K', value: 'V' }] }), { K: 'V' })
})
test('buildSecretData: AWS 凭证 3 keys', () => {
  const data = buildSecretData('aws', { access_key_id: 'AKIA...', secret_access_key: 'SECRET', region: 'us-east-1' })
  assert.deepEqual(data, { AWS_ACCESS_KEY_ID: 'AKIA...', AWS_SECRET_ACCESS_KEY: 'SECRET', AWS_REGION: 'us-east-1' })
})
test('detectSecretTemplate: 按 type+keys 判定', () => {
  assert.equal(detectSecretTemplate({ type: 'kubernetes.io/dockerconfigjson' }), 'docker')
  assert.equal(detectSecretTemplate({ type: 'kubernetes.io/tls', data: { 'tls.crt': '', 'tls.key': '' } }), 'tls')
  assert.equal(detectSecretTemplate({ type: 'kubernetes.io/ssh-auth' }), 'ssh')
  assert.equal(detectSecretTemplate({ type: 'kubernetes.io/basic-auth' }), 'basic-auth')
  assert.equal(detectSecretTemplate({ type: 'Opaque', data: { GITHUB_TOKEN: '' } }), 'git-token')
  assert.equal(detectSecretTemplate({ type: 'Opaque', data: { AWS_ACCESS_KEY_ID: '' } }), 'aws')
  assert.equal(detectSecretTemplate({ type: 'Opaque', data: { random: '' } }), 'opaque')
})
```

- [ ] **Step 2: `node scripts/test.mjs` → FAIL (module not found)**

- [ ] **Step 3: 实现 composable**

创建 `src/composables/useSecretTemplates.js`：

```js
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
    if (GITHUB_TOKEN in data || GITLAB_TOKEN in data || GITEA_TOKEN in data || ('token' in data && Object.keys(data).length === 1)) return 'git-token'
    if ('AWS_ACCESS_KEY_ID' in data) return 'aws'
    if ('DATABASE_URL' in data || ('DB_HOST' in data && 'DB_USER' in data)) return 'db'
  }
  return 'opaque'
}
```

- [ ] **Step 4: `node scripts/test.mjs` → PASS**

- [ ] **Step 5: 提交**

```bash
git add src/composables/useSecretTemplates.js scripts/test.mjs
git commit -m "feat(secret): 抽 useSecretTemplates composable（8 模板 + buildData + detect）+ 契约测试"
```

---

### Task 2: CreateResourceDialog Secret 表单加模板选择器 + 动态字段

**Files:** Modify: `src/components/common/CreateResourceDialog.vue`

**Interfaces:** Consumes: `SECRET_TEMPLATES`, `buildSecretData`（Task 1）。

- [ ] **Step 1: import + state**

在 `<script setup>` 顶部加 import（其它 import 之后）：
```js
import { SECRET_TEMPLATES, buildSecretData } from '@/composables/useSecretTemplates'
```

把 `const secretForm = ref({ name: '', type: 'Opaque', data: [{ key: '', value: '' }] })` 替换为：
```js
const secretForm = ref({ name: '', templateId: 'opaque', fields: { data: [{ key: '', value: '' }] } })
```

- [ ] **Step 2: handleCreate 对接模板**

把 `handleCreate` 函数替换为：
```js
function handleCreate() {
  if (props.resourceType === 'secret') {
    const tpl = SECRET_TEMPLATES.find(t => t.id === secretForm.value.templateId)
    const data = buildSecretData(secretForm.value.templateId, secretForm.value.fields)
    emit('create', { type: 'secret', namespace: props.namespace, name: secretForm.value.name, k8sType: tpl?.k8sType || 'Opaque', data })
  } else {
    emit('create', { type: props.resourceType, namespace: props.namespace })
  }
  close()
}
```

- [ ] **Step 3: 模板选择器 + 动态表单（template Secret form tab）**

找到 Secret 表单模板（`v-if="resourceType === 'secret'"`，约 145-155 行的 `<template v-if="resourceType === 'secret'">` 块），替换整个 Secret 表单内容为：

```html
              <!-- Secret 模板选择器 -->
              <div>
                <label class="text-label-caps text-on-surface-variant block mb-xs">模板</label>
                <div class="grid grid-cols-2 gap-xs">
                  <button v-for="tpl in SECRET_TEMPLATES" :key="tpl.id" type="button" @click="secretForm.templateId = tpl.id"
                    class="flex items-center gap-sm px-md py-sm rounded-lg border text-left transition-all"
                    :class="secretForm.templateId === tpl.id ? 'border-primary bg-primary-container/10 text-primary' : 'border-outline-variant text-on-surface hover:bg-surface-container-low">
                    <span class="material-symbols-outlined text-base">{{ tpl.icon }}</span>
                    <div class="min-w-0">
                      <p class="text-body-sm font-medium truncate">{{ tpl.label }}</p>
                      <p class="text-[10px] text-on-surface-variant truncate">{{ tpl.description }}</p>
                    </div>
                  </button>
                </div>
              </div>
              <!-- 名称 -->
              <div>
                <label class="text-label-caps text-on-surface-variant block mb-xs">Secret Name *</label>
                <input v-model="secretForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-secret" />
              </div>
              <!-- Opaque: key-value 列表 -->
              <div v-if="secretForm.templateId === 'opaque'">
                <label class="text-label-caps text-on-surface-variant block mb-xs">Data</label>
                <div v-for="(d, i) in secretForm.fields.data" :key="i" class="flex gap-xs mb-xs">
                  <input v-model="d.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono" placeholder="key" />
                  <input v-model="d.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono" placeholder="value" />
                  <button @click="() => { if (secretForm.fields.data.length > 1) secretForm.fields.data.splice(i, 1) }" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-lg">close</span></button>
                </div>
                <button @click="secretForm.fields.data.push({ key: '', value: '' })" class="text-body-sm text-primary font-medium hover:underline">+ 添加</button>
              </div>
              <!-- 非 Opaque: 按模板 fields 动态渲染 -->
              <div v-else>
                <div v-for="f in SECRET_TEMPLATES.find(t => t.id === secretForm.templateId)?.fields" :key="f.key" class="mb-sm">
                  <label class="text-label-caps text-on-surface-variant block mb-xs">{{ f.label }}{{ f.optional ? '（可选）' : '' }}</label>
                  <!-- select -->
                  <select v-if="f.type === 'select'" v-model="secretForm.fields[f.key]" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
                    <option v-for="opt in f.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                  </select>
                  <!-- password -->
                  <input v-else-if="f.type === 'password'" v-model="secretForm.fields[f.key]" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" :placeholder="f.placeholder || ''" />
                  <!-- textarea -->
                  <textarea v-else-if="f.type === 'textarea'" v-model="secretForm.fields[f.key]" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono h-24 resize-y" :placeholder="f.placeholder || ''"></textarea>
                  <!-- text -->
                  <input v-else v-model="secretForm.fields[f.key]" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" :placeholder="f.placeholder || ''" />
                  <!-- hint -->
                  <p v-if="f.hint || (f.type === 'select' && f.options?.find(o => o.value === secretForm.fields[f.key])?.hint)" class="text-[10px] text-on-surface-variant mt-xs">{{ f.options?.find(o => o.value === secretForm.fields[f.key])?.hint || f.hint }}</p>
                </div>
                <!-- Docker 快捷 registry -->
                <div v-if="secretForm.templateId === 'docker'" class="flex gap-xs flex-wrap mt-xs">
                  <button v-for="qf in SECRET_TEMPLATES.find(t => t.id === 'docker').quickFills" :key="qf.server" type="button" @click="secretForm.fields.server = qf.server"
                    class="px-sm py-xs text-xs rounded border" :class="secretForm.fields.server === qf.server ? 'border-primary text-primary bg-primary-container/10' : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-low'">
                    {{ qf.label }}
                  </button>
                </div>
              </div>
```

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck && npm run build` — 无新增错误。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/CreateResourceDialog.vue
git commit -m "feat(secret): CreateResourceDialog 加模板选择器 + 动态表单字段"
```

---

### Task 3: NsSecretDetail 类型感知摘要卡

**Files:** Modify: `src/views/NsSecretDetail.vue`

**Interfaces:** Consumes: `detectSecretTemplate`, `SECRET_TEMPLATES`（Task 1）。

- [ ] **Step 1: import + computed**

在 `<script setup>` 顶部加：
```js
import { detectSecretTemplate, SECRET_TEMPLATES } from '@/composables/useSecretTemplates'
```

在 `dataEntries` computed 之后加：
```js
const secretTemplateId = computed(() => detectSecretTemplate(secret.value))
const secretTemplate = computed(() => SECRET_TEMPLATES.find(t => t.id === secretTemplateId.value))
const dockerRegistries = computed(() => {
  if (secretTemplateId.value !== 'docker') return []
  try {
    const raw = decode(secret.value?.data?.['.dockerconfigjson'] || '')
    const config = JSON.parse(raw)
    return Object.entries(config.auths || {}).map(([server, info]) => ({ server, username: info.username || '—' }))
  } catch { return [] }
})
```

- [ ] **Step 2: Data tab 顶部加摘要卡**

在 Data tab 的 `<div v-if="activeTab === 'data'">` 内容最顶部（在 Data Keys 卡之前）插入：

```html
        <!-- 类型摘要卡 -->
        <div v-if="secretTemplateId !== 'opaque'" class="bg-primary-container/5 border border-primary/20 rounded-xl p-md mb-md flex items-center gap-md">
          <span class="material-symbols-outlined text-primary text-2xl">{{ secretTemplate?.icon }}</span>
          <div class="flex-1 min-w-0">
            <p class="text-body-sm font-semibold text-primary">{{ secretTemplate?.label }}</p>
            <!-- Docker: registry + username -->
            <div v-if="secretTemplateId === 'docker'" class="mt-xs flex flex-wrap gap-md text-body-sm text-on-surface-variant">
              <span v-for="reg in dockerRegistries" :key="reg.server"><span class="font-mono text-primary">{{ reg.server }}</span> · {{ reg.username }}</span>
            </div>
            <!-- TLS -->
            <p v-else-if="secretTemplateId === 'tls'" class="text-body-sm text-on-surface-variant mt-xs">包含 tls.crt (证书) + tls.key (私钥)</p>
            <!-- SSH -->
            <p v-else-if="secretTemplateId === 'ssh'" class="text-body-sm text-on-surface-variant mt-xs">包含 ssh-privatekey{{ secret.value?.data?.known_hosts ? ' + known_hosts' : '' }}</p>
            <!-- Basic Auth -->
            <p v-else-if="secretTemplateId === 'basic-auth'" class="text-body-sm text-on-surface-variant mt-xs">用户: <span class="font-mono">{{ decode(secret.value?.data?.username) || '—' }}</span></p>
            <!-- Git Token -->
            <p v-else-if="secretTemplateId === 'git-token'" class="text-body-sm text-on-surface-variant mt-xs">Key: <span class="font-mono text-primary">{{ Object.keys(secret.value?.data || {})[0] || '—' }}</span></p>
            <!-- AWS -->
            <p v-else-if="secretTemplateId === 'aws'" class="text-body-sm text-on-surface-variant mt-xs">AWS 凭证 (3 keys)</p>
            <!-- DB -->
            <p v-else-if="secretTemplateId === 'db'" class="text-body-sm text-on-surface-variant mt-xs">数据库连接 ({{ dataEntries.length }} keys)</p>
          </div>
        </div>
```

- [ ] **Step 3: typecheck + build**

Run: `npm run typecheck && npm run build` — 无新增错误。

- [ ] **Step 4: 提交**

```bash
git add src/views/NsSecretDetail.vue
git commit -m "feat(secret): NsSecretDetail Data tab 顶部加类型感知摘要卡"
```

---

## Self-Review

- **Spec coverage**: ① 8 模板 + buildData + detect（Task 1）② 模板选择器 + 动态表单 + Docker 快捷 + Git Token 服务选择（Task 2）③ 类型摘要卡 Docker/TLS/SSH/Basic/Git/AWS/DB（Task 3）——全覆盖。
- **Placeholder scan**: 无 TBD/TODO；composable 含完整 8 模板代码；Task 2/3 含精确 old→new。
- **Type consistency**: `buildSecretData(templateId, form)`（Task 1）→ CreateResourceDialog handleCreate 调用（Task 2）；`detectSecretTemplate(secret)`（Task 1）→ NsSecretDetail computed（Task 3）；`SECRET_TEMPLATES`（Task 1）→ 两处 import（Task 2/3）。字段名一致。
- **Git Token detect**：detectSecretTemplate 里检查 `GITHUB_TOKEN in data || GITLAB_TOKEN in data || ...`——但 K8s Secret 的 data 是 base64 编码后的值（key 名是明文，value 是 base64）。detect 只看 key 名（`in data` 检查的是 key 存在性，不管 value 编码）。✅
