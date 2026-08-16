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
const pct = (n, total) => total > 0 ? Math.max(1, Math.round((n / total) * 100)) : 0
const clusterTotal = c => c.ledgerSize + (c.projects || []).reduce((s, p) => s + p.size, 0)
const diskUsedPct = computed(() => {
  const st = data.value?.storage
  if (!st?.diskTotal) return 0
  return Math.round(((st.diskTotal - st.diskFree) / st.diskTotal) * 100)
})
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

    <!-- 空间使用量(总占用 + 库/仓库占比条 + 每集群·项目明细 + 主机磁盘) -->
    <div v-if="data?.storage" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md flex flex-col gap-sm">
      <div class="flex items-center justify-between">
        <p class="text-body-sm font-semibold text-on-surface flex items-center gap-xs">
          <span class="material-symbols-outlined text-base text-primary">database</span>{{ t('workbench.records.spaceTitle') }}
        </p>
        <span class="text-body-sm font-mono font-semibold text-primary">{{ fmtBytes(data.storage.dataTotalSize) }}</span>
      </div>

      <!-- 占比条:数据库 vs 工作台仓库(相对 data 目录总量) -->
      <div class="flex flex-col gap-xs">
        <div class="flex items-center gap-sm">
          <span class="text-body-xs text-on-surface-variant w-20 shrink-0">{{ t('workbench.records.storageDb') }}</span>
          <div class="flex-1 h-2.5 rounded-full bg-surface-container-high overflow-hidden flex">
            <div class="bg-primary h-full" :style="{ width: pct(data.storage.dbSize, data.storage.dataTotalSize) + '%' }"></div>
          </div>
          <span class="text-body-xs font-mono text-on-surface-variant w-20 text-right shrink-0">{{ fmtBytes(data.storage.dbSize) }}</span>
        </div>
        <div class="flex items-center gap-sm">
          <span class="text-body-xs text-on-surface-variant w-20 shrink-0">{{ t('workbench.records.storageWb') }}</span>
          <div class="flex-1 h-2.5 rounded-full bg-surface-container-high overflow-hidden flex">
            <div class="bg-tertiary h-full" :style="{ width: pct(data.storage.workbenchSize, data.storage.dataTotalSize) + '%' }"></div>
          </div>
          <span class="text-body-xs font-mono text-on-surface-variant w-20 text-right shrink-0">{{ fmtBytes(data.storage.workbenchSize) }} · {{ data.storage.workbenchFiles }} {{ t('workbench.records.files') }}</span>
        </div>
      </div>

      <!-- 每集群(台账 + 各项目 repo)占用,条相对该集群总量 -->
      <div v-if="data.storage.clusters?.length" class="flex flex-col gap-xs">
        <div v-for="c in data.storage.clusters" :key="c.clusterId" class="flex flex-col gap-0.5">
          <div class="flex items-center gap-xs text-body-xs">
            <span class="material-symbols-outlined text-sm text-on-surface-variant">hub</span>
            <span class="font-semibold text-on-surface">{{ c.clusterName }}</span>
            <span class="text-on-surface-variant font-mono">{{ t('workbench.records.ledger') }} {{ fmtBytes(c.ledgerSize) }}</span>
            <span class="text-on-surface-variant/60 font-mono ml-auto">{{ fmtBytes(clusterTotal(c)) }}</span>
          </div>
          <div v-for="p in c.projects" :key="p.projectId" class="flex items-center gap-sm pl-lg">
            <span class="text-body-xs text-on-surface-variant truncate flex-1">{{ p.projectName }}</span>
            <div class="w-32 h-1.5 rounded-full bg-surface-container-high overflow-hidden shrink-0">
              <div class="bg-tertiary/70 h-full" :style="{ width: pct(p.size, clusterTotal(c) || 1) + '%' }"></div>
            </div>
            <span class="text-body-xs font-mono text-on-surface-variant w-20 text-right shrink-0">{{ fmtBytes(p.size) }}</span>
          </div>
        </div>
      </div>

      <!-- 主机磁盘余量(statfs 不支持则隐藏) -->
      <div v-if="data.storage.diskTotal" class="flex items-center gap-sm pt-xs border-t border-outline-variant/40">
        <span class="material-symbols-outlined text-sm text-on-surface-variant">hard_drive</span>
        <span class="text-body-xs text-on-surface-variant">{{ t('workbench.records.disk') }}</span>
        <div class="flex-1 h-2 rounded-full bg-surface-container-high overflow-hidden">
          <div class="h-full" :class="diskUsedPct > 85 ? 'bg-error' : diskUsedPct > 70 ? 'bg-status-warning' : 'bg-status-running'" :style="{ width: diskUsedPct + '%' }"></div>
        </div>
        <span class="text-body-xs font-mono text-on-surface-variant shrink-0">{{ fmtBytes(data.storage.diskTotal - data.storage.diskFree) }} / {{ fmtBytes(data.storage.diskTotal) }} · {{ t('workbench.records.diskFree') }} {{ fmtBytes(data.storage.diskFree) }}</span>
      </div>

      <div class="text-body-xs text-on-surface-variant/70 font-mono flex flex-col gap-0.5">
        <span>{{ data.storage.dbPath }}</span>
        <span>{{ data.storage.workbenchDir }}</span>
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
