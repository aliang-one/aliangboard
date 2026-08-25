# 工具调用详情 Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 对话里的工具 chips 点击改为弹出详情 Modal(参数 + 摘要/原始结果双视图 + 复制),事件补时间戳。

**Architecture:** fmtResult 系列从 ToolTrace.vue 抽到纯函数共享模块(行为零变更)→ 新 ToolCallModal 复用 Modal 壳 → ToolTrace 点击入口替换(移除就地展开)→ agent.mjs 四处 onStep 补 `ts`。纯前端 + 服务端一行类改动,零新端点、零新依赖。

**Tech Stack:** Vue 3 + vue-i18n(双语)、vitest + @vue/test-utils、node --test(活体回归)。

**Spec:** `docs/superpowers/specs/2026-08-25-toolcall-detail-modal-design.md`

## Global Constraints

- 仓库**不新增外部依赖**
- i18n 双语同步:zh/en 键对齐,`npm run i18n:check` 绿
- 组件测试:vitest + `mount` + 真 `i18n` 插件(`@/i18n`);遵循 `src/components/workbench/__tests__/ToolTrace.test.js` 现有惯例
- 服务端测试:活体法(mock LLM+mock K8s+真网关子进程),文件 `server/wb-podlogs-roundtrip.test.mjs`
- `docs/superpowers/` 提交须 `git add -f`
- 当前分支:`feat-toolcall-detail-modal`(worktree `.claude/worktrees/fix-apikey-ns-allowlist`)

---

### Task 1: 抽 toolResultFormat.js 共享模块(行为零变更)

**Files:**
- Create: `src/utils/toolResultFormat.js`
- Modify: `src/components/workbench/ToolTrace.vue`(script 删除被抽函数,改 import)
- Test: `src/utils/__tests__/toolResultFormat.test.js`(新建)

**Interfaces:**
- Consumes: ToolTrace.vue 现有函数 `fmtResult(ev)` 及 fmtDescribe/fmtList/fmtRollout/fmtExec/fmtPodFile/fmtTop(约 34-146 行,逐字)
- Produces: `import { fmtResult } from '@/utils/toolResultFormat'`——`fmtResult(ev)` 签名不变:`(ev: {name?: string, result?: any}) => string`

- [ ] **Step 1: 写失败测试(先固化现行为)**

```js
// src/utils/__tests__/toolResultFormat.test.js
// fmtResult 搬迁回归:断言与 ToolTrace 时代逐字一致的行为(搬迁前固化)。
import { test, expect } from 'vitest'
import { fmtResult } from '@/utils/toolResultFormat'

test('string 结果原样返回', () => {
  expect(fmtResult({ name: 'wb_get_pod_logs', result: 'raw text' })).toBe('raw text')
})

test('wb_get_pod_logs:取 r.logs', () => {
  expect(fmtResult({ name: 'wb_get_pod_logs', result: { logs: 'line1\nline2', tail: 200 } })).toBe('line1\nline2')
})

test('wb_describe_resource:kind/name + phase', () => {
  const out = fmtResult({ name: 'wb_describe_resource', result: { resource: { kind: 'Pod', metadata: { name: 'p1', namespace: 'ns1' }, status: { phase: 'Running' } }, events: { count: 0, items: [] } } })
  expect(out).toContain('Pod/p1 (ns1)')
  expect(out).toContain('phase: Running')
})

test('wb_top:百分比行 + ≥80% 带 ⚠', () => {
  const out = fmtResult({ name: 'wb_top', result: { scope: 'pods', namespace: 'ns1', items: [{ name: 'p1', containers: [{ name: 'c1', cpu: '100m', memory: '1Gi', cpuPct: 95, memoryPct: 50 }] }] } })
  expect(out).toContain('p1/c1')
  expect(out).toContain('cpu 95% ⚠')
  expect(out).toContain('mem 50%')
})

test('未知工具对象结果:JSON pretty 兜底', () => {
  expect(fmtResult({ name: 'wb_unknown', result: { a: 1 } })).toBe(JSON.stringify({ a: 1 }, null, 2))
})

test('result null:空串', () => {
  expect(fmtResult({ name: 'wb_get_pod_logs', result: null })).toBe('')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/__tests__/toolResultFormat.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 搬迁实现**

新建 `src/utils/toolResultFormat.js`:把 ToolTrace.vue 里的 `fmtResult`、`fmtDescribe`、`fmtList`、`fmtRollout`、`fmtExec`、`fmtPodFile`、`fmtTop` 七个函数**逐字剪切**过来,文件头:

```js
// 工具调用结果的智能格式化(纯函数,零组件依赖):ToolTrace chips 与 ToolCallModal 共享。
// 行为与 2026-08-25 前 ToolTrace.vue 内联版逐字一致(搬迁,非重写)。
export function fmtResult(ev) { /* 逐字 */ }
export function fmtDescribe(r) { /* 逐字 */ }
export function fmtList(r) { /* 逐字 */ }
export function fmtRollout(r) { /* 逐字 */ }
export function fmtExec(r) { /* 逐字 */ }
export function fmtPodFile(r) { /* 逐字 */ }
export function fmtTop(r) { /* 逐字 */ }
```

ToolTrace.vue script 改为 `import { fmtResult } from '@/utils/toolResultFormat'`,删除被搬函数(仅保留组件自身状态);`<pre>` 展开仍在用 fmtResult——本任务**不动模板**,行为零变更。

- [ ] **Step 4: 双重验证**

Run: `npx vitest run src/utils/__tests__/toolResultFormat.test.js src/components/workbench/__tests__/ToolTrace.test.js`
Expected: 新 6 例 PASS + ToolTrace 现有 6 例 PASS(搬迁无行为变更)

- [ ] **Step 5: 提交**

```bash
git add src/utils/toolResultFormat.js src/utils/__tests__/toolResultFormat.test.js src/components/workbench/ToolTrace.vue
git commit -m "refactor(ui): fmtResult 系列抽 src/utils/toolResultFormat.js(行为零变更,为 ToolCallModal 共享)"
```

---

### Task 2: agent.mjs onStep 事件补 ts

**Files:**
- Modify: `server/agent.mjs:104,110,115,132`(四处 onStep)
- Test: `server/wb-podlogs-roundtrip.test.mjs`(追加断言)

**Interfaces:**
- Produces: trace 事件新增 `ts: number`(epoch ms)——旧事件无 ts,前端显示 `—`,不迁移

- [ ] **Step 1: 追加失败断言**

在 `server/wb-podlogs-roundtrip.test.mjs` 第一个测试(已断言消息级 trace 含工具事件处)追加:

```js
    assert.ok(msgTrace.some(e => e.type === 'tool' && typeof e.ts === 'number'), '工具事件须带 ts 时间戳')
