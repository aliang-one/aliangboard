# 国际化（i18n）Phase 1：基础设施 + 核心页面

- 日期：2026-08-06
- 分支：`feat/i18n`（从 `main` @ e03beb7 切出）
- 目标：为应用增加中文/英文双语支持，Phase 1 搭建基础设施 + 迁移核心页面。

## 背景
应用现有 109 个 .vue 文件，约 2555 行混合文本（英文标签 + 中文提示/占位符/toast），无任何 i18n 设置。需系统性地提取为 locale key + 双语翻译。

## 架构
- **库**: `vue-i18n` v9+（Composition API，支持 $t/t()、fallback、lazy-load）。
- **配置**: `src/i18n.js` — `createI18n({ locale: 'zh', fallbackLocale: 'en', messages })`，legacy: false。
- **locale 文件**: `src/locales/zh.json` + `src/locales/en.json`，按模块组织 key（common/nav/cluster/nodes/login...）。
- **插件注册**: `main.js` 中 `app.use(i18n)`。
- **语言切换**: 设置页/顶栏加语言选择器（中文/English），选择持久化到 `localStorage('aliangboard.locale')`，初始化时读取。
- **Composable**: 各组件用 `useI18n()` 获取 `t()`；模板用 `$t('key')`。

## Phase 1 范围（本 spec）
1. **基础设施**: 安装 vue-i18n；创建 i18n.js + locales/zh.json + locales/en.json（初始 key 集）；main.js 注册；语言切换器（Settings 页）+ localStorage 持久化。
2. **核心页面迁移**（验证 i18n 可行性）:
   - 侧栏导航（SideNavBar.vue）—— 所有分组/标签。
   - 登录页（Login.vue）—— 所有文案。
   - Cluster Overview（ClusterOverview.vue）—— 卡片标题/标签。
   - Nodes（Nodes.vue）—— 表头/状态/按钮。
   - 公共组件（StatusChip/ProgressBar/Breadcrumbs 等）—— 通用文案。
3. **公共 key 集**: common.save/cancel/delete/add/remove/search/sync/loading/empty/success/error 等跨页面复用的 key。

## Phase 2+（后续 spec，不在本次）
- 剩余所有 views（DeployApp, NsWorkloadDetail, NsIngress, NsIngressDetail, Storage, Monitoring...）。
- 组件内文案（VolumeMountCard, EnvSourceField, ClusterCard, AnnotationKeySelect...）。
- composables/stores 内的用户可见字符串（notify 消息、mock 数据 label 等）。
- 逐步迁移，每批一个子 spec。

## 不做（YAGNI）
RTL；3+ 语言；服务端 i18n；自动翻译；vue-i18n 的 SFC custom block（用 JSON 文件）。

## 验证
- `npm install` + `npm run build` 通过。
- 切换语言（中文↔English）→ 核心页面文案即时变化。
- localStorage 持久化：刷新后保持上次选择。
- fallback：未翻译的 key 显示英文（或 key 本身）。
