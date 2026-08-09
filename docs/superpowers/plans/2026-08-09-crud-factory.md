# CRUD 工厂化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 cluster.js 里 ~72 个重复的 add/update/delete CRUD 收敛成一张 `RESOURCE_SPECS` 表 + 一个 `makeCrud` 生成器,签名不变(视图零改动),并从结构上消灭 await-race。

**Architecture:** 在 cluster.js 的 store setup 内定义 `RESOURCE_SPECS`(每个资源一项配置)+ `makeCrud(plural, spec)`(闭包 over store 的 ref/remoteMode/remoteCreate·Update·Delete/invalidateResource/generateYAML),生成的 `{add,update,delete}` 解构进 store return,顶替手写函数。复杂资源(workload/namespace/ingress)用可选 hook 接回现有特殊逻辑。

**Tech Stack:** Vue 3 + Pinia(纯 JS)+ vitest/happy-dom。仓库零外部依赖政策(test 工具是已裁决例外,见 CLAUDE.md)。

## Global Constraints

- **工厂留 cluster.js 内**(状态耦合,绝不抽成独立纯模块 —— 本会话 `ref is not defined` 白屏教训)。
- **视图签名不变**:`store.addX/deleteX/updateX` 名字 + 参数顺序不变 → 不改任何 `.vue`。
- **`remoteCreate/Update/Delete`/`refetch`/`invalidateResource`/`generateYAML`/`generateExtraYAML` 原语不变**,工厂调用它们。
- **applyResourceYaml 契约不变**(generateYAML 无损 + mapper + updateXxx)。
- **每步验收门**:`npm run typecheck && npm run build && npm run test:unit && node scripts/check-await-race.mjs && node scripts/check-missing-value.mjs` 全绿才提交。任一步红 → 停,不进下一任务。
- **实现于隔离 worktree** `feat/crud-factory`(从最新 main 拉),避免并行覆盖。

## File Structure

- **Modify** `src/stores/cluster.js`:新增 `RESOURCE_SPECS` 表 + `makeCrud` 生成器;逐批把手写 `addX/updateX/deleteX` 换成工厂产物;最后删死代码。
- **Create** `src/stores/__tests__/cluster.crud-factory.test.js`:数据驱动的 CRUD 冒烟测试(mock 模式跑每个工厂资源的 add/update/delete + 断言 invalidateResource 触发)。
- 不新增其它文件;不改正文任何 `.vue`。

---

## Task 1: makeCrud 生成器 + 冒烟测试基建 + pilot(configmaps)

**Files:**
- Modify: `src/stores/cluster.js`(加 `makeCrud` + `RESOURCE_SPECS`,configmaps 改工厂生成,删手写 `addConfigMap/updateConfigMap/deleteConfigMap`)
- Create: `src/stores/__tests__/cluster.crud-factory.test.js`

**Interfaces:**
- Consumes: `remoteCreate/remoteUpdate/remoteDelete/refetch/invalidateResource/generateYAML`(cluster.js 现有)+ `configMapList`/`mapConfigMap`(现有)
- Produces: `makeCrud(plural, spec)` 生成器、`RESOURCE_SPECS` 表;`store.addConfigMap/updateConfigMap/deleteConfigMap` 仍同名同签名(后续 task 依赖此模式)

- [ ] **Step 1: 写 characterization 冒烟测试(configmaps,mock 模式)**

