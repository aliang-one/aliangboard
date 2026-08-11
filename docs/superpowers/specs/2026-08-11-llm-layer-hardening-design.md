# 2026-08-11 LLM 层硬化设计(streaming + token 保护 + 上下文/提示词一致性)

> **状态**:已确认,待 writing-plans 出实现计划
> **日期**:2026-08-11
> **分支**:`worktree-feat+llm-layer-hardening`(worktree 隔离)
> **关联**:`docs/superpowers/plans/2026-08-11-index-mjs-route-modularization.md`(路由模块化,本工作**之后**做)

## 1. 背景与动机

工作台 AI(workbench chat)和外接 AI(MCP / API-key)是 AliangBoard 的核心赋能层。对 LLM/Agent 层做了一次连贯性审视,发现 5 个会影响真实使用的问题,集中在三类:

- **体验**:工作台 chat 无流式输出,用户发消息要干等到整段生成完才有响应。
- **健壮性**:无 token 窗口保护,长对话 + 大日志(`get_pod_logs`)必爆模型上限且无提示;`@-ref` 资源快照只注入首轮 user message,后续轮次 agent 基于旧数据决策(真正的漂移);tool 结果在 `messages` 里无限累积,与上者叠加加速爆窗口。
- **能力正确性**:admin 档复用 operator 提示词,但 admin 实际有 `exec_pod / delete_resource / kubectl_debug / update_image / rollout_undo` 五个高危工具——admin agent 根本不知道自己有这些能力。

本设计一次性补齐这 5 项(P0 体验/健壮性 + 🔴 高危一致性问题)。

## 2. 范围

**本次做**:
1. 工作台 chat streaming(SSE)
2. token 硬截断(单条 tool result 8KB + 整体字符预算)
3. @-ref 漂移修复(每轮刷新资源快照)
4. admin 档提示词(tier 三分支)
5. tool 结果单条截断(并入 2)

**本次不做(留后续)**:
- 🟡 对话级总超时(单步已有 60s,缺对话级总预算/僵尸回收)
- 🟡 提示词全面补全工具教学 + 动态上下文注入(集群版本 / 当前 ns / 时间)
- 🟢 提示词 i18n、并行工具执行、tool 结果 schema 校验

## 3. 架构(approach A:先改行为,后搬位置)

5 项改动各自落在最合适的现有文件,新增 1 个 SSE 端点 + 1 个事件总线小模块,不动其余外部接口。完成后再执行路由模块化(纯搬位置,搬的是已硬化代码,零冲突)。

- **为何不先搬后改(B)**:硬化是改行为、模块化是搬位置,先改后搬更安全(行为稳定后再逐字搬);且 5 项侵入性都不大,不需借拆分的势。
- **为何不重构 FSM(C)**:当前 detached Promise + `onStep` 回调足够承载这些,YAGNI。

## 4. 详细设计

### 4.1 streaming(SSE)

#### 4.1.1 前置:LLM 客户端加 `chatStream`
`server/llm.mjs` 新增 `chatStream({messages, tools, toolChoice}, {onDelta}={})`,与现有 `chat` 同返回结构 `{role, content, tool_calls?}`:
- `body.stream = true`
- 原生 fetch + `ReadableStream` + `TextDecoder` 解 OpenAI 兼容 SSE(**零依赖**,不引 SDK)
- 逐 chunk 取 `choices[0].delta`:`delta.content` → 累积并 `onDelta(text)`;`delta.tool_calls` → 按 `index` **合并分片**(流式工具调用是碎片,需 merge)
- 收到 `data: [DONE]` 收尾
- 超时 / 非 JSON / HTTP 错误处理与 `chat` 一致

#### 4.1.2 事件总线 conv-bus
新建 `server/conv-bus.mjs`:per-`convId` 的 EventEmitter(基于 `node:events`,轻量)。
- API:`bus.emit(convId, event)` / `bus.subscribe(convId, fn)` / `bus.unsubscribe(convId, fn)` / `bus.dispose(convId)`
- **生产者**:`runConversation` / `resumeConversation` 仍 detached 跑,把 `onStep`、新增的 `onDelta`、状态变更 emit 到 bus
- **消费者**:`GET /:id/stream` 订阅,`res.write('data: ' + JSON.stringify(event) + '\n\n')`,连接关闭即 unsubscribe
- conv 结束(done/failed)后 `bus.dispose(convId)` 清理监听,防内存泄漏

