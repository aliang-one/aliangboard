<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const typeFilter = ref('All')
const typeOptions = computed(() => {
  const types = new Set(store.nsSecrets.map(s => s.type))
  return ['All', ...types]
})

const filtered = computed(() => {
  if (typeFilter.value === 'All') return store.nsSecrets
  return store.nsSecrets.filter(s => s.type === typeFilter.value)
})

// Create Secret
const showCreateModal = ref(false)
const createForm = ref({ name: '', type: 'Opaque', keys: [{ key: '', value: '' }] })

function resetCreate() {
  createForm.value = { name: '', type: 'Opaque', keys: [{ key: '', value: '' }] }
}
function addCreateKey() {
  createForm.value.keys.push({ key: '', value: '' })
}
function removeCreateKey(idx) {
  createForm.value.keys.splice(idx, 1)
}

function handleCreate() {
  const f = createForm.value
  const data = {}
  f.keys.forEach(k => { if (k.key) data[k.key] = k.value })
  store.addSecret({
    name: f.name,
    namespace: route.params.namespace,
    type: f.type,
    keys: Object.keys(data).length,
    data,
  })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(sec) {
  deleteTarget.value = sec
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteSecret(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

const typeColor = (type) => {
  if (type.includes('tls')) return 'bg-primary-container/10 text-primary border-primary/20'
  if (type.includes('docker')) return 'bg-secondary-container/10 text-secondary border-secondary/20'
  if (type.includes('service-account')) return 'bg-tertiary-container/10 text-tertiary border-tertiary/20'
  return 'bg-surface-container text-on-surface-variant border-outline-variant'
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Secrets' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Secrets</h2>
        <p class="text-on-surface-variant text-body-md mt-1">{{ store.nsSecrets.length }} secrets in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
        <span class="material-symbols-outlined">add</span> New Secret
      </button>
    </div>

    <!-- Type Filter -->
    <div class="flex flex-wrap gap-xs mb-lg">
      <button v-for="opt in typeOptions" :key="opt" @click="typeFilter = opt"
        class="px-md py-xs rounded-full text-body-sm font-medium border transition-all"
        :class="typeFilter === opt ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:border-primary'">
        {{ opt }}
      </button>
    </div>

    <div v-if="filtered.length" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Type</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Keys</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Data Preview</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-24">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr v-for="row in filtered" :key="row.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="router.push({ name: 'NsSecretDetail', params: { namespace: route.params.namespace, name: row.name } })">
            <td class="px-lg py-md">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-tertiary text-lg">key</span>
                <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
              </div>
            </td>
            <td class="px-lg py-md">
              <span class="px-2 py-0.5 rounded text-body-sm border" :class="typeColor(row.type)">{{ row.type }}</span>
            </td>
            <td class="px-lg py-md"><span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-surface-container text-body-sm font-bold text-on-surface-variant border border-outline-variant">{{ row.keys }}</span></td>
            <td class="px-lg py-md">
              <div class="flex flex-wrap gap-xs max-w-xs">
                <span v-for="k in Object.keys(row.data || {}).slice(0, 3)" :key="k" class="px-1.5 py-0.5 bg-surface-container text-label-caps text-on-surface-variant rounded border border-outline-variant">{{ k }}</span>
                <span v-if="Object.keys(row.data || {}).length > 3" class="text-label-caps text-on-surface-variant">+{{ Object.keys(row.data).length - 3 }}</span>
              </div>
            </td>
            <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-lg py-md" @click.stop>
              <div class="flex gap-1">
                <button @click="router.push({ name: 'NsSecretDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-lg">open_in_new</span></button>
                <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">key</span>
      <p class="text-on-surface-variant mt-md">No secrets in this namespace</p>
      <button @click="showCreateModal = true" class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">Create Secret</button>
    </div>
  </section>

  <!-- Create Secret Modal -->
  <Modal v-model="showCreateModal" title="Create Secret" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Secret Name *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-secret" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Type</label>
        <select v-model="createForm.type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
          <option>Opaque</option>
          <option>kubernetes.io/tls</option>
          <option>kubernetes.io/dockerconfigjson</option>
          <option>kubernetes.io/basic-auth</option>
          <option>kubernetes.io/ssh-auth</option>
        </select>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-sm">Data Keys</label>
        <div class="flex flex-col gap-sm">
          <div v-for="(kv, idx) in createForm.keys" :key="idx" class="flex gap-sm items-center">
            <input v-model="kv.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="KEY" />
            <input v-model="kv.value" type="password" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="value" />
            <button v-if="createForm.keys.length > 1" @click="removeCreateKey(idx)" class="p-xs text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
          </div>
          <button @click="addCreateKey" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined">add</span> Add Key
          </button>
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleCreate" :disabled="!createForm.name" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete Secret" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete secret <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Pods using this Secret will fail. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
