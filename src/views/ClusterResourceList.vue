<script setup>
// 通用集群资源浏览器：一份组件驱动多种 cluster-scoped / namespaced 资源。
// 对象路径取 metadata.selfLink（K8s 1.20+ 列表响应已不返回，按 gv/plural/scope 回退构造）。
// 增一种资源只需在 CONFIGS 加一项：title/icon/scope/gv/plural + summary/status。
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import { dump as yamlDump } from 'js-yaml'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { notify } from '@/composables/useToast'
import { usePagination } from '@/composables/usePagination'

const { t } = useI18n()
const route = useRoute()

const CONFIGS = {
  apiservices: {
    title: 'APIServices', icon: 'api', scope: 'cluster',
    gv: '/apis/apiregistration.k8s.io/v1', plural: 'apiservices',
    summary: it => {
      const gv = it.spec?.group ? `${it.spec.group}/${it.spec.version}` : 'core/v1'
      const svc = it.spec?.service?.name ? `${it.spec.service.namespace}/${it.spec.service.name}` : '本地（Local）'
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
    summary: it => `${(it.webhooks || []).length} 个 webhook`,
    status: () => 'Active',
  },
  validatingwebhooks: {
    title: 'ValidatingWebhookConfigurations', icon: 'rule', scope: 'cluster',
    gv: '/apis/admissionregistration.k8s.io/v1', plural: 'validatingwebhookconfigurations',
    summary: it => `${(it.webhooks || []).length} 个 webhook`,
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
      return drivers.length ? `${drivers.length} driver(s): ${drivers.map(d => d.name).join(', ')}` : '无 CSI 驱动（in-tree / NFS）'
    },
    status: () => 'Active',
  },
}

const cfg = computed(() => CONFIGS[route.meta.resource])
const namespaced = computed(() => cfg.value?.scope === 'namespace')
// 展开行 colspan：namespaced 多一列 Namespace
const colCount = computed(() => namespaced.value ? 6 : 5)
const items = ref([])
const loading = ref(false)
const { currentPage, pageSize, paginated, total } = usePagination(items)
const expanded = ref(new Set())
const yamlCache = ref({})        // key -> 实时 YAML（GET selfLink/回退路径 后 dump）

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

// 行唯一键：namespaced 含 namespace
function rowKey(it) { return (it.metadata?.namespace || '') + '/' + (it.metadata?.name || '') }

// 对象路径：优先 selfLink，否则按 gv/plural/scope 构造
function itemPath(it) {
  if (it.metadata?.selfLink) return it.metadata.selfLink
  const name = encodeURIComponent(it.metadata?.name || '')
  const { gv, plural } = cfg.value
  return namespaced.value
    ? `${gv}/namespaces/${encodeURIComponent(it.metadata?.namespace || 'default')}/${plural}/${name}`
    : `${gv}/${plural}/${name}`
}

async function ensureYaml(it) {
  const k = rowKey(it)
  if (yamlCache.value[k] != null) return
  try {
    const obj = await api.k8s(itemPath(it))
    if (obj?.metadata) delete obj.metadata.managedFields
    yamlCache.value = { ...yamlCache.value, [k]: yamlDump(obj) }
  } catch {
    // 无权限读取：编辑器回退到列表项自身的 dump
  }
}
function toggleExpand(it) {
  const k = rowKey(it)
  const s = new Set(expanded.value)
  if (s.has(k)) s.delete(k)
  else { s.add(k); ensureYaml(it) }
  expanded.value = s
}
function yamlOf(it) {
  const k = rowKey(it)
  if (yamlCache.value[k] != null) return yamlCache.value[k]
  const clone = JSON.parse(JSON.stringify(it))
  if (clone?.metadata) delete clone.metadata.managedFields
  return yamlDump(clone)
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

// 删除
const showDelete = ref(false)
const delTarget = ref(null)
function confirmDelete(it) { delTarget.value = it; showDelete.value = true }
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

    <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low/50 border-b border-outline-variant">
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('admin.resourceList.thName') }}</th>
            <th v-if="namespaced" class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('admin.resourceList.thNamespace') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('admin.resourceList.thDetail') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('admin.resourceList.thStatus') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('admin.resourceList.thAge') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant w-24">{{ t('admin.resourceList.thActions') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/15">
          <template v-for="it in paginated" :key="rowKey(it)">
            <tr class="hover:bg-surface-container-low/40 transition-colors">
              <td class="px-md py-2">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-base">{{ cfg.icon }}</span>
                  <span class="font-semibold text-on-surface font-mono text-code-sm">{{ it.metadata.name }}</span>
                </div>
              </td>
              <td v-if="namespaced" class="px-md py-2">
                <span v-if="it.metadata.namespace" class="px-2 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant">{{ it.metadata.namespace }}</span>
                <span v-else class="text-on-surface-variant text-xs">-</span>
              </td>
              <td class="px-md py-2 font-mono text-code-sm text-on-surface-variant">{{ cfg.summary(it) }}</td>
              <td class="px-md py-2"><StatusChip :status="cfg.status(it)" size="sm" /></td>
              <td class="px-md py-2 text-xs text-on-surface-variant">{{ ageOf(it.metadata.creationTimestamp) }}</td>
              <td class="px-md py-2" @click.stop>
                <div class="flex gap-1">
                  <button @click="toggleExpand(it)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="t('admin.resourceList.viewEditYaml')">
                    <span class="material-symbols-outlined text-base transition-transform" :class="expanded.has(rowKey(it)) ? 'rotate-180' : ''">expand_more</span>
                  </button>
                  <button @click="confirmDelete(it)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('admin.resourceList.titleDelete')">
                    <span class="material-symbols-outlined text-base">delete</span>
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="expanded.has(rowKey(it))">
              <td :colspan="colCount" class="px-md py-2 bg-surface-container-low/40">
                <YamlEditor :model-value="yamlOf(it)" :readonly="false" height="360px" @save="applyYaml" />
              </td>
            </tr>
          </template>
          <tr v-if="!items.length && !loading">
            <td :colspan="colCount" class="px-md py-md text-center">
              <span class="material-symbols-outlined text-2xl text-surface-container-high">inbox</span>
              <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('admin.resourceList.noData') }}</p>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="total > pageSize" class="flex items-center justify-between px-md py-2 border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>
    </div>

    <!-- 删除确认 -->
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
