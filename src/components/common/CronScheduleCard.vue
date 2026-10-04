<script setup>
// CronJob 详情页·调度卡片(2026-10-04):表达式 + 中文人性化(cron.js 零依赖自研)+
// 接下来 3 次预计运行 + 上次调度/上次成功 + 时区/并发策略。K 轨平铺 M3 卡,无氛围。
// 暂停时隐藏运行预测(预测无意义),节奏描述保留。schedule 不可解析 → 原文 + 提示,不炸。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { describeStructure, formatCronSchedule, nextRuns } from '@/utils/cron'
import { ageOf } from '@/composables/useResourceMappers'

const props = defineProps({
  schedule: { type: String, required: true },
  suspended: { type: Boolean, default: false },
  timeZone: { type: String, default: '' },
  concurrencyPolicy: { type: String, default: 'Allow' },
  lastScheduleTime: { type: String, default: '' },
  lastSuccessfulTime: { type: String, default: '' },
  // 测试注日期;缺省取当前时刻
  now: { type: Date, default: null },
})

const { t } = useI18n()

const descriptor = computed(() => describeStructure(props.schedule))
const human = computed(() => formatCronSchedule(descriptor.value, t))
const upcoming = computed(() => props.suspended
  ? []
  : nextRuns(props.schedule, { from: props.now || new Date(), count: 3, timeZone: props.timeZone }))

// 预计时刻按 spec.timeZone 的墙钟展示(无时区按浏览器本地)——与集群调度器同视角
const timeFmt = computed(() => {
  const opts = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
  try { return new Intl.DateTimeFormat(undefined, props.timeZone ? { ...opts, timeZone: props.timeZone } : opts) }
  catch { return new Intl.DateTimeFormat(undefined, opts) }
})

// 键全字面量(i18n-check 静扫);未知策略回退 Allow 文案
const CONCURRENCY_KEYS = { Allow: 'workload.cron.concurrencyAllow', Forbid: 'workload.cron.concurrencyForbid', Replace: 'workload.cron.concurrencyReplace' }
const CONCURRENCY_CLASSES = {
  Allow: 'bg-surface-container text-on-surface-variant',
  Forbid: 'bg-tertiary-container/40 text-on-surface-variant',
  Replace: 'bg-primary/10 text-primary',
}
const concKey = computed(() => CONCURRENCY_KEYS[props.concurrencyPolicy] || CONCURRENCY_KEYS.Allow)
const concClass = computed(() => CONCURRENCY_CLASSES[props.concurrencyPolicy] || CONCURRENCY_CLASSES.Allow)
</script>

<template>
  <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md" data-testid="cron-schedule-card">
    <div class="flex items-center gap-sm mb-md">
      <span class="material-symbols-outlined text-primary text-base">schedule</span>
      <span class="text-body-sm font-semibold text-on-surface">{{ $t('workload.cron.title') }}</span>
      <span v-if="suspended" class="ml-auto px-2 py-0.5 bg-tertiary-container/40 text-on-surface-variant text-xs rounded-md font-medium">{{ $t('workload.suspendedChip') }}</span>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-md">
      <!-- 表达式 + 人性化 -->
      <div class="min-w-0">
        <p class="text-xs text-on-surface-variant">{{ $t('workload.cron.expression') }}</p>
        <p class="font-mono text-code-sm text-on-surface mt-xs break-all">{{ schedule }}</p>
        <p v-if="human" class="text-body-sm text-on-surface mt-xs">「{{ human }}」</p>
        <p v-else-if="descriptor" class="text-body-sm text-on-surface-variant mt-xs">{{ $t('workload.cron.complexHint') }}</p>
        <p v-else class="text-body-sm text-on-surface-variant mt-xs">{{ $t('workload.cron.unparsable') }}</p>
      </div>
      <!-- 接下来 N 次(暂停时不预测) -->
      <div v-if="!suspended" class="min-w-0">
        <p class="text-xs text-on-surface-variant">{{ $t('workload.cron.nextRuns', { n: 3 }) }}</p>
        <template v-if="upcoming.length">
          <p v-for="run in upcoming" :key="run.getTime()" data-testid="cron-next-run" class="font-mono text-code-sm text-on-surface mt-xs">{{ timeFmt.format(run) }}</p>
        </template>
        <p v-else class="text-body-sm text-on-surface-variant mt-xs">{{ $t('workload.cron.noUpcoming') }}</p>
      </div>
      <!-- 上次调度/成功 + 时区/并发 -->
      <div class="flex flex-col gap-xs min-w-0">
        <div class="flex items-baseline gap-sm">
          <span class="text-xs text-on-surface-variant shrink-0">{{ $t('workload.cron.lastSchedule') }}</span>
          <span class="text-body-sm text-on-surface truncate" :title="lastScheduleTime">{{ lastScheduleTime ? ageOf(lastScheduleTime) : $t('workload.cron.never') }}</span>
        </div>
        <div class="flex items-baseline gap-sm">
          <span class="text-xs text-on-surface-variant shrink-0">{{ $t('workload.cron.lastSuccess') }}</span>
          <span class="text-body-sm text-on-surface truncate" :title="lastSuccessfulTime">{{ lastSuccessfulTime ? ageOf(lastSuccessfulTime) : $t('workload.cron.never') }}</span>
        </div>
        <div class="flex items-center gap-xs flex-wrap mt-xs">
          <span v-if="timeZone" class="px-2 py-0.5 bg-surface-container rounded text-xs font-mono text-on-surface-variant" :title="$t('workload.cron.timeZone')">{{ timeZone }}</span>
          <span class="px-2 py-0.5 rounded text-xs" :class="concClass" :title="`${$t('workload.cron.concurrency')}: ${concurrencyPolicy}`">{{ $t(concKey) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
