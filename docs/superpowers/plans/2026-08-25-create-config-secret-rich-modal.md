# ConfigMap/Secret 富创建 Modal 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ns 列表页 ConfigMap/Secret 创建 Modal 对齐详情页编辑体验（文件浏览器式多键管理 + 注解/标签 + 单向 YAML 派生/纯 YAML 模式 + Secret 掩码）。

**Architecture:** 新共用 CreateConfigResourceModal（kind prop 二态）+ 两个子组件（DataKeysEditor/KeyValueRowsEditor）+ 两个纯逻辑 util（detectLang/secretTemplates）；详情页零改动；提交走既有 makeCrud add→generateYAML→applyYaml 与 applyResourceYaml 契约，后端零改动。

**Tech Stack:** Vue 3 `<script setup>` + vue-i18n（全部文案双语键）+ vitest/@vue/test-utils（ModalStub 模式）+ js-yaml（已为运行时依赖，仅用于纯 YAML 模式校验）。

**Spec:** `docs/superpowers/specs/2026-08-25-create-config-secret-rich-modal-design.md`
**勘误（相对 spec）:** spec 提「Secret 8 种模板」系误记（来自死组件 CreateResourceDialog）；活代码 NsSecrets 为 **5 类型**，本计划保持 5 类型零增减。Secret 类型字段键名统一用 data 键（tls.crt/tls.key/ssh-privatekey），旧表单的 tlsCrt/tlsKey 平展字段由 secretTemplates 收编。

## Global Constraints

- 仓库零新增依赖（js-yaml 已在 dependencies，勿新引包）
- 所有用户可见文案走 i18n 双语键（zh/en 同 commit）；提交前 `node scripts/i18n-check.mjs` 六项全 0
- 代码内禁止出现中文字符串（门禁拦）；注释可用中文
- makeCrud add / applyResourceYaml 均为 `{ok}` 契约，调用方必须据 `r.ok` 决定关弹窗；失败保留表单
- 详情页（NsConfigMapDetail/NsSecretDetail）零改动
- K8s name 校验（DNS-1123 子域）：`/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/`
- 样式用既有 token 类（text-label-caps/bg-surface-container-low/border-outline-variant 等），字号必须用完整阶梯（幽灵 text-xxx 是静默 no-op）
- 每个 Task 结束跑该 Task 的测试 + `node scripts/i18n-check.mjs`，绿了才 commit

---

### Task 1: generateYAML Secret 分支支持 labels/annotations

**Files:**
- Modify: `src/stores/cluster.js:1273-1286`（secret 分支）
- Test: `src/stores/__tests__/generateYAML.secret-meta.test.js`（新建）

**Interfaces:**
- Consumes: 现有 `generateYAML(type, resource)`（cluster.js:1147），configmap 分支 1256-1261 的 metaExtra 模式
- Produces: `store.generateYAML('secret', { name, namespace, type, data, labels, annotations })` 输出含 `metadata.labels`/`metadata.annotations`（无值时不输出，与 configmap 一致）；后续 Task 6/7 的 YAML 预览直接调用它

- [ ] **Step 1: 写失败测试**（harness 照抄 `generateYAML.policy.test.js` 头部 mock）

```js
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

vi.mock('@/api/client', () => ({
  api: { applyYaml: vi.fn(), k8s: vi.fn() },
  k8sStream: vi.fn(),
  portForwardApi: {},
  getSavedClusters: vi.fn(() => []),
  addSavedCluster: vi.fn(),
  removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(),
  activeApiServer: vi.fn(() => ''),
  getSessionToken: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useClusterStore } from '@/stores/cluster'

let store
beforeAll(() => { setActivePinia(createPinia()); store = useClusterStore() })

describe('generateYAML secret meta', () => {
  it('labels/annotations 写入 metadata（stringData 保持明文）', () => {
    const y = store.generateYAML('secret', {
      name: 's1', namespace: 'default', type: 'Opaque',
      data: { token: btoa('abc') },                    // gen 内部 decodeBase64 后写 stringData
      labels: { app: 'x' }, annotations: { note: 'n1' },
    })
    const o = yamlLoad(y)
    expect(o.metadata.labels).toEqual({ app: 'x' })
    expect(o.metadata.annotations).toEqual({ note: 'n1' })
    expect(o.stringData).toEqual({ token: 'abc' })
    expect(o.type).toBe('Opaque')
  })

  it('无 labels/annotations 时不输出空块（输出与旧行为逐字一致）', () => {
    const y = store.generateYAML('secret', { name: 's2', namespace: 'default', type: 'Opaque', data: {} })
    expect(y).toBe(`apiVersion: v1
kind: Secret
metadata:
  name: s2
  namespace: default
type: Opaque
stringData:
  {}`)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/generateYAML.secret-meta.test.js`
