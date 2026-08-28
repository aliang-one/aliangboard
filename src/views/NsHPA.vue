<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useQueryClient } from '@tanstack/vue-query'
import { useTableColumns } from '@/composables/useTableColumns'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'
import CreateWithYamlButton from '@/components/common/CreateWithYamlButton.vue'

const { t } = useI18n()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('nsHPA'))
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()

// HPAs 走 Vue Query（cluster-wide + 按 ns 过滤）：远端 30s 轮询 + 聚焦重拉 + 新鲜度。
// targetOptions 仍读 nsWorkloads.value（不同资源，下拉用，保留 store 读）。
const cid = computed(() => (store.currentCluster || 'cluster'))
const wlState = computed(() => store.watchStateOf('workloads'))
const wlInterval = computed(() => (wlState.value === 'live' || wlState.value === 'reconnecting') ? false : 60000)
const hpasKey = ['cluster', cid, 'hpas']
const hpasQuery = useResourceList({
  key: hpasKey,
  fetcher: () => store.fetchHPAs(),
  options: { refetchInterval: 30000 },
})
const nsHPAs = computed(() => (hpasQuery.data.value || []).filter(h => h.namespace === route.params.namespace))
// 目标 Workload 下拉源走 Vue Query（nsWorkloads.value 在 remote 下孤立）
const wlsQ = useResourceList({ key: ['cluster', cid, 'workloads'], fetcher: () => store.fetchWorkloads(), options: { refetchInterval: wlInterval, refetchOnWindowFocus: false } })
const nsWorkloads = computed(() => (wlsQ.data.value || []).filter(w => w.namespace === route.params.namespace))

const { currentPage, pageSize, paginated, total } = usePagination(nsHPAs)

// Create HPA
const showCreateModal = ref(false)
const createForm = ref({ name: '', targetName: '', targetKind: 'Deployment', minReplicas: 1, maxReplicas: 10, cpuTarget: 80, memoryTarget: 80 })

// 可选目标工作负载（按 targetKind 过滤）
const targetOptions = computed(() => nsWorkloads.value.filter(w => w.type === createForm.value.targetKind).map(w => w.name))

function resetCreate() {
  createForm.value = { name: '', targetName: '', targetKind: 'Deployment', minReplicas: 1, maxReplicas: 10, cpuTarget: 80, memoryTarget: 80 }
}

// 切换 targetKind 时清空 targetName（旧选项不属于新 kind）
watch(() => createForm.value.targetKind, () => { createForm.value.targetName = '' })

