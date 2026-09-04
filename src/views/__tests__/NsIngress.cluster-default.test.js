// NsIngress 创建弹窗「集群默认」选项回归(2026-09-04 集群默认不变式,spec §3.4):
//   有默认类 → option 可选,value=显式默认类名;无默认 → disabled + hint;无类 → 维持空态 option。
//   预填语义(pickIngressClassName watch)不受本选项影响。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const state = vi.hoisted(() => ({ classes: [] }))
vi.mock('@/api/client', () => ({ api: { k8s: vi.fn(async () => ({ items: [] })) } }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    watchStateOf: () => 'off', currentCluster: 'demo', setNamespace: () => {},
    fetchIngresses: vi.fn(async () => []), fetchServices: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
    fetchIngressClasses: vi.fn(async () => state.classes),
    addIngress: vi.fn(async () => ({ ok: true })),
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'demo' } }), useRouter: () => ({ push: () => {} }) }))

import NsIngress from '../NsIngress.vue'

function mountView() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(NsIngress, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Modal: { props: ['modelValue', 'title', 'width'], emits: ['update:modelValue', 'cancel'], template: '<div><slot/><slot name="actions"/></div>' }, Breadcrumbs: true, Pagination: true, PortSelect: true, AnnotationKeySelect: true, DataTable: true, IngressRulesEditor: true, IngressPerfField: true, CreateWithYamlButton: true } } })
  return { w, qc }
}

test('有默认类 → 集群默认 option 可选,value=默认类名,跟随名可见', async () => {
  state.classes = [{ name: 'a' }, { name: 'nginx', isDefault: true }]
  const { w } = mountView()
  await flushPromises()
  const opt = w.find('[data-testid="ingress-cluster-default-option"]')
  expect(opt.exists()).toBe(true)
  expect(opt.attributes('disabled')).toBeUndefined()
  expect(opt.element.value).toBe('nginx')
  expect(opt.text()).toContain('nginx')
})

test('无默认类 → option disabled + hint 渲染', async () => {
  state.classes = [{ name: 'a' }]
  const { w } = mountView()
  await flushPromises()
  const opt = w.find('[data-testid="ingress-cluster-default-option"]')
  expect(opt.attributes('disabled')).toBeDefined()
  expect(w.find('[data-testid="ingress-cluster-default-hint"]').exists()).toBe(true)
})

test('有默认 → 选中「集群默认」即表单 className=显式默认类名', async () => {
  state.classes = [{ name: 'a' }, { name: 'nginx', isDefault: true }]
  const { w } = mountView()
  await flushPromises()
  await w.find('[data-testid="ingress-class-select"]').setValue('nginx')
  expect(w.vm.createForm.className).toBe('nginx')
})
