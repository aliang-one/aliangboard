# Data-Model Plan 2d-2: Aggregation + Namespaces → Vue Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** Migrate the last hydrate consumers (ClusterOverview, MonitoringCenter, NamespaceOverview, Namespaces, NamespaceDetail) to Vue Query, unblocking Plan 3 (remove hydrateCoreResources → 12→2).

**Architecture:** Each page adds one `useResourceList` per resource it reads (canonical pattern). `fetchNamespaces` created. Sync buttons → `queryClient.invalidateQueries`. All underlying fetchers (fetchNodes/fetchPods/fetchWorkloads/fetchServices/fetchIngresses/fetchEvents) already exist from prior batches.

**Tech Stack:** Vue 3, `@tanstack/vue-query`, Pinia. No new deps.

## Global Constraints

- **No new deps.** No new hardcoded Chinese (i18n:check). Zero behavior change (namespace counts → "—" or query-derived). Mock-verifiable.
- **Gate**: `npm test && npm run typecheck && npm run build && npm run i18n:check`.
- **Canonical pattern**: `cid = computed(() => store.remoteMode ? (store.currentCluster||'cluster') : 'demo')`; `useResourceList({key:['cluster',cid.value,'<R>'], fetcher:()=>store.fetchX(), mock:store.XList, mockMode:!store.remoteMode, options:{refetchInterval:store.remoteMode?30000:false}, select: list => list.filter(x => x.namespace === ns)})`.
- **Branch**: `feat/data-model-aggregation`. Commit per task.

---

### Task 1: Add `fetchNamespaces` + `fetchNamespace(name)`

**Files:** Modify `src/stores/cluster.js`

- [ ] **Step 1:** Add near other fetchers:
```js
  async function fetchNamespaces() {
    const d = await api.k8s('/api/v1/namespaces')
    return (d?.items || []).map(item => ({
      name: item.metadata?.name,
      status: item.status?.phase || 'Unknown',
      age: ageOf(item.metadata?.creationTimestamp),
      labels: item.metadata?.labels || {},
    }))
  }
  async function fetchNamespace(name) {
    const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(name)}`)
    return d ? { name: d.metadata?.name, status: d.status?.phase || 'Unknown', age: ageOf(d.metadata?.creationTimestamp), labels: d.metadata?.labels || {} } : null
  }
```
Add both to store return.

- [ ] **Step 2:** Verify + commit: `feat(ns): fetchNamespaces/fetchNamespace(为聚合页/namespaces 迁 Query 做准备)`

---

### Task 2: Migrate `ClusterOverview.vue`

**Files:** Modify `src/views/ClusterOverview.vue`

Reads: `store.nodeList`, `store.eventList`, `store.cluster`, `store.clusterHealth`.

- [ ] **Step 1:** Add `useResourceList` import + `cid` + nodes query + events query + computeds:
```js
const nodesQuery = useResourceList({ key: ['cluster', cid.value, 'nodes'], fetcher: () => store.fetchNodes(), mock: store.nodeList, mockMode: !store.remoteMode, options: { refetchInterval: store.remoteMode ? 30000 : false } })
const eventsQuery = useResourceList({ key: ['cluster', cid.value, 'events'], fetcher: () => store.fetchEvents(), mock: store.eventList, mockMode: !store.remoteMode, options: { refetchInterval: store.remoteMode ? 30000 : false } })
const nodeList = computed(() => nodesQuery.data.value || [])
const eventList = computed(() => eventsQuery.data.value || [])
```
Replace all `store.nodeList` → `nodeList`, `store.eventList` → `eventList` in the template/script. Leave `store.cluster` + `store.clusterHealth` (clusterHealth derives from nodeList via `useClusterHealth`; it reads the STORE nodeList — leave as-is for now, Plan 3 handles it). Actually: clusterHealth = `computed(() => computeClusterHealth({ nodeList: store.nodeList, ... }))`. After migration, `store.nodeList` is still hydrated (Plan 3 not yet done). So clusterHealth still works from the store. Leave it untouched.

- [ ] **Step 2:** Verify + commit: `refactor(aggregation): ClusterOverview nodes/events 改用 Vue Query`

---

### Task 3: Migrate `MonitoringCenter.vue`

**Files:** Modify `src/views/MonitoringCenter.vue`

Reads: `store.nodeList`, `store.podList`, `store.workloadList`, `store.eventList`, `store.refreshMetrics`, `store.startEventWatch`, `store.stopEventWatch`.

- [ ] **Step 1:** Add 4 queries (nodes + pods + workloads + events) + computeds. Replace all 4 store-list reads with the computeds. Leave `refreshMetrics` (store method, operates on store lists — still hydrated), `startEventWatch`/`stopEventWatch` (watch toggle, bridge from 2d-1), and `store.cluster` untouched.

- [ ] **Step 2:** Verify + commit: `refactor(aggregation): MonitoringCenter nodes/pods/workloads/events 改用 Vue Query`

---

### Task 4: Migrate `NamespaceOverview.vue`

**Files:** Modify `src/views/NamespaceOverview.vue`

Reads: `store.ingressList`, `store.nsWorkloads`, `store.serviceList`.

- [ ] **Step 1:** Add 3 queries (ingresses + workloads + services, ns-filtered via select) + computeds. Replace all 3 store-list reads. Leave `store.setNamespace` + navigation untouched.

- [ ] **Step 2:** Verify + commit: `refactor(aggregation): NamespaceOverview workloads/services/ingresses 改用 Vue Query`

---

### Task 5: Migrate `Namespaces.vue` + `NamespaceDetail.vue`

**Files:** Modify `src/views/Namespaces.vue`, `src/views/NamespaceDetail.vue`

- [ ] **Step 1 (Namespaces.vue):** Add `useResourceList(namespaces)` + `namespaces` computed. Replace `store.namespaceList` reads. Change the sync button handler: instead of `store.hydrateCoreResources()`, call `store.invalidateAllQueries()` (or `queryClient.invalidateQueries({ predicate: q => q.queryKey[0] === 'cluster' })` — add a store helper if not present).

- [ ] **Step 2 (NamespaceDetail.vue):** Add `useResourceDetail(fetchNamespace)` for the primary namespace + `useResourceList(services, select:ns)` + `useResourceList(workloads, select:ns)`. Replace `store.getNamespaceByName`, `store.serviceList`, `store.workloadList` reads. Change sync → invalidate.

- [ ] **Step 3:** Verify + commit: `refactor(ns): Namespaces/NamespaceDetail 改用 Vue Query;sync 按钮 → invalidate`

---

### Task 6: Final full-suite verification

- [ ] **Step 1:** `npm test && npm run typecheck && npm run build && npm run i18n:check` → all green.
- [ ] **Step 2:** Confirm: all 5 pages read Vue Query; `store.hydrateCoreResources()` is no longer called from any view (only from AppLayout mount + switchCluster + node drain — Plan 3 handles those). Note for PR: **all hydrate consumers migrated → Plan 3 unblocked**.
- [ ] **Step 3:** No commit (verification only).
