<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'
import { api } from '@/api/client'
import { dump as yamlDump } from 'js-yaml'
import { useI18n } from 'vue-i18n'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import DataTable from '@/components/common/DataTable.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import { notify } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()

const cid = computed(() => (store.currentCluster || 'cluster'))
const crdDetail = useResourceDetail({
  key: ['cluster', cid, 'crds', route.params.name],
  fetcher: () => store.fetchCRD(route.params.name),
  options: { refetchInterval: 15000 },
})
const crd = computed(() => crdDetail.data.value)
const instancesQuery = useResourceList({
  key: ['cluster', cid, 'crds', route.params.name, 'instances'],
  fetcher: () => store.fetchCRInstances(crd.value),
  enabled: (!!crd.value && !!crd.value._plural),
  options: { refetchInterval: 30000 },
})
const instances = computed(() => instancesQuery.data.value || [])

const activeTab = ref('overview')

// 远端模式下拉取真实 CRD 定义对象并转为 YAML（比静态模板准确）；失败回退静态模板
const realYaml = ref('')
onMounted(async () => {
  if (!crd.value) return
  try {
    const obj = await api.k8s(`/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${encodeURIComponent(route.params.name)}`)
    realYaml.value = yamlDump(obj)
  } catch { /* 无权限或不存在时回退静态模板 */ }
})

const tabs = [
  { key: 'overview', label: 'Overview' },
  { key: 'instances', label: 'Instances' },
  { key: 'yaml', label: 'YAML' },
]

// store.generateYAML 暂不支持 crd，提供一个静态模板
const staticYaml = computed(() => {
  if (!crd.value) return ''
  const c = crd.value
  const plural = c.name.split('.')[0]
  return `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ${c.name}
spec:
  group: ${c.group}
  names:
    kind: ${c.kind}
    listKind: ${c.kind}List
    plural: ${plural}
    singular: ${plural.replace(/s$/, '')}
  scope: ${c.scope}
  versions:
    - name: ${c.version}
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          description: "${c.description || ''}"
          properties:
            spec:
              type: object
              x-kubernetes-preserve-unknown-fields: true
            status:
              type: object
              x-kubernetes-preserve-unknown-fields: true
`
})

const expandedInst = ref(new Set())
const instYaml = ref({})          // instKey -> 实时 YAML（GET 对象后 dump，去掉 managedFields）
const instLoading = ref(new Set())
const instKey = (inst) => inst.name + (inst.namespace || '')

// 展开时拉取实例的实时对象并 dump 为 YAML（比静态模板准确：含 labels/annotations/真实 spec）
async function ensureInstYaml(inst, force = false) {
  const k = instKey(inst)
  if (!force && (instYaml.value[k] != null || instLoading.value.has(k))) return
  const s = new Set(instLoading.value); s.add(k); instLoading.value = s
  try {
    const obj = await api.k8s(store.crInstancePath(crd.value, inst))
    if (obj?.metadata) delete obj.metadata.managedFields
    instYaml.value = { ...instYaml.value, [k]: yamlDump(obj) }
  } catch {
    // 无权限或读取失败：保留模板回退（instYamlModel 退回 generateCRYaml）
  } finally {
    const s2 = new Set(instLoading.value); s2.delete(k); instLoading.value = s2
  }
}
function toggleInst(inst) {
  const s = new Set(expandedInst.value)
  const k = instKey(inst)
  if (s.has(k)) s.delete(k); else { s.add(k); ensureInstYaml(inst) }
  expandedInst.value = s
}
// —— Instances 裸表迁 DataTable(Wave5 B5,审计 #313,P0):手机卡片模式(首列=标题)——
// 展开行(实时 YAML 编辑)走 DataTable expandable + #expanded;本集合只跟踪「哪些行展开」
// 供 ensureInstYaml 懒拉取与 applyInstYaml 定向刷新。行键 = name(+ns,namespaced CRD 同名跨 ns 唯一)。
const instHeaders = computed(() => [
  { key: 'name', label: t('admin.crdDetail.name') },
  { key: 'namespace', label: t('admin.crdDetail.namespace') },
  { key: 'status', label: t('admin.crdDetail.status') },
  { key: 'age', label: 'AGE' },
  { key: 'actions', label: t('admin.crdDetail.actions'), align: 'right' },
])
const instRows = computed(() => instances.value.map(inst => ({ ...inst, _key: instKey(inst) })))
// 实时 YAML 优先；未加载完或失败时回退静态模板
const instYamlModel = (inst) => instYaml.value[instKey(inst)] ?? store.generateCRYaml(crd.value, inst)

