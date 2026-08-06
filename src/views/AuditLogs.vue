<script setup>
// 集群活动记录：K8s 标准 API 不暴露「审计日志」（需集群开启 audit logging 并对接日志后端），
// 故此处如实以集群 Events 作为可用的活动记录展示，并标注数据来源。
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const store = useClusterStore()
const router = useRouter()

const typeFilter = ref('All')
const searchQuery = ref('')

const filtered = computed(() => {
  let list = store.eventList
  if (typeFilter.value !== 'All') list = list.filter(e => e.type === typeFilter.value)
  const q = searchQuery.value.trim().toLowerCase()
  if (q) list = list.filter(e =>
    (e.reason || '').toLowerCase().includes(q) ||
    (e.message || '').toLowerCase().includes(q) ||
    (e.relatedName || '').toLowerCase().includes(q))
  return list
})

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [typeFilter, searchQuery] })

const stats = computed(() => {
  const list = store.eventList
  return {
    total: list.length,
    normal: list.filter(e => e.type !== 'warning').length,
    warning: list.filter(e => e.type === 'warning').length,
  }
})

const WL = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']
function goToRelated(e) {
  if (!e.relatedKind || !e.relatedName) return
  const ns = e.relatedNamespace || e.namespace
  if (e.relatedKind === 'Pod') router.push({ name: 'NsPodDetail', params: { namespace: ns, name: e.relatedName } })
  else if (WL.includes(e.relatedKind)) router.push({ name: 'NsWorkloadDetail', params: { namespace: ns, type: e.relatedKind.toLowerCase(), name: e.relatedName } })
  else if (e.relatedKind === 'Service') router.push({ name: 'NsServiceDetail', params: { namespace: ns, name: e.relatedName } })
  else if (e.relatedKind === 'Node') router.push(`/nodes/${e.relatedName}`)
}

onMounted(async () => {
  if (!store.remoteMode) return
  if (!store.eventList.length && store.connectionState !== 'loading') await store.refreshEvents()
  store.startEventWatch()
})
onUnmounted(() => store.stopEventWatch())
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: 'Cluster', route: '/cluster' },
      { label: t('audit.title') }
    ]" />

    <!-- 标题区 -->
    <div class="flex justify-between items-end mb-sm">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ t('audit.title') }} <span class="text-on-surface-variant font-normal text-headline-md">· {{ stats.total }}</span></h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('audit.subtitle') }}</p>
      </div>
      <span v-if="store.eventWatchLive" class="flex items-center gap-xs px-sm py-0 bg-primary-container/10 text-primary text-xs rounded-full">
        <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-status"></span>{{ t('audit.live') }}
      </span>
    </div>

    <!-- 数据来源说明 -->
    <div class="flex items-start gap-sm mb-md p-md rounded-lg bg-tertiary-container/10 border border-tertiary-container/30">
      <span class="material-symbols-outlined text-tertiary-container text-base shrink-0 mt-0.5">info</span>
      <p class="text-xs text-on-surface-variant">
        {{ t('audit.dataSource') }}
      </p>
    </div>

    <!-- 统计卡片 -->
    <div class="grid grid-cols-3 gap-sm mb-md">
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md">
        <div class="flex items-center gap-sm text-on-surface-variant mb-xs">
          <span class="material-symbols-outlined text-base">history</span>
          <span class="text-xs">{{ t('audit.totalEvents') }}</span>
        </div>
        <p class="text-headline-md text-on-surface font-semibold">{{ stats.total }}</p>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md">
        <div class="flex items-center gap-sm text-primary mb-xs">
          <span class="material-symbols-outlined text-base">check_circle</span>
          <span class="text-xs">{{ t('audit.normal') }}</span>
        </div>
        <p class="text-headline-md text-primary font-semibold">{{ stats.normal }}</p>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md">
        <div class="flex items-center gap-sm text-tertiary-container mb-xs">
          <span class="material-symbols-outlined text-base">warning</span>
          <span class="text-xs">{{ t('audit.warning') }}</span>
        </div>
        <p class="text-headline-md text-tertiary-container font-semibold">{{ stats.warning }}</p>
      </div>
    </div>

    <!-- 筛选区 -->
    <div class="flex flex-wrap items-center gap-sm mb-md">
      <div class="flex gap-xs">
        <button v-for="opt in ['All', 'normal', 'warning']" :key="opt" @click="typeFilter = opt"
          class="px-md py-xs rounded-full text-xs font-medium border transition-all capitalize"
          :class="typeFilter === opt ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:border-primary'">
          {{ opt === 'All' ? t('audit.all') : opt }}
        </button>
      </div>
      <div class="relative flex-1 min-w-[200px] max-w-md ml-auto">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-base pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-sm focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" :placeholder="t('audit.searchPlaceholder')" />
      </div>
      <span class="text-xs text-on-surface-variant">{{ filtered.length }} / {{ stats.total }}</span>
    </div>

    <!-- 日志表格 -->
    <div v-if="filtered.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead>
            <tr class="bg-surface-container-low/50 border-b border-outline-variant">
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant w-14">{{ t('audit.type') }}</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('audit.reason') }}</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('audit.resource') }}</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('audit.namespace') }}</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('audit.message') }}</th>
              <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('audit.time') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/15">
            <tr v-for="(e, idx) in paginated" :key="idx" class="hover:bg-surface-container-low/40 transition-colors">
              <td class="px-md py-2">
                <div class="w-7 h-7 rounded-full flex items-center justify-center"
                  :class="e.color === 'error' ? 'bg-error-container text-on-error-container' : e.color === 'tertiary' ? 'bg-tertiary-container/20 text-tertiary-container' : e.color === 'primary' ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container text-on-surface-variant'">
                  <span class="material-symbols-outlined text-sm">{{ e.icon }}</span>
                </div>
              </td>
              <td class="px-md py-2">
                <span class="font-semibold text-on-surface text-body-sm">{{ e.reason }}</span>
                <span class="ml-sm px-2 py-0.5 rounded text-xs" :class="e.type === 'warning' ? 'bg-tertiary-container/10 text-tertiary-container' : 'bg-primary-container/10 text-primary'">{{ e.type }}</span>
              </td>
              <td class="px-md py-2">
                <button v-if="e.relatedKind" @click="goToRelated(e)" class="font-mono text-code-sm text-primary hover:underline whitespace-nowrap">
                  {{ e.relatedKind }}/{{ e.relatedName }}
                </button>
                <span v-else class="text-on-surface-variant text-xs">—</span>
              </td>
              <td class="px-md py-2">
                <span v-if="e.namespace" class="px-2 py-0.5 bg-surface-container rounded-full text-xs text-on-surface-variant border border-outline-variant">{{ e.namespace }}</span>
                <span v-else class="text-on-surface-variant text-xs">—</span>
              </td>
              <td class="px-md py-2 text-xs text-on-surface-variant max-w-md">{{ e.message }}</td>
              <td class="px-md py-2 font-mono text-code-sm text-on-surface-variant whitespace-nowrap">{{ e.time }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="total > pageSize" class="flex items-center justify-between px-md py-2 border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant py-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">manage_history</span>
      <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('audit.noRecords') }}</p>
    </div>
  </section>
</template>
