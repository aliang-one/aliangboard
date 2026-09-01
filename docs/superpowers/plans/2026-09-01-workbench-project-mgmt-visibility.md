# 工作台项目管理+记忆入口可见性修复 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已实现但不可见的项目管理(重命名/删除)与项目记忆(空态可写)入口接进真实渲染树,并清除承载旧入口的死组件。

**Architecture:** 纯前端装配层修复,零服务端/零 API 改动。①WorkbenchProjects 卡片挂现成 `DropdownMenu` + 重命名/删除弹窗(移植死组件已验证语义);②WorkbenchChat 项目背景卡移出 `v-if/v-else` 分支链常驻 + 空态写入;③删 WorkbenchList.vue 及其测试、`workbenchList` 列目录条目、`workbench.list.*` 键。

**Tech Stack:** Vue 3 `<script setup>` + vitest + happy-dom + @vue/test-utils;vue-i18n(zh.json/en.json)。

**Spec:** `docs/superpowers/specs/2026-09-01-workbench-project-mgmt-visibility-design.md`

## Global Constraints

- 零服务端改动、零 API 契约改动(`workbenchApi.updateProject/deleteProject` 签名照旧)。
- 提交作者恒 `aliangone <aliangone@gmail.com>`,**禁** `Co-Authored-By: Claude` 尾注。
- worktree 分支实施,完成后 `--no-ff` 合回 main(用户 2026-08-30 硬约束)。
- i18n 双语键必须 zh/en 成对新增;字面 `@` 在消息值里必须写 `{'@'}`。
- 删除确认名语义逐字移植:**两侧 trim 对称、trim 后仍逐字比对、busy 防双发、warning→error 级提示**。
- `docs/superpowers/` 在 .gitignore,提交计划/spec 须 `git add -f`。
- 测试挂载后凡 Teleport 到 body 的 Modal 不卸载会泄漏进下一用例(本计划用 modalStub 规避;若改用真 Modal 须 `w.unmount()`)。
- 门禁四件:`npm run test:unit` + `npm run i18n:check` + `npm run typecheck` + `npm run build`。

---

### Task 1: 项目卡片 ⋮ 菜单 + 重命名弹窗

**Files:**
- Modify: `src/views/WorkbenchProjects.vue`
- Create: `src/views/__tests__/WorkbenchProjects.lifecycle.test.js`
- Modify: `src/locales/zh.json`、`src/locales/en.json`(workbench.card 新增 5 键)

**Interfaces:**
- Consumes: `workbenchApi.updateProject(id, { name })` → `{ ok, project }`(既有,client.js:253);`DropdownMenu` props `items: [{label, icon, action, danger?}], triggerLabel`(src/components/common/DropdownMenu.vue)。
- Produces: 卡片菜单项工厂 `cardActions(p)`;`startRename(p)/confirmRename()`;测试挂钩 `data-testid="rename-input"`、`"rename-confirm-btn"`、菜单触发钮 `aria-label` = `workbench.card.projectActions` 的 zh 值「项目操作」。Task 2 复用同测试文件与 `cardActions(p)`。

- [ ] **Step 1: 写失败测试(菜单导航隔离 + 重命名 3 条)**

创建 `src/views/__tests__/WorkbenchProjects.lifecycle.test.js`:

