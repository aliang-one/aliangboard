<script setup>
import { ref } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'

const store = useClusterStore()
const activeTab = ref('configmaps')
const showDetailModal = ref(false)
const selectedItem = ref(null)

const tabs = [
  { key: 'configmaps', label: 'ConfigMaps' },
  { key: 'secrets', label: 'Secrets' },
  { key: 'resourcequotas', label: 'ResourceQuotas' },
  { key: 'limitranges', label: 'LimitRanges' },
  { key: 'hpas', label: 'HPA' },
]

const cmHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'keys', label: 'Data Keys' },
  { key: 'age', label: 'Age' },
  { key: 'actions', label: 'Actions', align: 'right' },
]

const secretHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'type', label: 'Type' },
  { key: 'keys', label: 'Keys' },
  { key: 'age', label: 'Age' },
  { key: 'actions', label: 'Actions', align: 'right' },
]

function openDetail(item) {
  selectedItem.value = item
  showDetailModal.value = true
}
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Configuration</h2>
        <p class="text-on-surface-variant text-body-md mt-1">Manage ConfigMaps, Secrets, ResourceQuotas, and auto-scaling configurations.</p>
      </div>
      <button class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90">
        <span class="material-symbols-outlined">add</span> Create New
      </button>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors"
        :class="activeTab === tab.key ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'"
      >{{ tab.label }}</button>
    </div>

    <!-- ConfigMaps -->
    <DataTable v-if="activeTab === 'configmaps'" :headers="cmHeaders" :rows="store.configMapList" @row-click="openDetail">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-secondary">description</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #keys="{ row }">
        <span class="font-mono text-code-sm font-bold">{{ row.keys }}</span>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="Edit">
            <span class="material-symbols-outlined text-lg">edit</span>
          </button>
          <button class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete">
            <span class="material-symbols-outlined text-lg">delete</span>
          </button>
        </div>
      </template>
    </DataTable>

    <!-- Secrets -->
    <DataTable v-if="activeTab === 'secrets'" :headers="secretHeaders" :rows="store.secretList">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-tertiary-container">key</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #type="{ row }">
        <span class="px-2 py-0.5 bg-surface-container rounded text-body-sm border border-outline-variant">{{ row.type }}</span>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
    </DataTable>

    <!-- ResourceQuotas -->
    <div v-if="activeTab === 'resourcequotas'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-2xl text-center">
      <span class="material-symbols-outlined text-5xl text-surface-container-high">pie_chart</span>
      <p class="text-on-surface-variant mt-md">ResourceQuotas are managed per namespace.</p>
      <router-link to="/namespaces" class="mt-md inline-block px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Go to Namespaces</router-link>
    </div>

    <!-- LimitRanges -->
    <div v-if="activeTab === 'limitranges'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-2xl text-center">
      <span class="material-symbols-outlined text-5xl text-surface-container-high">tune</span>
      <p class="text-on-surface-variant mt-md">No LimitRanges configured.</p>
      <button class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Create LimitRange</button>
    </div>

    <!-- HPA -->
    <div v-if="activeTab === 'hpas'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-2xl text-center">
      <span class="material-symbols-outlined text-5xl text-surface-container-high">timeline</span>
      <p class="text-on-surface-variant mt-md">No HorizontalPodAutoscalers configured.</p>
      <button class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Create HPA</button>
    </div>

    <!-- Detail Modal -->
    <Modal v-model="showDetailModal" :title="selectedItem?.name || 'Detail'" width="max-w-2xl">
      <div v-if="selectedItem">
        <div class="space-y-md">
          <div class="flex justify-between"><span class="text-on-surface-variant">Namespace</span><span class="font-medium">{{ selectedItem.namespace }}</span></div>
          <div class="flex justify-between"><span class="text-on-surface-variant">Keys</span><span class="font-medium">{{ selectedItem.keys }}</span></div>
          <div class="flex justify-between"><span class="text-on-surface-variant">Age</span><span class="font-medium">{{ selectedItem.age }}</span></div>
        </div>
        <div v-if="selectedItem.data && Object.keys(selectedItem.data).length" class="mt-lg">
          <h4 class="text-label-caps text-on-surface-variant mb-sm">DATA</h4>
          <div class="bg-[#1a1c1e] rounded-lg p-md font-mono text-code-sm text-surface-variant max-h-64 overflow-auto">
            <pre>{{ JSON.stringify(selectedItem.data, null, 2) }}</pre>
          </div>
        </div>
      </div>
    </Modal>
  </section>
</template>
