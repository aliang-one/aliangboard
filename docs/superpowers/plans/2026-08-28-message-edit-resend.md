# 编辑已发消息重发 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** user 消息 hover「编辑」→ 载入输入框(编辑态提示条)→ 发送即截断该消息及之后全部、以新内容重跑。

**Architecture:** 领域函数 `truncateFromMessage`(workbench-projects.mjs,锚 messageId 删 `seq >=` 其后全部)→ `POST /:id/edit` 路由(截断+新消息+复位+水位钳制+run)→ 前端 ChatTurn showEdit/emit + WorkbenchChat 编辑态(草稿暂存/提示条/取消)与 send() 编辑分支。

**Tech Stack:** 零新依赖;node:test + :memory: SQLite;vitest;zh/en i18n。

**Spec:** `docs/superpowers/specs/2026-08-28-message-edit-resend-design.md`

## Global Constraints

- 提交作者恒 `aliangone <aliangone@gmail.com>`,禁止 Claude 尾注。
- body:`{ messageId, content, references? }`;references 缺省沿用原消息 refs,传入则替换;新 refs 并入对话级 references(append 的 mergeRefs 同款)。
- 门禁:404 不存在/403 非归属;`running/paused` → 400;messageId 非本对话或非 `role='user'` → 400;content 空 → 400。
- 复位字段与 append 路由逐字同款:`status='running', content='', reasoning='', trace='[]', steps=0, pendingApproval=null`。
- `summarizedUpTo` 钳制 `min(现值, keptMinSeq-1)`,截到空置 0。
- i18n zh/en 同步;`npm run i18n:check` 须过。

---

### Task 1: `truncateFromMessage` 领域函数

**Files:**
- Modify: `server/workbench-projects.mjs`(truncateAfterLastUser 之后 ~line 249)
- Test: `server/workbench-projects.test.mjs`(追加)

**Interfaces:**
- Produces: `truncateFromMessage(db, conversationId, messageId) → { removed, fromSeq, keptMinSeq } | null`(消息不存在/非 user → null;keptMinSeq=剩余最小 seq,截到空为 null)

- [ ] **Step 1: 写失败测试**(追加到 workbench-projects.test.mjs,沿用其既有 db/appendMessage 构造)

```js
// ── 编辑重发 T1:按消息锚截断(spec §3.2)──
test('truncateFromMessage:中间锚点删其后全部(含后续 user/assistant),前缀保留', () => {
  const { db, conv } = /* 本文件既有 setup:建项目+对话 */;
  const m1 = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1' })
  const m3 = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q2' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a2' })
  const r = truncateFromMessage(db, conv.id, m3.id)
  assert.equal(r.removed, 2, 'q2+a2 被删')
  assert.equal(r.fromSeq, m3.seq)
  const msgs = db.prepare('SELECT content FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id)
  assert.deepEqual(msgs.map(m => m.content), ['q1', 'a1'], '前缀保留')
  assert.equal(r.keptMinSeq, m1.seq)
})

test('truncateFromMessage:首条锚全删 → keptMinSeq null;不存在/非 user → null', () => {
  const { db, conv } = /* setup */
  const m1 = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1' })
  const r = truncateFromMessage(db, conv.id, m1.id)
  assert.equal(r.removed, 2); assert.equal(r.keptMinSeq, null)
  assert.equal(truncateFromMessage(db, conv.id, 'no-such-id'), null)
  const a = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'x' })
  assert.equal(truncateFromMessage(db, conv.id, a.id), null, 'assistant 锚拒绝')
})
```

