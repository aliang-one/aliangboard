<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const router = useRouter()
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
  { key: 'actions', label: 'Actions', align: 'right' },
]

const scHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'provisioner', label: 'Provisioner' },
  { key: 'reclaimPolicy', label: 'Reclaim Policy' },
  { key: 'default', label: 'Default' },
  { key: 'age', label: 'Age' },
  { key: 'actions', label: 'Actions', align: 'right' },
]

// Create PVC（集群页跨 namespace，需选择目标 namespace）
const showCreatePVC = ref(false)
const createForm = ref({ name: '', namespace: 'default', capacity: '10Gi', accessModes: 'RWO', storageClass: '' })
function resetCreate() {
  createForm.value = { name: '', namespace: 'default', capacity: '10Gi', accessModes: 'RWO', storageClass: '' }
}
function handleCreatePVC() {
  const f = createForm.value
  if (!f.name || !f.namespace) return
  store.addPVC({
    name: f.name,
    namespace: f.namespace,
    status: 'Pending',
    capacity: f.capacity,
    accessModes: f.accessModes,
    storageClass: f.storageClass || store.scList.find(s => s.default)?.name || 'standard',
    volume: '',
    age: 'Just now',
  })
  showCreatePVC.value = false
  resetCreate()
}

// Create PersistentVolume
const showCreatePV = ref(false)
const createPVForm = ref({ name: '', capacity: '50Gi', accessModes: 'RWO', reclaimPolicy: 'Retain', storageClass: '' })
function resetCreatePV() {
  createPVForm.value = { name: '', capacity: '50Gi', accessModes: 'RWO', reclaimPolicy: 'Retain', storageClass: '' }
}
function handleCreatePV() {
  const f = createPVForm.value
  if (!f.name) return
  store.addPV({
    name: f.name,
    capacity: f.capacity,
    accessModes: f.accessModes,
    reclaimPolicy: f.reclaimPolicy,
    storageClass: f.storageClass,
    status: 'Available',
  })
  showCreatePV.value = false
  resetCreatePV()
}

// Create StorageClass
const showCreateSC = ref(false)
const createSCForm = ref({ name: '', provisioner: '', parameters: '', reclaimPolicy: 'Retain', default: false })
function resetCreateSC() {
  createSCForm.value = { name: '', provisioner: '', parameters: '', reclaimPolicy: 'Retain', default: false }
}
function handleCreateSC() {
  const f = createSCForm.value
  if (!f.name) return
  store.addStorageClass({
    name: f.name,
    provisioner: f.provisioner,
    parameters: f.parameters,
    reclaimPolicy: f.reclaimPolicy,
    default: f.default,
  })
  showCreateSC.value = false
  resetCreateSC()
}

function openPVC(row) {
  router.push({ name: 'NsPVCDetail', params: { namespace: row.namespace, name: row.name } })
}
function openPV(row) {
  router.push({ name: 'PVDetail', params: { name: row.name } })
}
function openSC(row) {
  router.push({ name: 'StorageClassDetail', params: { name: row.name } })
}

