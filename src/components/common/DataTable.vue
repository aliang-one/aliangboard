<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { useTableColumns } from '@/composables/useTableColumns'
import { useDropdownPanel } from '@/composables/useDropdownPanel'
import { useIsPhone } from '@/composables/useBreakpoint'
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

const emit = defineEmits(['row-click', 'update:selection', 'expand'])

const { setWidth } = useTableColumns()

// 手机卡片模式(spec §4.1):首个数据列=标题,其余列=键值行;同一份列 slot 双分支复用,单渲染
const { isPhone } = useIsPhone()
const titleKey = computed(() => props.headers[0]?.key)
const kvHeaders = computed(() => props.headers.slice(1))

// 列管理弹层
const mgrOpen = ref(false)
function toggleMgr() { mgrOpen.value = !mgrOpen.value }
// 弹层 Teleport body + fixed 锚定 ☰ 按钮(2026-09-01):表格根 overflow-hidden +
// overflow-x-auto(overflow-y 计算为 auto)会把就地 absolute 弹层裁进滚动容器
const colMgrBtnRef = ref(null)
const { panelRef: mgrPanelRef, panelStyle: mgrPanelStyle } = useDropdownPanel(colMgrBtnRef, mgrOpen, { align: 'right' })

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
  const willExpand = !next.has(id)
  if (willExpand) next.add(id)
  else next.delete(id)
  expanded.value = next
  if (willExpand) emit('expand', row)   // 供视图懒拉取(如展开时 GET 完整 YAML)
}

// === 列数(含系统列:select / expand / ☰)用于 colspan ===
const sysCols = computed(() =>
  (props.selectable ? 1 : 0) + (props.expandable ? 1 : 0) + (props.columnKey ? 1 : 0))
const totalCols = computed(() => Math.max(props.headers.length, 1) + sysCols.value)

const thStyle = (h) => h.width ? { width: h.width + 'px', minWidth: h.width + 'px' } : {}
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
    <div v-if="!isPhone" class="overflow-x-auto">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <!-- 选择(全选)系统列 -->
            <th v-if="selectable" class="px-sm py-md w-10" @click.stop>
              <input type="checkbox" data-select-all :checked="allSelected" @change="toggleAll" class="accent-[rgb(var(--md-sys-color-primary))] cursor-pointer" />
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
                  ref="colMgrBtnRef"
                  data-col-manager
                  @click="toggleMgr"
                  class="material-symbols-outlined text-base text-on-surface-variant hover:text-primary p-xs rounded"
                  :title="$t('settings.columnManager')"
                >view_column</button>
              </div>
              <!-- 弹层 Teleport body + fixed(见脚本注释),脱离表格 overflow 裁切链 -->
              <Teleport to="body">
                <div
                  v-if="mgrOpen"
                  ref="mgrPanelRef"
                  data-testid="col-manager-panel"
                  :style="mgrPanelStyle"
                  class="w-64 p-md bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card"
                >
                  <button @click="toggleMgr" class="absolute top-xs right-xs material-symbols-outlined text-base text-on-surface-variant hover:text-primary max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">close</button>
                  <ColumnManager :table-key="columnKey" />
                </div>
              </Teleport>
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
                <input type="checkbox" data-row-select :checked="isSelected(row)" @change="toggleRow(row)" class="accent-[rgb(var(--md-sys-color-primary))] cursor-pointer" />
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
    <!-- 手机卡片模式(spec §4.1):slot 与桌面同源单渲染;checkbox/expand .stop 防误触 row-click -->
    <div v-else class="divide-y divide-outline-variant/30">
      <div v-for="(row, idx) in rows" :key="rowId(row) ?? idx" data-card-row
        class="relative px-md py-md active:bg-surface-container-low/60 transition-colors"
        @click="$emit('row-click', row)">
        <div class="flex items-start gap-sm">
          <div class="flex-1 min-w-0" data-card-title>
            <slot :name="titleKey" :row="row" :value="row[titleKey]">
              <span class="block truncate font-semibold text-body-md">{{ row[titleKey] }}</span>
            </slot>
          </div>
          <span v-if="selectable" data-card-select-hit class="shrink-0 -m-1 p-2.5 inline-flex items-center justify-center" @click.stop>
            <input type="checkbox" data-card-select :checked="isSelected(row)" @click.stop="toggleRow(row)"
              class="w-5 h-5 accent-[rgb(var(--md-sys-color-primary))] cursor-pointer" />
          </span>
          <button v-if="expandable" data-card-expand @click.stop="toggleExpand(row)"
            class="shrink-0 p-xs text-on-surface-variant hover:text-primary rounded">
            <span class="material-symbols-outlined text-base">{{ isExpanded(row) ? 'expand_more' : 'chevron_right' }}</span>
          </button>
        </div>
        <div class="mt-sm grid gap-xs">
          <div v-for="header in kvHeaders" :key="header.key" data-kv-row class="flex items-baseline gap-sm min-w-0">
            <span data-kv-label class="text-label-caps text-on-surface-variant shrink-0 w-20">{{ header.label }}</span>
            <span class="min-w-0 overflow-hidden text-body-sm"><slot :name="header.key" :row="row" :value="row[header.key]">{{ row[header.key] }}</slot></span>
          </div>
        </div>
        <div v-if="expandable && isExpanded(row)" class="mt-sm pt-sm border-t border-outline-variant/30">
          <slot name="expanded" :row="row" />
        </div>
      </div>
      <div v-if="!rows.length" class="px-md py-xl text-center">
        <span class="material-symbols-outlined text-4xl text-surface-container-high block mb-sm">inbox</span>
        <p class="text-on-surface-variant">{{ $t('common.noData') }}</p>
      </div>
    </div>
    <div v-if="$slots.pagination" class="px-lg py-md bg-surface-container-low border-t border-outline-variant flex justify-between items-center">
      <slot name="pagination" />
    </div>
  </div>
</template>
