# Namespace Overview 部署感知自适应轮询 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** workload「变更进行中」(扩缩容/编辑/回滚的 apply 过程)时,Namespace Overview 页三查询(workloads/services/ingresses)自动提频到 3s,收敛后再保持 10s 回落 30s;外部(kubectl)发起的变更同样感知。

**Architecture:** 纯函数判定模块 `src/logic/workloadTransition.js`(generation/updated/ready 三维判定,node --test)+ fastMode 状态机组合式 `src/composables/useDeployFastPoll.js`(10s 保持,vitest fake timers)+ `NamespaceOverview.vue` 接线(闭包式动态 `refetchInterval`,TDZ 安全声明顺序)。

**Tech Stack:** Vue 3 `<script setup>` + @tanstack/vue-query v5.101.4(函数式 refetchInterval 原生支持);测试分两层——纯逻辑 `node --test`、组合式 `vitest + fake timers`。

**Spec:** `docs/superpowers/specs/2026-08-16-ns-overview-adaptive-polling-design.md`(已批准)

## Global Constraints

- 分支 `feat/ns-overview-adaptive-polling`,worktree `.claude/worktrees/ns-overview-fastpoll`(已存在,勿再建)。
- 不新增依赖;不动 store/server;不改其他页面(Cluster Overview 明确不动)。
- Job/CronJob 恒不判定为进行中(范围外);查询失败(data undefined)必须安全回落 30s。
- i18n 新键 en+zh 同步;完成每个 Task 后 `npm run i18n:check`。
- 每门禁:`node --test <新测试文件>` / `npm run test:server` / `npx vitest run` / `npm run typecheck`。
- 每个 Task 单独 commit(末尾 `Co-Authored-By: Claude <noreply@anthropic.com>`)。
- 对 spec 的两处已裁决细化(实施时遵循):①`workloadCounts` 额外返回 `total`(healthOf 的 failed 判定需要);②fastMode 状态机抽成 `src/composables/useDeployFastPoll.js` 独立文件(spec 原文「不抽文件」——为 vitest fake timers 可测性,值得抽;仍是唯一消费者)。

---

### Task 1: 纯逻辑模块 workloadTransition

**Files:**
- Create: `src/logic/workloadTransition.js`
- Create: `src/logic/workloadTransition.test.mjs`(node:test 语法)
- Modify: `package.json`(test:server 链尾追加)

**Interfaces:**
- Consumes: 无(纯函数,零依赖)
- Produces(Task 2/3 依赖的精确签名):

```js
// raw = K8s 原始对象(mapWorkload 的 w.raw;含 kind/spec/status)
export function workloadCounts(raw) // → { desired, updated, ready, total }
// Deployment/StatefulSet: desired=spec.replicas??1, updated=status.updatedReplicas??0,
//   ready=status.readyReplicas??0, total=status.replicas??ready
// DaemonSet: desired=desiredNumberScheduled??0, updated=updatedNumberScheduled??0,
//   ready=numberReady??0, total=currentNumberScheduled??ready
// kind 缺失 → 按 Deployment/StatefulSet 公式
export function isWorkloadTransitioning(raw) // → boolean
// 仅 Deployment/StatefulSet/DaemonSet 参与;Job/CronJob/未知 kind → false
// 进行中 = generation > observedGeneration || updated < desired || ready < desired
// (desired=0 且 ready=0 的缩零收敛 → false)
export function anyWorkloadTransitioning(list) // → boolean;list 空/undefined → false
```

- [ ] **Step 1: 写失败测试**(完整文件)

