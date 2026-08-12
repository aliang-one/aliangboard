# SP2 · Agent Loop Refactor — Design

> 日期:2026-08-12|分支:`feat/workbench-sp2-agent`(worktree,基于 main `4745407`)
> 上游:whole-workbench 分解的 SP2;SP1(对话核心)已合 main。

## 1. 目标 / 背景

把 `server/index.mjs` 里的 agent-loop 闭包(`runConversation` / `resumeConversation` / `handleAgentResult` / `finalizeConvEmit` / `eventsForResult`,约 `index.mjs:1178-1310`)抽成可单测的 `server/workbench-agent.mjs`(factory 模式,与既有 `createApiKeyTools` / `createClusterProber` / `createMcpServer` 一致)。

**为什么**:
- 这些闭包是 SP1 遗留的可测性债(经 buildHistory 集成测试间接覆盖,但无法直接单测 agent loop)。
- index.mjs 已 2200+ 行;抽走 agent loop 是 route-modularization 的前置(减小单体)。
- 为 SP2 后续(agent effectiveness / tool expansion)提供干净、可测的 agent loop 边界。

**非目标(明确排除)**:
- 不改 agent 行为(纯重构,zero behavior change)。
- 不抽 `buildWbCtx`(tool-context 工厂,独立关注点;作为 dep 传入)。
- 不抽 SSE 端点(`GET /conversations/:id/stream` 留在 index.mjs;它是 HTTP 订阅层,不是 agent loop)。
- 不改 `agent-runner.mjs` / `llm.mjs` / `tool-registry.mjs` / `conv-bus.mjs`(它们已是独立模块)。
- 不改 tool 集 / system prompt / tier 鉴权(那些是 SP2 后续方向 B/C/D)。

## 2. 当前状态(synced to main 4745407)

`index.mjs:1178-1310` 的 agent-loop 闭包(均捕获模块级 `db` + 多个 helper):

| 函数 | 行 | 职责 |
|---|---|---|
| `handleAgentResult(convId, project, out)` | 1178 | paused→updateConversation(paused+pendingApproval);done→updateConversation(done+content)+appendMessage(assistant)+appendHistory |
| `finalizeConvEmit(convId, out)` | 1205 | result→bus 事件序列(eventsForResult)+ 条件 busDispose |
| `runConversation(convId, llmClient)` | 1213 | buildHistory→createAgentRunner→run(system,history,refreshSystem,onDelta,onStep)→handleAgentResult+finalizeConvEmit;全程 busEmit(status/delta/step/end) |
| `resumeConversation(convId, approved, llmClient)` | 1251 | 从 paused 恢复(approve/deny)→ run → 同上 |
| `eventsForResult(out)` | ~1205 附近 | 把 agent result 转成 bus 事件数组 + dispose 标志 |

依赖(闭包捕获的模块级符号):
- **从其他模块(import)**:`createAgentRunner`(agent-runner.mjs)、`buildHistory`/`appendMessage`/`getConversation`/`getProject`/`updateConversation`/`appendTrace`/`appendHistory`(workbench-projects.mjs)、`maybeSummarize`(workbench-summarize.mjs)、`busEmit`/`busDispose`(conv-bus.mjs)。
- **index.mjs 闭包(作为 dep 传入)**:`buildWbCtx(project)`(tool-context 工厂)、`buildK8sSession(clusterId)`(集群 session)、`fetchRefContext(refs, k8sSession)`(@-ref 资源→context 串)。
- **db**:`DatabaseSync` 实例。

`runConversation` 的关键流(SSE streaming + 多轮):
```
busEmit(status:running) → buildWbCtx → buildK8sSession → refreshSystem(每轮重拉 @-ref)
→ buildHistory(recap + 近期全文) → run({system, history, refreshSystem, onDelta→busEmit(delta), onStep→appendTrace+busEmit(step)})
→ handleAgentResult(done→appendMessage) → finalizeConvEmit(eventsForResult→busEmit(end)+busDispose)
catch → updateConversation(failed) + busEmit(status:failed) + busEmit(end) + busDispose
```

## 3. 目标架构

