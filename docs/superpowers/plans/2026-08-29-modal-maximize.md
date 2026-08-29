# Modal 最大化能力实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Modal 加通用「最大化/还原」切换（`maximizable` prop），ConfigMap/Secret 创建弹窗首批启用，YAML 编辑区从 ~55vh 增至 ~90vh+。

**Architecture:** Modal.vue 内部自持 `maximized` 状态，`fullscreen || maximized` 共用现有全屏三段式布局；ESC 经 useEscClose 回调包装为「先还原再关闭」；scoped slot 把 `maximized` 暴露给内容做高度自适应。CM/Secret 弹窗据此在普通态（`max-h-[55vh]` + `rows=14`）与撑满态（flex 高度链）间切换。

**Tech Stack:** Vue 3 SFC（纯 JS）+ Tailwind + vitest/@vue/test-utils（happy-dom）+ vue-i18n（zh/en 双语）。

**Spec:** `docs/superpowers/specs/2026-08-29-modal-maximize-design.md`

## Global Constraints

- 提交作者恒 `aliangone <aliangone@gmail.com>`，禁止 `Co-Authored-By: Claude` 尾注。
- 不新增外部依赖。
- i18n 新键必须 zh+en 同步（en 夹译是门禁盲区）；`npm run i18n:check` 须过。
- 非最大化路径的 DOM/class 与现状完全一致（零回归面）。
- 在 worktree 分支 `worktree-feat-modal-maximize` 上提交；不 force push、不改写已推送历史。
- 测试命令：前端 `npx vitest run <file>`；全量 `npm run test:unit` / `npm test` / `npm run typecheck`。

---

### Task 1: Modal `maximizable` 切换（prop + 标题栏按钮 + ESC 先还原 + scoped slot + i18n 键）

**Files:**
- Modify: `src/components/common/Modal.vue`
- Modify: `src/locales/zh.json`（`component.modal` 下加 2 键）
- Modify: `src/locales/en.json`（同）
- Test: `src/components/common/__tests__/Modal.test.js`

**Interfaces:**
- Consumes: `useEscClose(isOpenRef, onClose)`（既有，`src/composables/useEscClose.js`）；`Z`（zScale，本任务不涉新 z 层）。
- Produces: prop `maximizable: Boolean`；scoped slot prop `maximized: boolean`（默认 slot）；`data-testid="modal-maximize-btn"` / `"modal-restore-btn"`；i18n 键 `component.modal.maximize` / `component.modal.restore`。Task 2 消费 `maximizable` + scoped `maximized`。

- [ ] **Step 1: 写失败测试（追加到 Modal.test.js 末尾；文件头 `import { mount } from '@vue/test-utils'` 下补一行 `import { nextTick } from 'vue'`——下述纯 DOM click/keydown 不走 VTU trigger 的自动 flush，断言前一律 `await nextTick()`）**

