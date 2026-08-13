<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useI18n } from 'vue-i18n'
import { useResourceList } from '@/composables/useK8sQuery'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useTableColumns } from '@/composables/useTableColumns'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const { t } = useI18n()
const router = useRouter()
const store = useClusterStore()
const { tableColumns } = useTableColumns()
const activeTab = ref('services')

// Services/Ingresses 走 Vue Query（集群范围）：远端 30s 轮询 + 聚焦重拉 + 新鲜度。
const cid = computed(() => (store.currentCluster || 'cluster'))
const nsQ = useResourceList({ key: ['cluster', cid, 'namespaces'], fetcher: () => store.fetchNamespaces(), options: { refetchInterval: 60000 } })
const allNamespaces = computed(() => nsQ.data.value ?? store.namespaceList)
const servicesQuery = useResourceList({
  key: ['cluster', cid, 'services'],
  fetcher: () => store.fetchServices(),
  options: { refetchInterval: 30000 },
})
const serviceList = computed(() => servicesQuery.data.value || [])
const ingressesQuery = useResourceList({
  key: ['cluster', cid, 'ingresses'],
  fetcher: () => store.fetchIngresses(),
  options: { refetchInterval: 30000 },
})
const ingressList = computed(() => ingressesQuery.data.value || [])

// 全局页无命名空间上下文：New Service/Ingress 走部署向导；NetworkPolicy 进命名空间作用域页创建
function newServiceOrIngress() { router.push('/deploy') }
function newNetworkPolicy() {
  const ns = store.currentNamespace || allNamespaces.value?.[0]?.name || 'default'
  router.push({ name: 'NsNetworkPolicies', params: { namespace: ns } })
}

const tabs = [
  { key: 'services', label: t('network.tabServices') },
  { key: 'ingress', label: t('network.tabIngress') },
  { key: 'endpoints', label: t('network.tabEndpoints') },
  { key: 'networkpolicies', label: t('network.tabNetworkPolicies') },
]

const svcHeaders = computed(() => tableColumns('services'))
const ingressHeaders = computed(() => tableColumns('ingress'))

// 按 tab 切换的当前列表（services / ingress 有 DataTable；endpoints / networkpolicies 为占位）
const currentTabList = computed(() => ({
  services: serviceList.value,
  ingress: ingressList.value,
}[activeTab.value] || []))
const { currentPage, pageSize, paginated, total } = usePagination(currentTabList, { resetDeps: [activeTab] })
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ $t('network.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ $t('network.subtitle') }}</p>
      </div>
      <div class="flex gap-sm">
        <button @click="newServiceOrIngress" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-base">add</span> {{ $t('network.newService') }}
        </button>
        <button @click="newServiceOrIngress" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
          <span class="material-symbols-outlined text-base">add</span> {{ $t('network.newIngress') }}
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

    <EmptyState v-if="activeTab === 'services' && !serviceList.length" icon="share" :title="$t('network.noServices')" />
    <DataTable v-if="activeTab === 'services' && serviceList.length" :headers="svcHeaders" :rows="paginated" column-key="services">
      <template #name="{ row }">
        <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
      </template>
      <template #type="{ row }">
        <span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant">{{ row.type }}</span>
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

    <EmptyState v-if="activeTab === 'ingress' && !ingressList.length" icon="router" :title="$t('network.noIngressRules')" />
    <DataTable v-if="activeTab === 'ingress' && ingressList.length" :headers="ingressHeaders" :rows="paginated" column-key="ingress">
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
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('network.endpointsHint') }}</p>
    </div>

    <div v-if="activeTab === 'networkpolicies'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">security</span>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('network.noNetworkPolicies') }}</p>
      <button @click="newNetworkPolicy" class="mt-md px-3 py-1.5 bg-primary text-on-primary rounded-lg font-semibold text-body-sm">{{ $t('network.createNetworkPolicy') }}</button>
    </div>
  </section>
</template>
