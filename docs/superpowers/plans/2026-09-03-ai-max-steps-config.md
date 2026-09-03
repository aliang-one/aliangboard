# AI 最大执行步数可配置化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作台 AI 的最大执行步数从硬编码/env-only 升级为管理后台「AI 行为」面板可调(含不限制档),并把到上限时的硬断改为「收尾轮强制终答」。

**Architecture:** 配置落 `platform_settings` 键 `workbench.maxSteps`(0=不限制),单一来源在 `server/workbench-ai-config.mjs`,每次 run 现读(同 `disabledTools` 即时生效语义);`agent.mjs` 循环增加 0=不设限语义与收尾轮;两条 SSE 管道把 `truncated` 旗标真正送达前端(修复既有死旗标缺陷)。

**Tech Stack:** 纯 JS(node:sqlite / node:test 自研门禁)+ Vue 3 + vitest。零新增依赖。

**Spec:** 本文「背景与设计裁决」节(设计经用户 2026-09-03 当面裁决:暴露在 AI 行为控制面板;无独立 spec 文档)。

## 背景与设计裁决

现状(勘察结论,2026-09-03):

- 唯一活跃的 agent 循环 = 工作台路径(对话页 + 悬浮对话):`workbench-agent.mjs` 两处 `createAgentRunner` 传 `WB_MAX_STEPS`(module-load 读 env,默认 16,改 env 须重启)。MCP 路径是外部 LLM 直调工具,不走循环;`agent.mjs` 的 `MAX_STEPS=8` 是无消费方的死默认。
- 到上限行为:`agent.mjs` 直接返回硬编码灰字「(达到最大步数,未给出终答)」。
- 既有缺陷(本计划顺带修复):`truncated` 旗标在活体链路是死的——`conv-events.mjs` 的 done 事件不带它、`conv-stream.js` 的 reducer 不收它 → ChatTurn 的「步数用尽警告块」生产上永不渲染(仅单测里活)。

设计裁决(用户已确认):

1. **入口**:管理后台「AI 行为」面板(`src/views/admin/AiBehaviorConfig.vue`)主配置卡新增「不限制步数」开关 + 步数数字输入;走既有 `/api/admin/workbench-ai-config` GET/PUT,不新增端点(ROUTE_AUTH 已按 `/api/admin/*` 全段 admin 覆盖,无登记负担)。
2. **存储/语义**:`platform_settings` 键 `workbench.maxSteps`;**0 = 不限制**;整数域 `[0, 200]`;缺键/垃圾 → env `WB_MAX_STEPS`(保留部署侧预置通道,语义逐字不变)→ 16。
3. **生效时机**:每次 run 现读(运行中对话不中断,下一次提问/审批续跑生效),与 `disabledTools` 同款「即时生效」注释语义。
4. **到上限行为**:不再硬断——注入一条系统收尾指令、**不带工具**再调一次 LLM 强制基于已有信息终答;`truncated` 仍置 true;每 run 至多收尾一次(极端二次到顶保留旧兜底文案)。收尾轮计一步。
5. **不限制的兜底**:上下文预算 `budgetChars`(`trimMessages`)天然是第二道闸,不另造看门狗(YAGNI)。
6. MCP/API-key 路径不暴露配置(该路径无循环,死默认 8 保持原样,仅修透传 falsy-0 bug)。

## Global Constraints

- 任何开发一律 worktree 分支隔离(用户硬约束),完成后 `--no-ff` 合回 main;Edit 必须用 worktree 绝对路径。
- 提交作者恒为 `aliang-one <aliangdone@gmail.com>`;**禁止** `Co-Authored-By: Claude` 尾注;提交信息一律**英文**。
- 禁止改写已推送历史/force push。
- 零新增外部依赖。
- 门禁四件套:`npm run i18n:check`、`npm test`、`npm run test:unit`、`npm run typecheck`。
- 服务端文案进 `server/messages/admin.mjs` 双语表;前端文案 zh/en 两 locale 对齐(i18n 门禁强制)。
- main 被并行会话推进时,合并后必须重跑全门禁(合并树≠分支树)。
- 服务端改动上线须重启网关;前端改动重建 dist 即可。

---

### Task 1: 配置单源 getMaxStepsConfig / validateMaxSteps

**Files:**
- Modify: `server/workbench-ai-config.mjs`(模块头注释 + 文件尾新增导出)
- Test: `server/workbench-ai-config.test.mjs`

**Interfaces:**
- Consumes: 无(新功能)。
- Produces(后续任务依赖的精确签名):
  - `MAX_STEPS_RANGE`:`{ lo: 0, hi: 200 }`(常量对象)
  - `getMaxStepsConfig(db, envRaw = process.env.WB_MAX_STEPS)` → 整数(`0`=不限制;缺键/垃圾 → env → 16)
  - `validateMaxSteps(input)` → `{ ok: true, value: n | null }`(null=调用方语义「不修改」)或 `{ ok: false }`

- [ ] **Step 1: 写失败测试**

在 `server/workbench-ai-config.test.mjs` 顶部 import 行追加 `getMaxStepsConfig, validateMaxSteps`(保持既有 `makeDb` helper 复用),文件尾追加:

