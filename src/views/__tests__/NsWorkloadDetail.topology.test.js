// src/views/__tests__/NsWorkloadDetail.topology.test.js —— 拓扑 Tab 组件级断言(vitest+happy-dom)。
// harness 与 NsWorkloadDetail.selector-guard.test.js 同策略(mock @/api/client + @/stores/cluster,
// 真实 i18n + Vue Query;useToast importOriginal 保真)。fixture 经 state 对象按用例注入。
import { test, expect, vi, beforeEach } from 'vitest'

const captured = vi.hoisted(() => ({ svcAdds: [], svcUpdates: [], ingAdds: [] }))
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
  addIngress: vi.fn(item => { captured.ingAdds.push(item); return { ok: true } }),
  updateIngressRules: vi.fn(async () => ({})),
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
  captured.svcAdds.length = 0; captured.svcUpdates.length = 0; captured.ingAdds.length = 0
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
  expect(text).toContain('shared · +1 条其他应用路由')   // 合并行出现(不点他人 Service 名)
  expect(text).toContain('+1 条其他应用路由')
  // 他人路由不得渲染成规则卡,也不得点名他人 Service(spec §2:others 只带 {name,count})
  expect(text).not.toContain('→ other-svc')
  expect(text).not.toContain('other-svc')
})

test('C4: Service 卡显示端点就绪数,ready=0 标红', async () => {
  state.endpoints = [{ name: 'demo-svc', namespace: 'default', addresses: ['10.0.0.1', '10.0.0.2'], notReadyAddresses: [] }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  expect(w.text()).toContain('端点 2/2')
  state.endpoints = [{ name: 'demo-svc', namespace: 'default', addresses: [], notReadyAddresses: [] }]
  const w2 = mountDetail(); await flushPromises(); await gotoTopology(w2)
  expect(w2.text()).toContain('端点 0/0')
  // 元素级断言(终审 minor:全文 html 子串匹配会被他处 text-error 误绿)
  const epRow = w2.findAll('p').find(x => x.text().includes('端点 0/0'))
  expect(epRow, '端点行应渲染').toBeTruthy()
  expect(epRow.classes()).toContain('text-error')
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
  const repairBtn = w.findAll('button').find(b => b.text() === '修复 selector')
  expect(repairBtn).toBeTruthy()
  expect(repairBtn.attributes('title')).toContain('selector 值包含本负载名')
})

const mkRs = (name, ready, desired, ts, pods = []) => ({ name, namespace: 'default', ready, desired, raw: { metadata: { name, namespace: 'default', creationTimestamp: ts, ownerReferences: [{ kind: 'Deployment', name: 'demo-deploy', controller: true }], labels: { 'pod-template-hash': name } } } })

test('C1: RS chips 渲染 ready/desired,淘汰 RS 置灰,Pods 列按 RS 分组', async () => {
  state.replicasets = [mkRs('demo-9f8', 2, 2, '2026-02-01T00:00:00Z'), mkRs('demo-old', 0, 0, '2026-01-01T00:00:00Z')]
  state.pods = [
    { ...mkPod('demo-9f8-a', { app: 'demo-deploy' }), raw: { metadata: { name: 'demo-9f8-a', namespace: 'default', ownerReferences: [{ kind: 'ReplicaSet', name: 'demo-9f8', controller: true }] } } },
    { ...mkPod('demo-old-a', { app: 'demo-deploy' }), raw: { metadata: { name: 'demo-old-a', namespace: 'default', ownerReferences: [{ kind: 'ReplicaSet', name: 'demo-old', controller: true }] } } },
  ]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const text = w.text()
  expect(text).toContain('demo-9f8')
  expect(text).toContain('demo-old')
  // Pods 列按 RS 分组:组头含 RS 名;淘汰组容器带 opacity 降透明类
  expect(w.html()).toContain('opacity-60')
})

test('C2: HPA chip 与 标签消费者(PDB/NetPol)chips 渲染', async () => {
  state.hpas = [{ name: 'demo-hpa', namespace: 'default', targetName: 'demo-deploy', targetKind: 'Deployment', minReplicas: 1, maxReplicas: 5, cpuTarget: 80 }]
  state.pdbs = [{ name: 'demo-pdb', namespace: 'default', selector: { app: 'demo-deploy' }, raw: { status: { disruptionsAllowed: 0 } } }]
  state.netpols = [{ name: 'demo-np', namespace: 'default', podSelector: { app: 'demo-deploy' } }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const text = w.text()
  expect(text).toContain('demo-hpa')
  expect(text).toContain('demo-pdb')
  expect(text).toContain('demo-np')
  expect(text).toContain('标签消费者')
})

test('C3: 规则卡 hover → 匹配 Service 卡高亮(ring)', async () => {
  state.ingresses = [{ name: 'ing1', namespace: 'default', rules: [{ host: 'a.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'demo-svc', port: { number: 80 } } } }] } }], defaultBackend: null }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const ruleCard = w.findAll('button').find(b => b.text().includes('a.com'))
  const svcCardBefore = w.findAll('button').find(b => b.text().includes('demo-svc') && b.text().includes('ClusterIP'))
  // token 级匹配(classes() 返回数组,toContain 逐 token 严格比对)——focus-visible:ring-2 不会误中
  expect(svcCardBefore.classes()).not.toContain('ring-2')
  await ruleCard.trigger('mouseenter')
  expect(svcCardBefore.classes()).toContain('ring-2')
  await ruleCard.trigger('mouseleave')
  expect(svcCardBefore.classes()).not.toContain('ring-2')
})

// 弹窗(teleport 到 body)内按文本点按钮:取 body 内同名按钮最后一个即弹窗内的
async function clickModalBtn(text) {
  const els = [...document.body.querySelectorAll('button')].filter(b => b.textContent.trim() === text)
  expect(els.length, `body 内应有「${text}」按钮`).toBeGreaterThan(0)
  els.at(-1).click(); await flushPromises()
}

test('D1: saveExpose 容器无端口 → error 提示且不下发 Service 创建', async () => {
  state.workload.raw.spec.template.spec.containers = [{ name: 'main', image: 'nginx' }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const plusButtons = w.findAll('button').filter(b => b.classes().includes('-left-3'))
  expect(plusButtons.length).toBe(2)
  await plusButtons.at(-1).trigger('click'); await flushPromises()   // Deployment 卡「暴露」+
  await clickModalBtn('创建')
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('至少填写一个端口'))
  expect(captured.svcAdds).toHaveLength(0)
  // 弹窗不关:创建按钮仍在 body(校验失败不落库不清弹窗)
  expect([...document.body.querySelectorAll('button')].some(b => b.textContent.trim() === '创建')).toBe(true)
})

test('A5: saveIngressMap 未选 Service 端口 → error 提示且不触 Ingress 变更', async () => {
  // 默认 fixture 的 svcMatching.portList=[] → ingressMapForm.servicePort 初始为 ''
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const plusButtons = w.findAll('button').filter(b => b.classes().includes('-left-3'))
  expect(plusButtons.length).toBe(2)
  await plusButtons.at(0).trigger('click'); await flushPromises()   // Ingress 映射 +
  await clickModalBtn('创建')
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('请先选择 Service 端口'))
  expect(captured.ingAdds).toHaveLength(0)
})
