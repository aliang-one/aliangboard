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

// 搜索过滤
const search = ref('')
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return store.nsConfigMaps
  return store.nsConfigMaps.filter(cm => {
    if (cm.name.toLowerCase().includes(q)) return true
    return Object.keys(cm.data || {}).some(k => k.toLowerCase().includes(q))
  })
})

// Create ConfigMap
const showCreateModal = ref(false)
const createForm = ref({ name: '', keys: [{ key: '', value: '' }] })

function resetCreate() {
  createForm.value = { name: '', keys: [{ key: '', value: '' }] }
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
  store.addConfigMap({
    name: f.name,
    namespace: route.params.namespace,
    keys: Object.keys(data).length,
    data,
  })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(cm) {
  deleteTarget.value = cm
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteConfigMap(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

// 批量选择
const selected = ref(new Set())
function toggleSelect(name) {
  const s = new Set(selected.value)
  if (s.has(name)) s.delete(name); else s.add(name)
  selected.value = s
}
const isAllSelected = computed(() => filtered.value.length > 0 && filtered.value.every(r => selected.value.has(r.name)))
function toggleSelectAll() {
  selected.value = isAllSelected.value ? new Set() : new Set(filtered.value.map(r => r.name))
}
const showBatchModal = ref(false)
function confirmBatchDelete() { if (selected.value.size) showBatchModal.value = true }
function handleBatchDelete() {
  selected.value.forEach(name => store.deleteConfigMap(name, route.params.namespace))
  selected.value = new Set()
  showBatchModal.value = false
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'ConfigMaps' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">ConfigMaps</h2>
        <p class="text-on-surface-variant text-body-md mt-1">{{ store.nsConfigMaps.length }} ConfigMaps in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
        <span class="material-symbols-outlined">add</span> New ConfigMap
      </button>
    </div>

    <!-- 搜索框 -->
    <div class="flex items-center gap-md mb-lg">
      <div class="relative flex-1 max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="search" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary" placeholder="按名称或数据 key 搜索..." />
        <button v-if="search" @click="search = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface">
          <span class="material-symbols-outlined text-lg">close</span>
        </button>
      </div>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ store.nsConfigMaps.length }}</span>
      <div v-if="selected.size" class="flex items-center gap-sm ml-auto px-md py-xs bg-primary-container/10 border border-primary/20 rounded-lg">
        <span class="text-body-sm font-medium text-primary">已选 {{ selected.size }} 项</span>
        <button @click="confirmBatchDelete" class="flex items-center gap-xs px-sm py-xs bg-error text-on-error rounded text-body-sm font-semibold hover:opacity-90">
          <span class="material-symbols-outlined text-sm">delete</span>批量删除
        </button>
        <button @click="selected = new Set()" class="text-body-sm text-on-surface-variant hover:text-on-surface">取消</button>
      </div>
    </div>

    <div v-if="filtered.length" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md w-10">
              <input type="checkbox" :checked="isAllSelected" @change="toggleSelectAll" class="rounded text-primary focus:ring-primary h-4 w-4" />
            </th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Data Keys</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Preview</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-24">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr v-for="row in filtered" :key="row.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="router.push({ name: 'NsConfigMapDetail', params: { namespace: route.params.namespace, name: row.name } })">
            <td class="px-lg py-md" @click.stop>
              <input type="checkbox" :checked="selected.has(row.name)" @change="toggleSelect(row.name)" class="rounded text-primary focus:ring-primary h-4 w-4" />
            </td>
            <td class="px-lg py-md">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary text-lg">description</span>
                <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
              </div>
            </td>
            <td class="px-lg py-md"><span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-surface-container text-body-sm font-bold text-on-surface-variant border border-outline-variant">{{ row.keys }}</span></td>
            <td class="px-lg py-md">
              <div class="flex flex-wrap gap-xs max-w-xs">
                <span v-for="k in Object.keys(row.data || {}).slice(0, 4)" :key="k" class="px-1.5 py-0.5 bg-primary-container/10 text-primary text-label-caps rounded">{{ k }}</span>
                <span v-if="Object.keys(row.data || {}).length > 4" class="text-label-caps text-on-surface-variant">+{{ Object.keys(row.data).length - 4 }}</span>
              </div>
            </td>
            <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-lg py-md" @click.stop>
              <div class="flex gap-1">
                <button @click="router.push({ name: 'NsConfigMapDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-lg">open_in_new</span></button>
                <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">{{ search ? 'search_off' : 'description' }}</span>
      <p class="text-on-surface-variant mt-md">{{ search ? `没有匹配 "${search}" 的 ConfigMap` : 'No ConfigMaps in this namespace' }}</p>
      <button v-if="search" @click="search = ''" class="mt-md px-md py-sm border border-outline-variant rounded-lg text-body-sm font-medium hover:bg-surface-container-high">清除搜索</button>
      <button v-else @click="showCreateModal = true" class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">Create ConfigMap</button>
    </div>
  </section>

  <!-- Create ConfigMap Modal -->
  <Modal v-model="showCreateModal" title="Create ConfigMap" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">ConfigMap Name *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-config" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-sm">Data Keys</label>
        <div class="flex flex-col gap-sm">
          <div v-for="(kv, idx) in createForm.keys" :key="idx" class="flex gap-sm items-center">
            <input v-model="kv.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="KEY" />
            <input v-model="kv.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="value" />
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
  <Modal v-model="showDeleteModal" title="Delete ConfigMap" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete ConfigMap <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Pods using this ConfigMap may fail. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- Batch Delete Modal -->
  <Modal v-model="showBatchModal" title="批量删除 ConfigMap" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">确定要删除选中的 <span class="text-on-surface font-semibold">{{ selected.size }}</span> 个 ConfigMap 吗？</p>
    <p class="text-body-sm text-error mt-sm">引用这些 ConfigMap 的 Pod 可能受影响。此操作不可撤销。</p>
    <template #actions>
      <button @click="showBatchModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
      <button @click="handleBatchDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">全部删除</button>
    </template>
  </Modal>
</template>