```

- [ ] **Step 2: 跑确认失败**

Run: `node --test server/wb-podlogs-roundtrip.test.mjs`
Expected: 第一个测试 FAIL(无 ts)

- [ ] **Step 3: 实现**

server/agent.mjs 四处逐个加 `ts: Date.now()`:

```js
          onStep?.({ type: 'denied', name, args, ts: Date.now() })
        onStep?.({ type: 'tool_start', name, args, ts: Date.now() })
        onStep?.({ type: 'tool', name, args, result, ts: Date.now() })
      onStep?.({ type: 'assistant', message: assistant, ts: Date.now() })
```

- [ ] **Step 4: 跑确认通过 + 相关回归**

Run: `node --test server/wb-podlogs-roundtrip.test.mjs && node --test server/agent.test.mjs server/workbench-agent.test.mjs`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add server/agent.mjs server/wb-podlogs-roundtrip.test.mjs
git commit -m "feat(workbench): 工具调用事件补 ts 时间戳(详情 Modal 头部展示;存量事件显示 —)"
```

---

### Task 3: ToolCallModal 组件 + i18n

**Files:**
- Create: `src/components/workbench/ToolCallModal.vue`
- Modify: `src/locales/zh.json` / `src/locales/en.json`(workbench 块内加 `toolCall` 子块)
- Test: `src/components/workbench/__tests__/ToolCallModal.test.js`

**Interfaces:**
- Consumes: Task 1 的 `fmtResult`;`@/components/common/Modal.vue`(props: modelValue/title/width);`@/composables/useToast` 的 `notify`
- Produces: `<ToolCallModal v-model="show" :event="ev" />`;event 形状 `{type:'tool'|'denied'|'tool_start', name?: string, args?: object, result?: any, ts?: number}`

- [ ] **Step 1: 写失败测试**

