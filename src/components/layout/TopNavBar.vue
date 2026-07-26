<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { api, clearSession } from '@/api/client'

const router = useRouter()
const store = useClusterStore()

const searchQuery = ref('')
const showClusterDropdown = ref(false)

const currentClusterObj = computed(() => store.getCurrentCluster())

// 集群状态 → 圆点颜色
function clusterStatusColor(status) {
  if (status === 'Healthy') return 'bg-primary'
  if (status === 'Degraded') return 'bg-error'
  return 'bg-on-surface-variant'
}

function selectCluster(name) {
  if (name !== store.currentCluster) {
    store.switchCluster(name)
  }
  showClusterDropdown.value = false
}

function closeClusterDropdown() {
  showClusterDropdown.value = false
}

function goClusters() {
  showClusterDropdown.value = false
  router.push('/clusters')
}

async function logout() {
  try { await api.logout() } catch { /* 会话已失效时仍清理本地状态 */ }
  clearSession()
  router.push('/login')
}
</script>

<template>
  <header class="flex justify-between items-center px-lg w-full sticky top-0 z-50 bg-surface h-16 border-b border-outline-variant shrink-0">
    <div class="flex items-center gap-lg flex-1">
      <div class="relative max-w-md w-full">
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none">search</span>
        <input
          v-model="searchQuery"
          class="w-full bg-surface-container-low border border-outline-variant rounded-full py-1.5 pl-10 pr-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
          placeholder="Search resources..."
          type="text"
        />
      </div>

      <!-- 集群切换 -->
      <div class="relative">
        <button
          @click="showClusterDropdown = !showClusterDropdown"
          class="flex items-center gap-sm px-md py-1.5 rounded-lg border transition-all"
          :class="showClusterDropdown
            ? 'border-primary bg-primary/5 text-primary'
            : 'border-outline-variant bg-surface-container-low text-on-surface hover:border-primary/50'"
        >
          <span class="material-symbols-outlined text-lg">hub</span>
          <div class="flex flex-col items-start leading-tight min-w-0 max-w-[180px]">
            <span class="text-body-xs text-on-surface-variant opacity-70">CLUSTER</span>
            <span class="text-body-sm font-semibold truncate">{{ currentClusterObj?.name || '—' }}</span>
          </div>
          <span class="material-symbols-outlined text-lg shrink-0 transition-transform" :class="showClusterDropdown ? 'rotate-180' : ''">expand_more</span>
        </button>

        <!-- 下拉列表 -->
        <div
          v-if="showClusterDropdown"
          class="absolute top-full left-0 mt-1 w-80 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-50 overflow-hidden"
        >
          <!-- 头部 -->
          <div class="flex items-center justify-between px-md py-sm border-b border-outline-variant">
            <p class="text-label-caps text-on-surface-variant">切换集群</p>
            <button
              @click.stop="goClusters"
              class="flex items-center gap-1 text-body-sm text-primary hover:opacity-80 transition-opacity"
            >
              <span class="material-symbols-outlined text-base">view_module</span>
              管理全部
            </button>
          </div>

          <!-- 集群列表 -->
          <div class="max-h-80 overflow-y-auto p-sm">
            <div
              v-for="c in store.clusterList"
              :key="c.name"
              @click="selectCluster(c.name)"
              class="flex items-center justify-between px-md py-sm rounded-lg cursor-pointer transition-all hover:bg-surface-container"
              :class="c.name === store.currentCluster ? 'bg-primary-container/20' : ''"
            >
              <div class="flex items-center gap-sm min-w-0">
                <span class="w-2 h-2 rounded-full shrink-0" :class="clusterStatusColor(c.status)"></span>
                <div class="min-w-0">
                  <p class="text-body-md font-medium truncate" :class="c.name === store.currentCluster ? 'text-primary' : 'text-on-surface'">{{ c.name }}</p>
                  <p class="text-body-xs text-on-surface-variant">{{ c.version }} · {{ c.distribution }}</p>
                </div>
              </div>
              <div class="flex items-center gap-xs shrink-0">
                <span v-if="c.name === store.currentCluster" class="text-body-xs font-bold text-primary px-sm py-0.5 rounded-full bg-primary-container/30">CURRENT</span>
                <span class="material-symbols-outlined text-base text-on-surface-variant opacity-40">chevron_right</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="flex items-center gap-md">
      <button class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors relative">
        <span class="material-symbols-outlined">notifications</span>
        <span class="absolute top-1.5 right-1.5 w-2 h-2 bg-error rounded-full"></span>
      </button>
      <button class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors">
        <span class="material-symbols-outlined">help</span>
      </button>
      <button class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors">
        <span class="material-symbols-outlined">settings</span>
      </button>
      <div class="h-8 w-px bg-outline-variant mx-2"></div>
      <button @click="logout" class="flex items-center gap-sm cursor-pointer hover:bg-surface-container-low p-1 rounded-lg transition-colors" title="退出登录">
        <div class="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-body-sm font-bold">A</div>
        <span class="text-body-sm font-semibold">Admin</span>
        <span class="material-symbols-outlined text-on-surface-variant text-body-sm">logout</span>
      </button>
    </div>
  </header>
  <!-- 点击外部关闭集群下拉 -->
  <div v-if="showClusterDropdown" class="fixed inset-0 z-30" @click="closeClusterDropdown"></div>
</template>
