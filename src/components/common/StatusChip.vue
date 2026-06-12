<script setup>
const props = defineProps({
  status: { type: String, required: true },
  size: { type: String, default: 'md' },
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
      class="w-2 h-2 rounded-full"
      :class="[config.dot, config.animate ? 'animate-pulse-status' : '']"
    ></span>
    {{ status }}
  </span>
</template>
