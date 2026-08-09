<script setup>
// Universal cluster resource browser: one component drives multiple cluster-scoped / namespaced resources.
// Object path uses metadata.selfLink (K8s 1.20+ list response no longer returns it, fallback construct by gv/plural/scope).
// Adding a resource type only requires adding an entry to CONFIGS: title/icon/scope/gv/plural + summary/status.
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import { dump as yamlDump } from 'js-yaml'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import DataTable from '@/components/common/DataTable.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { useTableColumns } from '@/composables/useTableColumns'
import { notify } from '@/composables/useToast'
import { usePagination } from '@/composables/usePagination'

const { t } = useI18n()
const route = useRoute()
const { tableColumns } = useTableColumns()

const CONFIGS = {
  apiservices: {
    title: 'APIServices', icon: 'api', scope: 'cluster',
    gv: '/apis/apiregistration.k8s.io/v1', plural: 'apiservices',
    summary: it => {
      const gv = it.spec?.group ? `${it.spec.group}/${it.spec.version}` : 'core/v1'
      const svc = it.spec?.service?.name ? `${it.spec.service.namespace}/${it.spec.service.name}` : 'Local'
      return `${gv}  →  ${svc}`
    },
    status: it => {
      const c = (it.status?.conditions || []).find(x => x.type === 'Available')
      return c?.status === 'True' ? 'Available' : 'Unavailable'
    },
  },
  mutatingwebhooks: {
    title: 'MutatingWebhookConfigurations', icon: 'webhook', scope: 'cluster',
    gv: '/apis/admissionregistration.k8s.io/v1', plural: 'mutatingwebhookconfigurations',
    summary: it => `${(it.webhooks || []).length} webhooks`,
    status: () => 'Active',
  },
  validatingwebhooks: {
    title: 'ValidatingWebhookConfigurations', icon: 'rule', scope: 'cluster',
    gv: '/apis/admissionregistration.k8s.io/v1', plural: 'validatingwebhookconfigurations',
    summary: it => `${(it.webhooks || []).length} webhooks`,
    status: () => 'Active',
  },
  replicasets: {
    title: 'ReplicaSets', icon: 'dynamic_feed', scope: 'namespace',
    gv: '/apis/apps/v1', plural: 'replicasets',
    summary: it => {
      const ready = it.status?.readyReplicas ?? 0
      const replicas = it.status?.replicas ?? it.spec?.replicas ?? 0
      const owner = it.metadata?.ownerReferences?.[0]
      return `${ready}/${replicas} ready${owner ? `  ·  owned by ${owner.kind}/${owner.name}` : '  ·  standalone'}`
    },
    status: it => {
      const replicas = it.status?.replicas ?? it.spec?.replicas ?? 0
      const ready = it.status?.readyReplicas ?? 0
      if (!replicas) return 'ScaledDown'
      return ready >= replicas ? 'Available' : 'Progressing'
    },
  },
  csinodes: {
    title: 'CSINodes', icon: 'hard_drive', scope: 'cluster',
    gv: '/apis/storage.k8s.io/v1', plural: 'csinodes',
    summary: it => {
      const drivers = it.spec?.drivers || []
      return drivers.length ? `${drivers.length} driver(s): ${drivers.map(d => d.name).join(', ')}` : 'No CSI drivers (in-tree / NFS)'
    },
    status: () => 'Active',
  },
}

const cfg = computed(() => CONFIGS[route.meta.resource])
const namespaced = computed(() => cfg.value?.scope === 'namespace')
// 自定义列:namespace 列仅在 namespaced 资源时显示
const headers = computed(() =>
  tableColumns('clusterResources').filter(h => h.key !== 'namespace' || namespaced.value))
const items = ref([])
const loading = ref(false)
const { currentPage, pageSize, paginated, total } = usePagination(items)

// 将 K8s 原始对象映射为 DataTable 行(扁平键 + 保留 raw 引用供 YAML/操作使用)
const rows = computed(() => paginated.value.map(it => ({
  name: it.metadata?.name || '',
  namespace: it.metadata?.namespace || '',
  detail: cfg.value ? cfg.value.summary(it) : '',
  status: cfg.value ? cfg.value.status(it) : '',
  age: ageOf(it.metadata?.creationTimestamp),
  _raw: it,
  _key: rowKey(it),
})))

