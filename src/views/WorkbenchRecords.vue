<script setup>
// 工作台「记录」页:对话/消息/AI 操作数据的统一入口——统计卡 + 存储位置说明 +
// 跨项目对话记录列表(点击跳所属项目) + AI 工具调用记录(审计链 workbench 过滤)。
// 数据源 workbenchApi.records()(后端聚合)+ adminApi.auditTrail.list(source=workbench)。
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { workbenchApi, adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'

const { t } = useI18n()
const router = useRouter()
const loading = ref(true)
const data = ref(null)
const audits = ref([])

const fmtBytes = n => {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
const fmt = ts => ts ? new Date(Number(ts)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'
const relTime = ts => {
  if (!ts) return ''
  const s = Math.floor((Date.now() - Number(ts)) / 1000)
  if (s < 3600) return t('workbench.records.timeMinAgo', { n: Math.max(1, Math.floor(s / 60)) })
  if (s < 86400) return t('workbench.records.timeHourAgo', { n: Math.floor(s / 3600) })
  return t('workbench.records.timeDayAgo', { n: Math.floor(s / 86400) })
}
const statusStyle = {
  done: 'bg-surface-container-high text-on-surface-variant',
  running: 'bg-status-running/10 text-status-running',
  paused: 'bg-status-warning/10 text-status-warning',
  failed: 'bg-error/10 text-error',
  cancelled: 'bg-error/10 text-error',
}
const resultStyle = { ok: 'text-status-running', denied: 'text-status-warning', error: 'text-error' }
const preview = c => (c.title || c.userMessage || '').slice(0, 60) || t('workbench.records.emptyTitle')

async function load() {
  loading.value = true
  try {
    data.value = await workbenchApi.records()
    try {
      const r = await adminApi.auditTrail.list({ source: 'workbench', size: 30 })
      audits.value = r.items || []
    } catch { /* 审计明细失败不阻塞整页 */ }
  } catch (e) { notify('error', e.message || t('workbench.records.loadFailed')) }
  finally { loading.value = false }
}
function openProject(conv) { router.push(`/workbench/${conv.projectId}`) }
onMounted(load)
</script>

<template>
  <div class="animate-fade-in flex flex-col gap-md">
    <div>
      <h2 class="text-headline-md font-bold text-on-surface">{{ t('workbench.records.title') }}</h2>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('workbench.records.subtitle') }}</p>
    </div>

    <!-- 统计卡 -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-sm">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
        <p class="text-label-caps text-on-surface-variant">{{ t('workbench.records.statConversations') }}</p>
        <p class="text-headline-md font-bold text-primary mt-xs">{{ data?.counts?.conversations ?? '—' }}</p>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
        <p class="text-label-caps text-on-surface-variant">{{ t('workbench.records.statMessages') }}</p>
        <p class="text-headline-md font-bold text-primary mt-xs">{{ data?.counts?.messages ?? '—' }}</p>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
        <p class="text-label-caps text-on-surface-variant">{{ t('workbench.records.statAiCalls') }}</p>
        <p class="text-headline-md font-bold text-tertiary mt-xs">{{ data?.counts?.aiToolCalls ?? '—' }}</p>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
        <p class="text-label-caps text-on-surface-variant">{{ t('workbench.records.statProjects') }}</p>
        <p class="text-headline-md font-bold text-on-surface mt-xs">{{ data?.counts?.projects ?? '—' }}</p>
      </div>
    </div>

    <!-- 存储位置说明 -->
    <div v-if="data?.storage" class="bg-surface-container-low border border-outline-variant rounded-xl p-md flex flex-col gap-xs">
      <p class="text-body-sm font-semibold text-on-surface flex items-center gap-xs">
        <span class="material-symbols-outlined text-base text-primary">database</span>{{ t('workbench.records.storageTitle') }}
      </p>
      <div class="text-body-xs text-on-surface-variant font-mono flex flex-col gap-0.5">
        <span>{{ t('workbench.records.storageDb') }}: {{ data.storage.dbPath }} ({{ fmtBytes(data.storage.dbSize) }})</span>
        <span>{{ t('workbench.records.storageWb') }}: {{ data.storage.workbenchDir }} ({{ fmtBytes(data.storage.workbenchSize) }} / {{ data.storage.fileCount }} {{ t('workbench.records.files') }})</span>
      </div>
      <p class="text-body-xs text-on-surface-variant/80">{{ t('workbench.records.storageHint') }}</p>
    </div>

    <!-- 对话记录 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
      <div class="px-md py-sm border-b border-outline-variant flex items-center gap-xs">
        <span class="material-symbols-outlined text-base text-primary">forum</span>
        <span class="text-body-sm font-semibold">{{ t('workbench.records.convTitle') }}</span>
      </div>
      <div class="max-h-96 overflow-y-auto divide-y divide-outline-variant/40">
        <button v-for="c in (data?.conversations || [])" :key="c.id" @click="openProject(c)"
          class="w-full text-left px-md py-sm hover:bg-surface-container-low transition-colors flex items-center gap-sm">
          <span class="px-1.5 py-0.5 rounded text-body-xs font-mono shrink-0" :class="statusStyle[c.status] || statusStyle.done">{{ c.status }}</span>
          <span class="text-body-sm text-on-surface truncate flex-1 min-w-0">{{ preview(c) }}</span>
          <span class="text-body-xs text-on-surface-variant shrink-0">{{ c.projectName }}</span>
          <span class="text-body-xs text-on-surface-variant/70 shrink-0 font-mono">{{ c.messageCount }}💬 {{ c.steps }}↻</span>
          <span class="text-body-xs text-on-surface-variant/60 shrink-0 w-14 text-right">{{ relTime(c.updatedAt) }}</span>
        </button>
        <p v-if="data && !data.conversations.length" class="text-body-sm text-on-surface-variant px-md py-md text-center">{{ t('workbench.records.noConversations') }}</p>
      </div>
    </div>

    <!-- AI 工具调用记录(审计链) -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
      <div class="px-md py-sm border-b border-outline-variant flex items-center gap-xs">
        <span class="material-symbols-outlined text-base text-primary">smart_toy</span>
        <span class="text-body-sm font-semibold">{{ t('workbench.records.auditTitle') }}</span>
        <span class="text-body-xs text-on-surface-variant ml-auto">{{ t('workbench.records.auditHint') }}</span>
      </div>
      <div class="max-h-80 overflow-y-auto divide-y divide-outline-variant/40">
        <div v-for="a in audits" :key="a.seq" class="px-md py-xs flex items-center gap-sm text-body-xs font-mono">
          <span class="text-on-surface-variant/60 shrink-0 w-24">{{ fmt(a.ts) }}</span>
          <span class="text-on-surface shrink-0">{{ a.tool }}</span>
          <span class="text-on-surface-variant truncate flex-1 min-w-0">{{ a.resource || a.requestSummary || '—' }}</span>
          <span class="shrink-0 font-semibold" :class="resultStyle[a.result]">{{ a.result }}</span>
        </div>
        <p v-if="!audits.length" class="text-body-sm text-on-surface-variant px-md py-md text-center">{{ t('workbench.records.noAudits') }}</p>
      </div>
    </div>
  </div>
</template>
