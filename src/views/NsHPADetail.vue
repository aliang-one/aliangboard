<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail } from '@/composables/useK8sQuery'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const cid = computed(() => (store.currentCluster || 'cluster'))
const hpaDetail = useResourceDetail({
  key: ['cluster', cid, 'hpas', route.params.name],
  fetcher: () => store.fetchHPA(route.params.name, route.params.namespace),
  options: { refetchInterval: 15000 },
})
const hpa = computed(() => hpaDetail.data.value)
const { yaml } = useLiveYaml({
  pathFn: () => `/apis/autoscaling/v2/namespaces/${encodeURIComponent(route.params.namespace)}/horizontalpodautoscalers/${encodeURIComponent(route.params.name)}`,
})

const activeTab = ref('overview')
const showDeleteModal = ref(false)
const showEditModal = ref(false)

// Edit form
const editForm = ref({})
function openEdit() {
  if (!hpa.value) return
  editForm.value = {
    minReplicas: hpa.value.minReplicas,
    maxReplicas: hpa.value.maxReplicas,
    cpuTarget: hpa.value.cpuTarget,
    memoryTarget: hpa.value.memoryTarget,
  }
  showEditModal.value = true
}
function saveEdit() {
  store.updateHPA(route.params.name, route.params.namespace, {
    minReplicas: parseInt(editForm.value.minReplicas),
    maxReplicas: parseInt(editForm.value.maxReplicas),
    cpuTarget: parseInt(editForm.value.cpuTarget),
    memoryTarget: parseInt(editForm.value.memoryTarget),
  })
  showEditModal.value = false
}

async function handleDelete() {
  await store.deleteHPA(route.params.name, route.params.namespace)
  router.push({ name: 'NsHPA', params: { namespace: route.params.namespace } })
}

// Scaling status description
function scalingDescription(h) {
  if (!h) return ''
  if (h.status === 'Scaling') return `Scaling up from ${h.currentReplicas} replicas (CPU at ${h.currentCPU}%)`
  return `Stable at ${h.currentReplicas} replicas (CPU at ${h.currentCPU}%)`
}
</script>

