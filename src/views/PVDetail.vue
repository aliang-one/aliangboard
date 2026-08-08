<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
const _cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const _pvcQ = useResourceList({ key: ['cluster', _cid.value, 'pvcs'], fetcher: () => store.fetchPVCs(), mock: store.pvcList, mockMode: !store.remoteMode, options: { refetchInterval: store.remoteMode ? 30000 : false } })

const pv = computed(() => store.getPVByName(route.params.name))
const { yaml } = useLiveYaml({
  pathFn: () => `/api/v1/persistentvolumes/${encodeURIComponent(route.params.name)}`,
  mockFn: () => store.generateYAML('pv', pv.value),
})
const activeTab = ref('overview')

const claimParts = computed(() => (pv.value?.claim || '').split('/'))
const pvc = computed(() => {
  const [ns, nm] = claimParts.value
  return nm ? (_pvcQ.data.value || []).find(p => p.name === nm && (!ns || p.namespace === ns)) : null
})
const sc = computed(() => pv.value?.storageClass ? store.getSCByName(pv.value.storageClass) : null)
const accessModeLabels = { RWO: 'ReadWriteOnce', RWM: 'ReadWriteMany', ROM: 'ReadOnlyMany', RWOP: 'ReadWriteOncePod' }

// Structured edit (K8s mutable fields only: reclaimPolicy + labels/annotations) + delete
const showEditModal = ref(false)
const showDeleteModal = ref(false)
const editForm = ref({ reclaimPolicy: 'Retain', labels: [], annotations: [] })
const labelsToRows = obj => Object.entries(obj || {}).map(([key, value]) => ({ key, value: String(value) }))
const rowsToMap = rows => {
  const m = {}
  for (const r of rows) { const k = (r.key || '').trim(); if (k) m[k] = r.value }
  return m
}
function openEdit() {
  editForm.value = {
    reclaimPolicy: pv.value?.reclaimPolicy || 'Retain',
    labels: labelsToRows(pv.value?.labels),
    annotations: labelsToRows(pv.value?.annotations),
  }
  showEditModal.value = true
}
function addLabelRow() { editForm.value.labels.push({ key: '', value: '' }) }
function removeLabelRow(i) { editForm.value.labels.splice(i, 1) }
function addAnnRow() { editForm.value.annotations.push({ key: '', value: '' }) }
function removeAnnRow(i) { editForm.value.annotations.splice(i, 1) }
async function saveEdit() {
  await store.updatePV(route.params.name, {
    reclaimPolicy: editForm.value.reclaimPolicy,
    labels: rowsToMap(editForm.value.labels),
    annotations: rowsToMap(editForm.value.annotations),
  })
  showEditModal.value = false
}
async function handleDelete() {
  await store.deletePV(route.params.name)
  router.push('/storage')
}
</script>