```js
// ===== 最大化能力(2026-08-29 设计):maximizable 切换 + ESC 先还原 + scoped slot =====
function mountModal(props = {}, slots) {
  return mount(Modal, { props: { modelValue: true, title: 't', ...props }, global: { plugins: [i18n] }, slots })
}
const dialogOf = () => document.querySelector('body div.fixed.inset-0 div.relative')

test('Modal: maximizable=false 无切换钮(回归);true 渲染最大化钮', () => {
  const w1 = mountModal({})
  expect(document.querySelector('[data-testid="modal-maximize-btn"]')).toBe(null)
  w1.unmount()

  const w2 = mountModal({ maximizable: true })
  const btn = document.querySelector('[data-testid="modal-maximize-btn"]')
  expect(btn).toBeTruthy()
  expect(btn.getAttribute('aria-label')).toBe(i18n.global.t('component.modal.maximize'))
  w2.unmount()
})

test('Modal: 点最大化→全屏形态;再点→还原普通形态', async () => {
  const w = mountModal({ maximizable: true, width: 'max-w-4xl' })
  const btn = () => document.querySelector('[data-testid="modal-maximize-btn"], [data-testid="modal-restore-btn"]')
  btn().click(); await nextTick()
  let cls = dialogOf().className
  expect(cls).toContain('w-full'); expect(cls).toContain('h-full'); expect(cls).toContain('rounded-none')
  expect(dialogOf().querySelector('div.flex-1.overflow-y-auto')).toBeTruthy()
  expect(btn().getAttribute('data-testid')).toBe('modal-restore-btn')
  btn().click(); await nextTick()
  cls = dialogOf().className
  expect(cls).toContain('max-h-[90vh]'); expect(cls).toContain('rounded-xl'); expect(cls).toContain('max-w-4xl')
  w.unmount()
})

test('Modal: 重开(modelValue 关→开)重置为普通态', async () => {
  const w = mountModal({ maximizable: true })
  document.querySelector('[data-testid="modal-maximize-btn"]').click(); await nextTick()
  expect(dialogOf().className).toContain('rounded-none')
  await w.setProps({ modelValue: false })
  await w.setProps({ modelValue: true }); await nextTick()
  expect(dialogOf().className).toContain('rounded-xl')
  w.unmount()
})

test('Modal: ESC 先还原不关闭;还原后 ESC 才关闭', async () => {
  const w = mountModal({ maximizable: true })
  document.querySelector('[data-testid="modal-maximize-btn"]').click(); await nextTick()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await nextTick()
  expect(dialogOf().className).toContain('rounded-xl')          // 已还原
  expect(document.querySelector('body div.fixed.inset-0')).toBeTruthy() // 未关闭
  expect(w.emitted('update:modelValue')).toBeUndefined()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await nextTick()
  expect(w.emitted('update:modelValue')[0]).toEqual([false])     // 第二次 ESC 关闭
  w.unmount()
})

test('Modal: scoped slot 暴露 maximized 两态', async () => {
  const { h } = await import('vue')
  const w = mountModal({ maximizable: true }, {
    default: ({ maximized }) => h('p', { 'data-testid': 'scope-probe' }, String(maximized)),
  })
  expect(document.querySelector('[data-testid="scope-probe"]').textContent).toBe('false')
  document.querySelector('[data-testid="modal-maximize-btn"]').click(); await nextTick()
  expect(document.querySelector('[data-testid="scope-probe"]').textContent).toBe('true')
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/Modal.test.js`
Expected: 新增 5 例 FAIL（无 maximizable prop → 无切换钮/无 scoped prop），既有 4 例 PASS。

- [ ] **Step 3: 实现 Modal.vue**

script 部分（props 增一项；`close`/`useEscClose` 之间加状态与包装）：

```js
  fullscreen: { type: Boolean, default: false },
  // 可最大化(2026-08-29):标题栏出现「最大化/还原」切换;ESC 先还原再关闭。
  maximizable: { type: Boolean, default: false },
```

```js
// 最大化状态:内部自持(非受控);关闭即重置(重开必为普通态),跨内容切换保持。
const maximized = ref(false)
watch(() => props.modelValue, v => { if (!v) maximized.value = false })

// 全屏形态共用既有 fullscreen 三段式布局
const isMaxLayout = computed(() => props.fullscreen || maximized.value)

// ESC 关闭:行为同 Cancel/X/点遮罩;层叠时只关栈顶(见 useEscClose)。
// 最大化时 ESC 先还原,再次 ESC 才关闭(防误触丢表单)。
const isOpen = computed(() => props.modelValue)
useEscClose(isOpen, () => { maximized.value ? (maximized.value = false) : close() })
```

（原 `const isOpen = ...; useEscClose(isOpen, close)` 两行被上段替换；`watch`/`computed` 已在既有 import 中。）

template 部分——dialog class 三处 `fullscreen` 换 `isMaxLayout`：

```html
        <div :class="isMaxLayout
            ? 'w-full h-full max-w-none rounded-none flex flex-col'
            : [width, 'max-h-[90vh] overflow-y-auto p-lg rounded-xl']"
```

header 行/body/actions 容器的 `fullscreen` 三处同样换 `isMaxLayout`；标题右侧按钮组加切换钮：