(实现者注:`/* setup */` 按本测试文件既有 pattern;appendMessage 返回值含 id 与 seq——若不含 seq,以 `db.prepare('SELECT seq FROM workbench_messages WHERE id=?').get(m.id).seq` 取。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/workbench-projects.test.mjs`
Expected: FAIL(truncateFromMessage 未导出)

- [ ] **Step 3: 实现**(truncateAfterLastUser 函数之后)

```js
// 编辑重发(2026-08-28 spec §3.2):按消息锚截断——删该消息及其后全部(seq >= 锚.seq),
// 供 edit 路由换新内容重跑。keptMinSeq=剩余前缀最小 seq(截到空为 null),供摘要水位钳制。
// 锚不存在或非 user 消息返回 null(调用方 400)。
export function truncateFromMessage(db, conversationId, messageId) {
  const row = db.prepare('SELECT seq, role FROM workbench_messages WHERE id=? AND conversationId=?').get(messageId, conversationId)
  if (!row || row.role !== 'user') return null
  const removed = db.prepare('DELETE FROM workbench_messages WHERE conversationId=? AND seq>=?').run(conversationId, row.seq).changes
  const kept = db.prepare('SELECT MIN(seq) AS m FROM workbench_messages WHERE conversationId=?').get(conversationId)
  return { removed, fromSeq: row.seq, keptMinSeq: kept?.m ?? null }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/workbench-projects.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/workbench-projects.mjs server/workbench-projects.test.mjs
git commit -m "feat(wb): truncateFromMessage 领域函数——按消息锚截断供编辑重发(编辑重发 T1)"
```

---

### Task 2: `POST /:id/edit` 路由

**Files:**
- Modify: `server/routes/workbench-conversations.mjs`(regenerate 端点之后同区)
- Test: `server/workbench-conversations.test.mjs`(追加;复用本文件 T3/T4 既有 harness——先看 makeHttpHarness/makeCompactHarness 的桩 deps 构造,新建 `makeEditHarness` 或直接复用能 createConversation+置终态的既有装置)

**Interfaces:**
- Consumes: T1 `truncateFromMessage`;既有 `appendMessage`/`updateConversation`/`setActiveConversation`/`mergeRefs 逻辑(append 路由内联,可照抄)`/`contextInfo`/`msg` 消息表
- Produces: HTTP `POST /api/workbench/conversations/:id/edit` body `{ messageId, content, references? }` → `200 { status:'running', context }`;错误 `{ message }` + 400/403/404

- [ ] **Step 1: 写失败测试**(workbench-conversations.test.mjs 追加)

```js
// ── 编辑重发 T2:POST /:id/edit 契约(spec §3.1)──
test('POST edit:截断+新消息+running+refs 沿用+水位钳制', async () => {
  // 沿用本文件既有 harness 构造:项目+对话(置 done)+3 条消息(user/assistant/user)
  // 记录:锚=第 3 条 user 的 id;原 refs=[{kind:'pods',namespace:'ns',name:'p1'}]
  // POST edit { messageId: 锚, content: '改过的问题' }
  // 断言:200 + status running + context.windowTokens;
  //       GET messages:前 2 条保留、末条 content='改过的问题'、refs 沿用原值;
  //       conv.summarizedUpTo <= 前缀最小 seq - 1;conversation 级 references 含原 ref
})
test('POST edit:running → 400;锚非 user/不存在 → 400;跨对话锚 → 400', async () => { /* 三态各一断言 */ })
test('POST edit:非归属用户 → 403', async () => { /* 第二个普通用户 token POST → 403 */ })
```

(实现者注:骨架断言按上述注释展开为真断言——与本文件 compact 测试同款写法;harness 需能自定义消息内容/refs,L 侧 stub 与 makeCompactHarness 同构即可。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/workbench-conversations.test.mjs`
Expected: 新测试 FAIL(404 无此路由)

- [ ] **Step 3: 实现路由**(regenerate 端点块之后,GET /:id 之前)

```js
    // POST /api/workbench/conversations/:id/edit — 编辑已发消息重发(spec 2026-08-28 §3.1):
    // 截断锚消息及其后全部 → 以新内容 append(refs 缺省沿用)→ 复位运行态 → 重跑。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/edit$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4]
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      if (conv.status === 'running' || conv.status === 'paused') { sendJson(res, 400, { message: msg(req, 'wbc.busyNoResume') }); return true }
      const project = getProject(db, conv.projectId)
      if (!project) { sendJson(res, 404, { message: msg(req, 'wbc.projectNotFound') }); return true }
      if (project.ownerId !== ps.userId && ps.role !== 'admin') { sendJson(res, 403, { message: msg(req, 'wbc.noAccess') }); return true }
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
      try {
        const input = await readBody(req)
        const content = String(input.messageId ? input.content || '' : '')
        if (!content.trim()) { sendJson(res, 400, { message: msg(req, 'wbc.editContentRequired') }); return true }
        const anchor = db.prepare('SELECT id, seq, refs FROM workbench_messages WHERE id=? AND conversationId=? AND role=?').get(String(input.messageId || ''), id, 'user')
        if (!anchor) { sendJson(res, 400, { message: msg(req, 'wbc.editAnchorInvalid') }); return true }
        const t = truncateFromMessage(db, id, anchor.id)
        if (!t) { sendJson(res, 400, { message: msg(req, 'wbc.editAnchorInvalid') }); return true }
        // refs:body.references 替换;缺省沿用锚消息 refs(原始对象形状,appendMessage 直存)
        let refsValue = Array.isArray(input.references) ? input.references : null
        if (!refsValue && anchor.refs) { try { const p = JSON.parse(anchor.refs); if (Array.isArray(p)) refsValue = p } catch { refsValue = null } }
        setActiveConversation(db, conv.projectId, id)
        // 新 refs 并入对话级 references(与 append 的 mergeRefs 同款)
        let mergedRefs = []
        try { mergedRefs = JSON.parse(conv.references || '[]') } catch { mergedRefs = [] }
        const key = r => `${r.kind}/${r.namespace || ''}/${r.name}`
        const seen = new Set(mergedRefs.map(key))
        for (const r of (refsValue || [])) { const k = key(r); if (!seen.has(k)) { seen.add(k); mergedRefs.push({ kind: r.kind, namespace: r.namespace, name: r.name }) } }
        appendMessage(db, { conversationId: id, role: 'user', content, refs: refsValue ? refsValue.map(r => ({ kind: r.kind, namespace: r.namespace, name: r.name })) : null })
        updateConversation(db, id, {
          status: 'running', references: mergedRefs, content: '', reasoning: '', trace: '[]', steps: 0, pendingApproval: null,
          summarizedUpTo: Math.min(conv.summarizedUpTo ?? 0, t.keptMinSeq == null ? 0 : t.keptMinSeq - 1),
        })
        const llmClient = createLlmClient(cfg)
        wbAgent.runConversation(id, llmClient, { userId: ps.userId, username: ps.username }) // detached
        sendJson(res, 200, { status: 'running', context: contextInfo(getConversation(db, id)) })
        return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.editFailed') }); return true }
    }
```

import 增加 `truncateFromMessage`(并入既有 workbench-projects import 列表)。

消息表键(zh/en 各补,`grep -rn "wbc.llmNotConfigured" server/messages/` 定位):`wbc.editContentRequired`("消息内容不能为空"/"Message content required")、`wbc.editAnchorInvalid`("编辑目标无效:须为本对话的 user 消息"/"Invalid edit target: must be a user message in this conversation")、`wbc.editFailed`("编辑重发失败"/"Edit-resend failed")。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test server/workbench-conversations.test.mjs server/workbench-conv-routes.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/routes/workbench-conversations.mjs server/workbench-conversations.test.mjs server/messages/
git commit -m "feat(wb): POST /:id/edit 编辑重发端点——截断+refs 沿用/替换+水位钳制(编辑重发 T2)"
```

---

### Task 3: 前端(ChatTurn 入口 + WorkbenchChat 编辑态 + api + i18n)

**Files:**
- Modify: `src/api/client.js`(conversations 段 compact 行旁)
- Modify: `src/components/workbench/ChatTurn.vue`(props/emits/角色行按钮)
- Modify: `src/components/workbench/WorkbenchChat.vue`(编辑态/发送分支)
- Modify: `src/locales/zh.json` / `en.json`(workbench.chat 段)
- Test: `src/components/workbench/__tests__/WorkbenchChat.test.js` + `ChatTurn.test.js`(追加)

**Interfaces:**
- Consumes: T2 的 edit 端点;`workbenchApi.conversations.edit(id, { messageId, content, references })`
- Produces: `ChatTurn` prop `showEdit: Boolean` + emit `'edit'`;WorkbenchChat 内 `editing` 态(testid `edit-banner`)

- [ ] **Step 1: api client + i18n**

client.js(compact 行后):

```js
    edit: (id, body) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
```

zh/en `workbench.chat` 段(compact 键旁)各加:

```json
"editTitle": "编辑并重发", "editBanner": "正在编辑此消息,发送后将删除其后 {n} 条对话", "editCancel": "取消编辑"
```

(en:"Edit & resend" / "Editing this message — sending will remove {n} messages after it" / "Cancel edit")

- [ ] **Step 2: 写失败测试**

ChatTurn.test.js 追加:

```js
test('user turn:showEdit 时 hover 出编辑按钮,emit edit;默认不显示', async () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'user', content: 'q' }, showEdit: true }, global: { plugins: [i18n] } })
  const btn = w.find('[data-testid="edit-msg-btn"]')
  expect(btn.exists()).toBe(true)
  await btn.trigger('click')
  expect(w.emitted('edit')).toHaveLength(1)
  const w2 = mount(ChatTurn, { props: { turn: { role: 'user', content: 'q' } }, global: { plugins: [i18n] } })
  expect(w2.find('[data-testid="edit-msg-btn"]').exists()).toBe(false)
})
```

WorkbenchChat.test.js 追加(hoisted api 加 `edit: vi.fn()`,beforeEach mockClear 同列):

```js
// ── 编辑重发 T3:编辑态/取消/发送(spec §3.3)──
test('编辑流:点编辑→回填+banner(N 计数)→取消还原草稿', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockResolvedValue({ id: 'c-e', status: 'done', content: 'ok', trace: '[]', steps: 1, recap: '', messages: [
    { id: 'm1', role: 'user', content: '原始问题', createdAt: 1 },
    { id: 'm2', role: 'assistant', content: '答', createdAt: 2 },
  ], context: { estTokens: 1000, windowTokens: 200000, budgetTokens: 140000, recapUpTo: 0, willTrim: false } })
  const w = await mountChat({ conversationId: 'c-e', activeConversationId: 'c-e' })
  await w.find('textarea').setValue('未发送的草稿')
  await w.find('[data-testid="edit-msg-btn"]').trigger('click')
  expect(w.find('[data-testid="edit-banner"]').exists()).toBe(true)
  expect(w.find('[data-testid="edit-banner"]').text()).toContain('1')  // 其后 1 条(assistant)
  expect(w.find('textarea').element.value).toBe('原始问题')
  await w.findAll('button').find(b => b.text().includes('workbench.chat.editCancel')).trigger('click')
  expect(w.find('[data-testid="edit-banner"]').exists()).toBe(false)
  expect(w.find('textarea').element.value).toBe('未发送的草稿', '取消还原暂存草稿')
})

