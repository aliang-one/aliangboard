# 工作负载拓扑连线化(Vue Flow)— 设计

- 日期:2026-09-01
- 状态:已批准(问答裁决:①连线全画含失配红线 ②边框加号全部落卡 ③实现路线**引 @vue-flow/core**——用户知情指定,依赖政策破例,非推荐路线)
- 范围:`NsWorkloadDetail` 拓扑 Tab(WorkloadTopologyTab)重写为 flow 画布;动作层小改;零服务端改动

## 1. 背景与现状

拓扑 Tab 现为四列 flex 流水线(Ingress 路由→Service→Workload→Pods),列间是静态 `arrow_forward` 图标,无连线语义;「加号」是骑在 Service 列/Workload 列**左边框**上的圆形按钮(`absolute -left-3`,分别开 ingress-map/expose 弹窗),语义指向不明。

连线所需数据已齐:`useWorkloadTopology.ingressBreakdown.ownRules` 每条含 `{ ingress, host, path, serviceName, port }`(规则粒度,天然支持多 Ingress 扇入同一 Service);`relatedServices`/`driftedServices` 给出 Service→Workload 正常/失配关系。动作层 `openIngressMap()` 已实现完整的「建绑定某 Service 的 Ingress」弹窗(名/host/path/pathType/端口预填、同 host 追加 vs 新建、冲突检测),只是 serviceName 硬取第一个关联 Service。

## 2. 依赖裁决(CLAUDE.md 表新增行)

| 依赖 | 类别 | 引入原因 | 裁决来源 |
|------|------|----------|----------|
| `@vue-flow/core` | 运行时(dependencies) | 拓扑页节点/连线画布:四列流水线迁 flow 画布,Ingress 规则→Service→Workload 只读连线+失配红虚线,为后续拖拽/布局/缩放留扩展空间 | 2026-09-01 用户指定(本设计 §问答③) |

- 只引 `@vue-flow/core` 单包;**不引** background/minimap/controls 周边件、**不引 dagre**(布局自算,§4)。
- 必引样式 `@vue-flow/core/dist/style.css`(基础布局);视觉全部走项目 token 自绘,不引 theme-default。
- chunk:NsWorkloadDetail 本就路由级懒加载,依赖自然不进主包(echarts 先例)。
- API 事实(官方指南):自定义节点经 `:node-types` + `markRaw` 注册;节点组件内必须放 `<Handle type="target" :position="Position.Left">` / `<Handle type="source" :position="Position.Right">`,否则边无锚点;节点数据 `{ id, type, position, data }`,边 `{ id, source, target, type, class }`。

## 3. 节点化映射

| 现卡片 | 节点类型 | 粒度 | 内容迁移 |
|---|---|---|---|
| Ingress 路由条目 | `rule` | **每规则一节点**(ownRules;扇入画面的来源) | host/path 主行 + →svc:port 次行;点击跳 NsIngressDetail |
| 他人路由(共享 Ingress) | 列尾聚合 | 维持现状按钮列,**不连线、不建节点** | 原样 |
| Service 卡 | `service` | 每 Service 一节点 | governing 徽章/type/ports/endpoints 红行;点击跳 NsServiceDetail;**hover-+ 见 §6** |
| 失配 Service 卡 | `service`(drift 变体) | 每失配 Service 一节点 | 两档色/broken 文案/一键修复钮;**hover-+ 同样提供**(失配也可以补 Ingress) |
| Workload 卡 | `workload` | 单节点 | CronJob/Job/常规三形态 + HPA chips + RS chips + 配置引用,原样迁移 |
| Pods 列 | `pods` | **整列一节点**(内部保留 RS 分组滚动列表) | per-Pod 节点=节点爆炸,明确非目标 |
| 标签消费者(PDB/NetPol) | `consumers` | Service 列末尾**独立小节点**(有内容才渲染;**无连线**——selector 选的是 Pod 非 Service,不与 Service 卡连线以免错误归属暗示) | 原 chips 迁入,点击跳转保留 |

点击跳转、hover 高亮(`hoveredSvc` 单源)、`canMutate` 权限禁用等既有交互语义全部保留;节点组件是普通 Vue 组件,模板大段可搬。

