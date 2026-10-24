<!-- src/components/layout/WorkbenchNavItem.vue -->
<script setup>
// 工作台侧栏入口行(2026-10-23 自顶栏 WorkbenchEntryPill 迁入,spec §4.3):行形态入侧栏滚动导航,
// 悬停面板原样保留(≥lg、非触屏)。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useQuery, keepPreviousData } from '@tanstack/vue-query'
import { workbenchApi, getPlatformToken } from '@/api/client'
import { useIsPhone } from '@/composables/useBreakpoint'
import { useDropdownPanel } from '@/composables/useDropdownPanel'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const isWorkbenchActive = computed(() => route.path.startsWith('/workbench'))
const { isPhone } = useIsPhone()

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

// ---- 悬停面板开关(150ms 开/200ms 宽限关;Escape/外点/链内点击即关)----
const rowRef = ref(null)
const panelOpen = ref(false)
// 面板定位:Teleport body + fixed 锚定触发行(useDropdownPanel 共享配方——下方放不下自动上翻、
// 右缘钳制回视口、scroll/resize 跟随重算、首帧 visibility 防闪,替代原手写 placePanel,行为等价)
const { panelRef, panelStyle } = useDropdownPanel(rowRef, panelOpen)
let openTimer = null
let closeTimer = null
// 触屏 tap 合成 mouseenter 会让面板在跳转 /workbench 后残留新页(touch 无 mouseleave 关不掉)——
// 手机档整链禁开(Wave 4 终审 A)
function openPanel() {
  if (isPhone.value) return
  clearTimeout(closeTimer)
  clearTimeout(openTimer)
  openTimer = setTimeout(() => { panelOpen.value = true }, 150)
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
  if (panelOpen.value && !e.target.closest?.('[data-test="wb-nav-item"], [data-test="wb-panel"]')) closeNow()
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
  <a ref="rowRef" data-test="wb-nav-item" role="button" tabindex="0"
    @click="router.push('/workbench')" @keydown.enter.prevent="router.push('/workbench')"
    @mouseenter="openPanel" @mouseleave="scheduleClose"
    :aria-label="$t('nav.workbench')" :title="isPhone ? $t('nav.workbench') : summaryText"
    class="nav-item flex items-center gap-md px-md py-sm rounded-lg cursor-pointer transition-all duration-200"
    :class="isWorkbenchActive
      ? 'bg-primary-container text-on-primary-container font-semibold'
      : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
    <span class="relative inline-flex shrink-0">
      <span data-test="wb-nav-tile"
        class="relative inline-flex h-[26px] w-[26px] items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary to-primary-container shadow-[0_1px_3px_rgb(0_0_0/0.25),inset_0_1px_0_rgb(255_255_255/0.35)] transition-transform duration-300 motion-reduce:transition-none"
        :class="isWorkbenchActive ? 'scale-105' : ''">
        <span class="material-symbols-outlined text-base text-on-primary">workspaces</span>
        <span v-if="isWorkbenchActive" data-test="wb-nav-sheen" aria-hidden="true"
          class="absolute inset-0 rounded-lg bg-no-repeat bg-gradient-to-r from-transparent via-white/45 to-transparent bg-[length:200%_100%] animate-sheen motion-reduce:hidden"></span>
      </span>
    </span>
    <span class="text-body-sm nav-item__label flex-1 min-w-0 truncate">{{ $t('nav.workbench') }}</span>
    <span v-if="pendingCount > 0" data-test="wb-nav-pending"
      class="min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-error text-on-error text-body-xs font-bold leading-none shrink-0">{{ pendingCount }}</span>
  </a>
  <Teleport to="body">
    <div v-if="panelOpen" ref="panelRef" data-test="wb-panel"
      @mouseenter="holdPanel" @mouseleave="scheduleClose"
      class="fixed w-[340px] max-w-[calc(100vw-16px)] bg-surface-container-lowest border border-outline-variant rounded-xl shadow-dropdown p-md"
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
              <template v-else><span class="inline-block px-1 py-px rounded bg-tertiary/10 text-tertiary">{{ t('workbench.unboundBadge') }}</span></template>
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
</template>
