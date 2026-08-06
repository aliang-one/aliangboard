<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail } from '@/composables/useK8sQuery'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import ResourceReferences from '@/components/common/ResourceReferences.vue'
import CodeViewer from '@/components/common/CodeViewer.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

// 详情走 Vue Query（单资源 + 15s 轮询）；store CRUD 已接 invalidateResource('configmaps')，编辑后自动刷新。
// cm = query 优先、store 兜底（首屏 query 未就绪时用 hydrate 值，避免闪「Not Found」）。
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const cmDetail = useResourceDetail({
  key: ['cluster', cid.value, 'configmaps', route.params.name],
  fetcher: () => store.fetchConfigMap(route.params.name, route.params.namespace),
  mock: store.getConfigMapByName(route.params.name, route.params.namespace),
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 15000 : false },
})
const cm = computed(() => cmDetail.data.value ?? store.getConfigMapByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('configmap', cm.value))

const activeTab = ref('data')
const selectedKey = ref('')
const showDeleteModal = ref(false)
const showAddKeyModal = ref(false)
const newKey = ref('')
const newValue = ref('')
const editingKey = ref(null)
const editValue = ref('')

const dataEntries = computed(() => {
  if (!cm.value?.data) return []
  return Object.entries(cm.value.data)
})

// 进入 Data tab / 切换 ConfigMap 时自动选中第一个文件
watch([() => cm.value?.name, () => activeTab.value, () => dataEntries.value.length], () => {
  if (activeTab.value === 'data' && dataEntries.value.length && !selectedKey.value) {
    selectedKey.value = dataEntries.value[0][0]
  }
}, { immediate: true })
watch(() => cm.value?.name, () => { selectedKey.value = ''; editingKey.value = null })

// 引用此 ConfigMap 的 Workload 数量
const refCount = computed(() =>
  store.getResourceReferences('ConfigMap', route.params.name, route.params.namespace).length
)

// 配置文件类型识别
const COLLAPSE_THRESHOLD = 6
const expandedKeys = ref(new Set())

function detectLang(key) {
  const k = (key || '').toLowerCase()
  if (k.endsWith('.yml') || k.endsWith('.yaml')) return { label: 'YAML', icon: 'data_object', color: 'bg-primary-container/10 text-primary', prismLang: 'yaml' }
  if (k.endsWith('.json')) return { label: 'JSON', icon: 'data_object', color: 'bg-tertiary-container/10 text-tertiary', prismLang: 'json' }
  if (k.endsWith('.toml')) return { label: 'TOML', icon: 'settings', color: 'bg-secondary-container/10 text-secondary', prismLang: 'toml' }
  if (k.endsWith('.conf') || k.endsWith('.cfg') || k.endsWith('.cnf') || k.endsWith('.ini')) return { label: 'CONF', icon: 'settings', color: 'bg-secondary-container/10 text-secondary', prismLang: 'ini' }
  if (k.endsWith('.properties')) return { label: 'PROPS', icon: 'list_alt', color: 'bg-secondary-container/10 text-secondary', prismLang: 'properties' }
  if (k.endsWith('.sh') || k.endsWith('.bash')) return { label: 'SHELL', icon: 'terminal', color: 'bg-tertiary-container/10 text-tertiary', prismLang: 'bash' }
  if (k.endsWith('.py')) return { label: 'PYTHON', icon: 'code', color: 'bg-primary-container/10 text-primary', prismLang: 'python' }
  if (k.endsWith('.js') || k.endsWith('.mjs') || k.endsWith('.jsx')) return { label: 'JS', icon: 'code', color: 'bg-tertiary-container/10 text-tertiary', prismLang: 'javascript' }
  if (k.endsWith('.ts') || k.endsWith('.tsx')) return { label: 'TS', icon: 'code', color: 'bg-primary-container/10 text-primary', prismLang: 'typescript' }
  if (k.endsWith('.xml')) return { label: 'XML', icon: 'code', color: 'bg-secondary-container/10 text-secondary', prismLang: 'markup' }
  if (k.endsWith('.env')) return { label: 'ENV', icon: 'code', color: 'bg-primary-container/10 text-primary', prismLang: 'properties' }
  if (k.endsWith('.crt') || k.endsWith('.key') || k.endsWith('.pem') || k.endsWith('.ca')) return { label: 'CERT', icon: 'lock', color: 'bg-error-container/10 text-error', prismLang: 'none' }
  return { label: 'TEXT', icon: 'description', color: 'bg-surface-container text-on-surface-variant', prismLang: 'none' }
}

function lineCount(val) {
  return val ? String(val).split('\n').length : 0
}

