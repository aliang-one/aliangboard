<script setup>
// 通用浮动窗口壳:标题栏拖拽/最大化/最小化/关闭/z-index 置顶。从 TerminalWindow 抽取,
// 终端与文件浏览窗口共用。双击语义留给内容方(终端标题双击=改名);title/title-actions 插槽自定义。
import { ref, computed, onUnmounted } from 'vue'

const props = defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  icon: { type: String, default: 'window' },
  zIndex: { type: Number, default: 40 },
  width: { type: String, default: '720px' },
  height: { type: String, default: '460px' },
  cascadeIndex: { type: Number, default: 0 },
  maximizeTitle: { type: String, default: '' },
  minimizeTitle: { type: String, default: '' },
  closeTitle: { type: String, default: '' },
})
const emit = defineEmits(['focus', 'minimize', 'close'])

const isMax = ref(false)
const pos = ref({
  x: Math.min(80 + (props.cascadeIndex % 5) * 30, (typeof window !== 'undefined' ? window.innerWidth : 1920) - 740),
  y: Math.min(80 + (props.cascadeIndex % 5) * 25, (typeof window !== 'undefined' ? window.innerHeight : 1080) - 480),
})

// —— 拖拽(仅非全屏;标题插槽内输入框/文本域等交互元素上不启动,保留改名时选文本 —— 原 TerminalWindow editing 守卫的泛化) ——
let dragging = false, dragStart = null
function onDragStart(e) {
  if (isMax.value) return
  if (e.target?.closest?.('input, textarea, select, [contenteditable], [data-no-drag]')) return
  dragging = true
  dragStart = { x: e.clientX - pos.value.x, y: e.clientY - pos.value.y }
  emit('focus')
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragEnd)
}
function onDragMove(e) { if (dragging) pos.value = { x: e.clientX - dragStart.x, y: e.clientY - dragStart.y } }
function onDragEnd() {
  dragging = false
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
}
onUnmounted(() => { document.removeEventListener('mousemove', onDragMove); document.removeEventListener('mouseup', onDragEnd) })

const winStyle = computed(() => isMax.value
  ? { left: '8px', top: '8px', right: '8px', bottom: '44px', zIndex: props.zIndex }
  : { left: pos.value.x + 'px', top: pos.value.y + 'px', width: props.width, height: props.height, zIndex: props.zIndex })
</script>
<template>
  <div data-test="window" class="fixed flex flex-col bg-surface-container-lowest rounded-lg shadow-2xl border border-outline-variant overflow-hidden"
       :style="winStyle" @mousedown="emit('focus')">
    <div data-test="titlebar" class="flex items-center gap-xs px-md py-1.5 bg-surface-container-high border-b border-outline-variant cursor-move select-none shrink-0" @mousedown="onDragStart">
      <span class="material-symbols-outlined text-base text-primary">{{ icon }}</span>
      <slot name="title">
        <span class="flex-1 text-body-sm font-medium text-on-surface truncate" :title="title">
          {{ title }}<span v-if="subtitle" class="text-on-surface-variant/50 text-body-xs ml-xs">{{ subtitle }}</span>
        </span>
      </slot>
      <slot name="title-actions" />
      <button data-test="btn-maximize" @click="isMax = !isMax" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant hover:text-primary" :title="maximizeTitle">
        <span class="material-symbols-outlined text-base">{{ isMax ? 'fullscreen_exit' : 'fullscreen' }}</span>
      </button>
      <button data-test="btn-minimize" @click="emit('minimize')" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant hover:text-on-surface" :title="minimizeTitle">
        <span class="material-symbols-outlined text-base">remove</span>
      </button>
      <button data-test="btn-close" @click="emit('close')" class="p-0.5 rounded hover:bg-error/15 text-on-surface-variant hover:text-error" :title="closeTitle">
        <span class="material-symbols-outlined text-base">close</span>
      </button>
    </div>
    <div class="flex-1 min-h-0 p-0"><slot /></div>
  </div>
</template>
