<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const rq = computed(() => store.getResourceQuotaByName(route.params.name, route.params.namespace))
const { yaml } = useLiveYaml({
  pathFn: () => `/api/v1/namespaces/${encodeURIComponent(route.params.namespace)}/resourcequotas/${encodeURIComponent(route.params.name)}`,
  mockFn: () => store.generateYAML('resourcequota', rq.value),
})

const activeTab = ref('overview')
const showDeleteModal = ref(false)
const showEditModal = ref(false)

// Edit form
const editForm = ref({
  cpuHard: '',
  memoryHard: '',
  podsHard: '',
  servicesHard: '',
  pvcHard: '',
  storageHard: '',
})

function openEditModal() {
  if (!rq.value) return
  editForm.value = {
    cpuHard: rq.value.hard?.['limits.cpu'] || '',
    memoryHard: rq.value.hard?.['limits.memory'] || '',
    podsHard: rq.value.hard?.pods || '',
    servicesHard: rq.value.hard?.services || '',
    pvcHard: rq.value.hard?.persistentvolumeclaims || '',
    storageHard: rq.value.hard?.['requests.storage'] || '',
  }
  showEditModal.value = true
}

function handleEdit() {
  const f = editForm.value
  const hard = {}
  const used = { ...rq.value.used }
  if (f.cpuHard) hard['limits.cpu'] = f.cpuHard
  if (f.memoryHard) hard['limits.memory'] = f.memoryHard
  if (f.podsHard) hard.pods = f.podsHard
  if (f.servicesHard) hard.services = f.servicesHard
  if (f.pvcHard) hard.persistentvolumeclaims = f.pvcHard
  if (f.storageHard) hard['requests.storage'] = f.storageHard
  store.updateResourceQuota(route.params.name, route.params.namespace, { hard, used })
  showEditModal.value = false
}

async function handleDelete() {
  await store.deleteResourceQuota(route.params.name, route.params.namespace)
  router.push({ name: 'NsResourceQuotas', params: { namespace: route.params.namespace } })
}

// Compute all hard/used entries for overview
const quotaEntries = computed(() => {
  if (!rq.value) return []
  const hard = rq.value.hard || {}
  const used = rq.value.used || {}
  return Object.entries(hard).map(([key, hardVal]) => ({
    key,
    hard: hardVal,
    used: used[key] || '0',
    percent: getPercent(used[key] || '0', hardVal),
  }))
})

// Friendly names for quota keys
const friendlyNames = {
  'limits.cpu': 'CPU Limits',
  'limits.memory': 'Memory Limits',
  'requests.cpu': 'CPU Requests',
  'requests.memory': 'Memory Requests',
  'pods': 'Pods',
  'services': 'Services',
  'persistentvolumeclaims': 'PersistentVolumeClaims',
  'requests.storage': 'Storage Requests',
  'replicationcontrollers': 'ReplicationControllers',
  'resourcequotas': 'ResourceQuotas',
  'secrets': 'Secrets',
  'configmaps': 'ConfigMaps',
}

function friendlyName(key) {
  return friendlyNames[key] || key
}

function parseNumeric(val) {
  if (!val) return 0
  const str = String(val)
  if (str.endsWith('Gi')) return parseFloat(str)
  if (str.endsWith('Mi')) return parseFloat(str) / 1024
  if (str.endsWith('Ki')) return parseFloat(str) / (1024 * 1024)
  if (str.endsWith('m')) return parseFloat(str) / 1000
  return parseFloat(str) || 0
}

function getPercent(used, hard) {
  const u = parseNumeric(used)
  const h = parseNumeric(hard)
  if (!h || h === 0) return 0
  return Math.min(Math.round((u / h) * 100), 100)
}
</script>

<template>
  <div class="animate-fade-in" v-if="rq">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'ResourceQuotas', route: `/ns/${route.params.namespace}/resourcequotas` },
      { label: route.params.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-tertiary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-tertiary text-3xl">speed</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ rq.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-tertiary-container/10 text-tertiary text-label-caps rounded-full font-medium">ResourceQuota</span>
            <span class="text-body-sm text-on-surface-variant">{{ quotaEntries.length }} resources tracked</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ rq.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="openEditModal" class="flex items-center gap-sm px-md py-sm border border-outline-variant text-on-surface font-semibold rounded-lg hover:bg-surface-container-low transition-colors">
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

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <h3 class="text-headline-sm">Resource Usage ({{ quotaEntries.length }} quotas)</h3>
        </div>
        <div class="divide-y divide-outline-variant/30">
          <div v-for="entry in quotaEntries" :key="entry.key" class="px-lg py-md">
            <div class="flex items-center justify-between mb-xs">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-on-surface-variant text-lg">
                  {{ entry.key.includes('cpu') ? 'memory' : entry.key.includes('memory') ? 'memory_alt' : entry.key === 'pods' ? 'dataset' : entry.key === 'services' ? 'hub' : 'pie_chart' }}
                </span>
                <span class="font-medium text-on-surface text-body-md">{{ friendlyName(entry.key) }}</span>
                <span class="font-mono text-label-caps text-on-surface-variant">({{ entry.key }})</span>
              </div>
              <span class="font-semibold text-body-md" :class="entry.percent > 80 ? 'text-error' : entry.percent > 60 ? 'text-tertiary-container' : 'text-primary'">
                {{ entry.percent }}%
              </span>
            </div>
            <div class="flex items-center gap-md">
              <ProgressBar :value="entry.percent" size="md" class="flex-1" />
              <span class="text-body-sm text-on-surface-variant whitespace-nowrap min-w-[160px] text-right">
                {{ entry.used }} / {{ entry.hard }}
              </span>
            </div>
          </div>
          <div v-if="!quotaEntries.length" class="px-lg py-xl text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-3xl">speed</span>
            <p class="mt-sm">No quota entries</p>
          </div>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>
  </div>
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">ResourceQuota Not Found</h2>
    <button @click="router.push({ name: 'NsResourceQuotas', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to ResourceQuotas</button>
  </div>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" title="Edit ResourceQuota" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">CPU Limit</label>
          <input v-model="editForm.cpuHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Memory Limit</label>
          <input v-model="editForm.memoryHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Pods Limit</label>
          <input v-model="editForm.podsHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Services Limit</label>
          <input v-model="editForm.servicesHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">PVC Limit</label>
          <input v-model="editForm.pvcHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Storage Limit</label>
          <input v-model="editForm.storageHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Save Changes</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete ResourceQuota" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete ResourceQuota <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Removing a ResourceQuota may allow uncontrolled resource consumption. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
