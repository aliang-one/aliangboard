# SP2 · Agent Loop Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the 5 agent-loop closures from `server/index.mjs` into a testable `server/workbench-agent.mjs` (factory pattern), zero behavior change.

**Architecture:** `createWorkbenchAgent(deps)` factory (matching `createApiKeyTools` convention). Deps: `{ db, buildWbCtx, buildK8sSession, fetchRefContext, createAgentRunner }`. The 5 closures (`runConversation`, `resumeConversation`, `handleAgentResult`, `finalizeConvEmit`, `eventsForResult`) move into the factory; module functions (`buildHistory`, `appendMessage`, `getConversation`, `busEmit`, `maybeSummarize`, etc.) are imported directly. `index.mjs` creates `wbAgent` once + calls `wbAgent.runConversation()` / `wbAgent.resumeConversation()`.

**Tech Stack:** Node `http` + node:sqlite + `node:test`. Factory pattern.

**Spec:** `docs/superpowers/specs/2026-08-12-workbench-agent-loop-refactor-design.md`

## Global Constraints

- **纯重构,zero behavior change** —— 函数体逐字搬迁;只改 `db`→`deps.db`、`buildWbCtx`→`deps.buildWbCtx` 等 dep 引用;不改 agent 行为/system prompt/tool/SSE 协议。
- **node:sqlite**(`DatabaseSync`):db 作为 dep 传入;写边界强制 undefined→null(既有 updateConversation 已有)。
- 零新增依赖。
- `createAgentRunner` 作为 **dep**(不是 import)—— 便于 node:test 注入 stub(无 mock 框架)。
- 提交前 `npm test && npm run typecheck && npm run build` 全绿 + 手测(发消息 → agent 跑通 + SSE 流)。
- worktree:`.claude/worktrees/sp2-agent`(branch `feat/workbench-sp2-agent`,基于 main `4745407`)。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `server/workbench-agent.mjs` | factory `createWorkbenchAgent(deps) → {runConversation, resumeConversation}`;内部 `handleAgentResult`/`finalizeConvEmit`/`eventsForResult` | 新 |
| `server/workbench-agent.test.mjs` | stub-based 单测(done/paused/failed/multi-turn/resume) | 新 |
| `server/index.mjs` | 删 5 个闭包;import + 构造 `wbAgent`;端点调 `wbAgent.runConversation/resumeConversation` | 改 |

---

### Task 1: 抽 agent loop → workbench-agent.mjs + 接线 + 单测

**Files:**
- Create: `server/workbench-agent.mjs`
- Create: `server/workbench-agent.test.mjs`
- Modify: `server/index.mjs:1178-1310`(删 5 闭包)+ import + 构造 + 端点接线

**Interfaces:**
- Produces: `createWorkbenchAgent({ db, buildWbCtx, buildK8sSession, fetchRefContext, createAgentRunner }) → { runConversation(convId, llmClient), resumeConversation(convId, approved, llmClient) }`。
- Consumes (imported): `buildHistory`/`appendMessage`/`getConversation`/`getProject`/`updateConversation`/`appendTrace`/`appendHistory`(workbench-projects.mjs)、`maybeSummarize`(workbench-summarize.mjs)、`emit as busEmit`/`dispose as busDispose`(conv-bus.mjs)。

- [ ] **Step 1: 读 + grep 当前闭包** —— 确认 5 个函数的位置 + 全部引用。

```bash
# 读 5 个闭包的函数体(逐字搬迁的源)
sed -n '1178,1310p' server/index.mjs > /tmp/agent-loop-source.txt
# grep eventsForResult 的所有引用(确认只被 finalizeConvEmit 用 → 可搬;若被 index.mjs 其他地方用 → 留 index.mjs 作 dep)
grep -n "eventsForResult" server/index.mjs
# grep runConversation/resumeConversation 的调用点(端点里的调用)
grep -n "runConversation\|resumeConversation" server/index.mjs
```

- [ ] **Step 2: 创建 `server/workbench-agent.mjs`** —— factory + 5 函数(逐字从 index.mjs 搬,改 dep 引用)。