// 按 tab 切换的当前列表
const currentTabList = computed(() => ({
  pvc: store.pvcList,
  pv: store.pvList,
  sc: store.scList,
}[activeTab.value] || []))
const { currentPage, pageSize, paginated, total } = usePagination(currentTabList, { resetDeps: [activeTab] })
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">Storage</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">Manage persistent storage, volumes, and storage classes.</p>
      </div>
      <button v-if="activeTab === 'pvc'" @click="showCreatePVC = true" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-base">add</span> New PVC
      </button>
      <button v-else-if="activeTab === 'pv'" @click="showCreatePV = true" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-base">add</span> New PV
      </button>
      <button v-else-if="activeTab === 'sc'" @click="showCreateSC = true" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-base">add</span> New StorageClass
      </button>
    </div>

    <!-- Tabs -->
    <div class="flex items-center gap-xs border-b border-outline-variant mb-md">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        @click="activeTab = tab.key"
        class="px-lg py-2 text-body-sm font-medium transition-colors relative"
        :class="activeTab === tab.key ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'"
      >{{ tab.label }}
        <span v-if="activeTab === tab.key" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"></span>
      </button>
    </div>

    <!-- PVC Tab -->
    <DataTable v-if="activeTab === 'pvc'" :headers="pvcHeaders" :rows="paginated" @row-click="openPVC">
      <template #name="{ row }">
        <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
      </template>
      <template #status="{ row }">
        <StatusChip :status="row.status" />
      </template>
      <template #storageClass="{ row }">
        <span class="px-1.5 py-0.5 bg-surface-container rounded text-xs border border-outline-variant">{{ row.storageClass }}</span>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <!-- PV Tab -->
    <DataTable v-if="activeTab === 'pv'" :headers="pvHeaders" :rows="paginated" @row-click="openPV">
      <template #name="{ row }">
        <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
      </template>
      <template #status="{ row }">
        <StatusChip :status="row.status" />
      </template>
      <template #claim="{ row }">
        <span class="font-mono text-code-sm text-primary">{{ row.claim || '-' }}</span>
      </template>
      <template #actions="{ row }">
        <button @click.stop="store.deletePV(row.name)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete">
          <span class="material-symbols-outlined text-lg">delete</span>
        </button>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <!-- SC Tab -->
    <DataTable v-if="activeTab === 'sc'" :headers="scHeaders" :rows="paginated" @row-click="openSC">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
          <span v-if="row.default" class="px-1.5 py-0.5 bg-primary-container/20 text-primary text-xs rounded font-medium">DEFAULT</span>
        </div>
      </template>
      <template #default="{ row }">
        <span class="material-symbols-outlined" :class="row.default ? 'text-primary' : 'text-outline-variant'">{{ row.default ? 'check_circle' : 'radio_button_unchecked' }}</span>
      </template>
      <template #actions="{ row }">
        <button @click.stop="store.deleteStorageClass(row.name)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete">
          <span class="material-symbols-outlined text-lg">delete</span>
        </button>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <!-- Create PVC Modal -->
    <Modal v-model="showCreatePVC" title="Create PVC" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">PVC Name *</label>
            <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-pvc" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Namespace *</label>
            <select v-model="createForm.namespace" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option v-for="ns in store.namespaceList" :key="ns.name" :value="ns.name">{{ ns.name }}</option>
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Capacity *</label>
            <input v-model="createForm.capacity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="10Gi" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Access Mode</label>
            <select v-model="createForm.accessModes" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option value="RWO">ReadWriteOnce</option>
              <option value="RWM">ReadWriteMany</option>
              <option value="ROM">ReadOnlyMany</option>
            </select>
          </div>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">StorageClass</label>
          <select v-model="createForm.storageClass" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option value="">Default</option>
            <option v-for="sc in store.scList" :key="sc.name" :value="sc.name">{{ sc.name }}{{ sc.default ? ' (default)' : '' }}</option>
          </select>
        </div>
      </div>
      <template #actions>
        <button @click="showCreatePVC = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
        <button @click="handleCreatePVC" :disabled="!createForm.name || !createForm.namespace" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
      </template>
    </Modal>

    <!-- Create PersistentVolume Modal -->
    <Modal v-model="showCreatePV" title="Create PersistentVolume" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">PV Name *</label>
          <input v-model="createPVForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="pv-ssd-001" />
        </div>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Capacity *</label>
            <input v-model="createPVForm.capacity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="50Gi" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Access Mode</label>
            <select v-model="createPVForm.accessModes" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
              <option value="RWO">ReadWriteOnce</option>
              <option value="RWM">ReadWriteMany</option>
              <option value="ROM">ReadOnlyMany</option>
              <option value="RWOP">ReadWriteOncePod</option>
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Reclaim Policy</label>
            <select v-model="createPVForm.reclaimPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
              <option value="Retain">Retain</option>
              <option value="Delete">Delete</option>
              <option value="Recycle">Recycle</option>
            </select>
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">StorageClass</label>
            <input v-model="createPVForm.storageClass" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="ssd-premium" />
          </div>
        </div>
      </div>
      <template #actions>
        <button @click="showCreatePV = false; resetCreatePV()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
        <button @click="handleCreatePV" :disabled="!createPVForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
      </template>
    </Modal>

    <!-- Create StorageClass Modal -->
    <Modal v-model="showCreateSC" title="Create StorageClass" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">StorageClass Name *</label>
          <input v-model="createSCForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="fast-ssd" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Provisioner</label>
          <input v-model="createSCForm.provisioner" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="pd.csi.storage.gke.io" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Parameters</label>
          <input v-model="createSCForm.parameters" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="type=pd-ssd" />
        </div>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Reclaim Policy</label>
            <select v-model="createSCForm.reclaimPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
              <option value="Retain">Retain</option>
              <option value="Delete">Delete</option>
            </select>
          </div>
          <div class="flex items-center gap-sm pt-lg">
            <input type="checkbox" id="sc-default" v-model="createSCForm.default" class="w-4 h-4 accent-primary" />
            <label for="sc-default" class="text-body-md text-on-surface cursor-pointer">Set as default StorageClass</label>
          </div>
        </div>
      </div>
      <template #actions>
        <button @click="showCreateSC = false; resetCreateSC()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
        <button @click="handleCreateSC" :disabled="!createSCForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
      </template>
    </Modal>
  </section>
</template>
