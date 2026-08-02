<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useTableColumns } from '@/composables/useTableColumns'

const router = useRouter()
const store = useClusterStore()
const { tableColumns } = useTableColumns()
const activeTab = ref('services')

// 全局页无命名空间上下文：New Service/Ingress 走部署向导；NetworkPolicy 进命名空间作用域页创建
function newServiceOrIngress() { router.push('/deploy') }
function newNetworkPolicy() {
  const ns = store.currentNamespace || store.namespaceList?.[0]?.name || 'default'
  router.push({ name: 'NsNetworkPolicies', params: { namespace: ns } })
}

const tabs = [
  { key: 'services', label: 'Services' },
  { key: 'ingress', label: 'Ingress' },
  { key: 'endpoints', label: 'Endpoints' },
  { key: 'networkpolicies', label: 'NetworkPolicies' },
]

const svcHeaders = computed(() => tableColumns('services'))
const ingressHeaders = computed(() => tableColumns('ingress'))
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Network</h2>
        <p class="text-on-surface-variant text-body-md mt-1">Manage Services, Ingress, Endpoints, and NetworkPolicies.</p>
      </div>
      <div class="flex gap-sm">
        <button @click="newServiceOrIngress" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container">
          <span class="material-symbols-outlined">add</span> New Service
        </button>
        <button @click="newServiceOrIngress" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90">
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

    <EmptyState v-if="activeTab === 'services' && !store.serviceList.length" icon="share" title="No services" />
    <DataTable v-if="activeTab === 'services' && store.serviceList.length" :headers="svcHeaders" :rows="store.serviceList">
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

    <EmptyState v-if="activeTab === 'ingress' && !store.ingressList.length" icon="router" title="No ingress rules" />
    <DataTable v-if="activeTab === 'ingress' && store.ingressList.length" :headers="ingressHeaders" :rows="store.ingressList">
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
      <button @click="newNetworkPolicy" class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Create NetworkPolicy</button>
    </div>
  </section>
</template>
