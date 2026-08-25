<script setup>
// 轮内工具调用时间线(内联):每个 tool/denied/tool_start 事件一行——时刻 + 工具名 + 结果首行预览,
// 点击开 ToolCallModal 详情。与顶部 chips 总览(ToolTrace)互补:chips 看全貌,时间线看发生顺序与上下文。
// 流式期间随 live trace 实时追加;默认展开,超高滚动。
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ToolCallModal from './ToolCallModal.vue'
import { fmtResult } from '@/utils/toolResultFormat'

const props = defineProps({ trace: { type: Array, default: () => [] } })
const { t } = useI18n()
const selected = ref(null)
const showDetail = ref(false)

// 与 ToolTrace 同过滤口径:assistant 轮(LLM 思考回合,无 name)不占行
const rows = computed(() => (props.trace || []).filter(e => e && e.type !== 'assistant'))

const fmtTs = ts => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—')
// 结果首行预览(截断):fmtResult 智能摘要的第一行,内联一眼见结论;详情进 modal
const preview = ev => {
  const s = fmtResult(ev).split('\n').find(l => l.trim()) || ''
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}
function openDetail(ev) { selected.value = ev; showDetail.value = true }
</script>
<template>
  <div v-if="rows.length" data-testid="tool-timeline" class="flex flex-col gap-0.5 max-h-64 overflow-y-auto border-l-2 border-outline-variant/50 pl-sm">
    <button v-for="(ev, i) in rows" :key="i" type="button" data-testid="tool-tl-row"
      class="flex items-baseline gap-sm text-left text-body-xs font-mono px-xs py-0.5 rounded hover:bg-surface-container-low transition-colors"
      :class="ev.type === 'denied' ? 'text-status-warning' : ev.type === 'tool_start' ? 'text-status-running' : 'text-on-surface-variant'"
      @click="openDetail(ev)">
      <span class="text-on-surface-variant/50 shrink-0">{{ fmtTs(ev.ts) }}</span>
      <span class="shrink-0 font-semibold" :class="ev.type === 'denied' || ev.type === 'tool_start' ? '' : 'text-on-surface'">
        <span v-if="ev.type === 'tool_start'" class="material-symbols-outlined text-sm align-middle animate-spin mr-0.5">progress_activity</span>{{ ev.name }}
      </span>
      <span v-if="ev.type === 'denied'" class="truncate">{{ t('workbench.toolCall.denied') }}</span>
      <span v-else-if="ev.type === 'tool_start'" class="truncate text-status-running/70">{{ t('workbench.toolCall.running') }}</span>
      <span v-else class="truncate text-on-surface-variant/70">{{ preview(ev) }}</span>
    </button>
  </div>
  <ToolCallModal v-model="showDetail" :event="selected" />
</template>
