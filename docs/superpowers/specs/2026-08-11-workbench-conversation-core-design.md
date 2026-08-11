# SP1 · 对话核心(工作台多轮对话 + 自动摘要)设计

> 日期:2026-08-11|属于:AliangBoard AI 工作台产品规划(whole-workbench 分解的 SP1,地基)
> 触发:用户反馈「每次对话都开新会话,接不上」——根因是对话模型是**单发**(createConversation 单 userMessage → 一次 agent run → done),从未建过多轮。
> 上游分解:`docs/superpowers/specs`(本 SP)+ SP2 Agent/工具 / SP3 知识台账 / SP4 项目工作区 / SP5 上下文注入 / SP6 治理。

## 1. 目标 / 背景

把工作台 AI 对话从「单发」升级为 **per-project 连续多轮线程**(Cursor 式):
- 同一 project 内,每条消息**续接**当前线程,agent 记得整条线(历史 + 项目上下文)。
- 长线程**自动摘要**老轮次为 recap,近期保留全文——避免爆上下文窗口、丢脉络。
- sidebar 成为该 project 的**线程历史**;「New」显式开新线程;旧线程可重开续聊。

**非目标(明确排除)**:
- agent 能力/工具/审批流不变(SP2 范畴)。
- ledger/distill 内容不变(SP3),本 SP 只定义「ledger 怎么注入 system」的挂点。
- @-mention/ResourceCard 渲染不变(SP5,已完成),本 SP 只定义「新消息的 @-ref 怎么挂进 history」。
- 平台治理(key/LLM/审计)不变(SP6)。

## 2. 已锁定决策(brainstorming 结论)

| 维度 | 决策 |
|---|---|
| 对话模型 | **per-project 连续线程**(Cursor 式):一 project 一活跃线程,消息续接,agent 全程记忆 |
| 上下文管理 | **自动摘要老轮次**:超阈值时,老消息 LLM 摘成 recap 留在上下文,近期保留全文 |
| 实现架构 | **专用 `workbench_messages` 表 + 异步 summarizer**(查询友好、可扩展、send 不被摘要阻塞) |

## 3. 数据模型

### 3.1 新表 `workbench_messages`(轮次历史,可查询)
```sql
CREATE TABLE IF NOT EXISTS workbench_messages (
  id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  role TEXT NOT NULL,              -- 'user' | 'assistant'
  content TEXT NOT NULL DEFAULT '',
  refs TEXT,                       -- JSON: user 消息的 @-mention 资源 [{kind,namespace,name,resource?}]
  trace TEXT,                      -- JSON: assistant 消息的工具调用事件数组(同现 trace 结构)
  seq INTEGER NOT NULL,            -- 线程内单调递增(0,1,2...),便于「最近 N 条」「summarizedUpTo」
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wb_messages_conv ON workbench_messages(conversationId, seq);
```
- 一个 turn = 一条 user 消息 + 一条 assistant 消息(seq 连续)。
- assistant 的工具调用轨迹存它自己的 `trace`(不再堆在 conversation 上)。

### 3.2 `workbench_conversations` 加列(迁移,guarded ALTER,见 §9)
- `recap TEXT` —— 已摘要老轮次的累积摘要(可能为空)。
- `summarizedUpTo INTEGER NOT NULL DEFAULT 0` —— 已摘要进 recap 的最大 seq(此值及以下以 recap 代表,以上保留全文)。

> 现有 `messages/runContext/queue/denied/pendingApproval/trace/content` 列:**保留**用于 agent checkpoint/resume(单次 run 的中间态),不作为多轮展示历史。展示历史走 `workbench_messages`。`content`(终答)在 done 时同步写到最新 assistant message。

### 3.3 `workbench_projects` 加列
- `activeConversationId TEXT` —— 该 project 当前活跃线程(一 project 至多一个活跃)。新建线程时写入;「New」/重开时切换。

## 4. API 变更