// t('common.save')t('common.edit')（通用 server-side apply，适用于任意 CR kind）+ 局部刷新
async function applyInstYaml(yaml) {
  const r = await store.applyCRYaml(crd.value.name, yaml)
  notify(r.ok ? 'success' : 'error', r.ok ? t('admin.crdDetail.updatedSuccess', { kind: r.kind, name: r.name }) : (r.error || t('admin.crdDetail.applyFailed')))
  if (r.ok) {
    // spec 可能被 defaulter/webhook 改动：重新拉取当前展开行的实时 YAML
    const open = [...expandedInst.value]
    if (open.length === 1) {
      const inst = instances.value.find(i => instKey(i) === open[0])
      if (inst) ensureInstYaml(inst, true)
    }
  }
  return r
}

// t('common.delete')实例
const showDeleteInst = ref(false)
const deleteInstTarget = ref(null)
function confirmDeleteInst(inst) { deleteInstTarget.value = inst; showDeleteInst.value = true }
async function handleDeleteInst() {
  const inst = deleteInstTarget.value
  if (!inst) return
  try {
    await store.deleteCRInstance(crd.value, inst)
    const k = instKey(inst); const m = { ...instYaml.value }; delete m[k]; instYaml.value = m
    expandedInst.value = new Set([...expandedInst.value].filter(x => x !== k))
    notify('success', t('admin.crdDetail.deletedSuccess', { kind: crd.value.kind, name: inst.name }))
  } catch (e) { notify('error', e.message || t('admin.crdDetail.deleteFailed')) }
  showDeleteInst.value = false; deleteInstTarget.value = null
}

// 创建实例（通用 YAML apply：按 CRD 的 group/version/kind 生成骨架）
const showCreateInst = ref(false)
const createYaml = ref('')
function openCreateInst() {
  const c = crd.value; if (!c) return
  const meta = c.namespaced
    ? `metadata:\n  name: ${c.kind.toLowerCase()}-sample\n  namespace: default`
    : `metadata:\n  name: ${c.kind.toLowerCase()}-sample`
  createYaml.value = `apiVersion: ${c.group}/${c.version}\nkind: ${c.kind}\n${meta}\nspec:\n  # ${t('admin.crdDetail.fillBySchema', { kind: c.kind })}\n`
  showCreateInst.value = true
}
async function handleCreateInst(yaml) {
  const r = await store.applyCRYaml(crd.value.name, yaml)
  notify(r.ok ? 'success' : 'error', r.ok ? t('admin.crdDetail.createdSuccess', { kind: r.kind, name: r.name }) : (r.error || t('admin.crdDetail.createFailed')))
  if (r.ok) showCreateInst.value = false
  return r
}
</script>