```js
// src/views/__tests__/WorkbenchProjects.lifecycle.test.js
// 项目卡片 ⋮ 菜单生命周期(2026-09-01 可见性修复):语义自死组件 WorkbenchList 移植。
// 形态裁决(spec §6):行内 blur 重命名 → 弹窗确认式;enter/blur 竞态守卫随形态消失,由 busy 防重替代。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import { readFileSync } from 'node:fs'

const state = vi.hoisted(() => ({
  // trim 对称测试需要带首尾空白的项目名(终审 M1 语义)
  projects: [{ id: 'p1', name: 'alpha', clusterId: 'c1', namespace: 'default', manifestCount: 0, lastReconcile: null }],
}))
const updateProjectMock = vi.fn()
const deleteProjectMock = vi.fn()
const notifyMock = vi.fn()
const pushMock = vi.fn()

vi.mock('@/api/client', () => ({
  workbenchApi: {
    listProjects: () => Promise.resolve({ projects: state.projects }),
    createProject: vi.fn(),
    updateProjectCluster: vi.fn(),
    updateProject: (...a) => updateProjectMock(...a),
    deleteProject: (...a) => deleteProjectMock(...a),
  },
  authApi: { myClusters: () => Promise.resolve([]) },
}))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))

import WorkbenchProjects from '@/views/WorkbenchProjects.vue'

const i18n = createI18n({ legacy: false, locale: 'zh',
  messages: { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) } })

// Modal 是 Teleport 组件,行为矩阵测试统一用 stub(和死组件 13 条测试同手法)
const modalStub = {
  props: ['modelValue', 'title', 'width'],
  emits: ['update:modelValue'],
  template: `<div v-if="modelValue" class="test-modal"><div class="test-modal-body"><slot /></div><div class="test-modal-actions"><slot name="actions" /></div></div>`,
}

// projects 内联在卡片网格(非 Teleport),可直接挂载
function mountView() {
  return mount(WorkbenchProjects, {
    global: { plugins: [createPinia(), i18n], stubs: { Modal: modalStub, Transition: true } },
  })
}
function openCardMenu(w) {
  return w.find('button[aria-label="项目操作"]')
}

beforeEach(() => {
  notifyMock.mockClear(); updateProjectMock.mockClear(); deleteProjectMock.mockClear(); pushMock.mockClear()
  state.projects = [{ id: 'p1', name: 'alpha', clusterId: 'c1', namespace: 'default', manifestCount: 0, lastReconcile: null }]
})

test('菜单:点 ⋮ 展开菜单且不触发整卡导航(stopPropagation)', async () => {
  const w = mountView()
  await flushPromises()
  await openCardMenu(w).trigger('click')
  expect(w.text()).toContain('重命名')
  expect(pushMock).not.toHaveBeenCalled()
})

// 注意:happy-dom 里 Material Symbols 图标 span 渲染为图标名文字,菜单钮 text() 是 'edit重命名'
// 形态——必须 includes 匹配,不能等值。
test('重命名:弹窗输入新名 → updateProject(id,{name}) + 本地刷新 + success', async () => {
  const w = mountView()
  await flushPromises()
  await openCardMenu(w).trigger('click')
  await w.findAll('button').find(b => b.text().includes('重命名')).trigger('click')
  const input = w.find('input[data-testid="rename-input"]')
  expect(input.exists()).toBe(true)
  await input.setValue('beta')
  await w.find('[data-testid="rename-confirm-btn"]').trigger('click')
  expect(updateProjectMock).toHaveBeenCalledWith('p1', { name: 'beta' })
  await flushPromises()
  expect(w.text()).toContain('beta')
  expect(notifyMock).toHaveBeenCalledWith('success', expect.stringContaining('beta'))
})

test('重命名:空名确定钮禁用不发请求', async () => {
  const w = mountView()
  await flushPromises()
  await openCardMenu(w).trigger('click')
  await w.findAll('button').find(b => b.text().includes('重命名')).trigger('click')
  await w.find('input[data-testid="rename-input"]').setValue('   ')
  expect(w.find('[data-testid="rename-confirm-btn"]').attributes('disabled')).toBeDefined()
  await w.find('[data-testid="rename-confirm-btn"]').trigger('click')
  expect(updateProjectMock).not.toHaveBeenCalled()
})

test('重命名:PATCH 失败保留弹窗与输入可重试(错误透传)', async () => {
  updateProjectMock.mockRejectedValueOnce(new Error('nope'))
  const w = mountView()
  await flushPromises()
  await openCardMenu(w).trigger('click')
  await w.findAll('button').find(b => b.text().includes('重命名')).trigger('click')
  await w.find('input[data-testid="rename-input"]').setValue('delta')
  await w.find('[data-testid="rename-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(notifyMock).toHaveBeenCalledWith('error', 'nope')
  expect(w.find('input[data-testid="rename-input"]').exists()).toBe(true, '弹窗保留')
  expect(w.find('input[data-testid="rename-input"]').element.value).toBe('delta')
  updateProjectMock.mockResolvedValueOnce({ ok: true })
  await w.find('[data-testid="rename-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(updateProjectMock).toHaveBeenCalledTimes(2)
  expect(w.text()).toContain('delta')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/WorkbenchProjects.lifecycle.test.js`
Expected: FAIL——`aria-label="项目操作"` 找不到触发钮(菜单未实现)。

- [ ] **Step 3: 实现(菜单 + 重命名弹窗 + i18n 5 键)**

`src/locales/zh.json` 的 `workbench.card` 对象新增(保持字母序就近插入):

```json
"projectActions": "项目操作",
"renameProject": "重命名",
"renameModalTitle": "重命名项目",
"projectRenamed": "项目已重命名为 {name}",
"projectRenameFailed": "重命名失败"
```

`src/locales/en.json` 同位置:

```json
"projectActions": "Project actions",
"renameProject": "Rename",
"renameModalTitle": "Rename project",
"projectRenamed": "Project renamed to {name}",
"projectRenameFailed": "Failed to rename"
```

`src/views/WorkbenchProjects.vue` script 段,`bindCluster` 函数之后追加:

