# AI 对话 compact + 上下文余量 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 对话支持上下文余量展示(模型窗口口径)+ 手动 compact(全量重摘要+自定义指令),硬裁剪预算跟随模型窗口。

**Architecture:** 新纯函数模块 `server/model-context.mjs`(模型→窗口表/token 估算/预算派生);`trimMessages` 预算经 `workbench-agent → agent-runner → agent` 注入(取 `llmClient.model`);`GET /:id` 响应新增 `context` 字段(服务端单一计算源);`workbench-summarize.mjs` 新增 `compactConversation`(复用其 LLM 调用形状)+ `POST /:id/compact` 端点;前端 WorkbenchChat 输入区上方余量条(三色阈值)+ 压缩 modal(ChatModal 复用同组件自动获得)。

**Tech Stack:** 零新依赖;服务端 node:test + :memory: SQLite;前端 vitest + @vue/test-utils;i18n zh/en 双语。

**Spec:** `docs/superpowers/specs/2026-08-28-ai-context-compact-design.md`(字段口径/门禁/色彩语义以 spec 为准)

## Global Constraints

- 仓库零新外部依赖;测试用自研运行器(node:test)与 vitest。
- 提交作者恒为 `aliangone <aliangone@gmail.com>`,禁止 Claude 尾注。
- i18n:zh/en 同步加键,文案不得硬编码中文进组件;`npm run i18n:check` 须过。
- 服务端 SQLite 写入经 `updateConversation`(undefined→null/对象→JSON 由其统一处理)。
- 预算线 = `windowTokens × 0.7 × 2` 字符;黄≥70% 窗口(=到预算线)、红≥90%(=超线裁剪中);`willTrim = estTokens > budgetTokens`。

---

### Task 1: `server/model-context.mjs` 纯函数模块

**Files:**
- Create: `server/model-context.mjs`
- Test: `server/model-context.test.mjs`

**Interfaces:**
- Produces(Task 2/3 消费的精确签名):
  - `contextWindowFor(modelName: string): number` — 窗口 tokens,未命中默认 `200_000`
  - `estTokens(chars: number): number` — `Math.ceil(chars / 2)`
  - `trimBudgetChars(windowTokens: number): number` — `Math.floor(windowTokens * 0.7 * 2)`

- [ ] **Step 1: 写失败测试**

```js
// server/model-context.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { contextWindowFor, estTokens, trimBudgetChars } from './model-context.mjs'

test('contextWindowFor:家族 substring 匹配(小写化)', () => {
  assert.equal(contextWindowFor('gpt-4o'), 128_000)
  assert.equal(contextWindowFor('gpt-4o-2024-11-20'), 128_000)
  assert.equal(contextWindowFor('gpt-4.1'), 1_000_000)
  assert.equal(contextWindowFor('gpt-5'), 1_000_000)
  assert.equal(contextWindowFor('o3-mini'), 200_000)
  assert.equal(contextWindowFor('claude-sonnet-4-6'), 200_000)
  assert.equal(contextWindowFor('deepseek-chat'), 128_000)
  assert.equal(contextWindowFor('deepseek-reasoner'), 128_000)
  assert.equal(contextWindowFor('qwen-max'), 128_000)
  assert.equal(contextWindowFor('qwen3-235b-a22b'), 128_000)
  assert.equal(contextWindowFor('glm-4.5-air'), 128_000)
  assert.equal(contextWindowFor('moonshot-v1-8k'), 128_000)
  assert.equal(contextWindowFor('kimi-k2'), 128_000)
  assert.equal(contextWindowFor('gemini-2.0-flash'), 1_000_000)
  assert.equal(contextWindowFor('doubao-pro-32k'), 128_000)
  assert.equal(contextWindowFor('GPT-4O'), 128_000, '大小写不敏感')
})

test('contextWindowFor:未命中/空 → 默认 200k', () => {
  assert.equal(contextWindowFor('totally-unknown-model'), 200_000)
  assert.equal(contextWindowFor(''), 200_000)
  assert.equal(contextWindowFor(null), 200_000)
  assert.equal(contextWindowFor(undefined), 200_000)
})

test('estTokens:chars/2 向上取整(中文≈1字/token、英文≈4字符/token 折中)', () => {
  assert.equal(estTokens(0), 0)
  assert.equal(estTokens(100), 50)
  assert.equal(estTokens(101), 51)
})

test('trimBudgetChars:窗口 70% 折算字符(×2 反向估算)', () => {
  assert.equal(trimBudgetChars(200_000), 280_000)   // 200k 窗口 → 140k token 预算 → 280k 字符
  assert.equal(trimBudgetChars(128_000), 179_200)
  assert.equal(trimBudgetChars(1_000_000), 1_400_000)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/model-context.test.mjs`
Expected: FAIL(模块不存在,cannot find module)

- [ ] **Step 3: 最小实现**