test('编辑发送:调 edit 端点+本地截断+新 user turn+thinking', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockResolvedValue({ /* 同上 messages 两条 */ })
  api.conversations.edit.mockResolvedValueOnce({ status: 'running', context: { estTokens: 800, windowTokens: 200000, budgetTokens: 140000, recapUpTo: 0, willTrim: false } })
  const w = await mountChat({ conversationId: 'c-e', activeConversationId: 'c-e' })
  await w.find('[data-testid="edit-msg-btn"]').trigger('click')
  await w.find('textarea').setValue('改过的问题')
  await w.find('button.bg-primary').trigger('click')
  await flushPromises()
  expect(api.conversations.edit).toHaveBeenCalledWith('c-e', expect.objectContaining({ messageId: 'm1', content: '改过的问题' }))
  expect(w.text()).toContain('改过的问题')
  expect(w.text()).not.toContain('答', '锚之后的本地 turns 已截断')
  expect(w.vm.turns.at(-1).status).toBe('thinking')
  expect(w.find('[data-testid="edit-banner"]').exists()).toBe(false, '发送后编辑态退出')
})
```

(实现者注:本文件 i18n 极简——banner 文案渲染为键名路径,断言 N 计数用 banner text 含数字;`data-testid="edit-msg-btn"` 在 WorkbenchChat 传入 showEdit 后经 ChatTurn 渲染,turns 重建后 user turn 的 _id 对应。)

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/components/workbench/__tests__/ChatTurn.test.js src/components/workbench/__tests__/WorkbenchChat.test.js`
Expected: 新测试 FAIL

