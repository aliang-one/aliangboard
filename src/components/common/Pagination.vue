<script setup>
import { computed } from 'vue'

const props = defineProps({
  total: { type: Number, default: 0 },
  pageSize: { type: Number, default: 10 },
  currentPage: { type: Number, default: 1 },
  // 是否显示页码大小选择器
  showSizeSelector: { type: Boolean, default: false },
})

const emit = defineEmits(['page-change', 'size-change'])

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))

function go(page) {
  if (page >= 1 && page <= totalPages.value) emit('page-change', page)
}

const start = computed(() => (props.total === 0 ? 0 : (props.currentPage - 1) * props.pageSize + 1))
const end = computed(() => Math.min(props.currentPage * props.pageSize, props.total))

const sizeOptions = [10, 20, 50, 100]
</script>

<template>
  <div v-if="total > 0" class="flex items-center gap-md">
    <select
      v-if="showSizeSelector"
      :value="pageSize"
      @change="emit('size-change', parseInt($event.target.value))"
      class="bg-surface-container-lowest border border-outline-variant rounded-lg px-sm py-xs text-body-sm focus:ring-2 focus:ring-primary"
    >
      <option v-for="s in sizeOptions" :key="s" :value="s">{{ s }} / 页</option>
    </select>
    <span class="text-body-sm text-on-surface-variant whitespace-nowrap">
      {{ start }}-{{ end }} / 共 {{ total }}
    </span>
    <div class="flex items-center gap-1">
      <button
        @click="go(currentPage - 1)"
        :disabled="currentPage <= 1"
        class="p-xs text-on-surface-variant hover:bg-surface-container-highest rounded-md disabled:opacity-30 transition-colors"
        title="上一页"
      >
        <span class="material-symbols-outlined">chevron_left</span>
      </button>
      <span class="text-body-sm font-medium text-on-surface px-sm min-w-[60px] text-center">{{ currentPage }} / {{ totalPages }}</span>
      <button
        @click="go(currentPage + 1)"
        :disabled="currentPage >= totalPages"
        class="p-xs text-on-surface-variant hover:bg-surface-container-highest rounded-md disabled:opacity-30 transition-colors"
        title="下一页"
      >
        <span class="material-symbols-outlined">chevron_right</span>
      </button>
    </div>
  </div>
</template>
