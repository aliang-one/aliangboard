<script setup>
import { ref } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'

const store = useClusterStore()
const activeTab = ref('pvc')

const tabs = [
  { key: 'pvc', label: 'PersistentVolumeClaims' },
  { key: 'pv', label: 'PersistentVolumes' },
  { key: 'sc', label: 'StorageClasses' },
]

const pvcHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'status', label: 'Status' },
  { key: 'capacity', label: 'Capacity' },
  { key: 'accessModes', label: 'Access' },
  { key: 'storageClass', label: 'StorageClass' },
  { key: 'age', label: 'Age' },
]

const pvHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'capacity', label: 'Capacity' },
  { key: 'accessModes', label: 'Access' },
  { key: 'reclaimPolicy', label: 'Reclaim' },
  { key: 'status', label: 'Status' },
  { key: 'claim', label: 'Claim' },
  { key: 'storageClass', label: 'StorageClass' },
]

const scHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'provisioner', label: 'Provisioner' },
  { key: 'reclaimPolicy', label: 'Reclaim Policy' },
  { key: 'default', label: 'Default' },
  { key: 'age', label: 'Age' },
]
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Storage</h2>
        <p class="text-on-surface-variant text-body-md mt-1">Manage persistent storage, volumes, and storage classes.</p>
      </div>
      <button class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90">
        <span class="material-symbols-outlined">add</span> New PVC
      </button>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        @click="activeTab = tab.key"
        class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors"
        :class="activeTab === tab.key ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'"
      >{{ tab.label }}</button>
    </div>

    <!-- PVC Tab -->
    <DataTable v-if="activeTab === 'pvc'" :headers="pvcHeaders" :rows="store.pvcList">
      <template #name="{ row }">
        <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
      </template>
      <template #status="{ row }">
        <StatusChip :status="row.status" />
      </template>
      <template #storageClass="{ row }">
        <span class="px-2 py-0.5 bg-surface-container rounded text-body-sm border border-outline-variant">{{ row.storageClass }}</span>
      </template>
    </DataTable>

    <!-- PV Tab -->
    <DataTable v-if="activeTab === 'pv'" :headers="pvHeaders" :rows="store.pvList">
      <template #name="{ row }">
        <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
      </template>
      <template #status="{ row }">
        <StatusChip :status="row.status" />
      </template>
      <template #claim="{ row }">
        <span class="font-mono text-code-sm text-primary">{{ row.claim || '-' }}</span>
      </template>
    </DataTable>

    <!-- SC Tab -->
    <DataTable v-if="activeTab === 'sc'" :headers="scHeaders" :rows="store.scList">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
          <span v-if="row.default" class="px-2 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded">DEFAULT</span>
        </div>
      </template>
      <template #default="{ row }">
        <span class="material-symbols-outlined" :class="row.default ? 'text-primary' : 'text-outline-variant'">{{ row.default ? 'check_circle' : 'radio_button_unchecked' }}</span>
      </template>
    </DataTable>
  </section>
</template>