| 方法 | 端点 | 行为 |
|---|---|---|
| GET | `/api/workbench/projects/:id` | 返回里**加 `activeConversationId`** |
| POST | `/api/workbench/conversations` `{projectId, message, references}` | **新建线程**:createConversation + 写首条 user message + run(续接逻辑同下)+ 设 `project.activeConversationId`。响应 `{id, status, references}`(references = 拉到的完整资源,见既有 @-ref 卡片) |
| POST | `/api/workbench/conversations/:id/messages` `{message, references}` | **续接(多轮核心)**:append user message(seq=最大+1)→ 拉取 @-ref 资源 → run(传 recap + 最近全文 + 新消息)→ done 时 append assistant message(+trace)→ 触发摘要(若超阈)。响应 `{status}`(轮询沿用) |
| GET | `/api/workbench/conversations/:id` | 返回 `recap` + `summarizedUpTo` + **messages**(全文,按 seq)+ 现有 status/trace 等。前端据此渲染「recap 卡 + 全文轮次」 |
| 现有 | polling `/conversations/:id`、approve/deny | **不变**;done/trace 同步到最新 assistant message |

> `send()` 前端:有 `activeConversationId` → POST `/:id/messages`(续接);无 → POST `/conversations`(新建)。**这是修多轮 bug 的核心**:不再每次 create。

## 5. 多轮 send 流(修核心 bug)

```
前端 send(msg, refs):
  if project.activeConversationId:
    POST /conversations/<activeId>/messages {msg, refs}     # 续接
  else:
    POST /conversations {projectId, msg, refs}              # 新建线程 + 设 active

后端 POST /:id/messages (续接):
  1. append workbench_messages(conversationId, role:'user', content:msg, refs, seq=nextSeq)
  2. 取该 @-ref 的完整资源(@pod:x → requestKubernetes .body,既有逻辑)
  3. 组装 history(见 §7)→ run agent(续接;checkpoint/审批不变)
  4. agent done → append workbench_messages(role:'assistant', content, trace, seq=nextSeq+1)
                + updateConversation(status:'done', content, trace, ...)
  5. 若 (maxSeq - summarizedUpTo) > THRESHOLD → 异步触发 summarize(§6)
  6. detached,立即响应 {status:'running'};前端轮询
```

## 6. 自动摘要管线(异步)

- **阈值**:`THRESHOLD_TURNS`(默认 12 条未摘要消息)或估算 token 超 `THRESHOLD_TOKENS`(默认 12k)。任一满足触发。
- **触发点**:续接 send 的 step 5(异步,不阻塞响应);可选外加一个低频定时 sweep(兜底)。
- **summarizer**:
  1. 取 `summarizedUpTo < seq <= (maxSeq - RECENT_KEEP)` 的全文消息(`RECENT_KEEP` 默认 8 条留在全文窗口)。
  2. LLM 提示:「把以下对话老片段压成紧凑 recap,保留关键决策/资源/结论」→ 输出 recap 段。
  3. 新 recap = `(现有 recap)\n\n<新段>`;`updateConversation(recap, summarizedUpTo = maxSeq - RECENT_KEEP)`。
  4. 失败兜底:摘失败不阻塞对话(下次再试);记日志。
- **agent 每轮拿到**:`system + recap + 最近 RECENT_KEEP 全文消息 + 新消息`。老细节以 recap 留存,长线不丢脉络,也不爆窗口。

## 7. agent 上下文装配(每轮)

```
history = []
if recap: history.push({ role:'system', content: `Earlier in this conversation (summary):\n${recap}` })
history.push(...recentMessages)        // summarizedUpTo < seq <= maxSeq 的全文 user/assistant 消息
// 新 user 消息的 @-ref 资源 → 注入(既有逻辑,挂 system 或 user content 前缀)
history.push(newUserMessage)
run({ system: BASE + ledgerInjection, history, tools, onStep })
```
- `BASE + ledgerInjection`:base system + 项目 cluster ledger(SP3 挂点,现状已部分注入)。
- @-ref 注入:既有逻辑(资源 JSON 进 agent 上下文,不进用户展示消息——已修)。