```js
// ═══ 项目卡片菜单(2026-09-01 可见性修复):重命名/删除入口从死组件 WorkbenchList 移植 ═══
// 形态裁决(spec §6):行内 blur 重命名 → 弹窗确认式;busy 防重替代 enter/blur 竞态守卫。
const showRename = ref(false)
const renameTarget = ref(null)
const renameText = ref('')
const renameBusy = ref(false)
function startRename(p) {
  renameTarget.value = p
  renameText.value = p.name || ''
  showRename.value = true
}
async function confirmRename() {
  if (!showRename.value || renameBusy.value) return
  const name = renameText.value.trim()
  if (!name) return                                    // 空名不发请求(确定钮同时禁用)
  if (name === renameTarget.value.name) { showRename.value = false; return }
  renameBusy.value = true
  try {
    await workbenchApi.updateProject(renameTarget.value.id, { name })
    const p = projects.value.find(x => x.id === renameTarget.value.id)
    if (p) p.name = name
    notify('success', t('workbench.card.projectRenamed', { name }))
    showRename.value = false
  } catch (e) {
    // 失败保留弹窗与输入可重试;透传服务端消息(与死组件/WorkbenchChat 同款)
    notify('error', e?.message || t('workbench.card.projectRenameFailed'))
  } finally { renameBusy.value = false }
}
// 菜单项工厂(Task 2 在此追加删除项)
function cardActions(p) {
  return [
    { label: t('workbench.card.renameProject'), icon: 'edit', action: () => startRename(p) },
  ]
}
```

script 头部 import 区追加:

```js
import DropdownMenu from '@/components/common/DropdownMenu.vue'
```

template 卡片名行(`<div class="flex items-start justify-between mb-sm">` 内,`<span ...>arrow_forward</span>` 之前)改为:

```html
          <div class="flex items-center gap-xs">
            <!-- 菜单恒可见低强调(触屏无 hover;hover 时加强),组件自带 stopPropagation 防误触整卡导航 -->
            <DropdownMenu :items="cardActions(p)" :trigger-label="t('workbench.card.projectActions')"
              class="opacity-60 group-hover:opacity-100 transition-opacity" />
            <span class="material-symbols-outlined text-on-surface-variant/30 group-hover:text-primary transition-colors">arrow_forward</span>
          </div>
```

template 末尾(创建 Modal 之后)追加重命名弹窗:

```html
    <!-- Rename Modal(可见性修复):空名禁用;失败保留可重试 -->
    <Modal v-model="showRename" :title="t('workbench.card.renameModalTitle')" width="max-w-md">
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('workbench.card.nameLabel') }}</label>
        <input v-model="renameText" data-testid="rename-input" @keyup.enter="confirmRename"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
      </div>
      <template #actions>
        <button @click="showRename = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
        <button @click="confirmRename" :disabled="!renameText.trim() || renameBusy" data-testid="rename-confirm-btn"
          class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">{{ t('common.confirm') }}</button>
      </template>
    </Modal>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/WorkbenchProjects.lifecycle.test.js`
Expected: PASS(4 条)。既有 `WorkbenchProjects.open-create.test.js`/`unbound.test.js` 不受影响(顺手跑一遍确认)。

- [ ] **Step 5: Commit**

```bash
git add src/views/WorkbenchProjects.vue src/views/__tests__/WorkbenchProjects.lifecycle.test.js src/locales/zh.json src/locales/en.json
git commit --author="aliangone <aliangone@gmail.com>" -m "feat(workbench): 项目卡片⋮菜单+重命名弹窗——管理入口从死组件 WorkbenchList 移植进真实渲染树"
```

---

### Task 2: 删除确认名弹窗(13 条语义矩阵移植)

**Files:**
- Modify: `src/views/WorkbenchProjects.vue`
- Modify: `src/views/__tests__/WorkbenchProjects.lifecycle.test.js`(追加 9 条)
- Modify: `src/locales/zh.json`、`src/locales/en.json`(workbench.card 新增 7 键)

**Interfaces:**
- Consumes: Task 1 的 `cardActions(p)`、测试文件、modalStub;`workbenchApi.deleteProject(id, confirmName)` → `{ ok, removedConversations, repoRemoved, warning? }`(client.js:254)。
- Produces: `startDelete(p)/doDelete()`;`data-testid="delete-confirm-input"`、`"delete-confirm-btn"`。

- [ ] **Step 1: 追加失败测试(删除 9 条,语义逐字移植死组件)**

在 Task 1 测试文件末尾追加:

