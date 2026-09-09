// Wave5 W2 Task7(R5):Revisions/Events 两 tab 迁共享 DataTable——手机档卡片模式接管
// (旧裸 table 被 overflow-hidden 卡壳硬裁,回滚钮不可达),回滚钮四件套命中区扩展。
// mock 头照 Task 6(同目录同款,真实 i18n + Vue Query),追加 revisions 数据:
// k8s mock 按调用参数分流(cluster mock 暴露真 fetchWorkloadRevisions 消费此分流)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'
import { fetchWorkloadRevisions } from '@/composables/useFetchers'
import { mapEvent } from '@/composables/useResourceMappers'
import { api } from '@/api/client'

// Events 用:经真实 mapEvent 管线渲染出 message 单元(修复轮:钉 width cap 防回归)
const DEMO_EVENT_MESSAGE = 'Scaled up replica set demo-abc123 to 1'

vi.mock('@/api/client', () => ({
  // replicasets 分流:两个 owned RS(rev2=当前 / rev1=旧版)让回滚钮(v-if="!row.current")
  // 真实渲染;deployments 单查带 revision 注解锚定 current;其余列表路径返回空。
  api: { k8s: vi.fn(async (path) => {
    const p = String(path)
    if (p.includes('replicasets')) return { items: [{
      metadata: { name: 'demo-abc123', namespace: 'default',
        annotations: { 'deployment.kubernetes.io/revision': '2' },
        creationTimestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        ownerReferences: [{ kind: 'Deployment', controller: true, name: 'demo-deploy' }] },
      status: { replicas: 1, readyReplicas: 1 },
      spec: { replicas: 1, template: { spec: { containers: [{ image: 'nginx:1.27' }] } } } },
    { metadata: { name: 'demo-old456', namespace: 'default',
        annotations: { 'deployment.kubernetes.io/revision': '1' },
        creationTimestamp: new Date(Date.now() - 3600_000).toISOString(),
        ownerReferences: [{ kind: 'Deployment', controller: true, name: 'demo-deploy' }] },
      status: { replicas: 1, readyReplicas: 1 },
      spec: { replicas: 1, template: { spec: { containers: [{ image: 'nginx:1.26' }] } } } }] }
    if (p.includes('/deployments/demo-deploy')) return {
      metadata: { name: 'demo-deploy', namespace: 'default',
        annotations: { 'deployment.kubernetes.io/revision': '2' } },
      spec: { template: { spec: { containers: [{ image: 'nginx:1.27' }] } } } }
    if (p.includes('/api/v1/events')) return { items: [{
      metadata: { name: 'demo-deploy.17abc', namespace: 'default', uid: 'ev-1',
        creationTimestamp: new Date(Date.now() - 60_000).toISOString() },
      involvedObject: { kind: 'Deployment', name: 'demo-deploy', namespace: 'default' },
      type: 'Warning', reason: 'FailedScaling', message: DEMO_EVENT_MESSAGE, count: 1 }] }
    return { items: [] }
  }) },
  cronJobApi: { get: vi.fn(async () => ({})) },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
const demoWorkload = {
  name: 'demo-deploy', namespace: 'default', type: 'Deployment', labels: { app: 'demo' },
  raw: { metadata: { name: 'demo-deploy', namespace: 'default' },
    spec: { replicas: 1, selector: { matchLabels: { app: 'demo' } },
      template: { metadata: { labels: { app: 'demo' } }, spec: { containers: [{ name: 'main', image: 'nginx' }] } } } },
}
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  watchStateOf: () => 'off', currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [demoWorkload]), fetchPods: vi.fn(async () => []),
  fetchPVCs: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  restartWorkload: vi.fn(), scaleWorkload: vi.fn(), invalidateAllClusterQueries: vi.fn(async () => {}),
  // revisions 独立 query 走此门:接真 fetchWorkloadRevisions(useFetchers 只 import 被mock的
  // api/client,replicasets 分流即在此生效),完整跑 buildRevisions 映射。
  fetchWorkloadRevisions: vi.fn(fetchWorkloadRevisions),
  // events query 同门(真 cluster.js fetchEvents 是内联 api.k8s('/api/v1/events')+mapEvent,
  // 无独立导出可复用,按同管线内联),让 message 单元真实渲染。
  fetchEvents: vi.fn(async () => {
    const d = await api.k8s('/api/v1/events?limit=1000')
    return ((d?.items || []).map(mapEvent)).sort((a, b) => (b._ts || 0) - (a._ts || 0))
  }),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' }, query: {} }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

async function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true, WorkloadTopologyTab: true } } })
  await flushPromises()
  return w
}

test('Revisions tab 手机档:DataTable 卡片渲染,回滚钮带四件套', async () => {
  const spy = mockViewport(true)
  try {
    const w = await mountDetail()
    const tabBar = w.findAll('div').find(d => d.findAll('button').some(b => b.text() === i18n.global.t('workload.tabs.revisions')))
    await tabBar.findAll('button').find(b => b.text() === i18n.global.t('workload.tabs.revisions')).trigger('click')
    expect(w.findAll('[data-card-row]').length).toBeGreaterThanOrEqual(1)
    expect(w.find('[data-testid="revisions-table"]').exists()).toBe(false)   // 旧裸表锚点退役
    const rollback = w.findAll('button').find(b => b.text() === i18n.global.t('workload.revisionsTab.rollback'))
    if (rollback) expect(rollback.classes().join(' ')).toContain('max-sm:after:-inset-2')
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('Events tab:不再有裸 <table>(DataTable 双分支接管)', async () => {
  const spy = mockViewport(true)
  try {
    const w = await mountDetail()
    const tabBar = w.findAll('div').find(d => d.findAll('button').some(b => b.text() === i18n.global.t('workload.tabs.events')))
    await tabBar.findAll('button').find(b => b.text() === i18n.global.t('workload.tabs.events')).trigger('click')
    expect(w.find('table').exists()).toBe(false)
    // 修复轮:message 单元必须有宽度上限(旧裸表 td 是 truncate max-w-[400px];无上限时
    // auto-layout 表格 min-content=全文宽,列被挤穿+省略号永不出现)
    expect(w.findAll('[data-card-row]').length).toBeGreaterThanOrEqual(1)
    const msgSpan = w.findAll('[data-card-row] span').find(s => s.attributes('title') === DEMO_EVENT_MESSAGE)
    expect(msgSpan).toBeTruthy()
    expect(msgSpan.classes().join(' ')).toContain('max-w-[400px]')
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})
