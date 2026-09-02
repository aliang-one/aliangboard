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
import CreateWithYamlButton from '@/components/common/CreateWithYamlButton.vue'

const { t } = useI18n()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('nsPDBs'))
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()

const cid = computed(() => (store.currentCluster || 'cluster'))
const pdbsKey = ['cluster', cid, 'pdbs']
const pdbsQuery = useResourceList({
  key: pdbsKey,
  fetcher: () => store.fetchPDBs(),
  options: { refetchInterval: 30000 },
})
const nsPDBs = computed(() => (pdbsQuery.data.value || []).filter(p => p.namespace === route.params.namespace))

const search = ref('')

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return nsPDBs.value
  return nsPDBs.value.filter(p => p.name.toLowerCase().includes(q))
})

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [search] })

// Create PDB
const showCreateModal = ref(false)
const createForm = ref({
  name: '',
  selectorApp: '',
  constraintType: 'minAvailable', // 'minAvailable' | 'maxUnavailable'
  minAvailable: '',
  maxUnavailable: '',
  desiredHealthy: '',
})

function resetCreate() {
  createForm.value = {
    name: '',
    selectorApp: '',
    constraintType: 'minAvailable',
    minAvailable: '',
    maxUnavailable: '',
    desiredHealthy: '',
  }
}

