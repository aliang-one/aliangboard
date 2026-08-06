<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useQueryClient } from '@tanstack/vue-query'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()

// ConfigMaps 走 Vue Query（cluster-wide + 按 ns 过滤）：远端 30s 轮询 + 聚焦重拉 + 新鲜度。
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const configmapsKey = ['cluster', cid.value, 'configmaps']
const configmapsQuery = useResourceList({
  key: configmapsKey,
  fetcher: () => store.fetchConfigMaps(),
  mock: store.configMapList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const nsConfigMaps = computed(() => (configmapsQuery.data.value || []).filter(c => c.namespace === route.params.namespace))

// 搜索过滤
const search = ref('')
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return nsConfigMaps
  return nsConfigMaps.filter(cm => {
    if (cm.name.toLowerCase().includes(q)) return true
    return Object.keys(cm.data || {}).some(k => k.toLowerCase().includes(q))
  })
})

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [search] })

// Create ConfigMap
const showCreateModal = ref(false)
const createForm = ref({ name: '', keys: [{ key: '', value: '' }] })

function resetCreate() {
  createForm.value = { name: '', keys: [{ key: '', value: '' }] }
}

function addCreateKey() {
  createForm.value.keys.push({ key: '', value: '' })
}
function removeCreateKey(idx) {
  createForm.value.keys.splice(idx, 1)
}

