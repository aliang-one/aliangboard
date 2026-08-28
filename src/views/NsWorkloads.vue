<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useTableColumns } from '@/composables/useTableColumns'
import { useQueryClient } from '@tanstack/vue-query'
import { exportYaml } from '@/api/client'
import { readMeta } from '@/composables/useBusinessMeta'
import StatusChip from '@/components/common/StatusChip.vue'
import DataTable from '@/components/common/DataTable.vue'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DropdownMenu from '@/components/common/DropdownMenu.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import CreateWithYamlButton from '@/components/common/CreateWithYamlButton.vue'
import CopyWorkloadDialog from '@/components/common/CopyWorkloadDialog.vue'
import WatchStateChip from '@/components/common/WatchStateChip.vue'

const { t } = useI18n()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('nsWorkloads'))

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()

const showCopyDialog = ref(false)

// Workloads 走 Vue Query（cluster-wide deploy+sts+ds + 按 ns 过滤）：watch live 零轮询，降级 60s 兜底。
const cid = computed(() => (store.currentCluster || 'cluster'))
const wlState = computed(() => store.watchStateOf('workloads'))
const wlInterval = computed(() => (wlState.value === 'live' || wlState.value === 'reconnecting') ? false : 60000)
const workloadsKey = ['cluster', cid, 'workloads']
const workloadsQuery = useResourceList({
  key: workloadsKey,
  fetcher: () => store.fetchWorkloads(),
  options: { refetchInterval: wlInterval, refetchOnWindowFocus: false },
})
const nsWorkloads = computed(() => (workloadsQuery.data.value || []).filter(w => w.namespace === route.params.namespace))

const typeFilter = ref('All')
const statusFilter = ref('All')
const searchQuery = ref('')

const typeOptions = ['All', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']
const statusOptions = ['All', 'Running', 'Pending', 'Failed', 'Succeeded']

const filtered = computed(() => {
  let list = nsWorkloads.value
  if (typeFilter.value !== 'All') list = list.filter(w => w.type === typeFilter.value)
  if (statusFilter.value !== 'All') list = list.filter(w => w.status === statusFilter.value)
  const q = searchQuery.value.trim().toLowerCase()
  if (q) list = list.filter(w => w.name.toLowerCase().includes(q) || (w.image || '').toLowerCase().includes(q))
  return list
})

const deployCount = computed(() => nsWorkloads.value.filter(w => w.type === 'Deployment').length)
const stsCount = computed(() => nsWorkloads.value.filter(w => w.type === 'StatefulSet').length)
const dsCount = computed(() => nsWorkloads.value.filter(w => w.type === 'DaemonSet').length)
const jobCount = computed(() => nsWorkloads.value.filter(w => ['Job', 'CronJob'].includes(w.type)).length)

// 分页
const currentPage = ref(1)
const pageSize = ref(10)
const paginated = computed(() => filtered.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value))
watch([typeFilter, statusFilter, searchQuery], () => { currentPage.value = 1 })

function replicaPercent(replicas) {
  const parts = replicas.split('/')
  if (parts.length !== 2) return 0
  return Math.round((parseInt(parts[0]) / parseInt(parts[1])) * 100)
}

function goDetail(row) {
  router.push({ name: 'NsWorkloadDetail', params: { namespace: route.params.namespace, type: row.type.toLowerCase(), name: row.name } })
}

// 行内导出 YAML（kubectl get -o yaml 语义）：按类型取 apps/batch 的复数路径
const WL_PLURAL = { Deployment: ['apps', 'deployments'], StatefulSet: ['apps', 'statefulsets'], DaemonSet: ['apps', 'daemonsets'], Job: ['batch', 'jobs'], CronJob: ['batch', 'cronjobs'] }
function exportWorkload(row) {
  const g = WL_PLURAL[row.type]
  if (!g) return
  exportYaml(`/apis/${g[0]}/v1/namespaces/${route.params.namespace}/${g[1]}/${encodeURIComponent(row.name)}`, `${row.name}.yaml`)
}

// 行操作菜单
function menuItems(row) {
  return [
    { label: t('ns.workloads.viewDetail'), icon: 'open_in_new', action: () => goDetail(row) },
    { label: t('ns.workloads.exportYaml'), icon: 'download', action: () => exportWorkload(row) },
    { label: t('ns.workloads.restart'), icon: 'refresh', action: () => store.restartWorkload(row.name, route.params.namespace) },
    { label: t('ns.workloads.delete'), icon: 'delete', danger: true, action: () => confirmDelete(row) },
  ]
}

