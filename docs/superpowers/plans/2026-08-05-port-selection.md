# 端口选择改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Service 的 `targetPort` 与 Ingress 的 `serviceName`/`servicePort` 从手输改为可输可选（combobox），下拉候选来自已知资源（工作负载容器端口 / Service 端口），并保留手输兜底。

**Architecture:** 抽一个无依赖纯函数 `extractContainerPorts` 聚合工作负载容器端口（可单测）；store 暴露 `nsContainerPorts` computed 复用之；新建通用 `PortSelect.vue`（input + 浮层，参考 `TagInput.vue`）；6 处表单把对应 input 替换为 `PortSelect`，Ingress 两处加 serviceName→servicePort 候选联动。YAML 生成层不改。

**Tech Stack:** Vue 3 `<script setup>`、Pinia、Vite、原生 fetch、js-yaml、零依赖 node 测试运行器（`scripts/test.mjs`）。

## Global Constraints

- **禁止新增外部依赖**：不得引入 vitest/jest；纯逻辑测试追加到 `scripts/test.mjs`（镜像/纯函数契约，遵循该文件既有约定）。
- **可输可选，不禁用**：候选为空时仍允许手输（命名端口、跨 ns、无工作负载等边界靠手输兜底）。
- **Service targetPort 候选** = 当前 ns 全部工作负载的 `containerPort` 聚合去重升序，**与 selector 无关**。
- **Ingress servicePort 候选** = 用户所选 Service 的 `portList[].port`；serviceName 候选 = 当前 ns Service 名。
- **YAML 层（`generateYAML`）不改**——已兼容数字与字符串型端口。
- **样式**：输入框 class 由各表单经 `input-class` prop 透传以保持原视觉；浮层复用 `TagInput.vue:104` 的样式。
- **ExternalName 类型**：维持现有"隐藏 targetPort"逻辑，不动。
- 每个 Service 端口表单的端口行结构为 `{ port, targetPort, protocol, nodePort }`（DeployApp 服务端口用 `sp.targetPort`、容器端口用 `form.ports[].containerPort`）。

---

## File Structure

**新增**
- `src/composables/usePorts.js` — 纯函数 `extractContainerPorts(workloads)`，无依赖，单测可 import。
- `src/components/common/PortSelect.vue` — 可输可选端口选择器（combobox）。

**修改**
- `scripts/test.mjs` — 追加 `extractContainerPorts` 契约测试。
- `src/stores/cluster.js` — 新增 `nsContainerPorts` computed + 导出。
- `src/views/NsServices.vue` — targetPort input → PortSelect（创建表单）。
- `src/views/NsServiceDetail.vue` — targetPort input → PortSelect（编辑表单）。
- `src/views/DeployApp.vue` — targetPort input → PortSelect（候选来自本地 `form.ports`），删除旧的纯文字容器端口提示。
- `src/components/common/CreateResourceDialog.vue` — targetPort input → PortSelect。
- `src/views/NsIngress.vue` — serviceName + servicePort → PortSelect（创建，联动）。
- `src/views/NsIngressDetail.vue` — serviceName + servicePort → PortSelect（编辑路由，每行联动）。

---

### Task 1: 纯函数 `extractContainerPorts` + 单测（TDD）

**Files:**
- Create: `src/composables/usePorts.js`
- Test: `scripts/test.mjs`（追加用例）

**Interfaces:**
- Produces: `extractContainerPorts(workloads: Array<{raw?: {spec?: {template?: {spec?: {containers?: Array<{ports?: Array<{containerPort: number|string}>>}}>}}>}}>) => number[]`（去重、升序、过滤空值）。从 `../src/composables/usePorts.js` import。

- [ ] **Step 1: 写失败测试**

在 `scripts/test.mjs` 末尾"汇总"段（`const failed = ...` 那行之前）追加：

