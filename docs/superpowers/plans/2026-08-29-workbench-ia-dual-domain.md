# 工作台信息架构双域化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作台五 tab(项目/配置/全局/记录/服务器)收敛为四 tab(项目/服务器/知识/记录):「全局」更名「知识」并纳服务器台账、「配置」拆散归位后删除、记录页补服务器维度与审计来源口径。

**Architecture:** 纯前端为主的重排(tab 是 WorkbenchShell 组件内 ref 状态,无路由影响);台账面板抽 `ServerLedgerPanel` 供服务器 tab 弹窗与知识 tab 复用;后端唯一改动是 `queryAuditLog` 增加 `toolPrefix` 前缀过滤参数。

**Tech Stack:** Vue 3 `<script setup>` + vue-i18n + Pinia + @vue/test-utils/vitest(前端);node:sqlite + `node --test`(后端)。

**规格:** `docs/superpowers/specs/2026-08-29-workbench-ia-dual-domain-design.md`(裁决与验收标准见该文档)。

## Global Constraints

- 工作目录:`/home/liang/MyProgram/AiProject/aliangboard/.claude/worktrees/wb-ia-dual-domain`,分支 `feat/wb-ia-dual-domain`(基点 main @ 4f1176a)。所有命令在此目录执行。
- 提交作者恒为 `aliangone`(repo config 已设,勿覆盖);**提交信息禁止任何尾注**(禁 Co-Authored-By);禁改写已推送历史。
- `docs/superpowers/` 在 .gitignore 内,提交须 `git add -f`。
- i18n:zh/en 双语必须同步增删;消息值含字面 `@` 须转义 `{'@'}`;改完跑 `npm run i18n:check`。
- 后端测试运行方式:`node --test server/audit.test.mjs`;前端:`npx vitest run <path>`。
- 所有 `/api/ssh/*` 已是 admin-only(`requireAdmin`),前端不得为非 admin 发起 SSH 请求。
- 涉及组件测试若含 Teleport/Modal,断言查 `document.body`(既有教训)。
- 每个任务收尾必须提交一次,信息格式 `feat(workbench): ...` / `refactor(...): ...` 中文一句。

---

### Task 1: 后端 queryAuditLog 增加 toolPrefix 前缀过滤

**Files:**
- Modify: `server/audit.mjs:104-115`(`queryAuditLog` 签名与 where 子句)
- Modify: `server/routes/admin.mjs:474-486`(`/api/admin/audit-log` 透传 `toolPrefix`)
- Test: `server/audit.test.mjs`(文件末尾追加)

**Interfaces:**
- Consumes: 既有 `queryAuditLog(db, {...})` 返回 `{ items, total, page, size }`。
- Produces: `queryAuditLog` 新增可选参数 `toolPrefix`(string)→ `WHERE tool LIKE '<toolPrefix>%'`;`GET /api/admin/audit-log?toolPrefix=ssh` 可用。Task 7 的 Records 页依赖 `{ source:'platform', toolPrefix:'ssh' }` 组合。

- [ ] **Step 1: 写失败测试(server/audit.test.mjs 末尾追加)**

```js
test('queryAuditLog: toolPrefix 前缀过滤(ssh_* 命中,其余不混入)', () => {
  const db = makeDb()
  writeAudit(db, { ...intent, tool: 'ssh_sftp', source: 'platform', result: 'ok' })
  writeAudit(db, { ...intent, tool: 'ssh_server', source: 'platform', result: 'ok' })
  writeAudit(db, { ...intent, tool: 'wb_exec', source: 'workbench', result: 'ok' })
  const r = queryAuditLog(db, { source: 'platform', toolPrefix: 'ssh' })
  assert.equal(r.total, 2)
  assert.ok(r.items.every(x => x.tool.startsWith('ssh')))
  assert.equal(queryAuditLog(db, { toolPrefix: 'nope' }).total, 0)
  // 不传 toolPrefix → 行为不变
  assert.equal(queryAuditLog(db, {}).total, 3)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/audit.test.mjs`
Expected: 新增 test FAIL(`total` 为 3 而非 2——toolPrefix 被忽略)。

- [ ] **Step 3: 实现 audit.mjs**

`queryAuditLog` 解构参数中 `tool` 后加 `toolPrefix`:

```js
export function queryAuditLog(db, { keyId, owner, clusterId, tool, toolPrefix, result, source, since, until, page = 1, size = 50, status = 'finalized' } = {}) {
```

`if (tool) {...}` 行后插入:

```js
  if (toolPrefix) { where.push("tool LIKE ? || '%'"); params.push(String(toolPrefix)) }
```

- [ ] **Step 4: routes/admin.mjs 透传**

`/api/admin/audit-log` 分支的 `queryAuditLog(db, {...})` 参数对象里 `tool: q.get('tool') || undefined,` 行后加:

```js
        toolPrefix: q.get('toolPrefix') || undefined,
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test server/audit.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add server/audit.mjs server/audit.test.mjs server/routes/admin.mjs
git commit -m "feat(audit): queryAuditLog 支持 toolPrefix 前缀过滤——记录页服务器人工操作口径"
```

