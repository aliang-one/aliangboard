# Modal ESC 键盘关闭 — 设计文档

- 日期:2026-08-07
- 状态:已批准,待实现
- 范围:前端(src/components、src/composables)

## 1. 背景与目标

项目里有大量 modal/对话框,目前只能通过 **Cancel 按钮 / 右上角 X / 点击遮罩** 三种方式关闭,缺少键盘关闭能力。用户希望按 **ESC** 能关闭/取消 modal,尤其是 YAML 编辑类 modal。

目标:为所有 modal/对话框统一加上「ESC = 关闭」的键盘行为,且与现有三种关闭方式行为完全一致。

## 2. 现状盘点

| 类型 | 组件 | 实际是否在用 | 显隐控制 | ESC 现状 |
|------|------|------|----------|----------|
| 共享 Modal | `src/components/common/Modal.vue` | ✅ 在用:51 个文件、~120 处 `<Modal>` 实例 | `v-model:modelValue`,内部 `close()` | 无 |
| 手写对话框 | `src/components/common/CreateResourceDialog.vue` | ❌ 死代码(零引用、无全局注册) | `v-model` + `close()` | 无 |
| 手写对话框 | `src/components/common/ScaleDialog.vue` | ❌ 死代码(NsWorkloadDetail 自己内联实现了 scale) | `emit('close')` | 无 |
| 手写对话框 | `src/components/common/NodeActions.vue` | ❌ 死代码 | `emit('close')` | 无 |
| YAML 编辑器 | `src/components/common/YamlEditor.vue` | ✅ 嵌在 Modal 内使用 | 自身 `isEditing`/`hasChanges` + textarea | 无 |

关键事实(自审阶段已核实):

- **实际在跑的 modal 体系只有共享 `Modal.vue` 一处**:51 个文件 import 它,共 ~120 处 `<Modal>` 实例,含所有 YAML 编辑 modal(`YamlEditor` 嵌在 `Modal` 内)。改 `Modal.vue` 一处即覆盖全部实际渲染的 modal。
- 三个手写对话框组件(`CreateResourceDialog`/`ScaleDialog`/`NodeActions`)**当前是死代码**,全项目无 import、无全局注册、从未被渲染。用户决定仍一并加上 ESC,以便将来接入(workload 创建/管理相关)时自带该能力。
- 除上述外,项目里其他 `fixed inset-0` 写法均**非 modal**:TopNavBar / SideNavBar / DropdownMenu 是下拉菜单的 `z-30` 点击遮罩;NamespaceOverview 的 `z-[100]` 是 hover 关联卡片;ApplyToast 是通知 toast。均不在范围内。
- 无第三方 / 原生 `<dialog>` 元素。
- 现有 Cancel / X / 点遮罩三种关闭方式,**本来就不保存未提交的 YAML/表单改动**。
- 项目目前无任何全局键盘监听(TopNavBar 搜索框、Terminal 重命名等是局部 `@keydown.esc`,且不在 modal 内,无冲突)。

## 3. 设计决策

**ESC 永远直接关闭 modal,与 Cancel / X / 点遮罩完全一致,不加确认、不拦截。**

依据:现有三种关闭方式本就不保存未提交改动,ESC 若加确认会造成「只有 ESC 会确认」的割裂感;统一为直接关闭最可预测、肌肉记忆一致。未 Apply 的 YAML / 表单改动会丢失,但这与今天点 Cancel / X / 遮罩的行为相同,不引入新风险。

## 4. 必须处理的边界:modal 层叠

若两个 modal 同时打开(如详情页内再弹删除确认),且都监听 document 的 ESC,一次按键会把两者都关掉。

解决:composable 维护一个**模块级打开栈**,只有栈顶(最后打开的)modal 响应 ESC,其余 modal 的监听器在 `onKeydown` 内因「非栈顶」直接 return。

## 5. 实现方案:composable `useEscClose`

### 5.1 契约

```
useEscClose(isOpenRef: Ref<boolean>, onClose: () => void): void
```

