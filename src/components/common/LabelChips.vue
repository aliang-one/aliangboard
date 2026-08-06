<template>
  <div class="flex flex-wrap gap-2">
    <span v-for="(val, key) in labels" :key="key"
      class="px-2 py-1 bg-surface-container rounded text-body-sm border border-outline-variant">
      {{ key }}: {{ val }}
    </span>
    <span v-if="emptyText && !Object.keys(labels || {}).length" class="text-body-sm text-on-surface-variant">{{ emptyText }}</span>
  </div>
</template>

<script setup>
defineProps({
  labels: { type: Object, default: () => ({}) },
  emptyText: { type: String, default: '' },
})
</script>
