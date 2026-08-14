# DeployApp Step 2「容器配置」设计感重做(档案卡布局)

## 背景

用户对创建 workload 向导 Step 2 的容器配置区提出「更有设计感」。经视觉伴侣 6 轮迭代定稿(方向 A 分组卡片 × B 容器档案卡的合成,含「资源下沉左列」「args 终端风大输入」两轮用户修正)。定稿 mockup:`.superpowers/brainstorm/2601235-1786670309/content/design-direction-v6.html`(本地留档,未入库)。

**硬约束(用户明示):现有功能零删减** —— envFrom 整体引用(ConfigMap/Secret)、单 Key 引用、探针、ServiceAccount、安全上下文、生命周期、stdin/tty、init/sidecar、端口、资源预设等全部保留,只换组织方式与皮。

## 定稿布局(v6)

Step 2 整个变成「主容器」一张档案卡 + 卡外附件:

### 1. 主容器档案卡(整步核心)

```
┌─ 身份条(渐变浅绿底)─────────────────────────┐
│ [▣图标] [主容器徽标] 容器名输入   镜像输入(mono) │
├───────────────────────────────────────────┤
│ 带一(左右两栏):                              │
│  左列 38%:                                    │
│   ┌ 镜像获取 ───────────┐  ┌ 进程执行(等高)──┐ │
│   │ 拉取凭证(上)        │  │ 工作目录|command │ │
│   │ 拉取策略(下,横向    │  │ args 终端风大输入 │ │
│   │  三段分段按钮)      │  │ (2行高暗底等宽)  │ │
│   └────────────────────┘  │ stdin/tty 开关   │ │
│   ┌ 资源(下沉到左列底)──┐  └─────────────────┘ │
│   │ 预设chip│cpu/mem 2×2│                      │
│   └────────────────────┘                      │
├─ 带二「运行配置」(虚线分割+浅底):──────────────┤
│  端口(整行cell)                                │
│  环境变量·直填(整行cell)                        │
│  环境引用(整行cell:整体引用CM/Secret + 单Key行)  │
└───────────────────────────────────────────┘
```

### 2. 卡外(布局不变,仅换组头风格)

- **初始化容器 / 额外容器**:左右并排虚线空态卡(图标 + 计数徽标 + 添加按钮);有卡片时仍为现有卡片列表。
- **高级设置**:折叠条头部追加标签胶囊(`ServiceAccount · 探针 · 安全上下文 · 生命周期`,全部复用现有 i18n 键拼装),内部内容不动。

## 关键实现决策

- **纯模板/样式层**:只动 `src/views/DeployApp.vue` 的 `<template>` 与 i18n 文件;不改 `<script setup>` 的表单状态、校验、YAML 生成 —— 生成 YAML 与改动前逐字一致。
- **拉取策略分段按钮**:三个 `<button>`(IfNotPresent/Always/Never),`@click="form.pullPolicy = '…'"` + 选中态 `bg-primary text-on-primary`;替代 `<select>`,数据不变。
- **stdin/tty 开关**:模板层开关(轨道+滑块样式),`@click="form.stdin = !form.stdin"`,替代 checkbox。
- **args 大输入(终端风)**:`<textarea :rows="2">` + `@input` 把换行归一为空格(保持 `form.args` 单行语义 → YAML 不变);暗底等宽用现有 `src/styles/code-theme.js` 单一来源的代码主题 token,不新造颜色;行号槽为纯装饰 div。
- **图标**:Material Symbols Outlined 现有字面量(如 `terminal`/`download`/`memory`/`settings_ethernet`/`code`/`input` 等,实现时挑语义最贴的;注意 Material Symbols 族名带 Variable 后缀的字体约定)。
- **响应式**:`md:` 断点两栏,窄屏单栏堆叠(身份条字段、左列/右区、init/sidecar 并排卡均如此)。
- **明暗主题**:全部用 MD3 token(surface-container 系列/outline-variant/primary),无硬编码色;终端风 args 用 code-theme(暗底恒定,与全站代码块一致)。

## i18n

新增键 **恰好 5 个**(zh/en 同步):`deploy.mainContainer`(主容器)、`deploy.imagePullGroup`(镜像获取)、`deploy.processExecGroup`(进程执行)、`deploy.envDirectGroup`(环境变量 · 直填)、`deploy.envRefGroup`(环境引用)。组头其余标签与按钮一律复用现有键(`deploy.resources`/`containerPorts`/`environmentVariables`/`fromConfigMap`/`fromSecret`/`addPort`/`addVariable` 等);高级设置折叠条的胶囊标签用现有 `serviceAccountLabel`/`healthProbes`/`securityContext`/`lifecycleHooks` 拼 装。`npm run i18n:check` 门禁。

## 非目标

- 不动 Step 2 之外的任何步骤(Step 1 基本信息、Step 3 卷等)。
- 不改 init/sidecar 卡片内部字段、高级设置内部结构、校验与 YAML 逻辑。
- 不引新依赖、不做通用组件抽取(YAGNI;单文件模板改写)。

## 测试

- 无单元测试(纯模板 + 两个模板级交互处理器,无行为逻辑变化);`args` 归一化属模板内联,手测覆盖。
- 门禁:`npm run typecheck` + `npm run build` + `npm run i18n:check` + `npm run test:unit`(已知既有红:WorkbenchDetail.lifecycle 1 条,与本任务无关)。
- 手测清单:分段按钮/开关/args 换行归一/envFrom 与单 Key 引用可用性、窄屏堆叠、明暗主题、YAML 预览与改前逐字一致(同输入)。

## 影响面

- `src/views/DeployApp.vue`(Step 2 模板整段重写,约 880-1180 行区间的模板部分)
- `src/locales/zh.json`、`en.json`(≤6 新键)
