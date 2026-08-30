# 「从 YAML 创建」弹窗支持最大化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通用「从 YAML 创建」弹窗(Service 等 12+ 入口共用)启用 Modal 最大化,YAML 编辑器最大化时弹性填满内容区。

**Architecture:** `CreateFromYamlDialog` 传 `maximizable` + `#default="{ maximized }"`(照抄 `CreateConfigResourceModal` 既定模式);`YamlEditor` 加**可选** `heightClass` prop(镜像 `CodeTextarea` 同名 API),不传行为零变化,传入时内部 flex 填充。

**Tech Stack:** Vue 3 + vitest + @vue/test-utils(happy-dom)。

**Spec:** `docs/superpowers/specs/2026-08-30-yaml-dialog-maximize-design.md`

## Global Constraints

- **不传 `heightClass` = 现行为逐字节不变**——`YamlEditor` 有 33 个既有消费方,回归零容忍。
- Modal 是 Teleport:测试断言一律查 `document.body` / `document.querySelector`,不查组件 wrapper。
- happy-dom 测不出真实 rect:只断言 class/结构/`data-testid`,不断言像素。
- i18n 零新增(最大化/还原按钮键 `component.modal.maximize` / `restore` 已存在)。
- 最大化/还原按钮 testid:`modal-maximize-btn` / `modal-restore-btn`(Modal.vue 已有,勿重复造)。
- 不动:YamlEditor 的 diff 模式、NsServices 表单弹窗、弹窗默认宽度 `max-w-3xl`。
- 提交命令:`git -c commit.gpgsign=false commit --author="aliangone <aliangone@gmail.com>" -m "<msg>"`;禁 Claude 尾注。
- 分支 `feat/yaml-dialog-maximize`;开工前 `git branch --show-current` 确认。

---

### Task 1: YamlEditor 可选 `heightClass` prop

**Files:**
- Modify: `src/components/common/YamlEditor.vue`
- Test: `src/components/common/__tests__/YamlEditor.test.js`

**Interfaces:**
- Consumes: 无(独立组件契约扩展)。
- Produces: `heightClass: { type: String, default: '' }`——传入时根元素挂该 class,单模式视图容器(`data-testid="yaml-view"`)变 `flex-1 min-h-0 flex flex-col`,CodeViewer `maxHeight='100%'` + `flex-1 min-h-0`,编辑态 textarea `flex-1 min-h-0` 且无固定 min/max-height。Task 2 以 `:height-class="maximized ? 'flex-1 min-h-0' : ''"` 消费。

- [ ] **Step 1: 写失败测试**

在 `src/components/common/__tests__/YamlEditor.test.js` 末尾追加:

```js
test('YamlEditor: 未传 heightClass 行为不变(根无填充类,textarea 固定 min/max-height)', async () => {
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'kind: Service\n', readonly: false, height: '420px' },
    global: { plugins: [i18n] },
  })
  expect(wrapper.find('textarea').exists()).toBe(false)
  await wrapper.find('button').trigger('click') // 工具栏首按钮 = Edit,进入编辑态
  const ta = wrapper.find('textarea')
  expect(ta.classes()).not.toContain('flex-1')
  expect(ta.attributes('style')).toContain('420px')
  expect(wrapper.find('[data-testid="yaml-view"]').classes()).not.toContain('flex-1')
  wrapper.unmount()
})

test('YamlEditor: 传 heightClass → 根挂类,视图区 flex 填充,textarea 撑满非固定高', async () => {
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'kind: Service\n', readonly: false, height: '420px', heightClass: 'flex-1 min-h-0' },
    global: { plugins: [i18n] },
  })
  // 根元素挂上传的 class
  expect(wrapper.element.className).toContain('min-h-0')
  // 查看态:视图容器获得填充类
  const view = wrapper.find('[data-testid="yaml-view"]')
  expect(view.classes()).toContain('flex-1')
  expect(view.classes()).toContain('flex')
  await wrapper.find('button').trigger('click')
  const ta = wrapper.find('textarea')
  expect(ta.classes()).toContain('flex-1')
  expect(ta.classes()).toContain('min-h-0')
  expect(ta.attributes('style') ?? '').not.toContain('420px')
  wrapper.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/YamlEditor.test.js`
Expected: 新增第 2 个测试 FAIL(根元素无 `min-h-0` 类;`yaml-view` 无 `flex-1`);第 1 个可能 PASS(现状即满足,作回归守卫)

- [ ] **Step 3: 实现**

`src/components/common/YamlEditor.vue` 三处改动:

① props 增加(在 `originalValue` 之后):

```js
  // 传入时根元素挂该 class 且内部单模式视图区改 flex 填充(供最大化弹窗用);
  // 不传 = 行为与固定 height 模式完全一致。与 CodeTextarea 的 heightClass 契约镜像。
  heightClass: { type: String, default: '' },
```

② 模板根元素加动态 class 与专用 testid:

```html
  <div data-testid="yaml-editor-root" class="flex flex-col rounded-lg overflow-hidden border border-outline-variant" :class="heightClass">
```

③ Single Mode 区块整体替换为:

```html
    <!-- Single Mode -->
    <div v-else data-testid="yaml-view" :class="heightClass ? 'flex-1 min-h-0 flex flex-col' : ''">
      <!-- 查看模式（默认）：CodeViewer YAML 高亮 -->
      <CodeViewer v-if="!isEditing" :code="editableContent" lang="yaml"
        :class="heightClass ? 'flex-1 min-h-0' : ''" :max-height="heightClass ? '100%' : height" />
      <!-- 编辑模式：textarea -->
      <textarea v-else v-model="editableContent"
        :class="['w-full bg-code-surface text-on-code-surface p-md font-mono text-code-sm outline-none border-0 resize-y', heightClass ? 'flex-1 min-h-0' : '']"
        :style="heightClass ? undefined : { minHeight: height, maxHeight: height }"></textarea>
    </div>
```

