import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', watchStateOf: () => 'off', fetchIngressClasses: vi.fn(async () => [{ name: 'traefik', controller: 'x' }, { name: 'nginx', controller: 'x' }]), fetchNamespaces: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []), fetchPriorityClasses: vi.fn(async () => []), fetchServices: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []), fetchPVCs: vi.fn(async () => []), setNamespace: () => {} }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployApp from '../DeployApp.vue'

function mountApp() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployApp, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true, Breadcrumbs: true, PortSelect: true, EnvSourceField: true, VolumeMountCard: true, TagInput: true, AnnotationKeySelect: true } } })
}

test('选 traefik 类 → 调优面板出现 traefik 字段(placeholder=web),nginx 字段消失', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ currentStep: 4, form: { ...w.vm.form, createIngress: true } })
  await flushPromises()
  await w.find('[data-testid="ingress-class-select"]').setValue('traefik')
  await flushPromises()
  expect(w.find('[data-testid="gateway-perf"] input[placeholder="web"]').exists()).toBe(true)
  expect(w.find('[data-testid="gateway-perf"] input[placeholder="60"]').exists()).toBe(false)   // nginx read-timeout
})

test('方言切换清空 adv:填 nginx 值 → 切 traefik → 切回,值已清', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ currentStep: 4, form: { ...w.vm.form, createIngress: true } })
  await flushPromises()
  await w.find('[data-testid="ingress-class-select"]').setValue('nginx')
  await flushPromises()
  const nginxInput = w.find('[data-testid="gateway-perf"] input[placeholder="60"]')
  await nginxInput.setValue('90')
  await w.find('[data-testid="ingress-class-select"]').setValue('traefik')
  await flushPromises()
  await w.find('[data-testid="ingress-class-select"]').setValue('nginx')
  await flushPromises()
  expect(w.find('[data-testid="gateway-perf"] input[placeholder="60"]').element.value).toBe('')
})
