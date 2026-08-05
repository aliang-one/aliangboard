# 子项目 A：PV/StorageClass 暴露 + 可变字段结构化编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 PV/StorageClass 在集群级侧边栏暴露，并给两个详情页加结构化编辑（仅 K8s 可变字段：reclaimPolicy / default / labels / annotations，merge-patch 落库）+ 删除按钮。

**Architecture:** 抽无依赖纯函数 `buildPVPatch`/`buildStorageClassPatch`/`diffMap`（构造 merge-patch body，labels/annotations 删除=置 null）并单测；store 的 `mapPV`/`mapStorageClass` 补 labels/annotations、`updatePV`/`updateStorageClass` 改远端 merge-patch 复用纯函数；`PVDetail`/`StorageClassDetail` 加编辑 Modal + 删除按钮；`SideNavBar` 集群级导航加「存储」入口。

**Tech Stack:** Vue 3 `<script setup>`、Pinia、Vite、原生 fetch（merge-patch `application/merge-patch+json`）、零依赖 node 测试运行器（`scripts/test.mjs`）。

## Global Constraints

- **编辑走手术式 merge-patch**（只 patch 改动字段），**不走** `generateYAML` 全量 apply —— `mapPV` 有损（缺 volume source），全量 apply 会破坏 PV。
- 只编辑 K8s 可变字段：PV 的 `reclaimPolicy` + labels/annotations；SC 的 `is-default` 注解 + labels/annotations。不可变字段不碰。
- labels/annotations **删除 = merge-patch 该键 `null`**（`null` 必须显式出现在 PATCH body）。
- SC 的 `is-default` 注解由「default 开关」单独控制；annotations 编辑器与 `buildStorageClassPatch` 都**排除** `storageclass.kubernetes.io/is-default-class`（与 beta 键），避免双控件冲突。
- **禁止新增外部依赖**；纯函数测试追加 `scripts/test.mjs`（零依赖约定）。
- 不做 PV 创建表单的 volume source；不重构 Ingress 的 labels 编辑器为公共组件（内联复用样式）。

---

## File Structure

**新增**
- `src/composables/useStoragePatch.js` — `buildPVPatch` / `buildStorageClassPatch` / `diffMap` 纯函数。

**修改**
- `src/stores/cluster.js` — `mapPV`/`mapStorageClass` 加 labels/annotations；`updatePV`/`updateStorageClass` 改远端 merge-patch；顶部 import 纯函数。
- `src/views/PVDetail.vue` — header 编辑/删除按钮 + 编辑 Modal（reclaimPolicy + labels/annotations 编辑器）+ 删除确认。
- `src/views/StorageClassDetail.vue` — header 编辑/删除按钮 + 编辑 Modal（default + labels/annotations 编辑器，过滤 is-default）+ 删除确认。
- `src/components/layout/SideNavBar.vue` — `clusterPrimaryNav` 加「存储」→ `/storage`。
- `scripts/test.mjs` — 追加纯函数契约测试。

---

### Task 1: 纯函数 `diffMap`/`buildPVPatch`/`buildStorageClassPatch` + 单测（TDD）

**Files:**
- Create: `src/composables/useStoragePatch.js`
- Test: `scripts/test.mjs`

**Interfaces:**
- Produces：
  - `diffMap(original={}=, desired={}) => Object` — desired 相对 original 的 diff：新增/改值 `{k:v}`，删除 `{k:null}`。
  - `buildPVPatch(original, { reclaimPolicy, labels, annotations }) => patch | null` — `{ spec?:{ persistentVolumeReclaimPolicy }, metadata?:{ labels?, annotations? } }`；无改动返回 `null`。
  - `buildStorageClassPatch(original, { isDefault, labels, annotations }) => patch | null` — `{ metadata?:{ annotations?, labels? } }`（annotations 含 is-default 键当 default 切换；user annotations diff 排除 is-default 键）；无改动 `null`。
- 从 `../src/composables/useStoragePatch.js` import。

- [ ] **Step 1: 写失败测试**

