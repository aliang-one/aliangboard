<script setup>
import { ref, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import SideNavBar from './SideNavBar.vue'
import TopNavBar from './TopNavBar.vue'
import TerminalTaskbar from '@/components/terminal/TerminalTaskbar.vue'
import { useClusterStore } from '@/stores/cluster'
import { useTerminalStore } from '@/stores/terminals'
import { usePageRefresh } from '@/composables/usePageRefresh'

// 终端窗口懒加载：xterm + addons（~400KB）仅在 allTerminals 非空（用户开了终端）时才加载，
// 移出首屏关键路径。TerminalTaskbar 不引 xterm（仅会话列表），保持静态避免任务栏闪空。

const TerminalWindow = defineAsyncComponent(() => import('@/components/terminal/TerminalWindow.vue'))

const store = useClusterStore()
const termStore = useTerminalStore()
const { tick: refreshTick } = usePageRefresh()

// footer 时间：由定时器驱动，避免模板内 new Date() 在每次重渲时跳变且不自动 tick
const lastUpdated = ref('')
let timer = null
function tick() { lastUpdated.value = new Date().toLocaleTimeString() }
onMounted(() => {
  tick(); timer = setInterval(tick, 1000)
  termStore.loadPersisted() // 恢复持久化的终端会话（刷新不掉线）
  // 进入主界面后后台水合集群资源（不阻塞页面渲染，用户先看到框架再逐步加载）
  if (store.remoteMode) store.hydrateCoreResources({ silent: true }).then(() => store.prefillQueryCache()).catch(() => {})
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
        <span v-if="store.clusterHealth.status === 'Critical'">控制面异常：{{ store.clusterHealth.controlPlane.ready }}/{{ store.clusterHealth.controlPlane.total }} 就绪 · {{ store.clusterHealth.reasons.join('；') }}</span>
        <span v-else>集群不可达或未连接：{{ store.clusterHealth.reasons.join('；') }}</span>
      </div>
      <main class="flex-1 overflow-y-auto bg-surface p-margin">
        <router-view v-slot="{ Component, route }">
          <transition name="fade" mode="out-in">
            <!-- 用单根 div 包裹，避免页面组件为多根节点（fragment）时
                 <transition mode="out-in"> 无法动画化导致新页面不挂载（详情页点击空白） -->
            <div :key="route.path + '#' + refreshTick">
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
            <span class="text-body-sm text-on-surface-variant">集群: {{ store.clusterHealth.status }} · 控制面 {{ store.clusterHealth.controlPlane.ready }}/{{ store.clusterHealth.controlPlane.total }} · worker {{ store.clusterHealth.workers.ready }}/{{ store.clusterHealth.workers.total }}</span>
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
  </div>
</template>