```js
// ═══ 删除:确认名语义矩阵(自 WorkbenchList.lifecycle 逐条移植,文案键换 card.*) ═══

async function openDeleteModal(w) {
  await openCardMenu(w).trigger('click')
  await w.findAll('button').find(b => b.text().includes('删除')).trigger('click')
}

test('删除:确认名不一致时确定钮禁用且点击不发请求', async () => {
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  expect(w.find('.test-modal').exists()).toBe(true)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alph')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  expect(btn.attributes('disabled')).toBeDefined()
  await btn.trigger('click')
  expect(deleteProjectMock).not.toHaveBeenCalled()
})

test('删除:确认名逐字一致 → deleteProject(id, name) + 列表移除 + success', async () => {
  const w = mountView()
  await flushPromises()
  expect(w.text()).toContain('alpha')
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  expect(btn.attributes('disabled')).toBeUndefined()
  await btn.trigger('click')
  expect(deleteProjectMock).toHaveBeenCalledWith('p1', 'alpha')
  await flushPromises()
  expect(w.text()).not.toContain('alpha')
  expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String))
})

test('删除:请求失败时列表保留 + error notify(透传)', async () => {
  deleteProjectMock.mockRejectedValueOnce(new Error('boom'))
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  await w.find('[data-testid="delete-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('alpha')
  expect(notifyMock).toHaveBeenCalledWith('error', 'boom')
})

// 终审 I2 语义:repo 目录清除失败后端仍 200 但带 warning(数据已删、目录成孤儿)——
// 必须 error 级示警,只报成功会让孤儿目录永远无人跟进。
test('删除:响应带 warning → error 级提示含 warning 原文,行仍移除', async () => {
  deleteProjectMock.mockResolvedValueOnce({ ok: true, removedConversations: 2, repoRemoved: false, warning: 'EBUSY: resource busy' })
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  await w.find('[data-testid="delete-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(w.text()).not.toContain('alpha')
  expect(notifyMock).toHaveBeenCalledTimes(1)
  expect(notifyMock).toHaveBeenCalledWith('error', expect.stringContaining('EBUSY: resource busy'))
})

test('删除:无 warning → 恒 success 提示(不误报警)', async () => {
  deleteProjectMock.mockResolvedValueOnce({ ok: true, removedConversations: 0, repoRemoved: true })
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  await w.find('[data-testid="delete-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String))
  expect(notifyMock).not.toHaveBeenCalledWith('error', expect.anything())
})

// 终审 M1 语义:确认名 trim 对称——项目名可含首尾空白,只比原文会让它永远删不掉
test('删除确认名 trim 对称:项目名带首尾空白,输入 trim 后即可删', async () => {
  state.projects = [{ id: 'p-pad', name: 'pad me ', clusterId: '', namespace: 'default', manifestCount: 0, lastReconcile: null }]
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('pad me')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  expect(btn.attributes('disabled')).toBeUndefined()
  await btn.trigger('click')
  await flushPromises()
  expect(deleteProjectMock).toHaveBeenCalledWith('p-pad', 'pad me')
  expect(w.text()).not.toContain('pad me')
})

test('删除确认名仍逐字敏感:trim 后不等则禁用(M1 不是放弃校验)', async () => {
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alph')
  expect(w.find('[data-testid="delete-confirm-btn"]').attributes('disabled')).toBeDefined()
  expect(deleteProjectMock).not.toHaveBeenCalled()
})

// 终审 M2 语义:删除在途防重入——双击第二发落在已删项目上 → 404 → 假「删除失败」
test('删除:在途期间再点确定不发第二发请求', async () => {
  let release
  deleteProjectMock.mockImplementationOnce(() => new Promise(r => { release = r }))
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  await btn.trigger('click')       // 第一发(在途,不 resolve)
  await btn.trigger('click')       // 双击第二发
  await btn.trigger('click')
  expect(deleteProjectMock).toHaveBeenCalledTimes(1)
  release({ ok: true })
  await flushPromises()
  expect(deleteProjectMock).toHaveBeenCalledTimes(1)
  expect(w.text()).not.toContain('alpha')
})

test('删除:在途时确定按钮禁用', async () => {
  let release
  deleteProjectMock.mockImplementationOnce(() => new Promise(r => { release = r }))
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  await btn.trigger('click')
  expect(btn.attributes('disabled')).toBeDefined()
  release({ ok: true })
  await flushPromises()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/WorkbenchProjects.lifecycle.test.js`
Expected: 新增 9 条 FAIL(菜单只有重命名项,「删除」找不到)。

- [ ] **Step 3: 实现(删除弹窗 + i18n 5 键)**

`src/locales/zh.json` 的 `workbench.card` 追加(文案与死组件 list.* 逐字一致,仅命名空间换 card):

```json
"deleteProject": "删除",
"confirmDeleteTitle": "删除项目",
"confirmDeleteHint": "此操作不可恢复,将删除该项目的全部仓库内容。输入下方项目名以确认:",
"confirmDeletePlaceholder": "输入项目名以确认",
"projectDeleted": "项目已删除",
"projectDeletedWithWarning": "项目已删除，但仓库目录清除失败：{warning}",
"projectDeleteFailed": "删除项目失败"
```

`src/locales/en.json` 同位置:

```json
"deleteProject": "Delete",
"confirmDeleteTitle": "Delete project",
"confirmDeleteHint": "This is irreversible and removes all repository content of the project. Type the project name shown below to confirm:",
"confirmDeletePlaceholder": "Type project name to confirm",
"projectDeleted": "Project deleted",
"projectDeletedWithWarning": "Project deleted, but repo directory removal failed: {warning}",
"projectDeleteFailed": "Failed to delete project"
```

