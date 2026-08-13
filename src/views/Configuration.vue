<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'
import { useTableColumns } from '@/composables/useTableColumns'

const { t } = useI18n()
const router = useRouter()
const store = useClusterStore()
const { tableColumns } = useTableColumns()
const activeTab = ref('configmaps')

// 5 资源 cluster-wide 走 Vue Query（与 ns 页面共享 key 去重）
const cid = computed(() => (store.currentCluster || 'cluster'))
const nsQ = useResourceList({ key: ['cluster', cid, 'namespaces'], fetcher: () => store.fetchNamespaces(), options: { refetchInterval: 60000 } })
const allNamespaces = computed(() => nsQ.data.value ?? store.namespaceList)
const cmQ = useResourceList({ key: ['cluster', cid, 'configmaps'], fetcher: () => store.fetchConfigMaps(), options: { refetchInterval: 30000 } })
const secQ = useResourceList({ key: ['cluster', cid, 'secrets'], fetcher: () => store.fetchSecrets(), options: { refetchInterval: 30000 } })
const rqQ = useResourceList({ key: ['cluster', cid, 'resourcequotas'], fetcher: () => store.fetchResourceQuotas(), options: { refetchInterval: 30000 } })
const lrQ = useResourceList({ key: ['cluster', cid, 'limitranges'], fetcher: () => store.fetchLimitRanges(), options: { refetchInterval: 30000 } })
const hpaQ = useResourceList({ key: ['cluster', cid, 'hpas'], fetcher: () => store.fetchHPAs(), options: { refetchInterval: 30000 } })
const allConfigMaps = computed(() => cmQ.data.value || [])
const allSecrets = computed(() => secQ.data.value || [])
const allResourceQuotas = computed(() => rqQ.data.value || [])
const allLimitRanges = computed(() => lrQ.data.value || [])
const allHPAs = computed(() => hpaQ.data.value || [])

const tabs = [
  { key: 'configmaps', label: t('config.configmapsTab') },
  { key: 'secrets', label: t('config.secretsTab') },
  { key: 'resourcequotas', label: t('config.resourcequotasTab') },
  { key: 'limitranges', label: t('config.limitrangesTab') },
  { key: 'hpas', label: t('config.hpasTab') },
]

const cmHeaders = computed(() => tableColumns('configCM'))
const secretHeaders = computed(() => tableColumns('configSecret'))
const rqHeaders = computed(() => tableColumns('configRQ'))
const lrHeaders = computed(() => tableColumns('configLR'))
const hpaHeaders = computed(() => tableColumns('configHPA'))

// 各 tab 对应的「新建」目标命名空间列表页（复用既有表单页）与详情页路由名
const createRouteName = {
  configmaps: 'NsConfigMaps',
  secrets: 'NsSecrets',
  resourcequotas: 'NsResourceQuotas',
  limitranges: 'NsLimitRanges',
  hpas: 'NsHPA',
}
const detailRouteName = {
  configmaps: 'NsConfigMapDetail',
  secrets: 'NsSecretDetail',
  resourcequotas: 'NsResourceQuotaDetail',
  limitranges: 'NsLimitRangeDetail',
  hpas: 'NsHPADetail',
}
const deleteFn = {
  configmaps: (name, ns) => store.deleteConfigMap(name, ns),
  secrets: (name, ns) => store.deleteSecret(name, ns),
  resourcequotas: (name, ns) => store.deleteResourceQuota(name, ns),
  limitranges: (name, ns) => store.deleteLimitRange(name, ns),
  hpas: (name, ns) => store.deleteHPA(name, ns),
}

// 新建：跳转到当前命名空间（或首个命名空间）对应列表页，那里已有创建表单
function createNew() {
  const ns = store.currentNamespace || allNamespaces.value?.[0]?.name || 'default'
  router.push({ name: createRouteName[activeTab.value], params: { namespace: ns } })
}
// 编辑：跳转到命名空间级详情页（复用既有结构化编辑 UI）
function editItem(row) {
  router.push({ name: detailRouteName[activeTab.value], params: { namespace: row.namespace, name: row.name } })
}

// 删除确认
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
const deleting = ref(false)
function askDelete(row) {
  deleteTarget.value = { tab: activeTab.value, name: row.name, namespace: row.namespace }
  showDeleteModal.value = true
}
async function doDelete() {
  if (!deleteTarget.value) return
  const { tab, name, namespace } = deleteTarget.value
  deleting.value = true
  try {
    await deleteFn[tab](name, namespace)
    showDeleteModal.value = false
  } catch (e) {
    alert(e.message || 'Delete failed')
  } finally {
    deleting.value = false
  }
}

const rqLimitsCount = rq => Object.keys(rq.hard || {}).length

