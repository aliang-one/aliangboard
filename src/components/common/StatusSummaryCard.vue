<script setup>
// Pod 状态摘要卡:左环形分布 + 右可点击图例(等价替换 NsPods 原 4 格状态栏,保留点击切换过滤)。
// 状态名(Running/Pending/Failed/Other)照旧英文直出,与全站状态展示一致,不加 i18n。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import EChart from './EChart.vue'
import { buildStatusSegments, buildDonutOption, STATUS_COLORS, tokenHex } from '@/lib/chart-options'

const props = defineProps({
  pods: { type: Array, default: () => [] },
  statusFilter: { type: String, default: 'All' },
})
const emit = defineEmits(['filter'])
const { t } = useI18n()

const segments = computed(() => buildStatusSegments(props.pods))
const total = computed(() => props.pods.length)
const option = computed(() => buildDonutOption(segments.value))
const dot = (status) => tokenHex(STATUS_COLORS[status] || STATUS_COLORS.Other)
function toggle(status) {
  emit('filter', props.statusFilter === status ? 'All' : status)
}
</script>

<template>
  <div class="rounded-xl bg-surface-container-lowest border border-outline-variant px-md py-sm flex items-center gap-md mb-md">
    <div class="relative w-24 h-24 flex-shrink-0">
      <EChart v-if="segments.length" :option="option" :height="96" />
      <div v-else class="w-24 h-24 rounded-full border-[7px] border-outline-variant/40"></div>
      <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span class="text-headline-sm font-bold text-on-surface leading-none">{{ total }}</span>
        <span class="text-[10px] text-on-surface-variant mt-0.5">{{ t('ns.pods.total') }}</span>
      </div>
    </div>
    <div class="flex flex-wrap gap-sm">
      <template v-for="s in segments" :key="s.status">
        <!-- Other 是归并桶,p.status 永不等于 'Other',点了也过滤不出任何 pod(误导性空结果)。
             故渲染为非交互展示(旧 4 格栏 Succeeded 本就不可点);真实状态段保持按钮可点。 -->
        <button
          v-if="s.status !== 'Other'" type="button" @click="toggle(s.status)"
          class="flex items-center gap-xs px-sm py-1 rounded-lg border transition-colors"
          :class="statusFilter === s.status ? 'border-primary bg-primary-container/10' : 'border-outline-variant/50 hover:border-primary/60'"
        >
          <span class="w-2.5 h-2.5 rounded-full" :style="{ background: dot(s.status) }"></span>
          <span class="text-body-sm text-on-surface-variant">{{ s.status }}</span>
          <span class="text-body-md font-bold" :style="{ color: dot(s.status) }">{{ s.count }}</span>
        </button>
        <span
          v-else
          class="flex items-center gap-xs px-sm py-1 rounded-lg border border-outline-variant/50 cursor-default"
        >
          <span class="w-2.5 h-2.5 rounded-full" :style="{ background: dot(s.status) }"></span>
          <span class="text-body-sm text-on-surface-variant">{{ s.status }}</span>
          <span class="text-body-md font-bold" :style="{ color: dot(s.status) }">{{ s.count }}</span>
        </span>
      </template>
    </div>
  </div>
</template>