```js
// --- 端口选择：聚合工作负载 containerPort（去重升序，过滤空值）---
// 契约：stores/cluster.js 的 nsContainerPorts 复用本纯函数；镜像输入结构为 mapWorkload 产物（含 raw）。
import { extractContainerPorts } from '../src/composables/usePorts.js'
test('端口聚合 extractContainerPorts：多工作负载/多容器/多端口去重升序、过滤空值与缺省', () => {
  const workloads = [
    { raw: { spec: { template: { spec: { containers: [
      { name: 'a', ports: [{ containerPort: 8080 }, { containerPort: 3000 }] },
      { name: 'b', ports: [{ containerPort: 8080 }] },                 // 重复 8080
    ] } } } } },
    { raw: { spec: { template: { spec: { containers: [
      { name: 'c', ports: [{ containerPort: 9090 }, { containerPort: '' }, { containerPort: null }] }, // 空值过滤
    ] } } } } },
    { raw: { spec: { template: { spec: { containers: [] } } } } },     // 无端口
    { raw: {} },                                                        // 无 spec
    {},                                                                 // 无 raw
  ]
  assert.deepEqual(extractContainerPorts(workloads), [3000, 8080, 9090])
  assert.deepEqual(extractContainerPorts([]), [])
  assert.deepEqual(extractContainerPorts(undefined), [])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/test.mjs`
Expected: FAIL，报 `Cannot find module '../src/composables/usePorts.js'`。

- [ ] **Step 3: 实现纯函数**

创建 `src/composables/usePorts.js`：

```js
// 端口聚合纯函数：从工作负载列表提取所有 containerPort，去重并升序。
// 无外部依赖，便于 scripts/test.mjs 直接 import；stores/cluster.js 的 nsContainerPorts 复用本函数。
// 输入结构对齐 mapWorkload 产物（workload.raw.spec.template.spec.containers[].ports[].containerPort）。
export function extractContainerPorts(workloads = []) {
  const set = new Set()
  for (const w of workloads || []) {
    const containers = w?.raw?.spec?.template?.spec?.containers || []
    for (const c of containers) {
      for (const p of c.ports || []) {
        const port = p?.containerPort
        if (port !== null && port !== undefined && port !== '') set.add(Number(port))
      }
    }
  }
  return [...set].sort((a, b) => a - b)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/test.mjs`
Expected: PASS（末尾输出 `✓ N/N 用例全部通过`）。

- [ ] **Step 5: 提交**

```bash
git add src/composables/usePorts.js scripts/test.mjs
git commit -m "feat(ports): 抽 extractContainerPorts 纯函数 + 契约测试"
```

---

### Task 2: store 暴露 `nsContainerPorts`

**Files:**
- Modify: `src/stores/cluster.js`（`nsServices` 后新增 computed，约 169 行之后；return 导出区 3176 行）

**Interfaces:**
- Consumes: `extractContainerPorts`（Task 1）、`nsWorkloads`（既有 computed）。
- Produces: `store.nsContainerPorts`（`computed<number[]>`）。

- [ ] **Step 1: 引入纯函数**

在 `src/stores/cluster.js` 顶部 import 区（与其它 `@/composables/...` 同段）追加：

```js
import { extractContainerPorts } from '@/composables/usePorts'
```

- [ ] **Step 2: 新增 computed**

在 `nsServices` computed 之后（`src/stores/cluster.js:169` 的 `})` 之后）插入：

```js
  // 当前 ns 下所有工作负载暴露的容器端口（去重升序），供 Service targetPort 下拉选择
  const nsContainerPorts = computed(() => extractContainerPorts(nsWorkloads.value))
```

- [ ] **Step 3: 导出**

在 `src/stores/cluster.js:3176` 的 namespace 计算属性行：

```js
    nsWorkloads, nsPods, nsServices, nsIngress, nsEndpoints, nsConfigMaps, nsSecrets,
```

改为：

