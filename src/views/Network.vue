<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useTableColumns } from '@/composables/useTableColumns'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

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

// 按 tab 切换的当前列表（services / ingress 有 DataTable；endpoints / networkpolicies 为占位）
const currentTabList = computed(() => ({
  services: store.serviceList,
  ingress: store.ingressList,
}[activeTab.value] || []))
const { currentPage, pageSize, paginated, total } = usePagination(currentTabList, { resetDeps: [activeTab] })
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-md">
      <div>
        <h2 class="text-headline-lg text-on-surface font-bold">Network</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">Manage Services, Ingress, Endpoints, and NetworkPolicies.</p>
      </div>
      <div class="flex gap-sm">
        <button @click="newServiceOrIngress" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-base">add</span> New Service
        </button>
        <button @click="newServiceOrIngress" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
          <span class="material-symbols-outlined text-base">add</span> New Ingress
        </button>
      </div>
    </div>

    <div class="flex items-center gap-xs border-b border-outline-variant mb-md">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="px-lg py-2 text-body-sm font-medium transition-colors relative"
        :class="activeTab === tab.key ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'"
      >{{ tab.label }}
        <span v-if="activeTab === tab.key" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"></span>
      </button>
    </div>

    <EmptyState v-if="activeTab === 'services' && !store.serviceList.length" icon="share" title="No services" />
    <DataTable v-if="activeTab === 'services' && store.serviceList.length" :headers="svcHeaders" :rows="paginated">
      <template #name="{ row }">
        <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
      </template>
      <template #type="{ row }">
        <span class="px-1.5 py-0.5 bg-surface-container rounded text-body-xs text-on-surface-variant border border-outline-variant">{{ row.type }}</span>
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
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <EmptyState v-if="activeTab === 'ingress' && !store.ingressList.length" icon="router" title="No ingress rules" />
    <DataTable v-if="activeTab === 'ingress' && store.ingressList.length" :headers="ingressHeaders" :rows="paginated">
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
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <div v-if="activeTab === 'endpoints'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">lan</span>
      <p class="text-body-sm text-on-surface-variant mt-xs">Endpoints are auto-discovered from Services.</p>
    </div>

    <div v-if="activeTab === 'networkpolicies'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">security</span>
      <p class="text-body-sm text-on-surface-variant mt-xs">No NetworkPolicies defined.</p>
      <button @click="newNetworkPolicy" class="mt-md px-3 py-1.5 bg-primary text-on-primary rounded-lg font-semibold text-body-sm">Create NetworkPolicy</button>
    </div>
  </section>
</template>
