// src/logic/topologyFlow.test.mjs —— 拓扑 flow 图推导纯逻辑(零 vue-flow 依赖)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveFlowGraph, attachEdgeStates, COL_WIDTH, COL_GAP } from './topologyFlow.js'

const baseInput = () => ({
  ownRules: [
    { ingress: 'a-ing', host: 'a.com', path: '/', serviceName: 'svc-a', port: 80 },
    { ingress: 'a-ing', host: 'b.com', path: '/api', serviceName: 'svc-a', port: 80 },
    { ingress: 'b-ing', host: 'c.com', path: '/', serviceName: 'svc-b', port: 8080 },
  ],
  others: [{ name: 'shared-ing', count: 2 }],
  relatedServices: [
    { name: 'svc-a', type: 'ClusterIP', ports: '80:8080/TCP' },
    { name: 'svc-b', type: 'ClusterIP', ports: '8080:9090/TCP' },
  ],
  driftedServices: [{ name: 'svc-x', type: 'ClusterIP', ports: '80:80/TCP', drift: 'broken' }],
  workload: { name: 'demo', type: 'Deployment' },
  governingSvcName: '',
  labelConsumers: [{ kind: 'PDB', name: 'pdb-1', disruptive: false }],
  hasPods: true,
})

test('节点全集:规则×3+服务×2+失配×1+workload+pods+consumers,id/type/列序正确', () => {
  const { nodes } = deriveFlowGraph(baseInput())
  const byType = t => nodes.filter(n => n.type === t)
  assert.equal(byType('rule').length, 3)
  assert.equal(byType('service').length, 2)
  assert.equal(byType('service')[0].id, 'svc:svc-a')
  assert.equal(byType('drift').length, 1)
  assert.equal(byType('workload').length, 1)
  assert.equal(byType('pods').length, 1)
  assert.equal(byType('consumers').length, 1)
  // 四列 x 坐标单调
  const xs = ['rule', 'service', 'workload', 'pods'].map(t => byType(t)[0].position.x)
  assert.ok(xs[0] < xs[1]); assert.ok(xs[1] < xs[2]); assert.ok(xs[2] < xs[3])
})

test('边:多规则扇入同一 Service(2 条 route 边指向 svc-a)+ svc 边 + drift 红边;others/consumers 不产边', () => {
  const { edges } = deriveFlowGraph(baseInput())
  const routeToA = edges.filter(e => e.class.includes('topo-edge-route') && e.target === 'svc:svc-a')
  assert.equal(routeToA.length, 2)
  assert.equal(edges.filter(e => e.class.includes('topo-edge-svc')).length, 2)
  const drift = edges.filter(e => e.class.includes('topo-edge-drift'))
  assert.equal(drift.length, 1)
  assert.equal(drift[0].source, 'drift:svc-x'); assert.equal(drift[0].target, 'workload')
  assert.equal(edges.some(e => e.source.includes('shared') || e.target.includes('shared')), false)
  assert.equal(edges.some(e => e.source === 'consumers' || e.target === 'consumers'), false)
})

test('列内 y 累加:同列节点 x 相同、y 严格递增且间距>0', () => {
  const { nodes } = deriveFlowGraph(baseInput())
  const rules = nodes.filter(n => n.type === 'rule')
  assert.equal(new Set(rules.map(n => n.position.x)).size, 1)
  const ys = rules.map(n => n.position.y)
  assert.ok(ys[1] > ys[0]); assert.ok(ys[2] > ys[1])
})

test('规则数据随节点 data 携带(host/path/serviceName/port/ingress);governing 徽章数据下发', () => {
  const { nodes } = deriveFlowGraph(baseInput())
  const r0 = nodes.find(n => n.id === 'rule:0')
  assert.deepEqual(r0.data, { host: 'a.com', path: '/', serviceName: 'svc-a', port: 80, ingress: 'a-ing' })
  const wa = nodes.find(n => n.id === 'workload')
  assert.equal(wa.data.workload.name, 'demo')
})

test('空态:无规则/无服务/无失配/无消费者 → 相应节点与边为零,workload+pods 仍在(pods 走 hasPods=false 空态)', () => {
  const { nodes, edges } = deriveFlowGraph({ ownRules: [], others: [], relatedServices: [], driftedServices: [], workload: { name: 'x', type: 'Job' }, governingSvcName: '', labelConsumers: [], hasPods: false })
  assert.deepEqual(nodes.map(n => n.type).sort(), ['pods', 'workload'])
  assert.equal(nodes.find(n => n.type === 'pods').data.hasPods, false)
  assert.equal(edges.length, 0)
})

test('attachEdgeStates:hover 命中边 active、无关边 dim;空 hover 全部恢复', () => {
  const { edges } = deriveFlowGraph(baseInput())
  const on = attachEdgeStates(edges, 'svc-a')
  assert.ok(on.find(e => e.id === 'e:rule:0->svc:svc-a').class.includes('topo-edge--active'))
  assert.ok(on.find(e => e.id === 'e:svc:svc-b->workload').class.includes('topo-edge--dim'))
  const off = attachEdgeStates(edges, '')
  assert.ok(off.every(e => !e.class.includes('topo-edge--active') && !e.class.includes('topo-edge--dim')))
})

test('布局常量:列宽/列距为正数且列 x = 序×(COL_WIDTH+COL_GAP)', () => {
  const { nodes } = deriveFlowGraph(baseInput())
  const rule = nodes.find(n => n.type === 'rule')
  const pods = nodes.find(n => n.type === 'pods')
  assert.ok(COL_WIDTH > 0); assert.ok(COL_GAP > 0)
  assert.equal(pods.position.x - rule.position.x, 3 * (COL_WIDTH + COL_GAP))
})