async function handleCreate() {
  const f = createForm.value
  const minAvailable = f.constraintType === 'minAvailable' ? String(f.minAvailable) : ''
  const maxUnavailable = f.constraintType === 'maxUnavailable' ? String(f.maxUnavailable) : ''
  const desiredHealthy = Number(f.desiredHealthy) || 0
  await store.addPDB({
    name: f.name,
    namespace: route.params.namespace,
    minAvailable,
    maxUnavailable,
    selector: { app: f.selectorApp },
    allowedDisruptions: 0,
    currentHealthy: desiredHealthy,
    desiredHealthy,
    age: 'Just now',
  })
  queryClient.invalidateQueries({ queryKey: pdbsKey })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(pdb) {
  deleteTarget.value = pdb
  showDeleteModal.value = true
}
async function handleDelete() {
  if (deleteTarget.value) {
    await store.deletePDB(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: pdbsKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

// Helpers
const selectorEntries = (sel) => sel ? Object.entries(sel) : []

const allowedBadgeClass = (n) => {
  if (n > 0) return 'bg-primary-container/20 text-primary border-primary/20'
  return 'bg-error-container/20 text-error border-error/20'
}

const isHealthy = (row) => row.currentHealthy >= row.desiredHealthy

function goDetail(row) {
  router.push({ name: 'NsPDBDetail', params: { namespace: route.params.namespace, name: row.name } })
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: $t('ns.pdb.title') }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ $t('ns.pdb.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">
          {{ $t('ns.pdb.subtitle', { n: nsPDBs.length }) }}
        </p>
      </div>
      <CreateWithYamlButton :label="t('ns.pdb.newBtn')" :main-action="() => { showCreateModal = true }" yaml-template="PodDisruptionBudget" :namespace="route.params.namespace" />
    </div>

    <!-- Search -->
    <div class="flex flex-wrap items-center gap-sm mb-md">
      <div class="relative flex-1 min-w-[200px] max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="search" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-1.5 text-body-sm focus:ring-2 focus:ring-primary focus:border-primary" :placeholder="$t('ns.pdb.searchPlaceholder')" />
        <button v-if="search" @click="search = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
          <span class="material-symbols-outlined text-lg">close</span>
        </button>
      </div>
      <span class="text-xs text-on-surface-variant">{{ filtered.length }} / {{ nsPDBs.length }}</span>
    </div>

    <DataTable :headers="headers" :rows="paginated" column-key="nsPDBs" @row-click="goDetail">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary text-sm">shield</span>
          <span class="font-semibold text-on-surface text-body-sm">{{ row.name }}</span>
        </div>
      </template>
      <template #selector="{ row }">
        <div class="flex flex-wrap gap-xs max-w-xs">
          <span v-for="([k, v]) in selectorEntries(row.selector)" :key="k" class="px-1.5 py-0.5 bg-surface-container text-xs text-on-surface-variant rounded border border-outline-variant font-mono">
            {{ k }}={{ v }}
          </span>
        </div>
      </template>
      <template #budget="{ row }">
        <div class="flex flex-col">
          <span v-if="row.minAvailable" class="text-xs text-on-surface font-mono">
            <span class="text-on-surface-variant">minAvailable:</span> {{ row.minAvailable }}
          </span>
          <span v-else-if="row.maxUnavailable" class="text-xs text-on-surface font-mono">
            <span class="text-on-surface-variant">maxUnavailable:</span> {{ row.maxUnavailable }}
          </span>
          <span v-else class="text-xs text-on-surface-variant">—</span>
        </div>
      </template>
      <template #allowedDisruptions="{ row }">
        <span class="inline-flex items-center justify-center min-w-[2rem] px-2 py-0.5 rounded-full text-xs font-bold border" :class="allowedBadgeClass(row.allowedDisruptions)">
          {{ row.allowedDisruptions }}
        </span>
      </template>
      <template #healthy="{ row }">
        <div class="flex items-center gap-xs">
          <span class="text-xs font-mono font-semibold" :class="isHealthy(row) ? 'text-on-surface' : 'text-error'">{{ row.currentHealthy }}</span>
          <span class="text-on-surface-variant text-xs">/</span>
          <span class="text-xs font-mono text-on-surface-variant">{{ row.desiredHealthy }}</span>
          <span v-if="!isHealthy(row)" class="material-symbols-outlined text-error text-sm" :title="$t('ns.pdb.notReady')">warning</span>
        </div>
      </template>
      <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
      <template #actions="{ row }">
        <div class="flex gap-1">
          <button @click.stop="goDetail(row)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined text-sm">open_in_new</span>
          </button>
          <button @click.stop="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg">
            <span class="material-symbols-outlined text-sm">delete</span>
          </button>
        </div>
      </template>
      <template v-if="filtered.length" #pagination>
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>

  <!-- Create PDB Modal -->
  <Modal v-model="showCreateModal" :title="$t('ns.pdb.createModalTitle')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.pdb.pdbNameLabel') }}</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="api-gateway-pdb" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.pdb.selectorLabel') }}</label>
        <div class="flex items-center gap-sm">
          <span class="font-mono text-on-surface-variant text-body-md">app=</span>
          <input v-model="createForm.selectorApp" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="api-gateway" />
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.pdb.constraintTypeLabel') }}</label>
        <div class="flex gap-md">
          <label class="flex items-center gap-xs cursor-pointer">
            <input type="radio" v-model="createForm.constraintType" value="minAvailable" class="text-primary focus:ring-primary" />
            <span class="text-body-md text-on-surface">{{ $t('ns.pdb.minAvailableLabel') }}</span>
          </label>
          <label class="flex items-center gap-xs cursor-pointer">
            <input type="radio" v-model="createForm.constraintType" value="maxUnavailable" class="text-primary focus:ring-primary" />
            <span class="text-body-md text-on-surface">{{ $t('ns.pdb.maxUnavailableLabel') }}</span>
          </label>
        </div>
        <div class="mt-sm">
          <input v-if="createForm.constraintType === 'minAvailable'" v-model="createForm.minAvailable" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="$t('ns.pdb.minAvailablePlaceholder')" />
          <input v-else v-model="createForm.maxUnavailable" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="$t('ns.pdb.maxUnavailablePlaceholder')" />
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.pdb.desiredHealthyLabel') }}</label>
        <input v-model="createForm.desiredHealthy" type="number" min="0" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="$t('ns.pdb.desiredHealthyPlaceholder')" />
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="handleCreate" :disabled="!createForm.name || !createForm.selectorApp || (createForm.constraintType === 'minAvailable' ? !createForm.minAvailable : !createForm.maxUnavailable)" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ $t('common.create') }}</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="$t('ns.pdb.deleteModalTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ $t('ns.pdb.deleteConfirm', { name: deleteTarget?.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ $t('ns.pdb.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('common.delete') }}</button>
    </template>
  </Modal>
</template>
