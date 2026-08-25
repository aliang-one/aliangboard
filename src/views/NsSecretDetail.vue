<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
	import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'
import { useResourceApply } from '@/composables/useResourceApply'
import { detectSecretTemplate, SECRET_TEMPLATES } from '@/composables/useSecretTemplates'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import ResourceReferences from '@/components/common/ResourceReferences.vue'

const { t } = useI18n()
	const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

// 详情走 Vue Query（单资源 + 15s 轮询）；store CRUD 已接 invalidateResource('secrets')，编辑后自动刷新。
const cid = computed(() => (store.currentCluster || 'cluster'))
const secretDetail = useResourceDetail({
  key: ['cluster', cid, 'secrets', route.params.name],
  fetcher: () => store.fetchSecret(route.params.name, route.params.namespace),
  options: { refetchInterval: 15000 },
})
const secret = computed(() => secretDetail.data.value)
const yaml = computed(() => store.generateYAML('secret', secret.value))

const activeTab = ref('data')
const tabs = computed(() => [
  { key: 'data', label: t('ns.secretDetail.tabData') },
  { key: 'references', label: t('ns.secretDetail.tabReferences') },
  { key: 'annotations', label: t('ns.secretDetail.tabAnnotations') },
  { key: 'labels', label: t('ns.secretDetail.tabLabels') },
  { key: 'yaml', label: t('ns.secretDetail.tabYaml') },
])
const showDeleteModal = ref(false)
const showAddKeyModal = ref(false)
const newKey = ref('')
const newValue = ref('')
const editingKey = ref(null)
const editValue = ref('')
const revealedKeys = ref(new Set())

// Secret.data stores base64; decode for display/edit, re-encode when writing back via store
const decode = (v) => store.decodeBase64(v)
const decodedData = (d) => Object.fromEntries(Object.entries(d || {}).map(([k, v]) => [k, decode(v)]))

const dataEntries = computed(() => {
  if (!secret.value?.data) return []
  return Object.entries(secret.value.data)
})

const secretTemplateId = computed(() => detectSecretTemplate(secret.value))
const secretTemplate = computed(() => SECRET_TEMPLATES.find(t => t.id === secretTemplateId.value))
const dockerRegistries = computed(() => {
  if (secretTemplateId.value !== 'docker') return []
  try {
    const raw = decode(secret.value?.data?.['.dockerconfigjson'] || '')
    const config = JSON.parse(raw)
    return Object.entries(config.auths || {}).map(([server, info]) => ({ server, username: info.username || '—' }))
  } catch { return [] }
})

