// src/views/__tests__/NsWorkloadDetail.topology.test.js —— 拓扑 Tab 组件级断言(vitest+happy-dom)。
// harness 与 NsWorkloadDetail.selector-guard.test.js 同策略(mock @/api/client + @/stores/cluster,
// 真实 i18n + Vue Query;useToast importOriginal 保真)。fixture 经 state 对象按用例注入。
import { test, expect, vi, beforeEach } from 'vitest'

const captured = vi.hoisted(() => ({ svcAdds: [], svcUpdates: [] }))
const state = vi.hoisted(() => ({ workload: null, services: [], pdbs: [], netpols: [], pods: [], ingresses: [], endpoints: [], replicasets: [], hpas: [] }))

import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
  cronJobApi: { get: vi.fn(async () => ({})) },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
vi.mock('@/composables/useToast', async (importOriginal) => ({ ...(await importOriginal()), notify: vi.fn() }))
import { notify } from '@/composables/useToast'

vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  watchStateOf: () => 'off',
  currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [state.workload]), fetchPods: vi.fn(async () => state.pods),
  fetchPVCs: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  fetchServices: vi.fn(async () => state.services), fetchIngresses: vi.fn(async () => state.ingresses), fetchEvents: vi.fn(async () => []),
  fetchPDBs: vi.fn(async () => state.pdbs), fetchNetworkPolicies: vi.fn(async () => state.netpols),
  fetchEndpoints: vi.fn(async () => state.endpoints), fetchReplicaSets: vi.fn(async () => state.replicasets), fetchHPAs: vi.fn(async () => state.hpas),
  updateWorkload: vi.fn(async () => {}), applyWorkloadTemplate: vi.fn(async () => {}),
  updateWorkloadMeta: vi.fn(async () => {}),
  addService: vi.fn(item => { captured.svcAdds.push(item); return { ok: true } }),
  updateService: vi.fn((name, ns, updates) => { captured.svcUpdates.push({ name, updates }); return { ok: true } }),
  invalidateAllClusterQueries: vi.fn(async () => {}),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

const demoWorkload = {
  name: 'demo-deploy', namespace: 'default', type: 'Deployment', labels: { app: 'demo-deploy' }, annotations: {},
  raw: {
    metadata: { name: 'demo-deploy', namespace: 'default', labels: { app: 'demo-deploy' }, annotations: {} },
    spec: {
      replicas: 1, selector: { matchLabels: { app: 'demo-deploy' } },
      template: { metadata: { labels: { app: 'demo-deploy' } }, spec: { containers: [{ name: 'main', image: 'nginx', ports: [{ containerPort: 8080 }] }] } },
    },
  },
}
const svcMatching = { name: 'demo-svc', namespace: 'default', type: 'ClusterIP', ports: '80:8080/TCP', selector: { app: 'demo-deploy' }, portList: [] }
const mkPod = (name, labels) => ({ name, namespace: 'default', labels, status: 'Running', restarts: 0, raw: { metadata: { name, namespace: 'default' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } } })

function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { attachTo: document.body, global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true } } })
}
async function gotoTopology(w) {
  await w.findAll('button').find(b => b.text() === 'topology').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  document.body.innerHTML = ''
  captured.svcAdds.length = 0; captured.svcUpdates.length = 0
  notify.mockClear()
  state.workload = JSON.parse(JSON.stringify(demoWorkload))
  state.services = [JSON.parse(JSON.stringify(svcMatching))]
  state.pdbs = []; state.netpols = []; state.pods = []; state.ingresses = []
  state.endpoints = []; state.replicasets = []; state.hpas = []
  i18n.global.locale.value = 'zh'
})

test('A1: 共享 Ingress 只显示本负载规则,他人规则合并为 +N 行', async () => {
  state.services = [svcMatching, { name: 'other-svc', namespace: 'default', type: 'ClusterIP', ports: '80:80/TCP', selector: { app: 'other' }, portList: [] }]
  state.ingresses = [{
    name: 'shared', namespace: 'default', rules: [{ host: 'a.com', http: { paths: [
      { path: '/api', pathType: 'Prefix', backend: { service: { name: 'demo-svc', port: { number: 80 } } } },
      { path: '/', pathType: 'Prefix', backend: { service: { name: 'other-svc', port: { number: 80 } } } },
    ] } }],
    defaultBackend: null,
  }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const text = w.text()
  expect(text).toContain('a.com/api')
  expect(text).toContain('other-svc')          // 合并行出现
  expect(text).toContain('+1 条其他应用路由')
  // 他人路由不得渲染成规则卡(→ other-svc 形式的规则行不存在;合并行格式为「shared · +N …」)
  expect(text).not.toContain('→ other-svc')
})

test('C4: Service 卡显示端点就绪数,ready=0 标红', async () => {
  state.endpoints = [{ name: 'demo-svc', namespace: 'default', addresses: ['10.0.0.1', '10.0.0.2'], notReadyAddresses: [] }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  expect(w.text()).toContain('端点 2/2')
  state.endpoints = [{ name: 'demo-svc', namespace: 'default', addresses: [], notReadyAddresses: [] }]
  const w2 = mountDetail(); await flushPromises(); await gotoTopology(w2)
  expect(w2.text()).toContain('端点 0/0')
  expect(w2.html()).toContain('text-error')
})

test('C7: 实际 Pod 也不匹配 → 红「已断」;现有 Pod 仍匹配 → 黄「滚动后将断」', async () => {
  state.services = [{ ...JSON.parse(JSON.stringify(svcMatching)), selector: { app: 'demo-deploy', team: 'blue' } }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  expect(w.text()).toContain('已断')
  // 现有 Pod 仍匹配旧标签 → pending-break
  state.pods = [mkPod('demo-old', { app: 'demo-deploy', team: 'blue' })]
  state.endpoints = [{ name: 'demo-svc', namespace: 'default', addresses: ['10.0.0.1'], notReadyAddresses: [] }]
  const w2 = mountDetail(); await flushPromises(); await gotoTopology(w2)
  expect(w2.text()).toContain('滚动后将断')
})

test('C7: 失配卡 title 说明启发式判据(D3)', async () => {
  state.services = [{ ...JSON.parse(JSON.stringify(svcMatching)), selector: { app: 'demo-deploy', team: 'blue' } }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  expect(w.text()).toContain('selector 值包含本负载名')
})
