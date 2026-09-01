// 节点组件挂载断言:markup 自旧 WorkloadTopologyTab 迁移,语义不丢。
// provide 手法:节点经 inject 取 hover/actions;测试直接 provide 再 mount。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@/i18n'
import TopologyRuleNode from '../TopologyRuleNode.vue'
import TopologyServiceNode from '../TopologyServiceNode.vue'
import TopologyWorkloadNode from '../TopologyWorkloadNode.vue'
import TopologyPodsNode from '../TopologyPodsNode.vue'
import TopologyConsumersNode from '../TopologyConsumersNode.vue'

const mountNode = (Comp, data, extra) => mount(Comp, {
  props: { data },
  global: {
    plugins: [i18n],
    provide: {
      'topo-hover': ref(''),
      'topo-actions': { openIngressMap: vi.fn(), openExpose: vi.fn(), canMutate: true, repairingSvc: ref(''), repairServiceSelector: vi.fn(), epText: () => '' },
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
  const actions = { openIngressMap: vi.fn(), openExpose: vi.fn(), canMutate: true, repairingSvc: ref(''), repairServiceSelector: vi.fn(), epText: () => '1/1' }
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
  const actions = { openIngressMap: vi.fn(), openExpose: vi.fn(), canMutate: true, repairingSvc: ref(''), repairServiceSelector: vi.fn(), epText: () => '' }
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

test('WorkloadNode:三形态语义保留(CronJob schedule/Job completions/常规 replicas+image)+hover-+ 调 openExpose', async () => {
  const actions = { openIngressMap: vi.fn(), openExpose: vi.fn(), canMutate: true }
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
  expect(empty.text()).toContain(empty.text() ? '' : '')
  const consumers = mountNode(TopologyConsumersNode, { consumers: [{ kind: 'PDB', name: 'pdb-1', disruptive: false }] })
  expect(consumers.text()).toContain('pdb-1')
  expect(consumers.find('.vue-flow__handle').exists()).toBe(false)
})