```js
// server/model-context.mjs
// 模型上下文窗口表 + token 估算 + 硬裁剪预算派生(spec 2026-08-28 §4.1,单一事实源)。
// 条目取家族保守下限:低估只影响展示偏小,高估才有真实溢出风险(由 provider 报错兜底)。
// 未命中默认 200k(spec D1)。substring 匹配,长前缀在前防短名误吞。
const DEFAULT_WINDOW_TOKENS = 200_000

// [子串, 窗口 tokens]——匹配用 String(model).toLowerCase().includes(子串)
const MODEL_WINDOWS = [
  ['gpt-4.1', 1_000_000],
  ['gpt-5', 1_000_000],
  ['gemini', 1_000_000],
  ['gpt-4o', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4', 128_000],
  ['o1', 200_000],
  ['o3', 200_000],
  ['o4', 200_000],
  ['claude', 200_000],
  ['deepseek', 128_000],
  ['qwen', 128_000],
  ['glm', 128_000],
  ['moonshot', 128_000],
  ['kimi', 128_000],
  ['doubao', 128_000],
]

export function contextWindowFor(modelName) {
  const m = String(modelName || '').toLowerCase()
  if (!m) return DEFAULT_WINDOW_TOKENS
  for (const [frag, win] of MODEL_WINDOWS) {
    if (m.includes(frag)) return win
  }
  return DEFAULT_WINDOW_TOKENS
}

// 混合估算(中文≈1字/token、英文≈4字符/token 的折中);UI 标注「估算」
export function estTokens(chars) {
  return Math.ceil(Number(chars || 0) / 2)
}

// 硬裁剪预算(spec D4):窗口 70% 折算字符;60K 固定线退役
export function trimBudgetChars(windowTokens) {
  return Math.floor(Number(windowTokens || DEFAULT_WINDOW_TOKENS) * 0.7 * 2)
}
```

注意匹配顺序:`'gpt-4'` 条目排在 `'gpt-4o'`/`'gpt-4-turbo'`/`'gpt-4.1'`/`'gpt-5'` 之后(否则 `gpt-4.1` 会被 `gpt-4` 的 128k 吞掉)。`o1/o3/o4` 用 `'o1'` 短子串有误吞风险(如 `'proto3-model'`),家族实际命名 `o1-xxx` 可接受;若担心可改成 `' o1'` 带空格——本表按 includes 实现即可,测试已锁行为。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/model-context.test.mjs`
Expected: 4 pass

- [ ] **Step 5: 提交**

```bash
git add server/model-context.mjs server/model-context.test.mjs
git commit -m "feat(context): model-context 模块——模型窗口表/token 估算/裁剪预算派生(compact+余量 T1)"
```

---

### Task 2: trimMessages 预算注入链(workbench-agent → runner → agent)

**Files:**
- Modify: `server/agent.mjs:83`(createAgent 签名)、`server/agent.mjs:157`(trimMessages 调用)
- Modify: `server/agent-runner.mjs:40`(createAgentRunner 签名)、`server/agent-runner.mjs:68`(createAgent 调用)
- Modify: `server/workbench-agent.mjs:144-149 与 209-215`(两处 createAgentRunner 调用)
- Test: `server/agent.test.mjs`(追加)、`server/workbench-agent.test.mjs`(追加)

**Interfaces:**
- Consumes: Task 1 的 `contextWindowFor` / `trimBudgetChars`
- Produces: `createAgent({ ..., budgetChars })`、`createAgentRunner({ ..., budgetChars })` 新可选参;生产链 workbench-agent 恒注入(由 `llmClient.model` 派生)

- [ ] **Step 1: 写失败测试(agent 层)**

追加到 `server/agent.test.mjs` 末尾:

```js
// ── 2026-08-28 compact+余量 T2:裁剪预算注入(窗口 70% 派生,60K 固定线退役)──
test('createAgent budgetChars 注入:trimMessages 用注入预算而非 60K 缺省', async () => {
  // 预算 300 字符:2 条 user 各 160 字 → 总 320 > 300,最旧 user 应被丢
  const seen = []
  const chat = async (messages) => { seen.push(messages.map(m => m.content)); return { role: 'assistant', content: 'ok' } }
  const run = createAgent({ chat, execTool: async () => 'x', budgetChars: 300 }).run
  await run({ history: [
    { role: 'user', content: 'A'.repeat(160) },
    { role: 'assistant', content: 'B'.repeat(1) },
    { role: 'user', content: 'C'.repeat(160) },
  ] })
  const firstRound = seen[0]
  assert.ok(!firstRound.some(c => String(c).startsWith('A'.repeat(20))), '超注入预算,最旧 user 被裁')
  assert.ok(firstRound.some(c => String(c).startsWith('C'.repeat(20))), '最新 user 保留')
})

