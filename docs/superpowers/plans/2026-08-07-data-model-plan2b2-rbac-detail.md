# Data-Model Plan 2b-2: RBAC Detail Pages → Vue Query + Trim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the 4 RBAC detail pages to Vue Query (primary via `useResourceDetail`, related via the existing list queries), then trim all 5 RBAC resources from `hydrateExtendedResources` (−5 app-load requests), completing the RBAC single-source migration started in Plan 2b-1.

**Architecture:** Mirror the `PriorityClassDetail`/`NodeDetail` cluster-scoped detail pattern: each detail page's primary resource becomes a `useResourceDetail` with a new detail fetcher; related reads (rolebindings / clusterrolebindings / role-lookup) reuse the list fetchers from Plan 2b-1 via `useResourceList` + `select`. `nsSecrets` (non-RBAC) stays on the store. Once all consumers are on Query, the keyed-map `hydrateExtendedResources` (from Plan 2b-1's T1) lets the trim be a clean delete of 5 fetcher entries + 5 assignment lines (no reindex). The pre-trim grep gate (from Plan 2a) confirms zero remaining store consumers.

**Tech Stack:** Vue 3 `<script setup>`, `@tanstack/vue-query` (`useResourceDetail`/`useResourceList`), Pinia, Vite. No new deps.

## Global Constraints

- **No new external dependencies.**
- **No new hardcoded Chinese** — gate includes `npm run i18n:check` (0 residual).
- **Zero behavior change** — a migration. Mock mode renders identically (queries' `mock:` reads seeded store refs / `getXByName`).
- **Verification gate per task**: `npm test && npm run typecheck && npm run build && npm run i18n:check`.
- **No new unit tests for fetchers** — thin api.k8s wrappers.
- **Canonical detail pattern** (copy from `PriorityClassDetail.vue`/`NodeDetail.vue`, established in Plan 2a):
  ```js
  const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
  const q = useResourceDetail({
    key: ['cluster', cid.value, '<resource>', route.params.name],
    fetcher: () => store.fetchX(route.params.name, route.params.namespace), // ns-scoped
    mock: store.getXByName(route.params.name, route.params.namespace),
    mockMode: !store.remoteMode,
    options: { refetchInterval: store.remoteMode ? 15000 : false },
  })
  const item = computed(() => q.data.value ?? store.getXByName(...)) // transient fallback
  ```
- **Canonical related-list pattern** (reuse list fetchers from Plan 2b-1):
  ```js
  const relatedQ = useResourceList({
    key: ['cluster', cid.value, '<resource>'],
    fetcher: () => store.fetchXs(),
    mock: store.XList,
    mockMode: !store.remoteMode,
    options: { refetchInterval: store.remoteMode ? 30000 : false },
    select: list => list.filter(...), // page-specific filter
  })
  ```
- List fetchers `fetchRoles`/`fetchRoleBindings`/`fetchClusterRoleBindings`/`fetchServiceAccounts` already exist (Plan 2b-1). `mapRole(item,scope)`/`mapRoleBinding`/`mapServiceAccount` already exist — reuse.
- **Branch**: `feat/data-model-plan2-rbac-detail` (already checked out). Commit per task.

---

## File Structure

- **Modify** `src/stores/cluster.js` — (T1) add 5 detail fetchers + store return; (T6) trim 5 RBAC entries from `hydrateExtendedResources` (keyed map).
- **Modify** `src/views/NsRoleDetail.vue`, `NsRoleBindingDetail.vue`, `NsServiceAccountDetail.vue`, `ClusterRoleDetail.vue` — primary `useResourceDetail` + related `useResourceList`.

---

### Task 1: Add 5 RBAC detail fetchers

**Files:**
- Modify: `src/stores/cluster.js` (add fetchers near the list fetchers from Plan 2b-1; expose in store return)

**Interfaces:**
- Produces: `fetchRole(name,ns)`, `fetchRoleBinding(name,ns)`, `fetchServiceAccount(name,ns)` (ns-scoped), `fetchClusterRole(name)`, `fetchClusterRoleBinding(name)` (cluster-scoped) — each → `Promise<mapped|null>`.

- [ ] **Step 1: Add the fetchers**

Near the Plan 2b-1 RBAC list fetchers (after `fetchServiceAccounts`), add:
```js
  async function fetchRole(name, ns) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/roles/${encodeURIComponent(name)}`); return d ? mapRole(d, 'Namespace') : null }
  async function fetchRoleBinding(name, ns) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/rolebindings/${encodeURIComponent(name)}`); return d ? mapRoleBinding(d) : null }
  async function fetchServiceAccount(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/serviceaccounts/${encodeURIComponent(name)}`); return d ? mapServiceAccount(d) : null }
  async function fetchClusterRole(name) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/clusterroles/${encodeURIComponent(name)}`); return d ? mapRole(d, 'Cluster') : null }
  async function fetchClusterRoleBinding(name) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${encodeURIComponent(name)}`); return d ? mapRoleBinding(d) : null }
