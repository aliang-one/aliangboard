// src/views/__tests__/NsWorkloadDetail.topology.test.js —— 拓扑 Tab 组件级断言(vitest+happy-dom)。
// harness 与 NsWorkloadDetail.selector-guard.test.js 同策略(mock @/api/client + @/stores/cluster,
// 真实 i18n + Vue Query;useToast importOriginal 保真)。fixture 经 state 对象按用例注入。
import { test, expect, vi, beforeEach } from 'vitest'

const captured = vi.hoisted(() => ({ svcAdds: [], svcUpdates: [], ingAdds: [], routerPushes: [] }))
const state = vi.hoisted(() => ({ workload: null, services: [], pdbs: [], netpols: [], pods: [], ingresses: [], endpoints: [], replicasets: [], hpas: [], ingressClasses: [] }))

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
  fetchIngressClasses: vi.fn(async () => state.ingressClasses),
  updateWorkload: vi.fn(async () => {}), applyWorkloadTemplate: vi.fn(async () => {}),
  updateWorkloadMeta: vi.fn(async () => {}),
  addService: vi.fn(item => { captured.svcAdds.push(item); return { ok: true } }),
  updateService: vi.fn((name, ns, updates) => { captured.svcUpdates.push({ name, updates }); return { ok: true } }),
  invalidateAllClusterQueries: vi.fn(async () => {}),
  addIngress: vi.fn(item => { captured.ingAdds.push(item); return { ok: true } }),
  updateIngressRules: vi.fn(async () => ({})),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' } }), useRouter: () => ({ push: loc => captured.routerPushes.push(loc) }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'
import WorkloadTopologyTab from '@/components/common/WorkloadTopologyTab.vue'
import PortSelect from '@/components/common/PortSelect.vue'

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
  captured.svcAdds.length = 0; captured.svcUpdates.length = 0; captured.ingAdds.length = 0; captured.routerPushes.length = 0
  notify.mockClear()
  state.workload = JSON.parse(JSON.stringify(demoWorkload))
  state.services = [JSON.parse(JSON.stringify(svcMatching))]
  state.pdbs = []; state.netpols = []; state.pods = []; state.ingresses = []
  state.endpoints = []; state.replicasets = []; state.hpas = []; state.ingressClasses = []
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
  const repairBtn = w.findAll('button.topo-repair-btn').find(b => b.text() === '修复 selector')
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
  // 节点化后:规则节点=div.topo-rule,Service 节点=div(常显形态,非 button);
  // 取「文本同时含名+类型」的最深 div(祖先容器全文也含,at(-1) 即节点根)
  const ruleCard = w.findAll('.topo-rule').find(b => b.text().includes('a.com'))
  const svcNode = w.findAll('div').filter(x => x.text().includes('demo-svc') && x.text().includes('ClusterIP')).at(-1)
  expect(ruleCard).toBeTruthy(); expect(svcNode).toBeTruthy()
  // token 级匹配(classes() 返回数组,toContain 逐 token 严格比对)——focus-visible:ring-2 不会误中
  expect(svcNode.classes()).not.toContain('ring-2')
  await ruleCard.trigger('mouseenter')
  expect(svcNode.classes()).toContain('ring-2')
  await ruleCard.trigger('mouseleave')
  expect(svcNode.classes()).not.toContain('ring-2')
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
  const addBtns = w.findAll('.topo-wl-add')   // 节点化后加号落卡:workload 节点右上 hover-+(原 -left-3 边框钮已移除)
  expect(addBtns.length).toBe(1)
  await addBtns[0].trigger('click'); await flushPromises()   // workload 节点「暴露」+
  await clickModalBtn('创建')
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('至少填写一个端口'))
  expect(captured.svcAdds).toHaveLength(0)
  // 弹窗不关:创建按钮仍在 body(校验失败不落库不清弹窗)
  expect([...document.body.querySelectorAll('button')].some(b => b.textContent.trim() === '创建')).toBe(true)
})

test('A5: saveIngressMap 未选 Service 端口 → error 提示且不触 Ingress 变更', async () => {
  // 默认 fixture 的 svcMatching.portList=[] → ingressMapForm.servicePort 初始为 ''
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const addBtns = w.findAll('.topo-svc-add')   // Service 节点 hover-+ 开 ingress-map(原 -left-3 边框钮已移除)
  expect(addBtns.length).toBe(1)
  await addBtns[0].trigger('click'); await flushPromises()   // Ingress 映射 +
  await clickModalBtn('创建')
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('请先选择 Service 端口'))
  expect(captured.ingAdds).toHaveLength(0)
})

