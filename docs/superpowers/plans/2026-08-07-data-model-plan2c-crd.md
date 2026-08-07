# Data-Model Plan 2c: CRD → Vue Query (lazy instances) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate CRD list/detail to Vue Query with **lazy instance loading**, then remove `hydrateCRDs`'s N+1 fetch (1 CRD list + one instance-list per CRD) → up to −(N+1) app-load requests.

**Architecture:** `fetchCRDs()`/`fetchCRD(name)` return CRD **definitions only** (no instances); `fetchCRInstances(crd)` loads one CRD's instances on demand (CrdDetail). Extract `mapCRD`/`mapCRInstance` from `hydrateCRDs`. CrdList loses the global instance-count stat (→ "—"); CrdDetail's instances tab + count read an instances query (`enabled` on crd ready). `refreshCRDInstances` invalidates the instances query instead of mutating the store list.

**Tech Stack:** Vue 3 `<script setup>`, `@tanstack/vue-query` (`useResourceList`/`useResourceDetail`), Pinia, Vite. No new deps.

## Global Constraints

- **No new external dependencies.**
- **No new hardcoded Chinese** — gate includes `npm run i18n:check` (0 residual).
- **Zero behavior change** except the acknowledged UX change: CrdList no longer shows a global instance count (→ "—"); instances load when CrdDetail is viewed (one fetch).
- **Verification gate per task**: `npm test && npm run typecheck && npm run build && npm run i18n:check`.
- **No new unit tests for fetchers** — thin api.k8s wrappers (consistent with fetchServices).
- **Canonical patterns** (from Plan 2a/2b): `cid = computed(() => store.remoteMode ? (store.currentCluster||'cluster') : 'demo')`; `useResourceList({key, fetcher, mock: store.XList, mockMode: !store.remoteMode, options:{refetchInterval: store.remoteMode?30000:false}})`; `useResourceDetail({key, fetcher, mock: store.getXByName(...), mockMode, options:{refetchInterval: store.remoteMode?15000:false}})`; detail item `= computed(() => q.data.value ?? store.getXByName(...))`.
- `queryClient` is already imported in `cluster.js` (used by `invalidateResource`).
- **Branch**: `feat/data-model-crd` (checked out). Commit per task.

---

## File Structure

- **Modify** `src/stores/cluster.js` — (T1) add `mapCRD`/`mapCRInstance` + `fetchCRDs`/`fetchCRD`/`fetchCRInstances` + store return; (T3) `refreshCRDInstances` → invalidate instances query; (T4) remove `hydrateCRDs()` call + function.
- **Modify** `src/views/CrdList.vue` — `useResourceList(fetchCRDs)`; `totalInstances` → "—".
- **Modify** `src/views/CrdDetail.vue` — `useResourceDetail(fetchCRD)` + instances `useResourceList(fetchCRInstances)`.

---

### Task 1: Add `mapCRD`/`mapCRInstance` + 3 CRD fetchers

**Files:**
- Modify: `src/stores/cluster.js` (add mappers + fetchers near other fetchX / mappers; expose in store return)

**Interfaces:**
- Produces: `mapCRD(item)` → CRD def object (with `_plural`); `mapCRInstance(item)` → instance object; `fetchCRDs()` / `fetchCRD(name)` / `fetchCRInstances(crd)`.

- [ ] **Step 1: Add the mappers + fetchers**

Near the other mappers/fetchers in `cluster.js`, add (the mapping logic is lifted verbatim from the current `hydrateCRDs`):
```js
  // CRD 定义映射（抽自 hydrateCRDs；保留 _plural 供实例路径用）
  function mapCRD(item) {
    const names = item.spec?.names || {}
    const versions = item.spec?.versions || []
    const served = versions.find(v => v.served && v.storage) || versions.find(v => v.served) || versions[0]
    return {
      name: item.metadata?.name,
      group: item.spec?.group || '',
      version: served?.name || '',
      kind: names.kind || '',
      scope: item.spec?.scope || 'Namespaced',
      namespaced: item.spec?.scope === 'Namespaced',
      description: names.list || names.kind || '',
      instances: [],
      _plural: names.plural || item.metadata?.name?.split('.')[0] || '',
    }
  }
  // CR 实例映射（抽自 hydrateCRDs）
  function mapCRInstance(it) {
    return {
      name: it.metadata?.name,
      namespace: it.metadata?.namespace || '',
      status: it.status?.phase || it.status?.conditions?.find(x => x.type === 'Ready')?.status || 'Ready',
      age: ageOf(it.metadata?.creationTimestamp),
      spec: it.spec,
      labels: it.metadata?.labels || {},
      annotations: it.metadata?.annotations || {},
    }
  }
  async function fetchCRDs() { const d = await api.k8s('/apis/apiextensions.k8s.io/v1/customresourcedefinitions?limit=500'); return (d?.items || []).map(mapCRD) }
  async function fetchCRD(name) { const d = await api.k8s(`/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${encodeURIComponent(name)}`); return d ? mapCRD(d) : null }
  async function fetchCRInstances(crd) {
    const d = await api.k8s(`/apis/${crd.group}/${crd.version}/${crd._plural}?limit=500`)
    return (d?.items || []).map(mapCRInstance)
  }
```
Add `fetchCRDs, fetchCRD, fetchCRInstances` to the store's returned object (near other fetchX). (`mapCRD`/`mapCRInstance` are internal helpers — not returned.)

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green (additive — fetchers exist, not yet called by views).
Commit message (exact): `feat(crd): mapCRD/mapCRInstance + fetchCRDs/fetchCRD/fetchCRInstances(实例懒加载 fetcher)`