Expected: FAIL（第 1 例 labels 为 undefined）

- [ ] **Step 3: 最小实现**——cluster.js secret 分支加 metaExtra（照 configmap 分支 1252-1261 模式）：

```js
    if (type === 'secret') {
      // 展示为 stringData（明文）以便直接编辑；回写时由 applyResourceYaml 重新 base64 编码
      const fmtMap = obj => obj && Object.keys(obj).length
        ? Object.entries(obj).map(([k, v]) => `    ${k}: ${scalar(v)}`).join('\n')
        : ''
      const metaExtra = [
        fmtMap(resource.labels) && '  labels:\n' + fmtMap(resource.labels),
        fmtMap(resource.annotations) && '  annotations:\n' + fmtMap(resource.annotations),
      ].filter(Boolean).join('\n')
      const dataEntries = resource.data
        ? Object.entries(resource.data).map(([k, v]) => `  ${k}: ${scalar(decodeBase64(v))}`).join('\n')
        : ''
      return `apiVersion: v1
kind: Secret
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}${metaExtra ? '\n' + metaExtra : ''}
type: ${resource.type || 'Opaque'}
stringData:
${dataEntries || '  {}'}`
    }
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令，Expected: PASS）

- [ ] **Step 5: Commit**

```bash
git add src/stores/cluster.js src/stores/__tests__/generateYAML.secret-meta.test.js
git commit -m "feat(store): generateYAML secret 分支支持 labels/annotations(对齐 configmap metaExtra 模式)"
```

---

### Task 2: 抽 src/utils/detectLang.js

**Files:**
- Create: `src/utils/detectLang.js`
- Test: `src/utils/__tests__/detectLang.test.js`

**Interfaces:**
- Consumes: NsConfigMapDetail.vue:73-88 的内联 `detectLang`/`lineCount`（**逐字搬出，不改逻辑**；详情页本体不动）
- Produces: `export function detectLang(key) → { label, icon, color, prismLang }`；`export function lineCount(val) → number`。Task 5 DataKeysEditor 左栏图标与 CodeViewer 语言用它们

- [ ] **Step 1: 写失败测试**

```js
import { test, expect } from 'vitest'
import { detectLang, lineCount } from '../detectLang.js'

test('detectLang 按扩展名识别', () => {
  expect(detectLang('app.yml').prismLang).toBe('yaml')
  expect(detectLang('conf.json').label).toBe('JSON')
  expect(detectLang('tls.crt').label).toBe('CERT')
  expect(detectLang('plain').prismLang).toBe('none')
  expect(detectLang('run.sh').icon).toBe('terminal')
})
test('lineCount 空值/多行', () => {
  expect(lineCount('')).toBe(0)
  expect(lineCount('a\nb\nc')).toBe(3)
})
```

- [ ] **Step 2: 跑测试确认失败**（`npx vitest run src/utils/__tests__/detectLang.test.js`，FAIL: 模块不存在）

- [ ] **Step 3: 实现**——把 NsConfigMapDetail.vue:73-88 两个函数逐字搬到 `src/utils/detectLang.js`，头部加注释 `// 从 NsConfigMapDetail 内联实现抽出（详情页本体暂保留内联版，见 spec follow-up）`，导出加 `export`

- [ ] **Step 4: 跑测试确认通过** + `node --check`（typecheck 覆盖）

- [ ] **Step 5: Commit** `git add src/utils/detectLang.js src/utils/__tests__/detectLang.test.js && git commit -m "feat(utils): 抽 detectLang/lineCount 共享件(逐字自 NsConfigMapDetail)"`

---

### Task 3: src/utils/secretTemplates.js（5 类型纯函数）

**Files:**
- Create: `src/utils/secretTemplates.js`
- Test: `src/utils/__tests__/secretTemplates.test.js`

**Interfaces:**
- Consumes: NsSecrets.vue:88-115 的 canCreateSecret 校验与 handleCreate 数据组装逻辑（行为零变更）
- Produces（Task 6 消费）:
  - `SECRET_TYPES: Array<{ id, labelKey, freeKeys?: true, fields?: Array<{ key, labelKey, multiline, secret? }> }>`
  - `buildSecretData(typeId, values) → Object`（values: `{ [fieldKey]: string }`；Opaque 传 `{ data: {k:v} }`）
  - `secretFieldsComplete(typeId, values) → boolean`

- [ ] **Step 1: 写失败测试**

