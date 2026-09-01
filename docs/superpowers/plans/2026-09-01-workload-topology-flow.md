# 工作负载拓扑连线化(Vue Flow)— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拓扑 Tab 四列流水线迁 `@vue-flow/core` 画布:规则粒度 Ingress→Service 扇入连线、Service→Workload 连线、失配红虚线;加号全部落卡(hover Service 卡建绑定该卡的 Ingress,hover Workload 卡 expose)。

**Architecture:** 纯逻辑 `src/logic/topologyFlow.js`(节点/边/布局推导,零 vue-flow 依赖)→ 5 个自定义节点 SFC(旧卡片模板迁移)→ `WorkloadTopologyTab.vue` 重写为 `<VueFlow>` 宿主(布局/边态/hover provide)→ `openIngressMap(serviceName?)` 参数化。弹窗本体与保存逻辑零改动(仍宿主于 NsWorkloadDetail)。

**Tech Stack:** Vue 3 + @vue-flow/core(v1)+ vitest/happy-dom;vue-i18n。

**Spec:** `docs/superpowers/specs/2026-09-01-workload-topology-flow-design.md`

## Global Constraints

- 只引 `@vue-flow/core` 单包;**禁引** background/minimap/controls/dagre;必引 `@vue-flow/core/dist/style.css`,禁 theme-default。
- 颜色一律项目 CSS 变量/token,禁硬编码 hex(style token 约定)。
- 弹窗本体(NsWorkloadDetail :2161 expose / :2181 ingressMap)、`saveExpose/saveIngressMap` 保存逻辑、`filterOwnIngressRules/classifyServiceDrift` 判定逻辑**零改动**;动作层只允许 `openIngressMap` 加可选参。
- 画布:`zoom-on-scroll=false`、`pan-on-drag=true`、`nodes-draggable=false`、`fit-view-on-init` 一次;布局单源=logic 模块,节点实测尺寸只做一次校正。
- `others`(共享 Ingress 他人路由)与 PDB/NetPol 消费者节点**不产边**。
- 既有交互语义不丢:点击跳转、`hoveredSvc` 联动、`canMutate` 禁用、失配一键修复、governing 徽章、endpoints 红行。
- 提交作者恒 `aliang-one <aliangdone@gmail.com>`(repo config 兜底),禁 `Co-Authored-By` 尾注。
- i18n 新键 zh/en 成对:`workload.topology.addIngressFor` / `workload.topology.addExpose`(值见 Task 5)。
- 门禁四件:`npm run test:unit` + `npm run i18n:check` + `npm run typecheck` + `npm run build`。
- worktree 分支实施,`--no-ff` 合回 main。

---

### Task 1: 依赖登记 + 安装 + happy-dom 冒烟(fail-fast)

**Files:**
- Modify: `CLAUDE.md`(依赖政策表)
- Modify: `package.json`(dependencies)
- Modify: `tests/setup.js`(ResizeObserver 全局 stub)
- Create: `src/components/common/__tests__/topology-flow.mount.test.js`(冒烟)

**Interfaces:**
- Produces: 全局 `ResizeObserver` stub(observe/unobserve/disconnect no-op,回调存 `__cb` 供手动触发);已安装的 `@vue-flow/core`(后续所有任务的 import 来源)。冒烟测试锁「VueFlow+自定义节点可在 happy-dom 挂载」这一前提——**若本任务红灯,后续任务设计须改(降级 stub 方案),立即 STOP 上报**。

- [ ] **Step 1: 冒烟测试先行(期望失败:依赖未装)**

创建 `src/components/common/__tests__/topology-flow.mount.test.js`:

```js
// VueFlow 在 happy-dom 的可挂载性冒烟(2026-09-01 拓扑连线化 Task 1)。
// vue-flow 依赖 ResizeObserver/尺寸测量——setup.js 提供 stub;本测试锁该前提,
// 在任何拓扑重写工作开始前 fail-fast。
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { markRaw, defineComponent, h } from 'vue'
import { VueFlow, Handle, Position } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import { i18n } from '@/i18n'

const Mini = defineComponent({
  setup() {
    return () => h('div', { class: 'mini-node' }, [
      h(Handle, { type: 'target', position: Position.Left }),
      h('span', null, 'mini'),
      h(Handle, { type: 'source', position: Position.Right }),
    ])
  },
})

test('VueFlow + 自定义节点可在 happy-dom 挂载并渲染节点 DOM', async () => {
  const w = mount(VueFlow, {
    props: {
      nodes: [{ id: 'n1', type: 'mini', position: { x: 0, y: 0 } }],
      edges: [{ id: 'e1', source: 'n1', target: 'n1', type: 'smoothstep' }],
      nodeTypes: { mini: markRaw(Mini) },
      fitViewOnInit: false, zoomOnScroll: false, nodesDraggable: false,
    },
    global: { plugins: [i18n] },
  })
  await flush()
  expect(w.find('.vue-flow').exists()).toBe(true, 'VueFlow 根容器渲染')
  expect(w.find('.mini-node').exists()).toBe(true, '自定义节点渲染')
  expect(w.find('.mini-node').text()).toContain('mini')
})

function flush() { return new Promise(r => setTimeout(r, 0)) }
```

- [ ] **Step 2: 跑测试确认失败原因=依赖缺失**

Run: `npx vitest run src/components/common/__tests__/topology-flow.mount.test.js`
Expected: FAIL——`Failed to resolve import "@vue-flow/core"`。

- [ ] **Step 3: 安装依赖 + ResizeObserver stub + CLAUDE.md 登记**

```bash
npm install @vue-flow/core --no-audit --no-fund
```

`package.json` dependencies(字母序插入 echarts 附近):`"@vue-flow/core": "^1.45.0"`(以 npm 实际写入为准,勿手改版本号)。

