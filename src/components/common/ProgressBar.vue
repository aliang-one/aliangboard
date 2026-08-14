<script setup>
// 进度条:MD3 token 渐变填充 + 高危(>80%)斜纹流动示警。阈值语义与旧版一致(>80 error / >60 tertiary)。
// 渐变 hex 从 md-palette 取单一来源;props 契约与旧版完全一致(调用方零改动)。
import { computed } from 'vue'
import { tokenHex } from '@/styles/md-palette'

const props = defineProps({
  value: { type: Number, required: true },
  max: { type: Number, default: 100 },
  color: { type: String, default: 'primary' },
  size: { type: String, default: 'sm' },
  showLabel: { type: Boolean, default: false },
  label: { type: String, default: '' },
})

// 阈值档位(token 名);旧 color prop 的 primaryContainer camelCase 归一到 kebab
function tier(value) {
  if (value > 80) return 'error'
  if (value > 60) return 'tertiary-container'
  const map = { primary: 'primary', secondary: 'secondary', primaryContainer: 'primary-container' }
  return map[props.color] || 'primary'
}
// 每档渐变的亮端 token(比原色亮一档,纵向 90° 渐变)
const TO = {
  'primary': 'primary-container',
  'secondary': 'secondary-container',
  'primary-container': 'primary-fixed',
  'tertiary-container': 'tertiary-fixed-dim',
  'error': 'status-failed',
}
const stripes = computed(() => props.value > 80)
const fillStyle = computed(() => {
  const tok = tier(props.value)
  const grad = `linear-gradient(90deg, ${tokenHex(tok)} 0%, ${tokenHex(TO[tok] || 'primary-container')} 100%)`
  return {
    width: `${Math.min(props.value, 100)}%`,
    backgroundImage: stripes.value
      ? `repeating-linear-gradient(45deg, rgba(255,255,255,.25) 0 6px, transparent 6px 12px), ${grad}`
      : grad,
  }
})
</script>

<template>
  <div class="w-full">
    <div v-if="showLabel" class="flex justify-between text-body-sm mb-1">
      <span class="text-on-surface-variant">{{ label }}</span>
      <span class="font-medium">{{ value }}%</span>
    </div>
    <div
      class="w-full bg-surface-container-high rounded-full overflow-hidden"
      :class="size === 'sm' ? 'h-1.5' : size === 'md' ? 'h-2' : 'h-3'"
    >
      <div
        class="h-full rounded-full transition-all duration-700 ease-out"
        :class="stripes ? 'animate-bar-stripes' : ''"
        :style="fillStyle"
      ></div>
    </div>
  </div>
</template>
