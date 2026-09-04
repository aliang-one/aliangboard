<!-- src/components/layout/WorkbenchEntryPill.vue -->
<script setup>
// 工作台入口胶囊(2026-08-30 信息丰富化):C3 契约不变(aria/文字/点击),叠加
// 状态角标 + 悬停概览面板。数据 = GET /api/workbench/summary 单一汇总端点,30s 轮询
// (TopNavBar 全站常驻 ⇒ 全站唯一轮询器;标签页隐藏自动暂停,聚焦即刷新)。
// 2026-09-04 身份舱段式化:自身描边/底色上交 TopNavBar 的 identity-capsule 容器。
// 2026-09-04 v4 精修:裸图标升级 primary→tertiary 渐变品牌瓷砖(激活放大+高光扫过),
// 段悬停改舷形渐变填充(hoverfill 层 transform scale-x 扫入,轮廓镜像舷板外弧),
// 统计条灯珠化(绿呼吸/红脉冲,有数据才动;待批在场时呼吸让位)。
// 激活填充(bg-primary-container)保留。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useQuery, keepPreviousData } from '@tanstack/vue-query'
import { workbenchApi, getPlatformToken } from '@/api/client'
import { useIsPhone } from '@/composables/useBreakpoint'
import { Z } from '@/styles/zScale'

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
// 触屏 tap 合成 mouseenter 会让面板在跳转 /workbench 后残留新页(touch 无 mouseleave 关不掉)——
// 手机档整链禁开(Wave 4 终审 A)
function openPanel() {
  if (isPhone.value) return
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
      :title="isPhone ? $t('nav.workbench') : summaryText"
      class="group relative flex items-center gap-sm overflow-hidden rounded-tl-[30px] rounded-bl-[12px] max-sm:rounded-[14px] px-md py-2 transition-all duration-300 text-body-sm font-semibold shrink-0 active:scale-[0.98] active:duration-150 motion-reduce:transition-none"
      :class="[
        isWorkbenchActive
          ? 'bg-primary-container text-on-primary-container'
          : 'text-primary',
        isPhone ? 'max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:justify-center max-sm:px-0' : '',
      ]"
    >
      <!-- 舷形悬停填充(v4):镜像舷板外弧的渐变晕开(左叶亮起),scale-x 从左缘扫入(transform
           过渡有方向感;不用 opacity 显隐——避开 overflow-guard V4 的动作语义;触屏 :hover
           tap 后粘滞,装饰层整层 max-sm:hidden 才是真「触屏恒隐藏」);pointer-events-none 不挡点击 -->
      <span data-test="pill-hoverfill" aria-hidden="true"
        class="pointer-events-none absolute inset-0 origin-left scale-x-0 rounded-tl-[30px] rounded-bl-[12px] bg-gradient-to-r from-primary/10 via-primary/5 to-transparent transition-transform duration-300 group-hover:scale-x-100 max-sm:hidden motion-reduce:transition-none"></span>
      <!-- 品牌瓷砖(v4):primary→tertiary 渐变圆角砖包图标(on-primary 亮暗自翻转保对比度),
           自带底部投影+顶部内高光;激活放大,悬停微倾(手机档取消——粘滞 hover 恒倾);
           进入 /workbench 时高光扫过一次 -->
      <span class="relative inline-flex shrink-0">
        <span data-test="pill-tile"
          class="relative inline-flex h-[26px] w-[26px] items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary to-tertiary shadow-[0_1px_3px_rgb(0_0_0/0.25),inset_0_1px_0_rgb(255_255_255/0.35)] transition-transform duration-300 max-sm:transition-none motion-reduce:transition-none"
          :class="isWorkbenchActive ? 'scale-105' : 'group-hover:-rotate-6 max-sm:group-hover:rotate-0'">
          <span class="material-symbols-outlined text-base text-on-primary">workspaces</span>
          <!-- 一次性高光扫过:200% 宽背景必配 bg-no-repeat(repeat 会把白带绕回瓷砖常驻洗白);
               motion-reduce 用 hidden 不用 animate-none(摘动画后 background-position 回落 0%
               恰是右半白罩帧;装饰层 aria-hidden,直接藏掉最干净) -->
          <span v-if="isWorkbenchActive" data-test="pill-sheen" aria-hidden="true"
            class="absolute inset-0 rounded-lg bg-no-repeat bg-gradient-to-r from-transparent via-white/45 to-transparent bg-[length:200%_100%] animate-sheen motion-reduce:hidden"></span>
        </span>
        <!-- 手机档待审批红点(数字角标让位空间;桌面数字角标保留) -->
        <span v-if="isPhone && pendingCount > 0" data-test="pill-pending-dot"
          class="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-error"></span>
      </span>
      <template v-if="!isPhone">{{ $t('nav.workbench') }}</template>
      <!-- 迷你统计条(≥xl;2026-08-30 用户反馈:内容再丰富些):三段「灯珠+数字」常驻(0 也显示),
           灯珠按状态着色点亮(项目中性/运行绿/待审批红),有数据才动(绿呼吸/红脉冲,归零全静止,
           顶栏无常驻空转动画,motion-reduce 兜底);SSH 不上条(悬停面板看)。
           窄屏(<xl)整条隐藏,由下方单枚状态徽章接管 -->
      <span data-test="pill-stats" aria-hidden="true"
        class="hidden xl:inline-flex items-center gap-1.5 ml-1 text-body-xs font-normal">
        <span class="inline-flex items-center gap-1 text-on-surface-variant">
          <span data-test="pill-dot-projects" class="w-1.5 h-1.5 rounded-full bg-outline-variant/60"></span>
          <span class="font-bold text-on-surface">{{ totals.projects ?? 0 }}</span>{{ t('workbench.pill.kProjects') }}
        </span>
        <span class="inline-flex items-center gap-1 text-on-surface-variant">
          <span data-test="pill-dot-running" class="inline-block w-1.5 h-1.5 rounded-full transition-colors motion-reduce:animate-none"
            :class="runningCount > 0 ? (pendingCount > 0 ? 'bg-status-running' : 'bg-status-running animate-breathe') : 'bg-outline-variant/60'"></span>
          <span class="font-bold" :class="runningCount > 0 ? 'text-status-running' : ''">{{ runningCount }}</span>{{ t('workbench.pill.kRunning') }}
        </span>
        <span class="inline-flex items-center gap-1 text-on-surface-variant">
          <span class="relative inline-flex w-1.5 h-1.5">
            <span v-if="pendingCount > 0" data-test="pill-ping-pending" aria-hidden="true"
              class="absolute inline-flex h-full w-full rounded-full bg-error opacity-60 animate-ping motion-reduce:animate-none"></span>
            <span data-test="pill-dot-pending" class="relative inline-flex w-1.5 h-1.5 rounded-full transition-colors"
              :class="pendingCount > 0 ? 'bg-error' : 'bg-outline-variant/60'"></span>
          </span>
          <span class="font-bold" :class="pendingCount > 0 ? 'text-error' : ''">{{ pendingCount }}</span>{{ t('workbench.pill.kPending') }}
        </span>
      </span>
      <!-- 状态徽章(<xl 接管统计条;≥xl 隐藏防信息重复):
           待审批红数字(行动性最强)> 运行中绿数字 > 项目数中性,常驻不空。
           整链包 !isPhone:手机档三枚整体不渲染(红点接管)——v-else-if 不继承首枚
           条件,只给首枚加前缀会让运行/项目徽章在手机档照常求值渲染(评审抓) -->
      <template v-if="!isPhone">
        <span v-if="pendingCount > 0" data-test="pill-pending"
          class="ml-0.5 xl:hidden min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-error text-on-error text-body-xs font-bold leading-none"
          :title="$t('workbench.pill.pending', { n: pendingCount })">{{ pendingCount }}</span>
        <span v-else-if="runningCount > 0" data-test="pill-running"
          class="ml-0.5 xl:hidden min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-status-running/10 text-status-running text-body-xs font-bold leading-none"
          :title="$t('workbench.pill.running', { n: runningCount })">{{ runningCount }}</span>
        <span v-else data-test="pill-projects"
          class="ml-0.5 xl:hidden min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant text-body-xs font-bold leading-none"
          :title="$t('workbench.pill.projects', { n: totals.projects ?? 0 })">{{ totals.projects ?? 0 }}</span>
      </template>
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
  </div>
</template>