```js
import { test, expect } from 'vitest'
import { SECRET_TYPES, buildSecretData, secretFieldsComplete } from '../secretTemplates.js'

test('SECRET_TYPES 覆盖现有 5 类型', () => {
  expect(SECRET_TYPES.map(t => t.id)).toEqual(['Opaque', 'kubernetes.io/basic-auth', 'kubernetes.io/dockerconfigjson', 'kubernetes.io/tls', 'kubernetes.io/ssh-auth'])
})

test('buildSecretData: Opaque 透传 / tls 固定键 / dockerconfigjson 组装', () => {
  expect(buildSecretData('Opaque', { data: { a: '1' } })).toEqual({ a: '1' })
  expect(buildSecretData('kubernetes.io/tls', { 'tls.crt': 'C', 'tls.key': 'K' })).toEqual({ 'tls.crt': 'C', 'tls.key': 'K' })
  const d = buildSecretData('kubernetes.io/dockerconfigjson', { registry: 'reg.io', registryUser: 'u', registryPassword: 'p', registryEmail: 'e@x.io' })
  const cfg = JSON.parse(d['.dockerconfigjson'])
  expect(cfg.auths['reg.io'].username).toBe('u')
  expect(cfg.auths['reg.io'].auth).toBe(btoa('u:p'))
})

test('secretFieldsComplete 与旧 canCreateSecret 行为一致', () => {
  expect(secretFieldsComplete('kubernetes.io/tls', { 'tls.crt': 'C', 'tls.key': '' })).toBe(false)
  expect(secretFieldsComplete('kubernetes.io/tls', { 'tls.crt': 'C', 'tls.key': 'K' })).toBe(true)
  expect(secretFieldsComplete('kubernetes.io/basic-auth', { username: 'u', password: 'p' })).toBe(true)
  expect(secretFieldsComplete('Opaque', { data: { k: 'v' } })).toBe(true)
  expect(secretFieldsComplete('Opaque', { data: {} })).toBe(false)
})
```

- [ ] **Step 2: 确认失败**（模块不存在）

- [ ] **Step 3: 实现**（labelKey 沿用现有 `ns.secrets.type*` 键；字段标签新键见 Task 6 locale 段）

```js
// Secret 创建类型单一事实源：固定字段/必填校验/数据组装（自 NsSecrets.vue 内联 switch 抽出，5 类型零行为变更）
export const SECRET_TYPES = [
  { id: 'Opaque', labelKey: 'ns.secrets.typeOpaque', freeKeys: true },
  { id: 'kubernetes.io/basic-auth', labelKey: 'ns.secrets.typeBasicAuth', fields: [
    { key: 'username', labelKey: 'component.createConfigModal.fUsername', multiline: false },
    { key: 'password', labelKey: 'component.createConfigModal.fPassword', multiline: false, secret: true },
  ] },
  { id: 'kubernetes.io/dockerconfigjson', labelKey: 'ns.secrets.typeDocker', fields: [
    { key: 'registry', labelKey: 'component.createConfigModal.fRegistry', multiline: false },
    { key: 'registryUser', labelKey: 'component.createConfigModal.fRegistryUser', multiline: false },
    { key: 'registryPassword', labelKey: 'component.createConfigModal.fRegistryPassword', multiline: false, secret: true },
    { key: 'registryEmail', labelKey: 'component.createConfigModal.fRegistryEmail', multiline: false },
  ] },
  { id: 'kubernetes.io/tls', labelKey: 'ns.secrets.typeTls', fields: [
    { key: 'tls.crt', labelKey: 'component.createConfigModal.fTlsCrt', multiline: true },
    { key: 'tls.key', labelKey: 'component.createConfigModal.fTlsKey', multiline: true, secret: true },
  ] },
  { id: 'kubernetes.io/ssh-auth', labelKey: 'ns.secrets.typeSsh', fields: [
    { key: 'ssh-privatekey', labelKey: 'component.createConfigModal.fSshKey', multiline: true, secret: true },
  ] },
]

export function buildSecretData(typeId, values) {
  if (typeId === 'Opaque') return { ...(values.data || {}) }
  if (typeId === 'kubernetes.io/basic-auth') return { username: values.username || '', password: values.password || '' }
  if (typeId === 'kubernetes.io/dockerconfigjson') {
    let auth = ''
    try { auth = btoa(`${values.registryUser}:${values.registryPassword}`) } catch { auth = `${values.registryUser}:${values.registryPassword}` }
    const cfg = { auths: { [values.registry]: { username: values.registryUser, password: values.registryPassword, email: values.registryEmail, auth } } }
    return { '.dockerconfigjson': JSON.stringify(cfg) }
  }
  if (typeId === 'kubernetes.io/tls') return { 'tls.crt': values['tls.crt'] || '', 'tls.key': values['tls.key'] || '' }
  if (typeId === 'kubernetes.io/ssh-auth') return { 'ssh-privatekey': values['ssh-privatekey'] || '' }
  return {}
}

export function secretFieldsComplete(typeId, values) {
  switch (typeId) {
    case 'kubernetes.io/basic-auth': return !!(values.username && values.password)
    case 'kubernetes.io/dockerconfigjson': return !!(values.registry && values.registryUser && values.registryPassword)
    case 'kubernetes.io/tls': return !!(values['tls.crt'] && values['tls.key'])
    case 'kubernetes.io/ssh-auth': return !!values['ssh-privatekey']
    default: return Object.keys(values.data || {}).length > 0
  }
}
```

