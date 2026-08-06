<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { api } from '@/api/client'
import { dump as yamlDump } from 'js-yaml'
import { useI18n } from 'vue-i18n'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import { notify } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()

const crd = computed(() => store.getCRDByName(route.params.name))

const activeTab = ref('overview')

// 远端模式下拉取真实 CRD 定义对象并转为 YAML（比静态模板准确）；失败回退静态模板
const realYaml = ref('')
onMounted(async () => {
  if (!store.remoteMode || !crd.value) return
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
      const inst = crd.value.instances.find(i => instKey(i) === open[0])
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
    <div class="flex items-start justify-between mt-sm mb-md">
      <div class="flex items-center gap-md">
        <div class="w-12 h-12 rounded-xl bg-primary-container/20 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-primary text-2xl">extension</span>
        </div>
        <div>
          <div class="flex items-baseline gap-sm flex-wrap">
            <h1 class="text-headline-md text-on-surface font-mono font-bold">{{ crd.name }}</h1>
            <span class="px-2 py-0.5 bg-primary-container/20 text-primary text-xs font-semibold rounded">{{ crd.kind }}</span>
          </div>
          <div class="flex items-center gap-sm mt-xs flex-wrap">
            <span class="font-mono text-xs text-on-surface-variant">{{ crd.group }}/{{ crd.version }}</span>
            <span class="text-on-surface-variant/40">·</span>
            <span
              class="text-xs font-semibold inline-flex items-center gap-1"
              :class="crd.scope === 'Namespaced' ? 'text-tertiary-container' : 'text-secondary'"
            >
              <span class="material-symbols-outlined text-xs">{{ crd.scope === 'Namespaced' ? 'folder' : 'public' }}</span>
              {{ crd.scope }}
            </span>
            <span class="text-on-surface-variant/40">·</span>
            <span class="text-xs text-on-surface-variant">{{ crd.instances?.length || 0 }} {{ t('admin.crdDetail.instancesCount', { n: crd.instances?.length || 0 }) }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-xs shrink-0">
        <button
          @click="router.push('/crds')"
          class="flex items-center gap-sm px-3 py-1.5 border border-outline-variant text-on-surface text-body-sm font-semibold rounded-lg hover:bg-surface-container-high transition-colors"
        >
          <span class="material-symbols-outlined text-sm">arrow_back</span> {{ t('admin.crdDetail.backToList') }}
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex items-center gap-xs border-b border-outline-variant mb-md">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        @click="activeTab = tab.key"
        class="px-lg py-2 text-body-sm font-medium transition-colors relative"
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
              <p class="font-mono text-code-sm text-primary font-semibold">{{ crd.group }}</p>
            </div>
            <div class="p-sm rounded-lg bg-surface-container-low">
              <p class="text-xs text-on-surface-variant mb-xs">VERSION</p>
              <p class="font-mono text-code-sm text-primary font-semibold">{{ crd.version }}</p>
            </div>
            <div class="p-sm rounded-lg bg-surface-container-low">
              <p class="text-xs text-on-surface-variant mb-xs">KIND</p>
              <p class="text-body-sm text-on-surface font-semibold">{{ crd.kind }}</p>
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
              <span class="font-mono text-code-sm text-primary font-semibold">{{ crd.instances?.length || 0 }}</span>
            </div>
            <div class="flex justify-between items-center py-xs">
              <span class="text-xs text-on-surface-variant">Scope</span>
              <span class="text-body-sm text-on-surface">{{ crd.scope }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Instances Tab -->
    <div v-if="activeTab === 'instances'">
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
        <div class="flex items-center justify-between px-md py-2.5 border-b border-outline-variant/50">
          <div class="flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">list_alt</span>
            <span class="text-body-sm font-semibold">{{ t('admin.crdDetail.instancesTitle', { kind: crd.kind }) }}</span>
          </div>
          <div class="flex items-center gap-sm">
            <span class="text-xs text-on-surface-variant">{{ crd.instances?.length || 0 }} {{ t('admin.crdDetail.instancesCount', { n: crd.instances?.length || 0 }) }}</span>
            <button
              @click="openCreateInst"
              class="flex items-center gap-xs px-3 py-1.5 bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 active:scale-95 transition-all"
            >
              <span class="material-symbols-outlined text-sm">add</span> {{ t('admin.crdDetail.createInstance') }}
            </button>
          </div>
        </div>
        <table v-if="crd.instances && crd.instances.length" class="w-full">
          <thead>
            <tr class="border-b border-outline-variant bg-surface-container-low/50">
              <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('admin.crdDetail.name') }}</th>
              <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('admin.crdDetail.namespace') }}</th>
              <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('admin.crdDetail.status') }}</th>
              <th class="text-left px-md py-2 text-xs font-medium text-on-surface-variant">AGE</th>
              <th class="text-right px-md py-2 text-xs font-medium text-on-surface-variant w-24">{{ t('admin.crdDetail.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="inst in crd.instances" :key="inst.name + (inst.namespace || '')">
              <tr class="border-b border-outline-variant/15 last:border-0 hover:bg-surface-container-low/40 transition-colors">
                <td class="px-md py-2">
                  <div class="flex items-center gap-sm">
                    <span class="material-symbols-outlined text-on-surface-variant text-base">deployed_code</span>
                    <span class="font-mono text-code-sm text-on-surface font-semibold">{{ inst.name }}</span>
                  </div>
                </td>
                <td class="px-md py-2">
                  <span v-if="inst.namespace" class="px-2 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant">{{ inst.namespace }}</span>
                  <span v-else class="text-on-surface-variant text-xs">-</span>
                </td>
                <td class="px-md py-2">
                  <StatusChip :status="inst.status || 'Unknown'" size="sm" />
                </td>
                <td class="px-md py-2">
                  <span class="text-xs text-on-surface-variant font-mono text-code-sm">{{ inst.age }}</span>
                </td>
                <td class="px-md py-2 text-right">
                  <div class="flex gap-1 justify-end">
                    <button @click="toggleInst(inst)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="expandedInst.has(instKey(inst)) ? t('admin.crdDetail.collapse') : t('admin.crdDetail.viewEditYaml')">
                      <span class="material-symbols-outlined text-base transition-transform" :class="expandedInst.has(instKey(inst)) ? 'rotate-180' : ''">expand_more</span>
                    </button>
                    <button @click="confirmDeleteInst(inst)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('admin.crdDetail.deleteInstance')">
                      <span class="material-symbols-outlined text-base">delete</span>
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="expandedInst.has(instKey(inst))">
                <td colspan="5" class="px-md py-2 bg-surface-container-low/40">
                  <YamlEditor :model-value="instYamlModel(inst)" :readonly="false" height="360px" @save="applyInstYaml" />
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-else class="px-md py-md text-center">
          <span class="material-symbols-outlined text-2xl text-surface-container-high">inbox</span>
          <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('admin.crdDetail.noInstances') }}</p>
        </div>
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