```js
    nsWorkloads, nsPods, nsServices, nsIngress, nsEndpoints, nsConfigMaps, nsSecrets, nsContainerPorts,
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 无新增错误。

- [ ] **Step 5: 提交**

```bash
git add src/stores/cluster.js
git commit -m "feat(store): 暴露 nsContainerPorts 供端口下拉选择"
```

---

### Task 3: `PortSelect.vue` 组件 + 接入 NsServices 创建表单

**Files:**
- Create: `src/components/common/PortSelect.vue`
- Modify: `src/views/NsServices.vue`（import 组件；targetPort input → PortSelect）

**Interfaces:**
- Produces: `PortSelect` 组件。Props：`modelValue: string|number`、`options: Array<number|string|{label,value}>`、`placeholder: string`、`inputClass: string`（透传给内部 input）、`emptyHint: string`。Emits：`update:modelValue`。用法：`<PortSelect v-model="x" :options="..." input-class="..." placeholder="..." />`。

- [ ] **Step 1: 创建组件**

创建 `src/components/common/PortSelect.vue`：

```vue
<script setup>
// 端口选择器（可输可选 combobox）：下拉从已知端口选，也允许手输兜底（命名端口/跨ns/无候选）。
// options 为数字/字符串数组或 {label,value} 数组；inputClass 透传输入框样式以贴合各表单原有视觉。
import { ref, computed, watch } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  inputClass: { type: String, default: '' },
  emptyHint: { type: String, default: '无可选端口，可直接输入' },
})
const emit = defineEmits(['update:modelValue'])

const text = ref(String(props.modelValue ?? ''))
const focused = ref(false)

// 外部 modelValue 变化 → 同步输入框（父级重置后输入框跟随）
watch(() => props.modelValue, v => {
  if (String(v ?? '') !== text.value) text.value = String(v ?? '')
})

