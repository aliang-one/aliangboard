<script setup>
import { ref, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import SideNavBar from './SideNavBar.vue'
import TopNavBar from './TopNavBar.vue'
import TerminalTaskbar from '@/components/terminal/TerminalTaskbar.vue'
import { useClusterStore } from '@/stores/cluster'
import { useTerminalStore } from '@/stores/terminals'
import { useFileBrowserStore } from '@/stores/fileBrowsers'
import { useTransferStore } from '@/stores/transfers'
import { usePageRefresh } from '@/composables/usePageRefresh'
import { getSession } from '@/api/client'

// 终端窗口懒加载：xterm + addons（~400KB）仅在 allTerminals 非空（用户开了终端）时才加载，
// 移出首屏关键路径。TerminalTaskbar 不引 xterm（仅会话列表），保持静态避免任务栏闪空。

const TerminalWindow = defineAsyncComponent(() => import('@/components/terminal/TerminalWindow.vue'))
// 文件浏览窗口同策略懒加载：仅用户开了文件浏览才拉 FileBrowserBody 等体量组件
const FileBrowserWindow = defineAsyncComponent(() => import('@/components/common/FileBrowserWindow.vue'))
// 传输面板同策略:仅 panelOpen 时才加载(任务列表轻,但保持一致)
const TransfersPanel = defineAsyncComponent(() => import('@/components/common/TransfersPanel.vue'))
// 悬浮 AI 对话入口:按钮本身极轻,直接静态引入;重货 ChatModal(内嵌 WorkbenchChat/
// marked/dompurify)由 ChatPresence 内部 defineAsyncComponent 按需加载
import ChatPresence from '@/components/workbench/ChatPresence.vue'
// fullHeight 路由判定用:main 的 class 绑在 router-view 外,v-slot 的 route 够不到
const route = useRoute()

const store = useClusterStore()
const termStore = useTerminalStore()
const fbStore = useFileBrowserStore()
const trStore = useTransferStore()
const { tick: refreshTick } = usePageRefresh()

// footer 时间：由定时器驱动，避免模板内 new Date() 在每次重渲时跳变且不自动 tick
const lastUpdated = ref('')
let timer = null
function tick() { lastUpdated.value = new Date().toLocaleTimeString() }
onMounted(() => {
  tick(); timer = setInterval(tick, 1000)
  // 恢复持久化的终端会话（刷新不掉线）+ 后台水合集群资源（不阻塞页面渲染）。
  // 两者都是 K8s 会话层请求：无 K8s session 时跳过（首装 admin 在 /admin/clusters 等平台
  // 管理页），拉了必 401（hydrate 还会弹「节点拉取失败」噪音）；连上集群后 AppLayout
  // 会整页重挂载再补上
  if (getSession()) {
    termStore.loadPersisted()
    fbStore.loadPersisted()
    store.hydrateCriticalResources({ silent: true }).catch(() => {})
  }
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="flex h-screen overflow-hidden">
    <SideNavBar />
    <div class="flex-1 flex flex-col min-w-0 ml-[260px]">
      <!-- 全局加载指示：hydrate 期间（登录/同步/切集群）顶部细条，覆盖所有页面 -->
      <div v-if="store.connectionState === 'loading'" class="fixed top-0 left-[260px] right-0 h-0.5 bg-primary z-[60] animate-pulse"></div>
      <TopNavBar />
      <!-- 集群健康横幅：Critical / Disconnected -->
      <div v-if="store.clusterHealth.status === 'Critical' || store.clusterHealth.status === 'Disconnected'"
        class="px-lg py-sm flex items-center gap-sm text-on-error bg-error/10 border-b border-error/30 text-body-sm">
        <span class="material-symbols-outlined text-base">crisis_alert</span>
        <span v-if="store.clusterHealth.status === 'Critical'">{{ $t('layout.controlPlaneAbnormal', { ready: store.clusterHealth.controlPlane.ready, total: store.clusterHealth.controlPlane.total, reasons: store.clusterHealth.reasons.map(r => $t(r)).join('；') }) }}</span>
        <span v-else>{{ $t('layout.clusterUnreachable', { reasons: store.clusterHealth.reasons.map(r => $t(r)).join('；') }) }}</span>
      </div>
      <!-- fullHeight 路由(工作台类应用式布局):main 不滚不留白,高度链贯通到页面组件,
           由页面内部自管滚动;其余路由保持文档式页面滚动 -->
      <main class="flex-1 min-h-0" :class="route?.meta?.fullHeight ? 'overflow-hidden' : 'overflow-y-auto bg-surface p-margin'">
        <router-view v-slot="{ Component, route }">
          <transition name="fade" mode="out-in">
            <!-- 用单根 div 包裹，避免页面组件为多根节点（fragment）时
                 <transition mode="out-in"> 无法动画化导致新页面不挂载（详情页点击空白） -->
            <div :key="route.path + '#' + refreshTick" :class="route?.meta?.fullHeight ? 'h-full' : ''">
              <component :is="Component" />
            </div>
          </transition>
        </router-view>
      </main>
      <!-- Footer Status Bar -->
      <footer class="px-lg py-sm bg-surface border-t border-outline-variant flex justify-between items-center shrink-0">
        <div class="flex items-center gap-lg">
          <div class="flex items-center gap-sm">
            <span class="w-2 h-2 rounded-full" :class="{ 'bg-primary': store.clusterHealth.severity === 'ok', 'bg-tertiary-container': store.clusterHealth.severity === 'warn', 'bg-error': store.clusterHealth.severity === 'crit', 'bg-on-surface-variant': store.clusterHealth.severity === 'none' }"></span>
            <span class="text-body-sm text-on-surface-variant">{{ $t('layout.clusterStatusSummary', { status: store.clusterHealth.status, ready: store.clusterHealth.controlPlane.ready, total: store.clusterHealth.controlPlane.total, wready: store.clusterHealth.workers.ready, wtotal: store.clusterHealth.workers.total }) }}</span>
          </div>
        </div>
        <div class="flex items-center gap-md text-on-surface-variant font-mono text-code-sm">
          <span>Last Updated: {{ lastUpdated }}</span>
          <span class="px-sm py-xs bg-surface-container rounded-sm border border-outline-variant">{{ store.cluster.version }}</span>
        </div>
      </footer>
      <!-- 终端任务栏（底部，类似 Windows taskbar） -->
      <TerminalTaskbar />
    </div>
    <!-- 浮动终端窗口：用 v-show（不销毁）而非 v-if，最小化时保持 exec WS + xterm buffer 活跃 -->
    <TerminalWindow v-for="t in termStore.allTerminals" :key="t.id" :terminal="t" v-show="t.status === 'open'" />
    <!-- 浮动文件浏览窗口:v-show 保持挂载,最小化状态同步 -->
    <FileBrowserWindow v-for="b in fbStore.browsers" :key="b.id" :browser="b" v-show="b.status === 'open'" />
    <!-- 传输面板:按需挂载(关闭即销毁,状态在 transfers store) -->
    <TransfersPanel v-if="trStore.panelOpen" />
    <!-- 全局悬浮 AI 对话入口:有活跃对话才可见(内部自管显隐/轮询) -->
    <ChatPresence />
  </div>
</template>