```js
// server/workbench-agent.mjs
import { createAgentRunner } from './agent-runner.mjs'
import { buildHistory, appendMessage, getConversation, getProject, updateConversation, appendTrace, appendHistory } from './workbench-projects.mjs'
import { maybeSummarize } from './workbench-summarize.mjs'
import { emit as busEmit, dispose as busDispose } from './conv-bus.mjs'

export function createWorkbenchAgent(deps) {
  const { db, buildWbCtx, buildK8sSession, fetchRefContext } = deps
  // eventsForResult:纯函数(result→{events,dispose}),内部定义(从 index.mjs 搬来)
  function eventsForResult(out) { ... }
  function finalizeConvEmit(convId, out) { ... }
  function handleAgentResult(convId, project, out) { ... }
  async function runConversation(convId, llmClient) { ... }
  async function resumeConversation(convId, approved, llmClient) { ... }
  return { runConversation, resumeConversation }
}
```

**index.mjs 改动**:
```js
import { createWorkbenchAgent } from './workbench-agent.mjs'
// 启动时(all deps 可用后):
const wbAgent = createWorkbenchAgent({ db, buildWbCtx, buildK8sSession, fetchRefContext })
// 端点里:
wbAgent.runConversation(conv.id, llmClient)      // 原 runConversation(conv.id, llmClient)
wbAgent.resumeConversation(convId, approved, llmClient)  // 原 resumeConversation(...)
```
- 删除 index.mjs 里的 5 个闭包函数(handleAgentResult / finalizeConvEmit / runConversation / resumeConversation / eventsForResult)。
- `buildWbCtx` / `buildK8sSession` / `fetchRefContext` **留在** index.mjs(作为 dep 传入;它们是 tool-context/cluster/session 关注点,不是 agent loop)。

## 4. 为什么 factory(不是 ctx-param 或 raw-export)

- **与既有模式一致**:`createApiKeyTools({db, requestFn, ...})` / `createClusterProber({requestFn})` / `createMcpServer({db, apiKeyTools})` 全用 factory。`createWorkbenchAgent` 同形。
- **deps 闭包一次**:4 个 index.mjs 闭包(db, buildWbCtx, buildK8sSession, fetchRefContext)factory 构造时注入;模块级函数(agent-runner/workbench-projects/conv-bus/summarize)直接 import。
- **测试边界清晰**:注入 stub deps(db=:memory:、stub buildWbCtx、stub buildK8sSession/fetchRefContext)+ stub `createAgentRunner`(返回可控 `run()`),即可单测 agent loop 的全部分支。

## 5. 测试(可测性收益)

`server/workbench-agent.test.mjs`(`node --test`):
- **done 路径**:stub `run()`→`{status:'done', content:'answer', trace:[...]}`;断言 `handleAgentResult` 调 `appendMessage(role:assistant, content:'answer')` + `updateConversation(done)` + `busEmit(end)` + `busDispose`。
- **paused 路径**:stub `run()`→`{status:'pending_approval', pending:{...}}`;断言 `updateConversation(paused+pendingApproval)` + busEmit(approval) + **不** dispose。
- **failed 路径**:stub `run()`→throw;断言 `updateConversation(failed)` + busEmit(status:failed) + busEmit(end) + busDispose。
- **多轮 history**:append 2 条消息 → `runConversation` → 断言传给 `run()` 的 history 含两条(buildHistory 集成)。
- **refreshSystem**:@-ref 注入每轮刷新(fetchRefContext stub → 断言 system 含 ref context)。
- **resumeConversation**:从 paused 恢复(approve/deny)→ 断言 run 收到 approved 标志。

## 6. 约束

- **纯重构,zero behavior change**:函数体逐字搬迁(只改 `foo`→`deps.foo` / import);不改任何 agent 行为 / system prompt / tool / 流式协议。
- **node:sqlite**:db 作为 dep 传入(不在 workbench-agent.mjs 建连接)。
- 零新增依赖。
- `.mjs` 由 `npm run typecheck` 覆盖;`node --test` 测 agent loop。
- 提交前 `npm test && npm run typecheck && npm run build` 全绿 + 手测(发一条消息 → agent 跑通 + SSE 流式)。

## 7. 风险

- **闭包搬迁漏 dep**:5 个函数互相调用 + 捕获 4 个 index.mjs 闭包;搬前 grep 出全部引用,确保 factory deps 都带上。漏一个 → 运行时 ReferenceError(触发发消息才暴露)。
- **eventsForResult 位置**:若它在 index.mjs 其他地方被引用(非 agent-loop),搬走会断。搬前 grep 确认只被 finalizeConvEmit 用(若是,搬走;若被共享,留 index.mjs 作 dep)。
- **行为漂移**:搬时手滑改逻辑。diff 时确认纯搬迁(只加 import + `deps.` 前缀)。
