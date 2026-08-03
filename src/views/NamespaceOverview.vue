<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import { groupByLayer, LAYER_TAXONOMY } from '@/composables/useLayering'
import { readMeta, fmtDate, imageTag } from '@/composables/useBusinessMeta'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const ns = computed(() => store.getNamespaceByName(route.params.namespace))
const stats = computed(() => store.nsStats)
const recentPods = computed(() => store.nsPods.slice(0, 6))
const recentWorkloads = computed(() => store.nsWorkloads.slice(0, 5))

const activeTab = ref('topology')

// === 3 列分层布局（同 NsLayers：workloads + services + ingresses） ===
const layerItems = computed(() => {
  const list = []
  for (const w of store.nsWorkloads) list.push({ _kind: 'workload', kind: w.type, type: w.type, name: w.name, namespace: w.namespace, image: w.image, status: w.status, labels: w.labels, annotations: w.annotations })
  for (const s of store.nsServices) list.push({ _kind: 'service', kind: 'Service', type: 'Service', name: s.name, namespace: s.namespace, status: s.status, labels: s.labels, annotations: s.annotations })
  for (const ing of store.nsIngress) list.push({ _kind: 'ingress', kind: 'Ingress', type: 'Ingress', name: ing.name, namespace: ing.namespace, labels: ing.labels, annotations: ing.annotations })
  return list
})
const layerGroups = computed(() => groupByLayer(layerItems.value))
const leftGroups = computed(() => layerGroups.value.filter(g => g.column === 'left'))
const centerGroups = computed(() => layerGroups.value.filter(g => g.column === 'center'))
const rightGroups = computed(() => layerGroups.value.filter(g => g.column === 'right'))

const KIND_ICON = { Deployment: 'work', StatefulSet: 'work', DaemonSet: 'work', ReplicaSet: 'work', Job: 'schedule', CronJob: 'schedule', Service: 'share', Ingress: 'alt_route' }

// === 工作负载卡片元数据 ===
const metaCache = new WeakMap()
function metaOf(w) {
  if (!w) return {}
  if (!metaCache.has(w)) metaCache.set(w, readMeta(w))
  return metaCache.get(w)
}
function imgBase(image) { return image ? image.split('@')[0].replace(/:[^/]*$/, '') : '' }
function maxRestarts(w) {
  const pods = store.getWorkloadPods?.(w.name, w.namespace) || []
  return pods.reduce((m, p) => Math.max(m, p.restarts || 0), 0)
}
function statusDot(s) {
  return { Running: 'bg-primary animate-pulse-status', Pending: 'bg-tertiary-container', Failed: 'bg-error', Succeeded: 'bg-on-surface-variant' }[s] || 'bg-on-surface-variant'
}
function goToWorkload(w) {
  router.push({ name: 'NsWorkloadDetail', params: { namespace: route.params.namespace, type: w.type.toLowerCase(), name: w.name } })
}
function goTo(it) {
  if (it._kind === 'workload') router.push({ name: 'NsWorkloadDetail', params: { namespace: it.namespace, type: String(it.kind).toLowerCase(), name: it.name } })
  else if (it._kind === 'service') router.push({ name: 'NsServiceDetail', params: { namespace: it.namespace, name: it.name } })
  else if (it._kind === 'ingress') router.push({ name: 'NsIngressDetail', params: { namespace: it.namespace, name: it.name } })
}
</script>

