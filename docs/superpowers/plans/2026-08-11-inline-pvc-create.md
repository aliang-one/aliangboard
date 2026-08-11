# 工作台 PVC 内联快速创建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在创建负载向导的 PVC 卷挂载下拉旁加「新建」按钮,弹窗快速创建 PVC,创建确认后自动把该卷的 PVC 选择切换到新建的 PVC。

**Architecture:** 新增可复用 `CreatePvcDialog.vue`(common),由 `VolumeMountCard.vue` 自包含持有与触发;创建成功后 `emit('created', name)`,卡片写回 `entry.pvcName` 并用本地 `createdPvcName` 把新名并入下拉选项,使自动选中即时生效。为拿到「创建是否成功」的信号,给 `makeCrud.add` 加一行 `return r`(让 `store.addPVC` 返回 `remoteCreate` 的 `{ok}`)。不动 DeployApp / NsStorage。

**Tech Stack:** Vue 3(`<script setup>` + `defineModel`)+ Pinia(`useClusterStore`)+ `@tanstack/vue-query`(`useResourceList`)+ vue-i18n。组件测用 vitest + @vue/test-utils + happy-dom;基线 `node --check` / `i18n:check` / `build`。

## Global Constraints

- **零新增依赖**(CLAUDE.md):不引任何新运行时/工具链依赖。
- **i18n 门禁**:`npm run i18n:check` 必须绿,zh/en 键一一对应;每个新增键同时加中英文。
- **ESC/遮罩关闭**:弹窗复用 `Modal`(已内置 `useEscClose`)。
- **`store.addPVC` 行为**:走 `makeCrud.add` → `remoteCreate`(内部 try/catch,**不抛**、自带 toast)→ `invalidateResource('pvcs')`(已失效 PVC 查询)。故弹窗**无需**自己 `invalidateQueries`、也**无需** `useQueryClient`;只需据返回的 `{ok}` 决定关窗/选中还是留窗报错。
- **`defineModel` 嵌套写入即生效**:`VolumeMountCard` 用 `const entry = defineModel({ required: true })`;`entry.value.pvcName = x` 直接 mutate 父级 reactive 对象(卡片内既有此模式,如 `entry.value.server = ''`),**无需**手动 `emit('update:modelValue')`。

---

### Task 1: `makeCrud.add` 返回 `{ok}`(让 `store.addPVC` 可被判成败)

**Files:**
- Modify: `src/stores/cluster.js:345-349`(`makeCrud` 内的 `add` 函数)

**Interfaces:**
- Consumes: 无新增。
- Produces: 所有 `makeCrud` 产物的 `add`(含 `store.addPVC`)在创建后返回 `remoteCreate` 的 `{ ok: Boolean }`。失败时 `remoteCreate` 已 `notify('error', ...)`,调用方可据 `r.ok` 决定后续。既有调用方(NsStorage `handleCreatePVC` 等)忽略返回值,**行为不变**。Task 3 的 `CreatePvcDialog` 依赖 `store.addPVC()` → `{ ok }`。

- [ ] **Step 1: 改 `add` 函数,return `r`**

把 `src/stores/cluster.js` 中(约 345-349 行):
```javascript
    async function add(item) {
      await remoteCreate(yamlOf(item), `${kind}/${item.name}`)
      if (sideEffects?.onAdd) sideEffects.onAdd(item)
      invalidateResource(plural)
    }
```
改为:
```javascript
    async function add(item) {
      const r = await remoteCreate(yamlOf(item), `${kind}/${item.name}`)
      if (sideEffects?.onAdd) sideEffects.onAdd(item)
      invalidateResource(plural)
      return r // { ok } from remoteCreate;失败时已 toast,调用方可据 r.ok 决定后续(见 CreatePvcDialog)
    }
```

- [ ] **Step 2: 语法基线**

Run: `npm run typecheck`
Expected: 通过(`node --check` 全 .js/.mjs 无报错)。

- [ ] **Step 3: 提交**

```bash
git add src/stores/cluster.js
git commit -m "refactor(store): makeCrud.add 返回 {ok} 供调用方判成败"
```

> 该 1 行 enabler 的行为契约由 Task 3 的 `CreatePvcDialog.test.js`(断言 `addPVC` 返回值驱动关窗/选中)覆盖,本任务不单独写测试。

---

### Task 2: i18n 键(zh + en)