```js
// src/components/workbench/__tests__/ToolCallModal.test.js
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

const notifyMock = vi.fn()
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))

import ToolCallModal from '@/components/workbench/ToolCallModal.vue'

beforeEach(() => { notifyMock.mockClear(); Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } }) })

const mountM = (event) => mount(ToolCallModal, { props: { modelValue: true, event }, global: { plugins: [i18n] } })

test('tool 事件:头部工具名+ts、参数 JSON、摘要 tab 默认', () => {
  const w = mountM({ type: 'tool', name: 'wb_get_pod_logs', args: { namespace: 'ns1', pod: 'p1' }, result: { logs: 'err line' }, ts: 1756100000000 })
  expect(w.html()).toContain('wb_get_pod_logs')
  expect(w.html()).toContain('"namespace": "ns1"')
  expect(w.html()).toContain('err line')
})

test('原始 tab:完整 JSON 可切换', async () => {
  const w = mountM({ type: 'tool', name: 'wb_describe_resource', args: {}, result: { resource: { kind: 'Pod' } } })
  await w.findAll('button').find(b => b.text().includes(i18n.global.t('workbench.toolCall.rawTab'))).trigger('click')
  expect(w.html()).toContain('"kind": "Pod"')
})

test('denied:显示拒绝提示;无 ts 显示 —', () => {
  const w = mountM({ type: 'denied', name: 'wb_exec', args: { cmd: 'ls' } })
  expect(w.html()).toContain(i18n.global.t('workbench.toolCall.denied'))
  expect(w.html()).toContain('—')
})

test('复制:clipboard.writeText 收到当前 tab 内容', async () => {
  const w = mountM({ type: 'tool', name: 'wb_get_pod_logs', args: { pod: 'p' }, result: { logs: 'L1' } })
  await w.findAll('button').find(b => b.text().includes(i18n.global.t('common.copy'))).trigger('click')
  expect(navigator.clipboard.writeText).toHaveBeenCalled()
  expect(notifyMock).toHaveBeenCalled()
})

test('超大结果截断提示', () => {
  const big = 'x'.repeat(70 * 1024)
  const w = mountM({ type: 'tool', name: 'wb_get_pod_logs', args: {}, result: { logs: big } })
  expect(w.html()).toContain(i18n.global.t('workbench.toolCall.truncated'))
})
```

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run src/components/workbench/__tests__/ToolCallModal.test.js`
Expected: FAIL(组件不存在)

- [ ] **Step 3: 实现组件(全文)**

```vue
<script setup>
// 工具调用详情 Modal:chips 点击进入。参数 JSON + 结果双视图(摘要=fmtResult 智能格式化 / 原始=完整 JSON)+
// 复制;denied/tool_start 分型;ts 缺失(存量事件)显示 —。数据全部来自对话 trace,无新端点。
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'
import { fmtResult } from '@/utils/toolResultFormat'
import { notify } from '@/composables/useToast'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  event: { type: Object, default: null },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()
const tab = ref('summary')            // 'summary' | 'raw'
const RAW_MAX = 64 * 1024

const argsJson = computed(() => props.event?.args && Object.keys(props.event.args || {}).length ? JSON.stringify(props.event.args, null, 2) : '')
const summaryText = computed(() => props.event?.type === 'tool' ? fmtResult(props.event) : '')
const rawText = computed(() => {
  const r = props.event?.result
  if (r == null) return ''
  const s = typeof r === 'string' ? r : JSON.stringify(r, null, 2)
  return s.length > RAW_MAX ? s.slice(0, RAW_MAX) : s
})
const truncated = computed(() => {
  const r = props.event?.result
  if (r == null) return false
  const s = typeof r === 'string' ? r : JSON.stringify(r, null, 2)
  return s.length > RAW_MAX
})
const tsText = computed(() => props.event?.ts ? new Date(props.event.ts).toLocaleString() : t('workbench.toolCall.noTs'))
const currentText = computed(() => tab.value === 'raw' ? rawText.value : (summaryText.value || rawText.value))

