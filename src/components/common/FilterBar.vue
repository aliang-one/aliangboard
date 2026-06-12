<script setup>
defineProps({
  filters: { type: Array, required: true },
  resultCount: { type: Number, default: 0 },
  resultLabel: { type: String, default: 'results' },
})

const emit = defineEmits(['filter-change'])

function onChange(filter, event) {
  emit('filter-change', { key: filter.key, value: event.target.value })
}
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md flex flex-wrap items-center gap-gutter shadow-card">
    <div v-for="filter in filters" :key="filter.key" class="flex flex-col gap-xs">
      <label class="text-label-caps text-on-surface-variant">{{ filter.label }}</label>
      <select
        class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary focus:border-primary min-w-[160px]"
        @change="onChange(filter, $event)"
      >
        <option v-for="opt in filter.options" :key="opt" :value="opt">{{ opt }}</option>
      </select>
    </div>
    <div class="ml-auto flex items-center gap-sm self-end pb-1">
      <span class="text-body-sm text-on-surface-variant">{{ resultCount }} {{ resultLabel }}</span>
      <button class="p-xs text-primary hover:bg-primary-container/10 rounded-md transition-colors">
        <span class="material-symbols-outlined">refresh</span>
      </button>
    </div>
  </div>
</template>
