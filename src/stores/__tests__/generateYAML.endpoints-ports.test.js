import { test, expect, beforeAll, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load } from 'js-yaml'

// generateYAML endpoints 分支的端口 name 无损:
//   有 name 的端口必须回写 name(NsEndpoints.vue:99 用它做可编辑 YAML 的内容,
//   丢了 name → 编辑保存后多端口被 K8s 拒 / Service named-port 映射断裂)。
//   匿名端口保持匿名(单端口合法,不自动补名——与 Service 端口自动补名不同:
//   Endpoints 无 Service 上下文,擅自补名反而破坏与既有 Service 端口名的对应)。
// 背景:2026-08-17 系统审计 P1-B。

vi.mock('@/api/client', () => ({
  api: { applyYaml: vi.fn(), k8s: vi.fn() },
  k8sStream: vi.fn(),
  portForwardApi: {},
  getSavedClusters: vi.fn(() => []),
  addSavedCluster: vi.fn(),
  removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(),
  activeApiServer: vi.fn(() => ''),
  getSessionToken: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useClusterStore } from '@/stores/cluster'

let store
beforeAll(() => {
  setActivePinia(createPinia())
  store = useClusterStore()
})

test('有名端口:name 回写进 YAML(多端口场景)', () => {
  const y = store.generateYAML('endpoints', {
    name: 'svc-a', namespace: 'demo',
    addresses: ['10.1.2.3'],
    ports: [
      { name: 'http', port: 80, protocol: 'TCP' },
      { name: 'metrics', port: 9090, protocol: 'TCP' },
    ],
  })
  const ep = load(y)
  expect(ep.subsets[0].ports).toEqual([
    { name: 'http', port: 80, protocol: 'TCP' },
    { name: 'metrics', port: 9090, protocol: 'TCP' },
  ])
})

test('匿名端口:保持匿名(name 不输出,无损)', () => {
  const y = store.generateYAML('endpoints', {
    name: 'svc-b', namespace: 'demo',
    addresses: ['10.1.2.4'],
    ports: [{ name: '', port: 53, protocol: 'UDP' }],
  })
  const ep = load(y)
  expect(ep.subsets[0].ports).toEqual([{ port: 53, protocol: 'UDP' }])
})

test('回写闭环:mapper 提取 → generateYAML 回写,name 一致', () => {
  const src = [
    { name: 'http', port: 80, protocol: 'TCP' },
    { name: 'grpc', port: 9000, protocol: 'TCP' },
  ]
  const y = store.generateYAML('endpoints', { name: 'svc-c', namespace: 'demo', addresses: ['10.0.0.1'], ports: src })
  const ep = load(y)
  expect(ep.subsets[0].ports.map(p => p.name)).toEqual(['http', 'grpc'])
})
