<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import { readMeta, fmtDate, imageTag } from '@/composables/useBusinessMeta'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const ns = computed(() => store.getNamespaceByName(route.params.namespace))
const stats = computed(() => store.nsStats)

const recentPods = computed(() => store.nsPods.slice(0, 6))
const recentWorkloads = computed(() => store.nsWorkloads.slice(0, 5))

// === 微服务分层拓扑 ===
const tieredGroups = computed(() => store.nsTieredWorkloads)

const colorMap = {
  primary: { text: 'text-primary', bg: 'bg-primary-container/10', border: 'border-primary/20' },
  secondary: { text: 'text-secondary', bg: 'bg-secondary-container/10', border: 'border-secondary/20' },
  tertiary: { text: 'text-tertiary-container', bg: 'bg-tertiary-container/10', border: 'border-tertiary/20' },
  error: { text: 'text-error', bg: 'bg-error-container/10', border: 'border-error/20' },
  surface: { text: 'text-on-surface-variant', bg: 'bg-surface-container', border: 'border-outline-variant' },
}
function tierMeta(color) { return colorMap[color] || colorMap.surface }
function tierTextColor(c) { return tierMeta(c).text }
function tierBg(c) { return tierMeta(c).bg }
function tierChip(c) { return `${tierMeta(c).bg} ${tierMeta(c).text} ${tierMeta(c).border}` }

// 卡片健康信号：管理 Pod 的最大重启次数（>0 显示徽标，>3 标红）
function maxRestarts(w) {
  const pods = store.getWorkloadPods?.(w.name, w.namespace) || []
  return pods.reduce((m, p) => Math.max(m, p.restarts || 0), 0)
}
// 业务元数据：从 labels/annotations 读 title/description 等（aliangboard.io/* 体系）
const metaCache = new WeakMap()
function metaOf(w) {
  if (!w) return {}
  if (!metaCache.has(w)) metaCache.set(w, readMeta(w))
  return metaCache.get(w)
}
function imgBase(image) {
  if (!image) return ''
  return image.split('@')[0].replace(/:[^/]*$/, '')   // 去 tag/digest，留 registry/repo
}

function statusDot(status) {
  return {
    Running: 'bg-primary animate-pulse-status',
    Pending: 'bg-tertiary-container',
    Failed: 'bg-error',
    Succeeded: 'bg-on-surface-variant',
  }[status] || 'bg-on-surface-variant'
}

function goToWorkload(w) {
  router.push({ name: 'NsWorkloadDetail', params: { namespace: route.params.namespace, type: w.type.toLowerCase(), name: w.name } })
}
</script>

