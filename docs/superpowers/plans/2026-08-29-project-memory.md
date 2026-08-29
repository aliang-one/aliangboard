# 项目级跨对话记忆 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** workbench_history 攒着的原料变成项目滚动摘要,每轮注入 system,新对话自动继承项目决策;折叠卡+admin 开关可见可控。

**Architecture:** T1 领域(迁移列+水位查询+maybeSummarizeProject)→ T2 注入(refreshSystem×2 拼 projectRecap,ai-config projectMemory 开关)→ T3 路由(append fire+GET /:id 出参)→ T4 前端(项目背景卡+admin 开关+i18n)→ T5 回归。

**Tech Stack:** 零新依赖;node:test :memory:;vitest;zh/en i18n。

**Spec:** `docs/superpowers/specs/2026-08-29-project-memory-design.md`

## Global Constraints

- 提交作者恒 `aliangone <aliangone@gmail.com>`,禁止 Claude 尾注。
- 阈值 **≥8** 条未摘要触发;单条截 800 字;`touch:false`;成功才落库(`{ projectRecap, historyWatermark }`,watermark=本批最大 ts)。
- 注入格式逐字:`'\n\n[Project memory — 之前对话的决策摘要]\n' + pm`;开关 `projectMemory` 默认 true,每次 run 现读。
- 卡片:recap details 卡同款同位,`v-if="projectRecap"`;i18n zh/en 同步,`npm run i18n:check` 六项 0。

---

### Task 1: 迁移列 + `maybeSummarizeProject` 领域函数

**Files:**
- Modify: `server/workbench-projects.mjs`(schema 迁移 + `unsummarizedProjectHistory`)
- Modify: `server/workbench-summarize.mjs`(新导出)
- Test: `server/workbench-summarize.test.mjs`(追加)

**Interfaces:**
- Produces:
  - `unsummarizedProjectHistory(db, projectId) → [{ role, content, ts }]`(ts > historyWatermark,升序)
  - `maybeSummarizeProject(db, projectId, llmClient) → Promise<boolean>`(触发并成功=true)
  - `workbench_projects` 新列 `projectRecap TEXT` / `historyWatermark INTEGER DEFAULT 0`

- [ ] **Step 1: 写失败测试**(workbench-summarize.test.mjs 追加;沿用其 db/llm mock pattern——先看文件头既有 harness)

```js
// ── 项目记忆 T1(spec §3.1/3.2)──
test('maybeSummarizeProject:未满 8 条不动;满 8 条滚动合并旧摘要并推进水位;失败不动库', async () => {
  const { db, project, llm } = /* 本文件既有 pattern;project = createProject 返回或按 name 查 */
  // 不足阈值:7 条 history → false,projectRecap 仍 null
  for (let i = 0; i < 7; i++) appendHistory(db, project.id, 'user', `q${i}`)
  assert.equal(await maybeSummarizeProject(db, project.id, llm), false)
  // 满 8:预置旧摘要+水位 0,再 8 条新 → true;新摘要含旧摘要与新内容;watermark=本批最大 ts
  db.prepare('UPDATE workbench_projects SET projectRecap=?, historyWatermark=0 WHERE id=?').run('旧摘要:定了用 nginx', project.id)
  const tsList = []
  for (let i = 0; i < 8; i++) { appendHistory(db, project.id, 'assistant', `决定${i}`); tsList.push(/* 该行 ts——appendHistory 用 Date.now(),改用直接 INSERT 带显式 ts 更稳 */) }
  // (实现者注:为拿显式 ts,可直接 db.prepare('INSERT INTO workbench_history ...').run(projectId,'user',`决定${i}`, 1000+i) 构造)
  assert.equal(await maybeSummarizeProject(db, project.id, llm), true)
  const row = db.prepare('SELECT projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(project.id)
  assert.ok(row.projectRecap.includes('旧摘要') || row.projectRecap.includes('决定'), '滚动合并')
  assert.equal(row.historyWatermark, /* 本批最大 ts */)
  // 幂等边界:再调一次(0 条未摘要)→ false,库不变
  assert.equal(await maybeSummarizeProject(db, project.id, llm), false)
})

test('maybeSummarizeProject:LLM 抛错 → 不动库返回 false', async () => {
  // llm.chat 抛错的 mock;断言 projectRecap/historyWatermark 与调用前一致
})

test('unsummarizedProjectHistory:只取 ts > watermark,升序', () => {
  // INSERT 三行 ts=100/200/300,水位 200 → 只回 300;升序断言
})
```

