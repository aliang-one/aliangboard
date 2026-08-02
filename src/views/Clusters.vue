<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'

const router = useRouter()
const store = useClusterStore()

const searchQuery = ref('')
// Sync：重新水合当前集群（core + extended + CRDs + metrics，hydrateCoreResources 内部已串联）
const syncing = ref(false)
async function sync() {
  if (syncing.value) return
  if (!store.remoteMode) { notify('info', '演示数据模式下无需同步'); return }
  syncing.value = true
  try {
    await store.hydrateCoreResources()
    notify('success', `已同步 ${store.currentCluster}`)
  } catch (e) {
    notify('error', `同步失败：${e.message || '未知错误'}`)
  } finally {
    syncing.value = false
  }
}

const filtered = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return store.clusterList
  return store.clusterList.filter(c =>
    c.name.toLowerCase().includes(q) ||
    (c.distribution || '').toLowerCase().includes(q) ||
    (c.version || '').toLowerCase().includes(q) ||
    (c.apiServer || '').toLowerCase().includes(q)
  )
})

// 集群状态：StatusChip 没有原生支持 Healthy/Degraded，映射到现有值
function mapStatus(status) {
  if (status === 'Healthy') return 'Ready'
  if (status === 'Degraded') return 'Failed'
  return status || 'Unknown'
}

async function switchTo(apiServer) {
  await store.switchCluster(apiServer)
  notify('success', `已切换到 ${store.currentCluster}`)
}

async function openCluster(c) {
  // 先切到目标集群再进入概览
  if (c.apiServer !== store.cluster?.apiServer) await store.switchCluster(c.apiServer)
  router.push('/cluster')
}

function addCluster() {
  router.push('/login')
}

function removeCluster(c) {
  // 注意：仅从已保存列表移除，不主动断开当前连接
  if (!window.confirm(`移除已保存的集群「${c.name}」？\n（仅从列表删除，不会影响当前已连接的会话）`)) return
  store.removeSavedClusterStore(c.apiServer)
  notify('success', '已移除')
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: 'Cluster', route: '/cluster' },
      { label: 'Clusters' }
    ]" />

    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">集群管理</h2>
        <p class="text-on-surface-variant text-body-md mt-1">
          共 <span class="text-primary font-semibold">{{ store.clusterList.length }}</span> 个集群，当前为
          <span class="text-primary font-semibold">{{ store.currentCluster }}</span>
        </p>
      </div>
      <div class="flex gap-sm">
        <button @click="sync" :disabled="syncing" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          <span class="material-symbols-outlined" :class="syncing ? 'animate-spin' : ''">{{ syncing ? 'progress_activity' : 'refresh' }}</span> {{ syncing ? 'Syncing…' : 'Sync' }}
        </button>
        <button @click="addCluster" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined">add</span> 添加集群
        </button>
      </div>
    </div>

    <!-- 搜索 -->
    <div class="flex items-center gap-md mb-lg">
      <div class="relative flex-1 max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input
          v-model="searchQuery"
          class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
          placeholder="按名称、版本或发行版搜索..."
        />
        <button v-if="searchQuery" @click="searchQuery = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface">
          <span class="material-symbols-outlined text-lg">close</span>
        </button>
      </div>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ store.clusterList.length }}</span>
    </div>

    <!-- 卡片网格 -->
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-lg">
      <div
        v-for="c in filtered"
        :key="c.name"
        class="bg-surface-container-lowest border rounded-xl shadow-card p-lg flex flex-col gap-md cursor-pointer hover:shadow-lg hover:border-primary/40 transition-all"
        :class="c.name === store.currentCluster ? 'border-primary/60' : 'border-outline-variant'"
        @click="openCluster(c)"
      >
        <!-- 头部：名称 + 状态 -->
        <div class="flex items-start justify-between gap-sm">
          <div class="flex items-center gap-sm min-w-0">
            <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
              <span class="material-symbols-outlined">hub</span>
            </div>
            <div class="min-w-0">
              <h3 class="text-headline-sm text-on-surface font-bold truncate">{{ c.name }}</h3>
              <p class="text-body-xs text-on-surface-variant truncate">{{ c.version }}</p>
            </div>
          </div>
          <StatusChip :status="mapStatus(c.status)" size="sm" />
        </div>

        <!-- 徽章区 -->
        <div class="flex flex-wrap items-center gap-xs">
          <span
            v-if="c.name === store.currentCluster"
            class="inline-flex items-center gap-1 px-sm py-0.5 rounded-full bg-primary text-on-primary text-body-xs font-bold"
          >
            <span class="material-symbols-outlined text-sm">check_circle</span>
            CURRENT
          </span>
          <span class="inline-flex items-center gap-1 px-sm py-0.5 rounded-full bg-tertiary-container/20 text-tertiary-container text-body-xs font-medium">
            <span class="material-symbols-outlined text-sm">dns</span>
            {{ c.distribution || 'unknown' }}
          </span>
          <span class="inline-flex items-center gap-1 px-sm py-0.5 rounded-full bg-surface-container text-on-surface-variant text-body-xs font-medium">
            <span class="material-symbols-outlined text-sm">account_tree</span>
            {{ c.context || '—' }}
          </span>
        </div>

        <!-- 指标 -->
        <div class="grid grid-cols-2 gap-sm">
          <div class="bg-surface-container-low rounded-lg px-md py-sm">
            <p class="text-label-caps text-on-surface-variant">NODES</p>
            <p class="text-headline-sm text-on-surface font-bold mt-1">{{ c.nodeCount ?? 0 }}</p>
          </div>
          <div class="bg-surface-container-low rounded-lg px-md py-sm">
            <p class="text-label-caps text-on-surface-variant">PODS</p>
            <p class="text-headline-sm text-on-surface font-bold mt-1">{{ c.podCount ?? 0 }}</p>
          </div>
        </div>

        <!-- API Server -->
        <div class="flex items-center gap-sm bg-surface-container-low rounded-lg px-md py-sm">
          <span class="material-symbols-outlined text-on-surface-variant text-lg shrink-0">link</span>
          <span class="text-body-sm text-on-surface-variant truncate font-mono">{{ c.apiServer }}</span>
        </div>

        <!-- 操作区 -->
        <div class="flex items-center justify-end gap-sm mt-auto pt-xs" @click.stop>
          <button
            v-if="c.name !== store.currentCluster"
            @click="switchTo(c.apiServer)"
            class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary font-semibold rounded-lg text-body-sm shadow-sm hover:opacity-90 active:scale-95 transition-all"
          >
            <span class="material-symbols-outlined text-base">swap_horiz</span>
            切换到此集群
          </button>
          <span
            v-else
            class="inline-flex items-center gap-xs px-md py-sm text-primary font-semibold text-body-sm"
          >
            <span class="material-symbols-outlined text-base">check_circle</span>
            当前活动集群
          </span>
          <button
            v-if="c.name !== store.currentCluster"
            @click="removeCluster(c)"
            title="移除已保存集群"
            class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg transition-colors"
          >
            <span class="material-symbols-outlined text-base">delete</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="!filtered.length" class="text-center py-xl">
      <div class="w-16 h-16 rounded-full bg-surface-container mx-auto flex items-center justify-center mb-sm">
        <span class="material-symbols-outlined text-2xl text-on-surface-variant">search_off</span>
      </div>
      <p class="text-body-md text-on-surface-variant font-medium">未找到匹配的集群</p>
    </div>
  </section>
</template>
