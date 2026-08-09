<script setup>
import { ref, computed } from 'vue'
import { useTableColumns } from '@/composables/useTableColumns'
import ColumnManager from '@/components/common/ColumnManager.vue'

const props = defineProps({
  headers: { type: Array, required: true },
  rows: { type: Array, required: true },
  columnKey: { type: String, default: '' },
})

defineEmits(['row-click'])

const { setWidth } = useTableColumns()

// 列管理弹层
const mgrOpen = ref(false)
function toggleMgr() { mgrOpen.value = !mgrOpen.value }

// 列宽拖拽
let resizing = null // { key, startX, startW }
function startResize(e, key) {
  if (!props.columnKey) return
  const th = e.currentTarget.parentElement
  resizing = { key, startX: e.clientX, startW: th.getBoundingClientRect().width }
  e.preventDefault()
  e.stopPropagation()
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
function onMove(e) {
  if (!resizing) return
  const next = resizing.startW + (e.clientX - resizing.startX)
  setWidth(props.columnKey, resizing.key, next)
}
function onUp() {
  resizing = null
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
}

const thStyle = (h) => h.width ? { width: h.width + 'px', minWidth: h.width + 'px' } : {}
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
              class="relative px-lg py-md text-label-caps text-on-surface-variant whitespace-nowrap"
              :class="header.align === 'right' ? 'text-right' : ''"
              :style="thStyle(header)"
            >
              {{ header.label }}
              <span
                v-if="columnKey"
                @pointerdown="startResize($event, header.key)"
                class="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-primary/30"
                :title="$t('settings.dragHint')"
              ></span>
            </th>
            <!-- 列管理入口(仅 columnKey 时) -->
            <th v-if="columnKey" class="px-sm py-md w-10 text-right">
              <div class="relative inline-block">
                <button
                  data-col-manager
                  @click="toggleMgr"
                  class="material-symbols-outlined text-base text-on-surface-variant hover:text-primary p-xs rounded"
                  :title="$t('settings.columnManager')"
                >view_column</button>
                <div v-if="mgrOpen" class="absolute right-0 top-full mt-xs z-50 w-64 p-md bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card">
                  <button @click="toggleMgr" class="absolute top-xs right-xs material-symbols-outlined text-base text-on-surface-variant hover:text-primary">close</button>
                  <ColumnManager :table-key="columnKey" />
                </div>
              </div>
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
            <td v-if="columnKey" class="px-sm"></td>
          </tr>
          <!-- 空状态:无行 或 无可见列 -->
          <tr v-if="!rows.length || !headers.length">
            <td :colspan="Math.max(headers.length, 1) + (columnKey ? 1 : 0)" class="px-lg py-xl text-center">
              <span class="material-symbols-outlined text-4xl text-surface-container-high block mb-sm">inbox</span>
              <p class="text-on-surface-variant">{{ $t('common.noData') }}</p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="$slots.pagination" class="px-lg py-md bg-surface-container-low border-t border-outline-variant flex justify-between items-center">
      <slot name="pagination" />
    </div>
  </div>
</template>