test('createAgent 未注入 budgetChars → 维持 60K 缺省(既有单测兼容)', async () => {
  // 60k 缺省下小对话不裁;断言经由已有 trimMessages 行为(此处仅锁 createAgent 不因缺参抛错)
  const run = createAgent({ chat: async () => ({ role: 'assistant', content: 'ok' }), execTool: async () => 'x' }).run
  const out = await run({ history: [{ role: 'user', content: 'hi' }] })
  assert.equal(out.content, 'ok')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/agent.test.mjs`
Expected: 第一条 FAIL(旧预算 60k 不裁 320 字符)

- [ ] **Step 3: agent.mjs 实现**

`server/agent.mjs:83` 签名加参:

```js
export function createAgent({ chat, toolDefs = [], execTool, needsApproval = () => false, maxSteps = MAX_STEPS, budgetChars = DEFAULT_BUDGET_CHARS }) {
```

`server/agent.mjs:157` 调用改:

```js
const t = trimMessages(messages, budgetChars)
```

- [ ] **Step 4: agent-runner.mjs 透传**

`server/agent-runner.mjs:40` 签名加 `budgetChars`:

```js
export function createAgentRunner({ llmClient, apiKeyTools, keyRow, cluster, workbench, audit, maxSteps, disabledTools, budgetChars }) {
```

`server/agent-runner.mjs:68` createAgent 调用拼接(与 maxSteps 同款条件展开):

```js
const agent = createAgent({ chat, toolDefs, execTool, needsApproval: n => requiringApproval.has(n) && offered.has(n), ...(maxSteps ? { maxSteps } : {}), ...(budgetChars ? { budgetChars } : {}) })
```

- [ ] **Step 5: workbench-agent 注入(两处)**

`server/workbench-agent.mjs` 顶部 import 增加:

```js
import { contextWindowFor, trimBudgetChars } from './model-context.mjs'
```

两处 `createAgentRunner({ llmClient, workbench: ctx, audit: {...}, maxSteps: WB_MAX_STEPS, disabledTools: ... })`(runConversation ~line 144、resumeConversation ~line 209)各追加一项:

```js
        budgetChars: trimBudgetChars(contextWindowFor(llmClient.model)),
```

- [ ] **Step 6: workbench-agent 侧测试(注入到达 runner)**

追加到 `server/workbench-agent.test.mjs` 末尾:

```js
// T2:裁剪预算注入到达 runner(llmClient.model → 窗口 → 70% 折算)
test('runConversation: budgetChars 按 llmClient.model 派生传入 runner', async () => {
  const { db, conv, busEmit, busDispose } = setup()
  let capturedBudget = null
  const createAgentRunner = (opts) => { capturedBudget = opts.budgetChars; return { run: async () => ({ status: 'done', content: 'ok', steps: 1, messages: [], queue: [], denied: [] }) } }
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  const llmClient = { chat: async () => ({}), model: 'qwen-max' }   // 128k 窗口
  await agent.runConversation(conv.id, llmClient)
  assert.equal(capturedBudget, 179_200, '128k×0.7×2=179200 字符')
})
```

Run: `node --test server/workbench-agent.test.mjs server/agent.test.mjs server/agent-runner.test.mjs server/agent-runner-workbench.test.mjs`
Expected: 全 PASS

- [ ] **Step 7: 提交**

```bash
git add server/agent.mjs server/agent.test.mjs server/agent-runner.mjs server/workbench-agent.mjs server/workbench-agent.test.mjs
git commit -m "feat(context): trimMessages 预算跟随模型窗口——60K 固定线退役,经 llmClient.model 派生注入(compact+余量 T2)"
```

---

### Task 3: `GET /:id` 新增 context 字段(服务端单一计算源)

**Files:**
- Modify: `server/routes/workbench-conversations.mjs`(GET /:id 响应处 ~line 226-236;create/append 响应处)
- Test: `server/workbench-conversations.test.mjs`(追加)

**Interfaces:**
- Consumes: Task 1 `contextWindowFor`/`estTokens`/`trimBudgetChars`;既有 `buildHistory`、`getLlmConfig().model`
- Produces: 响应字段 `context: { estTokens, windowTokens, budgetTokens, recapUpTo, willTrim }`(Task 5 前端消费;Task 4 compact 响应复用同形状)

- [ ] **Step 1: 写失败测试**

先看 `server/workbench-conversations.test.mjs` 现有 GET /:id 测试的挂载方式(spawn 网关 or 直接调 handle),按同款追加:

```js
// ── T3:GET /:id 带 context 字段(余量口径见 spec §4.3)──
test('GET /:id 返回 context:estTokens/windowTokens/budgetTokens/recapUpTo/willTrim', async () => {
  // 沿用本文件现有 harness(建项目+对话+消息);按现有测试的 BASE/H 变量名
  const conv = /* 现有方式创建对话,置 done */;
  // 注:LLM 配置 model=mock-1(未命中表)→ 窗口 200k
  const r = await (await fetch(`${BASE}/api/workbench/conversations/${conv.id}`, { headers: H })).json()
  assert.ok(r.context, 'context 字段存在')
  assert.equal(r.context.windowTokens, 200_000, '未知模型默认 200k')
  assert.equal(r.context.budgetTokens, 140_000, '200k×0.7')
  assert.equal(typeof r.context.estTokens, 'number')
  assert.ok(r.context.estTokens > 0, '含 system+history 估算')
  assert.equal(r.context.recapUpTo, conv.summarizedUpTo ?? 0)
  assert.equal(r.context.willTrim, r.context.estTokens > r.context.budgetTokens)
})
```

(实现者注:`/* 现有方式 */` 处按本测试文件既有 pattern 填——文件里已有「创建对话→轮询状态」的完整先例;若该文件无直接 GET /:id 先例,参考 `wb-approval-roundtrip.test.mjs` 的 waitStatus 后直接 GET。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/workbench-conversations.test.mjs`
Expected: FAIL(`r.context` undefined)

- [ ] **Step 3: 实现 contextInfo()**

`server/routes/workbench-conversations.mjs`:`turnSnapshot` 函数(同文件 ~line 50)旁新增:

```js
  // 上下文余量(spec §4.3,服务端单一计算源):estTokens ≈ buildHistory 装配 + conv.system
  // 的总字符 × 折中比例。近似说明:@refs 每轮重拉的注入长度未计(通常远小于正文,spec 已记录)。
  function contextInfo(conv) {
    const history = buildHistory(db, conv)
    const chars = conv.system.length + history.reduce((n, m) => n + JSON.stringify(m).length, 0)
    const windowTokens = contextWindowFor(getLlmConfig().model)
    const est = estTokens(chars)
    const budgetTokens = Math.floor(windowTokens * 0.7)
    return { estTokens: est, windowTokens, budgetTokens, recapUpTo: conv.summarizedUpTo ?? 0, willTrim: est > budgetTokens }
  }
```

文件顶部 import 增加(与既有 workbench-projects import 合并):

```js
import { contextWindowFor, estTokens } from '../model-context.mjs'
```

`buildHistory` 加入既有 `from '../workbench-projects.mjs'` import 列表(若未有)。

GET /:id 响应对象(~line 226 `sendJson(res, 200, { id: conv.id, ... })`)追加一项:

```js
        context: contextInfo(conv),
```

- [ ] **Step 4: create/append 响应顺带**

POST /conversations(~line 134 `sendJson(res, 200, { id: conv.id, status: 'running', references })`)与 POST /:id/messages(~line 197 `sendJson(res, 200, { status: 'running', references })`)的响应对象各追加:

```js
  context: contextInfo(getConversation(db, <该对话id>)),
```

(create 处 `conv` 变量即新对话;messages 处为 `id`。)

- [ ] **Step 5: 跑测试确认通过 + 全文件回归**

Run: `node --test server/workbench-conversations.test.mjs server/workbench-conv-routes.test.mjs server/workbench-conv-active.test.mjs`
Expected: 全 PASS

- [ ] **Step 6: 提交**

```bash
git add server/routes/workbench-conversations.mjs server/workbench-conversations.test.mjs
git commit -m "feat(context): GET /:id 及变更响应下发 context 余量(estTokens/窗口/预算/recapUpTo/willTrim)(compact+余量 T3)"
```

---

### Task 4: compactConversation + `POST /:id/compact` 端点

**Files:**
- Modify: `server/workbench-summarize.mjs`(新增导出 `compactConversation`)
- Modify: `server/routes/workbench-conversations.mjs`(新端点,注册在 GET /:id 之前——路径更具体)
- Test: `server/workbench-summarize.test.mjs`(追加)、`server/workbench-conversations.test.mjs`(追加)

**Interfaces:**
- Consumes: Task 3 `contextInfo`(响应复用);既有 `listMessages`/`updateConversation`/`getMaxSeq`/`SUMMARIZE_PROMPT` 形状
- Produces: `compactConversation(db, convId, llmClient, instruction) → { ok: true, recap } | { ok: false, status, message }`;HTTP `POST /api/workbench/conversations/:id/compact` body `{ instruction?: string }` → `200 { ok, recap, context }`

- [ ] **Step 1: 写失败测试(领域层)**

追加到 `server/workbench-summarize.test.mjs`(沿用其现有 db/llm mock pattern):

```js
// ── T4:手动 compact(全量重摘要+可选指令;spec §4.4)──
test('compactConversation:全量重摘要落库,summarizedUpTo=最大seq-2,instruction 拼入 prompt', async () => {
  const { db, conv, llm } = /* 本文件现有 pattern */
  // 预置:1 条 recap + 5 条消息(user/assistant 交替,role/content/seq 由 appendMessage 生成)
  // mock llm.chat 捕获 messages,返回 { content: '全量新摘要' }
  const out = await compactConversation(db, conv.id, llm, '重点保留网络排查结论')
  assert.equal(out.ok, true)
  const row = getConversation(db, conv.id)
  assert.equal(row.recap, '全量新摘要', 'recap 被整体替换(旧 recap 并入摘要输入,非拼接)')
  assert.equal(row.summarizedUpTo, /* 最大seq */ - 2)
  const userPrompt = llm.chat.mock.calls[0][0].messages.map(m => m.content).join('\n')
  assert.ok(userPrompt.includes('重点保留网络排查结论'), '用户指令拼入')
  assert.ok(userPrompt.includes('第一问'), '旧消息全文进入摘要输入')
})

test('compactConversation:LLM 失败 → 不动任何字段', async () => {
  // mock llm.chat 抛错;断言 recap/summarizedUpTo 与调用前一致,out.ok=false
})

test('compactConversation:消息 ≤3 → 拒绝;running/paused → 拒绝', async () => {
  // 短对话:out = { ok:false, status:400, message:'对话太短,无需压缩' }
  // running 态对话:同型拒绝(不改 messages 保护 resume)
})
```

(实现者注:`/* 本文件现有 pattern */` 按该文件既有 harness 填,`getConversation` 从 workbench-projects import。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/workbench-summarize.test.mjs`
Expected: FAIL(compactConversation 未导出)

- [ ] **Step 3: 实现 compactConversation**

`server/workbench-summarize.mjs` 末尾新增(复用本文件 `llmClient.chat` 调用形状):

```js
// 手动 compact(spec §4.4,2026-08-28):全量重摘要(含旧 recap 作为输入)→ 新 recap 整体替换;
// 保最近 KEEP_RECENT=2 条全文(summarizedUpTo=最大seq-2)。先摘要成功再落库(失败不动 DB)。
// 门禁:仅终态(done/failed/cancelled;running/paused 会破坏 resume 状态);消息 ≤3 拒绝。
const COMPACT_KEEP_RECENT = 2
const COMPACT_MIN_MESSAGES = 4
export async function compactConversation(db, convId, llmClient, instruction = '') {
  const conv = getConversation(db, convId)
  if (!conv) return { ok: false, status: 404, message: '对话不存在' }
  if (conv.status === 'running' || conv.status === 'paused') return { ok: false, status: 400, message: '对话运行中/待审批,不能压缩' }
  const msgs = listMessages(db, convId)
  if (msgs.length <= COMPACT_MIN_MESSAGES - 1) return { ok: false, status: 400, message: '对话太短,无需压缩' }
  const maxSeq = getMaxSeq(db, convId)
  const fold = msgs.filter(m => m.seq <= maxSeq - COMPACT_KEEP_RECENT)
  const transcript = [
    ...(conv.recap ? [`(此前摘要)\n${conv.recap}`] : []),
    ...fold.map(m => `${m.role}: ${m.content}`),
  ].join('\n')
  const instruct = String(instruction || '').trim().slice(0, 200)
  try {
    const out = await llmClient.chat({
      messages: [
        { role: 'system', content: `你是对话压缩器。把下面的对话历史压缩成一份忠实、信息密集的中文摘要:保留已做出的决定、关键事实/数据、尚未解决的问题。${instruct ? `用户特别要求:${instruct}` : ''}` },
        { role: 'user', content: transcript },
      ],
    })
    const recap = out?.content?.trim()
    if (!recap) return { ok: false, status: 502, message: '摘要为空' }
    updateConversation(db, convId, { recap, summarizedUpTo: maxSeq - COMPACT_KEEP_RECENT })
    return { ok: true, recap }
  } catch (e) {
    return { ok: false, status: 502, message: e?.message || '摘要失败' }
  }
}
```

本文件 import 列表确认含 `getConversation, listMessages, getMaxSeq, updateConversation`(现有文件已 import `updateConversation/listMessages`,按需补)。

- [ ] **Step 4: 端点(HTTP 层测试先行)**

追加到 `server/workbench-conversations.test.mjs`:

```js
// T4:POST /:id/compact HTTP 契约
test('POST compact:成功 → { ok, recap, context };running → 400', async () => {
  // 沿用本文件 harness:建对话置 done,llm mock 返回固定摘要
  const r = await (await fetch(`${BASE}/api/workbench/conversations/${conv.id}/compact`, { method: 'POST', headers: H, body: JSON.stringify({ instruction: '保留结论' }) })).json()
  assert.equal(r.ok, true)
  assert.ok(r.recap)
  assert.ok(r.context.windowTokens, '响应带 context')
  // running 拒绝
  /* 第二条对话置 running */ → assert.equal(res.status, 400)
})
```

`server/routes/workbench-conversations.mjs` 新端点(**注册在 GET /:id 之前**,与 messages/regenerate 同区):

```js
    // POST /api/workbench/conversations/:id/compact — 手动压缩上下文(全量重摘要,spec §4.4)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/compact$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4]
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      if (conv.projectId) {
        const project = getProject(db, conv.projectId)
        if (project && project.ownerId !== ps.userId && ps.role !== 'admin') { sendJson(res, 403, { message: msg(req, 'wbc.noAccess') }); return true }
      }
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
      const input = await readBody(req)
      const out = await compactConversation(db, id, createLlmClient(cfg), String(input.instruction || ''))
      if (!out.ok) { sendJson(res, out.status, { message: msg(req, out.message) }); return true }
      sendJson(res, 200, { ok: true, recap: out.recap, context: contextInfo(getConversation(db, id)) })
      return true
    }
```

import 增加 `compactConversation`(from '../workbench-summarize.mjs')。服务端用户可见文案走 `msg(req, out.message)` 兜底未登记键(与 cancel 端点同款:message 表无该键时回落原文;zh/en 消息表补 `wbc.compactShort`/`wbc.compactBusy`/`wbc.compactFailed` 三键,见 Step 6)。

- [ ] **Step 5: 跑测试**

Run: `node --test server/workbench-summarize.test.mjs server/workbench-conversations.test.mjs`
Expected: PASS

- [ ] **Step 6: 服务端消息表双语键**

`server/messages/` 的 zh/en 消息表(先 `grep -rn "wbc.llmNotConfigured" server/messages/` 定位文件)各补:

```json
"wbc.compactShort": "对话太短,无需压缩",
"wbc.compactBusy": "对话运行中/待审批,不能压缩",
"wbc.compactFailed": "摘要失败"
```

(en 对应:"Conversation too short to compact" / "Conversation running/paused, cannot compact" / "Summarization failed";`compactConversation` 返回的 message 恰为这三键 + '对话不存在'→已有 wbc.convNotFound。)

Run: `npm run test:server 2>&1 | tail -3` → 全 PASS

- [ ] **Step 7: 提交**

```bash
git add server/workbench-summarize.mjs server/workbench-summarize.test.mjs server/routes/workbench-conversations.mjs server/workbench-conversations.test.mjs server/messages/
git commit -m "feat(context): POST /:id/compact 手动压缩——全量重摘要+自定义指令,终态门禁+失败不动库(compact+余量 T4)"
```

---

### Task 5: 前端余量条 + 压缩 modal(WorkbenchChat)

**Files:**
- Modify: `src/api/client.js:244`(conversations 段加 compact 方法)
- Modify: `src/components/workbench/WorkbenchChat.vue`(pollOnce 存 context;输入区上方余量条;压缩 modal)
- Modify: `src/locales/zh.json` / `src/locales/en.json`(workbench.chat.context.* 键)
- Test: `src/components/workbench/__tests__/WorkbenchChat.test.js`(追加)

**Interfaces:**
- Consumes: Task 3/4 的 `context` 响应字段与 `POST /:id/compact`
- Produces: `workbenchApi.conversations.compact(id, instruction)`;UI 余量条(testid `context-meter`,含 `context-meter-bar`/`context-meter-label`)与压缩按钮(`context-compact-btn`)、modal(`context-compact-modal`)

- [ ] **Step 1: api client 加方法**

`src/api/client.js` conversations 段(rename 行旁)加:

```js
    compact: (id, instruction) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}/compact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: instruction || '' }) }),