function toggleReveal(key) {
  const s = new Set(revealedKeys.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  revealedKeys.value = s
}

async function handleDelete() {
  await store.deleteSecret(route.params.name, route.params.namespace)
  router.push({ name: 'NsSecrets', params: { namespace: route.params.namespace } })
}

function addKey() {
  if (!newKey.value) return
  const data = decodedData(secret.value.data)
  data[newKey.value] = newValue.value
  store.updateSecret(route.params.name, route.params.namespace, { data, keys: Object.keys(data).length })
  newKey.value = ''
  newValue.value = ''
  showAddKeyModal.value = false
}

function startEdit(key) {
  editingKey.value = key
  editValue.value = decode(secret.value.data[key])
}

function saveEdit() {
  if (editingKey.value === null) return
  const data = decodedData(secret.value.data)
  data[editingKey.value] = editValue.value
  store.updateSecret(route.params.name, route.params.namespace, { data })
  editingKey.value = null
  editValue.value = ''
}

function deleteKey(key) {
  const data = decodedData(secret.value.data)
  delete data[key]
  store.updateSecret(route.params.name, route.params.namespace, { data, keys: Object.keys(data).length })
}

const allAnnotations = computed(() => {
  if (!secret.value?.annotations) return []
  return Object.entries(secret.value.annotations)
})
const allLabels = computed(() => {
  if (!secret.value?.labels) return []
  return Object.entries(secret.value.labels)
})

// === Annotations t('common.edit') ===
const showAddAnnModal = ref(false)
const newAnnKey = ref('')
const newAnnValue = ref('')
const editingAnn = ref(null)
const editAnnValue = ref('')

function addAnnotation() {
  if (!newAnnKey.value) return
  const annotations = { ...(secret.value.annotations || {}) }
  annotations[newAnnKey.value] = newAnnValue.value
  store.updateSecret(route.params.name, route.params.namespace, { annotations })
  newAnnKey.value = ''; newAnnValue.value = ''; showAddAnnModal.value = false
}
function deleteAnnotation(key) {
  const annotations = { ...secret.value.annotations }
  delete annotations[key]
  store.updateSecret(route.params.name, route.params.namespace, { annotations })
}
function startEditAnn(key) { editingAnn.value = key; editAnnValue.value = secret.value.annotations[key] }
function saveEditAnn() {
  if (editingAnn.value === null) return
  const annotations = { ...secret.value.annotations }
  annotations[editingAnn.value] = editAnnValue.value
  store.updateSecret(route.params.name, route.params.namespace, { annotations })
  editingAnn.value = null
}

// === Labels t('common.edit') ===
const showAddLabelModal = ref(false)
const newLabelKey = ref('')
const newLabelValue = ref('')
const editingLabel = ref(null)
const editLabelValue = ref('')

function addLabel() {
  if (!newLabelKey.value) return
  const labels = { ...(secret.value.labels || {}) }
  labels[newLabelKey.value] = newLabelValue.value
  store.updateSecret(route.params.name, route.params.namespace, { labels })
  newLabelKey.value = ''; newLabelValue.value = ''; showAddLabelModal.value = false
}
function deleteLabel(key) {
  const labels = { ...secret.value.labels }
  delete labels[key]
  store.updateSecret(route.params.name, route.params.namespace, { labels })
}
function startEditLabel(key) { editingLabel.value = key; editLabelValue.value = secret.value.labels[key] }
function saveEditLabel() {
  if (editingLabel.value === null) return
  const labels = { ...secret.value.labels }
  labels[editingLabel.value] = editLabelValue.value
  store.updateSecret(route.params.name, route.params.namespace, { labels })
  editingLabel.value = null
}

const typeBadge = computed(() => {
  const t = secret.value?.type || ''
  if (t.includes('tls')) return { color: 'bg-primary-container/10 text-primary border-primary/20', icon: 'lock' }
  if (t.includes('docker')) return { color: 'bg-secondary-container/10 text-secondary border-secondary/20', icon: 'key' }
  if (t.includes('service-account')) return { color: 'bg-tertiary-container/10 text-tertiary border-tertiary/20', icon: 'person' }
  return { color: 'bg-surface-container text-on-surface-variant border-outline-variant', icon: 'key' }
})

// Number of Workloads referencing this Secret
// P2-B：改 Vue Query workloads（旧读孤儿 store.workloadList 恒空 → 计数恒 0）；与 ResourceReferences 组件同 key 去重
const _workloadsQ = useResourceList({ key: ['cluster', cid, 'workloads'], fetcher: () => store.fetchWorkloads() })
const refCount = computed(() =>
  store.findResourceReferences(_workloadsQ.data.value || [], 'Secret', route.params.name, route.params.namespace).length
)
</script>

<template>
  <div class="animate-fade-in" v-if="secret">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Secrets', route: `/ns/${route.params.namespace}/secrets` },
      { label: route.params.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-tertiary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-tertiary text-3xl">key</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ secret.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 rounded-full text-label-caps font-medium border" :class="typeBadge.color">
              <span class="material-symbols-outlined text-xs align-middle mr-1">{{ typeBadge.icon }}</span>{{ secret.type }}
            </span>
            <span class="text-body-sm text-on-surface-variant">{{ $t('ns.secretDetail.keysCount', { n: secret.keys }) }}</span>
            <span class="text-body-sm text-on-surface-variant">{{ $t('ns.secretDetail.ageLabel', { age: secret.age }) }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> {{ $t('common.delete') }}
        </button>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors"
        :class="activeTab === tab.key ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab.label }}
        <span v-if="tab.key === 'references'" class="ml-xs px-1.5 py-0 rounded-full bg-primary-container/20 text-primary text-label-caps">{{ refCount }}</span>
      </button>
    </div>

    <!-- Data Tab -->
    <div v-if="activeTab === 'data'">
        <!-- 类型摘要卡 -->
        <div v-if="secretTemplateId !== 'opaque'" class="bg-primary-container/5 border border-primary/20 rounded-xl p-md mb-md flex items-center gap-md">
          <span class="material-symbols-outlined text-primary text-2xl">{{ secretTemplate?.icon }}</span>
          <div class="flex-1 min-w-0">
            <p class="text-body-sm font-semibold text-primary">{{ secretTemplate?.labelKey ? t(secretTemplate.labelKey) : '' }}</p>
            <!-- Docker: registry + username -->
            <div v-if="secretTemplateId === 'docker'" class="mt-xs flex flex-wrap gap-md text-body-sm text-on-surface-variant">
              <span v-for="reg in dockerRegistries" :key="reg.server"><span class="font-mono text-primary">{{ reg.server }}</span> · {{ reg.username }}</span>
            </div>
            <!-- TLS -->
            <p v-else-if="secretTemplateId === 'tls'" class="text-body-sm text-on-surface-variant mt-xs">{{ t('secret.templateTls') }}</p>
            <!-- SSH -->
            <p v-else-if="secretTemplateId === 'ssh'" class="text-body-sm text-on-surface-variant mt-xs">{{ t('secret.templateSsh', { known_hosts: secret.value?.data?.known_hosts } ) }}</p>
            <!-- Basic Auth -->
            <p v-else-if="secretTemplateId === 'basic-auth'" class="text-body-sm text-on-surface-variant mt-xs" v-html="t('secret.templateBasicAuth', { username: decode(secret.value?.data?.username) || '—' } )"></p>
            <!-- Git Token -->
            <p v-else-if="secretTemplateId === 'git-token'" class="text-body-sm text-on-surface-variant mt-xs">{{ $t('ns.secretDetail.gitTokenKey') }} <span class="font-mono text-primary">{{ Object.keys(secret.value?.data || {})[0] || '—' }}</span></p>
            <!-- AWS -->
            <p v-else-if="secretTemplateId === 'aws'" class="text-body-sm text-on-surface-variant mt-xs">{{ t('secret.templateAws') }}</p>
            <!-- DB -->
            <p v-else-if="secretTemplateId === 'db'" class="text-body-sm text-on-surface-variant mt-xs">{{ t('secret.templateDb', { count: dataEntries.length }) }}</p>
          </div>
        </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">{{ $t('ns.secretDetail.dataKeysCount', { n: dataEntries.length }) }}</h3>
          <button @click="showAddKeyModal = true" class="flex items-center gap-sm px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">
            <span class="material-symbols-outlined text-sm">add</span> {{ $t('common.addKey') }}
          </button>
        </div>
        <div class="divide-y divide-outline-variant/30">
          <div v-for="([key, val], idx) in dataEntries" :key="idx" class="px-lg py-md">
            <div class="flex items-center justify-between mb-sm">
              <div class="flex items-center gap-sm">
                <span class="font-mono text-code-sm text-primary font-semibold">{{ key }}</span>
                <button @click="toggleReveal(key)" class="p-xs text-on-surface-variant hover:text-primary rounded-lg" :title="revealedKeys.has(key) ? $t('ns.secretDetail.hide') : $t('ns.secretDetail.reveal')">
                  <span class="material-symbols-outlined text-lg">{{ revealedKeys.has(key) ? 'visibility_off' : 'visibility' }}</span>
                </button>
              </div>
              <div class="flex gap-xs">
                <button v-if="editingKey !== key" @click="startEdit(key)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg">
                  <span class="material-symbols-outlined text-lg">edit</span>
                </button>
                <button @click="deleteKey(key)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg">
                  <span class="material-symbols-outlined text-lg">delete</span>
                </button>
              </div>
            </div>
            <div v-if="editingKey === key" class="flex gap-sm">
              <input v-model="editValue" type="text" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
              <div class="flex gap-xs">
                <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">{{ $t('common.save') }}</button>
                <button @click="editingKey = null" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">{{ $t('common.cancel') }}</button>
              </div>
            </div>
            <div v-else class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm" :class="revealedKeys.has(key) ? 'text-on-surface' : 'text-on-surface-variant'">
              {{ revealedKeys.has(key) ? decode(val) : '••••••••••••••••' }}
            </div>
          </div>
          <div v-if="!dataEntries.length" class="px-lg py-xl text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-3xl">key</span>
            <p class="mt-sm">{{ $t('ns.secretDetail.noDataKeys') }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- References Tab -->
    <div v-if="activeTab === 'references'">
      <ResourceReferences kind="Secret" :name="route.params.name" />
    </div>

    <!-- Annotations Tab（可t('common.edit')）-->
    <div v-if="activeTab === 'annotations'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">{{ $t('ns.secretDetail.annotationsCount', { n: allAnnotations.length }) }}</h3>
          <button @click="showAddAnnModal = true" class="flex items-center gap-sm px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">
            <span class="material-symbols-outlined text-sm">add</span> {{ $t('ns.secretDetail.addAnnotation') }}
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
                <button @click="saveEditAnn" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">{{ $t('common.save') }}</button>
                <button @click="editingAnn = null" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">{{ $t('common.cancel') }}</button>
              </div>
            </div>
            <div v-else class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm text-on-surface-variant whitespace-pre-wrap break-all">{{ val }}</div>
          </div>
          <div v-if="!allAnnotations.length" class="px-lg py-xl text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-3xl">label</span>
            <p class="mt-sm">{{ $t('ns.secretDetail.noAnnotations') }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Labels Tab（可t('common.edit')）-->
    <div v-if="activeTab === 'labels'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">{{ $t('ns.secretDetail.labelsCount', { n: allLabels.length }) }}</h3>
          <button @click="showAddLabelModal = true" class="flex items-center gap-sm px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">
            <span class="material-symbols-outlined text-sm">add</span> {{ $t('ns.secretDetail.addLabel') }}
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
                <button @click="saveEditLabel" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">{{ $t('common.save') }}</button>
                <button @click="editingLabel = null" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">{{ $t('common.cancel') }}</button>
              </div>
            </div>
            <div v-else class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm text-on-surface-variant break-all">{{ val }}</div>
          </div>
          <div v-if="!allLabels.length" class="px-lg py-xl text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-3xl">label_off</span>
            <p class="mt-sm">{{ $t('ns.secretDetail.noLabels') }}</p>
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
    <h2 class="text-headline-md text-on-surface mt-md">{{ $t('common.notFound', { name: 'Secret' }) }}</h2>
    <button @click="router.push({ name: 'NsSecrets', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ $t('common.backTo', { name: 'Secrets' }) }}</button>
  </div>

  <Modal v-model="showDeleteModal" :title="$t('common.deleteTitle', { name: 'Secret' })" width="max-w-md">
    <p class="text-body-md text-on-surface-variant" v-html="$t('ns.secretDetail.deleteConfirm', { name: route.params.name })"></p>
    <p class="text-body-sm text-error mt-sm">{{ $t('ns.secretDetail.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('common.delete') }}</button>
    </template>
  </Modal>

  <Modal v-model="showAddKeyModal" :title="$t('ns.secretDetail.addDataKeyTitle')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.secretDetail.keyName') }}</label>
        <input v-model="newKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="SECRET_KEY" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.secretDetail.value') }}</label>
        <input v-model="newValue" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="secret value..." />
      </div>
    </div>
    <template #actions>
      <button @click="showAddKeyModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="addKey" :disabled="!newKey" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ $t('common.add') }}</button>
    </template>
  </Modal>

  <Modal v-model="showAddAnnModal" :title="$t('ns.secretDetail.addAnnotationTitle')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.secretDetail.annotationKey') }}</label>
        <input v-model="newAnnKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="kubectl.kubernetes.io/last-applied-configuration" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.secretDetail.value') }}</label>
        <textarea v-model="newAnnValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono h-20 resize-y focus:ring-2 focus:ring-primary" placeholder="{}"></textarea>
      </div>
    </div>
    <template #actions>
      <button @click="showAddAnnModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="addAnnotation" :disabled="!newAnnKey" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ $t('common.add') }}</button>
    </template>
  </Modal>

  <Modal v-model="showAddLabelModal" :title="$t('ns.secretDetail.addLabelTitle')" width="max-w-md">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.secretDetail.labelKey') }}</label>
        <input v-model="newLabelKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="app.kubernetes.io/name" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.secretDetail.value') }}</label>
        <input v-model="newLabelValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="my-app" />
      </div>
    </div>
    <template #actions>
      <button @click="showAddLabelModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="addLabel" :disabled="!newLabelKey" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ $t('common.add') }}</button>
    </template>
  </Modal>
</template>