---

### Task 2: ServerLedgerPanel 组件(服务器台账面板)

**Files:**
- Create: `src/components/ssh/ServerLedgerPanel.vue`
- Test: `src/components/ssh/__tests__/ServerLedgerPanel.test.js`

**Interfaces:**
- Consumes: `sshApi.getLedger(): Promise<{ globalNotes, servers:[{id,name,notes}], markdown }>`、`sshApi.saveLedger(scope, notes): Promise<{ok}>`(src/api/client.js:199-200);i18n 键 `ssh.ledgerHint/ledgerStructure/ledgerGlobal/ledgerNotesPlaceholder/ledgerEmpty`(zh 值见 locales/zh.json);`common.loading/save/saved/saveFailed/error`。
- Produces: `ServerLedgerPanel` 组件,无 props,自拉数据;`defineExpose({ load })` 供调用方强刷。Task 3(服务器 tab 弹窗)与 Task 4(知识 tab 服务器区)直接复用。

- [ ] **Step 1: 写失败测试**

```js
// ServerLedgerPanel:结构层 markdown 只读展示 + 自由层(全局/每服务器)备注编辑(2026-08-29 双域化)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ServerLedgerPanel from '@/components/ssh/ServerLedgerPanel.vue'
import { sshApi } from '@/api/client'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  sshApi: { getLedger: vi.fn(), saveLedger: vi.fn(async () => ({ ok: true })) },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

const FIXTURE = {
  globalNotes: '全局备注G',
  servers: [{ id: 's1', name: 'node-a', notes: 'N1' }],
  markdown: '# LEDGER_MARKDOWN',
}

beforeEach(() => { vi.clearAllMocks(); sshApi.getLedger.mockResolvedValue(FIXTURE) })

const mountPanel = async () => {
  const w = mount(ServerLedgerPanel, { global: { plugins: [i18n] } })
  await flushPromises()
  return w
}

test('挂载即拉台账:结构层 markdown 只读 + 自由层回填', async () => {
  const w = await mountPanel()
  expect(w.find('[data-test="ledgerMarkdown"]').text()).toContain('# LEDGER_MARKDOWN')
  expect(w.find('[data-test="ledgerGlobal"]').element.value).toBe('全局备注G')
  expect(w.find('[data-test="ledgerNotes-s1"]').element.value).toBe('N1')
})

test('保存全局备注:带当前输入值按 scope 调 saveLedger', async () => {
  const w = await mountPanel()
  await w.find('[data-test="ledgerGlobal"]').setValue('新全局')
  await w.find('[data-test="ledgerSaveGlobal"]').trigger('click')
  await flushPromises()
  expect(sshApi.saveLedger).toHaveBeenCalledWith('__global__', '新全局')
})

test('零服务器空态提示', async () => {
  sshApi.getLedger.mockResolvedValue({ globalNotes: '', servers: [], markdown: '' })
  const w = await mountPanel()
  expect(w.text()).toContain('暂无服务器')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/ssh/__tests__/ServerLedgerPanel.test.js`
Expected: FAIL(组件不存在,import 报错)。

- [ ] **Step 3: 实现组件**

`src/components/ssh/ServerLedgerPanel.vue`:

