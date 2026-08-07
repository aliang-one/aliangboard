<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useQueryClient } from '@tanstack/vue-query'
import StatusChip from '@/components/common/StatusChip.vue'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()

// PVCs 走 Vue Query（cluster-wide + 按 ns 过滤）：远端 30s 轮询 + 聚焦重拉 + 新鲜度。
// StorageClasses 仍读 store.scList（集群级，变化少，留 store）。
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const pvcsKey = ['cluster', cid.value, 'pvcs']
const pvcsQuery = useResourceList({
  key: pvcsKey,
  fetcher: () => store.fetchPVCs(),
  mock: store.pvcList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const nsPVCs = computed(() => (pvcsQuery.data.value || []).filter(p => p.namespace === route.params.namespace))

const activeTab = ref('pvc')

const boundCount = computed(() => nsPVCs.value.filter(p => p.status === 'Bound').length)
const pendingCount = computed(() => nsPVCs.value.filter(p => p.status === 'Pending').length)

// 搜索过滤
const searchQuery = ref('')
const filteredPVCs = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return nsPVCs
  return nsPVCs.value.filter(p => p.name.toLowerCase().includes(q) || (p.storageClass || '').toLowerCase().includes(q))
})

const { currentPage, pageSize, paginated, total } = usePagination(filteredPVCs, { resetDeps: [searchQuery] })

// Create PVC
const showCreatePVC = ref(false)
const createForm = ref({
  name: '',
  capacity: '10Gi',
  accessModes: 'RWO',
  storageClass: '',
})

function resetCreate() {
  createForm.value = { name: '', capacity: '10Gi', accessModes: 'RWO', storageClass: '' }
}

function handleCreatePVC() {
  const f = createForm.value
  store.addPVC({
    name: f.name,
    namespace: route.params.namespace,
    status: 'Pending',
    capacity: f.capacity,
    accessModes: f.accessModes,
    storageClass: f.storageClass || store.scList.find(s => s.default)?.name || 'standard',
    volume: '',
    age: 'Just now',
  })
  queryClient.invalidateQueries({ queryKey: pvcsKey })
  showCreatePVC.value = false
  resetCreate()
}