<template>
  <div class="animate-fade-in" v-if="hpa">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'HPA', route: `/ns/${route.params.namespace}/hpa` },
      { label: route.params.name }
    ]" />

    <!-- Header -->
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-secondary text-3xl">speed</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ hpa.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <StatusChip :status="hpa.status" size="sm" />
            <span class="px-2.5 py-0.5 bg-secondary-container/10 text-secondary text-label-caps rounded-full font-medium">HPA</span>
            <span class="text-body-sm text-on-surface-variant">Target: <span class="text-primary font-medium">{{ hpa.targetKind }}/{{ hpa.targetName }}</span></span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ hpa.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
        <button @click="openEdit" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">edit</span> Edit
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'metrics', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <!-- Target Info -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Target Info</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Scale Target</p>
              <p class="font-mono text-code-sm text-primary font-semibold">{{ hpa.targetKind }}/{{ hpa.targetName }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Current Replicas</p>
              <p class="text-headline-md text-on-surface font-bold">{{ hpa.currentReplicas }}</p>
            </div>
          </div>
        </div>

        <!-- Replica Range -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Replica Range</h3>
          <div class="flex items-center gap-lg">
            <div class="flex-1">
              <div class="flex justify-between mb-sm">
                <span class="text-body-sm text-on-surface-variant">Min Replicas</span>
                <span class="text-body-md font-bold text-on-surface">{{ hpa.minReplicas }}</span>
              </div>
              <div class="flex justify-between mb-sm">
                <span class="text-body-sm text-on-surface-variant">Max Replicas</span>
                <span class="text-body-md font-bold text-on-surface">{{ hpa.maxReplicas }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-body-sm text-on-surface-variant">Current</span>
                <span class="text-body-md font-bold text-primary">{{ hpa.currentReplicas }}</span>
              </div>
            </div>
            <div class="w-px h-16 bg-outline-variant/30"></div>
            <div class="flex-1">
              <div class="flex items-center gap-sm mb-sm">
                <span class="text-body-sm text-on-surface-variant">Replica Utilization</span>
              </div>
              <ProgressBar :value="hpa.maxReplicas ? Math.round((hpa.currentReplicas / hpa.maxReplicas) * 100) : 0" :max="100" color="primary" size="md" :show-label="true" :label="`${hpa.currentReplicas} / ${hpa.maxReplicas}`" />
            </div>
          </div>
        </div>

        <!-- Current Metrics -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Current Metrics</h3>
          <div class="space-y-lg">
            <!-- CPU Utilization -->
            <div>
              <div class="flex items-center justify-between mb-sm">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-primary text-lg">memory</span>
                  <span class="text-body-md font-medium text-on-surface">CPU Utilization</span>
                </div>
                <div class="flex items-center gap-md">
                  <span class="text-body-sm text-on-surface-variant">Target: <span class="font-semibold text-on-surface">{{ hpa.cpuTarget }}%</span></span>
                  <span class="text-body-sm" :class="hpa.currentCPU > hpa.cpuTarget ? 'text-error font-semibold' : 'text-on-surface'">Current: <span class="font-bold">{{ hpa.currentCPU }}%</span></span>
                </div>
              </div>
              <ProgressBar :value="hpa.currentCPU" :max="100" color="primary" size="md" />
            </div>
            <!-- Memory Utilization -->
            <div>
              <div class="flex items-center justify-between mb-sm">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">storage</span>
                  <span class="text-body-md font-medium text-on-surface">Memory Utilization</span>
                </div>
                <div class="flex items-center gap-md">
                  <span class="text-body-sm text-on-surface-variant">Target: <span class="font-semibold text-on-surface">{{ hpa.memoryTarget || '-' }}%</span></span>
                  <span class="text-body-sm" :class="hpa.memoryTarget && hpa.currentMemory > hpa.memoryTarget ? 'text-error font-semibold' : 'text-on-surface'">Current: <span class="font-bold">{{ hpa.currentMemory }}%</span></span>
                </div>
              </div>
              <ProgressBar :value="hpa.currentMemory" :max="100" color="secondary" size="md" />
            </div>
          </div>
        </div>
      </div>

      <!-- Right Sidebar -->
      <div class="lg:col-span-4 flex flex-col gap-lg">
        <!-- Summary -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Summary</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Status</span>
              <StatusChip :status="hpa.status" size="sm" />
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Namespace</span>
              <span class="text-body-md font-medium text-primary">{{ hpa.namespace }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Age</span>
              <span class="text-body-md text-on-surface">{{ hpa.age }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Min Replicas</span>
              <span class="text-body-md font-semibold text-on-surface">{{ hpa.minReplicas }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Max Replicas</span>
              <span class="text-body-md font-semibold text-on-surface">{{ hpa.maxReplicas }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Current Replicas</span>
              <span class="text-body-md font-bold text-primary">{{ hpa.currentReplicas }}</span>
            </div>
          </div>
        </div>

        <!-- Scaling Info -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Scaling Status</h3>
          <div class="p-md rounded-lg" :class="hpa.status === 'Scaling' ? 'bg-tertiary-container/10 border border-tertiary-container/20' : 'bg-primary-container/10 border border-primary/20'">
            <div class="flex items-center gap-sm mb-xs">
              <span class="material-symbols-outlined text-lg" :class="hpa.status === 'Scaling' ? 'text-tertiary-container' : 'text-primary'">{{ hpa.status === 'Scaling' ? 'trending_up' : 'check_circle' }}</span>
              <span class="text-body-md font-semibold" :class="hpa.status === 'Scaling' ? 'text-tertiary-container' : 'text-primary'">{{ hpa.status === 'Scaling' ? 'Scaling Up' : 'Stable' }}</span>
            </div>
            <p class="text-body-sm text-on-surface-variant">{{ scalingDescription(hpa) }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Metrics Tab -->
    <div v-if="activeTab === 'metrics'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Configured Metrics</h3>
          <span class="px-2.5 py-0.5 bg-surface-container text-label-caps text-on-surface-variant border border-outline-variant rounded">autoscaling/v2</span>
        </div>
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Metric Name</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Type</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Target Type</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Target Value</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Current Value</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <!-- CPU Metric -->
            <tr class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-primary text-lg">memory</span>
                  <span class="font-semibold text-on-surface text-body-md">cpu</span>
                </div>
              </td>
              <td class="px-lg py-md">
                <span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">Resource</span>
              </td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">Utilization</td>
              <td class="px-lg py-md font-mono text-code-sm font-semibold text-on-surface">{{ hpa.cpuTarget }}%</td>
              <td class="px-lg py-md">
                <span class="font-mono text-code-sm" :class="hpa.currentCPU > hpa.cpuTarget ? 'text-error font-semibold' : 'text-on-surface'">{{ hpa.currentCPU }}%</span>
              </td>
              <td class="px-lg py-md">
                <span class="px-2.5 py-0.5 rounded-full text-label-caps font-medium" :class="hpa.currentCPU > hpa.cpuTarget ? 'bg-error-container/40 text-error' : 'bg-primary-container/20 text-primary'">{{ hpa.currentCPU > hpa.cpuTarget ? 'Above Target' : 'Within Target' }}</span>
              </td>
            </tr>
            <!-- Memory Metric -->
            <tr class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">storage</span>
                  <span class="font-semibold text-on-surface text-body-md">memory</span>
                </div>
              </td>
              <td class="px-lg py-md">
                <span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">Resource</span>
              </td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">Utilization</td>
              <td class="px-lg py-md font-mono text-code-sm font-semibold text-on-surface">{{ hpa.memoryTarget || '-' }}%</td>
              <td class="px-lg py-md">
                <span class="font-mono text-code-sm" :class="hpa.memoryTarget && hpa.currentMemory > hpa.memoryTarget ? 'text-error font-semibold' : 'text-on-surface'">{{ hpa.currentMemory }}%</span>
              </td>
              <td class="px-lg py-md">
                <span class="px-2.5 py-0.5 rounded-full text-label-caps font-medium" :class="hpa.memoryTarget && hpa.currentMemory > hpa.memoryTarget ? 'bg-error-container/40 text-error' : 'bg-primary-container/20 text-primary'">{{ hpa.memoryTarget && hpa.currentMemory > hpa.memoryTarget ? 'Above Target' : 'Within Target' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Metrics Detail Cards -->
      <div class="grid grid-cols-2 gap-lg mt-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <div class="flex items-center gap-sm mb-md">
            <span class="material-symbols-outlined text-primary">memory</span>
            <h3 class="text-headline-sm">CPU Metric Detail</h3>
          </div>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Resource Name</span>
              <span class="font-mono text-code-sm text-on-surface">cpu</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Metric Type</span>
              <span class="text-body-md text-on-surface">Resource</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Target Type</span>
              <span class="text-body-md text-on-surface">Utilization</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Average Utilization</span>
              <span class="font-mono text-code-sm text-primary font-semibold">{{ hpa.cpuTarget }}%</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Current Utilization</span>
              <span class="font-mono text-code-sm" :class="hpa.currentCPU > hpa.cpuTarget ? 'text-error font-bold' : 'text-on-surface font-semibold'">{{ hpa.currentCPU }}%</span>
            </div>
          </div>
        </div>
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <div class="flex items-center gap-sm mb-md">
            <span class="material-symbols-outlined text-secondary">storage</span>
            <h3 class="text-headline-sm">Memory Metric Detail</h3>
          </div>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Resource Name</span>
              <span class="font-mono text-code-sm text-on-surface">memory</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Metric Type</span>
              <span class="text-body-md text-on-surface">Resource</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Target Type</span>
              <span class="text-body-md text-on-surface">Utilization</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Average Utilization</span>
              <span class="font-mono text-code-sm text-primary font-semibold">{{ hpa.memoryTarget || '-' }}%</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Current Utilization</span>
              <span class="font-mono text-code-sm" :class="hpa.memoryTarget && hpa.currentMemory > hpa.memoryTarget ? 'text-error font-bold' : 'text-on-surface font-semibold'">{{ hpa.currentMemory }}%</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>
  </div>

  <!-- Not Found -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">HPA Not Found</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">HorizontalPodAutoscaler "{{ route.params.name }}" not found in namespace "{{ route.params.namespace }}"</p>
    <button @click="router.push({ name: 'NsHPA', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to HPAs</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete HPA" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete HorizontalPodAutoscaler <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">The target workload will no longer be autoscaled. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" title="Edit HPA" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Min Replicas</label>
          <input v-model.number="editForm.minReplicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Max Replicas</label>
          <input v-model.number="editForm.maxReplicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">CPU Target (%)</label>
          <input v-model.number="editForm.cpuTarget" type="number" min="1" max="100" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Memory Target (%)</label>
          <input v-model.number="editForm.memoryTarget" type="number" min="1" max="100" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveEdit" :disabled="editForm.minReplicas > editForm.maxReplicas" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Save</button>
    </template>
  </Modal>
</template>
