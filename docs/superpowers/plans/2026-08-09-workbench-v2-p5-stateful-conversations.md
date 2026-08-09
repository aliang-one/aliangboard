# 工作台 V2 P5 — 有状态对话实体 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** 对话成为服务端一级实体(持久化 + 后台执行 + 轮询 + 服务端 checkpoint/resume)。

**Architecture:** `workbench_conversations` 表 + 5 端点 + detached Promise 后台执行 + WorkbenchChat 异步轮询改造。

**Tech Stack:** Node.js + Vue 3。零新依赖。

## Global Constraints
- 零新依赖;`npm run build` + `npm run i18n:check`。
- 后台 Promise detached(不阻塞 HTTP);启动清理 orphaned。
- 现有 `/api/agent/chat` 保留(K8s 模式 + 向后兼容);新端点是 workbench 专用。
- commit: `feat(workbench): …` + `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

### Task 1: workbench_conversations 表 + 纯函数 + 测试

**Files:** Modify `server/workbench-projects.mjs`; Create `server/workbench-conversations.test.mjs`

- [ ] **Step 1:** `workbench-projects.mjs` 加:
  - `createConversationsSchema(db)` — CREATE TABLE workbench_conversations(见 spec)。
  - `createConversation(db, { projectId, system, userMessage })` — INSERT row status='running',返 row。
  - `getConversation(db, id)` — SELECT *。
  - `updateConversation(db, id, patch)` — 动态 SET(patch 的 key→`key=?`)。
  - `listConversations(db, projectId)` — SELECT slim(id/status/steps/userMessage/content/error/createdAt/updatedAt) WHERE projectId ORDER BY createdAt DESC。
  - `appendTrace(db, id, step)` — parse trace JSON → push step → stringify → UPDATE。

- [ ] **Step 2:** `workbench-conversations.test.mjs`(node:test): create→get→update→list→appendTrace round-trip。

- [ ] **Step 3:** `node --test server/workbench-conversations.test.mjs`

- [ ] **Step 4:** commit `feat(workbench): workbench_conversations 表 + CRUD 纯函数 + 测试`

### Task 2: 后台执行 + 5 端点 + 启动清理

**Files:** Modify `server/index.mjs`; Modify `src/api/client.js`

- [ ] **Step 1:** `index.mjs`:
  - import conversation 纯函数;createConversationsSchema(db) 加到 schema 区。
  - 启动清理:`db.exec("UPDATE workbench_conversations SET status='failed', error='Server restarted' WHERE status='running'")`。
  - `runConversation(db, convId, llmClient, apiKeyTools)` — detached async(见 spec)。
  - `resumeConversation(db, convId, approved, llmClient, apiKeyTools)` — detached。
  - `handleAgentResult(db, convId, project, out)` — paused/done 分支。
  - 5 路由:POST create / GET one / GET list / POST approve / POST deny(均 requireAdmin)。
  - POST create 注入 references(复用 P3 references 逻辑,如存在)。

- [ ] **Step 2:** `src/api/client.js` 加 `conversations: { create, get, list, approve, deny }`。

- [ ] **Step 3:** `node --check server/index.mjs && npm run build`

- [ ] **Step 4:** commit `feat(workbench): 后台执行 + 5 个 conversations 端点 + 启动清理`

### Task 3: WorkbenchChat 异步轮询改造

**Files:** Modify `src/components/workbench/WorkbenchChat.vue`; i18n keys

- [ ] **Step 1:** WorkbenchChat script 改:
  - `const conversationId = ref(null)` `const pollTimer = ref(null)` `const convStatus = ref(null)`。
  - `send()` 改:`const { id } = await workbenchApi.conversations.create({ projectId: props.projectId, message: msg, references: refs.length ? refs : undefined })` → `conversationId.value = id` → `startPolling(id)`。refs 清空。
  - `startPolling(id)`:`setInterval(2000)` → `const conv = await workbenchApi.conversations.get(id)` → 更新 turns/trace/convStatus。
    - `convStatus==='paused'` → `pendingApproval.value = JSON.parse(conv.pendingApproval)` + 停轮询。
    - `convStatus==='done'` → updateTurn(终答 content) + 停轮询。
    - `convStatus==='failed'` → errorBanner + 停轮询。
  - `decideApproval(approved)` 改:`approved ? conversations.approve(id) : conversations.deny(id)` → `startPolling(id)`。
  - `stopPolling()` helper(clearInterval)。
  - trace → turns 重建:`conv.trace` parse → tool/denied steps → 渲染。

- [ ] **Step 2:** 模板:保持现有 chat 列表 + 审批 modal 结构;turns 从轮询数据更新(convStatus badge 显示在 header)。

- [ ] **Step 3:** i18n:复用现有 `workbench.chat.*`;加 `convStatus*`(running/paused/done/failed)。

- [ ] **Step 4:** `npm run i18n:check && npm run build`

- [ ] **Step 5:** commit `feat(workbench): WorkbenchChat 异步轮询改造(状态对话 + 后台执行)`

### Task 4: 对话历史列表 + 全量验证

**Files:** Modify `src/views/WorkbenchDetail.vue`; i18n keys

- [ ] **Step 1:** WorkbenchDetail 加对话历史面板:
  - script:`const conversations = ref([])` `async function loadConversations() { conversations.value = (await workbenchApi.conversations.list(id)).conversations || [] }`。
  - onMounted/loadProject 后调 loadConversations。
  - 模板:文件树下方或独立 section——折叠 details:`<details><summary>对话历史 (N)</summary>` → 每条 `status badge + userMessage truncate + steps + time`。点击 → 可选:加载到 chat(只读)或跳转到对话查看。

- [ ] **Step 2:** `npm test && npm run i18n:check && npm run typecheck && npm run build`

- [ ] **Step 3:** commit `feat(workbench): 对话历史列表(WorkbenchDetail)+ 全量验证`