```vue
<script setup>
// 服务器台账面板(2026-08-29 双域化):结构层(后端 renderServerLedger 实时生成,只读 pre 展示,
// 不开 HTML 渲染——无 XSS 面)+ 自由层(全局备注+每服务器备注,PUT /api/ssh/ledger)。
// 服务器 tab 弹窗与知识 tab 服务器区共用本面板,数据单源在后端。
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { sshApi } from '@/api/client'
import { notify } from '@/composables/useToast'

const { t } = useI18n()
const ledger = ref(null)      // { globalNotes, servers:[{id,name,notes}], markdown }
const busy = ref(true)
const draft = ref({})         // { __global__: str, [serverId]: str }
const saving = ref('')

async function load() {
  busy.value = true
  try {
    const r = await sshApi.getLedger()
    ledger.value = r
    draft.value = { __global__: r.globalNotes || '', ...Object.fromEntries((r.servers || []).map(x => [x.id, x.notes || ''])) }
  } catch (e) { notify('error', e?.message || t('common.error')) }
  finally { busy.value = false }
}
onMounted(load)

async function save(scope) {
  saving.value = scope
  try {
    await sshApi.saveLedger(scope, draft.value[scope] ?? '')
    notify('success', t('common.saved'))
  } catch (e) { notify('error', e?.message || t('common.saveFailed')) }
  finally { saving.value = '' }
}
defineExpose({ load })
</script>

<template>
  <div class="flex flex-col gap-md" data-test="serverLedgerPanel">
    <p class="text-body-xs text-on-surface-variant">{{ t('ssh.ledgerHint') }}</p>
    <div v-if="busy" class="text-body-sm text-on-surface-variant">{{ t('common.loading') }}</div>
    <template v-else>
      <div class="flex flex-col gap-xs">
        <p class="text-label-caps text-on-surface-variant">{{ t('ssh.ledgerStructure') }}</p>
        <pre data-test="ledgerMarkdown" class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md font-mono text-body-sm whitespace-pre-wrap break-words max-h-[30vh] overflow-y-auto">{{ ledger?.markdown }}</pre>
      </div>
      <div class="flex flex-col gap-xs">
        <div class="flex items-center justify-between">
          <h5 class="text-title-sm font-semibold">{{ t('ssh.ledgerGlobal') }}</h5>
          <button data-test="ledgerSaveGlobal" @click="save('__global__')" :disabled="saving === '__global__'"
            class="px-sm py-xs bg-primary text-on-primary rounded-lg text-body-xs font-semibold disabled:opacity-50">{{ t('common.save') }}</button>
        </div>
        <textarea data-test="ledgerGlobal" v-model="draft.__global__" rows="4"
          class="bg-surface-container-lowest border border-outline-variant rounded-lg px-sm py-xs text-body-sm font-mono"></textarea>
      </div>
      <div v-for="srv in (ledger?.servers || [])" :key="srv.id" class="flex flex-col gap-xs border-t border-outline-variant/40 pt-sm">
        <div class="flex items-center justify-between">
          <h5 class="text-title-sm font-semibold font-mono">{{ srv.name }}</h5>
          <button :data-test="'ledgerSave-' + srv.id" @click="save(srv.id)" :disabled="saving === srv.id"
            class="px-sm py-xs bg-primary text-on-primary rounded-lg text-body-xs font-semibold disabled:opacity-50">{{ t('common.save') }}</button>
        </div>
        <textarea :data-test="'ledgerNotes-' + srv.id" v-model="draft[srv.id]" rows="3"
          :placeholder="t('ssh.ledgerNotesPlaceholder')"
          class="bg-surface-container-lowest border border-outline-variant rounded-lg px-sm py-xs text-body-sm font-mono"></textarea>
      </div>
      <p v-if="!(ledger?.servers || []).length" class="text-body-sm text-on-surface-variant">{{ t('ssh.ledgerEmpty') }}</p>
    </template>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/ssh/__tests__/ServerLedgerPanel.test.js`
Expected: 3 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add -f src/components/ssh/ServerLedgerPanel.vue src/components/ssh/__tests__/ServerLedgerPanel.test.js
git commit -m "feat(ssh): ServerLedgerPanel 台账面板——结构层只读+自由层编辑,弹窗/知识区两处复用"
```

---

### Task 3: WorkbenchServers 台账弹窗改包 ServerLedgerPanel

**Files:**
- Modify: `src/views/WorkbenchServers.vue:113-136`(删台账状态与函数)、`:257-289`(弹窗体换面板)

**Interfaces:**
- Consumes: Task 2 的 `ServerLedgerPanel`(无 props,自拉数据)。
- Produces: 弹窗壳保留 `data-test="ledgerModal"`/`btnLedger` 选择器不变,内容全部由面板承担。

- [ ] **Step 1: script 手术**

删除 `// —— 台账弹窗 ...` 整段状态与函数(`showLedger` 保留):即删除 `ledger`/`ledgerBusy`/`ledgerDraft`/`ledgerSaving` 四个 ref 与 `openLedger`/`saveLedgerNotes` 两个函数,只留:

```js
// —— 台账弹窗(2026-08-29 双域化):内容迁 ServerLedgerPanel,弹窗只留壳 ——
const showLedger = ref(false)
```

顶部 import 区加:

```js
import ServerLedgerPanel from '@/components/ssh/ServerLedgerPanel.vue'
```

`btnLedger` 按钮的 `@click="openLedger"` 改为 `@click="showLedger = true"`。

- [ ] **Step 2: template 手术**

`<!-- 台账弹窗 ... -->` 注释起的整个 `div v-if="showLedger" data-test="ledgerModal"` 块(原 258-289 行)替换为:

