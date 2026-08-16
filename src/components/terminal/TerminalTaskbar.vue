<script setup>
// 底部任务栏(Windows taskbar 式)三分区:终端 | 文件窗口 | 传输(百分比汇总,点击开面板)。
// 「全部关闭」作用于终端+文件窗口;传输清理在 TransfersPanel。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore } from '@/stores/terminals'
import { useFileBrowserStore } from '@/stores/fileBrowsers'
import { useTransferStore } from '@/stores/transfers'

const { t } = useI18n()
const termStore = useTerminalStore()
const fbStore = useFileBrowserStore()
const trStore = useTransferStore()

function onTermClick(item) {
  if (item.status === 'external') {
    if (!termStore.focusExternal(item.id)) termStore.restoreTerminal(item.id)
  } else if (item.status === 'minimized') termStore.restoreTerminal(item.id)
  else termStore.focusTerminal(item.id)
}
function onFilesClick(b) { b.status === 'minimized' ? fbStore.restoreBrowser(b.id) : fbStore.focusBrowser(b.id) }

const sessionCount = computed(() => termStore.terminals.length + fbStore.browsers.length)
const hasAny = computed(() => sessionCount.value > 0 || trStore.tasks.length > 0)
const agg = computed(() => trStore.aggregate)
// 单任务直显名称+%;多任务汇总「done/count · 加权%」
const transferText = computed(() => {
  const a = agg.value
  if (a.count === 1) {
    const tk = trStore.tasks[0]
    const pct = tk.total > 0 ? Math.round((tk.received / tk.total) * 100) + '%' : fmt0(tk.received)
    return `${tk.name} ${pct}`
  }
  const pct = a.pct !== null ? ` · ${a.pct}%` : ''
  return `${t('transfers.summaryMulti', { done: a.doneCount, count: a.count })}${pct}`
})
function fmt0(n) { return (n / 1024).toFixed(0) + ' KB' }

function closeAll() {
  if (!sessionCount.value) return
  if (confirm(t('transfers.closeAllConfirm', { count: sessionCount.value }))) {
    [...termStore.terminals].forEach(item => termStore.closeTerminal(item.id))
    ;[...fbStore.browsers].forEach(b => fbStore.closeBrowser(b.id))
  }
}
</script>

<template>
  <div v-if="hasAny" class="flex items-center gap-xs px-md bg-surface-container-highest border-t border-outline-variant shadow-lg shrink-0" style="height: 32px">
    <button v-if="sessionCount" @click="closeAll" class="flex items-center gap-xs px-sm py-0.5 rounded-md text-body-xs bg-error/10 text-error hover:bg-error/20 border border-error/20 transition-colors shrink-0" :title="t('terminal.closeAllTitle')">
      <span class="material-symbols-outlined text-sm">delete_sweep</span>{{ t('terminal.closeAll') }}
    </button>
    <span v-if="sessionCount" class="w-px h-4 bg-outline-variant/40 shrink-0"></span>
    <!-- 分区1:终端 -->
    <button v-for="item in termStore.terminals" :key="'t-' + item.id" @click="onTermClick(item)"
      class="group flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs transition-all max-w-[220px] shrink-0"
      :class="item.status === 'open' ? 'bg-primary/15 text-primary border border-primary/30' : item.status === 'external' ? 'bg-secondary/10 text-secondary border border-secondary/30' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container border border-transparent'"
      :title="`${item.name}（${item.status === 'open' ? t('terminal.statusFloating') : item.status === 'external' ? t('terminal.statusExternal') : t('terminal.statusMinimized')}）`">
      <span class="material-symbols-outlined text-sm">{{ item.status === 'open' ? 'terminal' : item.status === 'external' ? 'open_in_new' : 'hide_source' }}</span>
      <span class="truncate">{{ item.name }}</span>
      <span @click.stop="termStore.closeTerminal(item.id)" class="ml-xs p-0.5 rounded hover:bg-error/20 text-on-surface-variant/50 hover:text-error transition-colors opacity-0 group-hover:opacity-100" :title="t('terminal.closeThisTitle')">
        <span class="material-symbols-outlined" style="font-size:13px">close</span>
      </span>
    </button>
    <!-- 分区2:文件窗口 -->
    <button v-for="b in fbStore.browsers" :key="'f-' + b.id" @click="onFilesClick(b)"
      class="group flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs transition-all max-w-[220px] shrink-0"
      :class="b.status === 'open' ? 'bg-tertiary-container/15 text-tertiary-container border border-tertiary-container/30' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container border border-transparent'"
      :title="`${b.name}（${b.status === 'open' ? t('terminal.statusFloating') : t('terminal.statusMinimized')}）`">
      <span class="material-symbols-outlined text-sm">{{ b.status === 'open' ? 'folder_open' : 'hide_source' }}</span>
      <span class="truncate">{{ b.name }}</span>
      <span @click.stop="fbStore.closeBrowser(b.id)" class="ml-xs p-0.5 rounded hover:bg-error/20 text-on-surface-variant/50 hover:text-error transition-colors opacity-0 group-hover:opacity-100" :title="t('terminal.closeThisTitle')">
        <span class="material-symbols-outlined" style="font-size:13px">close</span>
      </span>
    </button>
    <!-- 分区3:传输(百分比) -->
    <button v-if="trStore.tasks.length" @click="trStore.openPanel()"
      class="flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs shrink-0 transition-all max-w-[260px]"
      :class="agg.activeCount ? 'bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20' : 'bg-surface-container-low text-on-surface-variant border border-transparent hover:bg-surface-container'"
      :title="t('transfers.openPanelTitle')">
      <span class="material-symbols-outlined text-sm" :class="agg.activeCount ? 'animate-spin' : ''">{{ agg.count > 1 ? 'swap_vert' : (trStore.tasks[0].kind === 'download' ? 'download' : 'upload') }}</span>
      <span class="truncate">{{ transferText }}</span>
      <span v-if="!agg.activeCount" class="material-symbols-outlined text-sm">check_circle</span>
    </button>
    <span class="ml-auto text-body-xs text-on-surface-variant/40 shrink-0">{{ t('terminal.countLabel', { count: sessionCount }) }}</span>
  </div>
</template>