<template>
  <div class="animate-fade-in" v-if="crd">
    <Breadcrumbs :items="[
      { label: 'Cluster', route: '/cluster' },
      { label: 'CRDs', route: '/crds' },
      { label: crd.name }
    ]" />

    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-x-sm gap-y-sm mt-sm mb-md">
      <div class="flex items-center gap-md min-w-0">
        <div class="w-12 h-12 rounded-xl bg-primary-container/20 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-primary text-2xl">extension</span>
        </div>
        <div class="min-w-0">
          <div class="flex items-baseline gap-sm flex-wrap">
            <h1 class="text-headline-md text-on-surface font-mono font-bold min-w-0 break-all" :title="crd.name">{{ crd.name }}</h1>
            <span class="px-2 py-0.5 bg-primary-container/20 text-primary text-xs font-semibold rounded shrink-0">{{ crd.kind }}</span>
          </div>
          <div class="flex items-center gap-sm mt-xs flex-wrap">
            <span class="font-mono text-xs text-on-surface-variant break-all">{{ crd.group }}/{{ crd.version }}</span>
            <span class="text-on-surface-variant/40">·</span>
            <span
              class="text-xs font-semibold inline-flex items-center gap-1"
              :class="crd.scope === 'Namespaced' ? 'text-tertiary-container' : 'text-secondary'"
            >
              <span class="material-symbols-outlined text-xs">{{ crd.scope === 'Namespaced' ? 'folder' : 'public' }}</span>
              {{ crd.scope }}
            </span>
            <span class="text-on-surface-variant/40">·</span>
            <span class="text-xs text-on-surface-variant">{{ instances.length }} {{ t('admin.crdDetail.instancesCount', { n: instances.length }) }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-xs">
        <button
          @click="router.push('/crds')"
          class="flex items-center gap-sm px-3 py-1.5 border border-outline-variant text-on-surface text-body-sm font-semibold rounded-lg hover:bg-surface-container-high transition-colors max-sm:min-h-[40px]"
        >
          <span class="material-symbols-outlined text-sm">arrow_back</span> {{ t('admin.crdDetail.backToList') }}
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex items-center gap-xs overflow-x-auto border-b border-outline-variant mb-md">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        @click="activeTab = tab.key"
        class="px-lg py-2 text-body-sm font-medium transition-colors relative shrink-0 whitespace-nowrap"
        :class="activeTab === tab.key ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'"
      >{{ tab.label }}<span v-if="activeTab === tab.key" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"></span></button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-md">
      <div class="lg:col-span-8">
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">info</span>
            <span class="text-body-sm font-semibold">{{ t('admin.crdDetail.overview') }}</span>
          </div>
          <div class="p-md grid grid-cols-2 gap-sm">
            <div class="p-sm rounded-lg bg-surface-container-low">
              <p class="text-xs text-on-surface-variant mb-xs">GROUP</p>
              <p class="font-mono text-code-sm text-primary font-semibold break-all">{{ crd.group }}</p>
            </div>
            <div class="p-sm rounded-lg bg-surface-container-low">
              <p class="text-xs text-on-surface-variant mb-xs">VERSION</p>
              <p class="font-mono text-code-sm text-primary font-semibold break-all">{{ crd.version }}</p>
            </div>
            <div class="p-sm rounded-lg bg-surface-container-low">
              <p class="text-xs text-on-surface-variant mb-xs">KIND</p>
              <p class="text-body-sm text-on-surface font-semibold break-all">{{ crd.kind }}</p>
            </div>
            <div class="p-sm rounded-lg bg-surface-container-low">
              <p class="text-xs text-on-surface-variant mb-xs">SCOPE</p>
              <p class="text-body-sm text-on-surface font-semibold">{{ crd.scope }}</p>
            </div>
            <div class="p-sm rounded-lg bg-surface-container-low">
              <p class="text-xs text-on-surface-variant mb-xs">NAMESPACED</p>
              <span class="material-symbols-outlined text-sm align-middle" :class="crd.namespaced ? 'text-primary' : 'text-outline-variant'">
                {{ crd.namespaced ? 'check_circle' : 'cancel' }}
              </span>
              <span class="ml-1 text-body-sm" :class="crd.namespaced ? 'text-on-surface' : 'text-on-surface-variant'">
                {{ crd.namespaced ? 'Yes' : 'No' }}
              </span>
            </div>
            <div class="p-sm rounded-lg bg-surface-container-low">
              <p class="text-xs text-on-surface-variant mb-xs">FULL NAME</p>
              <p class="font-mono text-xs text-on-surface break-all">{{ crd.name }}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="lg:col-span-4 flex flex-col gap-md">
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">description</span>
            <span class="text-body-sm font-semibold">{{ t('admin.crdDetail.description') }}</span>
          </div>
          <div class="p-md">
            <p class="text-body-sm text-on-surface-variant leading-relaxed">
              {{ crd.description || t('admin.crdDetail.noDescription') }}
            </p>
          </div>
        </div>
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">analytics</span>
            <span class="text-body-sm font-semibold">{{ t('admin.crdDetail.instanceStats') }}</span>
          </div>
          <div class="p-md space-y-sm">
            <div class="flex justify-between items-center py-xs border-b border-outline-variant/30">
              <span class="text-xs text-on-surface-variant">{{ t('admin.crdDetail.totalInstances') }}</span>
              <span class="font-mono text-code-sm text-primary font-semibold">{{ instances.length }}</span>
            </div>
            <div class="flex justify-between items-center py-xs">
              <span class="text-xs text-on-surface-variant">Scope</span>
              <span class="text-body-sm text-on-surface">{{ crd.scope }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Instances Tab(DataTable:手机卡片模式 + 内建展开行,Wave5 B5) -->
    <div v-if="activeTab === 'instances'" class="flex flex-col gap-md">
      <div class="flex items-center justify-between flex-wrap gap-x-sm gap-y-xs">
        <div class="flex items-center gap-sm min-w-0">
          <span class="material-symbols-outlined text-primary text-lg">list_alt</span>
          <span class="text-body-sm font-semibold">{{ t('admin.crdDetail.instancesTitle', { kind: crd.kind }) }}</span>
          <span class="text-xs text-on-surface-variant">{{ instances.length }} {{ t('admin.crdDetail.instancesCount', { n: instances.length }) }}</span>
        </div>
        <button
          @click="openCreateInst"
          class="flex items-center gap-xs px-3 py-1.5 bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 active:scale-95 transition-all max-sm:min-h-[40px]"
        >
          <span class="material-symbols-outlined text-sm">add</span> {{ t('admin.crdDetail.createInstance') }}
        </button>
      </div>
      <DataTable v-if="instances.length" :headers="instHeaders" :rows="instRows" row-key="_key" expandable @expand="toggleInst">
        <template #name="{ row }">
          <div class="flex items-center gap-sm min-w-0">
            <span class="material-symbols-outlined text-on-surface-variant text-base shrink-0">deployed_code</span>
            <span class="font-mono text-code-sm text-on-surface font-semibold truncate" :title="row.name">{{ row.name }}</span>
          </div>
        </template>
        <template #namespace="{ row }">
          <span v-if="row.namespace" class="px-2 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant">{{ row.namespace }}</span>
          <span v-else class="text-on-surface-variant text-xs">-</span>
        </template>
        <template #status="{ row }">
          <StatusChip :status="row.status || 'Unknown'" size="sm" />
        </template>
        <template #age="{ row }">
          <span class="text-xs text-on-surface-variant font-mono text-code-sm">{{ row.age }}</span>
        </template>
        <template #actions="{ row }">
          <button @click="confirmDeleteInst(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="t('admin.crdDetail.deleteInstance')">
            <span class="material-symbols-outlined text-base">delete</span>
          </button>
        </template>
        <template #expanded="{ row }">
          <YamlEditor :model-value="instYamlModel(row)" :readonly="false" height="360px" @save="applyInstYaml" />
        </template>
      </DataTable>
      <div v-else class="rounded-xl bg-surface-container-lowest border border-outline-variant px-md py-md text-center">
        <span class="material-symbols-outlined text-2xl text-surface-container-high">inbox</span>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('admin.crdDetail.noInstances') }}</p>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="realYaml || staticYaml" :readonly="true" height="560px" />
    </div>

    <!-- 创建实例 Modal（通用 YAML apply） -->
    <Modal v-model="showCreateInst" :title="t('admin.crdDetail.createModalTitle', { kind: crd.kind })" width="max-w-2xl">
      <p class="text-body-sm text-on-surface-variant mb-sm" v-html="t('admin.crdDetail.createModalDesc', { group: crd.group, version: crd.version, kind: crd.kind })"></p>
      <YamlEditor v-model="createYaml" :readonly="false" height="320px" @save="handleCreateInst" />
      <template #actions>
        <button @click="showCreateInst = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('admin.crdDetail.cancel') }}</button>
        <button @click="handleCreateInst(createYaml)" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('admin.crdDetail.applyCreate') }}</button>
      </template>
    </Modal>

    <!-- t('common.delete')实例 Modal -->
    <Modal v-model="showDeleteInst" :title="t('admin.crdDetail.deleteModalTitle', { kind: crd.kind })" width="max-w-md">
      <p class="text-body-md text-on-surface-variant" v-html="t('admin.crdDetail.deleteConfirm', { kind: crd.kind, name: deleteInstTarget?.name, namespace: deleteInstTarget?.namespace })"></p>
      <p class="text-body-sm text-error mt-sm" v-html="t('admin.crdDetail.deleteWarning')"></p>
      <template #actions>
        <button @click="showDeleteInst = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('admin.crdDetail.cancel') }}</button>
        <button @click="handleDeleteInst" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('admin.crdDetail.deleteButton') }}</button>
      </template>
    </Modal>
  </div>

  <!-- Not Found 兜底 -->
  <div v-else class="animate-fade-in text-center py-md">
    <span class="material-symbols-outlined text-2xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-xs">{{ t('admin.crdDetail.notFound') }}</h2>
    <p class="text-body-sm text-on-surface-variant mt-xs" v-html="t('admin.crdDetail.notFoundDesc', { name: route.params.name })"></p>
    <button
      @click="router.push('/crds')"
      class="mt-md px-3 py-1.5 bg-primary text-on-primary text-body-sm rounded-lg font-semibold hover:opacity-90 transition-opacity"
    >{{ t('admin.crdDetail.backToCrdList') }}</button>
  </div>
</template>
