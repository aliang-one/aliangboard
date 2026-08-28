<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import DataTable from '@/components/common/DataTable.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import Pagination from '@/components/common/Pagination.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useTableColumns } from '@/composables/useTableColumns'
import { readMeta } from '@/composables/useBusinessMeta'
import { notify } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'
import CreateWithYamlButton from '@/components/common/CreateWithYamlButton.vue'
import CopyWorkloadDialog from '@/components/common/CopyWorkloadDialog.vue'

const router = useRouter()
const store = useClusterStore()
const { tableColumns } = useTableColumns()
const { t } = useI18n()

// Workloads 走 Vue Query（集群范围）：远端 30s 轮询 + 聚焦重拉 + 新鲜度。
const cid = computed(() => (store.currentCluster || 'cluster'))
const nsQ = useResourceList({ key: ['cluster', cid, 'namespaces'], fetcher: () => store.fetchNamespaces(), options: { refetchInterval: 60000 } })
const allNamespaces = computed(() => nsQ.data.value ?? store.namespaceList)
// watch live 零轮询 / 降级 60s 兜底；refetchInterval 直传 ref
const wlState = computed(() => store.watchStateOf('workloads'))
const wlInterval = computed(() => (wlState.value === 'live' || wlState.value === 'reconnecting') ? false : 60000)
const workloadsQuery = useResourceList({
  key: ['cluster', cid, 'workloads'],
  fetcher: () => store.fetchWorkloads(),
  options: { refetchInterval: wlInterval, refetchOnWindowFocus: false },
})
const workloadList = computed(() => workloadsQuery.data.value || [])

// 进页即触发 metrics 拉取 + 集群汇总刷新,让顶部 CPU%/podCount 显示真实值(computeClusterMetrics 从缓存派生)
onMounted(() => { store.refreshMetrics().catch(() => {}) })

const showCopyDialog = ref(false)

const namespaceFilter = ref('All Namespaces')
const typeFilter = ref('All Types')
const statusFilter = ref('All Statuses')

const filters = [
  { key: 'namespace', label: 'Namespace', options: ['All Namespaces', ...allNamespaces.value.map(n => n.name)] },
  { key: 'type', label: 'Workload Type', options: ['All Types', 'Deployment', 'Pod', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'] },
  { key: 'status', label: 'Status', options: ['All Statuses', 'Running', 'Pending', 'Failed', 'Succeeded'] },
]

// FilterBar 过滤回调 → 写回对应 ref
function onFilterChange({ key, value }) {
  if (key === 'namespace') namespaceFilter.value = value
  else if (key === 'type') typeFilter.value = value
  else if (key === 'status') statusFilter.value = value
  currentPage.value = 1
}

const filteredWorkloads = computed(() => {
  let list = workloadList.value
  if (namespaceFilter.value !== 'All Namespaces') {
    list = list.filter(w => w.namespace === namespaceFilter.value)
  }
  if (typeFilter.value !== 'All Types') {
    list = list.filter(w => w.type === typeFilter.value)
  }
  if (statusFilter.value !== 'All Statuses') {
    list = list.filter(w => w.status === statusFilter.value)
  }
  return list
})

const headers = computed(() => tableColumns('workloads'))

// 分页
const currentPage = ref(1)
const pageSize = 10
const pagedWorkloads = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  return filteredWorkloads.value.slice(start, start + pageSize)
})

function parseReplicas(rep) {
  const [current, total] = String(rep || '0/0').split('/').map(Number)
  return { current, total, percent: total > 0 ? (current / total) * 100 : 0 }
}

function goDetail(row) {
  router.push({
    name: 'NsWorkloadDetail',
    params: {
      namespace: row.namespace,
      type: row.type.toLowerCase(),
      name: row.name,
    },
  })
}

// 行内操作：Restart 真实落集群；Edit/Logs 复用详情页（含日志/t('common.edit')）
async function restartWorkload(row) {
  try { await store.restartWorkload(row.name, row.namespace); notify('success', t('workloads.restartSuccess', { name: row.name })) }
  catch (e) { notify('error', e.message || t('workloads.restartFailed')) }
}

