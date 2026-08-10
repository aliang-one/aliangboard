<script setup>
// 工具调用紧凑 chips：每个 tool/denied 事件一颗；点开就地展开 result（Cursor 风格工具行）。
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({ trace: { type: Array, default: () => [] } })
const { t } = useI18n()

const expanded = ref(null)
function fmtResult(v) { if (v == null) return ''; return typeof v === 'string' ? v : JSON.stringify(v, null, 2) }
function toggle(i) { expanded.value = expanded.value === i ? null : i }
</script>

<template>
  <div v-if="trace.length" class="flex flex-wrap gap-xs items-center">
    <button v-for="(ev, i) in trace" :key="i" type="button" @click="toggle(i)"
      class="flex items-center gap-xs text-body-xs font-mono px-sm py-xs rounded-md border transition-colors"
      :class="ev.type === 'denied'
        ? 'border-status-warning/30 text-status-warning bg-status-warning/5'
        : 'border-outline-variant text-on-surface hover:bg-surface-container-low'">
      <span class="material-symbols-outlined text-sm">{{ ev.type === 'denied' ? 'block' : 'play_arrow' }}</span>
      <span class="font-semibold">{{ ev.name }}</span>
      <span v-if="ev.type === 'denied'">{{ t('workbench.chat.toolDenied') }}</span>
      <span v-else class="text-status-success">✓</span>
    </button>
    <pre v-if="expanded !== null && fmtResult(trace[expanded].result)"
      class="w-full mt-xs font-mono text-body-xs text-on-surface-variant bg-surface-container-lowest border border-outline-variant rounded-lg px-sm py-xs max-h-32 overflow-y-auto whitespace-pre-wrap break-all">{{ fmtResult(trace[expanded].result) }}</pre>
  </div>
</template>
