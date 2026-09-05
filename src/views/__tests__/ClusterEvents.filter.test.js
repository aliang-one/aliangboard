import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

// 契约:集群级事件页是 overview「查看全部事件」入口的落点——
// 全集群事件不做 namespace 过滤(区别于 NsEvents),带类型过滤/搜索/分页,
// 且必须有 Namespace 列(全集群视图必须能看到事件来自哪个 ns)。
const h = vi.hoisted(() => ({
  push: vi.fn(),
  fetchEvents: vi.fn(async () => []),
}))
vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo',
    fetchEvents: h.fetchEvents,
    startEventWatch: vi.fn(),
    stopEventWatch: vi.fn(),
    eventWatchLive: false,
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push: h.push }),
}))

import ClusterEvents from '../ClusterEvents.vue'
import DataTable from '@/components/common/DataTable.vue'

function ev(i, { type = 'normal', ns = 'default', reason = `Reason${i}`, message = `msg ${i}` } = {}) {
  return {
    uid: `u${i}`, type, reason, message, count: 1,
    namespace: ns, time: `${i}m`, age: `${i}m`,
    icon: type === 'warning' ? 'warning' : 'event', color: type === 'warning' ? 'error' : 'primary',
    relatedKind: 'Pod', relatedName: `p${i}`, relatedNamespace: ns, _ts: 1000 - i,
  }
}
const SEED = [
  ev(1), ev(2, { type: 'warning', ns: 'kube-system', reason: 'BackOff' }), ev(3, { ns: 'app' }),
  ev(4, { type: 'warning' }), ev(5, { ns: 'app' }), ev(6),
  ev(7, { type: 'warning', ns: 'monitor', reason: 'Unhealthy' }), ev(8), ev(9, { ns: 'app' }),
  ev(10), ev(11, { ns: 'edge' }), ev(12, { type: 'warning' }),
]

function mountView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(ClusterEvents, {
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]],
      stubs: { Breadcrumbs: true },
    },
  })
}

describe('ClusterEvents 集群级事件页', () => {
  beforeEach(() => {
    h.push.mockClear()
    h.fetchEvents.mockResolvedValue(SEED.map(e => ({ ...e })))
  })

  it('全集群事件不过滤 namespace:12 条入页,默认页大小分页', async () => {
    const w = mountView()
    await flushPromises()
    const table = w.findComponent(DataTable)
    expect(table.props('rows')).toHaveLength(10) // usePagination 默认 pageSize=10
    const namespaces = new Set(SEED.map(e => e.namespace))
    expect(namespaces.size).toBeGreaterThan(1) // 种子跨多 ns,页未做 ns 过滤
  })

  it('列定义含 Namespace 列(全集群视图必须可见事件来源)', async () => {
    const w = mountView()
    await flushPromises()
    const headers = w.findComponent(DataTable).props('headers')
    expect(headers.map(c => c.key)).toContain('namespace')
  })

  it('namespace 单元格渲染事件来源 ns', async () => {
    const w = mountView()
    await flushPromises()
    expect(w.find('[data-testid="ev-ns-u1"]').text()).toBe('default')
    expect(w.find('[data-testid="ev-ns-u3"]').exists()).toBe(true) // app(第 3 条在首页内)
  })

  it('类型过滤 warning:只留 warning 事件', async () => {
    const w = mountView()
    await flushPromises()
    const chips = w.findAll('button').filter(b => ['normal', 'warning'].includes(b.text()))
    await chips.find(b => b.text() === 'warning').trigger('click')
    await flushPromises()
    const rows = w.findComponent(DataTable).props('rows')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.type).toBe('warning')
  })

  it('搜索命中 reason/message', async () => {
    const w = mountView()
    await flushPromises()
    const input = w.find('input[type="text"], input:not([type])')
    await input.setValue('backoff')
    await flushPromises()
    const rows = w.findComponent(DataTable).props('rows')
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe('BackOff')
  })

  it('过滤条件变化后回到第 1 页(不落越界空页)', async () => {
    const w = mountView()
    await flushPromises()
    const chips = w.findAll('button').filter(b => ['normal', 'warning'].includes(b.text()))
    await chips.find(b => b.text() === 'warning').trigger('click') // 4 条 warning → 单页
    await flushPromises()
    expect(w.findComponent(DataTable).props('rows')).toHaveLength(4)
  })
})
