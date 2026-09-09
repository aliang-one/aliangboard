import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

// 契约:B8b 功能缺口修复——手机卡片模式点卡无反应,补 row-click → PriorityClassDetail;
// 行内 open/delete 钮均 @click.stop 不冒泡成行导航。
const h = vi.hoisted(() => ({
  push: vi.fn(),
  fetchPriorityClasses: vi.fn(async () => [
    { name: 'high-prio', value: 1000000, globalDefault: false, age: '5d' },
    { name: 'system-cluster-critical', value: 2000000000, globalDefault: false, age: '99d' },
  ]),
  generateExtraYAML: vi.fn(() => 'kind: PriorityClass\nmetadata:\n  name: high-prio'),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo',
    fetchPriorityClasses: h.fetchPriorityClasses,
    generateExtraYAML: h.generateExtraYAML,
    addPriorityClass: vi.fn(),
    deletePriorityClass: vi.fn(),
    promotePriorityClassDefault: vi.fn(),
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push: h.push }),
}))

import PriorityClasses from '../PriorityClasses.vue'
import DataTable from '@/components/common/DataTable.vue'

function mountView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(PriorityClasses, {
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]],
      stubs: { Modal: true, Breadcrumbs: true },
    },
  })
}

describe('PriorityClasses 行导航', () => {
  beforeEach(() => { h.push.mockClear() })
  it('row-click 整行跳 PriorityClassDetail(手机卡片模式点卡可达)', async () => {
    const w = mountView()
    await flushPromises()
    w.findComponent(DataTable).vm.$emit('row-click', { name: 'high-prio' })
    await flushPromises()
    expect(h.push).toHaveBeenCalledWith({ name: 'PriorityClassDetail', params: { name: 'high-prio' } })
  })

  it('actions 列 open 钮 @click.stop:自身导航一次,不冒泡成 row-click 双跳', async () => {
    const w = mountView()
    await flushPromises()
    const open = w.findAll('tbody button[title]').find(b => b.text().includes('open_in_new'))
    expect(open.exists()).toBe(true)
    await open.trigger('click')
    await flushPromises()
    expect(h.push).toHaveBeenCalledTimes(1)
    expect(h.push.mock.calls[0][0].name).toBe('PriorityClassDetail')
  })

  it('actions 列 delete 钮 @click.stop:开确认弹窗,不冒泡成行导航', async () => {
    const w = mountView()
    await flushPromises()
    const del = w.findAll('tbody button[title]').find(b => b.text().includes('delete') && !b.attributes('disabled'))
    expect(del.exists()).toBe(true)
    await del.trigger('click')
    await flushPromises()
    expect(h.push).not.toHaveBeenCalled()
  })
})