`WorkbenchProjects.vue` script,`confirmRename` 之后追加(与死组件逐字同语义,仅键名换 card.*):

```js
// 删除:确认名与项目名(trim 后)一致才启用确定。M1:两侧都 trim——项目名可含首尾空白,
// 只比原文会让这类项目永远删不掉。deleteBusy(M2):删除在途拦第二次提交,否则双击的
// 第二发落在已删项目上 → 404 → 用户看到假「删除失败」。
const deleteTarget = ref(null)
const deleteConfirmText = ref('')
const deleteBusy = ref(false)
const deleteConfirmed = computed(() =>
  !!deleteTarget.value && deleteConfirmText.value.trim() === deleteTarget.value.name.trim())
function startDelete(p) {
  deleteTarget.value = p
  deleteConfirmText.value = ''
}
async function doDelete() {
  if (!deleteTarget.value || deleteBusy.value || !deleteConfirmed.value) return
  deleteBusy.value = true
  try {
    const res = await workbenchApi.deleteProject(deleteTarget.value.id, deleteConfirmText.value.trim())
    projects.value = projects.value.filter(x => x.id !== deleteTarget.value.id)
    deleteTarget.value = null
    // repo 目录清除失败时后端仍 200,但带 warning(数据已级联删、目录成孤儿):
    // 必须 error 级示警(终审 I2)——只报成功会让孤儿目录永远无人跟进。
    if (res?.warning) notify('error', t('workbench.card.projectDeletedWithWarning', { warning: res.warning }))
    else notify('success', t('workbench.card.projectDeleted'))
  } catch (e) { notify('error', e.message || t('workbench.card.projectDeleteFailed')) }
  finally { deleteBusy.value = false }
}
```

script 头部确认 `computed` 已从 vue import(当前只有 `ref, onMounted, watch`——补上 `computed`)。

`cardActions(p)` 追加删除项:

```js
function cardActions(p) {
  return [
    { label: t('workbench.card.renameProject'), icon: 'edit', action: () => startRename(p) },
    { label: t('workbench.card.deleteProject'), icon: 'delete', danger: true, action: () => startDelete(p) },
  ]
}
```

template 末尾追加删除弹窗(项目名是用户输入,不走 v-html:文案与 `<code>` 文本节点拆开渲染):

```html
    <!-- Delete Modal:确认名逐字一致才启用;两侧 trim 对称;busy 防双发 -->
    <Modal :model-value="!!deleteTarget" @update:model-value="v => { if (!v) deleteTarget = null }"
      :title="t('workbench.card.confirmDeleteTitle')" width="max-w-md">
      <div v-if="deleteTarget" class="flex flex-col gap-md">
        <p class="text-body-sm text-on-surface-variant">{{ t('workbench.card.confirmDeleteHint') }}</p>
        <p><code class="px-sm py-0.5 bg-surface-container rounded text-on-surface font-mono text-body-sm">{{ deleteTarget.name }}</code></p>
        <input v-model="deleteConfirmText" data-testid="delete-confirm-input"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono"
          :placeholder="t('workbench.card.confirmDeletePlaceholder')" />
      </div>
      <template #actions>
        <button @click="deleteTarget = null" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
        <button @click="doDelete" :disabled="!deleteConfirmed || deleteBusy" data-testid="delete-confirm-btn"
          class="px-md py-sm bg-error text-on-error rounded-lg font-semibold disabled:opacity-40">{{ t('workbench.card.deleteProject') }}</button>
      </template>
    </Modal>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/WorkbenchProjects.lifecycle.test.js`
Expected: PASS(13 条 = Task 1 的 4 + 本任务 9)。

- [ ] **Step 5: Commit**

```bash
git add src/views/WorkbenchProjects.vue src/views/__tests__/WorkbenchProjects.lifecycle.test.js src/locales/zh.json src/locales/en.json
git commit --author="aliangone <aliangone@gmail.com>" -m "feat(workbench): 项目卡片删除确认名弹窗——13 条语义矩阵自死组件逐字移植(两侧trim对称/busy防双发/warning示警)"
```

---

### Task 3: 聊天页项目背景卡常驻 + 空态可写

**Files:**
- Modify: `src/components/workbench/WorkbenchChat.vue`(template 卡片搬家 + v-if + 空态分支;script 展开逻辑 + import 补 `onMounted`)
- Modify: `src/components/workbench/__tests__/WorkbenchChat.recap.test.js`(2 处断言更新 + 3 条新测试)
- Modify: `src/locales/zh.json`、`src/locales/en.json`(workbench.chat 新增 2 键)

**Interfaces:**
- Consumes: 既有 `startRecapEdit/cancelRecapEdit/saveRecapEdit/clearRecap`、`projectRecapCard` ref(WorkbenchChat.vue:62-108)——**逻辑零改动**,只动渲染条件与空态分支。
- Produces: 卡片渲染条件 `v-if="projectId"`(props.projectId,非空即可写);空态测试挂钩 `[data-testid="recap-empty"]`(空态说明块)、`[data-testid="recap-write-btn"]`(写入记忆钮)。清空后语义变更:卡片**不再消失**、转空态(Task 3 Step 1 更新旧断言)。