// 统一为 {label, value}
const normalized = computed(() =>
  (props.options || []).map(o => (o && typeof o === 'object' ? { label: String(o.label), value: o.value } : { label: String(o), value: o }))
)
const filtered = computed(() => {
  const q = text.value.trim().toLowerCase()
  if (!q) return normalized.value
  return normalized.value.filter(o => String(o.value).toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
})

function onInput(e) {
  text.value = e.target.value
  emit('update:modelValue', text.value)
}
function pick(o) {
  text.value = String(o.value)
  emit('update:modelValue', o.value)
  focused.value = false
}
function onBlur() {
  // 延迟关闭，确保 mousedown 点击候选先于失焦
  setTimeout(() => { focused.value = false }, 150)
}
</script>

<template>
  <div class="relative">
    <input
      :value="text"
      :placeholder="placeholder"
      @input="onInput"
      @focus="focused = true"
      @blur="onBlur"
      :class="['outline-none', inputClass]"
    />
    <div
      v-if="focused && filtered.length"
      class="absolute z-30 top-full left-0 right-0 mt-1 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-lg max-h-48 overflow-auto"
    >
      <button
        v-for="o in filtered"
        :key="String(o.value)"
        type="button"
        @mousedown.prevent="pick(o)"
        class="w-full flex items-center justify-between gap-sm px-md py-sm text-body-sm hover:bg-primary-container/20 transition-colors text-left"
      >
        <span class="font-medium font-mono">{{ o.value }}</span>
        <span v-if="o.label !== String(o.value)" class="text-[10px] text-on-surface-variant shrink-0">{{ o.label }}</span>
      </button>
    </div>
    <div
      v-else-if="focused && !normalized.length"
      class="absolute z-30 top-full left-0 right-0 mt-1 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-lg px-md py-sm text-body-sm text-on-surface-variant"
    >
      {{ emptyHint }}
    </div>
  </div>
</template>
```

- [ ] **Step 2: NsServices 引入组件**

在 `src/views/NsServices.vue` import 区（`Pagination` 那行之后）追加：

```js
import PortSelect from '@/components/common/PortSelect.vue'
```

- [ ] **Step 3: 替换 targetPort input**

把 `src/views/NsServices.vue:336` 的：

```html
            <input v-model="p.targetPort" class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="target" />
```

替换为：

```html
            <PortSelect v-model="p.targetPort" :options="store.nsContainerPorts" placeholder="target" empty-hint="当前命名空间暂无工作负载暴露容器端口，可直接输入" input-class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" />
```

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误，构建成功。

- [ ] **Step 5: 手动验证**

Run: `npm run dev`，登录并进入某 namespace 的 Services 页，点创建。
Expected：
- targetPort 一列变为可输可选框；聚焦时弹出当前 ns 工作负载的 containerPort 下拉。
- 点候选项 → 填入；也可直接键入任意值（如命名端口 `http`）。
- 当前 ns 无工作负载时 → 浮层显示 emptyHint，仍可手输。

- [ ] **Step 6: 提交**

```bash
git add src/components/common/PortSelect.vue src/views/NsServices.vue
git commit -m "feat(ui): 新增 PortSelect 可输可选组件，接入 Service 创建表单 targetPort"
```

---

### Task 4: 接入 NsServiceDetail 编辑表单

**Files:**
- Modify: `src/views/NsServiceDetail.vue`（import 组件；targetPort input → PortSelect）

**Interfaces:**
- Consumes: `PortSelect`（Task 3）、`store.nsContainerPorts`（Task 2）。

- [ ] **Step 1: 引入组件**

在 `src/views/NsServiceDetail.vue` import 区（`DropdownMenu` 那行，约 18 行）之后追加：

```js
import PortSelect from '@/components/common/PortSelect.vue'
```

- [ ] **Step 2: 替换 targetPort input**

把 `src/views/NsServiceDetail.vue:518` 的：

```html
            <input v-model="p.targetPort" class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="target" />
```

替换为：

```html
            <PortSelect v-model="p.targetPort" :options="store.nsContainerPorts" placeholder="target" empty-hint="当前命名空间暂无工作负载暴露容器端口，可直接输入" input-class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" />
```

- [ ] **Step 3: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。

- [ ] **Step 4: 手动验证**

Run: `npm run dev`，进入某 Service 详情，打开编辑弹窗。
Expected：现有端口的 targetPort 回填到 PortSelect；可下拉改选/手输；保存后 YAML 的 targetPort 正确。

- [ ] **Step 5: 提交**

```bash
git add src/views/NsServiceDetail.vue
git commit -m "feat(ui): Service 编辑表单 targetPort 接入 PortSelect"
```

---

### Task 5: 接入 DeployApp 部署向导 Step5

**Files:**
- Modify: `src/views/DeployApp.vue`（import 组件；本地 containerPort computed；targetPort input → PortSelect；删除旧提示段）

**Interfaces:**
- Consumes: `PortSelect`（Task 3）。候选来自**本地** `form.ports[].containerPort`（用户同步骤前面填的容器端口），不复用 store。

- [ ] **Step 1: 引入组件 + 本地候选 computed**

在 `src/views/DeployApp.vue` import 区追加：

```js
import PortSelect from '@/components/common/PortSelect.vue'
```

在 `<script setup>` 内（与其它 computed 同段，`form` 定义之后）追加：

```js
// 部署向导：targetPort 候选 = 本步骤已填的容器端口（去重），引导用户选对后端端口
const containerPortOptions = computed(() => {
  const set = new Set()
  for (const p of form.value.ports) {
    if (p.containerPort !== '' && p.containerPort != null) set.add(p.containerPort)
  }
  return [...set]
})
```

- [ ] **Step 2: 替换 targetPort input**

把 `src/views/DeployApp.vue:1207` 的：

```html
                <input v-model="sp.targetPort" class="w-24 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs font-mono" placeholder="targetPort" />
```

替换为：

```html
                <PortSelect v-model="sp.targetPort" :options="containerPortOptions" placeholder="targetPort" empty-hint="先在上方 Containers 步骤填写容器端口" input-class="w-24 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs font-mono" />
```

- [ ] **Step 3: 删除旧的纯文字提示**

删除 `src/views/NsServices.vue` 中不存在、仅在 `DeployApp.vue:1218-1220` 的这段（已被 PortSelect 的 emptyHint/下拉取代）：

```html
            <p v-if="form.ports.filter(p => p.containerPort).length" class="text-xs text-on-surface-variant mt-sm flex items-center gap-xs">
              <span class="material-symbols-outlined text-xs">arrow_forward</span>容器端口 <span class="font-mono text-primary">{{ form.ports.find(p => p.containerPort)?.containerPort }}</span> 可填入 targetPort
            </p>
```

（紧随其后的 `v-else-if="form.serviceType === 'NodePort'"` 的 NodePort 提示段保留。）

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。

- [ ] **Step 5: 手动验证**

Run: `npm run dev`，进入部署向导，在 Containers 步骤填一个容器端口（如 8080），到 Service 步骤。
Expected：targetPort 下拉出现 8080；选中或手输均可；未填容器端口时浮层显示 emptyHint。

- [ ] **Step 6: 提交**

```bash
git add src/views/DeployApp.vue
git commit -m "feat(ui): 部署向导 Service targetPort 接入 PortSelect（候选来自本地容器端口）"
```

---

### Task 6: 接入 CreateResourceDialog 快速创建

**Files:**
- Modify: `src/components/common/CreateResourceDialog.vue`（import 组件 + store；targetPort input → PortSelect）

**Interfaces:**
- Consumes: `PortSelect`（Task 3）、`store.nsContainerPorts`（Task 2，pinia store 在组件内可直接 `useClusterStore()` 取，`currentNamespace` 已在其中）。

- [ ] **Step 1: 引入组件与 store**

在 `src/components/common/CreateResourceDialog.vue` `<script setup>` 顶部 import 区追加：

```js
import { useClusterStore } from '@/stores/cluster'
import PortSelect from '@/components/common/PortSelect.vue'
const store = useClusterStore()
```

（若该文件已 import store，则跳过重复的 import/实例化，仅确保 `store` 可用。）

- [ ] **Step 2: 替换 Target Port input**

把 `src/components/common/CreateResourceDialog.vue:213` 的：

```html
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Target Port</label><input v-model.number="serviceForm.targetPort" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
```

替换为（移除 `.number` 修饰符，改用 PortSelect）：

```html
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Target Port</label><PortSelect v-model="serviceForm.targetPort" :options="store.nsContainerPorts" placeholder="8080" empty-hint="当前命名空间暂无工作负载暴露容器端口，可直接输入" input-class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
```

- [ ] **Step 3: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误（YAML 预览 `{{ serviceForm.targetPort }}` 对字符串/数字均正常）。

- [ ] **Step 4: 手动验证**

Run: `npm run dev`，打开快速创建对话框，选 Service。
Expected：Target Port 可输可选，下拉为当前 ns containerPort；YAML 预览的 targetPort 跟随。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/CreateResourceDialog.vue
git commit -m "feat(ui): 快速创建 Service targetPort 接入 PortSelect"
```

---

### Task 7: 接入 NsIngress 创建表单（serviceName + servicePort 联动）

**Files:**
- Modify: `src/views/NsIngress.vue`（import 组件；serviceName/servicePort input → PortSelect；servicePort 候选 computed）

**Interfaces:**
- Consumes: `PortSelect`（Task 3）、`store.nsServices`（既有）、`store.getServiceByName(name, ns)`（既有，返回对象的 `.portList`）。

- [ ] **Step 1: 引入组件 + 候选 computed**

在 `src/views/NsIngress.vue` import 区追加：

```js
import PortSelect from '@/components/common/PortSelect.vue'
```

在 `<script setup>` 内（`createForm` 定义之后）追加：

```js
// 当前 ns Service 名候选（serviceName 下拉）
const nsServiceNames = computed(() => store.nsServices.map(s => s.name))
// 选中 Service 暴露的端口候选（servicePort 下拉）；service 不存在/未选时为空，允许手输兜底
const selectedServicePorts = computed(() => {
  const svc = store.getServiceByName(createForm.value.serviceName, route.params.namespace)
  return (svc?.portList || []).map(p => p.port)
})
```

- [ ] **Step 2: 替换 serviceName input**

把 `src/views/NsIngress.vue:252` 的：

```html
          <input v-model="createForm.serviceName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="my-service" />
```

替换为：

```html
          <PortSelect v-model="createForm.serviceName" :options="nsServiceNames" placeholder="my-service" empty-hint="当前命名空间暂无 Service，可直接输入" input-class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
```

- [ ] **Step 3: 替换 servicePort input**

把 `src/views/NsIngress.vue:256` 的：

```html
          <input v-model="createForm.servicePort" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="80" />
```

替换为：

```html
          <PortSelect v-model="createForm.servicePort" :options="selectedServicePorts" placeholder="80" empty-hint="选择 Service 后显示其端口，也可直接输入" input-class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
```

> 说明：`createForm.servicePort` 为字符串，`handleCreate`（`NsIngress.vue:69`）已用 `parseInt(f.servicePort)`，手输/选中均兼容，**不改 handleCreate**。

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。

- [ ] **Step 5: 手动验证**

Run: `npm run dev`，进入某 ns 的 Ingress 页，点创建。
Expected：
- Backend Service 下拉为当前 ns 的 Service 名；选中后 Service Port 下拉切换为该 Service 的端口。
- 切换 Service 时已填的 servicePort 保留（不清空），仅更新候选。
- 两者均可手输（跨 ns service 名/自定义端口）。
- 提交创建成功，路由 backend 端口正确。

- [ ] **Step 6: 提交**

```bash
git add src/views/NsIngress.vue
git commit -m "feat(ui): Ingress 创建 serviceName/servicePort 接入 PortSelect 并联动"
```

---

### Task 8: 接入 NsIngressDetail 编辑路由（每行联动）

**Files:**
- Modify: `src/views/NsIngressDetail.vue`（import 组件；每行 serviceName/servicePort input → PortSelect；端口候选 helper）

**Interfaces:**
- Consumes: `PortSelect`（Task 3）、`store.nsServices`、`store.getServiceByName`。每行 `r.serviceName` 不同，servicePort 候选需按行计算（模板内调用 helper）。

- [ ] **Step 1: 引入组件 + helper**

在 `src/views/NsIngressDetail.vue` import 区追加：

```js
import PortSelect from '@/components/common/PortSelect.vue'
```

在 `<script setup>` 内（`editRules` 相关函数附近）追加：

```js
// 当前 ns Service 名候选（每行 serviceName 下拉）
const nsServiceNames = computed(() => store.nsServices.map(s => s.name))
// 按行 serviceName 取其暴露端口（每行 servicePort 候选）；service 不存在时为空，允许手输
function portsFor(serviceName) {
  const svc = store.getServiceByName(serviceName, route.params.namespace)
  return (svc?.portList || []).map(p => p.port)
}
```

- [ ] **Step 2: 替换每行 serviceName input**

把 `src/views/NsIngressDetail.vue:436` 的：

```html
            <td class="px-md py-sm"><input v-model="r.serviceName" class="w-32 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="my-svc" /></td>
```

替换为：

```html
            <td class="px-md py-sm"><PortSelect v-model="r.serviceName" :options="nsServiceNames" placeholder="my-svc" empty-hint="当前命名空间暂无 Service，可直接输入" input-class="w-32 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" /></td>
```

- [ ] **Step 3: 替换每行 servicePort input**

把 `src/views/NsIngressDetail.vue:437` 的：

```html
            <td class="px-md py-sm"><input v-model="r.servicePort" class="w-20 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="80" /></td>
```

替换为：

```html
            <td class="px-md py-sm"><PortSelect v-model="r.servicePort" :options="portsFor(r.serviceName)" placeholder="80" empty-hint="选择 Service 后显示其端口，也可直接输入" input-class="w-20 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" /></td>
```

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。

- [ ] **Step 5: 手动验证**

Run: `npm run dev`，进入某 Ingress 详情，打开 Rules 编辑器。
Expected：
- 每行 serviceName 回填并可下拉（当前 ns Service 名）。
- 每行 servicePort 候选随该行 serviceName 变化；改选 serviceName 后该行 servicePort 候选更新（已填值保留）。
- 保存后远端 PATCH 的 rules backend 端口正确。

- [ ] **Step 6: 提交**

```bash
git add src/views/NsIngressDetail.vue
git commit -m "feat(ui): Ingress 路由编辑每行 serviceName/servicePort 接入 PortSelect 并按行联动"
```

---

## Self-Review（计划编写后自检，已修正）

- **Spec coverage**：spec 的 4 处 Service targetPort（Task 3/4/5/6）、2 处 Ingress serviceName+servicePort（Task 7/8）、`nsContainerPorts`（Task 2）、`PortSelect`（Task 3）、联动不清空（Task 7/5 步骤说明）、ExternalName 不动（Global Constraints）——均覆盖。YAML 层不改（Global Constraints）。
- **Placeholder scan**：无 TBD/TODO；每个代码步骤均给出可执行的精确 old/new。
- **Type consistency**：`extractContainerPorts`（Task 1）→ store `nsContainerPorts`（Task 2）→ 各表单 `:options="store.nsContainerPorts"`（Task 3/4/6）；`PortSelect` props（Task 3）与各接入任务用法一致；`portList[].port` 字段名与 `mapService` 一致。
- **DeployApp 候选来源**已在 Task 5 明确为本地 `form.ports`（非 store），与 spec 一致。
