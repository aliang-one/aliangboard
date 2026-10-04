<script setup>
// CronJob 详情页·运行记录 tab(2026-10-04):该 CronJob 触发出的 Jobs 列表。
// 行数据由宿主按 ownerUid 过滤好传入(NsWorkloadDetail cronRuns computed);
// 本组件只负责排序/派生列/渲染。行点击 → open(row) 跳 Job 详情。
// DataTable 双分支(桌面表/手机卡)同一份列 slot,满足 mobile-guard M1。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { ageOf } from '@/composables/useResourceMappers'

const props = defineProps({
  rows: { type: Array, required: true },
  loading: { type: Boolean, default: false },
})
defineEmits(['open'])

const { t } = useI18n()

// 时长桶与 ageOf 同族(s/m/h/d);运行中 = start→now,已完结 = start→completion,无 start = —
const durationOf = (start, end) => {
  if (!start) return '—'
  const seconds = Math.max(0, Math.floor(((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

const headers = computed(() => [
  { key: 'name', label: t('workload.runs.thName') },
  { key: 'status', label: t('workload.runs.thStatus') },
  { key: 'duration', label: t('workload.runs.thDuration') },
  { key: 'age', label: t('workload.runs.thAge') },
  { key: 'created', label: t('workload.runs.thCreated') },
])

const view = computed(() => [...props.rows]
  .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
  .map(r => ({
    ...r,
    duration: durationOf(r.startTime, r.completionTime),
    age: ageOf(r.createdAt),
    created: r.createdAt ? new Date(r.createdAt).toLocaleString(undefined, { hour12: false }) : '—',
  })))
</script>

<template>
  <div class="flex flex-col gap-sm">
    <div class="flex items-center gap-sm">
      <span class="material-symbols-outlined text-primary text-base">history</span>
      <span class="text-body-sm font-semibold text-on-surface">{{ $t('workload.runs.title') }}</span>
      <span class="text-xs text-on-surface-variant">{{ view.length }}</span>
    </div>

    <!-- 空态:尚未产生所属 Job -->
    <div v-if="!view.length && !loading" class="rounded-xl bg-surface-container-lowest border border-dashed border-outline-variant/50 py-xl text-center">
      <span class="material-symbols-outlined text-3xl text-surface-container-high">history</span>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('workload.runs.empty') }}</p>
      <p class="text-xs text-on-surface-variant/70 mt-xs">{{ $t('workload.runs.emptyHint') }}</p>
    </div>
    <div v-else-if="!view.length && loading" class="rounded-xl bg-surface-container-lowest border border-outline-variant/50 py-xl text-center text-body-sm text-on-surface-variant animate-pulse">
      {{ $t('common.loading') }}
    </div>
    <DataTable v-else :headers="headers" :rows="view" row-key="name" @row-click="$emit('open', $event)">
      <template #name="{ row }">
        <span data-testid="run-name" class="font-mono text-body-sm text-primary hover:underline break-all">{{ row.name }}</span>
      </template>
      <template #status="{ row }">
        <StatusChip :status="row.status" size="sm" :dot="false" />
      </template>
      <template #duration="{ row }">
        <span data-testid="run-duration" class="font-mono text-xs text-on-surface">{{ row.duration }}</span>
      </template>
      <template #age="{ row }">
        <span class="text-xs text-on-surface-variant">{{ row.age }}</span>
      </template>
      <template #created="{ row }">
        <span class="text-xs text-on-surface-variant font-mono">{{ row.created }}</span>
      </template>
    </DataTable>
  </div>
</template>
