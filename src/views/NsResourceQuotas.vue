<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const { currentPage, pageSize, paginated, total } = usePagination(computed(() => store.nsResourceQuotas))

// Create ResourceQuota
const showCreateModal = ref(false)
const createForm = ref({
  name: '',
  cpuHard: '8',
  memoryHard: '16Gi',
  podsHard: '20',
  servicesHard: '10',
})

function resetCreate() {
  createForm.value = { name: '', cpuHard: '8', memoryHard: '16Gi', podsHard: '20', servicesHard: '10' }
}

function handleCreate() {
  const f = createForm.value
  store.addResourceQuota({
    name: f.name,
    namespace: route.params.namespace,
    hard: {
      'limits.cpu': f.cpuHard,
      'limits.memory': f.memoryHard,
      pods: f.podsHard,
      services: f.servicesHard,
    },
    used: {
      'limits.cpu': '0',
      'limits.memory': '0Gi',
      pods: '0',
      services: '0',
    },
  })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(rq) {
  deleteTarget.value = rq
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteResourceQuota(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

// Helpers for parsing resource values
function parseCpu(val) {
  if (!val) return 0
  return parseFloat(val)
}

function parseMemory(val) {
  if (!val) return 0
  const str = String(val)
  if (str.endsWith('Gi')) return parseFloat(str)
  if (str.endsWith('Mi')) return parseFloat(str) / 1024
  if (str.endsWith('Ki')) return parseFloat(str) / (1024 * 1024)
  return parseFloat(str)
}

function parseCount(val) {
  if (!val) return 0
  return parseInt(val, 10) || 0
}

function getPercent(used, hard) {
  if (!hard || hard === 0) return 0
  return Math.round((used / hard) * 100)
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'ResourceQuotas' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-lg text-on-surface font-bold">ResourceQuotas</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ store.nsResourceQuotas.length }} ResourceQuotas in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg text-body-sm hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-sm">add</span> New ResourceQuota
      </button>
    </div>

    <div v-if="store.nsResourceQuotas.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Name</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">CPU</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Memory</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Pods</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Age</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant w-24">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/15">
          <tr v-for="row in paginated" :key="row.name" class="hover:bg-surface-container-low/40 cursor-pointer transition-colors" @click="router.push({ name: 'NsResourceQuotaDetail', params: { namespace: route.params.namespace, name: row.name } })">
            <td class="px-md py-2">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-tertiary text-sm">speed</span>
                <span class="font-semibold text-on-surface text-body-sm">{{ row.name }}</span>
              </div>
            </td>
            <td class="px-md py-2">
              <div class="flex flex-col gap-xs min-w-[120px]">
                <div class="flex justify-between text-body-xs">
                  <span class="text-on-surface-variant">{{ row.used?.['limits.cpu'] || '0' }} / {{ row.hard?.['limits.cpu'] || '-' }}</span>
                  <span class="font-medium" :class="getPercent(parseCpu(row.used?.['limits.cpu']), parseCpu(row.hard?.['limits.cpu'])) > 80 ? 'text-error' : 'text-primary'">
                    {{ getPercent(parseCpu(row.used?.['limits.cpu']), parseCpu(row.hard?.['limits.cpu'])) }}%
                  </span>
                </div>
                <ProgressBar :value="getPercent(parseCpu(row.used?.['limits.cpu']), parseCpu(row.hard?.['limits.cpu']))" size="sm" />
              </div>
            </td>
            <td class="px-md py-2">
              <div class="flex flex-col gap-xs min-w-[120px]">
                <div class="flex justify-between text-body-xs">
                  <span class="text-on-surface-variant">{{ row.used?.['limits.memory'] || '0' }} / {{ row.hard?.['limits.memory'] || '-' }}</span>
                  <span class="font-medium" :class="getPercent(parseMemory(row.used?.['limits.memory']), parseMemory(row.hard?.['limits.memory'])) > 80 ? 'text-error' : 'text-primary'">
                    {{ getPercent(parseMemory(row.used?.['limits.memory']), parseMemory(row.hard?.['limits.memory'])) }}%
                  </span>
                </div>
                <ProgressBar :value="getPercent(parseMemory(row.used?.['limits.memory']), parseMemory(row.hard?.['limits.memory']))" size="sm" />
              </div>
            </td>
            <td class="px-md py-2">
              <div class="flex flex-col gap-xs min-w-[100px]">
                <div class="flex justify-between text-body-xs">
                  <span class="text-on-surface-variant">{{ row.used?.pods || '0' }} / {{ row.hard?.pods || '-' }}</span>
                  <span class="font-medium" :class="getPercent(parseCount(row.used?.pods), parseCount(row.hard?.pods)) > 80 ? 'text-error' : 'text-primary'">
                    {{ getPercent(parseCount(row.used?.pods), parseCount(row.hard?.pods)) }}%
                  </span>
                </div>
                <ProgressBar :value="getPercent(parseCount(row.used?.pods), parseCount(row.hard?.pods))" size="sm" />
              </div>
            </td>
            <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-md py-2" @click.stop>
              <div class="flex gap-1">
                <button @click="router.push({ name: 'NsResourceQuotaDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">open_in_new</span></button>
                <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-sm">delete</span></button>
              </div>
            </td>
          </tr>
          <tr v-if="!store.nsResourceQuotas.length">
            <td :colspan="6" class="px-md py-md text-center">
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
      <p class="text-on-surface-variant text-body-sm mt-xs">No ResourceQuotas in this namespace</p>
      <button @click="showCreateModal = true" class="mt-xs px-3 py-1.5 bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">Create ResourceQuota</button>
    </div>
  </section>

  <!-- Create ResourceQuota Modal -->
  <Modal v-model="showCreateModal" title="Create ResourceQuota" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">ResourceQuota Name *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-quota" />
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">CPU Limit</label>
          <input v-model="createForm.cpuHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="8" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Memory Limit</label>
          <input v-model="createForm.memoryHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="16Gi" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Pods Limit</label>
          <input v-model="createForm.podsHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="20" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Services Limit</label>
          <input v-model="createForm.servicesHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="10" />
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleCreate" :disabled="!createForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete ResourceQuota" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete ResourceQuota <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Removing a ResourceQuota may allow uncontrolled resource consumption. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