```js
// ===== 最大执行步数(2026-09-03):0=不限制;缺键/垃圾 → env WB_MAX_STEPS → 16 =====
test('getMaxStepsConfig:缺键走 env 通道,env 语义与原 WB_MAX_STEPS 逐字一致', () => {
  assert.equal(getMaxStepsConfig(makeDb(), undefined), 16)
  assert.equal(getMaxStepsConfig(makeDb(), '32'), 32)
  assert.equal(getMaxStepsConfig(makeDb(), 'abc'), 16)
  assert.equal(getMaxStepsConfig(makeDb(), '0'), 16, 'env 0 回落默认(原语义 0||16)')
})

test('getMaxStepsConfig:落库值优先于 env;0=不限制;垃圾/越界/非整数回 env 链', () => {
  assert.equal(getMaxStepsConfig(makeDb({ 'workbench.maxSteps': '30' }), '16'), 30)
  assert.equal(getMaxStepsConfig(makeDb({ 'workbench.maxSteps': '0' }), '16'), 0)
  assert.equal(getMaxStepsConfig(makeDb({ 'workbench.maxSteps': 'abc' }), '16'), 16)
  assert.equal(getMaxStepsConfig(makeDb({ 'workbench.maxSteps': '999' }), '16'), 16)
  assert.equal(getMaxStepsConfig(makeDb({ 'workbench.maxSteps': '2.5' }), '16'), 16)
})

test('validateMaxSteps:null=不改;0..200 整数过;非整数/越界拒', () => {
  assert.deepEqual(validateMaxSteps(null), { ok: true, value: null })
  assert.deepEqual(validateMaxSteps(undefined), { ok: true, value: null })
  assert.equal(validateMaxSteps(0).ok, true)
  assert.equal(validateMaxSteps(0).value, 0)
  assert.equal(validateMaxSteps('30').ok, true)
  assert.equal(validateMaxSteps('30').value, 30)
  assert.equal(validateMaxSteps(201).ok, false)
  assert.equal(validateMaxSteps(-1).ok, false)
  assert.equal(validateMaxSteps(2.5).ok, false)
  assert.equal(validateMaxSteps('abc').ok, false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test 2>&1 | grep -A3 getMaxStepsConfig | head -20`(或 `node --test server/workbench-ai-config.test.mjs`)
Expected: FAIL — import 报错 `SyntaxError: The requested module does not provide an export named 'getMaxStepsConfig'`

- [ ] **Step 3: 最小实现**

`server/workbench-ai-config.mjs`:

模块头注释第 2 行「platform_settings 两键」改为「platform_settings 三键」,文件尾追加:

```js
// ===== 最大执行步数(2026-09-03):admin「AI 行为」面板可调,agent 循环上限单源 =====
// 语义:0 = 不限制(仅上下文预算 budgetChars 兜底);缺键/垃圾 → env WB_MAX_STEPS(部署侧
// 预置通道,语义与原 workbench-agent.mjs 的 WB_MAX_STEPS 逐字一致)→ 16。
export const MAX_STEPS_RANGE = { lo: 0, hi: 200 }

export function getMaxStepsConfig(db, envRaw = process.env.WB_MAX_STEPS) {
  let raw = null
  try { raw = db.prepare('SELECT value FROM platform_settings WHERE key=?').get('workbench.maxSteps')?.value ?? null } catch { raw = null }
  if (raw != null) {
    const n = Number(raw)
    if (Number.isInteger(n) && n >= MAX_STEPS_RANGE.lo && n <= MAX_STEPS_RANGE.hi) return n
  }
  return Math.max(1, Number(envRaw) || 16) // env 通道:与原 `Math.max(1, Number(...) || 16)` 逐字一致
}

// PUT 校验:null/undefined = 不修改(与 projectMemory 语义一致);否则必须 0..200 整数(0=不限制)
export function validateMaxSteps(input) {
  if (input == null) return { ok: true, value: null }
  const n = Number(input)
  if (!Number.isInteger(n) || n < MAX_STEPS_RANGE.lo || n > MAX_STEPS_RANGE.hi) return { ok: false }
  return { ok: true, value: n }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/workbench-ai-config.test.mjs`
Expected: PASS(全绿)

- [ ] **Step 5: Commit**

```bash
git add server/workbench-ai-config.mjs server/workbench-ai-config.test.mjs
git commit -m "feat(ai-config): max-steps setting single source (0=unlimited, env fallback)"
```

---

### Task 2: agent 循环 0=不设限 + 到上限收尾轮

**Files:**
- Modify: `server/agent.mjs:105` 附近(声明 `wrappedUp`)、`server/agent.mjs:167-168`(上限分支重写)
- Test: `server/agent.test.mjs:119-128`(改既有断言)+ 文件尾新增两测

**Interfaces:**
- Consumes: 无(纯循环内逻辑;`chat(messages, tools, opts)` 第三参 opts 已存在)。
- Produces: `run()` 返回形状不变,但到上限时 `content` 为收尾答案(而非硬编码灰字)且 `truncated: true`;`maxSteps <= 0` 永不截断。注意:到上限的返回 `steps` 从「= maxSteps」变为「maxSteps + 1」(收尾轮计一步)。

- [ ] **Step 1: 改写既有失控循环测试 + 新增两测**

`server/agent.test.mjs` 既有测试(119 行)替换为:

