// DeployApp 向导 IngressClass 默认值回归(2026-09-01「集群默认」退役):
//   曾默认 ingressClassName=''(「集群默认」)→ YAML 不写 ingressClassName,集群无默认类时 Ingress 落地无类。
//   现在:类列表到达即选中一个确定的类(isDefault 优先,否则字母序第一);用户显式选择不被覆盖。
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

test('类列表到达 → form.ingressClassName 自动选中确定的类(isDefault 优先)', async () => {
  state.classes = [{ name: 'traefik' }, { name: 'nginx', isDefault: true }]
  const { w } = mountApp()
  await flushPromises()
  expect(w.vm.form.ingressClassName).toBe('nginx')
})

test('用户已手选 → 列表重取不覆盖(仅空值时补选)', async () => {
  state.classes = [{ name: 'traefik' }, { name: 'nginx', isDefault: true }]
  const { w, qc } = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, ingressClassName: 'traefik' } })
  state.classes = [{ name: 'traefik' }, { name: 'nginx', isDefault: true }, { name: 'kong' }]
  await qc.invalidateQueries({ queryKey: ['cluster', 'demo', 'ingressclasses'] })
  await flushPromises()
  expect(w.vm.form.ingressClassName).toBe('traefik')
})

test('集群无 IngressClass → ingressClassName 保持空(生成 YAML 不写该字段)', async () => {
  state.classes = []
  const { w } = mountApp()
  await flushPromises()
  expect(w.vm.form.ingressClassName).toBe('')
})
