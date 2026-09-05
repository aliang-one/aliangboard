<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

// 集群级 IngressClass 详情页(与 StorageClassDetail 同构):
// YAML tab 用 useLiveYaml 拉「实时完整对象」而非 generateYAML 的有损重建——
// 后者只产出 name/is-default/controller 三字段,force apply 会把真实控制器的
// spec.parameters、labels/annotations 静默剪掉(SSA fieldManager 语义)。
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
const cid = computed(() => (store.currentCluster || 'cluster'))

const icDetail = useResourceDetail({
  key: ['cluster', cid, 'ingressclasses', route.params.name],
  fetcher: () => store.fetchIngressClass(route.params.name),
  options: { refetchInterval: 15000 },
})
const ic = computed(() => icDetail.data.value)
const { yaml } = useLiveYaml({
  pathFn: () => `/apis/networking.k8s.io/v1/ingressclasses/${encodeURIComponent(route.params.name)}`,
})
const activeTab = ref('overview')

// 集群级 Ingress 列表 → 过滤 className 引用本类的关联 Ingress(Network.vue 同款 key/轮询)
const ingressesQ = useResourceList({
  key: ['cluster', cid, 'ingresses'],
  fetcher: () => store.fetchIngresses(),
  options: { refetchInterval: 30000 },
})
const related = computed(() => (ingressesQ.data.value || []).filter(i => i.className === ic.value?.name))

// === 暴露摘要与明细(2026-09-05 第二轮):端口可见(80/443/host 级 TLS)、后端全量、搜索、折叠 ===
const hostListOf = ing => (ing.hosts || '').split(',').map(h => h.trim()).filter(Boolean)
// 该条全部后端(defaultBackend 映射形 {serviceName,servicePort};rules 内原生 K8s 形 service:{name,port:{number|name}}),去重
function backendsOf(ing) {
  const out = []
  if (ing.defaultBackend?.serviceName) out.push(`${ing.defaultBackend.serviceName}:${ing.defaultBackend.servicePort}`)
  for (const r of ing.rules || []) for (const p of r?.http?.paths || []) {
    const s = p?.backend?.service
    if (s?.name) out.push(`${s.name}:${s.port?.number ?? s.port?.name ?? ''}`)
  }
  return [...new Set(out)]
}
const tlsSet = computed(() => new Set((related.value || []).flatMap(i => i.tlsHosts || [])))
const hostList = computed(() => [...new Set((related.value || []).flatMap(hostListOf))])
const svcList = computed(() => [...new Set((related.value || []).flatMap(backendsOf))])
const hasTls = computed(() => hostList.value.some(h => tlsSet.value.has(h)))
const hasPlain = computed(() => hostList.value.some(h => !tlsSet.value.has(h)))

const relatedSearch = ref('')
const relatedExpanded = ref(false)
const RELATED_COLLAPSE = 5
const filteredRelated = computed(() => {
  const q = relatedSearch.value.trim().toLowerCase()
  if (!q) return related.value
  return related.value.filter(i => [i.namespace, i.name, hostListOf(i).join(' '), backendsOf(i).join(' ')].join(' ').toLowerCase().includes(q))
})
const visibleRelated = computed(() => (relatedExpanded.value ? filteredRelated.value : filteredRelated.value.slice(0, RELATED_COLLAPSE)))
watch([relatedSearch, () => related.value.length], () => { relatedExpanded.value = false })
async function toggleDefault() {
  if (ic.value.isDefault) await store.demoteIngressClassDefault(ic.value.name)
  else await store.promoteIngressClassDefault(ic.value.name)
}

const labelRows = computed(() => Object.entries(ic.value?.labels || {}))
const annRows = computed(() => Object.entries(ic.value?.annotations || {}))
const paramRows = computed(() => Object.entries(ic.value?.parameters || {}))

const showDeleteModal = ref(false)
async function handleDelete() {
  await store.deleteIngressClass(route.params.name)
  router.push('/ingressclasses')
}

