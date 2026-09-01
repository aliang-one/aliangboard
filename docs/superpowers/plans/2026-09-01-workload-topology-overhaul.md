# Workload 拓扑 Tab 整体修复与增强 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 workload 拓扑 Tab 审计发现的 18 项缺陷(A 正确性 5 / B 状态 2 / C 表达力 7 / D 小项 4),并把拓扑域从 NsWorkloadDetail(2547 行)拆出为独立组合式 + 展示组件。

**Architecture:** 三层拆分——纯函数层 `src/logic/topology.js`(零依赖可测)→ 组合式 `src/composables/useWorkloadTopology.js`(7 查询统一 pollInterval 门控 + computed + 动作 + 弹窗状态)→ 展示组件 `src/components/common/WorkloadTopologyTab.vue`(props 进、动作直调 store)。页面留接线。Spec: `docs/superpowers/specs/2026-09-01-workload-topology-overhaul-design.md`。

**Tech Stack:** Vue 3 + Pinia + @tanstack/vue-query(已有);测试 = node:test 零依赖(`*.test.mjs`) + vitest/happy-dom(组件);i18n vue-i18n zh/en 双份。

## Global Constraints

- 工作目录:`/home/liang/MyProgram/AiProject/aliangboard/.claude/worktrees/feat+topology-overhaul`(分支 `worktree-feat+topology-overhaul`);**所有 Edit 用 worktree 绝对路径**。
- **零新增外部依赖**(CLAUDE.md 依赖政策)。
- 提交作者恒 `aliangone <aliangone@gmail.com>`;**禁止 Co-Authored-By 尾注**。
- 纯函数(`logic/topology.js`、`podTemplateLabels`)**禁止 import Vue/Pinia**。
- i18n 新键 zh/en 双份同步,过 `npm run i18n:check`(消息值里字面 `@` 须写 `{'@'}`)。
- 每任务收尾跑:该任务测试 + `npm run typecheck`;关键任务(Task 4/5)加跑 `npm run test:unit`。
- 守卫红线(改模板时不得破坏,selector-guard 测试锚点):拓扑 Tab 两个悬浮 "+" 按钮保留 `-left-3` class;`修复 selector` 按钮文案不变;Tab 切换按钮文本 `topology` 不变。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/logic/topology.js` | 新建 | 拓扑纯函数:filterOwnIngressRules / classifyServiceDrift / groupPodsByReplicaSet / podsByPrefixFallback / endpointsForService / latestOwnedRs / isRetiredRs / volumesAndPullSecretsFromPodSpec |
| `src/logic/workloadMeta.js` | 修改 | +`podTemplateLabels(raw)`(A2 单源) |
| `src/logic/topology.test.mjs` | 新建 | node:test 零依赖用例(逻辑全函数 + podTemplateLabels) |
| `package.json` | 修改 | test:server 链追加 `node --test src/logic/topology.test.mjs` |
| `src/composables/useResourceMappers.js` | 修改 | +`mapReplicaSet` |
| `src/composables/useFetchers.js` | 修改 | +`fetchReplicaSets(ns)` |
| `src/stores/cluster.js` | 修改 | 挂载 `fetchReplicaSets` |
| `src/composables/useWorkloadTopology.js` | 新建 | 拓扑域组合式 |
| `src/components/common/WorkloadTopologyTab.vue` | 新建 | 拓扑 Tab 展示组件 |
| `src/views/NsWorkloadDetail.vue` | 修改 | 拓扑域迁出 + A2/A4 修复 + configRefs 扩面 + 接线 |
| `src/views/__tests__/NsWorkloadDetail.selector-guard.test.js` | 修改 | store mock 补 3 个 fetcher |
| `src/views/__tests__/NsWorkloadDetail.topology.test.js` | 新建 | 拓扑 Tab 组件级断言(vitest) |
| `src/locales/zh.json` / `en.json` | 修改 | 新增 `workload.topology.*` 等键 |

---

### Task 1: 纯函数层 logic/topology.js + workloadMeta.podTemplateLabels(TDD)

**Files:**
- Test: `src/logic/topology.test.mjs`(新建)
- Create: `src/logic/topology.js`
- Modify: `src/logic/workloadMeta.js`(文件末尾追加)
- Modify: `package.json`(test:server 链)

**Interfaces:**
- Consumes: 无(纯函数,零依赖)
- Produces(Task 3/4/5/6/7 依赖,签名精确如下):
  - `podTemplateLabels(raw) -> object`(workloadMeta.js;CronJob→jobTemplate 模板 labels,其余→spec.template labels,缺 shape→`{}`)
  - `filterOwnIngressRules(relatedIngresses, relatedServiceNames:Set) -> { ownRules:[{ingress,host,path,serviceName,port}], others:[{name,count}] }`
  - `classifyServiceDrift(svc, tplLabels, actualPods, endpoints) -> 'broken'|'pending-break'|null`(endpoints 形状 = `endpointsForService` 返回值或 null)
  - `groupPodsByReplicaSet(pods, replicaSets) -> { groups:[{rsName,ready,desired,pods}], ungrouped:[pod] }`
  - `podsByPrefixFallback(pods, wlName, allWorkloads) -> [pod]`
  - `endpointsForService(endpoints, svcName) -> { ready, notReady, total }|null`(endpoints 元素形状 = 既有 `mapEndpoints`:`{name,namespace,addresses[],notReadyAddresses[]}`)
  - `latestOwnedRs(replicaSets) -> rs|null`;`isRetiredRs(rs, latest) -> bool`
  - `volumesAndPullSecretsFromPodSpec(podSpec) -> [{kind:'PVC'|'imagePullSecrets', name}]`

- [ ] **Step 1: 写失败测试 `src/logic/topology.test.mjs`**

```js
// src/logic/topology.test.mjs —— 拓扑纯函数零依赖用例(node --test,进 package.json test:server 链)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterOwnIngressRules, classifyServiceDrift, groupPodsByReplicaSet, podsByPrefixFallback,
  endpointsForService, latestOwnedRs, isRetiredRs, volumesAndPullSecretsFromPodSpec,
} from './topology.js'
import { podTemplateLabels } from './workloadMeta.js'

// --- podTemplateLabels(A2:CronJob 标签面单源)---
test('podTemplateLabels: Deployment/Job 读 spec.template,CronJob 读 jobTemplate.spec.template', () => {
  assert.deepEqual(podTemplateLabels({ spec: { template: { metadata: { labels: { app: 'a' } } } } }), { app: 'a' })
  assert.deepEqual(podTemplateLabels({ spec: { jobTemplate: { spec: { template: { metadata: { labels: { app: 'cron' } } } } } } }), { app: 'cron' })
  // CronJob 不得回退读 spec.template(不存在)或自身 metadata.labels
  assert.deepEqual(podTemplateLabels({ metadata: { labels: { app: 'self' } }, spec: { jobTemplate: { spec: { template: { metadata: { labels: { app: 'cron' } } } } } } }), { app: 'cron' })
})
test('podTemplateLabels: 缺 shape 一律空 map,不炸', () => {
  assert.deepEqual(podTemplateLabels(undefined), {})
  assert.deepEqual(podTemplateLabels({}), {})
  assert.deepEqual(podTemplateLabels({ spec: {} }), {})
})

// --- filterOwnIngressRules(A1:共享 Ingress 不再张冠李戴)---
const Svc = n => new Set([n])
test('filterOwnIngressRules: 只保留指向本负载 Service 的路径,他人路径合并计数', () => {
  const ings = [{
    name: 'shared', rules: [{ host: 'a.com', http: { paths: [
      { path: '/api', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 8080 } } } },
      { path: '/', pathType: 'Prefix', backend: { service: { name: 'other', port: { number: 80 } } } },
    ] } }],
  }]
  const r = filterOwnIngressRules(ings, Svc('web'))
  assert.deepEqual(r.ownRules, [{ ingress: 'shared', host: 'a.com', path: '/api', serviceName: 'web', port: 8080 }])
  assert.deepEqual(r.others, [{ name: 'shared', count: 1 }])
})
test('filterOwnIngressRules: defaultBackend 命中折算 host:* 一条;命名端口透传', () => {
  const ings = [{ name: 'ing', defaultBackend: { serviceName: 'web', servicePort: '8080' }, rules: [] }]
  assert.deepEqual(filterOwnIngressRules(ings, Svc('web')).ownRules, [
    { ingress: 'ing', host: '*', path: '/', serviceName: 'web', port: '8080' },
  ])
  const named = [{ name: 'ing2', rules: [{ host: 'b.com', http: { paths: [{ path: '/x', backend: { service: { name: 'web', port: { name: 'http' } } } }] } }] }]
  assert.equal(filterOwnIngressRules(named, Svc('web')).ownRules[0].port, 'http')
})
test('filterOwnIngressRules: 全不命中 → ownRules 空 + others 计数完整', () => {
  const ings = [
    { name: 'a', rules: [{ host: 'h', http: { paths: [{ path: '/1', backend: { service: { name: 'x', port: {} } } }, { path: '/2', backend: { service: { name: 'y' } } }] } }] },
    { name: 'b', rules: [{ host: 'h', http: { paths: [{ path: '/3', backend: { service: { name: 'x' } } } }] } }],
  ]
  const r = filterOwnIngressRules(ings, Svc('web'))
  assert.deepEqual(r.ownRules, [])
  assert.deepEqual(r.others, [{ name: 'a', count: 2 }, { name: 'b', count: 1 }])
})
test('filterOwnIngressRules: 空/缺段安全', () => {
  assert.deepEqual(filterOwnIngressRules(undefined, Svc('web')), { ownRules: [], others: [] })
  assert.deepEqual(filterOwnIngressRules([{ name: 'e', rules: [] }], Svc('web')), { ownRules: [], others: [] })
})

