# SP1 · 工作台对话核心(多轮 + 自动摘要)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工作台 AI 对话从单发改成 per-project 连续多轮线程 + 老轮次自动摘要,修掉「每条消息开新会话」的根因。

**Architecture:** 新增 `workbench_messages` 表存可查询轮次历史;conversation 加 `recap`/`summarizedUpTo`,project 加 `activeConversationId`(一 project 一活跃线程)。`send()` 有活跃线程就 `POST /conversations/:id/messages` 续接(append user msg → agent 拿 recap+近期全文+新消息跑 → append assistant msg → 触发异步摘要),否则新建线程。异步 summarizer 在超阈值时把老轮次 LLM 压成 recap。

**Tech Stack:** Node `http` + node:sqlite(`DatabaseSync`)+ 既有 LLM client + Vue 3 `<script setup>`。纯逻辑走 `scripts/test.mjs` 零依赖运行器;server 端点/summarizer 走 `node --test server/*.test.mjs`;前端续接走 vitest。

**Spec:** `docs/superpowers/specs/2026-08-11-workbench-conversation-core-design.md`

## Global Constraints

- **node:sqlite 迁移**:`workbench-projects.mjs` schema 函数里新表 `CREATE TABLE IF NOT EXISTS`;加列用 guarded `ALTER TABLE ... ADD COLUMN`(try/catch「列已存在」),与既有 `referencesData` 迁移同模式。
- **node:sqlite 绑定坑**:写边界强制 `undefined→null`、对象→JSON(见 memory `nodesqlite-binding-gotcha`)。
- **零新增依赖**(复用既有 marked/dompurify/prismjs/LLM client)。
- **i18n 门禁**:`npm run i18n:check` 绿;新键值含 `@` 须 `{'@'}` 转义。
- **提交前** `npm test && npm run typecheck && npm run build`。每 Task 末尾 commit。
- `requestKubernetes` 返回 `{status,headers,body}`,资源在 `.body`(别踩坑)。
- 现有分支 `main`(5173 直出);本计划改 `server/workbench-projects.mjs`、`server/workbench-summarize.mjs`(新)、`server/index.mjs`、`src/api/client.js`、`src/components/workbench/WorkbenchChat.vue`、`src/views/WorkbenchDetail.vue`。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `server/workbench-projects.mjs` | schema 迁移 + message CRUD + activeConversation + buildHistory | 改 |
| `server/workbench-summarize.mjs` | 异步摘要(老轮次 → recap) | 新 |
| `server/index.mjs` | POST `/:id/messages`(续接)、POST `/conversations`(新建+active+首消息)、GET project 返 active、GET conversation 返 recap+messages;runConversation 改吃 history | 改 |
| `src/api/client.js` | `workbenchApi.conversations.append(id, {message, references})` | 改 |
| `src/components/workbench/WorkbenchChat.vue` | send() 续接/新建分支 + recap 卡渲染 | 改 |
| `src/views/WorkbenchDetail.vue` | activeConversationId 来自 project;New=归档;点旧=续聊 | 改 |
| `server/workbench-projects.test.mjs` | schema/CRUD/buildHistory 测试 | 改 |
| `server/workbench-conversations.test.mjs` | 续接/新建端点测试 | 新 |

---

### Task 1: schema 迁移 + message/active CRUD

**Files:**
- Modify: `server/workbench-projects.mjs`
- Test: `server/workbench-projects.test.mjs`

**Interfaces:**
- Produces: `appendMessage(db, {conversationId, role, content, refs?, trace?, seq?}) → message`;`listMessages(db, conversationId) → message[]`(seq 升序);`getMaxSeq(db, conversationId) → number`;`setActiveConversation(db, projectId, conversationId)`;`getActiveConversationId(db, projectId) → string|null`;conversation 加列 `recap`/`summarizedUpTo`;project 加列 `activeConversationId`;新表 `workbench_messages`。

- [ ] **Step 1: 写失败测试**(加到 `server/workbench-projects.test.mjs`)