```js
test('失控循环(一直 tool call 不终答)→ 到上限触发收尾轮,强制终答', async () => {
  const run = createAgent({
    chat: mockChat([toolCall('1', 'list_resources', {}), toolCall('2', 'list_resources', {}), toolCall('3', 'list_resources', {}), final('基于以上信息,结论是 X')]),
    execTool: async () => 'more',
    maxSteps: 3,
  }).run
  const out = await run({})
  assert.equal(out.truncated, true)
  assert.equal(out.steps, 4, '3 轮工具 + 1 轮收尾')
  assert.equal(out.content, '基于以上信息,结论是 X')
})

test('收尾轮:不带 tools + 注入系统收尾提示(2026-09-03)', async () => {
  const chats = []
  const chat = async (messages, tools) => {
    chats.push({ messages, tools })
    return chats.length <= 2 ? toolCall(String(chats.length), 'list_resources', {}) : final('收尾答案')
  }
  const run = createAgent({ chat, execTool: async () => 'ok', maxSteps: 2 }).run
  const out = await run({})
  assert.equal(out.content, '收尾答案')
  assert.equal(out.truncated, true)
  const last = chats[chats.length - 1]
  assert.deepEqual(last.tools, [], '收尾轮不提供任何工具')
  assert.match(last.messages[last.messages.length - 1].content, /最大执行步数 2/)
})

test('maxSteps 0 = 不设限:超过旧默认 8 仍继续到终答', async () => {
  let execCount = 0
  const run = createAgent({
    chat: async () => (execCount >= 12 ? final('done') : toolCall('t' + execCount, 'list_resources', {})),
    execTool: async () => { execCount++; return 'ok' },
    maxSteps: 0,
  }).run
  const out = await run({})
  assert.equal(out.content, 'done')
  assert.ok(out.steps >= 13, `应跑满 12 轮工具 + 终答,实际 ${out.steps}`)
  assert.ok(!out.truncated)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/agent.test.mjs`
Expected: FAIL — 旧实现到上限返回灰字 content,`out.steps` 为 3,收尾轮/不设限两测或挂或死循环超时(0 档旧实现会在 8 步截断返回灰字,故为断言失败非死循环)

- [ ] **Step 3: 最小实现**

`server/agent.mjs` 两处:

① `run()` 初始化区(105 行 `let messages, queue = [], denied = [], steps = 0` 附近)加一行:

```js
    let wrappedUp = false // 收尾轮每 run 至多一次(2026-09-03)
```

② 167-168 行的上限分支整体替换为:

```js
      // 2) 队列空 → 下一轮 chat(受 maxSteps 约束;0/负数 = 不设限,仅上下文预算兜底)
      if (maxSteps > 0 && steps >= maxSteps) {
        // 收尾轮(2026-09-03):到上限不再硬断——注入系统收尾指令、不带工具,强制基于已有信息终答。
        // truncated 仍 true:前端据此亮「已达步数上限」标;每 run 至多一次(极端二次到顶走旧兜底文案)。
        if (!wrappedUp) {
          wrappedUp = true
          messages.push({ role: 'user', content: `(系统提示:已达到最大执行步数 ${maxSteps},请立即基于以上已获得的信息给出最终回答,不要再调用任何工具。)` })
          steps++
          const assistant = await chat(messages, [], (onDelta || onReasoning) ? { onDelta, onReasoning } : {})
          messages.push(assistant)
          onStep?.({ type: 'assistant', message: assistant, ts: Date.now() })
          return { content: assistant.content, steps, denied, truncated: true }
        }
        return { content: '(达到最大步数,未给出终答)', steps, denied, truncated: true }
      }
```

背景知识:空 `tools` 数组在 `llm.mjs` 侧 `if (tools?.length)` 判空 → 请求体根本不带 tools 字段,模型必然终答;收尾轮照常流式(`onDelta`/`onReasoning` 透传)。LLM 侧合成消息用硬编码中文与同文件既有惯例一致(「工具 X 的参数不是合法 JSON…」等同款)。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/agent.test.mjs`
Expected: PASS(全绿,含既有 checkpoint/resume 系列不受影响)

- [ ] **Step 5: Commit**

```bash
git add server/agent.mjs server/agent.test.mjs
git commit -m "feat(agent): unlimited steps (maxSteps<=0) + forced wrap-up round at the cap"
```

---

### Task 3: 透传修 falsy-0 bug + workbench-agent 切配置读取

**Files:**
- Modify: `server/agent-runner.mjs:41`(注释)、`:83`(透传条件)
- Modify: `server/workbench-agent.mjs:36-37`(删常量)、import 行、`:179` 与 `:271`(两调用点)
- Test: `server/agent-runner-workbench.test.mjs:246-254`(改既有)+ 文件尾新增一测

**Interfaces:**
- Consumes: Task 1 的 `getMaxStepsConfig(db)`;Task 2 的 0=不设限语义。
- Produces: `createAgentRunner({ maxSteps })` 对 `0` 也透传(旧代码 `maxSteps ? ...` 会把 0 丢回默认 8);workbench 两调用点每次 run 现读配置。

- [ ] **Step 1: 改写既有透传测试 + 新增 0 档测试**

`server/agent-runner-workbench.test.mjs` 既有测试(246 行,「dev29: maxSteps 透传」)替换为:

```js
// dev29: maxSteps 透传——工作台侧深调查放宽(API-key 路径不传仍用默认 8)
// 2026-09-03 收尾轮:到上限不再硬断,追加一次无工具收尾 → content 为收尾答案
test('createAgentRunner 透传 maxSteps:到上限触发收尾轮', async () => {
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async () => {}, listResources: async () => ({ kind: 'pods', count: 0, items: [] }) }
  let chats = 0
  const llmClient = { chat: async () => (++chats <= 3 ? tc('c' + chats, 'wb_list_resources', { kind: 'pods' }) : { role: 'assistant', content: '调查完成' }) }
  const { run } = createAgentRunner({ llmClient, workbench: wb, maxSteps: 3 })
  const out = await run({ history: [] })
  assert.equal(out.truncated, true)
  assert.equal(out.steps, 4, '3 轮工具 + 1 轮收尾')
  assert.equal(out.content, '调查完成')
})

