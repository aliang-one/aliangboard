# Data-Model Plan 1: Eliminate Redundant Per-Page Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the redundant `api.k8s` re-fetches on detail pages (Pod, Service) by reading the already-cached object — directly cutting the "one page, several requests" pain — and produce the audit that sequences all later data-model work.

**Architecture:** Detail pages already hold the full server object: `mapPod`/`mapWorkload` attach `raw: item` (`src/stores/cluster.js:1801/1825`). PodDetail re-fetches the pod just to dump YAML (`PodDetail.vue:230`); NsServiceDetail re-fetches the service (`NsServiceDetail.vue:226`) instead of using the established `generateYAML('service', …)` pattern that sibling pages (`NsConfigMapDetail.vue:32`, `NsSecretDetail.vue:31`) already use. Extract one pure, tested helper `dumpResourceYaml(raw)` for the raw-dump path; switch Service to `generateYAML`. No hydrate changes, no Query migration, no live-cluster dependency — fully mock-verifiable.

**Tech Stack:** Vue 3 + Pinia, `@tanstack/vue-query`, `js-yaml` (already a dependency), Vite. Tests: `scripts/test.mjs` (zero-dep runner for pure logic), `vitest` + `@vue/test-utils` + `happy-dom` for components, `node --check` for syntax.

## Global Constraints

- **No new external dependencies** (per `CLAUDE.md`). `js-yaml` is already declared and used; do not add anything.
- **Pure logic is tested with the zero-dep runner** (`scripts/test.mjs`); components/composables with vitest. This plan's new logic is pure → goes in `scripts/test.mjs`.
- **Each step must be mock-verifiable**: `remoteMode=false` must still render correctly. No live cluster is required for this plan.
- **Verification gate per task**: `npm run typecheck` (node --check) + `npm run build` (covers `.vue`) + `npm test` (zero-dep runner) must all pass before commit.
- **Branch**: `feat/modular-data-model` (already checked out in this worktree). Commit per task.

## Scope & Roadmap (read this first)

This is **Plan 1** of the data-model effort. The big architectural wins (remove the 12-request app-load hydrate → 2 requests; collapse the 3586-line store; migrate the ~40% store-reading pages to Vue Query) are **sequenced in later plans**, because:
- Removing hydrate is blocked until the store-reading pages migrate (else those pages go empty) — spec P1-before-P2 ordering is unsafe; correct order is pages-first.
- Pod **list** migration (`NsPods`) is tangled with live pod-watch (`startPodWatch` writes `store.podList`); watch→setQueryData convergence needs a live cluster and is explicitly deferred.

Plan 1 delivers the safe, mock-verifiable, on-point subset: **the redundant-request eliminations + the audit/roadmap doc**. Subsequent plans: (2) migrate clean non-watch pages to Query, (3) remove hydrate overfetch + lazy global search, (4) watch convergence [needs live cluster], (5) collapse store lists, (separate) component modularization.

---

## File Structure

- **Modify** `src/composables/useYaml.js` — add pure `dumpResourceYaml(raw, opts)` alongside existing `yamlScalar`.
- **Modify** `scripts/test.mjs` — add zero-dep tests for `dumpResourceYaml`.
- **Modify** `src/views/PodDetail.vue` — replace `api.k8s` re-fetch (line ~230) with `dumpResourceYaml(pod.value.raw)`.
- **Modify** `src/views/NsServiceDetail.vue` — replace `api.k8s` re-fetch (line ~226) with `store.generateYAML('service', svc.value)`.
- **Create** `docs/superpowers/specs/data-model-audit.md` — the per-resource migration matrix + redundant-request inventory + roadmap.

---

### Task 1: Redundant-request audit & roadmap doc

**Files:**
- Create: `docs/superpowers/specs/data-model-audit.md`

**Interfaces:**
- Produces: the canonical inventory every later plan references — per-resource Query/store state, every `api.k8s` site in views classified redundant vs legitimate, and the safe phase ordering.

- [ ] **Step 1: Create the audit doc with the redundant-request inventory**

Create `docs/superpowers/specs/data-model-audit.md` with these sections (content below is the verified findings — copy it in):

