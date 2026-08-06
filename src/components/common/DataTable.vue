<script setup>
defineProps({
  headers: { type: Array, required: true },
  rows: { type: Array, required: true },
})

defineEmits(['row-click'])
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th
              v-for="header in headers"
              :key="header.key"
              class="px-lg py-md text-label-caps text-on-surface-variant whitespace-nowrap"
              :class="header.align === 'right' ? 'text-right' : ''"
            >
              {{ header.label }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr
            v-for="(row, idx) in rows"
            :key="idx"
            class="hover:bg-surface-container-low/50 transition-colors group cursor-pointer"
            @click="$emit('row-click', row)"
          >
            <td
              v-for="header in headers"
              :key="header.key"
              class="px-lg py-md text-body-md"
              :class="header.align === 'right' ? 'text-right' : ''"
            >
              <slot :name="header.key" :row="row" :value="row[header.key]">
                <span>{{ row[header.key] }}</span>
              </slot>
            </td>
          </tr>
          <!-- 空状态：所有 DataTable 视图统一兜底 -->
          <tr v-if="!rows.length">
            <td :colspan="headers.length" class="px-lg py-xl text-center">
              <span class="material-symbols-outlined text-4xl text-surface-container-high block mb-sm">inbox</span>
              <p class="text-on-surface-variant">{{ $t('common.noData') }}</p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <!-- Pagination -->
    <div v-if="$slots.pagination" class="px-lg py-md bg-surface-container-low border-t border-outline-variant flex justify-between items-center">
      <slot name="pagination" />
    </div>
  </div>
</template>