```js
import { createWorkbenchSchema, createConversationsSchema, createWorkbenchProjectsSchema } from './workbench-projects.mjs'
import { DatabaseSync } from 'node:sqlite'
function freshDb(){ const db = new DatabaseSync(':memory:'); createWorkbenchProjectsSchema(db); createConversationsSchema(db); db.exec('CREATE TABLE IF NOT EXISTS workbench_projects (id TEXT PRIMARY KEY)'); return db }

test('appendMessage/listMessages/getMaxSeq: seq 单调递增,按序返回', () => {
  const db = freshDb()
  db.prepare("INSERT INTO workbench_projects (id) VALUES ('p1')").run()
  createConversation(db, { projectId: 'p1', system: '', userMessage: 'first' })
  const conv = listConversations(db, 'p1')[0]
  const u = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
  const a = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'yo' })
  assert.equal(u.seq, 1); assert.equal(a.seq, 2)
  assert.equal(getMaxSeq(db, conv.id), 2)
  const all = listMessages(db, conv.id)
  assert.equal(all.length, 2); assert.equal(all[0].role, 'user'); assert.equal(all[1].content, 'yo')
})

test('activeConversation: setActive/get 一 project 一活跃', () => {
  const db = freshDb()
  setActiveConversation(db, 'p1', 'c1')
  assert.equal(getActiveConversationId(db, 'p1'), 'c1')
  setActiveConversation(db, 'p1', 'c2')
  assert.equal(getActiveConversationId(db, 'p1'), 'c2')
})

test('迁移:conversation 有 recap/summarizedUpTo 列', () => {
  const db = freshDb()
  const conv = listConversations(db, 'p1')?.[0] || (() => { createConversation(db,{projectId:'p1',system:'',userMessage:'x'}); return listConversations(db,'p1')[0] })()
  // 列存在 + 默认值
  const row = db.prepare('SELECT recap, summarizedUpTo FROM workbench_conversations WHERE id=?').get(conv.id)
  assert.equal(row.summarizedUpTo, 0); assert.equal(row.recap, null)
})
```
> 注:`freshDb` 里要先 `createWorkbenchProjectsSchema` 再 `createConversationsSchema`(顺序对齐既有);若 `workbench_projects` 表的创建在别的 schema 函数,调用对应的。implementer 按现有 schema 函数名核对。

- [ ] **Step 2: 跑测试确认失败** — `node --test server/workbench-projects.test.mjs`(FAIL:appendMessage 未定义 / 列不存在)。

- [ ] **Step 3: 实现 schema 迁移 + CRUD**(加到 `workbench-projects.mjs`)

