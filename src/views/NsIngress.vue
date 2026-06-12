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

// Create Ingress Dialog
const showCreateModal = ref(false)
const createForm = ref({
  name: '',
  host: '',
  path: '/',
  pathType: 'Prefix',
  serviceName: '',
  servicePort: '80',
  enableTLS: true,
  tlsSecret: '',
  className: 'nginx',
})

function resetCreate() {
  createForm.value = { name: '', host: '', path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80', enableTLS: true, tlsSecret: '', className: 'nginx' }
}

function handleCreate() {
  const f = createForm.value
  store.addIngress({
    name: f.name,
    namespace: route.params.namespace,
    hosts: f.host,
    path: f.path,
    backend: f.serviceName + ':' + f.servicePort,
    tls: f.enableTLS,
    tlsSecret: f.enableTLS ? (f.tlsSecret || f.name + '-tls') : '',
    age: 'Just now',
    className: f.className,
    annotations: { 'kubernetes.io/ingress.class': 'nginx' },
    rules: [{
      host: f.host,
      http: {
        paths: [{
          path: f.path,
          pathType: f.pathType,
          backend: { serviceName: f.serviceName, servicePort: parseInt(f.servicePort) }
        }]
      }
    }],
  })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(ing) {
  deleteTarget.value = ing
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteIngress(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Ingress' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Ingress</h2>
        <p class="text-on-surface-variant text-body-md mt-1">{{ store.nsIngress.length }} ingress rules in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
        <span class="material-symbols-outlined">add</span> New Ingress
      </button>
    </div>

    <div v-if="store.nsIngress.length" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Hosts</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Path</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Backend</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">TLS</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-24">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr v-for="row in store.nsIngress" :key="row.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="router.push({ name: 'NsIngressDetail', params: { namespace: route.params.namespace, name: row.name } })">
            <td class="px-lg py-md">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-primary text-lg">language</span>
                <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
              </div>
            </td>
            <td class="px-lg py-md"><span class="font-mono text-code-sm text-primary font-semibold">{{ row.hosts }}</span></td>
            <td class="px-lg py-md"><span class="font-mono text-code-sm">{{ row.path }}</span></td>
            <td class="px-lg py-md"><span class="font-mono text-code-sm text-on-surface-variant">{{ row.backend }}</span></td>
            <td class="px-lg py-md">
              <div class="flex items-center gap-xs">
                <span class="material-symbols-outlined text-lg" :class="row.tls ? 'text-primary' : 'text-on-surface-variant'">{{ row.tls ? 'lock' : 'lock_open' }}</span>
                <span class="text-body-sm" :class="row.tls ? 'text-primary' : 'text-on-surface-variant'">{{ row.tls ? 'Enabled' : 'None' }}</span>
              </div>
            </td>
            <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-lg py-md" @click.stop>
              <div class="flex gap-1">
                <button @click="router.push({ name: 'NsIngressDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="View Details">
                  <span class="material-symbols-outlined text-lg">open_in_new</span>
                </button>
                <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete">
                  <span class="material-symbols-outlined text-lg">delete</span>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">language</span>
      <p class="text-on-surface-variant mt-md">No ingress rules in this namespace</p>
      <button @click="showCreateModal = true" class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">Create Ingress</button>
    </div>
  </section>

  <!-- Create Ingress Modal -->
  <Modal v-model="showCreateModal" title="Create Ingress" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Ingress Name *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-ingress" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Host *</label>
        <input v-model="createForm.host" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="app.example.com" />
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Path</label>
          <input v-model="createForm.path" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="/" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Path Type</label>
          <select v-model="createForm.pathType" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option>Prefix</option><option>Exact</option><option>ImplementationSpecific</option>
          </select>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Backend Service *</label>
          <input v-model="createForm.serviceName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="my-service" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Service Port *</label>
          <input v-model="createForm.servicePort" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="80" />
        </div>
      </div>
      <div class="flex items-center gap-sm">
        <input v-model="createForm.enableTLS" type="checkbox" class="rounded text-primary h-4 w-4" />
        <span class="text-body-md font-medium">Enable TLS</span>
      </div>
      <div v-if="createForm.enableTLS">
        <label class="text-label-caps text-on-surface-variant block mb-xs">TLS Secret Name</label>
        <input v-model="createForm.tlsSecret" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="my-tls-secret (auto-generated if empty)" />
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleCreate" :disabled="!createForm.name || !createForm.host || !createForm.serviceName" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
    </template>
  </Modal>

  <!-- Delete Confirm Modal -->
  <Modal v-model="showDeleteModal" title="Delete Ingress" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete ingress <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This will remove all routing rules. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