- [ ] **Step 1: 更新旧断言 + 写失败测试**

`WorkbenchChat.recap.test.js` 两处断言更新(清空语义从「卡片消失」变「转空态」,spec §3):

① 第 65-74 行 `清空:二次确认…` 用例,删掉这行:
```js
  expect(w.find('[data-testid="project-recap-card"]').exists()).toBe(false)
```
换成:
```js
  expect(w.find('[data-testid="project-recap-card"]').exists()).toBe(true, '清空后转空态卡(仍可再写入)')
  expect(w.find('[data-testid="recap-empty"]').exists()).toBe(true)
  expect(w.text()).not.toContain('旧记忆')
```

② 第 115-128 行 `空文本保存…` 用例,删掉这行:
```js
  expect(w.find('[data-testid="project-recap-card"]').exists()).toBe(false, '清空后卡片收起')
```
换成:
```js
  expect(w.find('[data-testid="recap-empty"]').exists()).toBe(true, '清空后转空态卡')
```

文件末尾追加 3 条新测试:

```js
// ═══ 空态可写(2026-09-01 可见性修复,spec §3):v-if 恒真后,无记忆也有写入入口 ═══

test('空态:无记忆时卡片渲染、默认展开、写入记忆钮进编辑态', async () => {
  const w = await mountWithProjectRecap(null)
  const card = w.find('[data-testid="project-recap-card"]')
  expect(card.exists()).toBe(true)
  expect(card.element.open).toBe(true, '空态默认展开——入口必须一眼可见')
  expect(card.find('[data-testid="recap-empty"]').exists()).toBe(true)
  await card.find('[data-testid="recap-write-btn"]').trigger('click')
  expect(card.find('textarea').exists()).toBe(true)
})

test('空态:无对话项目(projectId 仅有的场景)卡片同样渲染', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockRejectedValueOnce(new Error('no conv'))
  const w = mount(WorkbenchChat, {
    props: { projectId: 'p1', projectName: 'demo' },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  expect(w.find('[data-testid="project-recap-card"]').exists()).toBe(true, '无对话也要能写项目记忆')
  expect(w.find('[data-testid="recap-write-btn"]').exists()).toBe(true)
})

test('空态写入:草稿非空保存 → updateProject(recap) 创建记忆(非清空路径无 confirm)', async () => {
  vi.stubGlobal('confirm', vi.fn(() => { throw new Error('非空保存不应弹 confirm') }))
  const w = await mountWithProjectRecap(null)
  const card = w.find('[data-testid="project-recap-card"]')
  await card.find('[data-testid="recap-write-btn"]').trigger('click')
  await card.find('textarea').setValue('第一条记忆')
  await card.find('[data-testid="recap-save-btn"]').trigger('click')
  await flushPromises()
  expect(api.updateProject).toHaveBeenCalledWith('p1', { recap: '第一条记忆' })
  expect(card.find('[data-testid="recap-empty"]').exists()).toBe(false)
  expect(w.text()).toContain('第一条记忆')
  vi.unstubAllGlobals()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.recap.test.js`
Expected: FAIL——`projectRecap: null` 时卡片不存在(v-if 未改),空态/无对话用例全红;两处改写的断言也红。

- [ ] **Step 3: 实现(模板搬家 + 空态分支 + 编程式默认展开)**

`src/locales/zh.json` 的 `workbench.chat` 追加:

```json
"recapEmptyHint": "尚无项目记忆。AI 每轮对话会携带此摘要作为项目背景;可手动写入,或由对话自动滚动生成。",
"recapWrite": "写入记忆"
```

`src/locales/en.json` 同位置:

```json
"recapEmptyHint": "No project memory yet. Each AI turn carries this summary as project background; write it manually or let conversations build it up automatically.",
"recapWrite": "Write memory"
```

`WorkbenchChat.vue` 模板:**整块剪切**现 `<details v-if="projectRecap" ref="projectRecapCard" ...>…</details>`(现 1043-1072 行,位于「阅读列」`v-else` 分支内),**粘贴**到 `<div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto" @scroll="onChatScroll">` 开标签之后、`v-if="convLoading…"` 分支之前(即脱离 v-if/v-else 链——否则无对话的新项目整条分支不渲染,入口依旧不可见)。同时:

- `v-if="projectRecap"` → `v-if="projectId"`
- summary 行编辑/清空按钮的 `v-if="!recapEditing"` 包裹段改为 `v-if="projectRecap && !recapEditing"`(无记忆时不该出现「清空」)
- body 增加**空态分支**,编辑态/内容态条件相应收窄:

```html
        <!-- 项目背景(2026-08-29 项目记忆;2026-09-01 常驻+空态可写):AI 每轮携带的项目决策摘要。
             脱离 v-if/v-else 链挂在滚动区顶部——无对话的新项目也要有写入入口(spec §3)。 -->
        <details v-if="projectId" ref="projectRecapCard" data-testid="project-recap-card" class="mt-md bg-surface-container-low border border-outline-variant rounded-lg">
          <summary class="cursor-pointer select-none px-md py-sm text-body-sm font-medium text-on-surface-variant flex items-center gap-xs">
            <span class="material-symbols-outlined text-base text-primary/60">folder_special</span>
            <span class="flex-1">{{ t('workbench.chat.projectRecapTitle') }}</span>
            <!-- 人工纠偏(T5)/空态写入(2026-09-01):点击不折叠卡片 -->
            <span v-if="projectRecap && !recapEditing" class="flex items-center gap-xs" @click.stop>
              <button data-testid="recap-edit-btn" type="button" @click="startRecapEdit"
                class="text-body-xs text-on-surface-variant hover:text-primary flex items-center gap-xs px-xs rounded transition-colors">
                <span class="material-symbols-outlined text-sm">edit</span>{{ t('workbench.chat.recapEdit') }}
              </button>
              <button data-testid="recap-clear-btn" type="button" @click="clearRecap"
                class="text-body-xs text-on-surface-variant hover:text-error flex items-center gap-xs px-xs rounded transition-colors">
                <span class="material-symbols-outlined text-sm">delete</span>{{ t('workbench.chat.recapClear') }}
              </button>
            </span>
            <span v-else-if="!projectRecap && !recapEditing" class="flex items-center gap-xs" @click.stop>
              <button data-testid="recap-write-btn" type="button" @click="startRecapEdit"
                class="text-body-xs text-primary hover:text-primary flex items-center gap-xs px-xs rounded transition-colors">
                <span class="material-symbols-outlined text-sm">edit</span>{{ t('workbench.chat.recapWrite') }}
              </button>
            </span>
          </summary>
          <!-- 编辑态:textarea + 保存/取消 -->
          <div v-if="recapEditing" class="px-md pb-md flex flex-col gap-xs">
            <textarea v-model="recapDraft" rows="5"
              class="w-full text-body-sm text-on-surface bg-surface-container border border-outline-variant rounded-lg px-sm py-sm focus:outline-none focus:border-primary resize-y"></textarea>
            <div class="flex items-center gap-sm">
              <button data-testid="recap-save-btn" type="button" :disabled="recapSaving" @click="saveRecapEdit"
                class="px-md py-xs text-body-sm rounded-md bg-primary text-on-primary hover:opacity-90 disabled:opacity-50 transition-opacity">{{ t('workbench.chat.recapSave') }}</button>
              <button data-testid="recap-cancel-btn" type="button" :disabled="recapSaving" @click="cancelRecapEdit"
                class="px-md py-xs text-body-sm rounded-md border border-outline-variant text-on-surface-variant hover:bg-surface-container transition-colors">{{ t('workbench.chat.recapCancel') }}</button>
            </div>
          </div>
          <!-- 空态:说明 + 可发现性(卡已默认展开,此文案兜底被手动折叠后的再展开场景) -->
          <div v-else-if="!projectRecap" data-testid="recap-empty" class="px-md pb-md text-body-sm text-on-surface-variant leading-relaxed">
            {{ t('workbench.chat.recapEmptyHint') }}
          </div>
          <div v-else class="px-md pb-md text-body-sm text-on-surface-variant leading-relaxed whitespace-pre-wrap">{{ projectRecap }}</div>
        </details>
```

`WorkbenchChat.vue` script:

① vue import 行补 `onMounted`(现为 `import { ref, computed, nextTick, watch, onUnmounted } from 'vue'`):

```js
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
```

② `projectRecapCard` 声明(第 69 行)之后追加:

```js
// 空态卡默认展开(spec §3):入口必须一眼可见。不用 :open 声明式绑定——30s 自适应轮询
// 重渲染会与用户手动展开/收起互搏,改编程式一次性展开;有记忆态维持默认收起(现状)。
function expandRecapIfEmpty() {
  if (props.projectId && !projectRecap.value && !recapEditing.value && projectRecapCard.value) {
    projectRecapCard.value.open = true
  }
}
watch(projectRecap, expandRecapIfEmpty)          // 清空/从未有记忆时转空态 → 展开
onMounted(() => nextTick(expandRecapIfEmpty))    // 首挂(模板 ref 此时尚未绑定,须 nextTick)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.recap.test.js`
Expected: PASS(既有 9 条含 2 处断言更新 + 新增 3 条)。再跑 `npx vitest run src/components/workbench` 全组件目录防联动回归。

- [ ] **Step 5: Commit**

