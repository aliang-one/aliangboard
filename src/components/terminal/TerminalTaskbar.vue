<script setup>
// 底部任务栏（类似 Windows taskbar）：显示所有终端会话（打开+最小化），点击恢复/聚焦。
// 左侧有「全部关闭」按钮。
import { useI18n } from 'vue-i18n'
import { useTerminalStore } from '@/stores/terminals'

const { t } = useI18n()
const termStore = useTerminalStore()

function onClick(item) {
  if (item.status === 'external') {
    // external：聚焦弹窗（弹窗已关则恢复为 minimized）
    if (!termStore.focusExternal(item.id)) termStore.restoreTerminal(item.id)
  } else if (item.status === 'minimized') termStore.restoreTerminal(item.id)
  else termStore.focusTerminal(item.id)
}
function closeAll() {
  if (!termStore.terminals.length) return
  if (confirm(t('terminal.closeAllConfirm', { count: termStore.terminals.length }))) {
    [...termStore.terminals].forEach(item => termStore.closeTerminal(item.id))
  }
}
</script>

<template>
  <div v-if="termStore.terminals.length" class="flex items-center gap-xs px-md bg-surface-container-highest border-t border-outline-variant shadow-lg shrink-0" style="height: 32px">
    <!-- 全部关闭 -->
    <button @click="closeAll" class="flex items-center gap-xs px-sm py-0.5 rounded-md text-body-xs bg-error/10 text-error hover:bg-error/20 border border-error/20 transition-colors shrink-0" :title="t('terminal.closeAllTitle')">
      <span class="material-symbols-outlined text-sm">delete_sweep</span>{{ t('terminal.closeAll') }}
    </button>
    <span class="w-px h-4 bg-outline-variant/40 shrink-0"></span>
    <!-- 终端列表 -->
    <button v-for="item in termStore.terminals" :key="item.id" @click="onClick(item)"
      class="group flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs transition-all max-w-[220px] shrink-0"
      :class="item.status === 'open' ? 'bg-primary/15 text-primary border border-primary/30' : item.status === 'external' ? 'bg-secondary/10 text-secondary border border-secondary/30' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container border border-transparent'"
      :title="`${item.name}（${item.status === 'open' ? t('terminal.statusFloating') : item.status === 'external' ? t('terminal.statusExternal') : t('terminal.statusMinimized')}）`">
      <span class="material-symbols-outlined text-sm">{{ item.status === 'open' ? 'terminal' : item.status === 'external' ? 'open_in_new' : 'hide_source' }}</span>
      <span class="truncate">{{ item.name }}</span>
      <span @click.stop="termStore.closeTerminal(item.id)" class="ml-xs p-0.5 rounded hover:bg-error/20 text-on-surface-variant/50 hover:text-error transition-colors opacity-0 group-hover:opacity-100" :title="t('terminal.closeThisTitle')">
        <span class="material-symbols-outlined" style="font-size:13px">close</span>
      </span>
    </button>
    <span class="ml-auto text-body-xs text-on-surface-variant/40 shrink-0">{{ t('terminal.countLabel', { count: termStore.terminals.length }) }}</span>
  </div>
</template>
