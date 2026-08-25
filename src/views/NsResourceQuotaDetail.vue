<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail } from '@/composables/useK8sQuery'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import { cpuToMilli, milliToCpu } from '@/composables/useResourceFormat'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const cid = computed(() => (store.currentCluster || 'cluster'))
const rqDetail = useResourceDetail({
  key: ['cluster', cid, 'resourcequotas', route.params.name],
  fetcher: () => store.fetchResourceQuota(route.params.name, route.params.namespace),
  options: { refetchInterval: 15000 },
})
const rq = computed(() => rqDetail.data.value)
const { yaml } = useLiveYaml({
  pathFn: () => `/api/v1/namespaces/${encodeURIComponent(route.params.namespace)}/resourcequotas/${encodeURIComponent(route.params.name)}`,
})

const activeTab = ref('overview')
const showDeleteModal = ref(false)
const showEditModal = ref(false)

// Edit form
const editForm = ref({
  cpuHard: '',
  memoryHard: '',
  podsHard: '',
  servicesHard: '',
  pvcHard: '',
  storageHard: '',
})

function openEditModal() {
  if (!rq.value) return
  editForm.value = {
    cpuHard: String(cpuToMilli(rq.value.hard?.['limits.cpu']) || ''),
    memoryHard: rq.value.hard?.['limits.memory'] || '',
    podsHard: rq.value.hard?.pods || '',
    servicesHard: rq.value.hard?.services || '',
    pvcHard: rq.value.hard?.persistentvolumeclaims || '',
    storageHard: rq.value.hard?.['requests.storage'] || '',
  }
  showEditModal.value = true
}

function handleEdit() {
  const f = editForm.value
  const hard = {}
  const used = { ...rq.value.used }
  if (f.cpuHard) hard['limits.cpu'] = milliToCpu(Number(f.cpuHard))
  if (f.memoryHard) hard['limits.memory'] = f.memoryHard
  if (f.podsHard) hard.pods = f.podsHard
  if (f.servicesHard) hard.services = f.servicesHard
  if (f.pvcHard) hard.persistentvolumeclaims = f.pvcHard
  if (f.storageHard) hard['requests.storage'] = f.storageHard
  store.updateResourceQuota(route.params.name, route.params.namespace, { hard, used })
  showEditModal.value = false
}

async function handleDelete() {
  await store.deleteResourceQuota(route.params.name, route.params.namespace)
  router.push({ name: 'NsResourceQuotas', params: { namespace: route.params.namespace } })
}

// Compute all hard/used entries for overview
// 按 quota key 选量值解析器:cpu→毫核(修 K8s 规范化后 cores/millicores 单位错配);其余 parseFloat
const parseQty = (key, val) => {
  if (key.endsWith('.cpu')) return cpuToMilli(val)
  const n = parseFloat(val)
  return isNaN(n) ? 0 : n
}

const quotaEntries = computed(() => {
  if (!rq.value) return []
  const hard = rq.value.hard || {}
  const used = rq.value.used || {}
  return Object.entries(hard).map(([key, hardVal]) => {
    const h = parseQty(key, hardVal)
    const u = parseQty(key, used[key] || '0')
    const percent = h ? Math.min(Math.round((u / h) * 100), 100) : 0
    return { key, hard: hardVal, used: used[key] || '0', percent }
  })
})

// Friendly names for quota keys (完整 i18n 键，便于静态门禁校验；未知 key 回退展示原始 K8s quota key)
const friendlyNameKeys = {
  'limits.cpu': 'ns.resourceQuotaDetail.quotaLimitsCpu',
  'limits.memory': 'ns.resourceQuotaDetail.quotaLimitsMemory',
  'requests.cpu': 'ns.resourceQuotaDetail.quotaRequestsCpu',
  'requests.memory': 'ns.resourceQuotaDetail.quotaRequestsMemory',
  'pods': 'ns.resourceQuotaDetail.quotaPods',
  'services': 'ns.resourceQuotaDetail.quotaServices',
  'persistentvolumeclaims': 'ns.resourceQuotaDetail.quotaPvc',
  'requests.storage': 'ns.resourceQuotaDetail.quotaStorageRequests',
  'replicationcontrollers': 'ns.resourceQuotaDetail.quotaReplicationControllers',
  'resourcequotas': 'ns.resourceQuotaDetail.quotaResourceQuotas',
  'secrets': 'ns.resourceQuotaDetail.quotaSecrets',
  'configmaps': 'ns.resourceQuotaDetail.quotaConfigMaps',
}

function friendlyName(key) {
  const k = friendlyNameKeys[key]
  return k ? t(k) : key
}

