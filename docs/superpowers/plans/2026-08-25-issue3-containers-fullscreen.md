# issue #3 收尾两项实施计划(init/sidecar 解挤 + 全屏创建/编辑)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修 issue #3 第 4/6 点:DeployApp init/sidecar 容器区纵向堆叠+可折叠全宽编辑;Modal 支持 fullscreen,Secret/ConfigMap 创建全屏化(表单/YAML 双 tab);Secret 详情值编辑改宽。

**Architecture:** 新组件 InitSideContainerEditor(字段直接 v-model 行对象,契约仿 IngressRulesEditor;v-show 展开保 testid 常驻 DOM);Modal 加 `fullscreen` prop(非 fullscreen 走原 DOM 零回归);创建弹窗加局部 tab + 手拼 YAML 只读预览(值经 yamlScalar;NsSecrets 的表单→data 映射从 handleCreate 抽函数共用,防漂移)。

**Tech Stack:** Vue 3 组合式 + Tailwind v3 + vitest/happy-dom + @vue/test-utils + vue-i18n(zh/en)。

**Spec:** `docs/superpowers/specs/2026-08-25-issue3-containers-fullscreen-design.md`(537bec7)

## Global Constraints

- **开工先 EnterWorktree**(分支 `worktree-fix-issue3-containers-fs`);每 Task 结束 commit;commit 前 `git branch --show-current` 复核
- 不新增外部依赖(CLAUDE.md 依赖政策)
- 新文案 zh/en 双语同步(`src/locales/zh.json`/`en.json`),过 `npm run i18n:check`;本批键无 `@` 无 HTML
- 既有测试 `src/views/__tests__/DeployApp.command-args.test.js:69-73` 断言 `[data-testid="init|sidecar-command|args-input"]` **存在于 DOM**——新组件展开态必须 `v-show`(非 v-if)且 testid 原值保留
- 组件测试模板:`global: { plugins: [i18n(+pinia/createPinia() 若组件用 store)] }`;Modal 系测试已有 `afterEach(() => { document.body.innerHTML = '' })`
- docs/ 下提交须 `git add -f`
- 并行会话可能在跑 vitest:失败若全为 timeout 型先 `pgrep -af vitest` 查串扰,机器安静再复跑定论

---

### Task 1: Modal `fullscreen` prop

**Files:**
- Modify: `src/components/common/Modal.vue`(props :9-13 + template :38-53)
- Test: `src/components/common/__tests__/Modal.test.js`(追加用例)

**Interfaces:**
- Consumes: 既有 `Z.modal`(zScale)
- Produces: Modal 新 prop `fullscreen: Boolean`(Task 4 消费);非 fullscreen 输出与现状 DOM 视觉等价

- [ ] **Step 1: 追加失败测试(Modal.test.js 末尾)**

```js
test('Modal: fullscreen 态铺满视口+分区滚动;非 fullscreen 原布局不变', () => {
  const w = mount(Modal, {
    props: { modelValue: true, title: 't', fullscreen: true },
    global: { plugins: [i18n] },
    slots: { default: '<p>x</p>', actions: '<button>a</button>' },
  })
  const overlay = document.querySelector('body div.fixed.inset-0')
  const dialog = overlay.querySelector('div.relative')
  expect(dialog.className).toContain('w-screen')
  expect(dialog.className).toContain('h-screen')
  expect(dialog.className).toContain('rounded-none')
  expect(dialog.querySelector('div.flex-1.overflow-y-auto')).toBeTruthy()  // 内容区独立滚动
  w.unmount()

  const w2 = mount(Modal, { props: { modelValue: true, title: 't' }, global: { plugins: [i18n] } })
  const dialog2 = document.querySelector('body div.fixed.inset-0 div.relative')
  expect(dialog2.className).toContain('max-h-[90vh]')
  expect(dialog2.className).toContain('rounded-xl')
  w2.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/Modal.test.js`
Expected: FAIL(无 fullscreen prop,dialog 类不含 w-screen)

- [ ] **Step 3: 实现(Modal.vue)**

props 块加一行:

```js
  fullscreen: { type: Boolean, default: false },
```

template 的 Dialog div(:39-53)整体替换为:

