<script setup>
// 环形表盘(ECharts gauge 渐变 + 数值过渡动画);中心数值仍由 HTML 叠加(与旧 SVG 版观感一致)。
// 容器 pointer-events:none——外层常是 router-link 卡片,图表不得挡点击。
import { computed } from 'vue'
import EChart from './EChart.vue'
import { buildGaugeOption } from '@/lib/chart-options'

const props = defineProps({
  value: { type: Number, default: null },
  label: { type: String, default: 'CPU' },
  size: { type: Number, default: 56 },
})
const option = computed(() => buildGaugeOption(props.value))
</script>

<template>
  <div class="relative flex-shrink-0 self-center" :style="{ width: size + 'px', height: size + 'px' }">
    <div class="pointer-events-none absolute inset-0">
      <EChart :option="option" :height="size" />
    </div>
    <div class="absolute inset-0 flex flex-col items-center justify-center">
      <span class="text-body-sm font-bold leading-none" :class="value != null ? 'text-on-surface' : 'text-on-surface-variant'">{{ value != null ? value + '%' : '—' }}</span>
      <span class="text-[9px] text-on-surface-variant uppercase tracking-wide mt-0.5">{{ label }}</span>
    </div>
  </div>
</template>
