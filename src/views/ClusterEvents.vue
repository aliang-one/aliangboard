<script setup>
// 集群级事件页:ClusterOverview「查看全部事件」入口的落点。
// 与 NsEvents 共用同一份全集群 events 查询缓存,但不做 namespace 过滤——
// 全量即视图;多一列 Namespace 标明事件来源(全集群视图必须可见)。
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useTableColumns } from '@/composables/useTableColumns'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DataTable from '@/components/common/DataTable.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'
import { useResourceList } from '@/composables/useK8sQuery'

const store = useClusterStore()
const { t } = useI18n()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('clusterEvents'))

const cid = computed(() => (store.currentCluster || 'cluster'))
const eventsQuery = useResourceList({
  key: ['cluster', cid, 'events'],
  fetcher: () => store.fetchEvents(),
})
const allEvents = computed(() => eventsQuery.data.value || [])

const searchQuery = ref('')
const typeFilter = ref('All')

const filtered = computed(() => {
  let list = allEvents.value
  if (typeFilter.value !== 'All') list = list.filter(e => e.type === typeFilter.value)
  const q = searchQuery.value.trim().toLowerCase()
  if (q) list = list.filter(e => (e.reason || '').toLowerCase().includes(q) || (e.message || '').toLowerCase().includes(q))
  return list
})

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [searchQuery, typeFilter] })

// eventsQuery 挂载即自取（Vue Query enabled 默认 true）；watch 桥接已写回 Query 缓存，
// 此处只负责启停 live watch。
onMounted(() => store.startEventWatch())
onUnmounted(() => store.stopEventWatch())
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[{ label: $t('nav.events') }]" />
    <div class="mt-sm mb-md">
      <h2 class="text-headline-md text-on-surface font-bold">{{ t('ns.events.title') }}</h2>
      <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('cluster.events.subtitle') }}</p>
    </div>

    <!-- 类型过滤 + 搜索 -->
    <div class="flex flex-wrap items-center gap-sm mb-md">
      <div class="flex gap-xs">
        <button v-for="opt in ['All', 'normal', 'warning']" :key="opt" @click="typeFilter = opt"
          class="px-md py-xs rounded-full text-xs font-medium border transition-all capitalize"
          :class="typeFilter === opt ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:border-primary'">
          {{ opt === 'All' ? t('ns.events.filterAll') : opt }}
        </button>
      </div>
      <div class="relative flex-1 min-w-[200px] max-w-md ml-auto">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-1.5 text-body-sm focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" :placeholder="t('ns.events.searchPlaceholder')" />
      </div>
      <span class="text-xs text-on-surface-variant">{{ filtered.length }} / {{ allEvents.length }}</span>
      <span v-if="store.eventWatchLive" class="flex items-center gap-xs px-sm py-0 bg-primary-container/10 text-primary text-xs rounded-full" :title="t('ns.events.liveTitle')">
        <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-status"></span>{{ t('ns.events.liveStream') }}
      </span>
    </div>

    <DataTable :headers="headers" :rows="paginated" column-key="clusterEvents">
      <template #type="{ row }">
        <div class="w-7 h-7 rounded-full flex items-center justify-center"
          :class="{
            'bg-primary-container text-on-primary-container': row.color === 'primary',
            'bg-tertiary-fixed-dim text-on-tertiary-fixed': row.color === 'tertiary',
            'bg-error-container text-on-error-container': row.color === 'error',
            'bg-surface-container text-on-surface-variant': row.color === 'surface',
          }">
          <span class="material-symbols-outlined text-sm">{{ row.icon }}</span>
        </div>
      </template>
      <template #reason="{ row }">
        <span class="font-semibold text-on-surface text-body-sm">{{ row.reason }}</span>
        <span class="ml-sm px-2 py-0.5 rounded text-xs" :class="row.type === 'warning' ? 'bg-tertiary-container/10 text-tertiary-container' : 'bg-primary-container/10 text-primary'">{{ row.type }}</span>
      </template>
      <template #message="{ row }"><span class="text-body-sm text-on-surface-variant max-w-md">{{ row.message }}</span></template>
      <template #namespace="{ row }">
        <span class="font-mono text-xs text-on-surface-variant" :data-testid="`ev-ns-${row.uid}`">{{ row.namespace }}</span>
      </template>
      <template #time="{ row }"><span class="font-mono text-xs text-on-surface-variant whitespace-nowrap">{{ row.time }}</span></template>
      <template v-if="filtered.length" #pagination>
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>
</template>