## 4. 布局(自算,不引 dagre)

- 纯函数模块 `src/logic/topologyFlow.js`:`deriveFlowGraph({ ownRules, others, relatedServices, driftedServices, workload, podsGrouped, ... }) → { nodes, edges }`——节点 id/type/position 与边集全部在此推导,**零 vue-flow 依赖**,可单测。
- 固定四列:x = 列序 × 列宽常量(列宽取 `min-w-[200px]` 同源常量);y = 列内按**数据驱动估算行高**累加(节点行数可从数据推导:endpoints 行、drift 徽标、RS chips 均为条件已知),首排节点顶部对齐。
- 尺寸校正:挂载后用 vue-flow 节点实测尺寸做一次重排(防估算漂移);`fit-view-on-init` 一次。
- 画布交互:`zoom-on-scroll=false`、`pan-on-drag=true`(窄屏/手机适配刚落地,平移保留)、禁用节点拖拽(`nodes-draggable=false`——拓扑是只读展示,位置由布局单源定,防拖乱)。

## 5. 连线

| 边 | from→to | 形态 |
|---|---|---|
| route | rule 节点右锚 → serviceName 对应 Service 左锚 | `smoothstep` 主色实线;**多规则同一 Service 自然扇入** |
| svc | Service 右锚 → Workload 左锚 | `smoothstep` 主色实线 |
| drift | 失配 Service 右锚 → Workload 左锚 | `smoothstep` **红虚线**(警示非流量) |

- hover 联动:`hoveredSvc` 变化时相关边加 class 高亮(加粗/全饱和),无关边降透明度;hover 规则节点=hover 其目标 Service(沿用现语义)。
- 颜色走项目 CSS 变量(主色/error),不硬编码 hex(style token 约定)。

## 6. 加号落卡

- `openIngressMap(serviceName?)` 参数化:传名 → `serviceName/servicePort` 钉该 Service(portList 首个);不传 → 维持现状(第一个关联 Service)。弹窗模板/保存逻辑零改动。
- `ServiceNode`(含 drift 变体)hover 显 `+`(节点右上角,`@click.stop` 防触发画布事件)→ `openIngressMap(s.name)`;禁用条件照旧 `!canMutate`。
- `WorkloadNode` hover 显 `+` → `openExpose()`。
- **两个边框圆钮删除**(Service 列/Workload 列 `-left-3` 按钮)。
- i18n:新增 hover 提示键(workbench 无关,`workload.topology.addIngressFor`/`addExpose` 两个键,zh/en 成对)。

## 7. 测试

- `src/logic/topologyFlow.test.mjs`:规则→route 边映射(含多规则扇入)、svc/drift 边、列内 y 累加与列宽、others 不产节点不产边、空态(无 Service/无规则)——零 vue-flow 依赖。
- 组件测试:stub `<VueFlow>`(happy-dom 无 ResizeObserver,setup 需 stub 全局);断言 nodes/edges 由 topo 推导注入、ServiceNode hover-+ 以指定 Service 名调 `openIngressMap`、边框圆钮消失、`openIngressMap('x')` 预填断言。
- 既有 `NsWorkloadDetail.topology.test.js` 与 `WorkloadTopologyTab` 相关断言按新挂载形态适配(语义不丢:跳转/失配修复/hover 联动仍锁)。

## 8. 非目标

- per-Pod 节点、自由拖拽/重连线编辑、minimap/背景网格/控制钮。
- PodDetail 的 `ResourceTopology.vue`、集群级全局拓扑页。
- dagre/elk 自动布局(固定列自算)。
- Service→Pods 连线(分组语义不对应,连线成噪)。

## 9. 风险

- **happy-dom 兼容**:vue-flow 依赖 ResizeObserver/尺寸测量——测试必须 stub;若 stub 后仍不稳,组件测试降级为「对 stub 注入的 nodes/edges props 断言」(拓扑展示语义移到 logic 层锁)。
- 估算行高与实测漂移:首排对齐+一次实测校正兜底;极端漂移仅表现为列内小空隙,不遮挡。
- bundle:+~100KB gz 于 NsWorkloadDetail chunk(懒加载,不进主包),可接受(echarts 先例同级)。
