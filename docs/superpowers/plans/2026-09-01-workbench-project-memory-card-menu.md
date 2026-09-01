# 项目卡片 ⋮ 菜单「项目记忆」直编 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在项目卡片 ⋮ 菜单加重命名/删除之外的第三项「项目记忆」,弹窗直接编辑/清空 projectRecap,语义与聊天页背景卡同构。

**Architecture:** 纯前端单点改动。列表接口 `SELECT *` 已携带 `projectRecap` 全文 → 弹窗预填零请求;提交走既有 `workbenchApi.updateProject(id, { recap })`;成功后本地就地更新 `projects` 数组(数据单源,不 reload);清空带 `confirm` 二次确认。

**Tech Stack:** Vue 3 `<script setup>` + vitest + happy-dom;vue-i18n(zh.json/en.json)。

**Spec:** `docs/superpowers/specs/2026-09-01-workbench-project-memory-card-menu-design.md`

## Global Constraints

- 零服务端改动、零新端点;提交语义与聊天页同构(保存空文本+原记忆非空 → confirm;清空钮恒 confirm)。
- i18n 双语键 zh/en 成对、值逐字取自 spec §4(7 键);按钮文案复用既有键 `workbench.chat.recapClear/recapSave` 与 `common.cancel/confirm`,**不新增重复文案键**。
- 提交作者恒 `aliangone <aliangone@gmail.com>`,禁 `Co-Authored-By` 尾注。
- worktree 分支实施,`--no-ff` 合回 main。
- 失败必须弹窗与输入保留、服务端消息透传;`memoryBusy` 保存/清空共用防双发。
- 门禁四件:`npm run test:unit` + `npm run i18n:check` + `npm run typecheck` + `npm run build`。

---

### Task 1: 菜单「项目记忆」项 + 记忆弹窗 + i18n + 测试 8 条

**Files:**
- Modify: `src/views/WorkbenchProjects.vue`(cardActions 追加项;script 追加记忆弹窗逻辑;template 追加记忆 Modal)
- Modify: `src/views/__tests__/WorkbenchProjects.lifecycle.test.js`(追加 8 条)
- Modify: `src/locales/zh.json`、`src/locales/en.json`(workbench.card 新增 7 键)

**Interfaces:**
- Consumes: `cardActions(p)`(卡片菜单工厂,现返回重命名/删除两项)、`workbenchApi.updateProject(id, { recap })` → `{ ok }`(client.js,与聊天页同签名)、测试文件既有 `mountView()/openCardMenu(w)/modalStub` 与可变 `state.projects` 种子、既有 i18n 键 `workbench.chat.recapClear`(清空)/`workbench.chat.recapSave`(保存)/`common.cancel`/`common.confirm`。
- Produces: `startMemory(p)/saveMemory()/clearMemory()/commitRecap(next, { requireConfirm })`;测试挂钩 `data-testid="memory-textarea"|"memory-save-btn"|"memory-clear-btn"`。

- [ ] **Step 1: 写失败测试(8 条,追加到 `WorkbenchProjects.lifecycle.test.js` 末尾)**