```js
// src/stores/__tests__/cluster.crud-factory.test.js
import { test, expect, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useClusterStore } from '@/stores/cluster'

// mock mode(remoteMode=false)下 add/update/delete 只动 store ref + 触发 invalidateResource(内部)。
// 这是 characterization test:先在手写代码上锁住行为,工厂化后必须仍绿。
let _ls, _ss
beforeEach(() => {
  _ls = globalThis.localStorage; _ss = globalThis.sessionStorage
  const mem = new Map()
  const shim = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k), clear: () => mem.clear(), key: i => [...mem.keys()][i] ?? null, get length() { return mem.size } }
  globalThis.localStorage = shim; globalThis.sessionStorage = shim
  setActivePinia(createPinia())
})
afterEach(() => { globalThis.localStorage = _ls; globalThis.sessionStorage = _ss })

test('configmaps CRUD(mock):add 入 ref / update 合并 / delete 移除', () => {
  const store = useClusterStore()
  const has = name => store.configMapList.value.some(c => c.name === name)
  expect(has('cm-test')).toBe(false)
  store.addConfigMap({ name: 'cm-test', namespace: 'default', data: { a: '1' } })
  expect(has('cm-test')).toBe(true)
  store.updateConfigMap('cm-test', 'default', { data: { a: '1', b: '2' } })
  expect(store.configMapList.value.find(c => c.name === 'cm-test').data).toEqual({ a: '1', b: '2' })
  store.deleteConfigMap('cm-test', 'default')
  expect(has('cm-test')).toBe(false)
})
```
> 后续 task 把同样三段(add/update/delete 断言)按各资源 list 名扩展成多个 test(或数据驱动表)。invalidateResource 的「在变更后触发」由 await-race 守门确定性覆盖,此处不重复 spy。

- [ ] **Step 2: 跑通 characterization(锁住当前手写 configmap 行为)**

Run: `npx vitest run src/stores/__tests__/cluster.crud-factory.test.js`
Expected: PASS(此时还是手写 addConfigMap/updateConfigMap/deleteConfigMap)。这步把 configmap 现有行为锁进测试,工厂化后必须仍绿。若 FAIL,先修测试断言对齐真实行为(如 update 合并语义),勿改源码。

- [ ] **Step 3: 实现 makeCrud + RESOURCE_SPECS(configmaps)**

在 cluster.js 的 store setup 内(所有 ref/原语已在 scope),`invalidateResource` 定义之后、现有 CRUD 之前插入:

```js
// === CRUD 工厂(状态耦合,留 store 内;集中 await + invalidateResource,结构性消灭 await-race)===
// spec 字段:kind/group/resource(URL plural)/namespaced/ref/mapper/genType/genExtra? + 可选 hook
// (beforeSave/customYaml/refreshMapper/dynamicPlural/patch:'merge'/sideEffects/skipRemoteUpdate/extra)
function makeCrud(plural, spec) {
  const { kind, group, resource, namespaced, ref, mapper, genType = resource, genExtra = false,
          beforeSave, customYaml, refreshMapper, dynamicPlural, patch, sideEffects, skipRemoteUpdate } = spec
  const genFn = genExtra ? generateExtraYAML : generateYAML
  const yamlOf = item => customYaml ? customYaml(item) : genFn(genType, beforeSave ? beforeSave(item) : item)
  const listApi = `${group}/${resource}`
  const itemApi = (name, ns) => namespaced
    ? `${group}/namespaces/${encodeURIComponent(ns)}/${resource}/${encodeURIComponent(name)}`
    : `${group}/${resource}/${encodeURIComponent(name)}`
  const idxOf = namespaced
    ? (name, ns) => ref.value.findIndex(x => x.name === name && x.namespace === ns)
    : (name) => ref.value.findIndex(x => x.name === name)
  const refresh = () => refetch(listApi, ref, refreshMapper || mapper)

  async function add(item) {
    if (remoteMode.value) await remoteCreate(yamlOf(item), `${kind}/${item.name}`, refresh)
    else ref.value.push({ ...(beforeSave ? beforeSave(item) : item), age: 'Just now' })
    if (sideEffects?.onAdd) sideEffects.onAdd(item)
    invalidateResource(plural)
  }
  async function update(name, ns, updates) {
    const idx = idxOf(name, ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(ref.value[idx]))
    ref.value[idx] = { ...before, ...updates }
    if (remoteMode.value && !skipRemoteUpdate) {
      const y = patch === 'merge' ? (updates.__mergePatch || yamlOf(ref.value[idx])) : yamlOf(ref.value[idx])
      await remoteUpdate(y, kind, () => { ref.value[idx] = before })
    }
    invalidateResource(plural)
  }
  async function remove(name, ns) {
    if (remoteMode.value) await remoteDelete(itemApi(name, ns), ref, namespaced ? (x => x.name === name && x.namespace === ns) : (x => x.name === name))
    else { const idx = idxOf(name, ns); if (idx !== -1) ref.value.splice(idx, 1) }
    if (sideEffects?.onDelete) sideEffects.onDelete(name, ns)
    invalidateResource(plural)
  }
  return { add, update, delete: remove }
}

const RESOURCE_SPECS = {
  configmaps: { kind: 'ConfigMap', group: '/api/v1', resource: 'configmaps', namespaced: true, ref: configMapList, mapper: mapConfigMap, genType: 'configmap' },
}
// 生成并顶替手写(解构到与原函数同名)
const _crud = {}
;(_crud.configmaps = makeCrud('configmaps', RESOURCE_SPECS.configmaps))
const addConfigMap = _crud.configmaps.add
const updateConfigMap = _crud.configmaps.update
const deleteConfigMap = _crud.configmaps.delete
```
然后**删掉**手写的 `async function addConfigMap`/`updateConfigMap`/`deleteConfigMap`(cluster.js:470-493)。return 里的 `addConfigMap, updateConfigMap, deleteConfigMap` 不动(现在指向工厂产物,同名)。