在 `scripts/test.mjs` 的"汇总"段（`const failed = ...` 之前）追加：

```js
// --- PV/StorageClass 编辑 merge-patch 构造（手术式：labels/annotations 删除=null）---
import { diffMap, buildPVPatch, buildStorageClassPatch } from '../src/composables/useStoragePatch.js'
test('diffMap：新增/改值/删除(null)/空', () => {
  assert.deepEqual(diffMap({ a: '1', b: '2' }, { a: '1', b: '9', c: '3' }), { b: '9', c: '3' })
  assert.deepEqual(diffMap({ a: '1' }, {}), { a: null })
  assert.deepEqual(diffMap({ a: '1' }, { a: '1' }), {})
  assert.deepEqual(diffMap({}, { a: '1' }), { a: '1' })
})
test('buildPVPatch：reclaimPolicy + labels/annotations diff；无改动→null', () => {
  const original = { reclaimPolicy: 'Retain', labels: { app: 'x' }, annotations: { note: 'old' } }
  const p1 = buildPVPatch(original, { reclaimPolicy: 'Delete', labels: { app: 'x', tier: 'db' }, annotations: {} })
  assert.equal(p1.spec.persistentVolumeReclaimPolicy, 'Delete')
  assert.deepEqual(p1.metadata.labels, { tier: 'db' })
  assert.deepEqual(p1.metadata.annotations, { note: null })
  // 无改动
  assert.equal(buildPVPatch(original, { reclaimPolicy: 'Retain', labels: { app: 'x' }, annotations: { note: 'old' } }), null)
  // 只传 reclaimPolicy 且不变 → null
  assert.equal(buildPVPatch(original, { reclaimPolicy: 'Retain' }), null)
  // 只删 label
  const p3 = buildPVPatch(original, { labels: {} })
  assert.deepEqual(p3.metadata.labels, { app: null })
  assert.equal(p3.spec, undefined)
})
test('buildStorageClassPatch：default 注解 + labels/annotations（排除 is-default 键）', () => {
  const original = { default: false, labels: { a: '1' }, annotations: { 'storageclass.kubernetes.io/is-default-class': 'false', note: 'x' } }
  // 启用 default + 改普通 annotation
  const p1 = buildStorageClassPatch(original, { isDefault: true, annotations: { note: 'y' } })
  assert.equal(p1.metadata.annotations['storageclass.kubernetes.io/is-default-class'], 'true')
  assert.equal(p1.metadata.annotations.note, 'y')
  // default 不变 + annotations 不变 → null（is-default 不因 desired 缺它而被 null 删除）
  assert.equal(buildStorageClassPatch(original, { isDefault: false, annotations: { note: 'x' } }), null)
  // 只改 label
  const p3 = buildStorageClassPatch(original, { labels: { a: '2' } })
  assert.deepEqual(p3.metadata.labels, { a: '2' })
  // 关闭 default（原本 false → 不变 → null；用 true 原始测关闭）
  const p4 = buildStorageClassPatch({ default: true, labels: {}, annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, { isDefault: false })
  assert.equal(p4.metadata.annotations['storageclass.kubernetes.io/is-default-class'], 'false')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/test.mjs`
Expected: FAIL，报 `Cannot find module '../src/composables/useStoragePatch.js'`。

- [ ] **Step 3: 实现纯函数**

创建 `src/composables/useStoragePatch.js`：