**Files:**
- Modify: `src/locales/zh.json`(在 `component` 对象内,与 `volumeMount` 同级加 `createPvc` 对象;并在 `component.volumeMount` 对象内加 `newPvc` 键)
- Modify: `src/locales/en.json`(同结构)

**Interfaces:**
- Produces:`component.createPvc.{title,hint,nameRequired,creating,createFailed}`、`component.volumeMount.newPvc`,供 Task 3 / Task 4 使用。其余字段复用既有 `ns.storage.{pvcName,capacity,accessMode,storageClass,defaultOption}`、`common.{create,cancel}`。

- [ ] **Step 1: zh.json —— `component.volumeMount` 内加 `newPvc`**

在 `src/locales/zh.json` 的 `"volumeMount": { ... }` 块内(起于第 81 行)任一现有键后追加一行:
```json
      "newPvc": "新建",
```
(注意逗号:加在非末尾键后须带逗号;若加在末尾键后,前一键补逗号。)

- [ ] **Step 2: zh.json —— `component` 内加 `createPvc` 对象**

在 `component` 对象内、`"volumeMount": { ... }` 块**之外**(与其同级)追加:
```json
    "createPvc": {
      "title": "新建 PVC",
      "hint": "将在命名空间 {ns} 下创建",
      "nameRequired": "请输入名称",
      "creating": "创建中…",
      "createFailed": "创建失败,请查看提示"
    },
```

- [ ] **Step 3: en.json —— 同结构**

在 `src/locales/en.json` 的 `component.volumeMount` 内加:
```json
      "newPvc": "New",
```
在 `component` 内(与 `volumeMount` 同级)加:
```json
    "createPvc": {
      "title": "New PVC",
      "hint": "Will be created in namespace {ns}",
      "nameRequired": "Name is required",
      "creating": "Creating…",
      "createFailed": "Failed to create — see notification"
    },
```

- [ ] **Step 4: i18n 门禁**

Run: `npm run i18n:check`
Expected: 绿(zh/en 键对齐、无残留中文、无缺失引用键)。

- [ ] **Step 5: 提交**

```bash
git add src/locales/zh.json src/locales/en.json
git commit -m "i18n: 新增 createPvc.* 与 volumeMount.newPvc"
```

---

### Task 3: `CreatePvcDialog.vue` + 测试(TDD)

**Files:**
- Create: `src/components/common/CreatePvcDialog.vue`
- Test: `src/components/common/__tests__/CreatePvcDialog.test.js`

**Interfaces:**
- Consumes: `Modal`(`@/components/common/Modal.vue`,props `modelValue/title/width`,emit `update:modelValue`,slot `default`+`#actions`);`useClusterStore`(`store.addPVC(item)` → `{ok}`(Task 1)、`store.fetchStorageClasses()`、`store.currentCluster`);`useResourceList`(`@/composables/useK8sQuery`);`useI18n`。
- Produces: 组件 props `{ modelValue: Boolean, namespace: String }`,emit `update:modelValue`、`created(name: String)`。Task 4 的 `VolumeMountCard` 依赖此接口。

- [ ] **Step 1: 写失败测试 `src/components/common/__tests__/CreatePvcDialog.test.js`**

```javascript
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const addPVC = vi.fn(async () => ({ ok: true }))

// 隔离 Vue Query 与 store:VolumeMountCard/CreatePvcDialog 都在 setup 调 useResourceList + useClusterStore。
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    addPVC,
    fetchStorageClasses: async () => [],
    currentCluster: 'c1',
  }),
}))

import CreatePvcDialog from '@/components/common/CreatePvcDialog.vue'

// Modal 会 Teleport 到 body,交互测试里用不 Teleport 的桩替换,便于 wrapper.find。
const ModalStub = {
  props: { modelValue: Boolean, title: String, width: String },
  emits: ['update:modelValue', 'confirm', 'cancel'],
  template: '<div v-if="modelValue"><slot /><slot name="actions" /></div>',
}

function mountDlg(props = {}) {
  return mount(CreatePvcDialog, {
    props: { modelValue: true, namespace: 'default', ...props },
    global: { plugins: [createPinia(), i18n], stubs: { Modal: ModalStub } },
  })
}

test('CreatePvcDialog: 填 name 创建成功 → emit created(name) + 关闭,且 addPVC 收到 namespace', async () => {
  addPVC.mockResolvedValue({ ok: true })
  const wrapper = mountDlg()
  const nameInput = wrapper.findAll('input')[0]
  await nameInput.setValue('my-pvc')
  await wrapper.find('[data-testid="pvc-create"]').trigger('click')
  await Promise.resolve()
  await Promise.resolve()
  expect(addPVC).toHaveBeenCalledWith(expect.objectContaining({ name: 'my-pvc', namespace: 'default' }))
  expect(wrapper.emitted('created')).toEqual([['my-pvc']])
  expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  wrapper.unmount()
})

test('CreatePvcDialog: 创建失败(ok:false) → 显示错误、不 emit created、不关闭', async () => {
  addPVC.mockResolvedValue({ ok: false })
  const wrapper = mountDlg()
  await wrapper.findAll('input')[0].setValue('bad')
  await wrapper.find('[data-testid="pvc-create"]').trigger('click')
  await Promise.resolve()
  await Promise.resolve()
  expect(wrapper.emitted('created')).toBeUndefined()
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  expect(wrapper.text()).toContain(i18n.global.t('component.createPvc.createFailed'))
  wrapper.unmount()
})

test('CreatePvcDialog: name 为空 → 创建按钮 disabled', () => {
  const wrapper = mountDlg()
  const btn = wrapper.find('[data-testid="pvc-create"]')
  expect(btn.attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/components/common/__tests__/CreatePvcDialog.test.js`
