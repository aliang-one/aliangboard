import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

// 契约:RuntimeClass 与 IngressClass 同病同修——row-click → RuntimeClassDetail,展开行 YAML 只读。
const h = vi.hoisted(() => ({
  push: vi.fn(),
  fetchRuntimeClasses: vi.fn(async () => [{
    name: 'kata', handler: 'kata-runtime', age: '5d',
  }]),
  generateYAML: vi.fn(() => 'kind: RuntimeClass\nmetadata:\n  name: kata'),
}))
vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn() },
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo',
    setNamespace: () => {},
    fetchRuntimeClasses: h.fetchRuntimeClasses,
    generateYAML: h.generateYAML,
    deleteRuntimeClass: vi.fn(),
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push: h.push }),
}))

import RuntimeClasses from '../RuntimeClasses.vue'
import DataTable from '@/components/common/DataTable.vue'

function mountView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(RuntimeClasses, {
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]],
      stubs: { Modal: true, Breadcrumbs: true },
    },
  })
}

describe('RuntimeClasses 行导航', () => {
  beforeEach(() => { h.push.mockClear() }) // 同文件用例共享 hoisted spy:不清则首例的 push 泄漏进「不被调用」断言
  it('row-click 整行跳 RuntimeClassDetail', async () => {
    const w = mountView()
    await flushPromises()
    w.findComponent(DataTable).vm.$emit('row-click', { name: 'kata' })
    await flushPromises()
    expect(h.push).toHaveBeenCalledWith({ name: 'RuntimeClassDetail', params: { name: 'kata' } })
  })

  it('展开行 YAML 只读(有损 manifest 不再作为编辑面)', async () => {
    const w = mountView()
    await flushPromises()
    const toggle = w.find('[data-expand-toggle]')
    expect(toggle.exists()).toBe(true)
    await toggle.trigger('click')
    await flushPromises()
    const editors = w.findAllComponents({ name: 'YamlEditor' })
    expect(editors.length).toBeGreaterThan(0)
    for (const ed of editors) expect(ed.props('readonly')).toBe(true)
  })

  it('actions 列删除按钮 @click.stop:不冒泡成行导航', async () => {
    const w = mountView()
    await flushPromises()
    const del = w.find('tbody button[title]')
    expect(del.exists()).toBe(true)
    await del.trigger('click')
    await flushPromises()
    expect(h.push).not.toHaveBeenCalled()
  })
})
