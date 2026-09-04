import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

// 契约:集群视角(无 namespace)下点击 IngressClass 行 → IngressClassDetail;
// 展开行 YAML 降级只读(有损 generateYAML 不再是编辑面,编辑收敛到详情页 live YAML)。
const h = vi.hoisted(() => ({
  push: vi.fn(),
  fetchIngressClasses: vi.fn(async () => [{
    name: 'nginx', controller: 'k8s.io/ingress-nginx', isDefault: true, age: '30d',
  }]),
  generateYAML: vi.fn(() => 'kind: IngressClass\nmetadata:\n  name: nginx'),
}))
vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(async () => ({ templates: [] })), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo',
    setNamespace: () => {},
    fetchIngressClasses: h.fetchIngressClasses,
    generateYAML: h.generateYAML,
    deleteIngressClass: vi.fn(),
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push: h.push }),
}))

import IngressClasses from '../IngressClasses.vue'
import DataTable from '@/components/common/DataTable.vue'

function mountView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(IngressClasses, {
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]],
      stubs: { DeployIngressControllerDialog: true, Modal: true, Breadcrumbs: true },
    },
  })
}

describe('IngressClasses 行导航', () => {
  beforeEach(() => { h.push.mockClear() }) // 同文件用例共享 hoisted spy:不清则首例的 push 泄漏进「不被调用」断言
  it('row-click 整行跳 IngressClassDetail(集群视角无需 namespace)', async () => {
    const w = mountView()
    await flushPromises()
    w.findComponent(DataTable).vm.$emit('row-click', { name: 'nginx' })
    await flushPromises()
    expect(h.push).toHaveBeenCalledWith({ name: 'IngressClassDetail', params: { name: 'nginx' } })
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

  it('actions 列删除按钮 @click.stop:不冒泡成行导航(姊妹页同配方 Storage/RBAC/Namespaces)', async () => {
    const w = mountView()
    await flushPromises()
    const del = w.find('tbody button[title]')
    expect(del.exists()).toBe(true)
    await del.trigger('click')
    await flushPromises()
    expect(h.push).not.toHaveBeenCalled()
  })
})
