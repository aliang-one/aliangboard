<script setup>
// 拓扑 Tab(2026-09-01 连线化):四列流水线迁 @vue-flow/core 画布。
// 数据/边/布局推导全部在 src/logic/topologyFlow.js(纯函数);本组件只做:
// 1) topo → deriveFlowGraph 输入组装;2) provide hover/actions 给节点;3) 节点实测尺寸一次校正;4) 边 hover 态。
import { computed, provide, reactive, ref, markRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { VueFlow, useVueFlow } from '@vue-flow/core'
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
// reactive 包 provide 对象:嵌套 computed/ref 经 reactive 解包,节点侧读 actions.canMutate
// 直接得布尔(普通对象内嵌 computed 不解包,曾致门禁恒真——R1 C2)。
provide('topo-actions', reactive({
  openIngressMap: name => props.topo.openIngressMap(name),
  openExpose: () => props.topo.openExpose(),
  canMutate: computed(() => props.canMutate),
  gotoService: svc => router.push({ name: 'NsServiceDetail', params: { namespace: props.workload.namespace, name: svc.name } }),
  repairingSvc: props.topo.repairingSvc,
  identitySel: computed(() => props.topo.identitySel.value),
  repairServiceSelector: name => props.topo.repairServiceSelector(name),
}))

const isRetired = rs => isRetiredRs(rs, props.topo.latestRs.value)

// ── flow 图推导(topo 是 plain-object 包 refs,读取一律 .value)──
const graph = computed(() => deriveFlowGraph({
  ownRules: props.topo.states.value.servicesPending || props.topo.states.value.ingressesPending ? [] : props.topo.ingressBreakdown.value.ownRules,
  others: props.topo.ingressBreakdown.value.others,
  relatedServices: props.topo.states.value.servicesPending ? [] : props.topo.relatedServices.value.map(s => ({ ...s, endpoints: props.topo.epFor(s.name) })),
  driftedServices: props.topo.states.value.servicesPending ? [] : props.topo.driftedServices.value.map(s => ({ ...s, endpoints: props.topo.epFor(s.name) })),
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
    jobCompletions: { s: props.workload?.raw?.status?.succeeded || 0, total: props.workload?.raw?.spec?.completions == null ? '*' : props.workload?.raw?.spec?.completions },
    hpas: props.topo.workloadHpas.value.map(h => ({ ...h, goto: undefined })),
    replicaSets: props.workload.type === 'Deployment' ? props.topo.replicaSets.value.map(rs => ({ ...rs, retired: isRetired(rs) })) : [],
    configRefs: props.configRefs,
    gotoRevisions: () => emit('goto', 'revisions'),
    gotoRef: r => router.push({ name: ({ ConfigMap: 'NsConfigMapDetail', Secret: 'NsSecretDetail', PVC: 'NsPVCDetail', imagePullSecrets: 'NsSecretDetail' })[r.kind] || 'NsSecretDetail', params: { namespace: props.workload.namespace, name: r.name } }),
    gotoHpa: h => router.push({ name: 'NsHPADetail', params: { namespace: h.namespace || props.workload.namespace, name: h.name } }),
  })
  if (n.type === 'pods') Object.assign(n.data, { pending: props.podsPending, groups: props.topo.podsGrouped.value.groups, ungrouped: props.topo.podsGrouped.value.ungrouped, gotoPod: p => router.push({ name: 'NsPodDetail', params: { namespace: props.workload.namespace, name: p.name } }) })
  if (n.type === 'consumers') n.data.gotoConsumer = c => router.push({ name: c.kind === 'PDB' ? 'NsPDBDetail' : 'NsNetworkPolicyDetail', params: { namespace: props.workload.namespace, name: c.name } })
  return n
}))

const edges = computed(() => attachEdgeStates(graph.value.edges, hoveredSvc.value))

const nodeTypes = markRaw({
  rule: TopologyRuleNode, service: TopologyServiceNode, drift: TopologyServiceNode, workload: TopologyWorkloadNode, pods: TopologyPodsNode, consumers: TopologyConsumersNode,
}) // drift 与 service 共用组件(logic 层 drift 独立 type 键,评审裁量)

// 节点实测尺寸一次校正(估算行高兜底):onNodesInitialized 触发后按实测高重排 y。
const { onNodesInitialized, updateNode } = useVueFlow()
onNodesInitialized(nodesMeasured => {
  const colOf = { rule: 0, service: 1, drift: 1, workload: 2, pods: 3 }
  const cols = {}
  for (const n of nodesMeasured) {
    const col = colOf[n.type] ?? 1
    ;(cols[col] ||= []).push({ id: n.id, h: n.dimensions?.height || 0 })
  }
  for (const list of Object.values(cols)) {
    let y = 0
    for (const { id, h } of list) { updateNode(id, { position: { ...nodesMeasured.find(x => x.id === id).position, y } }); y += h + 8 }
  }
})
</script>

<template>
  <div class="flex flex-col gap-md">
    <!-- 画布容器:高度取旧 Pods 列上限量级;pan 保留/缩放关/节点拖拽关(spec §4) -->
    <div class="topo-canvas relative rounded-xl border border-outline-variant bg-surface-container-lowest" style="height: 480px">
      <VueFlow :nodes="nodes" :edges="edges" :node-types="nodeTypes"
        fit-view-on-init :zoom-on-scroll="false" :nodes-draggable="false" :pan-on-drag="true"
        :min-zoom="0.5" :max-zoom="1.5" />
      <!-- pending 骨架:VueFlow 兄弟节点(不入其变换容器,inset-0 才按容器定位而非画布坐标) -->
      <div v-if="topo.states.value.servicesPending || topo.states.value.ingressesPending" class="absolute inset-0 z-10 flex items-center justify-center bg-surface-container-lowest/70">
        <span class="material-symbols-outlined animate-spin text-2xl text-on-surface-variant">progress_activity</span>
      </div>
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

<style>
/* topo 连线(非 scoped:vue-flow 边渲染在内部层) */
.topo-edge path { stroke: rgb(var(--md-sys-color-primary, 103 80 164)); stroke-width: 1.5; fill: none; }
.topo-edge.topo-edge-drift path { stroke: rgb(var(--md-sys-color-error, 179 36 48)); stroke-dasharray: 6 4; }
.topo-edge.topo-edge--active path { stroke-width: 2.5; opacity: 1; }
.topo-edge.topo-edge--dim { opacity: 0.25; }
.topo-edge { transition: opacity 0.15s; }
</style>