async function handleCreate() {
  const f = createForm.value
  await store.addHPA({
    name: f.name,
    namespace: route.params.namespace,
    targetName: f.targetName,
    targetKind: f.targetKind,
    minReplicas: parseInt(f.minReplicas),
    maxReplicas: parseInt(f.maxReplicas),
    currentReplicas: parseInt(f.minReplicas),
    cpuTarget: parseInt(f.cpuTarget),
    memoryTarget: parseInt(f.memoryTarget),
    currentCPU: 0,
    currentMemory: 0,
    status: 'Ok',
  })
  queryClient.invalidateQueries({ queryKey: hpasKey })
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
async function handleDelete() {
  if (deleteTarget.value) {
    await store.deleteHPA(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: hpasKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

function hpaStatus(status) {
  if (status === 'Ok') return 'Running'
  if (status === 'Scaling') return 'Pending'
  return status
}

function goDetail(row) {
  router.push({ name: 'NsHPADetail', params: { namespace: route.params.namespace, name: row.name } })
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: $t('ns.hpa.title') }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ $t('ns.hpa.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ $t('ns.hpa.subtitle', { n: nsHPAs.length, ns: route.params.namespace }) }}</p>
      </div>
      <CreateWithYamlButton :label="t('ns.hpa.createBtn')" :main-action="() => { showCreateModal = true }" yaml-template="HorizontalPodAutoscaler" :namespace="route.params.namespace" />
    </div>

    <DataTable :headers="headers" :rows="paginated" column-key="nsHPA" @row-click="goDetail">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-secondary text-sm">speed</span>
          <span class="font-semibold text-on-surface text-body-sm">{{ row.name }}</span>
        </div>
      </template>
      <template #target="{ row }">
        <div class="flex flex-col">
          <span class="text-body-sm font-medium text-on-surface">{{ row.targetName }}</span>
          <span class="text-xs text-on-surface-variant">{{ row.targetKind }}</span>
        </div>
      </template>
      <template #minMaxReplicas="{ row }">
        <span class="font-mono text-xs">
          <span class="text-on-surface font-semibold">{{ row.minReplicas }}</span>
          <span class="text-on-surface-variant mx-xs">/</span>
          <span class="text-on-surface font-semibold">{{ row.maxReplicas }}</span>
        </span>
      </template>
      <template #currentReplicas="{ row }">
        <div class="flex items-center gap-sm">
          <div class="w-14 bg-outline-variant/20 h-1.5 rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-500" :class="row.currentReplicas >= row.maxReplicas ? 'bg-error' : row.currentReplicas > row.minReplicas ? 'bg-tertiary-container' : 'bg-primary'" :style="{ width: (row.maxReplicas ? Math.round((row.currentReplicas / row.maxReplicas) * 100) : 0) + '%' }"></div>
          </div>
          <span class="font-mono text-xs font-bold text-primary">{{ row.currentReplicas }}</span>
        </div>
      </template>
      <template #cpuTarget="{ row }">
        <span class="font-mono text-xs text-on-surface-variant">{{ row.cpuTarget }}%</span>
      </template>
      <template #cpuCurrent="{ row }">
        <span class="font-mono text-xs" :class="row.currentCPU > row.cpuTarget ? 'text-error font-semibold' : 'text-on-surface-variant'">{{ row.currentCPU }}%</span>
      </template>
      <template #status="{ row }"><StatusChip :status="row.status" size="sm" /></template>
      <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
      <template #actions="{ row }">
        <div class="flex gap-1">
          <button @click.stop="goDetail(row)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">open_in_new</span></button>
          <button @click.stop="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-sm">delete</span></button>
        </div>
      </template>
      <template v-if="nsHPAs.length" #pagination>
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>

  <!-- Create HPA Modal -->
  <Modal v-model="showCreateModal" :title="$t('ns.hpa.createModalTitle')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.hpa.hpaNameLabel') }}</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-app-hpa" />
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.hpa.targetKindLabel') }}</label>
          <select v-model="createForm.targetKind" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
            <option>Deployment</option>
            <option>StatefulSet</option>
            <option>DaemonSet</option>
          </select>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.hpa.targetNameLabel') }}</label>
          <select v-model="createForm.targetName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
            <option value="" disabled>{{ $t('ns.hpa.targetNamePlaceholder') }}</option>
            <option v-for="name in targetOptions" :key="name" :value="name">{{ name }}</option>
          </select>
          <p v-if="!targetOptions.length" class="text-[10px] text-on-surface-variant/60 mt-xs">{{ $t('ns.hpa.targetKindHint', { kind: createForm.targetKind }) }}</p>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.hpa.minReplicasLabel') }}</label>
          <input v-model.number="createForm.minReplicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.hpa.maxReplicasLabel') }}</label>
          <input v-model.number="createForm.maxReplicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.hpa.cpuTargetLabel') }}</label>
          <input v-model.number="createForm.cpuTarget" type="number" min="1" max="100" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.hpa.memoryTargetLabel') }}</label>
          <input v-model.number="createForm.memoryTarget" type="number" min="1" max="100" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="handleCreate" :disabled="!createForm.name || !createForm.targetName || createForm.minReplicas > createForm.maxReplicas" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ $t('common.create') }}</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="$t('ns.hpa.deleteModalTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ $t('ns.hpa.deleteConfirm', { name: deleteTarget?.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ $t('ns.hpa.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('common.delete') }}</button>
    </template>
  </Modal>
</template>