async function copy() {
  try { await navigator.clipboard.writeText(currentText.value); notify('success', t('workbench.toolCall.copied')) }
  catch { notify('error', t('workbench.toolCall.copyFailed')) }
}
</script>
<template>
  <Modal :model-value="modelValue" :title="t('workbench.toolCall.title')" width="max-w-2xl" @update:model-value="v => emit('update:modelValue', v)">
    <div v-if="event" class="flex flex-col gap-md">
      <div class="flex items-center gap-sm">
        <span class="inline-block w-2 h-2 rounded-full" :class="event.type === 'denied' ? 'bg-status-warning' : event.type === 'tool_start' ? 'bg-status-running animate-pulse' : 'bg-status-running'"></span>
        <span class="font-mono font-semibold text-body-sm">{{ event.name }}</span>
        <span class="text-body-xs text-on-surface-variant ml-auto font-mono">{{ tsText }}</span>
      </div>
      <div>
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ t('workbench.toolCall.args') }}</p>
        <pre v-if="argsJson" data-testid="tc-args" class="font-mono text-body-xs bg-[#0b1c30] text-[#cfe3ff] border border-outline-variant/30 rounded-lg p-sm max-h-40 overflow-y-auto whitespace-pre-wrap break-all">{{ argsJson }}</pre>
        <p v-else class="text-body-xs text-on-surface-variant/60">{{ t('workbench.toolCall.noArgs') }}</p>
      </div>
      <div>
        <div class="flex items-center gap-sm mb-xs">
          <p class="text-body-xs text-on-surface-variant">{{ t('workbench.toolCall.result') }}</p>
          <div class="flex gap-xs ml-2">
            <button type="button" @click="tab = 'summary'" :class="['px-sm py-0.5 rounded-full text-body-xs border', tab === 'summary' ? 'border-primary/40 text-primary bg-primary/5' : 'border-outline-variant text-on-surface-variant']">{{ t('workbench.toolCall.summaryTab') }}</button>
            <button type="button" @click="tab = 'raw'" :class="['px-sm py-0.5 rounded-full text-body-xs border', tab === 'raw' ? 'border-primary/40 text-primary bg-primary/5' : 'border-outline-variant text-on-surface-variant']">{{ t('workbench.toolCall.rawTab') }}</button>
          </div>
          <button type="button" class="ml-auto flex items-center gap-xs text-body-xs text-primary hover:opacity-80" @click="copy">
            <span class="material-symbols-outlined text-sm">content_copy</span>{{ t('common.copy') }}
          </button>
        </div>
        <p v-if="event.type === 'denied'" class="text-body-xs text-status-warning bg-status-warning/5 border border-status-warning/30 rounded-lg px-sm py-sm">{{ t('workbench.toolCall.denied') }}</p>
        <p v-else-if="event.type === 'tool_start'" class="text-body-xs text-status-running flex items-center gap-xs px-sm"><span class="material-symbols-outlined text-sm animate-spin">progress_activity</span>{{ t('workbench.toolCall.running') }}</p>
        <template v-else>
          <p v-if="truncated" class="text-body-xs text-status-warning mb-xs">{{ t('workbench.toolCall.truncated') }}</p>
          <pre data-testid="tc-result" class="font-mono text-body-xs bg-[#0b1c30] text-[#cfe3ff] border border-outline-variant/30 rounded-lg p-sm max-h-72 overflow-y-auto whitespace-pre-wrap break-all leading-[18px]">{{ tab === 'raw' ? rawText : (summaryText || rawText) }}</pre>
        </template>
      </div>
    </div>
  </Modal>
</template>
```

zh.json 的 `workbench` 块内(与 `chat` 平级)加:

```json
    "toolCall": {
      "title": "工具调用详情",
      "args": "参数",
      "result": "结果",
      "summaryTab": "摘要",
      "rawTab": "原始",
      "noArgs": "(无参数)",
      "denied": "用户拒绝了该操作",
      "running": "执行中…",
      "noTs": "—",
      "copied": "已复制",
      "copyFailed": "复制失败,请手动选择复制",
      "truncated": "结果超过 64KB,已截断显示(完整内容可复制)"
    },
```

en.json 同位置:

```json
    "toolCall": {
      "title": "Tool Call Detail",
      "args": "Arguments",
      "result": "Result",
      "summaryTab": "Summary",
      "rawTab": "Raw",
      "noArgs": "(no arguments)",
      "denied": "User denied this operation",
      "running": "Running…",
      "noTs": "—",
      "copied": "Copied",
      "copyFailed": "Copy failed, select and copy manually",
      "truncated": "Result exceeds 64KB, truncated (copy for full content)"
    },