#### 4.1.3 SSE 端点
`GET /api/workbench/conversations/:id/stream`,`requireAdmin` + session 解析(同 `GET /:id`):
- 响应头:`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`
- 先推 `{type:'hello', convId, status:<当前DB状态>}` 让客户端对齐
- 订阅 conv-bus,逐事件写出
- 每 15s 推 `: keepalive\n\n`(SSE 注释行,防中间代理超时)
- conv 到达 `done`/`failed`/`paused` 后推 `{type:'end'}` 并关闭连接

#### 4.1.4 事件类型
对齐现有 `onStep.type` + 新增 delta,所有事件 JSON 单行:
```
{type:'status',     status:'running|paused|done|failed', error?}
{type:'step',       step:{type:'tool|assistant|denied', name?, args?, result?}}   // 复用现有 trace 事件
{type:'delta',      text:'逐字'}                                                    // 仅终答 turn 流出
{type:'approval',   pending:{toolCallId, name, args}}                               // 写操作 checkpoint
{type:'end'}
```

#### 4.1.5 断线重连
EventSource 浏览器自动重连。重连**只收后续事件**;客户端重连后先 `GET /:id` 拉当前状态(含已落库 trace)对齐,再接 SSE 实时。**不**实现历史事件回放(避免给 bus 加环形缓冲 + 序号;trace 已落库,GET 兜底够)。

#### 4.1.6 前端
工作台 chat 组件(精确文件 plan 阶段定位):`new EventSource('/api/workbench/conversations/'+id+'/stream')` 替代轮询;`delta` 事件拼到当前消息尾部;`step`/`approval` 复用现有 trace / 审批 UI;`end` 关闭连接。`GET /:id` 保留作首次对齐 + 兜底。

#### 4.1.7 resume(approve)的流式
approve → `resumeConversation`(detached)→ 事件发到同一 conv-bus → SSE 订阅者收到。前端 approve 后若 SSE 已断则重连,否则保持连接续收。

### 4.2 token 硬截断

#### 4.2.1 单条 tool result 截断
`server/agent.mjs` push tool 消息处(现 `messages.push({role:'tool', tool_call_id, content})`):
- `content`(`string`)长度超 **8192 字符**(`content.length`,与整体预算统一按字符计)→ 截断保留头部 + 尾标 `…[truncated N chars]`
- 主要砍 `get_pod_logs`、`list_resources` 等胖返回

#### 4.2.2 整体预算 `trimMessages`
`agent.mjs` 每轮 `chat`/`chatStream` 前调 `trimMessages(messages, budget)`:
- 预算:字符数估算 `JSON.stringify(msg).length`(**零依赖**,不引 tiktoken),默认 ~60000 字符可配(约对应 15–20k token,留足输出空间)
- 算法:保留 `system` + 最近 N 轮(默认保留最后 ~25% 预算的最新消息),从最旧的 `user`/`tool` 消息丢起
- **悬空清理**:若丢弃的 `tool` 消息,其对应的 `assistant.tool_calls[id]` 还留在 messages,把该 tool_call 一并从 assistant 删除(或连带丢那条 assistant),避免 OpenAI 校验报 `tool_call_id` 无对应 tool
- 触发截断时在返回值带 `truncated: true`,前端可提示"已精简早期上下文"

### 4.3 @-ref 漂移修复

#### 4.3.1 持久化 references
`workbench_conversations` 表加 `references TEXT`(JSON)。migration:`ALTER TABLE ... ADD COLUMN`,启动时幂等检查(`PRAGMA table_info` 或 try/catch)。创建对话时存入前端传的 `references` 数组。

#### 4.3.2 每轮刷新
`runConversation`/`resumeConversation` 每轮 chat 前(在 `trimMessages` **之后**)重新 fetch references 列表里的资源,刷新 refContext 块拼进 system:
- 复用现有 `KIND_API_PATH` 映射(`index.mjs` @-ref 注入处)
- **并发** fetch(`Promise.allSettled`)+ 单个 **5s 超时**
- 失败 / 404 → 标 `[kind/ns/name]: (not found / 已删除)`,agent 能感知资源变化(**这正是修复漂移的关键**)
- 刷新后 refContext 反映最新状态,后续轮次不再吃首轮旧快照

#### 4.3.3 前端
`GET /:id` 和 SSE 的 status 事件可带最新 ref 摘要,前端能展示资源当前态(plan 阶段定细节)。

### 4.4 admin 档提示词

system prompt 构造(`index.mjs`)按 `keyRow.tier` 三分支:
- `read`:现有 read 档 prompt(只读诊断)
- `operator`:现有 operator 档 prompt(读 + scale/restart)
- `admin`:**新增**全文——

