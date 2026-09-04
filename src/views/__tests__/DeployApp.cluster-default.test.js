// DeployApp 向导 IngressClass「集群默认」选项回归(2026-09-04 集群默认不变式,spec §3.4):
//   有默认类 → option 可选,value=显式默认类名;无默认 → disabled + hint;预填语义不受影响。
//   DOM 断言须先开 form.createIngress(v-if 门控)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const state = vi.hoisted(() => ({ classes: [] }))
vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(), manifest: vi.fn() } },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  currentCluster: 'demo', watchStateOf: () => 'off', setNamespace: () => {},
  fetchIngressClasses: vi.fn(async () => state.classes),
  fetchNamespaces: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []), fetchPriorityClasses: vi.fn(async () => []),
  fetchServices: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []), fetchPVCs: vi.fn(async () => []),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployApp from '../DeployApp.vue'

function mountApp() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(DeployApp, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true, Breadcrumbs: true, PortSelect: true, EnvSourceField: true, VolumeMountCard: true, TagInput: true, AnnotationKeySelect: true } } })
  return { w, qc }
}

async function mountWithIngressOn() {
  const { w, qc } = mountApp()
  await flushPromises()
  await w.setData({ currentStep: 4, form: { ...w.vm.form, createIngress: true } })
  return { w, qc }
}

test('有默认类 → 集群默认 option 可选,value=默认类名,跟随名可见', async () => {
  state.classes = [{ name: 'a' }, { name: 'nginx', isDefault: true }]
  const { w } = await mountWithIngressOn()
  const opt = w.find('[data-testid="ingress-cluster-default-option"]')
  expect(opt.exists()).toBe(true)
  expect(opt.attributes('disabled')).toBeUndefined()
  expect(opt.element.value).toBe('nginx')
  expect(opt.text()).toContain('nginx')
})

test('无默认类 → option disabled + hint 渲染', async () => {
  state.classes = [{ name: 'a' }]
  const { w } = await mountWithIngressOn()
  const opt = w.find('[data-testid="ingress-cluster-default-option"]')
  expect(opt.attributes('disabled')).toBeDefined()
  expect(w.find('[data-testid="ingress-cluster-default-hint"]').exists()).toBe(true)
})

test('有默认 → 选中「集群默认」即 form.ingressClassName=显式默认类名', async () => {
  state.classes = [{ name: 'a' }, { name: 'nginx', isDefault: true }]
  const { w } = await mountWithIngressOn()
  await w.find('[data-testid="ingress-class-select"]').setValue('nginx')
  expect(w.vm.form.ingressClassName).toBe('nginx')
})
