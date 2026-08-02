<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const pvc = computed(() => store.getPVCByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('pvc', pvc.value))
const pv = computed(() => pvc.value?.volume ? store.pvList.find(p => p.name === pvc.value.volume) : null)
const sc = computed(() => pvc.value?.storageClass ? store.scList.find(s => s.name === pvc.value.storageClass) : null)

const activeTab = ref('overview')
const showDeleteModal = ref(false)

async function handleDelete() {
  await store.deletePVC(route.params.name, route.params.namespace)
  router.push({ name: 'NsStorage', params: { namespace: route.params.namespace } })
}

// === 结构化编辑 ===
const showEditModal = ref(false)
const editCapacity = ref('')
const editAccessModes = ref('RWO')
const editStorageClass = ref('')

function openEdit() {
  editCapacity.value = pvc.value?.capacity || ''
  editAccessModes.value = pvc.value?.accessModes || 'RWO'
  editStorageClass.value = pvc.value?.storageClass || ''
  showEditModal.value = true
}
function saveEdit() {
  store.updatePVC(route.params.name, route.params.namespace, {
    capacity: editCapacity.value,
    accessModes: editAccessModes.value,
    storageClass: editStorageClass.value,
  })
  showEditModal.value = false
}
</script>

<template>
  <div class="animate-fade-in" v-if="pvc">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Storage', route: `/ns/${route.params.namespace}/storage` },
      { label: route.params.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">storage</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ pvc.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <StatusChip :status="pvc.status" />
            <span class="text-body-sm text-on-surface-variant">Capacity: <span class="font-mono text-primary font-semibold">{{ pvc.capacity }}</span></span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ pvc.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="openEdit" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors">
          <span class="material-symbols-outlined">edit</span> Edit
        </button>
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">PVC Details</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Status</p>
              <StatusChip :status="pvc.status" />
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Capacity</p>
              <p class="font-mono text-code-md text-primary font-semibold">{{ pvc.capacity }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Access Modes</p>
              <p class="text-body-md text-on-surface">{{ pvc.accessModes }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">StorageClass</p>
              <p class="text-body-md text-on-surface">{{ pvc.storageClass }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Volume</p>
              <p class="font-mono text-code-sm" :class="pvc.volume ? 'text-primary' : 'text-on-surface-variant'">{{ pvc.volume || 'Not bound' }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Namespace</p>
              <p class="text-body-md text-on-surface">{{ pvc.namespace }}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div v-if="pv" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Bound Volume</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">PV Name</span>
              <span class="font-mono text-code-sm text-primary font-semibold">{{ pv.name }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Reclaim Policy</span>
              <span class="text-body-md text-on-surface">{{ pv.reclaimPolicy }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Age</span>
              <span class="text-body-md text-on-surface">{{ pv.age }}</span>
            </div>
          </div>
        </div>
        <div v-if="sc" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">StorageClass</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Name</span>
              <span class="text-body-md text-primary font-semibold">{{ sc.name }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Provisioner</span>
              <span class="text-body-sm text-on-surface">{{ sc.provisioner }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Reclaim Policy</span>
              <span class="text-body-md text-on-surface">{{ sc.reclaimPolicy }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>
  </div>
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">PVC Not Found</h2>
    <button @click="router.push({ name: 'NsStorage', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Storage</button>
  </div>

  <Modal v-model="showDeleteModal" title="Delete PVC" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete PVC <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This may cause data loss. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <Modal v-model="showEditModal" title="Edit PVC" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Capacity</label>
        <input v-model="editCapacity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="50Gi" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Access Mode</label>
        <select v-model="editAccessModes" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
          <option value="RWO">RWO (ReadWriteOnce)</option>
          <option value="RWM">RWM (ReadWriteMany)</option>
          <option value="ROM">ROM (ReadOnlyMany)</option>
          <option value="RWOP">RWOP (ReadWriteOncePod)</option>
        </select>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">StorageClass</label>
        <input v-model="editStorageClass" list="pvc-sc-list" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="ssd-standard" />
        <datalist id="pvc-sc-list">
          <option v-for="s in store.scList" :key="s.name" :value="s.name" />
        </datalist>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Save</button>
    </template>
  </Modal>
</template>
