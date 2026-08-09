# 工作台 V2 P5 — 有状态对话实体

- 日期:2026-08-09
- 分支:`feat/workbench-v2-p1`(worktree)
- 状态:APPROVED(brainstorm 2026-08-09)
- 关联:V2 P5;依赖 P2(WorkbenchChat)+ agent.mjs(现有)

## 背景

当前 agent chat 是无状态的:checkpoint/resume 靠客户端 round-trip(服务端返 `pending_approval` + 全状态 → 客户端存 → 审批后回传)。关浏览器丢状态;无对话历史;不能后台跑。

P5:对话成为**服务端一级实体**——持久化、后台执行、轮询状态、服务端 checkpoint/resume。

## 范围

**做:**
1. `workbench_conversations` 表 + CRUD 纯函数。
2. 5 个端点(POST create / GET one / GET list / POST approve / POST deny)。
3. 后台执行(`runConversation` / `resumeConversation` detached Promise)。
4. 启动清理(orphaned running → failed)。
5. WorkbenchChat 改造:同步→异步轮询。
6. 对话历史列表(WorkbenchDetail 内)。

**不做:**SSE/WebSocket / 对话编辑 / 多对话并行 UI 强调 / 导出。

## 设计

### 1. 数据模型(`workbench-projects.mjs` 加 schema + 纯函数)

```sql
CREATE TABLE IF NOT EXISTS workbench_conversations (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  system TEXT,
  messages TEXT,
  queue TEXT,
  denied TEXT,
  pendingApproval TEXT,
  steps INTEGER DEFAULT 0,
  trace TEXT,
  content TEXT,
  error TEXT,
  userMessage TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
)
```

纯函数: `createConversation(db, {projectId, system, userMessage})` / `getConversation(db, id)` / `updateConversation(db, id, patch)` / `listConversations(db, projectId)` / `appendTrace(db, id, step)`(parse trace JSON → push → stringify → update)。

### 2. 后台执行(`server/index.mjs`)

```js
// 后台跑对话(detached Promise,不阻塞 HTTP 响应)
async function runConversation(db, convId, llmClient, apiKeyTools) {
  try {
    const conv = getConversation(db, convId)
    const project = getProject(db, conv.projectId)
    const { run } = createAgentRunner({ llmClient, workbench: buildWorkbenchCtx(project) })
    const out = await run({
      system: conv.system,
      history: [{ role: 'user', content: conv.userMessage }],
      onStep: e => appendTrace(db, convId, e)
    })
    handleAgentResult(db, convId, project, out)
  } catch (err) {
    updateConversation(db, convId, { status: 'failed', error: err.message })
  }
}

// checkpoint → paused; done → done + history
function handleAgentResult(db, convId, project, out) {
  if (out.status === 'pending_approval') {
    updateConversation(db, convId, {
      status: 'paused',
      messages: JSON.stringify(out.messages),
      queue: JSON.stringify(out.queue),
      denied: JSON.stringify(out.denied),
      pendingApproval: JSON.stringify(out.pending),
      steps: out.steps
    })
  } else {
    updateConversation(db, convId, {
      status: 'done', messages: JSON.stringify(out.messages),
      content: out.content, steps: out.steps
    })
    appendHistory(db, project.id, 'user', getConversation(db, convId).userMessage)
    appendHistory(db, project.id, 'assistant', out.content || '')
  }
}

// resume from paused
async function resumeConversation(db, convId, approved, llmClient, apiKeyTools) {
  const conv = getConversation(db, convId)
  const project = getProject(db, conv.projectId)
  updateConversation(db, convId, { status: 'running', pendingApproval: null })
  try {
    const { run } = createAgentRunner({ llmClient, workbench: buildWorkbenchCtx(project) })
    const pending = JSON.parse(conv.pendingApproval)
    const out = await run({
      resume: {
        messages: JSON.parse(conv.messages), queue: JSON.parse(conv.queue),
        denied: JSON.parse(conv.denied), steps: conv.steps,
        toolCallId: pending.toolCallId, approved
      },
      onStep: e => appendTrace(db, convId, e)
    })
    handleAgentResult(db, convId, project, out)
  } catch (err) {
    updateConversation(db, convId, { status: 'failed', error: err.message })
  }
}
```

### 3. 端点

- `POST /api/workbench/conversations` `{ projectId, message, references? }`:
  - requireAdmin;取 project;注入 references(同 P3 逻辑);getLlmConfig;createConversation → `runConversation(...)`(detached,不 await)→ 返 `{ id, status: 'running' }`。
- `GET /api/workbench/conversations/:id`:返 `{ id, status, steps, content, error, pendingApproval, trace }`(不返完整 messages——太大;客户端从 trace + content 渲染)。
- `GET /api/workbench/conversations?projectId=X`:返 `[{ id, status, steps, userMessage, content, createdAt, updatedAt }]`(slim,列表用)。
- `POST /api/workbench/conversations/:id/approve`:requireAdmin → `resumeConversation(db, id, true, ...)`(detached)→ 返 `{ status: 'running' }`。
- `POST /api/workbench/conversations/:id/deny`:同上 → `resumeConversation(db, id, false, ...)`。

### 4. 启动清理

Gateway 启动时:
```js
db.exec("UPDATE workbench_conversations SET status='failed', error='Server restarted (orphaned running)' WHERE status='running'")
```

### 5. WorkbenchChat 改造

- `send()` 改:
  1. `POST /conversations { projectId, message, references }` → `{ id, status:'running' }`。
  2. `startPolling(id)` → 每 2s `GET /conversations/:id` → 更新 turns + trace。
  3. `status==='paused'` → 弹审批 modal(用 `pendingApproval` 数据)。
  4. approve/deny → `POST .../approve` → 继续轮询。
  5. `status==='done'` → 显示 `content` + 停轮询。
  6. `status==='failed'` → 显示 `error` + 停轮询。
- `turns` 从 trace 重建:`trace.filter(e => e.type === 'tool' || e.type === 'denied')` → tool 调用列表;`content` → 终答。
- 审批 modal 逻辑不变(parse pendingApproval;approve/deny 按钮)。

### 6. 对话历史列表

WorkbenchDetail 加一个「对话历史」面板(折叠 details 或侧边小列表):
- `GET /conversations?projectId=X` → 每条显示 `status badge + userMessage(truncate) + steps + relative time`。
- 点击 → 加载该对话的 trace + content 到 chat 区域(只读)。

### 7. client API

```js
conversations: {
  create: (payload) => platformHttp.request('/api/workbench/conversations', { method: 'POST', body: JSON.stringify(payload) }),
  get: (id) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}`),
  list: (projectId) => platformHttp.request(`/api/workbench/conversations?projectId=${encodeURIComponent(projectId)}`),
  approve: (id) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  deny: (id) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}/deny`, { method: 'POST' }),
}
```

## 错误处理
- LLM 未配置 → conversation 直接 `failed` + error "LLM not configured"。
- agent loop 异常 → `failed` + error message。
- 服务重启 → orphaned running → `failed`。
- 轮询超时(client 端 5 min 无状态变化) → 提示「对话可能卡住,重试?」。

## 测试
- 纯函数:createConversation/getConversation/updateConversation/listConversations/appendTrace → node:test。
- 端点:mock agent.run → 验证 status 转换(running→paused→done)。
- 前端:build + i18n:check。
- 手测:创建对话 → 轮询 → 审批 → 终答。

## 非目标
SSE/WebSocket / 对话编辑 / 并行对话 UI / 导出 / 对话搜索 / trace 可视化增强。