// 按 tab 切换的当前列表（ConfigMaps / Secrets / ResourceQuotas / LimitRanges / HPA）
const currentTabList = computed(() => ({
  configmaps: allConfigMaps.value,
  secrets: allSecrets.value,
  resourcequotas: allResourceQuotas.value,
  limitranges: allLimitRanges.value,
  hpas: allHPAs.value,
}[activeTab.value] || []))
const { currentPage, pageSize, paginated, total } = usePagination(currentTabList, { resetDeps: [activeTab] })
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ t('config.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('config.subtitle') }}</p>
      </div>
      <button @click="createNew" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary text-body-sm font-semibold rounded-lg hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-sm">add</span> {{ t('config.createNew') }}
      </button>
    </div>

    <div class="flex items-center gap-xs border-b border-outline-variant mb-md">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="px-lg py-2 text-body-sm font-medium transition-colors relative"
        :class="activeTab === tab.key ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'"
      >{{ tab.label }}<span v-if="activeTab === tab.key" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"></span></button>
    </div>

    <!-- ConfigMaps -->
    <DataTable v-if="activeTab === 'configmaps'" :headers="cmHeaders" :rows="paginated" column-key="configCM" @row-click="editItem">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-secondary">description</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #keys="{ row }">
        <span class="font-mono text-code-sm font-bold">{{ row.keys }}</span>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="editItem(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="t('common.edit')">
            <span class="material-symbols-outlined text-lg">edit</span>
          </button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('common.delete')">
            <span class="material-symbols-outlined text-lg">delete</span>
          </button>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <!-- Secrets -->
    <DataTable v-if="activeTab === 'secrets'" :headers="secretHeaders" :rows="paginated" column-key="configSecret" @row-click="editItem">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-tertiary-container">key</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #type="{ row }">
        <span class="px-2 py-0.5 bg-surface-container rounded text-body-sm border border-outline-variant">{{ row.type }}</span>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="editItem(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="t('common.edit')"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('common.delete')"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <!-- ResourceQuotas -->
    <DataTable v-if="activeTab === 'resourcequotas' && allResourceQuotas.length" :headers="rqHeaders" :rows="paginated" column-key="configRQ" @row-click="editItem">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-secondary">pie_chart</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #limits="{ row }"><span class="font-mono text-code-sm">{{ rqLimitsCount(row) }}</span></template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="editItem(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="t('common.edit')"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('common.delete')"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
    <div v-else-if="activeTab === 'resourcequotas'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant py-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">pie_chart</span>
      <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('config.noResourceQuotas') }}</p>
      <button @click="createNew" class="mt-md px-3 py-1.5 bg-primary text-on-primary text-body-sm rounded-lg font-semibold">{{ t('config.createResourceQuota') }}</button>
    </div>

    <!-- LimitRanges -->
    <DataTable v-if="activeTab === 'limitranges' && allLimitRanges.length" :headers="lrHeaders" :rows="paginated" column-key="configLR" @row-click="editItem">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-secondary">tune</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #defaultCPU="{ row }"><span class="font-mono text-code-sm">{{ row.defaultCPU || '—' }}</span></template>
      <template #defaultMemory="{ row }"><span class="font-mono text-code-sm">{{ row.defaultMemory || '—' }}</span></template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="editItem(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="t('common.edit')"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('common.delete')"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
    <div v-else-if="activeTab === 'limitranges'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant py-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">tune</span>
      <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('config.noLimitRanges') }}</p>
      <button @click="createNew" class="mt-md px-3 py-1.5 bg-primary text-on-primary text-body-sm rounded-lg font-semibold">{{ t('config.createLimitRange') }}</button>
    </div>

    <!-- HPA -->
    <DataTable v-if="activeTab === 'hpas' && allHPAs.length" :headers="hpaHeaders" :rows="paginated" column-key="configHPA" @row-click="editItem">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-secondary">timeline</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #targetName="{ row }">
        <span class="font-mono text-code-sm text-primary">{{ row.targetKind }}/{{ row.targetName || '—' }}</span>
      </template>
      <template #cpuTarget="{ row }"><span class="font-mono text-code-sm">{{ row.cpuTarget != null ? row.cpuTarget + '%' : '—' }}</span></template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="editItem(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="t('common.edit')"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('common.delete')"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
    <div v-else-if="activeTab === 'hpas'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant py-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">timeline</span>
      <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('config.noHPAs') }}</p>
      <button @click="createNew" class="mt-md px-3 py-1.5 bg-primary text-on-primary text-body-sm rounded-lg font-semibold">{{ t('config.createHPA') }}</button>
    </div>

    <!-- Delete Confirm Modal -->
    <Modal v-model="showDeleteModal" :title="t('config.deleteModalTitle')" width="max-w-md">
      <p class="text-body-md text-on-surface-variant" v-html="t('config.deleteConfirm', { name: deleteTarget?.name, namespace: deleteTarget?.namespace })"></p>
      <p class="text-body-sm text-error mt-sm">{{ t('config.deleteWarning') }}</p>
      <template #actions>
        <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
        <button @click="doDelete" :disabled="deleting" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-50">{{ t('common.delete') }}</button>
      </template>
    </Modal>
  </section>
</template>
