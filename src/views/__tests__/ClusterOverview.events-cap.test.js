import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

// 契约:overview「最近事件」侧栏只渲染最新 8 条(页面不再被全量事件撑长),
// header 徽标仍显示全量总数;「查看全部事件」按钮跳集群级事件页 /cluster/events
// (不再误跳平台审计日志 /audit-logs)。
const h = vi.hoisted(() => ({
  push: vi.fn(),
  fetchEvents: vi.fn(async () => []),
  fetchNodes: vi.fn(async () => []),
  fetchPods: vi.fn(async () => []),
}))
vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo',
    cluster: { name: 'demo' },
    clusterHealth: { severity: 'ok', status: 'Healthy', controlPlane: { ready: 1, total: 1 } },
    watchStateOf: () => ref('idle'),
    fetchEvents: h.fetchEvents,
    fetchNodes: h.fetchNodes,
    fetchPods: h.fetchPods,
    startMetricsSampling: vi.fn(),
    stopMetricsSampling: vi.fn(),
  }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: h.push }),
}))

import ClusterOverview from '../ClusterOverview.vue'

function ev(i) {
  return {
    uid: `u${i}`, type: 'normal', reason: `Reason${i}`, message: `msg ${i}`, count: 1,
    namespace: 'default', time: `${i}m`, age: `${i}m`, icon: 'event', color: 'primary',
    relatedKind: 'Pod', relatedName: `p${i}`, relatedNamespace: 'default', _ts: 1000 - i,
  }
}

function mountView(events) {
  h.fetchEvents.mockResolvedValue(events)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(ClusterOverview, {
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]],
      stubs: { AreaLineChart: true, RingGauge: true, ProgressBar: true, RouterLink: true },
    },
  })
}

describe('ClusterOverview 最近事件侧栏封顶', () => {
  beforeEach(() => {
    h.push.mockClear()
  })

  it('12 条事件只渲染最新 8 条,徽标仍显示全量 12', async () => {
    const w = mountView(Array.from({ length: 12 }, (_, i) => ev(i + 1)))
    await flushPromises()
    const items = w.findAll('[data-testid="recent-events-item"]')
    expect(items).toHaveLength(8)
    // 最新 8 条:种子按 _ts 降序,Reason1 最新
    expect(items[0].text()).toContain('Reason1')
    expect(w.find('[data-testid="recent-events-count"]').text()).toBe('12')
  })

  it('不足 8 条时全量渲染', async () => {
    const w = mountView([ev(1), ev(2)])
    await flushPromises()
    expect(w.findAll('[data-testid="recent-events-item"]')).toHaveLength(2)
  })

  it('「查看全部事件」跳集群级事件页,不再跳审计日志', async () => {
    const w = mountView([ev(1)])
    await flushPromises()
    await w.find('[data-testid="events-more-btn"]').trigger('click')
    await flushPromises()
    expect(h.push).toHaveBeenCalledWith('/cluster/events')
    expect(h.push).not.toHaveBeenCalledWith('/audit-logs')
  })
})