// A6:「集群默认」退役(2026-09-01)——新建 Ingress 的 className 恒为确定类(曾硬编码 '' → 落地无类无人接)
test('A6: 新建 Ingress 的 className 选确定类(isDefault 优先),不再为空', async () => {
  state.ingressClasses = [{ name: 'traefik' }, { name: 'nginx', isDefault: true }]
  state.services = [{ ...JSON.parse(JSON.stringify(svcMatching)), portList: [{ port: 8080 }] }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const addBtns = w.findAll('.topo-svc-add')   // Service 节点 hover-+(vue-flow 改版后,原 -left-3 边框钮已移除)
  expect(addBtns.length).toBe(1)
  await addBtns[0].trigger('click'); await flushPromises()   // Ingress 映射 +
  await clickModalBtn('创建')
  expect(captured.ingAdds).toHaveLength(1)
  expect(captured.ingAdds[0].className).toBe('nginx')
})

// 弹窗内 serviceName 取值:PortSelect(placeholder='my-service' 唯一定位)的 modelValue
function modalServiceName(w) {
  const sel = w.findAllComponents(PortSelect).find(c => c.props('placeholder') === 'my-service')
  expect(sel, 'ingress-map 弹窗 serviceName 输入应存在').toBeTruthy()
  return sel.props('modelValue')
}

test('B6: Service 节点 hover-+ → ingressMap 弹窗预填该 Service(指定名参数化)', async () => {
  state.services = [
    { ...JSON.parse(JSON.stringify(svcMatching)), portList: [{ port: 8080 }] },
    { name: 'demo-svc-2', namespace: 'default', type: 'ClusterIP', ports: '81:8081/TCP', selector: { app: 'demo-deploy' }, portList: [{ port: 8081 }] },
  ]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  // 两个 Service 节点各有 hover-+;点「demo-svc-2」节点内那个(按钮父节点即节点根)
  const addBtn = w.findAll('.topo-svc-add').find(b => b.element.parentElement?.textContent.includes('demo-svc-2'))
  expect(addBtn).toBeTruthy()
  await addBtn.trigger('click'); await flushPromises()
  expect(modalServiceName(w)).toBe('demo-svc-2')   // 钉到点击的 Service,而非第一个关联 Service
})

test('B6: openIngressMap 无参回归——仍取第一个关联 Service', async () => {
  state.services = [
    { ...JSON.parse(JSON.stringify(svcMatching)), portList: [{ port: 8080 }] },
    { name: 'demo-svc-2', namespace: 'default', type: 'ClusterIP', ports: '81:8081/TCP', selector: { app: 'demo-deploy' }, portList: [{ port: 8081 }] },
  ]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  // 经 Tab provide 的 topo-actions 直调无参形态(链路与 hover-+ 同源:name => openIngressMap(name))
  const tab = w.findComponent(WorkloadTopologyTab)
  const actions = tab.vm.$.provides['topo-actions']
  actions.openIngressMap(); await flushPromises()
  expect(modalServiceName(w)).toBe('demo-svc')
})

// 终审 C1:规则卡点击 → router.push 收到含正确 ingress 名的定位对象(goto 契约=传规则对象)
test('C1: 规则卡点击跳转——push 定位对象含正确 ingress 名与 namespace', async () => {
  state.ingresses = [{ name: 'ing1', namespace: 'default', rules: [{ host: 'a.com', http: { paths: [{ path: '/app', pathType: 'Prefix', backend: { service: { name: 'demo-svc', port: { number: 80 } } } }] } }], defaultBackend: null }]
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const ruleCard = w.findAll('.topo-rule').find(x => x.text().includes('a.com'))
  expect(ruleCard).toBeTruthy()
  await ruleCard.trigger('click'); await flushPromises()
  const hit = captured.routerPushes.find(l => l?.name === 'NsIngressDetail')
  expect(hit, '应有 NsIngressDetail 跳转(终审 C1:goto 契约断裂则恒 undefined)').toBeTruthy()
  expect(hit.params).toEqual({ namespace: 'default', name: 'ing1' })
})
// === expose 弹窗 nodePort(2026-09-01):第三条创建路径补 nodePort 输入 + 集群级空闲推荐 ===
const setInput = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')) }
async function openExposeModal() {
  const w = mountDetail(); await flushPromises(); await gotoTopology(w)
  const plus = w.find(`.topo-wl-add`)   // Workload 节点 hover「暴露」+(加号落卡,2026-09-01 拓扑连线化)
  await plus.trigger('click'); await flushPromises()
  return w
}
// 弹窗 teleport 在 body 末尾:type 切换 select 取 body 内最后一个(仓库既有约定)
async function switchExposeType(type) {
  const sel = [...document.body.querySelectorAll('select')].at(-1)
  sel.value = type; sel.dispatchEvent(new Event('change')); await flushPromises()
}
// 带 Material Symbols 图标的按钮:连字文本混入 textContent(仓库既有教训),须包含匹配不能精确匹配
async function clickModalBtnContaining(text) {
  const els = [...document.body.querySelectorAll('button')].filter(b => b.textContent.includes(text))
  expect(els.length, `body 内应有含「${text}」的按钮`).toBeGreaterThan(0)
  els.at(-1).click(); await flushPromises()
}
const npInputs = () => [...document.body.querySelectorAll('input[placeholder="nodePort"]')]

test('expose nodePort: 仅 NodePort/LoadBalancer 显示 nodePort 输入,ClusterIP 不显示', async () => {
  await openExposeModal()
  expect(npInputs().length).toBe(0)          // 默认 ClusterIP
  await switchExposeType('NodePort')
  expect(npInputs().length).toBeGreaterThan(0)
  await switchExposeType('ClusterIP')
  expect(npInputs().length).toBe(0)
})

test('expose nodePort: 推荐——跳过集群已占用(NodePort/LB 全 ns),只填空行不覆盖手填', async () => {
  state.services = [
    JSON.parse(JSON.stringify(svcMatching)),
    { name: 'np-svc', namespace: 'kube-system', type: 'NodePort', ports: '443:8443/TCP', selector: { app: 'ingress' }, portList: [{ nodePort: 30000 }, { nodePort: 30001 }] },
    { name: 'lb-svc', namespace: 'other', type: 'LoadBalancer', ports: '80:80/TCP', selector: {}, portList: [{ nodePort: 30005 }] },
  ]
  await openExposeModal()
  await switchExposeType('NodePort')
  // 第二行留空,第一行手填 30999(推荐不得覆盖)
  const addBtn = [...document.body.querySelectorAll('button')].filter(b => b.textContent.trim().startsWith('+')).at(-1)
  addBtn.click(); await flushPromises()
  setInput(npInputs()[0], 30999)
  await clickModalBtnContaining('自动推荐端口')
  expect(Number(npInputs()[0].value)).toBe(30999)          // 手填不覆盖
  expect(Number(npInputs()[1].value)).toBe(30002)          // 空行:跳过集群已占用 30000/30001/30005
})

test('expose nodePort: saveExpose 走结构化 portList,手填 nodePort 落盘', async () => {
  await openExposeModal()
  await switchExposeType('NodePort')
  setInput(npInputs()[0], 30010)
  await clickModalBtn('创建')
  expect(captured.svcAdds).toHaveLength(1)
  expect(captured.svcAdds[0].portList).toEqual([{ name: '', port: 8080, targetPort: 8080, protocol: 'TCP', nodePort: 30010, appProtocol: '' }])
})

test('expose nodePort: ClusterIP 下 portList.nodePort 恒 null(创建成功弹窗即关)', async () => {
  await openExposeModal()
  await clickModalBtn('创建')
  expect(captured.svcAdds).toHaveLength(1)
  expect(captured.svcAdds[0].portList).toEqual([{ name: '', port: 8080, targetPort: 8080, protocol: 'TCP', nodePort: null, appProtocol: '' }])
})

test('expose nodePort: 非法值(>65535)拦截——error 不落库,弹窗保留', async () => {
  await openExposeModal()
  await switchExposeType('NodePort')
  setInput(npInputs()[0], 70000)
  await clickModalBtn('创建')
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('1-65535'))
  expect(captured.svcAdds).toHaveLength(0)
  expect([...document.body.querySelectorAll('button')].some(b => b.textContent.trim() === '创建')).toBe(true)
})
