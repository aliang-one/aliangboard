<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail } from '@/composables/useK8sQuery'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const lrDetail = useResourceDetail({
  key: ['cluster', cid.value, 'limitranges', route.params.name],
  fetcher: () => store.fetchLimitRange(route.params.name, route.params.namespace),
  mock: store.getLimitRangeByName(route.params.name, route.params.namespace),
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 15000 : false },
})
const lr = computed(() => lrDetail.data.value ?? store.getLimitRangeByName(route.params.name, route.params.namespace))
const { yaml } = useLiveYaml({
  pathFn: () => `/api/v1/namespaces/${encodeURIComponent(route.params.namespace)}/limitranges/${encodeURIComponent(route.params.name)}`,
  mockFn: () => store.generateYAML('limitrange', lr.value),
})

const activeTab = ref('overview')
const showDeleteModal = ref(false)
const showEditModal = ref(false)

// Edit form
const editForm = ref({
  defaultCPU: '',
  defaultMemory: '',
  defaultRequestCPU: '',
  defaultRequestMemory: '',
  maxCPU: '',
  maxMemory: '',
  minCPU: '',
  minMemory: '',
})

function openEditModal() {
  if (!lr.value) return
  editForm.value = {
    defaultCPU: lr.value.defaultCPU || '',
    defaultMemory: lr.value.defaultMemory || '',
    defaultRequestCPU: lr.value.defaultRequestCPU || '',
    defaultRequestMemory: lr.value.defaultRequestMemory || '',
    maxCPU: lr.value.maxCPU || '',
    maxMemory: lr.value.maxMemory || '',
    minCPU: lr.value.minCPU || '',
    minMemory: lr.value.minMemory || '',
  }
  showEditModal.value = true
}

function handleEdit() {
  const f = editForm.value
  store.updateLimitRange(route.params.name, route.params.namespace, {
    defaultCPU: f.defaultCPU,
    defaultMemory: f.defaultMemory,
    defaultRequestCPU: f.defaultRequestCPU,
    defaultRequestMemory: f.defaultRequestMemory,
    maxCPU: f.maxCPU,
    maxMemory: f.maxMemory,
    minCPU: f.minCPU,
    minMemory: f.minMemory,
  })
  showEditModal.value = false
}

async function handleDelete() {
  await store.deleteLimitRange(route.params.name, route.params.namespace)
  router.push({ name: 'NsLimitRanges', params: { namespace: route.params.namespace } })
}

// Grouped limit items for the overview grid
const limitSections = computed(() => {
  if (!lr.value) return []
  const l = lr.value
  return [
    {
      title: 'Default Limits',
      description: 'Resource limits applied to containers that do not specify their own limits',
      icon: 'layers',
      colorClass: 'bg-primary-container/10 text-primary border-primary/20',
      items: [
        { label: 'CPU', value: l.defaultCPU || '-' },
        { label: 'Memory', value: l.defaultMemory || '-' },
      ],
    },
    {
      title: 'Default Requests',
      description: 'Resource requests applied to containers that do not specify their own requests',
      icon: 'input',
      colorClass: 'bg-secondary-container/10 text-secondary border-secondary/20',
      items: [
        { label: 'CPU', value: l.defaultRequestCPU || '-' },
        { label: 'Memory', value: l.defaultRequestMemory || '-' },
      ],
    },
    {
      title: 'Max Limits',
      description: 'Maximum resource limits that can be set on containers',
      icon: 'arrow_upward',
      colorClass: 'bg-tertiary-container/10 text-tertiary border-tertiary/20',
      items: [
        { label: 'CPU', value: l.maxCPU || '-' },
        { label: 'Memory', value: l.maxMemory || '-' },
      ],
    },
    {
      title: 'Min Limits',
      description: 'Minimum resource limits that can be set on containers',
      icon: 'arrow_downward',
      colorClass: 'bg-surface-container text-on-surface-variant border-outline-variant',
      items: [
        { label: 'CPU', value: l.minCPU || '-' },
        { label: 'Memory', value: l.minMemory || '-' },
      ],
    },
  ]
})
</script>

<template>
  <div class="animate-fade-in" v-if="lr">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'LimitRanges', route: `/ns/${route.params.namespace}/limitranges` },
      { label: route.params.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-secondary text-3xl">tune</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ lr.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-secondary-container/10 text-secondary text-label-caps rounded-full font-medium">LimitRange</span>
            <span class="text-body-sm text-on-surface-variant">Type: Container</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ lr.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="openEditModal" class="flex items-center gap-sm px-md py-sm border border-outline-variant text-on-surface font-semibold rounded-lg hover:bg-surface-container-low transition-colors">
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
    <div v-if="activeTab === 'overview'">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-lg">
        <div v-for="section in limitSections" :key="section.title" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
          <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center gap-sm">
            <span class="material-symbols-outlined text-lg" :class="section.colorClass.split(' ')[1]">{{ section.icon }}</span>
            <h3 class="text-headline-sm">{{ section.title }}</h3>
          </div>
          <div class="px-lg py-md">
            <p class="text-body-sm text-on-surface-variant mb-md">{{ section.description }}</p>
            <div class="flex flex-col gap-sm">
              <div v-for="item in section.items" :key="item.label" class="flex items-center justify-between py-sm px-md bg-surface-container-low rounded-lg">
                <span class="text-body-md text-on-surface-variant font-medium">{{ item.label }}</span>
                <span class="text-body-md font-mono font-semibold" :class="section.colorClass.split(' ')[1]">{{ item.value }}</span>
              </div>
            </div>
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
    <h2 class="text-headline-md text-on-surface mt-md">LimitRange Not Found</h2>
    <button @click="router.push({ name: 'NsLimitRanges', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to LimitRanges</button>
  </div>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" title="Edit LimitRange" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Default Limits</label>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs text-xs">CPU</label>
            <input v-model="editForm.defaultCPU" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs text-xs">Memory</label>
            <input v-model="editForm.defaultMemory" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
          </div>
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Default Requests</label>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs text-xs">CPU</label>
            <input v-model="editForm.defaultRequestCPU" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs text-xs">Memory</label>
            <input v-model="editForm.defaultRequestMemory" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
          </div>
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Max Limits</label>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs text-xs">CPU</label>
            <input v-model="editForm.maxCPU" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs text-xs">Memory</label>
            <input v-model="editForm.maxMemory" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
          </div>
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Min Limits</label>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs text-xs">CPU</label>
            <input v-model="editForm.minCPU" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs text-xs">Memory</label>
            <input v-model="editForm.minMemory" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
          </div>
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Save Changes</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete LimitRange" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete LimitRange <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Removing a LimitRange removes default resource constraints for containers. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
