<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const workload = computed(() => store.getWorkloadByName(route.params.name, route.params.namespace))
const managedPods = computed(() => store.getWorkloadPods(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('deployment', workload.value))

const activeTab = ref('overview')
const showDeleteModal = ref(false)
const showScaleModal = ref(false)
const scaleReplicas = ref(1)
const showEditModal = ref(false)
const editForm = ref({})

function handleDelete() {
  store.deleteWorkload(route.params.name, route.params.namespace)
  router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })
}

function handleRestart() {
  store.restartWorkload(route.params.name, route.params.namespace)
}

function openScale() {
  if (!workload.value) return
  scaleReplicas.value = parseInt(workload.value.replicas?.split('/')[1] || '1')
  showScaleModal.value = true
}

function handleScale() {
  store.scaleWorkload(route.params.name, route.params.namespace, scaleReplicas.value)
  showScaleModal.value = false
}

function openEdit() {
  if (!workload.value) return
  editForm.value = {
    image: workload.value.image,
    replicas: workload.value.replicas?.split('/')[1] || '1',
    labels: { ...workload.value.labels },
  }
  showEditModal.value = true
}

function saveEdit() {
  store.updateWorkload(route.params.name, route.params.namespace, {
    image: editForm.value.image,
    replicas: `${editForm.value.replicas}/${editForm.value.replicas}`,
  })
  showEditModal.value = false
}
</script>

