<script setup>
// 拓扑 flow 节点:Ingress 规则(host/path→svc:port),每规则一节点(扇入来源)。
// markup 自 WorkloadTopologyTab 迁移(2026-09-01);跳转经 data.goto 注入。
import { Handle, Position, useNodeId } from '@vue-flow/core'
import { inject } from 'vue'
const props = defineProps({ data: { type: Object, required: true } })
// 真实 Handle 仅在 VueFlow 画布内可挂(useNode 依赖注入上下文);画布外(单测裸挂载)退化为同 class 占位元素
const inFlow = !!useNodeId()
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
    <Handle v-if="inFlow" type="source" :position="Position.Right" />
    <div v-else class="vue-flow__handle vue-flow__handle-right" style="position:absolute;right:-4px;top:50%;width:6px;height:6px;border-radius:9999px;background:var(--md-sys-color-primary, #6750a4)"></div>
  </div>
</template>
