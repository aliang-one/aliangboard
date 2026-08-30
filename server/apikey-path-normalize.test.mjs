// CSO 2026-08-30 #7:安全检查必须在 URL 解析语义之后做 —— 原始串上的正则会被
// 点段折叠、%2e、绝对 URL、//host 绕过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSafeApiPath } from './api-key-tools.mjs'
import { PermissionDeniedError } from './authorize.mjs'

const ok = (p) => assert.doesNotThrow(() => assertSafeApiPath(p))
const bad = (p) => assert.throws(() => assertSafeApiPath(p), PermissionDeniedError)

test('合法 K8s 路径放行(含编码段)', () => {
  ok('/api/v1/namespaces/default/pods')
  ok('/apis/apps/v1/namespaces/ns1/deployments/dp1')
  ok('/api/v1/namespaces/default/secrets/my%20name') // 编码段原样保留
})

test('点段逃逸拒绝(原始与解码两层)', () => {
  bad('/api/v1/namespaces/default/pods/../../kube-system/secrets')
  bad('/api/v1/namespaces/default/pods/../../../persistentvolumes')
  bad('/api/v1/namespaces/default/pods/%2e%2e/%2e%2e/kube-system/secrets')
  bad('/api/v1/namespaces/./pods')
})

test('换主机形态拒绝', () => {
  bad('//evil.test/namespaces/default/pods')
  bad('https://evil.test/api/v1/namespaces/default/pods')
  bad('/api/v1/namespaces/default/..\\..\\kube-system')
})

test('返回值:raw 原样、decoded 可供 ns 校验', () => {
  const r = assertSafeApiPath('/api/v1/namespaces/default/secrets/my%20name')
  assert.equal(r.raw, '/api/v1/namespaces/default/secrets/my%20name')
  assert.equal(r.decoded, '/api/v1/namespaces/default/secrets/my name')
})
