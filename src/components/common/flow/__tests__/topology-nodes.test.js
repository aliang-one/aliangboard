// 节点组件挂载断言:markup 自旧 WorkloadTopologyTab 迁移,语义不丢。
// provide 手法:节点经 inject 取 hover/actions;测试直接 provide 再 mount。
// provide 必须用 reactive({... canMutate: computed ...}) 复刻宿主真实契约(R1 C2:
// 普通对象内嵌 computed 不被解包,组件读到的恒为 computed 对象=truthy,canMutate 门禁失效)。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, reactive, ref } from 'vue'
import { i18n } from '@/i18n'
import TopologyRuleNode from '../TopologyRuleNode.vue'
import TopologyServiceNode from '../TopologyServiceNode.vue'
import TopologyWorkloadNode from '../TopologyWorkloadNode.vue'
import TopologyPodsNode from '../TopologyPodsNode.vue'
import TopologyConsumersNode from '../TopologyConsumersNode.vue'

const makeActions = over => reactive({
  openIngressMap: vi.fn(), openExpose: vi.fn(),
  canMutate: computed(() => true), gotoService: vi.fn(),
  repairingSvc: ref(''), identitySel: computed(() => ({ ns: 'default' })), repairServiceSelector: vi.fn(),
  epText: () => '',
  ...over,
})
const mountNode = (Comp, data, extra) => mount(Comp, {
  props: { data },
  global: {
    plugins: [i18n],
    provide: {
      'topo-hover': ref(''),
      'topo-actions': makeActions(),
      ...(extra?.provide || {}),
    },
  },
})

test('RuleNode:content+Handle+点击跳转', async () => {
  const goto = vi.fn()
  const w = mountNode(TopologyRuleNode, { ingress: 'a-ing', host: 'a.com', path: '/', serviceName: 'svc-a', port: 80, goto })
  expect(w.text()).toContain('a.com'); expect(w.text()).toContain('svc-a')
  expect(w.find('.vue-flow__handle').exists()).toBe(true)
  await w.find('.topo-rule').trigger('click')
  expect(goto).toHaveBeenCalledWith({ name: 'NsIngressDetail', params: { namespace: undefined, name: 'a-ing' } })
})

test('ServiceNode(normal):governing 徽章/endpoints 行/hover-+ 调 openIngressMap(指定名)', async () => {
  const actions = makeActions({ epText: () => '1/1' })
  const w = mount(TopologyServiceNode, {
    props: { data: { name: 'svc-a', type: 'ClusterIP', ports: '80:8080/TCP', governing: true, endpoints: { ready: 1, total: 1 } } },
    global: { plugins: [i18n], provide: { 'topo-hover': ref(''), 'topo-actions': actions } },
  })
  expect(w.text()).toContain('svc-a')
  expect(w.find('.topo-governing-badge').exists()).toBe(true)
  await w.find('.topo-svc-add').trigger('mouseenter')
  await w.find('.topo-svc-add').trigger('click')
  expect(actions.openIngressMap).toHaveBeenCalledWith('svc-a')
  expect(w.find('.vue-flow__handle').exists()).toBe(true)
})

test('ServiceNode(drift):broken 色样+修复钮调 repairServiceSelector;hover-+ 同样可建 Ingress', async () => {
  const actions = makeActions()
  const w = mount(TopologyServiceNode, {
    props: { data: { name: 'svc-x', type: 'ClusterIP', ports: '80:80/TCP', drift: 'broken', governing: false, endpoints: null } },
    global: { plugins: [i18n], provide: { 'topo-hover': ref(''), 'topo-actions': actions } },
  })
  expect(w.find('.topo-drift').exists()).toBe(true)
  await w.find('.topo-repair-btn').trigger('click')
  expect(actions.repairServiceSelector).toHaveBeenCalledWith('svc-x')
  await w.find('.topo-svc-add').trigger('click')
  expect(actions.openIngressMap).toHaveBeenCalledWith('svc-x')
})

