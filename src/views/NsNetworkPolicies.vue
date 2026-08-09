<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useQueryClient } from '@tanstack/vue-query'
import { useTableColumns } from '@/composables/useTableColumns'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import NetworkPolicyEditor from '@/components/networkpolicy/NetworkPolicyEditor.vue'
import { usePagination } from '@/composables/usePagination'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('nsNetworkPolicies'))
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()

// NetworkPolicies 走 Vue Query（cluster-wide + 按 ns 过滤）：远端 30s 轮询 + 聚焦重拉 + 新鲜度。
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const networkpoliciesKey = ['cluster', cid.value, 'networkpolicies']
const networkpoliciesQuery = useResourceList({
  key: networkpoliciesKey,
  fetcher: () => store.fetchNetworkPolicies(),
  mock: store.networkPolicyList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const nsNetworkPolicies = computed(() => (networkpoliciesQuery.data.value || []).filter(n => n.namespace === route.params.namespace))

// Tab-based filter
const activeFilter = ref('all')
const filteredPolicies = computed(() => {
  const all = nsNetworkPolicies.value
  switch (activeFilter.value) {
    case 'ingress':
      return all.filter(np => np.policyTypes.includes('Ingress') && !np.policyTypes.includes('Egress'))
    case 'egress':
      return all.filter(np => np.policyTypes.includes('Egress') && !np.policyTypes.includes('Ingress'))
    case 'both':
      return all.filter(np => np.policyTypes.includes('Ingress') && np.policyTypes.includes('Egress'))
    default:
      return all
  }
})

const { currentPage, pageSize, paginated, total } = usePagination(filteredPolicies, { resetDeps: [activeFilter] })

// Helpers
function podSelectorLabel(sel) {
  if (!sel || Object.keys(sel).length === 0) return 'All Pods'
  return Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(', ')
}

function ruleCount(rules) {
  return rules ? rules.length : 0
}

function goDetail(row) {
  router.push({ name: 'NsNetworkPolicyDetail', params: { namespace: route.params.namespace, name: row.name } })
}

// Create NetworkPolicy
const showCreate = ref(false)
function onApplied() {
  // applyResourceYaml 内部已 invalidate cluster 查询;这里显式再刷一次本页 key 保险。
  queryClient.invalidateQueries({ queryKey: networkpoliciesKey })
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(np) {
  deleteTarget.value = np
  showDeleteModal.value = true
}
async function handleDelete() {
  if (deleteTarget.value) {
    await store.deleteNetworkPolicy(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: networkpoliciesKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'NetworkPolicies' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ t('ns.networkPolicies.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('ns.networkPolicies.subtitle', { count: nsNetworkPolicies.length, ns: route.params.namespace }) }}</p>
      </div>
      <button @click="showCreate = true" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg text-body-sm hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-sm">add</span> Create NetworkPolicy
      </button>
    </div>

    <!-- Filter Tabs -->
    <div v-if="nsNetworkPolicies.length" class="flex border-b border-outline-variant mb-md">
      <button v-for="tab in [
        { key: 'all', label: 'All' },
        { key: 'ingress', label: 'Ingress Only' },
        { key: 'egress', label: 'Egress Only' },
        { key: 'both', label: 'Both' }
      ]" :key="tab.key" @click="activeFilter = tab.key"
        class="px-lg py-2 border-b-2 text-body-sm font-medium transition-colors"
        :class="activeFilter === tab.key ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab.label }}
        <span class="ml-1 text-xs px-1.5 py-0.5 rounded-full" :class="activeFilter === tab.key ? 'bg-primary-container/20 text-primary' : 'bg-surface-container text-on-surface-variant'">
          {{ tab.key === 'all' ? nsNetworkPolicies.length : filteredPolicies.length }}
        </span>
      </button>
    </div>

    <DataTable :headers="headers" :rows="paginated" column-key="nsNetworkPolicies" @row-click="goDetail">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-tertiary text-sm">shield</span>
          <span class="font-semibold text-on-surface text-body-sm">{{ row.name }}</span>
        </div>
      </template>
      <template #podSelector="{ row }">
        <span v-if="Object.keys(row.podSelector || {}).length === 0" class="px-2 py-0.5 bg-tertiary-container/10 text-tertiary text-xs rounded-full">All Pods</span>
        <div v-else class="flex flex-wrap gap-xs max-w-xs">
          <span v-for="(val, key) in row.podSelector" :key="key" class="px-1.5 py-0.5 bg-primary-container/10 text-primary text-xs rounded">{{ key }}={{ val }}</span>
        </div>
      </template>
      <template #policyTypes="{ row }">
        <div class="flex gap-xs">
          <span v-for="pt in row.policyTypes" :key="pt" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
            :class="pt === 'Ingress' ? 'bg-primary-container/10 text-primary border border-primary/20' : 'bg-tertiary-container/10 text-tertiary border border-tertiary/20'">
            <span class="material-symbols-outlined text-xs">{{ pt === 'Ingress' ? 'arrow_downward' : 'arrow_upward' }}</span>
            {{ pt }}
          </span>
        </div>
      </template>
      <template #ingressRules="{ row }">
        <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold border border-outline-variant"
          :class="ruleCount(row.ingressRules) > 0 ? 'bg-primary-container/10 text-primary' : 'bg-surface-container text-on-surface-variant'">
          {{ ruleCount(row.ingressRules) }}
        </span>
      </template>
      <template #egressRules="{ row }">
        <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold border border-outline-variant"
          :class="ruleCount(row.egressRules) > 0 ? 'bg-tertiary-container/10 text-tertiary' : 'bg-surface-container text-on-surface-variant'">
          {{ ruleCount(row.egressRules) }}
        </span>
      </template>
      <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
      <template #actions="{ row }">
        <div class="flex gap-1 justify-end">
          <button @click.stop="goDetail(row)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined text-sm">open_in_new</span>
          </button>
          <button @click.stop="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg">
            <span class="material-symbols-outlined text-sm">delete</span>
          </button>
        </div>
      </template>
      <template v-if="filteredPolicies.length" #pagination>
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>

  <!-- 创建向导 -->
  <NetworkPolicyEditor v-model="showCreate" :namespace="route.params.namespace" @applied="onApplied" />

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete NetworkPolicy" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete NetworkPolicy <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Removing this policy may expose pods to unintended network traffic. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
