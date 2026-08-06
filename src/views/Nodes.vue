<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore, formatCpu, formatMem } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useTableColumns } from '@/composables/useTableColumns'
import { notify } from '@/composables/useToast'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const router = useRouter()
const store = useClusterStore()
const { tableColumns } = useTableColumns()

// Nodes 走 Vue Query：远端 30s 轮询 + 聚焦窗口后台重拉（新鲜度）；mock 模式返回种子（staleTime:Infinity 不重拉）。
// hydrate 仍为 ClusterOverview 等供数（过渡期双源，后续域迁移后收敛）。
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const nodesQuery = useResourceList({
  key: ['cluster', cid.value, 'nodes'],
  fetcher: () => store.fetchNodes(),
  mock: store.nodeList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const nodes = computed(() => nodesQuery.data.value || [])
const healthyCount = computed(() => nodes.value.filter(n => n.status === 'Ready').length)
const loading = computed(() => nodesQuery.isLoading.value && store.remoteMode)

const searchQuery = ref('')
const syncing = computed(() => nodesQuery.isFetching.value)
async function sync() {
  if (!store.remoteMode) { notify('info', '演示数据模式下无需同步'); return }
  try { await nodesQuery.refetch(); notify('success', '已同步节点') }
  catch (e) { notify('error', `同步失败：${e.message || ''}`) }
}
const filtered = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return nodes.value
  return nodes.value.filter(n => n.name.toLowerCase().includes(q) || (n.roles || '').toLowerCase().includes(q) || (n.ip || '').toLowerCase().includes(q))
})

const headers = computed(() => tableColumns('nodes'))

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [searchQuery] })
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">Nodes</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">Monitor and manage cluster nodes. {{ healthyCount }} of {{ nodes.length }} healthy.</p>
      </div>
      <div class="flex gap-sm">
        <button @click="sync" :disabled="syncing" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          <span class="material-symbols-outlined text-base" :class="syncing ? 'animate-spin' : ''">{{ syncing ? 'progress_activity' : 'refresh' }}</span> {{ syncing ? 'Syncing…' : 'Sync' }}
        </button>
      </div>
    </div>

    <!-- 搜索框 -->
    <div class="flex items-center gap-md mb-md">
      <div class="relative flex-1 max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" placeholder="按名称、角色或 IP 搜索..." />
        <button v-if="searchQuery" @click="searchQuery = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"><span class="material-symbols-outlined text-lg">close</span></button>
      </div>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ nodes.length }}</span>
    </div>

    <div v-if="loading" class="flex items-center justify-center gap-sm py-xl text-on-surface-variant">
      <span class="material-symbols-outlined text-2xl animate-spin">progress_activity</span>
      <span class="text-body-sm">加载节点中…</span>
    </div>
    <EmptyState v-else-if="!filtered.length" icon="dns" title="No nodes found" description="集群暂无节点，或被搜索条件过滤。" />
    <DataTable v-else :headers="headers" :rows="paginated" @row-click="(row) => router.push(`/nodes/${row.name}`)">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <div class="w-8 h-8 rounded bg-surface-container flex items-center justify-center text-on-surface-variant">
            <span class="material-symbols-outlined">dns</span>
          </div>
          <div>
            <span class="font-semibold text-on-surface text-body-md block">{{ row.name }}</span>
            <span class="font-mono text-code-sm text-on-surface-variant">{{ row.ip }}<span v-if="row.externalIp" class="text-on-surface-variant/60"> · {{ row.externalIp }}</span></span>
          </div>
        </div>
      </template>
      <template #status="{ row }">
        <div class="flex flex-col gap-xs">
          <StatusChip :status="row.status === 'Ready' ? 'Ready' : 'NotReady'" />
          <div class="flex gap-xs">
            <span v-if="row.conditions?.DiskPressure" class="px-1 py-0.5 bg-error-container/30 text-error text-xs rounded" title="DiskPressure">Disk</span>
            <span v-if="row.conditions?.MemoryPressure" class="px-1 py-0.5 bg-error-container/30 text-error text-xs rounded" title="MemoryPressure">Mem</span>
            <span v-if="row.conditions?.PIDPressure" class="px-1 py-0.5 bg-error-container/30 text-error text-xs rounded" title="PIDPressure">PID</span>
            <span v-if="row.taintCount" class="px-1 py-0.5 bg-tertiary-container/20 text-tertiary-container text-xs rounded" title="Taints">{{ row.taintCount }} taint{{ row.taintCount > 1 ? 's' : '' }}</span>
          </div>
        </div>
      </template>
      <template #roles="{ row }">
        <span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant capitalize">{{ row.roles }}</span>
      </template>
      <template #system="{ row }">
        <div class="flex flex-col">
          <span class="text-body-sm text-on-surface truncate max-w-[14rem]">{{ row.os }}</span>
          <span class="font-mono text-code-sm text-on-surface-variant">{{ row.version }}<span v-if="row.containerRuntimeShort"> · {{ row.containerRuntimeShort }}</span><span v-if="row.arch"> · {{ row.arch }}</span></span>
        </div>
      </template>
      <template #cpu="{ row }">
        <div class="w-28">
          <ProgressBar v-if="row.cpu != null" :value="row.cpu" :show-label="true" />
          <span v-else class="text-on-surface-variant">—</span>
          <p v-if="row.usedCpu != null" class="font-mono text-xs text-on-surface-variant/70 -mt-1">{{ formatCpu(row.usedCpu) }}/{{ formatCpu(row.allocCpu) }}</p>
        </div>
      </template>
      <template #memory="{ row }">
        <div class="w-28">
          <ProgressBar v-if="row.memory != null" :value="row.memory" :show-label="true" />
          <span v-else class="text-on-surface-variant">—</span>
          <p v-if="row.usedMem != null" class="font-mono text-xs text-on-surface-variant/70 -mt-1">{{ formatMem(row.usedMem) }}/{{ formatMem(row.allocMem) }}</p>
        </div>
      </template>
      <template #pods="{ row }">
        <span class="text-body-sm font-medium text-on-surface">{{ row.podCount ?? 0 }}<span v-if="row.podCapacity" class="text-on-surface-variant/60"> / {{ row.podCapacity }}</span></span>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button v-if="!row.unschedulable" @click.stop="store.cordonNode(row.name)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg transition-all" title="Cordon">
            <span class="material-symbols-outlined text-lg">lock</span>
          </button>
          <button v-else @click.stop="store.uncordonNode(row.name)" class="p-sm text-primary hover:bg-primary-container/10 rounded-lg transition-all" title="Uncordon">
            <span class="material-symbols-outlined text-lg">lock_open</span>
          </button>
          <button @click.stop="router.push(`/nodes/${row.name}`)" class="p-sm text-on-surface-variant hover:text-tertiary-container hover:bg-tertiary-container/10 rounded-lg transition-all" title="Drain">
            <span class="material-symbols-outlined text-lg">output</span>
          </button>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>
</template>
