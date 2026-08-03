<script setup>
// 集群活动记录：K8s 标准 API 不暴露「审计日志」（需集群开启 audit logging 并对接日志后端），
// 故此处如实以集群 Events 作为可用的活动记录展示，并标注数据来源。
import { ref, computed, onMounted } from 'vue'
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

onMounted(() => { if (store.remoteMode) store.startEventWatch() })
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: 'Cluster', route: '/cluster' },
      { label: 'Audit Logs' }
    ]" />

    <!-- 标题区 -->
    <div class="flex justify-between items-end mb-sm">
      <div>
        <h2 class="text-headline-sm text-on-surface">审计日志 <span class="text-on-surface-variant font-normal">· {{ stats.total }}</span></h2>
        <p class="text-on-surface-variant text-body-md mt-1">集群活动记录</p>
      </div>
      <span v-if="store.eventWatchLive" class="flex items-center gap-xs px-sm py-0 bg-primary-container/10 text-primary text-body-xs rounded-full">
        <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-status"></span>LIVE
      </span>
    </div>

    <!-- 数据来源说明 -->
    <div class="flex items-start gap-sm mb-lg p-md rounded-lg bg-tertiary-container/10 border border-tertiary-container/30">
      <span class="material-symbols-outlined text-tertiary-container text-lg shrink-0 mt-0.5">info</span>
      <p class="text-body-sm text-on-surface-variant">
        Kubernetes 标准 API 不直接暴露审计日志（需集群开启 <code class="font-mono text-code-sm bg-surface-container-low px-1 rounded">audit logging</code> 并对接日志后端）。
        此处如实以集群 <strong>Events</strong> 作为可用的活动记录展示——包含资源调度、扩缩容、镜像拉取、异常等事件。
      </p>
    </div>

    <!-- 统计卡片 -->
    <div class="grid grid-cols-3 gap-md mb-lg">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-md">
        <div class="flex items-center gap-sm text-on-surface-variant mb-xs">
          <span class="material-symbols-outlined text-lg">history</span>
          <span class="text-label-caps">事件总数</span>
        </div>
        <p class="text-headline-sm text-on-surface font-semibold">{{ stats.total }}</p>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-md">
        <div class="flex items-center gap-sm text-primary mb-xs">
          <span class="material-symbols-outlined text-lg">check_circle</span>
          <span class="text-label-caps">Normal</span>
        </div>
        <p class="text-headline-sm text-primary font-semibold">{{ stats.normal }}</p>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-md">
        <div class="flex items-center gap-sm text-tertiary-container mb-xs">
          <span class="material-symbols-outlined text-lg">warning</span>
          <span class="text-label-caps">Warning</span>
        </div>
        <p class="text-headline-sm text-tertiary-container font-semibold">{{ stats.warning }}</p>
      </div>
    </div>

    <!-- 筛选区 -->
    <div class="flex flex-wrap items-center gap-md mb-lg">
      <div class="flex gap-xs">
        <button v-for="opt in ['All', 'normal', 'warning']" :key="opt" @click="typeFilter = opt"
          class="px-md py-xs rounded-full text-body-sm font-medium border transition-all capitalize"
          :class="typeFilter === opt ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:border-primary'">
          {{ opt === 'All' ? '全部' : opt }}
        </button>
      </div>
      <div class="relative flex-1 min-w-[200px] max-w-md ml-auto">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" placeholder="搜索原因 / 消息 / 资源..." />
      </div>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ stats.total }}</span>
    </div>

    <!-- 日志表格 -->
    <div v-if="filtered.length" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant w-14">Type</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Reason</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Resource</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Namespace</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Message</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Time</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="(e, idx) in paginated" :key="idx" class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md">
                <div class="w-8 h-8 rounded-full flex items-center justify-center"
                  :class="e.color === 'error' ? 'bg-error-container text-on-error-container' : e.color === 'tertiary' ? 'bg-tertiary-container/20 text-tertiary-container' : e.color === 'primary' ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container text-on-surface-variant'">
                  <span class="material-symbols-outlined text-lg">{{ e.icon }}</span>
                </div>
              </td>
              <td class="px-lg py-md">
                <span class="font-semibold text-on-surface text-body-md">{{ e.reason }}</span>
                <span class="ml-sm px-2 py-0.5 rounded text-label-caps" :class="e.type === 'warning' ? 'bg-tertiary-container/10 text-tertiary-container' : 'bg-primary-container/10 text-primary'">{{ e.type }}</span>
              </td>
              <td class="px-lg py-md">
                <button v-if="e.relatedKind" @click="goToRelated(e)" class="font-mono text-code-sm text-primary hover:underline whitespace-nowrap">
                  {{ e.relatedKind }}/{{ e.relatedName }}
                </button>
                <span v-else class="text-on-surface-variant text-body-sm">—</span>
              </td>
              <td class="px-lg py-md">
                <span v-if="e.namespace" class="px-2 py-0.5 bg-surface-container rounded-full text-label-caps text-on-surface-variant border border-outline-variant">{{ e.namespace }}</span>
                <span v-else class="text-on-surface-variant text-body-sm">—</span>
              </td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant max-w-md">{{ e.message }}</td>
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant whitespace-nowrap">{{ e.time }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="total > pageSize" class="flex items-center justify-between px-lg py-md border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">manage_history</span>
      <p class="text-on-surface-variant mt-md">没有匹配的活动记录</p>
    </div>
  </section>
</template>
