# 首装添加集群独立页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首装/日常「添加集群」改为 AppLayout 外的独立全屏页 `/add-cluster`,创建成功后自动连接并进入 `/cluster` Overview。

**Architecture:** 从 `ClusterManagement.vue` 的 modal 抽取共享表单组件 `ClusterForm.vue`(字段+必填校验,i18n 复用 `admin.clusters.*` 键);新增独立视图 `AddCluster.vue`(三态:表单→连接中→连接失败重试)消费它;`SelectCluster.vue` 的添加入口改指新路由并增加 admin 常驻入口;路由 meta `requiresCluster: false` 让现有守卫(`clusterGate.js`)自然放行,守卫逻辑零改动。

**Tech Stack:** Vue 3 `<script setup>` + vue-router + Pinia + vue-i18n;测试 vitest + @vue/test-utils + happy-dom(仓库已登记的依赖例外,见 CLAUDE.md)。

**Spec:** `docs/superpowers/specs/2026-08-14-first-cluster-add-page-design.md`

## Global Constraints

- 工作目录:worktree `.claude/worktrees/feat-first-cluster-onboarding`,分支 `worktree-feat-first-cluster-onboarding`;提交前先 `git branch --show-current` 确认。
- 不新增任何依赖;测试只写 vitest(`src/**/*.{test,spec}.js`,收在 `src/**/__tests__/`)。
- i18n:zh + en 两份 locale 同步加键;ClusterForm 复用现有 `admin.clusters.*` 键,不造重复键;`npm run i18n:check` 必须过。
- 验收命令:`npm run typecheck` + `npm test` + `npm run i18n:check` + `npm run build` 全绿。
- 每个任务 TDD:先写失败测试 → 跑确认失败 → 实现 → 跑确认通过 → commit。
- 提交信息末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 服务端零改动:`POST /api/admin/clusters` 创建时已探测 `/version`,成功返回 `{ cluster: { id, name, apiServer, version } }`;`authStore.connectCluster(id)` 走 `/api/connect-cluster`。

---

### Task 1: ClusterForm 共享表单组件(含必填校验)

**Files:**
- Create: `src/components/common/ClusterForm.vue`
- Test: `src/components/__tests__/ClusterForm.test.js`
- Modify: `src/locales/zh.json`、`src/locales/en.json`(admin.clusters 命名空间加 5 个校验键)

**Interfaces:**
- Consumes: 现有 i18n 键 `admin.clusters.clusterName/authKubeconfig/authToken/authBasic/pasteKubeconfig/username/password/insecureTls/addAndVerify` 与 `common.cancel`(均已存在,勿重复添加)。
- Produces(Task 2/3 依赖):
  - 组件 `@/components/common/ClusterForm.vue`,props `{ form: Object, submitting: Boolean }`,`emits ['submit', 'cancel']`;校验失败不 emit submit。
  - `form` 对象形状(与 ClusterManagement 现有 addForm 完全一致):`{ name, authMethod: 'kubeconfig'|'token'|'basic', apiServer, token, username, password, kubeconfig, insecure }`;组件直接改 prop 对象的字段(`v-model="form.xxx"`),父组件保留所有权。
  - data-testid:`cluster-form-name` / `cluster-form-kubeconfig` / `cluster-form-apiserver` / `cluster-form-token` / `cluster-form-username` / `cluster-form-password` / `cluster-form-auth-kubeconfig` / `cluster-form-auth-token` / `cluster-form-auth-basic` / `cluster-form-error-{name,kubeconfig,apiServer,token,username}` / `cluster-form-submit` / `cluster-form-cancel`。
  - i18n 新键:`admin.clusters.nameRequired/kubeconfigRequired/apiServerRequired/tokenRequired/usernameRequired`。

- [ ] **Step 1: 写失败测试**

创建 `src/components/__tests__/ClusterForm.test.js`:

