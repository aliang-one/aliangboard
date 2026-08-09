<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useI18n } from 'vue-i18n'
import { notify } from '@/composables/useToast'
import { useResourceList } from '@/composables/useK8sQuery'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import LabelChips from '@/components/common/LabelChips.vue'
import EventList from '@/components/common/EventList.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useClusterStore()

// 服务端状态归 Vue Query：workloads/pods/events 三查询，与列表页同源缓存。
const cid = computed(() => (store.currentCluster || 'cluster'))
const workloadsQuery = useResourceList({
  key: ['cluster', cid.value, 'workloads'],
  fetcher: () => store.fetchWorkloads(),
  options: { refetchInterval: 30000 },
})
const podsQuery = useResourceList({
  key: ['cluster', cid.value, 'pods'],
  fetcher: () => store.fetchPods(),
  select: list => list.filter(p => p.namespace === route.params.namespace),
})
const workload = computed(() => (workloadsQuery.data.value || []).find(
  (w) => w.name === route.params.name && w.type?.toLowerCase() === route.params.type
))
const pod = computed(() => (podsQuery.data.value || []).find((p) => p.name === route.params.name))
const displayData = computed(() => pod.value || workload.value)
const eventsQuery = useResourceList({
  key: ['cluster', cid.value, 'events'],
  fetcher: () => store.fetchEvents(),
  select: list => list.filter(e => e.namespace === route.params.namespace),
})
const nsPods = computed(() => podsQuery.data.value || [])
const nsEvents = computed(() => eventsQuery.data.value || [])

async function handleDelete() {
  if (!workload.value) { notify('error', t('workloadDetail.deleteSuccess')); return }
  try { await store.deleteWorkload(workload.value.name, workload.value.namespace); router.push('/workloads') }
  catch (e) { notify('error', e.message || t('workloadDetail.deleteFailed')) }
}
async function handleRestart() {
  if (!workload.value) { notify('error', t('workloadDetail.deleteSuccess')); return }
  try { await store.restartWorkload(workload.value.name, workload.value.namespace); notify('success', t('workloadDetail.restartSuccess')) }
  catch (e) { notify('error', e.message || t('workloadDetail.restartFailed')) }
}
</script>

<template>
  <div class="animate-fade-in" v-if="displayData">
    <!-- Header -->
    <div class="mb-lg flex items-center justify-between">
      <div class="flex flex-col">
        <Breadcrumbs :items="[
          { label: t('workloadDetail.workloads'), route: '/workloads' },
          { label: displayData.type || t('workloadDetail.detail') },
          { label: displayData.name }
        ]" />
        <div class="flex items-center gap-3 mt-2">
          <div class="w-3 h-3 rounded-full bg-primary-container animate-pulse-status"></div>
          <h2 class="text-display-lg">{{ displayData.name }}</h2>
          <StatusChip :status="displayData.status" />
        </div>
      </div>
      <div class="flex gap-2">
        <button @click="handleDelete" class="flex items-center gap-2 px-md py-2 border border-outline-variant rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-error">delete</span>
          <span class="font-medium text-body-md">{{ t('workloadDetail.delete') }}</span>
        </button>
        <button @click="handleRestart" class="flex items-center gap-2 px-md py-2 bg-primary text-on-primary rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined">refresh</span>
          <span class="font-medium text-body-md">{{ t('workloadDetail.restart') }}</span>
        </button>
      </div>
    </div>

    <!-- Detail Cards -->
    <div class="grid grid-cols-12 gap-gutter">
      <!-- Main Info -->
      <div class="col-span-12 lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">{{ t('workloadDetail.overview') }}</h3>
          <div class="grid grid-cols-2 gap-lg">
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('workloadDetail.typeLabel') }}</p>
              <p class="text-body-lg font-medium">{{ displayData.type }}</p>
            </div>
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('workloadDetail.namespaceLabel') }}</p>
              <p class="text-body-lg font-medium">{{ displayData.namespace }}</p>
            </div>
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('workloadDetail.imageLabel') }}</p>
              <p class="font-mono text-code-sm text-primary">{{ displayData.image }}</p>
            </div>
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('workloadDetail.ageLabel') }}</p>
              <p class="text-body-lg font-medium">{{ displayData.age }}</p>
            </div>
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('workloadDetail.replicasLabel') }}</p>
              <p class="text-body-lg font-medium">{{ displayData.replicas }}</p>
            </div>
            <div>
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('workloadDetail.revisionLabel') }}</p>
              <p class="font-mono text-code-sm">{{ displayData.sha }}</p>
            </div>
          </div>
        </div>

        <!-- Managed Pods -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
          <div class="p-lg pb-md">
            <h3 class="text-headline-sm">{{ t('workloadDetail.managedPods') }}</h3>
          </div>
          <table class="w-full text-left">
            <thead>
              <tr class="bg-surface-container-low border-y border-outline-variant">
                <th class="px-lg py-md text-label-caps text-on-surface-variant">{{ t('workloadDetail.thName') }}</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">{{ t('workloadDetail.thStatus') }}</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">{{ t('workloadDetail.thRestarts') }}</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">{{ t('workloadDetail.thNode') }}</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">{{ t('workloadDetail.thAge') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/30">
              <tr v-for="(p, idx) in nsPods.slice(0, 4)" :key="idx" class="hover:bg-surface-container-low/50 cursor-pointer" @click="$router.push({ name: 'NsPodDetail', params: { namespace: p.namespace, name: p.name } })">
                <td class="px-lg py-md">
                  <span class="font-mono text-code-sm font-medium text-on-surface">{{ p.name }}</span>
                </td>
                <td class="px-lg py-md"><StatusChip :status="p.status" size="sm" /></td>
                <td class="px-lg py-md text-body-sm">{{ p.restarts }}</td>
                <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ p.node || '-' }}</td>
                <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ p.age }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Sidebar -->
      <div class="col-span-12 lg:col-span-4 flex flex-col gap-lg">
        <!-- Labels -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('workloadDetail.labels') }}</h3>
          <LabelChips :labels="displayData.labels || {}" />
        </div>
        <!-- Events -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('workloadDetail.events') }}</h3>
          <div class="flex flex-col gap-md">
            <EventList :events="nsEvents" :max="4" compact />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
