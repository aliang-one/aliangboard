<script setup>
defineProps({
  total: { type: Number, default: 0 },
  pageSize: { type: Number, default: 10 },
  currentPage: { type: Number, default: 1 },
})

defineEmits(['page-change'])
</script>

<template>
  <div class="flex items-center gap-md">
    <span class="text-body-sm text-on-surface-variant">
      {{ (currentPage - 1) * pageSize + 1 }}-{{ Math.min(currentPage * pageSize, total) }} of {{ total }}
    </span>
    <div class="flex gap-1">
      <button
        class="p-xs text-on-surface-variant hover:bg-surface-container-highest rounded-md disabled:opacity-30"
        :disabled="currentPage <= 1"
      >
        <span class="material-symbols-outlined">chevron_left</span>
      </button>
      <button
        class="p-xs text-on-surface-variant hover:bg-surface-container-highest rounded-md"
        :disabled="currentPage * pageSize >= total"
      >
        <span class="material-symbols-outlined">chevron_right</span>
      </button>
    </div>
  </div>
</template>
