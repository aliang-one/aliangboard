<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const { currentPage, pageSize, paginated, total } = usePagination(computed(() => store.nsLimitRanges))

// Create LimitRange
const showCreateModal = ref(false)
const createForm = ref({
  name: '',
  defaultCPU: '500m',
  defaultMemory: '512Mi',
  defaultRequestCPU: '250m',
  defaultRequestMemory: '256Mi',
  maxCPU: '2',
  maxMemory: '4Gi',
  minCPU: '50m',
  minMemory: '64Mi',
})

function resetCreate() {
  createForm.value = {
    name: '',
    defaultCPU: '500m',
    defaultMemory: '512Mi',
    defaultRequestCPU: '250m',
    defaultRequestMemory: '256Mi',
    maxCPU: '2',
    maxMemory: '4Gi',
    minCPU: '50m',
    minMemory: '64Mi',
  }
}

function handleCreate() {
  const f = createForm.value
  store.addLimitRange({
    name: f.name,
    namespace: route.params.namespace,
    defaultCPU: f.defaultCPU,
    defaultMemory: f.defaultMemory,
    defaultRequestCPU: f.defaultRequestCPU,
    defaultRequestMemory: f.defaultRequestMemory,
    maxCPU: f.maxCPU,
    maxMemory: f.maxMemory,
    minCPU: f.minCPU,
    minMemory: f.minMemory,
  })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(lr) {
  deleteTarget.value = lr
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteLimitRange(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'LimitRanges' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">LimitRanges</h2>
        <p class="text-on-surface-variant text-body-md mt-1">{{ store.nsLimitRanges.length }} LimitRanges in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
        <span class="material-symbols-outlined">add</span> New LimitRange
      </button>
    </div>

    <div v-if="store.nsLimitRanges.length" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Default CPU</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Default Memory</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Max CPU</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Max Memory</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-24">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr v-for="row in paginated" :key="row.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="router.push({ name: 'NsLimitRangeDetail', params: { namespace: route.params.namespace, name: row.name } })">
            <td class="px-lg py-md">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary text-lg">tune</span>
                <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
              </div>
            </td>
            <td class="px-lg py-md">
              <span class="inline-flex items-center gap-xs px-2 py-0.5 bg-primary-container/10 text-primary text-body-sm font-mono rounded">
                {{ row.defaultCPU }}
              </span>
            </td>
            <td class="px-lg py-md">
              <span class="inline-flex items-center gap-xs px-2 py-0.5 bg-primary-container/10 text-primary text-body-sm font-mono rounded">
                {{ row.defaultMemory }}
              </span>
            </td>
            <td class="px-lg py-md">
              <span class="inline-flex items-center gap-xs px-2 py-0.5 bg-secondary-container/10 text-secondary text-body-sm font-mono rounded">
                {{ row.maxCPU }}
              </span>
            </td>
            <td class="px-lg py-md">
              <span class="inline-flex items-center gap-xs px-2 py-0.5 bg-secondary-container/10 text-secondary text-body-sm font-mono rounded">
                {{ row.maxMemory }}
              </span>
            </td>
            <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-lg py-md" @click.stop>
              <div class="flex gap-1">
                <button @click="router.push({ name: 'NsLimitRangeDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-lg">open_in_new</span></button>
                <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
              </div>
            </td>
          </tr>
          <tr v-if="!store.nsLimitRanges.length">
            <td :colspan="7" class="px-lg py-xl text-center">
              <span class="material-symbols-outlined text-4xl text-surface-container-high block mb-sm">inbox</span>
              <p class="text-on-surface-variant">暂无数据</p>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="total > pageSize" class="flex items-center justify-between px-lg py-md border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>
    </div>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">tune</span>
      <p class="text-on-surface-variant mt-md">No LimitRanges in this namespace</p>
      <button @click="showCreateModal = true" class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">Create LimitRange</button>
    </div>
  </section>

  <!-- Create LimitRange Modal -->
  <Modal v-model="showCreateModal" title="Create LimitRange" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">LimitRange Name *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-limits" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Default Limits</label>
        <div class="grid grid-cols-2 gap-md">
          <input v-model="createForm.defaultCPU" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="500m" />
          <input v-model="createForm.defaultMemory" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="512Mi" />
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Default Requests</label>
        <div class="grid grid-cols-2 gap-md">
          <input v-model="createForm.defaultRequestCPU" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="250m" />
          <input v-model="createForm.defaultRequestMemory" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="256Mi" />
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Max Limits</label>
        <div class="grid grid-cols-2 gap-md">
          <input v-model="createForm.maxCPU" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="2" />
          <input v-model="createForm.maxMemory" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="4Gi" />
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Min Limits</label>
        <div class="grid grid-cols-2 gap-md">
          <input v-model="createForm.minCPU" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="50m" />
          <input v-model="createForm.minMemory" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="64Mi" />
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleCreate" :disabled="!createForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete LimitRange" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete LimitRange <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Removing a LimitRange removes default resource constraints for containers. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
