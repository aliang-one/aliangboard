<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { api } from '@/api/client'
import { dump as yamlDump } from 'js-yaml'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import { notify } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()

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

// 保存编辑（通用 server-side apply，适用于任意 CR kind）+ 局部刷新
async function applyInstYaml(yaml) {
  const r = await store.applyCRYaml(crd.value.name, yaml)
  notify(r.ok ? 'success' : 'error', r.ok ? `${r.kind}/${r.name} 已更新` : (r.error || '应用失败'))
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

// 删除实例
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
    notify('success', `${crd.value.kind}/${inst.name} 已删除`)
  } catch (e) { notify('error', e.message || '删除失败') }
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
  createYaml.value = `apiVersion: ${c.group}/${c.version}\nkind: ${c.kind}\n${meta}\nspec:\n  # 按 ${c.kind} 的 OpenAPI schema 填写\n`
  showCreateInst.value = true
}
async function handleCreateInst(yaml) {
  const r = await store.applyCRYaml(crd.value.name, yaml)
  notify(r.ok ? 'success' : 'error', r.ok ? `${r.kind}/${r.name} 已创建` : (r.error || '创建失败'))
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
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">extension</span>
        </div>
        <div>
          <div class="flex items-center gap-md">
            <h1 class="text-display-lg text-on-surface font-mono">{{ crd.name }}</h1>
            <span class="px-2 py-0.5 bg-primary-container/20 text-primary text-body-sm font-semibold rounded">{{ crd.kind }}</span>
          </div>
          <div class="flex items-center gap-md mt-xs">
            <span class="font-mono text-code-sm text-on-surface-variant">{{ crd.group }}/{{ crd.version }}</span>
            <span class="text-on-surface-variant">·</span>
            <span
              class="text-body-sm font-semibold inline-flex items-center gap-1"
              :class="crd.scope === 'Namespaced' ? 'text-tertiary-container' : 'text-secondary'"
            >
              <span class="material-symbols-outlined text-sm">{{ crd.scope === 'Namespaced' ? 'folder' : 'public' }}</span>
              {{ crd.scope }}
            </span>
            <span class="text-on-surface-variant">·</span>
            <span class="text-body-sm text-on-surface-variant">{{ crd.instances?.length || 0 }} 个实例</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button
          @click="router.push('/crds')"
          class="flex items-center gap-sm px-md py-sm border border-outline-variant text-on-surface font-semibold rounded-lg hover:bg-surface-container-high transition-colors"
        >
          <span class="material-symbols-outlined">arrow_back</span> 返回列表
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        @click="activeTab = tab.key"
        class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors"
        :class="activeTab === tab.key ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'"
      >{{ tab.label }}</button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">概览</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">GROUP</p>
              <p class="font-mono text-code-md text-primary font-semibold">{{ crd.group }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">VERSION</p>
              <p class="font-mono text-code-md text-primary font-semibold">{{ crd.version }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">KIND</p>
              <p class="text-body-md text-on-surface font-semibold">{{ crd.kind }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">SCOPE</p>
              <p class="text-body-md text-on-surface font-semibold">{{ crd.scope }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">NAMESPACED</p>
              <span class="material-symbols-outlined" :class="crd.namespaced ? 'text-primary' : 'text-outline-variant'">
                {{ crd.namespaced ? 'check_circle' : 'cancel' }}
              </span>
              <span class="ml-1 text-body-md" :class="crd.namespaced ? 'text-on-surface' : 'text-on-surface-variant'">
                {{ crd.namespaced ? '是' : '否' }}
              </span>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">FULL NAME</p>
              <p class="font-mono text-code-sm text-on-surface break-all">{{ crd.name }}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">描述</h3>
          <p class="text-body-md text-on-surface-variant leading-relaxed">
            {{ crd.description || '暂无描述信息。' }}
          </p>
        </div>
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">实例统计</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">实例总数</span>
              <span class="font-mono text-code-md text-primary font-semibold">{{ crd.instances?.length || 0 }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Scope</span>
              <span class="text-body-md text-on-surface">{{ crd.scope }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Instances Tab -->
    <div v-if="activeTab === 'instances'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="flex items-center justify-between px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <div class="flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary">list_alt</span>
            <span class="text-headline-sm text-on-surface">{{ crd.kind }} 实例</span>
          </div>
          <div class="flex items-center gap-md">
            <span class="text-body-sm text-on-surface-variant">{{ crd.instances?.length || 0 }} 个实例</span>
            <button
              @click="openCreateInst"
              class="flex items-center gap-xs px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 active:scale-95 transition-all"
            >
              <span class="material-symbols-outlined text-sm">add</span> 创建实例
            </button>
          </div>
        </div>
        <table v-if="crd.instances && crd.instances.length" class="w-full">
          <thead>
            <tr class="border-b border-outline-variant bg-surface-container-low">
              <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">NAME</th>
              <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">NAMESPACE</th>
              <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">STATUS</th>
              <th class="text-left px-md py-sm text-label-caps text-on-surface-variant">AGE</th>
              <th class="text-right px-md py-sm text-label-caps text-on-surface-variant w-24">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="inst in crd.instances" :key="inst.name + (inst.namespace || '')">
              <tr class="border-b border-outline-variant/30 last:border-0 hover:bg-surface-container-low transition-colors">
                <td class="px-md py-md">
                  <div class="flex items-center gap-sm">
                    <span class="material-symbols-outlined text-on-surface-variant text-lg">deployed_code</span>
                    <span class="font-mono text-code-md text-on-surface font-semibold">{{ inst.name }}</span>
                  </div>
                </td>
                <td class="px-md py-md">
                  <span v-if="inst.namespace" class="px-2 py-0.5 bg-surface-container rounded text-body-sm text-on-surface-variant border border-outline-variant">{{ inst.namespace }}</span>
                  <span v-else class="text-on-surface-variant text-body-sm">-</span>
                </td>
                <td class="px-md py-md">
                  <StatusChip :status="inst.status || 'Unknown'" />
                </td>
                <td class="px-md py-md">
                  <span class="text-body-sm text-on-surface-variant font-mono text-code-sm">{{ inst.age }}</span>
                </td>
                <td class="px-md py-md text-right">
                  <div class="flex gap-1 justify-end">
                    <button @click="toggleInst(inst)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="expandedInst.has(instKey(inst)) ? '收起' : '查看 / 编辑 YAML'">
                      <span class="material-symbols-outlined text-lg transition-transform" :class="expandedInst.has(instKey(inst)) ? 'rotate-180' : ''">expand_more</span>
                    </button>
                    <button @click="confirmDeleteInst(inst)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="删除实例">
                      <span class="material-symbols-outlined text-lg">delete</span>
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="expandedInst.has(instKey(inst))">
                <td colspan="5" class="px-md py-md bg-surface-container-low">
                  <YamlEditor :model-value="instYamlModel(inst)" :readonly="false" height="360px" @save="applyInstYaml" />
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-else class="px-md py-xxl text-center">
          <span class="material-symbols-outlined text-5xl text-surface-container-high">inbox</span>
          <p class="text-body-md text-on-surface-variant mt-md">该 CRD 暂无实例</p>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="realYaml || staticYaml" :readonly="true" height="560px" />
    </div>

    <!-- 创建实例 Modal（通用 YAML apply） -->
    <Modal v-model="showCreateInst" :title="`创建 ${crd.kind} 实例`" width="max-w-2xl">
      <p class="text-body-sm text-on-surface-variant mb-sm">
        编辑 YAML 后应用（server-side apply）。骨架按
        <span class="font-mono">{{ crd.group }}/{{ crd.version }} · {{ crd.kind }}</span> 生成。
      </p>
      <YamlEditor v-model="createYaml" :readonly="false" height="320px" @save="handleCreateInst" />
      <template #actions>
        <button @click="showCreateInst = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
        <button @click="handleCreateInst(createYaml)" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">应用创建</button>
      </template>
    </Modal>

    <!-- 删除实例 Modal -->
    <Modal v-model="showDeleteInst" :title="`删除 ${crd.kind} 实例`" width="max-w-md">
      <p class="text-body-md text-on-surface-variant">
        确认删除 <span class="font-mono text-on-surface font-semibold">{{ crd.kind }}/{{ deleteInstTarget?.name }}</span>
        <span v-if="deleteInstTarget?.namespace">（namespace <span class="font-mono">{{ deleteInstTarget.namespace }}</span>）</span>？
      </p>
      <p class="text-body-sm text-error mt-sm">此操作不可撤销。</p>
      <template #actions>
        <button @click="showDeleteInst = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
        <button @click="handleDeleteInst" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">删除</button>
      </template>
    </Modal>
  </div>

  <!-- Not Found 兜底 -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">CRD 未找到</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">找不到名为 <span class="font-mono text-on-surface font-semibold">{{ route.params.name }}</span> 的自定义资源定义。</p>
    <button
      @click="router.push('/crds')"
      class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 transition-opacity"
    >返回 CRD 列表</button>
  </div>
</template>