`tests/setup.js` 末尾追加:

```js
// vue-flow(拓扑连线画布)依赖 ResizeObserver 做节点尺寸测量;happy-dom 无此 API。
// 提供 no-op stub:回调挂 __cb 供用例手动触发(如需模拟尺寸变化)。
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    constructor(cb) { this.__cb = cb }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
if (!globalThis.getComputedStyle) {
  // happy-dom 已实现 getComputedStyle;此分支仅为显式守卫,勿动
}
```

(注:第二段守卫如与现状重复则省略——只加 ResizeObserver 段。)

`CLAUDE.md` 依赖政策表追加一行(与既有行同格式):

```markdown
| `@vue-flow/core` | 运行时（dependencies） | 拓扑页节点/连线画布:四列流水线迁 flow 画布,Ingress 规则→Service→Workload 只读连线+失配红虚线,为后续拖拽/布局/缩放留扩展空间。 | 2026-09-01 用户指定（拓扑连线化设计 `docs/superpowers/specs/2026-09-01-workload-topology-flow-design.md`） |
```

- [ ] **Step 4: 跑冒烟确认通过(或触发降级决策)**

Run: `npx vitest run src/components/common/__tests__/topology-flow.mount.test.js`
Expected: PASS。
**若仍 FAIL**(vue-flow 挂载链在 happy-dom 断裂):STOP,以 BLOCKED 上报,附完整错误——后续任务须转「全局 stub VueFlow + logic 层锁语义」降级设计,由控制者重排。

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md package.json package-lock.json tests/setup.js src/components/common/__tests__/topology-flow.mount.test.js
git commit --author="aliang-one <aliangdone@gmail.com>" -m "feat(topology): 引入 @vue-flow/core(依赖政策登记)+happy-dom 冒烟锁可挂载性"
```

---

### Task 2: 纯逻辑 `topologyFlow.js`(节点/边/布局推导)

**Files:**
- Create: `src/logic/topologyFlow.js`
- Create: `src/logic/topologyFlow.test.mjs`

**Interfaces:**
- Consumes(仅数据形状,无 import):`ownRules: [{ ingress, host, path, serviceName, port }]`、`others: [{ name, count }]`、`relatedServices: [{ name, type, ports, selector, portList?, raw? }]`、`driftedServices: [{ name, drift: 'broken'|'pending-break', ...同上 }]`、`workload: { name, type, ... }`、`labelConsumers: [{ kind, name, disruptive? }]`、`hasPods: boolean`、`governingSvcName: string`。
- Produces(Task 3/4 唯一消费面):
  - `deriveFlowGraph(input) → { nodes, edges }`
    - 节点:`{ id, type, position: {x,y}, data }`;type ∈ `rule|service|workload|pods|consumers`;id 约定 `rule:<idx>`、`svc:<name>`、`drift:<name>`、`workload`、`pods`、`consumers`
    - 边:`{ id, source, target, type: 'smoothstep', class, markerEnd: '' }`;class ∈ `topo-edge topo-edge-route|topo-edge-svc|topo-edge-drift`;id 约定 `e:rule:<idx>->svc:<name>`、`e:svc:<name>->workload`、`e:drift:<name>->workload`
  - `attachEdgeStates(edges, hoveredName) → edges'`(hover 命中的边加 `topo-edge--active`,未命中非 hover 相关边加 `topo-edge--dim`;hoveredName 为空串=无态)
  - `HOVER_EXTRACT = { rule: r => r.serviceName, service: n => n, drift: n => n }`(node data→hover 键,Task 4 用)
  - 布局常量导出:`COL_WIDTH=240, COL_GAP=48`(供 Task 4 容器宽度估算)

- [ ] **Step 1: 写失败测试 `src/logic/topologyFlow.test.mjs`**