```js
// 构造 PV/StorageClass 编辑的 merge-patch body（手术式：只含改动字段）。
// labels/annotations 传「期望全量」，与 original 比较后，删除的键置 null（merge-patch 删除语义）。
// 无依赖纯函数，便于 scripts/test.mjs 直接 import；store.updatePV/updateStorageClass 复用。

// diffMap：desired 相对 original 的变化——新增/改值 → {k:v}；删除 → {k:null}
export function diffMap(original = {}, desired = {}) {
  const out = {}
  for (const [k, v] of Object.entries(desired)) {
    if (original[k] !== v) out[k] = v
  }
  for (const k of Object.keys(original)) {
    if (!(k in desired)) out[k] = null
  }
  return out
}

const SC_DEFAULT_KEYS = ['storageclass.kubernetes.io/is-default-class', 'storageclass.beta.kubernetes.io/is-default-class']

// PV patch：reclaimPolicy（可选）+ labels/annotations diff。无改动返回 null。
export function buildPVPatch(original = {}, { reclaimPolicy, labels, annotations } = {}) {
  const metadata = {}
  const spec = {}
  let touched = false
  if (reclaimPolicy && reclaimPolicy !== original.reclaimPolicy) {
    spec.persistentVolumeReclaimPolicy = reclaimPolicy; touched = true
  }
  if (labels) {
    const lp = diffMap(original.labels || {}, labels)
    if (Object.keys(lp).length) { metadata.labels = lp; touched = true }
  }
  if (annotations) {
    const ap = diffMap(original.annotations || {}, annotations)
    if (Object.keys(ap).length) { metadata.annotations = ap; touched = true }
  }
  if (!touched) return null
  const patch = {}
  if (Object.keys(spec).length) patch.spec = spec
  if (Object.keys(metadata).length) patch.metadata = metadata
  return patch
}

// SC patch：is-default 注解（由 isDefault 控制）+ labels/annotations diff（排除 is-default 键）。无改动返回 null。
export function buildStorageClassPatch(original = {}, { isDefault, labels, annotations } = {}) {
  const metadata = {}
  let touched = false
  if (isDefault != null && !!isDefault !== !!original.default) {
    metadata.annotations = { 'storageclass.kubernetes.io/is-default-class': isDefault ? 'true' : 'false' }
    touched = true
  }
  if (labels) {
    const lp = diffMap(original.labels || {}, labels)
    if (Object.keys(lp).length) { metadata.labels = lp; touched = true }
  }
  if (annotations) {
    const origAnnExcl = { ...(original.annotations || {}) }
    for (const k of SC_DEFAULT_KEYS) delete origAnnExcl[k]
    const ap = diffMap(origAnnExcl, annotations)
    if (Object.keys(ap).length) { metadata.annotations = { ...(metadata.annotations || {}), ...ap }; touched = true }
  }
  if (!touched) return null
  return { metadata }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/test.mjs`
Expected: PASS（`✓ N/N 用例全部通过`）。

- [ ] **Step 5: 提交**

```bash
git add src/composables/useStoragePatch.js scripts/test.mjs
git commit -m "feat(storage): 抽 diffMap/buildPVPatch/buildStorageClassPatch 纯函数 + 契约测试"
```

---

### Task 2: store mapper 补字段 + updatePV/updateStorageClass 改远端 merge-patch

**Files:**
- Modify: `src/stores/cluster.js`（顶部 import；`mapPV` 约 1734；`mapStorageClass` 约 1747；`updatePV` 约 656；`updateStorageClass` 约 677）

**Interfaces:**
- Consumes: `buildPVPatch`/`buildStorageClassPatch`（Task 1）。
- Produces: `mapPV`/`mapStorageClass` 返回对象新增 `labels`、`annotations`；`updatePV(name, { reclaimPolicy, labels, annotations })` / `updateStorageClass(name, { isDefault, labels, annotations })` 远端 merge-patch。

**Discipline:** 只改 import + mapPV + mapStorageClass + updatePV + updateStorageClass 五处。不碰 addPV/deletePV/addStorageClass/deleteStorageClass、mapPVC、generateYAML 等其它逻辑。

- [ ] **Step 1: 引入纯函数**

在 `src/stores/cluster.js` 顶部 `@/composables/...` import 段追加：

```js
import { buildPVPatch, buildStorageClassPatch } from '@/composables/useStoragePatch'
```

- [ ] **Step 2: mapPV 加 labels/annotations**

把 `mapPV`（约 1734-1746）整体替换为：

