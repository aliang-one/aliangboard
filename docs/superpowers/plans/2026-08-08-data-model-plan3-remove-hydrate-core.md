# Data-Model Plan 3: Remove hydrateCoreResources → 12→2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** Replace `hydrateCoreResources` (12 fetches) with `hydrateCriticalResources` (namespaces+nodes, 2 fetches), make TopNavBar global search lazy, remove `prefillQueryCache`. First-paint 23→13 (2 critical + 11 extended).

**Architecture:** Staged: add `hydrateCriticalResources` (additive) → migrate all callers → delete old `hydrateCoreResources` + `prefillQueryCache` → TopNavBar search lazy (Query consumer). `clusterHealth` reads `store.nodeList` (populated by critical). Pages self-fetch pods/workloads/services/etc. via their existing Query.

**Tech Stack:** Vue 3, `@tanstack/vue-query`, Pinia. No new deps.

## Global Constraints

- **No new deps.** No new hardcoded Chinese (i18n:check). Zero behavior change except: first-paint requests reduced; search is lazy (fires queries on open); namespace list no longer shows pod/service counts; node podCount may be stale (0) until Nodes page loads.
- **Gate**: `npm test && npm run typecheck && npm run build && npm run i18n:check`.
- **Branch**: `feat/data-model-plan3`. Commit per task.

---

### Task 1: Add `hydrateCriticalResources` (additive)

**Files:** Modify `src/stores/cluster.js`

- [ ] **Step 1:** Add `hydrateCriticalResources` near `hydrateCoreResources`:
```js
  // 关键路径水合：仅 namespaces + nodes（2 请求），替代原 12 路全量 hydrateCoreResources。
  // clusterHealth 只需 nodeList（Ready/controlPlane），不需 metrics。
  // pods/workloads/services/ingresses/events 等由各页面 Vue Query 自取。
  async function hydrateCriticalResources(opts = {}) {
    if (!remoteMode.value) return
    if (!opts.silent) connectionState.value = 'loading'
    const requests = await Promise.allSettled([
      api.k8s('/api/v1/namespaces'),
      api.k8s('/api/v1/nodes'),
    ])
    const namespaceData = requests[0].status === 'fulfilled' ? requests[0].value : null
    const nodeData = requests[1].status === 'fulfilled' ? requests[1].value : null
    if (!nodeData && remoteMode.value) notify('error', i18n.global.t('store.nodeFetchFailed'))
    if (!namespaceData) {
      if (!opts.silent) connectionState.value = 'error'
      throw new Error(i18n.global.t('store.namespaceReadFailed'))
    }
    if (nodeData?.items) nodeList.value = nodeData.items.map(item => mapNode(item, null))
    if (namespaceData?.items) namespaceList.value = namespaceData.items.map(item => ({
      name: item.metadata?.name,
      status: item.status?.phase || 'Unknown',
      age: ageOf(item.metadata?.creationTimestamp),
      labels: item.metadata?.labels || {},
    }))
    if (currentNamespace.value && namespaceList.value.length
        && !namespaceList.value.some(n => n.name === currentNamespace.value)) {
      setNamespace(namespaceList.value[0].name)
    }
    if (!opts.lite) {
      try { await hydrateExtendedResources() } catch (e) { console.warn('[hydrate] 扩展资源部分失败:', e?.message || e) }
    }
    if (!opts.silent) connectionState.value = 'connected'
    return { failed: requests.filter(r => r.status === 'rejected').length }
  }
```
Add `hydrateCriticalResources` to the store return (alongside `hydrateCoreResources` — both exist temporarily).

- [ ] **Step 2:** Verify + commit: `feat(hydrate): 新增 hydrateCriticalResources(仅 namespaces+nodes,2 请求)`

---

### Task 2: Migrate ALL callers to `hydrateCriticalResources` + delete `prefillQueryCache`

**Files:** Modify `src/stores/cluster.js` (switchCluster, node drain, mutation), `src/components/layout/AppLayout.vue`, `src/views/Clusters.vue`, `src/views/NsWorkloadDetail.vue`

- [ ] **Step 1: AppLayout mount** — replace `hydrateCoreResources` + `prefillQueryCache` with `hydrateCriticalResources`:
```js
// BEFORE (line 27):
if (store.remoteMode) store.hydrateCoreResources({ silent: true }).then(() => store.prefillQueryCache()).catch(() => {})
// AFTER:
if (store.remoteMode) store.hydrateCriticalResources({ silent: true }).catch(() => {})
```

- [ ] **Step 2: switchCluster** (cluster.js ~line 1675) — replace `await hydrateCoreResources()` with:
```js
queryClient.clear()
await hydrateCriticalResources()
```