- [ ] **Step 4: 跑 characterization + 全套验收门**

Run: `npx vitest run src/stores/__tests__/cluster.crud-factory.test.js` → Expected: PASS(行为同手写)。
Run 验收门:`npm run typecheck && npm run build && npm run test:unit && node scripts/check-await-race.mjs && node scripts/check-missing-value.mjs` → 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/stores/cluster.js src/stores/__tests__/cluster.crud-factory.test.js
git commit -m "refactor(crud): makeCrud 工厂 + 冒烟测试 + pilot configmaps"
```

---

## Task 2: secrets + pvcs(secrets 引入 beforeSave hook)

**Files:**
- Modify: `src/stores/cluster.js`(RESOURCE_SPECS 加 secrets/pvcs;删手写 addSecret/updateSecret/deleteSecret + addPVC/updatePVC/deletePVC)
- Modify: `src/stores/__tests__/cluster.crud-factory.test.js`(CASES 加 2 行)

**Interfaces:**
- Consumes: Task 1 的 `makeCrud`/`RESOURCE_SPECS`/`_crud` 模式;`secretList`/`pvcList`/`mapSecret`/`mapPVC`/`encodeSecretData`(现有)
- Produces: `store.addSecret/updateSecret/deleteSecret` + `store.addPVC/updatePVC/deletePVC` 工厂版(同名同签名)

- [ ] **Step 1: 冒烟测试加 secrets + pvcs 行**

```js
const CASES = [
  { plural: 'configmaps', add: { name: 'cm1', namespace: 'default', data: { a: '1' } }, upd: { data: { b: '2' } } },
  { plural: 'secrets',    add: { name: 'sec1', namespace: 'default', data: { k: 'v' } }, upd: { data: { k: 'v2' } } },
  { plural: 'pvcs',       add: { name: 'pvc1', namespace: 'default', capacity: '1Gi' }, upd: { capacity: '2Gi' } },
]
```
把每个 CASE 的 add/update/delete 断言对接到 `store.secretList`/`store.pvcList`(同 configmaps 模式)。

- [ ] **Step 2: RESOURCE_SPECS 加两项 + 生成**

```js
secrets: { kind: 'Secret', group: '/api/v1', resource: 'secrets', namespaced: true, ref: secretList, mapper: mapSecret, genType: 'secret', beforeSave: s => ({ ...s, data: encodeSecretData(s.data) }) },
pvcs:    { kind: 'PVC',    group: '/api/v1', resource: 'persistentvolumeclaims', namespaced: true, ref: pvcList, mapper: mapPVC, genType: 'pvc' },
```
生成顶替(同 Task 1 模式):
```js
_crud.secrets = makeCrud('secrets', RESOURCE_SPECS.secrets); const { add: addSecret, update: updateSecret, delete: deleteSecret } = _crud.secrets
_crud.pvcs = makeCrud('pvcs', RESOURCE_SPECS.pvcs); const { add: addPVC, update: updatePVC, delete: deletePVC } = _crud.pvcs
```
删手写 `addSecret/updateSecret/deleteSecret`(496-526)+ `addPVC/updatePVC/deletePVC`(529-556)。

- [ ] **Step 3: 跑验收门**

`npm run typecheck && npm run build && npm run test:unit && node scripts/check-await-race.mjs && node scripts/check-missing-value.mjs` → 全绿。

- [ ] **Step 4: Commit**

```bash
git commit -am "refactor(crud): secrets(+beforeSave) + pvcs 进工厂"
```

---

## Task 3: 命名空间级规整资源批量(services/networkpolicies/hpas/resourcequotas/limitranges/serviceaccounts/rolebindings/pdbs)

**Files:**
- Modify: `src/stores/cluster.js`(RESOURCE_SPECS 加 8 项;删对应 8 组手写 CRUD)
- Modify: 冒烟测试 CASES 加 8 行

**Interfaces:**
- Consumes: Task 1 `makeCrud`;各 `xxxList`/`mapXxx`(现有);`generateExtraYAML`(pdb 用)
- Produces: 8 组工厂版 store.addX/updateX/deleteX(同名)

- [ ] **Step 1: 冒烟测试加 8 行**(每资源一样本 item,对接各自 store list)

- [ ] **Step 2: RESOURCE_SPECS 加 8 项 + 生成**

```js
services:        { kind:'Service',       group:'/api/v1',                          resource:'services',                  namespaced:true, ref:serviceList,       mapper:mapService,       genType:'service' },
networkpolicies: { kind:'NetworkPolicy', group:'/apis/networking.k8s.io/v1',       resource:'networkpolicies',           namespaced:true, ref:networkPolicyList, mapper:mapNetworkPolicy, genType:'networkpolicy' },
hpas:            { kind:'HPA',           group:'/apis/autoscaling/v2',             resource:'horizontalpodautoscalers',  namespaced:true, ref:hpaList,           mapper:mapHPA,           genType:'hpa' },
resourcequotas:  { kind:'ResourceQuota', group:'/api/v1',                          resource:'resourcequotas',            namespaced:true, ref:resourceQuotaList, mapper:mapResourceQuota, genType:'resourcequota' },
limitranges:     { kind:'LimitRange',    group:'/api/v1',                          resource:'limitranges',               namespaced:true, ref:limitRangeList,    mapper:mapLimitRange,    genType:'limitrange' },
serviceaccounts: { kind:'ServiceAccount',group:'/api/v1',                          resource:'serviceaccounts',           namespaced:true, ref:saList,            mapper:mapServiceAccount,genType:'serviceaccount' },
rolebindings:    { kind:'RoleBinding',   group:'/apis/rbac.authorization.k8s.io/v1',resource:'rolebindings',            namespaced:true, ref:roleBindingList,   mapper:mapRoleBinding,   genType:'rolebinding' },
poddisruptionbudgets:{ kind:'PDB',       group:'/apis/policy/v1',                  resource:'poddisruptionbudgets',      namespaced:true, ref:pdbList,           mapper:mapPDB,           genType:'pdb', genExtra:true },
```
逐个生成顶替(同 Task 1/2 模式),删手写:services(393-425 的 add/update/delete service)、networkpolicies(1135-1158)、hpas(1161-1193)、resourcequotas(1195-1219)、limitranges(1221-1245)、serviceaccounts(1274-1294)、rolebindings(1296-1332)、pdbs(1358-1383)。

- [ ] **Step 3: 跑验收门** → 全绿。

- [ ] **Step 4: Commit** `refactor(crud): 8 个命名空间级规整资源进工厂`

---

## Task 4: 集群级规整资源批量(pvs/storageclasses/ingressclasses/runtimeclasses/priorityclasses/clusterrolebindings)+ roles 核实

**Files:**
- Modify: `src/stores/cluster.js`(RESOURCE_SPECS 加 6 项集群级;核实 roles/clusterroles 是否规整,是则加)
- Modify: 冒烟测试 CASES 加相应行

**Interfaces:**
- Consumes: Task 1 `makeCrud`;各 list/mapper;`generateExtraYAML`(priorityclass 用)
- Produces: 集群级工厂版 CRUD(namespaced:false)

- [ ] **Step 1: 核实 roles/clusterroles**

Run: `grep -nE "function (add|update|delete)(Cluster)?Role\b|generateYAML\('(cluster)?role'" src/stores/cluster.js`
判断 addRole/updateRole/deleteRole 是否规整(走 generateYAML('role'/'clusterrole') + 标准 remoteXxx)。若规整 → 加进本批;若特殊(如 roles 合并 clusterroles 双端点)→ 留 Task 7 复杂资源处理。把结论写进 commit message。

- [ ] **Step 2: 冒烟测试加行**(集群级:ns 不参与 match/itemApi)

- [ ] **Step 3: RESOURCE_SPECS 加集群级项 + 生成**

```js
pvs:               { kind:'PersistentVolume', group:'/api/v1',                          resource:'persistentvolumes',  namespaced:false, ref:pvList,            mapper:mapPV,            genType:'pv' },
storageclasses:    { kind:'StorageClass',     group:'/apis/storage.k8s.io/v1',          resource:'storageclasses',     namespaced:false, ref:scList,            mapper:mapStorageClass,  genType:'storageclass' },
ingressclasses:    { kind:'IngressClass',     group:'/apis/networking.k8s.io/v1',       resource:'ingressclasses',     namespaced:false, ref:ingressClassList,  mapper:mapIngressClass,  genType:'ingressclass' },
runtimeclasses:    { kind:'RuntimeClass',     group:'/apis/node.k8s.io/v1',             resource:'runtimeclasses',     namespaced:false, ref:runtimeClassList,  mapper:mapRuntimeClass,  genType:'runtimeclass' },
priorityclasses:   { kind:'PriorityClass',    group:'/apis/scheduling.k8s.io/v1',       resource:'priorityclasses',    namespaced:false, ref:priorityClassList, mapper:mapPriorityClass, genType:'priorityclass', genExtra:true },
clusterrolebindings:{kind:'ClusterRoleBinding',group:'/apis/rbac.authorization.k8s.io/v1',resource:'clusterrolebindings',namespaced:false, ref:clusterRoleBindingList, mapper:mapRoleBinding, genType:'clusterrolebinding' },
```
逐个生成顶替,删手写:pvs(558-589)、storageclasses(591-629)、ingressclasses(640-657)、runtimeclasses(659-675)、priorityclasses(1385-1398)、clusterrolebindings(1334-1356)。

- [ ] **Step 4: 跑验收门** → 全绿。

- [ ] **Step 5: Commit** `refactor(crud): 6 个集群级规整资源进工厂(+roles 核实结论)`

---

## Task 5: workload(复杂 —— dynamicPlural + merge-patch + sideEffects;rollback/scale/restart 保持手写)

**Files:**
- Modify: `src/stores/cluster.js`(RESOURCE_SPECS.workloads 用 hook;`addWorkload`/`deleteWorkload`/`updateWorkload` 工厂版;`rollbackWorkload/scaleWorkload/rollingRestart/updateWorkloadMeta` **保持手写不动**)

**Interfaces:**
- Consumes: `makeCrud` 的 hook:`dynamicPlural`、`patch:'merge'`、`sideEffects`、`extra`
- Produces: `store.addWorkload/deleteWorkload/updateWorkload`(工厂版,merge-patch);特殊 op 不变

- [ ] **Step 1: 冒烟测试加 workloads 行**(注意 update 走 merge-patch:给 `updates.__mergePatch` 一个 patch 对象;add 后断言 namespace.pods 副作用)

- [ ] **Step 2: RESOURCE_SPECS.workloads + hook 实现**

workload 的 updateWorkload 现状是定点 merge-patch(保留 labels/tier,加 managed-by tag),且 addWorkload 增 namespace.pods、deleteWorkload 减。把这些**现有逻辑**包成 hook:

```js
const WORKLOAD_PLURAL = wl => ({ Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[wl.type])
// merge-patch 构造(从现有 updateWorkload 696-815 抽出,保留 tier→label + managed-by tag 逻辑)
function buildWorkloadMergePatch(name, ns, updates, before) {
  const patch = {}
  if (updates.labels || updates.tier != null) {
    const labels = { ...(updates.labels || before.labels || {}) }
    if (updates.tier != null) labels['layer.aliangboard.io'] = updates.tier
    patch.metadata = { labels }
  }
  // ……(把现有 updateWorkload 里 patch 构造的其余字段搬来,逐字保留)
  return patch
}
function bumpNsPods(wl) { const ns = namespaceList.value.find(n => n.name === wl.namespace); if (ns) ns.pods += parseInt(wl.replicas?.split('/')[1] || '1') }
function decNsPods(name, ns) { const n = namespaceList.value.find(x => x.name === ns); if (n) n.pods = Math.max(0, n.pods - 1) }

RESOURCE_SPECS.workloads = {
  kind: 'Workload', group: '/apis/apps/v1', resource: null, /* dynamic */
  namespaced: true, ref: workloadList, mapper: null, genType: null,
  dynamicPlural: WORKLOAD_PLURAL,
  patch: 'merge',
  // itemApi 用 dynamicPlural
  sideEffects: { onAdd: bumpNsPods, onDelete: decNsPods },
}
```
makeCrud 需支持 `dynamicPlural`:`itemApi`/`listApi` 用 `dynamicPlural(item)` 而非 `resource`。在 Task 1 的 makeCrud 里补:
```js
const resOf = item => dynamicPlural ? dynamicPlural(item) : resource
const itemApi = (name, ns, item) => namespaced
  ? `${group}/namespaces/${encodeURIComponent(ns)}/${resOf(item)}/${encodeURIComponent(name)}`
  : `${group}/${resOf(item)}/${encodeURIComponent(name)}`
```
update 的 merge-patch:已在 Task 1 makeCrud 留了 `updates.__mergePatch` 钩子;workload 的 update 调用方传 `{ __mergePatch: buildWorkloadMergePatch(...) }` —— **但视图层不改**,所以需在 makeCrud.update 里对 `patch==='merge'` 自动构造(把 before+updates 喂给一个 spec.mergePatch 函数)。改 spec 字段为 `mergePatch(name, ns, updates, before)`:

```js
// makeCrud.update 内:
if (remoteMode.value && !skipRemoteUpdate) {
  const y = patch === 'merge' && spec.mergePatch ? spec.mergePatch(name, ns, updates, before) : yamlOf(ref.value[idx])
  await remoteUpdate(y, kind, () => { ref.value[idx] = before })
}
```
workloads spec 加 `mergePatch: buildWorkloadMergePatch`。删手写 addWorkload(677-681)/deleteWorkload(683-695)/updateWorkload(697-815,但保留 rollback/scale/restart/updateWorkloadMeta 这些**不删**)。

- [ ] **Step 3: 跑验收门 + 重点手测**

全套绿后,**手测**(连真机或 mock):Deployment 编辑 tier/image、删除 workloads(看 namespace pod 数变化)、rollback/scale(这些走手写,必须仍工作)。

- [ ] **Step 4: Commit** `refactor(crud): workload 进工厂(dynamicPlural+merge-patch+sideEffects;特殊 op 保持手写)`

---

## Task 6: namespace(复杂 —— customYaml + refreshMapper + skipRemoteUpdate)

**Files:**
- Modify: `src/stores/cluster.js`(RESOURCE_SPECS.namespaces 用 hook;addNamespace/deleteNamespace 工厂版;updateNamespace 留 mock-only)

**Interfaces:**
- Consumes: `makeCrud` hook:`customYaml`、`refreshMapper`、`skipRemoteUpdate:true`
- Produces: `store.addNamespace/deleteNamespace`(工厂版);`updateNamespace` 保持 mock-only(可工厂 + skipRemoteUpdate)

- [ ] **Step 1: 冒烟测试加 namespaces 行**(add 后断言派生 pods/services 字段在 remote mock 下 OK;mock 下 add 断言不重复 push)

- [ ] **Step 2: RESOURCE_SPECS.namespaces + hook**

把现有 addNamespace(1469-1489)的 YAML 构造 + refresh mapper 抽成 hook:
```js
function buildNamespaceYaml(ns) {
  const labelsYaml = ns.labels && Object.keys(ns.labels).length
    ? '\n  labels:\n' + Object.entries(ns.labels).map(([k, v]) => `    ${k}: ${yamlScalar(v)}`).join('\n') : ''
  return `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns.name}${labelsYaml}`
}
function mapNamespaceRefresh(item) {
  return { name: item.metadata?.name, status: item.status?.phase || 'Unknown',
    pods: podList.value.filter(p => p.namespace === item.metadata?.name).length,
    services: serviceList.value.filter(s => s.namespace === item.metadata?.name).length,
    age: ageOf(item.metadata?.creationTimestamp), labels: item.metadata?.labels || {} }
}
RESOURCE_SPECS.namespaces = { kind:'Namespace', group:'/api/v1', resource:'namespaces', namespaced:false, ref:namespaceList, mapper:null, genType:null, customYaml: buildNamespaceYaml, refreshMapper: mapNamespaceRefresh, skipRemoteUpdate: true }
```
(makeCrud:customYaml 时绕过 generateYAML;refreshMapper 时 refetch 用它;skipRemoteUpdate 时 update 仅 mock。)makeCrud 已支持这三 hook(Task 1 留了口)。

删手写 addNamespace(1469-1489)/deleteNamespace(1491-1498)/updateNamespace(1500-1503)。注意 addNamespace 的 mock 分支「`if (!find) push`」去重 —— 在 makeCrud.add 对 customYaml 资源加去重,或 spec 加 `dedup:true` 标志(Task 1 makeCrud 加:`if (spec.dedup && ref.value.some(...)) return` 于 mock 分支前)。给 namespaces 加 `dedup:true`。

- [ ] **Step 3: 跑验收门 + 手测 namespace 创建/删除/Sync** → 全绿。

- [ ] **Step 4: Commit** `refactor(crud): namespace 进工厂(customYaml+refreshMapper+skipRemoteUpdate+dedup)`

---

## Task 7: ingress(extra updateRules)+ pod + crd-instance + 收尾 roles

**Files:**
- Modify: `src/stores/cluster.js`

**Interfaces:**
- Consumes: `makeCrud` 的 `extra` 字段(CRUD 之外特殊 op);现有 updateIngressRules/deletePod/deleteCRInstance

- [ ] **Step 1: ingress** —— RESOURCE_SPECS.ingresses 规整进工厂(`group:'/apis/networking.k8s.io/v1', resource:'ingresses', genType:'ingress'`,删 addIngress/deleteIngress;updateIngress 规整部分进工厂),**updateIngressRules 保持手写**(特殊 patch,buildIngressRulesPatch)。冒烟加 ingress 行。

- [ ] **Step 2: pod** —— addPod/deletePod:pod 无标准创建表单(addPod 仅 mock 种子用),deletePod mock 分支规整、remote 走 `/api/v1/namespaces/${ns}/pods/${name}`。判断:addPod 留手写(mock 种子专用),deletePod **可**工厂但需 refreshPods 语义 —— 评估后若复杂则留手写,在本 task commit message 记结论。

- [ ] **Step 3: crd-instance** —— deleteCRInstance 走 `crInstancePath(crd)` 动态路径 + refreshCRDInstances,特殊,**保持手写**(不进工厂)。commit message 记。

- [ ] **Step 4: roles** —— 按 Task 4 Step 1 结论处理:若规整则进工厂,否则记理由留手写。

- [ ] **Step 5: 跑验收门** → 全绿。

- [ ] **Step 6: Commit** `refactor(crud): ingress(+extra updateRules)+ pod/crd/roles 结论`

---

## Task 8: 清理死代码 + 行数核对

**Files:**
- Modify: `src/stores/cluster.js`

- [ ] **Step 1: 找剩余手写 CRUD**

Run: `grep -nE "^\s*(async )?function (add|update|delete)[A-Z]" src/stores/cluster.js`
逐个核对:剩余的应是「保持手写」的特殊 op(rollbackWorkload/scaleWorkload/rollingRestart/updateWorkloadMeta/updateIngressRules/deletePod/addPod/deleteCRInstance + Task 7 结论项)。确认无遗漏的规整 CRUD。

- [ ] **Step 2: 清 `_crud` 中间变量(可选美化)**

若 `_crud` 仅用于解构,可内联 `const { add, update, delete: del } = makeCrud(...)` 直接命名。保持可读即可。

- [ ] **Step 3: 行数核对**

Run: `wc -l src/stores/cluster.js` → 目标 ~2600(从 ~2778 降)。记录实际值。

- [ ] **Step 4: 跑全套验收门(最终)**

`npm run typecheck && npm run build && npm run test:unit && node scripts/check-await-race.mjs && node scripts/check-missing-value.mjs` → 全绿。

- [ ] **Step 5: Commit** `refactor(crud): 清死代码 + 行数核对(2778→<actual>)`

---

## Task 9: 合并到最新 main

**Files:** worktree 合并操作

- [ ] **Step 1: re-merge latest main(本会话经验:main 会前进)**

```bash
git fetch origin
git merge origin/main   # 解决冲突(若有,优先保留工厂产物 + 对方新功能)
npm run typecheck && npm run build && npm run test:unit && node scripts/check-await-race.mjs && node scripts/check-missing-value.mjs
```

- [ ] **Step 2: 合并到 main + push**

```bash
git checkout main
git merge --no-ff feat/crud-factory -m "merge: CRUD 工厂化(RESOURCE_SPECS + makeCrud,消灭 await-race)"
git push origin main
```

- [ ] **Step 3: 删 worktree 分支(可选)**

```bash
git branch -d feat/crud-factory
```

---

## Self-Review(plan 自检)

- **Spec 覆盖**:spec §3(全覆盖)→ Task 1-7 覆盖全部资源;§5(schema)→ Task 1 定义;§6(契约)→ Task 1 makeCrud;§7(await-race 消灭)→ 工厂集中 + await-race 守门验证;§9(测试)→ Task 1 冒烟测试 + 全程验收门;§10(迁移批 0-5)→ Task 1-9 对应。✓
- **占位符扫描**:Task 5 的 buildWorkloadMergePatch 标注「把现有逻辑搬来」—— 这是必要的(完整代码在 cluster.js:696-815,搬字保留,不是新发明);Task 7 pod/crd/roles 有「评估后记结论」—— 这是有意的分支判断(资源特殊性),非占位,但实现者需在 commit 写清结论。无 TBD/TODO。
- **类型一致**:`makeCrud` 签名、hook 名(beforeSave/customYaml/refreshMapper/dynamicPlural/mergePatch/sideEffects/skipRemoteUpdate/dedup)在 Task 1 定义、Task 2/5/6 复用,名称一致。`_crud` 中间变量全 task 一致。

## 出参核对

cluster.js 2778 → ~2600;CRUD 冒烟测试覆盖全部工厂资源;await-race 守门对工厂资源恒绿;视图零改动;main 无新 bug。