Expected: FAIL(模块 `CreatePvcDialog.vue` 不存在)。

- [ ] **Step 3: 实现 `src/components/common/CreatePvcDialog.vue`**

```vue
<script setup>
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  namespace: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'created'])

const { t } = useI18n()
const store = useClusterStore()

// StorageClass 列表(集群级):弹窗自取,组件自包含、可复用,不依赖父组件喂入。
const cid = computed(() => store.currentCluster || 'cluster')
const scQ = useResourceList({ key: ['cluster', cid.value, 'storageclasses'], fetcher: () => store.fetchStorageClasses(), options: { refetchInterval: 30000 } })
const allSCs = computed(() => scQ.data.value || [])

const form = ref({ name: '', capacity: '10Gi', accessModes: 'RWO', storageClass: '' })
const error = ref('')
const applying = ref(false)

// 打开时重置表单 + 清错(默认值与 NsStorage 创建表单一致)
watch(() => props.modelValue, v => {
  if (v) {
    form.value = { name: '', capacity: '10Gi', accessModes: 'RWO', storageClass: '' }
    error.value = ''
    applying.value = false
  }
})

function close() { emit('update:modelValue', false) }

async function create() {
  const name = form.value.name.trim()
  if (!name) { error.value = t('component.createPvc.nameRequired'); return }
  error.value = ''
  applying.value = true
  try {
    // store.addPVC 内部:remoteCreate(server-side apply,自带 toast)+ invalidateResource('pvcs')。
    // 故此处不再单独 invalidateQueries;据返回 {ok} 决定关窗/选中还是留窗。
    const r = await store.addPVC({
      name,
      namespace: props.namespace,
      status: 'Pending',
      capacity: form.value.capacity || '10Gi',
      accessModes: form.value.accessModes,
      storageClass: form.value.storageClass || allSCs.value.find(s => s.default)?.name || 'standard',
      volume: '',
      age: 'Just now',
    })
    if (r && r.ok) {
      emit('created', name)
      close()
    } else {
      // 失败:remoteCreate 已 toast 详细原因;此处仅留通用提示并保留弹窗 + 用户输入。
      error.value = t('component.createPvc.createFailed')
    }
  } catch (e) {
    // 防御:addPVC 内部已 catch,理论不抛。
    error.value = t('component.createPvc.createFailed')
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <Modal :model-value="modelValue" :title="t('component.createPvc.title')" width="max-w-lg"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="flex flex-col gap-md">
      <p class="text-body-sm text-on-surface-variant">{{ t('component.createPvc.hint', { ns: namespace || '—' }) }}</p>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.pvcName') }} *</label>
        <input v-model="form.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary"
          :placeholder="t('ns.storage.pvcName')" />
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.capacity') }} *</label>
          <input v-model="form.capacity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="10Gi" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.accessMode') }}</label>
          <select v-model="form.accessModes" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option value="RWO">ReadWriteOnce</option>
            <option value="RWM">ReadWriteMany</option>
            <option value="ROM">ReadOnlyMany</option>
          </select>
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.storageClass') }}</label>
        <select v-model="form.storageClass" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
          <option value="">{{ t('ns.storage.defaultOption') }}</option>
          <option v-for="sc in allSCs" :key="sc.name" :value="sc.name">{{ sc.name }}{{ sc.default ? ' (default)' : '' }}</option>
        </select>
      </div>
      <p v-if="error" class="text-body-sm text-error">{{ error }}</p>
    </div>
    <template #actions>
      <button @click="close" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button data-testid="pvc-create" @click="create" :disabled="!form.name.trim() || applying"
        class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">
        <span v-if="applying" class="material-symbols-outlined animate-spin text-lg">progress_activity</span>
        {{ applying ? t('component.createPvc.creating') : t('common.create') }}
      </button>
    </template>
  </Modal>
</template>
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/components/common/__tests__/CreatePvcDialog.test.js`
Expected: PASS(3 个用例)。