- [ ] **Step 4: 实现**

ChatTurn.vue:props 加 `showEdit: { type: Boolean, default: false }`,emits 加 `'edit'`;角色行 user 分支(assistant 操作 span 之后加并列):

```html
      <span v-if="turn.role === 'user' && showEdit" class="ml-auto flex items-center gap-xs">
        <button data-testid="edit-msg-btn" @click.stop="emit('edit')" type="button"
          class="p-0.5 rounded text-on-surface-variant/50 hover:text-primary opacity-0 group-hover/turn:opacity-100 transition-opacity"
          :title="t('workbench.chat.editTitle')">
          <span class="material-symbols-outlined text-sm">edit</span>
        </button>
      </span>
```

WorkbenchChat.vue script(reactenerate 函数旁):

```js
// ── 编辑重发(2026-08-28 spec §3.3):编辑态=锚+暂存草稿;发送走 edit 端点就地截断重跑 ──
const editing = ref(null) // { messageId }
function startEdit(turn) {
  if (sending.value) return
  editing.value = { messageId: turn._messageId || turn._id, draft: input.value, draftRefs: [...refs.value] }
  input.value = turn.content
  refs.value = (turn.refs || []).map(r => ({ kind: r.kind, namespace: r.namespace, name: r.name }))
  nextTick(() => { if (taEl.value) taEl.value.style.height = 'auto' })
}
function cancelEdit() {
  if (!editing.value) return
  input.value = editing.value.draft
  refs.value = editing.value.draftRefs
  editing.value = null
}
const editAfterCount = computed(() => {
  if (!editing.value) return 0
  const i = turns.value.findIndex(t => t._id === undefined ? false : t === currentEditTurn.value)
  return i < 0 ? 0 : turns.value.length - 1 - i
})
const currentEditTurn = computed(() => turns.value.find(t => t.role === 'user' && (t._messageId || t._id) === editing.value?.messageId))
```

