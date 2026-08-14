import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const addIngress = vi.fn(async () => ({ ok: true }))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', nsServices: [], fetchServices: vi.fn(async () => []), fetchIngresses: vi.fn(async () => []), fetchIngressClasses: vi.fn(async () => [{ name: 'traefik' }]), addIngress, setNamespace: () => {} }) }))
vi.mock('@/api/client', () => ({ api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn() } }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))

import NsIngress from '../NsIngress.vue'

function mountDlg() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsIngress, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Modal: { props: ['modelValue','title','width'], template: '<div><slot/><slot name="actions"/></div>' }, Breadcrumbs: true, Pagination: true, PortSelect: true, AnnotationKeySelect: true, DataTable: true } } })
}

test('选 traefik + 填 entrypoints → addIngress 注解带 traefik 前缀、无 nginx 键', async () => {
  const w = mountDlg()
  await flushPromises()
  // 填写必填字段以启用 create 按钮(PortSelect 被 stub,通过 vm 直接设值)
  w.vm.createForm.name = 'test-ing'
  w.vm.createForm.host = 'app.test.com'
  w.vm.createForm.serviceName = 'svc1'
  await w.find('[data-testid="ingress-class-select"]').setValue('traefik')
  await flushPromises()
  // 切到「性能调优」标签(traefik 有 perf 组)
  const perfTab = w.findAll('button').find(b => b.text().includes('性能调优') || b.text().includes('Performance'))
  await perfTab.trigger('click')
  await flushPromises()
  await w.find('[data-testid="perf-panel"] input[placeholder="web"]').setValue('websecure')
  await w.find('[data-testid="create-ingress-btn"]').trigger('click')
  await flushPromises()
  const arg = addIngress.mock.calls.at(-1)[0]
  expect(arg.annotations['traefik.ingress.kubernetes.io/router.entrypoints']).toBe('websecure')
  expect(Object.keys(arg.annotations).some(k => k.startsWith('nginx.ingress.kubernetes.io/'))).toBe(false)
})
