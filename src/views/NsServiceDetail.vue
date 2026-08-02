<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import PortForwardPanel from '@/components/common/PortForwardPanel.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const svc = computed(() => store.getServiceByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('service', svc.value))

const activeTab = ref('overview')
const showDeleteModal = ref(false)
const showEditModal = ref(false)
const showPortForward = ref(false)
// Service 的可转发端口（取每个端口条目的 service port）
const forwardPorts = computed(() => {
  if (!svc.value?.ports) return []
  return svc.value.ports.split(',').map(p => parseInt(String(p).split(':')[0])).filter(n => !isNaN(n))
})

// Endpoints — pods matching this service's selector
const endpoints = computed(() => {
  if (!svc.value?.selector) return []
  const sel = svc.value.selector
  return store.nsPods.filter(p => {
    return Object.entries(sel).every(([k, v]) => p.labels?.[k] === v)
  })
})

async function handleDelete() {
  await store.deleteService(route.params.name, route.params.namespace)
  router.push({ name: 'NsServices', params: { namespace: route.params.namespace } })
}

// Edit form
const editForm = ref({})
const editSelector = ref([]) // [{ key, value }]
function openEdit() {
  if (!svc.value) return
  editForm.value = {
    type: svc.value.type,
    clusterIP: svc.value.clusterIP,
    ports: svc.value.ports,
  }
  editSelector.value = Object.entries(svc.value.selector || {}).map(([key, value]) => ({ key, value }))
  showEditModal.value = true
}
function addSelectorRow() { editSelector.value.push({ key: '', value: '' }) }
function removeSelectorRow(idx) { editSelector.value.splice(idx, 1) }
function saveEdit() {
  const selector = {}
  editSelector.value.forEach(r => { if (r.key.trim()) selector[r.key.trim()] = r.value })
  store.updateService(route.params.name, route.params.namespace, {
    type: editForm.value.type,
    ports: editForm.value.ports,
    selector,
  })
  showEditModal.value = false
}
</script>

<template>
  <div class="animate-fade-in" v-if="svc">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Services', route: `/ns/${route.params.namespace}/services` },
      { label: route.params.name }
    ]" />

    <!-- Header -->
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">hub</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ svc.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-primary-container/10 text-primary text-label-caps rounded-full font-medium">{{ svc.type }}</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ svc.age }}</span>
            <span class="text-body-sm text-on-surface-variant">Namespace: <span class="text-primary font-medium">{{ svc.namespace }}</span></span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
        <button @click="showPortForward = true" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">cable</span> Port Forward
        </button>
        <button @click="openEdit" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">edit</span> Edit
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'endpoints', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <!-- Connection Info -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Connection Info</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Cluster IP</p>
              <p class="font-mono text-code-md text-primary font-semibold">{{ svc.clusterIP }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">External IP</p>
              <p class="font-mono text-code-md" :class="svc.externalIP !== '-' ? 'text-primary font-semibold' : 'text-on-surface-variant'">{{ svc.externalIP }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Type</p>
              <p class="text-body-md font-semibold text-on-surface">{{ svc.type }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Ports</p>
              <p class="font-mono text-code-md text-on-surface">{{ svc.ports }}</p>
            </div>
          </div>
        </div>

        <!-- Selector -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Selector</h3>
          <div class="flex flex-wrap gap-sm">
            <span v-for="(val, key) in svc.selector" :key="key"
              class="px-md py-xs bg-primary-container/10 text-primary text-body-sm rounded-full border border-primary/20">
              <span class="font-semibold">{{ key }}</span>: {{ val }}
            </span>
          </div>
        </div>
      </div>

      <!-- Right Sidebar -->
      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Summary</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Endpoints</span>
              <span class="text-body-md font-semibold text-primary">{{ endpoints.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Session Affinity</span>
              <span class="text-body-md text-on-surface">None</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Age</span>
              <span class="text-body-md text-on-surface">{{ svc.age }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Endpoints Tab -->
    <div v-if="activeTab === 'endpoints'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Endpoint Pods ({{ endpoints.length }})</h3>
        </div>
        <table v-if="endpoints.length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Pod Name</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">IP</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Node</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="pod in endpoints" :key="pod.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: pod.name } })">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">layers</span>
                  <span class="font-mono text-code-sm font-semibold text-on-surface">{{ pod.name }}</span>
                </div>
              </td>
              <td class="px-lg py-md font-mono text-code-sm text-primary">{{ pod.ip }}</td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ pod.node }}</td>
              <td class="px-lg py-md"><StatusChip :status="pod.status" size="sm" /></td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ pod.age }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="p-xl text-center text-on-surface-variant">
          <span class="material-symbols-outlined text-3xl">search_off</span>
          <p class="mt-sm">No pods match this service's selector</p>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>

    <!-- Not Found -->
  </div>
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">Service Not Found</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">Service "{{ route.params.name }}" not found in namespace "{{ route.params.namespace }}"</p>
    <button @click="router.push({ name: 'NsServices', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Services</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete Service" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete service <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" title="Edit Service" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Service Type</label>
        <select v-model="editForm.type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
          <option>ClusterIP</option><option>NodePort</option><option>LoadBalancer</option><option>ExternalName</option>
        </select>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Ports</label>
        <input v-model="editForm.ports" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="80:8080/TCP,443:8443/TCP" />
      </div>
      <div>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-label-caps text-on-surface-variant">Selector</label>
          <button @click="addSelectorRow" type="button" class="flex items-center gap-xs text-body-sm text-primary font-semibold hover:underline">
            <span class="material-symbols-outlined text-sm">add</span> Add
          </button>
        </div>
        <div class="flex flex-col gap-xs">
          <div v-for="(row, idx) in editSelector" :key="idx" class="flex gap-xs items-center">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="app" />
            <span class="text-on-surface-variant">=</span>
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="my-app" />
            <button @click="removeSelectorRow(idx)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded-lg">
              <span class="material-symbols-outlined text-lg">remove</span>
            </button>
          </div>
          <p v-if="!editSelector.length" class="text-body-sm text-on-surface-variant italic">No selector (ExternalName or headless)</p>
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Save</button>
    </template>
  </Modal>

  <!-- Port Forward Panel -->
  <PortForwardPanel v-model="showPortForward" kind="Service" :name="route.params.name" :namespace="route.params.namespace" :suggested-ports="forwardPorts" />
</template>