function parseNumeric(val) {
  if (!val) return 0
  const str = String(val)
  if (str.endsWith('Gi')) return parseFloat(str)
  if (str.endsWith('Mi')) return parseFloat(str) / 1024
  if (str.endsWith('Ki')) return parseFloat(str) / (1024 * 1024)
  if (str.endsWith('m')) return parseFloat(str) / 1000
  return parseFloat(str) || 0
}

function getPercent(used, hard) {
  const u = parseNumeric(used)
  const h = parseNumeric(hard)
  if (!h || h === 0) return 0
  return Math.min(Math.round((u / h) * 100), 100)
}
</script>

<template>
  <div class="animate-fade-in" v-if="rq">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'ResourceQuotas', route: `/ns/${route.params.namespace}/resourcequotas` },
      { label: route.params.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-tertiary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-tertiary text-3xl">speed</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ rq.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-tertiary-container/10 text-tertiary text-label-caps rounded-full font-medium">ResourceQuota</span>
            <span class="text-body-sm text-on-surface-variant">{{ t('ns.resourceQuotaDetail.resourcesTracked', { count: quotaEntries.length }) }}</span>
            <span class="text-body-sm text-on-surface-variant">{{ t('common.age') }}: {{ rq.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="openEditModal" class="flex items-center gap-sm px-md py-sm border border-outline-variant text-on-surface font-semibold rounded-lg hover:bg-surface-container-low transition-colors">
          <span class="material-symbols-outlined">edit</span> {{ t('common.edit') }}
        </button>
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> {{ t('common.delete') }}
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
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <h3 class="text-headline-sm">{{ t('ns.resourceQuotaDetail.resourceUsageCount', { count: quotaEntries.length }) }}</h3>
        </div>
        <div class="divide-y divide-outline-variant/30">
          <div v-for="entry in quotaEntries" :key="entry.key" class="px-lg py-md">
            <div class="flex items-center justify-between mb-xs">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-on-surface-variant text-lg">
                  {{ entry.key.includes('cpu') ? 'memory' : entry.key.includes('memory') ? 'memory_alt' : entry.key === 'pods' ? 'dataset' : entry.key === 'services' ? 'hub' : 'pie_chart' }}
                </span>
                <span class="font-medium text-on-surface text-body-md">{{ friendlyName(entry.key) }}</span>
                <span class="font-mono text-label-caps text-on-surface-variant">({{ entry.key }})</span>
              </div>
              <span class="font-semibold text-body-md" :class="entry.percent > 80 ? 'text-error' : entry.percent > 60 ? 'text-tertiary-container' : 'text-primary'">
                {{ entry.percent }}%
              </span>
            </div>
            <div class="flex items-center gap-md">
              <ProgressBar :value="entry.percent" size="md" class="flex-1" />
              <span class="text-body-sm text-on-surface-variant whitespace-nowrap min-w-[160px] text-right">
                {{ entry.used }} / {{ entry.hard }}
              </span>
            </div>
          </div>
          <div v-if="!quotaEntries.length" class="px-lg py-xl text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-3xl">speed</span>
            <p class="mt-sm">{{ t('ns.resourceQuotaDetail.noQuotaEntries') }}</p>
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
    <h2 class="text-headline-md text-on-surface mt-md">{{ t('common.notFound', { name: 'ResourceQuota' }) }}</h2>
    <button @click="router.push({ name: 'NsResourceQuotas', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ t('common.backTo', { name: 'ResourceQuotas' }) }}</button>
  </div>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" :title="t('common.editTitle', { name: 'ResourceQuota' })" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('common.cpu') }} {{ t('ns.resourceQuotaDetail.limitSuffix') }} <span class="text-on-surface-variant/60 text-xs normal-case font-normal ml-xs">{{ t('ns.resourceQuotaDetail.millicoresHint') }}</span></label>
          <input v-model="editForm.cpuHard" placeholder="20000" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('common.memory') }} {{ t('ns.resourceQuotaDetail.limitSuffix') }}</label>
          <input v-model="editForm.memoryHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.resourceQuotaDetail.podsLimit') }}</label>
          <input v-model="editForm.podsHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.resourceQuotaDetail.servicesLimit') }}</label>
          <input v-model="editForm.servicesHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.resourceQuotaDetail.pvcLimit') }}</label>
          <input v-model="editForm.pvcHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.resourceQuotaDetail.storageLimit') }}</label>
          <input v-model="editForm.storageHard" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.saveChanges') }}</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="t('common.deleteTitle', { name: 'ResourceQuota' })" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('common.confirmDelete', { type: 'ResourceQuota', name: route.params.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.resourceQuotaDetail.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>
</template>