// R1 C2:canMutate 必须经 reactive 解包生效——false 时 hover-+ 不渲染、修复钮 disabled。
test('ServiceNode:reactive provide 的 canMutate=false 生效(无 + 钮/修复钮 disabled)', () => {
  const actions = makeActions({ canMutate: computed(() => false) })
  const w = mount(TopologyServiceNode, {
    props: { data: { name: 'svc-ro', type: 'ClusterIP', ports: '80:80/TCP', drift: 'broken', governing: false, endpoints: null } },
    global: { plugins: [i18n], provide: { 'topo-hover': ref(''), 'topo-actions': actions } },
  })
  expect(w.find('.topo-svc-add').exists()).toBe(false)
  expect(w.find('.topo-repair-btn').attributes('disabled')).toBeDefined()
})

// R1 I4:identity 缺失(identitySel 空)时修复钮禁用 + title 三段含 identityRequired。
test('ServiceNode(drift):identitySel 空对象→修复钮 disabled,title 带 identity 提示', () => {
  const actions = makeActions({ identitySel: computed(() => ({})) })
  const w = mount(TopologyServiceNode, {
    props: { data: { name: 'svc-x', type: 'ClusterIP', ports: '80:80/TCP', drift: 'pending', governing: false, endpoints: null } },
    global: { plugins: [i18n], provide: { 'topo-hover': ref(''), 'topo-actions': actions } },
  })
  const btn = w.find('.topo-repair-btn')
  expect(btn.attributes('disabled')).toBeDefined()
  expect(btn.attributes('title')).toContain(i18n.global.t('workload.expose.identityRequired'))
  expect(btn.attributes('title')).toContain(i18n.global.t('workload.topology.driftHeuristic'))
})

test('WorkloadNode:三形态语义保留(CronJob schedule/Job completions/常规 replicas+image)+hover-+ 调 openExpose', async () => {
  const actions = makeActions()
  const w = mount(TopologyWorkloadNode, {
    props: { data: { workload: { name: 'demo', type: 'Deployment', replicas: 3, age: '2d', image: 'nginx:1.25' }, cronSchedule: '', cronSuspended: false, jobCompletions: { s: 0, total: '*' }, hpas: [], replicaSets: [], configRefs: [], gotoRevisions: vi.fn(), gotoRef: vi.fn(), gotoHpa: vi.fn() } },
    global: { plugins: [i18n], provide: { 'topo-hover': ref(''), 'topo-actions': actions } },
  })
  expect(w.text()).toContain('demo')
  expect(w.text()).toContain('3')
  await w.find('.topo-wl-add').trigger('click')
  expect(actions.openExpose).toHaveBeenCalledTimes(1)
})

test('PodsNode/ConsumersNode:hasPods 空态文案/消费者 chips 渲染且无 Handle', () => {
  const empty = mountNode(TopologyPodsNode, { hasPods: false })
  expect(empty.text()).toContain('deployed_code')
  expect(empty.text()).toContain(i18n.global.t('workload.topology.noPods'))
  const consumers = mountNode(TopologyConsumersNode, { consumers: [{ kind: 'PDB', name: 'pdb-1', disruptive: false }] })
  expect(consumers.text()).toContain('pdb-1')
  expect(consumers.find('.vue-flow__handle').exists()).toBe(false)
})

// R1 C1:ungrouped Pod 段(无归属 RS)必须渲染,行同 groups 且可跳转。
test('PodsNode:ungrouped 段渲染(rsUngrouped 头行+gotoPod)', async () => {
  const gotoPod = vi.fn()
  const w = mountNode(TopologyPodsNode, {
    groups: [{ rsName: 'rs-a', ready: 1, desired: 1, pods: [{ name: 'p-a', ready: true, restarts: 0, age: '1h' }] }],
    ungrouped: [{ name: 'p-orphan', ready: true, restarts: 0, age: '2h' }],
    gotoPod,
  })
  expect(w.text()).toContain(i18n.global.t('workload.topology.rsUngrouped'))
  expect(w.text()).toContain('p-orphan')
  const rows = w.findAll('[role="button"]')
  await rows[rows.length - 1].trigger('click')
  expect(gotoPod).toHaveBeenCalledWith(expect.objectContaining({ name: 'p-orphan' }))
})

// R1 I5:pending=podsPending 骨架行,不出 noPods 文案。
test('PodsNode:pending 骨架 3 行,不渲染空态文案', () => {
  const w = mountNode(TopologyPodsNode, { pending: true, groups: [], ungrouped: [], gotoPod: vi.fn() })
  expect(w.findAll('.animate-pulse').length).toBe(3)
  expect(w.text()).not.toContain(i18n.global.t('workload.topology.noPods'))
})