- [ ] **Step 4: 通过 + Commit** `feat(utils): secretTemplates——5 类型字段/校验/组装纯函数(自 NsSecrets 内联抽出)`

---

### Task 4: KeyValueRowsEditor.vue（注解/标签行编辑）

**Files:**
- Create: `src/components/common/KeyValueRowsEditor.vue`
- Test: `src/components/common/__tests__/KeyValueRowsEditor.test.js`

**Interfaces:**
- Produces（Task 6 消费）: props `modelValue: Array<{key,value}>`（v-model）、`keyPlaceholder?: string`、`valuePlaceholder?: string`、`multiline?: boolean`；emit `update:modelValue`。行内标红重复/非法 key；空行（key 为空）不参与。无内部提交按钮——纯受控编辑器

- [ ] **Step 1: 写失败测试**（i18n 插件挂法照 CreatePvcDialog.test.js）

```js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import KeyValueRowsEditor from '@/components/common/KeyValueRowsEditor.vue'

function mountRows(props = {}) {
  return mount(KeyValueRowsEditor, { props: { modelValue: [], ...props }, global: { plugins: [i18n] } })
}

test('添加行并输入 → v-model 同步', async () => {
  const w = mountRows()
  await w.find('[data-testid="kv-add"]').trigger('click')
  ;[...w.findAll('input')[0].setValue('app'), w.findAll('input')[1].setValue('web')]
  expect(w.emitted('update:modelValue')[0][0]).toEqual([{ key: 'app', value: 'web' }])
})

test('删除行 → 同步移除；初始行渲染', async () => {
  const w = mountRows({ modelValue: [{ key: 'a', value '1' }, { key: 'b', value: '2' }] })
  await w.findAll('[data-testid="kv-del"]')[0].trigger('click')
  expect(w.emitted('update:modelValue')[0][0]).toEqual([{ key: 'b', value: '2' }])
})

test('重复 key 标红(data-dup)', async () => {
  const w = mountRows({ modelValue: [{ key: 'x', value: '1' }] })
  await w.find('[data-testid="kv-add"]').trigger('click')
  await w.findAll('input')[2].setValue('x')
  expect(w.findAll('[data-testid="kv-row"]')[1].attributes('data-dup')).toBe('true')
})
```

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**（行 = key input + value input(input/textarea 按 multiline) + 删除按钮；dup = 同 key 出现≥2 次；key 非法 = 非空且不合 `^[-._a-zA-Z][-._a-zA-Z0-9]*$` 前缀段（注解前缀）/标签 `^[-._a-zA-Z0-9]+$`——**统一用宽松版 `^[-._a-zA-Z0-9]+$` 加可选前缀 `^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/`**；空 key 行不标错。样式照 NsConfigMaps 现 modal 行样式 token）

- [ ] **Step 4: 通过 + Commit** `feat(components): KeyValueRowsEditor——注解/标签 key-value 行编辑(重复/非法标红)`

---

### Task 5: DataKeysEditor.vue（文件浏览器式多键管理）

**Files:**
- Create: `src/components/common/DataKeysEditor.vue`
- Test: `src/components/common/__tests__/DataKeysEditor.test.js`

**Interfaces:**
- Consumes: Task 2 的 `detectLang`/`lineCount`；CodeViewer（props: code/lang/maxHeight）
- Produces（Task 6 消费）:
  - props: `modelValue: Array<{key,value}>`（v-model）、`secret?: boolean`（自由键掩码）、`fixedFields?: Array<{key,labelKey,multiline,secret?}> | null`（模板固定字段模式）
  - emit: `update:modelValue`
  - 自由模式：左栏键列表（图标/键名/行数/hover 删/底部 `+` 添加）+ 右栏 CodeViewer 查看 ↔ textarea 编辑（Edit/Save/Cancel，Save 写回 modelValue）；secret 时右栏编辑 input 为掩码可切换（material icon `visibility`/`visibility_off` 按钮）
  - 固定模式：无左栏，字段纵向排列（labelKey 标签 + textarea/掩码 input），值实时写回 modelValue 中对应 key 的条目

- [ ] **Step 1: 写失败测试**

