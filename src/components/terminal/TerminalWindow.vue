<script setup>
// 浮动终端窗口：可拖拽、重命名、最小化、全屏、新标签页打开、关闭。
// 内嵌 InteractiveTerminal（exec 连接随窗口生命周期）。
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import InteractiveTerminal from '@/components/common/InteractiveTerminal.vue'
import { useTerminalStore } from '@/stores/terminals'

const props = defineProps({
  terminal: { type: Object, required: true },
})
const termStore = useTerminalStore()
const termRef = ref(null)  // InteractiveTerminal 引用

const editing = ref(false)
const nameInput = ref(props.terminal.name)
const isMax = ref(false) // 全屏

// 从 minimized → open 时，等 DOM 显示后触发 xterm 重新 fit（ResizeObserver 在 display:none→block 时可能漏触发）
let refitTimer = null
watch(() => props.terminal.status, (s) => {
  if (s === 'open') {
    if (refitTimer) clearTimeout(refitTimer)
    nextTick(() => {
      refitTimer = setTimeout(() => {
        try { termRef.value?.refit() } catch { /* noop */ }
        refitTimer = null
      }, 50)
    })
  }
})
const pos = ref({
  x: Math.min(80 + (termStore.terminals.length % 5) * 30, (typeof window !== 'undefined' ? window.innerWidth : 1920) - 740),
  y: Math.min(80 + (termStore.terminals.length % 5) * 25, (typeof window !== 'undefined' ? window.innerHeight : 1080) - 480),
})

// —— 拖拽（仅非全屏时） ——
let dragging = false, dragStart = null
function onDragStart(e) {
  if (editing.value || isMax.value) return
  dragging = true
  dragStart = { x: e.clientX - pos.value.x, y: e.clientY - pos.value.y }
  termStore.focusTerminal(props.terminal.id)
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

// —— 操作 ——
function saveName() {
  const v = nameInput.value.trim()
  if (v && v !== props.terminal.name) termStore.renameTerminal(props.terminal.id, v)
  editing.value = false
}
function focus() { termStore.focusTerminal(props.terminal.id) }
function minimize() { termStore.minimizeTerminal(props.terminal.id) }
function toggleMax() { isMax.value = !isMax.value }
function close() { termStore.closeTerminal(props.terminal.id) }

// 在新浏览器标签页打开：关闭浮动窗口（避免双重 exec），标记 external，打开独立路由页
function openInNewTab() { termStore.openExternal(props.terminal.id) }

const shortName = computed(() => {
  const n = props.terminal.name || ''
  return n.length > 30 ? n.slice(0, 28) + '…' : n
})
const winStyle = computed(() => isMax.value
  ? { left: '8px', top: '8px', right: '8px', bottom: '44px', zIndex: props.terminal.zIndex }
  : { left: pos.value.x + 'px', top: pos.value.y + 'px', width: '720px', height: '460px', zIndex: props.terminal.zIndex })
</script>

<template>
  <div class="fixed flex flex-col bg-surface-container-lowest rounded-lg shadow-2xl border border-outline-variant overflow-hidden"
       :style="winStyle" @mousedown="focus">
    <!-- 标题栏（可拖拽） -->
    <div class="flex items-center gap-xs px-md py-1.5 bg-surface-container-high border-b border-outline-variant cursor-move select-none shrink-0" @mousedown="onDragStart">
      <span class="material-symbols-outlined text-base text-primary">terminal</span>
      <!-- 可编辑名称 -->
      <input v-if="editing" v-model="nameInput" @blur="saveName" @keydown.enter="saveName" @keydown.esc="editing = false"
             class="flex-1 bg-surface-container-lowest border border-primary rounded px-sm py-0.5 text-body-sm font-mono focus:outline-none" />
      <span v-else @dblclick="editing = true; nameInput = terminal.name" class="flex-1 text-body-sm font-medium text-on-surface truncate" :title="terminal.name + '（双击重命名）'">
        {{ shortName }}
        <span class="text-on-surface-variant/50 text-body-xs ml-xs">{{ terminal.namespace }}</span>
      </span>
      <!-- 窗口操作 -->
      <button @click="openInNewTab" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant hover:text-primary" title="在新标签页打开">
        <span class="material-symbols-outlined text-base">open_in_new</span>
      </button>
      <button @click="toggleMax" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant hover:text-primary" :title="isMax ? '还原' : '全屏'">
        <span class="material-symbols-outlined text-base">{{ isMax ? 'fullscreen_exit' : 'fullscreen' }}</span>
      </button>
      <button @click="minimize" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant hover:text-on-surface" title="最小化">
        <span class="material-symbols-outlined text-base">remove</span>
      </button>
      <button @click="close" class="p-0.5 rounded hover:bg-error/15 text-on-surface-variant hover:text-error" title="关闭终端">
        <span class="material-symbols-outlined text-base">close</span>
      </button>
    </div>
    <!-- 终端体 -->
    <div class="flex-1 min-h-0 p-0">
      <InteractiveTerminal ref="termRef" :pod-name="terminal.podName" :namespace="terminal.namespace" :container="terminal.container" :auto-connect="true" />
    </div>
  </div>
</template>