function isCollapsible(key, val) {
  return lineCount(val) > COLLAPSE_THRESHOLD
}

function isExpanded(key) {
  return expandedKeys.value.has(key)
}

function toggleExpand(key) {
  const s = new Set(expandedKeys.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  expandedKeys.value = s
}

async function handleDelete() {
  await store.deleteConfigMap(route.params.name, route.params.namespace)
  router.push({ name: 'NsConfigMaps', params: { namespace: route.params.namespace } })
}

function addKey() {
  if (!newKey.value) return
  const data = { ...(cm.value.data || {}) }
  const addedKey = newKey.value
  data[addedKey] = newValue.value
  store.updateConfigMap(route.params.name, route.params.namespace, { data, keys: Object.keys(data).length })
  newKey.value = ''
  newValue.value = ''
  showAddKeyModal.value = false
  selectedKey.value = addedKey
}

function startEdit(key) {
  editingKey.value = key
  editValue.value = cm.value.data[key]
}

function saveEdit() {
  if (editingKey.value === null) return
  const data = { ...cm.value.data }
  data[editingKey.value] = editValue.value
  store.updateConfigMap(route.params.name, route.params.namespace, { data })
  editingKey.value = null
  editValue.value = ''
}

function deleteKey(key) {
  const data = { ...cm.value.data }
  delete data[key]
  store.updateConfigMap(route.params.name, route.params.namespace, { data, keys: Object.keys(data).length })
}

const allAnnotations = computed(() => {
  if (!cm.value?.annotations) return []
  return Object.entries(cm.value.annotations)
})

const allLabels = computed(() => {
  if (!cm.value?.labels) return []
  return Object.entries(cm.value.labels)
})

// === Annotations 编辑 ===
const showAddAnnModal = ref(false)
const newAnnKey = ref('')
const newAnnValue = ref('')
const editingAnn = ref(null)
const editAnnValue = ref('')

function addAnnotation() {
  if (!newAnnKey.value) return
  const annotations = { ...(cm.value.annotations || {}) }
  annotations[newAnnKey.value] = newAnnValue.value
  store.updateConfigMap(route.params.name, route.params.namespace, { annotations })
  newAnnKey.value = ''
  newAnnValue.value = ''
  showAddAnnModal.value = false
}
function deleteAnnotation(key) {
  const annotations = { ...cm.value.annotations }
  delete annotations[key]
  store.updateConfigMap(route.params.name, route.params.namespace, { annotations })
}
function startEditAnn(key) { editingAnn.value = key; editAnnValue.value = cm.value.annotations[key] }
function saveEditAnn() {
  if (editingAnn.value === null) return
  const annotations = { ...cm.value.annotations }
  annotations[editingAnn.value] = editAnnValue.value
  store.updateConfigMap(route.params.name, route.params.namespace, { annotations })
  editingAnn.value = null
}

// === Labels 编辑 ===
const showAddLabelModal = ref(false)
const newLabelKey = ref('')
const newLabelValue = ref('')
const editingLabel = ref(null)
const editLabelValue = ref('')

function addLabel() {
  if (!newLabelKey.value) return
  const labels = { ...(cm.value.labels || {}) }
  labels[newLabelKey.value] = newLabelValue.value
  store.updateConfigMap(route.params.name, route.params.namespace, { labels })
  newLabelKey.value = ''
  newLabelValue.value = ''
  showAddLabelModal.value = false
}
function deleteLabel(key) {
  const labels = { ...cm.value.labels }
  delete labels[key]
  store.updateConfigMap(route.params.name, route.params.namespace, { labels })
}
function startEditLabel(key) { editingLabel.value = key; editLabelValue.value = cm.value.labels[key] }
function saveEditLabel() {
  if (editingLabel.value === null) return
  const labels = { ...cm.value.labels }
  labels[editingLabel.value] = editLabelValue.value
  store.updateConfigMap(route.params.name, route.params.namespace, { labels })
  editingLabel.value = null
}
</script>

<template>
  <div class="animate-fade-in" v-if="cm">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'ConfigMaps', route: `/ns/${route.params.namespace}/configmaps` },
      { label: route.params.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-secondary text-3xl">description</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ cm.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-secondary-container/10 text-secondary text-label-caps rounded-full font-medium">ConfigMap</span>
            <span class="text-body-sm text-on-surface-variant">{{ cm.keys }} keys</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ cm.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['data', 'references', 'annotations', 'labels', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
        <span v-if="tab === 'references'" class="ml-xs px-1.5 py-0 rounded-full bg-primary-container/20 text-primary text-label-caps">{{ refCount }}</span>
      </button>
    </div>

    <!-- Data Tab：文件浏览器（左文件列表 + 右内容查看/编辑）-->
    <div v-if="activeTab === 'data'" class="flex gap-md">
      <!-- 左栏：文件列表 -->
      <div class="w-56 shrink-0 bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden flex flex-col">
        <div class="px-md py-sm border-b border-outline-variant bg-surface-container-low flex items-center gap-sm">
          <span class="material-symbols-outlined text-secondary text-base">folder</span>
          <span class="text-label-caps text-on-surface-variant truncate">Files ({{ dataEntries.length }})</span>
        </div>
        <div class="flex-1 overflow-y-auto max-h-[60vh]">
          <button v-for="([key, val], idx) in dataEntries" :key="idx"
            @click="selectedKey = key; editingKey = null"
            class="w-full flex items-center gap-sm px-md py-sm text-left transition-colors group"
            :class="selectedKey === key ? 'bg-primary-container/15 text-primary' : 'text-on-surface hover:bg-surface-container-low'">
            <span class="material-symbols-outlined text-base shrink-0" :class="selectedKey === key ? 'text-primary' : 'text-on-surface-variant'">{{ detectLang(key).icon }}</span>
            <span class="text-body-sm font-mono truncate flex-1">{{ key }}</span>
            <span class="text-[10px] text-on-surface-variant shrink-0">{{ lineCount(val) }}</span>
            <span @click.stop="deleteKey(key); selectedKey = dataEntries.find(([k]) => k !== key)?.[0] || ''" class="opacity-0 group-hover:opacity-100 p-0.5 text-on-surface-variant hover:text-error rounded transition-opacity shrink-0 cursor-pointer" title="删除">
              <span class="material-symbols-outlined text-sm">close</span>
            </span>
          </button>
          <div v-if="!dataEntries.length" class="px-md py-lg text-center text-on-surface-variant text-body-sm">无文件</div>
        </div>
        <button @click="showAddKeyModal = true" class="flex items-center justify-center gap-sm px-md py-sm border-t border-outline-variant text-body-sm text-primary font-medium hover:bg-primary-container/10 transition-colors">
          <span class="material-symbols-outlined text-sm">add</span> 新建文件
        </button>
      </div>

      <!-- 右栏：文件内容 -->
      <div class="flex-1 bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden flex flex-col">
        <!-- 有选中文件 -->
        <template v-if="selectedKey && cm.data[selectedKey] != null">
          <div class="px-md py-sm border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-base text-on-surface-variant">{{ detectLang(selectedKey).icon }}</span>
              <span class="font-mono text-code-sm text-primary font-semibold">{{ selectedKey }}</span>
              <span class="inline-flex items-center gap-1 px-1.5 py-0 rounded text-label-caps font-medium" :class="detectLang(selectedKey).color">
                <span class="material-symbols-outlined text-xs">{{ detectLang(selectedKey).icon }}</span>{{ detectLang(selectedKey).label }}
              </span>
              <span class="text-label-caps text-on-surface-variant">{{ lineCount(cm.data[selectedKey]) }} 行</span>
            </div>
            <div class="flex gap-xs">
              <button v-if="editingKey !== selectedKey" @click="startEdit(selectedKey)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="编辑"><span class="material-symbols-outlined text-lg">edit</span></button>
              <button @click="deleteKey(selectedKey); selectedKey = dataEntries.find(([k]) => k !== selectedKey)?.[0] || ''" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="删除"><span class="material-symbols-outlined text-lg">delete</span></button>
            </div>
          </div>
          <!-- 编辑模式 -->
          <div v-if="editingKey === selectedKey" class="p-md flex-1">
            <textarea v-model="editValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono min-h-[300px] resize-y focus:ring-2 focus:ring-primary focus:border-primary"></textarea>
            <div class="flex justify-end gap-sm mt-sm">
              <button @click="editingKey = null" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">取消</button>
              <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">保存</button>
            </div>
          </div>
          <!-- 查看模式 -->
          <div v-else class="p-md flex-1">
            <CodeViewer :code="cm.data[selectedKey]" :lang="detectLang(selectedKey).prismLang" />
          </div>
        </template>
        <!-- 未选中 / 无文件 -->
        <div v-else class="flex items-center justify-center flex-1 min-h-[300px] text-on-surface-variant">
          <div class="text-center">
            <span class="material-symbols-outlined text-3xl text-surface-container-high">description</span>
            <p class="mt-sm text-body-sm">选择左侧文件查看内容</p>
          </div>
        </div>
      </div>
    </div>

    <!-- References Tab -->
    <div v-if="activeTab === 'references'">
      <ResourceReferences kind="ConfigMap" :name="route.params.name" />
    </div>

    <!-- Annotations Tab（可编辑）-->
    <div v-if="activeTab === 'annotations'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Annotations ({{ allAnnotations.length }})</h3>
          <button @click="showAddAnnModal = true" class="flex items-center gap-sm px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">
            <span class="material-symbols-outlined text-sm">add</span> Add Annotation
          </button>
        </div>
        <div class="divide-y divide-outline-variant/30">
          <div v-for="([key, val], idx) in allAnnotations" :key="idx" class="px-lg py-md">
            <div class="flex items-center justify-between mb-sm">
              <span class="font-mono text-code-sm text-primary font-semibold break-all">{{ key }}</span>
              <div class="flex gap-xs shrink-0">
                <button v-if="editingAnn !== key" @click="startEditAnn(key)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-lg">edit</span></button>
                <button @click="deleteAnnotation(key)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
              </div>
            </div>
            <div v-if="editingAnn === key" class="flex gap-sm">
              <textarea v-model="editAnnValue" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono min-h-[60px] resize-y focus:ring-2 focus:ring-primary"></textarea>
              <div class="flex flex-col gap-xs">
                <button @click="saveEditAnn" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">Save</button>
                <button @click="editingAnn = null" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">Cancel</button>
              </div>
            </div>
            <div v-else class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm text-on-surface-variant whitespace-pre-wrap break-all">{{ val }}</div>
          </div>
          <div v-if="!allAnnotations.length" class="px-lg py-xl text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-3xl">label</span>
            <p class="mt-sm">No annotations</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Labels Tab（可编辑）-->
    <div v-if="activeTab === 'labels'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Labels ({{ allLabels.length }})</h3>
          <button @click="showAddLabelModal = true" class="flex items-center gap-sm px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">
            <span class="material-symbols-outlined text-sm">add</span> Add Label
          </button>
        </div>
        <div class="divide-y divide-outline-variant/30">
          <div v-for="([key, val], idx) in allLabels" :key="idx" class="px-lg py-md">
            <div class="flex items-center justify-between mb-sm">
              <span class="font-mono text-code-sm text-secondary font-semibold break-all">{{ key }}</span>
              <div class="flex gap-xs shrink-0">
                <button v-if="editingLabel !== key" @click="startEditLabel(key)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-lg">edit</span></button>
                <button @click="deleteLabel(key)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
              </div>
            </div>
            <div v-if="editingLabel === key" class="flex gap-sm">
              <input v-model="editLabelValue" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
              <div class="flex gap-xs">
                <button @click="saveEditLabel" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">Save</button>
                <button @click="editingLabel = null" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">Cancel</button>
              </div>
            </div>
            <div v-else class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm text-on-surface-variant break-all">{{ val }}</div>
          </div>
          <div v-if="!allLabels.length" class="px-lg py-xl text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-3xl">label_off</span>
            <p class="mt-sm">No labels</p>
          </div>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>
  </div>
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">ConfigMap Not Found</h2>
    <button @click="router.push({ name: 'NsConfigMaps', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to ConfigMaps</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete ConfigMap" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete ConfigMap <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Pods using this ConfigMap may fail. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- Add Key Modal -->
  <Modal v-model="showAddKeyModal" title="Add Data Key" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Key Name</label>
        <input v-model="newKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="MY_CONFIG_KEY" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Value</label>
        <textarea v-model="newValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono h-24 resize-y focus:ring-2 focus:ring-primary" placeholder="config value..."></textarea>
      </div>
    </div>
    <template #actions>
      <button @click="showAddKeyModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="addKey" :disabled="!newKey" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Add</button>
    </template>
  </Modal>

  <!-- Add Annotation Modal -->
  <Modal v-model="showAddAnnModal" title="Add Annotation" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Annotation Key</label>
        <input v-model="newAnnKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="kubectl.kubernetes.io/last-applied-configuration" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Value</label>
        <textarea v-model="newAnnValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono h-20 resize-y focus:ring-2 focus:ring-primary" placeholder="{}"></textarea>
      </div>
    </div>
    <template #actions>
      <button @click="showAddAnnModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="addAnnotation" :disabled="!newAnnKey" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Add</button>
    </template>
  </Modal>

  <!-- Add Label Modal -->
  <Modal v-model="showAddLabelModal" title="Add Label" width="max-w-md">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Label Key</label>
        <input v-model="newLabelKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="app.kubernetes.io/name" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Value</label>
        <input v-model="newLabelValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="my-app" />
      </div>
    </div>
    <template #actions>
      <button @click="showAddLabelModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="addLabel" :disabled="!newLabelKey" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Add</button>
    </template>
  </Modal>
</template>
