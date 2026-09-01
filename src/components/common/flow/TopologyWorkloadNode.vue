<script setup>
// 拓扑 flow 节点:本负载卡(CronJob/Job/常规三形态)+HPA/RS chips+配置引用;hover-+ = expose。
import { Handle, Position, useNodeId } from '@vue-flow/core'
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { imgBase, imgTag } from '@/composables/usePod'
const { t } = useI18n()
defineProps({ data: { type: Object, required: true } })
// 真实 Handle 仅在 VueFlow 画布内可挂(useNode 依赖注入上下文);画布外(单测裸挂载)退化为同 class 占位元素
const inFlow = !!useNodeId()
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
    <Handle v-if="inFlow" type="target" :position="Position.Left" />
    <div v-else class="vue-flow__handle vue-flow__handle-left" style="position:absolute;left:-4px;top:50%;width:6px;height:6px;border-radius:9999px;background:var(--md-sys-color-primary, #6750a4)"></div>
  </div>
</template>
