<script setup>
// ECharts 薄基座:业务图表组件不直接碰 echarts,只经本组件。
// 职责:init(md3 主题 + SVG)/ ResizeObserver 自适应 / option 变更增量 setOption / 卸载 dispose。
// merge 模式 setOption 配合 series id —— 滚动窗口更新走数据过渡动画而非整图重绘。
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { echarts } from '@/lib/echarts'

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: Number, required: true },
})
const el = ref(null)
let chart = null
let ro = null

function onWinResize() { if (chart) chart.resize() }

onMounted(() => {
  chart = echarts.init(el.value, 'md3', { renderer: 'svg' })
  chart.setOption(props.option)
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (chart) chart.resize() })
    ro.observe(el.value)
  } else {
    window.addEventListener('resize', onWinResize)
  }
})

watch(() => props.option, (opt) => { if (chart) chart.setOption(opt) }, { deep: true })

onBeforeUnmount(() => {
  if (ro) { ro.disconnect(); ro = null }
  window.removeEventListener('resize', onWinResize)
  if (chart) { chart.dispose(); chart = null }
})
</script>

<template>
  <div ref="el" class="w-full" :style="{ height: height + 'px' }"></div>
</template>