````markdown
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
````

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/data-model-audit.md
git commit -m "docs(data-model): 冗余请求清单 + 迁移矩阵 + 安全阶段排序 audit"
```

---

### Task 2: Pure `dumpResourceYaml` helper + zero-dep tests (TDD)

**Files:**
- Modify: `src/composables/useYaml.js`
- Test: `scripts/test.mjs`

**Interfaces:**
- Produces: `dumpResourceYaml(raw, { stripStatus = false } = {})` → `string`. Deep-clones `raw`, deletes `metadata.managedFields` (always), deletes `status` only when `stripStatus`, returns `js-yaml` `dump(clone)`. Returns `''` for null/undefined. Does not mutate input.

- [ ] **Step 1: Write the failing tests**

In `scripts/test.mjs`, update the existing import line and append tests. Find:
```js
import { yamlScalar } from '../src/composables/useYaml.js'
```
Replace with:
```js
import { yamlScalar, dumpResourceYaml } from '../src/composables/useYaml.js'
```
Then append these tests at the end of the file (before the results-summary block, if one exists; otherwise at the bottom):
```js
// --- dumpResourceYaml：原始 K8s 对象 → 干净 YAML（剔除 managedFields，可选 status） ---
test('dumpResourceYaml 剔除 managedFields、默认保留 status', () => {
  const raw = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web', managedFields: [{ x: 1 }] }, status: { phase: 'Running' }, spec: { containers: [] } }
  const y = dumpResourceYaml(raw)
  assert.ok(!y.includes('managedFields'), 'managedFields 应被剔除')
  assert.ok(y.includes('phase: Running'), 'status 默认保留')
  assert.ok(y.includes('kind: Pod'))
})
test('dumpResourceYaml stripStatus=true 剔除 status', () => {
  const raw = { kind: 'Service', metadata: { name: 's', managedFields: [{}] }, status: { loadBalancer: { ingress: [] } }, spec: {} }
  const y = dumpResourceYaml(raw, { stripStatus: true })
  assert.ok(!y.includes('loadBalancer'), 'status 应被剔除')
})
test('dumpResourceYaml 空/undefined 安全返回空串', () => {
  assert.equal(dumpResourceYaml(null), '')
  assert.equal(dumpResourceYaml(undefined), '')
})
test('dumpResourceYaml 不修改原对象', () => {
  const raw = { metadata: { name: 'n', managedFields: [1] }, status: { x: 1 } }
  dumpResourceYaml(raw)
  assert.ok(Array.isArray(raw.metadata.managedFields), '原对象 managedFields 不被破坏')
  assert.ok(raw.status, '原对象 status 不被破坏')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `dumpResourceYaml is not a function` (not yet exported from `useYaml.js`).

- [ ] **Step 3: Implement the helper**

In `src/composables/useYaml.js`, ensure `js-yaml`'s `dump` is imported (add at top if missing):
```js
import { dump } from 'js-yaml'
```
Add the function (alongside `yamlScalar`):
```js
// 把 K8s 原始对象转成「干净 YAML」：深拷贝后剔除 metadata.managedFields（冗长），
// 默认保留 status；stripStatus:true 时一并剔除 status（只读/派生）。
// 供详情页「查看 YAML」复用——避免每个详情页各自 api.k8s 再拉一遍同一对象。
export function dumpResourceYaml(raw, { stripStatus = false } = {}) {
  if (!raw) return ''
  const clone = JSON.parse(JSON.stringify(raw))
  if (clone?.metadata) delete clone.metadata.managedFields
  if (stripStatus && clone?.status) delete clone.status
  return dump(clone)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `dumpResourceYaml` tests green (and no regressions in existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/composables/useYaml.js scripts/test.mjs
git commit -m "feat(yaml): dumpResourceYaml 纯函数——原始对象转干净 YAML（去 managedFields）"
```

---

### Task 3: PodDetail — eliminate YAML re-fetch (use cached `raw`)

**Files:**
- Modify: `src/views/PodDetail.vue` (import near top; `loadYaml` remote branch ~line 228-244)

**Interfaces:**
- Consumes: `dumpResourceYaml` from Task 2; `pod.value.raw` (already present — `mapPod` attaches it).
- Produces: PodDetail "export real YAML" no longer issues a network request; output unchanged (same server object, minus `managedFields`).

- [ ] **Step 1: Add the import**

In `src/views/PodDetail.vue`, add to the existing imports:
```js
import { dumpResourceYaml } from '@/composables/useYaml'
```

- [ ] **Step 2: Replace the re-fetch in `loadYaml`**

Find the remote-mode branch of `loadYaml` (the `try { const obj = await api.k8s(.../pods/...) ... }` block). Replace:
```js
    yamlLoading.value = true
    try {
      const obj = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(pod.value.namespace)}/pods/${encodeURIComponent(pod.value.name)}`)
      const clone = JSON.parse(JSON.stringify(obj))
      if (clone?.metadata) delete clone.metadata.managedFields   // t('podDetail.removeRedundantFields') for readability
      podYaml.value = yamlDump(clone)
    } catch (e) {
      podYaml.value = `# ${t('podDetail.loadFailed')}: ${e.message || ''}`
    } finally {
      yamlLoading.value = false
    }
```
with:
```js
    yamlLoading.value = true
    try {
      // pod.raw 已是完整 server 对象（mapPod 携带），无需再 api.k8s 拉取第二遍
      podYaml.value = dumpResourceYaml(pod.value?.raw)
    } catch (e) {
      podYaml.value = `# ${t('podDetail.loadFailed')}: ${e.message || ''}`
    } finally {
      yamlLoading.value = false
    }