// 2026-09-03:maxSteps 0 = 不设限——旧 `maxSteps ? ...` 会把 0 当缺省丢回 8,必须 != null 透传
test('createAgentRunner maxSteps=0:不设限,超过旧默认 8 仍继续', async () => {
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async () => {}, listResources: async () => ({ kind: 'pods', count: 0, items: [] }) }
  let execCount = 0
  const llmClient = { chat: async () => (execCount >= 12 ? { role: 'assistant', content: 'done' } : tc('t' + execCount, 'wb_list_resources', { kind: 'pods' })) }
  const { run } = createAgentRunner({ llmClient, workbench: wb, maxSteps: 0 })
  const out = await run({ history: [] })
  assert.equal(out.content, 'done')
  assert.ok(out.steps >= 13, `应跑满 12 轮工具 + 终答,实际 ${out.steps}`)
})
```

(若该测试文件的 llmClient 桩有其他必需字段,以上述文件既有测试的桩形状为准补齐;`tc` helper 为该文件既有。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/agent-runner-workbench.test.mjs`
Expected: FAIL — 新 0 档测试在 8 步被截断返回灰字(steps≈9 不满足 ≥13);既有透传测试因收尾轮语义变化 steps 断言失败

- [ ] **Step 3: 实现**

`server/agent-runner.mjs`:

41 行注释改为:

```js
// maxSteps(可选):透传 createAgent;缺省用 agent.mjs 的 MAX_STEPS=8;0 = 不限制(须 != null 判定,0 是合法值)。
```

83 行透传条件改为:

```js
  const agent = createAgent({ chat, toolDefs, execTool, needsApproval: needsApprovalFn, ...(maxSteps != null ? { maxSteps } : {}), ...(budgetChars ? { budgetChars } : {}) })
```

`server/workbench-agent.mjs`:

① 删 36-37 行(注释 + `const WB_MAX_STEPS = ...`——常量与「ImagePullBackOff 走了 26 步」背景注释已迁 `workbench-ai-config.mjs`)。

② 在现有 `from './workbench-ai-config.mjs'` 的 import 中追加 `getMaxStepsConfig`。

③ 179 行与 271 行两处 `maxSteps: WB_MAX_STEPS,` 均改为:

```js
        maxSteps: getMaxStepsConfig(db), // 每次 run 现读(同 disabledTools 即时生效语义);0=不限制
```

- [ ] **Step 4: 跑测试确认通过 + 残留扫描**

Run: `node --test server/agent-runner-workbench.test.mjs && grep -rn "WB_MAX_STEPS" server/ --include="*.mjs" | grep -v test`
Expected: 测试全绿;grep 仅剩 `workbench-ai-config.mjs` 一处(env 通道实现)。

再跑: `npm test 2>&1 | tail -5`
Expected: 服务端全量绿(workbench-conversations 等注入 stub runner 的测试不受影响)。

- [ ] **Step 5: Commit**

```bash
git add server/agent-runner.mjs server/workbench-agent.mjs server/agent-runner-workbench.test.mjs
git commit -m "feat(agent-runner): pass maxSteps=0 through; workbench reads cap per-run from config"
```

---

### Task 4: admin 端点回显/保存 + 服务端消息 + deployment.yaml 注释

