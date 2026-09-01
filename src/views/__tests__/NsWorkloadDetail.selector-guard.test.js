// NsWorkloadDetail Service selector 失配防线测试(2026-09-01 Ingress 503 事故)。
// 根因:saveExpose 曾把暴露时刻全部 Pod 模板 labels 快照进 Service selector;元数据编辑器
// 镜像改动业务标签 → Pod labels 变 → Service selector ⊄ Pod labels → Endpoints 空 → 503 静默。
// 本文件锁四件事:①saveExpose 下发身份 selector(根因回归锁,不含业务标签)
// ②saveMeta 镜像会失配 Service 时拦截不落库(防线④) ③同形改动与模板一致时不误拦
// ④拓扑失配卡一键修复收敛为身份 selector。mock 策略与 NsWorkloadDetail.edit-shell 一致
// (mock @/api/client 与 @/stores/cluster,真实 i18n + Vue Query;useToast 用 importOriginal 保真)。
// Modal teleport 到 body:弹窗内交互统一走 document.body(仓库既有惯例,见 CreateFromYamlDialog.test)。
import { test, expect, vi, beforeEach } from 'vitest'

const captured = vi.hoisted(() => ({ svcAdds: [], metaSaves: [], svcUpdates: [] }))
// 可变 fixture:各用例注入不同 Service selector(state.services)/workload(state.workload)
const state = vi.hoisted(() => ({ workload: null, services: [], pdbs: [], netpols: [] }))

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
// importOriginal 保真(模块还有其他导出,子组件可能消费);只把 notify 换成捕获桩
vi.mock('@/composables/useToast', async (importOriginal) => ({ ...(await importOriginal()), notify: vi.fn() }))
import { notify } from '@/composables/useToast'

vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  watchStateOf: () => 'off',
  currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [state.workload]), fetchPods: vi.fn(async () => []),
  fetchPVCs: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  fetchServices: vi.fn(async () => state.services), fetchIngresses: vi.fn(async () => []), fetchEvents: vi.fn(async () => []),
  fetchPDBs: vi.fn(async () => state.pdbs), fetchNetworkPolicies: vi.fn(async () => state.netpols),
  updateWorkload: vi.fn(async () => {}), applyWorkloadTemplate: vi.fn(async () => {}),
  updateWorkloadMeta: vi.fn((n, ns, payload) => { captured.metaSaves.push(payload) }),
  addService: vi.fn(item => { captured.svcAdds.push(item); return { ok: true } }),
  updateService: vi.fn((name, ns, updates) => { captured.svcUpdates.push({ name, updates }); return { ok: true } }),
  invalidateAllClusterQueries: vi.fn(async () => {}),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

// 模板 labels 含业务标签(version/team)——旧 saveExpose 会把它们全量快照进 Service selector
const demoWorkload = {
  name: 'demo-deploy', namespace: 'default', type: 'Deployment', labels: { app: 'demo-deploy' }, annotations: {},
  raw: {
    metadata: { name: 'demo-deploy', namespace: 'default', labels: { app: 'demo-deploy' }, annotations: {} },
    spec: {
      replicas: 1, selector: { matchLabels: { app: 'demo-deploy' } },
      template: { metadata: { labels: { app: 'demo-deploy', 'aliangboard.io/version': 'v1', team: 'red' } }, spec: { containers: [{ name: 'main', image: 'nginx' }] } },
    },
  },
}
const svcMatching = { name: 'demo-svc', namespace: 'default', type: 'ClusterIP', ports: '80:8080/TCP', selector: { app: 'demo-deploy', team: 'red' }, portList: [] }

