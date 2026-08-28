import { test, expect } from 'vitest'
import { load as yamlLoad } from 'js-yaml'
import { yamlTemplates, CLUSTER_SCOPED_KINDS } from '@/utils/yamlTemplates'

test('共 14 个 kind 模板,键即 K8s kind 名', () => {
  expect(Object.keys(yamlTemplates).sort()).toEqual([
    'ClusterRole', 'ClusterRoleBinding', 'Deployment', 'HorizontalPodAutoscaler',
    'Ingress', 'LimitRange', 'Namespace', 'PersistentVolumeClaim', 'PodDisruptionBudget',
    'ResourceQuota', 'Role', 'RoleBinding', 'Service', 'ServiceAccount',
  ])
})

test('CLUSTER_SCOPED_KINDS 恰含 3 个集群级 kind', () => {
  expect([...CLUSTER_SCOPED_KINDS].sort()).toEqual(['ClusterRole', 'ClusterRoleBinding', 'Namespace'])
})

test('每个模板可被 js-yaml 解析、kind 与键一致、namespaced 模板 ns 插值生效', () => {
  for (const [kind, tpl] of Object.entries(yamlTemplates)) {
    const doc = yamlLoad(tpl('demo-ns'))
    expect(doc.kind, kind).toBe(kind)
    expect(doc.apiVersion, kind).toBeTruthy()
    expect(doc.metadata?.name, kind).toBeTruthy()
    if (CLUSTER_SCOPED_KINDS.has(kind)) {
      expect(doc.metadata?.namespace ?? null, kind).toBeNull() // 集群级:metadata 无 namespace 字段
    } else {
      expect(doc.metadata.namespace, kind).toBe('demo-ns')
    }
  }
})

test('Deployment 模板保留既有 my-app 示例(既有 dialog 测试断言依赖)', () => {
  const doc = yamlLoad(yamlTemplates.Deployment('demo-ns'))
  expect(doc.metadata.name).toBe('my-app')
  expect(doc.spec.template.spec.containers[0].image).toBe('nginx:latest')
})

test('RoleBinding 模板 subjects 的 SA 主体带当前 ns', () => {
  const doc = yamlLoad(yamlTemplates.RoleBinding('demo-ns'))
  expect(doc.roleRef.kind).toBe('Role')
  expect(doc.subjects[0].namespace).toBe('demo-ns')
})