async function handleCreate() {
  const f = createForm.value
  const data = {}
  f.keys.forEach(k => { if (k.key) data[k.key] = k.value })
  const r = await store.addConfigMap({
    name: f.name,
    namespace: route.params.namespace,
    keys: Object.keys(data).length,
    data,
  })
  if (r && r.ok === false) return   // 远端创建失败：保留弹窗（错误已由 store notify）
  queryClient.invalidateQueries({ queryKey: configmapsKey })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(cm) {
  deleteTarget.value = cm
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteConfigMap(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: configmapsKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

// 批量选择
const selected = ref(new Set())
function toggleSelect(name) {
  const s = new Set(selected.value)
  if (s.has(name)) s.delete(name); else s.add(name)
  selected.value = s
}
const isAllSelected = computed(() => filtered.value.length > 0 && filtered.value.every(r => selected.value.has(r.name)))
function toggleSelectAll() {
  selected.value = isAllSelected.value ? new Set() : new Set(filtered.value.map(r => r.name))
}
const showBatchModal = ref(false)
function confirmBatchDelete() { if (selected.value.size) showBatchModal.value = true }
function handleBatchDelete() {
  selected.value.forEach(name => store.deleteConfigMap(name, route.params.namespace))
  queryClient.invalidateQueries({ queryKey: configmapsKey })
  selected.value = new Set()
  showBatchModal.value = false
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'ConfigMaps' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
<<<<<<< HEAD
        <h2 class="text-headline-md text-on-surface font-bold">ConfigMaps</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ nsConfigMaps.length }} ConfigMaps in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
=======
        <h2 class="text-headline-md text-on-surface font-bold">{{ t('ns.configmaps.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('ns.configmaps.subtitle', { count: store.nsConfigMaps.length, ns: route.params.namespace }) }}</p>
>>>>>>> feat/i18n-phase2
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg text-body-sm hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-sm">add</span> {{ t('ns.configmaps.new') }}
      </button>
    </div>

    <!-- 搜索框 -->
    <div class="flex items-center gap-sm mb-md">
      <div class="relative flex-1 max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="search" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-1.5 text-body-sm focus:ring-2 focus:ring-primary focus:border-primary" :placeholder="t('ns.configmaps.searchPlaceholder')" />
        <button v-if="search" @click="search = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface">
          <span class="material-symbols-outlined text-lg">close</span>
        </button>
      </div>
      <span class="text-xs text-on-surface-variant">{{ filtered.length }} / {{ nsConfigMaps.length }}</span>
      <div v-if="selected.size" class="flex items-center gap-sm ml-auto px-md py-xs bg-primary-container/10 border border-primary/20 rounded-lg">
        <span class="text-xs font-medium text-primary">{{ t('ns.configmaps.selected', { n: selected.size }) }}</span>
        <button @click="confirmBatchDelete" class="flex items-center gap-xs px-sm py-xs bg-error text-on-error rounded text-xs font-semibold hover:opacity-90">
          <span class="material-symbols-outlined text-sm">delete</span>{{ t('ns.configmaps.batchDelete') }}
        </button>
        <button @click="selected = new Set()" class="text-xs text-on-surface-variant hover:text-on-surface">{{ t('ns.configmaps.cancel') }}</button>
      </div>
    </div>

    <div v-if="filtered.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-md py-2 w-10">
              <input type="checkbox" :checked="isAllSelected" @change="toggleSelectAll" class="rounded text-primary focus:ring-primary h-4 w-4" />
            </th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('ns.configmaps.thName') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('ns.configmaps.thKeys') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('ns.configmaps.thPreview') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('common.age') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant w-24">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/15">
          <tr v-for="row in paginated" :key="row.name" class="hover:bg-surface-container-low/40 cursor-pointer transition-colors" @click="router.push({ name: 'NsConfigMapDetail', params: { namespace: route.params.namespace, name: row.name } })">
            <td class="px-md py-2" @click.stop>
              <input type="checkbox" :checked="selected.has(row.name)" @change="toggleSelect(row.name)" class="rounded text-primary focus:ring-primary h-4 w-4" />
            </td>
            <td class="px-md py-2">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary text-sm">description</span>
                <span class="font-semibold text-on-surface text-body-sm">{{ row.name }}</span>
              </div>
            </td>
            <td class="px-md py-2"><span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-surface-container text-xs font-bold text-on-surface-variant border border-outline-variant">{{ row.keys }}</span></td>
            <td class="px-md py-2">
              <div class="flex flex-wrap gap-xs max-w-xs">
                <span v-for="k in Object.keys(row.data || {}).slice(0, 4)" :key="k" class="px-1.5 py-0.5 bg-primary-container/10 text-primary text-xs rounded">{{ k }}</span>
                <span v-if="Object.keys(row.data || {}).length > 4" class="text-xs text-on-surface-variant">+{{ Object.keys(row.data).length - 4 }}</span>
              </div>
            </td>
            <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-md py-2" @click.stop>
              <div class="flex gap-1">
                <button @click="router.push({ name: 'NsConfigMapDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">open_in_new</span></button>
                <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-sm">delete</span></button>
              </div>
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td :colspan="6" class="px-md py-md text-center">
              <span class="material-symbols-outlined text-2xl text-surface-container-high block mb-sm">inbox</span>
              <p class="text-on-surface-variant text-body-sm">{{ t('common.noData') }}</p>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="total > pageSize" class="flex items-center justify-between px-md py-2 border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>
    </div>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">{{ search ? 'search_off' : 'description' }}</span>
      <p class="text-on-surface-variant text-body-sm mt-xs">{{ search ? t('ns.configmaps.noMatch', { q: search }) : t('ns.configmaps.empty') }}</p>
      <button v-if="search" @click="search = ''" class="mt-xs px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium hover:bg-surface-container-high">{{ t('ns.configmaps.clearSearch') }}</button>
      <button v-else @click="showCreateModal = true" class="mt-xs px-3 py-1.5 bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">{{ t('ns.configmaps.createShort') }}</button>
    </div>
  </section>

  <!-- Create ConfigMap Modal -->
  <Modal v-model="showCreateModal" :title="t('ns.configmaps.createTitle')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.configmaps.nameLabel') }}</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-config" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-sm">{{ t('ns.configmaps.dataKeysLabel') }}</label>
        <div class="flex flex-col gap-sm">
          <div v-for="(kv, idx) in createForm.keys" :key="idx" class="flex gap-sm items-center">
            <input v-model="kv.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="KEY" />
            <input v-model="kv.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="value" />
            <button v-if="createForm.keys.length > 1" @click="removeCreateKey(idx)" class="p-xs text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
          </div>
          <button @click="addCreateKey" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined">add</span> {{ t('ns.configmaps.addKey') }}
          </button>
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleCreate" :disabled="!createForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('common.create') }}</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="t('ns.configmaps.deleteTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('ns.configmaps.deleteConfirm', { name: deleteTarget?.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.configmaps.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>

  <!-- Batch Delete Modal -->
  <Modal v-model="showBatchModal" :title="t('ns.configmaps.batchTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('ns.configmaps.batchConfirm', { n: selected.size }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.configmaps.batchWarning') }}</p>
    <template #actions>
      <button @click="showBatchModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleBatchDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('ns.configmaps.deleteAll') }}</button>
    </template>
  </Modal>
</template>
