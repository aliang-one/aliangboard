# Data-Model Plan 2d-1: Pods + Events → Vue Query (additive watch bridge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate pods/events consumers (NsPods, PodDetail, WorkloadDetail, NsEvents) to Vue Query with an **additive watch bridge** (store + Query cache both updated) so live updates are preserved.

**Architecture:** Create `fetchPods`/`fetchPod`/`fetchEvents`. In `startPodWatch`/`startEventWatch`'s onMessage, add `queryClient.setQueryData` (via `applyWatchEvent`) alongside the existing store update — additive, no regression. Migrate the 4 consumer pages to `useResourceList`/`useResourceDetail`. Watch toggles (startPodWatch/startEventWatch) stay; live flows into Query via the bridge.

**Tech Stack:** Vue 3 `<script setup>`, `@tanstack/vue-query`, Pinia, Vite. No new deps.

## Global Constraints

- **No new external dependencies.**
- **No new hardcoded Chinese** — gate includes `npm run i18n:check`.
- **Zero behavior change** — additive watch bridge (store still updated); mock renders identically.
- **Verification gate per task**: `npm test && npm run typecheck && npm run build && npm run i18n:check`.
- **No new unit tests for fetchers** — thin api.k8s wrappers. The watch bridge uses already-tested `applyWatchEvent`.
- **Canonical patterns**: `cid = computed(() => store.remoteMode ? (store.currentCluster||'cluster') : 'demo')`; `useResourceList({key, fetcher, mock, mockMode, select, options})`; `useResourceDetail({key, fetcher, mock, mockMode, options})`.
- `applyWatchEvent`, `mapPod`, `mapEvent`, `queryClient`, `currentCluster` are all available in `cluster.js` scope. Add `import { applyWatchEvent } from '@/composables/useK8sQuery'` if not already imported.
- **Branch**: `feat/data-model-pods`. Commit per task.

---

### Task 1: Add `fetchPods`/`fetchPod`/`fetchEvents` + import `applyWatchEvent`

**Files:**
- Modify: `src/stores/cluster.js` (add fetchers near other fetchX; add `applyWatchEvent` import; expose fetchers in store return)

**Interfaces:**
- Produces: `fetchPods()` → `Promise<mappedPod[]>` (with metrics); `fetchPod(name,ns)` → `Promise<mappedPod|null>`; `fetchEvents()` → `Promise<mappedEvent[]>`.

- [ ] **Step 1: Add `applyWatchEvent` import (if not present)**

Near the top of `cluster.js`, check if `applyWatchEvent` is imported from `@/composables/useK8sQuery`. If not, add:
```js
import { applyWatchEvent } from '@/composables/useK8sQuery'
```
(If there's already an import from useK8sQuery, add `applyWatchEvent` to it.)

- [ ] **Step 2: Add the 3 fetchers**

Near the other `fetchX` (after the RBAC/CRD fetchers), add:
```js
  async function fetchPods() {
    const [podData, metricsData] = await Promise.all([
      api.k8s('/api/v1/pods?limit=1000'),
      api.k8s('/apis/metrics.k8s.io/v1beta1/pods').catch(() => null),
    ])
    const metricsAvailable = Boolean(metricsData)
    const podMetricMap = new Map()
    for (const it of (metricsData?.items || [])) {
      let cpuMilli = 0, memKi = 0
      for (const c of (it.containers || [])) { cpuMilli += cpuToMilli(c.usage?.cpu); memKi += memToKi(c.usage?.memory) }
      podMetricMap.set(`${it.metadata?.namespace}/${it.metadata?.name}`, { cpuMilli, memKi })
    }
    const podMetric = (ns, name) => (metricsAvailable ? (podMetricMap.get(`${ns}/${name}`) || null) : null)
    return (podData?.items || []).map(item => mapPod(item, podMetric(item.metadata?.namespace, item.metadata?.name)))
  }
  async function fetchPod(name, ns) {
    const [data, metricsData] = await Promise.all([
      api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}`),
      api.k8s('/apis/metrics.k8s.io/v1beta1/pods').catch(() => null),
    ])
    if (!data) return null
    const m = (metricsData?.items || []).find(it => it.metadata?.namespace === ns && it.metadata?.name === name)
    return mapPod(data, m ? { cpuMilli: m.containers?.reduce((s, c) => s + cpuToMilli(c.usage?.cpu), 0), memKi: m.containers?.reduce((s, c) => s + memToKi(c.usage?.memory), 0) } : null)
  }
  async function fetchEvents() { const d = await api.k8s('/api/v1/events?limit=1000'); return ((d?.items || []).map(mapEvent)).sort((a, b) => (b._ts || 0) - (a._ts || 0)) }