(实现者注:`_messageId`——pollOnce 重建与 send push 时给 user turn 挂上消息 id:重建处在 `turns.value.push({ _id: ++turnSeq, role: 'user', content: m.content, refs: parseRefs(m.refs) })` 加 `messageId: m.id`;send 的两条 push 中 user 那条挂 `messageId: null`(新建场景无 id,编辑首条发生在重载后,届时已有 id)。ChatTurn 的 edit emit 载荷即 turn 本身,`startEdit(turn)` 由模板 `@edit="startEdit(turn)` 接。`editAfterCount` 直接用 `turns.value.findIndex(t => t.messageId === editing.value?.messageId)` 简化,去掉 currentEditTurn 中转亦可——实现者取简。)

send() 开头(`errorBanner.value = ''` 之后、空值守卫之前)插编辑分支:

```js
  if (editing.value && props.activeConversationId) {
    const ed = editing.value
    if (!msg || sending.value) return
    const refsSnapshot = refs.value.length ? [...refs.value] : null
    const userIdx = turns.value.findIndex(t => t.messageId === ed.messageId)
    if (userIdx < 0) { editing.value = null; return }
    try {
      const payload = { messageId: ed.messageId, content: msg }
      if (refsSnapshot) payload.references = refsSnapshot.map(r => ({ kind: r.kind, namespace: r.namespace, name: r.name }))
      const resp = await workbenchApi.conversations.edit(props.activeConversationId, payload)
      if (unmounted) return
      turns.value.splice(userIdx)                       // 锚及之后全删
      turns.value.push({ _id: ++turnSeq, role: 'user', content: msg, messageId: ed.messageId, refs: refsSnapshot ? [...refsSnapshot] : undefined })
      turns.value.push({ _id: ++turnSeq, role: 'assistant', status: 'thinking', content: '', reasoning: '', trace: [], steps: 0, denied: [], truncated: false, error: '', _startedAt: Date.now() })
      editing.value = null
      resetInput()
      conversationId.value = props.activeConversationId
      convStatus.value = 'running'
      if (resp?.context) ctxInfo.value = resp.context
      sending.value = true
      await scrollToBottom()
      startStreaming(props.activeConversationId)
    } catch (e) {
      errorBanner.value = e?.message || t('workbench.chat.agentFailed')   // 编辑态保留可重试(spec §4)
      if (!unmounted) sending.value = false
    }
    return
  }
```

