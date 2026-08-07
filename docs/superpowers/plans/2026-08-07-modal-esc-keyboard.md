# Modal ESC 键盘关闭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有 modal/对话框支持按 ESC 关闭(行为与 Cancel / X / 点遮罩完全一致),并通过打开栈保证层叠 modal 只关栈顶。

**Architecture:** 新增一个 composable `useEscClose(isOpenRef, onClose)`,内部维护模块级「打开栈」,只有栈顶 modal 响应 ESC。共享 `Modal.vue` 调用一行即覆盖 51 个文件 / ~120 处实际渲染的 modal;另三个当前为死代码的对话框组件一并接入。

**Tech Stack:** Vue 3 (`<script setup>`、`watch`/`computed`/`ref`/`onBeforeUnmount`)、vitest + @vue/test-utils + happy-dom(`npm run test:unit`)。无新增依赖。

## Global Constraints

- 仓库默认**不新增外部依赖**(`vitest`/`@vue/test-utils`/`happy-dom` 已是 CLAUDE.md 登记的例外,直接用)。
- 测试函数**不使用全局**:`vitest.config.js` 中 `globals: false`,测试里须 `import { describe, it, expect, vi } from 'vitest'`。
- 别名:`@` → `./src`(vitest 与 vite 均已配置)。
- **ESC 行为 = Cancel = X = 点遮罩,永远直接关闭,不加确认、不拦截**。
- 类型/语法基线:`npm run typecheck`(`node --check` 全 .js/.mjs;.vue 由 `npm run build` 覆盖)。
- 相关设计文档:`docs/superpowers/specs/2026-08-07-modal-esc-keyboard-design.md`。

---

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `src/composables/useEscClose.js` | composable 本体:绑定 ESC→onClose,模块级打开栈保证只关栈顶,卸载自动清理 | 新建 |
| `src/composables/__tests__/useEscClose.test.js` | composable 单测:基本路径/层叠只关栈顶/非 Escape 不触发/关闭与卸载后不误触发 | 新建 |
| `src/components/common/Modal.vue` | 共享 modal 组件;调用 `useEscClose` 覆盖全部实际渲染的 modal | 改 |
| `src/components/common/CreateResourceDialog.vue` | 死代码对话框;接入 ESC(将来接入时自带) | 改 |
| `src/components/common/ScaleDialog.vue` | 死代码对话框;接入 ESC | 改 |
| `src/components/common/NodeActions.vue` | 死代码对话框;接入 ESC | 改 |

---

## Task 1: composable `useEscClose` + 单测(TDD)

**Files:**
- Create: `src/composables/useEscClose.js`
- Test: `src/composables/__tests__/useEscClose.test.js`

**Interfaces:**
- Consumes: Vue 的 `watch` / `onBeforeUnmount`(`import { watch, onBeforeUnmount } from 'vue'`)。
- Produces: `useEscClose(isOpenRef: Ref<boolean>, onClose: () => void): void` —— 后续 4 个组件都按此签名调用。`isOpenRef` 必须是 ref/computed(有 `.value` 且可被 `watch`)。模块级导出 `useEscClose`(命名导出)。

- [ ] **Step 1: 写失败的单测**

Create `src/composables/__tests__/useEscClose.test.js`:

```js
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref, nextTick } from 'vue'
import { useEscClose } from '../useEscClose.js'

// 把 composable 包进一个空渲染组件里挂载(composable 依赖 setup 上下文的 watch/onBeforeUnmount)。
const mounted = []
function mountWithEsc(setup) {
  const Test = defineComponent({ setup, render() { return h('div') } })
  const wrapper = mount(Test)
  mounted.push(wrapper)
  return wrapper
}
afterEach(() => { while (mounted.length) mounted.pop().unmount() })

function esc() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

describe('useEscClose', () => {
  it('calls onClose when Escape pressed and open', () => {
    const onClose = vi.fn()
    mountWithEsc(() => useEscClose(ref(true), onClose))
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores non-Escape keys', () => {
    const onClose = vi.fn()
    mountWithEsc(() => useEscClose(ref(true), onClose))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not fire when isOpenRef is false', () => {
    const onClose = vi.fn()
    mountWithEsc(() => useEscClose(ref(false), onClose))
    esc()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('only closes the top modal when stacked', async () => {
    let closedA = 0, closedB = 0
    const openA = ref(true)
    const openB = ref(true)
    mountWithEsc(() => {
      useEscClose(openA, () => { closedA++; openA.value = false })
      useEscClose(openB, () => { closedB++; openB.value = false })
    })
    esc()
    await nextTick()
    expect(closedB).toBe(1)   // 栈顶 B 先关
    expect(closedA).toBe(0)
    esc()
    await nextTick()
    expect(closedA).toBe(1)   // B 关闭出栈后,轮到 A
  })

  it('stops firing after isOpenRef turns false', async () => {
    const onClose = vi.fn()
    const open = ref(true)
    mountWithEsc(() => useEscClose(open, onClose))
    open.value = false
    await nextTick()
    esc()
    expect(onClose).not.toHaveBeenCalled()   // 关闭后已移除监听
  })

  it('removes listener on unmount', () => {
    const onClose = vi.fn()
    const wrapper = mountWithEsc(() => useEscClose(ref(true), onClose))
    wrapper.unmount()
    esc()
    expect(onClose).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试,确认失败(模块不存在)**

Run: `npx vitest run src/composables/__tests__/useEscClose.test.js`
Expected: FAIL —— `Failed to resolve import "../useEscClose.js"` 或 `useEscClose is not a function`。

- [ ] **Step 3: 写最小实现**

Create `src/composables/useEscClose.js`:

```js
import { watch, onBeforeUnmount } from 'vue'

