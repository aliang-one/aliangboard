<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { useRouter } from 'vue-router'
import MiniChart from '@/components/common/MiniChart.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import StatusChip from '@/components/common/StatusChip.vue'

const store = useClusterStore()
const router = useRouter()

// 实时轮询：每 10s 刷新 metrics + 收集集群 CPU/内存到 30 样本滚动窗口（≈5min）喂 MiniChart
const cpuSeries = ref([])
const memSeries = ref([])
const lastRefresh = ref('')
const sampling = ref(false)
let timer = null
const MAX = 30
async function tick() {
  sampling.value = true
  try {
    await store.refreshMetrics()
    const cpu = store.cluster.cpuUsage
    const mem = store.cluster.memoryUsage
    if (cpu != null) cpuSeries.value = [...cpuSeries.value, cpu].slice(-MAX)
    if (mem != null) memSeries.value = [...memSeries.value, mem].slice(-MAX)
    lastRefresh.value = new Date().toLocaleTimeString()
  } finally { sampling.value = false }
}
onMounted(() => { tick(); timer = setInterval(tick, 10000); store.startEventWatch() })
onUnmounted(() => { if (timer) clearInterval(timer); store.stopEventWatch() })

// KPI 派生
const readyNodes = computed(() => store.nodeList.filter(n => n.status === 'Ready').length)
const failedPods = computed(() => store.podList.filter(p => p.status === 'Failed').length)
const warningEvents = computed(() => store.eventList.filter(e => e.type === 'warning').length)   // mapEvent 把 type 小写化为 normal|warning