```js
// src/logic/topologyFlow.test.mjs —— 拓扑 flow 图推导纯逻辑(零 vue-flow 依赖)。
import { test, expect } from 'vitest'
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
  expect(byType('rule')).toHaveLength(3)
  expect(byType('service')).toHaveLength(2)
  expect(byType('service')[0].id).toBe('svc:svc-a')
  expect(byType('drift')).toHaveLength(1)
  expect(byType('workload')).toHaveLength(1)
  expect(byType('pods')).toHaveLength(1)
  expect(byType('consumers')).toHaveLength(1)
  // 四列 x 坐标单调
  const xs = ['rule', 'service', 'workload', 'pods'].map(t => byType(t)[0].position.x)
  expect(xs[0]).toBeLessThan(xs[1]); expect(xs[1]).toBeLessThan(xs[2]); expect(xs[2]).toBeLessThan(xs[3])
})

test('边:多规则扇入同一 Service(2 条 route 边指向 svc-a)+ svc 边 + drift 红边;others/consumers 不产边', () => {
  const { edges } = deriveFlowGraph(baseInput())
  const routeToA = edges.filter(e => e.class.includes('topo-edge-route') && e.target === 'svc:svc-a')
  expect(routeToA).toHaveLength(2)
  expect(edges.filter(e => e.class.includes('topo-edge-svc'))).toHaveLength(2)
  const drift = edges.filter(e => e.class.includes('topo-edge-drift'))
  expect(drift).toHaveLength(1)
  expect(drift[0].source).toBe('drift:svc-x'); expect(drift[0].target).toBe('workload')
  expect(edges.some(e => e.source.includes('shared') || e.target.includes('shared'))).toBe(false)
  expect(edges.some(e => e.source === 'consumers' || e.target === 'consumers')).toBe(false)
})

test('列内 y 累加:同列节点 x 相同、y 严格递增且间距>0', () => {
  const { nodes } = deriveFlowGraph(baseInput())
  const rules = nodes.filter(n => n.type === 'rule')
  expect(new Set(rules.map(n => n.position.x)).size).toBe(1)
  const ys = rules.map(n => n.position.y)
  expect(ys[1]).toBeGreaterThan(ys[0]); expect(ys[2]).toBeGreaterThan(ys[1])
})

test('规则数据随节点 data 携带(host/path/serviceName/port/ingress);governing 徽章数据下发', () => {
  const { nodes } = deriveFlowGraph(baseInput())
  const r0 = nodes.find(n => n.id === 'rule:0')
  expect(r0.data).toMatchObject({ host: 'a.com', path: '/', serviceName: 'svc-a', port: 80, ingress: 'a-ing' })
  const wa = nodes.find(n => n.id === 'workload')
  expect(wa.data.workload.name).toBe('demo')
})

test('空态:无规则/无服务/无失配/无消费者 → 相应节点与边为零,workload+pods 仍在', () => {
  const { nodes, edges } = deriveFlowGraph({ ownRules: [], others: [], relatedServices: [], driftedServices: [], workload: { name: 'x', type: 'Job' }, governingSvcName: '', labelConsumers: [], hasPods: false })
  expect(nodes.map(n => n.type).sort()).toEqual(['workload'])
  expect(edges).toHaveLength(0)
})

test('attachEdgeStates:hover 命中边 active、无关边 dim;空 hover 全部恢复', () => {
  const { edges } = deriveFlowGraph(baseInput())
  const on = attachEdgeStates(edges, 'svc-a')
  expect(on.find(e => e.id === 'e:rule:0->svc:svc-a').class).toContain('topo-edge--active')
  expect(on.find(e => e.id === 'e:svc:svc-b->workload').class).toContain('topo-edge--dim')
  const off = attachEdgeStates(edges, '')
  expect(off.every(e => !e.class.includes('topo-edge--active') && !e.class.includes('topo-edge--dim'))).toBe(true)
})

test('布局常量:列宽/列距为正数且列 x = 序×(COL_WIDTH+COL_GAP)', () => {
  const { nodes } = deriveFlowGraph(baseInput())
  const rule = nodes.find(n => n.type === 'rule')
  const pods = nodes.find(n => n.type === 'pods')
  expect(COL_WIDTH).toBeGreaterThan(0); expect(COL_GAP).toBeGreaterThan(0)
  expect(pods.position.x - rule.position.x).toBe(3 * (COL_WIDTH + COL_GAP))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/logic/topologyFlow.test.mjs`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 `src/logic/topologyFlow.js`**

```js
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
    nodes.push({ id: `drift:${s.name}`, type: 'service', position: { x: colX('service'), y: svcY + driftY }, data: { ...s, governing: false, endpoints: s.endpoints ?? null } })
    driftY += estDriftH() + 8
    edges.push({ id: `e:drift:${s.name}->workload`, source: `drift:${s.name}`, target: 'workload', type: 'smoothstep', class: 'topo-edge topo-edge-drift', markerEnd: '' })
  }

  // 列 2:Workload(单节点);列 3:Pods(整列一节点,空态仍渲染骨架语义由 data.hasPods)
  nodes.push({ id: 'workload', type: 'workload', position: { x: colX('workload'), y: 0 }, data: { workload } })
  nodes.push({ id: 'pods', type: 'pods', position: { x: colX('pods'), y: 0 }, data: { hasPods } })

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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/logic/topologyFlow.test.mjs`
Expected: PASS(7 条)。

- [ ] **Step 5: Commit**

```bash
git add src/logic/topologyFlow.js src/logic/topologyFlow.test.mjs
git commit --author="aliang-one <aliangdone@gmail.com>" -m "feat(topology): flow 图推导纯逻辑——规则扇入/svc/drift 边+固定四列估算布局+hover 边态"
```

---

### Task 3: 自定义节点组件(5 个 SFC,旧卡片模板迁移)

**Files:**
- Create: `src/components/common/flow/TopologyRuleNode.vue`
- Create: `src/components/common/flow/TopologyServiceNode.vue`(normal+drift 双态)
- Create: `src/components/common/flow/TopologyWorkloadNode.vue`
- Create: `src/components/common/flow/TopologyPodsNode.vue`
- Create: `src/components/common/flow/TopologyConsumersNode.vue`
- Create: `src/components/common/flow/__tests__/topology-nodes.test.js`

**Interfaces:**
- Consumes: vue-flow 的 `Handle`/`Position`;`inject('topo-hover')`(ref,hover 键单源)、`inject('topo-actions')`(`{ openIngressMap(name), openExpose(), canMutate }`,Task 4 provide);node `props.data`;podHealth/imgBase/imgTag(`@/composables/usePod`);`useI18n`。
- Produces(Task 4 的 nodeTypes 注册表):5 个组件,均含必要 `Handle`(rule=仅 source Right;service/drift=target Left+source Right;workload=target Left;pods/consumers=无 Handle)。

- [ ] **Step 1: 写失败测试(创建 `src/components/common/flow/__tests__/topology-nodes.test.js`,全文如下)**

`src/components/common/flow/__tests__/topology-nodes.test.js`:

```js
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

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/flow/__tests__/topology-nodes.test.js`
Expected: FAIL——组件文件不存在。

- [ ] **Step 3: 实现 5 个节点组件**

`TopologyRuleNode.vue`:

