# Pod 日志新标签页查看器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PodCard 全部使用处获得日志快捷按钮，点击在浏览器新标签页打开带完整工具栏的日志页（LogPopup），日志查看逻辑收进共享 `LogViewerBody`，PodDetail 的 logs tab 换用同款。

**Architecture:** 三层：`src/logic/podLogs.js`（纯函数：解析/查询构造/过滤/高亮/滚动判定）→ `src/composables/useLogViewer.js`（响应式编排 + `openLogTab()`）→ `LogViewerBody.vue`（展示）+ `LogPopup.vue`（新标签页壳，仿 `TerminalPopup.vue`）。鉴权复用 `?token=` URL→sessionStorage 机制（`main.js:19-22`，与路径无关）；集群上下文由 session token 服务端绑定，无需额外参数。

**Tech Stack:** Vue 3.5（`defineModel` 已有惯例）+ vue-i18n + vitest/@vue/test-utils/happy-dom（组件测试）+ colocated node:test（纯逻辑）。零新增依赖。

**Spec:** `docs/superpowers/specs/2026-08-25-pod-log-tab-viewer-design.md`

## Global Constraints

- **零新增依赖**（仓库政策，见 CLAUDE.md；本计划不引任何包）。
- **i18n**：新键 zh/en 双语同步写入 `src/locales/{zh,en}.json`；消息值中字面 `@` 必须写成 `{'@'}`；模板渲染键值含 HTML 才用 v-html，其余一律 `{{ }}`。收尾跑 `npm run i18n:check`。
- **测试命令**：单文件 `npx vitest run <path>`；全量 `npm test`（= test:server + vitest run）。
- **代码风格**：跟仓库现状——`<script setup>`、中文行注释、Material Symbols 图标、tailwind 语义色 token（`bg-surface-container-*`/`text-on-surface-variant` 等）、代码区主题类 `bg-code-surface`/`code-scroll`/`text-code-sm`。
- **git**：在 worktree 分支 `feat/pod-log-tab-viewer` 上执行（基于 main）；每 Task 一次提交，消息中文 conventional（如 `feat(logs): ...`）；提交前 `git branch --show-current` 确认不在 main。
- **日志缓冲上限 5000 行**（`MAX_LOG_BUFFER = 5000`，常量定义于 composable 并导出）。

---

### Task 1: `src/logic/podLogs.js` 纯函数层

**Files:**
- Create: `src/logic/podLogs.js`
- Test: `src/logic/podLogs.test.mjs`（colocated，node:test 风格，同 `workloadTransition.test.mjs`）

**Interfaces:**
- Consumes: 无（纯函数，零依赖）。
- Produces（后续任务按此签名使用）:
  - `parseLogLine(line: string) → { timestamp: string, level: 'ERROR'|'WARN'|'INFO', message: string }`
  - `buildLogQuery({ container, tailLines=500, sinceSeconds=0, previous=false, follow=false }) → URLSearchParams`（总含 `timestamps:'true'` 与 `tailLines`）
  - `compileFilter({ search='', useRegex=false, levels=['ERROR','WARN','INFO'] }) → { error: string, test(line)→boolean, highlight(message)→[{text,hit}] }`（非法正则：`error` 非空、test 恒 true、highlight 返回整段单片段）
  - `highlightSegments(text, regex|null) → [{text, hit}]`
  - `isNearBottom({ scrollTop, scrollHeight, clientHeight }, threshold=40) → boolean`
  - `pushCapped(arr, incoming, cap) → void`（原地追加并截头）
  - `levelCounts(lines) → { ERROR, WARN, INFO }`

- [ ] **Step 1: 写失败测试**

```js
// src/logic/podLogs.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLogLine, buildLogQuery, compileFilter, highlightSegments, isNearBottom, pushCapped, levelCounts } from './podLogs.js'

test('parseLogLine: 时间戳拆分 + 级别识别（ERROR/WARN/INFO 边界）', () => {
  assert.deepEqual(parseLogLine('2026-08-25T01:02:03.000000001Z error connecting to db'), {
    timestamp: '2026-08-25T01:02:03.000000001Z', level: 'ERROR', message: 'error connecting to db',
  })
  assert.equal(parseLogLine('2026-01-01T00:00:00Z WARNING disk almost full').level, 'WARN')
  assert.equal(parseLogLine('2026-01-01T00:00:00Z warn: retrying').level, 'WARN')
  assert.equal(parseLogLine('2026-01-01T00:00:00Z server started').level, 'INFO')
  // 无时间戳：整行当消息，timestamp 为空串
  assert.deepEqual(parseLogLine('bare message'), { timestamp: '', level: 'INFO', message: 'bare message' })
})

test('buildLogQuery: 默认参数与全量参数', () => {
  const d = buildLogQuery({})
  assert.equal(d.get('timestamps'), 'true')
  assert.equal(d.get('tailLines'), '500')
  assert.equal(d.get('container'), null)
  assert.equal(d.get('follow'), null)
  const full = buildLogQuery({ container: 'main', tailLines: 100, sinceSeconds: 300, previous: true, follow: true })
  assert.equal(full.get('container'), 'main')
  assert.equal(full.get('sinceSeconds'), '300')
  assert.equal(full.get('previous'), 'true')
  assert.equal(full.get('follow'), 'true')
  // sinceSeconds=0 / previous=false / follow=false 不出现
  const zero = buildLogQuery({ sinceSeconds: 0, previous: false, follow: false })
  assert.equal(zero.get('sinceSeconds'), null)
  assert.equal(zero.get('previous'), null)
})

test('compileFilter: 子串不区分大小写 + 级别过滤', () => {
  const f = compileFilter({ search: 'DB', levels: ['ERROR', 'WARN', 'INFO'] })
  assert.equal(f.error, '')
  assert.equal(f.test({ level: 'INFO', message: 'connected to db' }), true)
  assert.equal(f.test({ level: 'INFO', message: 'connected to cache' }), false)
  const errOnly = compileFilter({ levels: ['ERROR'] })
  assert.equal(errOnly.test({ level: 'WARN', message: 'db' }), false)
  assert.equal(errOnly.test({ level: 'ERROR', message: 'x' }), true)
})

test('compileFilter: 正则模式 + 非法正则不崩溃', () => {
  const f = compileFilter({ search: 'err\\d+', useRegex: true })
  assert.equal(f.test({ level: 'INFO', message: 'failed err42 retry' }), true)
  assert.equal(f.test({ level: 'INFO', message: 'failed errX' }), false)
  const bad = compileFilter({ search: '[invalid', useRegex: true })
  assert.notEqual(bad.error, '')            // 有错误提示
  assert.equal(bad.test({ level: 'INFO', message: 'anything' }), true)  // 不过滤
})

test('highlightSegments: 命中拆分 + 零宽匹配安全 + null regex', () => {
  assert.deepEqual(highlightSegments('abc', null), [{ text: 'abc', hit: false }])
  const segs = highlightSegments('a error b error c', /error/gi)
  assert.deepEqual(segs.map(s => ({ hit: s.hit, text: s.text })), [
    { hit: false, text: 'a ' }, { hit: true, text: 'error' }, { hit: false, text: ' b ' },
    { hit: true, text: 'error' }, { hit: false, text: ' c' },
  ])
  const zeroWidth = highlightSegments('abc', /x*/gi)   // 零宽模式不得死循环
  assert.ok(Array.isArray(zeroWidth))
})

test('isNearBottom: 40px 阈值边界', () => {
  const el = { scrollTop: 960, scrollHeight: 1000, clientHeight: 0 }         // 差 40 → true
  assert.equal(isNearBottom(el), true)
  assert.equal(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 0 }), false)
  assert.equal(isNearBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 }), true)  // 无滚动
})

test('pushCapped: 截头保尾 + 单值/数组皆可', () => {
  const arr = []
  pushCapped(arr, [1, 2, 3], 5)
  pushCapped(arr, 4, 5)
  assert.deepEqual(arr, [1, 2, 3, 4])
  pushCapped(arr, [5, 6, 7], 5)
  assert.deepEqual(arr, [3, 4, 5, 6, 7])
})

test('levelCounts: 三级计数', () => {
  assert.deepEqual(levelCounts([
    { level: 'ERROR' }, { level: 'ERROR' }, { level: 'WARN' }, { level: 'INFO' }, {},
  ]), { ERROR: 2, WARN: 1, INFO: 1 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/logic/podLogs.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```js
