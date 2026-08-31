// NsWorkloadDetail 版本区紧凑化测试:锁定「左列卡 指标+操作 合并行」与「中列详情面板 合并行」
// 的结构现状(规格 docs/superpowers/specs/2026-08-30-workload-overview-compact-design.md)。
// mock 策略与 NsWorkloadDetail.edit-shell.test.js 一致(mock @/api/client 与 @/stores/cluster,
// 真实 i18n + Vue Query),额外 mock fetchWorkloadRevisions 供左列版本卡渲染。
import { test, expect, vi } from 'vitest'
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
// Deployment + 两个 owned ReplicaSet 派生的 revision 形状(字段与 buildRevisions 输出一致)
const REVISIONS = [
  { rev: 3, image: 'nginx:1.25', sha: 'abc1234', age: '2d', reason: 'bump tag', current: true, replicas: 2, readyReplicas: 2, desiredReplicas: 2, rsName: 'demo-deploy-7d9f', rsUid: 'uid-3' },
  { rev: 2, image: 'nginx:1.24', sha: 'def5678', age: '5d', reason: 'prev', current: false, replicas: 0, readyReplicas: 0, desiredReplicas: 2, rsName: 'demo-deploy-5c8a', rsUid: 'uid-2' },
]
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  watchStateOf: () => 'off',
  currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [{
    name: 'demo-deploy', namespace: 'default', type: 'Deployment', labels: { app: 'demo' }, status: 'Running',
    raw: {
      metadata: { name: 'demo-deploy', namespace: 'default', labels: { app: 'demo' } },
      spec: {
        replicas: 1, selector: { matchLabels: { app: 'demo' } },
        template: { metadata: { labels: { app: 'demo' } }, spec: { containers: [{ name: 'main', image: 'nginx' }] } },
      },
    },
  }]),
  fetchPods: vi.fn(async () => []),
  fetchWorkloadRevisions: vi.fn(async () => REVISIONS),
  fetchPVCs: vi.fn(async () => []),
  fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  updateWorkload: vi.fn(), applyWorkloadTemplate: vi.fn(),
  invalidateAllClusterQueries: vi.fn(async () => {}),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default', type: 'deployment' } }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true } } })
}

test('左列版本卡:期望/当前/就绪 与操作按钮在同一行容器(合并行)', async () => {
  const w = mountDetail()
  await flushPromises()
  const rows = w.findAll('[data-testid="rev-metrics-row"]')
  expect(rows.length).toBe(2)                       // 两张版本卡各一行
  const hist = rows[1]                              // rev2(非活跃):3 个操作按钮
  expect(hist.text()).toContain('期望')
  expect(hist.text()).toContain('当前')
  expect(hist.text()).toContain('就绪')
  expect(hist.findAll('button').length).toBe(3)     // 查看 YAML/回滚/删除 与指标同容器
  expect(rows[0].findAll('button').length).toBe(1)  // 活跃卡仅 查看 YAML
  w.unmount()
})
