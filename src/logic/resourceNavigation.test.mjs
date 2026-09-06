// src/logic/resourceNavigation.test.mjs —— 资源 kind → 详情路由 映射纯函数(node --test,进 test:server 链)
// 单源收编:全局搜索 goResult 与告警铃铛 involvedObject 跳转共用一份映射,不再两处漂移。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeForResource } from './resourceNavigation.js'

test('namespace 级资源 → Ns*Detail 命名路由(带 namespace+name)', () => {
  assert.deepEqual(
    routeForResource('Pod', 'api-7d9', 'web'),
    { name: 'NsPodDetail', params: { namespace: 'web', name: 'api-7d9' } },
  )
  assert.deepEqual(
    routeForResource('Service', 'svc-1', 'web'),
    { name: 'NsServiceDetail', params: { namespace: 'web', name: 'svc-1' } },
  )
  for (const [kind, name] of [['Ingress', 'ing-1'], ['ConfigMap', 'cm-1'], ['Secret', 'sec-1'], ['PVC', 'pvc-1']]) {
    const r = routeForResource(kind, name, 'web')
    assert.equal(r.name, `Ns${kind}Detail`)
    assert.deepEqual(r.params, { namespace: 'web', name })
  }
})

test('工作负载五族 → NsWorkloadDetail(type 小写)', () => {
  for (const kind of ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']) {
    assert.deepEqual(
      routeForResource(kind, 'wl-1', 'web'),
      { name: 'NsWorkloadDetail', params: { namespace: 'web', type: kind.toLowerCase(), name: 'wl-1' } },
    )
  }
})

test('集群级:Node 走路径路由,Namespace 走命名路由', () => {
  assert.deepEqual(routeForResource('Node', 'worker-2', ''), `/nodes/worker-2`)
  assert.deepEqual(
    routeForResource('Namespace', 'web', ''),
    { name: 'NamespaceDetail', params: { name: 'web' } },
  )
})

test('无详情路由的 kind(Node 之外的集群级/未知)→ null,调用方自行兜底', () => {
  assert.equal(routeForResource('ReplicaSet', 'rs-1', 'web'), null)
  assert.equal(routeForResource('UnknownKind', 'x', 'web'), null)
  assert.equal(routeForResource('', 'x', 'web'), null)
  assert.equal(routeForResource(undefined, 'x', 'web'), null)
})

test('无 name → null(空壳事件不可跳)', () => {
  assert.equal(routeForResource('Pod', '', 'web'), null)
  assert.equal(routeForResource('Pod', undefined, 'web'), null)
})

// --- 2026-09-04 搜索扩容:新 kinds 入图(HPA/RBAC 族/NetPol/配额族/集群级)---
test('ns 级扩容:HPA/RBAC 族/NetPol/配额族 → Ns*Detail', () => {
  for (const kind of ['HPA', 'NetworkPolicy', 'ResourceQuota', 'LimitRange', 'PDB', 'Role', 'RoleBinding', 'ServiceAccount']) {
    assert.deepEqual(
      routeForResource(kind, 'r-1', 'web'),
      { name: `Ns${kind}Detail`, params: { namespace: 'web', name: 'r-1' } },
      kind,
    )
  }
})

test('集群级扩容:StorageClass/PV/CRD/ClusterRole/ClusterRoleBinding → 命名路由(name 参数)', () => {
  for (const kind of ['StorageClass', 'PV', 'CRD', 'ClusterRole', 'ClusterRoleBinding']) {
    assert.deepEqual(
      routeForResource(kind, 'c-1', ''),
      { name: kind === 'CRD' ? 'CrdDetail' : `${kind}Detail`, params: { name: 'c-1' } },
      kind,
    )
  }
})

// --- 2026-09-06 证书可观测:铃铛证书告警伪事件落点 ---
test('Certificate → ClusterCerts 页(证书告警行点击落点,不带 params)', () => {
  assert.deepEqual(routeForResource('Certificate', 'tls-web', 'api'), { name: 'ClusterCerts' })
})
