<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const ing = computed(() => store.getIngressByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('ingress', ing.value))

const activeTab = ref('overview')
const showDeleteModal = ref(false)

async function handleDelete() {
  await store.deleteIngress(route.params.name, route.params.namespace)
  router.push({ name: 'NsIngress', params: { namespace: route.params.namespace } })
}

const allRules = computed(() => {
  if (!ing.value?.rules) return []
  return ing.value.rules.flatMap(r =>
    (r.http?.paths || []).map(p => {
      const svc = p.backend?.service || p.backend
      return {
        host: r.host,
        path: p.path,
        pathType: p.pathType,
        serviceName: svc?.name ?? svc?.serviceName ?? '',
        servicePort: svc?.port?.number ?? svc?.port?.name ?? svc?.servicePort ?? '',
      }
    })
  )
})

// === Rules 结构化编辑（远端 PATCH spec.rules）===
const showRulesModal = ref(false)
const editRules = ref([])
const pathTypeOptions = ['Prefix', 'Exact', 'ImplementationSpecific']
function openRulesEditor() {
  editRules.value = allRules.value.map(r => ({ ...r, servicePort: String(r.servicePort ?? '') }))
  if (!editRules.value.length) editRules.value = [{ host: '', path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }]
  showRulesModal.value = true
}
function addRule() {
  editRules.value.push({ host: '', path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' })
}
function removeRule(idx) {
  editRules.value.splice(idx, 1)
}
async function saveRules() {
  try {
    await store.updateIngressRules(route.params.name, route.params.namespace, editRules.value)
    showRulesModal.value = false
  } catch (e) {
    notify('error', e.message || '保存规则失败')
  }
}

// === IngressClass / TLS 编辑（远端 regenerate + apply）===
const showClassModal = ref(false)
const editClassName = ref('')
function openClassEditor() { editClassName.value = ing.value?.className || ''; showClassModal.value = true }
function saveClassName() {
  store.updateIngress(route.params.name, route.params.namespace, { className: editClassName.value })
  showClassModal.value = false
}
const showTlsModal = ref(false)
const editTls = ref(false)
const editTlsSecret = ref('')
function openTlsEditor() { editTls.value = ing.value?.tls || false; editTlsSecret.value = ing.value?.tlsSecret || ''; showTlsModal.value = true }
function saveTls() {
  store.updateIngress(route.params.name, route.params.namespace, { tls: editTls.value, tlsSecret: editTlsSecret.value })
  showTlsModal.value = false
}

const allAnnotations = computed(() => {
  if (!ing.value?.annotations) return []
  return Object.entries(ing.value.annotations)
})

const allLabels = computed(() => {
  if (!ing.value?.labels) return []
  return Object.entries(ing.value.labels)
})

// === Annotations 编辑 ===
const showAddAnnModal = ref(false)
const newAnnKey = ref('')
const newAnnValue = ref('')
const editingAnn = ref(null)
const editAnnValue = ref('')

function addAnnotation() {
  if (!newAnnKey.value) return
  const annotations = { ...(ing.value.annotations || {}) }
  annotations[newAnnKey.value] = newAnnValue.value
  store.updateIngress(route.params.name, route.params.namespace, { annotations })
  newAnnKey.value = ''
  newAnnValue.value = ''
  showAddAnnModal.value = false
}
function deleteAnnotation(key) {
  const annotations = { ...ing.value.annotations }
  delete annotations[key]
  store.updateIngress(route.params.name, route.params.namespace, { annotations })
}
function startEditAnn(key) { editingAnn.value = key; editAnnValue.value = ing.value.annotations[key] }
function saveEditAnn() {
  if (editingAnn.value === null) return
  const annotations = { ...ing.value.annotations }
  annotations[editingAnn.value] = editAnnValue.value
  store.updateIngress(route.params.name, route.params.namespace, { annotations })
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
  const labels = { ...(ing.value.labels || {}) }
  labels[newLabelKey.value] = newLabelValue.value
  store.updateIngress(route.params.name, route.params.namespace, { labels })
  newLabelKey.value = ''
  newLabelValue.value = ''
  showAddLabelModal.value = false
}
function deleteLabel(key) {
  const labels = { ...ing.value.labels }
  delete labels[key]
  store.updateIngress(route.params.name, route.params.namespace, { labels })
}
function startEditLabel(key) { editingLabel.value = key; editLabelValue.value = ing.value.labels[key] }
function saveEditLabel() {
  if (editingLabel.value === null) return
  const labels = { ...ing.value.labels }
  labels[editingLabel.value] = editLabelValue.value
  store.updateIngress(route.params.name, route.params.namespace, { labels })
  editingLabel.value = null
}
</script>

<template>
  <div class="animate-fade-in" v-if="ing">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Ingress', route: `/ns/${route.params.namespace}/ingress` },
      { label: route.params.name }
    ]" />

    <!-- Header -->
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">language</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ ing.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-primary-container/10 text-primary text-label-caps rounded-full font-medium">Ingress</span>
            <span class="flex items-center gap-xs text-body-sm" :class="ing.tls ? 'text-primary' : 'text-on-surface-variant'">
              <span class="material-symbols-outlined text-lg">{{ ing.tls ? 'lock' : 'lock_open' }}</span>
              {{ ing.tls ? 'TLS Enabled' : 'No TLS' }}
            </span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ ing.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'rules', 'annotations', 'labels', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Ingress Details</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Hosts</p>
              <p class="font-mono text-code-md text-primary font-semibold">{{ ing.hosts }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <div class="flex items-center justify-between mb-xs">
                <p class="text-label-caps text-on-surface-variant">Ingress Class</p>
                <button @click="openClassEditor" class="p-0.5 text-on-surface-variant hover:text-primary rounded" title="编辑 IngressClass"><span class="material-symbols-outlined text-base">edit</span></button>
              </div>
              <p class="text-body-md text-on-surface">{{ ing.className || '（默认）' }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <div class="flex items-center justify-between mb-xs">
                <p class="text-label-caps text-on-surface-variant">TLS</p>
                <button @click="openTlsEditor" class="p-0.5 text-on-surface-variant hover:text-primary rounded" title="编辑 TLS"><span class="material-symbols-outlined text-base">edit</span></button>
              </div>
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-lg" :class="ing.tls ? 'text-primary' : 'text-on-surface-variant'">{{ ing.tls ? 'lock' : 'lock_open' }}</span>
                <span class="text-body-md" :class="ing.tls ? 'text-primary font-semibold' : 'text-on-surface-variant'">{{ ing.tls ? 'Enabled' : 'Disabled' }}</span>
              </div>
            </div>
            <div v-if="ing.tlsSecret" class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">TLS Secret</p>
              <p class="font-mono text-code-sm text-on-surface">{{ ing.tlsSecret }}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="lg:col-span-4">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Summary</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Rules</span>
              <span class="text-body-md font-semibold text-primary">{{ allRules.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Annotations</span>
              <span class="text-body-md font-semibold text-on-surface">{{ allAnnotations.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Age</span>
              <span class="text-body-md text-on-surface">{{ ing.age }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Rules Tab -->
    <div v-if="activeTab === 'rules'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Routing Rules ({{ allRules.length }})</h3>
          <button @click="openRulesEditor" class="flex items-center gap-sm px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">
            <span class="material-symbols-outlined text-sm">edit</span> Edit Rules
          </button>
        </div>
        <table v-if="allRules.length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Host</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Path</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Path Type</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Backend Service</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Port</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="(rule, idx) in allRules" :key="idx" class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md"><span class="font-mono text-code-sm text-primary font-semibold">{{ rule.host }}</span></td>
              <td class="px-lg py-md"><span class="font-mono text-code-sm">{{ rule.path }}</span></td>
              <td class="px-lg py-md"><span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">{{ rule.pathType }}</span></td>
              <td class="px-lg py-md">
                <span class="font-mono text-code-sm text-secondary font-medium cursor-pointer hover:text-primary" @click="router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: rule.serviceName } })">{{ rule.serviceName }}</span>
              </td>
              <td class="px-lg py-md font-mono text-code-sm">{{ rule.servicePort }}</td>
            </tr>
          </tbody>
        </table>
      </div>
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
              <span class="font-mono text-code-md text-primary font-semibold break-all">{{ key }}</span>
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
              <span class="font-mono text-code-md text-secondary font-semibold break-all">{{ key }}</span>
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
    <h2 class="text-headline-lg text-on-surface mt-md">Ingress Not Found</h2>
    <button @click="router.push({ name: 'NsIngress', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Ingress</button>
  </div>

  <!-- Add Annotation Modal -->
  <Modal v-model="showAddAnnModal" title="Add Annotation" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Annotation Key</label>
        <input v-model="newAnnKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="nginx.ingress.kubernetes.io/rewrite-target" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Value</label>
        <textarea v-model="newAnnValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono h-20 resize-y focus:ring-2 focus:ring-primary" placeholder="/"></textarea>
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

  <!-- Edit Rules Modal -->
  <Modal v-model="showRulesModal" title="Edit Routing Rules" width="max-w-4xl">
    <p class="text-body-sm text-on-surface-variant mb-md">编辑路由规则，保存后写回 Ingress <span class="font-mono">{{ route.params.name }}</span>（等同 <code class="font-mono text-code-sm bg-surface-container-low px-1 rounded">kubectl patch ingress</code>）。</p>
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-md py-sm text-label-caps text-on-surface-variant">Host</th>
            <th class="px-md py-sm text-label-caps text-on-surface-variant">Path</th>
            <th class="px-md py-sm text-label-caps text-on-surface-variant">Type</th>
            <th class="px-md py-sm text-label-caps text-on-surface-variant">Service</th>
            <th class="px-md py-sm text-label-caps text-on-surface-variant">Port</th>
            <th class="px-md py-sm w-10"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr v-for="(r, idx) in editRules" :key="idx">
            <td class="px-md py-sm"><input v-model="r.host" class="w-40 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="app.example.com" /></td>
            <td class="px-md py-sm"><input v-model="r.path" class="w-28 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="/" /></td>
            <td class="px-md py-sm">
              <select v-model="r.pathType" class="bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm">
                <option v-for="t in pathTypeOptions" :key="t" :value="t">{{ t }}</option>
              </select>
            </td>
            <td class="px-md py-sm"><input v-model="r.serviceName" class="w-32 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="my-svc" /></td>
            <td class="px-md py-sm"><input v-model="r.servicePort" class="w-20 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="80" /></td>
            <td class="px-md py-sm text-center">
              <button @click="removeRule(idx)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded" title="删除该规则"><span class="material-symbols-outlined text-lg">delete</span></button>
            </td>
          </tr>
          <tr v-if="!editRules.length"><td colspan="6" class="px-md py-md text-center text-on-surface-variant text-body-sm">无规则</td></tr>
        </tbody>
      </table>
    </div>
    <button @click="addRule" class="mt-md flex items-center gap-xs px-md py-xs border border-dashed border-outline-variant rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container-low">
      <span class="material-symbols-outlined text-sm">add</span> Add Rule
    </button>
    <template #actions>
      <button @click="showRulesModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveRules" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Save Rules</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete Ingress" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete ingress <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This will remove all routing rules. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- IngressClass 编辑 -->
  <Modal v-model="showClassModal" title="编辑 IngressClass" width="max-w-md">
    <p class="text-body-sm text-on-surface-variant mb-sm">选择该 Ingress 使用的 IngressClass（留空则由集群默认类接管）。</p>
    <select v-model="editClassName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
      <option value="">（默认，不指定）</option>
      <option v-for="c in store.ingressClassList" :key="c.name" :value="c.name">{{ c.name }}{{ c.isDefault ? '（默认）' : '' }}</option>
    </select>
    <template #actions>
      <button @click="showClassModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
      <button @click="saveClassName" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">保存</button>
    </template>
  </Modal>

  <!-- TLS 编辑 -->
  <Modal v-model="showTlsModal" title="编辑 TLS" width="max-w-md">
    <label class="flex items-center gap-sm mb-md cursor-pointer">
      <input v-model="editTls" type="checkbox" class="h-4 w-4 accent-primary" />
      <span class="text-body-md text-on-surface">启用 TLS（spec.tls）</span>
    </label>
    <div v-if="editTls">
      <label class="text-label-caps text-on-surface-variant block mb-xs">TLS Secret 名称（含证书的 TLS Secret）</label>
      <input v-model="editTlsSecret" list="ing-tls-secrets" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="my-tls-secret" />
      <datalist id="ing-tls-secrets">
        <option v-for="s in store.nsSecrets.filter(x => x.type === 'kubernetes.io/tls')" :key="s.name" :value="s.name" />
      </datalist>
      <p class="text-body-xs text-on-surface-variant mt-xs">TLS hosts 取自当前 rules 的 host；Secret 需为 <code>kubernetes.io/tls</code> 类型。</p>
    </div>
    <template #actions>
      <button @click="showTlsModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
      <button @click="saveTls" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">保存</button>
    </template>
  </Modal>
</template>
