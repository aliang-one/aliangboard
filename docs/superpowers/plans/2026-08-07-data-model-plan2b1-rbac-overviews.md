# Data-Model Plan 2b-1: RBAC Overview Pages → Vue Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `hydrateExtendedResources` to a keyed map (zero behavior change), add the 4 RBAC list fetchers, and migrate the 3 RBAC overview/list pages (`RbacCanI`, `RBAC.vue`, `NsRBAC`) + the `DeployApp` SA dropdown to Vue Query — the foundation for Plan 2b-2 (detail pages + trim).

**Architecture:** Mirror the admin-classes pattern (Plan 2a): each resource gets a thin `fetchX` (roles combines 2 endpoints like `fetchWorkloads`); each overview page adds one `useResourceList` per resource it reads, with `select` for namespace/scope filtering. `fetchRoles` returns roles+clusterroles combined (via `mapRole(item,'Namespace'|'Cluster')`). `hydrateExtendedResources` becomes a named-key map so future trims don't shift indices. No trim in this plan (detail pages still read store → temporary double-fetch for the overview pages' resources, accepted per the project's "progress over strict no-double-fetch" steer).

**Tech Stack:** Vue 3 `<script setup>`, `@tanstack/vue-query` (`useResourceList`), Pinia, Vite. No new deps.

## Global Constraints