```vue
<script setup>
// 拓扑 flow 节点:Ingress 规则(host/path→svc:port),每规则一节点(扇入来源)。
// markup 自 WorkloadTopologyTab 迁移(2026-09-01);跳转经 data.goto 注入。
import { Handle, Position } from '@vue-flow/core'
import { inject } from 'vue'
const props = defineProps({ data: { type: Object, required: true } })
const hovered = inject('topo-hover')
function enter() { hovered.value = props.data.serviceName }
function leave() { hovered.value = '' }
</script>
<template>
  <div class="topo-rule rounded-lg border border-outline-variant/60 px-sm py-1.5 bg-surface-container-lowest cursor-pointer hover:border-primary hover:bg-primary/5 transition-colors"
    :class="hovered === data.serviceName ? 'ring-2 ring-primary' : ''"
    @click="data.goto?.({ name: 'NsIngressDetail', params: { namespace: data.namespace, name: data.ingress } })"
    @mouseenter="enter" @mouseleave="leave">
    <p class="font-mono text-xs text-primary font-semibold truncate">{{ data.host }}<span class="text-on-surface-variant font-normal">{{ data.path }}</span></p>
    <p class="text-[11px] text-on-surface-variant truncate">→ {{ data.serviceName }}<span v-if="data.port">:{{ data.port }}</span></p>
    <Handle type="source" :position="Position.Right" />
  </div>
</template>
```

`TopologyServiceNode.vue`(normal+drift 双态;hover-+ 落卡):

```vue
<script setup>
// 拓扑 flow 节点:Service(normal)+ 失配(drift 变体)。governing 徽章/endpoints 红行/
// 一键修复语义自旧 Tab 迁移;hover-+(右上)以指定 Service 名开 ingress-map 弹窗。
import { Handle, Position } from '@vue-flow/core'
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const props = defineProps({ data: { type: Object, required: true } })
const hovered = inject('topo-hover')
const actions = inject('topo-actions')
const drift = () => !!props.data.drift
const ringCls = () => (drift() ? (props.data.drift === 'broken' ? 'ring-error' : 'ring-primary') : 'ring-primary')
function enter() { hovered.value = props.data.name }
function leave() { hovered.value = '' }
</script>
<template>
  <div class="relative rounded-lg border px-sm py-1.5 transition-colors"
    :class="[
      drift() ? (data.drift === 'broken' ? 'border-error/50 bg-error/5' : 'border-tertiary-container/40 bg-tertiary-container/5') : 'border-outline-variant/60 bg-surface-container-lowest hover:border-primary hover:bg-primary/5 cursor-pointer',
      hovered === data.name ? `ring-2 ${ringCls()}` : '',
    ]"
    @click="!drift() && actions.gotoService?.(data)"
    @mouseenter="enter" @mouseleave="leave">
    <button v-if="actions.canMutate" class="topo-svc-add absolute -right-2 -top-2 z-10 w-5 h-5 rounded-full bg-primary text-on-primary shadow ring-2 ring-surface-container-lowest items-center justify-center hidden group-hover:flex hover:scale-110 transition-transform"
      :title="t('workload.topology.addIngressFor')"
      @click.stop="actions.openIngressMap(data.name)">
      <span class="material-symbols-outlined text-sm">add</span>
    </button>
    <template v-if="!drift()">
      <p class="font-mono text-xs text-on-surface font-semibold truncate">
        <span v-if="data.governing" class="topo-governing-badge px-1 rounded bg-primary/15 text-primary text-[10px]">{{ t('workload.topology.governing') }}</span>
        {{ data.name }}
      </p>
      <p class="text-[11px] text-on-surface-variant truncate"><span class="px-1 rounded bg-surface-container">{{ data.type }}</span> {{ data.ports }}</p>
      <p v-if="data.endpoints" class="text-[11px] truncate" :class="data.endpoints.ready === 0 ? 'text-error' : 'text-on-surface-variant'">
        {{ t('workload.topology.endpoints', { ready: data.endpoints.ready, total: data.endpoints.total }) }}
      </p>
    </template>
    <template v-else>
      <div class="flex items-center gap-xs">
        <span class="material-symbols-outlined text-sm shrink-0" :class="data.drift === 'broken' ? 'text-error' : 'text-tertiary-container'">warning</span>
        <p class="font-mono text-xs font-semibold truncate flex-1" :class="data.drift === 'broken' ? 'text-error' : 'text-tertiary-container'">{{ data.name }}</p>
        <button class="topo-repair-btn text-[11px] px-1.5 py-0.5 rounded-md font-medium disabled:opacity-40" :class="data.drift === 'broken' ? 'bg-error text-on-error' : 'bg-tertiary-container text-on-tertiary-container'"
          :disabled="!actions.canMutate || !!actions.repairingSvc?.value" @click.stop="actions.repairServiceSelector(data.name)">
          {{ t('workload.topology.repairSelector') }}
        </button>
      </div>
      <p class="text-[11px] mt-0.5" :class="data.drift === 'broken' ? 'text-error/80' : 'text-tertiary-container'">
        {{ data.drift === 'broken' ? t('workload.topology.driftBroken') : t('workload.topology.driftPending') }}
      </p>
    </template>
    <Handle type="target" :position="Position.Left" />
    <Handle type="source" :position="Position.Right" />
  </div>
</template>
```

(实现注:`hover-+` 用 `group-hover` 语义——宿主给节点外层加 `group` 类,或直接常显;为 happy-dom 可测,此处用「常显 + hover 放大」形态亦可接受,但**必须**有 `.topo-svc-add` 钩子与 `openIngressMap(data.name)` 调用。若选常显,删除 `hidden group-hover:flex` 两个类。)

`TopologyWorkloadNode.vue`(三形态+HPA/RS/配置引用 chips+hover-+ expose):