```

- [ ] **Step 4: 跑确认通过**

Run: `npx vitest run src/components/workbench/__tests__/ToolCallModal.test.js && npm run i18n:check`
Expected: 5 PASS + i18n 绿

- [ ] **Step 5: 提交**

```bash
git add src/components/workbench/ToolCallModal.vue src/components/workbench/__tests__/ToolCallModal.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(ui): ToolCallModal——工具调用详情弹窗(参数 JSON+摘要/原始双视图+复制+截断保护)"
```

---

### Task 4: ToolTrace 点击接 Modal(移除就地展开)

**Files:**
- Modify: `src/components/workbench/ToolTrace.vue`(script 的 expanded/toggle → selectedEvent;模板 `<pre>` 段删除,挂 ToolCallModal)
- Test: `src/components/workbench/__tests__/ToolTrace.test.js`(改造 2 个用例)

**Interfaces:**
- Consumes: Task 3 的 `<ToolCallModal v-model :event>`

- [ ] **Step 1: 改造测试(先红)**

ToolTrace.test.js 中「点 chip 展开 result,再点收起」改为:

```js
test('ToolTrace: 点 chip 打开详情 Modal(不再就地展开)', async () => {
  const trace = [{ type: 'tool', name: 'wb_get_pod_logs', args: { pod: 'p1' }, result: { logs: 'hello-log' }, ts: 1756100000000 }]
  const w = mount(ToolTrace, { props: { trace }, global: { plugins: [i18n] } })
  await w.findAll('button').find(b => b.text().includes('wb_get_pod_logs')).trigger('click')
  // Modal 渲染(组件不 mock):标题+工具名+参数+结果都在
  expect(w.html()).toContain(i18n.global.t('workbench.toolCall.title'))
  expect(w.html()).toContain('"pod": "p1"')
  expect(w.html()).toContain('hello-log')
  expect(w.find('pre[data-testid="tc-result"]').exists()).toBe(true)
  // 旧的就地展开 pre 不存在
  expect(w.html()).not.toContain('<pre class="font-mono text-body-xs bg-[#0b1c30] text-[#cfe3ff] border border-outline-variant/30 rounded-lg p-sm max-h-48')
})
```

「wb_top result 渲染用量百分比」用例:把「点 chip 展开」后的断言目标从旧 pre 改为点击后 modal 内 `pre[data-testid="tc-result"]` 含 `cpu 95% ⚠`(交互步骤不变,断言容器改 modal;若原用例直接断言 w.html() 亦兼容——保留原断言,追加 data-testid 存在断言)。

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run src/components/workbench/__tests__/ToolTrace.test.js`
Expected: 新用例 FAIL(点击仍是就地展开)

- [ ] **Step 3: 实现**

ToolTrace.vue script:`const expanded = ref(null)` / `toggle` 删除,换:

```js
const selected = ref(null)   // 当前详情 Modal 展示的事件;chips 点击打开(替代就地展开)
function openDetail(ev) { selected.value = ev }
```

import 增加 `import ToolCallModal from './ToolCallModal.vue'`。模板:chips 按钮 `@click="toggle(i)"` → `@click="openDetail(ev)"`;`:class` 中 `expanded === i` 分支删除;文件尾部的 `<pre v-if="expanded !== null ...">...</pre>` 整段替换为:

```html
    <ToolCallModal v-model="showDetail" :event="selected" />
```

script 加 `const showDetail = ref(false)`,`openDetail` 里 `selected.value = ev; showDetail.value = true`。Modal 关闭时(selected 置空由 v-model false 承担,不必清 selected——下次打开覆盖)。

- [ ] **Step 4: 跑确认通过 + 全组件回归**

Run: `npx vitest run src/components/workbench/`
Expected: ToolTrace 改造用例 + 其余全 PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/workbench/ToolTrace.vue src/components/workbench/__tests__/ToolTrace.test.js
git commit -m "feat(ui): ToolTrace chips 点击弹 ToolCallModal 详情(替代就地展开)"
```

---

### Task 5: 全量门禁 + 合并 main

**Files:** 无新文件

- [ ] **Step 1: 门禁**

Run: `npm test`、`npm run typecheck`、`npm run i18n:check`
Expected: 三项全绿

- [ ] **Step 2: 合并**

```bash
cd /home/liang/MyProgram/AiProject/aliangboard
git branch --show-current   # 须 main 且干净;否则停,按 multi-session 防撞流程
git merge --no-ff feat-toolcall-detail-modal -m "Merge branch 'feat-toolcall-detail-modal': 工具调用详情 Modal(参数+双视图结果+复制)"
```

- [ ] **Step 3: 汇报**

改动摘要、测试结果、手测指引(对话里点工具 chip 看 modal;旧对话无 ts 显示 —)。

---

## Self-Review 记录

- Spec 覆盖:共享模块(§1→Task 1)、ts(§3→Task 2)、Modal+i18n(§2/§5→Task 3)、ToolTrace 改造(§4→Task 4)、测试(§6→各 Task+Task 5)——全覆盖;错误处理表各项落在 Task 3 组件代码(noArgs/denied/running/truncated/clipboard catch/noTs)。
- 占位符:无 TBD;fmtResult 搬迁为逐字剪切指令(源行号+目标文件头+导出名均明确),非占位。
- 命名一致性:`fmtResult(ev)`/`toolResultFormat.js`/`ToolCallModal`(v-model+event)/`workbench.toolCall.*`/`tc-args`/`tc-result` 各任务与测试一致;`common.copy` 为既有键(已确认存在于 zh/en)。
