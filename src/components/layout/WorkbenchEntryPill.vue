<!-- src/components/layout/WorkbenchEntryPill.vue -->
<script setup>
// 工作台入口胶囊(2026-08-30 信息丰富化):C3 品牌胶囊契约不变(样式/aria/点击),叠加
// 状态角标 + 悬停概览面板。数据 = GET /api/workbench/summary 单一汇总端点,30s 轮询
// (TopNavBar 全站常驻 ⇒ 全站唯一轮询器;标签页隐藏自动暂停,聚焦即刷新)。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useQuery, keepPreviousData } from '@tanstack/vue-query'
import { workbenchApi, getPlatformToken } from '@/api/client'
import { Z } from '@/styles/zScale'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const isWorkbenchActive = computed(() => route.path.startsWith('/workbench'))

// ---- 数据(导航静默:失败不 toast,keepPreviousData 保旧值)----
const q = useQuery({
  queryKey: ['workbench-summary'],
  queryFn: () => workbenchApi.summary(),
  // 随平台登录态启停:不能用 K8s session(无集群用户 requiresCluster:false 恒 false,整块无数据)
  enabled: computed(() => !!getPlatformToken()),
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  staleTime: 15_000,
  retry: 1, retryDelay: 0,   // 即时重试一次:默认 1000ms 退避会让失败态在测试假钟 150ms 内不可达
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
// 鼠标移进面板取消宽限关闭。必须经函数:clearTimeout 不在 Vue 模板全局白名单,
// 裸写会编译成 _ctx.clearTimeout(...) 运行时 TypeError(→ 面板自关,2026-08-30 终审 C1)。
function holdPanel() { clearTimeout(closeTimer) }
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
      <!-- 迷你统计条(≥lg;2026-08-30 用户反馈:内容再丰富些):三段常驻(0 也显示),
           数字按状态着色(项目中性/运行绿/待审批红);SSH 不上条(悬停面板看)。
           窄屏(<lg)整条隐藏,由下方单枚状态徽章接管 -->
      <span data-test="pill-stats" aria-hidden="true"
        class="hidden lg:inline-flex items-center gap-1 ml-1 text-body-xs font-normal">
        <span class="w-px h-3.5 bg-current opacity-25"></span>
        <span class="inline-flex items-center text-on-surface-variant">
          <span class="font-bold text-on-surface">{{ totals.projects ?? 0 }}</span>{{ t('workbench.pill.kProjects') }}
        </span>
        <span class="opacity-40">·</span>
        <span class="inline-flex items-center text-on-surface-variant">
          <span class="font-bold" :class="runningCount > 0 ? 'text-status-running' : ''">{{ runningCount }}</span>{{ t('workbench.pill.kRunning') }}
        </span>
        <span class="opacity-40">·</span>
        <span class="inline-flex items-center text-on-surface-variant">
          <span class="font-bold" :class="pendingCount > 0 ? 'text-error' : ''">{{ pendingCount }}</span>{{ t('workbench.pill.kPending') }}
        </span>
      </span>
      <!-- 状态徽章(<lg 接管统计条;≥lg 隐藏防信息重复):
           待审批红数字(行动性最强)> 运行中绿数字 > 项目数中性,常驻不空 -->
      <span v-if="pendingCount > 0" data-test="pill-pending"
        class="ml-0.5 lg:hidden min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-error text-on-error text-body-xs font-bold leading-none"
        :title="$t('workbench.pill.pending', { n: pendingCount })">{{ pendingCount }}</span>
      <span v-else-if="runningCount > 0" data-test="pill-running"
        class="ml-0.5 lg:hidden min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-status-running/10 text-status-running text-body-xs font-bold leading-none"
        :title="$t('workbench.pill.running', { n: runningCount })">{{ runningCount }}</span>
      <span v-else data-test="pill-projects"
        class="ml-0.5 lg:hidden min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant text-body-xs font-bold leading-none"
        :title="$t('workbench.pill.projects', { n: totals.projects ?? 0 })">{{ totals.projects ?? 0 }}</span>
    </button>
    <Teleport to="body">
      <div v-if="panelOpen" data-test="wb-panel"
        @mouseenter="holdPanel" @mouseleave="scheduleClose"
        class="fixed bg-surface-container-lowest border border-outline-variant rounded-xl shadow-dropdown p-md"
        :style="panelStyle">
        <!-- 汇总 chips -->
        <div class="flex items-center gap-xs flex-wrap mb-sm text-body-xs">
          <span class="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant">{{ t('workbench.pill.projects', { n: totals.projects ?? 0 }) }}</span>
          <span class="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant">{{ t('workbench.pill.running', { n: runningCount }) }}</span>
          <span class="px-1.5 py-0.5 rounded bg-error/10 text-error">{{ t('workbench.pill.pending', { n: pendingCount }) }}</span>
          <span class="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant">{{ t('workbench.pill.ssh', { n: sshCount }) }}</span>
        </div>
        <!-- 项目行(≤8,服务端已待办优先排序) -->
        <div v-if="!projects.length" class="py-md text-center">
          <p class="text-body-sm text-on-surface-variant">{{ t('workbench.pill.noProjects') }}</p>
          <button @click="go('/workbench?create=1')" class="mt-sm px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">{{ t('workbench.pill.newProject') }}</button>
        </div>
        <div v-else class="max-h-72 overflow-y-auto">
          <button v-for="p in projects" :key="p.id" data-test="panel-project" @click="go('/workbench/' + p.id)"
            class="w-full flex items-center justify-between gap-sm px-xs py-sm rounded-lg hover:bg-surface-container text-left">
            <span class="min-w-0">
              <span class="block text-body-sm font-semibold text-on-surface truncate">{{ p.name }}</span>
              <span class="block text-body-xs text-on-surface-variant">
                <template v-if="p.clusterId">{{ p.clusterName }}</template>
                <template v-else><span class="inline-block px-1 py-px rounded bg-warning/10 text-warning">{{ t('workbench.unboundBadge') }}</span></template>
              </span>
            </span>
            <span class="flex items-center gap-xs shrink-0 text-body-xs text-on-surface-variant">
              <span v-if="p.pendingApprovals > 0" class="px-1.5 py-0.5 rounded bg-error/10 text-error">{{ t('workbench.pill.pendingChip', { n: p.pendingApprovals }) }}</span>
              <span v-if="p.runningConvs > 0" class="w-1.5 h-1.5 rounded-full bg-status-running"></span>
              <span v-if="p.lastActiveAt">{{ relTime(p.lastActiveAt) }}</span>
            </span>
          </button>
        </div>
        <!-- 快捷动作区 -->
        <div class="flex items-center gap-md mt-sm pt-sm border-t border-outline-variant">
          <button @click="go('/workbench?create=1')" class="flex items-center gap-xs text-body-xs text-on-surface-variant hover:text-primary"><span class="material-symbols-outlined text-sm">add</span>{{ t('workbench.pill.newProject') }}</button>
          <button @click="go('/workbench/ledger')" class="flex items-center gap-xs text-body-xs text-on-surface-variant hover:text-primary"><span class="material-symbols-outlined text-sm">menu_book</span>{{ t('workbench.pill.openLedger') }}</button>
          <button @click="go('/workbench?tab=records')" class="flex items-center gap-xs text-body-xs text-on-surface-variant hover:text-primary"><span class="material-symbols-outlined text-sm">history</span>{{ t('workbench.pill.openRecords') }}</button>
        </div>
        <!-- 降级细字:失败有旧数据 → stale;首次失败 → loadFailed -->
        <p v-if="q.isError.value && q.data.value" class="mt-xs text-body-xs text-on-surface-variant/70">{{ t('workbench.pill.stale', { t: relTime(q.dataUpdatedAt.value) }) }}</p>
        <p v-else-if="q.isError.value && !q.data.value" class="mt-xs text-body-xs text-on-surface-variant/70">{{ t('workbench.pill.loadFailed') }}</p>
      </div>
    </Teleport>
  </div>
</template>
