<script setup>
// 底部任务栏（类似 Windows taskbar）：显示所有终端会话（打开+最小化），点击恢复/聚焦。
// 左侧有「全部关闭」按钮。
import { useTerminalStore } from '@/stores/terminals'

const termStore = useTerminalStore()

function onClick(t) {
  if (t.status === 'external') {
    // external：聚焦弹窗（弹窗已关则恢复为 minimized）
    if (!termStore.focusExternal(t.id)) termStore.restoreTerminal(t.id)
  } else if (t.status === 'minimized') termStore.restoreTerminal(t.id)
  else termStore.focusTerminal(t.id)
}
function closeAll() {
  if (!termStore.terminals.length) return
  if (confirm(`确定关闭全部 ${termStore.terminals.length} 个终端会话？`)) {
    [...termStore.terminals].forEach(t => termStore.closeTerminal(t.id))
  }
}
</script>

<template>
  <div v-if="termStore.terminals.length" class="flex items-center gap-xs px-md bg-surface-container-highest border-t border-outline-variant shadow-lg shrink-0" style="height: 32px">
    <!-- 全部关闭 -->
    <button @click="closeAll" class="flex items-center gap-xs px-sm py-0.5 rounded-md text-body-xs bg-error/10 text-error hover:bg-error/20 border border-error/20 transition-colors shrink-0" title="关闭所有终端">
      <span class="material-symbols-outlined text-sm">delete_sweep</span>全部关闭
    </button>
    <span class="w-px h-4 bg-outline-variant/40 shrink-0"></span>
    <!-- 终端列表 -->
    <button v-for="t in termStore.terminals" :key="t.id" @click="onClick(t)"
      class="group flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs transition-all max-w-[220px] shrink-0"
      :class="t.status === 'open' ? 'bg-primary/15 text-primary border border-primary/30' : t.status === 'external' ? 'bg-secondary/10 text-secondary border border-secondary/30' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container border border-transparent'"
      :title="`${t.name}（${t.status === 'open' ? '浮动窗口' : t.status === 'external' ? '在新标签页中打开' : '已最小化'}）`">
      <span class="material-symbols-outlined text-sm">{{ t.status === 'open' ? 'terminal' : t.status === 'external' ? 'open_in_new' : 'hide_source' }}</span>
      <span class="truncate">{{ t.name }}</span>
      <span @click.stop="termStore.closeTerminal(t.id)" class="ml-xs p-0.5 rounded hover:bg-error/20 text-on-surface-variant/50 hover:text-error transition-colors opacity-0 group-hover:opacity-100" title="关闭此终端">
        <span class="material-symbols-outlined" style="font-size:13px">close</span>
      </span>
    </button>
    <span class="ml-auto text-body-xs text-on-surface-variant/40 shrink-0">{{ termStore.terminals.length }} 个终端</span>
  </div>
</template>