```js
// schema 函数里(createConversationsSchema / createWorkbenchProjectsSchema 之后)加:
db.exec(`CREATE TABLE IF NOT EXISTS workbench_messages (
  id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '', refs TEXT, trace TEXT,
  seq INTEGER NOT NULL, createdAt INTEGER NOT NULL
)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_wb_messages_conv ON workbench_messages(conversationId, seq)`)
// 迁移加列(既有表没有):
try { db.exec('ALTER TABLE workbench_conversations ADD COLUMN recap TEXT') } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE workbench_conversations ADD COLUMN summarizedUpTo INTEGER NOT NULL DEFAULT 0') } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE workbench_projects ADD COLUMN activeConversationId TEXT') } catch { /* 列已存在 */ }
```
```js
import { randomUUID } from 'node:crypto'
export function appendMessage(db, { conversationId, role, content, refs, trace, seq }) {
  const finalSeq = seq ?? (getMaxSeq(db, conversationId) + 1)
  const id = randomUUID()
  db.prepare(`INSERT INTO workbench_messages (id,conversationId,role,content,refs,trace,seq,createdAt) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, conversationId, role, content ?? '', refs ? JSON.stringify(refs) : null, trace ?? null, finalSeq, Date.now())
  return db.prepare('SELECT * FROM workbench_messages WHERE id=?').get(id)
}
export function listMessages(db, conversationId) {
  return db.prepare('SELECT * FROM workbench_messages WHERE conversationId=? ORDER BY seq ASC').all(conversationId)
}
export function getMaxSeq(db, conversationId) {
  return db.prepare('SELECT MAX(seq) AS m FROM workbench_messages WHERE conversationId=?').get(conversationId).m ?? 0
}
export function setActiveConversation(db, projectId, conversationId) {
  db.prepare('UPDATE workbench_projects SET activeConversationId=? WHERE id=?').run(conversationId, projectId)
}
export function getActiveConversationId(db, projectId) {
  return db.prepare('SELECT activeConversationId FROM workbench_projects WHERE id=?').get(projectId)?.activeConversationId ?? null
}
```
> `getProject`/`listConversations` 现已自动带新列(SELECT *);无需改。

- [ ] **Step 4: 跑测试确认通过** — `node --test server/workbench-projects.test.mjs`。

- [ ] **Step 5: typecheck + commit** — `npm run typecheck`;`git add server/workbench-projects.mjs server/workbench-projects.test.mjs`;`git commit -m "feat(workbench): workbench_messages 表 + 消息 CRUD + activeConversationId"`。

---

### Task 2: buildHistory(多轮上下文装配纯逻辑)

**Files:**
- Modify: `server/workbench-projects.mjs`
- Test: `server/workbench-projects.test.mjs`

**Interfaces:**
- Produces: `buildHistory(db, conv) → history[]`(agent 可吃的 `[{role,content}, ...]`):`[recap 段(若有), ...summarizedUpTo<seq 的全文消息]`。recap 作为 `{role:'system', content:'Earlier in this conversation (summary):\n...'}` 放最前。

- [ ] **Step 1: 写失败测试**

```js
test('buildHistory: recap 在前 + summarizedUpTo 之后的全文消息', () => {
  const db = freshDb()
  createConversation(db, { projectId: 'p1', system: '', userMessage: 'x' })
  const conv = listConversations(db, 'p1')[0]
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'old-q' })      // seq1
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'old-a' }) // seq2
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'new-q' })      // seq3
  // 设 recap 覆盖 seq1-2
  db.prepare('UPDATE workbench_conversations SET recap=?, summarizedUpTo=? WHERE id=?').run('老对话摘要', 2, conv.id)
  const conv2 = getConversation(db, conv.id)
  const h = buildHistory(db, conv2)
  assert.equal(h[0].role, 'system'); assert.match(h[0].content, /老对话摘要/)
  assert.equal(h[1].role, 'user'); assert.equal(h[1].content, 'new-q')  // 只剩 seq3 全文
  assert.equal(h.length, 2)
})
```

- [ ] **Step 2: 跑确认失败**(`buildHistory is not defined`)。

- [ ] **Step 3: 实现**

```js
export function buildHistory(db, conv) {
  const msgs = listMessages(db, conv.id)
  const upTo = conv.summarizedUpTo ?? 0
  const history = []
  if (conv.recap) history.push({ role: 'system', content: `Earlier in this conversation (summary):\n${conv.recap}` })
  for (const m of msgs) {
    if (m.seq <= upTo) continue            // 已进 recap,跳过全文
    history.push({ role: m.role, content: m.content })
  }
  return history
}
```

- [ ] **Step 4: 跑确认通过**。

- [ ] **Step 5: commit** — `git commit -m "feat(workbench): buildHistory 多轮上下文装配(recap + 近期全文)"`。

---

### Task 3: 异步 summarizer

**Files:**
- Create: `server/workbench-summarize.mjs`
- Test: `server/workbench-summarize.test.mjs`

**Interfaces:**
- Produces: `maybeSummarize(db, convId, llmClient, { thresholdTurns=12, recentKeep=8 }) → Promise<boolean>`(是否触发了摘要);常量 `SUMMARIZE_PROMPT`。
- Consumes:`listMessages`/`getMaxSeq`/`updateConversation`/`getConversation`(Task 1/既有)+ `llmClient`(`{ run({messages}) → {content} }`,与既有 createLlmClient 同形)。

- [ ] **Step 1: 写失败测试**(用桩 llmClient)

```js
import { maybeSummarize } from './workbench-summarize.mjs'
import { createWorkbenchProjectsSchema, createConversationsSchema, createConversation, appendMessage, listConversations, getConversation } from './workbench-projects.mjs'
import { DatabaseSync } from 'node:sqlite'
function freshDb(){ const db=new DatabaseSync(':memory:'); createWorkbenchProjectsSchema(db); createConversationsSchema(db); db.exec("CREATE TABLE IF NOT EXISTS workbench_projects (id TEXT PRIMARY KEY)"); db.prepare("INSERT INTO workbench_projects (id) VALUES ('p1')").run(); return db }