<template>
  <section class="animate-fade-in" v-if="pv">
    <Breadcrumbs :items="[
      { label: 'Storage', route: '/storage' },
      { label: 'PersistentVolumes' },
      { label: pv.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">database</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ pv.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <StatusChip :status="pv.status" />
            <span class="text-body-sm text-on-surface-variant">Capacity: <span class="font-mono text-primary font-semibold">{{ pv.capacity }}</span></span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ pv.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-xs">
        <button @click="openEdit" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined text-sm">edit</span> t('common.edit')
        </button>
        <button @click="showDeleteModal = true" class="px-3 py-1.5 text-body-sm font-medium border border-error/30 text-error rounded-lg hover:bg-error/5 transition-colors">t('common.delete')</button>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">PersistentVolume Details</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">STATUS</p><StatusChip :status="pv.status" size="sm" /></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">CAPACITY</p><p class="font-mono text-code-sm text-primary font-semibold">{{ pv.capacity }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">ACCESS MODE</p><p class="text-body-md text-on-surface" :title="accessModeLabels[pv.accessModes]">{{ pv.accessModes }} · {{ accessModeLabels[pv.accessModes] || pv.accessModes }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">RECLAIM POLICY</p><p class="text-body-md text-on-surface">{{ pv.reclaimPolicy }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">STORAGECLASS</p><p class="text-body-md text-on-surface">{{ pv.storageClass || '—' }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">CLAIM</p><p class="font-mono text-code-sm" :class="pv.claim ? 'text-primary' : 'text-on-surface-variant'">{{ pv.claim || 'Available' }}</p></div>
          </div>
        </div>
      </div>
      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div v-if="pvc" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Bound Claim</h3>
          <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
            <span class="text-body-sm text-on-surface-variant">PVC</span>
            <button class="font-mono text-code-sm text-primary font-semibold hover:underline" @click="router.push({ name: 'NsPVCDetail', params: { namespace: pvc.namespace, name: pvc.name } })">{{ pvc.name }}</button>
          </div>
          <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
            <span class="text-body-sm text-on-surface-variant">Namespace</span><span class="text-body-md text-on-surface">{{ pvc.namespace }}</span>
          </div>
          <div class="flex justify-between items-center py-sm">
            <span class="text-body-sm text-on-surface-variant">Status</span><StatusChip :status="pvc.status" size="sm" />
          </div>
        </div>
        <div v-if="sc" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">StorageClass</h3>
          <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
            <span class="text-body-sm text-on-surface-variant">Name</span>
            <button class="text-body-md text-primary font-semibold hover:underline" @click="router.push({ name: 'StorageClassDetail', params: { name: sc.name } })">{{ sc.name }}</button>
          </div>
          <div class="flex justify-between items-center py-sm">
            <span class="text-body-sm text-on-surface-variant">Provisioner</span><span class="font-mono text-code-sm text-on-surface-variant">{{ sc.provisioner }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>

    <!-- Edit Modal -->
    <Modal v-model="showEditModal" :title="t('pv.editModalTitle')" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Reclaim Policy</label>
          <select v-model="editForm.reclaimPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option value="Retain">Retain</option>
            <option value="Delete">Delete</option>
            <option value="Recycle">Recycle</option>
          </select>
        </div>
        <div>
          <div class="flex items-center justify-between mb-xs">
            <label class="text-label-caps text-on-surface-variant">Labels</label>
            <button @click="addLabelRow" type="button" class="text-body-sm text-primary font-medium hover:underline">+ {{ t('common.add') }}</button>
          </div>
          <div v-for="(row, i) in editForm.labels" :key="'l'+i" class="flex gap-xs mb-xs">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="key" />
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="value" />
            <button @click="removeLabelRow(i)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
          <p v-if="!editForm.labels.length" class="text-xs text-on-surface-variant/60">{{ t('common.none') }}</p>
        </div>
        <div>
          <div class="flex items-center justify-between mb-xs">
            <label class="text-label-caps text-on-surface-variant">Annotations</label>
            <button @click="addAnnRow" type="button" class="text-body-sm text-primary font-medium hover:underline">+ {{ t('common.add') }}</button>
          </div>
          <div v-for="(row, i) in editForm.annotations" :key="'a'+i" class="flex gap-xs mb-xs">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="key" />
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="value" />
            <button @click="removeAnnRow(i)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
          <p v-if="!editForm.annotations.length" class="text-xs text-on-surface-variant/60">{{ t('common.none') }}</p>
        </div>
      </div>
      <template #actions>
        <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">t('common.cancel')</button>
        <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">t('common.save')</button>
      </template>
    </Modal>

    <!-- Delete Modal -->
    <Modal v-model="showDeleteModal" title="t('common.delete') PersistentVolume" width="max-w-md">
      <p class="text-body-md text-on-surface-variant" v-html="t('pv.deleteConfirm', { name: pv.name })"></p>
      <template #actions>
        <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">t('common.cancel')</button>
        <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">t('common.delete')</button>
      </template>
    </Modal>
  </section>
  <section v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">PersistentVolume Not Found</h2>
    <button @click="router.push('/storage')" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Storage</button>
  </section>
</template>
