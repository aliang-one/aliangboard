<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'
import { notify } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()

// Namespace 详情 + 关联 services/workloads 走 Vue Query。
const cid = computed(() => (store.currentCluster || 'cluster'))
const nsName = computed(() => route.params.name)

// 进入该命名空间：切换 currentNamespace 并跳转其 overview（复用 SideNavBar 切换模式）
function enterNamespace() {
  store.setNamespace(nsName.value)
  router.push({ name: 'NamespaceOverview', params: { namespace: nsName.value } })
}
const nsDetail = useResourceDetail({
  key: ['cluster', cid, 'namespaces', nsName],
  fetcher: () => store.fetchNamespace(nsName.value),
  options: { enabled: Boolean(nsName.value) },
})
const ns = computed(() => nsDetail.data.value)

const servicesQuery = useResourceList({
  key: ['cluster', cid, 'services'],
  fetcher: () => store.fetchServices(),
  select: (list) => (list || []).filter(s => s.namespace === nsName.value),
})
const nsServices = computed(() => servicesQuery.data.value || [])

const workloadsQuery = useResourceList({
  key: ['cluster', cid, 'workloads'],
  fetcher: () => store.fetchWorkloads(),
  select: (list) => (list || []).filter(w => w.namespace === nsName.value),
})
const nsWorkloads = computed(() => workloadsQuery.data.value || [])

const syncing = computed(() => nsDetail.isFetching.value || servicesQuery.isFetching.value || workloadsQuery.isFetching.value)
async function sync() {
  try {
    store.invalidateAllClusterQueries()
    notify('success', t('ns.nsDetail.syncSuccess'))
  }
  catch (e) { notify('error', t('ns.nsDetail.syncFailed', { error: e.message || '' })) }
}
</script>

