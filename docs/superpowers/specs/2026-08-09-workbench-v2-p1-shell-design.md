# 工作台 V2 P1 — Shell + 项目卡片网格

- 日期:2026-08-09
- 分支:`feat/workbench-v2-p1`(worktree `.claude/worktrees/wb-v2-p1`,从 `origin/main` `b95ff48` 起)
- 状态:APPROVED(brainstorm 2026-08-09)
- 关联:V2 愿景 `liang-workbench-v2-vision-20260806-110214.md`;[[apikey-mcp-agent-base]]

## 背景

工作台 V2 愿景 P1:把工作台从「侧栏入口 + 扁平列表页」升级为**一个 shell**(右上角入口 → 全屏 tab 页:项目/配置/全局)。项目列表升级为**卡片网格**(属性 chips + manifest 数 + reconcile 状态)。点击卡片 → 现有 WorkbenchDetail(不改,P2 再升级 IDE)。

## 范围(已确认)

**做:**
1. **入口**:TopNavBar 右上角(头像区旁)加「工作台」按钮 → `/workbench`。
2. **Shell**:新页面 `WorkbenchShell.vue`,顶部 3 个 tab(项目/配置/全局)。
3. **项目 tab**:卡片网格(替代 WorkbenchList 列表),属性卡片(name/简介/ns chips/manifest 数/reconcile 状态)。
4. **配置 tab**:只读信息卡(集群绑定、项目根路径、distill 状态)。
5. **全局 tab**:WorkbenchLedger 内容(INDEX+learnings)搬进 shell。
6. 侧栏「工作台」入口移除。

**不做(P2+):**IDE 式工作区(文件树+编辑器+AI 侧栏)、@-mention、资源卡片、配置 tab 编辑表单。

## 设计

### 1. 入口(TopNavBar 右上角)
- `TopNavBar.vue` 头像区旁加 `<button @click="router.push('/workbench')">工作台</button>`(icon `workspaces`)。
- 侧栏 `SideNavBar.vue` 移除 `{ labelKey: 'nav.workbench', route: '/workbench' }` 项。

### 2. Shell(`WorkbenchShell.vue`)
- 路由 `/workbench` → `WorkbenchShell.vue`(替代现有 WorkbenchList)。
- 布局:顶部标题栏(「← 返回集群」+ 「工作台」标题)+ tab 栏(项目/配置/全局)+ 内容区。
- tab 状态:`ref('projects')`(不走路由 query,P1 简单)。
- 内容:`v-if` 切换三个子组件。

### 3. 项目 tab(`WorkbenchProjects.vue`,从 WorkbenchList 提取)
- 卡片网格(grid `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md`)。
- 每张卡:
  - 📦 项目名(font-semibold) + 简介(text-on-surface-variant)。
  - 属性 chips:`ns`(boundSA_namespace 或 allowed_namespaces)、`manifests`(yaml 文件数)、`reconcile`(lastReconcile 时间或 'never')。
  - 「打开项目 →」按钮 → `router.push('/workbench/' + project.id)`。
- 新建项目按钮(FAB 或卡片网格末尾的「+ 新建」卡)。
- 数据:现有 `workbench-projects` store + `adminApi.workbench.listProjects()`。

### 4. 配置 tab(`WorkbenchConfig.vue`)
- 只读卡片:集群名 / apiServer / 项目根目录路径(`WORKBENCH_DIR`)/ distill 是否启用。
- P1 不做编辑表单(只读展示)。

### 5. 全局 tab(WorkbenchLedger 内容)
- 将 `WorkbenchLedger.vue` 的核心内容(INDEX.md + learnings.md 显示 + 蒸馏按钮)搬入 shell 的全局 tab。
- 可直接 `<WorkbenchLedger />` 嵌入,或提取内容到 shell 内联。

### 6. 路由变化(`src/router/index.js`)
- `/workbench` → `WorkbenchShell.vue`(新,替代 WorkbenchList)。
- `/workbench/:id` → `WorkbenchDetail.vue`(不变)。
- `/workbench/ledger` → 可保留或删除(全局 tab 取代);保留则重定向到 `/workbench?tab=global`。

### 7. i18n
新键(`workbench.shell.*` + `workbench.card.*`):tab 标题、卡片标签(ns/manifests/reconcile)、返回按钮、新建。zh/en 对齐,`npm run i18n:check` 门禁。

## 数据流

```
TopNavBar「工作台」→ /workbench → WorkbenchShell
  ├ 项目 tab → WorkbenchProjects(卡片网格)→ listProjects() → store.projects
  │   └ 卡片点击 → /workbench/:id → WorkbenchDetail(现有,不改)
  ├ 配置 tab → WorkbenchConfig(只读集群/路径/distill 信息)
  └ 全局 tab → WorkbenchLedger(INDEX + learnings + 蒸馏)
```

## 错误处理
- 项目列表加载失败 → 卡片网格区显示错误提示 + 重试按钮。
- 无项目 → 空态「还没有项目,点击新建」。
- 全局 tab 台账为空 → 现有空态(已有)。

## 测试
- `npm run build`(编译新组件)。
- `npm run i18n:check`(新键对齐)。
- `npm run typecheck`(语法)。
- 手测:右上角入口 → shell → 3 个 tab 切换 → 卡片点击 → 详情页。

## 非目标(再确认)
IDE 工作区(P2)/ @-mention(P3)/ 资源卡片(P3)/ 属性系统(P4)/ 配置编辑表单 / tab 路由 query 持久化。
