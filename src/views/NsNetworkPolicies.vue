<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useQueryClient } from '@tanstack/vue-query'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
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
  const all = nsNetworkPolicies
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

// Create NetworkPolicy
const showCreateModal = ref(false)
const createForm = ref({
  name: '',
  podSelectorKey: '',
  podSelectorValue: '',
  policyTypes: ['Ingress', 'Egress'],
})

function resetCreate() {
  createForm.value = { name: '', podSelectorKey: '', podSelectorValue: '', policyTypes: ['Ingress', 'Egress'] }
}

function togglePolicyType(type) {
  const idx = createForm.value.policyTypes.indexOf(type)
  if (idx >= 0) {
    createForm.value.policyTypes.splice(idx, 1)
  } else {
    createForm.value.policyTypes.push(type)
  }
}

function handleCreate() {
  const f = createForm.value
  const podSelector = {}
  if (f.podSelectorKey) {
    podSelector[f.podSelectorKey] = f.podSelectorValue
  }
  store.addNetworkPolicy({
    name: f.name,
    namespace: route.params.namespace,
    podSelector,
    policyTypes: [...f.policyTypes],
    ingressRules: f.policyTypes.includes('Ingress') ? [] : [],
    egressRules: f.policyTypes.includes('Egress') ? [] : [],
  })
  queryClient.invalidateQueries({ queryKey: networkpoliciesKey })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(np) {
  deleteTarget.value = np
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteNetworkPolicy(deleteTarget.value.name, route.params.namespace)
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
        <h2 class="text-headline-md text-on-surface font-bold">NetworkPolicies</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ nsNetworkPolicies.length }} network policies in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg text-body-sm hover:opacity-90 transition-opacity">
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

    <div v-if="nsNetworkPolicies.length">
      <div v-if="filteredPolicies.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Name</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Pod Selector</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Policy Types</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Ingress Rules</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Egress Rules</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Age</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant w-24">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/15">
            <tr v-for="row in paginated" :key="row.name" class="hover:bg-surface-container-low/40 cursor-pointer transition-colors" @click="router.push({ name: 'NsNetworkPolicyDetail', params: { namespace: route.params.namespace, name: row.name } })">
              <td class="px-md py-2">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-tertiary text-sm">shield</span>
                  <span class="font-semibold text-on-surface text-body-sm">{{ row.name }}</span>
                </div>
              </td>
              <td class="px-md py-2">
                <span v-if="Object.keys(row.podSelector || {}).length === 0" class="px-2 py-0.5 bg-tertiary-container/10 text-tertiary text-xs rounded-full">All Pods</span>
                <div v-else class="flex flex-wrap gap-xs max-w-xs">
                  <span v-for="(val, key) in row.podSelector" :key="key" class="px-1.5 py-0.5 bg-primary-container/10 text-primary text-xs rounded">{{ key }}={{ val }}</span>
                </div>
              </td>
              <td class="px-md py-2">
                <div class="flex gap-xs">
                  <span v-for="pt in row.policyTypes" :key="pt" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                    :class="pt === 'Ingress' ? 'bg-primary-container/10 text-primary border border-primary/20' : 'bg-tertiary-container/10 text-tertiary border border-tertiary/20'">
                    <span class="material-symbols-outlined text-xs">{{ pt === 'Ingress' ? 'arrow_downward' : 'arrow_upward' }}</span>
                    {{ pt }}
                  </span>
                </div>
              </td>
              <td class="px-md py-2">
                <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold border border-outline-variant"
                  :class="ruleCount(row.ingressRules) > 0 ? 'bg-primary-container/10 text-primary' : 'bg-surface-container text-on-surface-variant'">
                  {{ ruleCount(row.ingressRules) }}
                </span>
              </td>
              <td class="px-md py-2">
                <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold border border-outline-variant"
                  :class="ruleCount(row.egressRules) > 0 ? 'bg-tertiary-container/10 text-tertiary' : 'bg-surface-container text-on-surface-variant'">
                  {{ ruleCount(row.egressRules) }}
                </span>
              </td>
              <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ row.age }}</td>
              <td class="px-md py-2" @click.stop>
                <div class="flex gap-1">
                  <button @click="router.push({ name: 'NsNetworkPolicyDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg">
                    <span class="material-symbols-outlined text-sm">open_in_new</span>
                  </button>
                  <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg">
                    <span class="material-symbols-outlined text-sm">delete</span>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="total > pageSize" class="flex items-center justify-between px-md py-2 border-t border-outline-variant bg-surface-container-low">
          <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
        </div>
      </div>
      <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-center">
        <span class="material-symbols-outlined text-2xl text-surface-container-high">filter_list_off</span>
        <p class="text-on-surface-variant text-body-sm mt-xs">No NetworkPolicies match the selected filter</p>
      </div>
    </div>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">shield</span>
      <p class="text-on-surface-variant text-body-sm mt-xs">No NetworkPolicies in this namespace</p>
      <button @click="showCreateModal = true" class="mt-xs px-3 py-1.5 bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">Create NetworkPolicy</button>
    </div>
  </section>

  <!-- Create NetworkPolicy Modal -->
  <Modal v-model="showCreateModal" title="Create NetworkPolicy" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">NetworkPolicy Name *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-network-policy" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-sm">Pod Selector</label>
        <div class="flex gap-sm items-center">
          <input v-model="createForm.podSelectorKey" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="key (e.g. app)" />
          <input v-model="createForm.podSelectorValue" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="value (e.g. frontend)" />
        </div>
        <p class="text-label-caps text-on-surface-variant mt-xs">Leave empty to select all pods in namespace</p>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-sm">Policy Types *</label>
        <div class="flex gap-md">
          <label class="flex items-center gap-sm cursor-pointer">
            <input type="checkbox" :checked="createForm.policyTypes.includes('Ingress')" @change="togglePolicyType('Ingress')" class="rounded text-primary h-4 w-4" />
            <span class="text-body-md font-medium text-on-surface">Ingress</span>
          </label>
          <label class="flex items-center gap-sm cursor-pointer">
            <input type="checkbox" :checked="createForm.policyTypes.includes('Egress')" @change="togglePolicyType('Egress')" class="rounded text-primary h-4 w-4" />
            <span class="text-body-md font-medium text-on-surface">Egress</span>
          </label>
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleCreate" :disabled="!createForm.name || createForm.policyTypes.length === 0" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
    </template>
  </Modal>

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