// src/logic/podLogs.js
// Pod 日志纯逻辑：行解析（parseLogLine 从 PodDetail.vue 迁入）、查询串构造、前端过滤/高亮、
// 智能滚动判定、环形缓冲。零依赖，供 useLogViewer/LogViewerBody 消费。

const LEVEL_RE = { ERROR: /\berror\b/i, WARN: /\bwarn(?:ing)?\b/i }

// 单行日志 → { timestamp, level, message }：K8s log API 开 timestamps=true 时行首为 RFC3339。
export function parseLogLine(line) {
  const match = String(line).match(/^(\S+)\s(.*)$/)
  const timestamp = match?.[1] || ''
  const message = match?.[2] || String(line ?? '')
  const level = LEVEL_RE.ERROR.test(message) ? 'ERROR' : LEVEL_RE.WARN.test(message) ? 'WARN' : 'INFO'
  return { timestamp, level, message }
}

// kubectl logs 语义查询串：--tail / --since / --previous / --follow / --timestamps
export function buildLogQuery({ container = '', tailLines = 500, sinceSeconds = 0, previous = false, follow = false } = {}) {
  const q = new URLSearchParams({ timestamps: 'true', tailLines: String(tailLines) })
  if (container) q.set('container', container)
  if (sinceSeconds) q.set('sinceSeconds', String(sinceSeconds))
  if (previous) q.set('previous', 'true')
  if (follow) q.set('follow', 'true')
  return q
}

// 高亮拆分：按全局正则把消息切成 [{text, hit}] 片段（模板 v-for 渲染 span，不走 v-html，XSS 免疫）。
// 零宽匹配（如 /x*/）跳过推进 lastIndex 防死循环。
export function highlightSegments(text, regex) {
  const str = String(text ?? '')
  if (!regex) return [{ text: str, hit: false }]
  regex.lastIndex = 0
  const out = []
  let last = 0
  let m
  while ((m = regex.exec(str)) !== null) {
    if (m[0] === '') { regex.lastIndex++; continue }
    if (m.index > last) out.push({ text: str.slice(last, m.index), hit: false })
    out.push({ text: m[0], hit: true })
    last = m.index + m[0].length
  }
  if (last < str.length) out.push({ text: str.slice(last), hit: false })
  return out.length ? out : [{ text: '', hit: false }]
}

// 组合过滤器：级别多选 + 搜索（子串不区分大小写 / 正则）。非法正则 → error 提示且不过滤（防崩溃）。
// test 用非全局正则（全局 lastIndex 会污染 test 结果），highlight 用全局正则。
export function compileFilter({ search = '', useRegex = false, levels = ['ERROR', 'WARN', 'INFO'] } = {}) {
  const levelSet = new Set(levels?.length ? levels : ['ERROR', 'WARN', 'INFO'])
  let testRegex = null
  let hlRegex = null
  let error = ''
  const q = String(search ?? '').trim()
  if (q) {
    const src = useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    try {
      testRegex = new RegExp(src, 'i')
      hlRegex = new RegExp(src, 'gi')
    } catch (e) {
      error = e?.message || 'invalid regex'
    }
  }
  return {
    error,
    test: line => levelSet.has(line?.level) && (!testRegex || testRegex.test(line?.message ?? '')),
    highlight: message => highlightSegments(message, hlRegex),
  }
}

