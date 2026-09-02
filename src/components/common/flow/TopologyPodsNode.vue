<script setup>
// 拓扑 flow 节点:Pods 整列一节点(RS 分组滚动列表内嵌;per-Pod 节点=非目标)。
// 无 Handle:无线端。pending=podsPending 骨架;ungrouped=无归属 RS 的 Pod 段(旧列语义)。
import { useI18n } from 'vue-i18n'
import { podHealth } from '@/composables/usePod'
const { t } = useI18n()
defineProps({ data: { type: Object, required: true } })
</script>
<template>
  <div class="rounded-xl border border-outline-variant bg-surface-container-lowest w-[236px]">
    <div v-if="data.pending" class="p-sm flex flex-col gap-xs">
      <div v-for="i in 3" :key="i" class="h-7 rounded-lg bg-surface-container-low animate-pulse"></div>
    </div>
    <div v-else-if="!data.groups?.length && !data.ungrouped?.length" class="p-md text-center text-xs text-on-surface-variant/50">
      <span class="material-symbols-outlined text-2xl text-surface-container-high block">deployed_code</span>{{ t('workload.topology.noPods') }}
    </div>
    <div v-else class="p-sm flex flex-col gap-xs max-h-[340px] overflow-y-auto">
      <template v-for="g in data.groups || []" :key="g.rsName">
        <p class="text-[10px] text-on-surface-variant/60 font-mono px-0.5">rs/{{ g.rsName }} <span class="opacity-70">{{ g.ready }}/{{ g.desired }}</span></p>
        <div v-for="p in g.pods" :key="p.name" role="button" tabindex="0" class="cursor-pointer flex items-center gap-xs rounded-lg border border-outline-variant/60 px-sm py-1 hover:border-primary hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-colors text-left"
          @click="data.gotoPod?.(p)" @keydown.enter="data.gotoPod?.(p)">
          <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="podHealth(p).dot"></span>
          <span class="font-mono text-[11px] text-on-surface truncate flex-1">{{ p.name }}</span>
          <span class="text-[11px] shrink-0" :class="podHealth(p).text">{{ podHealth(p).label }}</span>
        </div>
      </template>
      <template v-if="data.ungrouped?.length">
        <p class="text-[10px] text-on-surface-variant/60 px-0.5">{{ t('workload.topology.rsUngrouped') }}</p>
        <div v-for="p in data.ungrouped" :key="p.name" role="button" tabindex="0" class="cursor-pointer flex items-center gap-xs rounded-lg border border-outline-variant/60 px-sm py-1 hover:border-primary hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-colors text-left"
          @click="data.gotoPod?.(p)" @keydown.enter="data.gotoPod?.(p)">
          <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="podHealth(p).dot"></span>
          <span class="font-mono text-[11px] text-on-surface truncate flex-1">{{ p.name }}</span>
          <span class="text-[11px] shrink-0" :class="podHealth(p).text">{{ podHealth(p).label }}</span>
        </div>
      </template>
    </div>
  </div>
</template>
