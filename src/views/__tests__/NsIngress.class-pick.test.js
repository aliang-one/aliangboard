// NsIngress 创建弹窗 IngressClass 默认值回归(2026-09-01「集群默认」退役):
//   曾默认 className='')(下拉首项「集群默认」)→ 生成 YAML 不写 ingressClassName,指望集群默认类;
//   但集群经常没有任何 is-default-class 标记(平台自带 4 份控制器清单全不标)→ Ingress 落地无类,
//   控制器不接 → 永远没有 ADDRESS。现在:类列表到达即选中一个确定的类(isDefault 优先,否则字母序第一)。
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

// Modal 须渲染 slot(NsIngress.dialect 同款)才能断言 select 的 option
function mountView() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(NsIngress, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Modal: { props: ['modelValue', 'title', 'width'], emits: ['update:modelValue', 'cancel'], template: '<div><slot/><slot name="actions"/></div>' }, Breadcrumbs: true, Pagination: true, PortSelect: true, AnnotationKeySelect: true, DataTable: true, IngressRulesEditor: true, IngressPerfField: true, CreateWithYamlButton: true } } })
  return { w, qc }
}

test('类列表到达 → className 自动选中确定的类(isDefault 优先),空 option 退役', async () => {
  state.classes = [{ name: 'traefik' }, { name: 'nginx', isDefault: true }]
  const { w } = mountView()
  await flushPromises()
  expect(w.vm.createForm.className).toBe('nginx')
  const opts = w.find('[data-testid="ingress-class-select"]').findAll('option')
  expect(opts.some(o => o.element.value === '')).toBe(false)
})

test('无 isDefault → 字母序第一(不依赖接口返回顺序)', async () => {
  state.classes = [{ name: 'traefik' }, { name: 'apisix' }]
  const { w } = mountView()
  await flushPromises()
  expect(w.vm.createForm.className).toBe('apisix')
})

test('用户已手选 → 类列表重取变化不覆盖用户选择(仅空值时补选)', async () => {
  state.classes = [{ name: 'nginx', isDefault: true }, { name: 'traefik' }]
  const { w, qc } = mountView()
  await flushPromises()
  await w.find('[data-testid="ingress-class-select"]').setValue('traefik')
  state.classes = [{ name: 'nginx', isDefault: true }, { name: 'traefik' }, { name: 'kong' }]
  await qc.invalidateQueries({ queryKey: ['cluster', 'demo', 'ingressclasses'] })
  await flushPromises()
  expect(w.vm.createForm.className).toBe('traefik')
})

test('集群无 IngressClass → 保持空,回退「集群无 IngressClass」option', async () => {
  state.classes = []
  const { w } = mountView()
  await flushPromises()
  expect(w.vm.createForm.className).toBe('')
  const opts = w.find('[data-testid="ingress-class-select"]').findAll('option')
  expect(opts).toHaveLength(1)
  expect(opts[0].element.value).toBe('')
  expect(opts[0].text()).toContain('IngressClass')
})