```js
// src/logic/workloadTransition.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workloadCounts, isWorkloadTransitioning, anyWorkloadTransitioning } from './workloadTransition.js'

// K8s 真实结构:generation 在 metadata 下,observedGeneration 在 status 下
function k8s(kind, spec, status, generation, observedGeneration) {
  return {
    kind,
    metadata: { name: 'x', ...(generation != null ? { generation } : {}) },
    spec,
    status: { ...(observedGeneration != null ? { observedGeneration } : {}), ...status },
  }
}

test('workloadCounts: Deployment 取数与默认值', () => {
  assert.deepEqual(workloadCounts(k8s('Deployment', { replicas: 3 }, { readyReplicas: 2, updatedReplicas: 3, replicas: 3 })), { desired: 3, updated: 3, ready: 2, total: 3 })
  assert.deepEqual(workloadCounts(k8s('Deployment', {}, {})), { desired: 1, updated: 0, ready: 0, total: 0 })
})

test('workloadCounts: DaemonSet 用 scheduled 系列字段', () => {
  const raw = k8s('DaemonSet', {}, { desiredNumberScheduled: 5, updatedNumberScheduled: 4, numberReady: 4, currentNumberScheduled: 5 })
  assert.deepEqual(workloadCounts(raw), { desired: 5, updated: 4, ready: 4, total: 5 })
})

test('workloadCounts: kind 缺失按 replicas 公式;null 安全', () => {
  assert.equal(workloadCounts({ spec: {}, status: {} }).desired, 1)
  assert.deepEqual(workloadCounts(undefined), { desired: 1, updated: 0, ready: 0, total: 0 })
})

test('isWorkloadTransitioning: 扩容中(ready<desired)→ true', () => {
  assert.equal(isWorkloadTransitioning(k8s('Deployment', { replicas: 3 }, { readyReplicas: 1, updatedReplicas: 1 })), true)
})

test('isWorkloadTransitioning: 滚动中(updated<desired)→ true', () => {
  assert.equal(isWorkloadTransitioning(k8s('Deployment', { replicas: 3 }, { readyReplicas: 3, updatedReplicas: 2 })), true)
})

test('isWorkloadTransitioning: 刚 apply 未观测(generation>observedGeneration)→ true', () => {
  assert.equal(isWorkloadTransitioning(k8s('Deployment', { replicas: 1 }, { readyReplicas: 1, updatedReplicas: 1 }, 5, 4)), true)
})

test('isWorkloadTransitioning: 全收敛 → false', () => {
  assert.equal(isWorkloadTransitioning(k8s('Deployment', { replicas: 3 }, { readyReplicas: 3, updatedReplicas: 3, replicas: 3 }, 5, 5)), false)
})

test('isWorkloadTransitioning: 缩容到 0 → false(不误报)', () => {
  assert.equal(isWorkloadTransitioning(k8s('Deployment', { replicas: 0 }, { readyReplicas: 0, updatedReplicas: 0, replicas: 0 }, 2, 2)), false)
})

test('isWorkloadTransitioning: DaemonSet 三维判定', () => {
  assert.equal(isWorkloadTransitioning(k8s('DaemonSet', {}, { desiredNumberScheduled: 5, updatedNumberScheduled: 3, numberReady: 5 })), true)
  assert.equal(isWorkloadTransitioning(k8s('DaemonSet', {}, { desiredNumberScheduled: 5, updatedNumberScheduled: 5, numberReady: 4 })), true)
  assert.equal(isWorkloadTransitioning(k8s('DaemonSet', {}, { desiredNumberScheduled: 5, updatedNumberScheduled: 5, numberReady: 5 })), false)
})

test('isWorkloadTransitioning: Job/CronJob/未知 kind 恒 false', () => {
  assert.equal(isWorkloadTransitioning(k8s('Job', {}, { active: 3 })), false)
  assert.equal(isWorkloadTransitioning(k8s('CronJob', {}, {})), false)
  assert.equal(isWorkloadTransitioning({ spec: {}, status: {} }), false)
  assert.equal(isWorkloadTransitioning(undefined), false)
})

test('anyWorkloadTransitioning: 任一进行中/全收敛/空安全', () => {
  const busy = k8s('Deployment', { replicas: 3 }, { readyReplicas: 1 })
  const ok = k8s('Deployment', { replicas: 2 }, { readyReplicas: 2, updatedReplicas: 2 })
  assert.equal(anyWorkloadTransitioning([ok, busy]), true)
  assert.equal(anyWorkloadTransitioning([ok]), false)
  assert.equal(anyWorkloadTransitioning([]), false)
  assert.equal(anyWorkloadTransitioning(undefined), false)
})
```

注意:`k8s()` 辅助按 K8s 真实结构构造(generation 在 `metadata` 下)。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/logic/workloadTransition.test.mjs`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**(完整文件)

```js
// workload「变更进行中」判定(纯函数,零依赖,node --test 直测)。
// 消费方:NsOverview 自适应轮询(useDeployFastPoll)+ healthOf 取数。
// 语义:进行中 = generation 未被观测(刚 apply/回滚)|| updated 未达 desired(滚动中)|| ready 未达 desired(扩容中)。
// 仅 Deployment/StatefulSet/DaemonSet 参与;Job/CronJob 与未知 kind 恒 false(范围外,后续可扩)。

const TRANSITIONING_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet'])

export function workloadCounts(raw) {
  const st = raw?.status || {}
  const spec = raw?.spec || {}
  if (raw?.kind === 'DaemonSet') {
    const ready = st.numberReady ?? 0
    return { desired: st.desiredNumberScheduled ?? 0, updated: st.updatedNumberScheduled ?? 0, ready, total: st.currentNumberScheduled ?? ready }
  }
  const ready = st.readyReplicas ?? 0
  return { desired: spec.replicas ?? 1, updated: st.updatedReplicas ?? 0, ready, total: st.replicas ?? ready }
}