```vue
        <div :class="fullscreen
            ? 'w-screen h-screen max-w-none rounded-none flex flex-col'
            : [width, 'max-h-[90vh] overflow-y-auto p-lg rounded-xl']"
          class="relative w-full bg-surface-container-lowest border border-outline-variant shadow-dropdown z-10 animate-slide-up">
          <div v-if="title" class="flex justify-between items-center" :class="fullscreen ? 'shrink-0 px-lg py-md border-b border-outline-variant' : 'mb-lg'">
            <h3 class="text-headline-sm font-bold">{{ title }}</h3>
            <button @click="close" class="p-1 text-on-surface-variant hover:bg-surface-container rounded-lg">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
          <div :class="fullscreen ? 'flex-1 overflow-y-auto p-lg' : ''"><slot /></div>
          <div v-if="$slots.actions" class="flex justify-end gap-md" :class="fullscreen ? 'shrink-0 px-lg py-md border-t border-outline-variant' : 'mt-lg pt-md border-t border-outline-variant'">
            <slot name="actions">
              <button @click="close" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('component.modal.cancel') }}</button>
              <button @click="confirm" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold">{{ t('component.modal.confirm') }}</button>
            </slot>
          </div>
        </div>
```

- [ ] **Step 4: 跑测试确认通过(含既有 2 用例)**

Run: `npx vitest run src/components/common/__tests__/Modal.test.js`
Expected: PASS 3/3

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/components/common/Modal.vue src/components/common/__tests__/Modal.test.js
git commit -m "feat(modal): fullscreen prop——铺满视口+标题/内容/操作三区粘性布局(非 fullscreen 零回归)"
```

---

### Task 2: InitSideContainerEditor 组件

**Files:**
- Create: `src/components/common/InitSideContainerEditor.vue`
- Modify: `src/locales/zh.json`/`en.json`(`deploy` 对象内加 3 键)
- Test: `src/components/common/__tests__/InitSideContainerEditor.test.js`(新建)

**Interfaces:**
- Consumes: `ResourceInput`(`v-model` 承载规范串如 "4000m"/"512Mi",props: modelValue/kind('cpu'|'memory')/placeholder)
- Produces: 组件 props `{ container: Object, kind: 'init'|'sidecar' }` + emit `remove`(无参,父级按 index 删);字段直接 v-model container 行对象(`name/image/command/args/cpuRequest/cpuLimit/memoryRequest/memoryLimit`);testid `{init|sidecar}-command-input`/`-args-input`(Task 3 消费)

- [ ] **Step 1: i18n 键(zh.json `deploy` 对象内任意既有键后;两文件同步)**

zh:
```json
"initBadge": "Init",
"sidecarBadge": "Sidecar",
"unnamedContainer": "未命名容器",
```
en:
```json
"initBadge": "Init",
"sidecarBadge": "Sidecar",
"unnamedContainer": "Unnamed",
```

- [ ] **Step 2: 写失败测试**

```js
// src/components/common/__tests__/InitSideContainerEditor.test.js
// issue #3 容器区解挤:init/sidecar 共用折叠卡。契约:字段直接 v-model 行对象;
// 展开态 v-show 保 DOM(DeployApp.command-args.test 断言 testid 常驻)。
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import InitSideContainerEditor from '@/components/common/InitSideContainerEditor.vue'

const ROW = { name: 'probe', image: 'busybox:1', command: 'sh', args: '-c echo hi', cpuRequest: '100m', cpuLimit: '', memoryRequest: '128Mi', memoryLimit: '' }

function mountCard(props = {}) {
  return mount(InitSideContainerEditor, { props: { container: { ...ROW }, kind: 'init', ...props }, global: { plugins: [i18n] } })
}

test('已命名容器默认折叠:摘要行含 name/image/资源摘要;编辑器在 DOM 但不可见(v-show)', () => {
  const w = mountCard()
  expect(w.text()).toContain('probe')
  expect(w.text()).toContain('busybox:1')
  expect(w.text()).toContain('100m · 128Mi')
  const cmd = w.find('[data-testid="init-command-input"]')
  expect(cmd.exists()).toBe(true)          // DOM 常驻
  expect(cmd.isVisible()).toBe(false)      // 折叠隐藏
})

test('点击摘要条切换展开;空容器(name 空)自动展开', async () => {
  const w = mountCard()
  await w.find('button').trigger('click')
  expect(w.find('[data-testid="init-command-input"]').isVisible()).toBe(true)
  await w.find('button').trigger('click')
  expect(w.find('[data-testid="init-command-input"]').isVisible()).toBe(false)

  const w2 = mountCard({ container: { ...ROW, name: '' } })
  expect(w2.find('[data-testid="init-command-input"]').isVisible()).toBe(true)
})