```

测试 mock:`WorkbenchChat.test.js` 顶部 hoisted `api.conversations` 对象加 `compact: vi.fn()`。

- [ ] **Step 2: i18n 键(zh/en 同步)**

`workbench.chat` 段(两文件同位置)加:

```json
"context": {
  "title": "上下文余量(估算)",
  "detailHint": "token 为估算值(≈字符/2);上限按所配模型窗口,未知模型默认 200k",
  "recapUpTo": "前 {n} 条已折叠进摘要",
  "willTrim": "已超硬裁剪预算线,下轮起将丢弃最旧历史——建议压缩",
  "compact": "压缩",
  "compactTitle": "压缩上下文",
  "compactDesc": "把全部历史(含旧摘要)重新压缩为一份摘要,仅保留最近 2 条全文。屏幕上的消息不会被删除。",
  "compactInstruction": "压缩时侧重保留(可选)",
  "compactGo": "压缩",
  "compactDone": "上下文已压缩",
  "compactBusy": "对话运行中,结束后再压缩"
}
```

(en 镜像:Context usage (estimated) / Tokens are estimated (~chars/2); window follows the configured model, unknown models default to 200k / First {n} messages folded into summary / Over trim budget — oldest history will be dropped next round; compacting recommended / Compact / Compact context / Re-summarize all history (incl. old recap) into one summary, keeping only the last 2 messages in full. On-screen messages are not deleted. / Focus on preserving (optional) / Compact / Context compacted / Conversation running; compact after it finishes)

- [ ] **Step 3: 写失败测试**

追加到 `src/components/workbench/__tests__/WorkbenchChat.test.js`:

```js
// ── T5:上下文余量条 + 压缩(spec §4.5)──
const ctx = (est, win = 200_000) => ({ estTokens: est, windowTokens: win, budgetTokens: Math.floor(win * 0.7), recapUpTo: 0, willTrim: est > Math.floor(win * 0.7) })