```bash
git add src/stores/cluster.js
git commit -m "feat(crd): mapCRD/mapCRInstance + fetchCRDs/fetchCRD/fetchCRInstances(实例懒加载 fetcher)"
```

---

### Task 2: Migrate `CrdList.vue` (list query; totalInstances → "—")

**Files:**
- Modify: `src/views/CrdList.vue`

**Interfaces:**
- Consumes: `fetchCRDs` from Task 1.

- [ ] **Step 1: Add the query + drop the global instance count**

In `src/views/CrdList.vue`:
- Add `import { useResourceList } from '@/composables/useK8sQuery'` (`computed` already imported).
- After `const store = useClusterStore()`, add:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const crdsQuery = useResourceList({
  key: ['cluster', cid.value, 'crds'],
  fetcher: () => store.fetchCRDs(),
  mock: store.crdList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const crds = computed(() => crdsQuery.data.value || [])
```
- Replace `store.crdList` in `filteredCrds` (both the `if (!kw) return store.crdList` and the `.filter` branch) with `crds`.
- Remove the `totalInstances` computed (lines ~41-43) and change its display (line ~69 `{{ totalInstances }}`) to a literal `—`. Leave the `instancesLabel` label and the CRD-count stat (`crds.length`, line ~65) intact.

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: CrdList lists CRDs from seeds; instance-count stat shows "—".
Commit message (exact): `refactor(crd): CrdList 改用 Vue Query;全局实例计数显示 —(实例改懒加载)`

```bash
git add src/views/CrdList.vue
git commit -m "refactor(crd): CrdList 改用 Vue Query;全局实例计数显示 —(实例改懒加载)"
```

---

### Task 3: Migrate `CrdDetail.vue` (definition query + lazy instances query) + `refreshCRDInstances` invalidation

**Files:**
- Modify: `src/views/CrdDetail.vue`
- Modify: `src/stores/cluster.js` (`refreshCRDInstances` → invalidate instances query)

**Interfaces:**
- Consumes: `fetchCRD`, `fetchCRInstances` from Task 1.

- [ ] **Step 1: CrdDetail — definition query + instances query**

In `src/views/CrdDetail.vue`:
- Add `import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'` (`computed` already imported).
- After `const store = useClusterStore()`, add `cid` + definition query + instances query:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const crdDetail = useResourceDetail({
  key: ['cluster', cid.value, 'crds', route.params.name],
  fetcher: () => store.fetchCRD(route.params.name),
  mock: store.getCRDByName(route.params.name),
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 15000 : false },
})
const crd = computed(() => crdDetail.data.value ?? store.getCRDByName(route.params.name))
const instancesQuery = useResourceList({
  key: ['cluster', cid.value, 'crds', route.params.name, 'instances'],
  fetcher: () => store.fetchCRInstances(crd.value),
  mock: crd.value?.instances || [],
  mockMode: !store.remoteMode,
  enabled: !store.remoteMode ? true : (!!crd.value && !!crd.value._plural),
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const instances = computed(() => instancesQuery.data.value || [])
```
(`enabled` gates the remote instances fetch until the CRD def (with `_plural`) is loaded, avoiding a malformed path.)
- Replace all `crd.value?.instances` / `crd.instances` display reads (the instance **count** and the instances **table** `v-for`) with `instances`. (The single-instance YAML expand at line ~85 `api.k8s(store.crInstancePath(crd.value, inst))` is unaffected — it fetches one instance by path, keep it.)
- Remove the old `const crd = computed(() => store.getCRDByName(...))` line. Leave `staticYaml`, `applyCRYaml`, `deleteCRInstance`, `crInstancePath` usages, and the YAML/instance-edit handlers intact.

- [ ] **Step 2: `refreshCRDInstances` → invalidate the instances query**

In `src/stores/cluster.js` `refreshCRDInstances(crdName)` (~line 3056): it currently re-fetches a CRD's instances and mutates `crdList`. Change it to invalidate the instances query (so the CrdDetail instances query refetches) instead of mutating the store list. Replace its body with:
```js
  async function refreshCRDInstances(crdName) {
    if (!remoteMode.value) return
    const cid = currentCluster.value || 'cluster'
    queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === 'crds' && q.queryKey[3] === crdName && q.queryKey[4] === 'instances' })
  }
```
(Leaves `applyCRYaml`/`deleteCRInstance` callers unchanged — they still call `refreshCRDInstances(crdName)`, which now invalidates the instances query.)

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: CrdDetail shows the CRD def + its instances (from seeds via mock); create/delete instance (mock) still refresh the list.
Commit message (exact): `refactor(crd): CrdDetail 改用 Vue Query(定义+懒实例);refreshCRDInstances 改 invalidate`

```bash
git add src/views/CrdDetail.vue src/stores/cluster.js
git commit -m "refactor(crd): CrdDetail 改用 Vue Query(定义+懒实例);refreshCRDInstances 改 invalidate"
```

---

### Task 4: Trim `hydrateCRDs` (grep gate + remove)

**Files:**
- Modify: `src/stores/cluster.js`

**Interfaces:**
- Consumes: Tasks 1-3 migrated all CRD consumers (CrdList, CrdDetail) to Query; `getCRDByName`/`crdList` remain as mock-seed/fallback.

- [ ] **Step 1: Verify NO remaining store consumer of CRD instances/list**

Grep ALL of `src`:
```bash
grep -rnE "crdList|getCRDByName|\.instances" src/views src/components src/composables | grep -v __tests__
```
Expected remaining hits: `store.crdList` inside queries' `mock:` params, `store.getCRDByName(...)` inside `mock:`/`??` fallback, and the `instances` query/local computeds in CrdDetail. The `crd.instances`/`crd.value?.instances` reads in `cluster.js` (`refreshCRDInstances`, `crInstancePath`) and `mock: crd.value?.instances` are expected. Any OTHER display read of `store.crdList`/`crd.instances` as a data source = unmigrated consumer → STOP and migrate it first.

- [ ] **Step 2: Remove the `hydrateCRDs()` call**

In `hydrateCoreResources`, find the trailing CRD kick-off (a line like `hydrateCRDs().catch(e => console.warn('[hydrate] CRD 拉取失败:', e?.message || e))`) and delete it.

- [ ] **Step 3: Remove the `hydrateCRDs` function**

Delete the entire `async function hydrateCRDs() { ... }` block (the N+1 fetcher). Its mapping logic now lives in `mapCRD`/`mapCRInstance`/`fetchCRDs`/`fetchCRInstances` (Task 1). Do NOT remove the `crdList` ref declaration (still seeded for mock + used as Query `mock:`).

- [ ] **Step 4: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: CrdList + CrdDetail render from seeds (queries' `mock:`); remote mode self-fetches (CRD list on CrdList, def+instances on CrdDetail). `crdList` no longer hydrated in remote mode.
Commit message (exact): `perf(hydrate): 移除 hydrateCRDs(N+1 拉取),CRD 全量上 Vue Query 单源(首屏 −(N+1) 请求)`

```bash
git add src/stores/cluster.js
git commit -m "perf(hydrate): 移除 hydrateCRDs(N+1 拉取),CRD 全量上 Vue Query 单源(首屏 −(N+1) 请求)"
```

---

### Task 5: Final full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete gate**

Run:
```bash
npm test && npm run typecheck && npm run build && npm run i18n:check
```
Expected: all green.

- [ ] **Step 2: Confirm the consolidation + request reduction**

By code inspection: CrdList/CrdDetail read Vue Query (CrdDetail instances lazy); `hydrateCRDs` is gone (no N+1 on app load); `crdList` ref kept for mock seeds. Note the app-load request reduction (−(N+1), where N = CRD count — potentially 10–30+ requests) for the PR description.

- [ ] **Step 3: No commit** (verification only; all changes committed in Tasks 1-4).