export function isWorkloadTransitioning(raw) {
  if (!raw || !TRANSITIONING_KINDS.has(raw.kind)) return false
  const { desired, updated, ready } = workloadCounts(raw)
  const gen = raw.metadata?.generation   // K8s 真实路径:metadata.generation
  if (gen != null && raw.status?.observedGeneration != null && gen > raw.status.observedGeneration) return true
  return updated < desired || ready < desired
}

export function anyWorkloadTransitioning(list) {
  for (const raw of list || []) if (isWorkloadTransitioning(raw)) return true
  return false
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/logic/workloadTransition.test.mjs`
Expected: PASS(全部)

- [ ] **Step 5: 注册进测试链**

`package.json` 的 `test:server` 值末尾追加(在 `node --test src/composables/useIngressRules.test.mjs` 之后):

```
 && node --test src/logic/workloadTransition.test.mjs
```

Run: `npm run test:server`
Expected: 全绿(现有用例不回归)

- [ ] **Step 6: Commit**

```bash
git add src/logic/workloadTransition.js src/logic/workloadTransition.test.mjs package.json
git commit -m "feat(overview): workload 变更进行中判定纯函数(generation/updated/ready 三维)"
```

---

### Task 2: fastMode 状态机组合式

**Files:**
- Create: `src/composables/useDeployFastPoll.js`
- Create: `src/composables/__tests__/useDeployFastPoll.test.js`(vitest)

**Interfaces:**
- Consumes: Task 1 的 `anyWorkloadTransitioning(list)`
- Produces(Task 3 依赖):

```js
import { useDeployFastPoll } from '@/composables/useDeployFastPoll'
const { fastMode } = useDeployFastPoll(source, { holdMs = 10000 } = {})
// source: () => rawWorkloadArray(懒求值 getter;返回 K8s raw 数组,空/undefined 安全)
// fastMode: Ref<boolean> —— 检测到进行中→立即 true;检测到收敛→保持 holdMs 后才 false(期内再进行中则取消回落)
// 组件作用域销毁时清回落 timer(onScopeDispose)
// 常量:export const FAST_MS = 3000, SLOW_MS = 30000
```

- [ ] **Step 1: 写失败测试**(完整文件)

```js
// src/composables/__tests__/useDeployFastPoll.test.js
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, computed, effectScope } from 'vue'
import { useDeployFastPoll, FAST_MS, SLOW_MS } from '@/composables/useDeployFastPoll'

const busyRaw = { kind: 'Deployment', spec: { replicas: 3 }, status: { readyReplicas: 1 } }
const okRaw = { kind: 'Deployment', spec: { replicas: 2 }, status: { readyReplicas: 2, updatedReplicas: 2 } }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('常量:FAST=3000 / SLOW=30000', () => {
  expect(FAST_MS).toBe(3000)
  expect(SLOW_MS).toBe(30000)
})

test('初始空数据 → fastMode false', () => {
  const src = ref([])
  const { fastMode } = useDeployFastPoll(() => src.value)
  expect(fastMode.value).toBe(false)
})

test('进行中 → 立即 true;收敛 → 保持 holdMs 后才 false', () => {
  const src = ref([okRaw])
  const { fastMode } = useDeployFastPoll(() => src.value, { holdMs: 10000 })
  expect(fastMode.value).toBe(false)
  src.value = [busyRaw]
  expect(fastMode.value).toBe(true)          // 上升沿立即
  src.value = [okRaw]
  expect(fastMode.value).toBe(true)          // 收敛后仍保持
  vi.advanceTimersByTime(9999)
  expect(fastMode.value).toBe(true)
  vi.advanceTimersByTime(1)
  expect(fastMode.value).toBe(false)         // 10s 到点回落
})

test('保持期内再次进行中 → 取消回落并维持 true;再次收敛重新计时', () => {
  const src = ref([okRaw])
  const { fastMode } = useDeployFastPoll(() => src.value, { holdMs: 10000 })
  src.value = [busyRaw]
  src.value = [okRaw]
  vi.advanceTimersByTime(6000)
  src.value = [busyRaw]                       // 保持期内又进行中
  vi.advanceTimersByTime(5000)                // 原计时早已过点但被取消
  expect(fastMode.value).toBe(true)
  src.value = [okRaw]
  vi.advanceTimersByTime(10000)               // 重新计时完整 holdMs
  expect(fastMode.value).toBe(false)
})

