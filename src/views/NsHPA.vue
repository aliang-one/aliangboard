<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const { currentPage, pageSize, paginated, total } = usePagination(computed(() => store.nsHPAs))

// Create HPA
const showCreateModal = ref(false)
const createForm = ref({ name: '', targetName: '', targetKind: 'Deployment', minReplicas: 1, maxReplicas: 10, cpuTarget: 80 })

function resetCreate() {
  createForm.value = { name: '', targetName: '', targetKind: 'Deployment', minReplicas: 1, maxReplicas: 10, cpuTarget: 80 }
}

function handleCreate() {
  const f = createForm.value
  store.addHPA({
    name: f.name,
    namespace: route.params.namespace,
    targetName: f.targetName,
    targetKind: f.targetKind,
    minReplicas: parseInt(f.minReplicas),
    maxReplicas: parseInt(f.maxReplicas),
    currentReplicas: parseInt(f.minReplicas),
    cpuTarget: parseInt(f.cpuTarget),
    memoryTarget: 80,
    currentCPU: 0,
    currentMemory: 0,
    status: 'Ok',
  })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(hpa) {
  deleteTarget.value = hpa
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteHPA(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

function hpaStatus(status) {
  if (status === 'Ok') return 'Running'
  if (status === 'Scaling') return 'Pending'
  return status
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'HPA' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">HorizontalPodAutoscalers</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ store.nsHPAs.length }} HPAs in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg text-body-sm hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-sm">add</span> Create HPA
      </button>
    </div>

    <div v-if="store.nsHPAs.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Name</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Target</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Min/Max Replicas</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Current Replicas</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">CPU Target</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">CPU Current</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Status</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Age</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant w-24">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/15">
          <tr v-for="row in paginated" :key="row.name" class="hover:bg-surface-container-low/40 cursor-pointer transition-colors" @click="router.push({ name: 'NsHPADetail', params: { namespace: route.params.namespace, name: row.name } })">
            <td class="px-md py-2">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary text-sm">speed</span>
                <span class="font-semibold text-on-surface text-body-sm">{{ row.name }}</span>
              </div>
            </td>
            <td class="px-md py-2">
              <div class="flex flex-col">
                <span class="text-body-sm font-medium text-on-surface">{{ row.targetName }}</span>
                <span class="text-xs text-on-surface-variant">{{ row.targetKind }}</span>
              </div>
            </td>
            <td class="px-md py-2">
              <span class="font-mono text-xs">
                <span class="text-on-surface font-semibold">{{ row.minReplicas }}</span>
                <span class="text-on-surface-variant mx-xs">/</span>
                <span class="text-on-surface font-semibold">{{ row.maxReplicas }}</span>
              </span>
            </td>
            <td class="px-md py-2">
              <div class="flex items-center gap-sm">
                <div class="w-14 bg-outline-variant/20 h-1.5 rounded-full overflow-hidden">
                  <div class="h-full rounded-full transition-all duration-500" :class="row.currentReplicas >= row.maxReplicas ? 'bg-error' : row.currentReplicas > row.minReplicas ? 'bg-tertiary-container' : 'bg-primary'" :style="{ width: (row.maxReplicas ? Math.round((row.currentReplicas / row.maxReplicas) * 100) : 0) + '%' }"></div>
                </div>
                <span class="font-mono text-xs font-bold text-primary">{{ row.currentReplicas }}</span>
              </div>
            </td>
            <td class="px-md py-2">
              <span class="font-mono text-xs text-on-surface-variant">{{ row.cpuTarget }}%</span>
            </td>
            <td class="px-md py-2">
              <span class="font-mono text-xs" :class="row.currentCPU > row.cpuTarget ? 'text-error font-semibold' : 'text-on-surface-variant'">{{ row.currentCPU }}%</span>
            </td>
            <td class="px-md py-2">
              <StatusChip :status="row.status" size="sm" />
            </td>
            <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-md py-2" @click.stop>
              <div class="flex gap-1">
                <button @click="router.push({ name: 'NsHPADetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">open_in_new</span></button>
                <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-sm">delete</span></button>
              </div>
            </td>
          </tr>
          <tr v-if="!store.nsHPAs.length">
            <td :colspan="9" class="px-md py-md text-center">
              <span class="material-symbols-outlined text-2xl text-surface-container-high block mb-sm">inbox</span>
              <p class="text-on-surface-variant text-body-sm">暂无数据</p>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="total > pageSize" class="flex items-center justify-between px-md py-2 border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>
    </div>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">speed</span>
      <p class="text-on-surface-variant text-body-sm mt-xs">No HorizontalPodAutoscalers in this namespace</p>
      <button @click="showCreateModal = true" class="mt-xs px-3 py-1.5 bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">Create HPA</button>
    </div>
  </section>

  <!-- Create HPA Modal -->
  <Modal v-model="showCreateModal" title="Create HorizontalPodAutoscaler" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">HPA Name *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-app-hpa" />
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Target Name *</label>
          <input v-model="createForm.targetName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-deployment" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Target Kind</label>
          <select v-model="createForm.targetKind" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
            <option>Deployment</option>
            <option>StatefulSet</option>
            <option>ReplicaSet</option>
          </select>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Min Replicas</label>
          <input v-model.number="createForm.minReplicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Max Replicas</label>
          <input v-model.number="createForm.maxReplicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">CPU Target Utilization (%)</label>
        <input v-model.number="createForm.cpuTarget" type="number" min="1" max="100" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleCreate" :disabled="!createForm.name || !createForm.targetName || createForm.minReplicas > createForm.maxReplicas" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete HPA" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete HPA <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">The target workload will no longer be autoscaled. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
