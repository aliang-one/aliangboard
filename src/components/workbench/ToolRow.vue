<script setup>
// 单个工具调用行(交错流内联用):时刻 + 工具名 + 结果首行预览,点击开 ToolCallModal。
// 从 ToolTimeline 的行样式抽出;tool_start 转圈执行中 / denied 拒绝分型。
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ToolCallModal from './ToolCallModal.vue'
import { fmtResult } from '@/utils/toolResultFormat'

const props = defineProps({ event: { type: Object, required: true } })
const { t } = useI18n()
const showDetail = ref(false)

const fmtTs = ts => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—')
const preview = ev => {
  const s = fmtResult(ev).split('\n').find(l => l.trim()) || ''
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}
</script>
<template>
  <button type="button" data-testid="tool-row"
    class="flex items-baseline gap-sm text-left text-body-xs font-mono px-xs py-0.5 rounded hover:bg-surface-container-low transition-colors w-full"
    :class="event.type === 'denied' ? 'text-status-warning' : event.type === 'tool_start' ? 'text-status-running' : 'text-on-surface-variant'"
    @click="showDetail = true">
    <span class="text-on-surface-variant/50 shrink-0">{{ fmtTs(event.ts) }}</span>
    <span class="shrink-0 font-semibold" :class="event.type === 'denied' || event.type === 'tool_start' ? '' : 'text-on-surface'">
      <span v-if="event.type === 'tool_start'" class="material-symbols-outlined text-sm align-middle animate-spin mr-0.5">progress_activity</span>{{ event.name }}
    </span>
    <span v-if="event.type === 'denied'" class="truncate">{{ t('workbench.toolCall.denied') }}</span>
    <span v-else-if="event.type === 'tool_start'" class="truncate text-status-running/70">{{ t('workbench.toolCall.running') }}</span>
    <span v-else class="truncate text-on-surface-variant/70">{{ preview(event) }}</span>
  </button>
  <ToolCallModal v-model="showDetail" :event="event" />
</template>
