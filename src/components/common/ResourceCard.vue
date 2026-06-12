<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], required: true },
  subtitle: { type: String, default: '' },
  icon: { type: String, default: '' },
  color: { type: String, default: 'primary' },
})
</script>

<template>
  <div class="bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-card flex items-center justify-between hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300">
    <div>
      <p class="text-label-caps text-on-surface-variant mb-xs">{{ label }}</p>
      <h3 class="text-display-lg font-bold" :class="`text-${color}`">{{ value }}</h3>
      <p v-if="subtitle" class="text-body-sm text-on-surface-variant flex items-center gap-xs mt-xs">
        <slot name="subtitle">
          <span class="material-symbols-outlined text-base">{{ icon }}</span> {{ subtitle }}
        </slot>
      </p>
    </div>
    <span v-if="$slots.icon" class="material-symbols-outlined text-surface-container-high text-5xl">
      <slot name="icon" />
    </span>
  </div>
</template>
