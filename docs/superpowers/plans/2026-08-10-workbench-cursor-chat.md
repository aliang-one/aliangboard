# Workbench Chat Cursor-style 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 WorkbenchChat 从「半 SMS 气泡」升级为 Cursor/Composer 式全宽对话（全宽左对齐排版 + 角色标记/标签/用户底色 + agent 终答 markdown + 工具调用紧凑 chip + 自动增高输入框）。

**Architecture:** 拆出 2 个展示组件（`ChatTurn.vue` / `ToolTrace.vue`）+ 1 个纯函数（`src/logic/markdown.js` 的 `renderMarkdown`），`WorkbenchChat.vue` 瘦身为编排者。`renderMarkdown` 同步返回消毒 HTML（`marked.parse` + `DOMPurify.sanitize`），代码块高亮由 `ChatTurn` 在 `v-html` 后用懒加载的 Prism（镜像 `CodeViewer.vue` 的 `loadPrism`）`highlightAllUnder` 补——避免耦合 marked renderer 版本差异。

**Tech Stack:** Vue 3 `<script setup>` + vue-i18n + Tailwind/M3 token + Material Symbols + JetBrains Mono；markdown：`marked` + `dompurify`（+2 运行时依赖）；高亮：已有 `prismjs`。组件用 vitest（happy-dom + @vue/test-utils）。

**Spec:** `docs/superpowers/specs/2026-08-10-workbench-chat-cursor-style-design.md`

## Global Constraints

- **零新增运行时依赖**（本计划仅 `marked` + `dompurify` 两个例外，Task 1 登记 CLAUDE.md；`prismjs` 已是依赖）。
- **i18n 门禁**：`npm run i18n:check` 必须绿（残存中文 0）。新键值若含字面 `@` 须转义 `{'@'}`（见 memory `i18n-at-sign-escaping`）。
- **复用** M3 token（`surface-container-*` / `on-surface*` / `primary*` / `status-*` / `error`）、Material Symbols、JetBrains Mono、`prismjs`（暗底 `#0b1c30` / `#cfe3ff`，对齐 `CodeViewer.vue`）。
- **测试**：纯逻辑优先 vitest（本计划的 markdown util 用了依赖，不进零依赖运行器）；组件交互/排版以浏览器手测（Task 7）+ 关键逻辑 vitest 覆盖。
- **提交前** `npm test && npm run typecheck && npm run build` 全绿。每 Task 末尾 commit。
- 当前分支 `feat/workbench-cursor-chat`（基于 main `de1c8f9`）。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `package.json` | 登记 `marked` + `dompurify` 依赖 | 改 |
| `CLAUDE.md` | 依赖例外表登记 | 改 |
| `src/logic/markdown.js` | `renderMarkdown(md): string` 同步消毒 HTML | 新 |
| `src/logic/__tests__/markdown.test.js` | markdown util vitest | 新 |
| `src/locales/zh.json` / `en.json` | `workbench.chat.roleYou` / `roleAgent` / `toolDenied` | 改 |
| `src/components/workbench/ToolTrace.vue` | 工具调用 chips（展开 result） | 新 |
| `src/components/workbench/__tests__/ToolTrace.test.js` | ToolTrace vitest | 新 |
| `src/components/workbench/ChatTurn.vue` | 一轮对话行（marker/label/meta + 内容分支 + Prism 高亮） | 新 |
| `src/components/workbench/__tests__/ChatTurn.test.js` | ChatTurn vitest | 新 |
| `src/components/workbench/WorkbenchChat.vue` | 编排者：用 `<ChatTurn>`、自动增高 textarea、瘦身 | 改 |

---

### Task 1: 依赖 marked + dompurify（+ CLAUDE.md 登记）

**Files:**
- Modify: `package.json`
- Modify: `CLAUDE.md`（「依赖政策」例外表）

**Interfaces:**
- Produces: `marked`、`dompurify` 可 `import`（供 Task 2）。

- [ ] **Step 1: 安装依赖**

```bash
npm install marked dompurify
```

- [ ] **Step 2: 登记到 CLAUDE.md 例外表**

在 `CLAUDE.md` 的「以下为已裁决的例外」表格追加两行（紧接现有 `vitest` 行后）：

