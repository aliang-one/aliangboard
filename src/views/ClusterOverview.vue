<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import ProgressBar from '@/components/common/ProgressBar.vue'

const router = useRouter()
const store = useClusterStore()
const timeRange = ref('24h')

// CPU 环形表盘颜色（阈值与 ProgressBar.barColor 一致）
function gaugeClass(cpu) {
  if (cpu == null) return 'stroke-surface-container-high'
  if (cpu > 80) return 'stroke-error'
  if (cpu > 60) return 'stroke-tertiary-container'
  return 'stroke-primary'
}
// 是否存在压力条件（Disk/Memory/PID）——概览卡上合并为一个警告图标
function hasPressure(node) {
  return Boolean(node.conditions?.DiskPressure || node.conditions?.MemoryPressure || node.conditions?.PIDPressure)
}
</script>

<template>
  <div class="animate-fade-in">
    <!-- Page Header -->
    <div class="flex flex-col gap-sm mb-md">
      <h1 class="text-headline-md text-on-surface font-bold">Cluster Overview</h1>
      <p class="text-body-sm text-on-surface-variant mt-xs">Real-time performance metrics and operational health for {{ store.cluster.name }}.</p>
    </div>

    <!-- Summary Cards -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-md mb-md">
      <div class="bg-surface-container-lowest p-md rounded-xl border border-outline-variant shadow-card flex items-center justify-between hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300">
        <div>
          <p class="text-label-caps text-on-surface-variant mb-xs">TOTAL NODES</p>
          <h3 class="text-headline-md text-primary font-bold">{{ store.cluster.nodeCount }}</h3>
          <p class="text-body-sm flex items-center gap-xs mt-xs"
            :class="{ 'text-primary': store.clusterHealth.severity === 'ok', 'text-tertiary-container': store.clusterHealth.severity === 'warn', 'text-error': store.clusterHealth.severity === 'crit' || store.clusterHealth.severity === 'none' }">
            <span class="material-symbols-outlined text-base">{{ store.clusterHealth.severity === 'ok' ? 'check_circle' : 'warning' }}</span>
            {{ store.clusterHealth.status }} · 控制面 {{ store.clusterHealth.controlPlane.ready }}/{{ store.clusterHealth.controlPlane.total }}
          </p>
        </div>
        <span class="material-symbols-outlined text-surface-container-high text-2xl">dns</span>
      </div>

      <div class="bg-surface-container-lowest p-md rounded-xl border border-outline-variant shadow-card flex items-center justify-between hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300">
        <div>
          <p class="text-label-caps text-on-surface-variant mb-xs">TOTAL PODS</p>
          <h3 class="text-headline-md text-primary font-bold">{{ store.cluster.podCount }}</h3>
          <p class="text-body-sm text-on-surface-variant flex items-center gap-xs mt-xs">
            <span class="material-symbols-outlined text-base">cached</span> Running smoothly
          </p>
        </div>
        <span class="material-symbols-outlined text-surface-container-high text-2xl">layers</span>
      </div>

      <div class="bg-surface-container-lowest p-md rounded-xl border border-outline-variant shadow-card flex items-center justify-between hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300">
        <div>
          <p class="text-label-caps text-on-surface-variant mb-xs">ACTIVE EVENTS</p>
          <h3 class="text-headline-md text-tertiary font-bold">{{ store.cluster.activeEvents }}</h3>
          <p class="text-body-sm text-on-surface-variant flex items-center gap-xs mt-xs">
            <span class="material-symbols-outlined text-base">info</span> Last 60 minutes
          </p>
        </div>
        <span class="material-symbols-outlined text-surface-container-high text-2xl">notifications_active</span>
      </div>
    </div>

    <!-- Main Layout: 2/3 Content, 1/3 Sidebar -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-md">
      <div class="lg:col-span-8 flex flex-col gap-sm">
        <!-- Resource Usage Charts -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">monitoring</span>
              <span class="text-body-sm font-semibold">Resource Usage</span>
            </div>
            <div class="flex items-center gap-sm">
              <span v-if="!store.cluster.metricsAvailable" class="flex items-center gap-xs text-xs text-tertiary-container bg-tertiary-container/10 px-sm py-xs rounded-full" title="集群未安装 metrics-server 或当前凭证无 metrics 读取权限">
                <span class="material-symbols-outlined text-sm">sensors_off</span> 指标不可用
              </span>
              <div class="flex gap-xs">
                <span
                  v-for="range in ['24h', '7d', '30d']"
                  :key="range"
                  @click="timeRange = range"
                  class="px-md py-1 rounded-full text-body-sm cursor-pointer transition-colors"
                  :class="timeRange === range ? 'bg-surface-container text-on-surface' : 'text-on-surface-variant hover:bg-surface-container-low'"
                >{{ range }}</span>
              </div>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-md p-md">
            <!-- CPU Chart -->
            <div class="flex flex-col gap-sm">
              <div class="flex justify-between items-end">
                <div>
                  <p class="text-label-caps text-on-surface-variant">CPU UTILIZATION</p>
                  <p class="text-headline-md text-primary">{{ store.cluster.cpuUsage != null ? store.cluster.cpuUsage + '%' : '—' }}</p>
                </div>
                <p v-if="store.cluster.cpuUsage != null" class="text-body-sm flex items-center gap-xs" :class="store.cluster.cpuTrendUp ? 'text-error' : 'text-primary'">
                  <span class="material-symbols-outlined text-base">{{ store.cluster.cpuTrendUp ? 'trending_up' : 'trending_down' }}</span> {{ store.cluster.cpuTrend }}
                </p>
              </div>
              <div class="h-32 w-full bg-gradient-to-b from-primary/10 to-transparent relative border-b border-outline-variant overflow-hidden rounded-lg">
                <svg class="w-full h-full stroke-primary fill-none stroke-2" preserveAspectRatio="none" viewBox="0 0 400 100">
                  <path d="M0,80 Q50,70 100,75 T200,40 T300,50 T400,20" vector-effect="non-scaling-stroke" />
                </svg>
              </div>
              <div class="flex justify-between font-mono text-code-sm text-on-surface-variant">
                <span>24h ago</span><span>Now</span>
              </div>
            </div>
            <!-- Memory Chart -->
            <div class="flex flex-col gap-sm">
              <div class="flex justify-between items-end">
                <div>
                  <p class="text-label-caps text-on-surface-variant">MEMORY ALLOCATION</p>
                  <p class="text-headline-md text-primary">{{ store.cluster.memoryUsage != null ? store.cluster.memoryUsage + '%' : '—' }}</p>
                </div>
                <p v-if="store.cluster.memoryUsage != null" class="text-body-sm flex items-center gap-xs" :class="store.cluster.memoryTrendUp ? 'text-error' : 'text-primary'">
                  <span class="material-symbols-outlined text-base">{{ store.cluster.memoryTrendUp ? 'trending_up' : 'trending_down' }}</span> {{ store.cluster.memoryTrend }}
                </p>
              </div>
              <div class="h-32 w-full bg-surface-container-low rounded-lg relative border-b border-outline-variant overflow-hidden">
                <svg class="w-full h-full stroke-primary fill-none stroke-2 opacity-60" preserveAspectRatio="none" viewBox="0 0 400 100">
                  <path d="M0,60 Q50,65 100,55 T200,70 T300,60 T400,65" vector-effect="non-scaling-stroke" />
                </svg>
              </div>
              <div class="flex justify-between font-mono text-code-sm text-on-surface-variant">
                <span>24h ago</span><span>Now</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Node Health Grid -->
        <div class="flex flex-col gap-sm">
          <div class="flex justify-between items-center px-md">
            <span class="text-body-sm font-semibold">Node Health</span>
            <router-link to="/nodes" class="text-primary font-semibold flex items-center gap-xs text-body-sm">
              View all nodes <span class="material-symbols-outlined text-md">arrow_forward</span>
            </router-link>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-sm">
            <router-link
              v-for="node in store.nodeList.slice(0, 6)"
              :key="node.name"
              :to="`/nodes/${node.name}`"
              class="bg-surface-container-lowest p-md rounded-xl border border-outline-variant hover:border-primary hover:shadow-card-hover transition-all flex gap-md"
            >
              <!-- 左：CPU 环形表盘 -->
              <div class="relative w-14 h-14 flex-shrink-0 self-center">
                <svg class="w-full h-full -rotate-90" viewBox="0 0 36 36">
                  <circle cx="18" cy="18" r="15.5" fill="none" class="stroke-surface-container-high" stroke-width="3.5" />
                  <circle
                    cx="18" cy="18" r="15.5" fill="none" stroke-width="3.5" stroke-linecap="round" pathLength="100"
                    :class="gaugeClass(node.cpu)"
                    :stroke-dasharray="`${node.cpu != null ? node.cpu : 0} 100`"
                  />
                </svg>
                <div class="absolute inset-0 flex flex-col items-center justify-center">
                  <span class="text-body-sm font-bold leading-none" :class="node.cpu != null ? 'text-on-surface' : 'text-on-surface-variant'">{{ node.cpu != null ? node.cpu + '%' : '—' }}</span>
                  <span class="text-[9px] text-on-surface-variant uppercase tracking-wide mt-0.5">CPU</span>
                </div>
              </div>
              <!-- 右：身份 + 状态 + 底栏 -->
              <div class="flex-1 min-w-0 flex flex-col gap-xs">
                <div class="flex items-center gap-xs">
                  <div
                    class="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
                    :class="node.status === 'Ready' ? 'bg-primary-container/20 text-primary ring-1 ring-primary/30' : 'bg-error-container/20 text-error ring-1 ring-error/30'"
                  >
                    <span class="material-symbols-outlined text-base">dns</span>
                  </div>
                  <h4 class="text-body-sm font-bold truncate">{{ node.name }}</h4>
                  <span class="px-1 py-0.5 bg-surface-container rounded text-[10px] text-on-surface-variant border border-outline-variant capitalize flex-shrink-0">{{ node.roles }}</span>
                </div>
                <div class="flex items-center gap-xs text-xs">
                  <span class="flex items-center gap-0.5 font-medium" :class="node.status === 'Ready' ? 'text-primary' : 'text-error'">
                    <span class="w-1.5 h-1.5 rounded-full animate-pulse-status" :class="node.status === 'Ready' ? 'bg-primary-container' : 'bg-error'"></span>
                    {{ node.status === 'Ready' ? 'Ready' : 'NotReady' }}
                  </span>
                  <span v-if="hasPressure(node)" class="text-error flex items-center" title="节点存在压力条件（Disk/Memory/PID）">
                    <span class="material-symbols-outlined text-sm">warning</span>
                  </span>
                  <span class="font-mono text-on-surface-variant truncate">{{ node.ip }}</span>
                </div>
                <div class="flex items-center gap-md mt-auto pt-xs">
                  <div class="flex-1 min-w-0">
                    <div class="flex justify-between text-[10px] mb-0.5">
                      <span class="text-on-surface-variant">Mem</span>
                      <span class="font-mono text-on-surface-variant">{{ node.memory != null ? node.memory + '%' : '—' }}</span>
                    </div>
                    <ProgressBar v-if="node.memory != null" :value="node.memory" />
                    <div v-else class="h-1.5 bg-surface-container-high rounded-full"></div>
                  </div>
                  <span class="flex items-center gap-0.5 text-xs text-on-surface-variant flex-shrink-0" title="Pods">
                    <span class="material-symbols-outlined text-sm">view_in_ar</span>{{ node.podCount ?? 0 }}
                  </span>
                  <span v-if="node.taintCount" class="flex items-center gap-0.5 text-xs text-tertiary-container flex-shrink-0" :title="`${node.taintCount} taint(s)`">
                    <span class="material-symbols-outlined text-sm">block</span>{{ node.taintCount }}
                  </span>
                </div>
              </div>
            </router-link>
          </div>
        </div>
      </div>

      <!-- Recent Events Sidebar -->
      <div class="lg:col-span-4">
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant sticky top-[5.5rem]">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">notifications</span>
            <span class="text-body-sm font-semibold">Recent Events</span>
            <span class="text-xs text-on-surface-variant ml-auto">{{ store.eventList.length }}</span>
          </div>
          <div class="flex flex-col gap-sm p-md">
            <div
              v-for="(event, idx) in store.eventList"
              :key="idx"
              class="flex gap-sm border-b border-outline-variant/30 pb-sm last:border-0 last:pb-0"
            >
              <div class="mt-1">
                <div
                  class="w-7 h-7 rounded-full flex items-center justify-center"
                  :class="{
                    'bg-primary-container text-on-primary-container': event.color === 'primary',
                    'bg-tertiary-fixed-dim text-on-tertiary-fixed': event.color === 'tertiary',
                    'bg-error-container text-on-error-container': event.color === 'error',
                    'bg-surface-container text-on-surface-variant': event.color === 'surface',
                  }"
                >
                  <span class="material-symbols-outlined text-lg">{{ event.icon }}</span>
                </div>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex justify-between items-start mb-xs">
                  <h4 class="text-body-sm font-semibold text-on-surface truncate">{{ event.reason }}</h4>
                  <span class="font-mono text-xs text-on-surface-variant whitespace-nowrap ml-sm">{{ event.time }}</span>
                </div>
                <p class="text-xs text-on-surface-variant">{{ event.message }}</p>
              </div>
            </div>
          </div>
          <div class="px-md pb-md">
            <button @click="router.push('/audit-logs')" class="w-full py-1.5 border border-outline-variant rounded-lg text-on-surface-variant font-medium text-body-sm hover:bg-surface-container transition-colors">
              Show More Events
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
