<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import ResourceReferences from '@/components/common/ResourceReferences.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const secret = computed(() => store.getSecretByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('secret', secret.value))

const activeTab = ref('data')
const showDeleteModal = ref(false)
const showAddKeyModal = ref(false)
const newKey = ref('')
const newValue = ref('')
const editingKey = ref(null)
const editValue = ref('')
const revealedKeys = ref(new Set())

const dataEntries = computed(() => {
  if (!secret.value?.data) return []
  return Object.entries(secret.value.data)
})

function toggleReveal(key) {
  const s = new Set(revealedKeys.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  revealedKeys.value = s
}

function handleDelete() {
  store.deleteSecret(route.params.name, route.params.namespace)
  router.push({ name: 'NsSecrets', params: { namespace: route.params.namespace } })
}

function addKey() {
  if (!newKey.value) return
  const data = { ...(secret.value.data || {}) }
  data[newKey.value] = newValue.value
  store.updateSecret(route.params.name, route.params.namespace, { data, keys: Object.keys(data).length })
  newKey.value = ''
  newValue.value = ''
  showAddKeyModal.value = false
}

function startEdit(key) {
  editingKey.value = key
  editValue.value = secret.value.data[key]
}

function saveEdit() {
  if (editingKey.value === null) return
  const data = { ...secret.value.data }
  data[editingKey.value] = editValue.value
  store.updateSecret(route.params.name, route.params.namespace, { data })
  editingKey.value = null
  editValue.value = ''
}

function deleteKey(key) {
  const data = { ...secret.value.data }
  delete data[key]
  store.updateSecret(route.params.name, route.params.namespace, { data, keys: Object.keys(data).length })
}

const typeBadge = computed(() => {
  const t = secret.value?.type || ''
  if (t.includes('tls')) return { color: 'bg-primary-container/10 text-primary border-primary/20', icon: 'lock' }
  if (t.includes('docker')) return { color: 'bg-secondary-container/10 text-secondary border-secondary/20', icon: 'key' }
  if (t.includes('service-account')) return { color: 'bg-tertiary-container/10 text-tertiary border-tertiary/20', icon: 'person' }
  return { color: 'bg-surface-container text-on-surface-variant border-outline-variant', icon: 'key' }
})

// 引用此 Secret 的 Workload 数量
const refCount = computed(() =>
  store.getResourceReferences('Secret', route.params.name, route.params.namespace).length
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
            <span class="text-body-sm text-on-surface-variant">{{ secret.keys }} keys</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ secret.age }}</span>
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
      <button v-for="tab in ['data', 'references', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
        <span v-if="tab === 'references'" class="ml-xs px-1.5 py-0 rounded-full bg-primary-container/20 text-primary text-label-caps">{{ refCount }}</span>
      </button>
    </div>

    <!-- Data Tab -->
    <div v-if="activeTab === 'data'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Data Keys ({{ dataEntries.length }})</h3>
          <button @click="showAddKeyModal = true" class="flex items-center gap-sm px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">
            <span class="material-symbols-outlined text-sm">add</span> Add Key
          </button>
        </div>
        <div class="divide-y divide-outline-variant/30">
          <div v-for="([key, val], idx) in dataEntries" :key="idx" class="px-lg py-md">
            <div class="flex items-center justify-between mb-sm">
              <div class="flex items-center gap-sm">
                <span class="font-mono text-code-md text-primary font-semibold">{{ key }}</span>
                <button @click="toggleReveal(key)" class="p-xs text-on-surface-variant hover:text-primary rounded-lg" :title="revealedKeys.has(key) ? 'Hide' : 'Reveal'">
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
                <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">Save</button>
                <button @click="editingKey = null" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">Cancel</button>
              </div>
            </div>
            <div v-else class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm" :class="revealedKeys.has(key) ? 'text-on-surface' : 'text-on-surface-variant'">
              {{ revealedKeys.has(key) ? val : '••••••••••••••••' }}
            </div>
          </div>
          <div v-if="!dataEntries.length" class="px-lg py-xl text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-3xl">key</span>
            <p class="mt-sm">No data keys</p>
          </div>
        </div>
      </div>
    </div>

    <!-- References Tab -->
    <div v-if="activeTab === 'references'">
      <ResourceReferences kind="Secret" :name="route.params.name" />
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="() => {}" />
    </div>
  </div>
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">Secret Not Found</h2>
    <button @click="router.push({ name: 'NsSecrets', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Secrets</button>
  </div>

  <Modal v-model="showDeleteModal" title="Delete Secret" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete secret <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Pods using this Secret will fail to start. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <Modal v-model="showAddKeyModal" title="Add Data Key" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Key Name</label>
        <input v-model="newKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="SECRET_KEY" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Value</label>
        <input v-model="newValue" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="secret value..." />
      </div>
    </div>
    <template #actions>
      <button @click="showAddKeyModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="addKey" :disabled="!newKey" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Add</button>
    </template>
  </Modal>
</template>
