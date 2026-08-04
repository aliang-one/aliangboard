<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const pdb = computed(() => store.getPDBByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateExtraYAML('pdb', pdb.value))

const activeTab = ref('overview')
const showDeleteModal = ref(false)
const showEditModal = ref(false)

const isHealthy = computed(() => {
  if (!pdb.value) return false
  return pdb.value.currentHealthy >= pdb.value.desiredHealthy
})

const selectorEntries = computed(() => pdb.value?.selector ? Object.entries(pdb.value.selector) : [])

// Edit form
const editForm = ref({
  constraintType: 'minAvailable',
  minAvailable: '',
  maxUnavailable: '',
})

function openEdit() {
  if (!pdb.value) return
  if (pdb.value.minAvailable) {
    editForm.value = {
      constraintType: 'minAvailable',
      minAvailable: pdb.value.minAvailable,
      maxUnavailable: '',
    }
  } else {
    editForm.value = {
      constraintType: 'maxUnavailable',
      minAvailable: '',
      maxUnavailable: pdb.value.maxUnavailable,
    }
  }
  showEditModal.value = true
}

function handleEdit() {
  const f = editForm.value
  const updates = {
    minAvailable: f.constraintType === 'minAvailable' ? String(f.minAvailable) : '',
    maxUnavailable: f.constraintType === 'maxUnavailable' ? String(f.maxUnavailable) : '',
  }
  store.updatePDB(route.params.name, route.params.namespace, updates)
  showEditModal.value = false
}

async function handleDelete() {
  await store.deletePDB(route.params.name, route.params.namespace)
  router.push({ name: 'NsPDBs', params: { namespace: route.params.namespace } })
}
</script>

