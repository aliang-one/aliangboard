<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { exportYaml, api } from '@/api/client'
import { usePodBatchDelete } from '@/composables/usePodBatchDelete'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import PodCard from '@/components/common/PodCard.vue'
import StatusSummaryCard from '@/components/common/StatusSummaryCard.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import WatchStateChip from '@/components/common/WatchStateChip.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()
store.setNamespace(route.params.namespace)

const cid = computed(() => (store.currentCluster || 'cluster'))
const podsState = computed(() => store.watchStateOf('pods'))
const podsQuery = useResourceList({
  key: ['cluster', cid, 'pods'],
  fetcher: () => store.fetchPods(),
  select: list => list.filter(p => p.namespace === route.params.namespace),
})
const nsPods = computed(() => podsQuery.data.value || [])

const searchQuery = ref('')
const statusFilter = ref('All')
const nodeFilter = ref('All Nodes')

const statusOptions = ['All', 'Running', 'Pending', 'Failed', 'Succeeded']
const nodeOptions = computed(() => {
  const nodes = [...new Set(nsPods.value.map(p => p.node).filter(Boolean))]
  return ['All Nodes', ...nodes.sort()]
})

const filtered = computed(() => {
  let list = nsPods.value
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(p => p.name.toLowerCase().includes(q) || p.ip.includes(q))
  }
  if (statusFilter.value !== 'All') list = list.filter(p => p.status === statusFilter.value)
  if (nodeFilter.value !== 'All Nodes') list = list.filter(p => p.node === nodeFilter.value)
  return list
})

// 分页
const currentPage = ref(1)
const pageSize = ref(10)
const paginated = computed(() => filtered.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value))
// 筛选条件变化时回到第 1 页
watch([searchQuery, statusFilter, nodeFilter], () => { currentPage.value = 1 })

// Pod 实时监听（watch）：远端模式可开关；离开页面停止，避免长连接泄漏
function toggleLive() { store.podWatchLive ? store.stopPodWatch() : store.startPodWatch() }
onUnmounted(() => { if (store.podWatchLive) store.stopPodWatch() })

// 行内导出 YAML（PodCard 的 actions 插槽按钮用）
function exportPod(p) {
  exportYaml(`/api/v1/namespaces/${route.params.namespace}/pods/${encodeURIComponent(p.name)}`, `${p.name}.yaml`)
}

// 删除 Pod
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(row) {
  deleteTarget.value = row
  showDeleteModal.value = true
}
async function handleDelete() {
  const p = deleteTarget.value
  if (!p) return
  try {
    await store.deletePod(p.name, route.params.namespace)
    notify('success', t('ns.pods.deletedPod', { name: p.name }))
    showDeleteModal.value = false
    deleteTarget.value = null
    // deletePod 内已 invalidateResource('pods')：列表即时对齐；控制器重建的新 Pod 由 30s 轮询/Live watch 补
  } catch (e) {
    notify('error', e.message || t('ns.pods.deleteFailed'))
  }
}

// === 批量删除(卡片选择模式;逻辑在 usePodBatchDelete,选中集跨分页/筛选保留) ===
const {
  batchMode, selectedNames, showBatchModal, enterBatch, exitBatch,
  selectAllCandidates, clearSelection, batchTargets, batchNamesPreview, onCardClick, handleBatchDelete,
} = usePodBatchDelete({
  universe: nsPods,
  candidates: filtered,
  getNamespace: () => route.params.namespace,
  onOpen: p => router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } }),
})