```js
// ClusterForm 共享表单:三种凭据方式显隐 + 必填校验(不 emit submit)+ submit/cancel 事件。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { i18n } from '@/i18n'
import ClusterForm from '../common/ClusterForm.vue'

function makeForm(over = {}) {
  return reactive({ name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false, ...over })
}
function mountForm(form, submitting = false) {
  return mount(ClusterForm, { props: { form, submitting }, global: { plugins: [i18n] } })
}
const submit = w => w.find('[data-testid="cluster-form-submit"]')
const cancel = w => w.find('[data-testid="cluster-form-cancel"]')

test('默认 kubeconfig 方式:名称+kubeconfig 输入渲染,token/basic 区块隐藏', () => {
  const w = mountForm(makeForm())
  expect(w.find('[data-testid="cluster-form-name"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-kubeconfig"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-apiserver"]').exists()).toBe(false)
  expect(w.find('[data-testid="cluster-form-token"]').exists()).toBe(false)
  expect(w.find('[data-testid="cluster-form-username"]').exists()).toBe(false)
})

test('切 token 方式:显示 apiServer+token;切 basic:显示 apiServer+username+password', async () => {
  const form = makeForm()
  const w = mountForm(form)
  await w.find('[data-testid="cluster-form-auth-token"]').trigger('click')
  expect(w.find('[data-testid="cluster-form-apiserver"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-token"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-kubeconfig"]').exists()).toBe(false)

  await w.find('[data-testid="cluster-form-auth-basic"]').trigger('click')
  expect(w.find('[data-testid="cluster-form-username"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-password"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-token"]').exists()).toBe(false)
})

test('空表单提交:不 emit submit,名称与 kubeconfig 内联错误', async () => {
  const form = makeForm()
  const w = mountForm(form)
  await submit(w).trigger('click')
  expect(w.emitted('submit')).toBeUndefined()
  expect(w.find('[data-testid="cluster-form-error-name"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-error-kubeconfig"]').exists()).toBe(true)
})

test('token 方式缺 apiServer:显示 apiServer 错误,不 emit', async () => {
  const form = makeForm({ authMethod: 'token', token: 'eyX', name: 'demo' })
  const w = mountForm(form)
  await submit(w).trigger('click')
  expect(w.emitted('submit')).toBeUndefined()
  expect(w.find('[data-testid="cluster-form-error-apiServer"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-error-token"]').exists()).toBe(false)
})

test('basic 方式缺 username:显示 username 错误,不 emit', async () => {
  const form = makeForm({ authMethod: 'basic', apiServer: 'https://10.0.0.1:6443', name: 'demo' })
  const w = mountForm(form)
  await submit(w).trigger('click')
  expect(w.emitted('submit')).toBeUndefined()
  expect(w.find('[data-testid="cluster-form-error-username"]').exists()).toBe(true)
})

test('填齐(kubeconfig 方式)提交:emit submit 一次;cancel 按钮 emit cancel', async () => {
  const form = makeForm({ name: 'demo', kubeconfig: 'apiVersion: v1' })
  const w = mountForm(form)
  await submit(w).trigger('click')
  expect(w.emitted('submit')).toHaveLength(1)
  await cancel(w).trigger('click')
  expect(w.emitted('cancel')).toHaveLength(1)
})

test('submitting=true 时提交按钮 disabled', () => {
  const w = mountForm(makeForm({ name: 'd', kubeconfig: 'x' }), true)
  expect(submit(w).attributes('disabled')).toBeDefined()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/ClusterForm.test.js`
Expected: FAIL —— `Cannot find module '../common/ClusterForm.vue'`(或等价的模块不存在错误)。

- [ ] **Step 3: 加 i18n 校验键**

`src/locales/zh.json`:定位 `"admin"` → `"clusters"` 对象内 `"addFailed"` 键(约 2300 行附近),在其后追加:

```json
      "nameRequired": "集群名称不能为空",
      "kubeconfigRequired": "请粘贴 kubeconfig",
      "apiServerRequired": "API Server 不能为空",
      "tokenRequired": "Bearer Token 不能为空",
      "usernameRequired": "用户名不能为空",
```

`src/locales/en.json`:`admin.clusters.addFailed` 后追加(注意上一行补逗号):

```json
      "nameRequired": "Cluster name is required",
      "kubeconfigRequired": "Please paste a kubeconfig",
      "apiServerRequired": "API Server is required",
      "tokenRequired": "Bearer token is required",
      "usernameRequired": "Username is required",
```

注意 JSON 逗号:追加在对象中间时,前一个键行尾须有逗号,最后一个新键行尾无逗号(以对象内原最后键的位置为准,若 `addFailed` 不是最后一个键则新键块整体作为中间成员,行尾逗号规则同理)。

- [ ] **Step 4: 实现 ClusterForm.vue**

创建 `src/components/common/ClusterForm.vue`(字段模板从 `src/views/admin/ClusterManagement.vue:70-96` 平移,样式类与 placeholder 原样保留):

