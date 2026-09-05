// DeployApp 向导 IngressClass「集群默认」选项回归(2026-09-04 集群默认不变式,spec §3.4):
//   有默认类 → option 可选,value=显式默认类名;无默认 → disabled + hint;预填语义不受影响。
//   DOM 断言须先开 form.createIngress(v-if 门控)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const state = vi.hoisted(() => ({ classes: [], pcs: [] }))
// 提交桩:落库契约断言(选中「集群默认」→ 生成的 YAML 写显式 ingressClassName)
const applyResourceYaml = vi.fn(async () => ({ ok: true }))
vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(), manifest: vi.fn() } },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  currentCluster: 'demo', watchStateOf: () => 'off', setNamespace: () => {},
  fetchIngressClasses: vi.fn(async () => state.classes),
  fetchNamespaces: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []), fetchPriorityClasses: vi.fn(async () => state.pcs),
  fetchServices: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []), fetchPVCs: vi.fn(async () => []),
  applyResourceYaml: (...a) => applyResourceYaml(...a),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployApp from '../DeployApp.vue'

beforeEach(() => { applyResourceYaml.mockClear() })

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

test('有默认 → 选中「集群默认」后部署:提交的 YAML 写显式 ingressClassName', async () => {
  state.classes = [{ name: 'a' }, { name: 'nginx', isDefault: true }]
  const { w } = await mountWithIngressOn()
  // handleDeploy 走 validate() 全量门禁,须给最小合法表单(name/namespace/image + 合法规则)
  await w.setData({
    currentStep: 4,
    form: {
      ...w.vm.form,
      name: 'app1', namespace: 'demo', image: 'nginx:1',
      createService: false,
      createIngress: true,
      ingressRules: [{ host: 'a.com', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'svc-a', servicePort: '80' }] }],
    },
  })
  await w.find('[data-testid="ingress-class-select"]').setValue('nginx')
  await w.vm.handleDeploy()
  await flushPromises()
  expect(applyResourceYaml).toHaveBeenCalledTimes(1)
  expect(applyResourceYaml.mock.calls[0][0]).toContain('ingressClassName: nginx')
})

// === PriorityClass「集群默认」守卫选项(2026-09-05 审计:globalDefault 字段型默认同语义)===
async function mountWithSchedulingStep() {
  const { w, qc } = mountApp()
  await flushPromises()
  await w.setData({ currentStep: 3 })
  return { w, qc }
}

test('PC 有 globalDefault → 优先级集群默认 option 可选,value=类名', async () => {
  state.pcs = [{ name: 'low' }, { name: 'high', globalDefault: true }]
  const { w } = await mountWithSchedulingStep()
  const opt = w.find('[data-testid="priority-cluster-default-option"]')
  expect(opt.exists()).toBe(true)
  expect(opt.attributes('disabled')).toBeUndefined()
  expect(opt.element.value).toBe('high')
})

test('PC 无 globalDefault → option disabled + hint', async () => {
  state.pcs = [{ name: 'low', globalDefault: false }]
  const { w } = await mountWithSchedulingStep()
  const opt = w.find('[data-testid="priority-cluster-default-option"]')
  expect(opt.attributes('disabled')).toBeDefined()
  expect(w.find('[data-testid="priority-cluster-default-hint"]').exists()).toBe(true)
})

test('PC 空列表 → option disabled;hint 不渲染(空列表走「无类」语义,与 IC 配方一致)', async () => {
  state.pcs = []
  const { w } = await mountWithSchedulingStep()
  expect(w.find('[data-testid="priority-cluster-default-option"]').attributes('disabled')).toBeDefined()
  expect(w.find('[data-testid="priority-cluster-default-hint"]').exists()).toBe(false)
})

test('PC 有默认 → 选中「集群默认」即 form.priorityClassName=显式类名', async () => {
  state.pcs = [{ name: 'low' }, { name: 'high', globalDefault: true }]
  const { w } = await mountWithSchedulingStep()
  await w.find('[data-testid="priority-class-select"]').setValue('high')
  expect(w.vm.form.priorityClassName).toBe('high')
})
