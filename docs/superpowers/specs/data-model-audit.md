# Data-Model Audit & Roadmap

## A. Redundant `api.k8s` sites in views (verified 2026-08-06)

| Site | Call | Verdict | Action |
|------|------|---------|--------|
| `PodDetail.vue:230` | re-fetch pod for YAML | **REDUNDANT** — `mapPod` attaches `raw` (cluster.js:1801); `pod.value.raw` is the identical object | Eliminate (Plan 1) |
| `NsServiceDetail.vue:226` | re-fetch service for YAML | **REDUNDANT** — sibling pages use `generateYAML` (NsConfigMapDetail:32) | Eliminate (Plan 1) |
| `CrdDetail.vue:28` | fetch full CRD object | **TBD** — is `store.crdList` item already complete (schema/versions)? If yes → redundant | Confirm in Plan 2; if redundant, use `dumpResourceYaml` |
| `ClusterResourceList.vue:119` | fetch item for YAML | **TBD** — list is `${gv}/${plural}?limit=500`; cluster-scoped list responses usually return full objects → likely redundant | Confirm in Plan 2; if redundant, `dumpResourceYaml(it)` |
| `Settings.vue:40,43` | `/readyz`, `/componentstatuses` | **LEGITIMATE** — health probe + components data, not a duplicate | Leave |
| `CrdDetail.vue:85` | fetch CR instance on expand | **LEGITIMATE** — on-demand instance view (user clicks) | Leave |
| `ClusterResourceList.vue:88` | primary list fetch | **LEGITIMATE** — page's own data | Leave |
| `ClusterResourceList.vue:159`, `NsWorkloadDetail.vue:260` | DELETE | **LEGITIMATE** — mutations | Leave |
| `PodDetail.vue:129` | pod log stream | **LEGITIMATE** — distinct endpoint | Leave |

## B. Per-resource read-source state

- **Query-only (migrated):** configmaps, secrets, services(list+detail), ingresses, networkpolicies, hpas, pdbs, limitranges, resourcequotas, nodes(list), endpoints, workloads(list `NsWorkloads.vue`).
- **Dual (Query + store list both populated):** services, configmaps, secrets, ingresses, etc. — store list filled by `hydrateCoreResources`, Query cache filled by `prefillQueryCache`. Mutation does `invalidateResource`.
- **Store-only (NOT migrated):** pods (`NsPods`/`PodDetail`/`WorkloadDetail`/`Workloads`), workloads-detail (`WorkloadDetail`), CRD (`CrdDetail`/`CrdList`), RBAC views, `NamespaceDetail`/`NamespaceOverview`/`Namespaces`, `NsEvents`, `ClusterOverview`, `MonitoringCenter`, `NodeDetail`.

## C. Couplings that gate hydrate removal (must resolve before removing hydrate)

1. **`clusterHealth`** (`useClusterHealth.js`) reads `store.nodeList` only (NOT metrics) — critical path must keep nodes available.
2. **Namespace selector** (`TopNavBar`/`SideNavBar`) reads `store.namespaceList` — critical path must keep namespaces.
3. **Global search** (`TopNavBar.vue:55-63`) scans `podList/workloadList/serviceList/ingressList/configMapList/secretList/pvcList/nodeList/namespaceList` — must become a lazy Query consumer (open → fill).
4. **Namespace object** carries derived `pods`/`services` counts (cluster.js:2339-2346) — a standalone `fetchNamespaces()` must decide how to produce these (drop, or derive from other queries).
5. **Pod live-watch** (`NsPods` `startPodWatch`) writes `store.podList` — pod-list Query migration needs watch→setQueryData convergence (deferred, live cluster).

## D. Safe phase ordering (corrected from spec)

Spec numbered P1 (remove hydrate) before P2 (migrate pages) — **unsafe**: removing hydrate empties the store lists that 40% of pages still read. Correct order:
1. Plan 1 (this): redundant-request elimination + this audit.
2. Plan 2: migrate store-only pages to Query (list pages safe via `prefillQueryCache` bridge; detail pages temporarily double-fetch until hydrate removed — acceptable intermediate).
3. Plan 3: remove `hydrateCoreResources` overfetch → critical-path only (namespaces+nodes); lazy global search; `switchCluster` = `queryClient.clear()` + critical prefetch. **Delivers the 12→2 first-paint win.**
4. Plan 4 [live cluster]: watch→setQueryData convergence (pods/workloads).
5. Plan 5: collapse store — delete resource lists/computed/fetchers per resource; mutations → invalidate-only.
6. Separate: component modularization (Pod/Label/Event extraction, split `NsWorkloadDetail` 2178 lines).