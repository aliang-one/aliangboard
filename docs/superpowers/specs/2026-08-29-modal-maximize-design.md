# Modal 最大化能力设计（ConfigMap/Secret 创建弹窗 YAML 编辑区优化）

- 日期：2026-08-29
- 状态：已与用户确认（范围=通用能力+CM/Secret 首批启用；形态=真全屏；ESC 先还原）
- 背景：issue 反馈——创建 ConfigMap/Secret 时 YAML 编辑区太小（tab 内容 `max-h-[55vh]` 封顶 + textarea `rows=14`），体验差。

## 目标

给弹窗加「最大化/还原」切换，最大化时铺满视口，YAML 编辑区从 ~55vh 增至 ~90vh+。做成 Modal 通用能力，CM/Secret 创建弹窗首批启用，后续弹窗一行 prop 跟进。

## 非目标

- 不改 `fullscreen` prop 既有语义（恒全屏、无切换钮，现有零消费方，保留不动）。
- 不做受控 `v-model:maximized`（当前无外部控制需求，YAGNI）。
- 不做双击标题栏切换/快捷键（YAGNI）。
- 其他弹窗（从 YAML 创建等）本次不接。

## 组件契约（Modal.vue）

- 新 prop `maximizable: Boolean = false`；内部自持 `maximized = ref(false)`，不受控。
- 标题栏关闭按钮左侧新增切换按钮：`open_fullscreen` / `close_fullscreen` material symbols 图标，i18n title/aria-label：`component.modal.maximize` / `component.modal.restore`（zh+en 双语）。
- 布局分支：`fullscreen || maximized` 共用现有全屏三段式（dialog `w-full h-full max-w-none rounded-none flex flex-col`；header/footer `shrink-0` 带上下边框；body `flex-1 overflow-y-auto p-lg`）。
- ESC 语义：`useEscClose` 回调包一层——`maximized` 为 true 时 ESC 先还原（`maximized=false`），再次 ESC 才关闭。`maximizable=false` 或未最大化时行为与现状完全一致（零回归面）。
- 生命周期：`modelValue` false→true 时重置 `maximized=false`；最大化状态在 tab 切换间保持。
- slot 暴露：默认 slot 改 scoped `<slot :maximized="maximized">`，内容据此自适应高度。普通用法不受影响（不接 scoped prop 照常渲染）。

## 消费方（CreateConfigResourceModal.vue）

- `<Modal maximizable>`；内容根与 tab 容器接 scoped `maximized`：
  - 普通态：现状不动——tab 内容 `max-h-[55vh] overflow-y-auto`、YAML 编辑 textarea `rows="14"`。
  - 最大化态：内容根 `h-full flex flex-col`（配合 body flex-1 形成高度链），tab 容器 `flex-1 min-h-0 overflow-y-auto`（数据/注解/标签 tab 仍内滚），YAML 编辑 textarea `flex-1 min-h-0 w-full resize-none` 撑满。
  - YAML 预览态 `<pre>` 不强制撑满（内容多高显多高，容器内滚）。

## 测试

- `Modal.test.js` 增例：
  1. `maximizable` 才渲染切换钮；`false` 无钮（回归）。
  2. 点击切换→dialog class 含全屏形态；再点还原。
  3. 重开（modelValue 关再开）重置普通态。
  4. 最大化时 ESC 只还原不关闭；还原后 ESC 关闭。
  5. scoped slot 收到 `maximized`（真/假两态）。
- `CreateConfigResourceModal.test.js` 增例：最大化后 tab 容器与 YAML textarea class 切到撑满形态（真实挂 Modal 查 Teleport 到 body 的 DOM）。
- 浏览器实测：创建 Secret → YAML 编辑态 → 最大化截图对比普通态；ESC 还原；重开重置。

## 风险与防线

- Modal 是全站基座：改动仅新增按钮与布局分支，非最大化路径 class 不变；188 测试文件 + 既有 Modal 用例护航。
- i18n：新增 2 键须 zh+en 双语（en 夹译是门禁盲区）。
- z-index 无涉（同层切换，不新增浮层）。

## 交付物

- `src/components/common/Modal.vue`、`src/components/common/CreateConfigResourceModal.vue`
- `src/locales/zh.json` / `en.json`（2 键）
- `src/components/common/__tests__/Modal.test.js`、`CreateConfigResourceModal.test.js` 增例