```
Add `fetchPods, fetchPod, fetchEvents` to the store return object.

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green (additive). Commit: `feat(pods): fetchPods/fetchPod/fetchEvents + import applyWatchEvent(为 watch 桥接做准备)`

---

### Task 2: Additive watch bridge (store + Query cache)

**Files:**
- Modify: `src/stores/cluster.js` (`startPodWatch` ~line 1888, `startEventWatch` ~line 1920)

**Interfaces:**
- Produces: pods/events watch events now write BOTH store (existing) AND Query cache (new, additive).

- [ ] **Step 1: Add setQueryData to startPodWatch's onMessage**

In `startPodWatch`'s `onMessage` handler, after `applyPodWatchEvent(evt)`, add:
```js
          applyPodWatchEvent(evt)
          // 加法桥接：同步写 Query 缓存（NsPods 等 Query 消费者享 live）
          const _cid = currentCluster.value || 'cluster'
          queryClient.setQueryData(['cluster', _cid, 'pods'], old => applyWatchEvent(old || [], evt.type, mapPod(evt.object)))
```

- [ ] **Step 2: Add setQueryData to startEventWatch's onMessage**

In `startEventWatch`'s `onMessage`, after `applyEventWatchEvent(evt)`, add:
```js
          applyEventWatchEvent(evt)
          const _cid = currentCluster.value || 'cluster'
          queryClient.setQueryData(['cluster', _cid, 'events'], old => applyWatchEvent(old || [], evt.type, mapEvent(evt.object)))
```

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green (additive — store still updated, Query also updated; mock unaffected as watches don't run in mock). Commit: `feat(watch): pods/events watch 加法桥接——setQueryData 同步写 Query 缓存(live 保留)`

---

### Task 3: Migrate `NsPods.vue`

**Files:**
- Modify: `src/views/NsPods.vue`

**Interfaces:**
- Consumes: `fetchPods` (Task 1); watch bridge (Task 2).

- [ ] **Step 1: Add query + replace store.nsPods**

In `NsPods.vue`:
- Add `import { useResourceList } from '@/composables/useK8sQuery'` (`computed` already imported).
- After `store.setNamespace(route.params.namespace)`, add:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const podsQuery = useResourceList({
  key: ['cluster', cid.value, 'pods'],
  fetcher: () => store.fetchPods(),
  mock: store.podList,
  mockMode: !store.remoteMode,
  select: list => list.filter(p => p.namespace === route.params.namespace),
})
const nsPods = computed(() => podsQuery.data.value || [])
```
- Replace ALL `store.nsPods` references (in `nodeOptions`, `filtered`, `runningCount`, `pendingCount`, `failedCount`, subtitle template) with `nsPods`. Leave `toggleLive`/`startPodWatch`/`stopPodWatch`/`onUnmounted` watch logic unchanged (the bridge writes the Query cache).

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: NsPods lists pods from seeds. Commit: `refactor(pods): NsPods 改用 Vue Query(live 经 watch 桥接流入)`

---

### Task 4: Migrate `PodDetail.vue` (primary pod → Query; events panel stays on store)

**Files:**
- Modify: `src/views/PodDetail.vue`

**Interfaces:**
- Consumes: `fetchPod` (Task 1).

- [ ] **Step 1: Migrate primary pod to useResourceDetail**