```vue
<script setup>
// 拓扑 flow 节点:本负载卡(CronJob/Job/常规三形态)+HPA/RS chips+配置引用;hover-+ = expose。
import { Handle, Position } from '@vue-flow/core'
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { imgBase, imgTag } from '@/composables/usePod'
const { t } = useI18n()
defineProps({ data: { type: Object, required: true } })
const actions = inject('topo-actions')
const REF_ICONS = { ConfigMap: 'description', Secret: 'key', imagePullSecrets: 'key', PVC: 'database' }
</script>
<template>
  <div class="relative rounded-xl border-2 border-primary/40 bg-primary/5 px-sm py-2 w-[232px]">
    <button v-if="actions.canMutate" class="topo-wl-add absolute -right-2 -top-2 z-10 w-5 h-5 rounded-full bg-primary text-on-primary shadow ring-2 ring-surface-container-lowest flex items-center justify-center hover:scale-110 transition-transform"
      :title="t('workload.topology.addExpose')" @click.stop="actions.openExpose()">
      <span class="material-symbols-outlined text-sm">add</span>
    </button>
    <p class="font-mono text-xs text-on-surface font-semibold truncate">{{ data.workload.name }}</p>
    <template v-if="data.workload.type === 'CronJob'">
      <p class="font-mono text-[11px] text-on-surface truncate">{{ data.cronSchedule }}
        <span v-if="data.cronSuspended" class="px-1 rounded bg-tertiary-container/20 text-tertiary-container text-[10px]">{{ t('workload.topology.suspended') }}</span></p>
      <p class="text-[10px] text-on-surface-variant/60">{{ t('workload.topology.schedule') }}</p>
    </template>
    <template v-else-if="data.workload.type === 'Job'">
      <p class="text-[11px] text-on-surface-variant font-mono">{{ t('workload.topology.completions', { succeeded: data.jobCompletions.s, total: data.jobCompletions.total }) }}</p>
    </template>
    <template v-else>
      <p class="text-[11px] text-on-surface-variant">{{ t('workload.topology.replicasCount', { replicas: data.workload.replicas, age: data.workload.age }) }}</p>
      <p class="font-mono text-[11px] text-on-surface-variant truncate mt-0.5">{{ imgBase(data.workload.image) }}<span class="text-primary font-semibold">:{{ imgTag(data.workload.image) || 'latest' }}</span></p>
    </template>
    <div v-if="data.hpas?.length" class="flex flex-wrap gap-0.5 mt-1">
      <button v-for="h in data.hpas" :key="h.name" class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-surface-container-low text-[10px] font-mono hover:bg-surface-container" @click.stop="data.gotoHpa?.(h)">
        <span class="material-symbols-outlined" style="font-size:11px">speed</span>{{ h.name }} {{ h.minReplicas }}→{{ h.maxReplicas }}
      </button>
    </div>
    <div v-if="data.replicaSets?.length" class="flex flex-wrap gap-0.5 mt-1">
      <button v-for="rs in data.replicaSets" :key="rs.name" class="font-mono text-[10px] px-1 py-0.5 rounded border" :class="rs.retired ? 'border-outline-variant/40 text-on-surface-variant/50 opacity-60' : 'border-primary/30 bg-primary/5 text-primary'" @click.stop="data.gotoRevisions?.()">
        rs/{{ rs.name }} {{ rs.ready }}/{{ rs.desired }}
      </button>
    </div>
    <div v-if="data.configRefs?.length" class="mt-1">
      <p class="text-[10px] text-on-surface-variant/60 uppercase tracking-wider mb-0.5">{{ t('workload.bottomBar.mountConfig') }}</p>
      <div class="flex flex-wrap gap-0.5">
        <button v-for="(r, i) in data.configRefs" :key="i" class="inline-flex items-center gap-0.5 px-1 py-0.5 bg-surface-container-low rounded text-[11px] hover:bg-surface-container" @click.stop="data.gotoRef?.(r)">
          <span class="material-symbols-outlined" style="font-size:11px">{{ REF_ICONS[r.kind] || 'key' }}</span>{{ r.name }}
        </button>
      </div>
    </div>
    <Handle type="target" :position="Position.Left" />
  </div>
</template>
```

`TopologyPodsNode.vue`:

```vue
<script setup>
// 拓扑 flow 节点:Pods 整列一节点(RS 分组滚动列表内嵌;per-Pod 节点=非目标)。
import { Handle } from '@vue-flow/core' // 不挂 Handle:无线端
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { podHealth } from '@/composables/usePod'
const { t } = useI18n()
defineProps({ data: { type: Object, required: true } })
const hovered = inject('topo-hover')
</script>
<template>
  <div class="rounded-xl border border-outline-variant bg-surface-container-lowest w-[236px]" @mouseenter="hovered.value = ''" @mouseleave="hovered.value = ''">
    <div v-if="!data.groups?.length && !data.ungrouped?.length" class="p-md text-center text-xs text-on-surface-variant/50">
      <span class="material-symbols-outlined text-2xl text-surface-container-high block">deployed_code</span>{{ t('workload.topology.noPods') }}
    </div>
    <div v-else class="p-sm flex flex-col gap-xs max-h-[340px] overflow-y-auto">
      <template v-for="g in data.groups || []" :key="g.rsName">
        <p class="text-[10px] text-on-surface-variant/60 font-mono px-0.5">rs/{{ g.rsName }} <span class="opacity-70">{{ g.ready }}/{{ g.desired }}</span></p>
        <div v-for="p in g.pods" :key="p.name" class="cursor-pointer flex items-center gap-xs rounded-lg border border-outline-variant/60 px-sm py-1 hover:border-primary text-left"
          @click="data.gotoPod?.(p)">
          <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="podHealth(p).dot"></span>
          <span class="font-mono text-[11px] text-on-surface truncate flex-1">{{ p.name }}</span>
          <span class="text-[11px] shrink-0" :class="podHealth(p).text">{{ podHealth(p).label }}</span>
        </div>
      </template>
    </div>
  </div>
</template>
```

(实现注:`Handle` import 若未用请删——pods/consumers 无线端,不放 Handle。)

`TopologyConsumersNode.vue`:

