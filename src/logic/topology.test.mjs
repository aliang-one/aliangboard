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
  const ingA = {"name":"a","rules":[{"host":"h","http":{"paths":[{"path":"/1","backend":{"service":{"name":"x","port":{}}}},{"path":"/2","backend":{"service":{"name":"y"}}}]}}]}
  const ingB = {"name":"b","rules":[{"host":"h","http":{"paths":[{"path":"/3","backend":{"service":{"name":"x"}}}]}}]}
  const ings = [ingA, ingB]
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
