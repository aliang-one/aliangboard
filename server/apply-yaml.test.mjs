// apply-yaml 内核单测:defaultNs 缺省补齐语义 + 抽取回归(requestFn mock,无需真集群)。
// 语义:namespaced 资源 ns = metadata.namespace || defaultNs || 'default';集群级 kind 忽略后两者。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createApplyYaml } from './apply-yaml.mjs'

const session = { apiServer: 'https://k8s.example:6443' }
const DEPLOY_YAML = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d1\n'

// mock requestFn:记录每次调用;discovery 返回 apps/v1 与 core v1 的资源表;PATCH 回声。
function makeK8s() {
  const calls = []
  const requestFn = async (s, path, init = {}) => {
    calls.push({ path, method: init.method || 'GET' })
    if (path === '/apis/apps/v1') return { body: { resources: [{ kind: 'Deployment', name: 'deployments', namespaced: true }] } }
    if (path === '/api/v1') return { body: { resources: [
      { kind: 'Service', name: 'services', namespaced: true },
      { kind: 'Namespace', name: 'namespaces', namespaced: false },
    ] } }
    if (init.method === 'PATCH') return { body: { metadata: { name: 'echo' } } }
    throw new Error('mock: unexpected ' + path)
  }
  return { requestFn, calls }
}

test('applyYaml: namespaced 缺 ns → 补 defaultNs 到路径与 label', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  const r = await applyYaml(session, DEPLOY_YAML, 'demo')
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/namespaces/demo/deployments/d1?'), patch.path)
  assert.deepEqual(r.applied, [{ kind: 'Deployment', name: 'd1', namespace: 'demo' }])
  assert.equal(r.failed.length, 0)
  assert.equal(r.total, 1)
})

test('applyYaml: 显式 ns → 不覆盖', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  const r = await applyYaml(session, DEPLOY_YAML + '  namespace: other\n', 'demo')
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/namespaces/other/deployments/d1?'), patch.path)
  assert.equal(r.applied[0].namespace, 'other')
})

test('applyYaml: 集群级 kind(Namespace) → 忽略 defaultNs,无 /namespaces/ 段', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  const yaml = 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: new-ns\n'
  const r = await applyYaml(session, yaml, 'demo')
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/api/v1/namespaces/new-ns?'), patch.path)
  assert.equal(r.applied[0].namespace, undefined)
})

test('applyYaml: 不传 defaultNs → 落 default(兼容回归)', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  await applyYaml(session, DEPLOY_YAML)
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/namespaces/default/deployments/d1?'), patch.path)
})

test('applyYaml: defaultNs 空串 → 同样落 default(无特判)', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  await applyYaml(session, DEPLOY_YAML, '')
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/namespaces/default/deployments/d1?'), patch.path)
})

test('applyYamlPartial: 同语义(ns 补齐 + label 报补齐值)', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYamlPartial } = createApplyYaml({ requestKubernetes: requestFn })
  const r = await applyYamlPartial(session, DEPLOY_YAML, 'demo')
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/namespaces/demo/deployments/d1?'), patch.path)
  assert.deepEqual(r.applied, [{ kind: 'Deployment', name: 'd1', namespace: 'demo' }])
  assert.equal(r.total, 1)
})

test('applyYaml: 多文档混合(缺ns/显式ns/集群级)逐资源正确', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  const yaml = [
    'apiVersion: v1\nkind: Service\nmetadata:\n  name: s1',
    'apiVersion: v1\nkind: Service\nmetadata:\n  name: s2\n  namespace: other',
    'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: n1',
  ].join('\n---\n') + '\n'
  const r = await applyYaml(session, yaml, 'demo')
  const patches = calls.filter(c => c.method === 'PATCH').map(c => c.path)
  assert.equal(patches.length, 3)
  assert.ok(patches[0].includes('/namespaces/demo/services/s1?'), patches[0])
  assert.ok(patches[1].includes('/namespaces/other/services/s2?'), patches[1])
  assert.ok(patches[2].includes('/api/v1/namespaces/n1?'), patches[2])
  assert.deepEqual(r.applied.map(a => a.namespace), ['demo', 'other', undefined])
})

test('applyYaml: discovery 缓存——同实例第二次 apply 不再发 discovery 请求', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  await applyYaml(session, DEPLOY_YAML, 'demo')
  await applyYaml(session, DEPLOY_YAML, 'demo')
  assert.equal(calls.filter(c => c.path === '/apis/apps/v1').length, 1)
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 2)
})

test('applyYaml: 空 yaml → 抛错(/api/apply handler catch → 422)', async () => {
  const { requestFn } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  await assert.rejects(applyYaml(session, ''), /没有可应用的资源/)
})

test('applyYamlPartial: 空 yaml → 不抛,返回空结果 total:0', async () => {
  const { requestFn } = makeK8s()
  const { applyYamlPartial } = createApplyYaml({ requestKubernetes: requestFn })
  const r = await applyYamlPartial(session, '')
  assert.deepEqual(r, { applied: [], failed: [], total: 0 })
})
