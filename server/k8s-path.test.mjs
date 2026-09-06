import test from 'node:test'
import assert from 'node:assert/strict'
import { parseApiPath } from './k8s-path.mjs'

test('ns-scoped core list', () => {
  assert.deepEqual(parseApiPath('/api/v1/namespaces/team-a/pods'), {
    clusterScope: false, namespace: 'team-a', allNamespaces: false, resource: 'pods', name: null, subresource: null,
  })
})

test('ns-scoped group resource get', () => {
  assert.deepEqual(parseApiPath('/apis/apps/v1/namespaces/team-a/deployments/web'), {
    clusterScope: false, namespace: 'team-a', allNamespaces: false, resource: 'deployments', name: 'web', subresource: null,
  })
})

test('namespaces collection itself is cluster-scoped', () => {
  assert.deepEqual(parseApiPath('/api/v1/namespaces'), {
    clusterScope: true, namespace: null, allNamespaces: false, resource: 'namespaces', name: null, subresource: null,
  })
})

test('I2b: namespaces single object → ns-scoped gate on namespace=<name>', () => {
  assert.deepEqual(parseApiPath('/api/v1/namespaces/team-a'), {
    clusterScope: false, namespace: 'team-a', allNamespaces: false, resource: 'namespaces', name: 'team-a', subresource: null,
  })
})

test('cluster-scoped core list', () => {
  assert.deepEqual(parseApiPath('/api/v1/nodes'), {
    clusterScope: true, namespace: null, allNamespaces: false, resource: 'nodes', name: null, subresource: null,
  })
})

test('C1: ns-typed kind at cluster position = all-ns list (allNamespaces, namespace=null)', () => {
  assert.deepEqual(parseApiPath('/api/v1/pods'), {
    clusterScope: false, namespace: null, allNamespaces: true, resource: 'pods', name: null, subresource: null,
  })
  assert.deepEqual(parseApiPath('/apis/apps/v1/deployments'), {
    clusterScope: false, namespace: null, allNamespaces: true, resource: 'deployments', name: null, subresource: null,
  })
})

test('exec subresource', () => {
  assert.deepEqual(parseApiPath('/api/v1/namespaces/team-a/pods/x/exec'), {
    clusterScope: false, namespace: 'team-a', allNamespaces: false, resource: 'pods', name: 'x', subresource: 'exec',
  })
})

test('logs subresource (watch brief variant)', () => {
  assert.deepEqual(parseApiPath('/api/v1/namespaces/team-a/pods/x/log'), {
    clusterScope: false, namespace: 'team-a', allNamespaces: false, resource: 'pods', name: 'x', subresource: 'log',
  })
})

test('wildcard CRD group parses (resource not in KIND_API still returned)', () => {
  assert.deepEqual(parseApiPath('/apis/example.com/v1/namespaces/ns/things/y'), {
    clusterScope: false, namespace: 'ns', allNamespaces: false, resource: 'things', name: 'y', subresource: null,
  })
})

test('cluster-scoped get with name', () => {
  assert.deepEqual(parseApiPath('/apis/rbac.authorization.k8s.io/v1/clusterroles/foo'), {
    clusterScope: true, namespace: null, allNamespaces: false, resource: 'clusterroles', name: 'foo', subresource: null,
  })
})

test('C2: extended subresources parse (scale/eviction/status/ephemeralcontainers/token/proxy)', () => {
  assert.deepEqual(parseApiPath('/apis/apps/v1/namespaces/ns/deployments/web/scale').subresource, 'scale')
  assert.deepEqual(parseApiPath('/api/v1/namespaces/ns/pods/x/eviction').subresource, 'eviction')
  assert.deepEqual(parseApiPath('/api/v1/namespaces/ns/pods/x/status').subresource, 'status')
  assert.deepEqual(parseApiPath('/api/v1/namespaces/ns/pods/x/ephemeralcontainers').subresource, 'ephemeralcontainers')
  assert.deepEqual(parseApiPath('/api/v1/namespaces/ns/serviceaccounts/sa/token').subresource, 'token')
  assert.deepEqual(parseApiPath('/api/v1/nodes/worker1/proxy').subresource, 'proxy')
})

test('C2: multi-segment tails take first segment as subresource root (node proxy sub-path)', () => {
  const p = parseApiPath('/api/v1/nodes/worker1/proxy/api/v1/namespaces/x/pods')
  assert.deepEqual(p, {
    clusterScope: true, namespace: null, allNamespaces: false, resource: 'nodes', name: 'worker1', subresource: 'proxy',
  })
  const q = parseApiPath('/api/v1/namespaces/team-a/pods/x/exec/extra')
  assert.deepEqual(q, {
    clusterScope: false, namespace: 'team-a', allNamespaces: false, resource: 'pods', name: 'x', subresource: 'exec',
  })
})

test('unknown 3rd segment (not a known subresource) → null (fail-closed)', () => {
  for (const p of ['/api/v1/nodes/n1/bogus', '/api/v1/namespaces/team-a/pods/x/bogus']) {
    assert.equal(parseApiPath(p), null, `expected null for ${p}`)
  }
})