test('余量条:常驻渲染;<70% 灰 / ≥70% 黄+压缩钮 / ≥90% 红', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockResolvedValue({ id: 'c-ctx', status: 'done', content: 'ok', trace: '[]', steps: 1, recap: '', messages: [{ role: 'assistant', content: 'ok', createdAt: 1 }], context: ctx(30_000) })
  const w = await mountChat({ conversationId: 'c-ctx', activeConversationId: 'c-ctx' })
  let meter = w.find('[data-testid="context-meter"]')
  expect(meter.exists()).toBe(true, '余量条常驻')
  expect(meter.text()).toContain('30k')
  expect(meter.text()).toContain('200k')
  expect(meter.find('[data-testid="context-compact-btn"]').exists()).toBe(false, '<70% 无压缩钮')
  // 75% → 黄 + 压缩钮
  api.conversations.get.mockResolvedValue({ id: 'c-ctx', status: 'done', content: 'ok', trace: '[]', steps: 1, recap: '', messages: [{ role: 'assistant', content: 'ok', createdAt: 1 }], context: ctx(150_000) })
  await w.vm.pollOnce('c-ctx'); await flushPromises()
  meter = w.find('[data-testid="context-meter"]')
  expect(meter.find('[data-testid="context-compact-btn"]').exists()).toBe(true, '≥70% 出压缩钮')
  expect(meter.classes().join(' ')).toMatch(/status-warning|yellow/).or.toContain('70')  // 实现定 class 后锁死
})
```

(实现者注:颜色断言在实现 Step 4 定下 class 名后,把 `or` 行改为精确 `expect(meter.classes()).toContain('text-status-warning')` 类断言——灰=`text-on-surface-variant`,黄=`text-status-warning`,红=`text-error`,复用项目既有语义色 token。另加两条测试:①running 态压缩钮 disabled+title 提示;②点击压缩钮→modal 出现→填指令→POST compact→成功 toast+pollOnce 刷新。测试骨架:

```js
test('压缩流程:按钮→modal(可选指令)→compact 成功→刷新', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockResolvedValue({ id: 'c-ctx', status: 'done', content: 'ok', trace: '[]', steps: 1, recap: '', messages: [{ role: 'assistant', content: 'ok', createdAt: 1 }], context: ctx(150_000) })
  api.conversations.compact.mockResolvedValueOnce({ ok: true, recap: '新摘要', context: ctx(20_000) })
  const w = await mountChat({ conversationId: 'c-ctx', activeConversationId: 'c-ctx' })
  await w.find('[data-testid="context-compact-btn"]').trigger('click')
  const modal = w.find('[data-testid="context-compact-modal"]')
  expect(modal.exists()).toBe(true)
  await modal.find('textarea').setValue('保留结论')
  await w.findAll('button').find(b => b.text().includes('workbench.chat.context.compactGo')).trigger('click')
  await flushPromises()
  expect(api.conversations.compact).toHaveBeenCalledWith('c-ctx', '保留结论')
  expect(w.find('[data-testid="context-meter"]').text()).toContain('20k', '压缩后余量刷新')
})
```

——该文件 i18n 为极简 messages,新键渲染为键名路径,按钮断言用 `b.text().includes('workbench.chat.context.compactGo')` 与本文件既有审批按钮断言同款。)

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.test.js`
Expected: 新测试 FAIL(context-meter 不存在)

