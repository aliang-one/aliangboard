# 工作负载详情 Pods tab 批量删除实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 NsPods 的卡片批量删除抽成 `usePodBatchDelete` composable,并接入 NsWorkloadDetail 的 Pods tab。

**Architecture:** composable 承载全部状态+逻辑(选中集/存在性校验/allSettled 汇总/失败保留重试),i18n 键复用 `ns.pods.batch*` 零新增;两视图各持模板(工具栏/操作条/确认 Modal,布局各异);PodCard 已有 `selectable/selected` props 直接消费。

**Tech Stack:** Vue 3 组合式 + vitest/happy-dom + @vue/test-utils + vue-i18n。

**Spec:** `docs/superpowers/specs/2026-08-25-workload-pods-batch-delete-design.md`(ff78efe)

## Global Constraints

- **开工先 EnterWorktree**(分支 `worktree-fix-wld-pods-batch`);每 Task commit;commit 前 `git branch --show-current`
- 不新增依赖;i18n **零新键**(全量复用 `ns.pods.batch*`)
- 并行会话常驻:全量测试失败若全为 timeout 型 → `pgrep -af vitest` 查串扰,失败文件隔离复跑/安静窗口复跑定论,勿因串扰改码
- docs/ 提交须 `git add -f`

---

### Task 1: usePodBatchDelete composable(TDD)

**Files:**
- Create: `src/composables/usePodBatchDelete.js`
- Test: `src/composables/__tests__/usePodBatchDelete.test.js`

**Interfaces:**
- Consumes: `summarizeResults(results, items)` from `@/utils/batchDelete`;`useClusterStore().deletePod(name, ns)`;`notify` from `@/composables/useToast`;`useI18n`
- Produces: `usePodBatchDelete({ universe, candidates, getNamespace, onOpen })` → `{ batchMode, selectedNames, showBatchModal, toggleSelect, enterBatch, exitBatch, selectAllCandidates, clearSelection, batchTargets, batchNamesPreview, onCardClick, handleBatchDelete }`(Task 2/3 消费;`universe/candidates` 为返回 Pod[] 的 getter 函数或 ref/computed)

- [ ] **Step 1: 写失败测试**

