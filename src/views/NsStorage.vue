<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useQueryClient } from '@tanstack/vue-query'
import { useTableColumns } from '@/composables/useTableColumns'
import StatusChip from '@/components/common/StatusChip.vue'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import { usePagination } from '@/composables/usePagination'
import { usePvcUsage } from '@/composables/usePvcUsage'
import { formatBytes } from '@/utils/bytes'
import { useI18n } from 'vue-i18n'
import CreateWithYamlButton from '@/components/common/CreateWithYamlButton.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()
const { t } = useI18n()
const { tableColumns } = useTableColumns()
const pvcHeaders = computed(() => tableColumns('nsStoragePVC'))
const scHeaders = computed(() => tableColumns('nsStorageSC'))
const usageQ = usePvcUsage(route.params.namespace)
const noStatsAccess = computed(() => !!usageQ.data.value?.noStatsAccess)

// cluster id（取 currentCluster）；供 useResourceList key 用，须先于任何 key 声明，否则 TDZ
const cid = computed(() => (store.currentCluster || 'cluster'))
// PVCs 走 Vue Query（cluster-wide + 按 ns 过滤）：远端 30s 轮询 + 聚焦重拉 + 新鲜度。
// StorageClasses 走 Vue Query（cluster-wide）
const scQ = useResourceList({ key: ['cluster', cid, 'storageclasses'], fetcher: () => store.fetchStorageClasses(), options: { refetchInterval: 30000 } })
const allSCs = computed(() => scQ.data.value || [])
const pvcsKey = ['cluster', cid, 'pvcs']
const pvcsQuery = useResourceList({
  key: pvcsKey,
  fetcher: () => store.fetchPVCs(),
  options: { refetchInterval: 30000 },
})
const nsPVCs = computed(() => (pvcsQuery.data.value || []).filter(p => p.namespace === route.params.namespace))

const activeTab = ref('pvc')

const boundCount = computed(() => nsPVCs.value.filter(p => p.status === 'Bound').length)
const pendingCount = computed(() => nsPVCs.value.filter(p => p.status === 'Pending').length)

// 搜索过滤
const searchQuery = ref('')
const filteredPVCs = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return nsPVCs.value
  return nsPVCs.value.filter(p => p.name.toLowerCase().includes(q) || (p.storageClass || '').toLowerCase().includes(q))
})

const { currentPage, pageSize, paginated, total } = usePagination(filteredPVCs, { resetDeps: [searchQuery] })

// 合并 PVC 用量(rows → DataTable)。usageQ 来自 usePvcUsage(Task 2),按 claimName 取 {usedBytes, capacityBytes, percent, mounted}。
const rowsWithUsage = computed(() => (paginated.value || []).map(p => {
  const u = usageQ.data.value?.usage?.get(p.name)
  return { ...p, usedBytes: u?.usedBytes ?? null, capacityBytes: u?.capacityBytes ?? null, percent: u?.percent ?? null, mounted: u?.mounted ?? false, shared: u?.shared ?? false }
}))

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