```vue
<script setup>
// 拓扑 flow 节点:标签消费者(PDB/NetPol)小卡——无连线(selector 选 Pod 非 Service)。
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
defineProps({ data: { type: Object, required: true } })
</script>
<template>
  <div class="rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-sm py-1 w-[236px]">
    <p class="text-[10px] text-on-surface-variant/60 mb-0.5">{{ t('workload.topology.labelConsumers') }}</p>
    <div class="flex flex-wrap gap-0.5">
      <button v-for="c in data.consumers" :key="c.kind + '/' + c.name"
        class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] hover:bg-surface-container"
        :class="c.disruptive ? 'bg-error/10 text-error' : 'bg-surface-container-low text-on-surface-variant'"
        @click.stop="data.gotoConsumer?.(c)">
        <span class="material-symbols-outlined" style="font-size:11px">{{ c.kind === 'PDB' ? 'shield' : 'security' }}</span>{{ c.name }}
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/flow/__tests__/topology-nodes.test.js`
Expected: PASS(5 条)。注意 happy-dom 下 `mouseenter` 触发后 `.topo-svc-add` 需可点(常显形态无碍)。

- [ ] **Step 5: Commit**

```bash
git add src/components/common/flow/
git commit --author="aliang-one <aliangdone@gmail.com>" -m "feat(topology): 5 个 flow 节点组件——旧卡片 markup 迁移(rule/service双态/workload/pods/consumers)+hover-+落卡钩子"
```

---

### Task 4: WorkloadTopologyTab 重写为 VueFlow 宿主

**Files:**
- Modify: `src/components/common/WorkbenchTopologyTab` → 正确路径 **`src/components/common/WorkloadTopologyTab.vue`**(整文件重写)

**Interfaces:**
- Consumes: Task 2 `deriveFlowGraph/attachEdgeStates`(签名见 Task 2 Produces);Task 3 五节点组件;`useWorkloadTopology` topo prop(成员同现状,另需 `topo.workloadHpas/topo.replicaSets/topo.latestRs/topo.podsGrouped/topo.labelConsumers/topo.governingSvcName/topo.epFor/topo.repairingSvc/topo.repairServiceSelector/topo.relatedServices/topo.driftedServices/topo.ingressBreakdown/topo.states`)。
- Produces: 节点 data 内回调契约——`rule.goto(ingress)`、`workload.gotoRevisions/gotoRef/gotoHpa`、`pods.gotoPod`、`consumers.gotoConsumer`、`actions.gotoService(svc)`;provide 键 `topo-hover`(ref)/`topo-actions`(`{ openIngressMap, openExpose, canMutate, gotoService, repairingSvc, repairServiceSelector }`)。Task 5 消费 `openIngressMap(name)` 参数化行为。

- [ ] **Step 1: 重写 `WorkloadTopologyTab.vue`**

整文件替换为(骨架;`<script setup>` 主干如下,模板见后):

