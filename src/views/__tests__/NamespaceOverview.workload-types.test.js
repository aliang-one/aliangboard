import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'

// 回归:NamespaceOverview 曾只渲染 type==='Deployment',把 StatefulSet / DaemonSet 全部丢弃,
// 导致 anydoor 下的 MySQL(StatefulSet) 等有状态负载在分层拓扑里看不到。
// fetchWorkloads 明明返回了三类工作负载,根因在视图层硬过滤(NamespaceOverview.vue:53)。

// 三类工作负载各一个,均落在 anydoor 命名空间;raw 带 status/spec 供 healthOf 读取。
const fixtures = [
  { name: 'web-app', namespace: 'anydoor', type: 'Deployment', image: 'nginx:1.25', labels: {}, annotations: {}, age: '1d',
    raw: { spec: { replicas: 2, template: { spec: { containers: [{ image: 'nginx:1.25' }] }, metadata: { labels: {} } } }, status: { replicas: 2, readyReplicas: 2, updatedReplicas: 2 } } },
  { name: 'mysql', namespace: 'anydoor', type: 'StatefulSet', image: 'mysql:8.0', labels: {}, annotations: {}, age: '2d',
    raw: { spec: { replicas: 1, serviceName: 'mysql', template: { spec: { containers: [{ image: 'mysql:8.0' }] }, metadata: { labels: {} } } }, status: { replicas: 1, readyReplicas: 1, updatedReplicas: 1 } } },
  { name: 'fluentd', namespace: 'anydoor', type: 'DaemonSet', image: 'fluentd:v1', labels: {}, annotations: {}, age: '3d',
    raw: { spec: { template: { spec: { containers: [{ image: 'fluentd:v1' }] }, metadata: { labels: {} } } }, status: { desiredNumberScheduled: 3, currentNumberScheduled: 3, numberReady: 3, updatedNumberScheduled: 3 } } },
  // 其它命名空间的工作负载必须被过滤掉
  { name: 'mysql-other', namespace: 'kube-system', type: 'StatefulSet', image: 'mysql:8.0', labels: {}, annotations: {}, age: '5d',
    raw: { spec: { replicas: 1, serviceName: 'x', template: { spec: { containers: [{ image: 'mysql:8.0' }] }, metadata: { labels: {} } } }, status: { replicas: 1, readyReplicas: 1, updatedReplicas: 1 } } },
]

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c',
    setNamespace: vi.fn(),
    fetchWorkloads: vi.fn(async () => fixtures),
    fetchServices: vi.fn(async () => []),
    fetchIngresses: vi.fn(async () => []),
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'anydoor' } }), useRouter: () => ({ push: vi.fn() }) }))
// createI18n 须一并 stub:NamespaceOverview 经 CopyWorkloadDialog → useResourceApply → @/i18n
// 会触发 createI18n 调用,只 mock useI18n 会报 "No createI18n export"。
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }), createI18n: () => ({ global: { t: (k) => k } }) }))

import NamespaceOverview from '../NamespaceOverview.vue'

const mountView = () => mount(NamespaceOverview, {
  global: {
    plugins: [[VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } }) }]],
    stubs: { Breadcrumbs: true, SplitButton: true, CreateFromYamlDialog: true, CopyWorkloadDialog: true },
  },
})
const flush = (ms = 120) => new Promise(r => setTimeout(r, ms))

describe('NamespaceOverview 工作负载类型覆盖', () => {
  it('渲染 Deployment + StatefulSet + DaemonSet,过滤掉其它 ns', async () => {
    const w = mountView()
    await flush()
    const text = w.text()
    expect(text).toContain('web-app')   // Deployment
    expect(text).toContain('mysql')     // StatefulSet(回归:曾被过滤掉)
    expect(text).toContain('fluentd')   // DaemonSet(回归:曾被过滤掉)
    expect(text).not.toContain('mysql-other') // 其它 ns 被过滤
  })
})