<template>
  <div class="animate-fade-in">
    <!-- Header -->
    <div class="flex flex-col gap-sm mb-md">
      <Breadcrumbs :items="[
        { label: 'Cluster', route: '/cluster' },
        { label: route.params.namespace }
      ]" />
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-md">
          <div class="w-12 h-12 rounded-xl bg-primary-container/20 flex items-center justify-center">
            <span class="material-symbols-outlined text-primary text-2xl">folder_open</span>
          </div>
          <div>
            <h1 class="text-headline-lg font-bold text-on-surface">{{ route.params.namespace }}</h1>
            <div class="flex items-center gap-md mt-xs">
              <StatusChip status="Active" />
              <span class="text-body-sm text-on-surface-variant">Age: {{ ns?.age || 'N/A' }}</span>
              <span class="text-body-sm text-on-surface-variant">·</span>
              <span class="text-body-sm text-on-surface-variant">{{ stats.pods }} Pods</span>
              <span class="text-body-sm text-on-surface-variant">·</span>
              <span class="text-body-sm text-on-surface-variant">{{ stats.services }} Services</span>
            </div>
          </div>
        </div>
        <div class="flex gap-sm">
          <button
            @click="router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })"
            class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all"
          >
            <span class="material-symbols-outlined">add</span> Deploy
          </button>
        </div>
      </div>
    </div>

    <!-- Summary Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-gutter mb-md">
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant hover:-translate-y-0.5 transition-all duration-300 cursor-pointer group p-md" @click="router.push({ name: 'NsPods', params: { namespace: route.params.namespace } })">
        <div class="flex items-center justify-between mb-sm">
          <span class="material-symbols-outlined text-primary text-2xl">layers</span>
          <span class="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity">arrow_forward</span>
        </div>
        <h3 class="text-headline-lg font-bold text-primary">{{ stats.pods }}</h3>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ stats.runningPods }} Running · {{ stats.pods - stats.runningPods }} Other</p>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant hover:-translate-y-0.5 transition-all duration-300 cursor-pointer group p-md" @click="router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })">
        <div class="flex items-center justify-between mb-sm">
          <span class="material-symbols-outlined text-secondary text-2xl">apps</span>
          <span class="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity">arrow_forward</span>
        </div>
        <h3 class="text-headline-lg font-bold text-on-surface">{{ stats.deployments + stats.statefulSets + stats.daemonSets + stats.jobs }}</h3>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ stats.deployments }} Deploy · {{ stats.statefulSets }} STS · {{ stats.daemonSets }} DS</p>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant hover:-translate-y-0.5 transition-all duration-300 cursor-pointer group p-md" @click="router.push({ name: 'NsServices', params: { namespace: route.params.namespace } })">
        <div class="flex items-center justify-between mb-sm">
          <span class="material-symbols-outlined text-tertiary text-2xl">hub</span>
          <span class="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity">arrow_forward</span>
        </div>
        <h3 class="text-headline-lg font-bold text-on-surface">{{ stats.services }}</h3>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ stats.ingress }} Ingress</p>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant hover:-translate-y-0.5 transition-all duration-300 cursor-pointer group p-md" @click="router.push({ name: 'NsConfigMaps', params: { namespace: route.params.namespace } })">
        <div class="flex items-center justify-between mb-sm">
          <span class="material-symbols-outlined text-on-surface-variant text-2xl">description</span>
          <span class="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity">arrow_forward</span>
        </div>
        <h3 class="text-headline-lg font-bold text-on-surface">{{ stats.configMaps + stats.secrets }}</h3>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ stats.configMaps }} CM · {{ stats.secrets }} Secrets</p>
      </div>
    </div>

    <!-- 微服务分层拓扑（对标 Kuboard）-->
    <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant mb-md">
      <div class="px-md py-2.5 border-b border-outline-variant/50 bg-surface-container-low flex flex-wrap items-center justify-between gap-md">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary text-lg">account_tree</span>
          <div>
            <h3 class="text-body-sm font-semibold">微服务分层拓扑</h3>
            <p class="text-body-xs text-on-surface-variant">按业务分层可视化工作负载流向：表现层 → 网关 → 服务 → 中间件 → 持久层</p>
          </div>
        </div>
        <!-- 图例 -->
        <div class="flex flex-wrap gap-xs">
          <span v-for="g in tieredGroups" :key="g.tier" class="flex items-center gap-xs px-1.5 py-0.5 rounded border text-xs" :class="tierChip(g.meta.color)">
            <span class="material-symbols-outlined text-sm">{{ g.meta.icon }}</span>
            <span class="font-medium">{{ g.meta.label }}</span>
            <span class="opacity-70">{{ g.workloads.length }}</span>
          </span>
        </div>
      </div>

      <div v-if="tieredGroups.length" class="p-md flex flex-col">
        <div v-for="(group, idx) in tieredGroups" :key="group.tier">
          <!-- 层间流向箭头 -->
          <div v-if="idx > 0" class="flex justify-center py-xs">
            <span class="material-symbols-outlined text-on-surface-variant opacity-30">south</span>
          </div>
          <div class="flex flex-col md:flex-row gap-sm items-stretch">
            <!-- 层标签 -->
            <div class="md:w-40 shrink-0 rounded-lg p-md flex items-center gap-sm justify-center md:justify-start" :class="tierBg(group.meta.color)">
              <span class="material-symbols-outlined text-xl" :class="tierTextColor(group.meta.color)">{{ group.meta.icon }}</span>
              <div>
                <p class="font-semibold text-body-sm" :class="tierTextColor(group.meta.color)">{{ group.meta.label }}</p>
                <p class="text-body-xs opacity-70">{{ group.meta.en }} · {{ group.workloads.length }} 个</p>
              </div>
            </div>
            <!-- workload 节点 -->
            <div class="flex-1 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-sm">
              <div v-for="w in group.workloads" :key="w.name" @click="goToWorkload(w)"
                class="group p-sm rounded-lg border border-outline-variant bg-surface-container-low hover:-translate-y-0.5 hover:border-primary transition-all cursor-pointer">
                <div class="flex items-center justify-between mb-xs">
                  <span class="w-2 h-2 rounded-full shrink-0" :class="statusDot(w.status)"></span>
                  <div class="flex items-center gap-xs">
                    <span v-if="maxRestarts(w) > 0" class="flex items-center gap-0.5 text-body-xs font-semibold" :class="maxRestarts(w) > 3 ? 'text-error' : 'text-tertiary-container'" :title="`管理 Pod 共 ${maxRestarts(w)} 次重启`">
                      <span class="material-symbols-outlined text-sm">restart_alt</span>{{ maxRestarts(w) }}
                    </span>
                    <span class="px-1 py-0.5 rounded bg-surface-container text-xs text-on-surface-variant">{{ w.type }}</span>
                  </div>
                </div>
                <!-- 标题：label aliangboard.io/title 优先，否则用 name -->
                <p class="text-body-sm font-semibold text-on-surface truncate" :title="metaOf(w).title ? w.name : ''">{{ metaOf(w).title || w.name }}</p>
                <p v-if="metaOf(w).title" class="font-mono text-code-xs text-on-surface-variant truncate">{{ w.name }}</p>
                <p v-if="metaOf(w).description" class="text-body-xs text-on-surface-variant truncate mt-xs" :title="metaOf(w).description">{{ metaOf(w).description }}</p>
                <!-- 镜像：repo + 版本 tag 高亮 -->
                <div class="flex items-center gap-0.5 mt-xs min-w-0">
                  <span class="font-mono text-code-xs text-on-surface-variant truncate">{{ imgBase(w.image) }}</span>
                  <span v-if="imageTag(w.image)" class="font-mono text-code-xs text-primary shrink-0">:{{ imageTag(w.image) }}</span>
                </div>
                <!-- 业务元数据：owner / version（来自 aliangboard.io/* 标签，有才显示） -->
                <div v-if="metaOf(w).owner || metaOf(w).version" class="flex items-center gap-0.5 mt-xs flex-wrap">
                  <span v-if="metaOf(w).owner" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-surface-container text-body-xs text-on-surface-variant border border-outline-variant/60"><span class="material-symbols-outlined text-xs">group</span>{{ metaOf(w).owner }}</span>
                  <span v-if="metaOf(w).version" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-surface-container text-body-xs text-primary border border-outline-variant/60"><span class="material-symbols-outlined text-xs">sell</span>{{ metaOf(w).version }}</span>
                </div>
                <div class="flex items-center justify-between text-body-xs text-on-surface-variant mt-xs">
                  <span class="font-mono">{{ w.replicas }}</span>
                  <span class="font-mono">{{ fmtDate(w.createdAt) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="p-md text-center text-on-surface-variant">
        <span class="material-symbols-outlined text-2xl text-surface-container-high">workspaces</span>
        <p class="text-body-sm mt-xs">当前 namespace 无工作负载</p>
      </div>
    </div>

    <!-- Main Content -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-md">
      <!-- Left: Workload Summary + Pods -->
      <div class="lg:col-span-8 flex flex-col gap-sm">
        <!-- Workload Summary -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">apps</span>
            <span class="text-body-sm font-semibold">Workload Summary</span>
            <button @click="router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })" class="text-body-xs text-primary hover:underline ml-auto flex items-center gap-xs">
              View all <span class="material-symbols-outlined text-sm">arrow_forward</span>
            </button>
          </div>
          <div class="p-md">
            <!-- Workload Type Grid -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-sm mb-md">
              <div class="p-sm rounded-lg border border-outline-variant bg-surface-container-low text-center hover:border-primary transition-colors cursor-pointer" @click="router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })">
                <span class="material-symbols-outlined text-primary text-base">view_carousel</span>
                <p class="text-body-md font-bold mt-xs">{{ stats.deployments }}</p>
                <p class="text-body-xs text-on-surface-variant">Deployments</p>
              </div>
              <div class="p-sm rounded-lg border border-outline-variant bg-surface-container-low text-center hover:border-primary transition-colors">
                <span class="material-symbols-outlined text-secondary text-base">database</span>
                <p class="text-body-md font-bold mt-xs">{{ stats.statefulSets }}</p>
                <p class="text-body-xs text-on-surface-variant">StatefulSets</p>
              </div>
              <div class="p-sm rounded-lg border border-outline-variant bg-surface-container-low text-center hover:border-primary transition-colors">
                <span class="material-symbols-outlined text-tertiary text-base">settings_slow_motion</span>
                <p class="text-body-md font-bold mt-xs">{{ stats.daemonSets }}</p>
                <p class="text-body-xs text-on-surface-variant">DaemonSets</p>
              </div>
              <div class="p-sm rounded-lg border border-outline-variant bg-surface-container-low text-center hover:border-primary transition-colors">
                <span class="material-symbols-outlined text-on-surface-variant text-base">schedule</span>
                <p class="text-body-md font-bold mt-xs">{{ stats.jobs }}</p>
                <p class="text-body-xs text-on-surface-variant">Jobs</p>
              </div>
            </div>
            <!-- Recent Workloads Table -->
            <table v-if="recentWorkloads.length" class="w-full text-left">
              <thead>
                <tr class="border-b border-outline-variant">
                  <th class="pb-1 text-body-xs font-medium text-on-surface-variant">Name</th>
                  <th class="pb-1 text-body-xs font-medium text-on-surface-variant">Type</th>
                  <th class="pb-1 text-body-xs font-medium text-on-surface-variant">Status</th>
                  <th class="pb-1 text-body-xs font-medium text-on-surface-variant">Replicas</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-outline-variant/15">
                <tr v-for="w in recentWorkloads" :key="w.name" class="hover:bg-surface-container-low/40 cursor-pointer" @click="router.push({ name: 'NsWorkloadDetail', params: { namespace: route.params.namespace, type: w.type.toLowerCase(), name: w.name } })">
                  <td class="py-1.5 font-semibold text-on-surface text-body-md">{{ w.name }}</td>
                  <td class="py-1.5 text-body-sm text-on-surface-variant">{{ w.type }}</td>
                  <td class="py-1.5"><StatusChip :status="w.status" size="sm" /></td>
                  <td class="py-1.5 font-mono text-code-sm">{{ w.replicas }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="text-on-surface-variant text-body-sm text-center py-md">No workloads in this namespace</p>
          </div>
        </div>

        <!-- Recent Pods -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">layers</span>
            <span class="text-body-sm font-semibold">Recent Pods</span>
            <button @click="router.push({ name: 'NsPods', params: { namespace: route.params.namespace } })" class="text-body-xs text-primary hover:underline ml-auto flex items-center gap-xs">
              View all <span class="material-symbols-outlined text-sm">arrow_forward</span>
            </button>
          </div>
          <div class="p-md">
            <div v-if="recentPods.length" class="grid grid-cols-1 md:grid-cols-2 gap-sm">
              <div v-for="p in recentPods" :key="p.name" @click="router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } })" class="p-sm rounded-lg border border-outline-variant bg-surface-container-low hover:border-primary transition-colors cursor-pointer">
                <div class="flex items-center justify-between mb-xs">
                  <span class="font-mono text-code-sm font-semibold text-on-surface truncate mr-sm">{{ p.name }}</span>
                  <StatusChip :status="p.status" size="sm" />
                </div>
                <div class="flex items-center gap-md text-body-xs text-on-surface-variant">
                  <span class="flex items-center gap-xs"><span class="material-symbols-outlined text-sm">dns</span>{{ p.node || 'Unscheduled' }}</span>
                  <span v-if="p.restarts > 0" class="text-tertiary-container font-medium">⚠ {{ p.restarts }} restarts</span>
                </div>
              </div>
            </div>
            <p v-else class="text-on-surface-variant text-body-sm text-center py-md">No pods in this namespace</p>
          </div>
        </div>
      </div>

      <!-- Right Sidebar -->
      <div class="lg:col-span-4 flex flex-col gap-sm">
        <!-- Resource Quotas -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">tune</span>
            <span class="text-body-sm font-semibold">Resource Quotas</span>
          </div>
          <div class="p-md space-y-md">
            <div>
              <ProgressBar :value="62" show-label label="CPU Usage" />
              <p class="font-mono text-code-sm text-on-surface-variant mt-1">7.4 / 12 Cores</p>
            </div>
            <div>
              <ProgressBar :value="75" show-label label="Memory Usage" />
              <p class="font-mono text-code-sm text-on-surface-variant mt-1">24.1 / 32 GiB</p>
            </div>
            <div class="grid grid-cols-2 gap-md pt-md border-t border-outline-variant">
              <div>
                <p class="text-on-surface-variant text-body-xs mb-xs">Pods</p>
                <p class="text-body-md font-semibold">{{ stats.pods }}</p>
              </div>
              <div>
                <p class="text-on-surface-variant text-body-xs mb-xs">PVCs</p>
                <p class="text-body-md font-semibold">{{ stats.pvcs }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Quick Actions -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">bolt</span>
            <span class="text-body-sm font-semibold">Quick Actions</span>
          </div>
          <div class="p-md flex flex-col gap-xs">
            <button @click="router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })" class="flex items-center gap-sm px-md py-sm bg-primary/5 text-primary rounded-lg hover:bg-primary/10 transition-colors text-body-sm font-medium">
              <span class="material-symbols-outlined text-lg">rocket_launch</span> Deploy New App
            </button>
            <button @click="router.push({ name: 'NsEvents', params: { namespace: route.params.namespace } })" class="flex items-center gap-sm px-md py-sm bg-surface-container text-on-surface rounded-lg hover:bg-surface-container-high transition-colors text-body-sm font-medium">
              <span class="material-symbols-outlined text-lg">notifications_active</span> View Events
            </button>
            <button @click="router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })" class="flex items-center gap-sm px-md py-sm bg-surface-container text-on-surface rounded-lg hover:bg-surface-container-high transition-colors text-body-sm font-medium">
              <span class="material-symbols-outlined text-lg">admin_panel_settings</span> Manage RBAC
            </button>
            <button @click="router.push({ name: 'NsStorage', params: { namespace: route.params.namespace } })" class="flex items-center gap-sm px-md py-sm bg-surface-container text-on-surface rounded-lg hover:bg-surface-container-high transition-colors text-body-sm font-medium">
              <span class="material-symbols-outlined text-lg">storage</span> View Storage
            </button>
          </div>
        </div>

        <!-- Events -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">notifications_active</span>
            <span class="text-body-sm font-semibold">Events</span>
            <button @click="router.push({ name: 'NsEvents', params: { namespace: route.params.namespace } })" class="text-body-xs text-primary hover:underline ml-auto">View all</button>
          </div>
          <div class="p-md">
            <div v-if="store.nsEvents.length" class="flex flex-col gap-sm">
              <div v-for="(event, idx) in store.nsEvents.slice(0, 4)" :key="idx" class="flex gap-sm border-b border-outline-variant/15 pb-sm last:border-0 last:pb-0">
                <div class="mt-0.5">
                  <span class="material-symbols-outlined text-base" :class="{
                    'text-primary': event.color === 'primary',
                    'text-tertiary-container': event.color === 'tertiary',
                    'text-error': event.color === 'error',
                    'text-on-surface-variant': event.color === 'surface',
                  }">{{ event.icon }}</span>
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-body-sm font-medium text-on-surface truncate">{{ event.reason }}</p>
                  <p class="text-body-xs text-on-surface-variant truncate">{{ event.message }}</p>
                  <p class="font-mono text-code-xs text-on-surface-variant mt-xs">{{ event.time }}</p>
                </div>
              </div>
            </div>
            <p v-else class="text-on-surface-variant text-body-sm text-center py-md">No recent events</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