// Delete PVC
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(pvc) {
  deleteTarget.value = pvc
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deletePVC(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: pvcsKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

const accessModeLabels = { RWO: 'ReadWriteOnce', RWM: 'ReadWriteMany', ROM: 'ReadOnlyMany' }
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: t('ns.storage.title') }
    ]" />

    <!-- Tabs -->
    <div class="flex items-center gap-xs border-b border-outline-variant mb-md mt-sm">
      <button @click="activeTab = 'pvc'" class="px-lg py-2 text-body-sm font-medium transition-colors relative" :class="activeTab === 'pvc' ? 'text-primary font-bold' : 'text-on-surface-variant hover:text-on-surface'">
        {{ t('ns.storage.pvcTab') }} ({{ nsPVCs.length }})
        <span v-if="activeTab === 'pvc'" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"></span>
      </button>
      <button @click="activeTab = 'storageclass'" class="px-lg py-2 text-body-sm font-medium transition-colors relative" :class="activeTab === 'storageclass' ? 'text-primary font-bold' : 'text-on-surface-variant hover:text-on-surface'">
        {{ t('ns.storage.storageClassTab') }} ({{ store.scList.length }})
        <span v-if="activeTab === 'storageclass'" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"></span>
      </button>
    </div>

    <!-- PVC Tab -->
    <div v-if="activeTab === 'pvc'">
      <div class="flex justify-between items-end mb-md">
        <div>
          <h2 class="text-headline-md font-bold text-on-surface">{{ t('ns.storage.pvcTab') }}</h2>
          <p class="text-body-sm text-on-surface-variant mt-1">{{ t('ns.storage.pvcCount', { n: nsPVCs.length }) }} <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
        </div>
        <button @click="showCreatePVC = true" class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined">add</span> {{ t('ns.storage.newPVC') }}
        </button>
      </div>

      <!-- Summary -->
      <div class="grid grid-cols-2 gap-sm mb-md">
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant px-sm py-1.5 flex items-center gap-sm">
          <span class="w-2.5 h-2.5 rounded-full bg-primary"></span>
          <span class="text-body-sm text-on-surface-variant">{{ t('ns.storage.bound') }}</span>
          <span class="text-body-md font-bold text-primary ml-auto">{{ boundCount }}</span>
        </div>
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant px-sm py-1.5 flex items-center gap-sm">
          <span class="w-2.5 h-2.5 rounded-full bg-tertiary-container"></span>
          <span class="text-body-sm text-on-surface-variant">{{ t('ns.storage.pending') }}</span>
          <span class="text-body-md font-bold text-tertiary-container ml-auto">{{ pendingCount }}</span>
        </div>
      </div>

      <!-- 搜索框 -->
      <div class="flex items-center gap-md mb-md">
        <div class="relative flex-1 max-w-md">
          <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
          <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" :placeholder="t('ns.storage.searchPlaceholder')" />
          <button v-if="searchQuery" @click="searchQuery = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"><span class="material-symbols-outlined text-lg">close</span></button>
        </div>
        <span class="text-body-sm text-on-surface-variant">{{ filteredPVCs.length }} / {{ nsPVCs.length }}</span>
      </div>

      <div v-if="filteredPVCs.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Name</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Status</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Capacity</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Access</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">StorageClass</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Volume</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Age</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant w-24">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/15">
            <tr v-for="row in paginated" :key="row.name" class="hover:bg-surface-container-low/40 cursor-pointer transition-colors" @click="router.push({ name: 'NsPVCDetail', params: { namespace: route.params.namespace, name: row.name } })">
              <td class="px-md py-2">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-primary text-lg">storage</span>
                  <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
                </div>
              </td>
              <td class="px-md py-2"><StatusChip :status="row.status" size="sm" /></td>
              <td class="px-md py-2 font-mono text-code-sm font-semibold">{{ row.capacity }}</td>
              <td class="px-md py-2"><span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant" :title="accessModeLabels[row.accessModes] || row.accessModes">{{ row.accessModes }}</span></td>
              <td class="px-md py-2"><span class="px-1.5 py-0.5 bg-surface-container rounded text-body-sm border border-outline-variant">{{ row.storageClass }}</span></td>
              <td class="px-md py-2"><span class="font-mono text-code-sm text-primary">{{ row.volume || '-' }}</span></td>
              <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ row.age }}</td>
              <td class="px-md py-2" @click.stop>
                <div class="flex gap-1">
                  <button @click="router.push({ name: 'NsPVCDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-lg">open_in_new</span></button>
                  <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
                </div>
              </td>
            </tr>
            <tr v-if="!filteredPVCs.length">
              <td :colspan="8" class="px-md py-md text-center">
                <span class="material-symbols-outlined text-2xl text-surface-container-high block mb-sm">inbox</span>
                <p class="text-body-sm text-on-surface-variant">{{ t('ns.storage.noData') }}</p>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="total > pageSize" class="flex items-center justify-between px-md py-md border-t border-outline-variant bg-surface-container-low">
          <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
        </div>
      </div>
      <div v-else class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md text-center">
        <span class="material-symbols-outlined text-2xl text-surface-container-high">storage</span>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('ns.storage.noPVCsInNs') }}</p>
        <button @click="showCreatePVC = true" class="mt-md px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90">{{ t('ns.storage.createPVC') }}</button>
      </div>
    </div>

    <!-- StorageClass Tab -->
    <div v-if="activeTab === 'storageclass'">
      <div class="flex justify-between items-end mb-md">
        <div>
          <h2 class="text-headline-md font-bold text-on-surface">{{ t('ns.storage.storageClassTab') }}</h2>
          <p class="text-body-sm text-on-surface-variant mt-1">{{ t('ns.storage.clusterWide') }}</p>
        </div>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Name</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Provisioner</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Parameters</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Reclaim Policy</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Default</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Age</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/15">
            <tr v-for="sc in store.scList" :key="sc.name" class="hover:bg-surface-container-low/40 transition-colors cursor-pointer" @click="router.push({ name: 'StorageClassDetail', params: { name: sc.name } })">
              <td class="px-md py-2">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">database</span>
                  <span class="font-semibold text-on-surface text-body-md">{{ sc.name }}</span>
                </div>
              </td>
              <td class="px-md py-2 font-mono text-code-sm text-on-surface-variant">{{ sc.provisioner }}</td>
              <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ sc.parameters }}</td>
              <td class="px-md py-2"><span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant">{{ sc.reclaimPolicy }}</span></td>
              <td class="px-md py-2">
                <span v-if="sc.default" class="flex items-center gap-xs text-primary">
                  <span class="material-symbols-outlined text-lg">check_circle</span> Yes
                </span>
                <span v-else class="text-on-surface-variant">—</span>
              </td>
              <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ sc.age }}</td>
            </tr>
            <tr v-if="!store.scList.length">
              <td :colspan="6" class="px-md py-md text-center">
                <span class="material-symbols-outlined text-2xl text-surface-container-high block mb-sm">inbox</span>
                <p class="text-body-sm text-on-surface-variant">{{ t('ns.storage.noData') }}</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- Create PVC Modal -->
  <Modal v-model="showCreatePVC" :title="t('ns.storage.createPVC')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.pvcName') }} *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" :placeholder="t('ns.storage.pvcName')" />
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.capacity') }} *</label>
          <input v-model="createForm.capacity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" :placeholder="t('ns.storage.capacity')" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.accessMode') }}</label>
          <select v-model="createForm.accessModes" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option value="RWO">ReadWriteOnce</option>
            <option value="RWM">ReadWriteMany</option>
            <option value="ROM">ReadOnlyMany</option>
          </select>
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.storageClass') }}</label>
        <select v-model="createForm.storageClass" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
          <option value="">{{ t('ns.storage.defaultOption') }}</option>
          <option v-for="sc in store.scList" :key="sc.name" :value="sc.name">{{ sc.name }}{{ sc.default ? ' (default)' : '' }}</option>
        </select>
      </div>
    </div>
    <template #actions>
      <button @click="showCreatePVC = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleCreatePVC" :disabled="!createForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('common.create') }}</button>
    </template>
  </Modal>

  <!-- Delete PVC Modal -->
  <Modal v-model="showDeleteModal" :title="t('ns.storage.deletePVC')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('ns.storage.deletePVCConfirm', { name: deleteTarget?.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.storage.deletePVCWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>
</template>