```js
// server/workbench-agent.mjs
// SP2: agent loop 从 index.mjs 抽出。factory 模式(同 createApiKeyTools)。
// 纯重构,zero behavior change —— 函数体从 index.mjs 逐字搬迁。
import { buildHistory, appendMessage, getConversation, getProject, updateConversation, appendTrace, appendHistory } from './workbench-projects.mjs'
import { maybeSummarize } from './workbench-summarize.mjs'
import { emit as busEmit, dispose as busDispose } from './conv-bus.mjs'

export function createWorkbenchAgent(deps) {
  const { db, buildWbCtx, buildK8sSession, fetchRefContext, createAgentRunner } = deps

  // ↓ 从 index.mjs 逐字搬迁以下 5 个函数(只改 dep 引用):
  //   - db → db (已 destructure)
  //   - buildWbCtx → buildWbCtx (已 destructure)
  //   - buildK8sSession → buildK8sSession (已 destructure)
  //   - fetchRefContext → fetchRefContext (已 destructure)
  //   - createAgentRunner → createAgentRunner (已 destructure)
  //   - buildHistory/appendMessage/getConversation/getProject/updateConversation/appendTrace/appendHistory
  //     → 保持不变(imported from workbench-projects.mjs)
  //   - busEmit/busDispose → 保持不变(imported from conv-bus.mjs)
  //   - maybeSummarize → 保持不变(imported from workbench-summarize.mjs)

  // 1. eventsForResult(out) — 从 index.mjs 搬(focus: result→{events, dispose})
  function eventsForResult(out) { /* 逐字搬迁 */ }

  // 2. finalizeConvEmit(convId, out) — 从 index.mjs 搬
  function finalizeConvEmit(convId, out) { /* 逐字搬迁 */ }

  // 3. handleAgentResult(convId, project, out) — 从 index.mjs 搬
  function handleAgentResult(convId, project, out) { /* 逐字搬迁 */ }

  // 4. runConversation(convId, llmClient) — 从 index.mjs 搬(含 busEmit/buildHistory/refreshSystem/onDelta/onStep/handleAgentResult/finalizeConvEmit/catch)
  async function runConversation(convId, llmClient) { /* 逐字搬迁 */ }

  // 5. resumeConversation(convId, approved, llmClient) — 从 index.mjs 搬
  async function resumeConversation(convId, approved, llmClient) { /* 逐字搬迁 */ }

  return { runConversation, resumeConversation }
}
```

- [ ] **Step 3: 改 `server/index.mjs`** —— 删 5 闭包 + import + 构造 + 端点接线。

```js
// import 区(top of file)加:
import { createWorkbenchAgent } from './workbench-agent.mjs'

// 所有 setup 完成后(buildWbCtx/buildK8sSession/fetchRefContext/createAgentRunner 可用)加:
const wbAgent = createWorkbenchAgent({ db, buildWbCtx, buildK8sSession, fetchRefContext, createAgentRunner })

// 删掉 index.mjs:1178-1310 的 5 个闭包函数(eventsForResult/finalizeConvEmit/handleAgentResult/runConversation/resumeConversation)

// 端点里的调用改:
// 原: runConversation(conv.id, llmClient)       → wbAgent.runConversation(conv.id, llmClient)
// 原: resumeConversation(convId, approved, llm)  → wbAgent.resumeConversation(convId, approved, llm)
// 用 grep 找全部调用点(Step 1 的 grep 结果)逐一替换
```

- [ ] **Step 4: 写单测** `server/workbench-agent.test.mjs`(stub createAgentRunner → 控制run();真实 :memory: db + schema)

