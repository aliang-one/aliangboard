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

const search = ref('')

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return store.nsPDBs
  return store.nsPDBs.filter(p => p.name.toLowerCase().includes(q))
})

// Create PDB
const showCreateModal = ref(false)
const createForm = ref({
  name: '',
  selectorApp: '',
  constraintType: 'minAvailable', // 'minAvailable' | 'maxUnavailable'
  minAvailable: '',
  maxUnavailable: '',
  desiredHealthy: '',
})

function resetCreate() {
  createForm.value = {
    name: '',
    selectorApp: '',
    constraintType: 'minAvailable',
    minAvailable: '',
    maxUnavailable: '',
    desiredHealthy: '',
  }
}

function handleCreate() {
  const f = createForm.value
  const minAvailable = f.constraintType === 'minAvailable' ? String(f.minAvailable) : ''
  const maxUnavailable = f.constraintType === 'maxUnavailable' ? String(f.maxUnavailable) : ''
  const desiredHealthy = Number(f.desiredHealthy) || 0
  store.addPDB({
    name: f.name,
    namespace: route.params.namespace,
    minAvailable,
    maxUnavailable,
    selector: { app: f.selectorApp },
    allowedDisruptions: 0,
    currentHealthy: desiredHealthy,
    desiredHealthy,
    age: 'Just now',
  })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(pdb) {
  deleteTarget.value = pdb
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deletePDB(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

// Helpers
const selectorEntries = (sel) => sel ? Object.entries(sel) : []

const allowedBadgeClass = (n) => {
  if (n > 0) return 'bg-primary-container/20 text-primary border-primary/20'
  return 'bg-error-container/20 text-error border-error/20'
}

const isHealthy = (row) => row.currentHealthy >= row.desiredHealthy
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'PodDisruptionBudgets' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">中断预算 (PDBs)</h2>
        <p class="text-on-surface-variant text-body-md mt-1">
          {{ store.nsPDBs.length }} 个 PodDisruptionBudget · 保证自愿驱逐时最小可用副本数
        </p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
        <span class="material-symbols-outlined">add</span> New PDB
      </button>
    </div>

    <!-- Search -->
    <div class="flex flex-wrap items-center gap-md mb-lg">
      <div class="relative flex-1 min-w-[200px] max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="search" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary" placeholder="按名称搜索 PDB..." />
        <button v-if="search" @click="search = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface">
          <span class="material-symbols-outlined text-lg">close</span>
        </button>
      </div>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ store.nsPDBs.length }}</span>
    </div>

    <div v-if="filtered.length" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Selector</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Budget</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Allowed Disruptions</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Healthy</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-24">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr v-for="row in filtered" :key="row.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="router.push({ name: 'NsPDBDetail', params: { namespace: route.params.namespace, name: row.name } })">
            <td class="px-lg py-md">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-primary text-lg">shield</span>
                <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
              </div>
            </td>
            <td class="px-lg py-md">
              <div class="flex flex-wrap gap-xs max-w-xs">
                <span v-for="([k, v]) in selectorEntries(row.selector)" :key="k" class="px-1.5 py-0.5 bg-surface-container text-label-caps text-on-surface-variant rounded border border-outline-variant font-mono">
                  {{ k }}={{ v }}
                </span>
              </div>
            </td>
            <td class="px-lg py-md">
              <div class="flex flex-col">
                <span v-if="row.minAvailable" class="text-body-sm text-on-surface font-mono">
                  <span class="text-on-surface-variant">minAvailable:</span> {{ row.minAvailable }}
                </span>
                <span v-else-if="row.maxUnavailable" class="text-body-sm text-on-surface font-mono">
                  <span class="text-on-surface-variant">maxUnavailable:</span> {{ row.maxUnavailable }}
                </span>
                <span v-else class="text-body-sm text-on-surface-variant">—</span>
              </div>
            </td>
            <td class="px-lg py-md">
              <span class="inline-flex items-center justify-center min-w-[2rem] px-2 py-0.5 rounded-full text-body-sm font-bold border" :class="allowedBadgeClass(row.allowedDisruptions)">
                {{ row.allowedDisruptions }}
              </span>
            </td>
            <td class="px-lg py-md">
              <div class="flex items-center gap-xs">
                <span class="text-body-sm font-mono font-semibold" :class="isHealthy(row) ? 'text-on-surface' : 'text-error'">{{ row.currentHealthy }}</span>
                <span class="text-on-surface-variant text-body-sm">/</span>
                <span class="text-body-sm font-mono text-on-surface-variant">{{ row.desiredHealthy }}</span>
                <span v-if="!isHealthy(row)" class="material-symbols-outlined text-error text-base" title="不健康">warning</span>
              </div>
            </td>
            <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-lg py-md" @click.stop>
              <div class="flex gap-1">
                <button @click="router.push({ name: 'NsPDBDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg">
                  <span class="material-symbols-outlined text-lg">open_in_new</span>
                </button>
                <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg">
                  <span class="material-symbols-outlined text-lg">delete</span>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">{{ search ? 'search_off' : 'shield' }}</span>
      <p class="text-on-surface-variant mt-md">{{ search ? '没有匹配的 PodDisruptionBudget' : '当前命名空间暂无 PodDisruptionBudget' }}</p>
      <button v-if="search" @click="search = ''" class="mt-md px-md py-sm border border-outline-variant rounded-lg text-body-sm font-medium hover:bg-surface-container-high">清除筛选</button>
      <button v-else @click="showCreateModal = true" class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">Create PDB</button>
    </div>
  </section>

  <!-- Create PDB Modal -->
  <Modal v-model="showCreateModal" title="Create PodDisruptionBudget" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">PDB Name *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="api-gateway-pdb" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Selector (app label) *</label>
        <div class="flex items-center gap-sm">
          <span class="font-mono text-on-surface-variant text-body-md">app=</span>
          <input v-model="createForm.selectorApp" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="api-gateway" />
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">约束类型 (二选一) *</label>
        <div class="flex gap-md">
          <label class="flex items-center gap-xs cursor-pointer">
            <input type="radio" v-model="createForm.constraintType" value="minAvailable" class="text-primary focus:ring-primary" />
            <span class="text-body-md text-on-surface">minAvailable</span>
          </label>
          <label class="flex items-center gap-xs cursor-pointer">
            <input type="radio" v-model="createForm.constraintType" value="maxUnavailable" class="text-primary focus:ring-primary" />
            <span class="text-body-md text-on-surface">maxUnavailable</span>
          </label>
        </div>
        <div class="mt-sm">
          <input v-if="createForm.constraintType === 'minAvailable'" v-model="createForm.minAvailable" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="最小可用副本数 (如 2 或 50%)" />
          <input v-else v-model="createForm.maxUnavailable" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="最大不可用副本数 (如 1 或 25%)" />
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Desired Healthy</label>
        <input v-model="createForm.desiredHealthy" type="number" min="0" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="期望健康副本数 (如 3)" />
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleCreate" :disabled="!createForm.name || !createForm.selectorApp || (createForm.constraintType === 'minAvailable' ? !createForm.minAvailable : !createForm.maxUnavailable)" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete PodDisruptionBudget" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete PDB <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">删除后，受其保护的工作负载在节点驱逐时将不再有可用性保证。此操作不可撤销。</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