// 导出当前过滤结果为 JSON 文件下载
function exportWorkloads() {
  const blob = new Blob([JSON.stringify(filteredWorkloads.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'workloads.json'
  a.click()
  URL.revokeObjectURL(url)
}

// 真实统计（替代硬编码假数据）
const nodeHealthPct = computed(() => {
  const total = store.totalNodes
  return total > 0 ? Math.round((store.healthyNodes / total) * 100) : null
})
</script>

<template>
  <section class="animate-fade-in">
    <!-- Header -->
    <div class="flex flex-col gap-md mb-lg">
      <div class="flex justify-between items-end">
        <div>
          <h2 class="text-display-lg text-on-surface">{{ t('ns.workloads.title') }}</h2>
          <p class="text-on-surface-variant text-body-md mt-1">{{ t('workloads.subtitle') }}</p>
        </div>
        <div class="flex gap-sm">
          <button @click="exportWorkloads" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
            <span class="material-symbols-outlined">file_download</span> {{ t('common.export') }}
          </button>
          <CreateWithYamlButton
            :label="t('ns.workloads.new')"
            icon="rocket_launch"
            :main-action="() => router.push('/deploy')"
            yaml-template="Deployment"
            :extra-items="[{ label: t('component.splitButton.copyWorkload'), icon: 'content_copy', action: () => { showCopyDialog = true } }]"
          />
          <CopyWorkloadDialog v-model="showCopyDialog" target-route-name="Deploy" />
        </div>
      </div>

      <!-- Filters -->
      <FilterBar :filters="filters" :result-count="filteredWorkloads.length" result-label="workloads" @filter-change="onFilterChange" />
    </div>

    <!-- Table -->
    <EmptyState v-if="!filteredWorkloads.length" icon="workspaces" :title="t('workloads.emptyTitle')" :description="t('workloads.emptyDescription')" />
    <DataTable v-else :headers="headers" :rows="pagedWorkloads" column-key="workloads" @row-click="goDetail">
      <template #name="{ row }">
        <div class="flex flex-col">
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
          <span v-if="readMeta(row).title" class="text-xs text-primary">{{ readMeta(row).title }}</span>
          <span class="font-mono text-code-sm text-on-surface-variant">{{ row.sha }}</span>
        </div>
      </template>
      <template #status="{ row }">
        <StatusChip :status="row.status" />
      </template>
      <template #replicas="{ row }">
        <div class="flex items-center gap-sm">
          <span class="font-mono text-code-sm font-bold" :class="parseReplicas(row.replicas).percent === 100 ? 'text-on-surface' : 'text-error'">
            {{ row.replicas }}
          </span>
          <div class="w-16 bg-outline-variant/30 h-1.5 rounded-full overflow-hidden">
            <div
              class="h-full rounded-full"
              :class="parseReplicas(row.replicas).percent === 100 ? 'bg-primary' : parseReplicas(row.replicas).percent === 0 ? 'bg-error' : 'bg-tertiary-container'"
              :style="{ width: parseReplicas(row.replicas).percent + '%' }"
            ></div>
          </div>
        </div>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="goDetail(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg transition-all" :title="t('common.edit')">
            <span class="material-symbols-outlined text-lg">edit</span>
          </button>
          <button @click.stop="goDetail(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg transition-all" :title="t('workloads.logs')">
            <span class="material-symbols-outlined text-lg">receipt_long</span>
          </button>
          <button @click.stop="restartWorkload(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg transition-all" :title="t('common.restart')">
            <span class="material-symbols-outlined text-lg">restart_alt</span>
          </button>
        </div>
      </template>
      <template #pagination>
        <span class="text-body-sm text-on-surface-variant">{{ t('workloads.rowsPerPage') }}: {{ pageSize }}</span>
        <Pagination :total="filteredWorkloads.length" :page-size="pageSize" :current-page="currentPage" @page-change="p => currentPage = p" />
      </template>
    </DataTable>

    <!-- Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-lg mt-lg">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <div class="flex justify-between items-start mb-md">
          <span class="material-symbols-outlined text-primary">check_circle</span>
          <span class="text-label-caps text-on-surface-variant">{{ t('workloads.nodeHealth') }}</span>
        </div>
        <h3 class="text-headline-sm font-bold text-on-surface">{{ nodeHealthPct != null ? nodeHealthPct + '%' : '—' }}</h3>
        <p class="text-body-sm text-on-surface-variant mt-1">{{ t('workloads.nodesReady', { healthy: store.healthyNodes, total: store.totalNodes }) }}</p>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <div class="flex justify-between items-start mb-md">
          <span class="material-symbols-outlined text-tertiary-container">memory</span>
          <span class="text-label-caps text-on-surface-variant">{{ t('workloads.cpuUsage') }}</span>
        </div>
        <h3 class="text-headline-sm font-bold text-on-surface">{{ store.cluster.cpuUsage != null ? store.cluster.cpuUsage + '%' : '—' }}</h3>
        <div class="w-full bg-outline-variant/30 h-2 rounded-full mt-2 overflow-hidden">
          <div class="bg-tertiary-container h-full" :style="{ width: (store.cluster.cpuUsage || 0) + '%' }"></div>
        </div>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <div class="flex justify-between items-start mb-md">
          <span class="material-symbols-outlined text-secondary">workspaces</span>
          <span class="text-label-caps text-on-surface-variant">{{ t('ns.workloads.title') }}</span>
        </div>
        <h3 class="text-headline-sm font-bold text-on-surface">{{ workloadList.length }}</h3>
        <p class="text-body-sm text-on-surface-variant mt-1">{{ t('workloads.podsAcrossCluster', { count: store.cluster.podCount }) }}</p>
      </div>
    </div>
  </section>
</template>
