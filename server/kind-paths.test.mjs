// kind→API 路径单一事实源(2026-08-26 根治「不支持的 kind」):
// KIND_API 与 kindAlias.CANONICAL_KINDS 必须严格同集——历史上 5 份表拷贝漂移过两次,
// 本守卫让「词表加了、路径表没加」(或反之)在测试期即暴露,不再等运行期报障。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KIND_API, listApiPath, getApiPath } from './kind-paths.mjs'
import { CANONICAL_KINDS } from './kindAlias.mjs'

test('KIND_API 与 CANONICAL_KINDS 严格同集(防再漂移守卫)', () => {
  assert.deepEqual([...Object.keys(KIND_API)].sort(), [...CANONICAL_KINDS].sort())
})

test('金路径:2026-08-26 报障场景原样', () => {
  assert.equal(getApiPath('cronjobs', 'kube-system', 'descheduler'), '/apis/batch/v1/namespaces/kube-system/cronjobs/descheduler')
  assert.equal(getApiPath('nodes', '', 'k8s-master3'), '/api/v1/nodes/k8s-master3')
})

test('getApiPath:ns-scoped kind 带 ns 段,集群级 kind 无', () => {
  assert.equal(getApiPath('pods', 'default', 'web-1'), '/api/v1/namespaces/default/pods/web-1')
  assert.equal(getApiPath('deployments', 'default', 'nginx'), '/apis/apps/v1/namespaces/default/deployments/nginx')
  assert.equal(getApiPath('clusterroles', '', 'admin'), '/apis/rbac.authorization.k8s.io/v1/clusterroles/admin')
  assert.equal(getApiPath('clusterrolebindings', '', 'x'), '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/x')
  assert.equal(getApiPath('storageclasses', '', 'standard'), '/apis/storage.k8s.io/v1/storageclasses/standard')
  // 集群级 kind 传了 ns 也忽略(nodes/PV/SC/ns 本身无 ns 概念)
  assert.equal(getApiPath('nodes', 'default', 'n1'), '/api/v1/nodes/n1')
})

test('listApiPath:ns-scoped 给 ns 收窄,不给 ns 集群级;集群级恒集群级', () => {
  assert.equal(listApiPath('pods', 'default'), '/api/v1/namespaces/default/pods')
  assert.equal(listApiPath('pods', ''), '/api/v1/pods')
  assert.equal(listApiPath('cronjobs', 'kube-system'), '/apis/batch/v1/namespaces/kube-system/cronjobs')
  assert.equal(listApiPath('nodes', 'default'), '/api/v1/nodes')
  assert.equal(listApiPath('jobs', ''), '/apis/batch/v1/jobs')
})

test('未知 kind → null', () => {
  assert.equal(listApiPath('widget', ''), null)
  assert.equal(getApiPath('widget', 'default', 'x'), null)
  assert.equal(listApiPath('', ''), null)
})