// --- classifyServiceDrift(C7:两档)---
test('classifyServiceDrift: selector 空或匹配模板 → null', () => {
  assert.equal(classifyServiceDrift({ selector: {} }, {}, [], null), null)
  assert.equal(classifyServiceDrift({ selector: { app: 'a' } }, { app: 'a' }, [], null), null)
})
test('classifyServiceDrift: 实际 Pod 也不匹配 → broken', () => {
  assert.equal(classifyServiceDrift({ selector: { app: 'a', team: 'blue' } }, { app: 'a', team: 'red' }, [{ labels: { app: 'a', team: 'red' } }], null), 'broken')
  assert.equal(classifyServiceDrift({ selector: { app: 'a' } }, { app: 'b' }, [], null), 'broken')
})
test('classifyServiceDrift: 现有 Pod 仍匹配 → 看 Endpoints:ready=0 broken,有 ready 或数据缺失 pending-break', () => {
  const pods = [{ labels: { app: 'a', team: 'blue' } }]
  assert.equal(classifyServiceDrift({ selector: { app: 'a', team: 'blue' } }, { app: 'a', team: 'red' }, pods, { ready: 2, total: 2 }), 'pending-break')
  assert.equal(classifyServiceDrift({ selector: { app: 'a', team: 'blue' } }, { app: 'a', team: 'red' }, pods, { ready: 0, total: 2 }), 'broken')
  assert.equal(classifyServiceDrift({ selector: { app: 'a', team: 'blue' } }, { app: 'a', team: 'red' }, pods, null), 'pending-break')
})
test('classifyServiceDrift: 值按字符串比较(标签本就是字符串)', () => {
  const pods = [{ labels: { app: '1' } }]
  assert.equal(classifyServiceDrift({ selector: { app: 1 } }, { app: 'x' }, pods, null), 'pending-break')
})

// --- groupPodsByReplicaSet(C1)---
const rs = (name, ready, desired, ts) => ({ name, ready, desired, raw: { metadata: { name, creationTimestamp: ts } } })
const pod = (name, rsName) => ({ name, raw: { metadata: { name, ownerReferences: rsName ? [{ kind: 'ReplicaSet', name: rsName, controller: true }] : [] } } })
test('groupPodsByReplicaSet: 按 controller owner 分组;无 owner → ungrouped', () => {
  const r = groupPodsByReplicaSet([pod('a-1', 'rs-new'), pod('a-2', 'rs-new'), pod('b-1', 'rs-old'), pod('x', null)], [rs('rs-new', 2, 2), rs('rs-old', 0, 0)])
  assert.deepEqual(r.groups.map(g => ({ n: g.rsName, ready: g.ready, desired: g.desired, len: g.pods.length })), [
    { n: 'rs-new', ready: 2, desired: 2, len: 2 }, { n: 'rs-old', ready: 0, desired: 0, len: 1 },
  ])
  assert.deepEqual(r.ungrouped.map(p => p.name), ['x'])
})
test('groupPodsByReplicaSet: 空/缺段安全', () => {
  assert.deepEqual(groupPodsByReplicaSet([], []), { groups: [], ungrouped: [] })
  assert.deepEqual(groupPodsByReplicaSet(undefined, undefined), { groups: [], ungrouped: [] })
})

// --- podsByPrefixFallback(A4:连字符边界 + 最长前缀让渡)---
test('podsByPrefixFallback: 连字符边界,web 不吞 webcache-xxx', () => {
  const pods = [{ name: 'web-abc' }, { name: 'webcache-1' }, { name: 'web' }]
  assert.deepEqual(podsByPrefixFallback(pods, 'web', [{ name: 'web' }, { name: 'webcache' }]).map(p => p.name), ['web-abc'])
})
test('podsByPrefixFallback: 最长前缀让渡,web-canary 的 Pod 让给 web-canary', () => {
  const pods = [{ name: 'web-abc' }, { name: 'web-canary-7' }]
  const wls = [{ name: 'web' }, { name: 'web-canary' }]
  assert.deepEqual(podsByPrefixFallback(pods, 'web', wls).map(p => p.name), ['web-abc'])
  assert.deepEqual(podsByPrefixFallback(pods, 'web-canary', wls).map(p => p.name), ['web-canary-7'])
})

// --- endpointsForService(C4)---
test('endpointsForService: ready/notReady 计数;未命中 null', () => {
  const eps = [
    { name: 'web', addresses: ['10.0.0.1', '10.0.0.2'], notReadyAddresses: ['10.0.0.3'] },
    { name: 'other', addresses: ['1.1.1.1'], notReadyAddresses: [] },
  ]
  assert.deepEqual(endpointsForService(eps, 'web'), { ready: 2, notReady: 1, total: 3 })
  assert.equal(endpointsForService(eps, 'nope'), null)
  assert.equal(endpointsForService(undefined, 'web'), null)
})

// --- latestOwnedRs / isRetiredRs(C1)---
test('latestOwnedRs: creationTimestamp 最新者;空 → null', () => {
  const list = [rs('old', 0, 0, '2026-01-01T00:00:00Z'), rs('new', 3, 3, '2026-02-01T00:00:00Z')]
  assert.equal(latestOwnedRs(list).name, 'new')
  assert.equal(latestOwnedRs([]), null)
  assert.equal(latestOwnedRs(undefined), null)
})
test('isRetiredRs: 非最新且 desired=0 ready=0 → true;最新永 false', () => {
  const latest = rs('new', 3, 3, '2026-02-01T00:00:00Z')
  assert.equal(isRetiredRs(rs('old', 0, 0), latest), true)
  assert.equal(isRetiredRs(rs('scaling-down', 0, 1), latest), false)
  assert.equal(isRetiredRs(latest, latest), false)
})

