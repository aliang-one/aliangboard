# Fix: Store List Empty in Remote Mode (Plan 3 Regression)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Root cause:** Plan 3 removed `hydrateCoreResources` → podList/workloadList/serviceList/ingressList/eventList empty in remote mode. Pages reading these store lists directly get empty data.

**Fix:** Add `useResourceList`/`useResourceDetail` for the broken resources on each affected page. Same pattern as all prior batches.

**Branch:** `fix/store-list-empty-remote`. Commit per task.

## Global Constraints
- No new deps. Zero behavior change. i18n:check clean. Gate: `npm test && npm run typecheck && npm run build && npm run i18n:check`.
- Canonical: `cid = computed(() => store.remoteMode ? (store.currentCluster||'cluster') : 'demo')`; `useResourceList({key:['cluster',cid.value,'<R>'], fetcher:()=>store.fetchX(), mock:store.XList, mockMode:!store.remoteMode, options:{refetchInterval:store.remoteMode?30000:false}})`.

---

### Task 1: Fix WorkloadDetail.vue (CRITICAL — completely broken)

**File:** `src/views/WorkloadDetail.vue`

Reads: `store.workloadList.find(...)` (primary workload) + `store.podList.find(...)` (displayData pod).

- [ ] **Step 1:** Add `useResourceDetail` for the primary workload:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const workloadDetail = useResourceDetail({
  key: ['cluster', cid.value, 'workloads', route.params.name],
  fetcher: () => store.fetchWorkload(workload.value?.type || 'Deployment', route.params.name, route.params.namespace),
  mock: store.getWorkloadByName(route.params.name, route.params.namespace),
  mockMode: !store.remoteMode,
})
```
Wait — `fetchWorkload(type, name, ns)` needs the type. But the type comes from the workload object which we're trying to fetch. This is a chicken-and-egg. 

**Alternative:** Use `useResourceList(workloads, select: find by name+ns)` instead of useResourceDetail (avoids needing the type upfront):
```js
const workloadsQuery = useResourceList({
  key: ['cluster', cid.value, 'workloads'],
  fetcher: () => store.fetchWorkloads(),
  mock: store.workloadList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const workload = computed(() => (workloadsQuery.data.value || []).find(w => w.name === route.params.name && w.namespace === route.params.namespace))
```
And the pod (line 21): if it's a PodDetail-reuse case, use a pods query + find:
```js
const podsQuery = useResourceList({
  key: ['cluster', cid.value, 'pods'],
  fetcher: () => store.fetchPods(),
  mock: store.podList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
```
Then `store.podList.find(...)` → `(podsQuery.data.value || []).find(...)`.

Note: WorkloadDetail already has pods + events queries from Plan 2d-1 T5. Check if those are already wired. If so, only the workload primary read needs fixing.

- [ ] **Step 2:** Verify + commit: `fix(workload): WorkloadDetail workload+pod 改用 Vue Query(修远端空数据)`

---

### Task 2: Fix PodDetail.vue (owning workload + events)

**File:** `src/views/PodDetail.vue`

Reads: `store.workloadList` (line ~301, owning workload lookup) + `store.eventsFor/nsEvents` (events panel).

- [ ] **Step 1:** Add a workloads query (for the owning-workload lookup):
```js
const workloadsQuery = useResourceList({
  key: ['cluster', cid.value, 'workloads'],
  fetcher: () => store.fetchWorkloads(),
  mock: store.workloadList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
```
Replace `store.workloadList` in the owning-workload computed (line ~301) with `(workloadsQuery.data.value || [])`.

- [ ] **Step 2:** For events: PodDetail reads `store.eventsFor('Pod', ...)` in remote + `store.nsEvents` in mock. After Plan 3, `store.eventList` is empty → eventsFor returns []. Add an events query:
```js
const eventsQuery = useResourceList({
  key: ['cluster', cid.value, 'events'],
  fetcher: () => store.fetchEvents(),
  mock: store.eventList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
```
Replace the `podEvents` computed: `store.eventsFor(...)` → `(eventsQuery.data.value || []).filter(e => e.relatedKind === 'Pod' && e.relatedName === pod.value?.name && e.relatedNamespace === pod.value?.namespace)`.

- [ ] **Step 3:** Verify + commit: `fix(pod): PodDetail 归属 workload+events 改用 Vue Query(修远端空数据)`

---

### Task 3: Fix Workloads.vue + Network.vue + NodeDetail.vue

**Files:** `src/views/Workloads.vue`, `src/views/Network.vue`, `src/views/NodeDetail.vue`

- **Workloads.vue:** Add workloads query; replace `store.workloadList` with the query data.
- **Network.vue:** Add services + ingresses queries (ns-filtered); replace `store.serviceList`/`store.ingressList`.
- **NodeDetail.vue:** Add pods query; replace `store.podList.filter(p => p.node === ...)` with query data filtered by node.

- [ ] Verify + commit: `fix(views): Workloads/Network/NodeDetail 改用 Vue Query(修远端空数据)`

---

### Task 4: Fix AuditLogs.vue + NsEvents.vue + NsWorkloadDetail.vue

**Files:** `src/views/AuditLogs.vue`, `src/views/NsEvents.vue`, `src/views/NsWorkloadDetail.vue`

- **AuditLogs.vue:** Add events query; replace `store.eventList`.
- **NsEvents.vue:** The `store.eventList.length` check in onMounted → replace with the events query data (NsEvents already has an events query from 2d-1; the issue is the onMounted guard reading store.eventList).
- **NsWorkloadDetail.vue:** Check if the user's fix already added services/ingresses queries. If not (or partial), add them. The grep showed `store.serviceList`/`store.ingressList` reads at lines 619/624 — these need Query.

- [ ] Verify + commit: `fix(views): AuditLogs/NsEvents/NsWorkloadDetail events+关联资源 改用 Vue Query`

---

### Task 5: Final full-suite verification

- [ ] **Step 1:** `npm test && npm run typecheck && npm run build && npm run i18n:check` → all green.
- [ ] **Step 2:** Grep to confirm: no remaining `store.(podList|workloadList|serviceList|ingressList|eventList)` display reads in the fixed pages (only mock:/fallback). The 5 core store lists are no longer display-read by any view.
- [ ] **Step 3:** No commit (verification only).
