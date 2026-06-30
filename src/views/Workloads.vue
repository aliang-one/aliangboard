<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import Pagination from '@/components/common/Pagination.vue'

const router = useRouter()
const store = useClusterStore()

const namespaceFilter = ref('All Namespaces')
const typeFilter = ref('All Types')
const statusFilter = ref('All Statuses')

const filters = [
  { key: 'namespace', label: 'Namespace', options: ['All Namespaces', ...store.namespaceList.map(n => n.name)] },
  { key: 'type', label: 'Workload Type', options: ['All Types', 'Deployment', 'Pod', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'] },
  { key: 'status', label: 'Status', options: ['All Statuses', 'Running', 'Pending', 'Failed', 'Succeeded'] },
]

const filteredWorkloads = computed(() => {
  let list = store.workloadList
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

const headers = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'status', label: 'Status' },
  { key: 'replicas', label: 'Replicas' },
  { key: 'actions', label: 'Actions', align: 'right' },
]

function parseReplicas(rep) {
  const [current, total] = rep.split('/').map(Number)
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
</script>

<template>
  <section class="animate-fade-in">
    <!-- Header -->
    <div class="flex flex-col gap-md mb-lg">
      <div class="flex justify-between items-end">
        <div>
          <h2 class="text-display-lg text-on-surface">Workloads</h2>
          <p class="text-on-surface-variant text-body-md mt-1">Manage and monitor your containerized applications across all namespaces.</p>
        </div>
        <div class="flex gap-sm">
          <button class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
            <span class="material-symbols-outlined">file_download</span> Export
          </button>
          <router-link to="/deploy" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90">
            <span class="material-symbols-outlined">rocket_launch</span> New Workload
          </router-link>
        </div>
      </div>

      <!-- Filters -->
      <FilterBar :filters="filters" :result-count="filteredWorkloads.length" result-label="workloads" />
    </div>

    <!-- Table -->
    <DataTable :headers="headers" :rows="filteredWorkloads" @row-click="goDetail">
      <template #name="{ row }">
        <div class="flex flex-col">
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
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
          <button class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg transition-all" title="Edit">
            <span class="material-symbols-outlined text-lg">edit</span>
          </button>
          <button class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg transition-all" title="Logs">
            <span class="material-symbols-outlined text-lg">receipt_long</span>
          </button>
          <button class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg transition-all" title="Restart">
            <span class="material-symbols-outlined text-lg">restart_alt</span>
          </button>
        </div>
      </template>
      <template #pagination>
        <span class="text-body-sm text-on-surface-variant">Rows per page: 10</span>
        <Pagination :total="filteredWorkloads.length" />
      </template>
    </DataTable>

    <!-- Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-lg mt-lg">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <div class="flex justify-between items-start mb-md">
          <span class="material-symbols-outlined text-primary">check_circle</span>
          <span class="text-label-caps text-on-surface-variant">Health</span>
        </div>
        <h3 class="text-headline-sm font-bold text-on-surface">92.4%</h3>
        <p class="text-body-sm text-on-surface-variant mt-1">Global uptime across nodes</p>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <div class="flex justify-between items-start mb-md">
          <span class="material-symbols-outlined text-tertiary-container">memory</span>
          <span class="text-label-caps text-on-surface-variant">CPU Usage</span>
        </div>
        <h3 class="text-headline-sm font-bold text-on-surface">45.2%</h3>
        <div class="w-full bg-outline-variant/30 h-2 rounded-full mt-2 overflow-hidden">
          <div class="bg-tertiary-container h-full" style="width: 45%"></div>
        </div>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <div class="flex justify-between items-start mb-md">
          <span class="material-symbols-outlined text-secondary">database</span>
          <span class="text-label-caps text-on-surface-variant">Storage</span>
        </div>
        <h3 class="text-headline-sm font-bold text-on-surface">1.2 TB</h3>
        <p class="text-body-sm text-on-surface-variant mt-1">Available cluster capacity</p>
      </div>
    </div>
  </section>
</template>
