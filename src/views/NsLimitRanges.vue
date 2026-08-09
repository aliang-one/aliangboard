<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useQueryClient } from '@tanstack/vue-query'
import { useTableColumns } from '@/composables/useTableColumns'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const { t } = useI18n()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('nsLimitRanges'))
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()

const cid = computed(() => (store.currentCluster || 'cluster'))
const limitrangesKey = ['cluster', cid.value, 'limitranges']
const limitrangesQuery = useResourceList({
  key: limitrangesKey,
  fetcher: () => store.fetchLimitRanges(),
  options: { refetchInterval: 30000 },
})
const nsLimitRanges = computed(() => (limitrangesQuery.data.value || []).filter(l => l.namespace === route.params.namespace))

const { currentPage, pageSize, paginated, total } = usePagination(computed(() => nsLimitRanges))

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

async function handleCreate() {
  const f = createForm.value
  await store.addLimitRange({
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
  queryClient.invalidateQueries({ queryKey: limitrangesKey })
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
async function handleDelete() {
  if (deleteTarget.value) {
    await store.deleteLimitRange(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: limitrangesKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

function goDetail(row) {
  router.push({ name: 'NsLimitRangeDetail', params: { namespace: route.params.namespace, name: row.name } })
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: $t('ns.limitRanges.title') }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ $t('ns.limitRanges.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ $t('ns.limitRanges.subtitle', { n: nsLimitRanges.length, ns: route.params.namespace }) }}</p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg text-body-sm hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-sm">add</span> {{ $t('ns.limitRanges.newBtn') }}
      </button>
    </div>

    <DataTable :headers="headers" :rows="paginated" column-key="nsLimitRanges" @row-click="goDetail">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-secondary text-sm">tune</span>
          <span class="font-semibold text-on-surface text-body-sm">{{ row.name }}</span>
        </div>
      </template>
      <template #defaultCPU="{ row }">
        <span class="inline-flex items-center gap-xs px-2 py-0.5 bg-primary-container/10 text-primary text-xs font-mono rounded">
          {{ row.defaultCPU }}
        </span>
      </template>
      <template #defaultMemory="{ row }">
        <span class="inline-flex items-center gap-xs px-2 py-0.5 bg-primary-container/10 text-primary text-xs font-mono rounded">
          {{ row.defaultMemory }}
        </span>
      </template>
      <template #maxCPU="{ row }">
        <span class="inline-flex items-center gap-xs px-2 py-0.5 bg-secondary-container/10 text-secondary text-xs font-mono rounded">
          {{ row.maxCPU }}
        </span>
      </template>
      <template #maxMemory="{ row }">
        <span class="inline-flex items-center gap-xs px-2 py-0.5 bg-secondary-container/10 text-secondary text-xs font-mono rounded">
          {{ row.maxMemory }}
        </span>
      </template>
      <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
      <template #actions="{ row }">
        <div class="flex gap-1">
          <button @click.stop="goDetail(row)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">open_in_new</span></button>
          <button @click.stop="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-sm">delete</span></button>
        </div>
      </template>
      <template v-if="nsLimitRanges.length" #pagination>
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>

  <!-- Create LimitRange Modal -->
  <Modal v-model="showCreateModal" :title="$t('ns.limitRanges.createModalTitle')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.limitRanges.limitRangeNameLabel') }}</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-limits" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.limitRanges.defaultLimitsLabel') }}</label>
        <div class="grid grid-cols-2 gap-md">
          <input v-model="createForm.defaultCPU" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="500m" />
          <input v-model="createForm.defaultMemory" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="512Mi" />
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.limitRanges.defaultRequestsLabel') }}</label>
        <div class="grid grid-cols-2 gap-md">
          <input v-model="createForm.defaultRequestCPU" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="250m" />
          <input v-model="createForm.defaultRequestMemory" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="256Mi" />
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.limitRanges.maxLimitsLabel') }}</label>
        <div class="grid grid-cols-2 gap-md">
          <input v-model="createForm.maxCPU" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="2" />
          <input v-model="createForm.maxMemory" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="4Gi" />
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.limitRanges.minLimitsLabel') }}</label>
        <div class="grid grid-cols-2 gap-md">
          <input v-model="createForm.minCPU" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="50m" />
          <input v-model="createForm.minMemory" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="64Mi" />
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="handleCreate" :disabled="!createForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ $t('common.create') }}</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="$t('ns.limitRanges.deleteModalTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ $t('ns.limitRanges.deleteConfirm', { name: deleteTarget?.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ $t('ns.limitRanges.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('common.delete') }}</button>
    </template>
  </Modal>
</template>