```html
    <!-- 台账弹窗:内容为 ServerLedgerPanel(结构层只读+自由层编辑,与知识 tab 服务器区同源) -->
    <div v-if="showLedger" data-test="ledgerModal" class="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40" @click.self="showLedger = false">
      <div class="bg-surface-container-low rounded-xl p-lg w-[860px] max-h-[90vh] overflow-y-auto flex flex-col gap-md">
        <h4 class="text-title-md font-bold">{{ t('ssh.ledger') }}</h4>
        <ServerLedgerPanel />
        <div class="flex justify-end">
          <button @click="showLedger = false" class="px-lg py-sm rounded-lg border text-body-sm">{{ t('common.close') }}</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 3: 回归验证**

Run: `npx vitest run src/views src/components/ssh`
Expected: 无 FAIL(既有用例不受影响;若个别用例引用了被删的 ledgerDraft 行为,按面板测试口径修正该用例)。

- [ ] **Step 4: Commit**

```bash
git add src/views/WorkbenchServers.vue
git commit -m "refactor(ssh): 服务器台账弹窗改包 ServerLedgerPanel——消重,数据单源后端"
```

---

### Task 4: 知识 tab 两区(WorkbenchLedger 改造)

**Files:**
- Modify: `src/views/WorkbenchLedger.vue`
- Modify: `src/locales/zh.json`、`src/locales/en.json`(`workbench.ledger` 块加 2 键)

**Interfaces:**
- Consumes: Task 2 的 `ServerLedgerPanel`;`useAuthStore`(`auth.isAdmin`,文件已引入 auth store)。
- Produces: 知识 tab =「集群台账 | 服务器台账」两区;键 `workbench.ledger.sectionCluster`/`sectionServers`。Task 6 的 Shell 更名依赖本任务的组件行为不变。

- [ ] **Step 1: i18n 键**

`workbench.ledger` 块(zh):

```json
"sectionCluster": "集群台账",
"sectionServers": "服务器台账",
```

(en):

```json
"sectionCluster": "Cluster ledger",
"sectionServers": "Server ledger",
```

- [ ] **Step 2: script 增量**

import 区加 `import ServerLedgerPanel from '@/components/ssh/ServerLedgerPanel.vue'`;`const auth = useAuthStore()` 已有,再加:

```js
// 双域化(2026-08-29):知识 tab 两区——集群台账(原内容)+ 服务器台账(ServerLedgerPanel)。
const section = ref('cluster')
```

- [ ] **Step 3: template 增量**

根 `<section>` 内、头部 `div.flex.items-center.justify-between` 之后插入分段控件(仅 admin 见双选项):

```html
    <div v-if="auth.isAdmin" class="flex gap-xs">
      <button data-test="sectionCluster" @click="section = 'cluster'"
        class="flex items-center gap-xs px-md py-sm rounded-lg text-body-sm transition-all"
        :class="section === 'cluster' ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container'">
        <span class="material-symbols-outlined text-sm">hub</span>{{ t('workbench.ledger.sectionCluster') }}</button>
      <button data-test="sectionServers" @click="section = 'servers'"
        class="flex items-center gap-xs px-md py-sm rounded-lg text-body-sm transition-all"
        :class="section === 'servers' ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container'">
        <span class="material-symbols-outlined text-sm">dns</span>{{ t('workbench.ledger.sectionServers') }}</button>
    </div>
```

将其后全部现有内容——`v-if="loading"` div、`<template v-else-if="ledger">` 块——包进 `<template v-if="section === 'cluster'"> ... </template>`(蒸馏 diff 的 `<Modal>` 保持在包裹之外、`</section>` 之前,其显隐由 `distillResult` 控制,不受切区影响);紧随包裹之后加:

```html
    <ServerLedgerPanel v-if="section === 'servers'" />
```

- [ ] **Step 4: 门禁 + 回归**

Run: `npm run i18n:check && npx vitest run src/views/__tests__ src/components/ssh`
Expected: i18n:check 通过;无 FAIL。

- [ ] **Step 5: Commit**

```bash
git add src/views/WorkbenchLedger.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(workbench): 知识 tab 双区——集群台账+服务器台账(面板复用,服务器区 admin-only)"
```

---

### Task 5: presence 配置迁入 AiBehaviorConfig

**Files:**
- Modify: `src/views/admin/AiBehaviorConfig.vue`(script 加 presence 逻辑;template 加卡片)
- Modify: `src/locales/zh.json`、`src/locales/en.json`(`admin.aiBehavior` 块加 6 键)
- Create: `src/views/admin/__tests__/AiBehaviorConfig.presence.test.js`
- Delete: `src/views/__tests__/WorkbenchConfig.presence.test.js`

**Interfaces:**
- Consumes: `adminApi.presenceConfig.get(): Promise<{maxItems,windowMin}>`、`adminApi.presenceConfig.save({maxItems,windowMin})`(端点不变)。
- Produces: AiBehaviorConfig 页新卡片,`data-testid="presence-max"/"presence-window"/"presence-save"`;键 `admin.aiBehavior.presence*`。Task 6 删除旧 WorkbenchConfig 后,这是 presence 唯一编辑入口。

- [ ] **Step 1: 写失败测试(新文件)**

```js
// AiBehaviorConfig「悬浮对话入口」卡片(自 WorkbenchConfig 迁入,2026-08-29 双域化):
// 读配置回填;保存带输入值;读取失败兜底默认 5/30。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AiBehaviorConfig from '@/views/admin/AiBehaviorConfig.vue'
import { adminApi } from '@/api/client'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  adminApi: {
    workbenchAiConfig: { get: vi.fn(), save: vi.fn() },
    presenceConfig: { get: vi.fn(), save: vi.fn(async () => ({ ok: true })) },
  },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

const FIXTURE = { additionalInstructions: '', disabledTools: [], toolCatalog: [], effectivePreview: '' }

beforeEach(() => {
  vi.clearAllMocks()
  adminApi.workbenchAiConfig.get.mockResolvedValue(FIXTURE)
  adminApi.presenceConfig.get.mockResolvedValue({ maxItems: 8, windowMin: 45 })
})

const mountCfg = async () => {
  const w = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  return w
}