**Files:**
- Modify: `server/routes/admin.mjs:12`(import)、`:200-206`(GET 回显)、`:220-223` 后(PUT 校验落库)
- Modify: `server/messages/admin.mjs`(新增 `aiMaxStepsInvalid`)
- Modify: `deployment.yaml`(env 段注释示例,约 74 行 LLM 注释附近)
- Test: `server/workbench-ai-config-routes.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `getMaxStepsConfig` / `validateMaxSteps` / `MAX_STEPS_RANGE`。
- Produces: `GET /api/admin/workbench-ai-config` 响应新增字段 `maxSteps`(已解析整数,0=不限制);`PUT` 接受可选 `maxSteps`(缺省=不修改;非法→400 i18n 文案)。

- [ ] **Step 1: 写失败测试**

`server/workbench-ai-config-routes.test.mjs` 文件尾追加(复用既有 `adminHarness` / `U` helper):

```js
// ===== 最大执行步数(2026-09-03):GET 回显已解析值;PUT 缺省不改/0=不限制/非法 400 =====
test('admin GET:回显 maxSteps(缺省 16)', async () => {
  const { routes, sent } = adminHarness()
  await routes.handle({ method: 'GET' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(sent[0].status, 200)
  assert.equal(sent[0].json.maxSteps, 16)
})

test('admin PUT:maxSteps 30 落库读回;0=不限制读回 0', async () => {
  const a = adminHarness({ body: { maxSteps: 30 } })
  await a.routes.handle({ method: 'PUT' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(a.sent[0].status, 200)
  await a.routes.handle({ method: 'GET' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(a.sent[1].json.maxSteps, 30)

  const b = adminHarness({ body: { maxSteps: 0 } })
  await b.routes.handle({ method: 'PUT' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(b.sent[0].status, 200)
  await b.routes.handle({ method: 'GET' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(b.sent[1].json.maxSteps, 0)
})

test('admin PUT:maxSteps 缺省不修改旧值;非法 → 400 双语文案(zh 无头默认)', async () => {
  const a = adminHarness({ settings: { 'workbench.maxSteps': '30' }, body: { additionalInstructions: 'x' } })
  await a.routes.handle({ method: 'PUT' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(a.sent[0].status, 200)
  await a.routes.handle({ method: 'GET' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(a.sent[1].json.maxSteps, 30, '缺 maxSteps 键 → 不修改')

  const b = adminHarness({ body: { maxSteps: 999 } })
  await b.routes.handle({ method: 'PUT' }, null, U('/api/admin/workbench-ai-config'))
  assert.equal(b.sent[0].status, 400)
  assert.equal(b.sent[0].json.message, '最大执行步数必须是 0-200 的整数(0 = 不限制)')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/workbench-ai-config-routes.test.mjs`
Expected: FAIL — GET 响应无 `maxSteps` 字段(undefined ≠ 16);400 文案缺失(msg 缺码返回键本身)

- [ ] **Step 3: 实现**

`server/routes/admin.mjs`:

12 行 import 追加:

```js
import { getWorkbenchAiConfig, validateDisabledTools, clampInstructions, getMaxStepsConfig, validateMaxSteps, MAX_STEPS_RANGE } from '../workbench-ai-config.mjs'
```

GET 响应对象(203 行 `projectMemory` 之后)追加一行:

```js
        maxSteps: getMaxStepsConfig(db), // 最大执行步数(2026-09-03):回显已解析值(0=不限制),所见即所发
```

PUT 落库区(223 行 `projectMemory` 写入之后、`sendJson(res, 200, ...)` 之前)追加:

```js
        // 最大执行步数(2026-09-03):null/undefined = 不修改(与 projectMemory 语义一致);0 = 不限制
        const ms = validateMaxSteps(input.maxSteps)
        if (!ms.ok) { sendJson(res, 400, { message: msg(req, 'admin.aiMaxStepsInvalid', { lo: MAX_STEPS_RANGE.lo, hi: MAX_STEPS_RANGE.hi }) }); return true }
        if (ms.value != null) setSetting('workbench.maxSteps', String(ms.value))
```

`server/messages/admin.mjs`(既有条目旁,如 `aiToolUnknown` 附近)按该文件既有格式追加:

```js
  aiMaxStepsInvalid: { zh: '最大执行步数必须是 {lo}-{hi} 的整数(0 = 不限制)', en: 'Max agent steps must be an integer between {lo} and {hi} (0 = unlimited)' },
```

`deployment.yaml` env 段(72-74 行注释块之后)追加注释示例:

```yaml
            # 可选:工作台 AI 最大执行步数的「缺省值」(管理后台「AI 行为」面板可覆盖并存库;
            # 0 = 不限制;未设时默认 16)。仅作缺省通道,改动即时生效无需重启(面板存库值优先)。
            # - name: WB_MAX_STEPS
            #   value: "16"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/workbench-ai-config-routes.test.mjs && npm test 2>&1 | tail -5`
Expected: 全绿(既有 GET/PUT 测试不受影响——新增字段不破坏 deepEqual 之外的断言;先核对既有测试无对该响应的整对象 deepEqual,若有则按新增字段更新之)

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.mjs server/messages/admin.mjs server/workbench-ai-config-routes.test.mjs deployment.yaml
git commit -m "feat(admin): expose/validate maxSteps on workbench-ai-config endpoints"
```

---

### Task 5: truncated 旗标活体管道修复(SSE 侧)

**Files:**
- Modify: `server/conv-events.mjs:21-31`(done 事件携带 truncated)
- Modify: `src/components/workbench/conv-stream.js:71`(reducer 收 truncated)
- Test: `server/conv-events.test.mjs`(改两断言 + 新增一测)、`src/components/workbench/__tests__/conv-stream.test.js`(新增一测)

**Interfaces:**
- Consumes: Task 2 产出的 `out.truncated`。
- Produces: SSE `status:done` 事件新增 `truncated: boolean`;前端流状态(state)`truncated` 在 done 时可变 true——WorkbenchChat `:748` 的既有映射 `truncated: !!agentTurn.truncated` 自动受益,无需改动。

- [ ] **Step 1: 写失败测试**

`server/conv-events.test.mjs`:

17-23 行既有 done 测试的两处 deepEqual 补 `truncated: false`:

```js
test('done → status:done + end,dispose', () => {
  const { events, dispose } = eventsForResult({ status: 'done', content: 'hello' })
  assert.equal(dispose, true)
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], { type: 'status', status: 'done', truncated: false })
  assert.deepEqual(events[1], { type: 'end' })
})
```

25-31 行「无 status 字段默认走 done 路径」测试的 events[0] deepEqual 同样补 `truncated: false`。文件尾新增:

```js
test('done + truncated → status 事件透传 truncated(2026-09-03 收尾轮标识)', () => {
  const { events } = eventsForResult({ status: 'done', content: 'ans', truncated: true })
  assert.deepEqual(events[0], { type: 'status', status: 'done', truncated: true })
})
```

`src/components/workbench/__tests__/conv-stream.test.js` 文件尾新增(复用既有 `fresh()` helper):

```js
test('status=done 携带 truncated → 落入 state(2026-09-03 收尾轮标识)', () => {
  expect(applyStreamEvent(fresh(), { type: 'status', status: 'done', truncated: true }).truncated).toBe(true)
  expect(applyStreamEvent(fresh(), { type: 'status', status: 'done' }).truncated).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/conv-events.test.mjs` 与 `npx vitest run src/components/workbench/__tests__/conv-stream.test.js --maxWorkers=2`
Expected: 双双 FAIL(server 侧 deepEqual 缺字段;前端侧 truncated 恒 false)

- [ ] **Step 3: 实现**

`server/conv-events.mjs` 21-31 行 done 分支:

```js
  // done(以及其他终态——非 paused)都按 done 处理并 dispose;
  // truncated 透传(2026-09-03):收尾轮答案/旧硬断都带此标,前端亮「已达步数上限」
  return {
    events: [
      { type: 'status', status: 'done', truncated: !!out.truncated },
      { type: 'end' },
    ],
    dispose: true,
  }
```

`src/components/workbench/conv-stream.js` 71 行 status done 分支:

```js
      if (evt.status === 'done') return ensureFinalAnswerBlock(clean({ ...state, status: 'done', truncated: !!(evt.truncated || state.truncated) }))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/conv-events.test.mjs && npx vitest run src/components/workbench/__tests__/conv-stream.test.js --maxWorkers=2`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add server/conv-events.mjs server/conv-events.test.mjs src/components/workbench/conv-stream.js src/components/workbench/__tests__/conv-stream.test.js
git commit -m "fix(chat): carry truncated flag through SSE done event into stream state"
```

---

### Task 6: ChatTurn 警告语义拆分(有答案=小标 / 无答案=大警告块)

**Files:**
- Modify: `src/components/workbench/ChatTurn.vue:218`(小标条件与文案)、`:260-265`(大警告块条件)
- Modify: `src/locales/zh.json` + `src/locales/en.json`(`workbench.chat.stepsLimitWrapped`)
- Test: `src/components/workbench/__tests__/ChatTurn.test.js:129-134`(改既有 fixture)+ 新增一测

**Interfaces:**
- Consumes: Task 5 的 state.truncated。
- Produces: 渲染语义——`truncated && content`(收尾轮答案)→ 角色行小黄标「已达步数上限…」;`truncated && !content`(旧硬断存量/兜底)→ 保留醒目大警告块。

- [ ] **Step 1: 写失败测试**

`src/components/workbench/__tests__/ChatTurn.test.js` 129-134 行既有测试替换(fixture content 改空串——新语义下大警告块只在无终答时出现),并在其后新增:

```js
// 2026-08-27 静默终止审计 + 2026-09-03 收尾轮拆分:truncated 无终答 → 醒目大警告块;
// 有收尾答案 → 只亮角色行小黄标(答案本身是主体,大块警告反而喧宾夺主)。
test('ChatTurn: truncated 无终答 → 渲染醒目步数用尽警告块', () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'done', content: '', truncated: true } }, global: { plugins: [i18n] } })
  expect(w.text()).toContain('已达到最大执行步数')
  expect(w.find('.text-status-warning').exists()).toBe(true)
})

test('ChatTurn: truncated 有收尾答案 → 只亮小标,无大警告块', () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'done', content: '基于部分信息的结论', truncated: true } }, global: { plugins: [i18n] } })
  expect(w.text()).toContain('已达步数上限')
  expect(w.text()).not.toContain('已达到最大执行步数')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/workbench/__tests__/ChatTurn.test.js --maxWorkers=2`
Expected: FAIL — 新测断言的「已达步数上限」小标文案尚不存在

- [ ] **Step 3: 实现**

`src/locales/zh.json` 的 `workbench.chat` 下追加(`en.json` 同步,键序一致):

```json
"stepsLimitWrapped": "已达步数上限,以上为基于部分信息的回答"
```

```json
"stepsLimitWrapped": "Step limit reached — answer based on partial results"
```

`src/components/workbench/ChatTurn.vue`:

218 行小标(条件收窄到有答案场景,换新文案):

```html
      <span v-if="turn.truncated && turn.content" class="text-body-xs text-status-warning">⚠ {{ t('workbench.chat.stepsLimitWrapped') }}</span>
```

260-265 行大警告块(条件收窄到无终答场景,注释同步更新):

```html
      <!-- 步数用尽警告(2026-08-27 审计;2026-09-03 收尾轮拆分):无终答(旧硬断存量/兜底)
           → 醒目警告块;有收尾答案 → 仅角色行小黄标(stepsLimitWrapped),答案为主体。 -->
      <div v-if="turn.truncated && !turn.content" class="flex items-start gap-sm px-md py-sm bg-status-warning/5 border border-status-warning/30 rounded-xl">
```

(inner 内容不变。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/workbench/__tests__/ChatTurn.test.js --maxWorkers=2 && npm run i18n:check`
Expected: 全绿(键对齐门禁含新键)

- [ ] **Step 5: Commit**

```bash
git add src/components/workbench/ChatTurn.vue src/components/workbench/__tests__/ChatTurn.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(chat): split truncation warning into wrapped-answer badge vs no-answer block"
```

---

### Task 7: AI 行为面板 UI(不限制开关 + 步数输入)

**Files:**
- Modify: `src/views/admin/AiBehaviorConfig.vue`(头注释、script、模板主配置卡)
- Modify: `src/locales/zh.json` + `src/locales/en.json`(`admin.aiBehavior.maxSteps*` 三键)
- Test: `src/views/admin/__tests__/AiBehaviorConfig.test.js`(改既有 payload 断言 + 新增两测)

**Interfaces:**
- Consumes: Task 4 的 GET `maxSteps` 字段与 PUT `maxSteps` 参数(经既有 `adminApi.workbenchAiConfig.get/save`,client.js 零改动)。
- Produces: 保存 payload 恒含 `maxSteps`(勾不限制→`0`;否则→输入值,空串/垃圾回 16)。

- [ ] **Step 1: 写失败测试**

`src/views/admin/__tests__/AiBehaviorConfig.test.js`:

① 既有「保存:payload 含指令与禁用名单」测试的 `toHaveBeenCalledWith` 期望对象追加 `maxSteps: 16`(FIXTURE 无 maxSteps → load 兜底 16)。既有 projectMemory 开关测试若有同款整对象 payload 断言,同样追加 `maxSteps` 期望值。

② 文件尾追加:

```js
// ===== 最大执行步数(2026-09-03):回显 / 不限制开关联动禁用 / 保存 payload =====
test('maxSteps 回显:服务端 30 → 输入框 30;0 → 不限制开关开+输入禁用', async () => {
  adminApi.workbenchAiConfig.get.mockResolvedValue({ ...FIXTURE, maxSteps: 30 })
  const w = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(w.find('[data-testid="max-steps"]').element.value).toBe('30')
  expect(w.find('[data-testid="max-steps-unlimited"]').attributes('aria-checked')).toBe('false')

  adminApi.workbenchAiConfig.get.mockResolvedValue({ ...FIXTURE, maxSteps: 0 })
  const w2 = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(w2.find('[data-testid="max-steps-unlimited"]').attributes('aria-checked')).toBe('true')
  expect(w2.find('[data-testid="max-steps"]').element.disabled).toBe(true)
})

test('maxSteps 保存:开不限制 → payload 0;改 40 → payload 40', async () => {
  adminApi.workbenchAiConfig.get.mockResolvedValue({ ...FIXTURE, maxSteps: 16 })
  adminApi.workbenchAiConfig.save.mockResolvedValue({ ok: true })
  const w = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  await w.find('[data-testid="max-steps-unlimited"]').trigger('click')
  await w.find('[data-testid="save-btn"]').trigger('click')
  await flushPromises()
  expect(adminApi.workbenchAiConfig.save).toHaveBeenLastCalledWith(expect.objectContaining({ maxSteps: 0 }))

  const w2 = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  await w2.find('[data-testid="max-steps"]').setValue(40)
  await w2.find('[data-testid="save-btn"]').trigger('click')
  await flushPromises()
  expect(adminApi.workbenchAiConfig.save).toHaveBeenLastCalledWith(expect.objectContaining({ maxSteps: 40 }))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/admin/__tests__/AiBehaviorConfig.test.js --maxWorkers=2`
Expected: FAIL — `[data-testid="max-steps"]` 不存在;既有 payload 断言缺 maxSteps 键

- [ ] **Step 3: 实现**

`src/locales/zh.json` 的 `admin.aiBehavior` 下追加(`en.json` 同步):

```json
"maxStepsLabel": "最大执行步数",
"maxStepsUnlimited": "不限制步数",
"maxStepsHint": "单次回答最多执行多少轮「模型→工具」往返(实测:排查一个 ImagePullBackOff 走了 26 步,默认 16 不够用)。勾选不限制即不设上限,仅由上下文预算兜底。保存后下一次对话生效,无需重启。"
```

```json
"maxStepsLabel": "Max agent steps",
"maxStepsUnlimited": "Unlimited steps",
"maxStepsHint": "How many model→tool round-trips one answer may take (a real ImagePullBackOff investigation took 26 steps — the default 16 falls short). Check \"Unlimited\" to remove the cap; the context budget still backs things off. Takes effect on the next conversation, no restart needed."
```

`src/views/admin/AiBehaviorConfig.vue`:

script 头注释(第 2 行)追加「+ 最大执行步数(2026-09-03)」。script 声明区追加:

```js
// 最大执行步数(2026-09-03):0=不限制;输入框在勾选不限制时禁用
const maxSteps = ref(16)
const maxStepsUnlimited = ref(false)
```

`load()` 内 `projectMemory.value = ...` 之后追加:

```js
    maxStepsUnlimited.value = s.maxSteps === 0
    maxSteps.value = s.maxSteps > 0 ? s.maxSteps : 16
```

`save()` 的 payload 追加字段(空串/垃圾回 16;0 只经由开关产生,防误清空输入框即变不限制):

```js
async function save() {
  saving.value = true
  try {
    const n = Number(maxSteps.value)
    const maxStepsPayload = maxStepsUnlimited.value ? 0 : (Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 16)
    await adminApi.workbenchAiConfig.save({ additionalInstructions: instructions.value.slice(0, 4000), disabledTools: disabled.value, projectMemory: projectMemory.value, maxSteps: maxStepsPayload })
```

模板主配置卡(第一张卡,projectMemory 开关行之后、卡内闭合 div 之前)追加:

```html
        <!-- 最大执行步数(2026-09-03):0/勾选=不限制,仅上下文预算兜底;保存即时生效 -->
        <div class="flex flex-col gap-xs">
          <div class="flex items-center gap-sm flex-wrap">
            <button data-testid="max-steps-unlimited" @click="maxStepsUnlimited = !maxStepsUnlimited" role="switch" :aria-checked="String(maxStepsUnlimited)"
              class="w-9 h-5 rounded-full relative transition-colors shrink-0"
              :class="maxStepsUnlimited ? 'bg-primary' : 'bg-surface-container-highest'">
              <span class="absolute top-0.5 w-4 h-4 rounded-full bg-on-primary transition-all"
                :class="maxStepsUnlimited ? 'left-4.5' : 'left-0.5'"></span>
            </button>
            <span class="text-body-sm font-medium">{{ $t('admin.aiBehavior.maxStepsUnlimited') }}</span>
            <label class="flex items-center gap-xs ml-auto">
              <span class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.maxStepsLabel') }}</span>
              <input v-model.number="maxSteps" type="number" min="1" max="200" :disabled="maxStepsUnlimited" data-testid="max-steps"
                class="w-20 bg-surface-container-low border border-outline-variant rounded px-sm py-xs text-body-sm disabled:opacity-40" />
            </label>
          </div>
          <p class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.maxStepsHint') }}</p>
        </div>
```

(开关样式逐字复用同卡 projectMemory 开关配方;输入框样式复用 presence 卡数字输入配方,宽度 w-20 有界,不触 overflow-guard 守卫。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/admin/__tests__/AiBehaviorConfig.test.js --maxWorkers=2 && npm run i18n:check && npm run test:unit 2>&1 | tail -5`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/views/admin/AiBehaviorConfig.vue src/views/admin/__tests__/AiBehaviorConfig.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(admin-ui): max-steps input + unlimited toggle in AI behavior panel"
```

---

### Task 8: 全门禁 + dist 重建 + 手测清单

**Files:**
- 无新改动(验证 + 构建任务)。

- [ ] **Step 1: 全门禁**

```bash
npm run i18n:check && npm test && npm run test:unit && npm run typecheck
```

Expected: 四件套全绿。任何红灯先分辨是本分支引入还是 main 既有(并行会话活跃),既有红灯不修不在本计划范围。

- [ ] **Step 2: 重建 dist**

```bash
npm run build
```

Expected: 构建成功(echarts 等 chunk 正常切分)。

- [ ] **Step 3: 手测清单(需重启网关 + LLM/集群环境;网关重启后进行)**

1. 管理后台 → AI 行为:主配置卡出现「不限制步数」开关 + 「最大执行步数」输入框,回显当前值(全新库=16)。
2. 改 30 → 保存 → 刷新页面回显 30;en 语言下文案为英文。
3. 勾「不限制」→ 输入框变禁用态;保存 → 刷新开关仍开(库存 0)。
4. 30 档:让 AI 做多步排查任务(如「查 xx pod 为什么 CrashLoopBackOff」),步数计数超过 16 仍继续。
5. 16 档(或人为调低)让任务超限:不再出现灰字「(达到最大步数,未给出终答)」,而是模型基于已获信息给出收尾总结 + 角色行小黄标「已达步数上限,以上为基于部分信息的回答」。
6. 运行中的对话不受影响,下一次提问按新值执行(即时生效语义)。
7. 悬浮对话入口同验第 5 条(同组件)。

- [ ] **Step 4: 手测通过后按 finishing-a-development-branch 流程 --no-ff 合回 main**(若 main 已被并行推进,合并后重跑 Step 1 全门禁)。

## Self-Review 记录

- 规格覆盖:设计裁决 1-6 → Task 7(面板)/ Task 1+4(存储与端点)/ Task 3(现读接线)/ Task 2(收尾轮+不设限)/ Task 5+6(活体旗标与呈现);MCP 不暴露=无任务(裁决 6 的「不做」项)。
- 占位符扫描:无 TBD/「适当处理」;所有代码步骤含可复制实现。
- 类型一致性:`getMaxStepsConfig(db)`(Task 1 定义,Task 3/4 消费)、`validateMaxSteps(input)` 返回形状(Task 1 定义,Task 4 消费)、`MAX_STEPS_RANGE.{lo,hi}`(Task 1 定义,Task 4 插值)、SSE `truncated`(Task 5 定义,Task 6 消费)、payload `maxSteps`(Task 7 产出,Task 4 校验)——已逐一核对。
