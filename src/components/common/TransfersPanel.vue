<script setup>
// 传输面板:任务列表(进度条/速度/取消/移除)。FloatingWindow 壳,× 即关(panelOpen=false)。
import { useI18n } from 'vue-i18n'
import FloatingWindow from './FloatingWindow.vue'
import ProgressBar from './ProgressBar.vue'
import { useTransferStore, fmtBytes } from '@/stores/transfers'

const { t } = useI18n()
const tr = useTransferStore()

function pct(task) { return task.total > 0 ? Math.round((task.received / task.total) * 100) : null }
function statusLabel(s) {
  return s === 'active' ? t('transfers.statusActive') : s === 'done' ? t('transfers.statusDone')
    : s === 'canceled' ? t('transfers.statusCanceled') : t('transfers.statusError')
}
const kindIcon = k => (k === 'download' ? 'download' : 'upload')
</script>

<template>
  <FloatingWindow
    :title="t('transfers.panelTitle')" icon="swap_vert" width="480px" height="360px" :z-index="120"
    :cascade-index="9"
    :maximize-title="t('terminal.maximizeTitle')" :minimize-title="t('terminal.minimizeTitle')" :close-title="t('common.close')"
    @focus="() => {}" @minimize="tr.panelOpen = false" @close="tr.panelOpen = false"
  >
    <div class="h-full flex flex-col min-h-0">
      <div class="flex-1 overflow-auto p-sm space-y-sm min-h-0">
        <p v-if="!tr.tasks.length" class="text-body-sm text-on-surface-variant/60 text-center py-md">{{ t('transfers.empty') }}</p>
        <div v-for="task in tr.tasks" :key="task.id" class="px-sm py-2 rounded-lg border border-outline-variant/50 bg-surface-container-low flex flex-col gap-1">
          <div class="flex items-center gap-xs">
            <span class="material-symbols-outlined text-base shrink-0" :class="task.status === 'error' ? 'text-error' : task.status === 'done' ? 'text-primary' : 'text-on-surface-variant'">{{ kindIcon(task.kind) }}</span>
            <span class="font-mono text-xs truncate flex-1" :title="`${task.namespace}/${task.pod}/${task.container}${task.path}`">{{ task.name }}</span>
            <span class="text-[10px] px-1 rounded shrink-0" :class="task.status === 'error' ? 'bg-error/10 text-error' : task.status === 'done' ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant'">{{ statusLabel(task.status) }}</span>
            <button v-if="task.status === 'active'" @click="tr.cancel(task.id)" class="p-0.5 rounded hover:bg-error/15 text-on-surface-variant hover:text-error shrink-0 max-sm:p-2 max-sm:-m-2" :title="t('transfers.cancelTitle')">
              <span class="material-symbols-outlined text-base">close</span>
            </button>
            <button v-else @click="tr.remove(task.id)" class="p-0.5 rounded hover:bg-error/15 text-on-surface-variant hover:text-error shrink-0 max-sm:p-2 max-sm:-m-2" :title="t('transfers.removeTitle')">
              <span class="material-symbols-outlined text-base">delete</span>
            </button>
          </div>
          <ProgressBar v-if="pct(task) !== null" :value="pct(task)" :show-label="false" />
          <div class="flex items-center gap-sm text-[11px] text-on-surface-variant">
            <span v-if="pct(task) !== null">{{ t('transfers.progressLabel', { received: fmtBytes(task.received), total: fmtBytes(task.total) }) }} · {{ pct(task) }}%</span>
            <span v-else>{{ t('transfers.indeterminate', { received: fmtBytes(task.received) }) }}</span>
            <span v-if="task.status === 'active' && task.speed > 0">{{ t('transfers.speedLabel', { speed: fmtBytes(task.speed) }) }}</span>
            <span v-if="task.error" class="text-error truncate" :title="task.error">{{ task.error }}</span>
          </div>
        </div>
      </div>
      <div v-if="tr.tasks.some(x => x.status !== 'active')" class="px-sm py-1.5 border-t border-outline-variant/40 shrink-0">
        <button @click="tr.clearFinished()" class="px-sm py-1 rounded-md bg-surface-container text-on-surface-variant text-xs hover:bg-surface-container-high">{{ t('transfers.clearFinished') }}</button>
      </div>
    </div>
  </FloatingWindow>
</template>