```html
            <div class="flex items-center gap-xs">
              <button v-if="maximizable" @click="maximized = !maximized"
                :data-testid="maximized ? 'modal-restore-btn' : 'modal-maximize-btn'"
                :title="maximized ? t('component.modal.restore') : t('component.modal.maximize')"
                :aria-label="maximized ? t('component.modal.restore') : t('component.modal.maximize')"
                class="p-1 text-on-surface-variant hover:bg-surface-container rounded-lg">
                <span class="material-symbols-outlined">{{ maximized ? 'close_fullscreen' : 'open_fullscreen' }}</span>
              </button>
              <button @click="close" class="p-1 text-on-surface-variant hover:bg-surface-container rounded-lg">
                <span class="material-symbols-outlined">close</span>
              </button>
            </div>
```

默认 slot 改 scoped：

```html
          <div :class="isMaxLayout ? 'flex-1 overflow-y-auto p-lg' : ''"><slot :maximized="maximized" /></div>
```

- [ ] **Step 4: 加 i18n 键**

`src/locales/zh.json` 的 `component.modal` 对象改为：

```json
"modal": { "cancel": "取消", "confirm": "确认", "maximize": "最大化", "restore": "还原" },
```

`src/locales/en.json` 对应：

```json
"modal": { "cancel": "Cancel", "confirm": "Confirm", "maximize": "Maximize", "restore": "Restore" },
```

（保持各文件既有缩进/键序风格，手工编辑勿动其它键。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/Modal.test.js && npm run i18n:check`
Expected: Modal 9 例全 PASS；i18n 门禁三合一通过。

- [ ] **Step 6: 提交**

```bash
git add src/components/common/Modal.vue src/locales/zh.json src/locales/en.json src/components/common/__tests__/Modal.test.js
git -c user.name=aliangone -c user.email=aliangone@gmail.com commit -m "feat(ui): Modal 通用最大化切换——maximizable prop+标题栏按钮+ESC 先还原+scoped slot 暴露 maximized"
```

---

### Task 2: CM/Secret 创建弹窗接最大化（YAML 编辑区撑满）

**Files:**
- Modify: `src/components/common/CreateConfigResourceModal.vue:241`（Modal 标签）、`:276`（tab 内容容器）、YAML 面板根与 textarea
- Test: `src/components/common/__tests__/CreateConfigResourceModal.test.js`

**Interfaces:**
- Consumes: Task 1 的 `maximizable` prop、scoped slot `maximized`、`data-testid="modal-maximize-btn"`/`"modal-restore-btn"`。
- Produces: 无对外新接口（纯布局自适应）。

- [ ] **Step 1: 写失败测试（追加到 CreateConfigResourceModal.test.js 末尾；该文件已 import mount/i18n/nextTick 与 vi.mock 桩）**

```js
// ===== 最大化:YAML 编辑区撑满(2026-08-29 设计)——真实挂 Modal(不 stub)走 Teleport DOM =====
test('最大化后 tab 容器与 YAML textarea 切撑满形态;还原回普通态', async () => {
  const w = mount(CreateConfigResourceModal, {
    props: { modelValue: true, kind: 'configmap', namespace: 'default' },
    global: { plugins: [i18n], stubs: { DataKeysEditor: DataKeysStub, KeyValueRowsEditor: KvRowsStub } },
  })
  // 进 YAML 编辑态(「从 YAML 开始」之外的常规路径:tab → 切编辑)
  await w.find('[data-testid="ccm-tab-yaml"]').trigger('click')
  await w.find('[data-testid="ccm-yaml-switch"]').trigger('click')
  const tabWrap = () => w.find('[data-testid="ccm-panel-yaml"]').element.parentElement
  const ta = () => w.find('[data-testid="ccm-yaml-input"]')
  // 普通态基线
  expect(tabWrap().className).toContain('max-h-[55vh]')
  expect(ta().attributes('rows')).toBe('14')
  expect(ta().classes().join(' ')).not.toContain('flex-1')
  // 最大化
  await document.querySelector('[data-testid="modal-maximize-btn"]').click()
  await nextTick()
  expect(tabWrap().className).toContain('flex-1')
  expect(tabWrap().className).toContain('min-h-0')
  expect(ta().classes().join(' ')).toContain('flex-1')
  // 还原
  await document.querySelector('[data-testid="modal-restore-btn"]').click()
  await nextTick()
  expect(tabWrap().className).toContain('max-h-[55vh]')
  expect(ta().classes().join(' ')).not.toContain('flex-1')
  w.unmount()
  document.body.innerHTML = ''
})
```

（若文件头未 import `nextTick`，在 `import { mount } from '@vue/test-utils'` 后补 `import { nextTick } from 'vue'`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/CreateConfigResourceModal.test.js`
Expected: 新例 FAIL（Modal 未传 maximizable → body 里无 maximize 钮，`document.querySelector(...)` 为 null 抛错），既有例 PASS。

