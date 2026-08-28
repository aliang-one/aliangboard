# 编辑已发消息重发 设计

- 日期:2026-08-28
- 状态:已评审(brainstorming 两问定案:范围只做编辑重发;交互载入底部输入框),待实施
- 范围:AI 工作台对话的消息级操作(编辑 user 消息并重发)

## 1. 背景

用户发错/想改一条已发出的消息时,现状只能:最后一条场景靠「停止→回填输入框→重发」(且旧消息残留在库,重发走 append 追加);历史消息完全无法改。排障中「换个问法重问」是高频动作。

## 2. 决策记录

| # | 决策 | 选择 |
|---|------|------|
| D1 | 范围 | **只做编辑重发**;fork 分支对话、引用回复砍掉(YAGNI——复制已有,场景低频) |
| D2 | 交互 | **载入底部输入框**(非内联编辑):hover user 消息出「编辑」→ 回填现有输入框+chips,编辑态提示条+取消;复用 @-mention/自动增高/草稿机制,与「停止→回填」肌肉记忆一致 |
| D3 | 语义 | 就地截断重跑(线性历史,不做变体树):删该消息及其后全部,以新内容 append 重跑;想保留原路的需求由(未来的)fork 承担 |

## 3. 架构

### 3.1 服务端:`POST /api/workbench/conversations/:id/edit`

- **body**:`{ messageId: string, content: string, references?: array }`(messageId = workbench_messages.id,精确锚点;references 缺省**沿用原消息 refs**,传入则替换——编辑态回填的 @-chips 可增删,语义与 UI 一致)
- **门禁**:对话存在(404)+归属(admin/owner);`running/paused` → 400(改消息破坏 resume/并发);messageId 属于本对话且 `role='user'`(否则 400);content 非空(400)
- **语义**(单事务性由「先截断后写入,失败即停」保证;SQLite 同步单线程):
  1. `DELETE FROM workbench_messages WHERE conversationId=? AND seq >= 该消息.seq`
  2. append 新 user 消息:content=新文本,refs=body.references ?? 原消息 refs(沿用);新 refs 并入对话级 references(同 append 的 mergeRefs)
  3. 复位 conv 运行态字段(status='running', content='', reasoning='', trace='[]', steps=0, pendingApproval=null——与 append 路由同款);`setActiveConversation`
  4. `summarizedUpTo` 钳制:`min(现值, fromSeq - 1)`(剩余前缀为连续 seq 1..fromSeq-1,fromSeq-1 即保留区边界;防已摘要水位覆盖回滚区。自审修正:原式「剩余最小 seq - 1」恒为 0,会把每次编辑的水位全清零——编辑末条时前缀摘要覆盖应保留)
  5. `wbAgent.runConversation`(detached)
- **响应**:`{ status:'running', context }`(context 口径同 2026-08-28-ai-context-compact spec §4.3)
- **recap 不动**:已摘要内容保留(它是「当时聊过」的记录;编辑改写后 recap 与新历史可能轻微失配,近似语义可接受——记录该取舍)

### 3.2 领域函数

`server/workbench-projects.mjs` 新增导出:
```js
truncateFromMessage(db, conversationId, messageId)   // → { removed, fromSeq, keptMinSeq } | null(消息不存在/非 user)
```
(删除 seq >= fromSeq 的全部消息,返回删除数与剩余最小 seq;供 edit 路由 + 水位钳制复用;与既有 truncateAfterLastUser 同区同风格。)

### 3.3 前端 WorkbenchChat

- **入口**:`ChatTurn` 加 `showEdit` prop + `edit` emit(模式同 showRegenerate);WorkbenchChat 对 `role==='user' && !sending` 的 turn 传 true;hover 显示「编辑」铅笔按钮
- **编辑态**(`editing = ref({ messageId, draftBackup })`):
  - 点击:输入框回填该消息 content、refs chips 回填其 refs;**当前草稿暂存**到 draftBackup
  - 输入区上方提示条(testid `edit-banner`):「正在编辑此消息,发送后将删除其后 N 条对话」+ 取消;N = turns 中该消息之后的条数
  - 取消:还原暂存草稿+清 chips,退出编辑态
  - 切换对话/卸载:编辑态自然清空(watch conversationId 处)
- **发送**:`send()` 首查编辑态 → 调 `workbenchApi.conversations.edit(id, { messageId, content, references })` → 本地 turns 截断(移除该消息及之后)+ push 新 user + thinking turn → `startStreaming`;草稿键写 `getDraft('new')` 语义(编辑态退出后正常)
- **API client**:`edit: (id, body) => POST /api/workbench/conversations/:id/edit`(JSON body)
- **i18n**:zh/en 同步 `workbench.chat.editBanner` / `editBannerHint`(带 {n} 插值)/ `editCancel` / ChatTurn `editTitle`

### 3.4 数据流

编辑 → 服务端截断+重写 → runConversation 以 buildHistory(剩余前缀 + 新 user)重跑 → SSE 流式照旧;余量条随响应 context 刷新;前端本地截断与服务端一致(以服务端为准,pollOnce 兜底对齐)。

## 4. 错误处理

| 场景 | 行为 |
|------|------|
| running/paused 编辑 | 400(前端按钮在非终态本就隐藏,sending 时不显示编辑) |
| messageId 不属于本对话/非 user | 400 明确文案 |
| content 空 | 400(前端发送按钮 disabled 已拦) |
| edit 请求失败 | 前端 catch → errorBanner + 编辑态保留(可重试);本地不截断(先响应后截断) |
| 截断后对话为空(编辑首条且删光) | 不可能——新 user 消息总会 append,历史至少 1 条 |

## 5. 测试

- **领域**:truncateFromMessage 单测(中间锚点删后续/首条全删/不存在/非 user 返回 null)
- **路由集成**(workbench-conversations.test.mjs 沿用 harness):成功(删 N 条+新消息+running+refs 沿用+水位钳制)/ 三态 400 / 归属 403
- **前端**(WorkbenchChat.test.js):进入编辑态(回填+banner+N 计数)/ 取消(草稿还原)/ 发送(edit 调用参数+本地 turns 截断+新 user)/ 非终态无编辑按钮
- **回归**:全量 1358+ 测试绿

## 6. 开放问题

无(两问定案;取舍已记录:recap 失配、refs 沿用、线性语义)。
