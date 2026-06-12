<script setup>
import { ref } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'

const store = useClusterStore()
const activeTab = ref('services')

const tabs = [
  { key: 'services', label: 'Services' },
  { key: 'ingress', label: 'Ingress' },
  { key: 'endpoints', label: 'Endpoints' },
  { key: 'networkpolicies', label: 'NetworkPolicies' },
]

const svcHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'type', label: 'Type' },
  { key: 'clusterIP', label: 'Cluster IP' },
  { key: 'externalIP', label: 'External IP' },
  { key: 'ports', label: 'Ports' },
  { key: 'age', label: 'Age' },
]

const ingressHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'hosts', label: 'Hosts' },
  { key: 'path', label: 'Path' },
  { key: 'backend', label: 'Backend' },
  { key: 'tls', label: 'TLS' },
  { key: 'age', label: 'Age' },
]
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Network</h2>
        <p class="text-on-surface-variant text-body-md mt-1">Manage Services, Ingress, Endpoints, and NetworkPolicies.</p>
      </div>
      <div class="flex gap-sm">
        <button class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container">
          <span class="material-symbols-outlined">add</span> New Service
        </button>
        <button class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90">
          <span class="material-symbols-outlined">add</span> New Ingress
        </button>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors"
        :class="activeTab === tab.key ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'"
      >{{ tab.label }}</button>
    </div>

    <DataTable v-if="activeTab === 'services'" :headers="svcHeaders" :rows="store.serviceList">
      <template #name="{ row }">
        <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
      </template>
      <template #type="{ row }">
        <span class="px-2 py-0.5 bg-surface-container rounded-full text-label-caps text-on-surface-variant border border-outline-variant">{{ row.type }}</span>
      </template>
      <template #clusterIP="{ row }">
        <span class="font-mono text-code-sm">{{ row.clusterIP }}</span>
      </template>
      <template #externalIP="{ row }">
        <span class="font-mono text-code-sm" :class="row.externalIP !== '-' ? 'text-primary' : 'text-on-surface-variant'">{{ row.externalIP }}</span>
      </template>
      <template #ports="{ row }">
        <span class="font-mono text-code-sm">{{ row.ports }}</span>
      </template>
    </DataTable>

    <DataTable v-if="activeTab === 'ingress'" :headers="ingressHeaders" :rows="store.ingressList">
      <template #name="{ row }">
        <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
      </template>
      <template #hosts="{ row }">
        <span class="font-mono text-code-sm text-primary">{{ row.hosts }}</span>
      </template>
      <template #backend="{ row }">
        <span class="font-mono text-code-sm">{{ row.backend }}</span>
      </template>
      <template #tls="{ row }">
        <span class="material-symbols-outlined" :class="row.tls ? 'text-primary' : 'text-outline-variant'">{{ row.tls ? 'lock' : 'lock_open' }}</span>
      </template>
    </DataTable>

    <div v-if="activeTab === 'endpoints'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-2xl text-center">
      <span class="material-symbols-outlined text-5xl text-surface-container-high">lan</span>
      <p class="text-on-surface-variant mt-md">Endpoints are auto-discovered from Services.</p>
    </div>

    <div v-if="activeTab === 'networkpolicies'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-2xl text-center">
      <span class="material-symbols-outlined text-5xl text-surface-container-high">security</span>
      <p class="text-on-surface-variant mt-md">No NetworkPolicies defined.</p>
      <button class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Create NetworkPolicy</button>
    </div>
  </section>
</template>