// 创建 Pod（真实 API：POST 最小 Pod manifest + invalidate；P2-B 前 store.addPod 纯本地 push → 静默无效）
const showCreateModal = ref(false)
const creating = ref(false)
const createForm = ref({ name: '', image: '', container: '' })
function resetCreate() {
  createForm.value = { name: '', image: '', container: '' }
}
async function handleCreate() {
  const f = createForm.value
  if (!f.name || !f.image) return
  creating.value = true
  try {
    const manifest = {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: f.name, namespace: route.params.namespace, labels: { app: f.name } },
      spec: { containers: [{ name: f.container || f.name, image: f.image }] },
    }
    await api.k8s(`/api/v1/namespaces/${encodeURIComponent(route.params.namespace)}/pods`, {
      method: 'POST', body: JSON.stringify(manifest),
    })
    store.invalidateResource('pods')
    notify('success', t('ns.pods.createdPod', { name: f.name }))
    showCreateModal.value = false
    resetCreate()
  } catch (e) {
    notify('error', e.message || t('ns.pods.createFailed'))
  } finally { creating.value = false }
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Pods' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md font-bold text-on-surface">{{ t('ns.pods.title') }}</h2>
        <p class="text-body-sm text-on-surface-variant mt-1">{{ t('ns.pods.subtitle', { count: nsPods.length, ns: route.params.namespace }) }}</p>
      </div>
      <div class="flex items-center gap-sm">
        <WatchStateChip :state="podsState" />
        <button v-if="!batchMode" @click="enterBatch"
          class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-medium rounded-lg border bg-surface-container-highest text-on-surface border-outline-variant hover:bg-surface-container transition-colors"
          :title="t('ns.pods.batchEnter')">
          <span class="material-symbols-outlined">delete_sweep</span> {{ t('ns.pods.batchEnter') }}
        </button>
        <button v-else @click="exitBatch"
          class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-medium rounded-lg border bg-primary-container/20 text-primary border-primary transition-colors"
          :title="t('ns.pods.batchExit')">
          <span class="material-symbols-outlined">close</span> {{ t('ns.pods.batchExit') }}
        </button>
        <button @click="toggleLive"
          class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-medium rounded-lg border transition-colors"
          :class="store.podWatchLive ? 'bg-primary-container/20 text-primary border-primary' : 'bg-surface-container-highest text-on-surface border-outline-variant hover:bg-surface-container'"
          :title="store.podWatchLive ? t('ns.pods.liveOn') : t('ns.pods.liveOff')">
          <span class="material-symbols-outlined">{{ store.podWatchLive ? 'pause' : 'play_arrow' }}</span>
          <span class="flex items-center gap-xs">LIVE
            <span v-if="store.podWatchLive" class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-status"></span>
          </span>
        </button>
        <button @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined">add</span> {{ t('ns.pods.createShort') }}
        </button>
      </div>
    </div>

    <!-- Status Summary(环形分布 + 点击过滤,等价旧 4 格栏) -->
    <StatusSummaryCard :pods="nsPods" :status-filter="statusFilter" @filter="(s) => statusFilter = s" />

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-sm mb-md">
      <div class="relative flex-1 min-w-[200px] max-w-md">
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-10 pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" :placeholder="t('ns.pods.searchPlaceholder')" />
      </div>
      <select v-model="statusFilter" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary focus:border-primary cursor-pointer">
        <option v-for="s in statusOptions" :key="s" :value="s">{{ s === 'All' ? t('ns.pods.allStatuses') : s }}</option>
      </select>
      <select v-model="nodeFilter" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary focus:border-primary cursor-pointer">
        <option v-for="n in nodeOptions" :key="n" :value="n">{{ n }}</option>
      </select>
      <span class="text-body-sm text-on-surface-variant">{{ t('ns.pods.results', { n: filtered.length }) }}</span>
      <template v-if="batchMode">
        <span class="text-body-sm font-semibold text-primary">{{ t('ns.pods.batchSelected', { n: batchTargets.length }) }}</span>
        <button @click="selectAllCandidates" class="px-sm py-xs text-body-sm border border-outline-variant rounded-lg hover:bg-surface-container-low">{{ t('ns.pods.batchSelectAll') }}</button>
        <button @click="clearSelection" class="px-sm py-xs text-body-sm border border-outline-variant rounded-lg hover:bg-surface-container-low">{{ t('ns.pods.batchClear') }}</button>
        <button @click="showBatchModal = true" :disabled="!batchTargets.length"
          class="flex items-center gap-xs px-sm py-xs text-body-sm font-semibold bg-error text-on-error rounded-lg hover:opacity-90 disabled:opacity-40">
          <span class="material-symbols-outlined text-base">delete</span>{{ t('ns.pods.batchDeleteAction') }}
        </button>
      </template>
    </div>

    <!-- Pods Table -->
    <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <div v-if="filtered.length" class="p-sm flex flex-col gap-xs">
        <PodCard
          v-for="p in paginated" :key="p.name" :pod="p" show-delete
          :selectable="batchMode" :selected="batchMode && selectedNames.has(p.name)"
          @click="onCardClick"
          @delete="confirmDelete"
        >
          <template #actions>
            <button @click.stop="exportPod(p)" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant/50 hover:text-primary transition-colors shrink-0 relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="t('ns.pods.exportYaml')">
              <span class="material-symbols-outlined text-sm">download</span>
            </button>
          </template>
        </PodCard>
      </div>
      <div v-else class="py-md text-center">
        <span class="material-symbols-outlined text-2xl text-surface-container-high block mb-sm">search_off</span>
        <p class="text-body-sm text-on-surface-variant">{{ t('ns.pods.noMatch') }}</p>
      </div>
      <!-- 分页 -->
      <div v-if="filtered.length" class="flex items-center justify-between px-md py-md border-t border-outline-variant bg-surface-container-low">
        <Pagination
          :total="filtered.length"
          :page-size="pageSize"
          :current-page="currentPage"
          show-size-selector
          @page-change="(p) => currentPage = p"
          @size-change="(s) => { pageSize = s; currentPage = 1 }"
        />
      </div>
    </div>
  </section>

  <!-- 删除确认 -->
  <Modal v-model="showDeleteModal" :title="t('ns.pods.deleteTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('ns.pods.deleteConfirm', { name: deleteTarget?.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.pods.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>

  <!-- 创建 Pod -->
  <Modal v-model="showCreateModal" :title="t('ns.pods.createTitle')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.pods.nameLabel') }}</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="my-pod" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.pods.imageLabel') }}</label>
        <input v-model="createForm.image" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="nginx:latest" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.pods.containerLabel') }}</label>
        <input v-model="createForm.container" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="t('ns.pods.containerPlaceholder')" />
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleCreate" :disabled="!createForm.name || !createForm.image" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('common.create') }}</button>
    </template>
  </Modal>

  <!-- 批量删除确认 -->
  <Modal v-model="showBatchModal" :title="t('ns.pods.batchDeleteTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface">{{ t('ns.pods.batchDeleteConfirm', { n: batchTargets.length, names: batchNamesPreview }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.pods.batchDeleteWarning') }}</p>
    <template #actions>
      <button @click="showBatchModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleBatchDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>
</template>