```vue
<script setup>
// 集群凭据表单(共享组件):AddCluster 独立页与集群管理页 modal 共用。
// 职责:字段渲染 + 必填校验;不发 API(提交/取消由父组件处理)。
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  form: { type: Object, required: true },
  submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['submit', 'cancel'])
const { t } = useI18n()
const errors = ref({})

function validate() {
  const e = {}
  const f = props.form
  if (!f.name?.trim()) e.name = t('admin.clusters.nameRequired')
  if (f.authMethod === 'kubeconfig' && !f.kubeconfig?.trim()) e.kubeconfig = t('admin.clusters.kubeconfigRequired')
  if (f.authMethod !== 'kubeconfig' && !f.apiServer?.trim()) e.apiServer = t('admin.clusters.apiServerRequired')
  if (f.authMethod === 'token' && !f.token?.trim()) e.token = t('admin.clusters.tokenRequired')
  if (f.authMethod === 'basic' && !f.username?.trim()) e.username = t('admin.clusters.usernameRequired')
  return e
}

function onSubmit() {
  errors.value = validate()
  if (Object.keys(errors.value).length) return
  emit('submit')
}
</script>

<template>
  <div class="flex flex-col gap-md">
    <div>
      <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('admin.clusters.clusterName') }}</label>
      <input v-model="form.name" data-testid="cluster-form-name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="prod-cluster" />
      <p v-if="errors.name" data-testid="cluster-form-error-name" class="text-body-xs text-error mt-xs">{{ errors.name }}</p>
    </div>
    <!-- 凭据方式切换 -->
    <div class="flex gap-xs">
      <button v-for="m in [{k:'kubeconfig',l:t('admin.clusters.authKubeconfig')},{k:'token',l:t('admin.clusters.authToken')},{k:'basic',l:t('admin.clusters.authBasic')}]" :key="m.k" :data-testid="`cluster-form-auth-${m.k}`" @click="form.authMethod = m.k"
        class="px-sm py-xs rounded-lg border text-body-sm" :class="form.authMethod === m.k ? 'bg-primary text-on-primary border-primary font-semibold' : 'border-outline-variant text-on-surface-variant'">{{ m.l }}</button>
    </div>
    <!-- Kubeconfig -->
    <div v-if="form.authMethod === 'kubeconfig'">
      <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('admin.clusters.pasteKubeconfig') }}</label>
      <textarea v-model="form.kubeconfig" data-testid="cluster-form-kubeconfig" rows="8" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="apiVersion: v1&#10;kind: Config&#10;..."></textarea>
      <p v-if="errors.kubeconfig" data-testid="cluster-form-error-kubeconfig" class="text-body-xs text-error mt-xs">{{ errors.kubeconfig }}</p>
    </div>
    <!-- Token -->
    <div v-if="form.authMethod === 'token'" class="flex flex-col gap-sm">
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">API Server</label>
        <input v-model="form.apiServer" data-testid="cluster-form-apiserver" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="https://10.0.0.1:6443" />
        <p v-if="errors.apiServer" data-testid="cluster-form-error-apiServer" class="text-body-xs text-error mt-xs">{{ errors.apiServer }}</p>
      </div>
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">Bearer Token</label>
        <input v-model="form.token" data-testid="cluster-form-token" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="eyJhb..." />
        <p v-if="errors.token" data-testid="cluster-form-error-token" class="text-body-xs text-error mt-xs">{{ errors.token }}</p>
      </div>
    </div>
    <!-- Basic -->
    <div v-if="form.authMethod === 'basic'" class="flex flex-col gap-sm">
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">API Server</label>
        <input v-model="form.apiServer" data-testid="cluster-form-apiserver" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="https://10.0.0.1:6443" />
        <p v-if="errors.apiServer" data-testid="cluster-form-error-apiServer" class="text-body-xs text-error mt-xs">{{ errors.apiServer }}</p>
      </div>
      <div class="grid grid-cols-2 gap-sm">
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('admin.clusters.username') }}</label>
          <input v-model="form.username" data-testid="cluster-form-username" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" />
          <p v-if="errors.username" data-testid="cluster-form-error-username" class="text-body-xs text-error mt-xs">{{ errors.username }}</p>
        </div>
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('admin.clusters.password') }}</label>
          <input v-model="form.password" data-testid="cluster-form-password" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" />
        </div>
      </div>
    </div>
    <label class="flex items-center gap-sm text-body-sm cursor-pointer"><input type="checkbox" v-model="form.insecure" class="h-4 w-4 accent-primary" /> {{ t('admin.clusters.insecureTls') }}</label>

    <!-- 操作行 -->
    <div class="flex justify-end gap-sm pt-xs">
      <button data-testid="cluster-form-cancel" @click="emit('cancel')" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
      <button data-testid="cluster-form-submit" :disabled="submitting" @click="onSubmit" class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
        <span v-if="submitting" class="material-symbols-outlined text-sm animate-spin">progress_activity</span>
        {{ t('admin.clusters.addAndVerify') }}
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/ClusterForm.test.js`
Expected: PASS(7 个测试全绿)。

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # 确认 worktree-feat-first-cluster-onboarding
git add src/components/common/ClusterForm.vue src/components/__tests__/ClusterForm.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(components): 抽取共享 ClusterForm(字段+必填校验+i18n 错误键)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: ClusterManagement modal 改用 ClusterForm(行为不变)