(实现者注:`/* 本文件既有 pattern */` 按 harness 填;显式 ts 用裸 INSERT 最稳,appendHistory 的 Date.now() 不可控。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/workbench-summarize.test.mjs`
Expected: FAIL(函数未导出)

- [ ] **Step 3: 实现**

workbench-projects.mjs——迁移列(grep `ALTER TABLE workbench` 找既有幂等加列 pattern,同款加):

```js
// 项目记忆(2026-08-29 spec §3.1):滚动摘要 + history 水位
ensureColumn(db, 'workbench_projects', 'projectRecap', 'TEXT')        // 函数名以现场既有为准
ensureColumn(db, 'workbench_projects', 'historyWatermark', 'INTEGER DEFAULT 0')
```

```js
// 未并入项目摘要的 history(ts > 水位,升序)——条数判定与摘要输入共用
export function unsummarizedProjectHistory(db, projectId) {
  const wm = db.prepare('SELECT historyWatermark FROM workbench_projects WHERE id=?').get(projectId)?.historyWatermark ?? 0
  return db.prepare('SELECT role, content, ts FROM workbench_history WHERE projectId=? AND ts>? ORDER BY ts ASC').all(projectId, wm)
}
```

workbench-summarize.mjs 末尾(import 补 getProject/updateProject——按现场列表):

```js
// 项目级滚动摘要(2026-08-29 spec §3.2):新增未摘要 history ≥ 阈值时,旧摘要+新增历史滚动重摘要。
// 成功才落库(touch:false);失败/空产出静默 false(append 路由 fire,下轮重试)。
const PROJECT_SUMMARY_THRESHOLD = 8
export async function maybeSummarizeProject(db, projectId, llmClient) {
  const project = getProject(db, projectId)
  if (!project) return false
  const pending = unsummarizedProjectHistory(db, projectId)
  if (pending.length < PROJECT_SUMMARY_THRESHOLD) return false
  const transcript = [
    ...(project.projectRecap ? [`(此前项目摘要)\n${project.projectRecap}`] : []),
    ...pending.map(h => `${h.role}: ${String(h.content || '').slice(0, 800)}`),
  ].join('\n')
  try {
    const out = await llmClient.chat({
      messages: [
        { role: 'system', content: '你负责维护一份项目记忆摘要。把「此前项目摘要」与「新增对话」滚动合并为一份新摘要:保留已做出的决定、关键事实与数据、尚未解决的问题;丢弃过程性闲聊;中文,紧凑,不超过 500 字。输出只有摘要本身。' },
        { role: 'user', content: transcript },
      ],
    })
    const recap = out?.content?.trim()
    if (!recap) return false
    // 落库前防并发回退:只推进水位(取 pending 最大 ts 与现值较大者)
    const maxTs = pending[pending.length - 1].ts
    db.prepare('UPDATE workbench_projects SET projectRecap=?, historyWatermark=MAX(COALESCE(historyWatermark,0),?) WHERE id=?').run(recap, maxTs, projectId)
    return true
  } catch { return false }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/workbench-summarize.test.mjs server/workbench-projects.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/workbench-projects.mjs server/workbench-summarize.mjs server/workbench-summarize.test.mjs
git commit -m "feat(wb): maybeSummarizeProject 项目滚动摘要——history 水位/8 条阈值/成功才落库(项目记忆 T1)"
```

---

### Task 2: 注入(refreshSystem ×2 + projectMemory 开关)

**Files:**
- Modify: `server/workbench-ai-config.mjs`(projectMemory 默认 true:读写校验 + 出参)
- Modify: `server/workbench-agent.mjs`(run/resume 两处 refreshSystem)
- Test: `server/workbench-ai-config.test.mjs`(追加)+ `server/workbench-agent.test.mjs`(追加)

**Interfaces:**
- Consumes: T1 `getProject` 行的 `projectRecap`
- Produces: ai-config 字段 `projectMemory: boolean`(默认 true);refreshSystem 注入格式见 Global Constraints

- [ ] **Step 1: 写失败测试**

workbench-ai-config.test.mjs 追加(按其既有读写 roundtrip pattern):

```js
test('ai-config:projectMemory 默认 true;可写 false;出参带回', () => {
  const cfg = getWorkbenchAiConfig(db)
  assert.equal(cfg.projectMemory, true)
  setWorkbenchAiConfig(db, { projectMemory: false })   // 函数名以现场为准
  assert.equal(getWorkbenchAiConfig(db).projectMemory, false)
})
```

workbench-agent.test.mjs 追加:

```js
// ── 项目记忆 T2:refreshSystem 注入 ──
test('runConversation:projectRecap 拼入 refreshSystem 产物;projectMemory=false 不拼', async () => {
  const { db, conv, capturedRunOpts, makeRunner } = setup()
  db.prepare('UPDATE workbench_projects SET projectRecap=? WHERE id=?').run('定了用 nginx ingress', conv.projectId)
  const { createAgentRunner } = makeRunner(async () => ({ status: 'done', content: 'ok', steps: 1, messages: [], queue: [], denied: [] }))
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit: () => {}, busDispose: () => {} })
  await agent.runConversation(conv.id, { chat: async () => ({}), model: 'mock-1' })
  const sys = await capturedRunOpts().refreshSystem()
  assert.ok(sys.includes('[Project memory'), '注入标记')
  assert.ok(sys.includes('定了用 nginx ingress'))
  // 开关关(默认配置改 false)再跑一条新对话 → 不含标记
  db.prepare(/* 按 ai-config 存储写法,现场 grep setWorkbenchAiConfig/UPDATE */).run()
  const conv2 = createConversation(db, { projectId: conv.projectId, system: 'sys', userMessage: 'q2' })
  await agent.runConversation(conv2.id, { chat: async () => ({}), model: 'mock-1' })
  const sys2 = await capturedRunOpts().refreshSystem()
  assert.ok(!sys2.includes('[Project memory'), '关开关不注入')
})
```

(实现者注:ai-config 的存储写法先 grep——若为 KV 表或列,测试用导出的 setWorkbenchAiConfig 最稳;refreshSystem 是 run opts 的函数,直接 await 调用断言产物。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/workbench-ai-config.test.mjs server/workbench-agent.test.mjs`
Expected: 新测试 FAIL