```bash
git add src/components/workbench/WorkbenchChat.vue src/components/workbench/__tests__/WorkbenchChat.recap.test.js src/locales/zh.json src/locales/en.json
git commit --author="aliangone <aliangone@gmail.com>" -m "feat(workbench): 项目背景卡常驻+空态可写——脱离对话分支链(无对话新项目也有写入入口),空态默认展开编程式展开防轮询互搏"
```

---

### Task 4: 死组件清除 + i18n 键/列目录连坐清理

**Files:**
- Delete: `src/views/WorkbenchList.vue`
- Delete: `src/views/__tests__/WorkbenchList.lifecycle.test.js`
- Modify: `src/composables/tableColumnsCore.js:442-446`(删 `key: 'workbenchList'` 目录条目——仅死组件消费)
- Modify: `src/locales/zh.json`、`src/locales/en.json`(删整个 `workbench.list` 对象,28 键 ×2)

**Interfaces:**
- Consumes: Task 1/2 已把 13 条语义移植到 WorkbenchProjects.lifecycle.test.js(旧测试文件的信息内容已被取代)。
- Produces: 无(纯清除)。`tableColumnsCore.js` 的 `workbenchList` 条目与 `workbench.list.title/tableProject/tableCluster/tableCreated` 键是仅有的表外引用,随本任务连坐删除。

- [ ] **Step 1: 删文件 + 删目录条目 + 删 i18n 键**

```bash
git rm src/views/WorkbenchList.vue src/views/__tests__/WorkbenchList.lifecycle.test.js
```

`src/composables/tableColumnsCore.js` 删除 442-446 行整个条目:

```js
    key: 'workbenchList', labelKey: 'workbench.list.title', label: 'Workbench Projects', icon: 'workspaces',
    // …(含 name/cluster/created 三个列定义的完整对象,以 442 行起始的闭合括号为准)
```

`src/locales/zh.json` / `en.json`:删除 `"workbench"` 对象下的整个 `"list": { … }` 子对象。

- [ ] **Step 2: 残留引用扫描(必须零命中)**

Run: `grep -rn "workbench\.list\.\|'workbenchList'\|WorkbenchList" src/ --include="*.vue" --include="*.js" | grep -v "同款\|与 WorkbenchList 一致\|从死组件\|WorkbenchList 移植"`
Expected: 空输出(注释里的历史指涉不算引用,故 grep 排除注释性短语)。

- [ ] **Step 3: 全门禁四件**

Run: `npm run test:unit && npm run i18n:check && npm run typecheck && npm run build`
Expected: 全绿。i18n:check 特别验证键对齐(zh/en 同步删)与引用键缺失(无悬空)。

- [ ] **Step 4: Commit**

```bash
git add -A src/
git commit --author="aliangone <aliangone@gmail.com>" -m "chore(workbench): 删死组件 WorkbenchList+旧测试+workbenchList 列目录条目+workbench.list.* i18n 键——根除「功能写在死组件上」的断链复发源"
```

---

### Task 5: 终验(全门禁 + 交付清点)

**Files:** 无新改动(验证任务;若发现红灯,修复后按所属任务语义补提交)。

- [ ] **Step 1: 全门禁四件再跑一遍(合并树视角)**

Run: `npm run test:unit && npm run i18n:check && npm run typecheck && npm run build`
Expected: 全绿。

- [ ] **Step 2: 残留核验三查**

```bash
grep -rn "projectRecap\"" src/components/workbench/WorkbenchChat.vue | grep "v-if"   # 应无 v-if="projectRecap"(改 projectId)
grep -c "data-testid" src/views/__tests__/WorkbenchProjects.lifecycle.test.js        # 测试挂钩在位
git log --oneline main..HEAD                                                          # 4 个特性提交,作者 aliangone,无 Claude 尾注
```

- [ ] **Step 3: 手测 5 项登记(交付后人工,需真浏览器)**

1. 项目 tab 卡片 hover:⋮ 菜单出现,点开不进详情;
2. ⋮→重命名:弹窗改名即时生效,卡片名更新;
3. ⋮→删除:输错名确定钮禁用;输对名删除成功,卡片消失;
4. 进任一项目对话页:无记忆时顶部「项目背景」空态卡默认展开,「写入记忆」可写入并保存;
5. 有记忆态回归:编辑/清空正常,清空后转空态卡(不消失)。

---

## Self-Review 记录(计划完成时已自审)

- Spec 覆盖:§1→Task 1/2;§2→Task 3;§3(死组件)→Task 4;§4 门禁+手测→Task 4 Step 3 / Task 5。§2 权限不裁剪、§6 形态裁决、§7 非目标均无代码动作,符合。
- 无占位符:所有代码块可直接落盘;i18n 双语值逐字给出。
- 类型/命名一致性:`startRename/confirmRename/startDelete/doDelete/cardActions`、`data-testid="rename-input|rename-confirm-btn|delete-confirm-input|delete-confirm-btn|recap-empty|recap-write-btn"` 全文一致;Task 2 删除键 7 个与 Step 1 文案一一对应(含 en 全角逗号 zh 值原样保留)。
