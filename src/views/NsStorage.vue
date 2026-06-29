<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import StatusChip from '@/components/common/StatusChip.vue'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const activeTab = ref('pvc')

const boundCount = computed(() => store.nsPVCs.filter(p => p.status === 'Bound').length)
const pendingCount = computed(() => store.nsPVCs.filter(p => p.status === 'Pending').length)

// 搜索过滤
const searchQuery = ref('')
const filteredPVCs = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return store.nsPVCs
  return store.nsPVCs.filter(p => p.name.toLowerCase().includes(q) || (p.storageClass || '').toLowerCase().includes(q))
})

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
      { label: 'Storage' }
    ]" />

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg mt-sm">
      <button @click="activeTab = 'pvc'" class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors" :class="activeTab === 'pvc' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        PVCs ({{ store.nsPVCs.length }})
      </button>
      <button @click="activeTab = 'storageclass'" class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors" :class="activeTab === 'storageclass' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        StorageClasses ({{ store.scList.length }})
      </button>
    </div>

    <!-- PVC Tab -->
    <div v-if="activeTab === 'pvc'">
      <div class="flex justify-between items-end mb-lg">
        <div>
          <h2 class="text-display-lg text-on-surface">Persistent Volume Claims</h2>
          <p class="text-on-surface-variant text-body-md mt-1">{{ store.nsPVCs.length }} PVCs in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
        </div>
        <button @click="showCreatePVC = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined">add</span> New PVC
        </button>
      </div>

      <!-- Summary -->
      <div class="grid grid-cols-2 gap-sm mb-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm flex items-center gap-sm">
          <span class="w-2.5 h-2.5 rounded-full bg-primary"></span>
          <span class="text-body-sm text-on-surface-variant">Bound</span>
          <span class="text-body-md font-bold text-primary ml-auto">{{ boundCount }}</span>
        </div>
        <div class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm flex items-center gap-sm">
          <span class="w-2.5 h-2.5 rounded-full bg-tertiary-container"></span>
          <span class="text-body-sm text-on-surface-variant">Pending</span>
          <span class="text-body-md font-bold text-tertiary-container ml-auto">{{ pendingCount }}</span>
        </div>
      </div>

      <!-- 搜索框 -->
      <div class="flex items-center gap-md mb-lg">
        <div class="relative flex-1 max-w-md">
          <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
          <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" placeholder="按名称或 StorageClass 搜索..." />
          <button v-if="searchQuery" @click="searchQuery = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"><span class="material-symbols-outlined text-lg">close</span></button>
        </div>
        <span class="text-body-sm text-on-surface-variant">{{ filteredPVCs.length }} / {{ store.nsPVCs.length }}</span>
      </div>

      <div v-if="filteredPVCs.length" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Capacity</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Access</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">StorageClass</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Volume</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant w-24">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="row in filteredPVCs" :key="row.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="router.push({ name: 'NsPVCDetail', params: { namespace: route.params.namespace, name: row.name } })">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-primary text-lg">storage</span>
                  <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
                </div>
              </td>
              <td class="px-lg py-md"><StatusChip :status="row.status" size="sm" /></td>
              <td class="px-lg py-md font-mono text-code-sm font-semibold">{{ row.capacity }}</td>
              <td class="px-lg py-md"><span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant" :title="accessModeLabels[row.accessModes] || row.accessModes">{{ row.accessModes }}</span></td>
              <td class="px-lg py-md"><span class="px-2 py-0.5 bg-surface-container rounded text-body-sm border border-outline-variant">{{ row.storageClass }}</span></td>
              <td class="px-lg py-md"><span class="font-mono text-code-sm text-primary">{{ row.volume || '-' }}</span></td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ row.age }}</td>
              <td class="px-lg py-md" @click.stop>
                <div class="flex gap-1">
                  <button @click="router.push({ name: 'NsPVCDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-lg">open_in_new</span></button>
                  <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
        <span class="material-symbols-outlined text-4xl text-surface-container-high">storage</span>
        <p class="text-on-surface-variant mt-md">No PVCs in this namespace</p>
        <button @click="showCreatePVC = true" class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">Create PVC</button>
      </div>
    </div>

    <!-- StorageClass Tab -->
    <div v-if="activeTab === 'storageclass'">
      <div class="flex justify-between items-end mb-lg">
        <div>
          <h2 class="text-display-lg text-on-surface">StorageClasses</h2>
          <p class="text-on-surface-variant text-body-md mt-1">Cluster-wide storage class definitions</p>
        </div>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Provisioner</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Parameters</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Reclaim Policy</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Default</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="sc in store.scList" :key="sc.name" class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">database</span>
                  <span class="font-semibold text-on-surface text-body-md">{{ sc.name }}</span>
                </div>
              </td>
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ sc.provisioner }}</td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ sc.parameters }}</td>
              <td class="px-lg py-md"><span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">{{ sc.reclaimPolicy }}</span></td>
              <td class="px-lg py-md">
                <span v-if="sc.default" class="flex items-center gap-xs text-primary">
                  <span class="material-symbols-outlined text-lg">check_circle</span> Yes
                </span>
                <span v-else class="text-on-surface-variant">—</span>
              </td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ sc.age }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- Create PVC Modal -->
  <Modal v-model="showCreatePVC" title="Create PVC" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">PVC Name *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-pvc" />
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
      <button @click="handleCreatePVC" :disabled="!createForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
    </template>
  </Modal>

  <!-- Delete PVC Modal -->
  <Modal v-model="showDeleteModal" title="Delete PVC" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete PVC <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This may cause data loss. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