- **No new external dependencies.**
- **No new hardcoded Chinese** — gate includes `npm run i18n:check` (0 residual). Page edits preserve existing `t()`.
- **Zero behavior change** — a migration. Mock mode (`remoteMode=false`) renders identically (queries' `mock:` reads the seeded store refs).
- **Verification gate per task**: `npm test && npm run typecheck && npm run build && npm run i18n:check`.
- **No new unit tests for fetchers** — thin api.k8s wrappers (consistent with `fetchServices`). The hydrate refactor is verified by the existing store tests + mock render.
- **Canonical cid + useResourceList pattern** (copy verbatim from `NsServices.vue`/Plan 2a):
  ```js
  const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
  const q = useResourceList({
    key: ['cluster', cid.value, '<resource>'],
    fetcher: () => store.fetchX(),
    mock: store.XList,
    mockMode: !store.remoteMode,
    options: { refetchInterval: store.remoteMode ? 30000 : false },
    select: list => list.filter(...), // optional ns/scope filter
  })
  // consume via computed: const items = computed(() => q.data.value || [])
  ```
- `mapRole(item, scope)` / `mapRoleBinding(item)` / `mapServiceAccount(item)` already exist — reuse, do NOT redefine.
- **Branch**: `feat/data-model-plan2-rbac` (already checked out). Commit per task.
- **Scope note**: This plan does NOT trim hydrate (detail pages still read store). Plan 2b-2 migrates detail pages + trims.

---

## File Structure

- **Modify** `src/stores/cluster.js` — (T1) refactor `hydrateExtendedResources` to keyed map; (T2) add `fetchRoles`/`fetchRoleBindings`/`fetchClusterRoleBindings`/`fetchServiceAccounts` + expose in store return.
- **Modify** `src/views/RbacCanI.vue` — 2 queries (rolebindings + clusterrolebindings).
- **Modify** `src/views/RBAC.vue` — 3 queries (roles + clusterrolebindings + serviceaccounts).
- **Modify** `src/views/NsRBAC.vue` — 4 queries (roles + rolebindings + clusterrolebindings + serviceaccounts) + scope/ns selects.
- **Modify** `src/views/DeployApp.vue` — 1 query (serviceaccounts) for the SA dropdown.

---

### Task 1: Refactor `hydrateExtendedResources` to a keyed map (zero behavior change)

**Files:**
- Modify: `src/stores/cluster.js` (`hydrateExtendedResources`)

**Interfaces:**
- Produces: `hydrateExtendedResources` unchanged behavior, but assigns via named keys instead of positional `items(i)` — so removing a resource later = delete its fetcher entry + assignment (no reindex).

- [ ] **Step 1: Replace the function body**

In `src/stores/cluster.js`, replace the entire `hydrateExtendedResources` function body with:
```js
  async function hydrateExtendedResources() {
    if (!remoteMode.value) return
    const fetchers = {
      configmaps: () => api.k8s('/api/v1/configmaps?limit=5000'),
      secrets: () => api.k8s('/api/v1/secrets?limit=5000'),
      persistentvolumeclaims: () => api.k8s('/api/v1/persistentvolumeclaims?limit=5000'),
      endpoints: () => api.k8s('/api/v1/endpoints?limit=5000'),
      serviceaccounts: () => api.k8s('/api/v1/serviceaccounts?limit=5000'),
      resourcequotas: () => api.k8s('/api/v1/resourcequotas?limit=5000'),
      limitranges: () => api.k8s('/api/v1/limitranges?limit=5000'),
      persistentvolumes: () => api.k8s('/api/v1/persistentvolumes?limit=5000'),
      networkpolicies: () => api.k8s('/apis/networking.k8s.io/v1/networkpolicies?limit=5000'),
      horizontalpodautoscalers: () => api.k8s('/apis/autoscaling/v2/horizontalpodautoscalers?limit=5000'),
      poddisruptionbudgets: () => api.k8s('/apis/policy/v1/poddisruptionbudgets?limit=5000'),
      roles: () => api.k8s('/apis/rbac.authorization.k8s.io/v1/roles?limit=5000'),
      rolebindings: () => api.k8s('/apis/rbac.authorization.k8s.io/v1/rolebindings?limit=5000'),
      clusterroles: () => api.k8s('/apis/rbac.authorization.k8s.io/v1/clusterroles?limit=5000'),
      clusterrolebindings: () => api.k8s('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings?limit=5000'),
      storageclasses: () => api.k8s('/apis/storage.k8s.io/v1/storageclasses?limit=5000'),
    }
    const out = {}
    let failed = 0
    await Promise.all(Object.entries(fetchers).map(async ([k, fn]) => {
      try { out[k] = (await fn())?.items || [] } catch { out[k] = []; failed++ }
    }))
    configMapList.value = out.configmaps.map(mapConfigMap)
    secretList.value = out.secrets.map(mapSecret)
    pvcList.value = out.persistentvolumeclaims.map(mapPVC)
    endpointsList.value = out.endpoints.map(mapEndpoints)
    saList.value = out.serviceaccounts.map(mapServiceAccount)
    resourceQuotaList.value = out.resourcequotas.map(mapResourceQuota)
    limitRangeList.value = out.limitranges.map(mapLimitRange)
    pvList.value = out.persistentvolumes.map(mapPV)
    networkPolicyList.value = out.networkpolicies.map(mapNetworkPolicy)
    hpaList.value = out.horizontalpodautoscalers.map(mapHPA)
    pdbList.value = out.poddisruptionbudgets.map(mapPDB)
    // roles 列表同时承载命名空间级 Role 与集群级 ClusterRole（用 scope 区分）
    roleList.value = [
      ...out.roles.map(r => mapRole(r, 'Namespace')),
      ...out.clusterroles.map(r => mapRole(r, 'Cluster')),
    ]
    roleBindingList.value = out.rolebindings.map(mapRoleBinding)
    clusterRoleBindingList.value = out.clusterrolebindings.map(mapRoleBinding)
    scList.value = out.storageclasses.map(mapStorageClass)
    return { failed }
  }
```
This preserves every endpoint, mapper, assignment, and the `failed` count semantics — only the plumbing changes (positional → keyed). The 16 resources and their `mapX` are identical to before.

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green (pure refactor — no behavior change). Mock mode unaffected (function still early-returns when `!remoteMode`).
Commit message (exact): `refactor(hydrate): hydrateExtendedResources 改键控 map(零行为变更,为后续剔除不错位)`

```bash
git add src/stores/cluster.js
git commit -m "refactor(hydrate): hydrateExtendedResources 改键控 map(零行为变更,为后续剔除不错位)"
```

---

### Task 2: Add the 4 RBAC list fetchers

**Files:**
- Modify: `src/stores/cluster.js` (add 4 fetchers near `fetchPVCs` ~line 1207; expose in store return ~line 3531-3540)

**Interfaces:**
- Produces: `fetchRoles()` (roles+clusterroles combined), `fetchRoleBindings()`, `fetchClusterRoleBindings()`, `fetchServiceAccounts()` — each → `Promise<mapped[]>`. Consumed by Tasks 3-6.

- [ ] **Step 1: Add the fetchers**

Near the other `fetchX` one-liners (after `fetchPVCs`/`fetchPVC`), add:
```js
  async function fetchRoles() {
    const [roles, clusterRoles] = await Promise.all([
      api.k8s('/apis/rbac.authorization.k8s.io/v1/roles?limit=5000'),
      api.k8s('/apis/rbac.authorization.k8s.io/v1/clusterroles?limit=5000'),
    ])
    return [
      ...((roles?.items || []).map(r => mapRole(r, 'Namespace'))),
      ...((clusterRoles?.items || []).map(r => mapRole(r, 'Cluster'))),
    ]
  }
  async function fetchRoleBindings() { const d = await api.k8s('/apis/rbac.authorization.k8s.io/v1/rolebindings?limit=5000'); return (d?.items || []).map(mapRoleBinding) }
  async function fetchClusterRoleBindings() { const d = await api.k8s('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings?limit=5000'); return (d?.items || []).map(mapRoleBinding) }
  async function fetchServiceAccounts() { const d = await api.k8s('/api/v1/serviceaccounts?limit=5000'); return (d?.items || []).map(mapServiceAccount) }
```
Then add `fetchRoles, fetchRoleBindings, fetchClusterRoleBindings, fetchServiceAccounts` to the store's returned object (near the other `fetchX`, ~line 3531-3540).

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green (additive — fetchers exist but are not yet called by any view; that's fine, Tasks 3-6 adopt them).
Commit message (exact): `feat(rbac): 新增 fetchRoles/RoleBindings/ClusterRoleBindings/ServiceAccounts 列表 fetcher`

```bash
git add src/stores/cluster.js
git commit -m "feat(rbac): 新增 fetchRoles/RoleBindings/ClusterRoleBindings/ServiceAccounts 列表 fetcher"
```

---

### Task 3: Migrate `RbacCanI.vue` (2 queries: rolebindings + clusterrolebindings)

**Files:**
- Modify: `src/views/RbacCanI.vue`

**Interfaces:**
- Consumes: `fetchRoleBindings`, `fetchClusterRoleBindings` from Task 2.

- [ ] **Step 1: Replace the store-list reads with queries**

In `src/views/RbacCanI.vue`:
- Add imports: `import { useResourceList } from '@/composables/useK8sQuery'` (`computed` is already imported).
- After `const store = useClusterStore()`, add:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const roleBindingsQuery = useResourceList({
  key: ['cluster', cid.value, 'rolebindings'],
  fetcher: () => store.fetchRoleBindings(),
  mock: store.roleBindingList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const clusterRoleBindingsQuery = useResourceList({
  key: ['cluster', cid.value, 'clusterrolebindings'],
  fetcher: () => store.fetchClusterRoleBindings(),
  mock: store.clusterRoleBindingList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
```
- Replace the `knownSubjects` computed (currently `[...store.roleBindingList, ...store.clusterRoleBindingList]`):
```js
const knownSubjects = computed(() => {
  const set = new Set()
  ;[...(roleBindingsQuery.data.value || []), ...(clusterRoleBindingsQuery.data.value || [])].forEach(b => {
    (b.subjects || []).forEach(s => set.add(s.name))
  })
  return Array.from(set)
})
```

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: RbacCanI's known-subjects list populated from seeds.
Commit message (exact): `refactor(rbac): RbacCanI 角色绑定改用 Vue Query(rolebindings + clusterrolebindings)`

```bash
git add src/views/RbacCanI.vue
git commit -m "refactor(rbac): RbacCanI 角色绑定改用 Vue Query(rolebindings + clusterrolebindings)"
```

---

### Task 4: Migrate `RBAC.vue` (3 queries: roles + clusterrolebindings + serviceaccounts)

**Files:**
- Modify: `src/views/RBAC.vue`

**Interfaces:**
- Consumes: `fetchRoles`, `fetchClusterRoleBindings`, `fetchServiceAccounts` from Task 2.

- [ ] **Step 1: Replace the store-list reads with queries**

In `src/views/RBAC.vue`:
- Add `import { useResourceList } from '@/composables/useK8sQuery'` (`computed` already imported).
- After `const store = useClusterStore()`, add:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const rolesQuery = useResourceList({
  key: ['cluster', cid.value, 'roles'],
  fetcher: () => store.fetchRoles(),
  mock: store.roleList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const clusterRoleBindingsQuery = useResourceList({
  key: ['cluster', cid.value, 'clusterrolebindings'],
  fetcher: () => store.fetchClusterRoleBindings(),
  mock: store.clusterRoleBindingList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const serviceAccountsQuery = useResourceList({
  key: ['cluster', cid.value, 'serviceaccounts'],
  fetcher: () => store.fetchServiceAccounts(),
  mock: store.saList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
```
- Replace the `currentTabList` computed (currently `{ roles: store.roleList, clusterrolebindings: store.clusterRoleBindingList, serviceaccounts: store.saList }[activeTab.value]`):
```js
const currentTabList = computed(() => ({
  roles: rolesQuery.data.value || [],
  clusterrolebindings: clusterRoleBindingsQuery.data.value || [],
  serviceaccounts: serviceAccountsQuery.data.value || [],
}[activeTab.value] || []))
```

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: RBAC.vue's 3 tabs (roles / clusterrolebindings / serviceaccounts) populated from seeds.
Commit message (exact): `refactor(rbac): RBAC.vue 三 tab(rolebindings 改 roles/crb/sa)用 Vue Query`

```bash
git add src/views/RBAC.vue
git commit -m "refactor(rbac): RBAC.vue 三 tab(roles/crb/sa)改用 Vue Query"
```

---

### Task 5: Migrate `NsRBAC.vue` (4 queries + ns/scope selects)

**Files:**
- Modify: `src/views/NsRBAC.vue`

**Interfaces:**
- Consumes: `fetchRoles`, `fetchRoleBindings`, `fetchClusterRoleBindings`, `fetchServiceAccounts` from Task 2.

- [ ] **Step 1: Replace the store-list reads with queries + selects**

In `src/views/NsRBAC.vue`:
- Add `import { useResourceList } from '@/composables/useK8sQuery'` (`computed` already imported).
- After `const store = useClusterStore()` and the existing `store.setNamespace(route.params.namespace)`, add the namespace const + 4 queries:
```js
const ns = computed(() => route.params.namespace)
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const rolesQuery = useResourceList({
  key: ['cluster', cid.value, 'roles'],
  fetcher: () => store.fetchRoles(),
  mock: store.roleList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const roleBindingsQuery = useResourceList({
  key: ['cluster', cid.value, 'rolebindings'],
  fetcher: () => store.fetchRoleBindings(),
  mock: store.roleBindingList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const clusterRoleBindingsQuery = useResourceList({
  key: ['cluster', cid.value, 'clusterrolebindings'],
  fetcher: () => store.fetchClusterRoleBindings(),
  mock: store.clusterRoleBindingList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const serviceAccountsQuery = useResourceList({
  key: ['cluster', cid.value, 'serviceaccounts'],
  fetcher: () => store.fetchServiceAccounts(),
  mock: store.saList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
// ns/scope 派生（替代 store.nsRoles / nsRoleBindings / nsServiceAccounts / clusterRoles）
const nsRoles = computed(() => (rolesQuery.data.value || []).filter(r => r.scope === 'Namespace' && r.namespace === ns.value))
const clusterRoles = computed(() => (rolesQuery.data.value || []).filter(r => r.scope === 'Cluster'))
const nsRoleBindings = computed(() => (roleBindingsQuery.data.value || []).filter(rb => rb.namespace === ns.value))
const nsServiceAccounts = computed(() => (serviceAccountsQuery.data.value || []).filter(s => s.namespace === ns.value))
```
- Replace `clusterRoleOptions` (currently `store.clusterRoles.map(r => r.name)`):
```js
const clusterRoleOptions = computed(() => clusterRoles.value.map(r => r.name))
```
- Replace `currentTabList` (currently `{ roles: store.nsRoles, serviceaccounts: store.nsServiceAccounts, rolebindings: store.nsRoleBindings, clusterrolebindings: store.clusterRoleBindingList }[activeTab.value]`):
```js
const currentTabList = computed(() => ({
  roles: nsRoles.value,
  serviceaccounts: nsServiceAccounts.value,
  rolebindings: nsRoleBindings.value,
  clusterrolebindings: clusterRoleBindingsQuery.data.value || [],
}[activeTab.value] || []))
```

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: NsRBAC's 4 tabs populated from seeds (ns-filtered for ns-scoped resources; clusterrolebindings cluster-wide; clusterRoleOptions dropdown populated).
Commit message (exact): `refactor(rbac): NsRBAC 四 tab 改用 Vue Query(ns/scope select 派生)`

```bash
git add src/views/NsRBAC.vue
git commit -m "refactor(rbac): NsRBAC 四 tab 改用 Vue Query(ns/scope select 派生)"
```

---

### Task 6: Migrate the `DeployApp` SA dropdown

**Files:**
- Modify: `src/views/DeployApp.vue`

**Interfaces:**
- Consumes: `fetchServiceAccounts` from Task 2.

- [ ] **Step 1: Replace the SA store-list read with a query**

`src/views/DeployApp.vue` has `const availableServiceAccounts = computed(() => store.nsServiceAccounts.map(s => s.name))` (~line 231) and reads `route.params.namespace`-equivalent (its form targets a namespace). Add (in `<script setup>`, near its other store usage):
```js
import { useResourceList } from '@/composables/useK8sQuery'
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const serviceAccountsQuery = useResourceList({
  key: ['cluster', cid.value, 'serviceaccounts'],
  fetcher: () => store.fetchServiceAccounts(),
  mock: store.saList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
```
Then change `availableServiceAccounts` to read the query. IMPORTANT: preserve exact current behavior — `store.nsServiceAccounts` filters by the **global** `store.currentNamespace` (NOT the form's target namespace), so filter the query the same way. Replace:
```js
const availableServiceAccounts = computed(() => store.nsServiceAccounts.map(s => s.name))
```
with:
```js
const availableServiceAccounts = computed(() => (serviceAccountsQuery.data.value || []).filter(s => s.namespace === store.currentNamespace).map(s => s.name))
```
Leave all other DeployApp store reads untouched.

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: DeployApp's SA dropdown populated from seeds filtered to the selected namespace.
Commit message (exact): `refactor(deploy): DeployApp SA 下拉改用 Vue Query(serviceaccounts)`

```bash
git add src/views/DeployApp.vue
git commit -m "refactor(deploy): DeployApp SA 下拉改用 Vue Query(serviceaccounts)"
```

---

### Task 7: Final full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete gate**

Run:
```bash
npm test && npm run typecheck && npm run build && npm run i18n:check
```
Expected: all green.

- [ ] **Step 2: Confirm the migration**

By code inspection: `RbacCanI.vue`, `RBAC.vue`, `NsRBAC.vue` no longer read `store.roleList`/`roleBindingList`/`clusterRoleBindingList`/`saList`/`nsRoles`/`nsRoleBindings`/`nsServiceAccounts`/`clusterRoles` for display (they use the queries — `store.XList` remains ONLY inside `mock:` params); `DeployApp.vue`'s `availableServiceAccounts` reads the query. `hydrateExtendedResources` is the keyed-map form. Note: no trim this plan (detail pages still read store) — that's Plan 2b-2.

- [ ] **Step 3: No commit** (verification only; all changes committed in Tasks 1-6).
