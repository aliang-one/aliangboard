<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const { t } = useI18n()

const router = useRouter()
const store = useClusterStore()
const activeTab = ref('pvc')

const tabs = computed(() => [
  { key: 'pvc', label: t('storage.tabs.pvc') },
  { key: 'pv', label: t('storage.tabs.pv') },
  { key: 'sc', label: t('storage.tabs.sc') },
])

const pvcHeaders = computed(() => [
  { key: 'name', label: t('storage.thName') },
  { key: 'namespace', label: t('storage.thNamespace') },
  { key: 'status', label: t('storage.thStatus') },
  { key: 'capacity', label: t('storage.thCapacity') },
  { key: 'accessModes', label: t('storage.thAccess') },
  { key: 'storageClass', label: t('storage.thStorageClass') },
  { key: 'age', label: t('storage.thAge') },
])

const pvHeaders = computed(() => [
  { key: 'name', label: t('storage.thName') },
  { key: 'capacity', label: t('storage.thCapacity') },
  { key: 'accessModes', label: t('storage.thAccess') },
  { key: 'reclaimPolicy', label: t('storage.thReclaim') },
  { key: 'status', label: t('storage.thStatus') },
  { key: 'claim', label: t('storage.thClaim') },
  { key: 'storageClass', label: t('storage.thStorageClass') },
  { key: 'actions', label: t('storage.thActions'), align: 'right' },
])

const scHeaders = computed(() => [
  { key: 'name', label: t('storage.thName') },
  { key: 'provisioner', label: t('storage.thProvisioner') },
  { key: 'reclaimPolicy', label: t('storage.thReclaim') },
  { key: 'default', label: t('storage.thDefault') },
  { key: 'age', label: t('storage.thAge') },
  { key: 'actions', label: t('storage.thActions'), align: 'right' },
])

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
        <h2 class="text-headline-md text-on-surface font-bold">{{ t('storage.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('storage.subtitle') }}</p>
      </div>
      <button v-if="activeTab === 'pvc'" @click="showCreatePVC = true" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-base">add</span> {{ t('storage.newPVC') }}
      </button>
      <button v-else-if="activeTab === 'pv'" @click="showCreatePV = true" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-base">add</span> {{ t('storage.newPV') }}
      </button>
      <button v-else-if="activeTab === 'sc'" @click="showCreateSC = true" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-base">add</span> {{ t('storage.newSC') }}
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
        <button @click.stop="store.deletePV(row.name)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('storage.delete')">
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
        <button @click.stop="store.deleteStorageClass(row.name)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('storage.delete')">
          <span class="material-symbols-outlined text-lg">delete</span>
        </button>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <!-- Create PVC Modal -->
    <Modal v-model="showCreatePVC" :title="t('storage.createPVCTitle')" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.pvcName') }} *</label>
            <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" :placeholder="t('storage.pvcPlaceholder')" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.namespaceRequired') }} *</label>
            <select v-model="createForm.namespace" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option v-for="ns in store.namespaceList" :key="ns.name" :value="ns.name">{{ ns.name }}</option>
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.capacityRequired') }} *</label>
            <input v-model="createForm.capacity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" :placeholder="t('storage.capacityPlaceholder')" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.accessMode') }}</label>
            <select v-model="createForm.accessModes" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option value="RWO">{{ t('storage.readWriteOnce') }}</option>
              <option value="RWM">{{ t('storage.readWriteMany') }}</option>
              <option value="ROM">{{ t('storage.readOnlyMany') }}</option>
            </select>
          </div>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.storageClassLabel') }}</label>
          <select v-model="createForm.storageClass" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option value="">{{ t('storage.defaultOption') }}</option>
            <option v-for="sc in store.scList" :key="sc.name" :value="sc.name">{{ sc.name }}{{ sc.default ? ` (${t('storage.default')})` : '' }}</option>
          </select>
        </div>
      </div>
      <template #actions>
        <button @click="showCreatePVC = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('storage.cancel') }}</button>
        <button @click="handleCreatePVC" :disabled="!createForm.name || !createForm.namespace" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('storage.create') }}</button>
      </template>
    </Modal>

    <!-- Create PersistentVolume Modal -->
    <Modal v-model="showCreatePV" :title="t('storage.createPVTitle')" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.pvName') }} *</label>
          <input v-model="createPVForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" :placeholder="t('storage.pvPlaceholder')" />
        </div>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.capacityRequired') }} *</label>
            <input v-model="createPVForm.capacity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" :placeholder="t('storage.capacityPlaceholder')" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.accessMode') }}</label>
            <select v-model="createPVForm.accessModes" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
              <option value="RWO">{{ t('storage.readWriteOnce') }}</option>
              <option value="RWM">{{ t('storage.readWriteMany') }}</option>
              <option value="ROM">{{ t('storage.readOnlyMany') }}</option>
              <option value="RWOP">{{ t('storage.readWriteOncePod') }}</option>
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.reclaimPolicy') }}</label>
            <select v-model="createPVForm.reclaimPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
              <option value="Retain">{{ t('storage.retain') }}</option>
              <option value="Delete">{{ t('storage.delete') }}</option>
              <option value="Recycle">{{ t('storage.recycle') }}</option>
            </select>
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.storageClassLabel') }}</label>
            <input v-model="createPVForm.storageClass" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" :placeholder="t('storage.scPlaceholder')" />
          </div>
        </div>
      </div>
      <template #actions>
        <button @click="showCreatePV = false; resetCreatePV()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('storage.cancel') }}</button>
        <button @click="handleCreatePV" :disabled="!createPVForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('storage.create') }}</button>
      </template>
    </Modal>

    <!-- Create StorageClass Modal -->
    <Modal v-model="showCreateSC" :title="t('storage.createSCTitle')" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.scName') }} *</label>
          <input v-model="createSCForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" :placeholder="t('storage.scPlaceholder')" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.provisionerLabel') }}</label>
          <input v-model="createSCForm.provisioner" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" :placeholder="t('storage.provisionerPlaceholder')" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.parametersLabel') }}</label>
          <input v-model="createSCForm.parameters" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" :placeholder="t('storage.parametersPlaceholder')" />
        </div>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('storage.reclaimPolicy') }}</label>
            <select v-model="createSCForm.reclaimPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
              <option value="Retain">{{ t('storage.retain') }}</option>
              <option value="Delete">{{ t('storage.delete') }}</option>
            </select>
          </div>
          <div class="flex items-center gap-sm pt-lg">
            <input type="checkbox" id="sc-default" v-model="createSCForm.default" class="w-4 h-4 accent-primary" />
            <label for="sc-default" class="text-body-md text-on-surface cursor-pointer">{{ t('storage.setDefaultStorageClass') }}</label>
          </div>
        </div>
      </div>
      <template #actions>
        <button @click="showCreateSC = false; resetCreateSC()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('storage.cancel') }}</button>
        <button @click="handleCreateSC" :disabled="!createSCForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('storage.create') }}</button>
      </template>
    </Modal>
  </section>
</template>