- [ ] **Step 3: 实现**

workbench-ai-config.mjs:默认值对象加 `projectMemory: true`;读取出参带;写入白名单/校验加布尔(按现场 disabledTools/additionalInstructions 的同款处理)。

workbench-agent.mjs——run/resume 两处 `const refreshSystem = async () => conv.system + await fetchRefContext(refs, k8sSession)` 改为:

```js
      const pmEnabled = getWorkbenchAiConfig(db).projectMemory !== false
      const projectRecap = pmEnabled ? (getProject(db, conv.projectId)?.projectRecap || '') : ''
      const refreshSystem = async () => conv.system
        + (projectRecap ? `\n\n[Project memory — 之前对话的决策摘要]\n${projectRecap}` : '')
        + await fetchRefContext(refs, k8sSession)
```

(getWorkbenchAiConfig 已在文件 import——disabledTools 同族;getProject 已 import。)

- [ ] **Step 4: 跑测试确认通过 + 两文件回归**

Run: `node --test server/workbench-ai-config.test.mjs server/workbench-agent.test.mjs server/workbench-ai-config-routes.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/workbench-ai-config.mjs server/workbench-agent.mjs server/workbench-ai-config.test.mjs server/workbench-agent.test.mjs
git commit -m "feat(wb): refreshSystem 拼入项目摘要+projectMemory 开关即时生效(项目记忆 T2)"
```

---

### Task 3: 路由(append fire + GET /:id 出参)

