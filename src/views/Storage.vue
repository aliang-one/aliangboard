<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import Modal from '@/components/common/Modal.vue'

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
]

const scHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'provisioner', label: 'Provisioner' },
  { key: 'reclaimPolicy', label: 'Reclaim Policy' },
  { key: 'default', label: 'Default' },
  { key: 'age', label: 'Age' },
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

function openPVC(row) {
  router.push({ name: 'NsPVCDetail', params: { namespace: row.namespace, name: row.name } })
}
function openPV(row) {
  router.push({ name: 'PVDetail', params: { name: row.name } })
}
function openSC(row) {
  router.push({ name: 'StorageClassDetail', params: { name: row.name } })
}
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Storage</h2>
        <p class="text-on-surface-variant text-body-md mt-1">Manage persistent storage, volumes, and storage classes.</p>
      </div>
      <button @click="showCreatePVC = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90">
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
    <DataTable v-if="activeTab === 'pvc'" :headers="pvcHeaders" :rows="store.pvcList" @row-click="openPVC">
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
    <DataTable v-if="activeTab === 'pv'" :headers="pvHeaders" :rows="store.pvList" @row-click="openPV">
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
    <DataTable v-if="activeTab === 'sc'" :headers="scHeaders" :rows="store.scList" @row-click="openSC">
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
  </section>
</template>