```markdown
| `marked` | 运行时（dependencies） | 工作台 chat agent 终答 markdown→HTML 解析（标准、~30KB）。 | 2026-08-10 workbench Cursor-style chat 设计 |
| `dompurify` | 运行时（dependencies） | 消毒 marked 产出的 HTML（`conv.content` 为 LLM 生成、走 `v-html`，必须防 XSS）。 | 2026-08-10 workbench Cursor-style chat 设计 |
```

- [ ] **Step 3: 验证可 import**

```bash
node --input-type=module -e "import { marked } from 'marked'; import DOMPurify from 'dompurify'; console.log('marked', typeof marked.parse, '| dompurify', typeof DOMPurify.sanitize)"
```
Expected: 打印 `marked function | dompurify function`。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json CLAUDE.md
git commit -m "chore(deps): +marked +dompurify(workbench chat markdown 渲染,登记 CLAUDE.md 例外)"
```

---

### Task 2: `renderMarkdown` 纯函数（TDD）

**Files:**
- Create: `src/logic/markdown.js`
- Test: `src/logic/__tests__/markdown.test.js`

**Interfaces:**
- Produces: `renderMarkdown(md: string|null|undefined): string` —— 同步返回消毒过的 HTML 字串（空入参返回 `''`；围栏代码块为 `<pre><code class="language-X">…</code></pre>`，供 ChatTurn 的 Prism `highlightAllUnder` 高亮）。

- [ ] **Step 1: 写失败测试**

`src/logic/__tests__/markdown.test.js`：

```js
import { test, expect } from 'vitest'
import { renderMarkdown } from '../markdown.js'

test('renderMarkdown: 粗体 → <strong>', () => {
  expect(renderMarkdown('**hi**')).toContain('<strong>hi</strong>')
})

test('renderMarkdown: 围栏代码块带 language class（供 prism）', () => {
  const html = renderMarkdown('```js\nconst x = 1\n```')
  expect(html).toMatch(/<code[^>]*class="language-js"/)
})

test('renderMarkdown: XSS — <script> 被剥离', () => {
  const out = renderMarkdown('<script>alert(1)</script>**b**')
  expect(out).not.toContain('<script>')
  expect(out).toContain('<strong>b</strong>')
})

test('renderMarkdown: 空入参安全返回空串', () => {
  expect(renderMarkdown('')).toBe('')
  expect(renderMarkdown(null)).toBe('')
  expect(renderMarkdown(undefined)).toBe('')
})

test('renderMarkdown: GFM 列表/标题', () => {
  expect(renderMarkdown('# T')).toMatch(/<h1[^>]*>T<\/h1>/)
  expect(renderMarkdown('- a\n- b')).toContain('<li>a</li>')
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/logic/__tests__/markdown.test.js
```
Expected: FAIL（`renderMarkdown is not a function` / 模块找不到）。

- [ ] **Step 3: 写最小实现**

`src/logic/markdown.js`：

```js
// agent 终答 markdown → 安全 HTML。同步：marked.parse 默认渲染（围栏代码 → <pre><code class="language-X">，
// 代码本身已转义）→ DOMPurify 消毒（默认保留 class，剥离 script/事件属性）。
// 代码高亮（token span）由消费方在 v-html 渲染后调 Prism.highlightAllUnder 补（见 ChatTurn.vue）。
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: false })

