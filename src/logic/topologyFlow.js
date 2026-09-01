// src/logic/topologyFlow.js —— 拓扑 flow 图推导纯逻辑(2026-09-01 拓扑连线化)。
// 从 useWorkloadTopology 的产出推导 VueFlow 节点/边/固定四列布局;零 vue-flow 依赖。
// 列序:0=Ingress 规则 1=Service(含失配) 2=Workload 3=Pods;y=数据驱动估算行高累加,
// 挂载后由宿主用节点实测尺寸一次校正(见 WorkloadTopologyTab)。
export const COL_WIDTH = 240
export const COL_GAP = 48
const COL = { rule: 0, service: 1, workload: 2, pods: 3 }

// 估算行高(与节点组件的实际内容行数同源;实测校正兜底漂移)
const estRuleH = () => 46
const estServiceH = s => 40 + (s.ports ? 16 : 0) + (s.endpoints ? 16 : 0)
const estDriftH = () => 58
const estConsumersH = c => 18 + c.length * 18
const estWorkloadH = () => 210
const estPodsH = () => 340

export function deriveFlowGraph(input) {
  const { ownRules = [], relatedServices = [], driftedServices = [], workload, governingSvcName = '', labelConsumers = [], hasPods = false } = input
  const nodes = []
  const edges = []
  const colX = t => COL[t] * (COL_WIDTH + COL_GAP)

  // 列 0:Ingress 规则(每规则一节点,扇入来源)
  ownRules.forEach((r, i) => {
    nodes.push({ id: `rule:${i}`, type: 'rule', position: { x: colX('rule'), y: i * estRuleH() }, data: { ...r } })
    if (relatedServices.some(s => s.name === r.serviceName)) {
      edges.push({ id: `e:rule:${i}->svc:${r.serviceName}`, source: `rule:${i}`, target: `svc:${r.serviceName}`, type: 'smoothstep', class: 'topo-edge topo-edge-route', markerEnd: '' })
    }
  })

  // 列 1:Service(正常+失混分列内先后,各自累加 y)
  let svcY = 0
  for (const s of relatedServices) {
    const governing = s.name === governingSvcName
    nodes.push({ id: `svc:${s.name}`, type: 'service', position: { x: colX('service'), y: svcY }, data: { ...s, governing, endpoints: s.endpoints ?? null } })
    svcY += estServiceH(s) + 8
    edges.push({ id: `e:svc:${s.name}->workload`, source: `svc:${s.name}`, target: 'workload', type: 'smoothstep', class: 'topo-edge topo-edge-svc', markerEnd: '' })
  }
  let driftY = 0
  for (const s of driftedServices) {
    nodes.push({ id: `drift:${s.name}`, type: 'drift', position: { x: colX('service'), y: svcY + driftY }, data: { ...s, governing: false, endpoints: s.endpoints ?? null } })
    driftY += estDriftH() + 8
    edges.push({ id: `e:drift:${s.name}->workload`, source: `drift:${s.name}`, target: 'workload', type: 'smoothstep', class: 'topo-edge topo-edge-drift', markerEnd: '' })
  }

  // 列 2:Workload(单节点);列 3:Pods(整列一节点,有 Pod 才渲染)
  nodes.push({ id: 'workload', type: 'workload', position: { x: colX('workload'), y: 0 }, data: { workload } })
  if (hasPods) {
    nodes.push({ id: 'pods', type: 'pods', position: { x: colX('pods'), y: 0 }, data: { hasPods } })
  }

  // Service 列尾:标签消费者(有内容才渲染;无连线)
  if (labelConsumers.length) {
    nodes.push({ id: 'consumers', type: 'consumers', position: { x: colX('service'), y: svcY + driftY + 8 }, data: { consumers: labelConsumers } })
  }
  return { nodes, edges }
}

// hover 态注入:命中边 active、与 hover 无关的边 dim(纯函数,宿主 computed 调用)
export function attachEdgeStates(edges, hoveredName) {
  if (!hoveredName) return edges.map(e => ({ ...e, class: e.class.replace(/ ?topo-edge--(active|dim)/g, '') }))
  return edges.map(e => {
    const hit = e.source === `svc:${hoveredName}` || e.source === `drift:${hoveredName}` ||
      (e.class.includes('topo-edge-route') && e.target === `svc:${hoveredName}`)
    return { ...e, class: hit ? `${e.class} topo-edge--active` : `${e.class} topo-edge--dim` }
  })
}