## 8. 前端(Sidebar / 生命周期 / UX)

- **WorkbenchDetail**:`activeConversationId` 改为来自 `project.activeConversationId`(后端权威);sidebar 列本 project 线程(新→旧),活跃高亮。
- **New 按钮**:归档当前(留历史)+ `activeConversationId=null` → 下条消息走「新建线程」分支。
- **点旧线程**:设为活跃(`activeConversationId=该 id`)→ 可**续聊**(非只读);前端拉 `GET /conversations/:id` 渲染 recap 卡 + 全文轮次。
- **recap 卡**:线程顶部一个可折叠的「 Earlier (summary)」卡,点开看 recap 全文;其下是全文 ChatTurn 行(既有渲染)。
- **send 续接**:WorkbenchChat 的 `send()` 按 `activeConversationId` 走续接/新建分支(§5);不再每次 create。
- **轮次渲染**:既有 ChatTurn/ToolTrace/ResourceCard 不变;新消息的 refs 仍走卡片(既有)。
- **i18n**:新增键(recap 折叠标题、New、空历史等)走 `$t()`;含 `@` 转义(既有约定)。

## 9. 约束

- **node:sqlite 迁移**:`workbench-projects.mjs` 的 schema 函数里,新表 `CREATE TABLE IF NOT EXISTS`;加列用 guarded `ALTER TABLE ... ADD COLUMN`(try/catch「列已存在」),与既有 `referencesData` 迁移同模式。
- **零新增依赖**(复用既有 marked/dompurify/prismjs;摘要用既有 LLM client)。
- **i18n 门禁**:`npm run i18n:check` 绿。
- **测试**:纯逻辑(消息组装、阈值判定、seq 推进)优先零依赖运行器 `scripts/test.mjs`;summarizer/端点用 `node --test server/*.test.mjs`;前端续接用 vitest。
- **提交前** `npm test && npm run typecheck && npm run build`。

## 10. 测试要点
- 多轮:同一线程连发 3 条 → agent 第 3 轮 history 含前 2 轮(单测 history 组装)。
- 摘要阈值:塞 15 条消息 → 触发 summarize → recap 非空、`summarizedUpTo` 前移、agent 上下文含 recap(单测)。
- 续接 vs 新建:有 active → 走 `/:id/messages`;无 active → 走 `/conversations` + 设 active(端点测试)。
- 重开旧线程:点历史 → active 切换 → 新消息续接到旧线程(端点 + 前端)。
- 回归:既有 @-ref 卡片、审批、Cursor 渲染不破。

## 11. 为 SP2/SP3/SP4/SP5 铺路
- **SP2(agent/工具)**:多轮只改「history 传更多」;agent run/tools/审批零改。
- **SP3(ledger)**:`BASE + ledgerInjection` 是挂点;本 SP 留位,内容 SP3 填。
- **SP5(@-ref)**:新消息 refs 注入既有;ResourceCard 渲染既有。
- **SP4(项目工作区)**:线程属 project,与 manifests repo/edit 模式正交。

## 12. 风险
- **摘要质量**:LLM 摘要可能丢关键细节——`RECENT_KEEP` 留够近窗口 + recap 提示强调保留「决策/资源/结论」;可调阈值。
- **seq 并发**:detached run + 异步 summarize 都写 messages/recap——单进程 node:sqlite 串行,seq 用 `maxSeq+1` 取后立即写,竞争窗口小;summarizer 只写 recap/summarizedUpTo(不改 messages)。
- **旧数据**:既有 conversations(单发)无 messages 表记录——加载时若 messages 为空,fallback 用 conv.content/userMessage 渲染单轮(兼容)。
- **回滚**:加列/新表是加法,回滚只需前端 send 退回「每次 create」(行为退回单发,不丢数据)。
