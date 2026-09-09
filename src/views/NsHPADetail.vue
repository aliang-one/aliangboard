<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail } from '@/composables/useK8sQuery'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import DataTable from '@/components/common/DataTable.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const cid = computed(() => (store.currentCluster || 'cluster'))
const hpaDetail = useResourceDetail({
  key: ['cluster', cid, 'hpas', route.params.name],
  fetcher: () => store.fetchHPA(route.params.name, route.params.namespace),
  options: { refetchInterval: 15000 },
})
const hpa = computed(() => hpaDetail.data.value)
const { yaml } = useLiveYaml({
  pathFn: () => `/apis/autoscaling/v2/namespaces/${encodeURIComponent(route.params.namespace)}/horizontalpodautoscalers/${encodeURIComponent(route.params.name)}`,
})

const activeTab = ref('overview')
const showDeleteModal = ref(false)
const showEditModal = ref(false)

// Edit form
const editForm = ref({})
function openEdit() {
  if (!hpa.value) return
  editForm.value = {
    minReplicas: hpa.value.minReplicas,
    maxReplicas: hpa.value.maxReplicas,
    cpuTarget: hpa.value.cpuTarget,
    memoryTarget: hpa.value.memoryTarget,
  }
  showEditModal.value = true
}
function saveEdit() {
  store.updateHPA(route.params.name, route.params.namespace, {
    minReplicas: parseInt(editForm.value.minReplicas),
    maxReplicas: parseInt(editForm.value.maxReplicas),
    cpuTarget: parseInt(editForm.value.cpuTarget),
    memoryTarget: parseInt(editForm.value.memoryTarget),
  })
  showEditModal.value = false
}

async function handleDelete() {
  await store.deleteHPA(route.params.name, route.params.namespace)
  router.push({ name: 'NsHPA', params: { namespace: route.params.namespace } })
}

// Scaling status description
function scalingDescription(h) {
  if (!h) return ''
  if (h.status === 'Scaling') return t('ns.hpaDetail.scalingUpDesc', { replicas: h.currentReplicas, cpu: h.currentCPU })
  return t('ns.hpaDetail.stableDesc', { replicas: h.currentReplicas, cpu: h.currentCPU })
}

// —— 裸表迁 DataTable(Wave5 B4,审计 #251):手机自动卡片化(首列=标题),列 slot 双分支同源 ——
// headers 用 computed 保持 i18n 响应式;两行静态指标无唯一键 → 注入 _idx 作 row-key
const metricHeaders = computed(() => [
  { key: 'name', label: t('ns.hpaDetail.metricName') },
  { key: 'type', label: t('common.type') },
  { key: 'targetType', label: t('ns.hpaDetail.targetType') },
  { key: 'targetValue', label: t('ns.hpaDetail.targetValue') },
  { key: 'currentValue', label: t('ns.hpaDetail.currentValue') },
  { key: 'status', label: t('common.status') },
])
const metricRows = computed(() => {
  const h = hpa.value
  if (!h) return []
  return [
    { _idx: 0, name: 'cpu', icon: 'memory', iconClass: 'text-primary', target: h.cpuTarget, current: h.currentCPU, above: h.currentCPU > h.cpuTarget },
    { _idx: 1, name: 'memory', icon: 'storage', iconClass: 'text-secondary', target: h.memoryTarget || '-', current: h.currentMemory, above: !!(h.memoryTarget && h.currentMemory > h.memoryTarget) },
  ]
})
</script>

