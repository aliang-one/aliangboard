<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { useTableColumns } from '@/composables/useTableColumns'
import ColumnManager from '@/components/common/ColumnManager.vue'

const props = defineProps({
  headers: { type: Array, required: true },
  rows: { type: Array, required: true },
  columnKey: { type: String, default: '' },
  // 可选:行选择(leading checkbox 列,v-model:selection)
  selectable: { type: Boolean, default: false },
  // 可选:展开行(leading 展开钮列,#expanded slot 渲染展开内容)
  expandable: { type: Boolean, default: false },
  // 行唯一键(选择/展开按此识别)
  rowKey: { type: String, default: 'name' },
  selection: { type: Array, default: () => [] },
})

const emit = defineEmits(['row-click', 'update:selection'])

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
// 卸载兜底:拖拽途中组件被销毁时 onUp 不会触发,window 监听会泄漏。onUp 幂等。
onBeforeUnmount(() => onUp())

// === 行选择 ===
const rowId = (row) => (row == null ? null : row[props.rowKey])
function isSelected(row) {
  const id = rowId(row)
  return props.selection.some(r => rowId(r) === id)
}
function toggleRow(row) {
  const id = rowId(row)
  const next = isSelected(row)
    ? props.selection.filter(r => rowId(r) !== id)
    : [...props.selection, row]
  emit('update:selection', next)
}
const allSelected = computed(() => props.rows.length > 0 && props.rows.every(r => isSelected(r)))
function toggleAll() {
  emit('update:selection', allSelected.value ? [] : [...props.rows])
}

// === 展开行 ===
const expanded = ref(new Set())
function isExpanded(row) { return expanded.value.has(rowId(row)) }
function toggleExpand(row) {
  const id = rowId(row)
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

// === 列数(含系统列:select / expand / ☰)用于 colspan ===
const sysCols = computed(() =>
  (props.selectable ? 1 : 0) + (props.expandable ? 1 : 0) + (props.columnKey ? 1 : 0))
const totalCols = computed(() => Math.max(props.headers.length, 1) + sysCols.value)

const thStyle = (h) => h.width ? { width: h.width + 'px', minWidth: h.width + 'px' } : {}
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <!-- 选择(全选)系统列 -->
            <th v-if="selectable" class="px-sm py-md w-10" @click.stop>
              <input type="checkbox" data-select-all :checked="allSelected" @change="toggleAll" class="accent-[var(--md-sys-color-primary)] cursor-pointer" />
            </th>
            <!-- 展开钮占位系统列 -->
            <th v-if="expandable" class="px-sm py-md w-10"></th>
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
          <template v-for="(row, idx) in rows" :key="rowId(row) ?? idx">
            <tr
              class="hover:bg-surface-container-low/50 transition-colors group cursor-pointer"
              @click="$emit('row-click', row)"
            >
              <!-- 选择系统列(@click.stop 阻断行点击) -->
              <td v-if="selectable" class="px-sm py-md" @click.stop>
                <input type="checkbox" data-row-select :checked="isSelected(row)" @change="toggleRow(row)" class="accent-[var(--md-sys-color-primary)] cursor-pointer" />
              </td>
              <!-- 展开钮系统列 -->
              <td v-if="expandable" class="px-sm py-md" @click.stop>
                <button data-expand-toggle @click="toggleExpand(row)" class="material-symbols-outlined text-base text-on-surface-variant hover:text-primary p-xs rounded">{{ isExpanded(row) ? 'expand_more' : 'chevron_right' }}</button>
              </td>
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
            <!-- 展开行(整行一格,#expanded slot) -->
            <tr v-if="expandable && isExpanded(row)">
              <td :colspan="totalCols" class="px-lg py-md bg-surface-container-low border-t border-outline-variant/30">
                <slot name="expanded" :row="row" />
              </td>
            </tr>
          </template>
          <!-- 空状态:无行 或 无可见列 -->
          <tr v-if="!rows.length || !headers.length">
            <td :colspan="totalCols" class="px-lg py-xl text-center">
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
