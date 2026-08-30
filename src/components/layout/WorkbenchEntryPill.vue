<!-- src/components/layout/WorkbenchEntryPill.vue -->
<script setup>
// 工作台入口胶囊(2026-08-30 信息丰富化):C3 品牌胶囊契约不变(样式/aria/点击),叠加
// 状态角标 + 悬停概览面板。数据 = GET /api/workbench/summary 单一汇总端点,30s 轮询
// (TopNavBar 全站常驻 ⇒ 全站唯一轮询器;标签页隐藏自动暂停,聚焦即刷新)。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useQuery, keepPreviousData } from '@tanstack/vue-query'
import { workbenchApi, getSession } from '@/api/client'
import { Z } from '@/styles/zScale'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const isWorkbenchActive = computed(() => route.path.startsWith('/workbench'))

// ---- 数据(导航静默:失败不 toast,keepPreviousData 保旧值)----
const q = useQuery({
  queryKey: ['workbench-summary'],
  queryFn: () => workbenchApi.summary(),
  enabled: computed(() => !!getSession()),
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  staleTime: 15_000,
  retry: 1,
  placeholderData: keepPreviousData,
})
const totals = computed(() => q.data.value?.totals || {})
const projects = computed(() => q.data.value?.projects || [])
const pendingCount = computed(() => totals.value.pendingApprovals ?? 0)
const runningCount = computed(() => totals.value.runningConvs ?? 0)
const sshCount = computed(() => totals.value.sshSessions ?? 0)

const summaryText = computed(() => [
  t('workbench.pill.projects', { n: totals.value.projects ?? 0 }),
  t('workbench.pill.running', { n: runningCount.value }),
  t('workbench.pill.pending', { n: pendingCount.value }),
  t('workbench.pill.ssh', { n: sshCount.value }),
].join(' · '))

// ---- 悬停面板开关(150ms 开/200ms 宽限关;Escape/外点/链内点击即关)——Task 4 扩展 ----
const btnRef = ref(null)
const panelOpen = ref(false)
const panelStyle = ref({})
let openTimer = null
let closeTimer = null
const PANEL_W = 340
function placePanel() {
  const r = btnRef.value?.getBoundingClientRect()
  if (r) panelStyle.value = {
    top: `${r.bottom + 8}px`,
    left: `${Math.max(16, Math.min(r.right - PANEL_W, window.innerWidth - PANEL_W - 16))}px`,
    width: `${PANEL_W}px`,
    zIndex: Z.popover,
  }
}
function openPanel() {
  clearTimeout(closeTimer)
  clearTimeout(openTimer)
  openTimer = setTimeout(() => { placePanel(); panelOpen.value = true }, 150)
}
function scheduleClose() {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => { panelOpen.value = false }, 200)
}
function closeNow() { clearTimeout(openTimer); clearTimeout(closeTimer); panelOpen.value = false }
function go(path) { closeNow(); router.push(path) }
function onDocClick(e) {
  if (panelOpen.value && !e.target.closest?.('[data-test="wb-pill"], [data-test="wb-panel"]')) closeNow()
}
function onKey(e) { if (e.key === 'Escape') closeNow() }
onMounted(() => { document.addEventListener('click', onDocClick); document.addEventListener('keydown', onKey) })
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
  closeNow()
})

// ---- 相对时间(刚刚/{n} 分钟前/{n} 小时前/{n} 天前;超 7 天回退 M-D)----
function relTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return t('workbench.pill.relNow')
  if (diff < 3_600_000) return t('workbench.pill.relMin', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('workbench.pill.relHour', { n: Math.floor(diff / 3_600_000) })
  if (diff < 7 * 86_400_000) return t('workbench.pill.relDay', { n: Math.floor(diff / 86_400_000) })
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}
</script>

<template>
  <div ref="btnRef" data-test="wb-pill" class="relative shrink-0" @mouseenter="openPanel" @mouseleave="scheduleClose">
    <button
      @click="router.push('/workbench')"
      :aria-label="$t('nav.workbench')"
      :title="summaryText"
      class="flex items-center gap-sm rounded-full px-md py-1.5 border transition-colors text-body-sm font-semibold shrink-0"
      :class="isWorkbenchActive
        ? 'border-primary bg-primary-container text-on-primary-container'
        : 'border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10'"
    >
      <span class="material-symbols-outlined text-lg">workspaces</span>
      {{ $t('nav.workbench') }}
      <!-- 角标同一时刻一枚:待审批红数字(行动性最强)> 运行中静态绿点(无动画)-->
      <span v-if="pendingCount > 0" data-test="pill-pending"
        class="ml-0.5 min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-error text-on-error text-body-xs font-bold leading-none">{{ pendingCount }}</span>
      <span v-else-if="runningCount > 0" data-test="pill-running" class="w-2 h-2 rounded-full bg-status-running"></span>
    </button>
    <!-- 悬停面板:Task 4 接入(Teleport body + fixed + Z.popover) -->
  </div>
</template>
