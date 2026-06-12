<script setup>
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'

const router = useRouter()
const store = useClusterStore()

const headers = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'pods', label: 'Pods' },
  { key: 'services', label: 'Services' },
  { key: 'age', label: 'Age' },
  { key: 'actions', label: 'Actions', align: 'right' },
]
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex flex-col gap-md mb-lg">
      <div class="flex justify-between items-end">
        <div>
          <div class="flex items-center gap-sm text-on-surface-variant mb-sm">
            <span class="material-symbols-outlined text-lg">folder_open</span>
            <span class="text-label-caps uppercase tracking-wider">Namespace Explorer</span>
          </div>
          <h2 class="text-display-lg text-on-surface">Namespaces</h2>
          <p class="text-on-surface-variant text-body-md mt-1">Browse and manage Kubernetes namespaces.</p>
        </div>
        <div class="flex gap-sm">
          <button class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
            <span class="material-symbols-outlined">refresh</span> Sync
          </button>
          <button class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90">
            <span class="material-symbols-outlined">add</span> New Namespace
          </button>
        </div>
      </div>
    </div>

    <DataTable :headers="headers" :rows="store.namespaceList" @row-click="(row) => router.push(`/namespaces/${row.name}`)">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <div class="w-8 h-8 rounded-lg bg-primary-container/20 flex items-center justify-center">
            <span class="material-symbols-outlined text-primary text-lg">folder</span>
          </div>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #status="{ row }">
        <StatusChip :status="row.status" />
      </template>
      <template #pods="{ row }">
        <span class="font-mono text-code-sm font-bold">{{ row.pods }}</span>
      </template>
      <template #services="{ row }">
        <span class="font-mono text-code-sm font-bold">{{ row.services }}</span>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg transition-all" title="Edit YAML">
            <span class="material-symbols-outlined text-lg">edit</span>
          </button>
          <button class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg transition-all" title="Delete">
            <span class="material-symbols-outlined text-lg">delete</span>
          </button>
        </div>
      </template>
    </DataTable>
  </section>
</template>
