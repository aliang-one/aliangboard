<script setup>
// SplitPane:可拖拽调整 + 左右/上下切换 + localStorage 持久化。
// 两个具名 slot:first(左/上)+ second(右/下)。拖拽 handle 调整分割比。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  storageKey: { type: String, required: true },
  defaultDirection: { type: String, default: 'horizontal' },
  defaultSplit: { type: Number, default: 0.55 },
  minSplit: { type: Number, default: 0.2 },
  maxSplit: { type: Number, default: 0.85 },
})

const emit = defineEmits(['directionChange'])

const direction = ref(props.defaultDirection)
const split = ref(props.defaultSplit)
const dragging = ref(false)

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(props.storageKey) || '{}')
    if (saved.direction) direction.value = saved.direction
    if (typeof saved.split === 'number') split.value = saved.split
  } catch {}
})

function save() {
  localStorage.setItem(props.storageKey, JSON.stringify({ direction: direction.value, split: split.value }))
}

function toggleDirection() {
  direction.value = direction.value === 'horizontal' ? 'vertical' : 'horizontal'
  save()
  emit('directionChange', direction.value)
}

const isH = computed(() => direction.value === 'horizontal')

// Drag
let dragStart = 0, splitStart = 0, containerSize = 0

function onDragStart(e) {
  dragging.value = true
  const pos = isH.value ? e.clientX : e.clientY
  dragStart = pos
  splitStart = split.value
  const parent = e.currentTarget.parentElement
  const rect = parent.getBoundingClientRect()
  containerSize = isH.value ? rect.width : rect.height
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragEnd)
  if (e.preventDefault) e.preventDefault()
}

function onDragMove(e) {
  if (!dragging.value) return
  const pos = isH.value ? e.clientX : e.clientY
  const delta = (pos - dragStart) / containerSize
  split.value = Math.max(props.minSplit, Math.min(props.maxSplit, splitStart + delta))
}

function onDragEnd() {
  dragging.value = false
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
  save()
}

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
})

const firstStyle = computed(() => isH.value
  ? { width: `${split.value * 100}%`, height: '100%', minWidth: 0 }
  : { width: '100%', height: `${split.value * 100}%`, minHeight: 0 })
const secondStyle = computed(() => ({ flex: 1, minWidth: 0, minHeight: 0 }))
</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden" :class="isH ? 'flex-row' : 'flex-col'">
    <!-- Direction toggle (floating top-right) -->
    <button
      @click="toggleDirection"
      class="absolute top-1 right-1 z-20 p-1 rounded-md bg-surface-container-lowest/90 border border-outline-variant/50 text-on-surface-variant hover:text-primary hover:border-primary/30 transition-colors backdrop-blur-sm"
      :title="isH ? 'Switch to vertical (top/bottom)' : 'Switch to horizontal (left/right)'"
    >
      <span class="material-symbols-outlined text-base">{{ isH ? 'horizontal_split' : 'view_column' }}</span>
    </button>
    <!-- First pane (left/top) -->
    <div :style="firstStyle" class="overflow-hidden flex flex-col min-h-0 min-w-0">
      <slot name="first" />
    </div>
    <!-- Drag handle -->
    <div
      @mousedown="onDragStart"
      @touchstart.prevent="onDragStart($event.touches[0])"
      class="shrink-0 flex items-center justify-center transition-colors group z-10"
      :class="[
        isH ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
        dragging ? 'bg-primary' : 'bg-outline-variant hover:bg-primary/40'
      ]"
    >
      <div v-if="!dragging" :class="isH ? 'w-0.5 h-8' : 'h-0.5 w-8'" class="rounded-full bg-on-surface-variant/20 group-hover:bg-primary/40 transition-colors" />
    </div>
    <!-- Second pane (right/bottom) -->
    <div :style="secondStyle" class="overflow-hidden flex flex-col min-h-0 min-w-0">
      <slot name="second" />
    </div>
  </div>
</template>