// Top Pods（tab 切换 CPU/内存）
const topMetric = ref('cpu')
const topPods = computed(() => {
  const key = topMetric.value === 'cpu' ? 'usedCpu' : 'usedMem'
  return [...store.podList]
    .filter(p => p[key] != null && p[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .slice(0, 10)
})

// 事件流（集群级，warning 过滤）
const eventFilter = ref('all')   // all | warning
const recentEvents = computed(() => {
  const list = store.eventList
  const filtered = eventFilter.value === 'warning' ? list.filter(e => e.type === 'warning') : list   // type 小写
  return filtered.slice(0, 50)
})
// 告警面板
const highCpuNodes = computed(() => store.nodeList.filter(n => n.cpu != null && n.cpu >= 80))
const notReadyWorkloads = computed(() => store.workloadList.filter(w => w.status !== 'Running'))
</script>

<template>
  <section class="animate-fade-in">
    <!-- Header -->
    <div class="flex items-end justify-between mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary">monitoring</span> {{ t('monitoring.title') }}
          <span class="inline-flex items-center gap-0.5 px-2 py-0.5 bg-error/10 text-error text-xs rounded-full font-medium"><span class="w-1.5 h-1.5 rounded-full bg-error animate-pulse"></span>{{ t('monitoring.live') }}</span>
        </h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('monitoring.subtitle') }} {{ lastRefresh || '—' }}</p>
      </div>
      <button @click="tick" :disabled="sampling" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant rounded-lg hover:bg-surface-container-low disabled:opacity-40">
        <span class="material-symbols-outlined text-base" :class="sampling ? 'animate-spin' : ''">refresh</span> {{ t('monitoring.refresh') }}
      </button>
    </div>

    <!-- 未连接 / 指标不可用 提示 -->
    <div v-if="!store.remoteMode" class="rounded-lg border border-outline-variant bg-surface-container-low p-md text-on-surface-variant text-body-sm mb-md">{{ t('monitoring.notConnected') }}</div>
    <div v-else-if="!store.cluster.metricsAvailable" class="rounded-lg border border-tertiary-container/40 bg-tertiary-container/10 p-md text-on-surface-variant text-body-sm mb-md flex items-center gap-sm">
      <span class="material-symbols-outlined text-base">warning</span> {{ t('monitoring.metricsNotReady') }}
    </div>

    <!-- KPI 卡 -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-sm mb-md">
      <!-- CPU -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <p class="text-label-caps text-on-surface-variant">{{ t('monitoring.clusterCpu') }}</p>
        <div class="flex items-end gap-xs mt-xs">
          <span class="text-display-md font-bold text-primary">{{ store.cluster.cpuUsage == null ? '—' : store.cluster.cpuUsage + '%' }}</span>
          <span v-if="store.cluster.cpuTrendUp != null" class="text-xs mb-xs" :class="store.cluster.cpuTrendUp ? 'text-error' : 'text-tertiary-container'">{{ store.cluster.cpuTrend }}</span>
        </div>
        <MiniChart :series="cpuSeries" color="var(--md-sys-color-primary)" :height="48" />
      </div>
      <!-- 内存 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <p class="text-label-caps text-on-surface-variant">{{ t('monitoring.clusterMemory') }}</p>
        <div class="flex items-end gap-xs mt-xs">
          <span class="text-display-md font-bold text-tertiary-container">{{ store.cluster.memoryUsage == null ? '—' : store.cluster.memoryUsage + '%' }}</span>
          <span v-if="store.cluster.memoryTrendUp != null" class="text-xs mb-xs" :class="store.cluster.memoryTrendUp ? 'text-error' : 'text-tertiary-container'">{{ store.cluster.memoryTrend }}</span>
        </div>
        <MiniChart :series="memSeries" color="var(--md-sys-color-tertiary-container)" :height="48" />
      </div>
      <!-- 节点健康 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <p class="text-label-caps text-on-surface-variant">{{ t('monitoring.nodeHealth') }}</p>
        <div class="flex items-end gap-xs mt-xs">
          <span class="text-display-md font-bold" :class="readyNodes === store.nodeList.length ? 'text-tertiary-container' : 'text-error'">{{ readyNodes }}/{{ store.nodeList.length }}</span>
        </div>
        <p class="text-xs text-on-surface-variant mt-sm">{{ t('monitoring.readyNodes') }}</p>
      </div>
      <!-- 异常计数 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <p class="text-label-caps text-on-surface-variant">{{ t('monitoring.abnormal') }}</p>
        <div class="flex items-end gap-xs mt-xs">
          <span class="text-display-md font-bold" :class="(failedPods + warningEvents) > 0 ? 'text-error' : 'text-tertiary-container'">{{ failedPods + warningEvents }}</span>
        </div>
        <p class="text-xs text-on-surface-variant mt-sm">{{ failedPods }} {{ t('monitoring.failedPods') }} · {{ warningEvents }} {{ t('monitoring.warningEvents') }}</p>
      </div>
    </div>

    <!-- 节点健康网格 -->
    <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md mb-md">
      <h3 class="text-body-sm font-semibold mb-sm flex items-center gap-xs"><span class="material-symbols-outlined text-primary text-base">dns</span> {{ t('monitoring.nodeHealth') }}</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-sm">
        <button v-for="n in store.nodeList" :key="n.name" @click="router.push({ name: 'NodeDetail', params: { name: n.name } })" class="text-left rounded-lg border border-outline-variant/60 p-sm hover:border-primary hover:bg-primary-container/5 transition-colors">
          <div class="flex items-center justify-between gap-xs mb-xs">
            <span class="font-mono text-body-sm text-on-surface truncate">{{ n.name }}</span>
            <StatusChip :status="n.status" size="sm" />
          </div>
          <div class="flex items-center gap-xs text-xs text-on-surface-variant mb-0.5"><span class="w-10">CPU</span><ProgressBar :value="n.cpu || 0" class="flex-1" /></div>
          <div class="flex items-center gap-xs text-xs text-on-surface-variant"><span class="w-10">Mem</span><ProgressBar :value="n.memory || 0" class="flex-1" /></div>
        </button>
      </div>
      <p v-if="!store.nodeList.length" class="text-center text-on-surface-variant text-body-sm py-md">{{ t('monitoring.noNodes') }}</p>
    </div>

    <!-- Top Pods -->
    <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
      <div class="flex items-center justify-between mb-sm">
        <h3 class="text-body-sm font-semibold flex items-center gap-xs"><span class="material-symbols-outlined text-primary text-base">trending_up</span> {{ t('monitoring.topPods') }}</h3>
        <div class="flex gap-xs">
          <button @click="topMetric = 'cpu'" class="px-2 py-0.5 text-xs rounded" :class="topMetric === 'cpu' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'">{{ t('monitoring.cpuTab') }}</button>
          <button @click="topMetric = 'mem'" class="px-2 py-0.5 text-xs rounded" :class="topMetric === 'mem' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'">{{ t('monitoring.memoryTab') }}</button>
        </div>
      </div>
      <div v-if="topPods.length" class="divide-y divide-outline-variant/20">
        <button v-for="(p, i) in topPods" :key="p.namespace + '/' + p.name" @click="router.push({ name: 'PodDetail', params: { namespace: p.namespace, name: p.name } })" class="w-full flex items-center gap-sm py-1.5 hover:bg-surface-container-low rounded px-sm text-left">
          <span class="text-xs text-on-surface-variant w-6">{{ i + 1 }}</span>
          <span class="font-mono text-body-sm text-on-surface flex-1 truncate">{{ p.name }}</span>
          <span class="text-xs text-on-surface-variant">{{ p.namespace }}</span>
          <span class="font-mono text-xs text-primary font-medium">{{ topMetric === 'cpu' ? (p.usedCpu + 'm') : (Math.round(p.usedMem / 1024) + 'Mi') }}</span>
        </button>
      </div>
      <p v-else class="text-center text-on-surface-variant text-body-sm py-md">{{ t('monitoring.noPodUsage') }}</p>
    </div>

    <!-- 事件流 + 告警（两列）-->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-sm mt-md">
      <!-- 事件流 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <div class="flex items-center justify-between mb-sm">
          <h3 class="text-body-sm font-semibold flex items-center gap-xs"><span class="material-symbols-outlined text-primary text-base">notifications_active</span> {{ t('monitoring.eventStream') }} <span class="text-xs text-on-surface-variant font-normal">{{ t('monitoring.clusterLevel') }}</span></h3>
          <div class="flex gap-xs">
            <button @click="eventFilter = 'all'" class="px-2 py-0.5 text-xs rounded" :class="eventFilter === 'all' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'">{{ t('monitoring.all') }}</button>
            <button @click="eventFilter = 'warning'" class="px-2 py-0.5 text-xs rounded" :class="eventFilter === 'warning' ? 'bg-error text-on-error' : 'text-on-surface-variant hover:bg-surface-container-low'">{{ t('monitoring.warning') }}</button>
          </div>
        </div>
        <div class="flex flex-col gap-xs max-h-96 overflow-y-auto">
          <div v-for="(e, i) in recentEvents" :key="e.uid || i" class="flex items-start gap-sm p-xs rounded" :class="e.type === 'warning' ? 'bg-error/5' : ''">
            <span class="material-symbols-outlined text-base shrink-0" :class="e.type === 'warning' ? 'text-error' : 'text-on-surface-variant'">{{ e.icon }}</span>
            <div class="min-w-0 flex-1">
              <p class="text-body-sm text-on-surface truncate"><span class="font-mono text-primary">{{ e.relatedName || '—' }}</span> {{ e.reason || e.message }}</p>
              <p class="text-xs text-on-surface-variant">{{ e.relatedKind || e.type }} · {{ e.namespace || '—' }} · {{ e.age }}</p>
            </div>
          </div>
          <p v-if="!recentEvents.length" class="text-center text-on-surface-variant text-body-sm py-md">{{ t('monitoring.noEvents') }}</p>
        </div>
      </div>

      <!-- 告警面板 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
        <h3 class="text-body-sm font-semibold mb-sm flex items-center gap-xs"><span class="material-symbols-outlined text-error text-base">crisis_alert</span> {{ t('monitoring.alerts') }}</h3>
        <div class="flex flex-col gap-sm">
          <div v-if="highCpuNodes.length">
            <p class="text-xs text-on-surface-variant mb-xs">{{ t('monitoring.highCpuNodes') }}</p>
            <button v-for="n in highCpuNodes" :key="n.name" @click="router.push({ name: 'NodeDetail', params: { name: n.name } })" class="w-full flex items-center justify-between px-sm py-1 bg-error/5 rounded hover:bg-error/10">
              <span class="font-mono text-body-sm text-on-surface">{{ n.name }}</span><span class="text-xs text-error font-medium">{{ n.cpu }}%</span>
            </button>
          </div>
          <div v-if="failedPods">
            <p class="text-xs text-on-surface-variant mb-xs">{{ t('monitoring.failedPodsLabel') }}（{{ failedPods }}）</p>
            <button v-for="p in store.podList.filter(p => p.status === 'Failed').slice(0, 5)" :key="p.namespace + '/' + p.name" @click="router.push({ name: 'PodDetail', params: { namespace: p.namespace, name: p.name } })" class="w-full flex items-center justify-between px-sm py-1 bg-error/5 rounded hover:bg-error/10">
              <span class="font-mono text-body-sm text-on-surface truncate">{{ p.name }}</span><span class="text-xs text-on-surface-variant">{{ p.namespace }}</span>
            </button>
          </div>
          <div v-if="notReadyWorkloads.length">
            <p class="text-xs text-on-surface-variant mb-xs">{{ t('monitoring.notReadyWorkloads') }}（{{ notReadyWorkloads.length }}）</p>
            <button v-for="w in notReadyWorkloads.slice(0, 5)" :key="w.namespace + '/' + w.name" @click="router.push({ name: 'WorkloadDetail', params: { type: w.type, name: w.name } })" class="w-full flex items-center justify-between px-sm py-1 bg-error/5 rounded hover:bg-error/10">
              <span class="font-mono text-body-sm text-on-surface truncate">{{ w.name }}</span><span class="text-xs text-on-surface-variant">{{ w.type }} · {{ w.replicas }}</span>
            </button>
          </div>
          <p v-if="!highCpuNodes.length && !failedPods && !notReadyWorkloads.length" class="text-center text-tertiary-container text-body-sm py-md flex items-center justify-center gap-xs"><span class="material-symbols-outlined text-base">check_circle</span> {{ t('monitoring.allNormal') }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