// 删除
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(row) {
  deleteTarget.value = row
  showDeleteModal.value = true
}
async function handleDelete() {
  if (deleteTarget.value) {
    await store.deleteWorkload(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: workloadsKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Workloads' }
    ]" />

    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <div class="flex items-center gap-sm">
          <h2 class="text-headline-md font-bold text-on-surface">{{ t('ns.workloads.title') }}</h2>
          <WatchStateChip :state="wlState" />
        </div>
        <p class="text-body-sm text-on-surface-variant mt-1">{{ t('ns.workloads.subtitle', { count: nsWorkloads.length, ns: route.params.namespace }) }}</p>
      </div>
      <CreateWithYamlButton
        :label="t('ns.workloads.new')"
        icon="rocket_launch"
        :main-action="() => router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })"
        yaml-template="Deployment"
        :namespace="route.params.namespace"
        :extra-items="[{ label: t('component.splitButton.copyWorkload'), icon: 'content_copy', action: () => { showCopyDialog = true } }]"
        @applied="workloadsQuery.refetch()"
      />
      <CopyWorkloadDialog v-model="showCopyDialog" target-route-name="NsDeploy" :default-target-namespace="route.params.namespace" :target-namespace="route.params.namespace" />
    </div>

    <!-- Type Summary -->
    <div class="grid grid-cols-4 gap-sm mb-md">
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant px-sm py-1.5 flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" @click="typeFilter = typeFilter === 'Deployment' ? 'All' : 'Deployment'">
        <span class="material-symbols-outlined text-primary text-base">view_carousel</span>
        <span class="text-body-sm text-on-surface-variant">{{ t('ns.workloads.deployments') }}</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ deployCount }}</span>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant px-sm py-1.5 flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" @click="typeFilter = typeFilter === 'StatefulSet' ? 'All' : 'StatefulSet'">
        <span class="material-symbols-outlined text-secondary text-base">database</span>
        <span class="text-body-sm text-on-surface-variant">{{ t('ns.workloads.statefulSets') }}</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ stsCount }}</span>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant px-sm py-1.5 flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" @click="typeFilter = typeFilter === 'DaemonSet' ? 'All' : 'DaemonSet'">
        <span class="material-symbols-outlined text-tertiary text-base">settings_slow_motion</span>
        <span class="text-body-sm text-on-surface-variant">{{ t('ns.workloads.daemonSets') }}</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ dsCount }}</span>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant px-sm py-1.5 flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" @click="typeFilter = typeFilter === 'Job' ? 'All' : 'Job'">
        <span class="material-symbols-outlined text-on-surface-variant text-base">schedule</span>
        <span class="text-body-sm text-on-surface-variant">{{ t('ns.workloads.jobs') }}</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ jobCount }}</span>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-sm mb-md">
      <div class="relative flex-1 min-w-[200px] max-w-md">
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-10 pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" :placeholder="t('ns.workloads.searchPlaceholder')" />
      </div>
      <select v-model="typeFilter" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary focus:border-primary cursor-pointer">
        <option v-for="t in typeOptions" :key="t" :value="t">{{ t === 'All' ? $t('ns.workloads.allTypes') : t }}</option>
      </select>
      <select v-model="statusFilter" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary focus:border-primary cursor-pointer">
        <option v-for="s in statusOptions" :key="s" :value="s">{{ s === 'All' ? t('ns.workloads.allStatuses') : s }}</option>
      </select>
      <span class="text-body-sm text-on-surface-variant">{{ t('ns.workloads.results', { n: filtered.length }) }}</span>
    </div>

    <!-- Table -->
    <DataTable :headers="headers" :rows="paginated" column-key="nsWorkloads" @row-click="goDetail">
      <template #name="{ row }">
        <div class="flex flex-col">
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
          <span v-if="readMeta(row).title" class="text-xs text-primary">{{ readMeta(row).title }}</span>
          <span class="font-mono text-xs text-on-surface-variant">{{ row.sha }}</span>
        </div>
      </template>
      <template #type="{ row }">
        <span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant">{{ row.type }}</span>
      </template>
      <template #status="{ row }"><StatusChip :status="row.status" size="sm" /></template>
      <template #replicas="{ row }">
        <div class="flex items-center gap-sm">
          <div class="w-14 bg-outline-variant/20 h-1.5 rounded-full overflow-hidden">
            <div class="h-full rounded-full" :class="replicaPercent(row.replicas) === 100 ? 'bg-primary' : replicaPercent(row.replicas) === 0 ? 'bg-error' : 'bg-tertiary-container'" :style="{ width: replicaPercent(row.replicas) + '%' }"></div>
          </div>
          <span class="font-mono text-code-sm font-bold" :class="replicaPercent(row.replicas) === 100 ? 'text-primary' : 'text-tertiary-container'">{{ row.replicas }}</span>
        </div>
      </template>
      <template #image="{ row }"><span class="font-mono text-code-sm text-on-surface-variant">{{ row.image }}</span></template>
      <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
      <template #actions="{ row }"><DropdownMenu :items="menuItems(row)" /></template>
      <template v-if="filtered.length" #pagination>
        <Pagination
          :total="filtered.length"
          :page-size="pageSize"
          :current-page="currentPage"
          show-size-selector
          @page-change="(p) => currentPage = p"
          @size-change="(s) => { pageSize = s; currentPage = 1 }"
        />
      </template>
    </DataTable>
  </section>

  <!-- 删除确认 -->
  <Modal v-model="showDeleteModal" :title="t('ns.workloads.deleteTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('ns.workloads.deleteConfirm', { name: deleteTarget?.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.workloads.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('ns.workloads.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('ns.workloads.delete') }}</button>
    </template>
  </Modal>
</template>
