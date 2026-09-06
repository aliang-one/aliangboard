import test from 'node:test'
import assert from 'node:assert/strict'
import { parseApiPath } from './k8s-path.mjs'

test('ns-scoped core list', () => {
  assert.deepEqual(parseApiPath('/api/v1/namespaces/team-a/pods'), {
    clusterScope: false, namespace: 'team-a', resource: 'pods', name: null, subresource: null,
  })
})

test('ns-scoped group resource get', () => {
  assert.deepEqual(parseApiPath('/apis/apps/v1/namespaces/team-a/deployments/web'), {
    clusterScope: false, namespace: 'team-a', resource: 'deployments', name: 'web', subresource: null,
  })
})

test('namespaces collection itself is cluster-scoped', () => {
  assert.deepEqual(parseApiPath('/api/v1/namespaces'), {
    clusterScope: true, namespace: null, resource: 'namespaces', name: null, subresource: null,
  })
})

test('cluster-scoped core list', () => {
  assert.deepEqual(parseApiPath('/api/v1/nodes'), {
    clusterScope: true, namespace: null, resource: 'nodes', name: null, subresource: null,
  })
})

test('exec subresource', () => {
  assert.deepEqual(parseApiPath('/api/v1/namespaces/team-a/pods/x/exec'), {
    clusterScope: false, namespace: 'team-a', resource: 'pods', name: 'x', subresource: 'exec',
  })
})

test('logs subresource (watch brief variant)', () => {
  assert.deepEqual(parseApiPath('/api/v1/namespaces/team-a/pods/x/log'), {
    clusterScope: false, namespace: 'team-a', resource: 'pods', name: 'x', subresource: 'log',
  })
})

test('wildcard CRD group parses (resource not in KIND_API still returned)', () => {
  assert.deepEqual(parseApiPath('/apis/example.com/v1/namespaces/ns/things/y'), {
    clusterScope: false, namespace: 'ns', resource: 'things', name: 'y', subresource: null,
  })
})

test('cluster-scoped get with name', () => {
  assert.deepEqual(parseApiPath('/apis/rbac.authorization.k8s.io/v1/clusterroles/foo'), {
    clusterScope: true, namespace: null, resource: 'clusterroles', name: 'foo', subresource: null,
  })
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
    '/api/v1/namespaces/team-a/pods/x/exec/extra',
    '/api/v1/namespaces/~joe/secrets',
    '/api/v1/namespaces/team-a/pod\\s',
  ]) {
    assert.equal(parseApiPath(p), null, `expected null for ${p}`)
  }
})
