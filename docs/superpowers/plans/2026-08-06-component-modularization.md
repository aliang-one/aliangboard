# 组件模块化 Plan 1：共用展示组件抽取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the highest-payoff shared UI (label/annotation chips, event list) + centralize K8s quantity formatting into a composable — eliminating duplicated inline markup across ~20 views and shrinking the detail pages, with zero behavior change.

**Architecture:** Pure-presentational Vue 3 SFCs in `src/components/common/` (`LabelChips`, `AnnotationList`, `EventList`) backed by a vitest mount test each, plus a pure `src/composables/useResourceFormat.js` (moved out of `cluster.js`) tested by the zero-dep runner. `cluster.js` keeps its public exports via re-export (zero breakage). Adoption replaces inline markup 1:1, preserving the exact Tailwind classes.

**Tech Stack:** Vue 3 `<script setup>`, Tailwind utility classes (existing), `@tanstack/vue-query` (unchanged), vitest + `@vue/test-utils` + happy-dom for component tests, `scripts/test.mjs` zero-dep runner for pure logic, `node --check` + Vite build for syntax.

## Global Constraints

- **No new external dependencies** (per `CLAUDE.md`). All libraries used (Vue, vitest, js-yaml) are already declared.
- **Pure logic → zero-dep runner** (`scripts/test.mjs`); **components → vitest** (`@vue/test-utils`). Match the repo's existing split.
- **Zero behavior change**: this is a refactor. The extracted components must reproduce the current markup **byte-for-byte** (same Tailwind classes, same DOM structure) so there is no visual regression.
- **Verification gate per task**: `npm run typecheck` (node --check) + `npm run build` (covers `.vue`) + the relevant test command. Mock mode (`remoteMode=false`) must render identically.
- **`@/` alias note for the zero-dep runner**: `scripts/test.mjs` cannot import modules that themselves use the `@/` alias. New pure modules (e.g. `useResourceFormat.js`) must use **no imports** (or only relative ones) so the runner can import them via relative path.
- **Branch**: `feat/component-modularization` (already checked out in this worktree). Commit per task.

## Scope & Deviations from Spec

This plan implements spec `docs/superpowers/specs/2026-08-06-component-modularization-design.md` with one **investigation-driven deviation**: **`ContainerList` is deferred to Plan 2**. Reason: the two "container list" contexts render different shapes — `NsWorkloadDetail` renders workload-template spec containers (`{name,image,ports,resources}` via `fmtPorts`/`fmtResources`), while `PodDetail` uses container-name selection + live status. A shared component would need a complex prop surface; it is better extracted naturally when `NsWorkloadDetail` is split (Plan 2). Plan 1 covers: `useResourceFormat`, `LabelChips`, `AnnotationList`, `EventList`. `YamlEditor` wrapper + `PodTable` remain Plan 3 per the spec.

---

## File Structure

- **Create** `src/composables/useResourceFormat.js` — pure K8s quantity parse/format (single source for `cpuToMilli`/`memToKi`/`formatCpu`/`formatMem`).
- **Modify** `src/stores/cluster.js` — remove the 4 formatter definitions; import for internal use; re-export `formatCpu`/`formatMem` for back-comat.
- **Modify** `scripts/test.mjs` — the existing mirrored resource-quantity test now imports the real functions from `useResourceFormat.js` (delete the inline mirror) + add `formatCpu`/`formatMem` cases.
- **Modify** `src/views/Nodes.vue`, `src/views/NodeDetail.vue` — import `formatCpu`/`formatMem` from `useResourceFormat` instead of `cluster`.
- **Create** `src/components/common/LabelChips.vue`, `AnnotationList.vue`, `EventList.vue` + their vitest tests under `src/components/common/__tests__/`.
- **Modify** adopting views (`WorkloadDetail.vue`, `PodDetail.vue`) — replace inline label/annotation/event markup with the components.

---

### Task 1: `useResourceFormat` composable + centralize formatters

**Files:**
- Create: `src/composables/useResourceFormat.js`
- Modify: `src/stores/cluster.js` (remove formatter defs ~lines 25-54; add import + re-export)
- Modify: `scripts/test.mjs` (resource-quantity test ~lines 61-95; imports ~line 14)
- Modify: `src/views/Nodes.vue:5`, `src/views/NodeDetail.vue:5` (import source)