```js
  const mapPV = item => {
    const claim = item.spec?.claimRef
    return {
      name: item.metadata?.name,
      capacity: item.spec?.capacity?.storage || '—',
      accessModes: AM[item.spec?.accessModes?.[0]] || item.spec?.accessModes?.[0] || 'RWO',
      reclaimPolicy: item.spec?.persistentVolumeReclaimPolicy || 'Retain',
      status: item.status?.phase || 'Available',
      claim: claim ? `${claim.namespace || 'default'}/${claim.name}` : '',
      storageClass: item.spec?.storageClassName || '',
      labels: item.metadata?.labels || {},
      annotations: item.metadata?.annotations || {},
      age: ageOf(item.metadata?.creationTimestamp),
    }
  }
```

- [ ] **Step 3: mapStorageClass 加 labels/annotations**

把 `mapStorageClass`（约 1747-1759）整体替换为：

```js
  const mapStorageClass = item => {
    const ann = item.metadata?.annotations || {}
    const isDefault = ann['storageclass.kubernetes.io/is-default-class'] === 'true'
      || ann['storageclass.beta.kubernetes.io/is-default-class'] === 'true'
    return {
      name: item.metadata?.name,
      provisioner: item.provisioner || '',
      parameters: Object.entries(item.parameters || {}).map(([k, v]) => `${k}=${v}`).join(','),
      reclaimPolicy: item.reclaimPolicy || 'Delete',
      default: isDefault,
      labels: item.metadata?.labels || {},
      annotations: ann,
      age: ageOf(item.metadata?.creationTimestamp),
    }
  }
```

- [ ] **Step 4: updatePV 改远端 merge-patch**

把 `function updatePV(name, updates) { ... }`（约 656-659）整体替换为：

```js
  async function updatePV(name, updates) {
    const idx = pvList.value.findIndex(p => p.name === name)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(pvList.value[idx]))
    const patch = buildPVPatch(before, updates)
    if (!patch) return
    if (remoteMode.value) {
      await api.k8s(`/api/v1/persistentvolumes/${encodeURIComponent(name)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(patch),
      })
    }
    pvList.value[idx] = {
      ...before,
      ...(updates.reclaimPolicy ? { reclaimPolicy: updates.reclaimPolicy } : {}),
      ...(updates.labels ? { labels: updates.labels } : {}),
      ...(updates.annotations ? { annotations: updates.annotations } : {}),
    }
  }
