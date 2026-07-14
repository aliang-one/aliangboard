<script setup>
import SideNavBar from './SideNavBar.vue'
import TopNavBar from './TopNavBar.vue'
</script>

<template>
  <div class="flex h-screen overflow-hidden">
    <SideNavBar />
    <div class="flex-1 flex flex-col min-w-0 ml-[260px]">
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
            <span class="text-body-sm text-on-surface-variant">Control Plane: Healthy</span>
          </div>
          <div class="flex items-center gap-sm">
            <span class="w-2 h-2 bg-primary-container rounded-full"></span>
            <span class="text-body-sm text-on-surface-variant">Nodes: 12 Online</span>
          </div>
        </div>
        <div class="flex items-center gap-md text-on-surface-variant font-mono text-code-sm">
          <span>Last Updated: {{ new Date().toLocaleTimeString() }}</span>
          <span class="px-sm py-xs bg-surface-container rounded-sm border border-outline-variant">v1.28.2</span>
        </div>
      </footer>
    </div>
  </div>
</template>