```js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import DataKeysEditor from '@/components/common/DataKeysEditor.vue'

const CVStub = { props: ['code', 'lang', 'maxHeight'], template: '<pre data-testid="cv">{{ code }}</pre>' }
function mountEditor(props = {}) {
  return mount(DataKeysEditor, { props: { modelValue: [], ...props }, global: { plugins: [i18n], stubs: { CodeViewer: CVStub } } })
}

test('自由模式:添加键→编辑→Save 写回 modelValue', async () => {
  const w = mountEditor()
  await w.find('[data-testid="dk-add"]').trigger('click')
  await w.findAll('input')[0].setValue('app.yml')     // 新行 key 输入
  await w.find('[data-testid="dk-edit"]').trigger('click')
  await w.find('textarea').setValue('a: 1')
  await w.find('[data-testid="dk-save"]').trigger('click')
  expect(w.emitted('update:modelValue').at(-1)[0]).toEqual([{ key: 'app.yml', value: 'a: 1' }])
})

test('自由模式:删除键', async () => {
  const w = mountEditor({ modelValue: [{ key: 'k', value: 'v' }] })
  await w.find('[data-testid="dk-del-0"]').trigger('click')
  expect(w.emitted('update:modelValue')[0][0]).toEqual([])
})

test('secret 掩码:掩码态 input type=password,toggle 后 text', async () => {
  const w = mountEditor({ modelValue: [{ key: 'pwd', value: 'x' }], secret: true })
  await w.find('[data-testid="dk-edit"]').trigger('click')
  expect(w.find('textarea').attributes('type')).toBeUndefined()  // 文本值自由键用 textarea,掩码仅对单行?见实现注
  await w.find('[data-testid="dk-mask"]').trigger('click')
  expect(w.vm.revealed).toBe(true)
})

test('固定字段模式:渲染 labelKey 字段并写回', async () => {
  const w = mountEditor({
    modelValue: [{ key: 'tls.crt', value: '' }],
    fixedFields: [{ key: 'tls.crt', labelKey: 'component.createConfigModal.fTlsCrt', multiline: true }],
  })
  await w.find('textarea').setValue('CERT')
  expect(w.emitted('update:modelValue').at(-1)[0]).toEqual([{ key: 'tls.crt', value: 'CERT' }])
})

test('空态:无键显示引导文案', () => {
  const w = mountEditor()
  expect(w.find('[data-testid="dk-empty"]').exists()).toBe(true)
})
```

（注：掩码断言按实现微调——自由键多行值编辑固定用 textarea，掩码 toggle 只影响**左栏值预览行**与固定字段的单行 input；测试断言 `revealed` 状态即可）

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**（结构照 NsConfigMapDetail.vue:256-321 分栏布局 token 化：`grid grid-cols-[220px_1fr]`；编辑态本地 `editing` ref + `draft`；Save 时浅拷贝 modelValue 替换条目后 emit；固定模式渲染 `fixedFields`）

- [ ] **Step 4: 通过 + Commit** `feat(components): DataKeysEditor——文件浏览器式多键编辑(分栏/高亮/掩码/固定字段)`

---

### Task 6: CreateConfigResourceModal.vue 骨架（tabs + 表单 + payload）

**Files:**
- Create: `src/components/common/CreateConfigResourceModal.vue`
- Modify: `src/locales/zh.json`、`src/locales/en.json`（新增 `component.createConfigModal.*` 键，见 Step 3 清单）
- Test: `src/components/common/__tests__/CreateConfigResourceModal.test.js`

**Interfaces:**
- Consumes: Task 3 `SECRET_TYPES/secretFieldsComplete`、Task 4 KeyValueRowsEditor、Task 5 DataKeysEditor；store `addConfigMap({name,namespace,keys,data,labels,annotations})` / `addSecret({name,namespace,type,keys,data,labels,annotations})`
- Produces（Task 7/8 消费）:
  - props: `kind: 'configmap'|'secret'`、`modelValue: boolean`、`namespace: string`
  - emits: `update:modelValue`、`created`（成功后触发，父级刷新）
  - 内部状态（Task 7 在此基础上加 YAML tab）：`name`、`secretTypeId`、`freeKeys: [{key,value}]`（**唯一数据源**：自由键与固定字段都经 DataKeysEditor v-model 到这里，固定模式即 `[{key:'tls.crt',value:'C'},…]`）、`labels: [{key,value}]`、`annotations: [{key,value}]`、`activeTab: 'data'|'annotations'|'labels'|'yaml'`
  - computed `payload()` → kind 二态对象（data 由 buildSecretData/自由键组装）

- [ ] **Step 1: 写失败测试**