// 距底 ≤ threshold 视为「贴底」（following 恢复条件）。直接接收 DOM 元素亦可（鸭子类型）。
export function isNearBottom({ scrollTop, scrollHeight, clientHeight }, threshold = 40) {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

// 环形缓冲：原地追加（单值或数组）并截头保尾。
export function pushCapped(arr, incoming, cap) {
  const items = Array.isArray(incoming) ? incoming : [incoming]
  arr.push(...items)
  if (arr.length > cap) arr.splice(0, arr.length - cap)
  return arr
}

export function levelCounts(lines) {
  const c = { ERROR: 0, WARN: 0, INFO: 0 }
  for (const l of lines || []) if (l?.level && c[l.level] != null) c[l.level]++
  return c
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/logic/podLogs.test.mjs`
Expected: PASS（7 用例全绿）

- [ ] **Step 5: 提交**

```bash
git branch --show-current   # 应为 feat/pod-log-tab-viewer
git add src/logic/podLogs.js src/logic/podLogs.test.mjs
git commit -m "feat(logs): pod 日志纯逻辑层——行解析/查询构造/过滤高亮/滚动判定/环形缓冲"
```

---

### Task 2: `src/composables/useLogViewer.js` 响应式编排 + `openLogTab`

**Files:**
- Create: `src/composables/useLogViewer.js`
- Test: `src/composables/__tests__/useLogViewer.test.js`（vitest）

**Interfaces:**
- Consumes: Task 1 的 `parseLogLine/buildLogQuery/pushCapped`；`@/api/client` 的 `api.k8s/k8sStream/getSessionToken`；`@/i18n` 的 `i18n.global.t`（client.js 同款用法）。
- Produces:
  - `useLogViewer({ namespace: Ref<string>, podName: Ref<string>, container: Ref<string> })` → `{ lines, followLog, logLines, logSince, logPrevious, streamError, startFollow, stopFollow, loadRemoteLogs, restart }`（`lines` 为 `{timestamp,level,message}[]`，cap 5000）
  - `openLogTab({ namespace, podName, container })` → `window.open('/log-popup?ns&pod&container&token', 'log-{ns}-{pod}-{container}')`
  - 常量 `MAX_LOG_BUFFER=5000`、`LOG_LINE_OPTIONS=[100,500,1000,5000]`、`LOG_SINCE_OPTIONS=[{value:'',seconds:0},{value:'300',seconds:300},{value:'900',seconds:900},{value:'3600',seconds:3600},{value:'21600',seconds:21600}]`

- [ ] **Step 1: 写失败测试**

```js
// src/composables/__tests__/useLogViewer.test.js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

// 捕获 k8sStream 的 handlers，模拟服务端推流
let streamHandlers = null
let streamAbort = null
const k8sStreamMock = vi.fn((path, handlers) => {
  streamHandlers = { path, ...handlers }
  streamAbort = vi.fn()
  return { abort: streamAbort }
})
const apiK8sMock = vi.fn(async () => '2026-01-01T00:00:00Z line-a\n2026-01-01T00:00:01Z error line-b')

vi.mock('@/api/client', () => ({
  api: { k8s: apiK8sMock },
  k8sStream: k8sStreamMock,
  getSessionToken: () => 'tok-1',
}))

import { useLogViewer, openLogTab, MAX_LOG_BUFFER } from '@/composables/useLogViewer'

// 宿主组件：composable 的生命周期钩子须在 setup 内注册
function mountViewer(props = {}) {
  const state = {}
  const Host = defineComponent({
    setup() {
      Object.assign(state, useLogViewer({
        namespace: ref(props.ns || 'default'),
        podName: ref(props.pod || 'pod-1'),
        container: ref(props.container || 'main'),
      }))
      return {}
    },
    template: '<div />',
  })
  const wrapper = mount(Host, { global: { plugins: [createPinia(), i18n] } })
  return { wrapper, state }
}

test('挂载即启动 follow 流，路径带 follow=true 与 container', () => {
  const { state } = mountViewer()
  expect(k8sStreamMock).toHaveBeenCalledTimes(1)
  expect(streamHandlers.path).toContain('/api/v1/namespaces/default/pods/pod-1/log?')
  expect(streamHandlers.path).toContain('follow=true')
  expect(streamHandlers.path).toContain('container=main')
  expect(state.followLog.value).toBe(true)
})

test('onMessage 逐行解析入缓冲；onError 写入 streamError 与 ERROR 行', () => {
  const { state } = mountViewer()
  streamHandlers.onMessage('2026-01-01T00:00:00Z started')
  expect(state.lines.value).toHaveLength(1)
  expect(state.lines.value[0].level).toBe('INFO')
  streamHandlers.onError(new Error('boom'))
  expect(state.streamError.value).toContain('boom')
  expect(state.lines.value.at(-1).level).toBe('ERROR')
})

test('缓冲截断：超过 MAX_LOG_BUFFER 截头保尾', () => {
  const { state } = mountViewer()
  for (let i = 0; i < MAX_LOG_BUFFER + 100; i++) streamHandlers.onMessage(`2026-01-01T00:00:00Z msg-${i}`)
  expect(state.lines.value).toHaveLength(MAX_LOG_BUFFER)
  expect(state.lines.value.at(-1).message).toBe(`msg-${MAX_LOG_BUFFER + 99}`)
})

test('勾 previous 自动关 follow 并改走静态拉取；卸载断流', async () => {
  const { wrapper, state } = mountViewer()
  await wrapper.vm.$nextTick()
  state.logPrevious.value = true
  await nextTick()
  expect(state.followLog.value).toBe(false)
  expect(streamAbort).toHaveBeenCalled()
  expect(apiK8sMock).toHaveBeenCalled()
  wrapper.unmount()   // 卸载不再抛错（stopFollow 幂等）
})

test('openLogTab: URL 含 query 与 token，target 为具名 log-ns-pod-container', () => {
  const open = vi.fn()
  vi.stubGlobal('open', open)
  openLogTab({ namespace: 'default', podName: 'pod-1', container: 'main' })
  expect(open).toHaveBeenCalledTimes(1)
  const [url, target] = open.mock.calls[0]
  expect(url).toContain('/log-popup?')
  expect(url).toContain('ns=default')
  expect(url).toContain('pod=pod-1')
  expect(url).toContain('container=main')
  expect(url).toContain('token=tok-1')
  expect(target).toBe('log-default-pod-1-main')
  vi.unstubAllGlobals()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/__tests__/useLogViewer.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```js
// src/composables/useLogViewer.js
// Pod 日志响应式编排：流式/静态拉取状态机（迁自 PodDetail.vue logs tab 并强化）+
// openLogTab（浏览器新标签页打开 /log-popup，TerminalPopup 同构）。
import { ref, watch, onMounted, onUnmounted, getCurrentInstance } from 'vue'
import { api, k8sStream, getSessionToken } from '@/api/client'
import { i18n } from '@/i18n'
import { parseLogLine, buildLogQuery, pushCapped } from '@/logic/podLogs'

export const MAX_LOG_BUFFER = 5000
export const LOG_LINE_OPTIONS = [100, 500, 1000, 5000]
export const LOG_SINCE_OPTIONS = [
  { value: '', seconds: 0 },
  { value: '300', seconds: 300 },
  { value: '900', seconds: 900 },
  { value: '3600', seconds: 3600 },
  { value: '21600', seconds: 21600 },
]

export function useLogViewer({ namespace, podName, container }) {
  const lines = ref([])          // [{timestamp, level, message}]，cap MAX_LOG_BUFFER
  const followLog = ref(true)    // follow 流式开关（previous 时强制 false）
  const logLines = ref(500)      // --tail
  const logSince = ref('')       // ''=不限；否则 sinceSeconds 字符串
  const logPrevious = ref(false) // --previous（崩溃前容器日志）
  const streamError = ref('')    // 流中断/拉取失败（横幅）
  let stream = null

  function logPath(follow) {
    const q = buildLogQuery({
      container: container.value,
      tailLines: logLines.value,
      sinceSeconds: Number(logSince.value) || 0,
      previous: logPrevious.value,
      follow,
    })
    return `/api/v1/namespaces/${encodeURIComponent(namespace.value)}/pods/${encodeURIComponent(podName.value)}/log?${q}`
  }

  async function loadRemoteLogs() {
    if (!podName.value) return
    streamError.value = ''
    try {
      const text = await api.k8s(logPath(false))
      lines.value = String(text || '').split('\n').filter(Boolean).map(parseLogLine)
    } catch (e) {
      lines.value = [{ timestamp: new Date().toISOString(), level: 'ERROR', message: e?.message || i18n.global.t('component.logViewer.loadFailed') }]
    }
  }

  function startFollow() {
    if (!podName.value) return
    stopFollow()
    lines.value = []
    streamError.value = ''
    stream = k8sStream(logPath(true), {
      onMessage: line => pushCapped(lines.value, parseLogLine(line), MAX_LOG_BUFFER),
      onError: e => {
        streamError.value = e?.message || i18n.global.t('component.logViewer.streamInterrupted')
        pushCapped(lines.value, { timestamp: new Date().toISOString(), level: 'ERROR', message: streamError.value }, MAX_LOG_BUFFER)
      },
    })
  }
  function stopFollow() {
    if (stream) { stream.abort(); stream = null }
  }
  // 按当前模式重启：follow 开（且非 previous）走流，否则静态拉取
  function restart() {
    if (followLog.value && !logPrevious.value) startFollow()
    else { stopFollow(); loadRemoteLogs() }
  }

  watch(followLog, v => (v ? startFollow() : stopFollow()))
  watch(container, restart)
  watch([logLines, logSince], restart)
  watch(logPrevious, v => { if (v) followLog.value = false; restart() })

  // 仅在组件 setup 内注册生命周期（测试可绕过宿主直接调用函数）
  if (getCurrentInstance()) {
    onMounted(() => (followLog.value && !logPrevious.value ? startFollow() : loadRemoteLogs()))
    onUnmounted(stopFollow)
  }
  return { lines, followLog, logLines, logSince, logPrevious, streamError, startFollow, stopFollow, loadRemoteLogs, restart }
}

// 在新浏览器标签页打开独立日志页：同 ns+pod+container 复用同一标签页（具名 target 聚焦），换容器另开。
export function openLogTab({ namespace, podName, container = '' }) {
  const params = new URLSearchParams({ ns: namespace, pod: podName, container, token: getSessionToken() })
  window.open(`${window.location.origin}/log-popup?${params}`, `log-${namespace}-${podName}-${container}`)
}
```

注意：`component.logViewer.loadFailed/streamInterrupted` 键在 Task 3 一并加入 locales（本任务测试不断言文案内容，缺键只渲染 key 字符串不影响断言）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/__tests__/useLogViewer.test.js`
Expected: PASS（5 用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/composables/useLogViewer.js src/composables/__tests__/useLogViewer.test.js
git commit -m "feat(logs): useLogViewer 流式状态机 composable + openLogTab 新标签页入口"
```

---

### Task 3: `LogViewerBody.vue` 共享日志查看器组件 + i18n 键

**Files:**
- Create: `src/components/common/LogViewerBody.vue`
- Modify: `src/locales/zh.json`、`src/locales/en.json`（新增 `component.logViewer.*` 键）
- Test: `src/components/common/__tests__/LogViewerBody.test.js`

**Interfaces:**
- Consumes: Task 1 纯函数 + Task 2 composable。
- Produces: `<LogViewerBody :namespace :pod-name :containers v-model:container="..." class="flex-1 min-h-0" />`（PodDetail 内嵌与 LogPopup 全屏共用；根节点 `relative flex flex-col min-h-0 h-full`）。

- [ ] **Step 1: 加 i18n 键**（先加键，组件测试断言文案才稳定）

`src/locales/zh.json` 的 `"component"` 对象内新增（保持字母序插入 `logViewer` 子对象）：

```json
"logViewer": {
  "container": "容器",
  "lines": "行数",
  "since": "时间",
  "since_all": "全部",
  "since_300": "5 分钟",
  "since_900": "15 分钟",
  "since_3600": "1 小时",
  "since_21600": "6 小时",
  "previous": "Previous",
  "previousHint": "查看上一次（崩溃前）容器的日志",
  "follow": "Follow",
  "live": "实时流",
  "searchPlaceholder": "搜索日志…",
  "regex": "正则",
  "regexHint": "将关键字按正则表达式匹配",
  "invalidRegex": "正则表达式无效",
  "wrap": "折行",
  "wrapHint": "长行折行显示（关闭则横向滚动）",
  "timestamps": "时间戳",
  "timestampsHint": "显示/隐藏行首时间戳",
  "refresh": "刷新",
  "download": "下载日志",
  "copy": "复制日志",
  "stat": "已加载 {loaded} 行 / 可见 {visible} 行",
  "backToBottom": "回到底部（{n} 新行）",
  "streamInterrupted": "日志流已中断",
  "retry": "重试",
  "loadFailed": "日志读取失败",
  "empty": "暂无日志"
}
```

`src/locales/en.json` 同位置：

```json
"logViewer": {
  "container": "Container",
  "lines": "Lines",
  "since": "Since",
  "since_all": "All",
  "since_300": "5 min",
  "since_900": "15 min",
  "since_3600": "1 hour",
  "since_21600": "6 hours",
  "previous": "Previous",
  "previousHint": "Show logs from the previous (crashed) container instance",
  "follow": "Follow",
  "live": "Live",
  "searchPlaceholder": "Search logs…",
  "regex": "Regex",
  "regexHint": "Match keyword as a regular expression",
  "invalidRegex": "Invalid regular expression",
  "wrap": "Wrap",
  "wrapHint": "Wrap long lines (off = horizontal scroll)",
  "timestamps": "Timestamps",
  "timestampsHint": "Show/hide leading timestamps",
  "refresh": "Refresh",
  "download": "Download logs",
  "copy": "Copy logs",
  "stat": "{loaded} loaded / {visible} visible",
  "backToBottom": "Back to bottom ({n} new)",
  "streamInterrupted": "Log stream interrupted",
  "retry": "Retry",
  "loadFailed": "Failed to read logs",
  "empty": "No logs"
}
```

- [ ] **Step 2: 写失败组件测试**

```js
// src/components/common/__tests__/LogViewerBody.test.js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

// k8sStream 捕获 handlers 后由测试手动推流；api.k8s 静态返回三行
let streamHandlers = null
const k8sStreamMock = vi.fn((path, handlers) => { streamHandlers = { path, ...handlers }; return { abort: vi.fn() } })
const apiK8sMock = vi.fn(async () => '2026-01-01T00:00:00Z app started\n2026-01-01T00:00:01Z error cannot connect db\n2026-01-01T00:00:02Z warn retrying')

vi.mock('@/api/client', () => ({
  api: { k8s: apiK8sMock },
  k8sStream: k8sStreamMock,
  getSessionToken: () => 'tok',
}))

import LogViewerBody from '@/components/common/LogViewerBody.vue'

function mountBody() {
  return mount(LogViewerBody, {
    props: { namespace: 'default', podName: 'pod-1', containers: ['main', 'sidecar'] },
    global: { plugins: [createPinia(), i18n] },
  })
}

test('follow 流推入的行渲染时间戳/级别/消息，级别着色 ERROR', async () => {
  const w = mountBody()
  streamHandlers.onMessage('2026-01-01T00:00:00Z error cannot connect db')
  await w.vm.$nextTick()
  const line = w.find('[data-testid="log-line"]')
  expect(line.text()).toContain('error cannot connect db')
  expect(line.text()).toContain('ERROR')
  expect(w.find('[data-testid="log-line"] .text-error').exists()).toBe(true)
})

test('搜索过滤：只保留命中行，命中片段带高亮标记', async () => {
  const w = mountBody()
  streamHandlers.onMessage('2026-01-01T00:00:00Z app started')
  streamHandlers.onMessage('2026-01-01T00:00:01Z error cannot connect db')
  await w.vm.$nextTick()
  await w.find('[data-testid="log-search"]').setValue('db')
  await w.vm.$nextTick()
  const lines = w.findAll('[data-testid="log-line"]')
  expect(lines).toHaveLength(1)
  expect(lines[0].text()).toContain('cannot connect db')
  expect(w.find('[data-testid="log-highlight"]').exists()).toBe(true)
})

test('非法正则：显示错误提示且不过滤', async () => {
  const w = mountBody()
  streamHandlers.onMessage('2026-01-01T00:00:00Z hello')
  await w.vm.$nextTick()
  await w.find('[data-testid="log-regex"]').setValue(true)
  await w.find('[data-testid="log-search"]').setValue('[invalid')
  await w.vm.$nextTick()
  expect(w.find('[data-testid="log-regex-error"]').exists()).toBe(true)
  expect(w.findAll('[data-testid="log-line"]')).toHaveLength(1)
})

test('级别 chip：只留 ERROR', async () => {
  const w = mountBody()
  streamHandlers.onMessage('2026-01-01T00:00:00Z fine')
  streamHandlers.onMessage('2026-01-01T00:00:01Z error boom')
  await w.vm.$nextTick()
  const chips = w.findAll('[data-testid="log-level"]')   // [ERROR, WARN, INFO] 顺序
  await chips[1].trigger('click')   // 关 WARN
  await chips[2].trigger('click')   // 关 INFO
  await w.vm.$nextTick()
  const lines = w.findAll('[data-testid="log-line"]')
  expect(lines).toHaveLength(1)
  expect(lines[0].text()).toContain('boom')
})

test('previous 勾选：follow 自动关闭并改走静态拉取', async () => {
  const w = mountBody()
  await w.find('[data-testid="log-previous"]').setValue(true)
  await w.vm.$nextTick()
  expect(w.find('[data-testid="log-follow"]').element.disabled).toBe(true)
  expect(apiK8sMock).toHaveBeenCalled()
  expect(w.text()).toContain('app started')   // 静态三行渲染
})

test('上滚暂停跟随：出现回到底部按钮，点击恢复', async () => {
  const w = mountBody()
  const el = w.find('[data-testid="log-scroll"]').element
  streamHandlers.onMessage('2026-01-01T00:00:00Z one')
  await w.vm.$nextTick()
  // happy-dom 无真实布局：手动构造「远离底部」再派发 scroll
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
  el.scrollTop = 0
  await w.find('[data-testid="log-scroll"]').trigger('scroll')
  expect(w.find('[data-testid="back-to-bottom"]').exists()).toBe(true)
  streamHandlers.onMessage('2026-01-01T00:00:01Z two')
  await w.vm.$nextTick()
  expect(w.find('[data-testid="back-to-bottom"]').text()).toContain('1')
  await w.find('[data-testid="back-to-bottom"]').trigger('click')
  expect(w.find('[data-testid="back-to-bottom"]').exists()).toBe(false)
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/LogViewerBody.test.js`
Expected: FAIL（组件不存在）

- [ ] **Step 4: 写组件**

```vue
<script setup>
// 共享 Pod 日志查看器：PodDetail logs tab（内嵌）与 LogPopup（新标签页）同源。
// 工具栏：查询（容器/tail/since/previous/follow）+ 搜索（正则开关）+ 级别过滤 + 显示（折行/时间戳）+ 操作（刷新/下载/复制）。
// 智能滚动：贴底自动跟随，上滚暂停并显示「回到底部（N 新行）」。
import { ref, computed, watch, onMounted, nextTick, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLogViewer, LOG_LINE_OPTIONS, LOG_SINCE_OPTIONS } from '@/composables/useLogViewer'
import { compileFilter, isNearBottom, levelCounts } from '@/logic/podLogs'

const { t } = useI18n()
const props = defineProps({
  namespace: { type: String, required: true },
  podName: { type: String, required: true },
  containers: { type: Array, default: () => [] },
})
// 容器双向绑定：PodDetail 跨 tab 共享 selectedContainer；LogPopup 自持
const container = defineModel('container', { type: String, default: '' })
if (!container.value && props.containers.length) container.value = props.containers[0]
watch(() => props.containers, cs => { if (!cs.includes(container.value)) container.value = cs[0] || '' })

// 解构保持模板自动解包（viewer.lines 嵌套 ref 不会解包）
const { lines, followLog, logLines, logSince, logPrevious, streamError, restart } = useLogViewer({
  namespace: toRef(props, 'namespace'),
  podName: toRef(props, 'podName'),
  container,
})

// === 搜索 / 级别过滤（纯前端，作用于已加载行）===
const search = ref('')
const useRegex = ref(false)
const activeLevels = ref(['ERROR', 'WARN', 'INFO'])
const filter = computed(() => compileFilter({ search: search.value, useRegex: useRegex.value, levels: activeLevels.value }))
const visibleLines = computed(() => lines.value.filter(l => filter.value.test(l)))
const counts = computed(() => levelCounts(lines.value))
function toggleLevel(lv) {
  activeLevels.value = activeLevels.value.includes(lv)
    ? activeLevels.value.filter(x => x !== lv)
    : [...activeLevels.value, lv]
}
const LEVEL_CHIPS = [
  { lv: 'ERROR', on: 'bg-error/15 text-error border-error/40' },
  { lv: 'WARN', on: 'bg-tertiary-container/15 text-tertiary-container border-tertiary-container/40' },
  { lv: 'INFO', on: 'bg-primary-container/10 text-primary border-primary/30' },
]

// === 显示选项 ===
const wrap = ref(true)
const showTs = ref(true)

// === 智能自动滚动 ===
const scrollEl = ref(null)
const following = ref(true)
const pausedNew = ref(0)
function onScroll() {
  const el = scrollEl.value
  if (!el) return
  if (isNearBottom(el)) { following.value = true; pausedNew.value = 0 }
  else following.value = false
}
watch(() => lines.value.length, async (n, o = 0) => {
  if (n <= o) return
  if (following.value) { await nextTick(); const el = scrollEl.value; if (el) el.scrollTop = el.scrollHeight }
  else pausedNew.value += n - o
})
function backToBottom() {
  const el = scrollEl.value
  if (el) el.scrollTop = el.scrollHeight
  following.value = true
  pausedNew.value = 0
}
onMounted(async () => { await nextTick(); const el = scrollEl.value; if (el) el.scrollTop = el.scrollHeight })

// === 导出（WYSIWYG：过滤后的可见行）===
function formatLines() {
  return visibleLines.value.map(l => `${showTs.value ? l.timestamp + ' ' : ''}[${l.level}] ${l.message}`).join('\n')
}
function downloadLogs() {
  const blob = new Blob([formatLines()], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${props.podName}-logs.txt`
  a.click()
  URL.revokeObjectURL(url)
}
async function copyLogs() {
  try { await navigator.clipboard.writeText(formatLines()) } catch { /* clipboard 不可用静默 */ }
}
</script>

<template>
  <div class="relative flex flex-col min-h-0 h-full">
    <!-- 错误横幅：流中断/拉取失败 -->
    <div v-if="streamError" data-testid="log-error-banner" class="flex items-center gap-xs px-md py-1 bg-error/10 text-error text-body-xs border-b border-error/30 shrink-0">
      <span class="material-symbols-outlined text-sm">error</span>{{ t('component.logViewer.streamInterrupted') }}
      <button @click="restart" class="ml-auto underline">{{ t('component.logViewer.retry') }}</button>
    </div>

    <!-- 工具栏 -->
    <div class="bg-surface-container-highest/50 px-md py-2 flex flex-wrap items-center gap-md border-b border-outline-variant shrink-0">
      <div class="flex items-center gap-xs">
        <span class="text-body-sm text-on-surface-variant font-medium">{{ t('component.logViewer.container') }}</span>
        <select v-model="container" data-testid="log-container" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-sm font-mono focus:ring-2 focus:ring-primary">
          <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div class="flex items-center gap-xs">
        <span class="text-body-sm text-on-surface-variant font-medium">{{ t('component.logViewer.lines') }}</span>
        <select v-model="logLines" data-testid="log-lines" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-sm font-mono focus:ring-2 focus:ring-primary">
          <option v-for="n in LOG_LINE_OPTIONS" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
      <div class="flex items-center gap-xs">
        <span class="text-body-sm text-on-surface-variant font-medium">{{ t('component.logViewer.since') }}</span>
        <select v-model="logSince" data-testid="log-since" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-sm font-mono focus:ring-2 focus:ring-primary">
          <option v-for="o in LOG_SINCE_OPTIONS" :key="o.value" :value="o.value">{{ t('component.logViewer.since_' + (o.value || 'all')) }}</option>
        </select>
      </div>
      <label class="flex items-center gap-1 cursor-pointer select-none" :class="logPrevious ? 'text-tertiary-container font-medium' : 'text-on-surface-variant'" :title="t('component.logViewer.previousHint')">
        <input v-model="logPrevious" data-testid="log-previous" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" />
        <span class="text-body-sm font-medium">{{ t('component.logViewer.previous') }}</span>
      </label>
      <label class="flex items-center gap-1 cursor-pointer select-none" :class="logPrevious ? 'text-on-surface-variant/50' : 'text-on-surface-variant'">
        <input v-model="followLog" data-testid="log-follow" :disabled="logPrevious" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" />
        <span class="text-body-sm">{{ t('component.logViewer.follow') }}</span>
        <span v-if="followLog" class="flex items-center gap-xs ml-xs px-sm py-0 bg-primary-container/10 text-primary text-xs rounded-full">
          <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-status"></span>{{ t('component.logViewer.live') }}
        </span>
      </label>
      <div class="flex items-center gap-xs">
        <span class="material-symbols-outlined text-body-base text-on-surface-variant">search</span>
        <input v-model="search" data-testid="log-search" type="text" :placeholder="t('component.logViewer.searchPlaceholder')" class="w-40 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-sm font-mono focus:ring-2 focus:ring-primary" />
        <label class="flex items-center gap-0.5 text-body-xs cursor-pointer select-none" :class="useRegex ? 'text-primary font-medium' : 'text-on-surface-variant'" :title="t('component.logViewer.regexHint')">
          <input v-model="useRegex" data-testid="log-regex" type="checkbox" class="h-3 w-3" />{{ t('component.logViewer.regex') }}
        </label>
        <span v-if="filter.error" data-testid="log-regex-error" class="text-error text-body-xs">{{ t('component.logViewer.invalidRegex') }}</span>
      </div>
      <div class="flex items-center gap-1">
        <button v-for="c in LEVEL_CHIPS" :key="c.lv" data-testid="log-level" @click="toggleLevel(c.lv)"
          class="px-sm py-0.5 rounded-full text-[11px] font-mono border transition-colors"
          :class="activeLevels.includes(c.lv) ? c.on : 'border-outline-variant/50 text-on-surface-variant/40'">
          {{ c.lv }} {{ counts[c.lv] }}
        </button>
      </div>
      <div class="flex items-center gap-1 ml-auto">
        <label :title="t('component.logViewer.wrapHint')" class="flex items-center gap-0.5 text-body-xs cursor-pointer select-none" :class="wrap ? 'text-primary font-medium' : 'text-on-surface-variant'">
          <input v-model="wrap" type="checkbox" class="h-3 w-3" />{{ t('component.logViewer.wrap') }}
        </label>
        <label :title="t('component.logViewer.timestampsHint')" class="flex items-center gap-0.5 text-body-xs cursor-pointer select-none" :class="showTs ? 'text-primary font-medium' : 'text-on-surface-variant'">
          <input v-model="showTs" type="checkbox" class="h-3 w-3" />{{ t('component.logViewer.timestamps') }}
        </label>
        <button @click="restart" :title="t('component.logViewer.refresh')" class="p-1 hover:bg-surface-container-low rounded"><span class="material-symbols-outlined text-body-md">refresh</span></button>
        <button @click="downloadLogs" :title="t('component.logViewer.download')" class="p-1 hover:bg-surface-container-low rounded"><span class="material-symbols-outlined text-body-md">download</span></button>
        <button @click="copyLogs" :title="t('component.logViewer.copy')" class="p-1 hover:bg-surface-container-low rounded"><span class="material-symbols-outlined text-body-md">content_copy</span></button>
      </div>
    </div>

    <!-- 状态行 -->
    <div class="px-md py-0.5 text-[11px] text-on-surface-variant/60 border-b border-outline-variant/50 shrink-0">{{ t('component.logViewer.stat', { loaded: lines.length, visible: visibleLines.length }) }}</div>

    <!-- 渲染区 -->
    <div ref="scrollEl" data-testid="log-scroll" @scroll="onScroll" class="flex-1 min-h-0 overflow-auto bg-code-surface p-md font-mono text-code-sm code-scroll" :class="wrap ? '' : '[&>div]:whitespace-pre [&>div]:overflow-x-visible'">
      <p v-if="!visibleLines.length" class="text-outline-variant py-md text-center">{{ t('component.logViewer.empty') }}</p>
      <div v-for="(log, idx) in visibleLines" :key="idx" data-testid="log-line" class="leading-relaxed break-all" :class="wrap ? 'whitespace-pre-wrap' : 'whitespace-pre'">
        <span v-if="showTs" class="text-outline-variant/70">{{ log.timestamp }} </span>
        <span :class="log.level === 'ERROR' ? 'text-error' : log.level === 'WARN' ? 'text-tertiary-fixed-dim' : 'text-outline-variant'">[{{ log.level }}]</span>
        <span v-for="(seg, si) in filter.highlight(log.message)" :key="si" :data-testid="seg.hit ? 'log-highlight' : undefined" :class="seg.hit ? 'bg-primary/30 text-on-surface rounded-sm' : ''">{{ seg.text }}</span>
      </div>
      <div v-if="followLog" class="w-1.5 h-4 bg-primary inline-block animate-pulse ml-1 align-middle"></div>
    </div>

    <!-- 回到底部悬浮按钮（follow 中用户上滚时出现） -->
    <button v-if="followLog && !following" data-testid="back-to-bottom" @click="backToBottom"
      class="absolute bottom-4 right-4 flex items-center gap-xs px-sm py-1 rounded-full bg-surface-container-high border border-outline-variant shadow-card text-body-xs text-primary hover:bg-surface-container-highest transition-colors">
      <span class="material-symbols-outlined text-sm">arrow_downward</span>{{ t('component.logViewer.backToBottom', { n: pausedNew }) }}
    </button>
  </div>
</template>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/LogViewerBody.test.js`
Expected: PASS（6 用例全绿）

- [ ] **Step 6: 提交**

```bash
git add src/components/common/LogViewerBody.vue src/components/common/__tests__/LogViewerBody.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(logs): 共享 LogViewerBody——搜索/级别过滤/智能滚动/折行时间戳切换/导出"
```

---

### Task 4: `LogPopup.vue` 独立日志页 + 路由与守卫

**Files:**
- Create: `src/views/LogPopup.vue`
- Modify: `src/router/index.js:30-35`（TerminalPopup 路由后加 LogPopup 路由）、`src/router/index.js:514`（守卫豁免数组化）
- Modify: `src/locales/zh.json`/`en.json`（顶层 `logPopup.*` 键）
- Test: `src/views/__tests__/LogPopup.test.js`

**Interfaces:**
- Consumes: Task 3 的 `LogViewerBody`；`@/api/client` 的 `api`；`@/stores/cluster` 的 `setNamespace`；`@/styles/code-theme`。
- Produces: 路由 `/log-popup?ns&pod&container&token`（name `LogPopup`，守卫豁免，与 TerminalPopup 同语义）。

- [ ] **Step 1: 加 i18n 键**

zh.json 顶层新增（与 `terminal` 平级）：

```json
"logPopup": { "title": "日志 · {pod}/{container}", "closeWindow": "关闭窗口" }
```

en.json：

```json
"logPopup": { "title": "Logs · {pod}/{container}", "closeWindow": "Close window" }
```

- [ ] **Step 2: 写失败测试**

```js
// src/views/__tests__/LogPopup.test.js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { i18n } from '@/i18n'

const apiK8sMock = vi.fn(async () => ({
  spec: {
    containers: [{ name: 'main' }, { name: 'sidecar' }],
    initContainers: [{ name: 'init-db' }],
    ephemeralContainers: [{ name: 'debugger' }],
  },
}))
vi.mock('@/api/client', () => ({ api: { k8s: apiK8sMock }, getSessionToken: () => 'tok' }))

import LogPopup from '@/views/LogPopup.vue'

// LogViewerBody 桩：捕获 props，避免其内部 composable 发请求
const bodyProps = []
const BodyStub = defineComponent({
  props: ['namespace', 'podName', 'containers', 'container'],
  template: '<div data-testid="log-viewer-stub">{{ containers.join(",") }}</div>',
  mounted() { bodyProps.push({ ns: this.namespace, pod: this.podName, containers: [...this.containers] }) },
})

async function mountPopup() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/log-popup', name: 'LogPopup', component: LogPopup }] })
  router.push('/log-popup?ns=default&pod=pod-1&container=main')
  await router.isReady()
  return mount(LogPopup, {
    global: { plugins: [createPinia(), i18n, router], stubs: { LogViewerBody: BodyStub } },
  })
}

test('从 URL 读 ns/pod/container，拉 pod spec 组全量容器列表（含 init/ephemeral）传给 LogViewerBody', async () => {
  sessionStorage.setItem('aliangboard.session', 'tok')
  const w = await mountPopup()
  await new Promise(r => setTimeout(r, 0))   // 等 onMounted 的 api.k8s
  expect(apiK8sMock).toHaveBeenCalledWith('/api/v1/namespaces/default/pods/pod-1')
  expect(w.find('[data-testid="log-viewer-stub"]').text()).toBe('main,sidecar,init-db,debugger')
})

test('容器列表拉取失败：回退为 URL 单容器，页面不崩', async () => {
  sessionStorage.setItem('aliangboard.session', 'tok')
  apiK8sMock.mockRejectedValueOnce(new Error('404'))
  const w = await mountPopup()
  await new Promise(r => setTimeout(r, 0))
  expect(w.find('[data-testid="log-viewer-stub"]').text()).toBe('main')
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/LogPopup.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 写视图 + 路由**

`src/views/LogPopup.vue`：

```vue
<script setup>
// 独立日志页（新浏览器标签页打开，TerminalPopup 同构）：全屏日志，无侧栏/顶栏。
// URL: /log-popup?ns=xxx&pod=xxx&container=xxx&token=xxx
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LogViewerBody from '@/components/common/LogViewerBody.vue'
import { api } from '@/api/client'
import { useClusterStore } from '@/stores/cluster'
import { codeTheme } from '@/styles/code-theme'

const { t } = useI18n()
const route = useRoute()
const store = useClusterStore()
const ns = computed(() => String(route.query.ns || ''))
const pod = computed(() => String(route.query.pod || ''))
const container = ref(String(route.query.container || ''))
// 容器列表：先以 URL 单容器兜底，挂载后拉 pod spec 补全（containers+initContainers+ephemeralContainers）
const containers = ref(container.value ? [container.value] : [])

// session token 已由 main.js 从 URL 写入 sessionStorage；缺失则整页提示会话过期
const hasToken = !!sessionStorage.getItem('aliangboard.session')
if (!hasToken) {
  document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:${codeTheme.surface};color:${codeTheme.onSurface};font-family:monospace;font-size:14px">${t('terminal.expired')}</div>`
} else if (ns.value) {
  store.setNamespace(ns.value)
}

document.title = t('logPopup.title', { pod: pod.value, container: container.value })

function containerNames(raw) {
  const spec = raw?.spec || {}
  return [...new Set([...(spec.containers || []), ...(spec.initContainers || []), ...(spec.ephemeralContainers || [])]
    .map(c => c?.name).filter(Boolean))]
}
onMounted(async () => {
  try {
    const raw = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns.value)}/pods/${encodeURIComponent(pod.value)}`)
    const names = containerNames(raw)
    if (names.length) containers.value = names
  } catch { /* 拉取失败保留 URL 单容器兜底 */ }
})
function close() { window.close() }
</script>

<template>
  <div class="h-screen w-screen flex flex-col bg-code-surface">
    <!-- 顶栏（pod 名 + 定位 + 关闭） -->
    <div class="flex items-center gap-sm px-md shrink-0 bg-surface-container-high border-b border-outline-variant" style="height: 36px">
      <span class="material-symbols-outlined text-base text-primary">subject</span>
      <span class="text-body-sm font-medium text-on-surface truncate flex-1">{{ pod }}</span>
      <span class="text-body-xs text-on-surface-variant/60 font-mono">{{ ns }}/{{ pod }}{{ container ? ':' + container : '' }}</span>
      <button @click="close" class="flex items-center gap-xs px-sm py-0.5 rounded-md bg-error/10 text-error hover:bg-error/20 text-body-xs font-medium transition-colors shrink-0">
        <span class="material-symbols-outlined text-sm">close</span>{{ t('logPopup.closeWindow') }}
      </button>
    </div>
    <!-- 全屏日志查看器 -->
    <div class="flex-1 min-h-0">
      <LogViewerBody :namespace="ns" :pod-name="pod" :containers="containers" v-model:container="container" />
    </div>
  </div>
</template>
```

`src/router/index.js`——TerminalPopup 路由（:31-35）之后新增：

```js
  {
    // 独立日志页（新浏览器标签页打开），不走 AppLayout（无侧栏/顶栏，全屏日志）
    path: '/log-popup',
    name: 'LogPopup',
    component: () => import('@/views/LogPopup.vue'),
    meta: { title: 'Logs' }
  },
```

守卫豁免（router/index.js:514 一带，原 `if (to.name === 'TerminalPopup') return`）改为：

```js
  if (['TerminalPopup', 'LogPopup'].includes(to.name)) return
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/LogPopup.test.js`
Expected: PASS（2 用例全绿）

- [ ] **Step 6: 跑全量单测确认无回归**（`src/__tests__/_allViewsMount` 等冒烟会自动扫到新视图）

Run: `npm run test:unit`
Expected: 全绿（若全量挂测桩对新视图报错，按既有桩模式补 stub，不改产品代码语义）

- [ ] **Step 7: 提交**

```bash
git add src/views/LogPopup.vue src/views/__tests__/LogPopup.test.js src/router/index.js src/locales/zh.json src/locales/en.json
git commit -m "feat(logs): LogPopup 独立日志页(/log-popup 守卫豁免)——容器列表自拉+URL兜底"
```

---

### Task 5: PodCard 日志按钮 + NsWorkloadDetail viewLogs 改新标签页

**Files:**
- Modify: `src/components/common/PodCard.vue`（:8-10 import 区、:14-29 props、:55-60 函数区、:81 文件按钮后）
- Modify: `src/views/NsWorkloadDetail.vue:547-549`（viewLogs）
- Modify: `src/locales/zh.json`/`en.json`（`component.podCard.logsTitle`）
- Test: Create `src/components/common/__tests__/PodCard.test.js`

**Interfaces:**
- Consumes: Task 2 的 `openLogTab`。
- Produces: PodCard 新 prop `showLogs: Boolean = true`；点击日志按钮 → `openLogTab({ namespace, podName, container })`（container 取第一个容器，形状与终端/文件入口一致 `(c && (c.name || c)) || 'main'`）。

- [ ] **Step 1: 加 i18n 键**

zh.json `component.podCard` 内（`filesDisabled` 后）：`"logsTitle": "查看日志"`；en.json：`"logsTitle": "View logs"`。

- [ ] **Step 2: 写失败测试**

```js
// src/components/common/__tests__/PodCard.test.js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const openLogTabMock = vi.fn()
vi.mock('@/composables/useLogViewer', () => ({ openLogTab: openLogTabMock }))
// PodCard 依赖的终端/文件 store 与 usePod 工具照常（不涉及网络）
vi.mock('@/stores/terminals', () => ({ useTerminalStore: () => ({ openTerminal: vi.fn() }) }))
vi.mock('@/stores/fileBrowsers', () => ({ useFileBrowserStore: () => ({ openBrowser: vi.fn() }) }))

import PodCard from '@/components/common/PodCard.vue'

const POD = {
  name: 'web-abc123', namespace: 'default', status: 'Running', age: '1h',
  containers: [{ name: 'main' }, { name: 'sidecar' }],
}

function mountCard(props = {}) {
  return mount(PodCard, { props: { pod: POD, ...props }, global: { plugins: [createPinia(), i18n] } })
}

test('日志按钮默认展示：点击 openLogTab 带第一个容器', async () => {
  const w = mountCard()
  await w.find('[data-testid="podcard-logs"]').trigger('click')
  expect(openLogTabMock).toHaveBeenCalledWith({ namespace: 'default', podName: 'web-abc123', container: 'main' })
})

test('CrashLoopBackOff（非 Running）不禁用日志按钮——previous 日志是刚需', async () => {
  const w = mountCard({ pod: { ...POD, status: 'CrashLoopBackOff' } })
  const btn = w.find('[data-testid="podcard-logs"]')
  expect(btn.attributes('disabled')).toBeUndefined()
  await btn.trigger('click')
  expect(openLogTabMock).toHaveBeenCalled()
})

test('showLogs=false 隐藏日志按钮', () => {
  const w = mountCard({ showLogs: false })
  expect(w.find('[data-testid="podcard-logs"]').exists()).toBe(false)
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/PodCard.test.js`
Expected: FAIL（无 `podcard-logs` 按钮）

- [ ] **Step 4: 改 PodCard 与 NsWorkloadDetail**

PodCard.vue——import 区（:8-10 附近）加：

```js
import { openLogTab } from '@/composables/useLogViewer'
```

props（:27-28 `showTerminal/showFiles` 后）加：

```js
  // 快速入口：终端（exec）/ 文件浏览 / 日志（新标签页）；点击导航到 PodDetail 对应 tab
  showLogs: { type: Boolean, default: true },
```

函数区（:55-60 `openTerm` 后）加：

```js
// 日志：新浏览器标签页打开独立日志页（具名 target 去重复用）。不受 canExec 限制——
// CrashLoopBackOff/Pending 看 previous 日志是刚需，K8s log API 对未运行容器返回错误由日志页内横幅呈现。
function openLogs() {
  const c = containers.value?.[0]
  openLogTab({ namespace: pod.value.namespace, podName: pod.value.name, container: (c && (c.name || c)) || 'main' })
}
```

模板（:81 文件按钮之后、:82 删除按钮之前）加：

```html
      <button v-if="showLogs" @click.stop="openLogs" :title="t('component.podCard.logsTitle')" data-testid="podcard-logs" class="p-0.5 rounded hover:bg-primary/10 text-on-surface-variant/50 hover:text-primary transition-colors shrink-0"><span class="material-symbols-outlined text-sm">subject</span></button>
```

NsWorkloadDetail.vue:547-549 `viewLogs` 改为：

```js
function viewLogs(p) {
  // 新浏览器标签页打开独立日志页（不再页内跳转 PodDetail#logs）
  openLogTab({ namespace: route.params.namespace, podName: p.name, container: p.containers?.[0] || 'main' })
}
```

并在该文件 import 区加 `import { openLogTab } from '@/composables/useLogViewer'`（与现有 `useTerminalStore` import 相邻）。注意：NsWorkloadDetail 中 `p.containers` 是容器名字符串数组（见 `openExec` :553 同款用法）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/PodCard.test.js`
Expected: PASS（3 用例全绿）

- [ ] **Step 6: 提交**

```bash
git add src/components/common/PodCard.vue src/components/common/__tests__/PodCard.test.js src/views/NsWorkloadDetail.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(logs): PodCard 日志快捷按钮(不受 Running 限制)+NsWorkloadDetail viewLogs 改新标签页"
```

---

### Task 6: PodDetail logs tab 换装 LogViewerBody

**Files:**
- Modify: `src/views/PodDetail.vue`（:18 import、:74-168 日志逻辑区、:371-418 模板 logs 块）

**Interfaces:**
- Consumes: Task 3 的 `LogViewerBody`（props `namespace/podName/containers`，`v-model:container`）。
- Produces: 无（终端消费者）。`selectedContainer`/`containers` computed 保留（terminal/files tab 共用）。

本任务是删旧换新的机械重构，正确性由 LogViewerBody 组件测试 + 全量门禁 + 冒烟保障，不新增 PodDetail 专项测试（无既有 PodDetail 测试文件，新写需 mock 十余个依赖，性价比低）。

- [ ] **Step 1: 换模板**——:371-418 的 `<!-- Logs View -->` 整块（`v-if="activeTab === 'logs'"` 的 div 及其内部工具栏/渲染区）替换为：

```html
        <!-- Logs View（共享 LogViewerBody：与 LogPopup 新标签页同源）-->
        <div v-if="activeTab === 'logs'" class="flex-1 flex flex-col min-h-0">
          <LogViewerBody :namespace="pod.namespace" :pod-name="pod.name" :containers="containers" v-model:container="selectedContainer" class="flex-1 min-h-0" />
        </div>
```

- [ ] **Step 2: 删脚本区旧日志逻辑**——:18 import 行改为 `import { api, podDebugApi, exportYaml } from '@/api/client'`（`k8sStream` 仅日志使用，移除）；:74-168 区内删除以下成员（逐个 grep 确认无其他引用后删）：
  - `levelColor` 函数（:74-77）
  - `formatLogs/downloadLogs/copyLogs`（:80-96）
  - `followLog/liveLogs/logStream/logLines/logSince/logPrevious/lineOptions/sinceOptions`（:99-113）
  - `logQuery/parseLogLine/pushParsed/loadRemoteLogs/startFollow/stopFollow`（:114-156）
  - 三个 watch：`watch(followLog…)`、`watch(selectedContainer…重启流)`、`watch([logLines, logSince, logPrevious]…)`（:157-166）
  - `onMounted(() => { if (followLog…)…})` / `onUnmounted(stopFollow)`（:167-168）——**保留** `onMounted/onUnmounted` import 仅当文件其余处仍用（grep 确认后决定，否则从 import 中移除）
  - `allLogs` computed（:169）
  - **保留**：`debugContainers/containers/selectedContainer` 及 `watch(pod, …selectedContainer 默认值)`（terminal/files tab 仍用）

- [ ] **Step 3: 加 import**——与其它组件 import 相邻加：

```js
import LogViewerBody from '@/components/common/LogViewerBody.vue'
```

- [ ] **Step 4: 验证**——`grep -n "k8sStream\|followLog\|liveLogs\|logQuery\|parseLogLine\|allLogs\|levelColor\|downloadLogs\|copyLogs" src/views/PodDetail.vue` 应零命中；然后全量：

Run: `npm run test:unit && npm run typecheck && npm run build`
Expected: 全绿（typecheck `node --check` 过 .js；build 编译 .vue）

- [ ] **Step 5: 提交**

```bash
git add src/views/PodDetail.vue
git commit -m "refactor(logs): PodDetail logs tab 换装共享 LogViewerBody，删本地日志逻辑约 90 行"
```

---

### Task 7: 孤儿 i18n 键清理 + 全门禁收尾

**Files:**
- Modify: `src/locales/zh.json`、`src/locales/en.json`（删被 Task 6 孤儿化的 `podDetail.*` 日志键）

- [ ] **Step 1: 找孤儿键**——对以下候选逐个 grep，仅当 `src/`（排除 locales）零引用时从 zh+en **两份同时**删除：

```
podDetail.sinceAll podDetail.since5min podDetail.since15min podDetail.since1hour podDetail.since6hours
podDetail.previousLogHint podDetail.downloadLogs podDetail.copyLogs
podDetail.logStreamInterrupted podDetail.logReadFailed podDetail.logStreamFailed
podDetail.liveStreamHint podDetail.liveStreamText podDetail.showPreviousHint
```

Run: `for k in sinceAll since5min since15min since1hour since6hours previousLogHint downloadLogs copyLogs logStreamInterrupted logReadFailed logStreamFailed liveStreamHint liveStreamText showPreviousHint; do echo "== $k: $(grep -rn "podDetail.$k" src/ --include='*.vue' --include='*.js' | grep -v locales | wc -l)"; done`
Expected: 全部 0 → 全删；非 0 的键保留（说明仍有引用处）。

- [ ] **Step 2: 全门禁**

Run: `npm test && npm run typecheck && npm run i18n:check && npm run build`
Expected: 四项全绿（i18n:check 三合一：残存中文/键对齐/引用键缺失）。

- [ ] **Step 3: 提交**

```bash
git add src/locales/zh.json src/locales/en.json
git commit -m "chore(i18n): 清理 PodDetail 换装后孤儿化的日志键(zh/en 同步)"
```

- [ ] **Step 4: 手测清单移交**（需集群，人工执行；清单见 spec 附录）：
  1. Workload Overview 中列 PodCard 点日志 → 新标签页打开，容器/行数/时间筛选生效
  2. Pods 列表页同上；同 pod+容器二击聚焦不新开；换容器新开
  3. CrashLoopBackOff Pod：按钮可点，勾 Previous 看崩溃前日志
  4. Follow 实时滚动；上滚暂停出现「回到底部（N）」，点击恢复
  5. 搜索关键字/正则高亮；级别 chip 只看 ERROR
  6. 下载/复制内容=过滤后可见行
  7. PodDetail logs tab 新工具齐全，容器选择与 terminal/files tab 联动
  8. 关闭日志标签页 → 网络面板确认流断开

---

## Self-Review 记录

- **Spec 覆盖**：入口三处（PodCard/NsWorkloadDetail viewLogs/自动覆盖 NsPods 与 Service Endpoints）→ Task 5；新标签页+具名 target → Task 2/4；工具全集（七件套+搜索/级别/滚动/折行时间戳/回到底部/刷新）→ Task 3；PodDetail 换装 → Task 6；i18n → Task 3/4/5/7；错误矩阵（流中断/拉取失败/Pending/404/空态/卸载断流/无 token）→ Task 2/3/4；缓冲 5000 → Task 1/2。无缺口。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型/命名一致性**：`parseLogLine/buildLogQuery/compileFilter/highlightSegments/isNearBottom/pushCapped/levelCounts`（Task 1）与 Task 2/3 引用一致；`useLogViewer/openLogTab/MAX_LOG_BUFFER/LOG_LINE_OPTIONS/LOG_SINCE_OPTIONS`（Task 2）与 Task 3/4/5 引用一致；`LogViewerBody` props/model（Task 3）与 Task 4/6 用法一致；data-testid 命名（log-line/log-search/log-regex/log-regex-error/log-level/log-previous/log-follow/log-scroll/back-to-bottom/log-highlight/log-error-banner/podcard-logs/log-viewer-stub）测试与模板一致。
