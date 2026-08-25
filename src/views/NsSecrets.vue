<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useTableColumns } from '@/composables/useTableColumns'
import { useQueryClient } from '@tanstack/vue-query'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import CreateConfigResourceModal from '@/components/common/CreateConfigResourceModal.vue'
import { usePagination } from '@/composables/usePagination'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('nsSecrets'))
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()

// Secrets 走 Vue Query（cluster-wide + 按 ns 过滤）：远端 30s 轮询 + 聚焦重拉 + 新鲜度。
const cid = computed(() => (store.currentCluster || 'cluster'))
const secretsKey = ['cluster', cid, 'secrets']
const secretsQuery = useResourceList({
  key: secretsKey,
  fetcher: () => store.fetchSecrets(),
  options: { refetchInterval: 30000 },
})
const nsSecrets = computed(() => (secretsQuery.data.value || []).filter(s => s.namespace === route.params.namespace))

const typeFilter = ref('All')
const search = ref('')
const typeOptions = computed(() => {
  const types = new Set(nsSecrets.value.map(s => s.type))
  return ['All', ...types]
})

const filtered = computed(() => {
  let list = nsSecrets.value
  if (typeFilter.value !== 'All') {
    list = list.filter(s => s.type === typeFilter.value)
  }
  const q = search.value.trim().toLowerCase()
  if (q) {
    list = list.filter(s => {
      if (s.name.toLowerCase().includes(q)) return true
      return Object.keys(s.data || {}).some(k => k.toLowerCase().includes(q))
    })
  }
  return list
})

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [typeFilter, search] })

