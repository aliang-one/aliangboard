<script setup>
const props = defineProps({
  status: { type: String, required: true },
  size: { type: String, default: 'md' },
  // 内置状态点开关(默认开,向后兼容)。宿主行内已画状态点时必须关掉——PodCard 行1 行首
  // 已有健康呼吸点,与内置点叠成双呼吸点并把行内容推宽,窄列(overview 中列)溢出(2026-09-05)。
  dot: { type: Boolean, default: true },
})

const statusConfig = {
  Running:   { bg: 'bg-primary-container/20', text: 'text-primary', dot: 'bg-primary', animate: true },
  Pending:   { bg: 'bg-tertiary-container/10', text: 'text-tertiary-container', dot: 'bg-tertiary-container', animate: false },
  Failed:    { bg: 'bg-error-container/40', text: 'text-error', dot: 'bg-error', animate: false },
  Succeeded: { bg: 'bg-secondary-fixed/20', text: 'text-secondary', dot: 'bg-secondary-fixed-dim', animate: false },
  Unknown:   { bg: 'bg-surface-container', text: 'text-on-surface-variant', dot: 'bg-on-surface-variant', animate: false },
  Ready:     { bg: 'bg-primary-container/20', text: 'text-primary', dot: 'bg-primary', animate: false },
  NotReady:  { bg: 'bg-error-container/40', text: 'text-error', dot: 'bg-error', animate: false },
  Active:    { bg: 'bg-primary-container/20', text: 'text-primary', dot: 'bg-primary', animate: false },
  Bound:     { bg: 'bg-primary-container/20', text: 'text-primary', dot: 'bg-primary', animate: false },
}

const config = statusConfig[props.status] || statusConfig.Unknown
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full font-semibold"
    :class="[config.bg, config.text, size === 'sm' ? 'text-body-sm' : 'text-body-sm']"
  >
    <span
      v-if="dot"
      class="w-2 h-2 rounded-full"
      :class="[config.dot, config.animate ? 'animate-pulse-status' : '']"
    ></span>
    {{ status }}
  </span>
</template>