In `PodDetail.vue`:
- Add `import { useResourceDetail } from '@/composables/useK8sQuery'`.
- After `store.setNamespace(...)`, add `cid` + detail query:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const podDetail = useResourceDetail({
  key: ['cluster', cid.value, 'pods', route.params.name],
  fetcher: () => store.fetchPod(route.params.name, route.params.namespace),
  mock: store.getPodByName(route.params.name, route.params.namespace),
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 15000 : false },
})
```
- Change `const pod = computed(...)` to: `const pod = computed(() => podDetail.data.value ?? store.getPodByName(route.params.name, route.params.namespace))`.
- Leave the events panel (`store.eventsFor`), YAML export (`pod.raw`), logs, debug, and all handlers UNTOUCHED.

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Commit: `refactor(pods): PodDetail 主资源改用 Vue Query(events/YAML/logs 不变)`

---

### Task 5: Migrate `WorkloadDetail.vue` (managed pods + events → Query)

**Files:**
- Modify: `src/views/WorkloadDetail.vue`

**Interfaces:**
- Consumes: `fetchPods` (Task 1), `fetchEvents` (Task 1).

- [ ] **Step 1: Migrate pod + event reads to Query**

In `WorkloadDetail.vue` (reads `store.podList.slice(0,4)` for managed pods sidebar + `store.eventList.slice(0,4)` for events sidebar):
- Add `import { useResourceList } from '@/composables/useK8sQuery'`.
- Add `cid` + 2 queries (pods + events, ns-filtered):
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const podsQuery = useResourceList({
  key: ['cluster', cid.value, 'pods'],
  fetcher: () => store.fetchPods(),
  mock: store.podList,
  mockMode: !store.remoteMode,
  select: list => list.filter(p => p.namespace === route.params.namespace),
})
const eventsQuery = useResourceList({
  key: ['cluster', cid.value, 'events'],
  fetcher: () => store.fetchEvents(),
  mock: store.eventList,
  mockMode: !store.remoteMode,
  select: list => list.filter(e => e.namespace === route.params.namespace),
})
const nsPods = computed(() => podsQuery.data.value || [])
const nsEvents = computed(() => eventsQuery.data.value || [])
```
- Replace `store.podList.slice(0, 4)` → `nsPods.value.slice(0, 4)` (or a computed `recentPods`).
- Replace `store.eventList.slice(0, 4)` → `nsEvents.value.slice(0, 4)`.
- Leave the workload read (`store.workloadList.find(...)`), delete/restart handlers UNTOUCHED.

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Commit: `refactor(pods): WorkloadDetail 管理 pods 与 events 改用 Vue Query`

---

### Task 6: Migrate `NsEvents.vue`

**Files:**
- Modify: `src/views/NsEvents.vue`

**Interfaces:**
- Consumes: `fetchEvents` (Task 1); watch bridge (Task 2).

- [ ] **Step 1: Add query + replace store.nsEvents**

In `NsEvents.vue`:
- Add `import { useResourceList } from '@/composables/useK8sQuery'`.
- After `store.setNamespace(...)`, add:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const eventsQuery = useResourceList({
  key: ['cluster', cid.value, 'events'],
  fetcher: () => store.fetchEvents(),
  mock: store.eventList,
  mockMode: !store.remoteMode,
  select: list => list.filter(e => e.namespace === route.params.namespace),
})
const nsEvents = computed(() => eventsQuery.data.value || [])
```
- Replace ALL `store.nsEvents` references (`filtered`, count template) with `nsEvents`. Leave `startEventWatch`/`stopEventWatch`/`onMounted`/`onUnmounted` watch logic unchanged (the bridge writes Query cache). The `store.refreshEvents()` call in onMounted can stay (harmless; the query also fetches) or be removed (the query fetcher handles initial load) — leave it for minimal change.

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: NsEvents lists from seeds. Commit: `refactor(events): NsEvents 改用 Vue Query(live 经 watch 桥接流入)`

---

### Task 7: Final full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete gate**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green.

- [ ] **Step 2: Confirm**

By code inspection: NsPods/PodDetail/WorkloadDetail/NsEvents read Vue Query (pods/events); the watch bridge writes BOTH store + Query cache (additive); `store.nsPods`/`store.podList`/`store.nsEvents`/`store.eventList` display reads are gone from these 4 pages (only `mock:` remains). Note for PR: pods/events are now on Vue Query single-source with live preserved via the additive bridge; this unblocks Plan 2d-2 (aggregation+namespaces) + Plan 3 (remove hydrateCoreResources).

- [ ] **Step 3: No commit** (verification only).