**Interfaces:**
- Produces: `useResourceFormat.js` exports `cpuToMilli(q)→number`, `memToKi(q)→number`, `formatCpu(milli)→string`, `formatMem(ki)→string`. Pure, no imports. `cluster.js` re-exports `formatCpu`/`formatMem` (public API unchanged).

- [ ] **Step 1: Update the zero-dep test to import the real functions (RED)**

In `scripts/test.mjs`, add to the import block near the top (alongside the existing `useYaml.js` import):
```js
import { cpuToMilli, memToKi, formatCpu, formatMem } from '../src/composables/useResourceFormat.js'
```
Then replace the existing test block that begins `// --- K8s 资源量解析契约（镜像 stores/cluster.js 的 cpuToMilli/memToKi...` (it currently defines inline `cpuToMilli`/`memToKi` and asserts on them). Replace the WHOLE block with:
```js
// --- K8s 资源量解析（现从 useResourceFormat 直接 import，无需镜像）---
test('K8s 资源量解析：CPU→毫核、内存→Ki（覆盖各后缀与裸值）', () => {
  // CPU：毫核 / 核 / 纳核 / 微核 / 空值
  assert.equal(cpuToMilli('500m'), 500)
  assert.equal(cpuToMilli('2'), 2000)
  assert.equal(cpuToMilli('868940n'), 1)      // 纳核 → 0.87m，四舍五入为 1m
  assert.equal(cpuToMilli('750u'), 1)         // 微核 → 0.75m，四舍五入为 1m
  assert.equal(cpuToMilli(''), 0)
  assert.equal(cpuToMilli(null), 0)
  // 内存：Ki/Mi/Gi/裸字节
  assert.equal(memToKi('1Gi'), 1024 ** 2)
  assert.equal(memToKi('512Mi'), 512 * 1024)
  assert.equal(memToKi('1024'), 1)            // 裸字节 → 1024 B = 1 Ki
})

test('用量格式化：CPU→毫核串、内存→Ti/Gi/Mi 降级、空值→—', () => {
  assert.equal(formatCpu(500), '500m')
  assert.equal(formatCpu(null), '—')
  assert.equal(formatMem(1024), '1Mi')
  assert.equal(formatMem(1024 ** 2), '1Gi')
  assert.equal(formatMem(1024 ** 3), '1Ti')
  assert.equal(formatMem(null), '—')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the runner cannot resolve `../src/composables/useResourceFormat.js` (module not created yet). Capture the failing output.

- [ ] **Step 3: Create `useResourceFormat.js` with the functions moved verbatim from cluster.js**

Create `src/composables/useResourceFormat.js`:
```js
// K8s 资源量（quantity）解析与格式化——单一数据源。
// metrics.k8s.io 返回的用量与节点 allocatable / 容器 requests 都是 K8s quantity 字符串，
// 这里统一解析为可计算的数值，再格式化回展示格式（"124m"、"1Gi"）。
// 纯函数、零依赖：scripts/test.mjs 可经相对路径直接 import（无 @/ 别名）。
export function cpuToMilli(q) {
  if (q == null || q === '') return 0
  const s = String(q).trim()
  if (s.endsWith('n')) return Math.round(Number(s.slice(0, -1)) / 1e6)   // nanocores → m
  if (s.endsWith('u')) return Math.round(Number(s.slice(0, -1)) / 1e3)   // microcores → m
  if (s.endsWith('m')) return Number(s.slice(0, -1)) || 0                // millicores
  const n = Number(s)
  return isNaN(n) ? 0 : n * 1000                                         // cores → m
}

export function memToKi(q) {
  if (q == null || q === '') return 0
  const s = String(q).trim()
  const m = s.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/)
  if (!m) return 0
  const num = Number(m[1])
  const suf = m[2] || ''
  const mult = {
    Ki: 1, Mi: 1024, Gi: 1024 ** 2, Ti: 1024 ** 3, Pi: 1024 ** 4, Ei: 1024 ** 5,
    k: 1000 / 1024, M: 1e6 / 1024, G: 1e9 / 1024, T: 1e12 / 1024, P: 1e15 / 1024, E: 1e18 / 1024,
  }
  return Math.round(num * (suf ? (mult[suf] ?? 1) : 1 / 1024))           // 无后缀视为裸字节
}