test('未达阈值不摘要', async () => {
  const db = freshDb(); createConversation(db,{projectId:'p1',system:'',userMessage:'x'})
  const conv = listConversations(db,'p1')[0]
  for (let i=0;i<5;i++) { appendMessage(db,{conversationId:conv.id,role:'user',content:'q'}); appendMessage(db,{conversationId:conv.id,role:'assistant',content:'a'}) }
  const llm = { run: async () => { throw new Error('不该调') } }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(fired, false)
})

test('达阈值:把老消息摘成 recap,前移 summarizedUpTo', async () => {
  const db = freshDb(); createConversation(db,{projectId:'p1',system:'',userMessage:'x'})
  const conv = listConversations(db,'p1')[0]
  for (let i=0;i<10;i++) { appendMessage(db,{conversationId:conv.id,role:'user',content:`q${i}`}); appendMessage(db,{conversationId:conv.id,role:'assistant',content:`a${i}`}) } // 20 条
  const llm = { run: async ({ messages }) => { return { content: 'RECAP:' + messages.length } } }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(fired, true)
  const c = getConversation(db, conv.id)
  assert.match(c.recap, /RECAP:/); assert.ok(c.summarizedUpTo > 0)
})
```

- [ ] **Step 2: 跑确认失败**(模块不存在)。

- [ ] **Step 3: 实现** `server/workbench-summarize.mjs`

```js
import { listMessages, getMaxSeq, updateConversation, getConversation } from './workbench-projects.mjs'
const SUMMARIZE_PROMPT = '把以下对话老片段压成紧凑 recap,保留关键决策、涉及资源、结论与未决问题,丢弃寒暄/中间步骤细节。用中文,不超过 300 字。'