- `isOpenRef`:该 modal 是否打开的响应式引用。
- `onClose`:ESC 命中时要执行的关闭回调(通常是现有 `close()` / `emit('close')`)。

### 5.2 行为

- `watch(isOpenRef, { immediate: true })`:
  - `open === true` → 入栈(分配自增 id)+ `document.addEventListener('keydown', onKeydown)`。
  - `open === false` → 出栈 + `document.removeEventListener('keydown', onKeydown)`。
- `onKeydown(e)`:`e.key === 'Escape' && isOpenRef.value && isTop(id)` 三者同时满足 → 调用 `onClose()`。非栈顶直接 return。
- `onBeforeUnmount()`:出栈 + 移除监听(防组件在打开态被卸载时的内存泄漏与误触发)。

### 5.3 模块级状态

- `const stack = []`:当前打开的 modal id 序列,末尾即栈顶。
- `let counter = 0`:自增 id 生成器(确定、无随机)。
- `isTop(id)`:`stack.length > 0 && stack[stack.length - 1] === id`。

> 说明:用模块级单例栈而不是 DOM 查询或 z-index 比较,因为 modal 都 Teleport 到 body、DOM 顺序与打开顺序一致,内存栈最廉价且可测。

## 6. 改动文件

1. **新增** `src/composables/useEscClose.js` — composable 本体(含栈管理)。
2. `src/components/common/Modal.vue` — 增加 `useEscClose(() => props.modelValue, close)`。覆盖 51 个文件 / ~120 处 modal 实例,含所有 YAML 编辑 modal(`YamlEditor` 嵌在 `Modal` 内,编辑模式 textarea 里按 ESC 也会关掉整个 modal,符合「永远直接关闭」决策)。
3. `src/components/common/CreateResourceDialog.vue`(当前死代码)— 增加 `useEscClose(() => props.modelValue, close)`。其 YAML tab 是只读 `<pre>` 预览,无 textarea 编辑态,ESC 直接关闭即可。
4. `src/components/common/ScaleDialog.vue`(当前死代码)— 增加 `useEscClose(ref(true), () => emit('close'))`(组件通过 `emit('close')` 让父组件 v-if 卸载,故挂载即视为打开)。
5. `src/components/common/NodeActions.vue`(当前死代码)— 同 ScaleDialog。

### 不在范围内(已逐一核实,均非 modal)

- TopNavBar / SideNavBar / `DropdownMenu.vue` 的 `fixed inset-0 z-30` 是下拉菜单点击遮罩(非 modal)。
- `NamespaceOverview.vue` 的 `z-[100]` 是 hover 关联卡片(鼠标驱动,非 modal)。
- `ApplyToast.vue` 通知 toast。
- TopNavBar 搜索框、Terminal 重命名等已有局部 `@keydown.esc`(非 modal 内,无冲突)。

## 7. 测试策略

依 CLAUDE.md「纯逻辑优先自研零依赖运行器」,但本 composable 绑定 Vue 生命周期 + DOM 事件,适合用已批准的 **vitest + @vue/test-utils + happy-dom**(`npm run test:unit`):

- 基本路径:挂载使用 composable 的假 modal → 派发 ESC keydown → 断言 `onClose` 被调用一次。
- 层叠:挂载两个层叠 modal → ESC → 只关栈顶;栈顶关闭后再次 ESC 关下一个。
- 非 Escape 键(如 Enter)不触发。
- 关闭 / 卸载后:栈正确出栈、监听已移除(再次派发 ESC 不触发已关闭的 modal)。
- `isOpenRef` 为 false 时即便有残留监听也不触发。

回归基线:

- `npm run typecheck`(`node --check` 全部新/改 .js / .mjs)。
- `npm run build` 覆盖 .vue 模板语法。
- `npm test` 不受影响(无服务端/纯逻辑变更)。

## 8. 风险与回滚

- 风险低:改动集中在共享组件 + 一个新 composable,行为是纯增量(新增关闭途径),不改任何现有关闭逻辑。
- 回滚:删除 composable 调用即可恢复原状。
