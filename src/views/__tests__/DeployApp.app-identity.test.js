// DeployApp 身份标签防线(2026-09-01 selector 耦合系统排查):模板 app 标签单方面由负载名定义。
// 事故形态:复制 workload 把来源 metadata labels(app: 源名)带进表单(useWorkloadToForm),
// 用户改名后向导 selector 恒为 app:<新名> ⊄ 模板 labels(app: 源名)→ 创建即 K8s 422
// 「selector does not match template labels」。修复:previewYAML 强制 labels.app = f.name。
// mock 策略与 DeployApp.annotation-typing 一致(harness 处理过同源的复制流 revision 事故)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { load } from 'js-yaml'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const { applyResourceYaml, notify } = vi.hoisted(() => ({ applyResourceYaml: vi.fn(), notify: vi.fn() }))

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
    watchStateOf: () => 'off',
  currentCluster: 'demo', applyResourceYaml,
  fetchIngressClasses: vi.fn(async () => []), fetchNamespaces: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []),
  fetchPriorityClasses: vi.fn(async () => []), fetchServices: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []),
  fetchSecrets: vi.fn(async () => []), fetchPVCs: vi.fn(async () => []), setNamespace: () => {},
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))
vi.mock('@/composables/useToast', () => ({ notify }))

import DeployApp from '../DeployApp.vue'

beforeEach(() => { notify.mockClear(); applyResourceYaml.mockReset() })

function mountApp() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployApp, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true, Breadcrumbs: true, PortSelect: true, EnvSourceField: true, VolumeMountCard: true, TagInput: true, AnnotationKeySelect: true } } })
}

async function previewWith(form) {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, ...form } })
  await flushPromises()
  return { w, doc: load(w.vm.previewYAML) }
}

test('复制流:labels 带来源 app:web,改名 web-copy 后模板 app 强制为新名(与 selector 一致,不再 422)', async () => {
  const { doc } = await previewWith({
    name: 'web-copy', containerName: 'main', image: 'nginx',
    labels: [{ key: 'app', value: 'web' }, { key: 'team', value: 'red' }],
  })
  expect(doc.spec.selector.matchLabels.app).toBe('web-copy')
  expect(doc.spec.template.metadata.labels.app).toBe('web-copy')
  expect(doc.spec.template.metadata.labels.team).toBe('red', '非身份业务标签照常保留')
})

test('非复制流:用户手改 app 标签值同样强制为负载名', async () => {
  const { doc } = await previewWith({
    name: 'myapp', containerName: 'main', image: 'nginx',
    labels: [{ key: 'app', value: 'not-myapp' }],
  })
  expect(doc.spec.selector.matchLabels.app).toBe('myapp')
  expect(doc.spec.template.metadata.labels.app).toBe('myapp')
})