- [ ] **Step 5: 实现 WorkbenchChat**

script 段(pollOnce 里 GET 成功后、`convStatus.value = conv.status` 附近)加:

```js
const ctxInfo = ref(null)   // 服务端下发的上下文余量(Task 3 口径)
// pollOnce 内:
    if (conv.context) ctxInfo.value = conv.context
```

压缩状态与动作:

```js
const showCompact = ref(false)
const compactInstruction = ref('')
const compacting = ref(false)
const ctxPct = computed(() => ctxInfo.value ? Math.min(100, Math.round(ctxInfo.value.estTokens / ctxInfo.value.windowTokens * 100)) : 0)
const ctxLevel = computed(() => ctxPct.value >= 90 ? 'red' : ctxPct.value >= 70 ? 'yellow' : 'gray')
const compactDisabled = computed(() => !['done', 'failed', 'cancelled'].includes(convStatus.value))
async function doCompact() {
  if (!conversationId.value || compacting.value) return
  compacting.value = true
  try {
    const r = await workbenchApi.conversations.compact(conversationId.value, compactInstruction.value.trim())
    if (unmounted) return
    if (r?.ok) {
      showCompact.value = false; compactInstruction.value = ''
      notify?.('success', t('workbench.chat.context.compactDone'))   // 本组件未引入 notify 时省略此行,以刷新反馈为准
      await pollOnce(conversationId.value)                            // recap/context 重算,顶部摘要卡+余量条更新
    }
  } finally { if (!unmounted) compacting.value = false }
}
```

