<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const typeFilter = ref('All')
const typeOptions = ['All', 'ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName']
const searchQuery = ref('')

const filtered = computed(() => {
  let list = store.nsServices
  if (typeFilter.value !== 'All') list = list.filter(s => s.type === typeFilter.value)
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(s => s.name.toLowerCase().includes(q) || s.clusterIP.includes(q))
  }
  return list
})

const clusterIPCount = computed(() => store.nsServices.filter(s => s.type === 'ClusterIP').length)
const nodePortCount = computed(() => store.nsServices.filter(s => s.type === 'NodePort').length)
const lbCount = computed(() => store.nsServices.filter(s => s.type === 'LoadBalancer').length)

// Create Service Dialog
const showCreateModal = ref(false)
const createForm = ref({
  name: '',
  type: 'ClusterIP',
  port: '',
  targetPort: '',
  selectorKey: 'app',
  selectorValue: '',
})

function resetCreate() {
  createForm.value = { name: '', type: 'ClusterIP', port: '', targetPort: '', selectorKey: 'app', selectorValue: '' }
}

async function handleCreate() {
  const f = createForm.value
  const r = await store.addService({
    name: f.name,
    namespace: route.params.namespace,
    type: f.type,
    clusterIP: '10.96.' + Math.floor(Math.random() * 255) + '.' + Math.floor(Math.random() * 255),
    externalIP: '-',
    ports: f.port + ':' + (f.targetPort || f.port) + '/TCP',
    selector: { [f.selectorKey]: f.selectorValue || f.name },
  })
  if (r && r.ok === false) return   // 远端创建失败：保留弹窗（错误已由 store notify）
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(svc) {
  deleteTarget.value = svc
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteService(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Services' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Services</h2>
        <p class="text-on-surface-variant text-body-md mt-1">{{ store.nsServices.length }} services in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
        <span class="material-symbols-outlined">add</span> New Service
      </button>
    </div>

    <!-- Type Summary -->
    <div class="grid grid-cols-3 gap-sm mb-lg">
      <div class="bg-surface-container-lowest border rounded-lg px-md py-sm flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" :class="typeFilter === 'ClusterIP' ? 'border-primary bg-primary/5' : 'border-outline-variant'" @click="typeFilter = typeFilter === 'ClusterIP' ? 'All' : 'ClusterIP'">
        <span class="material-symbols-outlined text-primary text-lg">hub</span>
        <span class="text-body-sm text-on-surface-variant">ClusterIP</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ clusterIPCount }}</span>
      </div>
      <div class="bg-surface-container-lowest border rounded-lg px-md py-sm flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" :class="typeFilter === 'NodePort' ? 'border-primary bg-primary/5' : 'border-outline-variant'" @click="typeFilter = typeFilter === 'NodePort' ? 'All' : 'NodePort'">
        <span class="material-symbols-outlined text-secondary text-lg">lan</span>
        <span class="text-body-sm text-on-surface-variant">NodePort</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ nodePortCount }}</span>
      </div>
      <div class="bg-surface-container-lowest border rounded-lg px-md py-sm flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" :class="typeFilter === 'LoadBalancer' ? 'border-primary bg-primary/5' : 'border-outline-variant'" @click="typeFilter = typeFilter === 'LoadBalancer' ? 'All' : 'LoadBalancer'">
        <span class="material-symbols-outlined text-tertiary text-lg">public</span>
        <span class="text-body-sm text-on-surface-variant">LoadBalancer</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ lbCount }}</span>
      </div>
    </div>

    <!-- Search -->
    <div class="mb-lg">
      <div class="relative max-w-xs">
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-sm pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-9 pr-sm py-sm text-body-sm focus:ring-1 focus:ring-primary focus:border-primary" placeholder="Search by name or IP..." />
      </div>
    </div>

    <!-- Table -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Type</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Cluster IP</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">External IP</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Ports</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-24">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr v-for="row in filtered" :key="row.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: row.name } })">
            <td class="px-lg py-md">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-primary text-lg">hub</span>
                <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
              </div>
            </td>
            <td class="px-lg py-md"><span class="px-2 py-0.5 bg-surface-container rounded-full text-label-caps text-on-surface-variant border border-outline-variant">{{ row.type }}</span></td>
            <td class="px-lg py-md"><span class="font-mono text-code-sm">{{ row.clusterIP }}</span></td>
            <td class="px-lg py-md"><span class="font-mono text-code-sm" :class="row.externalIP !== '-' ? 'text-primary font-semibold' : 'text-on-surface-variant'">{{ row.externalIP }}</span></td>
            <td class="px-lg py-md"><span class="font-mono text-code-sm">{{ row.ports }}</span></td>
            <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-lg py-md" @click.stop>
              <div class="flex gap-1">
                <button @click="router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="View Details">
                  <span class="material-symbols-outlined text-lg">open_in_new</span>
                </button>
                <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete">
                  <span class="material-symbols-outlined text-lg">delete</span>
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="7" class="px-lg py-xl text-center text-on-surface-variant">No services found</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- Create Service Modal -->
  <Modal v-model="showCreateModal" title="Create Service" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Service Name *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-service" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Service Type</label>
        <div class="flex gap-sm">
          <button v-for="st in ['ClusterIP', 'NodePort', 'LoadBalancer']" :key="st" @click="createForm.type = st"
            class="px-lg py-sm rounded-lg border font-medium text-body-md transition-all"
            :class="createForm.type === st ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'">
            {{ st }}
          </button>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Port *</label>
          <input v-model="createForm.port" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="80" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Target Port</label>
          <input v-model="createForm.targetPort" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="8080" />
        </div>
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Selector Key</label>
          <input v-model="createForm.selectorKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="app" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Selector Value *</label>
          <input v-model="createForm.selectorValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="my-app" />
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleCreate" :disabled="!createForm.name || !createForm.port" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
    </template>
  </Modal>

  <!-- Delete Confirm Modal -->
  <Modal v-model="showDeleteModal" title="Delete Service" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete service <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This will disrupt traffic to the backend pods. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
