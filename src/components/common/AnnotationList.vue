<template>
  <div class="text-body-sm bg-surface-container p-sm rounded border border-outline-variant font-mono text-code-sm text-on-surface-variant">
    <div v-for="(val, key) in annotations" :key="key">{{ key }}: "{{ val }}"</div>
    <div v-if="emptyText && !Object.keys(annotations || {}).length">{{ emptyText }}</div>
  </div>
</template>

<script setup>
defineProps({
  annotations: { type: Object, default: () => ({}) },
  emptyText: { type: String, default: '' },
})
</script>