```js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

const addConfigMap = vi.fn(async () => ({ ok: true }))
const addSecret = vi.fn(async () => ({ ok: true }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ addConfigMap, addSecret, generateYAML: vi.fn(() => ''), applyResourceYaml: vi.fn(async () => ({ ok: true })) }),
}))
import CreateConfigResourceModal from '@/components/common/CreateConfigResourceModal.vue'

const ModalStub = { props: ['modelValue', 'title', 'width'], emits: ['update:modelValue'],
  template: '<div v-if="modelValue"><slot /><slot name="actions" /></div>' }
function mountModal(kind, props = {}) {
  return mount(CreateConfigResourceModal, {
    props: { modelValue: true, kind, namespace: 'default', ...props },
    global: { plugins: [i18n], stubs: { Modal: ModalStub } },
  })
}

test('configmap: name+数据键+labels → addConfigMap 收到完整 payload,emit created', async () => {
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-name"]').setValue('cm1')
  // 数据 tab 默认展开 DataKeysEditor stub 场景下直接操纵组件 emitted —— 见 Step3 实现 defineExpose 或用子组件交互
  await w.find('[data-testid="ccm-create"]').trigger('click')
  expect(addConfigMap).toHaveBeenCalledWith(expect.objectContaining({ name: 'cm1', namespace: 'default' }))
  expect(w.emitted('created')).toBeTruthy()
})

test('secret tls: 固定字段完整 → addSecret 收到 type+data 组装', async () => {
  const w = mountModal('secret')
  await w.find('[data-testid="ccm-name"]').setValue('s1')
  await w.find('[data-testid="ccm-type"]').setValue('kubernetes.io/tls')
  // 固定字段经 DataKeysEditor fixedFields——测试里 stub DataKeysEditor 直接触发其 update:modelValue
  await w.findComponent({ name: 'DataKeysEditor' }).vm.$emit('update:modelValue', [{ key: 'tls.crt', value: 'C' }, { key: 'tls.key', value: 'K' }])
  await w.find('[data-testid="ccm-create"]').trigger('click')
  expect(addSecret).toHaveBeenCalledWith(expect.objectContaining({ name: 's1', type: 'kubernetes.io/tls', data: { 'tls.crt': 'C', 'tls.key': 'K' } }))
})

test('name 非法/必填缺失 → 创建按钮禁用', async () => {
  const w = mountModal('configmap')
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeDefined()
  await w.find('[data-testid="ccm-name"]').setValue('Bad_Name')
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeDefined()
})

test('addConfigMap 返回 {ok:false} → 不 emit created、Modal 不关', async () => {
  addConfigMap.mockResolvedValueOnce({ ok: false })
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-name"]').setValue('cm2')
  await w.find('[data-testid="ccm-create"]').trigger('click')
  await Promise.resolve()
  expect(w.emitted('created')).toBeFalsy()
  expect(w.emitted('update:modelValue')).toBeFalsy()
})
```

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**
  - 模板：Modal（width `max-w-4xl`，title `t('component.createConfigModal.titleConfigMap'|'titleSecret')` 按 kind）→ name 输入（`data-testid="ccm-name"`，非法 name 行内错误键 `invalidName`）→ secret 时类型 select（`data-testid="ccm-type"`，选项渲染 `SECRET_TYPES` 的 labelKey）→ tab 条（数据/注解/标签 + YAML 占位 tab 本 Task 只渲染按钮禁用）→ tab 内容：DataKeysEditor（kind=secret && 模板有 fields 时传 `fixedFields`；值统一存 `freeKeys` 数组，固定模式即 `[{key:'tls.crt',...}]`）、两个 KeyValueRowsEditor → actions：取消 / 创建（`data-testid="ccm-create"`，:disabled = `!canCreate`）
  - `canCreate`：name 合法（DNS-1123 子域 regex，Global Constraints）+ 无重复/非法 meta key + （secret 时 `secretFieldsComplete` 或 configmap 至少一键）
  - `payload()`：`const keyObj = Object.fromEntries(freeKeys.filter(k => k.key).map(k => [k.key, k.value]))`；configmap `{ name, namespace, keys: Object.keys(keyObj).length, data: keyObj, labels: rowsToObj(labels), annotations: rowsToObj(annotations) }`；secret 同构 + `type: secretTypeId`，`data: buildSecretData(secretTypeId, secretTypeId === 'Opaque' ? { data: keyObj } : keyObj)`
  - `submit()`：`const r = kind==='configmap' ? await store.addConfigMap(payload) : await store.addSecret(payload)`；`if (r && r.ok === false) return`；否则 `emit('created')` + `emit('update:modelValue', false)`
  - **locale 键**（zh/en 同加，`component.createConfigModal.*`）：`titleConfigMap`(创建 ConfigMap/Create ConfigMap)、`titleSecret`(创建 Secret/Create Secret)、`tabData`(数据/Data)、`tabAnnotations`(注解/Annotations)、`tabLabels`(标签/Labels)、`tabYaml`(YAML/YAML)、`nameLabel`(名称/Name)、`typeLabel`(类型/Type)、`invalidName`(名称需符合 K8s 规则：小写字母数字与 - . /Name must be a valid K8s name: lowercase alphanumerics with - .)、`duplicateKey`(键重复/Duplicate key)、`base64Hint`(值将以 base64 编码存储/Values will be stored base64-encoded)、`emptyKeys`(还没有数据键,点左侧添加/No data keys yet — add one on the left)、`addKey`(添加键/Add Key)、`fUsername`(用户名/Username)、`fPassword`(密码/Password)、`fRegistry`(Registry 地址/Registry)、`fRegistryUser`(用户名/Username)、`fRegistryPassword`(密码/Password)、`fRegistryEmail`(邮箱/Email)、`fTlsCrt`(证书 (tls.crt)/Certificate (tls.crt))、`fTlsKey`(私钥 (tls.key)/Private key (tls.key))、`fSshKey`(SSH 私钥/SSH private key)
  - Task 4/5 组件若用 `component.dataKeysEditor.*`/`component.kvRows.*` 键，在各自 Task 落（本 Task 检查两组件测试引用的键已存在）