<template>
  <div class="animate-fade-in" v-if="pdb">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'PodDisruptionBudgets', route: `/ns/${route.params.namespace}/pdbs` },
      { label: route.params.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">shield</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ pdb.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 rounded-full text-label-caps font-medium border bg-primary-container/10 text-primary border-primary/20">
              <span class="material-symbols-outlined text-xs align-middle mr-1">shield</span>PodDisruptionBudget
            </span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ pdb.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="openEdit" class="flex items-center gap-sm px-md py-sm border border-outline-variant text-on-surface font-semibold rounded-lg hover:bg-surface-container-low transition-colors">
          <span class="material-symbols-outlined">edit</span> Edit
        </button>
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="flex flex-col gap-lg">
      <!-- 健康状态卡片 -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-lg">
        <!-- Allowed Disruptions -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-lg">
          <div class="flex items-center gap-sm mb-md">
            <span class="material-symbols-outlined text-primary">remove_circle</span>
            <h3 class="text-headline-sm text-on-surface">允许中断数</h3>
          </div>
          <div class="flex items-baseline gap-sm">
            <span class="text-display-lg font-bold" :class="pdb.allowedDisruptions > 0 ? 'text-primary' : 'text-error'">{{ pdb.allowedDisruptions }}</span>
            <span class="text-on-surface-variant text-body-md">Allowed Disruptions</span>
          </div>
          <p class="text-body-sm text-on-surface-variant mt-sm">
            当前可安全中断（驱逐）的 Pod 数量。为 0 时表示暂不允许自愿驱逐。
          </p>
        </div>

        <!-- Healthy 对比 -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-lg">
          <div class="flex items-center gap-sm mb-md">
            <span class="material-symbols-outlined" :class="isHealthy ? 'text-primary' : 'text-error'">{{ isHealthy ? 'check_circle' : 'warning' }}</span>
            <h3 class="text-headline-sm text-on-surface">健康状态</h3>
          </div>
          <div class="flex items-end gap-md">
            <div class="flex flex-col">
              <span class="text-label-caps text-on-surface-variant">Current Healthy</span>
              <span class="text-display-lg font-bold" :class="isHealthy ? 'text-on-surface' : 'text-error'">{{ pdb.currentHealthy }}</span>
            </div>
            <span class="text-on-surface-variant text-display-lg pb-xs">/</span>
            <div class="flex flex-col">
              <span class="text-label-caps text-on-surface-variant">Desired Healthy</span>
              <span class="text-display-lg font-bold text-on-surface-variant">{{ pdb.desiredHealthy }}</span>
            </div>
          </div>
          <div v-if="!isHealthy" class="mt-sm flex items-center gap-xs px-md py-sm bg-error-container/10 border border-error/20 rounded-lg">
            <span class="material-symbols-outlined text-error text-base">warning</span>
            <span class="text-body-sm text-error font-medium">当前健康副本数低于期望值，PDB 约束生效中</span>
          </div>
          <p v-else class="text-body-sm text-on-surface-variant mt-sm">当前健康副本数满足期望，状态正常。</p>
        </div>
      </div>

      <!-- 约束信息 -->
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <h3 class="text-headline-sm text-on-surface">约束信息</h3>
        </div>
        <div class="divide-y divide-outline-variant/30">
          <!-- 约束类型 -->
          <div class="px-lg py-md flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-on-surface-variant">tune</span>
              <span class="text-body-md text-on-surface-variant">约束类型</span>
            </div>
            <div class="flex items-center gap-sm">
              <template v-if="pdb.minAvailable">
                <span class="text-body-sm text-on-surface-variant">minAvailable</span>
                <span class="px-2 py-0.5 rounded bg-surface-container text-body-sm font-mono font-semibold text-on-surface border border-outline-variant">{{ pdb.minAvailable }}</span>
              </template>
              <template v-else-if="pdb.maxUnavailable">
                <span class="text-body-sm text-on-surface-variant">maxUnavailable</span>
                <span class="px-2 py-0.5 rounded bg-surface-container text-body-sm font-mono font-semibold text-on-surface border border-outline-variant">{{ pdb.maxUnavailable }}</span>
              </template>
              <span v-else class="text-body-sm text-on-surface-variant">—</span>
            </div>
          </div>
          <!-- Selector -->
          <div class="px-lg py-md flex items-center justify-between gap-md">
            <div class="flex items-center gap-sm shrink-0">
              <span class="material-symbols-outlined text-on-surface-variant">filter_alt</span>
              <span class="text-body-md text-on-surface-variant">Selector</span>
            </div>
            <div class="flex flex-wrap gap-xs justify-end">
              <span v-for="([k, v]) in selectorEntries" :key="k" class="px-1.5 py-0.5 bg-surface-container text-label-caps text-on-surface rounded border border-outline-variant font-mono">
                {{ k }}={{ v }}
              </span>
              <span v-if="!selectorEntries.length" class="text-body-sm text-on-surface-variant">—</span>
            </div>
          </div>
          <!-- Namespace -->
          <div class="px-lg py-md flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-on-surface-variant">namespace</span>
              <span class="text-body-md text-on-surface-variant">Namespace</span>
            </div>
            <span class="text-body-sm font-mono text-on-surface">{{ pdb.namespace }}</span>
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
    <h2 class="text-headline-md text-on-surface mt-md">PodDisruptionBudget Not Found</h2>
    <button @click="router.push({ name: 'NsPDBs', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to PodDisruptionBudgets</button>
  </div>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" title="Edit PodDisruptionBudget" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">约束类型 (二选一) *</label>
        <div class="flex gap-md">
          <label class="flex items-center gap-xs cursor-pointer">
            <input type="radio" v-model="editForm.constraintType" value="minAvailable" class="text-primary focus:ring-primary" />
            <span class="text-body-md text-on-surface">minAvailable</span>
          </label>
          <label class="flex items-center gap-xs cursor-pointer">
            <input type="radio" v-model="editForm.constraintType" value="maxUnavailable" class="text-primary focus:ring-primary" />
            <span class="text-body-md text-on-surface">maxUnavailable</span>
          </label>
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">值</label>
        <input v-if="editForm.constraintType === 'minAvailable'" v-model="editForm.minAvailable" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="最小可用副本数 (如 2 或 50%)" />
        <input v-else v-model="editForm.maxUnavailable" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="最大不可用副本数 (如 1 或 25%)" />
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleEdit" :disabled="editForm.constraintType === 'minAvailable' ? !editForm.minAvailable : !editForm.maxUnavailable" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Save</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete PodDisruptionBudget" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete PDB <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">删除后，受其保护的工作负载在节点驱逐时将不再有可用性保证。此操作不可撤销。</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