// ===== C1/C2 final-review: 前端真实形态清单契约(useFetchers.js / cluster.js 实际发出的路径)。
// 每条都必须解析为非 null(解析失败 = 透传面 403 对所有人,将打断 open-mode 字节兼容)。
// 查询串由 index.mjs 在解析前剥除,这里同口径 split('?')[0]。
const REAL_SHAPES = [
  // useFetchers.js
  ['/apis/apps/v1/deployments?limit=1000', { namespace: null, allNamespaces: true, resource: 'deployments' }],
  ['/apis/apps/v1/statefulsets?limit=1000', { namespace: null, allNamespaces: true, resource: 'statefulsets' }],
  ['/apis/apps/v1/daemonsets?limit=1000', { namespace: null, allNamespaces: true, resource: 'daemonsets' }],
  ['/api/v1/nodes', { clusterScope: true, resource: 'nodes' }],
  ['/api/v1/nodes/worker1', { clusterScope: true, resource: 'nodes', name: 'worker1' }],
  ['/apis/metrics.k8s.io/v1beta1/nodes', { clusterScope: true, resource: 'nodes' }],
  ['/api/v1/services?limit=1000', { namespace: null, allNamespaces: true, resource: 'services' }],
  ['/api/v1/configmaps?limit=5000', { namespace: null, allNamespaces: true, resource: 'configmaps' }],
  ['/api/v1/secrets?limit=5000', { namespace: null, allNamespaces: true, resource: 'secrets' }],
  ['/apis/networking.k8s.io/v1/ingresses?limit=1000', { namespace: null, allNamespaces: true, resource: 'ingresses' }],
  ['/apis/policy/v1/poddisruptionbudgets?limit=5000', { namespace: null, allNamespaces: true, resource: 'poddisruptionbudgets' }],
  ['/apis/autoscaling/v2/horizontalpodautoscalers?limit=5000', { namespace: null, allNamespaces: true, resource: 'horizontalpodautoscalers' }],
  ['/api/v1/persistentvolumes', { clusterScope: true, resource: 'persistentvolumes' }],
  ['/apis/storage.k8s.io/v1/storageclasses', { clusterScope: true, resource: 'storageclasses' }],
  ['/apis/rbac.authorization.k8s.io/v1/roles?limit=5000', { namespace: null, allNamespaces: true, resource: 'roles' }],
  ['/apis/rbac.authorization.k8s.io/v1/clusterroles?limit=5000', { clusterScope: true, resource: 'clusterroles' }],
  ['/apis/node.k8s.io/v1/runtimeclasses?limit=5000', { clusterScope: true, resource: 'runtimeclasses' }],
  ['/api/v1/namespaces/team-a/services/web', { namespace: 'team-a', resource: 'services', name: 'web' }],
  ['/apis/apps/v1/namespaces/team-a/replicasets?limit=500', { namespace: 'team-a', resource: 'replicasets' }],
  ['/apis/apiextensions.k8s.io/v1/customresourcedefinitions?limit=500', { clusterScope: true, resource: 'customresourcedefinitions' }],
  // cluster.js
  ['/api/v1/pods?limit=1000', { namespace: null, allNamespaces: true, resource: 'pods' }],
  ['/apis/metrics.k8s.io/v1beta1/pods', { namespace: null, allNamespaces: true, resource: 'pods' }],
  ['/api/v1/events?limit=1000', { clusterScope: true, resource: 'events' }],
  // CR 实例(apiextensions 任意 group/version/plural)
  ['/apis/example.com/v1/things?limit=500', { clusterScope: true, resource: 'things' }],
  // 变更面真实形态
  ['/apis/apps/v1/namespaces/team-a/deployments/web/scale', { namespace: 'team-a', resource: 'deployments', name: 'web', subresource: 'scale' }],
  ['/api/v1/namespaces/team-a/pods/x/eviction', { namespace: 'team-a', resource: 'pods', name: 'x', subresource: 'eviction' }],
  ['/api/v1/pods?fieldSelector=spec.nodeName%3Dworker1', { namespace: null, allNamespaces: true, resource: 'pods' }],
  ['/api/v1/namespaces', { clusterScope: true, resource: 'namespaces' }],
  ['/api/v1/namespaces/team-a', { namespace: 'team-a', resource: 'namespaces', name: 'team-a' }],
]

test('real frontend path inventory: every shape parses (non-null) with expected anchors', () => {
  for (const [raw, expected] of REAL_SHAPES) {
    const p = parseApiPath(raw.split('?')[0])
    assert.notEqual(p, null, `real shape must parse: ${raw}`)
    for (const [k, v] of Object.entries(expected)) {
      assert.equal(p[k], v, `${raw}: ${k} should be ${v}, got ${p?.[k]}`)
    }
  }
})

test('unresolvable paths → null (fail-closed for non-admin)', () => {
  for (const p of [
    '/foo/bar',
    '/api/v1/namespaces/../secrets',
    '/api/v1/namespaces/%252e%252e/x',
    '/api/v1//pods',
    '/apis',
    '/apis/apps',
    '',
    '/',
    '/api',
    '/api/v1',
    '/api/v1/namespaces/~joe/secrets',
    '/api/v1/namespaces/team-a/pod\\s',
  ]) {
    assert.equal(parseApiPath(p), null, `expected null for ${p}`)
  }
})
