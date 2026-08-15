<script setup>
// 平滑面积折线图:ECharts 实现(tooltip/渐变/数据过渡动画),替代已删除的旧版 SVG 迷你图。
// 颜色与 refLines 颜色都传 palette token 名('primary'/'secondary'/'error'…),杜绝 var() 未定义坑。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import EChart from './EChart.vue'
import { buildAreaLineOption, buildTimeAreaLineOption, tokenHex } from '@/lib/chart-options'

const props = defineProps({
  series: { type: Array, default: () => [] },
  // 时间戳样本(全局采样器):[{t: 毫秒, v: 数值}]。与 series 二选一,samples 优先。
  samples: { type: Array, default: null },
  color: { type: String, default: 'primary' },
  unit: { type: String, default: '' },
  height: { type: Number, default: 64 },
  refLines: { type: Array, default: () => [] },
  spark: { type: Boolean, default: false },
  smooth: { type: Boolean, default: true },
  sampleIntervalSec: { type: Number, default: 10 },
})
const { t } = useI18n()
const validSamples = computed(() => (props.samples || []).filter(s =>
  s && typeof s === 'object' && typeof s.t === 'number' && typeof s.v === 'number' && !isNaN(s.t) && !isNaN(s.v)))
const empty = computed(() => props.samples != null
  ? validSamples.value.length < 2
  : props.series.filter(v => typeof v === 'number' && !isNaN(v)).length < 2)
const option = computed(() => props.samples != null
  ? buildTimeAreaLineOption({ samples: props.samples, color: props.color, unit: props.unit, refLines: props.refLines, spark: props.spark, smooth: props.smooth })
  : buildAreaLineOption({
      series: props.series, color: props.color, unit: props.unit, refLines: props.refLines,
      spark: props.spark, smooth: props.smooth, sampleIntervalSec: props.sampleIntervalSec,
    }))
</script>

<template>
  <div>
    <div v-if="empty" class="flex items-center justify-center text-body-sm text-on-surface-variant/60" :style="{ height: height + 'px' }">
      {{ t('common.noData') }}
    </div>
    <EChart v-else :option="option" :height="height" />
    <!-- refLines 图例 footer(沿用旧版 HTML 形式) -->
    <div v-if="refLines.length" class="flex flex-wrap gap-sm mt-xs">
      <span v-for="(r, i) in refLines" :key="i" class="flex items-center gap-0.5 text-xs text-on-surface-variant">
        <span class="w-2.5 h-0.5 rounded" :style="{ background: tokenHex(r.color) }"></span>{{ r.label }} {{ r.value }}{{ unit }}
      </span>
    </div>
  </div>
</template>
