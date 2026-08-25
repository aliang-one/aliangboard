<script setup>
// 工具调用紧凑 chips：每个 tool/denied 事件一颗；点开打开详情 Modal（替代就地展开）。
// 结果智能格式化:pod_logs 直接显示文本;describe/list 提取关键字段摘要;其他走 JSON。
// 多工具(>5)时折叠为摘要行,点开展开。
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { fmtResult } from '@/utils/toolResultFormat'
import ToolCallModal from './ToolCallModal.vue'

const props = defineProps({ trace: { type: Array, default: () => [] } })
const { t } = useI18n()

const selected = ref(null)   // 当前详情 Modal 展示的事件;chips 点击打开(替代就地展开)
const showDetail = ref(false)
const showAll = ref(false)
const COLLAPSE_THRESHOLD = 5

function openDetail(ev) { selected.value = ev; showDetail.value = true }

// 只展示工具类事件:assistant 轮(LLM 思考回合,无 name)曾渲染成无名 chip +
// 摘要里计为 "N× unknown"——用户无法解读,直接滤掉
const toolTrace = computed(() => props.trace.filter(x => x && x.type !== 'assistant'))
const needsCollapse = computed(() => toolTrace.value.length > COLLAPSE_THRESHOLD)
const visibleTrace = computed(() => needsCollapse.value && !showAll.value ? toolTrace.value.slice(0, 3) : toolTrace.value)

// 摘要:统计每个工具的调用次数(tool_start 是执行前瞬态,不计入防虚高)
const summary = computed(() => {
  const counts = {}
  for (const ev of toolTrace.value) {
    if (ev.type === 'tool_start') continue
    if (ev.type === 'denied') { counts['denied'] = (counts['denied'] || 0) + 1; continue }
    const n = ev.name || 'unknown'
    counts[n] = (counts[n] || 0) + 1
  }
  return Object.entries(counts).map(([name, count]) => `${count > 1 ? `${count}× ` : ''}${name}`).join(' + ')
})
</script>

<template>
  <div v-if="toolTrace.length" class="flex flex-col gap-xs">
    <div class="flex flex-wrap gap-sm items-center">
      <button v-for="(ev, i) in visibleTrace" :key="i" type="button" @click="openDetail(ev)"
        class="flex items-center gap-xs text-body-xs font-mono px-sm py-0.5 rounded-full border transition-colors"
        :class="ev.type === 'denied'
          ? 'border-status-warning/30 text-status-warning bg-status-warning/5'
          : ev.type === 'tool_start'
            ? 'border-status-running/40 text-status-running bg-status-running/5'
            : 'border-outline-variant text-on-surface hover:bg-surface-container-low'">
        <span class="material-symbols-outlined text-sm" :class="ev.type === 'tool_start' ? 'animate-spin' : ''">{{ ev.type === 'denied' ? 'block' : ev.type === 'tool_start' ? 'progress_activity' : 'play_arrow' }}</span>
        <span class="font-semibold">{{ ev.name }}</span>
        <span v-if="ev.type === 'denied'">{{ t('workbench.chat.toolDenied') }}</span>
        <span v-else-if="ev.type === 'tool_start'" class="text-status-running/70">…</span>
        <span v-else class="text-status-success">✓</span>
      </button>
      <button v-if="needsCollapse" @click="showAll = !showAll" type="button"
        class="flex items-center gap-xs text-body-xs text-on-surface-variant hover:text-primary px-sm py-xs rounded-md transition-colors whitespace-nowrap">
        <span class="material-symbols-outlined text-sm">{{ showAll ? 'expand_less' : 'expand_more' }}</span>
        {{ showAll ? t('workbench.chat.collapse') : '+' + (toolTrace.length - 3) }}
      </button>
      <span v-if="needsCollapse && !showAll" class="text-body-xs text-on-surface-variant/70 truncate ml-xs">{{ summary }}</span>
    </div>
    <ToolCallModal v-model="showDetail" :event="selected" />
  </div>
</template>