<template>
  <div class="animate-fade-in">
    <!-- Header -->
    <div class="flex flex-col gap-sm mb-md">
      <Breadcrumbs :items="[{ label: 'Cluster', route: '/cluster' }, { label: route.params.namespace }]" />
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-md">
          <div class="w-12 h-12 rounded-xl bg-primary-container/20 flex items-center justify-center">
            <span class="material-symbols-outlined text-primary text-2xl">folder_open</span>
          </div>
          <div>
            <h1 class="text-headline-lg font-bold text-on-surface">{{ route.params.namespace }}</h1>
            <div class="flex items-center gap-md mt-xs">
              <StatusChip status="Active" />
              <span class="text-body-sm text-on-surface-variant">{{ stats.pods }} Pods · {{ stats.services }} Services · {{ stats.deployments + stats.statefulSets + stats.daemonSets }} Workloads</span>
            </div>
          </div>
        </div>
        <button @click="router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })" class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
          <span class="material-symbols-outlined text-sm">add</span> Deploy
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex items-center gap-xs border-b border-outline-variant mb-md">
      <button v-for="tab in ['topology', 'summary']" :key="tab" @click="activeTab = tab"
        class="px-lg py-2 text-body-sm font-medium capitalize transition-colors relative"
        :class="activeTab === tab ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'">
        {{ tab === 'topology' ? '分层拓扑' : '概要' }}
        <span v-if="activeTab === tab" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"></span>
      </button>
    </div>

    <!-- ====== Topology Tab（3 列分层布局） ====== -->
    <div v-if="activeTab === 'topology'">
      <div v-if="layerGroups.length" class="grid grid-cols-1 xl:grid-cols-[220px_1fr_220px] gap-md">
        <!-- 左列：监控层 -->
        <div class="flex flex-col gap-sm">
          <div v-for="g in leftGroups" :key="g.key" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
            <div class="flex items-center gap-sm px-md py-2 border-b border-outline-variant/40">
              <div class="w-7 h-7 rounded-lg bg-secondary/10 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-secondary text-base">{{ g.icon }}</span></div>
              <h3 class="text-body-sm text-on-surface font-bold">{{ g.label }}</h3>
              <span class="text-body-xs text-on-surface-variant ml-auto">{{ g.count }}</span>
            </div>
            <div class="p-sm flex flex-col gap-xs">
              <div v-for="it in g.items" :key="it._kind + it.name" @click="goTo(it)" class="flex items-center gap-xs px-sm py-xs rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary transition-colors cursor-pointer">
                <span class="material-symbols-outlined text-on-surface-variant text-sm">{{ KIND_ICON[it.kind] || 'circle' }}</span>
                <span class="font-mono text-xs text-on-surface truncate flex-1">{{ it.name }}</span>
              </div>
            </div>
          </div>
          <!-- 空列占位 -->
          <div v-if="!leftGroups.length" class="rounded-xl border border-dashed border-outline-variant/40 py-md text-center">
            <span class="material-symbols-outlined text-2xl text-surface-container-high">monitoring</span>
            <p class="text-body-xs text-on-surface-variant mt-xs">监控层<br>（本命名空间暂无）</p>
          </div>
        </div>

        <!-- 中列：主应用流 -->
        <div class="flex flex-col gap-sm">
          <div v-for="g in centerGroups" :key="g.key" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
            <div class="flex items-center gap-sm px-md py-2.5 border-b border-outline-variant/40 bg-surface-container-low/30">
              <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-primary text-base">{{ g.icon }}</span></div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-xs"><h3 class="text-body-sm text-on-surface font-bold">{{ g.label }}</h3><span class="px-1.5 py-0.5 rounded bg-primary-container/15 text-primary text-body-xs font-semibold">{{ g.count }}</span></div>
                <p class="text-body-xs text-on-surface-variant truncate">{{ g.desc }}</p>
              </div>
            </div>
            <!-- 微服务子层 -->
            <div v-if="g.children" class="divide-y divide-outline-variant/10">
              <div v-for="sub in g.children" :key="sub.key" class="px-md py-2">
                <div class="flex items-center gap-xs mb-xs">
                  <span class="material-symbols-outlined text-on-surface-variant text-sm">{{ sub.icon }}</span>
                  <h4 class="text-body-xs font-semibold text-on-surface">{{ sub.label }}</h4>
                  <span class="text-body-xs text-on-surface-variant">{{ sub.items.length }}</span>
                </div>
                <div class="flex flex-wrap gap-xs">
                  <div v-for="it in sub.items" :key="it._kind + it.name" @click="goTo(it)" class="group flex items-center gap-xs px-sm py-xs rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary hover:bg-primary-container/5 transition-all cursor-pointer">
                    <span class="material-symbols-outlined text-on-surface-variant text-sm group-hover:text-primary">{{ KIND_ICON[it.kind] || 'circle' }}</span>
                    <span class="font-mono text-xs text-on-surface group-hover:text-primary truncate max-w-[180px]">{{ it.name }}</span>
                    <span class="text-body-xs text-on-surface-variant/50 shrink-0">{{ it.kind }}</span>
                  </div>
                </div>
              </div>
            </div>
            <!-- 普通层：工作负载卡片（带指标） -->
            <div v-else class="p-md">
              <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-sm">
                <div v-for="w in g.items.filter(it => it._kind === 'workload')" :key="w.name" @click="goToWorkload(w)" class="group p-sm rounded-lg border border-outline-variant bg-surface-container-low hover:border-primary transition-all cursor-pointer">
                  <div class="flex items-center justify-between mb-xs">
                    <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="statusDot(w.status)"></span>
                    <span class="text-body-xs text-on-surface-variant/50">{{ w.type }}</span>
                  </div>
                  <p class="text-body-sm font-semibold truncate">{{ metaOf(w).title || w.name }}</p>
                  <p v-if="metaOf(w).title" class="font-mono text-xs text-on-surface-variant truncate">{{ w.name }}</p>
                  <div class="flex items-center gap-0.5 mt-xs min-w-0">
                    <span class="font-mono text-xs text-on-surface-variant truncate">{{ imgBase(w.image) }}</span>
                    <span v-if="imageTag(w.image)" class="font-mono text-xs text-primary shrink-0">:{{ imageTag(w.image) }}</span>
                  </div>
                  <div class="flex items-center justify-between text-body-xs text-on-surface-variant mt-xs">
                    <span class="font-mono">{{ w.replicas }}</span>
                    <span class="font-mono">{{ fmtDate(w.createdAt) }}</span>
                  </div>
                </div>
                <!-- 非 workload（Service/Ingress）显示为 chip -->
                <div class="flex flex-wrap gap-xs items-start">
                  <div v-for="it in g.items.filter(it => it._kind !== 'workload')" :key="it._kind + it.name" @click="goTo(it)" class="flex items-center gap-xs px-sm py-xs rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary transition-colors cursor-pointer">
                    <span class="material-symbols-outlined text-on-surface-variant text-sm">{{ KIND_ICON[it.kind] || 'circle' }}</span>
                    <span class="font-mono text-xs text-on-surface truncate">{{ it.name }}</span>
                    <span class="text-body-xs text-on-surface-variant/50">{{ it.kind }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 右列：中间件 -->
        <div class="flex flex-col gap-sm">
          <div v-for="g in rightGroups" :key="g.key" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
            <div class="flex items-center gap-sm px-md py-2 border-b border-outline-variant/40">
              <div class="w-7 h-7 rounded-lg bg-secondary/10 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-secondary text-base">{{ g.icon }}</span></div>
              <h3 class="text-body-sm text-on-surface font-bold">{{ g.label }}</h3>
              <span class="text-body-xs text-on-surface-variant ml-auto">{{ g.count }}</span>
            </div>
            <div class="p-sm flex flex-col gap-xs">
              <div v-for="it in g.items" :key="it._kind + it.name" @click="goTo(it)" class="flex items-center gap-xs px-sm py-xs rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary transition-colors cursor-pointer">
                <span class="material-symbols-outlined text-on-surface-variant text-sm">{{ KIND_ICON[it.kind] || 'circle' }}</span>
                <span class="font-mono text-xs text-on-surface truncate flex-1">{{ it.name }}</span>
              </div>
            </div>
          </div>
          <div v-if="!rightGroups.length" class="rounded-xl border border-dashed border-outline-variant/40 py-md text-center">
            <span class="material-symbols-outlined text-2xl text-surface-container-high">sync_alt</span>
            <p class="text-body-xs text-on-surface-variant mt-xs">中间件<br>（本命名空间暂无）</p>
          </div>
        </div>
      </div>
      <div v-else class="rounded-xl border border-outline-variant py-xl text-center text-on-surface-variant">
        <span class="material-symbols-outlined text-2xl text-surface-container-high">workspaces</span>
        <p class="text-body-sm mt-xs">当前 namespace 无可归类资源</p>
      </div>
    </div>

    <!-- ====== Summary Tab ====== -->
    <div v-if="activeTab === 'summary'" class="flex flex-col gap-sm">
      <!-- Summary Cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-sm">
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md cursor-pointer hover:border-primary transition-colors" @click="router.push({ name: 'NsPods', params: { namespace: route.params.namespace } })">
          <span class="material-symbols-outlined text-primary text-xl">layers</span>
          <h3 class="text-headline-lg font-bold text-primary mt-xs">{{ stats.pods }}</h3>
          <p class="text-body-xs text-on-surface-variant">{{ stats.runningPods }} Running</p>
        </div>
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md cursor-pointer hover:border-primary transition-colors" @click="router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })">
          <span class="material-symbols-outlined text-secondary text-xl">apps</span>
          <h3 class="text-headline-lg font-bold text-on-surface mt-xs">{{ stats.deployments + stats.statefulSets + stats.daemonSets + stats.jobs }}</h3>
          <p class="text-body-xs text-on-surface-variant">{{ stats.deployments }} Deploy · {{ stats.statefulSets }} STS</p>
        </div>
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md cursor-pointer hover:border-primary transition-colors" @click="router.push({ name: 'NsServices', params: { namespace: route.params.namespace } })">
          <span class="material-symbols-outlined text-tertiary text-xl">hub</span>
          <h3 class="text-headline-lg font-bold text-on-surface mt-xs">{{ stats.services }}</h3>
          <p class="text-body-xs text-on-surface-variant">{{ stats.ingress }} Ingress</p>
        </div>
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md cursor-pointer hover:border-primary transition-colors" @click="router.push({ name: 'NsConfigMaps', params: { namespace: route.params.namespace } })">
          <span class="material-symbols-outlined text-on-surface-variant text-xl">description</span>
          <h3 class="text-headline-lg font-bold text-on-surface mt-xs">{{ stats.configMaps + stats.secrets }}</h3>
          <p class="text-body-xs text-on-surface-variant">{{ stats.configMaps }} CM · {{ stats.secrets }} Secrets</p>
        </div>
      </div>

      <!-- Recent Pods + Workloads + Quotas (2-col) -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-sm">
        <!-- Recent Workloads -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2 border-b border-outline-variant/40 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">apps</span>
            <span class="text-body-sm font-semibold">Workloads</span>
            <button @click="router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })" class="text-body-xs text-primary ml-auto">→</button>
          </div>
          <div class="divide-y divide-outline-variant/10">
            <div v-for="w in recentWorkloads" :key="w.name" @click="router.push({ name: 'NsWorkloadDetail', params: { namespace: route.params.namespace, type: w.type.toLowerCase(), name: w.name } })" class="flex items-center gap-sm px-md py-1.5 hover:bg-surface-container-low/40 cursor-pointer">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="statusDot(w.status)"></span>
              <span class="text-body-sm font-medium truncate flex-1">{{ w.name }}</span>
              <span class="text-body-xs text-on-surface-variant">{{ w.type }}</span>
              <span class="font-mono text-xs text-on-surface-variant">{{ w.replicas }}</span>
            </div>
            <p v-if="!recentWorkloads.length" class="px-md py-sm text-body-sm text-on-surface-variant text-center">暂无</p>
          </div>
        </div>
        <!-- Recent Pods -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2 border-b border-outline-variant/40 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">view_in_ar</span>
            <span class="text-body-sm font-semibold">Recent Pods</span>
            <button @click="router.push({ name: 'NsPods', params: { namespace: route.params.namespace } })" class="text-body-xs text-primary ml-auto">→</button>
          </div>
          <div class="divide-y divide-outline-variant/10">
            <div v-for="p in recentPods" :key="p.name" @click="router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } })" class="flex items-center gap-sm px-md py-1.5 hover:bg-surface-container-low/40 cursor-pointer">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="statusDot(p.status)"></span>
              <span class="font-mono text-xs font-medium truncate flex-1">{{ p.name }}</span>
              <span v-if="p.restarts > 0" class="text-body-xs text-tertiary-container">↻{{ p.restarts }}</span>
              <span class="font-mono text-xs text-on-surface-variant/50 hidden md:inline">{{ p.node || '—' }}</span>
            </div>
            <p v-if="!recentPods.length" class="px-md py-sm text-body-sm text-on-surface-variant text-center">暂无</p>
          </div>
        </div>
      </div>

      <!-- Quotas + Events (2-col) -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-sm">
        <!-- Resource Usage -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2 border-b border-outline-variant/40 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">tune</span>
            <span class="text-body-sm font-semibold">Resource Usage</span>
          </div>
          <div class="p-md space-y-sm">
            <ProgressBar :value="62" show-label label="CPU" />
            <ProgressBar :value="75" show-label label="Memory" />
          </div>
        </div>
        <!-- Recent Events -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2 border-b border-outline-variant/40 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">notifications_active</span>
            <span class="text-body-sm font-semibold">Events</span>
            <button @click="router.push({ name: 'NsEvents', params: { namespace: route.params.namespace } })" class="text-body-xs text-primary ml-auto">→</button>
          </div>
          <div class="divide-y divide-outline-variant/10">
            <div v-for="(e, i) in store.nsEvents.slice(0, 5)" :key="i" class="flex items-start gap-xs px-md py-1.5">
              <span class="w-1 h-1 rounded-full mt-1.5 shrink-0" :class="e.type === 'warning' ? 'bg-error' : 'bg-primary'"></span>
              <div class="flex-1 min-w-0">
                <span class="text-body-xs font-medium">{{ e.reason }}</span>
                <span class="text-body-xs text-on-surface-variant/40 ml-xs">{{ e.age }}</span>
                <p class="text-body-xs text-on-surface-variant/70 truncate">{{ e.message }}</p>
              </div>
            </div>
            <p v-if="!store.nsEvents.length" class="px-md py-sm text-body-sm text-on-surface-variant text-center">暂无事件</p>
          </div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="flex flex-wrap gap-xs">
        <button @click="router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })" class="flex items-center gap-xs px-sm py-1.5 text-body-sm font-medium bg-primary/5 text-primary rounded-lg hover:bg-primary/10 transition-colors"><span class="material-symbols-outlined text-sm">rocket_launch</span> Deploy</button>
        <button @click="router.push({ name: 'NsLayers', params: { namespace: route.params.namespace } })" class="flex items-center gap-xs px-sm py-1.5 text-body-sm font-medium bg-surface-container text-on-surface rounded-lg hover:bg-surface-container-high transition-colors"><span class="material-symbols-outlined text-sm">layers</span> 应用分层</button>
        <button @click="router.push({ name: 'NsEvents', params: { namespace: route.params.namespace } })" class="flex items-center gap-xs px-sm py-1.5 text-body-sm font-medium bg-surface-container text-on-surface rounded-lg hover:bg-surface-container-high transition-colors"><span class="material-symbols-outlined text-sm">notifications_active</span> Events</button>
        <button @click="router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })" class="flex items-center gap-xs px-sm py-1.5 text-body-sm font-medium bg-surface-container text-on-surface rounded-lg hover:bg-surface-container-high transition-colors"><span class="material-symbols-outlined text-sm">admin_panel_settings</span> RBAC</button>
        <button @click="router.push({ name: 'NsStorage', params: { namespace: route.params.namespace } })" class="flex items-center gap-xs px-sm py-1.5 text-body-sm font-medium bg-surface-container text-on-surface rounded-lg hover:bg-surface-container-high transition-colors"><span class="material-symbols-outlined text-sm">storage</span> Storage</button>
      </div>
    </div>
  </div>
</template>
