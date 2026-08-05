<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()

const sc = computed(() => store.getSCByName(route.params.name))
const { yaml } = useLiveYaml({
  pathFn: () => `/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(route.params.name)}`,
  mockFn: () => store.generateYAML('storageclass', sc.value),
})
const activeTab = ref('overview')

const paramMap = computed(() => Object.fromEntries(
  String(sc.value?.parameters || '').split(',').map(kv => kv.split('=')).filter(([k]) => k).map(([k, v]) => [k.trim(), (v || '').trim()])
))
const boundPVCs = computed(() => store.pvcList.filter(p => p.storageClass === sc.value?.name))

// 结构化编辑（仅可变：default + labels/annotations）+ 删除
const showEditModal = ref(false)
const showDeleteModal = ref(false)
const editForm = ref({ isDefault: false, labels: [], annotations: [] })
const SC_DEFAULT_KEYS = ['storageclass.kubernetes.io/is-default-class', 'storageclass.beta.kubernetes.io/is-default-class']
const labelsToRows = obj => Object.entries(obj || {}).map(([key, value]) => ({ key, value: String(value) }))
const rowsToMap = rows => {
  const m = {}
  for (const r of rows) { const k = (r.key || '').trim(); if (k) m[k] = r.value }
  return m
}
function openEdit() {
  const annExcl = { ...(sc.value?.annotations || {}) }
  for (const k of SC_DEFAULT_KEYS) delete annExcl[k]   // 过滤 is-default，由开关控制
  editForm.value = {
    isDefault: !!sc.value?.default,
    labels: labelsToRows(sc.value?.labels),
    annotations: labelsToRows(annExcl),
  }
  showEditModal.value = true
}
function addLabelRow() { editForm.value.labels.push({ key: '', value: '' }) }
function removeLabelRow(i) { editForm.value.labels.splice(i, 1) }
function addAnnRow() { editForm.value.annotations.push({ key: '', value: '' }) }
function removeAnnRow(i) { editForm.value.annotations.splice(i, 1) }
async function saveEdit() {
  await store.updateStorageClass(route.params.name, {
    isDefault: editForm.value.isDefault,
    labels: rowsToMap(editForm.value.labels),
    annotations: rowsToMap(editForm.value.annotations),
  })
  showEditModal.value = false
}
async function handleDelete() {
  await store.deleteStorageClass(route.params.name)
  router.push('/storage')
}
</script>

<template>
  <section class="animate-fade-in" v-if="sc">
    <Breadcrumbs :items="[
      { label: 'Storage', route: '/storage' },
      { label: 'StorageClasses' },
      { label: sc.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-secondary text-3xl">database</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ sc.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span v-if="sc.default" class="px-2.5 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded-full font-medium">DEFAULT</span>
            <span class="text-body-sm text-on-surface-variant font-mono">{{ sc.provisioner }}</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ sc.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-xs">
        <button @click="openEdit" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined text-sm">edit</span> 编辑
        </button>
        <button @click="showDeleteModal = true" class="px-3 py-1.5 text-body-sm font-medium border border-error/30 text-error rounded-lg hover:bg-error/5 transition-colors">删除</button>
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
          <h3 class="text-headline-sm mb-lg">StorageClass Details</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">PROVISIONER</p><p class="font-mono text-code-sm text-on-surface">{{ sc.provisioner }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">RECLAIM POLICY</p><p class="text-body-md text-on-surface">{{ sc.reclaimPolicy }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">DEFAULT</p><p class="text-body-md text-on-surface">{{ sc.default ? 'Yes' : 'No' }}</p></div>
            <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">AGE</p><p class="text-body-md text-on-surface">{{ sc.age }}</p></div>
          </div>
          <div v-if="Object.keys(paramMap).length" class="mt-lg">
            <p class="text-label-caps text-on-surface-variant mb-sm">PARAMETERS</p>
            <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
              <div v-for="(v, k) in paramMap" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface">{{ v }}</span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="lg:col-span-4">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Bound PVCs ({{ boundPVCs.length }})</h3>
          <div v-if="boundPVCs.length" class="flex flex-col gap-sm">
            <button v-for="p in boundPVCs" :key="p.name" @click="router.push({ name: 'NsPVCDetail', params: { namespace: p.namespace, name: p.name } })"
              class="flex items-center justify-between px-md py-sm bg-surface-container-low rounded-lg hover:bg-primary-container/10 transition-colors">
              <span class="font-mono text-code-sm text-primary">{{ p.name }}</span>
              <span class="text-body-sm text-on-surface-variant">{{ p.namespace }} · {{ p.capacity }}</span>
            </button>
          </div>
          <p v-else class="text-body-sm text-on-surface-variant py-md text-center">No PVCs bound</p>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>

    <!-- Edit Modal -->
    <Modal v-model="showEditModal" title="编辑 StorageClass（仅可变字段）" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <label class="flex items-center gap-sm cursor-pointer">
          <input v-model="editForm.isDefault" type="checkbox" class="h-4 w-4 accent-primary" />
          <span class="text-body-md text-on-surface">设为默认 StorageClass</span>
        </label>
        <div>
          <div class="flex items-center justify-between mb-xs">
            <label class="text-label-caps text-on-surface-variant">Labels</label>
            <button @click="addLabelRow" type="button" class="text-body-sm text-primary font-medium hover:underline">+ 添加</button>
          </div>
          <div v-for="(row, i) in editForm.labels" :key="'l'+i" class="flex gap-xs mb-xs">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="key" />
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="value" />
            <button @click="removeLabelRow(i)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
          <p v-if="!editForm.labels.length" class="text-xs text-on-surface-variant/60">无</p>
        </div>
        <div>
          <div class="flex items-center justify-between mb-xs">
            <label class="text-label-caps text-on-surface-variant">Annotations</label>
            <button @click="addAnnRow" type="button" class="text-body-sm text-primary font-medium hover:underline">+ 添加</button>
          </div>
          <div v-for="(row, i) in editForm.annotations" :key="'a'+i" class="flex gap-xs mb-xs">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="key" />
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="value" />
            <button @click="removeAnnRow(i)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
          <p v-if="!editForm.annotations.length" class="text-xs text-on-surface-variant/60">无</p>
          <p class="text-[10px] text-on-surface-variant/60 mt-xs">系统注解 <code>storageclass.kubernetes.io/is-default-class</code> 由「默认开关」控制，不在此列。</p>
        </div>
      </div>
      <template #actions>
        <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
        <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">保存</button>
      </template>
    </Modal>

    <!-- Delete Modal -->
    <Modal v-model="showDeleteModal" title="删除 StorageClass" width="max-w-md">
      <p class="text-body-md text-on-surface-variant">确认删除 StorageClass <span class="text-on-surface font-semibold">{{ sc.name }}</span>？此操作不可撤销。</p>
      <template #actions>
        <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
        <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">删除</button>
      </template>
    </Modal>
  </section>
  <section v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">StorageClass Not Found</h2>
    <button @click="router.push('/storage')" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Storage</button>
  </section>
</template>