// 模块级打开栈:只有栈顶(最后打开)的 modal 响应 ESC,避免层叠时一次 ESC 关掉多个。
// modal 都 Teleport 到 body、DOM 顺序与打开顺序一致,内存栈最廉价且可测。
const stack = []
let counter = 0

function isTop(id) {
  return stack.length > 0 && stack[stack.length - 1] === id
}

function removeFromStack(id) {
  const i = stack.indexOf(id)
  if (i >= 0) stack.splice(i, 1)
}

/**
 * 给 modal/对话框绑定「ESC 关闭」。ESC = Cancel = X = 点遮罩,直接关闭、不确认、不拦截。
 * @param {import('vue').Ref<boolean>} isOpenRef - 该 modal 是否打开(需为 ref/computed)。
 * @param {() => void} onClose - ESC 命中且本 modal 为栈顶时执行的关闭回调。
 */
export function useEscClose(isOpenRef, onClose) {
  const id = ++counter

  function onKeydown(e) {
    if (e.key !== 'Escape') return
    if (!isOpenRef.value) return
    if (!isTop(id)) return
    onClose()
  }

  watch(isOpenRef, (open) => {
    if (open) {
      stack.push(id)
      document.addEventListener('keydown', onKeydown)
    } else {
      removeFromStack(id)
      document.removeEventListener('keydown', onKeydown)
    }
  }, { immediate: true })

  onBeforeUnmount(() => {
    removeFromStack(id)
    document.removeEventListener('keydown', onKeydown)
  })
}
```

- [ ] **Step 4: 运行测试,确认全绿**

Run: `npx vitest run src/composables/__tests__/useEscClose.test.js`
Expected: PASS(6 个用例全过)。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 通过(`node --check` 校验新 `.js` 语法)。

- [ ] **Step 6: 提交**

```bash
git add src/composables/useEscClose.js src/composables/__tests__/useEscClose.test.js
git commit -m "feat(ui): add useEscClose composable (ESC closes topmost modal)"
```

---

## Task 2: 接入共享 `Modal.vue`(覆盖全部实际渲染的 modal)

**Files:**
- Modify: `src/components/common/Modal.vue`

**Interfaces:**
- Consumes: Task 1 的 `useEscClose(isOpenRef, onClose)`。
- Produces: 所有使用 `<Modal v-model="...">` 的 ~120 处 modal 自动获得 ESC 关闭。后续 Task 3 的三个对话框各自独立调用同一 composable,不依赖本任务的内部改动。

**Context —— `Modal.vue` 现状(script 全文,便于精准编辑):**
```js
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  width: { type: String, default: 'max-w-lg' },
})
const emit = defineEmits(['update:modelValue', 'confirm', 'cancel'])
function close() {
  emit('update:modelValue', false)
  emit('cancel')
}
function confirm() { emit('confirm'); close() }
```
(`ref`/`watch` 在当前文件中其他逻辑使用,保留 import;只需追加 `computed` 与 `useEscClose`。)

- [ ] **Step 1: 追加 import**

在 `Modal.vue` 的 `<script setup>` 顶部,把 vue 的 import 改为同时导出 `computed`,并新增 composable import:

old:
```js
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
```
new:
```js
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEscClose } from '@/composables/useEscClose'
```

- [ ] **Step 2: 在 `close()` 之后接入 composable**

old:
```js
function close() {
  emit('update:modelValue', false)
  emit('cancel')
}
```
new:
```js
function close() {
  emit('update:modelValue', false)
  emit('cancel')
}