test('读配置回填两个输入', async () => {
  const w = await mountCfg()
  const inputs = w.findAll('input[type="number"]')
  expect(inputs.length).toBe(2)
  expect(inputs[0].element.value).toBe('8')
  expect(inputs[1].element.value).toBe('45')
})

test('修改后保存:带当前输入值调 save', async () => {
  const w = await mountCfg()
  await w.findAll('input[type="number"]')[0].setValue('12')
  await w.find('[data-testid="presence-save"]').trigger('click')
  await flushPromises()
  expect(adminApi.presenceConfig.save).toHaveBeenCalledWith({ maxItems: 12, windowMin: 45 })
})

test('读取失败 → 回默认 5/30 不炸', async () => {
  adminApi.presenceConfig.get.mockRejectedValueOnce(new Error('403'))
  const w = await mountCfg()
  const inputs = w.findAll('input[type="number"]')
  expect(inputs[0].element.value).toBe('5')
  expect(inputs[1].element.value).toBe('30')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/admin/__tests__/AiBehaviorConfig.presence.test.js`
Expected: FAIL(页面无 `input[type=number]`、无 `presence-save`)。

- [ ] **Step 3: 实现页面**

`AiBehaviorConfig.vue` script:import 区补 `adminApi.presenceConfig` 无需(已引 adminApi);ref 区加:

```js
// 悬浮对话入口(2026-08-29 自 WorkbenchConfig 迁入):展示条数/隐去时间,保存约 10s 内全端生效。
const presence = ref({ maxItems: 5, windowMin: 30 })
const presenceSaving = ref(false)
async function loadPresence() {
  try {
    const r = await adminApi.presenceConfig.get()
    presence.value = { maxItems: r.maxItems, windowMin: r.windowMin }
  } catch { /* 未配置/异常 → 默认 5/30 */ }
}
async function savePresence() {
  presenceSaving.value = true
  try {
    await adminApi.presenceConfig.save({ maxItems: Number(presence.value.maxItems), windowMin: Number(presence.value.windowMin) })
    notify('success', t('admin.aiBehavior.presenceSaved'))
  } catch { notify('error', t('admin.aiBehavior.presenceSaveFailed')) }
  finally { presenceSaving.value = false }
}
```

`onMounted(load)` 改为 `onMounted(() => { load(); loadPresence() })`。
(兼容性:既有 `AiBehaviorConfig.test.js` 的 mock 只有 `workbenchAiConfig`,`adminApi.presenceConfig.get` 为 undefined → TypeError 被 try/catch 吞掉回默认,该文件用例不受影响。)

template:第一张卡(指令+项目记忆)`</div>` 之后、工具卡之前插入:

```html
      <!-- 悬浮对话入口(2026-08-29 自 WorkbenchConfig 迁入):独立保存端点,与上方主保存按钮互不影响 -->
      <div class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md flex flex-col gap-md">
        <p class="text-label-caps text-on-surface-variant">{{ $t('admin.aiBehavior.presenceTitle') }}</p>
        <div class="flex items-end gap-md flex-wrap">
          <label class="flex flex-col gap-xs">
            <span class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.presenceMaxItems') }}</span>
            <input v-model.number="presence.maxItems" type="number" min="1" max="20" data-testid="presence-max"
              class="w-24 bg-surface-container-low border border-outline-variant rounded px-sm py-xs text-body-sm" />
          </label>
          <label class="flex flex-col gap-xs">
            <span class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.presenceWindowMin') }}</span>
            <input v-model.number="presence.windowMin" type="number" min="1" max="1440" data-testid="presence-window"
              class="w-24 bg-surface-container-low border border-outline-variant rounded px-sm py-xs text-body-sm" />
          </label>
          <button data-testid="presence-save" @click="savePresence" :disabled="presenceSaving"
            class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 disabled:opacity-40">
            {{ $t('common.save') }}</button>
        </div>
        <p class="text-body-xs text-on-surface-variant">{{ $t('admin.aiBehavior.presenceHint') }}</p>
      </div>
```

- [ ] **Step 4: i18n 键(6 个,zh)**

`admin.aiBehavior` 块加(值自 `workbench.config.presence*` 原样迁改,title/hint 按新落点微调):

```json
"presenceTitle": "悬浮对话入口",
"presenceMaxItems": "展示条数",
"presenceWindowMin": "隐去时间(分钟)",
"presenceHint": "运行中/待审批对话常驻;终态对话超过隐去时间无动态后不再显示。保存后约 10 秒内全端生效。",
"presenceSaved": "悬浮对话配置已保存",
"presenceSaveFailed": "悬浮对话配置保存失败",
```

(en):

```json
"presenceTitle": "Floating Chat",
"presenceMaxItems": "Items shown",
"presenceWindowMin": "Hide after (min)",
"presenceHint": "Running/paused conversations stay; terminal ones drop after the window with no activity. Takes effect within ~10s after saving.",
"presenceSaved": "Floating chat config saved",
"presenceSaveFailed": "Failed to save floating chat config",
```

- [ ] **Step 5: 迁移测试文件并回归**

```bash
git rm src/views/__tests__/WorkbenchConfig.presence.test.js
```

Run: `npx vitest run src/views/admin/__tests__ && npm run i18n:check`
Expected: 新 presence 3 用例 + 既有 AiBehaviorConfig 用例全 PASS;i18n:check 通过(旧 workbench.config.presence* 键此刻**不删**,Task 6 与视图一起删)。

- [ ] **Step 6: Commit**

```bash
git add -A src/views/admin src/locales/zh.json src/locales/en.json
git commit -m "refactor(workbench): 悬浮对话配置迁入 admin AI 行为配置页——配置 tab 拆散第一步"
```

---

### Task 6: Shell 重排为四 tab + 配置 tab 消失

**Files:**
- Modify: `src/views/WorkbenchShell.vue`
- Delete: `src/views/WorkbenchConfig.vue`
- Modify: `src/locales/zh.json`、`src/locales/en.json`(shell 块:删 `tabConfig`/`tabGlobal`、加 `tabKnowledge`;删整个 `workbench.config` 块)
- Create: `src/views/__tests__/WorkbenchShell.tabs.test.js`

**Interfaces:**
- Consumes: Task 4 的知识 tab(`activeTab` 键 `knowledge` 时渲染 `WorkbenchLedger`);`useAuthStore.isAdmin`。
- Produces: 四 tab `projects/servers/knowledge/records`(顺序即此);`workbench.shell.tabKnowledge` 键。

- [ ] **Step 1: 写失败测试**

```js
// WorkbenchShell 四 tab(2026-08-29 双域化):项目/服务器(admin)/知识/记录;配置与全局不复存在。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { i18n } from '@/i18n'

vi.mock('@/views/WorkbenchProjects.vue', () => ({ default: { template: '<div data-test-stub="projects" />' } }))
vi.mock('@/views/WorkbenchLedger.vue', () => ({ default: { template: '<div data-test-stub="ledger" />' } }))
vi.mock('@/views/WorkbenchRecords.vue', () => ({ default: { template: '<div data-test-stub="records" />' } }))
vi.mock('@/views/WorkbenchServers.vue', () => ({ default: { template: '<div data-test-stub="servers" />' } }))
import WorkbenchShell from '@/views/WorkbenchShell.vue'

function mountShell(role) {
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.user = role === 'admin' ? { role: 'admin' } : null
  return mount(WorkbenchShell, { global: { plugins: [pinia, i18n] } })
}
const tabTexts = w => w.findAll('button').map(b => b.text()).join('|')

test('admin:恰好四 tab(项目/服务器/知识/记录),配置与全局消失', () => {
  const w = mountShell('admin')
  const txt = tabTexts(w)
  for (const name of ['项目', '服务器', '知识', '记录']) expect(txt).toContain(name)
  expect(txt).not.toContain('配置')
  expect(txt).not.toContain('全局')
})

test('非 admin:无服务器 tab,只余三个', () => {
  const w = mountShell('user')
  const txt = tabTexts(w)
  expect(txt).not.toContain('服务器')
  expect(txt).toContain('知识')
})

test('默认项目 tab;点知识渲染 WorkbenchLedger(键改名后接线正确)', async () => {
  const w = mountShell('admin')
  expect(w.find('[data-test-stub="projects"]').exists()).toBe(true)
  await w.findAll('button').find(b => b.text() === '知识').trigger('click')
  expect(w.find('[data-test-stub="ledger"]').exists()).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/WorkbenchShell.tabs.test.js`
Expected: FAIL(现五 tab,含 配置/全局,无 知识)。

- [ ] **Step 3: 实现 Shell**

`WorkbenchShell.vue` script 整体替换为:

```js
// 工作台 shell(2026-08-29 双域化):四 tab——项目(集群域工作单元)/服务器(服务器域,admin)/
// 知识(跨域知识:集群台账+服务器台账)/记录(跨域记录)。tab 为组件内状态,无路由影响。
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import WorkbenchProjects from './WorkbenchProjects.vue'
import WorkbenchLedger from './WorkbenchLedger.vue'
import WorkbenchRecords from './WorkbenchRecords.vue'
import WorkbenchServers from './WorkbenchServers.vue'

const router = useRouter()
const { t } = useI18n()
const auth = useAuthStore()
const activeTab = ref('projects')
const tabs = computed(() => [
  { key: 'projects', label: t('workbench.shell.tabProjects'), icon: 'folder' },
  ...(auth.isAdmin ? [{ key: 'servers', label: t('workbench.shell.tabServers'), icon: 'dns' }] : []),
  { key: 'knowledge', label: t('workbench.shell.tabKnowledge'), icon: 'menu_book' },
  { key: 'records', label: t('workbench.shell.tabRecords'), icon: 'history' },
])
```

template:`<WorkbenchConfig v-else-if="activeTab === 'config'" />` 行删除;`<WorkbenchLedger v-else-if="activeTab === 'global'" />` 改 `activeTab === 'knowledge'`。import/模板中 WorkbenchConfig 引用全部清除。

- [ ] **Step 4: 删除 WorkbenchConfig.vue + i18n 清理**

```bash
git rm src/views/WorkbenchConfig.vue
```

zh.json/en.json:`workbench.shell` 删 `tabConfig`/`tabGlobal`,加 `"tabKnowledge": "知识"` / `"tabKnowledge": "Knowledge"`;删除整个 `workbench.config` 块(presence 键已迁 `admin.aiBehavior.presence*`)。

- [ ] **Step 5: 全量回归 + 门禁**

Run: `npx vitest run && npm run i18n:check`
Expected: 全 PASS;i18n:check 通过。

- [ ] **Step 6: Commit**

```bash
git add -A src/views src/locales/zh.json src/locales/en.json
git commit -m "feat(workbench): 导航双域化——四 tab(项目/服务器/知识/记录),配置 tab 拆散后删除"
```

---

### Task 7: 记录页服务器卡 + 审计来源筛选

**Files:**
- Modify: `src/views/WorkbenchRecords.vue`
- Modify: `src/locales/zh.json`、`src/locales/en.json`(`workbench.records` 块加 8 键、删 `auditHint`)
- Create: `src/views/__tests__/WorkbenchRecords.audit-source.test.js`

**Interfaces:**
- Consumes: Task 1 的 `toolPrefix`;`sshApi.list(): Promise<{servers:[{exposeToAi}]}>`;`adminApi.auditTrail.list(params)`;审计行字段 `a.source`('workbench'|'platform')。
- Produces: 统计卡 4→5(admin 第 5 卡);`data-testid="audit-source"` 下拉,三口径 `workbench|platform|all`。

- [ ] **Step 1: 写失败测试**

```js
// WorkbenchRecords 双域化:admin 服务器统计卡 + 审计来源三口径(workbench/platform+toolPrefix/all)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  workbenchApi: { records: vi.fn() },
  adminApi: { auditTrail: { list: vi.fn() } },
  sshApi: { list: vi.fn() },
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
import { workbenchApi, adminApi, sshApi } from '@/api/client'
import WorkbenchRecords from '@/views/WorkbenchRecords.vue'

const RECORDS = { counts: { conversations: 1, messages: 2, aiToolCalls: 3, projects: 1 }, storage: null, conversations: [] }
const AUDITS = { items: [{ seq: 1, ts: Date.now(), tool: 'ssh_sftp', resource: 'server=s1', result: 'ok', source: 'platform' }] }

beforeEach(() => {
  vi.clearAllMocks()
  workbenchApi.records.mockResolvedValue(RECORDS)
  adminApi.auditTrail.list.mockResolvedValue(AUDITS)
  sshApi.list.mockResolvedValue({ servers: [{ exposeToAi: true }, { exposeToAi: false }] })
})

function mountRecords(role) {
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.user = role === 'admin' ? { role: 'admin' } : null
  return mount(WorkbenchRecords, { global: { plugins: [pinia, i18n] } })
}

test('admin:第 5 卡服务器总数/暴露数;默认审计口径 workbench', async () => {
  const w = mountRecords('admin')
  await flushPromises()
  expect(sshApi.list).toHaveBeenCalled()
  expect(w.text()).toContain('2')            // 总数
  expect(w.text()).toContain('1')            // 暴露数
  expect(adminApi.auditTrail.list).toHaveBeenCalledWith(expect.objectContaining({ source: 'workbench' }))
})

test('切换来源=服务器人工操作:带 source=platform+toolPrefix=ssh,行标「人工」', async () => {
  const w = mountRecords('admin')
  await flushPromises()
  adminApi.auditTrail.list.mockClear()
  await w.find('[data-testid="audit-source"]').setValue('platform')
  await flushPromises()
  expect(adminApi.auditTrail.list).toHaveBeenCalledWith({ size: 30, source: 'platform', toolPrefix: 'ssh' })
  expect(w.text()).toContain('人工')
})

test('非 admin:不发 SSH 请求,统计卡 4 张', async () => {
  const w = mountRecords('user')
  await flushPromises()
  expect(sshApi.list).not.toHaveBeenCalled()
  expect(w.findAll('.grid > div').length).toBe(4)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/WorkbenchRecords.audit-source.test.js`
Expected: FAIL(无服务器卡/无 `audit-source` 下拉)。

- [ ] **Step 3: 实现**

script 增量:

```js
import { useAuthStore } from '@/stores/auth'
const auth = useAuthStore()
// 双域化(2026-08-29):服务器统计卡(admin)+ 审计来源三口径。
const serverStats = ref(null)          // { total, exposed }
const auditSource = ref('workbench')   // workbench | platform | all
async function loadAudits() {
  try {
    const params = { size: 30 }
    if (auditSource.value === 'workbench') params.source = 'workbench'
    else if (auditSource.value === 'platform') { params.source = 'platform'; params.toolPrefix = 'ssh' }
    const r = await adminApi.auditTrail.list(params)
    audits.value = r.items || []
  } catch { /* 审计明细失败不阻塞整页 */ }
}
```

`load()` 内:原 `try { const r = await adminApi.auditTrail.list({ source: 'workbench', size: 30 }); audits.value = r.items || [] } catch {}` 整段替换为 `await loadAudits()`,其后追加:

```js
    if (auth.isAdmin) {
      try {
        const r = await sshApi.list()
        const ss = r.servers || []
        serverStats.value = { total: ss.length, exposed: ss.filter(s => s.exposeToAi).length }
      } catch { serverStats.value = null }
    }
```

template 增量——统计卡 grid 行改:

```html
    <div class="grid grid-cols-2 gap-sm" :class="auth.isAdmin ? 'lg:grid-cols-5' : 'lg:grid-cols-4'">
```

第 4 张卡(projects)之后加:

```html
      <div v-if="auth.isAdmin" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
        <p class="text-label-caps text-on-surface-variant">{{ t('workbench.records.statServers') }}</p>
        <p class="text-headline-md font-bold text-on-surface mt-xs">{{ serverStats ? serverStats.total : '—' }}</p>
        <p class="text-body-xs text-on-surface-variant mt-xs">{{ t('workbench.records.statServersExposed', { n: serverStats?.exposed ?? 0 }) }}</p>
      </div>
```

审计区头部(`auditTitle` span 之后)把原 `ml-auto` 的 hint span 替换为来源筛选:

```html
        <label class="flex items-center gap-xs ml-auto">
          <span class="text-body-xs text-on-surface-variant">{{ t('workbench.records.auditSourceLabel') }}</span>
          <select data-testid="audit-source" v-model="auditSource" @change="loadAudits"
            class="bg-surface-container-low border border-outline-variant rounded px-sm py-xs text-body-xs">
            <option value="workbench">{{ t('workbench.records.auditSourceAi') }}</option>
            <option value="platform">{{ t('workbench.records.auditSourceSsh') }}</option>
            <option value="all">{{ t('workbench.records.auditSourceAll') }}</option>
          </select>
        </label>
```

审计行 `a.tool` span 之前加来源标签:

```html
          <span class="px-1.5 py-0.5 rounded text-body-xs shrink-0"
            :class="a.source === 'workbench' ? 'bg-primary-container/40 text-primary' : 'bg-surface-container-high text-on-surface-variant'">
            {{ a.source === 'workbench' ? t('workbench.records.auditRowAi') : t('workbench.records.auditRowManual') }}</span>
```

- [ ] **Step 4: i18n 键(zh)**

`workbench.records` 块加(删 `auditHint`):

```json
"statServers": "服务器",
"statServersExposed": "暴露 AI {n} 台",
"auditSourceLabel": "来源",
"auditSourceAi": "工作台 AI",
"auditSourceSsh": "服务器人工操作",
"auditSourceAll": "全部",
"auditRowAi": "AI",
"auditRowManual": "人工",
```

(en):

```json
"statServers": "Servers",
"statServersExposed": "{n} AI-exposed",
"auditSourceLabel": "Source",
"auditSourceAi": "Workbench AI",
"auditSourceSsh": "Manual server ops",
"auditSourceAll": "All",
"auditRowAi": "AI",
"auditRowManual": "Manual",
```

- [ ] **Step 5: 回归 + 门禁**

Run: `npx vitest run src/views/__tests__ && npm run i18n:check`
Expected: 全 PASS;i18n:check 通过。

- [ ] **Step 6: Commit**

```bash
git add -A src/views src/locales/zh.json src/locales/en.json
git commit -m "feat(workbench): 记录页双域化——服务器统计卡(admin)+ 审计三口径(AI/服务器人工/全部)"
```

---

### Task 8: 收尾门禁与验收对照

**Files:** 无新改动(纯验证;发现问题回到对应任务修)

- [ ] **Step 1: 全量单测**

Run: `npx vitest run && node --test server/audit.test.mjs && node --test server/ssh/routes.test.mjs`
Expected: 全 PASS。

- [ ] **Step 2: 门禁**

Run: `npm run i18n:check && npm run typecheck`
Expected: 双绿。

- [ ] **Step 3: 验收标准逐条对照(spec §7)**

1. 四 tab 且 admin/非 admin 可见性正确 → Task 6 测试覆盖;
2. 两台账编辑同源 → Task 2/3/4 代码走查(同一面板 + 同一端点);
3. 记录页三口径 → Task 1 + Task 7 测试覆盖;
4. AiBehaviorConfig presence 可读存 → Task 5 测试覆盖;
5. 非 admin 无 SSH 报错面 + 门禁全绿 → Task 6/7 测试 + Step 1/2。
   任何一条无对应证据 → 回对应任务补齐后再提交。

- [ ] **Step 4: Commit(如有收尾修正)并汇报**

```bash
git add -A && git commit -m "chore(workbench): 双域化收尾——门禁与验收对照"
```

真机手测按 spec §9 清单延后(需集群/LLM 环境),不阻塞本计划完成。

---

## 任务依赖

Task 1 独立;Task 2 → Task 3、Task 4;Task 5 独立(但须先于 Task 6);Task 6 依赖 Task 4/5;Task 7 依赖 Task 1;Task 8 最后。并行可行分组:{1,2,5,7-prep} → {3,4} → {6,7} → 8。