test('连续收敛不叠加回落 timer(不提前回落)', () => {
  const src = ref([busyRaw])
  const { fastMode } = useDeployFastPoll(() => src.value, { holdMs: 10000 })
  src.value = [okRaw]
  src.value = [...src.value]                  // 触发 watch 重算(bool 不变,不重置)
  vi.advanceTimersByTime(5000)
  src.value = [...src.value]
  vi.advanceTimersByTime(5000)
  expect(fastMode.value).toBe(false)          // 恰好 10s 回落,未被中途重置延后
})

test('作用域销毁清 timer:dispose 后推进时间无泄漏副作用', () => {
  const scope = effectScope()
  let api
  scope.run(() => {
    const src = ref([busyRaw])
    api = useDeployFastPoll(() => src.value, { holdMs: 10000 })
  })
  expect(api.fastMode.value).toBe(true)
  scope.stop()
  vi.advanceTimersByTime(60000)
  expect(api.fastMode.value).toBe(true)       // timer 已清,不再回落
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/__tests__/useDeployFastPoll.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**(完整文件)

```js
// 部署感知 fastMode 状态机:workload 变更进行中 → 立即进入高频;全部收敛 → 保持 holdMs 后回落。
// 消费方:NamespaceOverview 自适应轮询(唯一);source 为懒求值 getter,返回 K8s raw 数组。
// 边界:数据 undefined/空 → 视为收敛;作用域销毁清回落 timer(onScopeDispose)。
import { ref, computed, watch, toValue, onScopeDispose } from 'vue'
import { anyWorkloadTransitioning } from '@/logic/workloadTransition'

export const FAST_MS = 3000
export const SLOW_MS = 30000

export function useDeployFastPoll(source, { holdMs = 10000 } = {}) {
  const fastMode = ref(false)
  const pollInterval = computed(() => (fastMode.value ? FAST_MS : SLOW_MS))
  let fallTimer = null
  const stop = () => { if (fallTimer) { clearTimeout(fallTimer); fallTimer = null } }
  watch(
    () => anyWorkloadTransitioning(toValue(source)),
    busy => {
      if (busy) { stop(); fastMode.value = true }
      else if (fastMode.value && !fallTimer) fallTimer = setTimeout(() => { fallTimer = null; fastMode.value = false }, holdMs)
    },
    { immediate: true },
  )
  onScopeDispose(stop)
  return { fastMode, pollInterval }
}
```

(说明:视图侧因 TDZ 安全需要先声明 interval ref(见 Task 3),pollInterval 由本组合式导出供测试与潜在复用;两者由 FAST_MS/SLOW_MS 常量保证一致。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/__tests__/useDeployFastPoll.test.js`
Expected: PASS(5/5)

- [ ] **Step 5: Commit**

```bash
git add src/composables/useDeployFastPoll.js src/composables/__tests__/useDeployFastPoll.test.js
git commit -m "feat(overview): fastMode 状态机组合式(收敛+holdMs 保持,作用域销毁清理)"
```

---

### Task 3: NamespaceOverview 接线 + healthOf 复用 + 徽标

**Files:**
- Modify: `src/views/NamespaceOverview.vue`(查询区 26-50、healthOf 179-195、模板头部 ~232、imports)
- Modify: `src/locales/en.json` + `src/locales/zh.json`(1 新键)

**Interfaces:**
- Consumes: Task 1 `workloadCounts`;Task 2 `useDeployFastPoll/FAST_MS/SLOW_MS`
- Produces: 无(页面行为)

- [ ] **Step 1: i18n 新键**(en.json 与 zh.json 的 `ns.namespaceOverview` 段,与 `healthy`/`updating` 等键并排)

```json
"fastPolling": "Deploying · 3s refresh"      // zh: "部署进行中 · 3s 刷新"
```

- [ ] **Step 2: script 改造**(NamespaceOverview.vue)

imports 区(第 8 行 useResourceList 之后)追加:

```js
import { useDeployFastPoll, FAST_MS, SLOW_MS } from '@/composables/useDeployFastPoll'
import { workloadCounts } from '@/logic/workloadTransition'
```

查询区(26-50 行)改造——**先声明 interval 再建查询,避免 TDZ**(vue-query 在 observer 创建时会同步求值 refetchInterval 函数):

```js
// === 部署感知自适应轮询:workload 变更进行中 → 三查询 3s;收敛+10s 保持后回 30s ===
// 声明顺序即依赖顺序:pollInterval 先有值(闭包安全)→ 建查询 → fastMode 状态机消费查询数据。
const pollInterval = ref(SLOW_MS)
const workloadsKey = ['cluster', cid, 'workloads']
const workloadsQuery = useResourceList({
  key: workloadsKey,
  fetcher: () => store.fetchWorkloads(),
  options: { refetchInterval: () => pollInterval.value },
})
const nsWorkloads = computed(() => (workloadsQuery.data.value || []).filter(w => w.namespace === route.params.namespace))

// fastMode:对 ns 内 workload 判定进行中;pollInterval 随之切换(FAST/SLOW 常量同源)
const { fastMode } = useDeployFastPoll(() => nsWorkloads.value.map(w => w.raw))
watch(fastMode, f => { pollInterval.value = f ? FAST_MS : SLOW_MS }, { immediate: true })
```

(services/ingresses 两查询仅把 `refetchInterval: 30000` 改为 `refetchInterval: () => pollInterval.value`,其余不动;`watch` 已在 vue 导入里——核对第 4 行 `import { computed, ref, onUnmounted } from 'vue'` 需补 `watch`。)

healthOf(179-195 行)取数改用 `workloadCounts`,判定对齐判定模块(补 generation 维度):

```js
function healthOf(dep) {
  const raw = dep?.raw || {}
  const { desired, updated, ready, total } = workloadCounts(raw)
  const transitioning = isWorkloadTransitioning(raw)
  let level = 'healthy'
  if (ready === 0 && total > 0) level = 'failed'
  else if (desired === 0) level = 'warning'
  else if (transitioning) level = 'updating'
  else if (ready < desired) level = 'warning'
  const meta = HEALTH_META[level]
  return { desired, ready, ...meta, label: t(meta.label) }
}
```

(imports 相应补 `isWorkloadTransitioning`;原 182-187 行的按 kind 取数删除。)

- [ ] **Step 3: 模板徽标**(模板头部 ~232 行,deployCount 段落内、计数文字之后追加)

```html
<p class="text-body-sm text-on-surface-variant mt-xs">
  <span class="text-primary font-semibold">{{ workloads.length }}</span> {{ t('ns.namespaceOverview.deployCount', { n: workloads.length, layers: layerSections.filter(s => s.items.length).length }) }}
  <span v-if="fastMode" class="ml-sm inline-flex items-center gap-xs px-sm py-0.5 rounded-full bg-primary-container/15 text-primary text-xs font-medium align-middle">
    <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>{{ t('ns.namespaceOverview.fastPolling') }}
  </span>
</p>
```

- [ ] **Step 4: 全量门禁**

Run: `npx vitest run && npm run test:server && npm run typecheck && npm run i18n:check`
Expected: 全绿(含 `_allViewsMount` 挂载冒烟)

- [ ] **Step 5: 手测场景(需真实集群;无则记入报告交接)**
  1. `kubectl scale deployment <名> --replicas=5` → 页面 ≤30s 内出现「部署进行中 · 3s」徽标,ready 计数 3s 级爬升
  2. 收敛后徽标再保持 ~10s 消失,刷新回落(网络面板看请求间隔回 30s)
  3. 本 UI 内扩缩容/编辑 → invalidate 即时 refetch 后直接进入 3s
  4. 缩容到 0:过程 3s,到位后回落,无永久高频

- [ ] **Step 6: Commit**

```bash
git add src/views/NamespaceOverview.vue src/locales/en.json src/locales/zh.json
git commit -m "feat(overview): NsOverview 部署感知自适应轮询(进行中 3s/收敛+10s 回 30s+徽标)"
```

---

## Self-Review 记录

- **Spec 覆盖**:§3.1 判定模块→Task 1;§3.2 fastMode→Task 2(细化:抽组合式文件,理由见 Global Constraints);§3.3 徽标+i18n→Task 3;§4 数据流(invalidate 即时+外部周期捕获)→既有机制+Task 3 闭包间隔;§5 测试→Task 1 node 用例与 Task 2 fake timers 用例一一对应;§6 边界(undefined 回落/Job false/不动其他页)→Task 1 用例+Global Constraints。
- **占位符扫描**:无 TBD;Task 1 测试文件中的草稿辅助 `dep()` 已明确标注「落地时删除」。
- **类型一致性**:`workloadCounts→{desired,updated,ready,total}`(Task 1 定义=Task 3 healthOf 消费);`useDeployFastPoll(source,{holdMs})→{fastMode,pollInterval}`+`FAST_MS/SLOW_MS`(Task 2=Task 3);i18n 键名 `ns.namespaceOverview.fastPolling`(Task 3 Step 1=Step 3)。