// ESC 关闭:行为同 Cancel/X/点遮罩;层叠时只关栈顶(见 useEscClose)。
const isOpen = computed(() => props.modelValue)
useEscClose(isOpen, close)
```

- [ ] **Step 3: 语法/构建校验**

Run: `npm run build`
Expected: 构建成功(覆盖 `.vue` 模板与 `<script setup>` 编译)。若报错,检查 `computed` 是否已 import、`useEscClose` 路径是否为 `@/composables/useEscClose`。

- [ ] **Step 4: 手测(任选一个含 YAML 编辑的 modal)**

启动 dev server,打开任意详情页(如 Service 详情)→ 打开 YAML 编辑 modal → 在 textarea 内敲过几行(未 Apply)→ 按 ESC → modal 关闭(与点 Cancel/遮罩一致);再叠开一个删除确认 modal → 按 ESC → 只关栈顶那个。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/Modal.vue
git commit -m "feat(ui): Modal supports ESC to close (covers all modal instances)"
```

---

## Task 3: 接入三个当前为死代码的对话框组件

> 这三个组件全项目零引用、无全局注册(见 spec §2),当前不渲染。按用户决定一并接入,以便将来挂载时自带 ESC。三处改动机械一致。

**Files:**
- Modify: `src/components/common/CreateResourceDialog.vue`
- Modify: `src/components/common/ScaleDialog.vue`
- Modify: `src/components/common/NodeActions.vue`

**Interfaces:**
- Consumes: Task 1 的 `useEscClose(isOpenRef, onClose)`。
- Produces: 无外部消费者依赖(死代码);仅保证将来被引用时 ESC 可用。

**Context:**
- `CreateResourceDialog.vue`:`defineProps({ modelValue, resourceType, namespace })`、`emit(['update:modelValue','create'])`、已有 `function close() { emit('update:modelValue', false) }`,已 import `computed`。
- `ScaleDialog.vue` / `NodeActions.vue`:`emit(['confirm','close'])`,无 `modelValue`;组件由父组件 `v-if` 控制挂载,故「挂载即打开」→ 用 `ref(true)`,ESC 时 `emit('close')`。两者已 import `ref`。

- [ ] **Step 1: 改 `CreateResourceDialog.vue`**

在 `<script setup>` 顶部 import 区追加(紧随现有 `import { useI18n } from 'vue-i18n'` 之后):
```js
import { useEscClose } from '@/composables/useEscClose'
```
在 `function close() { emit('update:modelValue', false) }` 之后追加:
```js
const isOpen = computed(() => props.modelValue)
useEscClose(isOpen, close)
```

- [ ] **Step 2: 改 `ScaleDialog.vue`**

在 import 区追加:
```js
import { useEscClose } from '@/composables/useEscClose'
```
在 `const replicas = ref(props.currentReplicas)`(或任意 setup 顶层语句)之后追加:
```js
// 挂载即打开(父组件 v-if 控制);ESC 同 Cancel。
const isOpen = ref(true)
useEscClose(isOpen, () => emit('close'))
```

- [ ] **Step 3: 改 `NodeActions.vue`**

在 import 区追加:
```js
import { useEscClose } from '@/composables/useEscClose'
```
在 `const isConfirmed = ref(false)`(或任意 setup 顶层语句)之后追加:
```js
const isOpen = ref(true)
useEscClose(isOpen, () => emit('close'))
```

- [ ] **Step 4: 语法/构建校验**

Run: `npm run build`
Expected: 构建成功。三个组件虽未挂载,但 `.vue` 编译须通过。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/CreateResourceDialog.vue src/components/common/ScaleDialog.vue src/components/common/NodeActions.vue
git commit -m "feat(ui): wire ESC-to-close into CreateResourceDialog/ScaleDialog/NodeActions"
```

---

## Task 4: 全量回归校验

**Files:** 无(仅校验)。

- [ ] **Step 1: 类型/语法基线**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 2: 前端单测全量**

Run: `npm run test:unit`
Expected: 全绿(含 Task 1 的 6 个新用例 + 既有用例无回归)。

- [ ] **Step 3: 全量测试(确认无服务端/纯逻辑回归)**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 4: 构建**

Run: `npm run build`
Expected: 构建成功、无新 warning。

> 本任务为只读校验,无代码改动则无需提交。若校验中发现问题,修复后回到对应 Task 重提。
