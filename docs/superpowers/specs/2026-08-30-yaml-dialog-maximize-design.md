# 通用「从 YAML 创建」弹窗支持最大化 — 设计

- 日期:2026-08-30
- 状态:已批准(对话内确认,方案 A)
- 范围:仅 `CreateFromYamlDialog`(通用 YAML 创建弹窗);不动 Service 表单创建弹窗

## 1. 背景

「从 YAML 创建 Service」(及部署/CM 等 12+ 视图入口,经 `CreateWithYamlButton`)打开的是全站通用弹窗 `src/components/common/CreateFromYamlDialog.vue`。`Modal.vue` 已支持 `maximizable`(Modal 最大化特性),但该弹窗未启用;CM/Secret 富创建弹窗(`CreateConfigResourceModal.vue`)是唯一已启用的参考实现。

## 2. 方案(已选 A:弹性填充,照抄 CCM 既定模式)

否决的 B:最大化时把编辑器 height 换成 `calc(100vh - Xpx)` 近似值——不同屏幕不精确,是 hack,违背 Modal 最大化特性确立的 h-full 链。
否决的 C:换 `CodeTextarea` 直编(默认可编辑)——行为变更,超出本特性范围。

## 3. 改动点(两个文件)

### 3.1 `src/components/common/CreateFromYamlDialog.vue`

- Modal 加 `maximizable`。
- 内容区改 `<template #default="{ maximized }">` 解构。
- 内容根容器 maximized 时加 `h-full`。
- YamlEditor 传 `:height-class="maximized ? 'flex-1 min-h-0' : ''"`(与 CCM yaml tab 同款写法)。

### 3.2 `src/components/common/YamlEditor.vue`

- 加可选 `heightClass` prop(默认 `''`),与 `CodeTextarea` 的同名 API 镜像。
- **不传 = 现行为逐字节不变**(既有 33 个消费方安全)。
- 传入时:根元素挂该 class;单模式(single)视图容器加 `flex-1 min-h-0 flex flex-col`;CodeViewer 的 `maxHeight` 传 `'100%'`;编辑态 textarea 由固定 min/max-height 改为 flex 填充(`flex-1 min-h-0`)。
- Diff 模式不处理(本弹窗不使用 diffMode;保持原样)。

## 4. 行为

- 默认打开完全不变(420px 编辑器、max-w-3xl 弹窗)。
- 点标题栏最大化按钮 → 弹窗满屏、YAML 编辑器填满内容区(hint/解析错误行仍可见)。
- 再点还原 → 回 420px。
- Esc 关闭、`beforeClose` 守卫、草稿状态均由 Modal 既有机制承担,零新逻辑。

## 5. 测试

扩展现有 vitest(YAML 弹窗相关测试文件):

- 挂载弹窗 → `modal-maximize-btn` 存在。
- 点击最大化 → 内容根含 `h-full`、编辑器根 class 含 `flex-1 min-h-0`。
- 点还原(`modal-restore-btn`)→ class 恢复、编辑器区回到固定高度形态。

硬性注意(记忆教训):

- Modal 是 Teleport,**断言必须查 `document.body`**(组件 wrapper 内找不到)。
- happy-dom 测不出真实 rect,**只断言 class/结构,不断言像素**。

## 6. 不做的事(YAGNI)

- i18n 零新增(`component.modal.maximize` / `restore` 键已有)。
- 不动 NsServices 表单创建弹窗。
- 不换 CodeTextarea、不改弹窗默认宽度(max-w-3xl)。
- 不动 YamlEditor 的 diff 模式与其余消费方。