export async function maybeSummarize(db, convId, llmClient, { thresholdTurns = 12, recentKeep = 8 } = {}) {
  const conv = getConversation(db, convId)
  if (!conv) return false
  const maxSeq = getMaxSeq(db, convId)
  const unsummarized = maxSeq - (conv.summarizedUpTo ?? 0)
  if (unsummarized <= thresholdTurns) return false                  // 未达阈值
  const upTo = maxSeq - recentKeep                                  // 留 recentKeep 条全文
  if (upTo <= (conv.summarizedUpTo ?? 0)) return false              // 没新东西可摘
  const oldMsgs = listMessages(db, convId).filter(m => m.seq <= upTo && m.seq > (conv.summarizedUpTo ?? 0))
  const transcript = oldMsgs.map(m => `${m.role}: ${m.content}`).join('\n')
  try {
    const out = await llmClient.run({ messages: [
      { role: 'system', content: SUMMARIZE_PROMPT },
      { role: 'user', content: transcript },
    ] })
    const seg = out?.content?.trim()
    if (!seg) return false
    const newRecap = conv.recap ? `${conv.recap}\n\n${seg}` : seg
    updateConversation(db, convId, { recap: newRecap, summarizedUpTo: upTo })
    return true
  } catch { return false }  // 摘失败不阻塞对话
}
```
> `llmClient.run` 的签名以既有 `createLlmClient` 为准;若它是 `complete({messages})` 或别的名,implementer 按现有 `server/llm.mjs` + agent 调用处对齐(在 Task 4 的 runConversation 里能看到 llmClient 怎么被 agent 用,沿用同一调用形态)。

- [ ] **Step 4: 跑确认通过** — `node --test server/workbench-summarize.test.mjs`。

- [ ] **Step 5: commit** — `git add server/workbench-summarize.mjs server/workbench-summarize.test.mjs`;`git commit -m "feat(workbench): 异步 summarizer(老轮次→recap,阈值触发)"`。

---

### Task 4: 续接端点 POST /conversations/:id/messages + runConversation 改吃 history

**Files:**
- Modify: `server/index.mjs`(POST `/:id/messages` 新端点;`runConversation` 重构)
- Test: `server/workbench-conversations.test.mjs`(新)

**Interfaces:**
- Consumes:`appendMessage`/`buildHistory`/`maybeSummarize`/`getConversation`/`updateConversation`/`appendTrace`(Task 1-3 + 既有)+ 既有 @-ref 拉取逻辑(`requestKubernetes` .body)+ `getLlmConfig`/`createLlmClient`/`createAgentRunner`。
- Produces:`POST /api/workbench/conversations/:id/messages {message, references} → {status}`。

- [ ] **Step 1: 写失败测试**(端点级,桩 db/llm。聚焦「续接 append + agent 拿到 history」)

```js
// server/workbench-conversations.test.mjs —— 若端点与 db/llm 强耦合难桩,改为对 runConversation 的 buildHistory 集成测试:
// 至少断言:续接同一线程第 2 条消息时,传给 agent 的 history 含第 1 轮。
// implementer 按现有 server/index.mjs 的可测性决定(若 runConversation 是闭包无法直测,就把 buildHistory 的产出在端点里可观测,或抽 runConversation 接收 history 为参数后单测它)。
test('runConversation: 第 2 轮 history 含第 1 轮(多轮)', async () => {
  // 建 project + conversation + 2 条消息;调 runConversation(convId, stubLlm);
  // 断言 stubLlm 收到的 history 含第 1 轮 user/assistant + 新 user。
  // 见 Task 4 Step 3 把 runConversation 重构成接收 history(buildHistory 产出)。
})
```
> 若 `server/index.mjs` 的 `runConversation` 是模块内闭包、无法从测试 import:本 Task 先把 `runConversation` 重构成接收 `{ conv, history, llmClient }` 的可测函数(或抽到 `server/workbench-agent.mjs`),再写上述测试。这是必要的小重构(也利好 SP2)。

- [ ] **Step 2: 跑确认失败**。

- [ ] **Step 3: 重构 runConversation + 加续接端点**(index.mjs)

  3a. `runConversation` 改吃 history:
  ```js
  async function runConversation(convId, llmClient) {
    try {
      const conv = getConversation(db, convId)
      if (!conv) return
      const project = getProject(db, conv.projectId)
      if (!project) { updateConversation(db, convId, { status: 'failed', error: '项目不存在' }); return }
      const history = buildHistory(db, conv)                         // [recap?, ...近期全文(末条是新 user)]
      const { ctx } = buildWbCtx(project)
      const { run } = createAgentRunner({ llmClient, workbench: ctx })
      const out = await run({ system: conv.system, history, onStep: e => appendTrace(db, convId, e) })
      handleAgentResult(convId, project, out)                        // done 时 append assistant message(见 3b)
    } catch (err) { updateConversation(db, convId, { status: 'failed', error: err.message }) }
  }
  ```
  3b. `handleAgentResult` 的 `done` 分支,append assistant message(除既有 updateConversation 外):
  ```js
  // 在 done 分支里追加:
  appendMessage(db, { conversationId: convId, role: 'assistant', content: out.content || '', trace: JSON.stringify(out.trace || []) })
  ```
  3c. 新端点(放在 GET /conversations/:id 之前,路径更具体的先匹配):
  ```js
  if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/messages$/) && req.method === 'POST') {
    const ps = requireAdmin(req, res); if (!ps) return
    try {
      const id = url.pathname.split('/')[4]
      const input = await readBody(req)
      const conv = getConversation(db, id)
      if (!conv) return sendJson(res, 404, { message: '对话不存在' })
      const project = getProject(db, conv.projectId)
      if (!project) return sendJson(res, 404, { message: '项目不存在' })
      if (project.ownerId !== ps.userId && ps.role !== 'admin') return sendJson(res, 403, { message: '无权访问' })
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) return sendJson(res, 400, { message: 'LLM 未配置' })
      // append user message(干净;refs 存原始,资源另拉)
      appendMessage(db, { conversationId: id, role: 'user', content: String(input.message), refs: Array.isArray(input.references) ? input.references : null })
      // @-ref 资源拉取 + 注入到最新 user 消息内容(复用现有 @-ref 注入逻辑:取 .body,拼到该 message 的 content)——
      //   因 buildHistory 读 message.content,把资源前缀拼进「最新 user 消息」即可被 agent 看到:
      const refsCtx = await buildRefsContext(project, input.references)   // 复用/抽出现有 @-ref 拉取(见下注)
      if (refsCtx) {
        const maxSeq = getMaxSeq(db, id)
        db.prepare('UPDATE workbench_messages SET content = ? WHERE conversationId=? AND seq=?').run(`${refsCtx}\n\n${input.message}`, id, maxSeq)
      }
      updateConversation(db, id, { status: 'running' })
      const llmClient = createLlmClient({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model })
      runConversation(id, llmClient)                                  // detached
      maybeSummarize(db, id, llmClient).catch(() => {})              // 异步摘要,失败忽略
      return sendJson(res, 200, { status: 'running' })
    } catch (e) { return sendJson(res, e.status || 500, { message: e?.message || '续接失败' }) }
  }
  ```
  > `buildRefsContext(project, references)`:把现有 `POST /conversations` 里的 @-ref 拉取循环(KIND_API_PATH + requestKubernetes .body + JSON)抽成这个函数,返回 `Referenced resources:\n...` 字符串(无 references 则返回 '')。**先把这段从现有 POST /conversations 抽出**(Task 5 会复用)。

- [ ] **Step 4: 跑测试 + 手测** — `node --test server/workbench-conversations.test.mjs`;启网关,对一条已有 conversation 调 `POST /:id/messages`(curl)确认 append + agent 续接。

- [ ] **Step 5: commit** — `git commit -m "feat(workbench): POST /conversations/:id/messages 续接 + runConversation 吃 history(多轮核心)"`。

---

### Task 5: 新建端点 set active + 首消息;GET project/conversation 返新字段

**Files:**
- Modify: `server/index.mjs`

**Interfaces:**
- Produces:`POST /conversations`(新建)额外 `setActiveConversation` + append 首条 user message + 用 `buildHistory`/`runConversation`(与续接同路径);GET `/projects/:id` 返 `activeConversationId`;GET `/conversations/:id` 返 `recap`/`summarizedUpTo`/`messages`。

- [ ] **Step 1: 写测试**(端点:新建后 project.activeConversationId==新 conv;首条消息在 workbench_messages;GET conversation 含 messages)。

- [ ] **Step 2: 跑确认失败**。

- [ ] **Step 3: 实现**
  - `POST /conversations`:在现有 createConversation 后,`setActiveConversation(db, projectId, conv.id)` + `appendMessage(db,{conversationId:conv.id,role:'user',content:input.message,refs:input.references})` + `runConversation(conv.id, llmClient)`(runConversation 现在读 buildHistory,首条消息已在表里)+ `maybeSummarize`。响应 `{id, status:'running', references}`(references = 拉到的资源,供卡片,既有逻辑保留)。
  - `GET /projects/:id`(找现有该端点):返回对象加 `activeConversationId: getActiveConversationId(db, id)`。
  - `GET /conversations/:id`:返回加 `recap: conv.recap, summarizedUpTo: conv.summarizedUpTo, messages: listMessages(db, id)`。
  - 旧单发兼容:GET conversation 的 `messages` 若为空(老数据),前端 fallback 用 conv.userMessage/content(单轮渲染)——前端 Task 6 处理。

- [ ] **Step 4: 跑测试 + 手测**(curl 新建 → active 设置;GET 返 messages)。

- [ ] **Step 5: commit** — `git commit -m "feat(workbench): 新建线程设 active+首消息;GET project/conversation 返多轮字段"`。

---

### Task 6: 前端 send() 续接/新建 + recap 渲染

**Files:**
- Modify: `src/api/client.js`、`src/components/workbench/WorkbenchChat.vue`
- Test: `src/components/workbench/__tests__/WorkbenchChat.test.js`(若无则新建)

**Interfaces:**
- Consumes:`project.activeConversationId`(prop 或 WorkbenchDetail 传);`workbenchApi.conversations.append`。
- Produces:`send()` 续接/新建分支;`WorkbenchChat` 接收 `activeConversationId` prop(从 project 取)。

- [ ] **Step 1: 写测试**(vitest:有 activeConversationId → 调 `conversations.append`;无 → 调 `conversations.create`)。桩 `workbenchApi`。

- [ ] **Step 2: 跑确认失败**。

- [ ] **Step 3: 实现**
  - `src/api/client.js`:`workbenchApi.conversations.append = (id, { message, references }) => fetch(`/api/workbench/conversations/${id}/messages`, { method:'POST', ... }).then(r=>r.json())`(对齐既有 create/get 的写法)。
  - `WorkbenchChat.vue` send():把现有「每次 create」改成:
    ```js
    if (props.activeConversationId) {
      const { status } = await workbenchApi.conversations.append(props.activeConversationId, payload)
      conversationId.value = props.activeConversationId; convStatus.value = 'running'; startPolling(props.activeConversationId)
    } else {
      const { id } = await workbenchApi.conversations.create(payload)
      conversationId.value = id; convStatus.value = 'running'; emit('conversation-created', id); startPolling(id)
    }
    ```
    新增 prop `activeConversationId`(String)。
  - **pollOnce**:done 时渲染来自 conv.messages 的历史(见 Task 7 的 ChatTurn 列表);recap 渲染见下。
  - recap 卡:ConversationTurn 顶部,若 `conv.recap`,渲染一个可折叠 `details`「Earlier (summary)」+ recap 文本。

- [ ] **Step 4: 跑 vitest + 手测**(有 active → 续接;无 → 新建)。

- [ ] **Step 5: commit** — `git commit -m "feat(workbench): 前端 send() 续接/新建分支 + recap 卡"`。

---

### Task 7: 前端 sidebar 生命周期 + 多轮渲染(WorkbenchDetail)

**Files:**
- Modify: `src/views/WorkbenchDetail.vue`

- [ ] **Step 1:** `activeConversationId` 从 `project.activeConversationId` 初始化(后端权威);`selectConversation(id)` 设本地 + 可选 `setActiveConversation`(点旧线程时设为活跃以便续聊——加 `workbenchApi.projects.setActive(projectId, id)` 或复用 GET 后端已返)。**New 按钮**:`activeConversationId = null`(归档当前;下条消息走新建)。
- [ ] **Step 2:** 把 `WorkbenchChat :conversation-id="activeConversationId"` 改为同时传 `:active-conversation-id="activeConversationId"`(供 send 判分支)。
- [ ] **Step 3:** 多轮渲染:WorkbenchChat 的 pollOnce 加载时,用 `conv.messages`(若非空)渲染 ChatTurn 列表(每条 message 一个 ChatTurn;user 用 refs 卡片,assistant 用 markdown);空则 fallback 旧单轮(content/userMessage)。recap 卡在列表顶。
- [ ] **Step 4:** vitest/hand-test:点旧线程 → 加载其 messages → 续聊一条 → 续接到该线程(不再新建)。
- [ ] **Step 5:** commit — `git commit -m "feat(workbench): sidebar 多线程生命周期 + 多轮消息渲染"`。

---

### Task 8: 端到端验证 + 终极门禁

**Files:** 无(验证 + 门禁)

- [ ] **Step 1:** 起服务(5173 + 8787,保留 ANTHROPIC env)。
- [ ] **Step 2:** 浏览器:登录 → workbench → 项目 → 连发 3 条消息 → **第 3 条 agent 记得前 2 条**(问「刚才说的那个 pod 再看一下」→ agent 接得上)。确认不再每次新建(同一 thread)。
- [ ] **Step 3:** 灌 >12 条消息 → 确认 recap 生成(线程顶出现「Earlier (summary)」卡)+ agent 上下文不爆。
- [ ] **Step 4:** sidebar:New 开新线程;点旧线程 → 续聊接得上。
- [ ] **Step 5:** 终极门禁 `npm run i18n:check && npm run typecheck && npm test && npm run build`。
- [ ] **Step 6:** commit(若有微调)+ 收口。

---

## Self-Review

- **Spec 覆盖**:数据模型(T1)、buildHistory/上下文装配(T2,T7)、summarizer(T3)、续接端点+runConversation(T4)、新建+active+GET 字段(T5)、send 续接+recap 卡(T6)、sidebar 生命周期+多轮渲染(T7)、验证(T8)——spec 各节均有任务。
- **占位符**:无 TBD;每步含实代码或可执行命令。Task 4 的「runConversation 重构为可测」是必要小重构,已显式说明(非占位)。
- **类型/命名一致**:`appendMessage/listMessages/getMaxSeq/setActiveConversation/getActiveConversationId/buildHistory/maybeSummarize`(T1-T3 定义,T4-T7 消费)——一致;`activeConversationId`(后端列 + 前端 prop)一致。
- **偏离 spec**:`buildRefsContext` 抽取(spec 没强制,但避免 T4/T5 重复 @-ref 拉取;与 spec §7「@-ref 注入」一致)。runConversation 重构为可测(spec 未明说,但 spec §5 的 detached run 隐含;可测化是必要工程实践,也利好 SP2)。

## 完成标志
- 同一线程连发多条 → agent 记得前文(多轮);长线程 → recap 自动生成;sidebar 多线程 + New + 续聊;门禁全绿;既有 @-ref 卡片/审批/Cursor 渲染不破。