<template>
  <div class="animate-fade-in" v-if="ns">
    <div class="flex flex-col md:flex-row md:items-end justify-between mb-md gap-sm">
      <div>
        <Breadcrumbs :items="[
          { label: 'Namespaces', route: '/namespaces' },
          { label: ns.name }
        ]" />
        <div class="flex items-center gap-xs mt-xs">
          <span class="material-symbols-outlined text-base text-on-surface-variant">folder_open</span>
          <span class="text-xs text-on-surface-variant uppercase tracking-wider">{{ t('ns.nsDetail.namespaceExplorer') }}</span>
        </div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ t('ns.nsDetail.namespaceLabel') }}: <span class="text-primary">{{ ns.name }}</span></h2>
      </div>
      <div class="flex gap-sm">
        <button @click="enterNamespace" class="px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity flex items-center gap-xs">
          <span class="material-symbols-outlined text-base">login</span> {{ t('ns.nsDetail.enterNamespace') }}
        </button>
        <button @click="sync" :disabled="syncing" class="px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors flex items-center gap-xs disabled:opacity-50">
          <span class="material-symbols-outlined text-base" :class="syncing ? 'animate-spin' : ''">{{ syncing ? 'progress_activity' : 'refresh' }}</span> {{ syncing ? t('ns.nsDetail.syncing') : t('ns.nsDetail.sync') }}
        </button>
      </div>
    </div>

    <div class="grid grid-cols-12 gap-md">
      <!-- Resource Quotas -->
      <section class="col-span-12 lg:col-span-4 rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
        <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary text-lg">analytics</span>
          <span class="text-body-sm font-semibold">{{ t('ns.nsDetail.resourceQuotas') }}</span>
        </div>
        <div class="p-md space-y-md">
          <div>
            <ProgressBar :value="62" show-label :label="t('ns.nsDetail.cpuUsage')" />
            <p class="font-mono text-xs text-on-surface-variant mt-1">7.4 / 12 Cores</p>
          </div>
          <div>
            <ProgressBar :value="75" show-label :label="t('ns.nsDetail.memoryUsage')" color="primary" />
            <p class="font-mono text-xs text-on-surface-variant mt-1">24.1 / 32 GiB</p>
          </div>
          <div class="grid grid-cols-2 gap-md pt-sm border-t border-outline-variant/40">
            <div>
              <p class="text-on-surface-variant text-xs mb-xs">{{ t('ns.nsDetail.pods') }}</p>
              <p class="text-body-md font-semibold">{{ ns.pods }} / 50</p>
            </div>
            <div>
              <p class="text-on-surface-variant text-xs mb-xs">{{ t('ns.nsDetail.services') }}</p>
              <p class="text-body-md font-semibold">{{ ns.services }} / 20</p>
            </div>
          </div>
        </div>
      </section>

      <!-- Distribution Map -->
      <section class="col-span-12 lg:col-span-8 rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
        <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary text-lg">grid_view</span>
          <span class="text-body-sm font-semibold">{{ t('ns.nsDetail.workloadDistribution') }}</span>
          <span class="ml-auto flex items-center gap-xs text-xs px-sm py-0.5 bg-primary/10 text-primary rounded">
            <span class="w-1.5 h-1.5 bg-primary rounded-full animate-pulse-status"></span> {{ t('ns.nsDetail.healthy') }}
          </span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-md p-md">
          <div
            v-for="group in [
              { name: 'Deployments', icon: 'layers', items: nsWorkloads.filter(w => w.type === 'Deployment').slice(0, 6) },
              { name: 'StatefulSets', icon: 'storage', items: nsWorkloads.filter(w => w.type === 'StatefulSet').slice(0, 6) },
              { name: 'DaemonSets', icon: 'settings_slow_motion', items: nsWorkloads.filter(w => w.type === 'DaemonSet').slice(0, 6) },
            ]"
            :key="group.name"
            class="p-sm rounded-lg border border-outline-variant bg-surface-container-low hover:border-primary transition-colors"
          >
            <div class="flex items-center justify-between mb-sm">
              <span class="text-xs uppercase text-on-surface-variant">{{ group.name }}</span>
              <span class="material-symbols-outlined text-base">{{ group.icon }}</span>
            </div>
            <div class="grid grid-cols-3 gap-xs">
              <div
                v-for="(item, idx) in group.items.length ? group.items : [{ status: 'empty' }]"
                :key="idx"
                class="w-full aspect-square rounded-sm border"
                :class="item.status === 'Running' ? 'bg-primary/20 border-primary/40' : item.status === 'Pending' ? 'bg-tertiary-container/20 border-tertiary-container/40' : item.status === 'Failed' ? 'bg-error/20 border-error/40' : 'bg-surface-container border-outline-variant'"
              >
                <span v-if="item.status === 'Failed'" class="absolute -top-1 -right-1 w-2 h-2 bg-error rounded-full relative float-right"></span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Workloads Table -->
      <section class="col-span-12 rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
        <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary text-lg">view_in_ar</span>
          <span class="text-body-sm font-semibold">{{ t('ns.nsDetail.workloads') }}</span>
          <span class="text-xs text-on-surface-variant ml-auto">{{ nsWorkloads.length }}</span>
        </div>
        <table class="w-full text-left">
          <thead>
            <tr class="bg-surface-container-low/50 border-b border-outline-variant">
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('ns.nsDetail.name') }}</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('ns.nsDetail.type') }}</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('ns.nsDetail.status') }}</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('ns.nsDetail.replicas') }}</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('ns.nsDetail.age') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/15">
            <tr v-for="w in nsWorkloads" :key="w.name" class="hover:bg-surface-container-low/40 cursor-pointer" @click="router.push({ name: 'NsWorkloadDetail', params: { namespace: route.params.name, type: w.type.toLowerCase(), name: w.name } })">
              <td class="px-md py-2 font-semibold text-on-surface text-body-sm">{{ w.name }}</td>
              <td class="px-md py-2 text-xs text-on-surface-variant">{{ w.type }}</td>
              <td class="px-md py-2"><StatusChip :status="w.status" size="sm" /></td>
              <td class="px-md py-2 font-mono text-xs">{{ w.replicas }}</td>
              <td class="px-md py-2 text-xs text-on-surface-variant">{{ w.age }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>
