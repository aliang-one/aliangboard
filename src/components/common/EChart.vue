<script setup>
// ECharts 薄基座:业务图表组件不直接碰 echarts,只经本组件。
// 职责:init(亮/暗双主题 + SVG)/ ResizeObserver 自适应 / option 变更增量 setOption / 主题翻转重渲 / 卸载 dispose。
// merge 模式 setOption 配合 series id —— 滚动窗口更新走数据过渡动画而非整图重绘。
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { echarts } from '@/lib/echarts'
import { isDark } from '@/styles/theme'

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: Number, required: true },
})
const el = ref(null)
let chart = null
let ro = null

function onWinResize() { if (chart) chart.resize() }

function mountChart() {
  if (chart || !el.value) return
  chart = echarts.init(el.value, isDark.value ? 'md3-dark' : 'md3', { renderer: 'svg' })
  chart.setOption(props.option)
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (chart) chart.resize() })
    ro.observe(el.value)
  } else {
    window.addEventListener('resize', onWinResize)
  }
}
function unmountChart() {
  if (ro) { ro.disconnect(); ro = null }
  window.removeEventListener('resize', onWinResize)
  if (chart) { chart.dispose(); chart = null }
}

onMounted(mountChart)

watch(() => props.option, (opt) => { if (chart) chart.setOption(opt) })

// 主题翻转:dispose 重建(换 theme 名必须重建实例),当前 option 原样回灌
watch(isDark, () => { unmountChart(); mountChart() })

onBeforeUnmount(unmountChart)
</script>

<template>
  <div ref="el" class="w-full" :style="{ height: height + 'px' }"></div>
</template>
