<script setup>
import { useIsPhone } from '@/composables/useBreakpoint'
import { ref } from 'vue'

const { isPhone } = useIsPhone()
const filterOpen = ref(false) // 手机档折叠态;桌面恒视为展开

const props = defineProps({
  filters: { type: Array, required: true },
  resultCount: { type: Number, default: 0 },
  resultLabel: { type: String, default: 'results' },
})

const emit = defineEmits(['filter-change'])

function onChange(filter, event) {
  emit('filter-change', { key: filter.key, value: event.target.value })
}
// 重置所有过滤器为各自的默认（首个）选项
function resetFilters() {
  for (const f of props.filters) emit('filter-change', { key: f.key, value: f.options[0] })
}
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md flex flex-wrap items-center gap-gutter shadow-card">
    <!-- 手机档:条件收进可展开面板;桌面恒展开 -->
    <div v-show="!isPhone || filterOpen" data-filter-fields class="contents">
      <div v-for="filter in filters" :key="filter.key" class="flex flex-col gap-xs">
        <label class="text-label-caps text-on-surface-variant">{{ filter.label }}</label>
        <select
          class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary focus:border-primary min-w-[160px]"
          @change="onChange(filter, $event)"
        >
          <option v-for="opt in filter.options" :key="opt" :value="opt">{{ opt }}</option>
        </select>
      </div>
    </div>
    <div class="ml-auto flex items-center gap-sm self-end pb-1">
      <button v-if="isPhone" data-test="filter-toggle" @click="filterOpen = !filterOpen"
        class="p-xs text-on-surface-variant hover:text-primary rounded-md transition-colors max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center"
        :aria-label="$t('component.filterBar.toggle')">
        <span class="material-symbols-outlined text-lg">{{ filterOpen ? 'filter_alt_off' : 'filter_alt' }}</span>
      </button>
      <span class="text-body-sm text-on-surface-variant">{{ resultCount }} {{ resultLabel }}</span>
      <button @click="resetFilters" :title="$t('component.filterBar.resetFilters')" class="p-xs text-primary hover:bg-primary-container/10 rounded-md transition-colors">
        <span class="material-symbols-outlined">refresh</span>
      </button>
    </div>
  </div>
</template>