**Files:**
- Modify: `src/views/admin/ClusterManagement.vue`(替换 modal 内联表单,69-101 行区域)
- Test: `src/views/__tests__/ClusterManagement.clusterform.test.js`(新)

**Interfaces:**
- Consumes: Task 1 的 `ClusterForm`(props/emits/data-testid 见 Task 1 Interfaces)。
- Produces: ClusterManagement 对外的行为不变——`adminApi.clusters.create(addForm)` 成功 notify('success', ...) + 刷新列表;差异仅在:空字段提交现在被 ClusterForm 内联拦截(不发请求);新增 `adding` ref 驱动按钮 loading。

- [ ] **Step 1: 写失败测试**

创建 `src/views/__tests__/ClusterManagement.clusterform.test.js`:

```js
// 集群管理 modal 改用共享 ClusterForm 后的回归:校验拦截 + 成功提交走 create。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const createMock = vi.fn(async () => ({ cluster: { id: 'c1', name: 'demo', apiServer: 'https://x', version: 'v1.30' } }))
const notifyMock = vi.fn()

vi.mock('@/api/client', () => ({
  adminApi: {
    clusters: {
      list: vi.fn(async () => ({ clusters: [] })),
      create: (...a) => createMock(...a),
      remove: vi.fn(),
    },
  },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: '' }) }))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))

import ClusterManagement from '../admin/ClusterManagement.vue'

function mountView() {
  return mount(ClusterManagement, {
    global: {
      plugins: [i18n],
      stubs: { Modal: { template: '<div><slot /></div>' }, ClusterCard: true }, // Modal 打穿默认插槽;actions 插槽已随重构移除
    },
  })
}
async function openAddModal(w) {
  const btn = w.findAll('button').find(b => b.text().includes('添加集群'))
  expect(btn, '「添加集群」按钮存在').toBeTruthy()
  await btn.trigger('click')
  await flushPromises()
}
const submitBtn = w => w.find('[data-testid="cluster-form-submit"]')

beforeEach(() => { createMock.mockClear(); notifyMock.mockClear() })

test('空表单提交:create 未被调用,内联错误可见', async () => {
  const w = mountView()
  await openAddModal(w)
  await submitBtn(w).trigger('click')
  await flushPromises()
  expect(createMock).not.toHaveBeenCalled()
  expect(w.find('[data-testid="cluster-form-error-name"]').exists()).toBe(true)
})

test('填齐后提交:create 收到完整 payload,notify success', async () => {
  const w = mountView()
  await openAddModal(w)
  await w.find('[data-testid="cluster-form-name"]').setValue('demo')
  await w.find('[data-testid="cluster-form-kubeconfig"]').setValue('apiVersion: v1')
  await submitBtn(w).trigger('click')
  await flushPromises()
  expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'demo', authMethod: 'kubeconfig', kubeconfig: 'apiVersion: v1', insecure: false }))
  expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/ClusterManagement.clusterform.test.js`
