<script setup>
// 轻量 SVG 折线图：无第三方依赖。用于工作负载/Pod 的 CPU/内存实时占用曲线。
// series: number[]；refLines: [{label,value,color}]（如 requests/limits 参考线）。
import { computed } from 'vue'
const props = defineProps({
  series: { type: Array, default: () => [] },
  label: { type: String, default: '' },
  unit: { type: String, default: '' },
  color: { type: String, default: 'var(--md-sys-color-primary)' },
  height: { type: Number, default: 64 },
  refLines: { type: Array, default: () => [] },
})
const W = 100
const PAD = 4
// 唯一渐变 id（避免多图冲突）
const gid = 'mc-' + Math.random().toString(36).slice(2, 9)
const maxVal = computed(() => {
  const vals = [...props.series, ...props.refLines.map(r => Number(r.value) || 0)].filter(v => typeof v === 'number' && !isNaN(v) && v > 0)
  return Math.max(1, ...vals)
})
const y = v => (props.height - PAD) - ((Number(v) || 0) / maxVal.value) * (props.height - PAD * 2)
const points = computed(() => {
  const s = props.series
  if (s.length < 2) return ''
  return s.map((v, i) => `${(i / (s.length - 1)) * W},${y(v)}`).join(' ')
})
const area = computed(() => props.series.length < 2 ? '' : `0,${props.height - PAD} ${points.value} ${W},${props.height - PAD}`)
const current = computed(() => props.series[props.series.length - 1])
const grids = [0.25, 0.5, 0.75]
</script>

<template>
  <div>
    <svg :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" class="w-full block text-on-surface-variant" :style="{ height: height + 'px' }">
      <defs>
        <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="color" stop-opacity="0.35" />
          <stop offset="100%" :stop-color="color" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      <!-- 网格线（淡） -->
      <line v-for="(g, gi) in grids" :key="gi" x1="0" :x2="W" :y1="y(maxVal * g)" :y2="y(maxVal * g)"
        stroke="currentColor" stroke-width="0.4" opacity="0.1" vector-effect="non-scaling-stroke" />
      <!-- 参考线（requests / limits） -->
      <line v-for="(r, i) in refLines" :key="'r' + i" :x1="0" :x2="W" :y1="y(r.value)" :y2="y(r.value)"
        :stroke="r.color" stroke-width="0.7" stroke-dasharray="3,2" opacity="0.65" vector-effect="non-scaling-stroke" />
      <!-- 面积渐变 -->
      <polygon v-if="area" :points="area" :fill="`url(#${gid})`" />
      <!-- 曲线 -->
      <polyline v-if="points" :points="points" fill="none" :stroke="color" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
    <div v-if="refLines.length" class="flex flex-wrap gap-sm mt-xs">
      <span v-for="(r, i) in refLines" :key="i" class="flex items-center gap-0.5 text-xs text-on-surface-variant">
        <span class="w-2.5 h-0.5 rounded" :style="{ background: r.color }"></span>{{ r.label }} {{ r.value }}{{ unit }}
      </span>
    </div>
  </div>
</template>