function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { attachTo: document.body, global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true } } })
}
// 弹窗在 wrapper 之外(teleport),按钮统一查 body;trigger 后须 flushPromises
const bodyBtns = text => [...document.body.querySelectorAll('button')].filter(b => b.textContent.trim() === text)
const bodyBtn = text => bodyBtns(text)[0]
const setInput = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')) }
async function clickBody(text) {
  const el = bodyBtn(text)
  expect(el, `body 内应有「${text}」按钮`).toBeTruthy()
  el.click(); await flushPromises()
}
// teleport 的弹窗追加在 body 末尾:同名按钮(如「编辑」既是页头结构化编辑,又是弹窗内 YamlEditor 的)
// 取最后一个即弹窗内的那个,避免误点页头同名按钮
async function clickModalBtn(text) {
  const els = bodyBtns(text)
  expect(els.length, `body 内应有「${text}」按钮`).toBeGreaterThan(0)
  els.at(-1).click(); await flushPromises()
}
async function gotoTopology(w) {
  await w.findAll('button').find(b => b.text() === 'topology').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  document.body.innerHTML = ''
  captured.svcAdds.length = 0; captured.metaSaves.length = 0; captured.svcUpdates.length = 0
  notify.mockClear()
  state.workload = JSON.parse(JSON.stringify(demoWorkload))
  state.services = [JSON.parse(JSON.stringify(svcMatching))]
  state.pdbs = []; state.netpols = []
  i18n.global.locale.value = 'zh'
})

test('saveExpose 下发身份 selector——不再快照全量模板 labels(根因回归锁)', async () => {
  const w = mountDetail(); await flushPromises()
  await gotoTopology(w)
  // 拓扑条上两个「+」:Ingress 映射(Service 卡)在前,暴露(Deployment 卡)在后
  const plusButtons = w.findAll('button').filter(b => b.classes().includes('-left-3'))
  expect(plusButtons.length).toBe(2)
  await plusButtons.at(-1).trigger('click'); await flushPromises()
  await clickBody('创建')
  expect(captured.svcAdds).toHaveLength(1)
  // 只锚身份标签 app;team / aliangboard.io/version 等会被元数据编辑器镜像改写的键不得进 selector
  expect(captured.svcAdds[0].selector).toEqual({ app: 'demo-deploy' })
})

test('saveMeta:镜像改动会失配 Service 时拦截,不落库(防线④)', async () => {
  const w = mountDetail(); await flushPromises()
  await w.findAll('button').find(b => b.text() === '元数据').trigger('click'); await flushPromises()
  // 自定义 Labels 区第一个「+ 添加」(第二个在 Annotations 区)
  const addButtons = bodyBtns('+ 添加')
  expect(addButtons.length).toBeGreaterThanOrEqual(2)
  addButtons[0].click(); await flushPromises()
  const keyInputs = [...document.body.querySelectorAll('input[placeholder="key"]')]
  expect(keyInputs.length).toBeGreaterThanOrEqual(1)
  setInput(keyInputs.at(-1), 'team')
  setInput([...document.body.querySelectorAll('input[placeholder="value"]')].at(-1), 'blue')
  await clickBody('保存')
  // team: red→blue 会让 demo-svc(selector 含 team: red)失配 → 必须拦下,updateWorkloadMeta 不得调用
  expect(captured.metaSaves).toHaveLength(0)
})

test('saveMeta:镜像值与模板一致(模板不变)→ 正常保存,不误拦', async () => {
  const w = mountDetail(); await flushPromises()
  await w.findAll('button').find(b => b.text() === '元数据').trigger('click'); await flushPromises()
  bodyBtns('+ 添加')[0].click(); await flushPromises()
  setInput([...document.body.querySelectorAll('input[placeholder="key"]')].at(-1), 'team')
  setInput([...document.body.querySelectorAll('input[placeholder="value"]')].at(-1), 'red')
  await clickBody('保存')
  expect(captured.metaSaves).toHaveLength(1)
})

test('saveTemplate:手编模板改 Service 绑定标签值 → 拦截不 apply', async () => {
  const w = mountDetail(); await flushPromises()
  await w.findAll('button').find(b => b.text() === 'Template').trigger('click'); await flushPromises()
  // 收窄到当前打开的 Modal 根(fixed inset-0):wrapper(attachTo)与 teleport 内容都在 body,
  // 且 Material Symbols 连字文本会混入按钮 textContent(YamlEditor 编辑钮 = 'edit 编辑')
  const modalRoot = [...document.body.querySelectorAll('.fixed.inset-0')].at(-1)
  expect(modalRoot, '模板 Modal 应已打开').toBeTruthy()
  const editBtn = [...modalRoot.querySelectorAll('button')].find(b => b.textContent.includes('编辑'))
  expect(editBtn, 'YamlEditor 应有编辑按钮').toBeTruthy()
  editBtn.click(); await flushPromises()
  const textarea = [...modalRoot.querySelectorAll('textarea')].find(t => t.value.includes('team: red'))
  expect(textarea, '模板 YAML 编辑态应有含模板内容的 textarea').toBeTruthy()
  // 输入即 emit update:modelValue → 视图 templateYaml 已持新 YAML
  // (YamlEditor 既有怪癖:prop 回流会重置 isEditing,故不走行内「应用更改」,走弹窗 Apply 按钮 = 真实用户路径)
  setInput(textarea, textarea.value.replace('team: red', 'team: blue')); await flushPromises()
  await clickModalBtn('Apply') // workload.diff.apply → saveTemplate(templateYaml)
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('demo-svc'))
})