Expected: FAIL —— 找不到 `[data-testid="cluster-form-submit"]`(现实现是 modal #actions 里的普通按钮)。

- [ ] **Step 3: 重构 ClusterManagement.vue**

修改点(其余不动):

1. script 区:import 增加 `import ClusterForm from '@/components/common/ClusterForm.vue'`;`showAddModal` 旁加 `const adding = ref(false)`;`doAdd` 包 adding 态:

```js
async function doAdd() {
  adding.value = true
  try {
    await adminApi.clusters.create(addForm.value)
    notify('success', t('admin.clusters.added', { name: addForm.value.name }))
    showAddModal.value = false
    addForm.value = { name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false }
    load()
  } catch (e) { notify('error', e.message || t('admin.clusters.addFailed')) }
  finally { adding.value = false }
}
```

2. template 区:整个「添加集群 Modal」块(现 69-101 行)替换为:

```html
    <!-- 添加集群 Modal(表单抽至共享 ClusterForm) -->
    <Modal v-model="showAddModal" :title="$t('admin.clusters.addCluster')" width="max-w-xl">
      <ClusterForm :form="addForm" :submitting="adding" @submit="doAdd" @cancel="showAddModal = false" />
    </Modal>
```

(操作按钮移入 ClusterForm,故删除 `<template #actions>` 块。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/ClusterManagement.clusterform.test.js`
Expected: PASS(2 个测试)。

- [ ] **Step 5: Commit**

```bash
git add src/views/admin/ClusterManagement.vue src/views/__tests__/ClusterManagement.clusterform.test.js
git commit -m "refactor(admin): 集群管理 modal 改用共享 ClusterForm(补必填拦截)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: /add-cluster 路由 + AddCluster 独立页

**Files:**
- Modify: `src/router/index.js`(SelectCluster 路由块后加一条)
- Create: `src/views/AddCluster.vue`
- Test: `src/views/__tests__/AddCluster.test.js`
- Modify: `src/locales/zh.json`、`src/locales/en.json`(新顶层 `addCluster` 对象)

**Interfaces:**
- Consumes: Task 1 的 `ClusterForm`;`adminApi.clusters.create(payload) → { cluster: { id, name, apiServer, version } }`;`authStore.connectCluster(id) → { token, cluster: { apiServer, version } }`;`clusterStore.setConnectedCluster({ apiServer, version })`。
- Produces: 路由 `{ path: '/add-cluster', name: 'AddCluster' }`(Task 4 的入口 push 目标);meta `{ titleKey: 'addCluster.title', requiresCluster: false, requireAdmin: true }`。守卫零改动已验证:无 session 时 `resolveWhenSessionMissing` 对 `requiresCluster: false` 放行(`src/router/clusterGate.js:14`);无平台 token 时照常弹 Login。
- i18n 新键(顶层 `addCluster` 对象,插在两份 locale 的 `"selectCluster": {...}` 块之后,约 2153 行起):

```json
  "addCluster": {
    "title": "添加集群",
    "subtitle": "填写集群信息,验证通过后将自动连接并进入控制台",
    "back": "返回选择集群",
    "connecting": "正在连接集群…",
    "connectFailed": "连接集群失败",
    "connectFailedWarning": "集群已添加,但连接失败",
    "retryConnect": "重试连接"
  },
```

en 对应:

```json
  "addCluster": {
    "title": "Add Cluster",
    "subtitle": "Enter cluster details; it will connect automatically once verified",
    "back": "Back to cluster selection",
    "connecting": "Connecting to cluster…",
    "connectFailed": "Failed to connect to cluster",
    "connectFailedWarning": "Cluster added, but connection failed",
    "retryConnect": "Retry connection"
  },
```

- [ ] **Step 1: 写失败测试**

创建 `src/views/__tests__/AddCluster.test.js`:

```js
// AddCluster 独立页:非 admin 弹回 / create 失败内联错误 / 成功→connect→整页跳 /connect
// 失败→重试态。复用真 ClusterForm(集成校验拦截路径)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { pushMock, replaceMock } = vi.hoisted(() => ({ pushMock: vi.fn(), replaceMock: vi.fn() }))
const createMock = vi.fn()
const connectMock = vi.fn()
const setConnectedMock = vi.fn()
let _isAdmin = true

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  RouterLink: { template: '<a><slot/></a>' },
}))
vi.mock('@/api/client', () => ({
  adminApi: { clusters: { create: (...a) => createMock(...a) } },
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { username: 'admin', role: 'admin' },
    get isAdmin() { return _isAdmin },
    connectCluster: (...a) => connectMock(...a),
  }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ setConnectedCluster: setConnectedMock }),
}))

import AddCluster from '../AddCluster.vue'

function mountView() { return mount(AddCluster, { global: { plugins: [i18n] } }) }
async function fillAndSubmit(w) {
  await w.find('[data-testid="cluster-form-name"]').setValue('demo')
  await w.find('[data-testid="cluster-form-kubeconfig"]').setValue('apiVersion: v1')
  await w.find('[data-testid="cluster-form-submit"]').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  _isAdmin = true
  createMock.mockReset(); connectMock.mockReset(); setConnectedMock.mockReset()
  pushMock.mockClear(); replaceMock.mockClear()
  window.location.href = 'http://localhost/add-cluster' // 复位上个测试的整页跳转
})

test('非 admin:挂载即 replace 回 SelectCluster', async () => {
  _isAdmin = false
  mountView()
  await flushPromises()
  expect(replaceMock).toHaveBeenCalledWith({ name: 'SelectCluster' })
})

test('空表单提交被 ClusterForm 拦截:create 未调用', async () => {
  const w = mountView()
  await w.find('[data-testid="cluster-form-submit"]').trigger('click')
  await flushPromises()
  expect(createMock).not.toHaveBeenCalled()
})

test('create 失败:内联错误,表单保留,不 connect', async () => {
  createMock.mockRejectedValue(new Error('凭据无效'))
  const w = mountView()
  await fillAndSubmit(w)
  expect(w.find('[data-testid="add-cluster-error"]').text()).toContain('凭据无效')
  expect(w.find('[data-testid="cluster-form-name"]').exists()).toBe(true)
  expect(connectMock).not.toHaveBeenCalled()
})

test('create+connect 成功:setConnectedCluster(去尾斜杠)并整页跳 /cluster', async () => {
  createMock.mockResolvedValue({ cluster: { id: 'c1', name: 'demo', apiServer: 'https://x', version: 'v1.30' } })
  connectMock.mockResolvedValue({ token: 'k8s-t', cluster: { apiServer: 'https://x/', version: 'v1.30' } })
  const w = mountView()
  await fillAndSubmit(w)
  expect(connectMock).toHaveBeenCalledWith('c1')
  expect(setConnectedMock).toHaveBeenCalledWith({ apiServer: 'https://x', version: 'v1.30' })
  expect(window.location.pathname).toBe('/cluster')
})

test('create 成功但 connect 失败:重试卡片;点重试再 connect', async () => {
  createMock.mockResolvedValue({ cluster: { id: 'c1', name: 'demo', apiServer: 'https://x', version: 'v1.30' } })
  connectMock.mockRejectedValueOnce(new Error('网络抖动')).mockResolvedValue({ token: 'k8s-t', cluster: { apiServer: 'https://x', version: 'v1.30' } })
  const w = mountView()
  await fillAndSubmit(w)
  expect(w.find('[data-testid="add-cluster-connect-failed"]').exists()).toBe(true)
  expect(w.text()).toContain('网络抖动')

  await w.find('[data-testid="add-cluster-retry"]').trigger('click')
  await flushPromises()
  expect(connectMock).toHaveBeenCalledTimes(2)
  expect(window.location.pathname).toBe('/cluster')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/AddCluster.test.js`
Expected: FAIL —— `Cannot find module '../AddCluster.vue'`。

- [ ] **Step 3: 加路由**

`src/router/index.js`:在 `SelectCluster` 路由块(现 15-20 行)之后插入:

```js
  {
    // 添加集群独立页(admin):AppLayout 外全屏,创建→自动连接→进 Overview。
    // requiresCluster: false → 无 K8s session 时守卫放行(clusterGate);requireAdmin 由页面自查+服务端兜底。
    path: '/add-cluster',
    name: 'AddCluster',
    component: () => import('@/views/AddCluster.vue'),
    meta: { titleKey: 'addCluster.title', requiresCluster: false, requireAdmin: true }
  },
```

- [ ] **Step 4: 加 i18n 键**

按本任务 Interfaces 中的 JSON 块,在 `src/locales/zh.json` 与 `src/locales/en.json` 的 `"selectCluster": { ... }` 块结束的 `},` 之后插入 `"addCluster": { ... },`(注意前后逗号)。

- [ ] **Step 5: 实现 AddCluster.vue**

创建 `src/views/AddCluster.vue`:

```vue
<script setup>
// 添加集群独立页(AppLayout 外,与 Login/SelectCluster 同级):
// 创建(adminApi.clusters.create,服务端已探测凭据)→ 自动连接(connectCluster)
// → 整页跳 /cluster Overview(与 SelectCluster.connect 同路径,复用守卫水合)。
// create 成功但 connect 失败:集群已入库不回滚,给重试连接/返回选择页。
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useClusterStore } from '@/stores/cluster'
import ClusterForm from '@/components/common/ClusterForm.vue'

const router = useRouter()
const authStore = useAuthStore()
const clusterStore = useClusterStore()
const { t } = useI18n()

const form = ref({ name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false })
const submitting = ref(false)      // create 进行中(按钮 loading)
const phase = ref('form')          // form | connecting | connectFailed
const createError = ref('')
const connectError = ref('')
const createdId = ref('')

// 非 admin 手输 URL:守卫不查 requireAdmin,页面自查弹回;服务端 requireAdmin 兜底
onMounted(() => {
  if (!authStore.isAdmin) router.replace({ name: 'SelectCluster' })
})

async function onSubmit() {
  createError.value = ''
  submitting.value = true
  try {
    const res = await adminApi.clusters.create(form.value)
    createdId.value = res.cluster.id
    await connect()
  } catch (e) {
    createError.value = e?.message || t('admin.clusters.addFailed')
  } finally {
    submitting.value = false
  }
}

async function connect() {
  phase.value = 'connecting'
  connectError.value = ''
  try {
    const res = await authStore.connectCluster(createdId.value)
    clusterStore.setConnectedCluster({ apiServer: res.cluster.apiServer.replace(/\/$/, ''), version: res.cluster.version })
    window.location.href = '/cluster' // 整页跳转,走守卫水合(同 SelectCluster.connect)
  } catch (e) {
    connectError.value = e?.message || t('addCluster.connectFailed')
    phase.value = 'connectFailed'
  }
}

function back() { router.push({ name: 'SelectCluster' }) }
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-surface p-xl">
    <div class="w-full max-w-xl">
      <div class="text-center mb-xl">
        <span class="material-symbols-outlined text-5xl text-primary">hub</span>
        <h1 class="text-headline-lg font-bold text-on-surface mt-sm">{{ t('addCluster.title') }}</h1>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('addCluster.subtitle') }}</p>
      </div>

      <p v-if="createError" data-testid="add-cluster-error" class="text-body-sm text-error bg-error-container/10 rounded-lg px-md py-sm flex items-center gap-sm mb-md">
        <span class="material-symbols-outlined text-base">error</span>{{ createError }}
      </p>

      <div v-if="phase === 'connecting'" data-testid="add-cluster-connecting" class="text-center py-xl text-on-surface-variant">
        <span class="material-symbols-outlined animate-spin inline-block text-3xl">progress_activity</span>
        <p class="text-body-sm mt-sm">{{ t('addCluster.connecting') }}</p>
      </div>

      <div v-else-if="phase === 'connectFailed'" data-testid="add-cluster-connect-failed" class="rounded-xl border border-warning/40 bg-surface-container-low p-lg text-center">
        <span class="material-symbols-outlined text-3xl text-on-surface-variant">warning</span>
        <p class="text-body-md font-semibold text-on-surface mt-sm">{{ t('addCluster.connectFailedWarning') }}</p>
        <p v-if="connectError" class="font-mono text-xs text-on-surface-variant mt-xs">{{ connectError }}</p>
        <div class="flex justify-center gap-sm mt-md">
          <button data-testid="add-cluster-retry" @click="connect" class="flex items-center gap-xs px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
            <span class="material-symbols-outlined text-sm">refresh</span> {{ t('addCluster.retryConnect') }}
          </button>
          <button @click="back" class="px-lg py-sm border border-outline-variant rounded-lg">{{ t('addCluster.back') }}</button>
        </div>
      </div>

      <ClusterForm v-else :form="form" :submitting="submitting" @submit="onSubmit" @cancel="back" />
    </div>
  </div>
</template>
```

注意:`text-warning` 若项目无该 token,用 `text-on-surface-variant` 替代(实现时以现有 token 为准,勿发明新 class)。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/AddCluster.test.js`
Expected: PASS(5 个测试)。

- [ ] **Step 7: Commit**

```bash
git add src/router/index.js src/views/AddCluster.vue src/views/__tests__/AddCluster.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(onboarding): /add-cluster 独立添加页(创建→自动连接→进 Overview)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: SelectCluster 入口改指 /add-cluster + admin 常驻入口

**Files:**
- Modify: `src/views/SelectCluster.vue`
- Test: `src/views/__tests__/SelectCluster.entries.test.js`(新)

**Interfaces:**
- Consumes: Task 3 的路由 `name: 'AddCluster'` / path `/add-cluster`。
- Produces: 无(叶子改动)。现有 data-testid 约定新增 `select-cluster-add`(空状态主按钮)与 `select-cluster-add-persistent`(底部常驻入口,admin 可见)。

- [ ] **Step 1: 写失败测试**

创建 `src/views/__tests__/SelectCluster.entries.test.js`:

```js
// SelectCluster 添加集群入口:空状态主按钮与底部常驻入口(仅 admin)都指 /add-cluster。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }))
const myClustersMock = vi.fn()
let _isAdmin = true

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
  RouterLink: { template: '<a><slot/></a>' },
}))
vi.mock('@/api/client', () => ({
  authApi: { myClusters: (...a) => myClustersMock(...a) },
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { username: 'admin', role: 'admin' },
    logout: vi.fn(),
    get isAdmin() { return _isAdmin },
  }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ setConnectedCluster: vi.fn() }),
}))

import SelectCluster from '../SelectCluster.vue'

function mountView() { return mount(SelectCluster, { global: { plugins: [i18n] } }) }

beforeEach(() => {
  _isAdmin = true
  pushMock.mockClear()
  myClustersMock.mockReset()
})

test('admin 有集群:底部常驻「添加集群」入口存在,点击 push /add-cluster', async () => {
  myClustersMock.mockResolvedValue({ clusters: [{ id: 'c1', name: 'demo', apiServer: 'https://x' }] })
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="select-cluster-add-persistent"]').trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/add-cluster')
})

test('admin 无集群:空状态主按钮 push /add-cluster', async () => {
  myClustersMock.mockResolvedValue({ clusters: [] })
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="select-cluster-add"]').trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/add-cluster')
})

test('非 admin:无添加入口,显示联系管理员提示', async () => {
  _isAdmin = false
  myClustersMock.mockResolvedValue({ clusters: [] })
  const w = mountView()
  await flushPromises()
  expect(w.find('[data-testid="select-cluster-add"]').exists()).toBe(false)
  expect(w.find('[data-testid="select-cluster-add-persistent"]').exists()).toBe(false)
  expect(w.text()).toContain('请联系管理员')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/SelectCluster.entries.test.js`
Expected: FAIL —— `select-cluster-add` 元素不存在(现按钮无 data-testid 且 push 到 `/admin/clusters`)。

- [ ] **Step 3: 改 SelectCluster.vue**

1. 空状态主按钮(现 93-96 行)加 data-testid 并改目标:

```html
        <button v-if="authStore.isAdmin" data-testid="select-cluster-add" @click="router.push('/add-cluster')"
          class="mt-md inline-flex items-center gap-xs px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
          <span class="material-symbols-outlined text-base">add</span> {{ t('selectCluster.addCluster') }}
        </button>
```

2. 底部操作行(现 100-107 行)在「集群管理」链接前插入 admin 常驻入口:

```html
        <button v-if="authStore.isAdmin" data-testid="select-cluster-add-persistent" @click="router.push('/add-cluster')" class="text-body-sm text-on-surface-variant hover:text-primary flex items-center gap-xs">
          <span class="material-symbols-outlined text-sm">add</span> {{ t('selectCluster.addCluster') }}
        </button>
```

(常驻入口文案复用 `selectCluster.addCluster`;置于底部操作行与「集群管理」并列,视觉一致——比 spec 里「标题行右侧」更贴合现有居中式头部布局,spec 该细节据此微调。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/SelectCluster.entries.test.js`
Expected: PASS(3 个测试)。

- [ ] **Step 5: Commit**

```bash
git add src/views/SelectCluster.vue src/views/__tests__/SelectCluster.entries.test.js
git commit -m "feat(select-cluster): 添加集群入口改指 /add-cluster 并增 admin 常驻入口

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 全量验收

**Files:**
- 无新增;全部为验证步骤。

**Interfaces:**
- Consumes: Task 1-4 的全部产出。

- [ ] **Step 1: 类型/语法基线**

Run: `npm run typecheck`
Expected: 无输出错误(退出码 0)。

- [ ] **Step 2: i18n 门禁**

Run: `npm run i18n:check`
Expected: 残存中文 0、键对齐、引用键缺失 0(zh/en 各加 12 键:admin.clusters 5 + addCluster 7)。

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: server 零依赖运行器 + node --test 全绿;vitest 含新增 3 个测试文件(ClusterForm 7 + ClusterManagement 2 + AddCluster 5 + SelectCluster 3 = 17 个新用例)+ `_allViewsMount.test.js` 自动把 `AddCluster.vue` 纳入冒烟(glob 自动发现,无需登记)。

- [ ] **Step 4: 构建(.vue 语法由 build 覆盖)**

Run: `npm run build`
Expected: 构建成功,无 Vue 模板编译错误。

- [ ] **Step 5: 手测路径(有环境时)**

1. 清空 server 数据库(或新环境首装)→ admin 登录 → `/select-cluster` 空状态 → 「添加集群」→ 独立页
2. 空表单提交 → 内联红字,无请求
3. 填 name+kubeconfig → 添加并验证 → 「正在连接集群…」→ 自动落 `/cluster` Overview 有数据
4. 断网/错凭据:分别确认 create 失败内联错误、connect 失败重试卡片
5. 已有集群时:选择页底部「添加集群」常驻入口可用;`/admin/clusters` modal 行为照旧

- [ ] **Step 6: 收尾提交(如验收有修补)**

```bash
git status   # 确认无未预期改动
# 有修补则 git add -A && git commit -m "fix(onboarding): 验收修补

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review 记录

- **Spec 覆盖:** 路由+守卫(Task 3)、AddCluster 页+三态(Task 3)、ClusterForm 抽取+校验(Task 1)、ClusterManagement 改造(Task 2)、SelectCluster 双入口(Task 4)、i18n(Task 1/3)、测试(Task 1-4)+全量验收(Task 5)——spec 六节全覆盖;服务端/守卫/clusterGate 零改动符合「不做的事」。
- **占位符扫描:** 无 TBD/TODO;所有代码步骤含完整代码。
- **类型/命名一致性:** `data-testid` 命名在 Task 1(定义)与 Task 2/3(消费)一致;`connectCluster(createdId.value)` 与 auth store 签名一致;`adminApi.clusters.create` 返回形状与 server/routes/admin.mjs:125 一致。
- **已知偏差(已注明):** 常驻入口放底部操作行(spec 写「标题行右侧」),理由见 Task 4 Step 3。