```js
import { test } from 'node:assert/strict'  // 或 node:test
import { createWorkbenchAgent } from './workbench-agent.mjs'
import { createWorkbenchSchema, createConversationsSchema, createProject, createConversation, appendMessage } from './workbench-projects.mjs'
import { DatabaseSync } from 'node:sqlite'

function setup() {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)  // 建 projects + conversations + messages 表
  createProject(db, { name: 'test', clusterId: 'c1', ownerId: 'u1' })
  const project = db.prepare("SELECT * FROM workbench_projects WHERE name='test'").get()
  const conv = createConversation(db, { projectId: project.id, system: 'sys', userMessage: 'hi' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
  // 捕获 bus 事件
  const events = []
  const busEmit = (id, evt) => events.push(evt)
  const busDispose = (id) => events.push({ type: 'disposed' })
  return { db, project, conv, events, busEmit, busDispose }
}

test('runConversation done: appendMessage(assistant) + busEmit(end) + busDispose', async () => {
  const { db, project, conv, events, busEmit, busDispose } = setup()
  const stubRunner = () => ({ run: async () => ({ status: 'done', content: 'answer', trace: [], steps: 1 }) })
  const agent = createWorkbenchAgent({
    db, buildWbCtx: () => ({ ctx: {} }), buildK8sSession: () => ({}),
    fetchRefContext: async () => '', createAgentRunner: stubRunner,
    // busEmit/busDispose 通过 import 注入——若 factory 内 import 了 conv-bus,
    // 测试需要注入 stub bus。如不能注入,factory 也把 busEmit/busDispose 作 dep。
    // → 若 factory import busEmit/busDispose,测试改:在 conv-bus 层面 mock,
    //   或把 busEmit/busDispose 也加进 deps(推荐,与 createAgentRunner 同理)。
  })
  await agent.runConversation(conv.id, { chat: async () => ({}) })
  const msgs = db.prepare('SELECT role,content FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id)
  // assert: 2 messages (user 'hi' + assistant 'answer')
  // assert: events 含 {type:'end'} 或 {type:'status',status:'done'}
})

test('runConversation paused: updateConversation(paused) + busEmit(approval) + NOT dispose', async () => {
  // stub run()→{status:'pending_approval', pending:{toolCallId:'x',name:'apply',args:{}}, messages:[], queue:[], denied:[], steps:1}
  // assert: conv.status === 'paused'; events 含 approval; no dispose
})

test('runConversation failed: catch → updateConversation(failed) + busEmit(failed+end) + dispose', async () => {
  // stub run()→throw new Error('boom')
  // assert: conv.status === 'failed'; conv.error === 'boom'
})

test('runConversation multi-turn: history includes prior messages', async () => {
  // append 2 prior messages → stub run captures history → assert history length ≥ 2
})
```

> **busEmit/busDispose 测试注入**:若 `workbench-agent.mjs` 直接 `import { emit as busEmit } from './conv-bus.mjs'`,测试无法 stub。两个选项:
> (a) **推荐**:把 `busEmit`/`busDispose` 也加进 factory deps(与 createAgentRunner 同理)→ 测试注入 stub。但这改了 conv-bus 的消费方式(index.mjs 构造时传 busEmit/busDispose)。
> (b) 测试用真实 conv-bus(emit 到 in-memory Map)+ 事后 busSubscribe 验证事件(不 stub)。
> implementer 选 (a) 或 (b);若选 (a),factory deps 加 `busEmit, busDispose`。

- [ ] **Step 5: 跑测试 + typecheck**

```bash
node --test server/workbench-agent.test.mjs   # 新单测全绿
npm run typecheck                               # node --check 全绿
node --test server/workbench-conversations.test.mjs  # 既有对话端点测试不回归
```

- [ ] **Step 6: Commit**

```bash
git add server/workbench-agent.mjs server/workbench-agent.test.mjs server/index.mjs
git commit -m "refactor(server): 抽 agent loop 到 workbench-agent.mjs(factory,可单测,zero behavior change)"
```

---

### Task 2: 手测冒烟 + 终极门禁

**Files:** 无(验证)

- [ ] **Step 1:** 起网关(`node server/index.mjs`,保留 ANTHROPIC env)+ Vite。
- [ ] **Step 2:** 浏览器手测:workbench → 项目 → 发一条消息 → agent 跑通(终答渲染)+ SSE 流式(delta/step 实时)+ 多轮续接(第 2 条续同一线程)。
- [ ] **Step 3:** 终极门禁 `npm test && npm run typecheck && npm run build`。
- [ ] **Step 4:** commit(若有微调)。

---

## Self-Review

- **Spec 覆盖**:5 个闭包(eventsForResult/finalizeConvEmit/handleAgentResult/runConversation/resumeConversation)抽到 workbench-agent.mjs(T1 Step 2);factory 模式 + deps(T1 Step 2);index.mjs 接线(T1 Step 3);单测 done/paused/failed/multi-turn(T1 Step 4);手测 SSE+多轮(T2);纯重构 constraint 在 Global Constraints。spec 各节均有任务。
- **占位符**:"逐字搬迁"指从 index.mjs 逐字复制(不是 TBD)—— implementer 读 Step 1 的 sed 输出。eventsForResult 的位置(Step 1 grep 确认)。busEmit/busDispose 注入(Step 4 注释给了 (a)/(b) 两个具体选项)。
- **类型一致**:`createWorkbenchAgent(deps) → {runConversation, resumeConversation}`(Step 2 定义,Step 3 消费);`wbAgent.runConversation(convId, llmClient)`(Step 3 接线,与原 `runConversation(convId, llmClient)` 同签名)—— 一致。