- [ ] **Step 3: 实现 CreateConfigResourceModal.vue**

Modal 开标签加 `maximizable`（`:241` 一带）：

```html
  <Modal :model-value="modelValue" :title="..." width="max-w-4xl" maximizable @update:model-value="cancel">
```

默认 slot 内容包 scoped 模板（根 div 增条件高度，tab 容器改双态）：

```html
    <template #default="{ maximized }">
    <div class="flex flex-col gap-md" :class="maximized ? 'h-full' : ''">
```

tab 内容容器（原 `<div class="max-h-[55vh] overflow-y-auto">`）：

```html
      <div :class="['overflow-y-auto', maximized ? 'flex-1 min-h-0' : 'max-h-[55vh]']">
```

YAML 面板根（原 `class="flex flex-col gap-sm"`）：

```html
        <div v-if="activeTab === 'yaml'" data-testid="ccm-panel-yaml" class="flex flex-col gap-sm" :class="maximized ? 'flex-1 min-h-0' : ''">
```

YAML 编辑态 textarea（原 `rows="14"` 的那个）：

```html
            <textarea v-model="rawYaml" data-testid="ccm-yaml-input" rows="14" spellcheck="false"
              :class="maximized ? 'flex-1 min-h-0 w-full resize-none' : ''"
              class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md text-body-sm font-mono" />
```

（根 div 闭合 `</div>` 后补 `</template>`；其余普通态 class 一律不动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/CreateConfigResourceModal.test.js`
Expected: 全 PASS（含新增 1 例）。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/CreateConfigResourceModal.vue src/components/common/__tests__/CreateConfigResourceModal.test.js
git -c user.name=aliangone -c user.email=aliangone@gmail.com commit -m "feat(ui): ConfigMap/Secret 创建弹窗接最大化——YAML 编辑区 55vh 封顶→全屏 flex 链撑满"
```

---

### Task 3: 全量回归 + 浏览器实测 + 合并推送

**Files:**
- 无新改（验证与交付）。

**Interfaces:**
- Consumes: Task 1/2 的全部产出。

- [ ] **Step 1: 全量回归**

Run: `npm run test:unit && npm test && npm run typecheck`
Expected: 188+ 测试文件全 PASS、typecheck ✓。

- [ ] **Step 2: 浏览器实测（临时 harness，验后删）**

在 worktree 根建 `maximize-harness.html` + `maximize-harness.js`（挂真实 Modal + 复刻 CM 弹窗高度链的 textarea；import 路径与 issue4 harness 相同：`./src/i18n`、`./src/styles/main.css`、`installPaletteVars`；SFC 用独立 .vue 或 h() 渲染函数，勿用模板字符串——vite 是 runtime-only 构建）。`npx vite --port 5273` 起服务后用 Playwright 验证：

1. 打开弹窗 → 点最大化 → dialog `rounded-none`+`w-full h-full`，textarea 可视高度 ≥ 视口 70%（`getBoundingClientRect` 断言）。
2. ESC → 还原普通态（截图对比两态）。
3. 再 ESC → 关闭。
4. 重开 → 普通态。

验完 `rm` 三个 harness 文件、停 vite。

- [ ] **Step 3: 合并推送**

```bash
cd /home/liang/MyProgram/AiProject/aliangboard && git status --short   # 确认无重叠脏文件
git -c user.name=aliangone -c user.email=aliangone@gmail.com merge --no-ff worktree-feat-modal-maximize -m "Merge branch 'worktree-feat-modal-maximize'"
git fetch origin && git rev-list --count origin/main..main   # 确认只含本特性提交再推
git push origin main
```

（若 ff 不可能或 main 有并行推进，同 issue4 流程：no-ff 合并；推送前确认未推清单只含本特性。）