> 你是 aliangboard 集群高级运维助手。先用只读工具(list_resources/get_resource/get_pod_logs/get_events/can_i/rollout_history)调查问题。除扩缩容(scale)、滚动重启(restart)外,你还有**高风险工具**:exec_pod(进容器执行)、kubectl_debug(注入临时容器排查)、update_image(更新镜像)、rollout_undo(回滚到历史 revision)、delete_resource(删除资源)。这些工具破坏性大,**仅在用户明确要求或诊断确有必要时使用**,调用前用简短一句话说明意图。所有写操作都会弹审批,被拒会告知你。优先用只读手段定位根因,改动从最小代价开始。

## 5. 数据结构变更

| 位置 | 变更 | migration |
|---|---|---|
| `workbench_conversations` | + `references TEXT`(JSON) | `ALTER TABLE ADD COLUMN`,启动幂等检查 |

无其余 schema 变更。conv-bus 是内存态,不落库。

## 6. 文件清单

**新建**:
- `server/conv-bus.mjs`(事件总线)

**修改**:
- `server/llm.mjs`(+ `chatStream`)
- `server/agent.mjs`(+ `trimMessages` + 单条截断 + `onDelta` 透传 + 切到 `chatStream`)
- `server/index.mjs`(@-ref 漂移刷新 + admin prompt 分支 + SSE 端点 + run/resumeConversation 接 bus)
- `server/workbench-projects.mjs`(conversations 表 + `references` 列 migration,或表定义所在文件)
- 前端工作台 chat 组件(`EventSource` + delta 拼接,精确文件 plan 阶段定位)

## 7. 测试策略

**server 纯逻辑(自研零依赖运行器,`scripts/test.mjs`)**:
- `chatStream`:SSE 分片解析、`delta.content` 累积、`tool_calls` 按 index 合并、`[DONE]` 收尾、超时
- `trimMessages`:预算内不动、超预算保 system + 最近 N 轮、丢最旧、悬空 tool_call 清理、`truncated` 标记
- `conv-bus`:emit/subscribe/unsubscribe、多订阅者、conv 结束 dispose 清理
- @-ref 刷新:并发 + 超时降级 + 404 标记、漂移场景(快照变 → 刷新拿到新)
- prompt 三分支:tier → 正确 prompt

**前端单测(vitest + happy-dom)**:
- `EventSource` mock:delta 拼接、approval 弹窗、end 关闭、断线重连对齐(GET /:id)

**手测**:
- 发消息看逐字流式 + tool 事件穿插
- 长对话(刷几十次 `get_pod_logs`)看截断标记、不爆窗口
- `@pod:x` 后改 pod 再追问 → agent 感知变化(用上新数据)
- admin key 发消息 → 用上新 prompt、认得高危工具

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| `chatStream` 的 tool_calls 分片合并写错 → agent 收到残缺 tool_call | 单测覆盖合并;dry-run 比对 stream vs 非 stream 返回一致 |
| `trimMessages` 丢错消息致 `tool_call_id` 悬空 → OpenAI 400 | 悬空清理逻辑 + 单测;保留最近 N 轮完整 turn 边界 |
| @-ref 每轮刷新增延迟(多 ref 时) | 并发 + 5s 超时;ref 列表通常 ≤ 几个 |
| SSE 长连被中间代理超时断 | 15s keepalive 注释行 |
| streaming 与轮询并存的双写复杂 | `GET /:id` 只读 DB 兜底、SSE 只读 bus,两者只读不写,无双写 |
| conv-bus 内存泄漏(未清理监听) | conv done/failed 后 `dispose(convId)`;SSE 关闭即 unsubscribe |

## 9. 完成标志

- 5 项改动落地,全量门禁绿:`npm run i18n:check && npm run typecheck && npm test && npm run test:unit && npm run build`
  - 注:`_allViewsMount > AuditLogs.vue` 为 pre-existing 环境依赖失败(挂载时连 :443 网关、测试环境无网关),与本工作无关,不作为阻断
- 端到端手测通过(见第 7 节)
- 之后路由模块化计划可直接搬硬化后的代码

## 10. 与路由模块化的关系

本设计改动落在 `index.mjs`(对话端点 / run/resumeConversation / @-ref / prompt)+ `agent.mjs` / `llm.mjs` / `conv-bus.mjs`。路由模块化计划(`2026-08-11-index-mjs-route-modularization.md`)的 Task 2 会把 workbench 对话端点搬到 `routes/workbench-conversations.mjs`——届时搬的就是本文档硬化后的代码,行为已稳定,只需逐字复制 + 经 ctx 传依赖。**先硬化后搬,顺序固定,勿反**。