- [ ] **Step 4: 通过 + i18n:check 全 0 + Commit** `feat(components): CreateConfigResourceModal 骨架——四 tab+校验+payload 组装+{ok} 契约`

---

### Task 7: YAML tab（派生预览 + 纯 YAML 模式）

**Files:**
- Modify: `src/components/common/CreateConfigResourceModal.vue`
- Modify: `src/locales/zh.json`、`src/locales/en.json`（+3 键）
- Test: 扩 `src/components/common/__tests__/CreateConfigResourceModal.test.js`

**Interfaces:**
- Consumes: `store.generateYAML`（Task 1 后 secret 支持 meta）、`store.applyResourceYaml(yaml)→{ok}`、js-yaml `load`
- Produces: YAML tab 两种模式；`yamlMode: 'preview'|'edit'`、`rawYaml: string`

- [ ] **Step 1: 写失败测试**

```js
test('YAML tab 预览:派生自 payload(含 labels)', async () => {
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-name"]').setValue('cm3')
  await w.find('[data-testid="ccm-tab-yaml"]').trigger('click')
  const pre = w.find('[data-testid="ccm-yaml-preview"]')
  expect(pre.text()).toContain('kind: ConfigMap')
  expect(pre.text()).toContain('name: cm3')
})

test('切换纯 YAML 编辑:填合法 ConfigMap YAML → applyResourceYaml 提交', async () => {
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-tab-yaml"]').trigger('click')
  await w.find('[data-testid="ccm-yaml-switch"]').trigger('click')
  await w.find('[data-testid="ccm-yaml-input"]').setValue('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: y1\n  namespace: default\ndata:\n  k: v')
  await w.find('[data-testid="ccm-create"]').trigger('click')
  expect(applyResourceYaml).toHaveBeenCalled()
  expect(addConfigMap).not.toHaveBeenCalled()
})

test('纯 YAML kind 不对 → 创建禁用 + 错误提示', async () => {
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-tab-yaml"]').trigger('click')
  await w.find('[data-testid="ccm-yaml-switch"]').trigger('click')
  await w.find('[data-testid="ccm-yaml-input"]').setValue('apiVersion: v1\nkind: Service\nmetadata:\n  name: s\n  namespace: default')
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeDefined()
  expect(w.find('[data-testid="ccm-yaml-error"]').exists()).toBe(true)
})
```

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**
  - `derivedYaml = computed(() => store.generateYAML(kind === 'configmap' ? 'configmap' : 'secret', { ...payload(), data: kind === 'secret' ? encodeSecretData(payload().data) : payload().data }))`（`encodeSecretData` 自 `@/composables/useResourceMappers` 导入——与 makeCrud beforeSave 完全同路，保证预览=提交体）
  - preview 模式：`<pre data-testid="ccm-yaml-preview">` 显示 derivedYaml + 复制按钮（复用 clipboard 逻辑照 YamlEditor.vue copy 实现）
  - `switchToEdit()`：rawYaml = derivedYaml 值快照；edit 模式：`<textarea data-testid="ccm-yaml-input">`；「返回表单」按钮 `window.confirm(t('...discardConfirm'))` 确认后 yamlMode='preview'
  - edit 校验 computed：`load(rawYaml)` try/catch（解析失败）+ `o.kind === (kind==='configmap'?'ConfigMap':'Secret')`；错误显示 `[data-testid="ccm-yaml-error"]`
  - edit 模式下其他 tab 按钮 disabled + 数据 tab 内容置灰（`opacity-50 pointer-events-none` 容器类）
  - `canCreate` edit 分支：YAML 校验通过即可提交；`submit()` edit 分支：`const r = await store.applyResourceYaml(rawYaml)`，`if (r && r.ok === false) return`
  - locale +3：`switchToYamlEdit`(切换为纯 YAML 编辑/Switch to raw YAML editing)、`backToForm`(返回表单/Back to form)、`yamlKindError`(YAML 解析失败或 kind 不符/Invalid YAML or wrong kind)、`yamlParseError`(YAML 解析失败/YAML parse error)、`discardConfirm`(返回表单将丢弃 YAML 手动修改,继续?/Return to form and discard manual YAML edits?)

