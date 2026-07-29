<script setup>
import { ref } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'

const store = useClusterStore()
const timeRange = ref('24h')
</script>

<template>
  <div class="animate-fade-in">
    <!-- Page Header -->
    <div class="flex flex-col gap-sm mb-xl">
      <h1 class="text-display-lg text-on-surface">Cluster Overview</h1>
      <p class="text-body-lg text-on-surface-variant">Real-time performance metrics and operational health for {{ store.cluster.name }}.</p>
    </div>

    <!-- Summary Cards -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-gutter mb-xl">
      <div class="bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-card flex items-center justify-between hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300">
        <div>
          <p class="text-label-caps text-on-surface-variant mb-xs">TOTAL NODES</p>
          <h3 class="text-display-lg text-primary">{{ store.cluster.nodeCount }}</h3>
          <p class="text-body-sm text-primary flex items-center gap-xs mt-xs">
            <span class="material-symbols-outlined text-base">check_circle</span> {{ store.healthyNodes }}/{{ store.totalNodes }} Operational
          </p>
        </div>
        <span class="material-symbols-outlined text-surface-container-high text-5xl">dns</span>
      </div>

      <div class="bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-card flex items-center justify-between hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300">
        <div>
          <p class="text-label-caps text-on-surface-variant mb-xs">TOTAL PODS</p>
          <h3 class="text-display-lg text-primary">{{ store.cluster.podCount }}</h3>
          <p class="text-body-sm text-on-surface-variant flex items-center gap-xs mt-xs">
            <span class="material-symbols-outlined text-base">cached</span> Running smoothly
          </p>
        </div>
        <span class="material-symbols-outlined text-surface-container-high text-5xl">layers</span>
      </div>

      <div class="bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-card flex items-center justify-between hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300">
        <div>
          <p class="text-label-caps text-on-surface-variant mb-xs">ACTIVE EVENTS</p>
          <h3 class="text-display-lg text-tertiary">{{ store.cluster.activeEvents }}</h3>
          <p class="text-body-sm text-on-surface-variant flex items-center gap-xs mt-xs">
            <span class="material-symbols-outlined text-base">info</span> Last 60 minutes
          </p>
        </div>
        <span class="material-symbols-outlined text-surface-container-high text-5xl">notifications_active</span>
      </div>
    </div>

    <!-- Main Layout: 2/3 Content, 1/3 Sidebar -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-xl">
      <div class="lg:col-span-8 flex flex-col gap-gutter">
        <!-- Resource Usage Charts -->
        <div class="bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-card">
          <div class="flex justify-between items-center mb-lg">
            <h2 class="text-headline-sm">Resource Usage</h2>
            <div class="flex items-center gap-md">
              <span v-if="!store.cluster.metricsAvailable" class="flex items-center gap-xs text-body-xs text-tertiary-container bg-tertiary-container/10 px-sm py-xs rounded-full" title="集群未安装 metrics-server 或当前凭证无 metrics 读取权限">
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
          <div class="grid grid-cols-1 md:grid-cols-2 gap-xl">
            <!-- CPU Chart -->
            <div class="flex flex-col gap-md">
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
            <div class="flex flex-col gap-md">
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
        <div class="flex flex-col gap-md">
          <div class="flex justify-between items-center">
            <h2 class="text-headline-sm">Node Health</h2>
            <router-link to="/nodes" class="text-primary font-semibold flex items-center gap-xs text-body-sm">
              View all nodes <span class="material-symbols-outlined text-md">arrow_forward</span>
            </router-link>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-md">
            <router-link
              v-for="node in store.nodeList.slice(0, 6)"
              :key="node.name"
              :to="`/nodes/${node.name}`"
              class="bg-surface-container-lowest p-md rounded-lg border border-outline-variant shadow-card hover:border-primary transition-colors group"
            >
              <div class="flex justify-between items-start mb-sm">
                <div class="w-8 h-8 rounded bg-surface-container flex items-center justify-center text-on-surface-variant">
                  <span class="material-symbols-outlined">dns</span>
                </div>
                <div
                  class="w-2 h-2 rounded-full animate-pulse-status"
                  :class="node.status === 'Ready' ? 'bg-primary-container' : 'bg-error'"
                ></div>
              </div>
              <h4 class="text-body-lg font-bold truncate">{{ node.name }}</h4>
              <div class="flex flex-col gap-xs mt-md">
                <ProgressBar :value="node.cpu || 0" label="CPU" />
                <ProgressBar :value="node.memory || 0" label="Memory" />
              </div>
              <div class="mt-md flex items-center justify-between">
                <StatusChip :status="node.status === 'Ready' ? 'Ready' : 'NotReady'" size="sm" />
                <span class="font-mono text-code-sm text-on-surface-variant">{{ node.version }}</span>
              </div>
            </router-link>
          </div>
        </div>
      </div>

      <!-- Recent Events Sidebar -->
      <div class="lg:col-span-4">
        <div class="bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-card sticky top-[5.5rem]">
          <h2 class="text-headline-sm mb-lg">Recent Events</h2>
          <div class="flex flex-col gap-md">
            <div
              v-for="(event, idx) in store.eventList"
              :key="idx"
              class="flex gap-md border-b border-outline-variant pb-md last:border-0 last:pb-0"
            >
              <div class="mt-1">
                <div
                  class="w-8 h-8 rounded-full flex items-center justify-center"
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
                  <h4 class="text-body-md font-semibold text-on-surface truncate">{{ event.reason }}</h4>
                  <span class="font-mono text-code-sm text-on-surface-variant whitespace-nowrap ml-sm">{{ event.time }}</span>
                </div>
                <p class="text-body-sm text-on-surface-variant">{{ event.message }}</p>
              </div>
            </div>
          </div>
          <button class="w-full mt-lg py-sm border border-outline-variant rounded-lg text-on-surface-variant font-semibold text-body-sm hover:bg-surface-container-low transition-colors">
            Show More Events
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