// === 结构化编辑(2026-09-05):controller/parameters/labels/annotations 走 updateIngressClassSpec
// 手术 merge-patch(不走 generateYAML 有损重建);isDefault 开关走 promote/demote 保 sweep 唯一性。
const showEditModal = ref(false)
const editForm = ref({})
const rowsToMap = rows => {
  const m = {}
  for (const r of rows) { const k = (r.key || '').trim(); if (k) m[k] = r.value }
  return m
}
const DEFAULT_KEY = 'ingressclass.kubernetes.io/is-default-class'
const editCanSave = computed(() => {
  if (!editForm.value.paramsEnabled) return true
  const p = editForm.value.params || {}
  return !!(p.kind || '').trim() && !!(p.name || '').trim()   // parameters 启用时 kind/name 必填
})
function openEdit() {
  const anns = Object.entries(ic.value?.annotations || {}).filter(([k]) => k !== DEFAULT_KEY)
  editForm.value = {
    controller: ic.value?.controller || '',
    paramsEnabled: !!ic.value?.parameters,
    params: { apiGroup: ic.value?.parameters?.apiGroup || '', kind: ic.value?.parameters?.kind || '', name: ic.value?.parameters?.name || '' },
    labels: Object.entries(ic.value?.labels || {}).map(([key, value]) => ({ key, value: String(value) })),
    annotations: anns.map(([key, value]) => ({ key, value: String(value) })),
    isDefault: !!ic.value?.isDefault,
  }
  showEditModal.value = true
}
function addRow(list) { editForm.value[list].push({ key: '', value: '' }) }
function removeRow(list, i) { editForm.value[list].splice(i, 1) }
// 全字面量键( i18n 门禁静态扫描无法解析拼接的 'admin.ingressClasses.' + key )
const KV_SECTIONS = [
  { key: 'labels', labelKey: 'admin.ingressClasses.labels' },
  { key: 'annotations', labelKey: 'admin.ingressClasses.annotations' },
]
async function saveEdit() {
  const f = editForm.value
  const updates = {
    controller: f.controller,
    parameters: f.paramsEnabled
      ? { apiGroup: (f.params.apiGroup || '').trim() || undefined, kind: f.params.kind.trim(), name: f.params.name.trim() }
      : null,
    labels: rowsToMap(f.labels),
    annotations: rowsToMap(f.annotations),
  }
  const r = await store.updateIngressClassSpec(route.params.name, updates)
  if (r && r.ok === false) return // spec 保存失败:保留弹窗(错误已由 store notify),不动默认态
  if (f.isDefault !== !!ic.value?.isDefault) {
    // spec 已落库;默认态切换失败时 toast 已可见,详情轮询回真,弹窗关闭后可用 header ⭐ 重试
    if (f.isDefault) await store.promoteIngressClassDefault(route.params.name)
    else await store.demoteIngressClassDefault(route.params.name)
  }
  showEditModal.value = false
}
</script>

