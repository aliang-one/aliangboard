<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import { pvcFileApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const pvc = computed(() => store.getPVCByName(route.params.name, route.params.namespace))
const { yaml } = useLiveYaml({
  pathFn: () => `/api/v1/namespaces/${encodeURIComponent(route.params.namespace)}/persistentvolumeclaims/${encodeURIComponent(route.params.name)}`,
  mockFn: () => store.generateYAML('pvc', pvc.value),
})
const pv = computed(() => pvc.value?.volume ? store.pvList.find(p => p.name === pvc.value.volume) : null)
const sc = computed(() => pvc.value?.storageClass ? store.scList.find(s => s.name === pvc.value.storageClass) : null)

const activeTab = ref('overview')
const showDeleteModal = ref(false)

async function handleDelete() {
  await store.deletePVC(route.params.name, route.params.namespace)
  router.push({ name: 'NsStorage', params: { namespace: route.params.namespace } })
}

// === 结构化编辑 ===
const showEditModal = ref(false)
const editCapacity = ref('')
const editAccessModes = ref('RWO')
const editStorageClass = ref('')

function openEdit() {
  editCapacity.value = pvc.value?.capacity || ''
  editAccessModes.value = pvc.value?.accessModes || 'RWO'
  editStorageClass.value = pvc.value?.storageClass || ''
  showEditModal.value = true
}
function saveEdit() {
  store.updatePVC(route.params.name, route.params.namespace, {
    capacity: editCapacity.value,
    accessModes: editAccessModes.value,
    storageClass: editStorageClass.value,
  })
  showEditModal.value = false
}

// === PVC 文件浏览（只读）：网关起 busybox helper Pod 只读挂载 + exec ls/cat ===
const fpath = ref('/')
const fentries = ref([])
const ffile = ref(null)        // 当前预览文件 { name, content, truncated, binary }
const floading = ref(false)
const ferror = ref('')
const fInited = ref(false)
const joinPath = (base, name) => (base.replace(/\/$/, '') + '/' + name).replace(/\/+/g, '/')
async function browsePvc(p) {
  if (!store.remoteMode) { ferror.value = t('ns.pvcDetail.browseFailed'); return }
  floading.value = true; ferror.value = ''; ffile.value = null
  try {
    const r = await pvcFileApi.list({ namespace: route.params.namespace, pvc: route.params.name, path: p || '/' })
    fpath.value = r.path; fentries.value = r.entries; fInited.value = true
  } catch (e) { ferror.value = e.message || t('ns.pvcDetail.browseFailed') }
  finally { floading.value = false }
}
async function openFEntry(e) {
  if (e.type === 'dir') { browsePvc(joinPath(fpath.value, e.name)); return }
  floading.value = true; ferror.value = ''
  try {
    const r = await pvcFileApi.read({ namespace: route.params.namespace, pvc: route.params.name, path: joinPath(fpath.value, e.name) })
    ffile.value = { ...r, name: e.name }
  } catch (e) { ferror.value = e.message || t('component.podCard.filesDisabled') }
  finally { floading.value = false }
}
function fup() {
  if (fpath.value === '/' || !fpath.value) return
  const parts = fpath.value.replace(/\/$/, '').split('/').filter(Boolean); parts.pop()
  browsePvc('/' + parts.join('/'))
}
watch(activeTab, t => { if (t === 'files' && !fInited.value) browsePvc('/') })
</script>

<template>
  <div class="animate-fade-in" v-if="pvc">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: t('ns.storage.title'), route: `/ns/${route.params.namespace}/storage` },
      { label: route.params.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">storage</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ pvc.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <StatusChip :status="pvc.status" />
            <span class="text-body-sm text-on-surface-variant">Capacity: <span class="font-mono text-primary font-semibold">{{ pvc.capacity }}</span></span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ pvc.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="openEdit" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors">
          <span class="material-symbols-outlined">edit</span> {{ t('ns.pvcDetail.edit') }}
        </button>
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> {{ t('ns.pvcDetail.delete') }}
        </button>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'files', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab === 'overview' ? t('common.status') : tab === 'files' ? t('ns.pvcDetail.files') : 'YAML' }}
      </button>
    </div>

    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">{{ t('ns.pvcDetail.title') }}</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.pvcDetail.status') }}</p>
              <StatusChip :status="pvc.status" />
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.pvcDetail.capacity') }}</p>
              <p class="font-mono text-code-sm text-primary font-semibold">{{ pvc.capacity }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.pvcDetail.accessModes') }}</p>
              <p class="text-body-md text-on-surface">{{ pvc.accessModes }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.pvcDetail.storageClass') }}</p>
              <p class="text-body-md text-on-surface">{{ pvc.storageClass }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.pvcDetail.volume') }}</p>
              <p class="font-mono text-code-sm" :class="pvc.volume ? 'text-primary' : 'text-on-surface-variant'">{{ pvc.volume || t('ns.pvcDetail.notBound') }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.pvcDetail.namespace') }}</p>
              <p class="text-body-md text-on-surface">{{ pvc.namespace }}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div v-if="pv" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('ns.pvcDetail.boundVolume') }}</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.pvcDetail.pvName') }}</span>
              <span class="font-mono text-code-sm text-primary font-semibold">{{ pv.name }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.pvcDetail.reclaimPolicy') }}</span>
              <span class="text-body-md text-on-surface">{{ pv.reclaimPolicy }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">{{ t('common.age') }}</span>
              <span class="text-body-md text-on-surface">{{ pv.age }}</span>
            </div>
          </div>
        </div>
        <div v-if="sc" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('ns.pvcDetail.storageClassTitle') }}</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.pvcDetail.name') }}</span>
              <span class="text-body-md text-primary font-semibold">{{ sc.name }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.pvcDetail.provisioner') }}</span>
              <span class="text-body-sm text-on-surface">{{ sc.provisioner }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.pvcDetail.reclaimPolicy') }}</span>
              <span class="text-body-md text-on-surface">{{ sc.reclaimPolicy }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'files'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="flex items-center gap-sm px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <button @click="fup" :disabled="fpath === '/'" class="p-xs text-on-surface-variant hover:text-primary hover:bg-surface-container rounded-lg disabled:opacity-30" :title="t('ns.pvcDetail.parentDir')">
            <span class="material-symbols-outlined text-lg">arrow_upward</span>
          </button>
          <span class="material-symbols-outlined text-on-surface-variant">folder_open</span>
          <span class="font-mono text-code-sm text-on-surface flex-1 truncate">{{ fpath }}</span>
          <button @click="browsePvc(fpath)" :disabled="floading" class="p-xs text-on-surface-variant hover:text-primary hover:bg-surface-container rounded-lg" :title="t('ns.pvcDetail.refresh')">
            <span class="material-symbols-outlined text-lg" :class="floading ? 'animate-spin' : ''">refresh</span>
          </button>
        </div>
        <div class="p-lg">
          <p v-if="ferror" class="text-body-sm text-error py-sm">{{ ferror }}</p>
          <p v-else-if="floading" class="text-body-sm text-on-surface-variant py-sm">{{ t('ns.pvcDetail.loading') }}</p>
          <template v-else-if="!ffile">
            <p v-if="!fentries.length" class="text-body-sm text-on-surface-variant text-center py-md">{{ t('ns.pvcDetail.emptyDir') }}</p>
            <div v-for="e in fentries" :key="e.name" @click="openFEntry(e)" class="flex items-center gap-sm px-sm py-xs rounded-lg hover:bg-surface-container-low cursor-pointer">
              <span class="material-symbols-outlined text-lg" :class="e.type === 'dir' ? 'text-primary' : 'text-on-surface-variant'">{{ e.type === 'dir' ? 'folder' : 'description' }}</span>
              <span class="font-mono text-code-sm text-on-surface">{{ e.name }}</span>
            </div>
          </template>
          <div v-else>
            <div class="flex items-center justify-between mb-sm">
              <span class="font-mono text-code-sm text-on-surface flex items-center gap-xs"><span class="material-symbols-outlined text-base text-on-surface-variant">description</span>{{ ffile.name }}</span>
              <button @click="ffile = null" class="text-xs text-primary hover:underline">← {{ t('ns.pvcDetail.backToList') }}</button>
            </div>
            <p v-if="ffile.binary" class="text-body-sm text-on-surface-variant">{{ t('ns.pvcDetail.binaryFile') }}</p>
            <pre v-else class="bg-[#0b1c30] text-[#cfe3ff] p-md rounded-lg font-mono text-code-sm overflow-auto max-h-[480px] whitespace-pre-wrap">{{ ffile.content }}<span v-if="ffile.truncated" class="text-[#cfe3ff]/60">

{{ t('ns.pvcDetail.truncated') }}</span></pre>
          </div>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>
  </div>
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">{{ t('ns.pvcDetail.notFound') }}</h2>
    <button @click="router.push({ name: 'NsStorage', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ t('ns.pvcDetail.backToStorage') }}</button>
  </div>

  <Modal v-model="showDeleteModal" :title="t('ns.pvcDetail.deleteModalTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant" v-html="t('ns.pvcDetail.deleteConfirm', { name: route.params.name })"></p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.pvcDetail.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>

  <Modal v-model="showEditModal" :title="t('ns.pvcDetail.editModalTitle')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.pvcDetail.capacityLabel') }}</label>
        <input v-model="editCapacity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="t('ns.pvcDetail.capacityPlaceholder')" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.pvcDetail.accessModeLabel') }}</label>
        <select v-model="editAccessModes" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
          <option value="RWO">RWO (ReadWriteOnce)</option>
          <option value="RWM">RWM (ReadWriteMany)</option>
          <option value="ROM">ROM (ReadOnlyMany)</option>
          <option value="RWOP">RWOP (ReadWriteOncePod)</option>
        </select>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.pvcDetail.storageClassLabel') }}</label>
        <input v-model="editStorageClass" list="pvc-sc-list" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="t('ns.pvcDetail.storageClassPlaceholder')" />
        <datalist id="pvc-sc-list">
          <option v-for="s in store.scList" :key="s.name" :value="s.name" />
        </datalist>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.save') }}</button>
    </template>
  </Modal>
</template>
