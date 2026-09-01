<script setup>
// 拓扑 flow 节点:Service(normal)+ 失配(drift 变体)。governing 徽章/endpoints 红行/
// 一键修复语义自旧 Tab 迁移;hover-+(右上)以指定 Service 名开 ingress-map 弹窗。
import { Handle, Position, useNodeId } from '@vue-flow/core'
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const props = defineProps({ data: { type: Object, required: true } })
// 真实 Handle 仅在 VueFlow 画布内可挂(useNode 依赖注入上下文);画布外(单测裸挂载)退化为同 class 占位元素
const inFlow = !!useNodeId()
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
      drift() ? 'topo-drift' : '',
      drift() ? (data.drift === 'broken' ? 'border-error/50 bg-error/5' : 'border-tertiary-container/40 bg-tertiary-container/5') : 'border-outline-variant/60 bg-surface-container-lowest hover:border-primary hover:bg-primary/5 cursor-pointer',
      hovered === data.name ? `ring-2 ${ringCls()}` : '',
    ]"
    @click="!drift() && actions.gotoService?.(data)"
    @mouseenter="enter" @mouseleave="leave">
    <!-- 实现:常显形态(hover:scale 放大提示)——group-hover 依赖宿主外层 group 类,常显保 happy-dom 可点测 -->
    <button v-if="actions.canMutate" class="topo-svc-add absolute -right-2 -top-2 z-10 w-5 h-5 rounded-full bg-primary text-on-primary shadow ring-2 ring-surface-container-lowest flex items-center justify-center hover:scale-110 transition-transform"
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
    <template v-if="inFlow">
      <Handle type="target" :position="Position.Left" />
      <Handle type="source" :position="Position.Right" />
    </template>
    <template v-else>
      <div class="vue-flow__handle vue-flow__handle-left" style="position:absolute;left:-4px;top:50%;width:6px;height:6px;border-radius:9999px;background:var(--md-sys-color-primary, #6750a4)"></div>
      <div class="vue-flow__handle vue-flow__handle-right" style="position:absolute;right:-4px;top:50%;width:6px;height:6px;border-radius:9999px;background:var(--md-sys-color-primary, #6750a4)"></div>
    </template>
  </div>
</template>