<template>
  <div class="animate-fade-in" v-if="hpa">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'HPA', route: `/ns/${route.params.namespace}/hpa` },
      { label: route.params.name }
    ]" />

    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-x-sm gap-y-sm mt-sm mb-xl">
      <div class="flex items-center gap-lg min-w-0">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-secondary text-3xl">speed</span>
        </div>
        <div class="min-w-0">
          <h1 class="text-display-lg text-on-surface min-w-0 max-sm:truncate" :title="hpa.name">{{ hpa.name }}</h1>
          <div class="flex items-center gap-md mt-xs flex-wrap">
            <StatusChip :status="hpa.status" size="sm" />
            <span class="px-2.5 py-0.5 bg-secondary-container/10 text-secondary text-label-caps rounded-full font-medium">HPA</span>
            <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.targetLabel') }}: <span class="text-primary font-medium">{{ hpa.targetKind }}/{{ hpa.targetName }}</span></span>
            <span class="text-body-sm text-on-surface-variant">{{ t('common.age') }}: {{ hpa.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex flex-wrap gap-sm">
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors max-sm:min-h-[40px]">
          <span class="material-symbols-outlined">delete</span> {{ t('common.delete') }}
        </button>
        <button @click="openEdit" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors max-sm:min-h-[40px]">
          <span class="material-symbols-outlined">edit</span> {{ t('common.edit') }}
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex overflow-x-auto border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'metrics', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors shrink-0 whitespace-nowrap"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <!-- Target Info -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">{{ t('ns.hpaDetail.targetInfo') }}</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.hpaDetail.scaleTarget') }}</p>
              <p class="font-mono text-code-sm text-primary font-semibold truncate min-w-0" :title="`${hpa.targetKind}/${hpa.targetName}`">{{ hpa.targetKind }}/{{ hpa.targetName }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.hpaDetail.currentReplicas') }}</p>
              <p class="text-headline-md text-on-surface font-bold">{{ hpa.currentReplicas }}</p>
            </div>
          </div>
        </div>

        <!-- Replica Range -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">{{ t('ns.hpaDetail.replicaRange') }}</h3>
          <div class="flex items-center gap-lg">
            <div class="flex-1">
              <div class="flex justify-between mb-sm">
                <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.minReplicas') }}</span>
                <span class="text-body-md font-bold text-on-surface">{{ hpa.minReplicas }}</span>
              </div>
              <div class="flex justify-between mb-sm">
                <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.maxReplicas') }}</span>
                <span class="text-body-md font-bold text-on-surface">{{ hpa.maxReplicas }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.currentLabel') }}</span>
                <span class="text-body-md font-bold text-primary">{{ hpa.currentReplicas }}</span>
              </div>
            </div>
            <div class="w-px h-16 bg-outline-variant/30"></div>
            <div class="flex-1">
              <div class="flex items-center gap-sm mb-sm">
                <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.replicaUtilization') }}</span>
              </div>
              <ProgressBar :value="hpa.maxReplicas ? Math.round((hpa.currentReplicas / hpa.maxReplicas) * 100) : 0" :max="100" color="primary" size="md" :show-label="true" :label="`${hpa.currentReplicas} / ${hpa.maxReplicas}`" />
            </div>
          </div>
        </div>

        <!-- Current Metrics -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">{{ t('ns.hpaDetail.currentMetrics') }}</h3>
          <div class="space-y-lg">
            <!-- CPU Utilization -->
            <div>
              <div class="flex items-center justify-between mb-sm flex-wrap gap-x-sm gap-y-xs">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-primary text-lg">memory</span>
                  <span class="text-body-md font-medium text-on-surface">{{ t('ns.hpaDetail.cpuUtilization') }}</span>
                </div>
                <div class="flex items-center gap-md flex-wrap">
                  <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.targetLabel') }}: <span class="font-semibold text-on-surface">{{ hpa.cpuTarget }}%</span></span>
                  <span class="text-body-sm" :class="hpa.currentCPU > hpa.cpuTarget ? 'text-error font-semibold' : 'text-on-surface'">{{ t('ns.hpaDetail.currentLabel') }}: <span class="font-bold">{{ hpa.currentCPU }}%</span></span>
                </div>
              </div>
              <ProgressBar :value="hpa.currentCPU" :max="100" color="primary" size="md" />
            </div>
            <!-- Memory Utilization -->
            <div>
              <div class="flex items-center justify-between mb-sm flex-wrap gap-x-sm gap-y-xs">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">storage</span>
                  <span class="text-body-md font-medium text-on-surface">{{ t('ns.hpaDetail.memoryUtilization') }}</span>
                </div>
                <div class="flex items-center gap-md flex-wrap">
                  <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.targetLabel') }}: <span class="font-semibold text-on-surface">{{ hpa.memoryTarget || '-' }}%</span></span>
                  <span class="text-body-sm" :class="hpa.memoryTarget && hpa.currentMemory > hpa.memoryTarget ? 'text-error font-semibold' : 'text-on-surface'">{{ t('ns.hpaDetail.currentLabel') }}: <span class="font-bold">{{ hpa.currentMemory }}%</span></span>
                </div>
              </div>
              <ProgressBar :value="hpa.currentMemory" :max="100" color="secondary" size="md" />
            </div>
          </div>
        </div>
      </div>

      <!-- Right Sidebar -->
      <div class="lg:col-span-4 flex flex-col gap-lg">
        <!-- Summary -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('ns.hpaDetail.summary') }}</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('common.status') }}</span>
              <StatusChip :status="hpa.status" size="sm" />
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('common.namespace') }}</span>
              <span class="text-body-md font-medium text-primary">{{ hpa.namespace }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('common.age') }}</span>
              <span class="text-body-md text-on-surface">{{ hpa.age }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.minReplicas') }}</span>
              <span class="text-body-md font-semibold text-on-surface">{{ hpa.minReplicas }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.maxReplicas') }}</span>
              <span class="text-body-md font-semibold text-on-surface">{{ hpa.maxReplicas }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.currentReplicas') }}</span>
              <span class="text-body-md font-bold text-primary">{{ hpa.currentReplicas }}</span>
            </div>
          </div>
        </div>

        <!-- Scaling Info -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('ns.hpaDetail.scalingStatus') }}</h3>
          <div class="p-md rounded-lg" :class="hpa.status === 'Scaling' ? 'bg-tertiary-container/10 border border-tertiary-container/20' : 'bg-primary-container/10 border border-primary/20'">
            <div class="flex items-center gap-sm mb-xs">
              <span class="material-symbols-outlined text-lg" :class="hpa.status === 'Scaling' ? 'text-tertiary-container' : 'text-primary'">{{ hpa.status === 'Scaling' ? 'trending_up' : 'check_circle' }}</span>
              <span class="text-body-md font-semibold" :class="hpa.status === 'Scaling' ? 'text-tertiary-container' : 'text-primary'">{{ hpa.status === 'Scaling' ? t('ns.hpaDetail.scalingUp') : t('ns.hpaDetail.stable') }}</span>
            </div>
            <p class="text-body-sm text-on-surface-variant">{{ scalingDescription(hpa) }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Metrics Tab -->
    <div v-if="activeTab === 'metrics'" class="flex flex-col gap-md">
      <div class="flex items-center justify-between flex-wrap gap-x-sm gap-y-xs">
        <h3 class="text-headline-sm">{{ t('ns.hpaDetail.configuredMetrics') }}</h3>
        <span class="px-2.5 py-0.5 bg-surface-container text-label-caps text-on-surface-variant border border-outline-variant rounded">autoscaling/v2</span>
      </div>
      <DataTable :headers="metricHeaders" :rows="metricRows" row-key="_idx">
        <template #name="{ row }">
          <div class="flex items-center gap-sm min-w-0">
            <span class="material-symbols-outlined text-lg shrink-0" :class="row.iconClass">{{ row.icon }}</span>
            <span class="font-semibold text-on-surface text-body-md truncate">{{ row.name }}</span>
          </div>
        </template>
        <template #type>
          <span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">Resource</span>
        </template>
        <template #targetType>
          <span class="text-body-sm text-on-surface-variant">Utilization</span>
        </template>
        <template #targetValue="{ row }">
          <span class="font-mono text-code-sm font-semibold text-on-surface">{{ row.target }}%</span>
        </template>
        <template #currentValue="{ row }">
          <span class="font-mono text-code-sm" :class="row.above ? 'text-error font-semibold' : 'text-on-surface'">{{ row.current }}%</span>
        </template>
        <template #status="{ row }">
          <span class="px-2.5 py-0.5 rounded-full text-label-caps font-medium" :class="row.above ? 'bg-error-container/40 text-error' : 'bg-primary-container/20 text-primary'">{{ row.above ? t('ns.hpaDetail.aboveTarget') : t('ns.hpaDetail.withinTarget') }}</span>
        </template>
      </DataTable>

      <!-- Metrics Detail Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <div class="flex items-center gap-sm mb-md">
            <span class="material-symbols-outlined text-primary">memory</span>
            <h3 class="text-headline-sm">{{ t('ns.hpaDetail.cpuMetricDetail') }}</h3>
          </div>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.resourceName') }}</span>
              <span class="font-mono text-code-sm text-on-surface">cpu</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.metricType') }}</span>
              <span class="text-body-md text-on-surface">Resource</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.targetType') }}</span>
              <span class="text-body-md text-on-surface">Utilization</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.averageUtilization') }}</span>
              <span class="font-mono text-code-sm text-primary font-semibold">{{ hpa.cpuTarget }}%</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.currentUtilization') }}</span>
              <span class="font-mono text-code-sm" :class="hpa.currentCPU > hpa.cpuTarget ? 'text-error font-bold' : 'text-on-surface font-semibold'">{{ hpa.currentCPU }}%</span>
            </div>
          </div>
        </div>
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <div class="flex items-center gap-sm mb-md">
            <span class="material-symbols-outlined text-secondary">storage</span>
            <h3 class="text-headline-sm">{{ t('ns.hpaDetail.memoryMetricDetail') }}</h3>
          </div>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.resourceName') }}</span>
              <span class="font-mono text-code-sm text-on-surface">memory</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.metricType') }}</span>
              <span class="text-body-md text-on-surface">Resource</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.targetType') }}</span>
              <span class="text-body-md text-on-surface">Utilization</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.averageUtilization') }}</span>
              <span class="font-mono text-code-sm text-primary font-semibold">{{ hpa.memoryTarget || '-' }}%</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.hpaDetail.currentUtilization') }}</span>
              <span class="font-mono text-code-sm" :class="hpa.memoryTarget && hpa.currentMemory > hpa.memoryTarget ? 'text-error font-bold' : 'text-on-surface font-semibold'">{{ hpa.currentMemory }}%</span>
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

  <!-- Not Found -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">{{ t('common.notFound', { name: 'HPA' }) }}</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">{{ t('ns.hpaDetail.notFoundMsg', { name: route.params.name, namespace: route.params.namespace }) }}</p>
    <button @click="router.push({ name: 'NsHPA', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ t('common.backTo', { name: 'HPAs' }) }}</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="t('common.deleteTitle', { name: 'HPA' })" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('common.confirmDelete', { type: 'HorizontalPodAutoscaler', name: route.params.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.hpaDetail.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" :title="t('common.editTitle', { name: 'HPA' })" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.hpaDetail.minReplicas') }}</label>
          <input v-model.number="editForm.minReplicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.hpaDetail.maxReplicas') }}</label>
          <input v-model.number="editForm.maxReplicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.hpaDetail.cpuTargetPct') }}</label>
          <input v-model.number="editForm.cpuTarget" type="number" min="1" max="100" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.hpaDetail.memoryTargetPct') }}</label>
          <input v-model.number="editForm.memoryTarget" type="number" min="1" max="100" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="saveEdit" :disabled="editForm.minReplicas > editForm.maxReplicas" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('common.save') }}</button>
    </template>
  </Modal>
</template>
