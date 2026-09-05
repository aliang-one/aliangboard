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
  promoteIngressClassDefault: vi.fn(async () => ({ ok: true })),
  demoteIngressClassDefault: vi.fn(async () => ({ ok: true })),
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
    promoteIngressClassDefault: h.promoteIngressClassDefault,
    demoteIngressClassDefault: h.demoteIngressClassDefault,
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
  beforeEach(() => { // 同文件用例共享 hoisted spy:不清则首例的 push 泄漏进「不被调用」断言
    h.push.mockClear()
    h.promoteIngressClassDefault.mockClear()
    h.demoteIngressClassDefault.mockClear()
    h.fetchIngressClasses.mockResolvedValue([{ name: 'nginx', controller: 'k8s.io/ingress-nginx', isDefault: true, age: '30d' }])
  })
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
    const del = w.find('[data-testid="ic-delete"]')
    expect(del.exists()).toBe(true)
    await del.trigger('click')
    await flushPromises()
    expect(h.push).not.toHaveBeenCalled()
  })
})

// 行级「设为集群默认」+「编辑」(2026-09-05):⭐ 就位切换(promote/demote sweep 语义),✏ 显式跳详情
describe('IngressClasses 行级默认/编辑操作', () => {
  beforeEach(() => {
    h.push.mockClear()
    h.promoteIngressClassDefault.mockClear()
    h.demoteIngressClassDefault.mockClear()
    h.fetchIngressClasses.mockResolvedValue([{ name: 'nginx', controller: 'k8s.io/ingress-nginx', isDefault: true, age: '30d' }])
  })

  it('已是默认的行:⭐ 高亮,点击调 demote(不导航、不 promote)', async () => {
    const w = mountView()
    await flushPromises()
    const star = w.find('[data-testid="ic-toggle-default"]')
    expect(star.exists()).toBe(true)
    await star.trigger('click')
    await flushPromises()
    expect(h.demoteIngressClassDefault).toHaveBeenCalledWith('nginx')
    expect(h.promoteIngressClassDefault).not.toHaveBeenCalled()
    expect(h.push).not.toHaveBeenCalled()
  })

  it('非默认的行:⭐ 点击调 promote(sweep 摘旧默认),不导航', async () => {
    h.fetchIngressClasses.mockResolvedValue([{ name: 'apisix', controller: 'c', isDefault: false, age: '1d' }])
    const w = mountView()
    await flushPromises()
    const star = w.find('[data-testid="ic-toggle-default"]')
    expect(star.exists()).toBe(true)
    await star.trigger('click')
    await flushPromises()
    expect(h.promoteIngressClassDefault).toHaveBeenCalledWith('apisix')
    expect(h.demoteIngressClassDefault).not.toHaveBeenCalled()
    expect(h.push).not.toHaveBeenCalled()
  })

  it('✏ 编辑钮:跳 IngressClassDetail(显式编辑入口)', async () => {
    const w = mountView()
    await flushPromises()
    const edit = w.find('[data-testid="ic-edit"]')
    expect(edit.exists()).toBe(true)
    await edit.trigger('click')
    await flushPromises()
    expect(h.push).toHaveBeenCalledWith({ name: 'IngressClassDetail', params: { name: 'nginx' } })
    expect(h.promoteIngressClassDefault).not.toHaveBeenCalled()
    expect(h.demoteIngressClassDefault).not.toHaveBeenCalled()
  })
})