- [ ] **Step 4: 通过 + i18n:check + Commit** `feat(components): 创建 Modal YAML tab——实时派生预览+纯 YAML 模式(解析/kind 校验+applyResourceYaml)`

---

### Task 8: NsConfigMaps/NsSecrets 换装

**Files:**
- Modify: `src/views/NsConfigMaps.vue`（删 48-76 创建态/函数 + 178 起 Modal 块，换新组件）
- Modify: `src/views/NsSecrets.vue`（删 58-127 创建态/函数 + Modal 块，换新组件；secret 类型/组装逻辑已被 Task 3 收编）
- Test: `src/views/__tests__/NsConfigMaps.create.test.js`（新建，NsSecrets 同文件二 describe 或新文件）

**Interfaces:**
- Consumes: Task 6/7 完整 Modal
- Produces: 两列表页 `<CreateConfigResourceModal v-model="showCreateModal" :kind="'configmap'|'secret'" :namespace="route.params.namespace" @created="queryClient.invalidateQueries({ queryKey: configmapsKey|secretsKey })" />`；「新建」按钮仅置 `showCreateModal=true`

- [ ] **Step 1: 写失败测试**（mock store + queryClient 照 NsServices.delete-ok.test.js 模式；断言：点新建 → Modal 出现；Modal emit created → invalidateQueries 被调；旧 Modal 的本地 keys 状态已不存在——`wrapper.vm.createForm` 为 undefined）

```js
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const invalidateQueries = vi.fn()
vi.mock('@/composables/useK8sQuery', () => ({ useResourceList: () => ({ data: { value: [] } }) }))
vi.mock('@tanstack/vue-query', () => ({ useQueryClient: () => ({ invalidateQueries }) }))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ nsConfigMaps: [], addConfigMap: vi.fn() }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'ns1' } }) }))

import NsConfigMaps from '@/views/NsConfigMaps.vue'

test('新建入口挂新 Modal;created → invalidate configmaps 查询', async () => {
  const w = mount(NsConfigMaps, { global: { plugins: [i18n], stubs: { CreateConfigResourceModal: { props: ['modelValue','kind','namespace'], emits: ['update:modelValue','created'], template: '<div data-testid="ccm-stub" v-if="modelValue" @click="$emit(\'created\')" />' } } } })
  await w.find('[data-testid="open-create"]').trigger('click')
  expect(w.find('[data-testid="ccm-stub"]').exists()).toBe(true)
  await w.find('[data-testid="ccm-stub"]').trigger('click')
  expect(invalidateQueries).toHaveBeenCalled()
})
```

（NsConfigMaps 新建按钮加 `data-testid="open-create"`；NsSecrets 同样测一组）

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**——两视图：script 删 `createForm/resetCreate/addCreateKey/removeCreateKey/canCreateSecret/handleCreate`；模板删旧 Modal 块换新组件标签；新建按钮加 testid。NsSecrets 删除后其 i18n 键（ns.secrets.type* 除外，被 SECRET_TYPES 引用）保留不删

- [ ] **Step 4: 通过 + 全量 `npm run test:unit`（防其他视图测试连带）+ Commit** `feat(views): NsConfigMaps/NsSecrets 创建换装富 Modal(删两份内联表单)`

---

### Task 9: 终验

- [ ] `node scripts/i18n-check.mjs` 六项全 0
- [ ] `npm run typecheck` ✓
- [ ] `npm test`（server+unit 全绿）
- [ ] `npm run build` ✓
- [ ] Commit（如有收尾）+ 汇报手测清单：①两 kind 各建一个（含 labels/annotations）→ 列表出现且详情页能看到 meta ②YAML 预览实时反映 ③纯 YAML 建一个 ④tls 类型必填校验 ⑤失败路径（name 已存在）Modal 保留 ⑥Secret 掩码切换 ⑦中英文切换全文案跟随

---

## Self-Review 记录

- Spec 覆盖：四 tab（Task 6/7）、文件浏览器（Task 5）、注解/标签（Task 4/6）、单向 YAML+纯 YAML（Task 7）、掩码（Task 5）、{ok} 契约（Task 6/7/8）、详情页不动（全计划无其文件）、i18n 双语（Global+各 Task）✓
- 类型一致：`buildSecretData(typeId, values)`/`secretFieldsComplete(typeId, values)` 签名 Task 3 定义 = Task 6 使用 ✓；DataKeysEditor `fixedFields` 形状 Task 5 定义 = Task 3 `fields` 形状 ✓；`payload()` 键名与 store.add* 期望对齐（keys/data/labels/annotations/type）✓
- 已知留白（实现时照做，不再扩设计）：Task 4/5 测试里行内样式细节以实现为准；Task 6 DataKeysEditor 交互在 Modal 测试中经 stub 触发
