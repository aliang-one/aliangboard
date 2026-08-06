# Data-Model Plan 2a: Admin Classes → Vue Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the 3 admin-class resources (runtimeClass, ingressClass, priorityClass) — and the `DeployApp`/`NsIngressDetail` reads of them — to Vue Query, then trim those 3 resources from `hydrateExtendedResources` (−3 app-load requests), with zero behavior change.

**Architecture:** Each resource: add a thin `fetchX` to `cluster.js` (mirror `fetchServices`: `api.k8s(endpoint) → items.map(mapX)`), migrate its consumer pages to `useResourceList` (canonical cluster key + `mock: store.XList` + `mockMode`), then — once no remote-mode consumer reads the store list — remove the resource's entry + assignment from `hydrateExtendedResources`. `mapX` functions already exist; the store keeps its refs (still seeded for mock mode). This is Plan 2's first (cleanest) batch; CRD + RBAC follow in later plans.

**Tech Stack:** Vue 3 `<script setup>`, `@tanstack/vue-query` (`useResourceList` from `@/composables/useK8sQuery`), Pinia store, Vite. No new deps.

## Global Constraints

- **No new external dependencies.** `@tanstack/vue-query` already declared.
- **No new hardcoded Chinese** — `main` is fully i18n'd; the gate includes `npm run i18n:check` (must be 0 residual). New UI strings (none expected here — fetchers are logic, page edits preserve existing `t()`) must use `t()`.
- **Zero behavior change** — a migration. Mock mode (`remoteMode=false`) must render identically (mock seeds still populate the store refs, and the queries' `mock:` param reads them).
- **Verification gate per task**: `npm test` (zero-dep runner + server tests incl `i18n-check.test` + vitest) + `npm run typecheck` + `npm run build` + `npm run i18n:check`. All must pass before commit.
- **No new unit tests for the fetchers** — they are `api.k8s` thin wrappers (consistent with existing `fetchServices`/`fetchConfigMaps`, which have none). Verify via build + mock render.
- **Canonical query-key + cid pattern** (copy verbatim from `NsServices.vue`/`NsConfigMaps.vue`):
  ```js
  const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
  const q = useResourceList({
    key: ['cluster', cid.value, '<resource>'],
    fetcher: () => store.fetchX(),
    mock: store.XList,
    mockMode: !store.remoteMode,
    options: { refetchInterval: store.remoteMode ? 30000 : false },
  })
  // consume: q.data.value (a Ref) — wrap in a computed for the template
  ```
- **Branch**: `feat/data-model-plan2` (already checked out). Commit per task.
- `mapX` functions (`mapRuntimeClass`, `mapIngressClass`, `mapPriorityClass`) already exist in `cluster.js` (arrow form) and are currently used by `hydrateExtendedResources`. Reuse them — do not redefine.

---

## File Structure

- **Modify** `src/stores/cluster.js` — add `fetchRuntimeClasses`/`fetchIngressClasses`/`fetchPriorityClasses` (near `fetchPVCs` ~line 1207), expose them in the store's return object (near line ~3500, alongside `fetchServices`), and (Task 4) trim 3 entries + 3 assignments from `hydrateExtendedResources`.
- **Modify** `src/views/RuntimeClasses.vue` — migrate to query.
- **Modify** `src/views/IngressClasses.vue` + `src/views/NsIngressDetail.vue` — migrate to query (NsIngressDetail: add a query for the ingress-class dropdown only).
- **Modify** `src/views/PriorityClasses.vue` + `src/views/DeployApp.vue` — migrate to query (DeployApp: add a query for the priority-class dropdown only).

---

### Task 1: runtimeClass — fetcher + migrate RuntimeClasses.vue

**Files:**
- Modify: `src/stores/cluster.js` (add `fetchRuntimeClasses` near `fetchPVCs`; add to store return)
- Modify: `src/views/RuntimeClasses.vue`

**Interfaces:**
- Produces: `store.fetchRuntimeClasses()` → `Promise<mappedRuntimeClass[]>` (consumed by RuntimeClasses.vue's query).

- [ ] **Step 1: Add the fetcher to `cluster.js`**

Near the other `fetchX` one-liners (right after `fetchPVCs`/`fetchPVC`, ~line 1207), add:
```js
  async function fetchRuntimeClasses() { const d = await api.k8s('/apis/node.k8s.io/v1/runtimeclasses?limit=5000'); return (d?.items || []).map(mapRuntimeClass) }
```
Then add `fetchRuntimeClasses` to the store's returned object (find the `return { ... }` near the end of `defineStore`, ~line 3500, where `fetchServices`/`fetchWorkloads` are listed).

- [ ] **Step 2: Migrate `RuntimeClasses.vue` to the query**

In `src/views/RuntimeClasses.vue`:
- Ensure `computed` is imported from `vue` (the file currently uses `ref`; add `computed` to that import if missing).
- Add the import: `import { useResourceList } from '@/composables/useK8sQuery'`
- In `<script setup>`, after `const store = useClusterStore()`, add:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const runtimeClassesQuery = useResourceList({
  key: ['cluster', cid.value, 'runtimeclasses'],
  fetcher: () => store.fetchRuntimeClasses(),
  mock: store.runtimeClassList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const runtimeClasses = computed(() => runtimeClassesQuery.data.value || [])
```
- In the template, replace the two `store.runtimeClassList` references:
  - subtitle count `store.runtimeClassList.length` → `runtimeClasses.length`
  - `v-for="row in store.runtimeClassList"` → `v-for="row in runtimeClasses"`

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Confirm mock render: RuntimeClasses page lists the mock-seeded classes (query `mock` reads `store.runtimeClassList`).
Commit message (exact): `refactor(admin): runtimeClass 迁 Vue Query + 新增 fetchRuntimeClasses`

```bash
git add src/stores/cluster.js src/views/RuntimeClasses.vue
git commit -m "refactor(admin): runtimeClass 迁 Vue Query + 新增 fetchRuntimeClasses"
```

---

### Task 2: ingressClass — fetcher + migrate IngressClasses.vue + NsIngressDetail.vue

**Files:**
- Modify: `src/stores/cluster.js` (add `fetchIngressClasses`; add to store return)
- Modify: `src/views/IngressClasses.vue`
- Modify: `src/views/NsIngressDetail.vue` (add an ingress-class query for the dropdown at line ~593)

**Interfaces:**
- Produces: `store.fetchIngressClasses()` → `Promise<mappedIngressClass[]>`.

- [ ] **Step 1: Add the fetcher to `cluster.js`**

Near `fetchRuntimeClasses` (added in Task 1), add:
```js
  async function fetchIngressClasses() { const d = await api.k8s('/apis/networking.k8s.io/v1/ingressclasses?limit=5000'); return (d?.items || []).map(mapIngressClass) }
```
Add `fetchIngressClasses` to the store's returned object.

- [ ] **Step 2: Migrate `IngressClasses.vue`** (identical pattern to Task 1's RuntimeClasses)

- Ensure `computed` imported from `vue`; add `import { useResourceList } from '@/composables/useK8sQuery'`.
- After `const store = useClusterStore()`:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const ingressClassesQuery = useResourceList({
  key: ['cluster', cid.value, 'ingressclasses'],
  fetcher: () => store.fetchIngressClasses(),
  mock: store.ingressClassList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const ingressClasses = computed(() => ingressClassesQuery.data.value || [])
```
- Template: replace the two `store.ingressClassList` references (subtitle `.length` and `v-for="row in store.ingressClassList"`) with `ingressClasses`.

- [ ] **Step 3: Migrate the NsIngressDetail dropdown**

`src/views/NsIngressDetail.vue` is already a Query page (it has `cid` + a service query in `<script setup>`). Add alongside its existing query:
```js
const ingressClassesQuery = useResourceList({
  key: ['cluster', cid.value, 'ingressclasses'],
  fetcher: () => store.fetchIngressClasses(),
  mock: store.ingressClassList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const ingressClasses = computed(() => ingressClassesQuery.data.value || [])
```
(If `computed`/`useResourceList` are not yet imported in this file, add them — `useResourceList` likely already imported since it's a migrated page; verify.)
Then in the template, replace `store.ingressClassList` (the `<option v-for="c in store.ingressClassList" …>` at ~line 593) with `ingressClasses`.

- [ ] **Step 4: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: IngressClasses page lists seeded classes; NsIngressDetail's class dropdown populated.
Commit message (exact): `refactor(admin): ingressClass 迁 Vue Query(IngressClasses + NsIngressDetail 下拉) + fetchIngressClasses`

```bash
git add src/stores/cluster.js src/views/IngressClasses.vue src/views/NsIngressDetail.vue
git commit -m "refactor(admin): ingressClass 迁 Vue Query(IngressClasses + NsIngressDetail 下拉) + fetchIngressClasses"
```

---

### Task 3: priorityClass — fetcher + migrate PriorityClasses.vue + DeployApp.vue + PriorityClassDetail.vue

**Files:**
- Modify: `src/stores/cluster.js` (add `fetchPriorityClasses` + `fetchPriorityClass(name)`; add both to store return)
- Modify: `src/views/PriorityClasses.vue`
- Modify: `src/views/DeployApp.vue` (add a priority-class query for the `availablePriorityClasses` computed at line ~220)
- Modify: `src/views/PriorityClassDetail.vue` (migrate the `pc` computed at line ~14 to `useResourceDetail`; cluster-scoped, mirror `NodeDetail.vue`)

**Interfaces:**
- Produces: `store.fetchPriorityClasses()` → `Promise<mappedPriorityClass[]>`; `store.fetchPriorityClass(name)` → `Promise<mappedPriorityClass|null>` (cluster-scoped, no namespace).

- [ ] **Step 1: Add the fetchers to `cluster.js`**

Near the other admin fetchers, add (priorityclasses are cluster-scoped — no namespace in the detail path):
```js
  async function fetchPriorityClasses() { const d = await api.k8s('/apis/scheduling.k8s.io/v1/priorityclasses?limit=5000'); return (d?.items || []).map(mapPriorityClass) }
  async function fetchPriorityClass(name) { const d = await api.k8s(`/apis/scheduling.k8s.io/v1/priorityclasses/${encodeURIComponent(name)}`); return d ? mapPriorityClass(d) : null }
```
Add both `fetchPriorityClasses` and `fetchPriorityClass` to the store's returned object.

- [ ] **Step 2: Migrate `PriorityClasses.vue`**

- Ensure `computed` imported (it is — used at line 20); add `import { useResourceList } from '@/composables/useK8sQuery'`.
- After `const store = useClusterStore()`:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const priorityClassesQuery = useResourceList({
  key: ['cluster', cid.value, 'priorityclasses'],
  fetcher: () => store.fetchPriorityClasses(),
  mock: store.priorityClassList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const priorityClasses = computed(() => priorityClassesQuery.data.value || [])
```
- In the existing `filtered` computed (lines ~20-29), replace the two `store.priorityClassList` references (the `.filter(...)` branch and the `[...store.priorityClassList]` else branch) with `priorityClasses`.
- Template subtitle (line ~90): `store.priorityClassList.length` → `priorityClasses.length`.

- [ ] **Step 3: Migrate the DeployApp dropdown**

`src/views/DeployApp.vue` is a wizard; it has `const store = useClusterStore()` and reads several store lists. Add (in `<script setup>`, near its other store usage):
```js
import { useResourceList } from '@/composables/useK8sQuery'
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const priorityClassesQuery = useResourceList({
  key: ['cluster', cid.value, 'priorityclasses'],
  fetcher: () => store.fetchPriorityClasses(),
  mock: store.priorityClassList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
```
Then change line ~220:
```js
const availablePriorityClasses = computed(() => store.priorityClassList.map(p => p.name))
```
to:
```js
const availablePriorityClasses = computed(() => (priorityClassesQuery.data.value || []).map(p => p.name))
```
Leave all other DeployApp store reads (`namespaceList`/`nsConfigMaps`/`nsSecrets`/`nsPVCs`/`nsServiceAccounts`) untouched — they are out of scope for this plan.

- [ ] **Step 4: Migrate `PriorityClassDetail.vue`** (cluster-scoped detail; mirror `NodeDetail.vue`)

`src/views/PriorityClassDetail.vue` currently has `const pc = computed(() => store.getPriorityClassByName(route.params.name))` (line ~14) as its sole source. Migrate it:
- Add imports: `import { useResourceDetail } from '@/composables/useK8sQuery'` and ensure `computed` is imported (it is).
- After `const store = useClusterStore()`, add `cid` + the detail query:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const pcDetail = useResourceDetail({
  key: ['cluster', cid.value, 'priorityclasses', route.params.name],
  fetcher: () => store.fetchPriorityClass(route.params.name),
  mock: store.getPriorityClassByName(route.params.name),
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 15000 : false },
})
```
- Change the `pc` computed to read the query (with the store getter as a transient fallback, same shape as `NodeDetail.vue`):
```js
const pc = computed(() => pcDetail.data.value ?? store.getPriorityClassByName(route.params.name))
```

- [ ] **Step 5: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: PriorityClasses page lists/seeds + search filter works; DeployApp priority-class dropdown populated; PriorityClassDetail renders the seeded pc.
Commit message (exact): `refactor(admin): priorityClass 迁 Vue Query(PriorityClasses+Detail+DeployApp 下拉) + fetchPriorityClasses/fetchPriorityClass`

```bash
git add src/stores/cluster.js src/views/PriorityClasses.vue src/views/DeployApp.vue src/views/PriorityClassDetail.vue
git commit -m "refactor(admin): priorityClass 迁 Vue Query(PriorityClasses+Detail+DeployApp 下拉) + fetchPriorityClasses/fetchPriorityClass"
```

---

### Task 4: Trim runtimeClass/ingressClass/priorityClass from `hydrateExtendedResources`

**Files:**
- Modify: `src/stores/cluster.js` (`hydrateExtendedResources`)

**Interfaces:**
- Consumes: Tasks 1-3 migrated ALL remote-mode consumers of these 3 store lists to Query (verified: `store.runtimeClassList` only in RuntimeClasses.vue; `store.ingressClassList` in IngressClasses.vue + NsIngressDetail.vue; `store.priorityClassList` in PriorityClasses.vue + DeployApp.vue — all migrated). So the hydrate population is now dead in remote mode.

- [ ] **Step 1: Verify NO remaining store-reader of these 3 resources**

Before trimming, grep ALL of `src` (views + components + composables) for every access pattern of the 3 resources to confirm every consumer was migrated in Tasks 1-3 (this catches list pages, detail getters, and ns-filter computeds alike — the initial audit once missed `PriorityClassDetail.vue`):
```bash
grep -rnE "runtimeClassList|getRuntimeClassByName|ingressClassList|getIngressClassByName|priorityClassList|getPriorityClassByName" src/views src/components src/composables | grep -v __tests__
```
Expected remaining hits: ONLY `store.<X>List` inside the new queries' `mock:` params and the `?? store.getPriorityClassByName(...)` transient fallback in `PriorityClassDetail.vue` (both are mock-mode/fallback reads, not remote data sources). Any OTHER hit (e.g. a template `v-for`, a `.length`, a `.filter`, a `.find`) means a consumer was NOT migrated — STOP and migrate it before trimming. Do not trim if any real remote consumer remains.

- [ ] **Step 2: Remove the 3 fetch entries from the `Promise.allSettled` array**

In `hydrateExtendedResources`, the array's last three entries are:
```js
      api.k8s('/apis/networking.k8s.io/v1/ingressclasses?limit=5000'),
      api.k8s('/apis/node.k8s.io/v1/runtimeclasses?limit=5000'),
      api.k8s('/apis/scheduling.k8s.io/v1/priorityclasses?limit=5000'),
```
Delete these three lines. (They are indices 16, 17, 18 — the tail — so removing them does not shift indices 0-15 used by the remaining `items(i)` assignments.)

- [ ] **Step 3: Remove the 3 assignment lines**

Delete these three lines (they referenced the now-removed indices 16/17/18):
```js
    ingressClassList.value = items(16).map(mapIngressClass)
    runtimeClassList.value = items(17).map(mapRuntimeClass)
    priorityClassList.value = items(18).map(mapPriorityClass)
```
Do NOT remove the `ingressClassList`/`runtimeClassList`/`priorityClassList` ref declarations elsewhere — they are still seeded for mock mode and used as the queries' `mock:` param.

- [ ] **Step 4: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: the 3 admin pages still render (queries self-fetch in remote; mock seeds in mock mode). The store refs are no longer hydrated in remote mode (dead, but kept for mock seeds).
Commit message (exact): `perf(hydrate): 从 hydrateExtendedResources 剔除 ingressClass/runtimeClass/priorityClass(-3 请求)`

```bash
git add src/stores/cluster.js
git commit -m "perf(hydrate): 从 hydrateExtendedResources 剔除 ingressClass/runtimeClass/priorityClass(-3 请求)"
```

---

### Task 5: Final full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete gate**

Run:
```bash
npm test && npm run typecheck && npm run build && npm run i18n:check
```
Expected: all green. `npm test` covers zero-dep runner + server tests (incl `i18n-check.test`) + vitest; `i18n:check` reports 0 residual hardcoded Chinese.

- [ ] **Step 2: Confirm the consolidation**

By code inspection: `RuntimeClasses.vue`/`IngressClasses.vue`/`NsIngressDetail.vue`/`PriorityClasses.vue`/`DeployApp.vue` no longer read `store.runtimeClassList`/`store.ingressClassList`/`store.priorityClassList` for display (they use the queries); `hydrateExtendedResources` no longer contains those 3 fetches or assignments. Note the app-load request reduction (−3) for the PR description.

- [ ] **Step 3: No commit** (verification only; all changes committed in Tasks 1-4).
