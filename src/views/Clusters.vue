<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import ClusterCard from '@/components/common/ClusterCard.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

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

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [searchQuery] })

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

    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">集群管理</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">
          共 <span class="text-primary font-semibold">{{ store.clusterList.length }}</span> 个集群，当前为
          <span class="text-primary font-semibold">{{ store.currentCluster }}</span>
        </p>
      </div>
      <div class="flex gap-sm">
        <button @click="sync" :disabled="syncing" class="flex items-center gap-sm px-3 py-1.5 bg-surface-container-highest text-on-surface text-body-sm font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          <span class="material-symbols-outlined text-sm" :class="syncing ? 'animate-spin' : ''">{{ syncing ? 'progress_activity' : 'refresh' }}</span> {{ syncing ? 'Syncing…' : 'Sync' }}
        </button>
        <button @click="addCluster" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary text-body-sm font-semibold rounded-lg hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined text-sm">add</span> 添加集群
        </button>
      </div>
    </div>

    <!-- 搜索 -->
    <div class="flex items-center gap-md mb-md">
      <div class="relative flex-1 max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-base pointer-events-none">search</span>
        <input
          v-model="searchQuery"
          class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-1.5 text-body-sm focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
          placeholder="按名称、版本或发行版搜索..."
        />
        <button v-if="searchQuery" @click="searchQuery = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface">
          <span class="material-symbols-outlined text-base">close</span>
        </button>
      </div>
      <span class="text-xs text-on-surface-variant">{{ filtered.length }} / {{ store.clusterList.length }}</span>
    </div>

    <!-- 卡片网格 -->
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-md">
      <ClusterCard
        v-for="c in paginated"
        :key="c.name"
        :cluster="c"
        :active="c.name === store.currentCluster"
        @remove="removeCluster(c)"
      />
    </div>

    <div v-if="total > pageSize" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant flex items-center justify-between px-md py-2 bg-surface-container-low">
      <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
    </div>

    <!-- 空状态 -->
    <div v-if="!filtered.length" class="text-center py-md">
      <div class="w-12 h-12 rounded-full bg-surface-container mx-auto flex items-center justify-center mb-sm">
        <span class="material-symbols-outlined text-2xl text-on-surface-variant">search_off</span>
      </div>
      <p class="text-body-sm text-on-surface-variant font-medium">未找到匹配的集群</p>
    </div>
  </section>
</template>