- [ ] **Step 5: 语法基线 + 提交**

Run: `npm run typecheck`
```bash
git add src/components/common/CreatePvcDialog.vue src/components/common/__tests__/CreatePvcDialog.test.js
git commit -m "feat(pvc): add reusable CreatePvcDialog (quick create + emit created(name))"
```

---

### Task 4: `VolumeMountCard.vue` 接线 + 测试

**Files:**
- Modify: `src/components/common/VolumeMountCard.vue`(import + 2 ref + computed + onPvcCreated + PVC select 改 options + 加「新建」按钮 + 挂弹窗)
- Test: `src/components/common/__tests__/VolumeMountCard.test.js`(新建冒烟)

**Interfaces:**
- Consumes: `CreatePvcDialog`(Task 3,props `modelValue/namespace`,emit `update:modelValue/created`);既有 `defineModel` entry、props `pvcs`/`namespace`。
- Produces: PVC 卷类型下拉旁出现「新建」按钮;`created(name)` 后 `entry.pvcName = name` 且下拉 options 含该名。

- [ ] **Step 1: 写失败测试 `src/components/common/__tests__/VolumeMountCard.test.js`**

```javascript
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, reactive, defineComponent } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ fetchConfigMaps: async () => [], fetchSecrets: async () => [], currentCluster: 'c1' }),
}))

import VolumeMountCard from '@/components/common/VolumeMountCard.vue'

// 用会 emit 'created' 的桩替代真实 CreatePvcDialog,隔离其内部逻辑(Task 3 已单独覆盖)。
const CreatePvcStub = defineComponent({
  name: 'CreatePvcDialog',
  emits: ['created', 'update:modelValue'],
  props: { modelValue: Boolean, namespace: String },
  template: '<button data-testid="stub-emit-created" @click="$emit(\'created\', \'newpvc\')">stub</button>',
})

function makeEntry() {
  return reactive({ name: 'vol-1', target: 'main', type: 'pvc', mountPath: '/data', subPath: '', readOnly: false, pvcName: '', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] })
}

test('VolumeMountCard: PVC 下拉含传入 pvcs;点新建→stub emit created→entry.pvcName 与 options 同步', async () => {
  const entry = makeEntry()
  const wrapper = mount(VolumeMountCard, {
    props: { modelValue: entry, pvcs: ['a', 'b'], namespace: 'default' },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })

  // 初始:PVC 下拉含 a/b,不含 newpvc
  const select = () => wrapper.find('select')
  expect(select().text()).toContain('a')
  expect(select().text()).toContain('b')
  expect(select().text()).not.toContain('newpvc')

  // 点「新建」打开弹窗(stub 渲染)
  const newBtn = wrapper.findAll('button').find(b => b.attributes('title') === i18n.global.t('component.volumeMount.newPvc'))
  expect(newBtn).toBeTruthy()
  await newBtn.trigger('click')

  // stub 发 created('newpvc') → onPvcCreated
  await wrapper.find('[data-testid="stub-emit-created"]').trigger('click')

  // 自动选中(defineModel entry 直接 mutate 同一 reactive 对象)
  expect(entry.pvcName).toBe('newpvc')
  // 下拉 options 并入新名(createdPvcName ref 触发 pvcOptions 重算)
  expect(select().text()).toContain('newpvc')
  wrapper.unmount()
})

test('VolumeMountCard: namespace 为空时「新建」按钮 disabled', () => {
  const entry = makeEntry()
  const wrapper = mount(VolumeMountCard, {
    props: { modelValue: entry, pvcs: [], namespace: '' },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const newBtn = wrapper.findAll('button').find(b => b.attributes('title') === i18n.global.t('component.volumeMount.newPvc'))
  expect(newBtn.attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/components/common/__tests__/VolumeMountCard.test.js`
