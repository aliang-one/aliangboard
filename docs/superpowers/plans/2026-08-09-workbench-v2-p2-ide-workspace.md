# 工作台 V2 P2 — IDE 式项目工作区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把 WorkbenchDetail 改为三栏 IDE 布局(文件树|编辑器|AI chat),提取 WorkbenchChat 子组件,编辑器改用 YamlEditor。

**Architecture:** WorkbenchDetail template 重写为三栏(可折叠);WorkbenchChat.vue 从 WorkbenchProjectChat 提取(props projectId);YamlEditor 替代 textarea。

**Tech Stack:** Vue 3 + vue-router + vue-i18n + Tailwind。零新依赖。

## Global Constraints
- 零新依赖;`npm run build` + `npm run i18n:check` + `npm run typecheck`。
- 不改 agent 后端逻辑(只提取前端 chat 组件,API 调用不变)。
- WorkbenchProjectChat.vue 保留(向后兼容);路由 `/workbench/:id/chat` redirect。
- commit 风格:`feat(workbench): …` + `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

### Task 1: WorkbenchChat.vue(从 WorkbenchProjectChat 提取 chat 组件)

**Files:** Create `src/components/workbench/WorkbenchChat.vue`

- [ ] **Step 1:** 创建 `src/components/workbench/WorkbenchChat.vue`:
  - 从 `src/views/WorkbenchProjectChat.vue` 复制 script + template。
  - 改 props: `defineProps({ projectId: String, projectName: String })`。删 `useRoute`/`useRouter` + `const id = route.params.id` → 用 `props.projectId`。
  - 所有 `id` 引用改为 `props.projectId`。
  - 模板改为紧凑侧栏布局(去掉页面级 header/back button,保留 chat 列表 + 输入 + hints + approval modal)。
  - i18n 复用现有 `workbench.chat.*` 键。

- [ ] **Step 2:** `npm run i18n:check && npm run build`

- [ ] **Step 3:** commit `feat(workbench): WorkbenchChat 组件(从 ProjectChat 提取,props projectId)`

### Task 2: WorkbenchDetail.vue 三栏布局 + YamlEditor + 折叠

**Files:** Modify `src/views/WorkbenchDetail.vue`;Create i18n keys

- [ ] **Step 1:** WorkbenchDetail template 重写:
  - Header:保留 back/project name/reconcile;删"AI 助手"跳页按钮;加折叠按钮(左/右)。
  - Body:三栏 flex:
    - 左栏(`v-if="showFileTree"`):文件树(现有,加折叠按钮 `◄`)。
    - 中栏(flex-1):YamlEditor(替代 textarea)+ 保存/commit 区域。
    - 右栏(`v-if="showChat"`):`<WorkbenchChat :project-id="id" :project-name="project?.name" />` + 折叠按钮 `►`。
  - Script 加:`import WorkbenchChat`、`import YamlEditor`、`const showFileTree = ref(true)`、`const showChat = ref(true)`。
  - textarea 改 YamlEditor:`<YamlEditor :modelValue="currentContent" @update:modelValue="v => { currentContent = v; dirty = true }" @save="save" />`。注意 YamlEditor 接 `modelValue` prop + `update:modelValue`/`save`/`discard` emits。读 `src/components/common/YamlEditor.vue` 确认接口。
  - i18n 新增 `workbench.ide.collapseFiles` / `workbench.ide.collapseChat` / `workbench.ide.expandFiles` / `workbench.ide.expandChat`(zh/en)。

- [ ] **Step 2:** `npm run i18n:check && npm run build`

- [ ] **Step 3:** commit `feat(workbench): 三栏 IDE 布局(file|YamlEditor|AI chat)+ 可折叠`

### Task 3: 路由 redirect + 全量验证

**Files:** Modify `src/router/index.js`

- [ ] **Step 1:** 路由 `/workbench/:id/chat` 改为 redirect:`{ redirect: to => '/workbench/' + to.params.id }`。

- [ ] **Step 2:** `npm test && npm run i18n:check && npm run typecheck && npm run build`

- [ ] **Step 3:** commit `feat(workbench): /workbench/:id/chat redirect + 全量验证`
