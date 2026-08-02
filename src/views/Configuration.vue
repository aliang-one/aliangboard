<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'

const router = useRouter()
const store = useClusterStore()
const activeTab = ref('configmaps')

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
const rqHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'limits', label: 'Limits' },
  { key: 'age', label: 'Age' },
  { key: 'actions', label: 'Actions', align: 'right' },
]
const lrHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'defaultCPU', label: 'Def CPU' },
  { key: 'defaultMemory', label: 'Def Memory' },
  { key: 'age', label: 'Age' },
  { key: 'actions', label: 'Actions', align: 'right' },
]
const hpaHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'targetName', label: 'Target' },
  { key: 'minReplicas', label: 'Min' },
  { key: 'maxReplicas', label: 'Max' },
  { key: 'cpuTarget', label: 'CPU %' },
  { key: 'age', label: 'Age' },
  { key: 'actions', label: 'Actions', align: 'right' },
]

// 各 tab 对应的「新建」目标命名空间列表页（复用既有表单页）与详情页路由名
const createRouteName = {
  configmaps: 'NsConfigMaps',
  secrets: 'NsSecrets',
  resourcequotas: 'NsResourceQuotas',
  limitranges: 'NsLimitRanges',
  hpas: 'NsHPA',
}
const detailRouteName = {
  configmaps: 'NsConfigMapDetail',
  secrets: 'NsSecretDetail',
  resourcequotas: 'NsResourceQuotaDetail',
  limitranges: 'NsLimitRangeDetail',
  hpas: 'NsHPADetail',
}
const deleteFn = {
  configmaps: (name, ns) => store.deleteConfigMap(name, ns),
  secrets: (name, ns) => store.deleteSecret(name, ns),
  resourcequotas: (name, ns) => store.deleteResourceQuota(name, ns),
  limitranges: (name, ns) => store.deleteLimitRange(name, ns),
  hpas: (name, ns) => store.deleteHPA(name, ns),
}

// 新建：跳转到当前命名空间（或首个命名空间）对应列表页，那里已有创建表单
function createNew() {
  const ns = store.currentNamespace || store.namespaceList?.[0]?.name || 'default'
  router.push({ name: createRouteName[activeTab.value], params: { namespace: ns } })
}
// 编辑：跳转到命名空间级详情页（复用既有结构化编辑 UI）
function editItem(row) {
  router.push({ name: detailRouteName[activeTab.value], params: { namespace: row.namespace, name: row.name } })
}

// 删除确认
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
const deleting = ref(false)
function askDelete(row) {
  deleteTarget.value = { tab: activeTab.value, name: row.name, namespace: row.namespace }
  showDeleteModal.value = true
}
async function doDelete() {
  if (!deleteTarget.value) return
  const { tab, name, namespace } = deleteTarget.value
  deleting.value = true
  try {
    await deleteFn[tab](name, namespace)
    showDeleteModal.value = false
  } catch (e) {
    alert(e.message || '删除失败')
  } finally {
    deleting.value = false
  }
}

const rqLimitsCount = rq => Object.keys(rq.hard || {}).length
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Configuration</h2>
        <p class="text-on-surface-variant text-body-md mt-1">Manage ConfigMaps, Secrets, ResourceQuotas, and auto-scaling configurations.</p>
      </div>
      <button @click="createNew" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90">
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
    <DataTable v-if="activeTab === 'configmaps'" :headers="cmHeaders" :rows="store.configMapList" @row-click="editItem">
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
          <button @click.stop="editItem(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="Edit">
            <span class="material-symbols-outlined text-lg">edit</span>
          </button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete">
            <span class="material-symbols-outlined text-lg">delete</span>
          </button>
        </div>
      </template>
    </DataTable>

    <!-- Secrets -->
    <DataTable v-if="activeTab === 'secrets'" :headers="secretHeaders" :rows="store.secretList" @row-click="editItem">
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
          <button @click.stop="editItem(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="Edit"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
    </DataTable>

    <!-- ResourceQuotas -->
    <DataTable v-if="activeTab === 'resourcequotas' && store.resourceQuotaList.length" :headers="rqHeaders" :rows="store.resourceQuotaList" @row-click="editItem">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-secondary">pie_chart</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #limits="{ row }"><span class="font-mono text-code-sm">{{ rqLimitsCount(row) }}</span></template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="editItem(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="Edit"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
    </DataTable>
    <div v-else-if="activeTab === 'resourcequotas'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-2xl text-center">
      <span class="material-symbols-outlined text-5xl text-surface-container-high">pie_chart</span>
      <p class="text-on-surface-variant mt-md">未发现 ResourceQuota。</p>
      <button @click="createNew" class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Create ResourceQuota</button>
    </div>

    <!-- LimitRanges -->
    <DataTable v-if="activeTab === 'limitranges' && store.limitRangeList.length" :headers="lrHeaders" :rows="store.limitRangeList" @row-click="editItem">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-secondary">tune</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #defaultCPU="{ row }"><span class="font-mono text-code-sm">{{ row.defaultCPU || '—' }}</span></template>
      <template #defaultMemory="{ row }"><span class="font-mono text-code-sm">{{ row.defaultMemory || '—' }}</span></template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="editItem(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="Edit"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
    </DataTable>
    <div v-else-if="activeTab === 'limitranges'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-2xl text-center">
      <span class="material-symbols-outlined text-5xl text-surface-container-high">tune</span>
      <p class="text-on-surface-variant mt-md">未发现 LimitRange。</p>
      <button @click="createNew" class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Create LimitRange</button>
    </div>

    <!-- HPA -->
    <DataTable v-if="activeTab === 'hpas' && store.hpaList.length" :headers="hpaHeaders" :rows="store.hpaList" @row-click="editItem">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-secondary">timeline</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #targetName="{ row }">
        <span class="font-mono text-code-sm text-primary">{{ row.targetKind }}/{{ row.targetName || '—' }}</span>
      </template>
      <template #cpuTarget="{ row }"><span class="font-mono text-code-sm">{{ row.cpuTarget != null ? row.cpuTarget + '%' : '—' }}</span></template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="editItem(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="Edit"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
    </DataTable>
    <div v-else-if="activeTab === 'hpas'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-2xl text-center">
      <span class="material-symbols-outlined text-5xl text-surface-container-high">timeline</span>
      <p class="text-on-surface-variant mt-md">未发现 HorizontalPodAutoscaler。</p>
      <button @click="createNew" class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Create HPA</button>
    </div>

    <!-- Delete Confirm Modal -->
    <Modal v-model="showDeleteModal" title="Delete resource" width="max-w-md">
      <p class="text-body-md text-on-surface-variant">确定删除 <span class="font-mono text-on-surface font-semibold">{{ deleteTarget?.name }}</span><span class="text-on-surface-variant">（{{ deleteTarget?.namespace }}）</span>？</p>
      <p class="text-body-sm text-error mt-sm">此操作不可撤销。</p>
      <template #actions>
        <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
        <button @click="doDelete" :disabled="deleting" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-50">Delete</button>
      </template>
    </Modal>
  </section>
</template>