(实现者注:`ctxInfo` 为 compact 特性引入的余量 ref 名;若现场名不同以 grep 为准。`watch(() => props.conversationId)` 的清理段加 `editing.value = null`。模板:ChatTurn 循环处 `:show-edit="turn.role === 'user' && !sending && !editing"` `@edit="startEdit"`;输入区(@-ref chips 容器上方、余量条同级)加 banner:

```html
      <!-- 编辑态提示条(spec §3.3):发送即删锚后 N 条;取消还原暂存草稿 -->
      <div v-if="editing" data-testid="edit-banner" class="flex items-center gap-sm mb-sm px-md py-xs bg-status-warning/10 border border-status-warning/30 rounded-lg">
        <span class="material-symbols-outlined text-base text-status-warning">edit</span>
        <span class="text-body-xs text-status-warning flex-1">{{ t('workbench.chat.editBanner', { n: editAfterCount }) }}</span>
        <button @click="cancelEdit" class="text-body-xs text-on-surface-variant hover:text-on-surface underline">{{ t('workbench.chat.editCancel') }}</button>
      </div>
```

)

- [ ] **Step 5: 跑测试确认通过 + 组件回归**

Run: `npx vitest run src/components/workbench/__tests__/ChatTurn.test.js src/components/workbench/__tests__/WorkbenchChat.test.js src/components/workbench/__tests__/ChatModal.test.js && npm run i18n:check`
Expected: PASS / 六项 0

- [ ] **Step 6: 提交**

```bash
git add src/api/client.js src/components/workbench/ChatTurn.vue src/components/workbench/WorkbenchChat.vue src/components/workbench/__tests__/ src/locales/
git commit -m "feat(ui): 消息编辑重发——user 消息 hover 编辑/输入框回填/提示条/取消还原/就地截断重跑(编辑重发 T3)"
```

---

### Task 4: 全量回归 + 收尾

- [ ] **Step 1:** `npm test` / `npm run typecheck` / `npm run build` / `npm run i18n:check` 全绿。
- [ ] **Step 2:** 手测清单记入合并提交信息(编辑中间消息旧轮消失重跑/编辑首条/取消草稿还原/编辑态切对话清空)。
- [ ] **Step 3:** 合并:rebase main(如有并行提交)→ 全量验证 → `git merge --ff-only` → push(用户裁决 tag)。

---

## Self-Review 记录

1. **Spec 覆盖**:§3.1→T2;§3.2→T1;§3.3→T3(入口/编辑态/发送/i18n/api);§3.4 数据流在 T3 发送分支(context 刷新+pollOnce 兜底为既有机制);§4 错误处理散在 T2 门禁/T3 catch;§5 测试对应各任务。无遗漏。
2. **占位符**:T1 测试 `/* setup */`、T2 测试骨架注释——均为「按本文件既有 pattern 展开」的明确指令(与 compact 计划同款,已验证可行);代码块完整。
3. **类型一致**:`truncateFromMessage(db, conversationId, messageId) → { removed, fromSeq, keptMinSeq }` T1/T2 一致;`edit(id, { messageId, content, references? })` client/路由/前端三处一致;`turn.messageId`(T3 引入)在重建/send/编辑分支三处一致。