**Files:**
- Modify: `server/routes/workbench-conversations.mjs`(append 路由 maybeSummarize 旁;GET /:id 响应)
- Test: `server/workbench-conversations.test.mjs`(追加,沿用 harness)

**Interfaces:**
- Consumes: T1 `maybeSummarizeProject`;T2 出参
- Produces: `GET /:id` 响应字段 `projectRecap: string|null`

- [ ] **Step 1: 写失败测试**

```js
// ── 项目记忆 T3 ──
test('GET /:id 带 projectRecap;append 路由 fire maybeSummarizeProject', async () => {
  // harness:建项目+对话;项目行置 projectRecap='记忆内容'
  // GET /:id → r.projectRecap === '记忆内容'
  // append:mock/触发方式——routes 侧 maybeSummarizeProject 是模块 import,测试断言 fire 可走「append 后对话终态、项目 watermark 推进」的行为面:
  // 预置 8 条 history + llm mock 固定摘要 → POST messages → 等 200 → 轮询 projects 行 projectRecap 非空(异步 fire,waitFor/短轮询)
})
```

(实现者注:fire 断言走行为面轮询 DB 行(≤2s),不断言调用次数——异步竞态下次数断言 flaky。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/workbench-conversations.test.mjs`
Expected: 新测试 FAIL(projectRecap undefined)

- [ ] **Step 3: 实现**

GET /:id 响应对象加:

```js
        projectRecap: db.prepare('SELECT projectRecap FROM workbench_projects WHERE id=?').get(conv.projectId)?.projectRecap ?? null,
```

(或复用已 getProject 的行——若 handler 内已有 project 变量则 `projectRecap: project?.projectRecap ?? null`。)

append 路由 `maybeSummarize(db, id, llmClient).catch(() => {})` 行旁加:

```js
        maybeSummarizeProject(db, conv.projectId, llmClient).catch(() => {})   // 项目记忆滚动摘要(spec §3.2,fire-and-forget)
```

import 并入 workbench-summarize 既有 import。

- [ ] **Step 4: 跑测试确认通过 + 路由回归**

Run: `node --test server/workbench-conversations.test.mjs server/workbench-conv-routes.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/routes/workbench-conversations.mjs server/workbench-conversations.test.mjs
git commit -m "feat(wb): append fire 项目摘要+GET /:id 出参 projectRecap(项目记忆 T3)"
```

---

### Task 4: 前端(项目背景卡 + admin 开关 + i18n)

**Files:**
- Modify: `src/components/workbench/WorkbenchChat.vue`(pollOnce 存 projectRecap;recap 卡旁并列卡片)
- Modify: `src/views/admin/AiBehaviorConfig.vue`(开关行)
- Modify: `src/locales/zh.json` / `en.json`
- Test: `src/components/workbench/__tests__/WorkbenchChat.test.js`(追加)+ `src/views/admin/__tests__/AiBehaviorConfig.test.js`(追加)

**Interfaces:**
- Consumes: T3 `projectRecap` 响应字段;ai-config 端点的 projectMemory
- Produces: 卡片 testid `project-recap-card`

- [ ] **Step 1: i18n 键(zh/en,workbench.chat 段 loadEarlier 旁)**

```json
"projectRecapTitle": "项目背景(之前对话的记忆)", "projectRecapSummary": "AI 每轮携带的项目决策摘要"
```

(en:"Project context (memory from earlier chats)" / "Project decision summary the AI carries each turn";admin 侧键 `admin.aiBehavior.projectMemory` = 「项目记忆注入」/"Inject project memory",描述「新对话自动携带项目历史决策摘要」/"New chats carry a summary of past project decisions",按现场 admin 键结构放。)

- [ ] **Step 2: 写失败测试**

WorkbenchChat.test.js(i18n messages 补两键):

```js
test('项目背景卡:有 projectRecap 渲染折叠卡;无则不渲染', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockResolvedValue({ id: 'c-pm', status: 'done', content: 'ok', trace: '[]', steps: 1, recap: '', projectRecap: '定了用 nginx', messages: [{ id: 'm1', role: 'user', content: 'q', createdAt: 1 }] })
  const w = await mountChat({ conversationId: 'c-pm', activeConversationId: 'c-pm' })
  expect(w.find('[data-testid="project-recap-card"]').exists()).toBe(true)
  expect(w.find('[data-testid="project-recap-card"]').text()).toContain('定了用 nginx')
  api.conversations.get.mockImplementation(async () => ({ id: 'c-pm', status: 'done', content: 'ok', trace: '[]', steps: 1, recap: '', projectRecap: null, messages: [{ id: 'm1', role: 'user', content: 'q', createdAt: 1 }] }))
  await w.vm.pollOnce('c-pm'); await flushPromises()
  expect(w.find('[data-testid="project-recap-card"]').exists()).toBe(false)
})
```

AiBehaviorConfig.test.js(按其既有表单 roundtrip pattern):

```js
test('projectMemory 开关:默认开;切换保存后回读', async () => {
  // 按文件既有 mock/表单 pattern:找到开关(checkbox/testid)→ 断言初始 checked → 取消勾选+保存 → GET 回 false
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.test.js src/views/admin/__tests__/AiBehaviorConfig.test.js`
Expected: 新测试 FAIL

- [ ] **Step 4: 实现**

WorkbenchChat.vue:script `const projectRecap = ref(null)`;pollOnce 内 `if (conv.projectRecap !== undefined) projectRecap.value = conv.projectRecap`;watch(conversationId) 清理段置 null。模板 recap details 卡后并列(同款结构):

```html
        <!-- 项目背景(2026-08-29 项目记忆):AI 每轮携带的项目决策摘要,透明可查 -->
        <details v-if="projectRecap" data-testid="project-recap-card" class="mt-xs bg-surface-container-low border border-outline-variant rounded-lg">
          <summary class="cursor-pointer select-none px-md py-sm text-body-sm font-medium text-on-surface-variant flex items-center gap-xs">
            <span class="material-symbols-outlined text-base text-primary/60">folder_special</span>
            {{ t('workbench.chat.projectRecapTitle') }}
          </summary>
          <div class="px-md pb-md text-body-sm text-on-surface-variant leading-relaxed whitespace-pre-wrap">{{ projectRecap }}</div>
        </details>
```

AiBehaviorConfig.vue:按既有开关行(若全表单则同 additionalInstructions 的输入控件风格)加 projectMemory 布尔控件,读写走既有 save/load。

- [ ] **Step 5: 跑测试确认通过 + i18n 门禁**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.test.js src/views/admin/__tests__/AiBehaviorConfig.test.js && npm run i18n:check`
Expected: PASS;六项 0

- [ ] **Step 6: 提交**

```bash
git add src/components/workbench/WorkbenchChat.vue src/views/admin/AiBehaviorConfig.vue src/components/workbench/__tests__/WorkbenchChat.test.js src/views/admin/__tests__/AiBehaviorConfig.test.js src/locales/
git commit -m "feat(ui): 项目背景折叠卡+admin 项目记忆开关(项目记忆 T4)"
```

---

### Task 5: 全量回归 + 收尾

- [ ] **Step 1:** `npm test` / `npm run typecheck` / `npm run build` / `npm run i18n:check` 全绿。
- [ ] **Step 2:** 手测清单记入合并提交信息(多对话后新对话「记得」旧决策/卡片可见/开关关后新对话失忆/8 条阈值触发滚动)。
- [ ] **Step 3:** 合并:rebase main(如有并行)→ 全量验证 → ff 合并 → push(用户裁决 tag)。

---

## Self-Review 记录

1. **Spec 覆盖**:§3.1→T1;§3.2→T1(生成)+T3(fire);§3.3→T2;§3.4→T3(出参)+T4(卡片/开关);§4 错误处理散在 T1 失败静默/T2 开关;§5 测试对应。无遗漏。
2. **占位符**:测试中 `/* 既有 pattern */` 均为明确指引(与既往计划同款,已证可行);ai-config 存储写法指示 grep 现场。无 TBD。
3. **类型一致**:`maybeSummarizeProject(db, projectId, llmClient)→Promise<boolean>`、`projectRecap`/`historyWatermark`/`projectMemory` 在四任务间一致;注入格式串逐字同 Global Constraints。
