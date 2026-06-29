<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'

const router = useRouter()
const store = useClusterStore()

const searchQuery = ref('')
const filtered = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return store.nodeList
  return store.nodeList.filter(n => n.name.toLowerCase().includes(q) || (n.roles || '').toLowerCase().includes(q) || (n.ip || '').toLowerCase().includes(q))
})

const headers = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'roles', label: 'Role' },
  { key: 'cpu', label: 'CPU' },
  { key: 'memory', label: 'Memory' },
  { key: 'version', label: 'Version' },
  { key: 'age', label: 'Age' },
  { key: 'actions', label: 'Actions', align: 'right' },
]
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Nodes</h2>
        <p class="text-on-surface-variant text-body-md mt-1">Monitor and manage cluster nodes. {{ store.healthyNodes }} of {{ store.totalNodes }} healthy.</p>
      </div>
      <div class="flex gap-sm">
        <button class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">refresh</span> Sync
        </button>
      </div>
    </div>

    <!-- 搜索框 -->
    <div class="flex items-center gap-md mb-lg">
      <div class="relative flex-1 max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" placeholder="按名称、角色或 IP 搜索..." />
        <button v-if="searchQuery" @click="searchQuery = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"><span class="material-symbols-outlined text-lg">close</span></button>
      </div>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ store.nodeList.length }}</span>
    </div>

    <DataTable :headers="headers" :rows="filtered" @row-click="(row) => router.push(`/nodes/${row.name}`)">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <div class="w-8 h-8 rounded bg-surface-container flex items-center justify-center text-on-surface-variant">
            <span class="material-symbols-outlined">dns</span>
          </div>
          <div>
            <span class="font-semibold text-on-surface text-body-md block">{{ row.name }}</span>
            <span class="font-mono text-code-sm text-on-surface-variant">{{ row.ip }}</span>
          </div>
        </div>
      </template>
      <template #status="{ row }">
        <StatusChip :status="row.status === 'Ready' ? 'Ready' : 'NotReady'" />
      </template>
      <template #roles="{ row }">
        <span class="px-2 py-0.5 bg-surface-container rounded-full text-label-caps text-on-surface-variant border border-outline-variant">{{ row.roles }}</span>
      </template>
      <template #cpu="{ row }">
        <div class="w-24">
          <ProgressBar :value="row.cpu" :show-label="true" />
        </div>
      </template>
      <template #memory="{ row }">
        <div class="w-24">
          <ProgressBar :value="row.memory" :show-label="true" />
        </div>
      </template>
      <template #version="{ row }">
        <span class="font-mono text-code-sm text-on-surface-variant">{{ row.version }}</span>
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
    </DataTable>
  </section>
</template>
