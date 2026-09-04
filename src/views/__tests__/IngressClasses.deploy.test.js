import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(async () => ({ templates: [] })), manifest: vi.fn() } },
}))
// 创建即设默认必须走 sweep(I-2):addIngressClass 恒 isDefault:false,成功后 promoteIngressClassDefault(name)
const h = vi.hoisted(() => ({
  addIngressClass: vi.fn(async () => ({ ok: true })),
  promoteIngressClassDefault: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo',
    fetchIngressClasses: vi.fn(async () => []),
    setNamespace: () => {},
    addIngressClass: h.addIngressClass,
    promoteIngressClassDefault: h.promoteIngressClassDefault,
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import IngressClasses from '../IngressClasses.vue'

test('IngressClasses 有「部署控制器」按钮,点击打开弹窗', async () => {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(IngressClasses, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { DeployIngressControllerDialog: { template: '<div data-testid="deploy-dlg"/>' }, Modal: true, Breadcrumbs: true, Pagination: true } } })
  await flushPromises()
  const btn = w.find('[data-testid="deploy-controller-btn"]')
  expect(btn.exists()).toBe(true)
  await btn.trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="deploy-dlg"]').exists()).toBe(true)
})

// I-2 回归:勾默认创建 → add 恒 isDefault:false + 成功后 promote(name)(sweep 防双默认)
const ModalStub = { name: 'Modal', props: ['modelValue'], template: '<div v-if="modelValue"><slot/><slot name="actions"/></div>' }

test('创建勾选默认:addIngressClass 恒 isDefault:false,成功后走 promoteIngressClassDefault', async () => {
  h.addIngressClass.mockClear(); h.promoteIngressClassDefault.mockClear()
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(IngressClasses, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { DeployIngressControllerDialog: true, Modal: ModalStub, Breadcrumbs: true, Pagination: true } } })
  await flushPromises()
  await w.find('[data-testid="ic-create-open"]').trigger('click')
  await flushPromises()
  const inputs = w.findAll('input[type="text"], input:not([type])')
  await inputs[0].setValue('my-ic')
  await w.find('input[type="checkbox"]').setValue(true)
  await w.find('[data-testid="ic-create-submit"]').trigger('click')
  await flushPromises()
  expect(h.addIngressClass).toHaveBeenCalledTimes(1)
  expect(h.addIngressClass).toHaveBeenCalledWith(expect.objectContaining({ name: 'my-ic', isDefault: false }))
  expect(h.promoteIngressClassDefault).toHaveBeenCalledWith('my-ic')
})

test('创建未勾默认:成功后不调 promoteIngressClassDefault', async () => {
  h.addIngressClass.mockClear(); h.promoteIngressClassDefault.mockClear()
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(IngressClasses, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { DeployIngressControllerDialog: true, Modal: ModalStub, Breadcrumbs: true, Pagination: true } } })
  await flushPromises()
  await w.find('[data-testid="ic-create-open"]').trigger('click')
  await flushPromises()
  const inputs = w.findAll('input[type="text"], input:not([type])')
  await inputs[0].setValue('plain-ic')
  await w.find('[data-testid="ic-create-submit"]').trigger('click')
  await flushPromises()
  expect(h.addIngressClass).toHaveBeenCalledWith(expect.objectContaining({ name: 'plain-ic', isDefault: false }))
  expect(h.promoteIngressClassDefault).not.toHaveBeenCalled()
})