test('拓扑:失配 Service 显性化,一键修复收敛为身份 selector', async () => {
  // 存量病灶形:Service selector 冻结了 team: blue,而模板已是 team: red → ⊆ 不成立,
  // relatedServices 过滤后「坏得看不见」;driftedServices 应让它显形
  state.services = [{ ...JSON.parse(JSON.stringify(svcMatching)), selector: { app: 'demo-deploy', team: 'blue' } }]
  const w = mountDetail(); await flushPromises()
  await gotoTopology(w)
  const repairBtn = w.findAll('button').find(b => b.text() === '修复 selector')
  expect(repairBtn).toBeTruthy()
  await repairBtn.trigger('click'); await flushPromises()
  expect(captured.svcUpdates).toEqual([
    { name: 'demo-svc', updates: { selector: { app: 'demo-deploy' } } },
  ])
})

// --- 防线④精度版(consumersBrokenBy)+ 三类消费者扩面 ---

// meta 弹窗内加一行自定义标签 team:<value> 并点保存(saveMeta 镜像 → 模板 team 变更)
async function metaEditTeam(value) {
  const w = mountDetail(); await flushPromises()
  await w.findAll('button').find(b => b.text() === '元数据').trigger('click'); await flushPromises()
  bodyBtns('+ 添加')[0].click(); await flushPromises()
  setInput([...document.body.querySelectorAll('input[placeholder="key"]')].at(-1), 'team')
  setInput([...document.body.querySelectorAll('input[placeholder="value"]')].at(-1), value)
  await clickBody('保存'); await flushPromises()
  return w
}

test('防线④精度:无关 Service(selector 指向别处)不再误拦,拓扑失配卡也不误报', async () => {
  state.services = [
    JSON.parse(JSON.stringify(svcMatching)),
    { name: 'other-svc', namespace: 'default', type: 'ClusterIP', ports: '80:80/TCP', selector: { app: 'other-app' }, portList: [] },
  ]
  const w = await metaEditTeam('blue')
  // team: red→blue 仍拦 demo-svc;other-svc 从不匹配本负载,不是这次编辑拆的 → 不拦不点名
  expect(captured.metaSaves).toHaveLength(0)
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('Service/demo-svc'))
  expect(notify).not.toHaveBeenCalledWith('error', expect.stringContaining('other-svc'))
  // 拓扑:other-svc 不得出现在失配卡(否则「修复」会把别人的 Service 指到本负载)
  await gotoTopology(w)
  const repairBtns = w.findAll('button').filter(b => b.text() === '修复 selector')
  expect(repairBtns.length).toBe(0)
})

test('防线④扩面:NetworkPolicy podSelector 绑定标签进拦截名单', async () => {
  state.netpols = [{ name: 'np-team', namespace: 'default', podSelector: { app: 'demo-deploy', team: 'red' }, policyTypes: ['Ingress'] }]
  await metaEditTeam('blue')
  expect(captured.metaSaves).toHaveLength(0)
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('NetworkPolicy/np-team'))
})

test('防线④扩面:PDB selector 绑定标签进拦截名单', async () => {
  state.pdbs = [{ name: 'pdb-demo', namespace: 'default', selector: { app: 'demo-deploy', team: 'red' }, minAvailable: '1', maxUnavailable: '', allowedDisruptions: 0, currentHealthy: 1, desiredHealthy: 1, age: '' }]
  await metaEditTeam('blue')
  expect(captured.metaSaves).toHaveLength(0)
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('PDB/pdb-demo'))
})