export function renderMarkdown(md) {
  if (!md) return ''
  const raw = marked.parse(String(md))
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/logic/__tests__/markdown.test.js
```
Expected: PASS（5 passed）。

- [ ] **Step 5: 语法基线**

```bash
npm run typecheck
```
Expected: ✓（`node --check` 通过）。

- [ ] **Step 6: Commit**

```bash
git add src/logic/markdown.js src/logic/__tests__/markdown.test.js
git commit -m "feat(logic): renderMarkdown(md)→消毒HTML(marked+DOMPurify,XSS-safe)"
```

---

### Task 3: i18n 键（roleYou / roleAgent / toolDenied）

**Files:**
- Modify: `src/locales/zh.json`、`src/locales/en.json`（`workbench.chat` 下，紧挨 `atMentionSearching` 后）

**Interfaces:**
- Produces: `workbench.chat.roleYou` / `roleAgent` / `toolDenied`（zh/en 对齐，供 ChatTurn/ToolTrace 用）。

- [ ] **Step 1: 加键**

`zh.json` 在 `workbench.chat` 对象内追加（与现有键同缩进）：

```json
      "roleYou": "你",
      "roleAgent": "Agent",
      "toolDenied": "已拒绝",
```

`en.json` 同位置追加：

```json
      "roleYou": "You",
      "roleAgent": "Agent",
      "toolDenied": "denied",
```

- [ ] **Step 2: 跑 i18n 门禁**

```bash
npm run i18n:check
```
Expected: `残存中文行：0`、`键对齐：✓`、`引用键缺失：0`（键未在模板引用前不算缺失；本步骤只验对齐 + 无残存中文）。

- [ ] **Step 3: Commit**

```bash
git add src/locales/zh.json src/locales/en.json
git commit -m "i18n(workbench): +roleYou/roleAgent/toolDenied(chat Cursor 排版用)"
```

---

### Task 4: `ToolTrace.vue`（chips + 展开 result）

**Files:**
- Create: `src/components/workbench/ToolTrace.vue`
- Test: `src/components/workbench/__tests__/ToolTrace.test.js`

**Interfaces:**
- Consumes: `workbench.chat.toolDenied`（Task 3）。
- Produces: `<ToolTrace :trace="trace" />`，`trace: Array<{ type: 'tool'|'denied', name: string, result?: any }>`。每个事件一颗 chip；点 chip 就地展开 `result`（再点收起）。

- [ ] **Step 1: 写失败测试**

`src/components/workbench/__tests__/ToolTrace.test.js`：

```js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ToolTrace from '../ToolTrace.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: { workbench: { chat: { toolDenied: '已拒绝' } } } } })

test('ToolTrace: 每事件一颗 chip，含 name', () => {
  const trace = [
    { type: 'tool', name: 'list_resources', result: 'ok' },
    { type: 'denied', name: 'get_pod_logs' },
  ]
  const w = mount(ToolTrace, { props: { trace }, global: { plugins: [i18n] } })
  const chips = w.findAll('button')
  expect(chips).toHaveLength(2)
  expect(w.text()).toContain('list_resources')
  expect(w.text()).toContain('get_pod_logs')
})

test('ToolTrace: 点 chip 展开 result，再点收起', async () => {
  const w = mount(ToolTrace, { props: { trace: [{ type: 'tool', name: 'foo', result: 'hello-result' }] }, global: { plugins: [i18n] } })
  expect(w.text()).not.toContain('hello-result')
  await w.find('button').trigger('click')
  expect(w.text()).toContain('hello-result')
  await w.find('button').trigger('click')
  expect(w.text()).not.toContain('hello-result')
})

test('ToolTrace: 空 trace 不渲染', () => {
  const w = mount(ToolTrace, { props: { trace: [] }, global: { plugins: [i18n] } })
  expect(w.find('button').exists()).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/components/workbench/__tests__/ToolTrace.test.js
```
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 写实现**

`src/components/workbench/ToolTrace.vue`：

```vue
<script setup>
// 工具调用紧凑 chips：每个 tool/denied 事件一颗；点开就地展开 result（Cursor 风格工具行）。
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({ trace: { type: Array, default: () => [] } })
const { t } = useI18n()

const expanded = ref(null)
function fmtResult(v) { if (v == null) return ''; return typeof v === 'string' ? v : JSON.stringify(v, null, 2) }
function toggle(i) { expanded.value = expanded.value === i ? null : i }
</script>

<template>
  <div v-if="trace.length" class="flex flex-wrap gap-xs items-center">
    <button v-for="(ev, i) in trace" :key="i" type="button" @click="toggle(i)"
      class="flex items-center gap-xs text-body-xs font-mono px-sm py-xs rounded-md border transition-colors"
      :class="ev.type === 'denied'
        ? 'border-status-warning/30 text-status-warning bg-status-warning/5'
        : 'border-outline-variant text-on-surface hover:bg-surface-container-low'">
      <span class="material-symbols-outlined text-sm">{{ ev.type === 'denied' ? 'block' : 'play_arrow' }}</span>
      <span class="font-semibold">{{ ev.name }}</span>
      <span v-if="ev.type === 'denied'">{{ t('workbench.chat.toolDenied') }}</span>
      <span v-else class="text-status-success">✓</span>
    </button>
    <pre v-if="expanded !== null && fmtResult(trace[expanded].result)"
      class="w-full mt-xs font-mono text-body-xs text-on-surface-variant bg-surface-container-lowest border border-outline-variant rounded-lg px-sm py-xs max-h-32 overflow-y-auto whitespace-pre-wrap break-all">{{ fmtResult(trace[expanded].result) }}</pre>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/components/workbench/__tests__/ToolTrace.test.js
```
Expected: PASS（3 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/components/workbench/ToolTrace.vue src/components/workbench/__tests__/ToolTrace.test.js
git commit -m "feat(workbench): ToolTrace 紧凑 chips(展开 result,取代 details 块)"
```

---

### Task 5: `ChatTurn.vue`（全宽行 + markdown + Prism 高亮）

**Files:**
- Create: `src/components/workbench/ChatTurn.vue`
- Test: `src/components/workbench/__tests__/ChatTurn.test.js`

**Interfaces:**
- Consumes: `renderMarkdown`（Task 2）、`ToolTrace`（Task 4）、`workbench.chat.roleYou/roleAgent`（Task 3）。
- Produces: `<ChatTurn :turn="turn" />`，`turn` 形如 `{ role:'user'|'assistant', content, status, trace?, steps?, refs?, error?, denied?, truncated? }`。

- [ ] **Step 1: 写失败测试**

`src/components/workbench/__tests__/ChatTurn.test.js`：

```js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ChatTurn from '../ChatTurn.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: { workbench: { chat: { roleYou: '你', roleAgent: 'Agent' } } } } })

test('ChatTurn: agent done 渲染 markdown(v-html)', () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'done', content: '**hi**' } }, global: { plugins: [i18n] } })
  expect(w.html()).toContain('<strong>hi</strong>')
})

test('ChatTurn: 用户轮有底色 + role label', () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'user', content: 'hello' } }, global: { plugins: [i18n] } })
  expect(w.find('[data-role="user"]').exists()).toBe(true)
  expect(w.text()).toContain('你')
})

test('ChatTurn: agent done 暴露 language class(供 Prism)', () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'done', content: '```yaml\napiVersion: v1\n```' } }, global: { plugins: [i18n] } })
  expect(w.html()).toMatch(/class="language-yaml"/)
})

test('ChatTurn: error 状态显示 error 文案', () => {
  const w = mount(ChatTurn, { props: { turn: { role: 'assistant', status: 'error', error: 'boom' } }, global: { plugins: [i18n] } })
  expect(w.text()).toContain('boom')
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/components/workbench/__tests__/ChatTurn.test.js
```
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 写实现**

`src/components/workbench/ChatTurn.vue`：

```vue
<script setup>
// 一轮对话行（Cursor 风格）：marker + label + meta + 内容。用户轮底色带；agent 终答 markdown(Prism 高亮)。
import { ref, onMounted, onUpdated, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '@/logic/markdown'
import ToolTrace from './ToolTrace.vue'

const props = defineProps({ turn: { type: Object, required: true } })
const { t } = useI18n()

const root = ref(null)
// Prism 懒加载(镜像 CodeViewer.vue):首屏不拉 ~200KB;命中后缓存。languages 覆盖 chat 常见代码。
let PrismPromise = null
function loadPrism() {
  if (!PrismPromise) {
    PrismPromise = (async () => {
      const Prism = (await import('prismjs')).default
      await Promise.all([
        import('prismjs/components/prism-yaml'),
        import('prismjs/components/prism-json'),
        import('prismjs/components/prism-bash'),
        import('prismjs/components/prism-javascript'),
        import('prismjs/themes/prism-tomorrow.css'),
      ])
      return Prism
    })()
  }
  return PrismPromise
}
async function highlight() {
  if (!root.value) return
  try { const Prism = await loadPrism(); Prism.highlightAllUnder(root.value) } catch { /* 降级:不高亮 */ }
}
onMounted(highlight)
onUpdated(() => nextTick(highlight))
</script>

<template>
  <div ref="root" :data-role="turn.role" class="px-md py-sm border-b border-outline-variant/40"
    :class="turn.role === 'user' ? 'bg-primary/[0.04]' : ''">
    <!-- 角色行 -->
    <div class="flex items-center gap-xs mb-xs">
      <span class="material-symbols-outlined text-sm" :class="turn.role === 'user' ? 'text-primary' : 'text-on-surface-variant'">{{ turn.role === 'user' ? 'person' : 'smart_toy' }}</span>
      <span class="text-body-xs font-semibold" :class="turn.role === 'user' ? 'text-primary' : 'text-on-surface-variant'">{{ turn.role === 'user' ? t('workbench.chat.roleYou') : t('workbench.chat.roleAgent') }}</span>
      <span v-if="turn.role === 'assistant' && turn.steps" class="ml-auto text-body-xs text-on-surface-variant">{{ turn.steps }} steps</span>
      <span v-if="turn.truncated" class="text-body-xs text-status-warning">⚠ truncated</span>
    </div>

    <!-- USER -->
    <div v-if="turn.role === 'user'">
      <div v-if="turn.refs && turn.refs.length" class="flex flex-wrap gap-xs mb-xs">
        <span v-for="(r, i) in turn.refs" :key="i" class="text-body-xs font-mono text-primary bg-primary/10 border border-primary/20 rounded px-xs py-0.5">@{{ r.kind }}:{{ r.name }}</span>
      </div>
      <p class="text-body-sm whitespace-pre-wrap break-words leading-relaxed">{{ turn.content }}</p>
    </div>

    <!-- AGENT -->
    <div v-else class="flex flex-col gap-sm">
      <ToolTrace v-if="turn.trace && turn.trace.length" :trace="turn.trace" />

      <div v-if="turn.status === 'thinking' && !(turn.trace && turn.trace.length)" class="flex items-center gap-sm">
        <span class="flex gap-0.5">
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 0ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 150ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 300ms"></span>
        </span>
        <span class="text-body-sm text-on-surface-variant">Thinking...</span>
      </div>

      <div v-else-if="turn.status === 'pending_approval'" class="flex items-center gap-sm px-sm py-sm bg-status-warning/5 border border-status-warning/30 rounded-xl">
        <span class="material-symbols-outlined text-base text-status-warning">pending_actions</span>
        <span class="text-body-sm text-status-warning font-medium">Waiting for approval...</span>
      </div>

      <div v-else-if="turn.status === 'error'" class="flex items-start gap-sm px-md py-sm bg-error/5 border border-error/20 rounded-xl">
        <span class="material-symbols-outlined text-base text-error mt-0.5">error</span>
        <span class="text-body-sm text-error whitespace-pre-wrap break-words">{{ turn.error }}</span>
      </div>

      <!-- done: markdown -->
      <div v-else-if="turn.status === 'done'" class="text-body-sm text-on-surface leading-relaxed prose-chat" v-html="renderMarkdown(turn.content)"></div>
    </div>
  </div>
</template>
```

> 注：`Thinking...` / `Waiting for approval...` 沿用既有硬编码英文（i18n 门禁只查中文，非违规；如需 i18n 化为后续）。`prose-chat` 是可选样式钩子（代码块暗底可在此微调，见 Task 7 视觉验收）。

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/components/workbench/__tests__/ChatTurn.test.js
```
Expected: PASS（4 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/components/workbench/ChatTurn.vue src/components/workbench/__tests__/ChatTurn.test.js
git commit -m "feat(workbench): ChatTurn 全宽行(marker/label/用户底色)+agent markdown(Prism 高亮)"
```

---

### Task 6: 重构 `WorkbenchChat.vue`（用 ChatTurn + 自动增高 + 瘦身）

**Files:**
- Modify: `src/components/workbench/WorkbenchChat.vue`

**Interfaces:**
- Consumes: `ChatTurn`（Task 5，已含 `ToolTrace`）。删除本文件内联的 tool trace `<details>` 块、`fmtResult`、`toolCount`（迁入 ToolTrace/ChatTurn）；保留 `refIcon`（输入区 ref chips + 审批 modal 仍用）。

- [ ] **Step 1: 导入 ChatTurn，替换消息循环**

在 `<script setup>` 顶部 import 区加：

```js
import ChatTurn from './ChatTurn.vue'
```

把模板里整个 `<!-- Conversation -->` 的 `v-for="turn in turns"` 块（user message + assistant message 全部分支，约原文件 286–365 行）替换为：

```html
      <!-- Conversation -->
      <div v-for="turn in turns" :key="turn._id">
        <ChatTurn :turn="turn" />
      </div>
```

- [ ] **Step 2: 删除迁出的死代码**

从 `<script setup>` 删除：`function toolCount(...)`、`function fmtResult(...)`（已迁入 `ToolTrace`；`refIcon` 保留）。

- [ ] **Step 3: textarea 自动增高**

在 `<script setup>` 加：

```js
function autoGrow(e) {
  const ta = e.target
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 128) + 'px' // max-h-32 = 8rem ≈ 128px
}
function resetInput() { input.value = ''; nextTick(() => { const ta = document.querySelector('textarea'); if (ta) ta.style.height = 'auto' }) }
```

`send()` 里 `input.value = ''` 改为 `resetInput()`（清空时收回高度）。

textarea 元素加 `@input="autoGrow"`（与 `v-model` 并存）：

```html
<textarea v-model="input" @keydown="onKeydown" @input="autoGrow" :disabled="sending || !!pendingApproval" rows="1" :placeholder="t('workbench.chat.userMessage')" class="flex-1 bg-transparent resize-none outline-none text-body-sm leading-relaxed max-h-32"></textarea>
```

- [ ] **Step 4: 瘦身状态栏（可选微调）**

顶部状态栏 `py-xs` → `py-0.5`，错误 banner 同步收窄边距（保持语义不变）。

- [ ] **Step 5: 语法 + 单测不回归**

```bash
npm run typecheck && npx vitest run src/components/workbench
```
Expected: typecheck ✓；workbench 组件测试全绿（含 Task 4/5 新增）。

- [ ] **Step 6: Commit**

```bash
git add src/components/workbench/WorkbenchChat.vue
git commit -m "refactor(workbench): WorkbenchChat 用 ChatTurn + textarea 自动增高(瘦身)"
```

---

### Task 7: 浏览器视觉验收 + 终极门禁

**Files:** 无（验收 + 门禁）

- [ ] **Step 1: 起服务（若未起）**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173   # 期望 200
curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/api/health   # 期望 200
```
若未起：`npm run dev`（5173）+ `node server/index.mjs`（8787，后台）。

- [ ] **Step 2: 浏览器验收（playwright，登录 admin/admin123 → main-cluster → workbench → test 项目）**

逐项核对：
1. 用户消息**全宽左对齐**、有 `bg-primary/[0.04]` 底色带、左侧 `person` 图标 + 「你」标签；**无右对齐气泡、无 max-w-80%**。
2. agent 终答 `done` 渲染为 markdown：`**b**`→粗体、`- x`→列表、` ```yaml …``` `→**暗底代码块且 Prism 高亮**（yaml/json/bash 着色）。
3. 工具调用显示为**紧凑 chips**（`▶ name ✓` / `block name 已拒绝`），点击展开 result。
4. textarea 输入多行时**自动增高**（封顶 ~8 行），清空后收回。
5. 无 Vue 控制台报错（`browser_console_messages` level=error → 0）。

- [ ] **Step 3: 终极门禁**

```bash
npm run i18n:check && npm run typecheck && npm test && npm run build
```
Expected: i18n 残存中文 0 / typecheck ✓ / test 全绿 / build `✓ built`。

- [ ] **Step 4: Commit（如有 Task 7 微调，如 prose-chat 样式）**

```bash
git add -u
git commit -m "style(workbench): chat Cursor 风格视觉微调(prose-chat 代码块暗底等)"
```
（无微调则跳过本步。）

---

## Self-Review

- **Spec 覆盖**：全宽左对齐+用户底色（T5/T6/T7）、marker+label（T5）、markdown marked+DOMPurify（T1/T2）、代码块 prism（T5 loadPrism）、工具 chips（T4）、自动增高（T6）、i18n 键（T3）、+2 依赖登记（T1）——spec 各节均有任务。
- **占位符**：无 TBD/TODO；每步含可执行命令或实代码。
- **类型/命名一致**：`renderMarkdown(md)`（T2 定义，T5 消费）；`<ToolTrace :trace>`（T4 定义，T5 消费）；`<ChatTurn :turn>`（T5 定义，T6 消费）；i18n 键 `roleYou/roleAgent/toolDenied`（T3 定义，T4/T5 消费）——一致。
- **偏离 spec**：markdown 高亮从「util 内路由 prism」改为「util 同步产 language-X class + ChatTurn 懒加载 Prism highlightAllUnder」——更可测、对齐 CodeViewer 既有模式；已在 Architecture 注明。
