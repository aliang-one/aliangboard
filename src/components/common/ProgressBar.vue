<script setup>
defineProps({
  value: { type: Number, required: true },
  max: { type: Number, default: 100 },
  color: { type: String, default: 'primary' },
  size: { type: String, default: 'sm' },
  showLabel: { type: Boolean, default: false },
  label: { type: String, default: '' },
})

function barColor(color, value) {
  if (value > 80) return 'bg-error'
  if (value > 60) return 'bg-tertiary-container'
  const colors = { primary: 'bg-primary', secondary: 'bg-secondary', primaryContainer: 'bg-primary-container' }
  return colors[color] || 'bg-primary'
}
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
        class="h-full rounded-full transition-all duration-500"
        :class="barColor(color, value)"
        :style="{ width: `${Math.min(value, 100)}%` }"
      ></div>
    </div>
  </div>
</template>
