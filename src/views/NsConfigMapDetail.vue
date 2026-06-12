<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const cm = computed(() => store.getConfigMapByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('configmap', cm.value))

const activeTab = ref('data')
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

function handleDelete() {
  store.deleteConfigMap(route.params.name, route.params.namespace)
  router.push({ name: 'NsConfigMaps', params: { namespace: route.params.namespace } })
}

function addKey() {
  if (!newKey.value) return
  const data = { ...(cm.value.data || {}) }
  data[newKey.value] = newValue.value
  store.updateConfigMap(route.params.name, route.params.namespace, { data, keys: Object.keys(data).length })
  newKey.value = ''
  newValue.value = ''
  showAddKeyModal.value = false
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
      <button v-for="tab in ['data', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
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
              <span class="font-mono text-code-md text-primary font-semibold">{{ key }}</span>
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
              <textarea v-model="editValue" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono min-h-[80px] resize-y focus:ring-2 focus:ring-primary focus:border-primary"></textarea>
              <div class="flex flex-col gap-xs">
                <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">Save</button>
                <button @click="editingKey = null" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">Cancel</button>
              </div>
            </div>
            <div v-else class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm text-on-surface-variant whitespace-pre-wrap max-h-40 overflow-auto">{{ val }}</div>
          </div>
          <div v-if="!dataEntries.length" class="px-lg py-xl text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-3xl">description</span>
            <p class="mt-sm">No data keys</p>
          </div>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="() => {}" />
    </div>
  </div>
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">ConfigMap Not Found</h2>
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
</template>