async function handleCreatePVC() {
  const f = createForm.value
  const r = await store.addPVC({
    name: f.name,
    namespace: route.params.namespace,
    status: 'Pending',
    capacity: f.capacity,
    accessModes: f.accessModes,
    storageClass: f.storageClass || allSCs.value.find(s => s.default)?.name || 'standard',
    volume: '',
    age: 'Just now',
  })
  if (r && r.ok === false) return // 远端创建失败:保留弹窗(错误已由 store notify)
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
async function handleDelete() {
  if (deleteTarget.value) {
    await store.deletePVC(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: pvcsKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

const accessModeLabels = { RWO: 'ReadWriteOnce', RWM: 'ReadWriteMany', ROM: 'ReadOnlyMany' }

function goPVCDetail(row) {
  router.push({ name: 'NsPVCDetail', params: { namespace: route.params.namespace, name: row.name } })
}
function goSCDetail(row) {
  router.push({ name: 'StorageClassDetail', params: { name: row.name } })
}
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
        {{ t('ns.storage.storageClassTab') }} ({{ allSCs.length }})
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
        <CreateWithYamlButton :label="t('ns.storage.newPVC')" :main-action="() => { showCreatePVC = true }" yaml-template="PersistentVolumeClaim" :namespace="route.params.namespace" />
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
          <button v-if="searchQuery" @click="searchQuery = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"><span class="material-symbols-outlined text-lg">close</span></button>
        </div>
        <span class="text-body-sm text-on-surface-variant">{{ filteredPVCs.length }} / {{ nsPVCs.length }}</span>
      </div>

      <DataTable :headers="pvcHeaders" :rows="rowsWithUsage" column-key="nsStoragePVC" @row-click="goPVCDetail">
        <template #name="{ row }">
          <div class="flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">storage</span>
            <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
          </div>
        </template>
        <template #status="{ row }"><StatusChip :status="row.status" size="sm" /></template>
        <template #capacity="{ row }"><span class="font-mono text-code-sm font-semibold">{{ row.capacity }}</span></template>
        <template #used="{ row }">
          <span v-if="row.shared" :title="t('ns.storage.nfsShared')" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-on-surface-variant bg-surface-container border border-outline-variant cursor-help">NFS</span>
          <div v-else-if="row.percent != null" class="flex flex-col gap-0.5 min-w-[84px]">
            <ProgressBar :value="row.percent" size="sm" />
            <span class="text-[10px] text-on-surface-variant font-mono">{{ formatBytes(row.usedBytes) }} / {{ formatBytes(row.capacityBytes) }}</span>
          </div>
          <span v-else-if="!row.mounted" class="text-xs text-on-surface-variant/60">{{ t('ns.storage.notMounted') }}</span>
          <span v-else :title="noStatsAccess ? t('ns.storage.usageNoPermission') : t('ns.storage.usageNoData')" class="text-xs text-on-surface-variant/60 cursor-help">—</span>
        </template>
        <template #accessModes="{ row }"><span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant" :title="accessModeLabels[row.accessModes] || row.accessModes">{{ row.accessModes }}</span></template>
        <template #storageClass="{ row }"><span class="px-1.5 py-0.5 bg-surface-container rounded text-body-sm border border-outline-variant">{{ row.storageClass }}</span></template>
        <template #volume="{ row }"><span class="font-mono text-code-sm text-primary">{{ row.volume || '-' }}</span></template>
        <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
        <template #actions="{ row }">
          <div class="flex gap-1">
            <button @click.stop="goPVCDetail(row)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-lg">open_in_new</span></button>
            <button @click.stop="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
          </div>
        </template>
        <template v-if="filteredPVCs.length" #pagination>
          <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
        </template>
      </DataTable>
    </div>

    <!-- StorageClass Tab -->
    <div v-if="activeTab === 'storageclass'">
      <div class="flex justify-between items-end mb-md">
        <div>
          <h2 class="text-headline-md font-bold text-on-surface">{{ t('ns.storage.storageClassTab') }}</h2>
          <p class="text-body-sm text-on-surface-variant mt-1">{{ t('ns.storage.clusterWide') }}</p>
        </div>
      </div>
      <DataTable :headers="scHeaders" :rows="allSCs" column-key="nsStorageSC" @row-click="goSCDetail">
        <template #name="{ row }">
          <div class="flex items-center gap-sm">
            <span class="material-symbols-outlined text-secondary text-lg">database</span>
            <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
          </div>
        </template>
        <template #provisioner="{ row }"><span class="font-mono text-code-sm text-on-surface-variant">{{ row.provisioner }}</span></template>
        <template #parameters="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.parameters }}</span></template>
        <template #reclaimPolicy="{ row }"><span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant">{{ row.reclaimPolicy }}</span></template>
        <template #default="{ row }">
          <span v-if="row.default" class="flex items-center gap-xs text-primary">
            <span class="material-symbols-outlined text-lg">check_circle</span> Yes
          </span>
          <span v-else class="text-on-surface-variant">—</span>
        </template>
        <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
      </DataTable>
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
          <option v-for="sc in allSCs" :key="sc.name" :value="sc.name">{{ sc.name }}{{ sc.default ? ' (default)' : '' }}</option>
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
