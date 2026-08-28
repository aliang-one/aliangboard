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
import ProgressBar from '@/components/common/ProgressBar.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'
import { cpuToMilli, milliToCpu, formatCpu } from '@/composables/useResourceFormat'
import CreateWithYamlButton from '@/components/common/CreateWithYamlButton.vue'

const { t } = useI18n()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('nsResourceQuotas'))
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()

const cid = computed(() => (store.currentCluster || 'cluster'))
const resourcequotasKey = ['cluster', cid, 'resourcequotas']
const resourcequotasQuery = useResourceList({
  key: resourcequotasKey,
  fetcher: () => store.fetchResourceQuotas(),
  options: { refetchInterval: 30000 },
})
const nsResourceQuotas = computed(() => (resourcequotasQuery.data.value || []).filter(r => r.namespace === route.params.namespace))

const { currentPage, pageSize, paginated, total } = usePagination(nsResourceQuotas)

// Create ResourceQuota
const showCreateModal = ref(false)
const createForm = ref({
  name: '',
  cpuHard: '8000',
  memoryHard: '16Gi',
  podsHard: '20',
  servicesHard: '10',
})

function resetCreate() {
  createForm.value = { name: '', cpuHard: '8000', memoryHard: '16Gi', podsHard: '20', servicesHard: '10' }
}

async function handleCreate() {
  const f = createForm.value
  await store.addResourceQuota({
    name: f.name,
    namespace: route.params.namespace,
    hard: {
      'limits.cpu': milliToCpu(Number(f.cpuHard)),
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
  queryClient.invalidateQueries({ queryKey: resourcequotasKey })
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
async function handleDelete() {
  if (deleteTarget.value) {
    await store.deleteResourceQuota(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: resourcequotasKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

// Helpers for parsing resource values
function parseCpu(val) {
  return cpuToMilli(val)
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

function goDetail(row) {
  router.push({ name: 'NsResourceQuotaDetail', params: { namespace: route.params.namespace, name: row.name } })
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: $t('ns.resourceQuotas.title') }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ $t('ns.resourceQuotas.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ $t('ns.resourceQuotas.subtitle', { n: nsResourceQuotas.length, ns: route.params.namespace }) }}</p>
      </div>
      <CreateWithYamlButton :label="t('ns.resourceQuotas.newBtn')" :main-action="() => { showCreateModal = true }" yaml-template="ResourceQuota" :namespace="route.params.namespace" />
    </div>

    <DataTable :headers="headers" :rows="paginated" column-key="nsResourceQuotas" @row-click="goDetail">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-tertiary text-sm">speed</span>
          <span class="font-semibold text-on-surface text-body-sm">{{ row.name }}</span>
        </div>
      </template>
      <template #cpu="{ row }">
        <div class="flex flex-col gap-xs min-w-[120px]">
          <div class="flex justify-between text-xs">
            <span class="text-on-surface-variant">{{ formatCpu(cpuToMilli(row.used?.['limits.cpu'])) }} / {{ formatCpu(cpuToMilli(row.hard?.['limits.cpu'])) }}</span>
            <span class="font-medium" :class="getPercent(parseCpu(row.used?.['limits.cpu']), parseCpu(row.hard?.['limits.cpu'])) > 80 ? 'text-error' : 'text-primary'">
              {{ getPercent(parseCpu(row.used?.['limits.cpu']), parseCpu(row.hard?.['limits.cpu'])) }}%
            </span>
          </div>
          <ProgressBar :value="getPercent(parseCpu(row.used?.['limits.cpu']), parseCpu(row.hard?.['limits.cpu']))" size="sm" />
        </div>
      </template>
      <template #memory="{ row }">
        <div class="flex flex-col gap-xs min-w-[120px]">
          <div class="flex justify-between text-xs">
            <span class="text-on-surface-variant">{{ row.used?.['limits.memory'] || '0' }} / {{ row.hard?.['limits.memory'] || '-' }}</span>
            <span class="font-medium" :class="getPercent(parseMemory(row.used?.['limits.memory']), parseMemory(row.hard?.['limits.memory'])) > 80 ? 'text-error' : 'text-primary'">
              {{ getPercent(parseMemory(row.used?.['limits.memory']), parseMemory(row.hard?.['limits.memory'])) }}%
            </span>
          </div>
          <ProgressBar :value="getPercent(parseMemory(row.used?.['limits.memory']), parseMemory(row.hard?.['limits.memory']))" size="sm" />
        </div>
      </template>
      <template #pods="{ row }">
        <div class="flex flex-col gap-xs min-w-[100px]">
          <div class="flex justify-between text-xs">
            <span class="text-on-surface-variant">{{ row.used?.pods || '0' }} / {{ row.hard?.pods || '-' }}</span>
            <span class="font-medium" :class="getPercent(parseCount(row.used?.pods), parseCount(row.hard?.pods)) > 80 ? 'text-error' : 'text-primary'">
              {{ getPercent(parseCount(row.used?.pods), parseCount(row.hard?.pods)) }}%
            </span>
          </div>
          <ProgressBar :value="getPercent(parseCount(row.used?.pods), parseCount(row.hard?.pods))" size="sm" />
        </div>
      </template>
      <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
      <template #actions="{ row }">
        <div class="flex gap-1">
          <button @click.stop="goDetail(row)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">open_in_new</span></button>
          <button @click.stop="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-sm">delete</span></button>
        </div>
      </template>
      <template v-if="nsResourceQuotas.length" #pagination>
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>

  <!-- Create ResourceQuota Modal -->
  <Modal v-model="showCreateModal" :title="$t('ns.resourceQuotas.createModalTitle')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.resourceQuotas.quotaNameLabel') }}</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-quota" />
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.resourceQuotas.cpuLimitLabel') }} <span class="text-on-surface-variant/60 text-xs normal-case font-normal ml-xs">(millicores, 1=1000m)</span></label>
          <input v-model="createForm.cpuHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="8000" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.resourceQuotas.memoryLimitLabel') }}</label>
          <input v-model="createForm.memoryHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="16Gi" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.resourceQuotas.podsLimitLabel') }}</label>
          <input v-model="createForm.podsHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="20" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.resourceQuotas.servicesLimitLabel') }}</label>
          <input v-model="createForm.servicesHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="10" />
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="handleCreate" :disabled="!createForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ $t('common.create') }}</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="$t('ns.resourceQuotas.deleteModalTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant" v-html="$t('ns.resourceQuotas.deleteConfirm', { name: deleteTarget?.name })"></p>
    <p class="text-body-sm text-error mt-sm">{{ $t('ns.resourceQuotas.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('common.delete') }}</button>
    </template>
  </Modal>
</template>
