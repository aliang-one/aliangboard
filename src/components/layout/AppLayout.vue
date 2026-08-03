<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import SideNavBar from './SideNavBar.vue'
import TopNavBar from './TopNavBar.vue'
import { useClusterStore } from '@/stores/cluster'

const store = useClusterStore()

// footer 时间：由定时器驱动，避免模板内 new Date() 在每次重渲时跳变且不自动 tick
const lastUpdated = ref('')
let timer = null
function tick() { lastUpdated.value = new Date().toLocaleTimeString() }
onMounted(() => { tick(); timer = setInterval(tick, 1000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="flex h-screen overflow-hidden">
    <SideNavBar />
    <div class="flex-1 flex flex-col min-w-0 ml-[260px]">
      <!-- 全局加载指示：hydrate 期间（登录/同步/切集群）顶部细条，覆盖所有页面 -->
      <div v-if="store.connectionState === 'loading'" class="fixed top-0 left-[260px] right-0 h-0.5 bg-primary z-[60] animate-pulse"></div>
      <TopNavBar />
      <main class="flex-1 overflow-y-auto bg-surface p-margin">
        <router-view v-slot="{ Component, route }">
          <transition name="fade" mode="out-in">
            <!-- 用单根 div 包裹，避免页面组件为多根节点（fragment）时
                 <transition mode="out-in"> 无法动画化导致新页面不挂载（详情页点击空白） -->
            <div :key="route.path">
              <component :is="Component" />
            </div>
          </transition>
        </router-view>
      </main>
      <!-- Footer Status Bar -->
      <footer class="px-lg py-sm bg-surface border-t border-outline-variant flex justify-between items-center shrink-0">
        <div class="flex items-center gap-lg">
          <div class="flex items-center gap-sm">
            <span class="w-2 h-2 bg-primary-container rounded-full animate-pulse-status"></span>
            <span class="text-body-sm text-on-surface-variant">Control Plane: {{ store.cluster.status }}</span>
          </div>
          <div class="flex items-center gap-sm">
            <span class="w-2 h-2 bg-primary-container rounded-full"></span>
            <span class="text-body-sm text-on-surface-variant">Nodes: {{ store.healthyNodes }}/{{ store.totalNodes }} Online</span>
          </div>
        </div>
        <div class="flex items-center gap-md text-on-surface-variant font-mono text-code-sm">
          <span>Last Updated: {{ lastUpdated }}</span>
          <span class="px-sm py-xs bg-surface-container rounded-sm border border-outline-variant">{{ store.cluster.version }}</span>
        </div>
      </footer>
    </div>
  </div>
</template>