(实现者注:WorkbenchChat 现未 import notify——省略 toast 行,以 pollOnce 刷新为反馈;失败错误由 platformHttp 抛出→外层不吞则控制台;若需 toast,引入 `notify` from '@/composables/useToast' 与 WorkbenchDetail 同款。)

template 段:输入区容器(`<div class="shrink-0 border-t border-outline-variant p-md ...">` 内、`<div class="mx-auto w-full max-w-3xl">` 顶部)插入:

```html
      <!-- 上下文余量条(常驻,spec §4.5):灰 <70% / 黄 ≥70%(=预算线,出压缩钮) / 红 ≥90%(超线裁剪中) -->
      <div v-if="ctxInfo" data-testid="context-meter" class="flex items-center gap-sm mb-sm group relative"
        :class="{ 'text-on-surface-variant': ctxLevel === 'gray', 'text-status-warning': ctxLevel === 'yellow', 'text-error': ctxLevel === 'red' }">
        <div class="flex-1 h-1 rounded-full bg-surface-container overflow-hidden">
          <div data-testid="context-meter-bar" class="h-full rounded-full transition-all"
            :class="ctxLevel === 'red' ? 'bg-error' : ctxLevel === 'yellow' ? 'bg-status-warning' : 'bg-on-surface-variant/40'"
            :style="{ width: ctxPct + '%' }"></div>
        </div>
        <span data-testid="context-meter-label" class="text-body-xs font-mono shrink-0">≈{{ Math.round(ctxInfo.estTokens / 1000) }}k / {{ Math.round(ctxInfo.windowTokens / 1000) }}k ({{ ctxPct }}%)</span>
        <button v-if="ctxPct >= 70" data-testid="context-compact-btn" @click="showCompact = true"
          :disabled="compactDisabled" :title="compactDisabled ? t('workbench.chat.context.compactBusy') : t('workbench.chat.context.compactTitle')"
          class="shrink-0 px-sm py-0.5 border border-outline-variant rounded-lg text-body-xs hover:bg-surface-container disabled:opacity-40 flex items-center gap-xs">
          <span class="material-symbols-outlined text-sm">compress</span>{{ t('workbench.chat.context.compact') }}
        </button>
        <!-- 详情(hover/点击展开;简化为 title + 常驻明细行) -->
        <span class="text-body-xs text-on-surface-variant/60 hidden md:inline" :title="t('workbench.chat.context.detailHint')">
          {{ t('workbench.chat.context.recapUpTo', { n: ctxInfo.recapUpTo }) }}<template v-if="ctxInfo.willTrim"> · {{ t('workbench.chat.context.willTrim') }}</template>
        </span>
      </div>
```