```
Leave the mock-mode early-`return` branch (the one building a trimmed `spec`) unchanged.

- [ ] **Step 3: Remove now-unused import if applicable**

If `yamlDump` (`import { dump as yamlDump } from 'js-yaml'`) is no longer referenced anywhere in `PodDetail.vue` after the change, remove that import line. (It is still used elsewhere in the file, leave it — verify with a grep first.)

- [ ] **Step 4: Verify (typecheck + build + mock render)**

Run: `npm run typecheck && npm run build`
Expected: both pass.
Then verify mock behavior: with `remoteMode=false`, opening PodDetail → YAML tab still renders the mock-generated YAML (the mock early-`return` branch is untouched). With `remoteMode=true` (mock the store so `pod.raw` is a sample object), YAML renders from `dumpResourceYaml(pod.raw)` with no `api.k8s` call.

- [ ] **Step 5: Commit**

```bash
git add src/views/PodDetail.vue
git commit -m "perf(pod): 详情页 YAML 改读 pod.raw,去掉 api.k8s 二次拉取"
```

---

### Task 4: NsServiceDetail — eliminate YAML re-fetch (use `generateYAML`)

**Files:**
- Modify: `src/views/NsServiceDetail.vue` (`loadYaml` remote branch ~line 224-236)

**Interfaces:**
- Consumes: `store.generateYAML('service', svc.value)` (exists — used by `addService`/`updateService`, cluster.js:567/582; lossless per edit architecture).
- Produces: NsServiceDetail YAML tab no longer issues a network request; aligns with the `generateYAML` pattern used by `NsConfigMapDetail`/`NsSecretDetail`. Behavior change: YAML is the canonical apply-manifest (consistent with sibling pages) instead of a server-raw dump.

- [ ] **Step 1: Replace the re-fetch in `loadYaml`**

Find the remote-mode branch of `loadYaml` (the `try { const obj = await api.k8s(.../services/...) ... }` block). Replace:
```js
  yamlLoading.value = true
  try {
    const obj = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(svc.value.namespace)}/services/${encodeURIComponent(svc.value.name)}`)
    const clone = JSON.parse(JSON.stringify(obj))
    if (clone?.metadata) delete clone.metadata.managedFields
    if (clone?.status) delete clone.status
    svcYaml.value = yamlDump(clone)
  } catch (e) {
    svcYaml.value = `# ${t('ns.svcDetail.loadFailed')}: ${e.message || ''}`
  } finally {
    yamlLoading.value = false
  }
```
with:
```js
  yamlLoading.value = true
  try {
    // 与 ConfigMap/Secret 详情页同链路：从已缓存对象生成 YAML，单源不重取
    svcYaml.value = store.generateYAML('service', svc.value)
  } catch (e) {
    svcYaml.value = `# ${t('ns.svcDetail.loadFailed')}: ${e.message || ''}`
  } finally {
    yamlLoading.value = false
  }
```
Leave the mock-mode early branch (`if (!store.remoteMode) { svcYaml.value = store.generateYAML('service', svc.value); return }`) unchanged — note it already uses `generateYAML`, so remote now matches mock.

- [ ] **Step 2: Remove now-unused import if applicable**

If `yamlDump` (`import { dump as yamlDump } from 'js-yaml'`) is no longer referenced anywhere in `NsServiceDetail.vue`, remove that import line. Grep first to confirm.

- [ ] **Step 3: Verify (typecheck + build + mock render)**

Run: `npm run typecheck && npm run build`
Expected: both pass.
Verify: open Service detail → YAML tab; mock and remote both render via `generateYAML('service', …)`; no `api.k8s` call for the service on tab open.

- [ ] **Step 4: Commit**

```bash
git add src/views/NsServiceDetail.vue
git commit -m "perf(service): 详情页 YAML 改用 generateYAML,去掉 api.k8s 二次拉取(对齐 ConfigMap/Secret)"
```

---

### Task 5: Final full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete gate**

Run:
```bash
npm test && npm run test:unit && npm run typecheck && npm run build
```
Expected: all green. `npm test` includes the new `dumpResourceYaml` cases; `npm run test:unit` (vitest) unaffected/regreen; `typecheck` (node --check) clean; `build` (covers `.vue`) succeeds.

- [ ] **Step 2: Confirm the request reduction**

Confirm (by code inspection / mock network panel) that PodDetail and NsServiceDetail no longer issue a second `api.k8s` call for their own resource when opening the YAML tab. The only remaining `api.k8s` calls on these pages are legitimate (pod log stream on PodDetail).

- [ ] **Step 3: No commit** (verification only; all changes already committed in Tasks 1–4). Note results in the plan/PR description.