async function load() {
  if (!cfg.value) return
  loading.value = true
  try {
    const data = await api.k8s(`${cfg.value.gv}/${cfg.value.plural}?limit=500`)
    items.value = (data.items || []).slice().sort((a, b) => {
      const ka = rowKey(a), kb = rowKey(b)
      return ka.localeCompare(kb)
    })
  } catch (e) {
    notify('error', e.message || t('admin.resourceList.loadFailed'))
    items.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)

// Row unique key: namespaced resources include namespace
function rowKey(it) { return (it.metadata?.namespace || '') + '/' + (it.metadata?.name || '') }

// GET 拉取的完整 YAML 缓存(按 rowKey 懒加载,展开时 ensureYaml 触发)
const yamlCache = ref({})

// Object path: prefer selfLink, otherwise construct by gv/plural/scope
function itemPath(it) {
  if (it.metadata?.selfLink) return it.metadata.selfLink
  const name = encodeURIComponent(it.metadata?.name || '')
  const { gv, plural } = cfg.value
  return namespaced.value
    ? `${gv}/namespaces/${encodeURIComponent(it.metadata?.namespace || 'default')}/${plural}/${name}`
    : `${gv}/${plural}/${name}`
}

function yamlOf(it) {
  const k = rowKey(it)
  if (yamlCache.value[k] != null) return yamlCache.value[k]   // 已 GET 拉取的完整 YAML
  const clone = JSON.parse(JSON.stringify(it))
  if (clone?.metadata) delete clone.metadata.managedFields
  return yamlDump(clone)
}
// 展开时懒拉取完整对象(GET 单项 → dump → 缓存);无读权限则编辑器回退到列表项 dump
async function ensureYaml(it) {
  const k = rowKey(it)
  if (yamlCache.value[k] != null) return
  try {
    const obj = await api.k8s(itemPath(it))
    if (obj?.metadata) delete obj.metadata.managedFields
    yamlCache.value = { ...yamlCache.value, [k]: yamlDump(obj) }
  } catch { /* 无读权限:yamlOf 回退到列表项 */ }
}

async function applyYaml(yaml) {
  try {
    await api.applyYaml(yaml)
    notify('success', t('admin.resourceList.applied'))
    await load()
  } catch (e) {
    notify('error', e.message || t('admin.resourceList.applyFailed'))
  }
}

// t('common.delete')
const showDelete = ref(false)
const delTarget = ref(null)
function confirmDelete(row) { delTarget.value = row._raw; showDelete.value = true }
async function handleDelete() {
  const it = delTarget.value
  if (!it) return
  try {
    await api.k8s(itemPath(it), { method: 'DELETE' })
    notify('success', t('admin.resourceList.deleted', { name: it.metadata?.name }))
    await load()
  } catch (e) {
    notify('error', e.message || t('admin.resourceList.applyFailed'))
  }
  showDelete.value = false
  delTarget.value = null
}

const ageOf = ts => {
  if (!ts) return '-'
  const ms = Date.now() - new Date(ts).getTime()
  const d = Math.floor(ms / 86400000); if (d > 0) return d + 'd'
  const h = Math.floor(ms / 3600000); if (h > 0) return h + 'h'
  const m = Math.floor(ms / 60000); return Math.max(m, 0) + 'm'
}
</script>

<template>
  <section v-if="cfg" class="animate-fade-in">
    <Breadcrumbs :items="[{ label: cfg.title }]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ cfg.title }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('admin.resourceList.itemCount', { n: items.length, scope: namespaced ? t('admin.resourceList.namespaceScope') : t('admin.resourceList.clusterScope') }) }}</p>
      </div>
      <button
        @click="load"
        class="flex items-center gap-sm px-3 py-1.5 border border-outline-variant text-on-surface text-body-sm font-semibold rounded-lg hover:bg-surface-container-high transition-colors"
      >
        <span class="material-symbols-outlined text-sm">refresh</span> {{ t('admin.resourceList.refresh') }}
      </button>
    </div>

    <DataTable
      :headers="headers"
      :rows="rows"
      column-key="clusterResources"
      row-key="_key"
      expandable
      @expand="(row) => ensureYaml(row._raw)"
    >
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-secondary text-base">{{ cfg.icon }}</span>
          <span class="font-semibold text-on-surface font-mono text-code-sm">{{ row.name }}</span>
        </div>
      </template>
      <template #namespace="{ row }">
        <span v-if="row.namespace" class="px-2 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant">{{ row.namespace }}</span>
        <span v-else class="text-on-surface-variant text-xs">-</span>
      </template>
      <template #detail="{ row }"><span class="font-mono text-code-sm text-on-surface-variant">{{ row.detail }}</span></template>
      <template #status="{ row }"><StatusChip :status="row.status" size="sm" /></template>
      <template #age="{ row }"><span class="text-xs text-on-surface-variant">{{ row.age }}</span></template>
      <template #actions="{ row }">
        <div class="flex gap-1 justify-end" @click.stop>
          <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('admin.resourceList.titleDelete')">
            <span class="material-symbols-outlined text-base">delete</span>
          </button>
        </div>
      </template>
      <template #expanded="{ row }">
        <YamlEditor :model-value="yamlOf(row._raw)" :readonly="false" height="360px" @save="applyYaml" />
      </template>
      <template v-if="total > pageSize" #pagination>
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <!-- t('common.delete')确认 -->
    <Modal v-model="showDelete" :title="t('admin.resourceList.deleteConfirm', { title: cfg.title, name: delTarget?.metadata?.name })" width="max-w-md">
      <p class="text-body-md text-on-surface-variant">
        {{ t('admin.resourceList.deleteConfirm', { title: cfg.title, name: delTarget?.metadata?.name }) }}
      </p>
      <p class="text-body-sm text-error mt-sm">{{ t('admin.resourceList.deleteWarning') }}</p>
      <template #actions>
        <button @click="showDelete = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
        <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
      </template>
    </Modal>
  </section>
</template>