// --- volumesAndPullSecretsFromPodSpec(C2)---
test('volumesAndPullSecretsFromPodSpec: PVC + imagePullSecrets 提取去重', () => {
  const spec = {
    volumes: [
      { name: 'data', persistentVolumeClaim: { claimName: 'my-pvc' } },
      { name: 'cm', configMap: { name: 'cfg' } },
      { name: 'data2', persistentVolumeClaim: { claimName: 'my-pvc' } },
    ],
    imagePullSecrets: [{ name: 'regcred' }, { name: 'regcred' }],
  }
  assert.deepEqual(volumesAndPullSecretsFromPodSpec(spec), [
    { kind: 'PVC', name: 'my-pvc' }, { kind: 'imagePullSecrets', name: 'regcred' },
  ])
  assert.deepEqual(volumesAndPullSecretsFromPodSpec(undefined), [])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/logic/topology.test.mjs`
Expected: FAIL(`Cannot find module './topology.js'` 或 `podTemplateLabels` 未导出)

- [ ] **Step 3: 实现 `src/logic/workloadMeta.js` 追加 + 新建 `src/logic/topology.js`**

`src/logic/workloadMeta.js` 文件末尾追加:

```js
// Pod 模板 labels 单一事实源(A2,2026-09-01 拓扑整修):CronJob 的 Pod 模板在
// spec.jobTemplate.spec.template 下——此前调用方直读 spec.template 缺失后静默回退
// 到 CronJob 自身 metadata.labels,导致 relatedServices/driftedServices/identitySelector
// 全部建在错误标签面上。其余类型读 spec.template。缺 shape 一律空 map 不炸。
export function podTemplateLabels(raw) {
  const spec = raw?.spec
  const tpl = spec?.jobTemplate?.spec?.template?.metadata?.labels
    ?? spec?.template?.metadata?.labels
  return tpl && typeof tpl === 'object' && !Array.isArray(tpl) ? tpl : {}
}
```

新建 `src/logic/topology.js`:

```js
// 拓扑域纯函数(2026-09-01 拓扑整修;零 Vue/Pinia 依赖,单测 topology.test.mjs node --test)。
// 判定语义与 spec docs/superpowers/specs/2026-09-01-workload-topology-overhaul-design.md §2 一致。

// backend 名/端口提取(兼容 networking.k8s.io/v1 backend.service 与旧 beta backend.serviceName)
const backendNameOf = p => p?.backend?.service?.name ?? p?.backend?.serviceName ?? ''
const backendPortOf = p => p?.backend?.service?.port?.number ?? p?.backend?.service?.port?.name ?? p?.backend?.servicePort ?? ''

// A1:相关 Ingress → 本负载路由。只保留指向本负载 Service 的路径(defaultBackend 命中折算
// host:'*' 一条);指向其他应用的路径合并为 others [{name,count}]——入口不丢,但不冒充本负载流量。
export function filterOwnIngressRules(relatedIngresses, relatedServiceNames) {
  const ownRules = []
  const otherCounts = new Map()
  for (const ing of relatedIngresses || []) {
    const db = ing?.defaultBackend
    if (db?.serviceName && relatedServiceNames.has(db.serviceName)) {
      ownRules.push({ ingress: ing.name, host: '*', path: '/', serviceName: db.serviceName, port: db.servicePort || '' })
    }
    for (const r of (ing?.rules || [])) {
      for (const p of (r.http?.paths || [])) {
        const name = backendNameOf(p)
        if (relatedServiceNames.has(name)) {
          ownRules.push({ ingress: ing.name, host: r.host || '*', path: p.path || '/', serviceName: name, port: backendPortOf(p) })
        } else {
          otherCounts.set(ing?.name, (otherCounts.get(ing?.name) || 0) + 1)
        }
      }
    }
  }
  return { ownRules, others: [...otherCounts].map(([name, count]) => ({ name, count })) }
}

// C7:Service drift 两档。'broken'=已断(实际无匹配 Pod,或 Endpoints 就绪数为 0);
// 'pending-break'=滚动后将断(现有 Pod 仍匹配;endpoints 数据缺失(null)按保守档处理);
// null=selector 空或匹配模板(不失配)。值按字符串比较(标签本就是字符串)。
export function classifyServiceDrift(svc, tplLabels, actualPods, endpoints) {
  const sel = svc?.selector
  if (!sel || typeof sel !== 'object' || !Object.keys(sel).length) return null
  const subsetOf = labels => Object.entries(sel).every(([k, v]) => {
    const l = labels || {}
    return k in l && String(l[k]) === String(v)
  })
  if (subsetOf(tplLabels)) return null
  const matched = (actualPods || []).some(p => subsetOf(p?.labels))
  if (!matched) return 'broken'
  if (endpoints && endpoints.ready === 0) return 'broken'
  return 'pending-break'
}

// C1:Pod 按所属 RS 分组(pod.raw.metadata.ownerReferences 取 controller=true 的 ReplicaSet);
// 无 owner/RS 不在列 → ungrouped。组序随 replicaSets 入参序。
export function groupPodsByReplicaSet(pods, replicaSets) {
  const byName = new Map((replicaSets || []).map(rs2 => [rs2.name, rs2]))
  const groups = []
  const index = new Map()
  const ungrouped = []
  for (const p of pods || []) {
    const owner = (p?.raw?.metadata?.ownerReferences || []).find(o => o.kind === 'ReplicaSet' && o.controller)
    const rs2 = owner ? byName.get(owner.name) : null
    if (!rs2) { ungrouped.push(p); continue }
    if (!index.has(rs2.name)) {
      index.set(rs2.name, groups.length)
      groups.push({ rsName: rs2.name, ready: rs2.ready || 0, desired: rs2.desired ?? 0, pods: [] })
    }
    groups[index.get(rs2.name)].pods.push(p)
  }
  return { groups, ungrouped }
}

// A4:无 selector/无标签负载的 Pod 兜底归属。①边界收紧为 `${wlName}-`(杜绝 webcache 吞进
// web);②最长前缀让渡(存在更长负载名前缀时让给它,如 web → web-canary)。
export function podsByPrefixFallback(pods, wlName, allWorkloads) {
  if (!wlName) return []
  const prefix = `${wlName}-`
  const longer = (allWorkloads || [])
    .map(w => w?.name)
    .filter(n => n && n !== wlName && n.length > wlName.length && n.startsWith(prefix))
  return (pods || []).filter(p => p?.name?.startsWith(prefix) && !longer.some(n => p.name.startsWith(`${n}-`)))
}

// C4:Service 端点就绪计数(mapEndpoints 形状 {addresses[],notReadyAddresses[]})。未命中 → null。
export function endpointsForService(endpoints, svcName) {
  const ep = (endpoints || []).find(e => e?.name === svcName)
  if (!ep) return null
  const ready = (ep.addresses || []).length
  const notReady = (ep.notReadyAddresses || []).length
  return { ready, notReady, total: ready + notReady }
}

// C1:当前版本 RS = creationTimestamp 最新;其余 desired=0 且 ready=0 → 已淘汰(展示置灰)。
export function latestOwnedRs(replicaSets) {
  const list = replicaSets || []
  if (!list.length) return null
  return list.reduce((a, b) => (String(b?.raw?.metadata?.creationTimestamp || '') > String(a?.raw?.metadata?.creationTimestamp || '') ? b : a))
}
export function isRetiredRs(rs2, latest) {
  if (!latest || rs2?.name === latest.name) return false
  return (rs2?.desired ?? 0) === 0 && (rs2?.ready || 0) === 0
}

// C2:PVC 卷与 imagePullSecrets 提取(形状对齐 configRefs 的 {kind,name},供合并去重)。
export function volumesAndPullSecretsFromPodSpec(podSpec) {
  const out = []
  const seen = new Set()
  const add = (kind, name) => {
    if (!name) return
    const key = `${kind}/${name}`
    if (!seen.has(key)) { seen.add(key); out.push({ kind, name }) }
  }
  for (const vol of (podSpec?.volumes || [])) {
    if (vol?.persistentVolumeClaim?.claimName) add('PVC', vol.persistentVolumeClaim.claimName)
  }
  for (const s of (podSpec?.imagePullSecrets || [])) add('imagePullSecrets', s?.name)
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/logic/topology.test.mjs`
Expected: PASS(全部用例)

- [ ] **Step 5: 接线 package.json(test:server 链)**

`package.json` 的 `test:server` 值末尾(`...&& node --test scripts/overflow-guard.test.mjs` 之后)追加 `&& node --test src/logic/topology.test.mjs`。

- [ ] **Step 6: 回归 + 提交**

Run: `npm run test:server 2>&1 | tail -5 && npm run typecheck`
Expected: 全绿

```bash
git add src/logic/topology.js src/logic/topology.test.mjs src/logic/workloadMeta.js package.json
git commit --author="aliangone <aliangone@gmail.com>" -m "feat(topology): 拓扑纯函数层+Pod 模板标签单源(A1/C1/C2/C4/C7/A2/A4 判定核心,TDD)"
```

---

### Task 2: 数据面 mapReplicaSet + fetchReplicaSets(ns)+ store 挂载

**Files:**
- Modify: `src/composables/useResourceMappers.js`(`mapWorkload` 之后,约 :119)
- Modify: `src/composables/useFetchers.js`(`fetchWorkloads` 之后,约 :70)
- Modify: `src/stores/cluster.js`(:15 import 列表 + :599 return 列表)

**Interfaces:**
- Consumes: 无
- Produces: `store.fetchReplicaSets(ns) -> Promise<[{name,namespace,desired,ready,hash,age,raw}]>`(Task 3 组合式消费)。复用既有 `store.fetchEndpoints()`(cluster 级,mapEndpoints 已存在,查询 key `['cluster', cid, 'endpoints']` 与 NsServiceDetail/NsEndpoints 同源共享缓存)与 `store.fetchHPAs()`。

- [ ] **Step 1: `useResourceMappers.js` 的 `mapWorkload` 函数(:97-119)后追加**

```js
// ReplicaSet(拓扑 RS 层,2026-09-01):ownerReferences 判定与「新/旧」排序走 raw。
export const mapReplicaSet = item => ({
  name: item.metadata?.name,
  namespace: item.metadata?.namespace,
  desired: item.spec?.replicas ?? 0,
  ready: item.status?.readyReplicas || 0,
  hash: item.metadata?.labels?.['pod-template-hash'] || '',
  age: ageOf(item.metadata?.creationTimestamp),
  raw: item,
})
```

- [ ] **Step 2: `useFetchers.js` 的 `fetchWorkloads`(:55-70)后追加,并把 `mapReplicaSet` 加进顶部 `useResourceMappers` import 列表(:8-11)**

```js
// ns 级 ReplicaSet(拓扑 RS 层):watch 不覆盖 RS,新鲜度靠查询 pollInterval 兜底(B2 单轨)。
export async function fetchReplicaSets(ns) {
  const d = await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/replicasets?limit=500`)
  return (d?.items || []).map(mapReplicaSet)
}
```

- [ ] **Step 3: `stores/cluster.js` 挂载**

:15 的 import 大列表里 `fetchWorkloadRevisions` 后追加 `, fetchReplicaSets`;:599 的 return 列表 `fetchHPAs, fetchEndpoints,` 后追加 `fetchReplicaSets,`。

- [ ] **Step 4: 验证 + 提交**

Run: `npm run typecheck && npm run test:server 2>&1 | tail -3`
Expected: 全绿(纯新增,无行为变化)

```bash
git add src/composables/useResourceMappers.js src/composables/useFetchers.js src/stores/cluster.js
git commit --author="aliangone <aliangone@gmail.com>" -m "feat(topology): ns 级 ReplicaSet fetcher+mapper+store 挂载(endpoints/hpas 复用既有数据面)"
```

---

### Task 3: 组合式 useWorkloadTopology.js

**Files:**
- Create: `src/composables/useWorkloadTopology.js`

**Interfaces:**
- Consumes: Task 1 全部纯函数;`store.fetchServices/fetchIngresses/fetchPDBs/fetchNetworkPolicies/fetchEndpoints/fetchHPAs/fetchReplicaSets`(签名 = 既有);`useResourceList({key,fetcher,select,options})`(options 支持 `refetchInterval: Ref` 与 `enabled: () => bool`,参照页面 `revisionsQuery` :305 用法)。
- Produces(Task 4/5 消费,返回键名精确如下):
  `{ tplLabels, relatedServices, relatedServiceNames, relatedIngresses, ingressBreakdown, driftedServices, epFor, workloadHpas, labelConsumers, replicaSets, latestRs, podsGrouped, governingSvcName, containerPorts, identitySel, states, showExposeModal, exposeForm, openExpose, saveExpose, showIngressMapModal, ingressMapForm, sameHost, mapConflict, mapSvcOptions, mapPortsFor, openIngressMap, saveIngressMap, repairingSvc, repairServiceSelector }`
  - `driftedServices` 元素 = `{...svc, drift:'broken'|'pending-break'}`
  - `ingressBreakdown` = Task 1 `filterOwnIngressRules` 返回值
  - `epFor(name)` = `{ready,notReady,total}|null`
  - `labelConsumers` = `[{kind:'PDB'|'NetworkPolicy', name, disruptive?:bool}]`
  - `states` = `{servicesPending, ingressesPending, endpointsPending, rsPending, hpasPending}`(bool)
  - `podsGrouped` = Task 1 `groupPodsByReplicaSet` 返回值;`replicaSets` = 本负载 owned RS 列表;`latestRs` = rs|null
- 行为不变式:`relatedServices`/`relatedIngresses`/`openExpose`/`openIngressMap`/`saveExpose`/`saveIngressMap`/`repairServiceSelector`/`sameHost`/`mapSvcOptions`/`mapPortsFor`/`mapConflict` 语义与原 NsWorkloadDetail :749-902 完全一致,仅三处已裁决的变化:①`podLabels`→`tplLabels`(A2);②`openExpose` 端口缺省不再猜 `80→8080`,改空行 + `saveExpose` 校验(D1);③`saveIngressMap` 起手校验 `servicePort` 非空、删 `|| 80` 兜底(A5)。

- [ ] **Step 1: 新建 `src/composables/useWorkloadTopology.js`**

```js
// 拓扑域组合式(2026-09-01 拓扑整修):services/ingresses/pdbs/netpols 四查询自 NsWorkloadDetail
// 迁入,新增 replicasets/endpoints/hpas 三查询;七条统一 pollInterval 门控(B2:watch 降级时与
// workloads/pods 同 30s 兜底,新鲜度单轨)。workloads/pods 查询留在页面(多 Tab 共用),
// pollInterval/managedPods 经参数只读注入。判定纯函数在 logic/topology 与 logic/workloadMeta。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { notify } from '@/composables/useToast'
import { sameHostIngresses, appendPathToIngress } from '@/composables/useIngressRules'
import { identitySelector, servicesBrokenBy, podTemplateLabels } from '@/logic/workloadMeta'
import { filterOwnIngressRules, classifyServiceDrift, endpointsForService, groupPodsByReplicaSet, latestOwnedRs } from '@/logic/topology'

export function useWorkloadTopology({ workload, namespace, pollInterval, managedPods }) {
  const { t } = useI18n()
  const store = useClusterStore()
  const cid = computed(() => (store.currentCluster || 'cluster'))
  const ns = () => namespace
  const POLL = { refetchInterval: pollInterval }

  const servicesQuery = useResourceList({ key: ['cluster', cid, 'services'], fetcher: () => store.fetchServices(), select: list => list.filter(s => s.namespace === ns()), options: POLL })
  const ingressesQuery = useResourceList({ key: ['cluster', cid, 'ingresses'], fetcher: () => store.fetchIngresses(), select: list => list.filter(i => i.namespace === ns()), options: POLL })
  const pdbsQuery = useResourceList({ key: ['cluster', cid, 'poddisruptionbudgets'], fetcher: () => store.fetchPDBs(), select: list => list.filter(p => p.namespace === ns()), options: POLL })
  const netpolsQuery = useResourceList({ key: ['cluster', cid, 'networkpolicies'], fetcher: () => store.fetchNetworkPolicies(), select: list => list.filter(n => n.namespace === ns()), options: POLL })
  const endpointsQuery = useResourceList({ key: ['cluster', cid, 'endpoints'], fetcher: () => store.fetchEndpoints(), select: list => list.filter(e => e.namespace === ns()), options: POLL })
  const hpasQuery = useResourceList({ key: ['cluster', cid, 'hpas'], fetcher: () => store.fetchHPAs(), select: list => list.filter(h => h.namespace === ns()), options: POLL })
  const rsQuery = useResourceList({
    key: ['cluster', cid, 'replicasets', namespace],
    fetcher: () => store.fetchReplicaSets(ns()),
    select: list => list.filter(r => r.namespace === ns()),
    options: { ...POLL, enabled: () => workload.value?.type === 'Deployment' },
  })

  const serviceList = computed(() => servicesQuery.data.value || [])
  const ingressList = computed(() => ingressesQuery.data.value || [])
  const pdbList = computed(() => pdbsQuery.data.value || [])
  const netpolList = computed(() => netpolsQuery.data.value || [])

  // A2:Pod 模板标签单源(CronJob 走 jobTemplate)
  const tplLabels = computed(() => podTemplateLabels(workload.value?.raw))

  // 关联 Service:selector ⊆ 模板 labels
  const relatedServices = computed(() => serviceList.value.filter(s => s.selector && Object.keys(s.selector).length && Object.entries(s.selector).every(([k, v]) => tplLabels.value[k] === v)))
  const relatedServiceNames = computed(() => new Set(relatedServices.value.map(s => s.name)))
  const relatedIngresses = computed(() => ingressList.value.filter(ing => (ing.rules || []).some(r => (r.http?.paths || []).some(p => { const be = p.backend?.service || p.backend; return relatedServiceNames.value.has(be?.name) }))))
  // A1:本负载路由(共享 Ingress 不再张冠李戴)
  const ingressBreakdown = computed(() => filterOwnIngressRules(relatedIngresses.value, relatedServiceNames.value))

  // 失配 Service(两档):归属判据保持「selector 值含本负载名」启发式(防线④精度语义不变),
  // 档位由 classifyServiceDrift 依模板 labels + 实际 Pod + Endpoints 判定(C7)
  const driftedServices = computed(() => {
    const name = workload.value?.name
    if (!name) return []
    const broken = new Set(servicesBrokenBy(tplLabels.value, serviceList.value))
    const eps = endpointsQuery.data.value || []
    return serviceList.value
      .filter(s => broken.has(s.name) && Object.values(s.selector || {}).map(String).includes(name))
      .map(s => ({ ...s, drift: classifyServiceDrift(s, tplLabels.value, managedPods.value || [], endpointsForService(eps, s.name)) }))
      .filter(s => s.drift)
  })
  const epFor = name => endpointsForService(endpointsQuery.data.value || [], name)

  // C2 附挂:HPA(scaleTargetRef 命中本负载)+ 标签消费者(selector ⊆ 模板 labels 精度语义)
  const workloadHpas = computed(() => (hpasQuery.data.value || []).filter(h => h.targetName === workload.value?.name && (h.targetKind || 'Deployment') === workload.value?.type))
  const labelConsumers = computed(() => {
    const subset = sel => Object.entries(sel || {}).every(([k, v]) => k in tplLabels.value && String(tplLabels.value[k]) === String(v))
    return [
      ...pdbList.value.filter(p => subset(p.selector)).map(p => ({ kind: 'PDB', name: p.name, disruptive: p.raw?.status?.disruptionsAllowed === 0 })),
      ...netpolList.value.filter(n => subset(n.podSelector)).map(n => ({ kind: 'NetworkPolicy', name: n.name })),
    ]
  })

  // C1:本负载 owned RS(最新/淘汰)+ Pod 分组
  const replicaSets = computed(() => (rsQuery.data.value || []).filter(rs2 => (rs2.raw?.metadata?.ownerReferences || []).some(o => o.kind === 'Deployment' && o.controller && o.name === workload.value?.name)))
  const latestRs = computed(() => latestOwnedRs(replicaSets.value))
  const podsGrouped = computed(() => groupPodsByReplicaSet(managedPods.value || [], replicaSets.value))

  // C5:STS governing service
  const governingSvcName = computed(() => (workload.value?.type === 'StatefulSet' ? workload.value?.raw?.spec?.serviceName : '') || '')

  // 网络暴露(自 NsWorkloadDetail :750-754 原样迁入)
  const containerPorts = computed(() => {
    const out = []
    const wl = workload.value
    const podSpec = wl?.type === 'CronJob' ? wl?.raw?.spec?.jobTemplate?.spec?.template?.spec : wl?.raw?.spec?.template?.spec
    for (const c of (podSpec?.containers || [])) for (const p of (c.ports || [])) out.push({ container: c.name, port: p.containerPort, name: p.name, protocol: p.protocol || 'TCP' })
    return out
  })
  const identitySel = computed(() => identitySelector(workload.value?.raw, tplLabels.value, workload.value?.name))

  // === 弹窗状态与动作(自 NsWorkloadDetail :814-902 迁入;差异处见注释)===
  const showExposeModal = ref(false)
  const exposeForm = ref({ name: '', type: 'ClusterIP', ports: [] })
  function openExpose() {
    const base = workload.value?.name || 'app'
    const existing = new Set(relatedServices.value.map(s => s.name))
    let name = `${base}-svc`, n = 2
    while (existing.has(name)) name = `${base}-svc-${n++}`
    // D1:不再猜 80→8080;无声明端口时空一行由用户填
    exposeForm.value = { name, type: 'ClusterIP', ports: containerPorts.value.length ? containerPorts.value.map(p => ({ port: p.port, targetPort: p.port, protocol: p.protocol })) : [{ port: '', targetPort: '', protocol: 'TCP' }] }
    showExposeModal.value = true
  }
  async function saveExpose() {
    try {
      const sel = identitySel.value
      if (!Object.keys(sel).length) { notify('error', t('workload.expose.identityRequired')); return }
      // D1:至少一个有效端口,不静默丢弃
      const ports = exposeForm.value.ports.filter(p => p.port)
      if (!ports.length) { notify('error', t('workload.expose.portRequired')); return }
      const r = await store.addService({ name: exposeForm.value.name, namespace: ns(), type: exposeForm.value.type, clusterIP: '', ports: ports.map(p => `${p.port}:${p.targetPort}/${p.protocol}`).join(','), selector: sel })
      if (r && r.ok === false) return
      notify('success', t('workload.notify.createdService', { name: exposeForm.value.name })); showExposeModal.value = false
    } catch (e) { notify('error', e.message || t('workload.notify.createServiceFailed')) }
  }
  const showIngressMapModal = ref(false)
  const ingressMapForm = ref({ name: '', host: '', path: '/', pathType: 'Prefix', serviceName: '', servicePort: '', target: '' })
  const sameHost = computed(() => sameHostIngresses(ingressList.value || [], ingressMapForm.value.host))
  const mapConflict = ref('')
  const mapSvcOptions = computed(() => {
    const related = new Set(relatedServices.value.map(s => s.name))
    const badge = t('workload.ingressMap.relatedBadge')
    return serviceList.value
      .map(s => ({ related: related.has(s.name), label: related.has(s.name) ? `${s.name}${badge}` : s.name, value: s.name }))
      .sort((a, b) => Number(b.related) - Number(a.related))
      .map(({ label, value }) => ({ label, value }))
  })
  const mapPortsFor = computed(() => {
    const svc = serviceList.value.find(s => s.name === ingressMapForm.value.serviceName)
    return (svc?.portList || []).map(p => p.port)
  })
  function openIngressMap() {
    const svc = relatedServices.value[0]
    const base = workload.value?.name || 'app'
    const existing = new Set(ingressList.value.map(i => i.name))
    let name = `${base}-ingress`, n = 2
    while (existing.has(name)) name = `${base}-ingress-${n++}`
    mapConflict.value = ''
    ingressMapForm.value = { name, host: '', path: '/', pathType: 'Prefix', serviceName: svc?.name || '', servicePort: (svc?.portList || [])[0]?.port || '', target: '' }
    showIngressMapModal.value = true
  }
  async function saveIngressMap() {
    const f = ingressMapForm.value
    if (!f.serviceName) { notify('error', t('workload.notify.selectService')); return }
    // A5:端口必填(无值必生成坏 backend;不再静默兜底 80)
    if (f.servicePort === '' || f.servicePort == null) { notify('error', t('workload.ingressMap.portRequired')); return }
    const rule = { host: (f.host || '').trim(), path: f.path || '/', pathType: f.pathType, serviceName: f.serviceName, servicePort: f.servicePort }
    const targetIng = f.target && f.target !== 'new' ? (ingressList.value || []).find(i => i.name === f.target) : null
    if (targetIng) {
      const { flatRules, conflict } = appendPathToIngress(targetIng, rule)
      if (conflict) { mapConflict.value = t('workload.ingressMap.conflict', { path: rule.path }); return }
      mapConflict.value = ''
      const db = targetIng.defaultBackend?.serviceName
        ? { enabled: true, serviceName: targetIng.defaultBackend.serviceName, servicePort: targetIng.defaultBackend.servicePort }
        : null
      try {
        await store.updateIngressRules(targetIng.name, ns(), flatRules, db)
      } catch (e) { notify('error', e.message || t('workload.notify.createIngressFailed')); return }
      notify('success', t('workload.notify.createdIngress', { host: rule.host || '*', path: rule.path, service: rule.serviceName, port: rule.servicePort }))
      showIngressMapModal.value = false
      return
    }
    // 新建模式:端口已校验非空,去掉旧 || 80 兜底(A5)
    const r = await store.addIngress({ name: f.name || `${workload.value?.name || 'app'}-ingress`, namespace: ns(), className: '', tls: false, tlsSecret: '', rules: [{ host: rule.host, http: { paths: [{ path: rule.path, pathType: rule.pathType, backend: { serviceName: rule.serviceName, servicePort: Number(rule.servicePort) } }] } }] })
    if (r && r.ok === false) return
    notify('success', t('workload.notify.createdIngress', { host: rule.host || '*', path: rule.path, service: rule.serviceName, port: rule.servicePort }))
    showIngressMapModal.value = false
  }
  const repairingSvc = ref('')
  async function repairServiceSelector(name) {
    const sel = identitySel.value
    if (!Object.keys(sel).length) return
    const svc = serviceList.value.find(s => s.name === name)
    if (!svc) return
    repairingSvc.value = name
    try {
      const r = await store.updateService(name, ns(), { selector: sel })
      if (!(r && r.ok === false)) notify('success', t('workload.topology.selectorRepaired', { name }))
    } catch (e) { notify('error', e.message || t('workload.notify.saveFailed')) }
    repairingSvc.value = ''
  }

  // B1:各查询 pending 态(展示层骨架 vs 空态分流用)
  const states = computed(() => ({
    servicesPending: !!servicesQuery.isPending.value,
    ingressesPending: !!ingressesQuery.isPending.value,
    endpointsPending: !!endpointsQuery.isPending.value,
    rsPending: !!rsQuery.isPending.value,
    hpasPending: !!hpasQuery.isPending.value,
  }))

  return {
    tplLabels, relatedServices, relatedServiceNames, relatedIngresses, ingressBreakdown,
    driftedServices, epFor, workloadHpas, labelConsumers,
    replicaSets, latestRs, podsGrouped, governingSvcName, containerPorts, identitySel, states,
    showExposeModal, exposeForm, openExpose, saveExpose,
    showIngressMapModal, ingressMapForm, sameHost, mapConflict, mapSvcOptions, mapPortsFor, openIngressMap, saveIngressMap,
    repairingSvc, repairServiceSelector,
  }
}
```

> 注意:原 `saveIngressMap` 新建模式尾部还有一段 `catch` 分支处理(addIngress 可能抛错)。实现时以原实现(:897-902)为准补齐同样的 try/catch 与错误 notify,不要丢分支。

- [ ] **Step 2: 验证 + 提交**

Run: `npm run typecheck && npm run test:unit 2>&1 | tail -3`
Expected: 全绿(组件未被改动,组合式暂无消费者)

```bash
git add src/composables/useWorkloadTopology.js
git commit --author="aliangone <aliangone@gmail.com>" -m "feat(topology): 拓扑域组合式——7 查询统一 pollInterval 门控(B2)+ 动作/弹窗状态收编(A5/D1)"
```

---

### Task 4: NsWorkloadDetail 接线(A2 podLabels 换源 + A4 managedPods 兜底 + 拓扑域迁出)

**Files:**
- Modify: `src/views/NsWorkloadDetail.vue`
- Modify: `src/views/__tests__/NsWorkloadDetail.selector-guard.test.js`(store mock 补 fetcher)

**Interfaces:**
- Consumes: Task 3 组合式返回包(全部键);Task 1 `podsByPrefixFallback` / `volumesAndPullSecretsFromPodSpec`;`podTemplateLabels`。
- Produces: 页面 setup 顶层解构 `const { relatedServices, relatedIngresses, containerPorts, openExpose, saveExpose, openIngressMap, saveIngressMap, showExposeModal, exposeForm, showIngressMapModal, ingressMapForm, sameHost, mapConflict, mapSvcOptions, mapPortsFor, tplLabels, configRefs 扩展后 } = ...`(模板继续自动解包,Network Tab/弹窗零改动)。本任务后拓扑 Tab 模板块暂由 `topo` 数据驱动(展示组件 Task 5 才迁)。

- [ ] **Step 1: 脚本区改写**

1. 删除 :55-86 的 services/ingresses/events/pdbs/netpols 五个查询块中前四个(services/ingresses/pdbs/netpols)与对应 `serviceList/ingressList/pdbList/netpolList` computed;**保留 eventsQuery/nsEvents**(Events 不在拓扑域,另路)。
2. `managedPods` computed(:117-132)之后插入:

```js
// 拓扑域:services/ingresses/pdbs/netpols/endpoints/hpas/replicasets 七查询 + 判定 + 动作(2026-09-01 整修)
const topo = useWorkloadTopology({ workload, namespace: route.params.namespace, pollInterval, managedPods })
const {
  relatedServices, relatedIngresses, containerPorts, ingressBreakdown, driftedServices,
  openExpose, saveExpose, openIngressMap, saveIngressMap, showExposeModal, exposeForm,
  showIngressMapModal, ingressMapForm, sameHost, mapConflict, mapSvcOptions, mapPortsFor,
  repairingSvc, repairServiceSelector, tplLabels, identitySel,
} = topo
```

(import 区加 `import { useWorkloadTopology } from '@/composables/useWorkloadTopology'` 与 `import { podsByPrefixFallback, volumesAndPullSecretsFromPodSpec } from '@/logic/topology'`。)

3. 删除原 :749-813 的 `containerPorts/podLabels/relatedServices/relatedServiceNames/relatedIngresses/topoIngressRules/driftedServices/labelConsumers/identitySel/repairingSvc/repairServiceSelector`(全部由组合式供给);删除原 :814-902 的弹窗状态与 `openExpose/saveExpose/openIngressMap/saveIngressMap/sameHost/mapSvcOptions/mapPortsFor/mapConflict`(同)。
4. **A4**:`managedPods` 兜底分支(:131 `return inNs.filter(p => p.name.startsWith(wl.name))`)改为:

```js
  // A4:前缀兜底收紧——连字符边界 + 最长前缀让渡(不再吞 webcache-*/web-canary-* 的 Pod)
  return podsByPrefixFallback(inNs, wl.name, workloadsQuery.data.value || [])
```

5. **A2 收尾**:全文件 grep `podLabels`——`configRefs`/`meta`/`saveMeta`/`saveTemplate` 等其余消费面一律改读 `tplLabels`(组合式已导出);grep `spec?.template?.metadata?.labels` 直读点一并换 `podTemplateLabels(workload.value?.raw)`(import 自 `@/logic/workloadMeta`)。**此步必须列出 grep 命中清单并逐条处理,不许有残留直读。**
6. **configRefs 扩面(C2)**:`configRefs` computed 的 `return refs` 前插入:

```js
  // C2:PVC 卷 + imagePullSecrets(既有缺口:refTypeMeta 声明了 IPS 却从未提取)
  for (const ref of volumesAndPullSecretsFromPodSpec(podSpec)) add(ref.kind, ref.name)
```

7. **refRoute 扩面**(:267-270):

```js
const REF_ROUTE_NAMES = { ConfigMap: 'NsConfigMapDetail', Secret: 'NsSecretDetail', PVC: 'NsPVCDetail', imagePullSecrets: 'NsSecretDetail' }
function refRoute(ref) {
  return { name: REF_ROUTE_NAMES[ref.kind] || 'NsSecretDetail', query: {} }
}
```

8. 拓扑 Tab 模板块(:1782-1898)暂改为由 topo 数据驱动:`topoIngressRules` → `ingressBreakdown.ownRules`,`driftedServices` → `driftedServices`(已带 drift 档,本任务先不分支文案,Task 6 处理)。

- [ ] **Step 2: selector-guard store mock 补 fetcher**

`src/views/__tests__/NsWorkloadDetail.selector-guard.test.js` 的 `vi.mock('@/stores/cluster')` 工厂内追加:

```js
  fetchReplicaSets: vi.fn(async () => []), fetchEndpoints: vi.fn(async () => []), fetchHPAs: vi.fn(async () => []),
```

- [ ] **Step 3: 验证(green 是硬门槛,selector-guard 是 A2/A4 的回归锁)**

Run: `npm run typecheck && npm run test:unit 2>&1 | tail -4`
Expected: 全绿。若 `saveMeta`/`saveTemplate`/`拓扑失配` 用例红,优先怀疑 A2 换源漏接(grep 清单重查)。

- [ ] **Step 4: 提交**

```bash
git add src/views/NsWorkloadDetail.vue src/views/__tests__/NsWorkloadDetail.selector-guard.test.js
git commit --author="aliangone <aliangone@gmail.com>" -m "refactor(topology): NsWorkloadDetail 接线拓扑组合式——CronJob 标签面根治(A2)+ 前缀兜底收紧(A4)+ configRefs 扩 PVC/IPS"
```

---

### Task 5: WorkloadTopologyTab.vue 迁移 + A1/A3/B1/C5/C6/D1-D4 展示层落地

**Files:**
- Create: `src/components/common/WorkloadTopologyTab.vue`
- Modify: `src/views/NsWorkloadDetail.vue`(拓扑模板块替换为组件标签)
- Modify: `src/locales/zh.json` / `en.json`

**Interfaces:**
- Consumes: 组合式返回包(Task 3)、`managedPods`/`configRefs`/`podsPending`(页面)、`podHealth`(usePod)。
- Produces: 组件 props `{ topo: Object, workload: Object, canMutate: Boolean, managedPods: Array, podsPending: Boolean, configRefs: Array }`;emit `goto(tab)`(Task 7 的 RS chip 用)。页面用法:`<WorkloadTopologyTab :topo="topo" :workload="workload" :can-mutate="canMutate" :managed-pods="managedPods" :pods-pending="podsPending" :config-refs="configRefs" @goto="t => (activeTab = t)" />`,页面加 `const podsPending = computed(() => !!podsQuery.isPending.value)`。

- [ ] **Step 1: 新建组件(模板自 NsWorkloadDetail :1782-1898 迁移,应用下列变更)**

`<script setup>`:

```vue
<script setup>
// Workload 拓扑 Tab(2026-09-01 整修):Ingress → Service → Workload → Pods 四列流水线展示层。
// 数据与动作全部来自 useWorkloadTopology 组合式(topo prop);本组件无查询、无 store 直调以外的副作用。
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { podHealth, imgBase, imgTag } from '@/composables/usePod'

const { t } = useI18n()
const router = useRouter()
const props = defineProps({
  topo: { type: Object, required: true },
  workload: { type: Object, required: true },
  canMutate: { type: Boolean, default: true },
  managedPods: { type: Array, default: () => [] },
  podsPending: { type: Boolean, default: false },
  configRefs: { type: Array, default: () => [] },
})
defineEmits(['goto'])

const WL = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']
const REF_ROUTES = { ConfigMap: 'NsConfigMapDetail', Secret: 'NsSecretDetail', PVC: 'NsPVCDetail', imagePullSecrets: 'NsSecretDetail' }
function go(node) {
  if (WL.includes(node.kind)) router.push({ name: 'NsWorkloadDetail', params: { namespace: node.namespace, type: node.kind.toLowerCase(), name: node.name } })
  else if (node.kind === 'Pod') router.push({ name: 'NsPodDetail', params: { namespace: node.namespace, name: node.name } })
  else if (node.kind === 'Service') router.push({ name: 'NsServiceDetail', params: { namespace: node.namespace, name: node.name } })
}
const gotoRef = ref2 => router.push({ name: REF_ROUTES[ref2.kind] || 'NsSecretDetail', params: { namespace: props.workload.namespace, name: ref2.name } })
const gotoHpa = h => router.push({ name: 'NsHPADetail', params: { namespace: h.namespace || props.workload.namespace, name: h.name } })

// C6:CronJob/Job 卡语义(替代 replicas/image 行)
const cronSchedule = computed(() => props.workload?.raw?.spec?.schedule || '')
const cronSuspended = computed(() => props.workload?.raw?.spec?.suspend === true)
const jobCompletions = computed(() => {
  const s = props.workload?.raw?.status?.succeeded || 0
  const total = props.workload?.raw?.spec?.completions
  return { s, total: total == null ? '*' : total }
})

// A3:Service 列头计数 = 关联 + 失配
const svcTotal = computed(() => props.topo.relatedServices.length + props.topo.driftedServices.length)
</script>
```

`<template>`:四列骨架与悬浮 "+" 按钮原样保留(两个 "+" 必须 `-left-3` class,selector-guard 锚点),逐列变更:

**Ingress 列**(A1 + B1 + D2/D4):

```html
<div class="px-md py-2 border-b border-outline-variant/40 bg-surface-container-low/40 flex items-center gap-sm">
  <span class="material-symbols-outlined text-primary text-base">alt_route</span>
  <span class="text-body-sm font-semibold">{{ $t('workload.topology.ingress') }}</span>
  <span class="text-xs text-on-surface-variant ml-auto">{{ $t('workload.topology.countRoutes', { n: topo.ingressBreakdown.ownRules.length }) }}</span>
</div>
<div class="p-sm flex flex-col gap-xs flex-1">
  <template v-if="topo.states.value.servicesPending || topo.states.value.ingressesPending">
    <div v-for="i in 2" :key="i" class="h-9 rounded-lg bg-surface-container-low animate-pulse"></div>
  </template>
  <template v-else>
    <button v-for="(r, i) in topo.ingressBreakdown.ownRules" :key="i" type="button" @click="router.push({ name: 'NsIngressDetail', params: { namespace: workload.namespace, name: r.ingress } })"
      class="text-left cursor-pointer rounded-lg border border-outline-variant/60 px-sm py-1.5 hover:border-primary hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-colors">
      <p class="font-mono text-xs text-primary font-semibold truncate">{{ r.host }}<span class="text-on-surface-variant font-normal">{{ r.path }}</span></p>
      <p class="text-[11px] text-on-surface-variant truncate">→ {{ r.serviceName }}<span v-if="r.port">:{{ r.port }}</span></p>
    </button>
    <!-- A1:共享 Ingress 的他人路由,合并计数入口(不冒充本负载流量) -->
    <button v-for="o in topo.ingressBreakdown.others" :key="'o-' + o.name" type="button"
      @click="router.push({ name: 'NsIngressDetail', params: { namespace: workload.namespace, name: o.name } })"
      class="text-left text-[11px] text-on-surface-variant/70 hover:text-primary rounded-lg px-sm py-1 border border-dashed border-outline-variant/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <span class="material-symbols-outlined text-xs align-middle">alt_route</span>
      {{ o.name }} · {{ $t('workload.topology.otherRoutes', { count: o.count }) }}
    </button>
    <div v-if="!topo.ingressBreakdown.ownRules.length && !topo.ingressBreakdown.others.length" class="flex-1 flex flex-col items-center justify-center text-center text-xs text-on-surface-variant/50 py-md">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">block</span>{{ $t('workload.topology.noIngress') }}
    </div>
  </template>
</div>
```

**Service 列**(A3 + C4 行 + C5 徽标与空态提示 + 失配卡保留一个 `修复 selector` 按钮文案不变):

- 列头计数:`{{ $t('workload.topology.countServices', { n: svcTotal }) }}`,失配时徽标 `<span v-if="topo.driftedServices.length" class="text-error">+{{ topo.driftedServices.length }}⚠</span>`。
- 骨架分支同上(`topo.states.value.servicesPending`)。
- Service 卡(button 化,`@mouseleave` 见 Task 7 联动,本任务先不加 hover 逻辑)副行追加端点行:

```html
<p v-if="topo.epFor(s.name)" class="text-[11px] truncate" :class="topo.epFor(s.name).ready === 0 ? 'text-error' : 'text-on-surface-variant'">
  {{ $t('workload.topology.endpoints', { ready: topo.epFor(s.name).ready, total: topo.epFor(s.name).total }) }}
</p>
```

- STS 主 Service 徽标(S 列卡片名前):`<span v-if="s.name === topo.governingSvcName" class="px-1 rounded bg-primary/15 text-primary text-[10px]">{{ $t('workload.topology.governing') }}</span>`
- 失配卡文案(Task 6 前先统一用 `workload.topology.driftBroken`,Task 6 分两档):

```html
<p class="text-[11px] text-error/80 mt-0.5">{{ $t('workload.topology.driftBroken') }}</p>
```

- 全空空态补 C5 提示行:

```html
<p class="text-[10px] text-on-surface-variant/40 mt-1">{{ $t('workload.topology.noSelectorHint') }}</p>
```

**Workload 卡**(C6 + D2;C1 RS chips / C2 附挂 Task 7 加):

- CronJob 分支(替代 replicas/image 两行):

```html
<template v-if="workload.type === 'CronJob'">
  <p class="font-mono text-[11px] text-on-surface truncate">{{ cronSchedule }}
    <span v-if="cronSuspended" class="px-1 rounded bg-tertiary-container/20 text-tertiary-container text-[10px]">{{ $t('workload.topology.suspended') }}</span>
  </p>
  <p class="text-[10px] text-on-surface-variant/60">{{ $t('workload.topology.schedule') }}</p>
</template>
<template v-else-if="workload.type === 'Job'">
  <p class="text-[11px] text-on-surface-variant font-mono">{{ $t('workload.topology.completions', { succeeded: jobCompletions.s, total: jobCompletions.total }) }}</p>
</template>
<template v-else>
  <!-- 原 replicas/image 两行保持不变 -->
</template>
```

- 挂载区(configRefs)卡点击改 `gotoRef(ref)`(支持 PVC/IPS 跳转);Kind→图标映射:`ConfigMap:'description' / Secret|imagePullSecrets:'key' / PVC:'database'`。

**Pods 列**(B1 + D2):骨架分支 `podsPending`;Pod 卡 button 化;空态保持。

- [ ] **Step 2: i18n 键(zh/en 同步进现有 `workload.topology` 对象与 `workload.ingressMap`、`workload.expose`)**

zh.json `workload.topology` 追加:

```json
"countRoutes": "{n} 条路由",
"countServices": "{n} Service",
"countPods": "{n} Pod",
"otherRoutes": "+{count} 条其他应用路由",
"endpoints": "端点 {ready}/{total}",
"driftBroken": "已断:selector 失配,Endpoints 为空(访问 503)",
"governing": "主",
"noSelectorHint": "无 selector 的 Service(ExternalName/自管 Endpoints)不在此列",
"schedule": "计划",
"suspended": "已暂停",
"completions": "完成 {succeeded}/{total}"
```

en.json 对应:

```json
"countRoutes": "{n} routes",
"countServices": "{n} Service(s)",
"countPods": "{n} Pod(s)",
"otherRoutes": "+{count} other route(s)",
"endpoints": "endpoints {ready}/{total}",
"driftBroken": "Broken: selector mismatch, no endpoints (503)",
"governing": "governing",
"noSelectorHint": "Services without a selector (ExternalName / self-managed Endpoints) are not listed",
"schedule": "schedule",
"suspended": "suspended",
"completions": "{succeeded}/{total} completed"
```

zh `workload.ingressMap` 追加 `"portRequired": "请先选择 Service 端口"`,en `"portRequired": "Select a service port first"`;zh `workload.expose` 追加 `"portRequired": "至少填写一个端口"`,en `"portRequired": "At least one port is required"`。

- [ ] **Step 3: 页面接线**

NsWorkloadDetail:import 组件;拓扑模板块(:1783-1898 整块)替换为 `<WorkloadTopologyTab .../>`(用法见 Interfaces);删除已被组件吸收的模板级引用。`driftedServices` 失配卡的「修复 selector」按钮随卡迁入组件(文案与 disabled 逻辑不变:`!canMutate || !!topo.repairingSvc || !Object.keys(topo.identitySel).length`)。

- [ ] **Step 4: 验证 + 提交**

Run: `npm run typecheck && npm run i18n:check && npm run test:unit 2>&1 | tail -4`
Expected: 全绿(selector-guard 的 `-left-3`/`修复 selector`/`topology` 锚点保持)

```bash
git add src/components/common/WorkloadTopologyTab.vue src/views/NsWorkloadDetail.vue src/locales/zh.json src/locales/en.json
git commit --author="aliangone <aliangone@gmail.com>" -m "feat(topology): 拓扑 Tab 组件化——A1 路由过滤/A3 计数/B1 骨架/C5/C6/D1-D4(i18n 双语)"
```

---

### Task 6: C4 Endpoints 行 + C7 drift 两档(组件测试先行)

**Files:**
- Test: `src/views/__tests__/NsWorkloadDetail.topology.test.js`(新建)
- Modify: `src/components/common/WorkloadTopologyTab.vue`(失配卡两档文案)
- Modify: `src/locales/zh.json` / `en.json`(+`driftPending`/`driftHeuristic`)

**Interfaces:**
- Consumes: Task 3 `driftedServices`(已带 `drift` 档)、`epFor`;Task 5 组件结构。
- Produces: 失配卡按 `s.drift` 渲染 `driftBroken`(红)/`driftPending`(黄)文案;title 补启发式说明(D3)。

- [ ] **Step 1: 新建测试文件(harness 复制 selector-guard:同一 mock 策略 + 三个新 fetcher mock + `gotoTopology` 助手),写四条失败用例**

```js
// src/views/__tests__/NsWorkloadDetail.topology.test.js —— 拓扑 Tab 组件级断言(vitest+happy-dom)。
// harness 与 NsWorkloadDetail.selector-guard.test.js 同策略(mock @/api/client + @/stores/cluster,
// 真实 i18n + Vue Query;useToast importOriginal 保真)。fixture 经 state 对象按用例注入。
import { test, expect, vi, beforeEach } from 'vitest'

const captured = vi.hoisted(() => ({ svcAdds: [], svcUpdates: [] }))
const state = vi.hoisted(() => ({ workload: null, services: [], pdbs: [], netpols: [], pods: [], ingresses: [], endpoints: [], replicasets: [], hpas: [] }))

import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
  cronJobApi: { get: vi.fn(async () => ({})) },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
vi.mock('@/composables/useToast', async (importOriginal) => ({ ...(await importOriginal()), notify: vi.fn() }))
import { notify } from '@/composables/useToast'

vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  watchStateOf: () => 'off',
  currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [state.workload]), fetchPods: vi.fn(async () => state.pods),
  fetchPVCs: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  fetchServices: vi.fn(async () => state.services), fetchIngresses: vi.fn(async () => state.ingresses), fetchEvents: vi.fn(async () => []),
  fetchPDBs: vi.fn(async () => state.pdbs), fetchNetworkPolicies: vi.fn(async () => state.netpols),
  fetchEndpoints: vi.fn(async () => state.endpoints), fetchReplicaSets: vi.fn(async () => state.replicasets), fetchHPAs: vi.fn(async () => state.hpas),
  updateWorkload: vi.fn(async () => {}), applyWorkloadTemplate: vi.fn(async () => {}),
  updateWorkloadMeta: vi.fn(async () => {}),
  addService: vi.fn(item => { captured.svcAdds.push(item); return { ok: true } }),
  updateService: vi.fn((name, ns, updates) => { captured.svcUpdates.push({ name, updates }); return { ok: true } }),
  invalidateAllClusterQueries: vi.fn(async () => {}),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

const demoWorkload = {
  name: 'demo-deploy', namespace: 'default', type: 'Deployment', labels: { app: 'demo-deploy' }, annotations: {},
  raw: {
    metadata: { name: 'demo-deploy', namespace: 'default', labels: { app: 'demo-deploy' }, annotations: {} },
    spec: {
      replicas: 1, selector: { matchLabels: { app: 'demo-deploy' } },
      template: { metadata: { labels: { app: 'demo-deploy' } }, spec: { containers: [{ name: 'main', image: 'nginx', ports: [{ containerPort: 8080 }] }] } },
    },
  },
}
const svcMatching = { name: 'demo-svc', namespace: 'default', type: 'ClusterIP', ports: '80:8080/TCP', selector: { app: 'demo-deploy' }, portList: [] }
const mkPod = (name, labels) => ({ name, namespace: 'default', labels, status: 'Running', restarts: 0, raw: { metadata: { name, namespace: 'default' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } } })

function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { attachTo: document.body, global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true } } })
}
async function gotoTopology(w) {
  await w.findAll('button').find(b => b.text() === 'topology').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  document.body.innerHTML = ''
  captured.svcAdds.length = 0; captured.svcUpdates.length = 0
  notify.mockClear()
  state.workload = JSON.parse(JSON.stringify(demoWorkload))
  state.services = [JSON.parse(JSON.stringify(svcMatching))]
  state.pdbs = []; state.netpols = []; state.pods = []; state.ingresses = []
  state.endpoints = []; state.replicasets = []; state.hpas = []
  i18n.global.locale.value = 'zh'
})

test('A1: 共享 Ingress 只显示本负载规则,他人规则合并为 +N 行', async () => {
  state.services = [svcMatching, { name: 'other-svc', namespace: 'default', type: 'ClusterIP', ports: '80:80/TCP', selector: { app: 'other' }, portList: [] }]
  state.ingresses = [{
    name: 'shared', namespace: 'default', rules: [{ host: 'a.com', http: { paths: [
      { path: '/api', pathType: 'Prefix', backend: { service: { name: 'demo-svc', port: { number: 80 } } } },
      { path: '/', pathType: 'Prefix', backend: { service: { name: 'other-svc', port: { number: 80 } } } },
    ] } }],
    defaultBackend: null,
  }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const text = w.text()
  expect(text).toContain('a.com/api')
  expect(text).toContain('other-svc')          // 合并行出现
  expect(text).toContain('+1 条其他应用路由')
  // 他人路由不得渲染成规则卡(→ other-svc 形式的规则行不存在;合并行格式为「shared · +N …」)
  expect(text).not.toContain('→ other-svc')
})

test('C4: Service 卡显示端点就绪数,ready=0 标红', async () => {
  state.endpoints = [{ name: 'demo-svc', namespace: 'default', addresses: ['10.0.0.1', '10.0.0.2'], notReadyAddresses: [] }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  expect(w.text()).toContain('端点 2/2')
  state.endpoints = [{ name: 'demo-svc', namespace: 'default', addresses: [], notReadyAddresses: [] }]
  const w2 = mountDetail(); await flushPromises(); await gotoTopology(w2)
  expect(w2.text()).toContain('端点 0/0')
  expect(w2.html()).toContain('text-error')
})

test('C7: 实际 Pod 也不匹配 → 红「已断」;现有 Pod 仍匹配 → 黄「滚动后将断」', async () => {
  state.services = [{ ...JSON.parse(JSON.stringify(svcMatching)), selector: { app: 'demo-deploy', team: 'blue' } }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  expect(w.text()).toContain('已断')
  // 现有 Pod 仍匹配旧标签 → pending-break
  state.pods = [mkPod('demo-old', { app: 'demo-deploy', team: 'blue' })]
  state.endpoints = [{ name: 'demo-svc', namespace: 'default', addresses: ['10.0.0.1'], notReadyAddresses: [] }]
  const w2 = mountDetail(); await flushPromises(); await gotoTopology(w2)
  expect(w2.text()).toContain('滚动后将断')
})

test('C7: 失配卡 title 说明启发式判据(D3)', async () => {
  state.services = [{ ...JSON.parse(JSON.stringify(svcMatching)), selector: { app: 'demo-deploy', team: 'blue' } }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  expect(w.text()).toContain('selector 值包含本负载名')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.topology.test.js`
Expected: FAIL(无 `driftPending`/`driftHeuristic` 键;失配卡恒红文案)

- [ ] **Step 3: 实现两档 + D3 title**

组件失配卡改为:

```html
<p class="text-[11px] mt-0.5" :class="s.drift === 'broken' ? 'text-error/80' : 'text-tertiary-container'">
  {{ s.drift === 'broken' ? $t('workload.topology.driftBroken') : $t('workload.topology.driftPending') }}
</p>
```

修复按钮 title 追加判据:`$t('workload.topology.driftHeuristic')`(与既有 identityRequired/noUpdatePerm 分支并列)。失配卡边框色按档位:`s.drift === 'broken' ? 'border-error/50 bg-error/5' : 'border-tertiary-container/40 bg-tertiary-container/5'`,warning 图标色同理。

i18n 追加(zh):`"driftPending": "滚动后将断:现有 Pod 仍匹配,新 Pod 将失配"`,`"driftHeuristic": "判据:selector 值包含本负载名"`;
(en):`"driftPending": "Will break on rollout: current pods match, new pods will not"`,`"driftHeuristic": "Heuristic: a selector value equals this workload name"`。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.topology.test.js && npm run test:unit 2>&1 | tail -3`
Expected: 新用例 PASS;selector-guard 全绿(其断言不涉及失配文案,仅「修复 selector」与捕获 selector)

- [ ] **Step 5: 提交**

```bash
git add src/views/__tests__/NsWorkloadDetail.topology.test.js src/components/common/WorkloadTopologyTab.vue src/locales/zh.json src/locales/en.json
git commit --author="aliangone <aliangone@gmail.com>" -m "feat(topology): C4 端点就绪数+C7 drift 两档文案分型(组件测试先行)"
```

---

### Task 7: C1 RS 层 + C2 附挂 + C3 悬停联动

**Files:**
- Modify: `src/components/common/WorkloadTopologyTab.vue`
- Modify: `src/views/NsWorkloadDetail.vue`(如需把 `latestRs` 传组件——不必,`topo` 里已带)
- Test: `src/views/__tests__/NsWorkloadDetail.topology.test.js`(追加用例)
- Modify: `src/locales/zh.json` / `en.json`

**Interfaces:**
- Consumes: `topo.replicaSets / latestRs / podsGrouped / workloadHpas / labelConsumers`(Task 3);Task 1 `isRetiredRs`。
- Produces: Workload 卡 RS chips + HPA chip;Service 列尾「标签消费者」chips;Pods 列 RS 分组;规则卡⇄Service 卡 hover 高亮(组件内 `hoveredSvc = ref('')`)。
- **设计微调(相对 spec §3.3 C2)**:PDB/NetPol chips 落在 **Service 列尾「标签消费者」组**而非逐 Service 卡下——二者 selector 选的是 Pod 不是 Service,逐卡挂载会产生错误归属暗示;视觉上仍在 Service 列内,与 spec 附图一致。

- [ ] **Step 1: 追加失败测试(文件末尾)**

```js
const mkRs = (name, ready, desired, ts, pods = []) => ({ name, namespace: 'default', ready, desired, raw: { metadata: { name, namespace: 'default', creationTimestamp: ts, ownerReferences: [{ kind: 'Deployment', name: 'demo-deploy', controller: true }], labels: { 'pod-template-hash': name } } } })

test('C1: RS chips 渲染 ready/desired,淘汰 RS 置灰,Pods 列按 RS 分组', async () => {
  state.replicasets = [mkRs('demo-9f8', 2, 2, '2026-02-01T00:00:00Z'), mkRs('demo-old', 0, 0, '2026-01-01T00:00:00Z')]
  state.pods = [
    { ...mkPod('demo-9f8-a', { app: 'demo-deploy' }), raw: { metadata: { name: 'demo-9f8-a', namespace: 'default', ownerReferences: [{ kind: 'ReplicaSet', name: 'demo-9f8', controller: true }] } } },
    { ...mkPod('demo-old-a', { app: 'demo-deploy' }), raw: { metadata: { name: 'demo-old-a', namespace: 'default', ownerReferences: [{ kind: 'ReplicaSet', name: 'demo-old', controller: true }] } } },
  ]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const text = w.text()
  expect(text).toContain('demo-9f8')
  expect(text).toContain('demo-old')
  // Pods 列按 RS 分组:组头含 RS 名;淘汰组容器带 opacity 降透明类
  expect(w.html()).toContain('opacity-60')
})

test('C2: HPA chip 与 标签消费者(PDB/NetPol)chips 渲染', async () => {
  state.hpas = [{ name: 'demo-hpa', namespace: 'default', targetName: 'demo-deploy', targetKind: 'Deployment', minReplicas: 1, maxReplicas: 5, cpuTarget: 80 }]
  state.pdbs = [{ name: 'demo-pdb', namespace: 'default', selector: { app: 'demo-deploy' }, raw: { status: { disruptionsAllowed: 0 } } }]
  state.netpols = [{ name: 'demo-np', namespace: 'default', podSelector: { app: 'demo-deploy' } }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const text = w.text()
  expect(text).toContain('demo-hpa')
  expect(text).toContain('demo-pdb')
  expect(text).toContain('demo-np')
  expect(text).toContain('标签消费者')
})

test('C3: 规则卡 hover → 匹配 Service 卡高亮(ring)', async () => {
  state.ingresses = [{ name: 'ing1', namespace: 'default', rules: [{ host: 'a.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'demo-svc', port: { number: 80 } } } }] } }], defaultBackend: null }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const ruleCard = w.findAll('button').find(b => b.text().includes('a.com'))
  const svcCardBefore = w.findAll('button').find(b => b.text().includes('demo-svc') && b.text().includes('ClusterIP'))
  expect(svcCardBefore.classes().join(' ')).not.toContain('ring-2')
  await ruleCard.trigger('mouseenter')
  expect(svcCardBefore.classes().join(' ')).toContain('ring-2')
  await ruleCard.trigger('mouseleave')
  expect(svcCardBefore.classes().join(' ')).not.toContain('ring-2')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.topology.test.js`
Expected: 新 3 条 FAIL(chips/分组/联动未实现)

- [ ] **Step 3: 实现**

组件 `<script setup>` 追加:

```js
import { isRetiredRs } from '@/logic/topology'
// C3:hover 联动(规则卡 ⇄ Service 卡,按 serviceName 对齐;失配卡同样命中)
const hoveredSvc = ref('')
const isRetired = rs2 => isRetiredRs(rs2, props.topo.latestRs)
```

模板插入点:

1. **Workload 卡**(replicas 行下方;仅 `workload.type === 'Deployment'`):
```html
<div v-if="workload.type === 'Deployment' && topo.replicaSets.length" class="flex flex-wrap gap-0.5 mt-1">
  <button v-for="rs2 in topo.replicaSets" :key="rs2.name" type="button"
    @click="$emit('goto', 'revisions')"
    :class="['font-mono text-[10px] px-1 py-0.5 rounded border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-colors',
      isRetired(rs2) ? 'border-outline-variant/40 text-on-surface-variant/50 opacity-60' : 'border-primary/30 bg-primary/5 text-primary']">
    rs/{{ rs2.name }} {{ rs2.ready }}/{{ rs2.desired }}
  </button>
</div>
```
2. **Workload 卡 C2 HPA chip**(RS chips 上方):
```html
<div v-if="topo.workloadHpas.length" class="flex flex-wrap gap-0.5 mt-1">
  <button v-for="h in topo.workloadHpas" :key="h.name" type="button" @click="gotoHpa(h)"
    class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-surface-container-low text-[10px] font-mono hover:bg-surface-container focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    <span class="material-symbols-outlined" style="font-size:11px">speed</span>{{ h.name }} {{ h.minReplicas }}→{{ h.maxReplicas }}
  </button>
</div>
```
3. **Service 列尾「标签消费者」组**(C2;失配卡之后、空态之前):
```html
<div v-if="topo.labelConsumers.length" class="mt-1 pt-1 border-t border-outline-variant/30">
  <p class="text-[10px] text-on-surface-variant/60 mb-0.5">{{ $t('workload.topology.labelConsumers') }}</p>
  <div class="flex flex-wrap gap-0.5">
    <button v-for="c in topo.labelConsumers" :key="c.kind + '/' + c.name" type="button"
      @click="router.push({ name: c.kind === 'PDB' ? 'NsPDBDetail' : 'NsNetworkPolicyDetail', params: { namespace: workload.namespace, name: c.name } })"
      :class="['inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        c.disruptive ? 'bg-error/10 text-error' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container']">
      <span class="material-symbols-outlined" style="font-size:11px">{{ c.kind === 'PDB' ? 'shield' : 'security' }}</span>{{ c.name }}
    </button>
  </div>
</div>
```
4. **Pods 列 RS 分组**(替换平铺 `v-for="p in managedPods"`;`managedPods` prop 保留作未分组兜底数据源已并入 `topo.podsGrouped`):
```html
<template v-for="g in topo.podsGrouped.groups" :key="g.rsName">
  <p class="text-[10px] text-on-surface-variant/60 font-mono flex items-center gap-1 px-0.5">
    rs/{{ g.rsName }} <span class="opacity-70">{{ g.ready }}/{{ g.desired }}</span>
    <span v-if="isRetired({ name: g.rsName, desired: g.desired, ready: g.ready })" class="w-full border-t border-outline-variant/20"></span>
  </p>
  <div v-for="p in g.pods" :key="p.name" :class="['cursor-pointer flex items-center gap-xs rounded-lg border border-outline-variant/60 px-sm py-1 hover:border-primary hover:bg-primary/5 transition-colors', isRetired({ name: g.rsName, desired: g.desired, ready: g.ready }) ? 'opacity-60' : '']" role="button" tabindex="0" @click="router.push({ name: 'NsPodDetail', params: { namespace: workload.namespace, name: p.name } })" @keydown.enter="router.push({ name: 'NsPodDetail', params: { namespace: workload.namespace, name: p.name } })">
    <!-- 原 Pod 行内容:podHealth 圆点 + 名称 + 标签 -->
  </div>
</template>
<div v-if="topo.podsGrouped.ungrouped.length">
  <p class="text-[10px] text-on-surface-variant/60 px-0.5">{{ $t('workload.topology.rsUngrouped') }}</p>
  <!-- 原 Pod 行内容,数据源 topo.podsGrouped.ungrouped -->
</div>
<div v-if="!topo.podsGrouped.groups.length && !topo.podsGrouped.ungrouped.length">
  <!-- 原无 Pod 空态 -->
</div>
```
> 实现注:`isRetired` 入参形状需含 `desired/ready/name`——分组头里由 `g` 组装;RS chips 处直接传 `rs2`(mapper 形状即含)。Pod 行内保留 `podHealth(p)` 圆点与状态标签原文。
5. **C3 联动 class**:规则卡 `@mouseenter="hoveredSvc = r.serviceName" @mouseleave="hoveredSvc = ''"`,class 追加 `hoveredSvc === r.serviceName ? 'ring-2 ring-primary' : ''`;Service 卡与失配卡 `@mouseenter="hoveredSvc = s.name" @mouseleave="hoveredSvc = ''"`,class 追加 `hoveredSvc === s.name ? (s.drift ? 'ring-2 ring-error' : 'ring-2 ring-primary') : ''`。

i18n 追加(zh):`"rsUngrouped": "未分组 Pod"`,`"labelConsumers": "标签消费者"`;(en):`"rsUngrouped": "ungrouped pods"`,`"labelConsumers": "label consumers"`。

- [ ] **Step 4: 跑测试确认通过 + 回归 + 提交**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.topology.test.js && npm run test:unit 2>&1 | tail -3 && npm run i18n:check`
Expected: 全绿

```bash
git add src/components/common/WorkloadTopologyTab.vue src/views/__tests__/NsWorkloadDetail.topology.test.js src/locales/zh.json src/locales/en.json
git commit --author="aliangone <aliangone@gmail.com>" -m "feat(topology): C1 RS 层(chips+Pod 分组)+C2 HPA/消费者附挂+C3 悬停联动"
```

---

### Task 8: 终验——门禁全家桶 + 手测清单

**Files:** 无新改动(发现问题回改对应任务文件)

- [ ] **Step 1: 门禁全家桶**

Run: `npm test 2>&1 | tail -4 && npm run typecheck && npm run i18n:check && npm run build 2>&1 | tail -4`
Expected: 全绿(test:server 零依赖链含 topology.test.mjs;vitest 全量;build 覆盖 .vue)

- [ ] **Step 2: 手测清单(写入 PR 描述,需真集群)**

1. Deployment 拓扑:共享 Ingress 只显示本负载路由,合并行可跳转
2. 滚动更新进行中:RS chips 新旧并存,Pods 列分组随滚动迁移
3. 失配 Service 两档:改模板标签未滚动(黄)→ 滚动后(红);修复按钮两档可用
4. Service 卡端点数:缩到 0 副本 → 端点 0/0 标红
5. CronJob 拓扑:关联 Service 判定正确(jobTemplate 标签),卡显示 schedule/suspend
6. STS:主 Service「主」徽标;DaemonSet/Job 无 RS 区
7. HPA/PDB/NetPol chips 跳转;PDB disruptive 警示色
8. watch 关闭(kill-switch)时:改 Service 名 → 30s 内拓扑自动刷新(B2)
9. 首次进入拓扑 Tab:骨架闪现后空态/数据(B1)
10. 键盘 Tab 遍历拓扑卡有 focus 环,Enter 可跳转(D2)

- [ ] **Step 3: 汇报**

输出:任务完成清单、门禁结果、手测清单,等待用户验收后走 finishing-a-development-branch(`--no-ff` 合回 main)。

---

## Self-Review 记录(写计划时已核)

1. **Spec 覆盖**:A1→T5+A1 用例;A2→T1/T4;A3→T5;A4→T1/T4;A5→T3;B1→T5;B2→T3;C1→T7;C2→T7(+T4 configRefs/refRoute);C3→T7;C4→T6;C5→T5;C6→T5;C7→T6;D1→T3/T5;D2→T5;D3→T6;D4→T5;i18n→各任务;错误处理→T3 注释+T5 骨架分支;组件拆分→T3/T4/T5。无缺口。
2. **占位符扫描**:无 TBD/「适当处理」;Task 7 Pods 分组的「原 Pod 行内容」为迁移指令(源码在 T5 前的组件里,逐字搬),已附实现注。
3. **类型一致性**:`endpointsForService` 返回 `{ready,notReady,total}`(T1 测试=T6 断言=T3 消费一致);`ingressBreakdown.others` 元素 `{name,count}`(T1=T5 一致);`driftedServices` 带 `drift` 档(T3=T6 一致);`mapReplicaSet` 形状(T2=T1 测试 fixture 一致);`labelConsumers` 带 `disruptive`(T3=T7 一致)。