- [ ] **Step 3: node drain** (cluster.js ~line 1605) — replace `await hydrateCoreResources()` with:
```js
queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' })
await hydrateCriticalResources({ silent: true })
```

- [ ] **Step 4: mutation invalidation** (cluster.js ~line 3171) — replace `await hydrateCoreResources()` with:
```js
queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' })
```

- [ ] **Step 5: Clusters.vue sync** (line 23) — replace `await store.hydrateCoreResources()` with `await store.invalidateAllClusterQueries()`.

- [ ] **Step 6: NsWorkloadDetail refresh** (lines 281, 286, 294) — replace all `store.hydrateCoreResources(...)` calls with `store.invalidateAllClusterQueries()`.

- [ ] **Step 7: Delete `prefillQueryCache`** function from cluster.js (no longer called).

- [ ] **Step 8:** Verify + commit: `refactor(hydrate): 所有调用者改用 hydrateCriticalResources;删 prefillQueryCache`

---

### Task 3: Delete `hydrateCoreResources` (no longer called)

**Files:** Modify `src/stores/cluster.js`

- [ ] **Step 1:** Grep to confirm NO remaining callers:
```bash
grep -rn "hydrateCoreResources" src/ --include=*.vue --include=*.js | grep -v "function hydrateCore\|//\|__tests__\|hydrateCritical\|hydrateExtended"
```
Expected: ZERO hits (all callers migrated to hydrateCriticalResources in T2).

- [ ] **Step 2:** Delete the entire `async function hydrateCoreResources(opts = {}) { ... }` block. Also remove it from the store return object (line ~3578). Keep `hydrateCriticalResources` in the return.

- [ ] **Step 3:** Verify + commit: `perf(hydrate): 删 hydrateCoreResources(12 路全量拉取),首屏 12→2 critical`

---

### Task 4: TopNavBar global search → lazy Query consumer

**Files:** Modify `src/components/layout/TopNavBar.vue`

Currently scans 9 store lists (podList/workloadList/serviceList/ingressList/configMapList/secretList/pvcList/nodeList/namespaceList) synchronously. After hydrateCore removal, most of these are empty in remote → search broken. Migrate to lazy Query consumer.

- [ ] **Step 1:** Add `useResourceList` queries for the resources the search scans (pods/workloads/services/ingresses/configmaps/secrets/pvcs), each `enabled` by a `searchOpen` ref:
```js
import { useResourceList } from '@/composables/useK8sQuery'
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const searchOpen = ref(false)
const searchEnabled = computed(() => searchOpen.value && store.remoteMode)
// Each resource query enabled only when search box opens:
const podsQ = useResourceList({ key: ['cluster', cid.value, 'pods'], fetcher: () => store.fetchPods(), mock: store.podList, mockMode: !store.remoteMode, options: { refetchInterval: false, enabled: searchEnabled.value } })
// ... similarly for workloads, services, ingresses, configmaps, secrets, pvcs
```
(Note: `enabled` via `options.enabled` — verify useResourceList forwards it; it does per `useK8sQuery.js:48`.)

- [ ] **Step 2:** Replace the search index builder (lines 55-63) to read from the queries:
```js
const searchIndex = computed(() => {
  if (!searchOpen.value) return []
  const push = (type, name, ns) => items.push({ type, name, namespace: ns || '' })
  const items = []
  for (const p of (podsQ.data.value || [])) push('Pod', p.name, p.namespace)
  for (const w of (workloadsQ.data.value || [])) push(w.type || 'Workload', w.name, w.namespace)
  // ... etc for services, ingresses, configmaps, secrets, pvcs
  for (const n of (store.nodeList || [])) push('Node', n.name, '')
  for (const ns of (store.namespaceList || [])) push('Namespace', ns.name, '')
  return items
})
```

- [ ] **Step 3:** Wire `searchOpen` to the search input focus/blur (set true on focus, false on blur — or keep true while dropdown is open).

- [ ] **Step 4:** Verify + commit: `refactor(search): TopNavBar 全局搜索改惰性 Query(打开时补取,不再依赖 hydrate 预加载)`

---

### Task 5: Final full-suite verification

- [ ] **Step 1:** `npm test && npm run typecheck && npm run build && npm run i18n:check` → all green.
- [ ] **Step 2:** Confirm: `hydrateCoreResources` GONE (grep 0 hits); `hydrateCriticalResources` replaces it (2 requests: namespaces+nodes); `prefillQueryCache` GONE; TopNavBar search reads Query (lazy). **First-paint 23→13** (2 critical + 11 extended).
- [ ] **Step 3:** No commit (verification only).