<template>
  <section class="animate-fade-in" v-if="ic">
    <Breadcrumbs :items="[
      { label: 'IngressClasses', route: '/ingressclasses' },
      { label: ic.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-secondary text-3xl">language</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ ic.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="text-body-sm text-on-surface-variant font-mono">{{ ic.controller }}</span>
            <span v-if="ic.isDefault" class="px-2.5 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded-full font-medium">DEFAULT</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ ic.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-xs">
        <button data-testid="detail-edit-btn" @click="openEdit" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined text-sm">edit</span> {{ t('common.edit') }}
        </button>
        <button data-testid="promote-default-btn" v-if="!ic.isDefault" @click="toggleDefault" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold border border-primary/40 text-primary rounded-lg hover:bg-primary-container/10 transition-colors">
          <span class="material-symbols-outlined text-sm">star</span> {{ t('common.setAsDefault') }}
        </button>
        <button data-testid="demote-default-btn" v-else @click="toggleDefault" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface-variant rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-sm">star</span> {{ t('common.unsetDefault') }}
        </button>
        <button data-testid="detail-delete-btn" @click="showDeleteModal = true" class="px-3 py-1.5 text-body-sm font-medium border border-error/30 text-error rounded-lg hover:bg-error/5 transition-colors">{{ t('common.delete') }}</button>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <h3 class="text-headline-sm mb-lg">{{ t('admin.ingressClasses.details') }}</h3>
        <div class="grid grid-cols-2 gap-md">
          <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">{{ t('admin.ingressClasses.thController') }}</p><p class="font-mono text-code-sm text-on-surface">{{ ic.controller }}</p></div>
          <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">{{ t('admin.ingressClasses.thDefault') }}</p><p class="text-body-md text-on-surface">{{ ic.isDefault ? t('admin.ingressClasses.yes') : '—' }}</p></div>
        </div>

        <div v-if="paramRows.length" class="mt-lg">
          <p class="text-label-caps text-on-surface-variant mb-sm">{{ t('admin.ingressClasses.parameters') }}</p>
          <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
            <div v-for="[k, v] in paramRows" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface break-all">{{ v }}</span></div>
          </div>
        </div>

        <div v-if="labelRows.length" class="mt-lg">
          <p class="text-label-caps text-on-surface-variant mb-sm">{{ t('admin.ingressClasses.labels') }}</p>
          <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
            <div v-for="[k, v] in labelRows" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface break-all">{{ v }}</span></div>
          </div>
        </div>

        <div v-if="annRows.length" class="mt-lg">
          <p class="text-label-caps text-on-surface-variant mb-sm">{{ t('admin.ingressClasses.annotations') }}</p>
          <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
            <div v-for="[k, v] in annRows" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface break-all">{{ v }}</span></div>
          </div>
        </div>
      </div>
      </div>
      <div class="lg:col-span-4" data-testid="related-ingresses">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('admin.ingressClasses.relatedIngresses') }} ({{ related.length }})</h3>

          <!-- 暴露摘要:端口/hosts/后端服务一眼可见(2026-09-05) -->
          <div v-if="related.length" data-testid="exposure-summary" class="flex flex-col gap-sm mb-md p-md bg-surface-container-low rounded-lg">
            <div class="flex items-center gap-xs flex-wrap">
              <span v-if="hasPlain" class="px-2 py-0.5 rounded bg-surface-container text-label-caps text-on-surface-variant font-mono">:80 HTTP</span>
              <span v-if="hasTls" class="px-2 py-0.5 rounded bg-secondary-container/20 text-secondary text-label-caps font-mono flex items-center gap-xs"><span class="material-symbols-outlined text-sm">lock</span>:443 HTTPS</span>
              <span data-testid="exposure-stats" :data-counts="`${related.length}|${hostList.length}|${svcList.length}`" class="text-label-caps text-on-surface-variant">{{ related.length }} · {{ hostList.length }} · {{ svcList.length }}</span>
            </div>
            <div v-if="hostList.length" class="flex flex-col gap-xs">
              <p class="text-label-caps text-on-surface-variant">{{ t('admin.ingressClasses.exposedHosts') }}</p>
              <div class="flex flex-wrap gap-xs">
                <span v-for="h in hostList" :key="h" class="px-2 py-0.5 rounded bg-surface-container text-code-sm font-mono"
                  :class="tlsSet.has(h) ? 'text-secondary' : 'text-on-surface'">{{ h }}{{ tlsSet.has(h) ? ':443' : ':80' }}</span>
              </div>
            </div>
            <div v-if="svcList.length" class="flex flex-col gap-xs">
              <p class="text-label-caps text-on-surface-variant">{{ t('admin.ingressClasses.exposedBackends') }}</p>
              <div class="flex flex-wrap gap-xs">
                <span v-for="s in svcList" :key="s" class="px-2 py-0.5 rounded bg-surface-container text-code-sm font-mono text-on-surface">{{ s }}</span>
              </div>
            </div>
          </div>

          <!-- 明细:搜索过滤 + 折叠展开 -->
          <div v-if="related.length" class="mb-sm">
            <input data-testid="related-search" v-model="relatedSearch" :placeholder="t('admin.ingressClasses.searchRelated')"
              class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1.5 text-body-sm focus:ring-2 focus:ring-primary" />
          </div>
          <div v-if="filteredRelated.length" class="flex flex-col gap-sm">
            <button v-for="ing in visibleRelated" :key="ing.namespace + '/' + ing.name" data-testid="related-row" @click="router.push({ name: 'NsIngressDetail', params: { namespace: ing.namespace, name: ing.name } })"
              class="flex flex-col items-start gap-xs px-md py-sm bg-surface-container-low rounded-lg hover:bg-primary-container/10 transition-colors text-left">
              <span class="font-mono text-code-sm text-primary truncate max-w-full">{{ ing.namespace }}/{{ ing.name }}</span>
              <span v-if="hostListOf(ing).length" class="flex flex-wrap gap-xs text-code-sm font-mono">
                <span v-for="h in hostListOf(ing)" :key="h" :class="tlsSet.has(h) ? 'text-secondary' : 'text-on-surface-variant'">{{ h }}{{ tlsSet.has(h) ? ':443' : ':80' }}</span>
              </span>
              <span v-if="backendsOf(ing).length" class="flex flex-wrap gap-xs text-label-caps font-mono text-on-surface-variant">
                <span v-for="b in backendsOf(ing)" :key="b" class="px-1.5 py-0.5 rounded bg-surface-container">{{ b }}</span>
              </span>
            </button>
            <button v-if="filteredRelated.length > visibleRelated.length" data-testid="related-expand" @click="relatedExpanded = true"
              class="text-body-sm text-primary font-medium hover:underline text-center py-xs">
              {{ t('admin.ingressClasses.showAll', { n: filteredRelated.length }) }}
            </button>
            <button v-else-if="relatedExpanded && filteredRelated.length > RELATED_COLLAPSE" data-testid="related-collapse" @click="relatedExpanded = false"
              class="text-body-sm text-primary font-medium hover:underline text-center py-xs">
              {{ t('admin.ingressClasses.showLess') }}
            </button>
          </div>
          <p v-else-if="related.length" class="text-body-sm text-on-surface-variant py-md text-center">{{ t('common.noData') }}</p>
          <p v-else class="text-body-sm text-on-surface-variant py-md text-center">{{ t('admin.ingressClasses.relatedEmpty') }}</p>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>

    <!-- 结构化编辑 Modal(2026-09-05) -->
    <Modal v-model="showEditModal" :title="t('admin.ingressClasses.editTitle')" width="max-w-xl">
      <div class="flex flex-col gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('admin.ingressClasses.thController') }}</label>
          <input data-testid="edit-controller" v-model="editForm.controller" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
          <p class="text-label-caps text-on-surface-variant mt-xs flex items-center gap-xs">
            <span class="material-symbols-outlined text-sm text-error">warning</span>{{ t('admin.ingressClasses.controllerWarning') }}
          </p>
        </div>

        <div>
          <label class="flex items-center gap-sm cursor-pointer">
            <input data-testid="edit-params-enable" v-model="editForm.paramsEnabled" type="checkbox" class="h-4 w-4 accent-primary" />
            <span class="text-body-md text-on-surface">{{ t('admin.ingressClasses.paramsEnable') }}</span>
          </label>
          <div v-if="editForm.paramsEnabled" class="grid grid-cols-3 gap-sm mt-sm">
            <input data-testid="edit-params-apigroup" v-model="editForm.params.apiGroup" :placeholder="t('admin.ingressClasses.paramsApiGroup')" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono" />
            <input data-testid="edit-params-kind" v-model="editForm.params.kind" :placeholder="t('admin.ingressClasses.paramsKind')" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono" />
            <input data-testid="edit-params-name" v-model="editForm.params.name" :placeholder="t('admin.ingressClasses.paramsName')" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono" />
          </div>
        </div>

        <label class="flex items-center gap-sm cursor-pointer">
          <input data-testid="edit-is-default" v-model="editForm.isDefault" type="checkbox" class="h-4 w-4 accent-primary" />
          <span class="text-body-md text-on-surface">{{ t('admin.ingressClasses.setDefaultLabel') }}</span>
        </label>

        <div v-for="s in KV_SECTIONS" :key="s.key">
          <div class="flex items-center justify-between mb-xs">
            <label class="text-label-caps text-on-surface-variant">{{ t(s.labelKey) }}</label>
            <button @click="addRow(s.key)" type="button" class="text-body-sm text-primary font-medium hover:underline">+ {{ t('common.add') }}</button>
          </div>
          <div v-for="(row, i) in editForm[s.key]" :key="s.key + i" class="flex gap-xs mb-xs">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="key" />
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="value" />
            <button @click="removeRow(s.key, i)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
          <p v-if="!(editForm[s.key] || []).length" class="text-xs text-on-surface-variant/60">{{ t('common.none') }}</p>
        </div>
      </div>
      <template #actions>
        <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('admin.ingressClasses.cancel') }}</button>
        <button data-testid="edit-save" :disabled="!editCanSave" @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('common.save') }}</button>
      </template>
    </Modal>

    <!-- 删除确认 Modal -->
    <Modal v-model="showDeleteModal" :title="t('admin.ingressClasses.deleteTitle')" width="max-w-md">
      <p class="text-body-md text-on-surface-variant" v-html="t('admin.ingressClasses.deleteConfirm', { name: ic.name })"></p>
      <p class="text-body-sm text-error mt-sm">{{ t('admin.ingressClasses.deleteWarning') }}</p>
      <template #actions>
        <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('admin.ingressClasses.cancel') }}</button>
        <button data-testid="detail-delete-confirm" @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('admin.ingressClasses.delete') }}</button>
      </template>
    </Modal>
  </section>
  <!-- 首载中不渲染 not-found(避免慢加载时闪错页);仅查询结束仍无对象时呈现 -->
  <section v-else-if="!icDetail.isLoading.value" class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">{{ t('admin.ingressClasses.notFound') }}</h2>
    <button data-testid="back-to-list" @click="router.push('/ingressclasses')" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ t('admin.ingressClasses.backToList') }}</button>
  </section>
</template>
