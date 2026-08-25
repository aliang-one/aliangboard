<script setup>
// 工具调用详情 Modal:chips 点击进入。参数 JSON + 结果双视图(摘要=fmtResult 智能格式化 / 原始=完整 JSON)+
// 复制;denied/tool_start 分型;ts 缺失(存量事件)显示 —。数据全部来自对话 trace,无新端点。
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'
import { fmtResult } from '@/utils/toolResultFormat'
import { notify } from '@/composables/useToast'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  event: { type: Object, default: null },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()
const tab = ref('summary')            // 'summary' | 'raw'
const RAW_MAX = 64 * 1024

const argsJson = computed(() => props.event?.args && Object.keys(props.event.args || {}).length ? JSON.stringify(props.event.args, null, 2) : '')
const summaryText = computed(() => props.event?.type === 'tool' ? fmtResult(props.event) : '')
const rawText = computed(() => {
  const r = props.event?.result
  if (r == null) return ''
  const s = typeof r === 'string' ? r : JSON.stringify(r, null, 2)
  return s.length > RAW_MAX ? s.slice(0, RAW_MAX) : s
})
const truncated = computed(() => {
  const r = props.event?.result
  if (r == null) return false
  const s = typeof r === 'string' ? r : JSON.stringify(r, null, 2)
  return s.length > RAW_MAX
})
const tsText = computed(() => props.event?.ts ? new Date(props.event.ts).toLocaleString() : t('workbench.toolCall.noTs'))
const currentText = computed(() => tab.value === 'raw' ? rawText.value : (summaryText.value || rawText.value))

async function copy() {
  try { await navigator.clipboard.writeText(currentText.value); notify('success', t('workbench.toolCall.copied')) }
  catch { notify('error', t('workbench.toolCall.copyFailed')) }
}
</script>
<template>
  <Modal :model-value="modelValue" :title="t('workbench.toolCall.title')" width="max-w-2xl" @update:model-value="v => emit('update:modelValue', v)">
    <div v-if="event" class="flex flex-col gap-md">
      <div class="flex items-center gap-sm">
        <span class="inline-block w-2 h-2 rounded-full" :class="event.type === 'denied' ? 'bg-status-warning' : event.type === 'tool_start' ? 'bg-status-running animate-pulse' : 'bg-status-running'"></span>
        <span class="font-mono font-semibold text-body-sm">{{ event.name }}</span>
        <span class="text-body-xs text-on-surface-variant ml-auto font-mono">{{ tsText }}</span>
      </div>
      <div>
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ t('workbench.toolCall.args') }}</p>
        <pre v-if="argsJson" data-testid="tc-args" class="font-mono text-body-xs bg-[#0b1c30] text-[#cfe3ff] border border-outline-variant/30 rounded-lg p-sm max-h-40 overflow-y-auto whitespace-pre-wrap break-all">{{ argsJson }}</pre>
        <p v-else class="text-body-xs text-on-surface-variant/60">{{ t('workbench.toolCall.noArgs') }}</p>
      </div>
      <div>
        <div class="flex items-center gap-sm mb-xs">
          <p class="text-body-xs text-on-surface-variant">{{ t('workbench.toolCall.result') }}</p>
          <div class="flex gap-xs ml-2">
            <button type="button" @click="tab = 'summary'" :class="['px-sm py-0.5 rounded-full text-body-xs border', tab === 'summary' ? 'border-primary/40 text-primary bg-primary/5' : 'border-outline-variant text-on-surface-variant']">{{ t('workbench.toolCall.summaryTab') }}</button>
            <button type="button" @click="tab = 'raw'" :class="['px-sm py-0.5 rounded-full text-body-xs border', tab === 'raw' ? 'border-primary/40 text-primary bg-primary/5' : 'border-outline-variant text-on-surface-variant']">{{ t('workbench.toolCall.rawTab') }}</button>
          </div>
          <button type="button" class="ml-auto flex items-center gap-xs text-body-xs text-primary hover:opacity-80" @click="copy">
            <span class="material-symbols-outlined text-sm">content_copy</span>{{ t('common.copy') }}
          </button>
        </div>
        <p v-if="event.type === 'denied'" class="text-body-xs text-status-warning bg-status-warning/5 border border-status-warning/30 rounded-lg px-sm py-sm">{{ t('workbench.toolCall.denied') }}</p>
        <p v-else-if="event.type === 'tool_start'" class="text-body-xs text-status-running flex items-center gap-xs px-sm"><span class="material-symbols-outlined text-sm animate-spin">progress_activity</span>{{ t('workbench.toolCall.running') }}</p>
        <template v-else>
          <p v-if="truncated" class="text-body-xs text-status-warning mb-xs">{{ t('workbench.toolCall.truncated') }}</p>
          <pre data-testid="tc-result" class="font-mono text-body-xs bg-[#0b1c30] text-[#cfe3ff] border border-outline-variant/30 rounded-lg p-sm max-h-72 overflow-y-auto whitespace-pre-wrap break-all leading-[18px]">{{ tab === 'raw' ? rawText : (summaryText || rawText) }}</pre>
        </template>
      </div>
    </div>
  </Modal>
</template>