```
Note: `fetchClusterRole` maps with `mapRole(d, 'Cluster')` (cluster-scoped role). Add all 5 to the store's returned object (near the other fetchX).

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green (additive — not yet called by views).
Commit message (exact): `feat(rbac): 新增 5 个 RBAC 详情 fetcher(Role/RoleBinding/SA/ClusterRole/ClusterRoleBinding)`

```bash
git add src/stores/cluster.js
git commit -m "feat(rbac): 新增 5 个 RBAC 详情 fetcher(Role/RoleBinding/SA/ClusterRole/ClusterRoleBinding)"
```

---

### Task 2: Migrate `NsRoleDetail.vue` (primary role + related rolebindings)

**Files:**
- Modify: `src/views/NsRoleDetail.vue`

**Interfaces:**
- Consumes: `fetchRole(name,ns)` (Task 1), `fetchRoleBindings()` (Plan 2b-1).

- [ ] **Step 1: Migrate primary + related to Query**

In `src/views/NsRoleDetail.vue`:
- Add `import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'` (`computed` already imported).
- After `const store = useClusterStore()` + `store.setNamespace(...)`, add `cid` + the primary detail query + the related rolebindings query:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const roleDetail = useResourceDetail({
  key: ['cluster', cid.value, 'roles', route.params.name],
  fetcher: () => store.fetchRole(route.params.name, route.params.namespace),
  mock: store.getRoleByName(route.params.name, route.params.namespace),
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 15000 : false },
})
const role = computed(() => roleDetail.data.value ?? store.getRoleByName(route.params.name, route.params.namespace))
const roleBindingsQuery = useResourceList({
  key: ['cluster', cid.value, 'rolebindings'],
  fetcher: () => store.fetchRoleBindings(),
  mock: store.roleBindingList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
```
- Replace the `roleBindings` computed (currently `store.nsRoleBindings.filter(rb => rb.roleName === role.value.name)`):
```js
const roleBindings = computed(() => {
  if (!role.value) return []
  return (roleBindingsQuery.data.value || []).filter(rb => rb.namespace === route.params.namespace && rb.roleName === role.value.name)
})
```
- Remove the old `const role = computed(() => store.getRoleByName(...))` line (now defined above). Leave `useLiveYaml` and the rest untouched.

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: NsRoleDetail shows the role + its bindings.
Commit message (exact): `refactor(rbac): NsRoleDetail 改用 Vue Query(主资源 role + 关联 rolebindings)`

```bash
git add src/views/NsRoleDetail.vue
git commit -m "refactor(rbac): NsRoleDetail 改用 Vue Query(主资源 role + 关联 rolebindings)"
```

---

### Task 3: Migrate `NsRoleBindingDetail.vue` (primary rolebinding + referenced role lookup)

**Files:**
- Modify: `src/views/NsRoleBindingDetail.vue`

**Interfaces:**
- Consumes: `fetchRoleBinding(name,ns)` (Task 1), `fetchRoles()` (Plan 2b-1).

- [ ] **Step 1: Migrate primary + related to Query**

In `src/views/NsRoleBindingDetail.vue`:
- Add `import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'`.
- After `const store = useClusterStore()` + `store.setNamespace(...)`, add `cid` + primary detail query + a roles list query (for the referenced-role lookup):
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const rbDetail = useResourceDetail({
  key: ['cluster', cid.value, 'rolebindings', route.params.name],
  fetcher: () => store.fetchRoleBinding(route.params.name, route.params.namespace),
  mock: store.getRoleBindingByName(route.params.name, route.params.namespace),
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 15000 : false },
})
const rb = computed(() => rbDetail.data.value ?? store.getRoleBindingByName(route.params.name, route.params.namespace))
const rolesQuery = useResourceList({
  key: ['cluster', cid.value, 'roles'],
  fetcher: () => store.fetchRoles(),
  mock: store.roleList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
```
- Replace `referencedRole` (currently `store.getRoleByName(rb.value.roleName, rb.value.namespace)`):
```js
const referencedRole = computed(() => {
  if (!rb.value) return null
  return (rolesQuery.data.value || []).find(r => r.name === rb.value.roleName && (r.scope === 'Cluster' || r.namespace === rb.value.namespace)) || null
})
```
(The find mirrors `getRoleByName`'s logic: match name + scope Cluster OR same namespace.)
- Remove the old `const rb = computed(...)` line. Leave `useLiveYaml` and the edit/subjects logic untouched.

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: NsRoleBindingDetail shows the binding + its referenced role.
Commit message (exact): `refactor(rbac): NsRoleBindingDetail 改用 Vue Query(主资源 rolebinding + 关联 role 查找)`

```bash
git add src/views/NsRoleBindingDetail.vue
git commit -m "refactor(rbac): NsRoleBindingDetail 改用 Vue Query(主资源 rolebinding + 关联 role 查找)"
```

---

### Task 4: Migrate `NsServiceAccountDetail.vue` (primary SA + related rolebindings; nsSecrets stays on store)

**Files:**
- Modify: `src/views/NsServiceAccountDetail.vue`

**Interfaces:**
- Consumes: `fetchServiceAccount(name,ns)` (Task 1), `fetchRoleBindings()` (Plan 2b-1).

- [ ] **Step 1: Migrate primary + related to Query (keep nsSecrets on store)**

In `src/views/NsServiceAccountDetail.vue`:
- Add `import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'`.
- After `const store = useClusterStore()` + `store.setNamespace(...)`, add `cid` + primary detail query + rolebindings query:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const saDetail = useResourceDetail({
  key: ['cluster', cid.value, 'serviceaccounts', route.params.name],
  fetcher: () => store.fetchServiceAccount(route.params.name, route.params.namespace),
  mock: store.getServiceAccountByName(route.params.name, route.params.namespace),
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 15000 : false },
})
const sa = computed(() => saDetail.data.value ?? store.getServiceAccountByName(route.params.name, route.params.namespace))
const roleBindingsQuery = useResourceList({
  key: ['cluster', cid.value, 'rolebindings'],
  fetcher: () => store.fetchRoleBindings(),
  mock: store.roleBindingList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
```
- Replace `saRoleBindings` (currently `store.nsRoleBindings.filter(rb => rb.subjects?.some(s => s.kind==='ServiceAccount' && s.name === sa.value.name))`):
```js
const saRoleBindings = computed(() => {
  if (!sa.value) return []
  return (roleBindingsQuery.data.value || []).filter(rb => rb.namespace === route.params.namespace && rb.subjects?.some(s => s.kind === 'ServiceAccount' && s.name === sa.value.name))
})
```
- LEAVE `saSecrets` (reads `store.nsSecrets`) UNCHANGED — secrets are NOT RBAC and remain hydrated. Remove the old `const sa = computed(...)` line. Leave `useLiveYaml` and the edit logic untouched.

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: NsServiceAccountDetail shows the SA + its rolebindings + its secrets (secrets still from store).
Commit message (exact): `refactor(rbac): NsServiceAccountDetail 改用 Vue Query(主资源 SA + 关联 rolebindings;nsSecrets 保留 store)`

```bash
git add src/views/NsServiceAccountDetail.vue
git commit -m "refactor(rbac): NsServiceAccountDetail 改用 Vue Query(主资源 SA + 关联 rolebindings;nsSecrets 保留 store)"
```

---

### Task 5: Migrate `ClusterRoleDetail.vue` (primary clusterrole + related clusterrolebindings)

**Files:**
- Modify: `src/views/ClusterRoleDetail.vue`

**Interfaces:**
- Consumes: `fetchClusterRole(name)` (Task 1), `fetchClusterRoleBindings()` (Plan 2b-1).

- [ ] **Step 1: Migrate primary + related to Query**

In `src/views/ClusterRoleDetail.vue` (cluster-scoped, no namespace):
- Add `import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'`.
- After `const store = useClusterStore()`, add `cid` + primary detail query + clusterrolebindings query:
```js
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const roleDetail = useResourceDetail({
  key: ['cluster', cid.value, 'roles', route.params.name],
  fetcher: () => store.fetchClusterRole(route.params.name),
  mock: store.getClusterRoleByName(route.params.name),
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 15000 : false },
})
const role = computed(() => roleDetail.data.value ?? store.getClusterRoleByName(route.params.name))
const clusterRoleBindingsQuery = useResourceList({
  key: ['cluster', cid.value, 'clusterrolebindings'],
  fetcher: () => store.fetchClusterRoleBindings(),
  mock: store.clusterRoleBindingList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
```
- Replace `bindings` (currently `store.clusterRoleBindingList.filter(b => b.roleName === role.value?.name)`):
```js
const bindings = computed(() => (clusterRoleBindingsQuery.data.value || []).filter(b => b.roleName === role.value?.name))
```
- Remove the old `const role = computed(...)` line. Leave `useLiveYaml` untouched.

- [ ] **Step 2: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: ClusterRoleDetail shows the clusterrole + its bindings.
Commit message (exact): `refactor(rbac): ClusterRoleDetail 改用 Vue Query(主资源 clusterrole + 关联 clusterrolebindings)`

```bash
git add src/views/ClusterRoleDetail.vue
git commit -m "refactor(rbac): ClusterRoleDetail 改用 Vue Query(主资源 clusterrole + 关联 clusterrolebindings)"
```

---

### Task 6: Trim the 5 RBAC resources from `hydrateExtendedResources`

**Files:**
- Modify: `src/stores/cluster.js` (`hydrateExtendedResources` keyed map)

**Interfaces:**
- Consumes: Tasks 1-5 migrated ALL consumers of roles/rolebindings/clusterrolebindings/serviceaccounts to Query (detail pages now on Query; overview pages from Plan 2b-1; DeployApp SA from Plan 2b-1). `nsSecrets` (secrets) is NOT trimmed (secrets stay hydrated for `NsServiceAccountDetail.saSecrets`).

- [ ] **Step 1: Verify NO remaining store-reader of the 5 RBAC resources**

Grep ALL of `src` for every access pattern (mirrors Plan 2a's T4 gate):
```bash
grep -rnE "roleList|roleBindingList|clusterRoleBindingList|saList|nsRoles|nsRoleBindings|nsServiceAccounts|clusterRoles|getRoleByName|getRoleBindingByName|getClusterRoleByName|getClusterRoleBindingByName|getServiceAccountByName" src/views src/components src/composables | grep -v __tests__
```
Expected remaining hits: ONLY `store.XList`/`store.getXByName(...)` inside queries' `mock:` params and the `?? store.getXByName(...)` transient fallbacks in the detail/overview pages (mock-mode/fallback reads, not remote data sources). Any OTHER hit = a consumer not yet migrated → STOP and migrate it before trimming.

- [ ] **Step 2: Remove the 5 RBAC fetcher entries from the keyed `fetchers` map**

In `hydrateExtendedResources` (keyed map from Plan 2b-1 T1), delete these 5 entries:
```js
      serviceaccounts: () => api.k8s('/api/v1/serviceaccounts?limit=5000'),
      ...
      roles: () => api.k8s('/apis/rbac.authorization.k8s.io/v1/roles?limit=5000'),
      rolebindings: () => api.k8s('/apis/rbac.authorization.k8s.io/v1/rolebindings?limit=5000'),
      clusterroles: () => api.k8s('/apis/rbac.authorization.k8s.io/v1/clusterroles?limit=5000'),
      clusterrolebindings: () => api.k8s('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings?limit=5000'),
```

- [ ] **Step 3: Remove the 5 RBAC assignment lines**

Delete these assignments (they reference the now-removed keys):
```js
    saList.value = out.serviceaccounts.map(mapServiceAccount)
    ...
    // roles 列表同时承载命名空间级 Role 与集群级 ClusterRole（用 scope 区分）
    roleList.value = [
      ...out.roles.map(r => mapRole(r, 'Namespace')),
      ...out.clusterroles.map(r => mapRole(r, 'Cluster')),
    ]
    roleBindingList.value = out.rolebindings.map(mapRoleBinding)
    clusterRoleBindingList.value = out.clusterrolebindings.map(mapRoleBinding)
```
(Also remove the roles comment.) Do NOT remove the `roleList`/`roleBindingList`/`clusterRoleBindingList`/`saList` ref declarations — still seeded for mock mode + used as queries' `mock:` param. Leave secrets/configmaps/etc. untouched.

- [ ] **Step 4: Verify + commit**

Run: `npm test && npm run typecheck && npm run build && npm run i18n:check`
Expected: all green. Mock render: all RBAC pages render (queries self-fetch in remote; mock seeds in mock mode). Store RBAC refs no longer hydrated in remote (kept for mock seeds).
Commit message (exact): `perf(hydrate): 从 hydrateExtendedResources 剔除 RBAC 5 资源(roles/clusterroles/rolebindings/clusterrolebindings/serviceaccounts,-5 请求)`

```bash
git add src/stores/cluster.js
git commit -m "perf(hydrate): 从 hydrateExtendedResources 剔除 RBAC 5 资源(roles/clusterroles/rolebindings/clusterrolebindings/serviceaccounts,-5 请求)"
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

- [ ] **Step 2: Confirm the consolidation + request reduction**

By code inspection: the 4 RBAC detail pages read their primary via `useResourceDetail` and related via `useResourceList`; `nsSecrets` still on store (intended). `hydrateExtendedResources` no longer fetches the 5 RBAC resources (keyed map now has 11 entries: configmaps/secrets/pvcs/endpoints/resourcequotas/limitranges/pvs/networkpolicies/hpas/pdbs/storageclasses). Note the app-load request reduction (−5) for the PR description. RBAC single-source migration complete (overview pages Plan 2b-1 + detail pages this plan).

- [ ] **Step 3: No commit** (verification only; all changes committed in Tasks 1-6).
