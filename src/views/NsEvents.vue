<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const route = useRoute()
const store = useClusterStore()
const { t } = useI18n()
store.setNamespace(route.params.namespace)

const searchQuery = ref('')
const typeFilter = ref('All')

const filtered = computed(() => {
  let list = store.nsEvents
  if (typeFilter.value !== 'All') list = list.filter(e => e.type === typeFilter.value)
  const q = searchQuery.value.trim().toLowerCase()
  if (q) list = list.filter(e => (e.reason || '').toLowerCase().includes(q) || (e.message || '').toLowerCase().includes(q))
  return list
})

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [searchQuery, typeFilter] })

// 远端模式：无初始快照（且非水合中）时先拉一次 events 避免空表闪，再叠 watch；离开停止
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
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Events' }
    ]" />
    <div class="mt-sm mb-md">
      <h2 class="text-headline-md text-on-surface font-bold">{{ t('ns.events.title') }}</h2>
      <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('ns.events.subtitle', { ns: route.params.namespace }) }}</p>
    </div>

    <!-- 搜索 + 类型过滤 -->
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
      <span class="text-xs text-on-surface-variant">{{ filtered.length }} / {{ store.nsEvents.length }}</span>
      <span v-if="store.eventWatchLive" class="flex items-center gap-xs px-sm py-0 bg-primary-container/10 text-primary text-xs rounded-full" :title="t('ns.events.liveTitle')">
        <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-status"></span>{{ t('ns.events.liveStream') }}
      </span>
    </div>

    <div v-if="filtered.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <table class="w-full text-left">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant w-14">{{ t('ns.events.thType') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('ns.events.thReason') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('ns.events.thMessage') }}</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('ns.events.thTime') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/15">
          <tr v-for="(event, idx) in paginated" :key="idx" class="hover:bg-surface-container-low/40 transition-colors">
            <td class="px-md py-2">
              <div class="w-7 h-7 rounded-full flex items-center justify-center"
                :class="{
                  'bg-primary-container text-on-primary-container': event.color === 'primary',
                  'bg-tertiary-fixed-dim text-on-tertiary-fixed': event.color === 'tertiary',
                  'bg-error-container text-on-error-container': event.color === 'error',
                  'bg-surface-container text-on-surface-variant': event.color === 'surface',
                }">
                <span class="material-symbols-outlined text-sm">{{ event.icon }}</span>
              </div>
            </td>
            <td class="px-md py-2">
              <span class="font-semibold text-on-surface text-body-sm">{{ event.reason }}</span>
              <span class="ml-sm px-2 py-0.5 rounded text-xs" :class="event.type === 'warning' ? 'bg-tertiary-container/10 text-tertiary-container' : 'bg-primary-container/10 text-primary'">{{ event.type }}</span>
            </td>
            <td class="px-md py-2 text-body-sm text-on-surface-variant max-w-md">{{ event.message }}</td>
            <td class="px-md py-2 font-mono text-xs text-on-surface-variant whitespace-nowrap">{{ event.time }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="total > pageSize" class="flex items-center justify-between px-md py-2 border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>
    </div>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">event_available</span>
      <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('ns.events.empty') }}</p>
    </div>
  </section>
</template>