// Create Secret（富 Modal：类型模板/校验/组装均在 CreateConfigResourceModal + secretTemplates 内）
const showCreateModal = ref(false)
function onCreated() {
  queryClient.invalidateQueries({ queryKey: secretsKey })
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(sec) {
  deleteTarget.value = sec
  showDeleteModal.value = true
}
async function handleDelete() {
  if (deleteTarget.value) {
    await store.deleteSecret(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: secretsKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

const typeColor = (type) => {
  if (type.includes('tls')) return 'bg-primary-container/10 text-primary border-primary/20'
  if (type.includes('docker')) return 'bg-secondary-container/10 text-secondary border-secondary/20'
  if (type.includes('service-account')) return 'bg-tertiary-container/10 text-tertiary border-tertiary/20'
  return 'bg-surface-container text-on-surface-variant border-outline-variant'
}

// 批量选择（DataTable 发射行对象数组）
const selected = ref([])
const showBatchModal = ref(false)
function confirmBatchDelete() { if (selected.value.length) showBatchModal.value = true }
function handleBatchDelete() {
  selected.value.forEach(row => store.deleteSecret(row.name, route.params.namespace))
  queryClient.invalidateQueries({ queryKey: secretsKey })
  selected.value = []
  showBatchModal.value = false
}
function goDetail(row) {
  router.push({ name: 'NsSecretDetail', params: { namespace: route.params.namespace, name: row.name } })
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Secrets' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ t('ns.secrets.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('ns.secrets.subtitle', { count: nsSecrets.length, ns: route.params.namespace }) }}</p>
      </div>
      <button data-testid="open-create" @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg text-body-sm hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-sm">add</span> {{ t('ns.secrets.new') }}
      </button>
    </div>

    <!-- Type Filter + Search -->
    <div class="flex flex-wrap items-center gap-sm mb-md">
      <div class="flex flex-wrap gap-xs">
        <button v-for="opt in typeOptions" :key="opt" @click="typeFilter = opt"
          class="px-md py-xs rounded-full text-xs font-medium border transition-all"
          :class="typeFilter === opt ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:border-primary'">
          {{ opt }}
        </button>
      </div>
      <div class="relative flex-1 min-w-[200px] max-w-md ml-auto">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="search" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-1.5 text-body-sm focus:ring-2 focus:ring-primary focus:border-primary" :placeholder="t('ns.secrets.searchPlaceholder')" />
        <button v-if="search" @click="search = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface">
          <span class="material-symbols-outlined text-lg">close</span>
        </button>
      </div>
      <span class="text-xs text-on-surface-variant">{{ filtered.length }} / {{ nsSecrets.length }}</span>
      <div v-if="selected.length" class="flex items-center gap-sm ml-auto px-md py-xs bg-primary-container/10 border border-primary/20 rounded-lg">
        <span class="text-xs font-medium text-primary">{{ t('ns.secrets.selected', { n: selected.length }) }}</span>
        <button @click="confirmBatchDelete" class="flex items-center gap-xs px-sm py-xs bg-error text-on-error rounded text-xs font-semibold hover:opacity-90">
          <span class="material-symbols-outlined text-sm">delete</span>{{ t('ns.secrets.batchDelete') }}
        </button>
        <button @click="selected = []" class="text-xs text-on-surface-variant hover:text-on-surface">{{ t('ns.secrets.cancel') }}</button>
      </div>
    </div>

    <DataTable v-if="filtered.length" :headers="headers" :rows="paginated" column-key="nsSecrets" selectable v-model:selection="selected" row-key="name" @row-click="goDetail">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-tertiary text-sm">key</span>
          <span class="font-semibold text-on-surface text-body-sm">{{ row.name }}</span>
        </div>
      </template>
      <template #type="{ row }">
        <span class="px-2 py-0.5 rounded text-xs border" :class="typeColor(row.type)">{{ row.type }}</span>
      </template>
      <template #keys="{ row }"><span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-surface-container text-xs font-bold text-on-surface-variant border border-outline-variant">{{ row.keys }}</span></template>
      <template #preview="{ row }">
        <div class="flex flex-wrap gap-xs max-w-xs">
          <span v-for="k in Object.keys(row.data || {}).slice(0, 3)" :key="k" class="px-1.5 py-0.5 bg-surface-container text-xs text-on-surface-variant rounded border border-outline-variant">{{ k }}</span>
          <span v-if="Object.keys(row.data || {}).length > 3" class="text-xs text-on-surface-variant">+{{ Object.keys(row.data).length - 3 }}</span>
        </div>
      </template>
      <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
      <template #actions="{ row }">
        <div class="flex gap-1 justify-end">
          <button @click.stop="goDetail(row)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">open_in_new</span></button>
          <button @click.stop="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-sm">delete</span></button>
        </div>
      </template>
      <template v-if="total > pageSize" #pagination>
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">{{ (search || typeFilter !== 'All') ? 'search_off' : 'key' }}</span>
      <p class="text-on-surface-variant text-body-sm mt-xs">{{ (search || typeFilter !== 'All') ? t('ns.secrets.noMatch') : t('ns.secrets.empty') }}</p>
      <button v-if="search || typeFilter !== 'All'" @click="search = ''; typeFilter = 'All'" class="mt-xs px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium hover:bg-surface-container-high">{{ t('ns.secrets.clearFilter') }}</button>
      <button v-else data-testid="open-create" @click="showCreateModal = true" class="mt-xs px-3 py-1.5 bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">{{ t('ns.secrets.createShort') }}</button>
    </div>
  </section>

  <!-- Create Secret Modal（富组件：类型模板/固定字段/YAML 均在其中） -->
  <CreateConfigResourceModal v-model="showCreateModal" kind="secret" :namespace="route.params.namespace" @created="onCreated" />

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="t('ns.secrets.deleteTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('ns.secrets.deleteConfirm', { name: deleteTarget?.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.secrets.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>

  <!-- Batch Delete Modal -->
  <Modal v-model="showBatchModal" :title="t('ns.secrets.batchTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('ns.secrets.batchConfirm', { n: selected.length }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.secrets.batchWarning') }}</p>
    <template #actions>
      <button @click="showBatchModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleBatchDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('ns.secrets.deleteAll') }}</button>
    </template>
  </Modal>
</template>