test('字段直接回写行对象(v-model 行对象契约)+ remove emit + sidecar testid', async () => {
  const row = { ...ROW }
  const w = mountCard({ container: row })
  await w.find('button').trigger('click')
  await w.find('[data-testid="init-command-input"]').setValue('envoy')
  expect(row.command).toBe('envoy')        // 父级数组内同一对象被改
  await w.findAll('span.material-symbols-outlined').filter(s => s.text() === 'delete').at(-1).trigger('click')
  expect(w.emitted('remove')).toBeTruthy()

  const w2 = mountCard({ container: { ...ROW }, kind: 'sidecar' })
  expect(w2.find('[data-testid="sidecar-command-input"]').exists()).toBe(true)
  expect(w2.find('[data-testid="sidecar-args-input"]').element.tagName).toBe('TEXTAREA')
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/InitSideContainerEditor.test.js`
Expected: FAIL(组件不存在)

- [ ] **Step 4: 实现组件**

```vue
<script setup>
// init/sidecar 容器共用编辑卡:折叠摘要 + 展开全宽编辑。契约仿 IngressRulesEditor——
// 字段直接 v-model 行对象(父级持有数组,对象引用共享);remove 由父级按 index 删。
// 展开态 v-show(非 v-if):DeployApp.command-args.test.js 断言 data-testid 常驻 DOM。
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ResourceInput from './ResourceInput.vue'

const props = defineProps({
  container: { type: Object, required: true },
  kind: { type: String, default: 'init' },  // 'init' | 'sidecar'
})
const emit = defineEmits(['remove'])
const { t } = useI18n()

// 新添加的空容器自动展开;已命名的默认折叠(总览紧凑)
const expanded = ref(props.container.name === '')
const resSummary = computed(() =>
  ['cpuRequest', 'cpuLimit', 'memoryRequest', 'memoryLimit']
    .map(k => props.container[k]).filter(Boolean).join(' · '))
const tid = suffix => (props.kind === 'init' ? 'init' : 'sidecar') + '-' + suffix
</script>

<template>
  <div class="border border-outline-variant rounded-lg bg-surface-container-low/30">
    <!-- 摘要条:点击整条切换展开 -->
    <button type="button" data-test="container-summary" @click="expanded = !expanded"
      class="w-full flex items-center gap-sm px-sm py-1.5 text-left rounded-lg hover:bg-surface-container-low transition-colors">
      <span class="material-symbols-outlined text-base text-on-surface-variant shrink-0 transition-transform duration-150" :class="expanded ? 'rotate-90' : ''">expand_more</span>
      <span class="shrink-0 px-sm py-xs rounded-full text-xs font-semibold"
        :class="kind === 'init' ? 'bg-primary-container/20 text-primary' : 'bg-tertiary-container/20 text-tertiary-container'">
        {{ kind === 'init' ? t('deploy.initBadge') : t('deploy.sidecarBadge') }}
      </span>
      <span class="font-mono text-xs font-semibold truncate min-w-0" :class="container.name ? 'text-on-surface' : 'text-on-surface-variant/60'">{{ container.name || t('deploy.unnamedContainer') }}</span>
      <span class="font-mono text-xs text-on-surface-variant truncate min-w-0 hidden sm:inline">{{ container.image }}</span>
      <span v-if="resSummary" class="font-mono text-[10px] text-on-surface-variant/70 shrink-0 hidden md:inline">{{ resSummary }}</span>
      <span class="ml-auto shrink-0 flex items-center">
        <span @click.stop="emit('remove')" class="p-xs text-on-surface-variant/60 hover:text-error rounded-lg" :title="t('deploy.removeContainer')"><span class="material-symbols-outlined text-base">delete</span></span>
      </span>
    </button>
    <!-- 编辑器(v-show 保 DOM/testid) -->
    <div v-show="expanded" class="px-sm pb-sm pt-xs flex flex-col gap-sm">
      <div class="flex gap-sm">
        <input v-model="container.name" class="w-40 bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" :placeholder="kind === 'init' ? 'init name' : 'sidecar name'" />
        <input v-model="container.image" class="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="image" />
      </div>
      <div class="grid grid-cols-[minmax(9rem,auto)_1fr] gap-sm">
        <input :data-testid="tid('command-input')" v-model="container.command" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" placeholder="sh -c" />
        <textarea :data-testid="tid('args-input')" v-model="container.args" rows="4" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-xs font-mono resize-y" :placeholder="t('deploy.argsHint')" />
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-sm">
        <ResourceInput v-model="container.cpuRequest" kind="cpu" placeholder="cpu req" />
        <ResourceInput v-model="container.cpuLimit" kind="cpu" placeholder="cpu lim" />
        <ResourceInput v-model="container.memoryRequest" kind="memory" placeholder="mem req" />
        <ResourceInput v-model="container.memoryLimit" kind="memory" placeholder="mem lim" />
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/InitSideContainerEditor.test.js`
Expected: PASS 3/3

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add src/components/common/InitSideContainerEditor.vue src/components/common/__tests__/InitSideContainerEditor.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(deploy): InitSideContainerEditor——init/sidecar 共用折叠编辑卡(v-show 保 testid,v-model 行对象)"
```

---

### Task 3: DeployApp 接线(纵向堆叠)

**Files:**
- Modify: `src/views/DeployApp.vue`(:1092-1155 双列 grid 区 + import 区)

**Interfaces:**
- Consumes: Task 2 组件(props `container`/`kind`,emit `remove`);既有 `addInitContainer/addExtraContainer/removeInitContainer/removeExtraContainer` 与 `form.initContainers/extraContainers` 模型不动
- Produces: 无(表单模型/Step 6 previewYAML 零改动)

- [ ] **Step 1: 接线**

script import 区(DeployApp 组件 import 处)加:

```js
import InitSideContainerEditor from '@/components/common/InitSideContainerEditor.vue'
```

template :1092-1155 整块(注释 `<!-- 初始化 / 额外容器:左右并排 -->` 起,至 sidecar 块 `</div>` 止)替换为:

```vue
        <!-- 初始化 / 额外容器:纵向堆叠,全宽可折叠卡(issue #3 第 4 点) -->
        <div class="flex flex-col gap-md mt-md">
          <!-- 初始容器 (Init) -->
          <div :class="['rounded-lg p-md', form.initContainers.length ? 'border border-outline-variant bg-surface-container-low/30' : 'border border-dashed border-outline-variant']">
            <div class="flex items-center gap-sm mb-xs text-primary">
              <span class="material-symbols-outlined text-base">restart_alt</span>
              <h4 class="text-body-sm font-semibold">{{ $t('deploy.initContainers') }}</h4>
              <span class="px-sm py-xs rounded-full bg-primary-container/20 text-primary text-xs font-semibold">{{ form.initContainers.length }}</span>
            </div>
            <div class="flex flex-col gap-sm">
              <InitSideContainerEditor v-for="(c, idx) in form.initContainers" :key="'ic'+idx" :container="c" kind="init" @remove="removeInitContainer(idx)" />
              <button @click="addInitContainer" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
                <span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addInitContainer') }}
              </button>
            </div>
          </div>

          <!-- 额外工作容器 (Sidecar) -->
          <div :class="['rounded-lg p-md', form.extraContainers.length ? 'border border-outline-variant bg-surface-container-low/30' : 'border border-dashed border-outline-variant']">
            <div class="flex items-center gap-sm mb-xs text-primary">
              <span class="material-symbols-outlined text-base">widgets</span>
              <h4 class="text-body-sm font-semibold">{{ $t('deploy.sidecarContainers') }}</h4>
              <span class="px-sm py-xs rounded-full bg-primary-container/20 text-primary text-xs font-semibold">{{ form.extraContainers.length }}</span>
            </div>
            <div class="flex flex-col gap-sm">
              <InitSideContainerEditor v-for="(c, idx) in form.extraContainers" :key="'ec'+idx" :container="c" kind="sidecar" @remove="removeExtraContainer(idx)" />
              <button @click="addExtraContainer" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
                <span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addSidecarContainer') }}
              </button>
            </div>
          </div>
        </div>
```

(原块的 ResourceInput import 若仅此处使用可留——DeployApp 主容器区也用,不动。)

- [ ] **Step 2: 验证(既有测试是本任务的验收)**

Run: `npx vitest run src/views/__tests__/DeployApp.command-args.test.js && npx vitest run src/components/common/__tests__/InitSideContainerEditor.test.js && npm run build 2>&1 | tail -1`
Expected: command-args 全过(testid 断言靠 v-show 保 DOM)+ 组件 3/3 + build 成功

- [ ] **Step 3: Commit**

```bash
git branch --show-current
git add src/views/DeployApp.vue
git commit -m "feat(deploy): init/sidecar 区纵向堆叠换 InitSideContainerEditor——每卡全宽(~850px),折叠摘要总览(issue #3 第 4 点)"
```

---

### Task 4: Secret/ConfigMap 创建全屏化(表单/YAML tab)

**Files:**
- Modify: `src/views/NsSecrets.vue`(script handleCreate 抽函数 + template Modal)
- Modify: `src/views/NsConfigMaps.vue`(同型)
- Modify: `src/locales/zh.json`/`en.json`(4 键)

**Interfaces:**
- Consumes: Task 1 Modal `fullscreen` prop;`yamlScalar` from `@/composables/useYaml`(签名 `yamlScalar(v: string): string`)
- Produces: 无

- [ ] **Step 1: i18n 键(zh.json:`ns.secrets` 对象内加 2 键 + `ns.configmaps` 对象内加 2 键;两文件同步)**

zh:
```json
"tabForm": "表单",
"tabYaml": "YAML",
```
(en.json 同位置同键,值 `"Form"` / `"YAML"`;分别加进 ns.secrets 与 ns.configmaps 两个对象)

- [ ] **Step 2: NsSecrets.vue script 改造**

import 区加:

```js
import { yamlScalar } from '@/composables/useYaml'
```

`const createForm = ref({...})` 之后加:

```js
const createTab = ref('form')  // 'form' | 'yaml'
```

把 `handleCreate` 里 `let data = {}` 到 `data = { 'ssh-privatekey': f.sshKey } }` 的整段映射逻辑抽成独立函数(handleCreate 改为调用它,映射代码逐行照搬不改动):

```js
// 表单 → stringData 映射(创建与 YAML 预览共用,防两处漂移)
function createSecretData(f) {
  let data = {}
  if (f.type === 'Opaque') {
    f.keys.forEach(k => { if (k.key) data[k.key] = k.value })
  } else if (f.type === 'kubernetes.io/basic-auth') {
    data = { username: f.username, password: f.password }
  } else if (f.type === 'kubernetes.io/dockerconfigjson') {
    let auth = ''
    try { auth = btoa(`${f.registryUser}:${f.registryPassword}`) } catch (e) { auth = `${f.registryUser}:${f.registryPassword}` }
    const cfg = { auths: { [f.registry]: { username: f.registryUser, password: f.registryPassword, email: f.registryEmail, auth } } }
    data = { '.dockerconfigjson': JSON.stringify(cfg) }
  } else if (f.type === 'kubernetes.io/tls') {
    data = { 'tls.crt': f.tlsCrt, 'tls.key': f.tlsKey }
  } else if (f.type === 'kubernetes.io/ssh-auth') {
    data = { 'ssh-privatekey': f.sshKey }
  }
  return data
}
```

handleCreate 内原映射段替换为一行 `const data = createSecretData(f)`,其余不变。再加 YAML 预览 computed:

```js
const createYaml = computed(() => {
  const f = createForm.value
  const data = createSecretData(f)
  const lines = ['apiVersion: v1', 'kind: Secret', 'metadata:', `  name: ${f.name || 'my-secret'}`, `  namespace: ${route.params.namespace}`, `type: ${f.type}`, 'stringData:']
  Object.entries(data).forEach(([k, v]) => lines.push(`  ${k}: ${yamlScalar(v)}`))
  return lines.join('\n')
})
```

(`computed` 已在 vue import 中,缺则补。)

- [ ] **Step 3: NsSecrets.vue template 改造**

创建 Modal 开标签(:246)改为:

```vue
  <Modal v-model="showCreateModal" :title="t('ns.secrets.createTitle')" fullscreen>
```

Modal 内容结构:原 `<div class="flex flex-col gap-md">…全部类型字段…</div>` 外面改包 tab(原字段 div 加 v-show,字段逐行不动):

```vue
    <div class="flex items-center gap-md border-b border-outline-variant mb-md">
      <button v-for="tb in [{ k: 'form', l: t('ns.secrets.tabForm') }, { k: 'yaml', l: t('ns.secrets.tabYaml') }]" :key="tb.k" @click="createTab = tb.k"
        class="px-md py-sm text-body-sm font-medium border-b-2 -mb-px transition-colors"
        :class="createTab === tb.k ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface'">{{ tb.l }}</button>
    </div>
    <div v-show="createTab === 'form'" class="flex flex-col gap-md">
      …原全部类型字段(name/type/Opaque/basic-auth/docker/tls/ssh 各 v-if 块,逐行照搬)…
    </div>
    <pre v-show="createTab === 'yaml'" class="font-mono text-xs whitespace-pre-wrap text-on-surface bg-surface-container-low rounded-lg p-md">{{ createYaml }}</pre>
```

`<template #actions>` 两个按钮不动。

- [ ] **Step 4: NsConfigMaps.vue 同型改造**

script:import yamlScalar;`const createTab = ref('form')`;加 computed:

```js
const createYaml = computed(() => {
  const f = createForm.value
  const data = {}
  f.keys.forEach(k => { if (k.key) data[k.key] = k.value })
  const lines = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', `  name: ${f.name || 'my-cm'}`, `  namespace: ${route.params.namespace}`, 'data:']
  Object.entries(data).forEach(([k, v]) => lines.push(`  ${k}: ${yamlScalar(v)}`))
  return lines.join('\n')
})
```

template(:178 起):Modal 开标签改 `fullscreen`;内容同 Step 3 的 tab 包法(`ns.configmaps.tabForm/tabYaml`,表单 div 加 v-show,YAML pre 用上面 computed)。

- [ ] **Step 5: 验证**

Run: `npm run i18n:check && npx vitest run && npm run build 2>&1 | tail -1`
Expected: i18n 过、全量测试过(注意 Global Constraints 的并行串扰条款)、build 成功

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add src/views/NsSecrets.vue src/views/NsConfigMaps.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(secret/cm): 创建弹窗全屏化+表单/YAML 双 tab——映射抽函数共用,预览 yamlScalar 转义(issue #3 第 6 点)"
```

---

### Task 5: Secret 详情编辑改宽

**Files:**
- Modify: `src/views/NsSecretDetail.vue`(data 行内编辑块 :282-289 + 加键 Modal)

**Interfaces:**
- Consumes: 无新接口
- Produces: 无

- [ ] **Step 1: 行内编辑 input → textarea(:282-289 的编辑分支)**

原:

```vue
            <div v-if="editingKey === key" class="flex gap-sm">
              <input v-model="editValue" type="text" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
              <div class="flex gap-xs">
```

改为(textarea + 按钮区 shrink-0,save/cancel 按钮原样):

```vue
            <div v-if="editingKey === key" class="flex gap-sm">
              <textarea v-model="editValue" class="flex-1 min-h-[80px] resize-y bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary"></textarea>
              <div class="flex gap-xs shrink-0">
```

- [ ] **Step 2: 加键 Modal(:391 起 `<Modal v-model="showAddKeyModal"`)两处**

width:`width="max-w-lg"` → `width="max-w-2xl"`;value 字段:

```vue
        <input v-model="newValue" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="secret value..." />
```

改为:

```vue
        <textarea v-model="newValue" class="w-full min-h-[100px] resize-y bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="secret value..."></textarea>
```

- [ ] **Step 3: 验证(无独立单测,以门禁代行)**

Run: `npx vitest run && npm run build 2>&1 | tail -1`
Expected: 全量过 + build 成功

- [ ] **Step 4: Commit**

```bash
git branch --show-current
git add src/views/NsSecretDetail.vue
git commit -m "feat(secret): 详情值编辑改宽 textarea + 加键弹窗 max-w-2xl(证书/长值舒适编辑,issue #3 第 6 点)"
```

---

### Task 6: 门禁四连 + 终审 + 合并推送(控制器执行,不派实现者)

- [ ] **Step 1:** `npm run test:unit && npm test && npm run typecheck && npm run build`(并行串扰条款适用;干净窗口全绿为准)
- [ ] **Step 2:** 全分支终审(SDD 流程,review-package MERGE_BASE..HEAD)
- [ ] **Step 3:** 主 checkout `merge --ff-only` + `push origin main`(若 main 被并行会话推进:零重叠则 merge main 入分支→定向 sanity→再 ff)
- [ ] **Step 4:** 手测清单交付(见 spec 验证节 4 条)

## Self-Review 记录

- 覆盖:spec ④→Task 2+3;⑥a→Task 1+4;⑥b→Task 5;验证→Task 6 ✓
- 占位:无(所有代码完整;NsSecrets 模板「逐行照搬」指原字段块不动,锚点明确)✓
- 类型一致:`fullscreen` prop(Task 1 产出=Task 4 消费);`container/kind/remove`(Task 2 产出=Task 3 消费);`yamlScalar(v)` 签名与仓库一致 ✓