// 用量/容量格式化（供视图展示）
export const formatCpu = milli => (milli == null ? '—' : Math.round(milli) + 'm')
export const formatMem = ki => {
  if (ki == null) return '—'
  if (ki >= 1024 ** 3) return (ki / 1024 ** 3).toFixed(ki % 1024 ** 3 ? 1 : 0) + 'Ti'
  if (ki >= 1024 ** 2) return (ki / 1024 ** 2).toFixed(ki % 1024 ** 2 ? 1 : 0) + 'Gi'
  if (ki >= 1024) return Math.round(ki / 1024) + 'Mi'
  return Math.round(ki) + 'Ki'
}
```
Note: the `formatMem` body above adds the final `return Math.round(ki) + 'Ki'` line — verify this matches the tail of the existing `formatMem` in `cluster.js` (the original may end after the `Mi` branch; if so, copy the original's exact tail instead of inventing one). Read `cluster.js` lines 50-56 to copy `formatMem` **exactly** before finalizing.

- [ ] **Step 4: Rewire `cluster.js` — remove defs, import + re-export**

In `src/stores/cluster.js`:
1. Add with the other top imports: `import { cpuToMilli, memToKi } from '@/composables/useResourceFormat'`
2. Delete the four definitions: the `function cpuToMilli(q) { ... }` (~line 27), `function memToKi(q) { ... }` (~line 36), `export const formatCpu = ...` (~line 50), and `export const formatMem = ki => { ... }` (~line 51, multi-line through its closing `}`). Keep the surrounding comment only if you move it to `useResourceFormat.js` (already done above) — otherwise delete it to avoid a dangling reference.
3. Add (where `formatCpu`/`formatMem` used to be exported, or with the imports): `export { formatCpu, formatMem } from '@/composables/useResourceFormat'`

After this, `cluster.js` still exports `formatCpu`/`formatMem` (via re-export) and uses `cpuToMilli`/`memToKi` internally (via import) — all existing call sites (`mapNode`, `hydrateCoreResources`, `refreshMetrics`, etc.) work unchanged.

- [ ] **Step 5: Run the zero-dep test to verify GREEN**

Run: `npm test`
Expected: PASS — the resource-quantity tests now import the real functions; the full suite (zero-dep + node --test server + vitest) is green.

- [ ] **Step 6: Switch view imports to the canonical source**

In `src/views/Nodes.vue:5` change:
```js
import { useClusterStore, formatCpu, formatMem } from '@/stores/cluster'
```
to:
```js
import { useClusterStore } from '@/stores/cluster'
import { formatCpu, formatMem } from '@/composables/useResourceFormat'
```
Do the identical change in `src/views/NodeDetail.vue:5`.

- [ ] **Step 7: Verify (typecheck + build) and commit**

Run: `npm run typecheck && npm run build`
Expected: both pass.
Commit message (exact): `refactor(format): 抽 useResourceFormat composable,消除 test 镜像副本; cluster 改 import+re-export`

```bash
git add src/composables/useResourceFormat.js src/stores/cluster.js scripts/test.mjs src/views/Nodes.vue src/views/NodeDetail.vue
git commit -m "refactor(format): 抽 useResourceFormat composable,消除 test 镜像副本; cluster 改 import+re-export"
```

---

### Task 2: `LabelChips` + `AnnotationList` components + vitest tests

**Files:**
- Create: `src/components/common/LabelChips.vue`, `src/components/common/AnnotationList.vue`
- Test: `src/components/common/__tests__/LabelChips.test.js`, `src/components/common/__tests__/AnnotationList.test.js`

**Interfaces:**
- `LabelChips`: props `labels: Object (default {})`, `emptyText: String (default '')`. Renders a `<div class="flex flex-wrap gap-2">` of `<span class="px-2 py-1 bg-surface-container rounded text-body-sm border border-outline-variant">{{ key }}: {{ val }}</span>`; shows `emptyText` when `labels` is empty.
- `AnnotationList`: props `annotations: Object (default {})`, `emptyText: String (default '')`. Renders a `<div class="text-body-sm bg-surface-container p-sm rounded border border-outline-variant font-mono text-code-sm text-on-surface-variant">` of `<div>{{ key }}: "{{ val }}"</div>`; shows `emptyText` when empty.

- [ ] **Step 1: Write failing tests**

Create `src/components/common/__tests__/LabelChips.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LabelChips from '../LabelChips.vue'