压缩 modal(模板尾部 Approval Modal 旁):

```html
    <!-- 上下文压缩 Modal(spec §4.4) -->
    <Modal :modelValue="showCompact" :title="t('workbench.chat.context.compactTitle')" @update:model-value="v => showCompact = v">
      <div data-testid="context-compact-modal" v-if="showCompact" class="flex flex-col gap-md">
        <p class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.context.compactDesc') }}</p>
        <textarea v-model="compactInstruction" rows="2" :placeholder="t('workbench.chat.context.compactInstruction')"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm resize-none outline-none focus:border-primary/40"></textarea>
      </div>
      <template #actions>
        <button @click="showCompact = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container">{{ t('common.cancel') }}</button>
        <button @click="doCompact" :disabled="compacting" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold disabled:opacity-40">{{ t('workbench.chat.context.compactGo') }}</button>
      </template>
    </Modal>
```

(`common.cancel` 键已存在——`grep -n '"cancel"' src/locales/zh.json` 确认;若无则用 `component.modal.cancel`。)

- [ ] **Step 6: 跑测试确认通过 + 组件全量回归**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.test.js src/components/workbench/__tests__/ChatModal.test.js`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/api/client.js src/components/workbench/WorkbenchChat.vue src/components/workbench/__tests__/WorkbenchChat.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(ui): 上下文余量条(三色阈值+详情)+ 手动压缩 modal——输入区常驻,≥70% 出压缩入口(compact+余量 T5)"
```

---

### Task 6: 全量回归 + i18n 门禁 + 文档收尾

**Files:**
- 无新改(验证任务)

- [ ] **Step 1: 全量验证**

```bash
npm test               # 服务端 + 1339+ 前端单测
npm run i18n:check     # zh/en 键对齐/引用完整
npm run typecheck
npm run build
```

Expected: 全绿(i18n:check 三项 0 缺失)。

- [ ] **Step 2: 手测清单(需 LLM+集群,记入提交信息)**

- 长对话(maybeSummarize 触发过)余量条显示 recapUpTo>0
- ≥70% 出压缩钮;running 时 disabled;压缩后 recap 卡更新、余量骤降
- ChatModal(悬浮)同款余量条可用
- mock-1 模型显示 200k 默认窗口

- [ ] **Step 3: 提交(若有补丁)与合并**

按仓库惯例:worktree 分支 → `git merge --ff-only` → `git push origin main`;用户裁决是否打 tag。

---

## Self-Review 记录

1. **Spec 覆盖**:§4.1→T1;§4.2→T2;§4.3→T3;§4.4→T4;§4.5→T5;§5 错误处理分散在 T4 门禁/T5 disabled;§6 测试对应各任务 Step。无遗漏。
2. **占位符**:T3/T4 测试中 `/* 现有 pattern */` 标注为「按本文件既有 harness 填」并给出参考文件——非 TBD,是复用既有测试基建的明确指引;代码块均完整。
3. **类型一致**:`contextInfo` 字段名(estTokens/windowTokens/budgetTokens/recapUpTo/willTrim)在 T3 定义、T4 响应/T5 前端消费处一致;`compactConversation(db, convId, llmClient, instruction)` 签名 T4 定义、端点调用一致;`budgetChars` 贯穿 T2 三层一致。