<template>
  <div class="animate-fade-in" v-if="workload">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Workloads', route: `/ns/${route.params.namespace}/workloads` },
      { label: route.params.type, route: `/ns/${route.params.namespace}/workloads` },
      { label: workload.name }
    ]" />

    <!-- Header -->
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">apps</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ workload.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-primary-container/10 text-primary text-label-caps rounded-full font-medium">{{ workload.type }}</span>
            <StatusChip :status="workload.status" />
            <span class="text-body-sm text-on-surface-variant">Age: {{ workload.age }}</span>
            <span class="text-body-sm text-on-surface-variant">Namespace: <span class="text-primary font-medium">{{ workload.namespace }}</span></span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
        <button @click="openScale" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">height</span> Scale
        </button>
        <button @click="handleRestart" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">refresh</span> Restart
        </button>
        <button @click="openEdit" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors">
          <span class="material-symbols-outlined">edit</span> Edit
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'pods', 'yaml', 'events']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Overview</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">TYPE</p>
              <p class="text-body-lg font-semibold">{{ workload.type }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">NAMESPACE</p>
              <p class="text-body-lg font-semibold text-primary">{{ workload.namespace }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">IMAGE</p>
              <p class="font-mono text-code-sm text-primary">{{ workload.image }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">REPLICAS</p>
              <p class="text-body-lg font-semibold">{{ workload.replicas }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">AGE</p>
              <p class="text-body-lg font-semibold">{{ workload.age }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">REVISION</p>
              <p class="font-mono text-code-sm">{{ workload.sha }}</p>
            </div>
          </div>
        </div>

        <!-- Container Info -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Containers</h3>
          <div class="flex flex-col gap-md">
            <div class="flex items-center gap-md p-md bg-surface-container-low rounded-lg">
              <div class="w-10 h-10 rounded-lg bg-secondary/10 flex items-center justify-center">
                <span class="material-symbols-outlined text-secondary">inventory_2</span>
              </div>
              <div class="flex-1">
                <p class="text-body-md font-semibold">{{ workload.name }}</p>
                <p class="font-mono text-code-sm text-primary">{{ workload.image }}</p>
              </div>
              <div class="text-right">
                <p class="text-label-caps text-on-surface-variant">Ports</p>
                <p class="text-body-sm">8080/TCP</p>
              </div>
              <div class="text-right">
                <p class="text-label-caps text-on-surface-variant">Resources</p>
                <p class="text-body-sm">250m-500m / 256Mi-512Mi</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Labels</h3>
          <div class="flex flex-wrap gap-2">
            <span v-for="(val, key) in (workload.labels || {})" :key="key"
              class="px-md py-xs bg-primary-container/10 text-primary text-body-sm rounded-full border border-primary/20">
              <span class="font-semibold">{{ key }}</span>: {{ val }}
            </span>
          </div>
        </div>
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Summary</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Managed Pods</span>
              <span class="text-body-md font-semibold text-primary">{{ managedPods.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Running</span>
              <span class="text-body-md font-semibold text-primary">{{ managedPods.filter(p => p.status === 'Running').length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Pending</span>
              <span class="text-body-md font-semibold">{{ managedPods.filter(p => p.status === 'Pending').length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Failed</span>
              <span class="text-body-md font-semibold text-error">{{ managedPods.filter(p => p.status === 'Failed').length }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Pods Tab -->
    <div v-if="activeTab === 'pods'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Managed Pods ({{ managedPods.length }})</h3>
        </div>
        <table v-if="managedPods.length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Restarts</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Node</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">IP</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="p in managedPods" :key="p.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } })">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">layers</span>
                  <span class="font-mono text-code-sm font-semibold text-on-surface">{{ p.name }}</span>
                </div>
              </td>
              <td class="px-lg py-md"><StatusChip :status="p.status" size="sm" /></td>
              <td class="px-lg py-md text-body-sm">{{ p.restarts }}</td>
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ p.node || '-' }}</td>
              <td class="px-lg py-md font-mono text-code-sm text-primary">{{ p.ip || '-' }}</td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ p.age }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="p-xl text-center text-on-surface-variant">
          <span class="material-symbols-outlined text-3xl">search_off</span>
          <p class="mt-sm">No managed pods found</p>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="() => {}" />
    </div>

    <!-- Events Tab -->
    <div v-if="activeTab === 'events'" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table v-if="store.nsEvents.length" class="w-full text-left">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-14">Type</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Reason</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Message</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Time</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr v-for="(event, idx) in store.nsEvents" :key="idx" class="hover:bg-surface-container-low/50 transition-colors">
            <td class="px-lg py-md">
              <div class="w-8 h-8 rounded-full flex items-center justify-center"
                :class="{
                  'bg-primary-container text-on-primary-container': event.color === 'primary',
                  'bg-tertiary-fixed-dim text-on-tertiary-fixed': event.color === 'tertiary',
                  'bg-error-container text-on-error-container': event.color === 'error',
                  'bg-surface-container text-on-surface-variant': event.color === 'surface',
                }">
                <span class="material-symbols-outlined text-lg">{{ event.icon }}</span>
              </div>
            </td>
            <td class="px-lg py-md">
              <span class="font-semibold text-on-surface text-body-md">{{ event.reason }}</span>
              <span class="ml-sm px-2 py-0.5 rounded text-label-caps" :class="event.type === 'warning' ? 'bg-tertiary-container/10 text-tertiary-container' : 'bg-primary-container/10 text-primary'">{{ event.type }}</span>
            </td>
            <td class="px-lg py-md text-body-sm text-on-surface-variant max-w-md">{{ event.message }}</td>
            <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant whitespace-nowrap">{{ event.time }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="p-xl text-center text-on-surface-variant">
        <p>No events found for this namespace</p>
      </div>
    </div>
  </div>

  <!-- Not Found -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">Workload Not Found</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">Workload "{{ route.params.name }}" not found in namespace "{{ route.params.namespace }}"</p>
    <button @click="router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Workloads</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete Workload" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This action cannot be undone. All managed pods will be terminated.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- Scale Modal -->
  <Modal v-model="showScaleModal" title="Scale Workload" width="max-w-md">
    <p class="text-body-md text-on-surface-variant mb-md">Adjust the number of replicas for <span class="text-on-surface font-semibold">{{ route.params.name }}</span></p>
    <div class="flex items-center gap-md">
      <label class="text-label-caps text-on-surface-variant">Replicas</label>
      <input v-model.number="scaleReplicas" type="number" min="0" max="100" class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono text-center" />
    </div>
    <template #actions>
      <button @click="showScaleModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleScale" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Scale</button>
    </template>
  </Modal>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" title="Edit Workload" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Container Image</label>
        <input v-model="editForm.image" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Replicas</label>
        <input v-model.number="editForm.replicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Save</button>
    </template>
  </Modal>
</template>