describe('LabelChips', () => {
  it('renders one chip per label as "key: val"', () => {
    const w = mount(LabelChips, { props: { labels: { app: 'web', tier: 'frontend' } } })
    expect(w.text()).toContain('app: web')
    expect(w.text()).toContain('tier: frontend')
    expect(w.findAll('span').length).toBeGreaterThanOrEqual(2)
  })
  it('uses the canonical chip classes', () => {
    const w = mount(LabelChips, { props: { labels: { a: 'b' } } })
    expect(w.find('span').classes()).toContain('bg-surface-container')
    expect(w.find('span').classes()).toContain('rounded')
  })
  it('shows emptyText when labels is empty', () => {
    const w = mount(LabelChips, { props: { labels: {}, emptyText: '无标签' } })
    expect(w.text()).toContain('无标签')
  })
  it('renders nothing extra when empty and no emptyText', () => {
    const w = mount(LabelChips, { props: { labels: {} } })
    expect(w.findAll('span').length).toBe(0)
  })
})
```
Create `src/components/common/__tests__/AnnotationList.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AnnotationList from '../AnnotationList.vue'

describe('AnnotationList', () => {
  it('renders one row per annotation as key: "val"', () => {
    const w = mount(AnnotationList, { props: { annotations: { 'kubectl.kubernetes.io/last-applied': '{"a":1}' } } })
    expect(w.text()).toContain('kubectl.kubernetes.io/last-applied: "{"a":1}"')
  })
  it('uses the canonical mono container classes', () => {
    const w = mount(AnnotationList, { props: { annotations: { a: 'b' } } })
    const box = w.findAll('div').find(d => d.classes().includes('font-mono'))
    expect(box?.classes()).toContain('bg-surface-container')
  })
  it('shows emptyText when annotations is empty', () => {
    const w = mount(AnnotationList, { props: { annotations: {}, emptyText: '无注解' } })
    expect(w.text()).toContain('无注解')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- LabelChips AnnotationList` (or `npx vitest run src/components/common/__tests__/LabelChips.test.js src/components/common/__tests__/AnnotationList.test.js`)
Expected: FAIL — components not found.

- [ ] **Step 3: Implement `LabelChips.vue`**

Create `src/components/common/LabelChips.vue`:
```vue
<template>
  <div class="flex flex-wrap gap-2">
    <span v-for="(val, key) in labels" :key="key"
      class="px-2 py-1 bg-surface-container rounded text-body-sm border border-outline-variant">
      {{ key }}: {{ val }}
    </span>
    <span v-if="emptyText && !Object.keys(labels || {}).length" class="text-body-sm text-on-surface-variant">{{ emptyText }}</span>
  </div>
</template>

<script setup>
defineProps({
  labels: { type: Object, default: () => ({}) },
  emptyText: { type: String, default: '' },
})
</script>
```

- [ ] **Step 4: Implement `AnnotationList.vue`**

Create `src/components/common/AnnotationList.vue`:
```vue
<template>
  <div class="text-body-sm bg-surface-container p-sm rounded border border-outline-variant font-mono text-code-sm text-on-surface-variant">
    <div v-for="(val, key) in annotations" :key="key">{{ key }}: "{{ val }}"</div>
    <div v-if="emptyText && !Object.keys(annotations || {}).length">{{ emptyText }}</div>
  </div>
</template>

<script setup>
defineProps({
  annotations: { type: Object, default: () => ({}) },
  emptyText: { type: String, default: '' },
})
</script>
```

- [ ] **Step 5: Run tests to verify GREEN**

Run: `npx vitest run src/components/common/__tests__/LabelChips.test.js src/components/common/__tests__/AnnotationList.test.js`
Expected: PASS (all cases). Then run `npm run typecheck && npm run build`.

- [ ] **Step 6: Commit**

```bash
git add src/components/common/LabelChips.vue src/components/common/AnnotationList.vue src/components/common/__tests__/LabelChips.test.js src/components/common/__tests__/AnnotationList.test.js
git commit -m "feat(ui): LabelChips + AnnotationList 只读展示组件 + vitest 单测"
```

---

### Task 3: Adopt `LabelChips` + `AnnotationList` in detail pages

**Files:**
- Modify: `src/views/WorkloadDetail.vue` (labels block ~lines 129-135), `src/views/PodDetail.vue` (labels ~515-523, annotations ~525-528)
- (Same-pattern follow-up sites not required for task completion: `NsConfigMapDetail`, `NsSecretDetail`, `NsServiceDetail`, `NamespaceOverview`, `PVDetail`.)

**Interfaces:**
- Consumes: `LabelChips` (props `labels`, `emptyText`), `AnnotationList` (props `annotations`, `emptyText`) from Task 2.

- [ ] **Step 1: Add imports**

In `src/views/WorkloadDetail.vue` add with its other component imports:
```js
import LabelChips from '@/components/common/LabelChips.vue'
```
In `src/views/PodDetail.vue` add:
```js
import LabelChips from '@/components/common/LabelChips.vue'
import AnnotationList from '@/components/common/AnnotationList.vue'
```

- [ ] **Step 2: Replace the labels block in `WorkloadDetail.vue`**

Find (around line 131):
```html
          <div class="flex flex-wrap gap-2">
            <span v-for="(val, key) in (displayData.labels || {})" :key="key" class="px-2 py-1 bg-surface-container rounded text-body-sm border border-outline-variant">
              {{ key }}: {{ val }}
            </span>
          </div>
```
Replace with:
```html
          <LabelChips :labels="displayData.labels || {}" />
```

- [ ] **Step 3: Replace the labels + annotations blocks in `PodDetail.vue`**

Find the labels block (around line 518-522):
```html
              <div class="flex flex-wrap gap-2">
                <span v-for="(val, key) in pod.labels" :key="key" class="px-2 py-1 bg-surface-container rounded text-body-sm border border-outline-variant">
                  {{ key }}: {{ val }}
                </span>
              </div>
```
Replace with:
```html
              <LabelChips :labels="pod.labels || {}" />
```
Find the annotations block (around line 525-527):
```html
              <div class="text-body-sm bg-surface-container p-sm rounded border border-outline-variant font-mono text-code-sm text-on-surface-variant">
                <div v-for="(val, key) in pod.annotations" :key="key">{{ key }}: "{{ val }}"</div>
              </div>
```
Replace with:
```html
              <AnnotationList :annotations="pod.annotations || {}" />
```

- [ ] **Step 4: Verify (typecheck + build + mock render) and commit**

Run: `npm run typecheck && npm run build`
Expected: both pass. Confirm mock render: WorkloadDetail/PodDetail label + annotation areas render identically (same chips, same mono box).
Commit message (exact): `refactor(ui): WorkloadDetail/PodDetail 标签与注解改用 LabelChips/AnnotationList`

```bash
git add src/views/WorkloadDetail.vue src/views/PodDetail.vue
git commit -m "refactor(ui): WorkloadDetail/PodDetail 标签与注解改用 LabelChips/AnnotationList"
```

---

### Task 4: `EventList` component + vitest test (full + compact)

**Files:**
- Create: `src/components/common/EventList.vue`
- Test: `src/components/common/__tests__/EventList.test.js`

**Interfaces:**
- `EventList`: props `events: Array (default [])` of `mapEvent` objects (`{type,reason,message,count,time,icon,color,relatedKind,relatedName}`), `max: Number (default 0)` (>0 truncates), `compact: Boolean (default false)`. Emits `navigate(event)` when a full-mode row with `relatedKind` is clicked. `compact=true` renders the sidebar variant (icon + reason + time only).

- [ ] **Step 1: Write the failing test**

Create `src/components/common/__tests__/EventList.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EventList from '../EventList.vue'

const ev = (over = {}) => ({
  type: 'normal', reason: 'Started', message: 'Container started', time: '12s',
  icon: 'play_circle', color: 'primary', relatedKind: '', relatedName: '', ...over,
})

describe('EventList', () => {
  it('full mode renders reason, time, message', () => {
    const w = mount(EventList, { props: { events: [ev({ reason: 'Pulled', message: 'Image pulled' })] } })
    expect(w.text()).toContain('Pulled')
    expect(w.text()).toContain('Image pulled')
    expect(w.text()).toContain('12s')
  })
  it('compact mode renders reason + time but not message', () => {
    const w = mount(EventList, { props: { events: [ev({ message: 'secret' })], compact: true } })
    expect(w.text()).toContain('Started')
    expect(w.text()).not.toContain('secret')
  })
  it('max truncates the list', () => {
    const w = mount(EventList, { props: { events: [ev({ reason: 'a' }), ev({ reason: 'b' }), ev({ reason: 'c' })], max: 2, compact: true } })
    expect(w.text()).toContain('a')
    expect(w.text()).toContain('b')
    expect(w.text()).not.toContain('"c"').and.not.toContain('c') // c 被截断
  })
  it('emits navigate on full-mode related row click', async () => {
    const w = mount(EventList, { props: { events: [ev({ relatedKind: 'Pod', relatedName: 'web' })] } })
    await w.find('[data-testid="event-row"]').trigger('click')
    expect(w.emitted('navigate')).toBeTruthy()
    expect(w.emitted('navigate')[0][0].relatedKind).toBe('Pod')
  })
})
```
Note on the `max` assertion: if `'c'` could appear as a substring of another token, change the third event's reason to a unique sentinel like `'zz-truncated'` and assert `not.toContain('zz-truncated')`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/common/__tests__/EventList.test.js`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement `EventList.vue`**

Create `src/components/common/EventList.vue`:
```vue
<template>
  <div class="flex flex-col gap-md">
    <div v-for="(event, idx) in list" :key="idx" data-testid="event-row"
      :class="rowClass(event)"
      @click="onRowClick(event)">
      <template v-if="compact">
        <span class="material-symbols-outlined text-base mt-0.5"
          :class="event.color === 'primary' ? 'text-primary' : 'text-tertiary-container'">{{ event.icon }}</span>
        <div>
          <p class="text-body-sm font-medium">{{ event.reason }}</p>
          <p class="text-body-sm text-on-surface-variant">{{ event.time }}</p>
        </div>
      </template>
      <template v-else>
        <div class="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
          :class="event.color === 'primary' ? 'bg-primary-container text-on-primary-container' : event.color === 'error' ? 'bg-error-container text-on-error-container' : 'bg-surface-container text-on-surface-variant'">
          <span class="material-symbols-outlined text-lg">{{ event.icon }}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex justify-between items-start gap-sm">
            <h4 class="text-body-md font-semibold">{{ event.reason }}</h4>
            <span class="font-mono text-code-sm text-on-surface-variant shrink-0">{{ event.time }}</span>
          </div>
          <p class="text-body-sm text-on-surface-variant mt-xs">{{ event.message }}</p>
          <div v-if="event.relatedKind" class="mt-xs inline-flex items-center gap-xs px-sm py-xs bg-primary-container/10 text-primary text-xs rounded-full">
            <span class="material-symbols-outlined text-sm">link</span>
            <span class="font-mono">{{ event.relatedKind }}/{{ event.relatedName }}</span>
            <span class="material-symbols-outlined text-sm">chevron_right</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  events: { type: Array, default: () => [] },
  max: { type: Number, default: 0 },
  compact: { type: Boolean, default: false },
})
const emit = defineEmits(['navigate'])

const list = computed(() => (props.max > 0 ? props.events.slice(0, props.max) : props.events))

function rowClass(event) {
  if (props.compact) return 'flex gap-sm'
  const clickable = event.relatedKind ? 'cursor-pointer hover:bg-surface-container-low/50 rounded-lg -mx-sm px-sm py-xs transition-colors' : ''
  return ['flex gap-md border-b border-outline-variant pb-md', clickable]
}
function onRowClick(event) {
  if (!props.compact && event.relatedKind) emit('navigate', event)
}
</script>
```

- [ ] **Step 4: Run test to verify GREEN**

Run: `npx vitest run src/components/common/__tests__/EventList.test.js`
Expected: PASS (all 4 cases). Then `npm run typecheck && npm run build`.

- [ ] **Step 5: Commit**

```bash
git add src/components/common/EventList.vue src/components/common/__tests__/EventList.test.js
git commit -m "feat(ui): EventList 组件(full/compact 双模 + navigate 事件)+ vitest 单测"
```

---

### Task 5: Adopt `EventList` in PodDetail (full) + WorkloadDetail (compact)

**Files:**
- Modify: `src/views/PodDetail.vue` (events block ~lines 472-495; `goToRelated` stays), `src/views/WorkloadDetail.vue` (events sidebar block ~lines 140-147)

**Interfaces:**
- Consumes: `EventList` from Task 4 (`events`, `max`, `compact`, `@navigate`). PodDetail's existing `goToRelated(event)` handler is reused.

- [ ] **Step 1: PodDetail — adopt full-mode EventList**

In `src/views/PodDetail.vue` add the import:
```js
import EventList from '@/components/common/EventList.vue'
```
Find the events block (the `<div v-for="(event, idx) in podEvents" ...>` row inside `v-if="activeTab === 'events'"`, around lines 472-495, which includes the icon circle, reason/time header, message, and the related-kind chip, all inside one `<div class="flex flex-col gap-md">`). Replace that entire `<div class="flex flex-col gap-md"> … </div>` (the list wrapper + the single event row template) with:
```html
            <EventList :events="podEvents" @navigate="goToRelated" />
```
Leave the surrounding `<div v-if="activeTab === 'events'" class="flex-1 p-lg overflow-y-auto max-h-[600px]">` wrapper in place. The existing `goToRelated` function (and `podEvents` computed) is unchanged.

- [ ] **Step 2: WorkloadDetail — adopt compact-mode EventList**

In `src/views/WorkloadDetail.vue` add the import:
```js
import EventList from '@/components/common/EventList.vue'
```
Find the events sidebar block (around lines 142-147):
```html
            <div v-for="(e, i) in store.eventList.slice(0, 4)" :key="i" class="flex gap-sm">
              <span class="material-symbols-outlined text-base mt-0.5" :class="e.color === 'primary' ? 'text-primary' : 'text-tertiary-container'">{{ e.icon }}</span>
              <div>
                <p class="text-body-sm font-medium">{{ e.reason }}</p>
                <p class="text-body-sm text-on-surface-variant">{{ e.time }}</p>
              </div>
            </div>
```
Replace with:
```html
            <EventList :events="store.eventList" :max="4" compact />
```
Leave the wrapping `<div class="flex flex-col gap-md">` and the section card around it in place.

- [ ] **Step 3: Verify (typecheck + build + mock render) and commit**

Run: `npm run typecheck && npm run build`
Expected: both pass. Mock render: PodDetail events tab lists events with icon/reason/time/message + related chip (click still navigates); WorkloadDetail sidebar lists up to 4 compact events.
Commit message (exact): `refactor(ui): PodDetail/WorkloadDetail 事件改用 EventList(full/compact)`

```bash
git add src/views/PodDetail.vue src/views/WorkloadDetail.vue
git commit -m "refactor(ui): PodDetail/WorkloadDetail 事件改用 EventList(full/compact)"
```

---

### Task 6: Final full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete gate**

Run:
```bash
npm test && npm run test:unit && npm run typecheck && npm run build
```
Expected: all green. `npm test` covers the now-imported `useResourceFormat` cases; `npm run test:unit` (vitest) includes the new `LabelChips`/`AnnotationList`/`EventList` tests; `typecheck` (node --check) clean; `build` succeeds.

- [ ] **Step 2: Confirm the consolidation**

By code inspection: `WorkloadDetail.vue` and `PodDetail.vue` no longer contain the inline `v-for` label/annotation/event markup (they use the components); `scripts/test.mjs` no longer contains the mirrored `cpuToMilli`/`memToKi` copy; `cluster.js` no longer defines those four functions (imports + re-exports). Note the line-count reduction in the two views for the plan/PR description.

- [ ] **Step 3: No commit** (verification only; all changes committed in Tasks 1–5).