```vue
<script setup>
// 拓扑 Tab(2026-09-01 连线化):四列流水线迁 @vue-flow/core 画布。
// 数据/边/布局推导全部在 src/logic/topologyFlow.js(纯函数);本组件只做:
// 1) topo → deriveFlowGraph 输入组装;2) provide hover/actions 给节点;3) 节点实测尺寸一次校正;4) 边 hover 态。
import { computed, provide, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import { markRaw } from 'vue'
import { deriveFlowGraph, attachEdgeStates } from '@/logic/topologyFlow'
import TopologyRuleNode from './flow/TopologyRuleNode.vue'
import TopologyServiceNode from './flow/TopologyServiceNode.vue'
import TopologyWorkloadNode from './flow/TopologyWorkloadNode.vue'
import TopologyPodsNode from './flow/TopologyPodsNode.vue'
import TopologyConsumersNode from './flow/TopologyConsumersNode.vue'
import { isRetiredRs } from '@/logic/topology'
import '@vue-flow/core/dist/style.css'

const { t } = useI18n()
const router = useRouter()
const props = defineProps({ topo: { type: Object, required: true }, workload: { type: Object, required: true }, canMutate: { type: Boolean, default: true }, managedPods: { type: Array, default: () => [] }, podsPending: { type: Boolean, default: false }, configRefs: { type: Array, default: () => [] } })
const emit = defineEmits(['goto'])

const hoveredSvc = ref('')
provide('topo-hover', hoveredSvc)
provide('topo-actions', {
  openIngressMap: name => props.topo.openIngressMap(name),
  openExpose: () => props.topo.openExpose(),
  canMutate: computed(() => props.canMutate),
  gotoService: svc => router.push({ name: 'NsServiceDetail', params: { namespace: props.workload.namespace, name: svc.name } }),
  repairingSvc: props.topo.repairingSvc,
  repairServiceSelector: name => props.topo.repairServiceSelector(name),
})

const isRetired = rs => isRetiredRs(rs, props.topo.latestRs.value)

// ── flow 图推导(topo 是 plain-object 包 refs,读取一律 .value)──
const graph = computed(() => deriveFlowGraph({
  ownRules: props.topo.states.value.servicesPending || props.topo.states.value.ingressesPending ? [] : props.topo.ingressBreakdown.value.ownRules,
  others: props.topo.ingressBreakdown.value.others,
  relatedServices: props.topo.states.value.servicesPending ? [] : props.topo.relatedServices.value.map(s => ({ ...s, endpoints: props.topo.epFor(s.name) })),
  driftedServices: props.topo.driftedServices.value.map(s => ({ ...s, endpoints: props.topo.epFor(s.name) })),
  workload: props.workload,
  governingSvcName: props.topo.governingSvcName.value,
  labelConsumers: props.topo.labelConsumers.value,
  hasPods: props.managedPods.length > 0,
}))

// 节点 data 组装(回调经 data 注入;provide 携 hover/actions)
const nodes = computed(() => graph.value.nodes.map(n => {
  if (n.type === 'rule') n.data.goto = r => router.push({ name: 'NsIngressDetail', params: { namespace: props.workload.namespace, name: r.ingress } })
  if (n.type === 'workload') Object.assign(n.data, {
    cronSchedule: props.workload?.raw?.spec?.schedule || '',
    cronSuspended: props.workload?.raw?.spec?.suspend === true,
    jobCompletions: { s: props.workload?.raw?.status?.succeeded || 0, total: props.workload?.raw?.spec?.completions },
    hpas: props.topo.workloadHpas.value.map(h => ({ ...h, goto: undefined })),
    replicaSets: props.workload.type === 'Deployment' ? props.topo.replicaSets.value.map(rs => ({ ...rs, retired: isRetired(rs) })) : [],
    configRefs: props.configRefs,
    gotoRevisions: () => emit('goto', 'revisions'),
    gotoRef: r => router.push({ name: ({ ConfigMap: 'NsConfigMapDetail', Secret: 'NsSecretDetail', PVC: 'NsPVCDetail', imagePullSecrets: 'NsSecretDetail' })[r.kind] || 'NsSecretDetail', params: { namespace: props.workload.namespace, name: r.name } }),
    gotoHpa: h => router.push({ name: 'NsHPADetail', params: { namespace: h.namespace || props.workload.namespace, name: h.name } }),
  })
  if (n.type === 'pods') Object.assign(n.data, { groups: props.topo.podsGrouped.value.groups, ungrouped: props.topo.podsGrouped.value.ungrouped, gotoPod: p => router.push({ name: 'NsPodDetail', params: { namespace: props.workload.namespace, name: p.name } }) })
  if (n.type === 'consumers') n.data.gotoConsumer = c => router.push({ name: c.kind === 'PDB' ? 'NsPDBDetail' : 'NsNetworkPolicyDetail', params: { namespace: props.workload.namespace, name: c.name } })
  return n
}))

const edges = computed(() => attachEdgeStates(graph.value.edges, hoveredSvc.value))

const nodeTypes = markRaw({
  rule: TopologyRuleNode, service: TopologyServiceNode, workload: TopologyWorkloadNode, pods: TopologyPodsNode, consumers: TopologyConsumersNode,
})

// 节点实测尺寸一次校正(估算行高兜底):onNodesInitialized 触发后按实测高重排 y。
const { onNodesInitialized, updateNode } = useVueFlow()
onNodesInitialized(ns2 => {
  const colOf = { rule: 0, service: 1, workload: 2, pods: 3 }
  const cols = {}
  for (const n of ns2) {
    const col = colOf[n.type] ?? 1
    ;(cols[col] ||= []).push({ id: n.id, h: n.dimensions?.height || 0 })
  }
  for (const list of Object.values(cols)) {
    let y = 0
    for (const { id, h } of list) { updateNode(id, { position: { ...ns2.find(x => x.id === id).position, y } }); y += h + 8 }
  }
})
</script>
```

模板:

```html
<template>
  <div class="flex flex-col gap-md">
    <!-- 画布容器:高度取旧 Pods 列上限量级;pan 保留/缩放关/节点拖拽关(spec §4) -->
    <div class="topo-canvas rounded-xl border border-outline-variant bg-surface-container-lowest" style="height: 480px">
      <VueFlow :nodes="nodes" :edges="edges" :node-types="nodeTypes"
        fit-view-on-init :zoom-on-scroll="false" :nodes-draggable="false" :pan-on-drag="true"
        :min-zoom="0.5" :max-zoom="1.5">
        <!-- pending 骨架:拓扑域加载中时盖在画布上 -->
        <div v-if="topo.states.value.servicesPending || topo.states.value.ingressesPending" class="absolute inset-0 z-10 flex items-center justify-center bg-surface-container-lowest/70">
          <span class="material-symbols-outlined animate-spin text-2xl text-on-surface-variant">progress_activity</span>
        </div>
      </VueFlow>
    </div>
    <!-- 他人路由(共享 Ingress,不连线):列尾语义保留 -->
    <div v-if="topo.ingressBreakdown.value.others.length" class="flex flex-wrap gap-xs">
      <button v-for="o in topo.ingressBreakdown.value.others" :key="'o-' + o.name" type="button"
        @click="router.push({ name: 'NsIngressDetail', params: { namespace: workload.namespace, name: o.name } })"
        class="text-left text-[11px] text-on-surface-variant/70 hover:text-primary rounded-lg px-sm py-1 border border-dashed border-outline-variant/40">
        <span class="material-symbols-outlined text-xs align-middle">alt_route</span>
        {{ o.name }} · {{ t('workload.topology.otherRoutes', { count: o.count }) }}
      </button>
    </div>
    <!-- 流水线说明(旧卡保留) -->
    <div class="rounded-xl bg-surface-container-low border border-outline-variant/60 p-md flex items-start gap-sm">
      <span class="material-symbols-outlined text-on-surface-variant text-base mt-0.5">info</span>
      <p class="text-xs text-on-surface-variant">
        {{ t('workload.topology.flowPath') }}{{ t('workload.topology.flowPathDesc', { type: workload.type }) }}
        <span v-if="!topo.relatedServices.value.length" class="text-tertiary-container">{{ t('workload.topology.noServiceHint') }}</span>
        <span v-else class="text-on-surface-variant/70">{{ t('workload.topology.addHint') }}</span>
      </p>
    </div>
  </div>
</template>
```

**删除(旧版不再存在):** 四列 flex 容器、静态 `arrow_forward` 分隔、两个 `-left-3` 边框圆钮。连线 CSS 追加到组件 `<style>`(scoped 外,用普通 style):