Expected: FAIL(找不到「新建」按钮 / `pvcOptions` 不存在)。

- [ ] **Step 3: 改 `src/components/common/VolumeMountCard.vue` —— script**

第 2 行 import 补 `ref`:
```javascript
import { computed, ref } from 'vue'
```
在 import 区(`useResourceList` import 之后)加:
```javascript
import CreatePvcDialog from '@/components/common/CreatePvcDialog.vue'
```
在现有 `_secQ = ...` 那行(约第 24 行)之后、`const TYPES = [` 之前,加状态与处理:
```javascript

// PVC 内联快速创建:下拉旁「新建」开 CreatePvcDialog;创建后写回 entry.pvcName 并把新名并入 options,
// 使自动选中即时生效(不依赖父列表刷新时机、不受 namespace 过滤差异影响)。
const showCreatePvc = ref(false)
const createdPvcName = ref('')
const pvcOptions = computed(() => [...new Set([...props.pvcs, createdPvcName.value].filter(Boolean))])
function onPvcCreated(name) {
  createdPvcName.value = name
  entry.value.pvcName = name
}
```

- [ ] **Step 4: 改 `src/components/common/VolumeMountCard.vue` —— template PVC select + 按钮**

把现有 PVC `<select>`(约第 83-86 行):
```vue
        <select v-if="entry.type === 'pvc'" v-model="entry.pvcName" :class="fld">
          <option value="">{{ t('component.volumeMount.selectPvc') }}</option>
          <option v-for="p in pvcs" :key="p" :value="p">{{ p }}</option>
        </select>
```
替换为(select 包进 flex 行 + 旁边「新建」按钮 + options 改 `pvcOptions`):
```vue
        <div v-if="entry.type === 'pvc'" class="flex gap-xs">
          <select v-model="entry.pvcName" :class="fld" class="flex-1">
            <option value="">{{ t('component.volumeMount.selectPvc') }}</option>
            <option v-for="p in pvcOptions" :key="p" :value="p">{{ p }}</option>
          </select>
          <button type="button" :disabled="!namespace" @click="showCreatePvc = true"
            :title="t('component.volumeMount.newPvc')"
            class="shrink-0 px-sm rounded-md border border-outline-variant text-on-surface-variant hover:bg-surface-container-high hover:text-primary disabled:opacity-40 transition-colors">
            <span class="material-symbols-outlined text-sm">add</span>
          </button>
          <CreatePvcDialog v-model="showCreatePvc" :namespace="namespace" @created="onPvcCreated" />
        </div>
```
> `<div v-if="entry.type === 'pvc'">` 后面紧跟的 `<input v-else-if="entry.type === 'hostPath'">`(及其后的 `v-else-if`/`v-else` 链)无需改动 —— Vue 的 `v-else-if` 按相邻兄弟元素链式判断,与标签是 `<div>` 还是 `<select>` 无关。

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run src/components/common/__tests__/VolumeMountCard.test.js`
Expected: PASS(2 个用例)。

- [ ] **Step 6: 语法 + 全量单测**

Run: `npm run typecheck && npm run test:unit`
Expected: 全通过(含 Task 3 的 CreatePvcDialog 用例)。

- [ ] **Step 7: 提交**

```bash
git add src/components/common/VolumeMountCard.vue src/components/common/__tests__/VolumeMountCard.test.js
git commit -m "feat(pvc): VolumeMountCard 下拉旁加「新建」→ CreatePvcDialog,创建后自动选中"
```

---

## 全量回归(所有任务完成后)

- [ ] `npm run typecheck`(`node --check` 全 .js/.mjs)
- [ ] `npm run i18n:check`(zh/en 键对齐、无残留中文、无缺失引用键)
- [ ] `npm run test:unit`(CreatePvcDialog + VolumeMountCard + 既有 vitest 全过)
- [ ] `npm run build`(.vue 编译通过)
- [ ] 手测(需连真实集群):
  - 工作台创建负载 → 卷挂载步骤 → 加卷、类型选 PVC → 下拉旁点「新建」→ 填 name/size/accessMode/SC → 创建;
  - 创建成功:toast 成功 + 下拉**自动切到新 PVC**;YAML 预览该卷 `persistentVolumeClaim.claimName` = 新 PVC 名;
  - 创建失败(如重名 / 无权限):toast 报错原因 + 弹窗**保留不关**、输入仍在、可改后重试;
  - namespace 为空时「新建」按钮置灰;
  - NsStorage 页创建 PVC 的原功能不受影响(回归)。