```

- [ ] **Step 5: updateStorageClass 改远端 merge-patch**

把 `function updateStorageClass(name, updates) { ... }`（约 677-680）整体替换为：

```js
  async function updateStorageClass(name, updates) {
    const idx = scList.value.findIndex(s => s.name === name)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(scList.value[idx]))
    const patch = buildStorageClassPatch(before, updates)
    if (!patch) return
    if (remoteMode.value) {
      await api.k8s(`/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(name)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(patch),
      })
    }
    const DEFAULT_KEY = 'storageclass.kubernetes.io/is-default-class'
    const newAnns = { ...(updates.annotations || before.annotations || {}) }
    if (updates.isDefault != null) {
      if (updates.isDefault) newAnns[DEFAULT_KEY] = 'true'
      else delete newAnns[DEFAULT_KEY]
    }
    scList.value[idx] = {
      ...before,
      default: updates.isDefault != null ? !!updates.isDefault : before.default,
      ...(updates.labels ? { labels: updates.labels } : {}),
      annotations: newAnns,
    }
  }
```

- [ ] **Step 6: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误（仅 pre-existing chunk-size 提示）。

- [ ] **Step 7: 提交**

```bash
git add src/stores/cluster.js
git commit -m "feat(storage): mapPV/mapStorageClass 补 labels/annotations + updatePV/updateStorageClass 改远端 merge-patch"
```

---

### Task 3: PVDetail 编辑 Modal + 删除按钮

**Files:**
- Modify: `src/views/PVDetail.vue`（header 约 40-54；script 约 1-30；末尾加 Modal）

**Interfaces:**
- Consumes: `store.updatePV(name, { reclaimPolicy, labels, annotations })`、`store.deletePV(name)`（Task 2）、`pv.labels`/`pv.annotations`（Task 2 mapper）。

**Discipline:** 只在 PVDetail 加编辑/删除 UI 与对应 script。不改 overview/yaml 展示逻辑、不改 bound claim/SC 卡片。

- [ ] **Step 1: script 加编辑/删除状态与函数**

在 `PVDetail.vue` 的 `<script setup>`（`accessModeLabels` 那行之后）追加：

```js
// 结构化编辑（仅 K8s 可变字段：reclaimPolicy + labels/annotations）+ 删除
const showEditModal = ref(false)
const showDeleteModal = ref(false)
const editForm = ref({ reclaimPolicy: 'Retain', labels: [], annotations: [] })
const labelsToRows = obj => Object.entries(obj || {}).map(([key, value]) => ({ key, value: String(value) }))
const rowsToMap = rows => {
  const m = {}
  for (const r of rows) { const k = (r.key || '').trim(); if (k) m[k] = r.value }
  return m
}
function openEdit() {
  editForm.value = {
    reclaimPolicy: pv.value?.reclaimPolicy || 'Retain',
    labels: labelsToRows(pv.value?.labels),
    annotations: labelsToRows(pv.value?.annotations),
  }
  showEditModal.value = true
}
function addLabelRow() { editForm.value.labels.push({ key: '', value: '' }) }
function removeLabelRow(i) { editForm.value.labels.splice(i, 1) }
function addAnnRow() { editForm.value.annotations.push({ key: '', value: '' }) }
function removeAnnRow(i) { editForm.value.annotations.splice(i, 1) }
async function saveEdit() {
  await store.updatePV(route.params.name, {
    reclaimPolicy: editForm.value.reclaimPolicy,
    labels: rowsToMap(editForm.value.labels),
    annotations: rowsToMap(editForm.value.annotations),
  })
  showEditModal.value = false
}
async function handleDelete() {
  await store.deletePV(route.params.name)
  router.push('/storage')
}
```

- [ ] **Step 2: header 加编辑/删除按钮**

把 `PVDetail.vue` 的 header（`<div class="flex items-center justify-between mt-sm mb-xl">` 块，约 40-54）里在标题 `<div class="flex items-center gap-lg">...</div>` 之后、闭合 `</div>` 之前插入按钮组。即把：

```html
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">database</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ pv.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <StatusChip :status="pv.status" />
            <span class="text-body-sm text-on-surface-variant">Capacity: <span class="font-mono text-primary font-semibold">{{ pv.capacity }}</span></span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ pv.age }}</span>
          </div>
        </div>
      </div>
    </div>
```

替换为（在标题块后加按钮组）：

```html
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">database</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ pv.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <StatusChip :status="pv.status" />
            <span class="text-body-sm text-on-surface-variant">Capacity: <span class="font-mono text-primary font-semibold">{{ pv.capacity }}</span></span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ pv.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-xs">
        <button @click="openEdit" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined text-sm">edit</span> 编辑
        </button>
        <button @click="showDeleteModal = true" class="px-3 py-1.5 text-body-sm font-medium border border-error/30 text-error rounded-lg hover:bg-error/5 transition-colors">删除</button>
      </div>
    </div>
```

- [ ] **Step 3: 末尾加编辑 Modal + 删除 Modal**

在 `PVDetail.vue` 的 `<div v-if="activeTab === 'yaml'">...</div>` 之后、`</section>`（v-if="pv" 那个）之前插入：

```html
    <!-- Edit Modal -->
    <Modal v-model="showEditModal" title="编辑 PersistentVolume（仅可变字段）" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Reclaim Policy</label>
          <select v-model="editForm.reclaimPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option value="Retain">Retain</option>
            <option value="Delete">Delete</option>
            <option value="Recycle">Recycle</option>
          </select>
        </div>
        <div>
          <div class="flex items-center justify-between mb-xs">
            <label class="text-label-caps text-on-surface-variant">Labels</label>
            <button @click="addLabelRow" type="button" class="text-body-sm text-primary font-medium hover:underline">+ 添加</button>
          </div>
          <div v-for="(row, i) in editForm.labels" :key="'l'+i" class="flex gap-xs mb-xs">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="key" />
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="value" />
            <button @click="removeLabelRow(i)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
          <p v-if="!editForm.labels.length" class="text-xs text-on-surface-variant/60">无</p>
        </div>
        <div>
          <div class="flex items-center justify-between mb-xs">
            <label class="text-label-caps text-on-surface-variant">Annotations</label>
            <button @click="addAnnRow" type="button" class="text-body-sm text-primary font-medium hover:underline">+ 添加</button>
          </div>
          <div v-for="(row, i) in editForm.annotations" :key="'a'+i" class="flex gap-xs mb-xs">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="key" />
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="value" />
            <button @click="removeAnnRow(i)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
          <p v-if="!editForm.annotations.length" class="text-xs text-on-surface-variant/60">无</p>
        </div>
      </div>
      <template #actions>
        <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
        <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">保存</button>
      </template>
    </Modal>

    <!-- Delete Modal -->
    <Modal v-model="showDeleteModal" title="删除 PersistentVolume" width="max-w-md">
      <p class="text-body-md text-on-surface-variant">确认删除 PV <span class="text-on-surface font-semibold">{{ pv.name }}</span>？此操作不可撤销。</p>
      <template #actions>
        <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
        <button @click="handleDelete" class="px-md py-sm bg-error text-error rounded-lg text-body-md font-semibold hover:opacity-90">删除</button>
      </template>
    </Modal>
```

- [ ] **Step 4: 确认 Modal 已 import**

`PVDetail.vue` 顶部已 import `Modal`（用于无？检查）。若无，在 import 段加 `import Modal from '@/components/common/Modal.vue'`。（当前文件未 import Modal——需新增。）

- [ ] **Step 5: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。若报 `Modal is not defined`，说明 Step 4 import 漏了。

- [ ] **Step 6: 提交**

```bash
git add src/views/PVDetail.vue
git commit -m "feat(pv): PVDetail 加结构化编辑 Modal（reclaimPolicy + labels/annotations）+ 删除按钮"
```

---

### Task 4: StorageClassDetail 编辑 Modal + 删除按钮

**Files:**
- Modify: `src/views/StorageClassDetail.vue`（header 约 36-50；script 约 1-26；末尾加 Modal）

**Interfaces:**
- Consumes: `store.updateStorageClass(name, { isDefault, labels, annotations })`、`store.deleteStorageClass(name)`（Task 2）、`sc.labels`/`sc.annotations`/`sc.default`（Task 2 mapper）。

**Discipline:** 只加编辑/删除 UI。annotations 编辑器**过滤掉** `storageclass.kubernetes.io/is-default-class`（与 beta 键），由 default 开关控制。

- [ ] **Step 1: script 加编辑/删除状态与函数**

在 `StorageClassDetail.vue` 的 `<script setup>`（`boundPVCs` 那行之后）追加：

```js
// 结构化编辑（仅可变：default + labels/annotations）+ 删除
const showEditModal = ref(false)
const showDeleteModal = ref(false)
const editForm = ref({ isDefault: false, labels: [], annotations: [] })
const SC_DEFAULT_KEYS = ['storageclass.kubernetes.io/is-default-class', 'storageclass.beta.kubernetes.io/is-default-class']
const labelsToRows = obj => Object.entries(obj || {}).map(([key, value]) => ({ key, value: String(value) }))
const rowsToMap = rows => {
  const m = {}
  for (const r of rows) { const k = (r.key || '').trim(); if (k) m[k] = r.value }
  return m
}
function openEdit() {
  const annExcl = { ...(sc.value?.annotations || {}) }
  for (const k of SC_DEFAULT_KEYS) delete annExcl[k]   // 过滤 is-default，由开关控制
  editForm.value = {
    isDefault: !!sc.value?.default,
    labels: labelsToRows(sc.value?.labels),
    annotations: labelsToRows(annExcl),
  }
  showEditModal.value = true
}
function addLabelRow() { editForm.value.labels.push({ key: '', value: '' }) }
function removeLabelRow(i) { editForm.value.labels.splice(i, 1) }
function addAnnRow() { editForm.value.annotations.push({ key: '', value: '' }) }
function removeAnnRow(i) { editForm.value.annotations.splice(i, 1) }
async function saveEdit() {
  await store.updateStorageClass(route.params.name, {
    isDefault: editForm.value.isDefault,
    labels: rowsToMap(editForm.value.labels),
    annotations: rowsToMap(editForm.value.annotations),
  })
  showEditModal.value = false
}
async function handleDelete() {
  await store.deleteStorageClass(route.params.name)
  router.push('/storage')
}
```

- [ ] **Step 2: header 加编辑/删除按钮**

把 `StorageClassDetail.vue` 的 header（`<div class="flex items-center justify-between mt-sm mb-xl">`，约 36-50）整体替换为（标题块后加按钮组）：

```html
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-secondary text-3xl">database</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ sc.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span v-if="sc.default" class="px-2.5 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded-full font-medium">DEFAULT</span>
            <span class="text-body-sm text-on-surface-variant font-mono">{{ sc.provisioner }}</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ sc.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-xs">
        <button @click="openEdit" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined text-sm">edit</span> 编辑
        </button>
        <button @click="showDeleteModal = true" class="px-3 py-1.5 text-body-sm font-medium border border-error/30 text-error rounded-lg hover:bg-error/5 transition-colors">删除</button>
      </div>
    </div>
```

- [ ] **Step 3: 末尾加编辑 Modal + 删除 Modal**

在 `StorageClassDetail.vue` 的 `<div v-if="activeTab === 'yaml'">...</div>` 之后、`</section>`（v-if="sc" 那个）之前插入：

```html
    <!-- Edit Modal -->
    <Modal v-model="showEditModal" title="编辑 StorageClass（仅可变字段）" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <label class="flex items-center gap-sm cursor-pointer">
          <input v-model="editForm.isDefault" type="checkbox" class="h-4 w-4 accent-primary" />
          <span class="text-body-md text-on-surface">设为默认 StorageClass</span>
        </label>
        <div>
          <div class="flex items-center justify-between mb-xs">
            <label class="text-label-caps text-on-surface-variant">Labels</label>
            <button @click="addLabelRow" type="button" class="text-body-sm text-primary font-medium hover:underline">+ 添加</button>
          </div>
          <div v-for="(row, i) in editForm.labels" :key="'l'+i" class="flex gap-xs mb-xs">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="key" />
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="value" />
            <button @click="removeLabelRow(i)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
          <p v-if="!editForm.labels.length" class="text-xs text-on-surface-variant/60">无</p>
        </div>
        <div>
          <div class="flex items-center justify-between mb-xs">
            <label class="text-label-caps text-on-surface-variant">Annotations</label>
            <button @click="addAnnRow" type="button" class="text-body-sm text-primary font-medium hover:underline">+ 添加</button>
          </div>
          <div v-for="(row, i) in editForm.annotations" :key="'a'+i" class="flex gap-xs mb-xs">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="key" />
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="value" />
            <button @click="removeAnnRow(i)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
          <p v-if="!editForm.annotations.length" class="text-xs text-on-surface-variant/60">无</p>
          <p class="text-[10px] text-on-surface-variant/60 mt-xs">系统注解 <code>storageclass.kubernetes.io/is-default-class</code> 由「默认开关」控制，不在此列。</p>
        </div>
      </div>
      <template #actions>
        <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
        <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">保存</button>
      </template>
    </Modal>

    <!-- Delete Modal -->
    <Modal v-model="showDeleteModal" title="删除 StorageClass" width="max-w-md">
      <p class="text-body-md text-on-surface-variant">确认删除 StorageClass <span class="text-on-surface font-semibold">{{ sc.name }}</span>？此操作不可撤销。</p>
      <template #actions>
        <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
        <button @click="handleDelete" class="px-md py-sm bg-error text-error rounded-lg text-body-md font-semibold hover:opacity-90">删除</button>
      </template>
    </Modal>
```

- [ ] **Step 4: 确认 Modal 已 import**

`StorageClassDetail.vue` 顶部当前未 import `Modal`。在 import 段加：`import Modal from '@/components/common/Modal.vue'`。

- [ ] **Step 5: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。

- [ ] **Step 6: 提交**

```bash
git add src/views/StorageClassDetail.vue
git commit -m "feat(sc): StorageClassDetail 加结构化编辑 Modal（default + labels/annotations）+ 删除按钮"
```

---

### Task 5: SideNavBar 集群级「存储」入口

**Files:**
- Modify: `src/components/layout/SideNavBar.vue`（`clusterPrimaryNav` 约 17-21）

**Interfaces:** 无（独立 UI 改动，路由 `/storage` 已存在）。

- [ ] **Step 1: 加「存储」导航项**

把 `clusterPrimaryNav`（约 17-21）：

```js
const clusterPrimaryNav = [
  { icon: 'dashboard', label: 'Cluster Overview', route: '/cluster' },
  { icon: 'dns', label: 'Nodes', route: '/nodes' },
  { icon: 'folder_open', label: 'Namespaces', route: '/namespaces' },
]
```

替换为：

```js
const clusterPrimaryNav = [
  { icon: 'dashboard', label: 'Cluster Overview', route: '/cluster' },
  { icon: 'dns', label: 'Nodes', route: '/nodes' },
  { icon: 'folder_open', label: 'Namespaces', route: '/namespaces' },
  { icon: 'storage', label: '存储', route: '/storage' },
]
```

- [ ] **Step 2: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。

- [ ] **Step 3: 手动验证（可选，无 GUI 则跳过）**

`npm run dev` → 集群级侧边栏出现「存储」→ 点击进 `/storage` 3-Tab（PVC/PV/SC）。

- [ ] **Step 4: 提交**

```bash
git add src/components/layout/SideNavBar.vue
git commit -m "feat(nav): 集群级侧边栏加「存储」入口暴露 PV/StorageClass"
```

---

## Self-Review（计划编写后自检，已修正）

- **Spec coverage**：① 集群级侧边栏入口（Task 5）② mapper 补 labels/annotations（Task 2）③ updatePV/updateStorageClass 远端 merge-patch（Task 2）④ PVDetail 编辑 Modal + 删除（Task 3）⑤ StorageClassDetail 编辑 Modal + 删除（Task 4，annotations 过滤 is-default）⑥ 纯函数 + 单测（Task 1）——全覆盖。
- **Placeholder scan**：无 TBD/TODO；每步含可执行 old/new 或具体代码。
- **Type consistency**：`buildPVPatch(original,{reclaimPolicy,labels,annotations})`（Task 1）→ store `updatePV(name, updates)` 调 `buildPVPatch(before, updates)`（Task 2）→ 组件 `saveEdit` 传 `{reclaimPolicy, labels, annotations}`（Task 3）；`buildStorageClassPatch(original,{isDefault,labels,annotations})` → store `updateStorageClass` → 组件 `{isDefault, labels, annotations}`（Task 4）。字段名一致。`mapPV`/`mapStorageClass` 加的 `labels`/`annotations` 供组件 `openEdit` 读取。
- **merge-patch null 语义**：`diffMap` 删除→null（Task 1 测试覆盖）；store PATCH body = `JSON.stringify(patch)`（patch 含 null）。一致。
- **SC is-default 双控件**：组件 annotations 编辑器过滤 is-default（Task 4 openEdit），`buildStorageClassPatch` 排除 is-default 键（Task 1），default 仅由 `isDefault` 参数控制。一致。
- **Modal import**：Task 3 Step 4 / Task 4 Step 4 明确两个详情页需新增 `import Modal`（当前未 import）。
