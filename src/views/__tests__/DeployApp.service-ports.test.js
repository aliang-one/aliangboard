// Deploy 向导 Service 多端口自动补 name 回归:
//   K8s 校验:Service 端口数 > 1 时每个 port 都必须有 name(spec.ports[i].name: Required value)。
//   向导 Service 段自拼 YAML(不走 store.generateYAML),曾漏掉 store 层的自动补名
//   → 默认 'http' + 用户加的无名第二端口 → K8s 拒 → workload 建成、Service 静默缺失。
// 单一事实源:ensureServicePortNames(useYaml.js),与 cluster.js generateYAML 共用。
// 背景:2026-08-17 系统审计 P1-A(同日 6ca93e8 只修了 store 层)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { loadAll } from 'js-yaml'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', fetchIngressClasses: vi.fn(async () => []), fetchNamespaces: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []), fetchPriorityClasses: vi.fn(async () => []), fetchServices: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []), fetchPVCs: vi.fn(async () => []), setNamespace: () => {} }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployApp from '../DeployApp.vue'

function mountApp() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployApp, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true, Breadcrumbs: true, PortSelect: true, EnvSourceField: true, VolumeMountCard: true, TagInput: true, AnnotationKeySelect: true } } })
}

async function serviceDocWith(servicePorts, extra = {}) {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'demo', image: 'nginx', createService: true, serviceType: 'ClusterIP', servicePorts, ...extra } })
  await flushPromises()
  const docs = []
  loadAll(w.vm.previewYAML, d => docs.push(d))
  return docs.find(d => d.kind === 'Service')
}

const P = (name, port, protocol = 'TCP') => ({ name, port: String(port), targetPort: String(port), nodePort: '', protocol })

test('多端口:已有 name 保留,空 name 自动补 port-<端口号>', async () => {
  const svc = await serviceDocWith([P('http', 80), P('', 8080)])
  expect(svc.spec.ports.map(p => p.name)).toEqual(['http', 'port-8080'])
})

test('多端口:全部空 name → 逐个自动补名;同端口号重号加序号去重', async () => {
  const svc = await serviceDocWith([P('', 80, 'TCP'), P('', 80, 'UDP'), P('', 9090)])
  expect(svc.spec.ports.map(p => p.name)).toEqual(['port-80', 'port-80-2', 'port-9090'])
})

test('单端口:空 name 保持匿名(不自动补名,无损)', async () => {
  const svc = await serviceDocWith([P('', 80)])
  expect(svc.spec.ports[0].name).toBeUndefined()
})

test('自动补的名不与用户已填 name 冲突(已占用 port-8080 → 追加序号)', async () => {
  const svc = await serviceDocWith([P('port-8080', 80), P('', 8080)])
  expect(svc.spec.ports.map(p => p.name)).toEqual(['port-8080', 'port-8080-2'])
})
