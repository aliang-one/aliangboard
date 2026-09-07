<script setup>
// 我的活动(2026-09-04 Wave1 §3.2):audit_log 本人只读视图。服务端钳 owner+90 天窗口,前端只做过滤/分页。
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/api/client'
import Pagination from '@/components/common/Pagination.vue'

const { t } = useI18n()
const loading = ref(false)
const items = ref([])
const total = ref(0)
const windowDays = ref(90)
const page = ref(1)
const pageSize = 50
const resultFilter = ref('')
// 残余收尾 fix 3:tool 文本过滤器(server /api/my/activity 已收 tool 参数,精确匹配;回车提交)
const toolFilter = ref('')

async function load() {
  loading.value = true
  try {
    const params = {}
    if (page.value > 1) { params.page = page.value; params.size = pageSize }
    if (resultFilter.value) params.result = resultFilter.value
    const tool = toolFilter.value.trim()
    if (tool) params.tool = tool
    const res = await authApi.myActivity(params)
    items.value = res.items || []
    total.value = res.total || 0
    windowDays.value = res.windowDays || 90
  } catch { /* 失败保留空态(与安全卡会话列表同策略) */ } finally { loading.value = false }
}
function onFilter() { page.value = 1; load() }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '—' }
onMounted(load)
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
    <div class="flex items-center justify-between mb-md flex-wrap gap-sm">
      <h3 class="text-headline-sm font-bold">{{ $t('userCenter.activityTitle') }}</h3>
      <div class="flex items-center gap-sm flex-wrap">
        <input v-model="toolFilter" data-testid="activity-tool-filter" type="text"
          :placeholder="$t('userCenter.toolFilterPlaceholder')"
          class="w-52 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-body-sm font-mono"
          @keyup.enter="onFilter" />
        <select v-model="resultFilter" data-testid="activity-result-filter" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-body-sm" @change="onFilter">
          <option value="">{{ $t('userCenter.filterAll') }}</option>
          <option value="ok">{{ $t('userCenter.resultOk') }}</option>
          <option value="denied">{{ $t('userCenter.resultDenied') }}</option>
          <option value="error">{{ $t('userCenter.resultError') }}</option>
        </select>
      </div>
    </div>
    <p class="text-body-xs text-on-surface-variant mb-md" data-testid="activity-window">{{ $t('userCenter.activityWindow', { n: windowDays }) }}</p>

    <div v-if="loading" class="py-md text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block">progress_activity</span></div>
    <div v-else-if="!items.length" class="py-lg text-center text-on-surface-variant text-body-sm" data-testid="activity-empty">{{ $t('userCenter.activityEmpty') }}</div>
    <div v-else class="flex flex-col gap-xs">
      <div v-for="it in items" :key="it.seq" data-testid="activity-row"
        class="flex items-start gap-md px-md py-sm rounded-lg border border-outline-variant/50">
        <span class="material-symbols-outlined text-on-surface-variant text-base shrink-0 mt-xs" :class="it.result === 'ok' ? 'text-primary' : 'text-error'">
          {{ it.result === 'ok' ? 'check_circle' : 'cancel' }}
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-body-sm font-medium truncate font-mono">{{ it.tool }}<span v-if="it.verb" class="ml-sm text-on-surface-variant font-sans">· {{ it.verb }}</span></p>
          <p class="text-body-xs text-on-surface-variant truncate">
            {{ fmtTime(it.ts) }}<span v-if="it.clusterId"> · {{ it.clusterId }}<span v-if="it.namespace">/{{ it.namespace }}</span></span>
            <span v-if="it.requestSummary"> · {{ it.requestSummary.slice(0, 80) }}</span>
          </p>
        </div>
      </div>
    </div>
    <Pagination v-if="total > pageSize" class="mt-sm" :total="total" :page-size="pageSize" :current-page="page"
      @page-change="(p) => { page = p; load() }" />
  </div>
</template>