```css
<style>
/* topo 连线(非 scoped:vue-flow 边渲染在内部层) */
.topo-edge path { stroke: var(--md-sys-color-primary, #6750a4); stroke-width: 1.5; fill: none; }
.topo-edge.topo-edge-drift path { stroke: var(--md-sys-color-error, #b3261e); stroke-dasharray: 6 4; }
.topo-edge.topo-edge--active path { stroke-width: 2.5; opacity: 1; }
.topo-edge.topo-edge--dim { opacity: 0.25; }
.topo-edge { transition: opacity 0.15s; }
</style>
```

(色值 fallback 仅防变量缺失,项目 token 变量名为准——实现时从 `src/styles` 确认主色/error 变量名替换;若项目变量非 `--md-sys-color-*` 命名,以实际为准。)

- [ ] **Step 2: 跑相关测试 + 门禁**

Run: `npx vitest run src/components/common/__tests__/topology-flow.mount.test.js src/components/common/flow/__tests__/topology-nodes.test.js src/logic/topologyFlow.test.mjs`
Expected: 全绿。**注意**:`NsWorkloadDetail.topology.test.js` 此时可能红(Task 5 适配)——本任务门禁只跑上述三文件+`npm run typecheck`。

- [ ] **Step 3: Commit**

```bash
git add src/components/common/WorkloadTopologyTab.vue
git commit --author="aliang-one <aliangdone@gmail.com>" -m "feat(topology): 拓扑 Tab 迁 VueFlow 画布——四列流水线节点化+扇入/失配连线+hover 边态,边框加号移除"
```

---

### Task 5: openIngressMap 参数化 + 页面测试适配 + 全门禁

**Files:**
- Modify: `src/composables/useWorkloadTopology.js`(`openIngressMap` 签名)
- Modify: `src/locales/zh.json`、`src/locales/en.json`(`workload.topology.addIngressFor/addExpose`)
- Modify: `src/views/__tests__/NsWorkloadDetail.topology.test.js`(既有 9 条适配)
- Modify: `src/views/NsWorkloadDetail.vue`(解构处 :117-118 无需变更;确认无残引用)

- [ ] **Step 1: i18n 两键**

zh(`workload.topology` 下):`"addIngressFor": "为该 Service 添加 Ingress"`, `"addExpose": "暴露为 Service"`
en:`"addIngressFor": "Add Ingress for this Service"`, `"addExpose": "Expose as Service"`

- [ ] **Step 2: `openIngressMap` 参数化(useWorkloadTopology.js)**

现签名 `function openIngressMap() { const svc = relatedServices.value[0] ... }` 改为:

```js
  // 参数化(2026-09-01 加号落卡):传 serviceName 则钉到该 Service(端口取 portList 首个),
  // 不传维持原语义(第一个关联 Service)。弹窗本体/保存逻辑零改动。
  function openIngressMap(serviceName) {
    const svc = (serviceName ? relatedServices.value.find(s => s.name === serviceName) : relatedServices.value[0])
      || relatedServices.value[0]
    // ……其余函数体逐字保留(existing Set/命名生成/mapConflict/表单赋值)
  }
```

(函数体其余部分不动;仅首行取 svc 逻辑替换。)

- [ ] **Step 3: 适配 `NsWorkloadDetail.topology.test.js`**

既有 9 条断言的 DOM 锚点变化(卡片→节点):文本断言(text contains)基本存活;按钮选择器变化对照:
- 修复钮:`.topo-repair-btn`(原 `button` 内嵌选择器)
- governing 徽章:`.topo-governing-badge`
- **新增 2 条**:
  1. 「Service 节点 hover-+ → ingressMap 弹窗预填该 Service」:找到含目标 svc 名的 `.topo-svc-add` 点击 → 断言 `showIngressMapModal` 弹窗内 serviceName 输入值为该名(弹窗在页面层,Teleport→`document.body` 查询);
  2. 「openIngressMap 无参回归:仍取第一个关联 Service」。
- 若某断言依赖列容器几何(happy-dom 全零),改为对节点组件 props/data 断言。

- [ ] **Step 4: 全门禁**

Run: `npm run test:unit && npm run i18n:check && npm run typecheck && npm run build`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/composables/useWorkloadTopology.js src/views/__tests__/NsWorkloadDetail.topology.test.js src/views/NsWorkloadDetail.vue src/locales/zh.json src/locales/en.json
git commit --author="aliang-one <aliangdone@gmail.com>" -m "feat(topology): openIngressMap 参数化(加号落卡传指定 Service)+i18n 两键+页面级拓扑测试适配"
```

---

## Self-Review 记录(计划完成时已自审)

- Spec 覆盖:§2 依赖→Task 1;§3 节点映射→Task 3(五节点)+Task 4(组装);§4 布局→Task 2(估算+常量)+Task 4(实测校正/画布 props);§5 连线→Task 2(边推导)+Task 4(class/CSS);§6 加号落卡→Task 3(钩子)+Task 5(参数化+i18n);§7 测试→各任务内嵌;§8 非目标未引入。
- 占位符:Task 3 测试为单一块(无占位);其余代码块均可直接落盘。
- 类型/命名一致:nodeTypes 键(rule/service/workload/pods/consumers)、节点 id 前缀、data 回调名(goto/gotoRevisions/gotoRef/gotoHpa/gotoPod/gotoConsumer/gotoService)、CSS 钩子类名(`.topo-rule/.topo-governing-badge/.topo-svc-add/.topo-drift/.topo-repair-btn/.topo-wl-add`)跨任务一致;`topo-actions` 键集(openIngressMap/openExpose/canMutate/gotoService/repairingSvc/repairServiceSelector)在 Task 3 测试 provide 与 Task 4 provide 对齐。
