# 工作台 V2 P2 — IDE 式项目工作区

- 日期:2026-08-09
- 分支:`feat/workbench-v2-p1`(从 `origin/main` `b95ff48` 起;P1 已合)
- 状态:APPROVED(brainstorm 2026-08-09)
- 关联:V2 愿景 P2;依赖 P1(shell 已建)

## 背景

P1 建了工作台 shell(项目/配置/全局 tab + 卡片网格)。点击卡片 → 现有 WorkbenchDetail(2 栏:文件树 + textarea 编辑器)。AI 助手是**独立页**(`WorkbenchProjectChat.vue`),需跳页。

P2 把 chat 从独立页**搬进 Detail 右侧栏**,成为三栏 IDE 工作区:文件树 | 编辑器 | AI 对话,不再跳页。三栏可折叠。

## 范围

**做:**
1. `WorkbenchDetail.vue` 重写为三栏布局(文件树 | 编辑器 | AI chat),加折叠按钮。
2. 提取 chat 逻辑为子组件 `WorkbenchChat.vue`(props: projectId;内部 agent loop + checkpoint/resume + trace + approval modal)。
3. 删 WorkbenchDetail 的"AI 助手"跳页按钮(chat 始终可见在右栏)。
4. 编辑器改用 `YamlEditor.vue`(替代 textarea;带语法高亮 + 编辑/查看切换)。
5. 路由 `/workbench/:id/chat` 保留但重定向到 `/workbench/:id`(向后兼容)。

**不做(P3+):**@-mention / 资源卡片 / 实时 diff / git history tree / 多 tab 编辑。

## 设计

### 1. 三栏布局(`WorkbenchDetail.vue` template 重写)

```
┌─────────────────────────────────────────────────────┐
│  ← 工作台  项目名·集群  [Reconcile] [折叠左][折叠右] │
│──────────┬───────────────────┬──────────────────────│
│ 📁 files │  📝 YamlEditor    │  🤖 WorkbenchChat   │
│ ▸deploy  │  (编辑/查看切换)   │  (agent loop)        │
│ ▸svc     │  + 保存 + commit   │  + checkpoint/resume │
│ (可折叠◄)│                   │  (可折叠►)            │
│──────────┴───────────────────┴──────────────────────│
```

折叠状态:左栏折叠 → 文件树隐藏,编辑器获得空间;右栏折叠 → chat 隐藏。`ref` 控制展开/折叠(`showFileTree`/`showChat`,默认都展开)。

### 2. `WorkbenchChat.vue`(从 WorkbenchProjectChat 提取)

- **props**: `{ projectId: String, projectName: String }`(不再从 route.params 取)。
- **核心逻辑**:从 WorkbenchProjectChat 的 script 1:1 移植(turns/send/applyResponse/checkpoint/resume/trace/approval modal/HINTS)。
- **模板**:聊天消息列表(scroll) + 输入框 + 发送按钮 + hint chips + approval modal。紧凑布局(适配侧栏宽度)。
- 不再需要 `useRoute`(projectId 从 props 取)。

### 3. 编辑器(`YamlEditor.vue` 复用)

- 现有 WorkbenchDetail 用 `<textarea>` → 改用 `<YamlEditor v-model="currentContent" @save="save" />`。
- YamlEditor 已有编辑/查看切换 + 保存按钮 + discard。
- 保存逻辑(save → writeFile)保留在 WorkbenchDetail。
- commit 区域( commit msg + recent commits)移到编辑器下方。

### 4. 路由

- `/workbench/:id` → WorkbenchDetail(不变,但内部改了)。
- `/workbench/:id/chat` → 改为 redirect 到 `/workbench/:id`(向后兼容;如果用户书签了旧 URL)。

### 5. i18n

新增:`workbench.ide.*`(折叠/展开按钮、chat 侧栏标题)。复用现有 `workbench.detail.*` 和 `workbench.chat.*` 键。

## 数据流

```
点击卡片 → /workbench/:id → WorkbenchDetail
  ├ 左栏: files(现有 listFiles API)→ 点文件 → readFile → currentContent
  ├ 中栏: YamlEditor(currentContent)→ save → writeFile → commit
  └ 右栏: WorkbenchChat(projectId)→ POST /api/agent/chat → agent loop → trace + approval
```

## 错误处理
- 文件树加载失败 → 显示错误(现有)。
- chat 发送失败 → errorBanner(从 WorkbenchProjectChat 移植)。
- 编辑器保存失败 → notify(现有)。

## 测试
- `npm run build` + `npm run i18n:check` + `npm run typecheck`。
- 手测:三栏布局 + 折叠 + 文件编辑 + AI chat + checkpoint 审批。

## 非目标
@-mention(P3)/ 资源卡片(P3)/ 属性系统(P4)/ 多 tab / git diff viewer / P2 不改 WorkbenchChat 的 agent 逻辑(只提取不改)。