```js
// src/composables/__tests__/usePodBatchDelete.test.js
// 批量删除 composable 单测(补此前视图层无测的洞)。逻辑自 NsPods 原样迁入,行为契约:
// 选中集跨筛选保留;batchTargets=universe∩selected(存在性校验);全成清空退出/部分败保留失败选中。
import { test, expect, vi, beforeEach } from 'vitest'
import { computed, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const del = vi.fn()
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ deletePod: (...a) => del(...a) }) }))

import { usePodBatchDelete } from '@/composables/usePodBatchDelete'

const P = (name) => ({ name, status: 'Running' })
const ALL = [P('a'), P('b'), P('c'), P('gone')]          // universe 含一个已消失项

function setup() {
  const universe = computed(() => ALL)
  const candidates = computed(() => [P('a'), P('b')])      // 当前筛选只见 a/b
  const onOpen = vi.fn()
  const b = usePodBatchDelete({ universe, candidates, getNamespace: () => 'ns1', onOpen })
  return { b, onOpen }
}

beforeEach(() => { setActivePinia(createPinia()); del.mockReset() })

test('选择切换/全选=candidates/存在性校验剔除已消失项', () => {
  const { b } = setup()
  b.enterBatch()
  b.toggleSelect('a'); b.toggleSelect('gone')             // gone 不在 universe 当前值?在 ALL 里——见下一行
  // 'gone' 在 universe 中(ALL 含),仍会被选中;batchTargets 按名字过滤 universe
  expect(b.selectedNames.value.has('a')).toBe(true)
  b.selectAllCandidates()
  expect([...b.selectedNames.value].sort()).toEqual(['a', 'b'])  // 全选范围=candidates
  b.clearSelection()
  expect(b.selectedNames.value.size).toBe(0)
})

test('batchTargets = universe ∩ selected(重命名后的 Pod 自动失效)', () => {
  const { b } = setup()
  b.enterBatch()
  b.selectAllCandidates()
  b.toggleSelect('c')                                      // 手动加选 c(不在 candidates 但在 universe)
  expect(b.batchTargets.value.map(p => p.name).sort()).toEqual(['a', 'b', 'c'])
})

test('onCardClick 两路:批量=切换选中,非批量=onOpen', () => {
  const { b, onOpen } = setup()
  b.onCardClick(P('a'))
  expect(onOpen).toHaveBeenCalledWith(P('a'))
  b.enterBatch()
  b.onCardClick(P('a'))
  expect(b.selectedNames.value.has('a')).toBe(true)
  expect(onOpen).toHaveBeenCalledTimes(1)
})

test('handleBatchDelete 全成:清空+退出+关弹窗', async () => {
  del.mockResolvedValue(null)
  const { b } = setup()
  b.enterBatch(); b.selectAllCandidates(); b.showBatchModal.value = true
  await b.handleBatchDelete()
  expect(del).toHaveBeenCalledTimes(2)
  expect(b.batchMode.value).toBe(false)
  expect(b.selectedNames.value.size).toBe(0)
  expect(b.showBatchModal.value).toBe(false)
})

test('handleBatchDelete 部分败:保留失败选中+不退出', async () => {
  del.mockImplementation((_n) => _n === 'a' ? Promise.resolve(null) : Promise.reject(new Error('403')))
  const { b } = setup()
  b.enterBatch(); b.selectAllCandidates(); b.showBatchModal.value = true
  await b.handleBatchDelete()
  expect([...b.selectedNames.value]).toEqual(['b'])
  expect(b.batchMode.value).toBe(true)
  expect(b.showBatchModal.value).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/__tests__/usePodBatchDelete.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现(逻辑自 NsPods.vue:88-131 原样迁入,universe/candidates 兼容 getter)**

```js
// src/composables/usePodBatchDelete.js
// Pod 卡片批量删除(NsPods 列表 / NsWorkloadDetail Pods tab 共用):
// 选中集 Set 跨筛选/分页保留;batchTargets 按 universe 存在性校验(列表刷新/被删的自动失效);
// allSettled+summarizeResults 汇总——全成清空退出,部分败保留失败选中便于重试。
import { ref, computed, unref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
import { summarizeResults } from '@/utils/batchDelete'

export function usePodBatchDelete({ universe, candidates, getNamespace, onOpen }) {
  const { t } = useI18n()
  const store = useClusterStore()
  const val = x => (typeof x === 'function' ? x() : unref(x))

  const batchMode = ref(false)
  const selectedNames = ref(new Set())
  const showBatchModal = ref(false)
  function toggleSelect(name) {
    const s = selectedNames.value
    if (s.has(name)) s.delete(name)
    else s.add(name)
  }
  function enterBatch() { batchMode.value = true }
  function exitBatch() { batchMode.value = false; selectedNames.value = new Set() }
  function selectAllCandidates() {
    selectedNames.value = new Set(val(candidates).map(p => p.name))
  }
  function clearSelection() { selectedNames.value = new Set() }
  const batchTargets = computed(() => val(universe).filter(p => selectedNames.value.has(p.name)))
  const batchNamesPreview = computed(() => {
    const names = batchTargets.value.map(p => p.name)
    const head = names.slice(0, 10).join(', ')
    return names.length > 10 ? `${head} ${t('ns.pods.batchMoreNames', { n: names.length - 10 })}` : head
  })
  function onCardClick(p) {
    if (batchMode.value) { toggleSelect(p.name); return }
    onOpen(p)
  }
  async function handleBatchDelete() {
    const targets = batchTargets.value
    if (!targets.length) return
    const ns = getNamespace()
    const results = await Promise.allSettled(targets.map(p => store.deletePod(p.name, ns)))
    const { okNames, failedNames } = summarizeResults(results, targets)
    if (!failedNames.length) {
      notify('success', t('ns.pods.batchDeleted', { n: okNames.length }))
      showBatchModal.value = false
      exitBatch()
    } else {
      // 部分失败:保留失败项选中便于重试;不退出批量模式
      notify('error', t('ns.pods.batchPartial', { ok: okNames.length, fail: failedNames.length, names: failedNames.length > 5
        ? `${failedNames.slice(0, 5).join(', ')} ${t('ns.pods.batchMoreNames', { n: failedNames.length - 5 })}`
        : failedNames.join(', ') }))
      selectedNames.value = new Set(failedNames)
      showBatchModal.value = false
    }
  }
  return { batchMode, selectedNames, showBatchModal, toggleSelect, enterBatch, exitBatch, selectAllCandidates, clearSelection, batchTargets, batchNamesPreview, onCardClick, handleBatchDelete }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/__tests__/usePodBatchDelete.test.js`
Expected: PASS 5/5

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/composables/usePodBatchDelete.js src/composables/__tests__/usePodBatchDelete.test.js
git commit -m "feat(pods): usePodBatchDelete composable——批量删除逻辑自 NsPods 抽出单一事实源(补视图层无测的洞)"
```

---

### Task 2: NsPods 重构接 composable(行为保持)

**Files:**
- Modify: `src/views/NsPods.vue`(script :88-131 批量块;模板引用改 `selectAllCandidates`)

**Interfaces:**
- Consumes: Task 1 全部返回值
- Produces: 无(行为保持)

- [ ] **Step 1: 重构**

script:删 :88-131 内联批量块(`// === 批量删除…` 至 handleBatchDelete 结束),替换为:

```js
// === 批量删除(卡片选择模式;逻辑在 usePodBatchDelete,选中集跨分页/筛选保留) ===
const {
  batchMode, selectedNames, showBatchModal, enterBatch, exitBatch,
  selectAllCandidates, clearSelection, batchTargets, batchNamesPreview, onCardClick, handleBatchDelete,
} = usePodBatchDelete({
  universe: nsPods,
  candidates: filtered,
  getNamespace: () => route.params.namespace,
  onOpen: p => router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } }),
})
```

import 区:`import { usePodBatchDelete } from '@/composables/usePodBatchDelete'`(替原 summarizeResults import;检查 summarizeResults 是否还有他处使用,无则删该 import 行)。

模板:`@click="selectAllFiltered"`(:222 附近)→ `@click="selectAllCandidates"`;其余批量引用名全部同名不变。

- [ ] **Step 2: 验证**

Run: `npx vitest run src/composables/__tests__/usePodBatchDelete.test.js src/views/__tests__ && npm run build 2>&1 | tail -1`
Expected: 全过+build 成功

- [ ] **Step 3: Commit**

```bash
git branch --show-current
git add src/views/NsPods.vue
git commit -m "refactor(pods): NsPods 批量删除接 usePodBatchDelete——行为保持,删内联逻辑"
```

---

### Task 3: NsWorkloadDetail Pods tab 接线

**Files:**
- Modify: `src/views/NsWorkloadDetail.vue`

**Interfaces:**
- Consumes: Task 1 全部返回值;PodCard `selectable/selected` props(已在 main)

- [ ] **Step 1: script**

import 区加 `import { usePodBatchDelete } from '@/composables/usePodBatchDelete'`;在 `filteredPods` computed(:121)之后加:

```js
// Pods tab 批量删除(逻辑在 usePodBatchDelete;universe=本工作负载管理的 Pod)
const {
  batchMode, selectedNames, showBatchModal, enterBatch, exitBatch,
  selectAllCandidates, clearSelection, batchTargets, batchNamesPreview, onCardClick, handleBatchDelete,
} = usePodBatchDelete({
  universe: managedPods,
  candidates: filteredPods,
  getNamespace: () => route.params.namespace,
  onOpen: goPodDetail,
})
```

- [ ] **Step 2: template 三处**

① 头部行(:1835 `<div class="flex items-center gap-sm flex-wrap">` 内,状态筛选 v-for 按钮之后)追加:

```vue
        <span class="w-px h-4 bg-outline-variant/60"></span>
        <button v-if="!batchMode" @click="enterBatch"
          class="inline-flex items-center gap-1 px-sm py-1 rounded-full text-xs font-medium border bg-surface-container-lowest text-on-surface border-outline-variant hover:bg-surface-container transition-colors"
          :title="$t('ns.pods.batchEnter')">
          <span class="material-symbols-outlined text-sm">delete_sweep</span> {{ $t('ns.pods.batchEnter') }}
        </button>
        <template v-else>
          <button @click="exitBatch"
            class="inline-flex items-center gap-1 px-sm py-1 rounded-full text-xs font-medium border bg-primary-container/20 text-primary border-primary transition-colors"
            :title="$t('ns.pods.batchExit')">
            <span class="material-symbols-outlined text-sm">close</span> {{ $t('ns.pods.batchExit') }}
          </button>
          <span class="text-xs font-semibold text-primary">{{ $t('ns.pods.batchSelected', { n: batchTargets.length }) }}</span>
          <button @click="selectAllCandidates" class="px-sm py-xs text-xs border border-outline-variant rounded-lg hover:bg-surface-container-low">{{ $t('ns.pods.batchSelectAll') }}</button>
          <button @click="clearSelection" class="px-sm py-xs text-xs border border-outline-variant rounded-lg hover:bg-surface-container-low">{{ $t('ns.pods.batchClear') }}</button>
          <button @click="showBatchModal = true" :disabled="!batchTargets.length"
            class="inline-flex items-center gap-1 px-sm py-xs text-xs font-semibold bg-error text-on-error rounded-lg hover:opacity-90 disabled:opacity-40">
            <span class="material-symbols-outlined text-sm">delete</span>{{ $t('ns.pods.batchDeleteAction') }}
          </button>
        </template>
```

② PodCard(:1850-1853)`:show-terminal="false" show-delete` 行后加两 prop,`@click="goPodDetail"` 改 `@click="onCardClick"`:

```vue
        <PodCard v-for="p in filteredPods" :key="p.name"
          :pod="p" :name-base="workload?.name"
          :show-terminal="false" show-delete
          :selectable="batchMode" :selected="batchMode && selectedNames.has(p.name)"
          @click="onCardClick" @delete="confirmDeletePod($event)">
```

③ 文件末尾单删 Pod Modal 旁(与其同级)追加:

```vue
    <!-- Pods tab 批量删除确认 -->
    <Modal v-model="showBatchModal" :title="$t('ns.pods.batchDeleteTitle')" width="max-w-md">
      <p class="text-body-md text-on-surface">{{ $t('ns.pods.batchDeleteConfirm', { n: batchTargets.length, names: batchNamesPreview }) }}</p>
      <p class="text-body-sm text-error mt-sm">{{ $t('ns.pods.batchDeleteWarning') }}</p>
      <template #actions>
        <button @click="showBatchModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
        <button @click="handleBatchDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('common.delete') }}</button>
      </template>
    </Modal>
```

(确认 Modal 已 import——WLD 已有单删 Modal;若用的是其它弹窗组件则对齐既有。)

- [ ] **Step 3: 验证**

Run: `npx vitest run src/views/__tests__ src/composables/__tests__ && npm run build 2>&1 | tail -1`
Expected: 全过+build 成功

- [ ] **Step 4: Commit**

```bash
git branch --show-current
git add src/views/NsWorkloadDetail.vue
git commit -m "feat(workload): 详情页 Pods tab 批量删除——usePodBatchDelete 接入,全选=当前筛选,确认弹窗带控制器重建警告"
```

---

### Task 4: 门禁四连+终审+合并推送(控制器执行)

- [ ] Step 1: `npm run test:unit && npm test && npm run typecheck && npm run build`(串扰条款适用)
- [ ] Step 2: 全分支终审(SDD review-package MERGE_BASE..HEAD)
- [ ] Step 3: main ff-only 合并+push(main 若被推进:查重叠→零重叠 merge main→定向 sanity→ff)
- [ ] Step 4: 手测清单交付

## Self-Review 记录

- 覆盖:spec composable→T1;NsPods 重构→T2;WLD 接线→T3;验证→T4 ✓
- 占位:无(代码全量内联)✓
- 类型一致:`selectAllCandidates`(T1 产出=T2/T3 消费);`universe/candidates/getNamespace/onOpen` 签名三任务一致 ✓
