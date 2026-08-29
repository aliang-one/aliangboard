<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTableColumns } from '@/composables/useTableColumns'

const props = defineProps({
  tableKey: { type: String, required: true },
})

const { t } = useI18n()
const { allColumns, toggle, setOrder, resetTable } = useTableColumns()

const cols = computed(() => allColumns(props.tableKey))
const dragOverKey = ref(null)
let dragFromKey = null

function onDragStart(e, key) {
  dragFromKey = key
  e.dataTransfer.effectAllowed = 'move'
}
function onDragOver(e, key) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  dragOverKey.value = key
}
function onDrop(e, key) {
  e.preventDefault()
  dragOverKey.value = null
  if (dragFromKey && dragFromKey !== key) {
    const keys = cols.value.map(c => c.key)
    const from = keys.indexOf(dragFromKey)
    const to = keys.indexOf(key)
    if (from !== -1 && to !== -1) {
      keys.splice(to, 0, keys.splice(from, 1)[0])
      setOrder(props.tableKey, keys)
    }
  }
  dragFromKey = null
}
function move(key, dir) {
  const keys = cols.value.map(c => c.key)
  const i = keys.indexOf(key)
  const j = i + dir
  if (i !== -1 && j >= 0 && j < keys.length) {
    keys.splice(j, 0, keys.splice(i, 1)[0])
    setOrder(props.tableKey, keys)
  }
}
</script>

<template>
  <div class="w-full">
    <div class="flex items-center justify-between mb-sm">
      <span class="text-body-sm font-semibold">{{ t('settings.columnManager') }}</span>
      <button
        @click="resetTable(props.tableKey)"
        class="px-2 py-1 border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container"
      >{{ t('settings.reset') }}</button>
    </div>
    <ul class="space-y-xs">
      <li
        v-for="c in cols"
        :key="c.key"
        draggable="true"
        @dragstart="onDragStart($event, c.key)"
        @dragover="onDragOver($event, c.key)"
        @drop="onDrop($event, c.key)"
        class="flex items-center gap-sm px-sm py-xs rounded-md border cursor-grab active:cursor-grabbing transition-colors"
        :class="dragOverKey === c.key ? 'border-primary bg-primary-container/10' : (c.hidden ? 'border-outline-variant bg-surface-container-low' : 'border-outline-variant/60 bg-surface-container-lowest')"
      >
        <span class="material-symbols-outlined text-sm text-on-surface-variant select-none" :title="t('settings.dragHint')">drag_indicator</span>
        <label class="flex items-center gap-xs flex-1 cursor-pointer">
          <input
            type="checkbox"
            :checked="!c.hidden"
            @change="toggle(props.tableKey, c.key)"
            class="accent-[rgb(var(--md-sys-color-primary))]"
          />
          <span class="text-xs" :class="c.hidden ? 'text-on-surface-variant line-through' : 'text-on-surface'">{{ c.label }}</span>
        </label>
        <button @click="move(c.key, -1)" :title="t('settings.moveUp')" class="p-xs text-on-surface-variant hover:text-primary rounded">▲</button>
        <button @click="move(c.key, 1)" :title="t('settings.moveDown')" class="p-xs text-on-surface-variant hover:text-primary rounded">▼</button>
      </li>
    </ul>
  </div>
</template>