```js
// ═══ 项目记忆直编(spec 2026-09-01b):⋮ 菜单第三项,弹窗编辑 projectRecap ═══
// confirm 手法与 WorkbenchChat.recap.test.js 同源:vi.stubGlobal;确认语义=保存空文本
// (原记忆非空)或清空钮必须二次确认。

const memorySeed = () => [{ id: 'p1', name: 'alpha', clusterId: 'c1', namespace: 'default',
  manifestCount: 0, lastReconcile: null, projectRecap: '旧记忆' }]

async function openMemoryModal(w) {
  await openCardMenu(w).trigger('click')
  await w.findAll('button').find(b => b.text().includes('项目记忆')).trigger('click')
}

test('菜单含「项目记忆」:点击开弹窗且 textarea 预填列表携带的 recap', async () => {
  state.projects = memorySeed()
  const w = mountView()
  await flushPromises()
  await openMemoryModal(w)
  const ta = w.find('[data-testid="memory-textarea"]')
  expect(ta.exists()).toBe(true)
  expect(ta.element.value).toBe('旧记忆')
})

test('无记忆项目:弹窗 textarea 为空', async () => {
  const w = mountView()
  await flushPromises()
  await openMemoryModal(w)
  expect(w.find('[data-testid="memory-textarea"]').element.value).toBe('')
})

test('保存非空:updateProject(id,{recap}) + 本地就地更新 + success + 关窗(无 confirm)', async () => {
  vi.stubGlobal('confirm', vi.fn(() => { throw new Error('非空保存不应弹 confirm') }))
  state.projects = memorySeed()
  const w = mountView()
  await flushPromises()
  await openMemoryModal(w)
  await w.find('[data-testid="memory-textarea"]').setValue('新记忆')
  await w.find('[data-testid="memory-save-btn"]').trigger('click')
  await flushPromises()
  expect(updateProjectMock).toHaveBeenCalledWith('p1', { recap: '新记忆' })
  expect(state.projects[0].projectRecap).toBe('新记忆')
  expect(notifyMock).toHaveBeenCalledWith('success', expect.stringContaining('更新'))
  expect(w.find('[data-testid="memory-textarea"]').exists()).toBe(false, '关窗')
  vi.unstubAllGlobals()
})

test('清空钮 confirm 同意:updateProject(id,{recap:\'\'}) + 本地置 null + 关窗', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true))
  state.projects = memorySeed()
  const w = mountView()
  await flushPromises()
  await openMemoryModal(w)
  await w.find('[data-testid="memory-clear-btn"]').trigger('click')
  await flushPromises()
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(updateProjectMock).toHaveBeenCalledWith('p1', { recap: '' })
  expect(state.projects[0].projectRecap).toBeNull()
  expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String))
  expect(w.find('[data-testid="memory-textarea"]').exists()).toBe(false)
  vi.unstubAllGlobals()
})

test('清空钮 confirm 拒绝:不发请求、弹窗保留', async () => {
  vi.stubGlobal('confirm', vi.fn(() => false))
  state.projects = memorySeed()
  const w = mountView()
  await flushPromises()
  await openMemoryModal(w)
  await w.find('[data-testid="memory-clear-btn"]').trigger('click')
  await flushPromises()
  expect(updateProjectMock).not.toHaveBeenCalled()
  expect(w.find('[data-testid="memory-textarea"]').exists()).toBe(true)
  vi.unstubAllGlobals()
})

test('空文本保存(原记忆非空):confirm 同意按 \'\' 提交;拒绝不发请求', async () => {
  vi.stubGlobal('confirm', vi.fn(() => false))
  state.projects = memorySeed()
  const w = mountView()
  await flushPromises()
  await openMemoryModal(w)
  await w.find('[data-testid="memory-textarea"]').setValue('   ')
  await w.find('[data-testid="memory-save-btn"]').trigger('click')
  await flushPromises()
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(updateProjectMock).not.toHaveBeenCalled()
  vi.stubGlobal('confirm', vi.fn(() => true))
  await w.find('[data-testid="memory-save-btn"]').trigger('click')
  await flushPromises()
  expect(updateProjectMock).toHaveBeenCalledWith('p1', { recap: '' })
  vi.unstubAllGlobals()
})

test('busy 防双发:在途仅 1 发且按钮禁用,成功后关窗', async () => {
  let release
  updateProjectMock.mockImplementationOnce(() => new Promise(r => { release = r }))
  state.projects = memorySeed()
  const w = mountView()
  await flushPromises()
  await openMemoryModal(w)
  await w.find('[data-testid="memory-textarea"]').setValue('新记忆')
  const btn = w.find('[data-testid="memory-save-btn"]')
  await btn.trigger('click')          // 第一发(在途)
  await btn.trigger('click')          // 双击第二发
  expect(updateProjectMock).toHaveBeenCalledTimes(1)
  expect(btn.attributes('disabled')).toBeDefined()
  release({ ok: true })
  await flushPromises()
  expect(w.find('[data-testid="memory-save-btn"]').exists()).toBe(false, '成功关窗')
})

test('保存失败:error 透传 + 弹窗与输入保留可重试', async () => {
  updateProjectMock.mockRejectedValueOnce(new Error('recap 太长'))
  state.projects = memorySeed()
  const w = mountView()
  await flushPromises()
  await openMemoryModal(w)
  await w.find('[data-testid="memory-textarea"]').setValue('新记忆')
  await w.find('[data-testid="memory-save-btn"]').trigger('click')
  await flushPromises()
  expect(notifyMock).toHaveBeenCalledWith('error', 'recap 太长')
  expect(w.find('[data-testid="memory-textarea"]').exists()).toBe(true, '失败保留弹窗')
  expect(w.find('[data-testid="memory-textarea"]').element.value).toBe('新记忆')
})
```


- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/WorkbenchProjects.lifecycle.test.js`
Expected: 新增 8 条 FAIL(菜单无「项目记忆」项);既有 14 条(4+9+遮罩 1)仍 PASS。

- [ ] **Step 3: 实现**

**i18n** — `src/locales/zh.json` 的 `workbench.card` 追加(值逐字取 spec §4):

```json
"projectMemory": "项目记忆",
"memoryModalTitle": "项目记忆·{name}",
"memorySaved": "项目记忆已更新",
"memoryCleared": "项目记忆已清空",
"memoryClearConfirm": "确认清空该项目记忆?清空后 AI 不再携带旧摘要,对话将重新滚动生成新记忆。",
"memorySaveFailed": "保存项目记忆失败",
"memoryModalHint": "上限 65536 字符;清空后 AI 不再携带旧摘要,对话将重新滚动生成新记忆。"
```

`src/locales/en.json` 同位置:

```json
"projectMemory": "Project memory",
"memoryModalTitle": "Project memory · {name}",
"memorySaved": "Project memory updated",
"memoryCleared": "Project memory cleared",
"memoryClearConfirm": "Clear this project's memory? The AI will stop carrying the old summary; new memory builds up from upcoming conversations.",
"memorySaveFailed": "Failed to save project memory",
"memoryModalHint": "Up to 65,536 characters. Clearing stops the AI from carrying the old summary; new memory builds up from upcoming conversations."
```

**script** — `src/views/WorkbenchProjects.vue`,`clearRecap` 无此函数;在 `doDelete` 之后追加:

```js
// ═══ 项目记忆直编(spec 2026-09-01b):⋮ 菜单第三项,弹窗编辑 projectRecap ═══
// 数据单源=projects[].projectRecap(列表接口 SELECT * 已携带,预填零请求);
// 语义与聊天页背景卡同构:保存空文本(原记忆非空)与清空钮均需 confirm 二次确认。
const showMemory = ref(false)
const memoryTarget = ref(null)
const memoryText = ref('')
const memoryBusy = ref(false)
function startMemory(p) {
  memoryTarget.value = p
  memoryText.value = p.projectRecap || ''
  showMemory.value = true
}
async function commitRecap(next, { requireConfirm = false } = {}) {
  if (!showMemory.value || memoryBusy.value) return
  const clearing = next === ''
  if ((requireConfirm || (clearing && !!memoryTarget.value.projectRecap)) &&
      !window.confirm(t('workbench.card.memoryClearConfirm'))) return
  memoryBusy.value = true
  try {
    await workbenchApi.updateProject(memoryTarget.value.id, { recap: next })
    const p = projects.value.find(x => x.id === memoryTarget.value.id)
    if (p) p.projectRecap = clearing ? null : next
    notify('success', clearing ? t('workbench.card.memoryCleared') : t('workbench.card.memorySaved'))
    showMemory.value = false
  } catch (e) {
    // 失败保留弹窗与输入可重试;透传服务端消息(如 65536 超长 400)
    notify('error', e?.message || t('workbench.card.memorySaveFailed'))
  } finally { memoryBusy.value = false }
}
function saveMemory() { commitRecap(memoryText.value) }
function clearMemory() { commitRecap('', { requireConfirm: true }) }
```

`cardActions(p)` 改为(项目记忆插在重命名与删除之间):

```js
function cardActions(p) {
  return [
    { label: t('workbench.card.renameProject'), icon: 'edit', action: () => startRename(p) },
    { label: t('workbench.card.projectMemory'), icon: 'folder_special', action: () => startMemory(p) },
    { label: t('workbench.card.deleteProject'), icon: 'delete', danger: true, action: () => startDelete(p) },
  ]
}
```

**template** — 文件末尾(删除 Modal 之后)追加:

```html
    <!-- Memory Modal(spec 2026-09-01b):⋮ 菜单直编项目记忆;语义与聊天页背景卡同构 -->
    <Modal v-model="showMemory" :title="t('workbench.card.memoryModalTitle', { name: memoryTarget?.name })" width="max-w-lg">
      <div class="flex flex-col gap-sm">
        <textarea v-model="memoryText" data-testid="memory-textarea" rows="8"
          class="w-full text-body-sm text-on-surface bg-surface-container border border-outline-variant rounded-lg px-sm py-sm focus:outline-none focus:border-primary resize-y"></textarea>
        <p class="text-body-xs text-on-surface-variant">{{ t('workbench.card.memoryModalHint') }}</p>
      </div>
      <template #actions>
        <button @click="clearMemory" :disabled="memoryBusy" data-testid="memory-clear-btn"
          class="px-md py-sm text-body-sm rounded-md text-error border border-error/40 hover:bg-error/5 disabled:opacity-40">{{ t('workbench.chat.recapClear') }}</button>
        <div class="flex-1"></div>
        <button @click="showMemory = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
        <button @click="saveMemory" :disabled="memoryBusy" data-testid="memory-save-btn"
          class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">{{ t('workbench.chat.recapSave') }}</button>
      </template>
    </Modal>
```

- [ ] **Step 4: 跑测试 + 全门禁**

Run: `npx vitest run src/views/__tests__/WorkbenchProjects.lifecycle.test.js`(22 条全过:14 既有+8 新)
再:`npm run test:unit && npm run i18n:check && npm run typecheck && npm run build`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/views/WorkbenchProjects.vue src/views/__tests__/WorkbenchProjects.lifecycle.test.js src/locales/zh.json src/locales/en.json
git commit --author="aliangone <aliangone@gmail.com>" -m "feat(workbench): 卡片⋮菜单「项目记忆」直编——弹窗编辑/清空 projectRecap,语义与聊天页背景卡同构(列表payload零请求预填)"
```
