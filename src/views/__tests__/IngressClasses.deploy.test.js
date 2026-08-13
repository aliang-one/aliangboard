import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(async () => ({ templates: [] })), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', fetchIngressClasses: vi.fn(async () => []), setNamespace: () => {} }) }))
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
