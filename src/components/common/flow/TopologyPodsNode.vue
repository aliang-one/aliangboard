<script setup>
// 拓扑 flow 节点:Pods 整列一节点(RS 分组滚动列表内嵌;per-Pod 节点=非目标)。
// 无 Handle:无线端。
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