(Diff Mode 区块与其余部分一律不动。)

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/components/common/__tests__/YamlEditor.test.js`
Expected: 全部 PASS(含既有用例)

- [ ] **Step 5: 提交**

```bash
git add src/components/common/YamlEditor.vue src/components/common/__tests__/YamlEditor.test.js
git -c commit.gpgsign=false commit --author="aliangone <aliangone@gmail.com>" -m "feat(ui): YamlEditor 可选 heightClass——传入时视图区 flex 填充(不传零变化)"
```

---

### Task 2: CreateFromYamlDialog 启用最大化

**Files:**
- Modify: `src/components/common/CreateFromYamlDialog.vue`
- Test: `src/components/common/__tests__/CreateFromYamlDialog.test.js`

**Interfaces:**
- Consumes: Task 1 的 `heightClass` 契约;`Modal.vue` 既有 `maximizable` prop / `modal-maximize-btn` / `modal-restore-btn` testid / `#default="{ maximized }"` slot。
- Produces: 「从 YAML 创建」弹窗最大化行为(用户可见)。无新导出。

- [ ] **Step 1: 写失败测试**

`src/components/common/__tests__/CreateFromYamlDialog.test.js` — 顶部 vitest import 行补 `nextTick`(改为 `import { nextTick } from 'vue'` 新增一行即可,现有 import 不动),文件末尾追加:

```js
test('最大化:按钮存在,最大化后内容根 h-full + 编辑器 flex 填充,可还原', async () => {
  const w = mount(CreateFromYamlDialog, { props: { modelValue: true, namespace: 'demo', kind: 'Service' }, global: { plugins: [createPinia(), i18n] } })
  const maxBtn = () => document.querySelector('[data-testid="modal-maximize-btn"], [data-testid="modal-restore-btn"]')
  expect(maxBtn()).not.toBe(null)
  maxBtn().click(); await nextTick()
  // 最大化态:内容根挂 h-full;YamlEditor 根获得 heightClass 的填充类
  const contentRoot = document.querySelector('[data-testid="yaml-dialog-content"]')
  expect(contentRoot).not.toBe(null)
  expect(contentRoot.className).toContain('h-full')
  const yamlRoot = contentRoot.querySelector('[data-testid="yaml-editor-root"]')
  expect(yamlRoot.className).toContain('flex-1')
  // 还原
  maxBtn().click(); await nextTick()
  expect(document.querySelector('[data-testid="modal-maximize-btn"]')).not.toBe(null)
  expect(contentRoot.className).not.toContain('h-full')
  expect(yamlRoot.className).not.toContain('flex-1')
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/CreateFromYamlDialog.test.js`
Expected: FAIL(`maxBtn()` 为 null——弹窗未开最大化;`yaml-dialog-content` 不存在)

- [ ] **Step 3: 实现**

`src/components/common/CreateFromYamlDialog.vue` template 改动——Modal 开标签加 `maximizable`,默认 slot 改作用域插槽,内容根加 testid 与条件 h-full,YamlEditor 传 height-class:

```html
  <Modal :model-value="modelValue" :title="t('component.createFromYaml.title')" width="max-w-3xl" maximizable
    @update:model-value="emit('update:modelValue', $event)">
    <template #default="{ maximized }">
      <div data-testid="yaml-dialog-content" class="flex flex-col gap-sm" :class="maximized ? 'h-full' : ''">
        <p class="text-body-sm text-on-surface-variant">{{ t('component.createFromYaml.hint') }}</p>
        <YamlEditor v-model="yaml" height="420px" :height-class="maximized ? 'flex-1 min-h-0' : ''" />
        <p v-if="nsHint" class="text-body-sm text-on-surface-variant">{{ t('component.createFromYaml.nsHint', { ns: props.namespace }) }}</p>
        <p v-if="parseError" class="text-body-sm text-error">{{ parseError }}</p>
      </div>
    </template>
    <template #actions>
```

(`#actions` 区块及其后全部保持原样;script 区零改动。)

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/components/common/__tests__/CreateFromYamlDialog.test.js src/components/common/__tests__/CreateWithYamlButton.test.js src/components/common/__tests__/Modal.test.js`
Expected: 三个文件全部 PASS(既有用例零回归)

- [ ] **Step 5: 提交**

```bash
git add src/components/common/CreateFromYamlDialog.vue src/components/common/__tests__/CreateFromYamlDialog.test.js
git -c commit.gpgsign=false commit --author="aliangone <aliangone@gmail.com>" -m "feat(ui): 「从 YAML 创建」弹窗支持最大化——编辑器弹性填满内容区"
```

---

## 收尾(全任务完成后)

- [ ] `npm run test:unit` 全量跑通(33 个 YamlEditor 消费方零回归)。
- [ ] 手测(需真浏览器,happy-dom 测不出 rect):任一列表页「从 YAML 创建」→ 弹窗右上最大化 → 编辑器填满、hint/错误行可见 → 还原回 420px;Esc 关闭正常;创建 Service 流程不受影响。
- [ ] superpowers:requesting-code-review 终审,再 finishing-a-development-branch(--no-ff 合回 main)。
