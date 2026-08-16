<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useAuthStore } from '@/stores/auth'
import { useNavMode, drillDirection } from '@/composables/useNavMode'
import { getSession } from '@/api/client'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const authStore = useAuthStore()
const { navMode, isNsMode, isClusterMode } = useNavMode()
// 钻入方向:进入 ns = 'down'(菜单从下滑入),返回集群 = 'up'(从上滑入)
const drillDir = ref('down')
watch(navMode, (m, prev) => {
  drillDir.value = drillDirection(prev, m) ?? drillDir.value
})
const _cid = computed(() => (store.currentCluster || 'cluster'))
// 无 K8s session（首装 admin 在平台管理页）时不轮询 namespaces——拉了必 401
const _nsEnabled = computed(() => !!getSession())
const _nsQ = useResourceList({ key: ['cluster', _cid, 'namespaces'], fetcher: () => store.fetchNamespaces(), options: { refetchInterval: 60000, enabled: _nsEnabled } })
const allNamespaces = computed(() => _nsQ.data.value ?? store.namespaceList)

const showNsDropdown = ref(false)
const nsSearch = ref('')

// 集群级导航——分三组，全部收进可折叠的「集群管理」专门板块。
// 集群级导航——分三组，收进可折叠的「集群管理」板块（仅集群态渲染；命名空间态整组隐藏）。
const clusterPrimaryNav = [
  { icon: 'dashboard', labelKey: 'nav.clusterOverview', route: '/cluster' },
  { icon: 'dns', labelKey: 'nav.nodes', route: '/nodes' },
  { icon: 'folder_open', labelKey: 'nav.namespaces', route: '/namespaces' },
  { icon: 'storage', labelKey: 'nav.storage', route: '/storage' },
  { icon: 'monitoring', labelKey: 'nav.monitoring', route: '/monitoring' },
]
const clusterResourcesNav = [
  { icon: 'extension', labelKey: 'nav.crds', route: '/crds' },
  { icon: 'flag', label: 'PriorityClasses', route: '/priorityclasses' },
  { icon: 'language', label: 'IngressClasses', route: '/ingressclasses' },
  { icon: 'memory', label: 'RuntimeClasses', route: '/runtimeclasses' },
  { icon: 'api', label: 'APIServices', route: '/admin/apiservices' },
  { icon: 'webhook', label: 'Mutating Webhooks', route: '/admin/webhooks-mutating' },
  { icon: 'rule', label: 'Validating Webhooks', route: '/admin/webhooks-validating' },
  { icon: 'dynamic_feed', label: 'ReplicaSets', route: '/admin/replicasets' },
  { icon: 'hard_drive', label: 'CSINodes', route: '/admin/csinodes' },
]
const clusterOtherNav = [
  { icon: 'hub', labelKey: 'nav.clusters', route: '/clusters' },
]
// 平台管理（admin only）
const platformAdminNav = [
  { icon: 'group', labelKey: 'nav.userManagement', route: '/admin/users' },
  { icon: 'cloud', labelKey: 'nav.clusterManagement', route: '/admin/clusters' },
  { icon: 'vpn_key', labelKey: 'nav.apiKeys', route: '/admin/apikeys' },
  { icon: 'smart_toy', labelKey: 'nav.aiConsole', route: '/admin/agent' },
  { icon: 'neurology', labelKey: 'nav.llmConfig', route: '/admin/llm-config' },
  { icon: 'shield', labelKey: 'nav.auditTrail', route: '/admin/audit-trail' },
]
const clusterNavOpen = ref(true)

// Namespace 作用域导航 - 按 Kuboard 分组
const nsNavGroups = [
  {
    labelKey: 'nav.workloads',
    icon: 'work',
    items: [
      { icon: 'apps', labelKey: 'nav.workloadsList', routeKey: 'workloads' },
      { icon: 'view_in_ar', label: 'Pods', routeKey: 'pods' },
      { icon: 'timeline', label: 'HPA', routeKey: 'hpa' },
    ]
  },
  {
    labelKey: 'nav.network',
    icon: 'share',
    items: [
      { icon: 'hub', label: 'Services', routeKey: 'services' },
      { icon: 'language', label: 'Ingress', routeKey: 'ingress' },
      { icon: 'shield', label: 'NetworkPolicy', routeKey: 'networkpolicies' },
    ]
  },
  {
    labelKey: 'nav.storageConfig',
    icon: 'folder_shared',
    items: [
      { icon: 'storage', label: 'Storage (PVC)', routeKey: 'storage' },
      { icon: 'description', label: 'ConfigMaps', routeKey: 'configmaps' },
      { icon: 'key', label: 'Secrets', routeKey: 'secrets' },
    ]
  },
  {
    labelKey: 'nav.security',
    icon: 'security',
    items: [
      { icon: 'admin_panel_settings', label: 'RBAC', routeKey: 'rbac' },
    ]
  },
  {
    labelKey: 'nav.policy',
    icon: 'policy',
    items: [
      { icon: 'pie_chart', label: 'ResourceQuota', routeKey: 'resourcequotas' },
      { icon: 'tune', label: 'LimitRange', routeKey: 'limitranges' },
      { icon: 'shield', label: 'PDB', routeKey: 'pdbs' },
    ]
  },
]

const currentNs = computed(() => store.currentNamespace)

const filteredNamespaces = computed(() => {
  if (!nsSearch.value) return allNamespaces.value
  const q = nsSearch.value.toLowerCase()
  return allNamespaces.value.filter(ns => ns.name.toLowerCase().includes(q))
})

const nsRouteMap = {
  overview: 'NamespaceOverview',
  events: 'NsEvents',
  layers: 'NsLayers',
  workloads: 'NsWorkloads',
  pods: 'NsPods',
  hpa: 'NsHPA',
  services: 'NsServices',
  ingress: 'NsIngress',
  networkpolicies: 'NsNetworkPolicies',
  storage: 'NsStorage',
  configmaps: 'NsConfigMaps',
  secrets: 'NsSecrets',
  rbac: 'NsRBAC',
  resourcequotas: 'NsResourceQuotas',
  limitranges: 'NsLimitRanges',
  pdbs: 'NsPDBs',
}

function selectNamespace(ns) {
  store.setNamespace(ns)
  showNsDropdown.value = false
  nsSearch.value = ''
  router.push({ name: 'NamespaceOverview', params: { namespace: ns } })
}

function goNsRoute(routeKey) {
  if (!currentNs.value) return
  const name = nsRouteMap[routeKey]
  if (name) router.push({ name, params: { namespace: currentNs.value } })
}

function isGlobalActive(path) {
  if (route.path === path) return true
  // 仅对有子路由的项用前缀匹配（避免 /cluster 误匹配 /clusters）
  if (path === '/nodes' && route.path.startsWith('/nodes/')) return true
  if (path === '/crds' && route.path.startsWith('/crds/')) return true
  return false
}

function isNsRouteActive(routeKey) {
  const name = nsRouteMap[routeKey]
  if (!name) return false
  if (route.name === name) return true
  if (name === 'NsWorkloads' && route.name === 'NsWorkloadDetail') return true
  if (name === 'NsPods' && route.name === 'NsPodDetail') return true
  if (name === 'NsServices' && route.name === 'NsServiceDetail') return true
  if (name === 'NsIngress' && route.name === 'NsIngressDetail') return true
  if (name === 'NsStorage' && (route.name === 'NsPVCDetail')) return true
  if (name === 'NsConfigMaps' && route.name === 'NsConfigMapDetail') return true
  if (name === 'NsSecrets' && route.name === 'NsSecretDetail') return true
  if (name === 'NsRBAC' && (route.name === 'NsRoleDetail' || route.name === 'NsServiceAccountDetail' || route.name === 'NsRoleBindingDetail')) return true
  if (name === 'NsNetworkPolicies' && route.name === 'NsNetworkPolicyDetail') return true
  if (name === 'NsHPA' && route.name === 'NsHPADetail') return true
  if (name === 'NsResourceQuotas' && route.name === 'NsResourceQuotaDetail') return true
  if (name === 'NsLimitRanges' && route.name === 'NsLimitRangeDetail') return true
  if (name === 'NsPDBs' && route.name === 'NsPDBDetail') return true
  return false
}

// 从 URL 同步 namespace
watch(() => route.params.namespace, (ns) => {
  if (ns && ns !== store.currentNamespace) {
    store.setNamespace(ns)
  }
}, { immediate: true })

// 点击外部关闭下拉
function closeDropdown() {
  showNsDropdown.value = false
  nsSearch.value = ''
}

// Namespace 状态颜色
function nsStatusColor(status) {
  return status === 'Active' ? 'bg-primary-container' : 'bg-on-surface-variant'
}
</script>

<template>
  <aside class="fixed left-0 top-0 h-full flex flex-col z-40 w-[260px] bg-surface-container-lowest border-r border-outline-variant overflow-hidden">
    <!-- Cluster Header:两态容器——集群态大头部 / ns 态收缩锚点条(整行可点返回) -->
    <div data-test="cluster-header" class="shrink-0 px-lg flex items-center transition-all duration-300 ease-out overflow-hidden"
      :class="isClusterMode ? 'h-[68px]' : 'h-[44px]'">
      <div v-if="isClusterMode" data-test="cluster-brand" class="flex items-center gap-md w-full">
        <div class="w-9 h-9 rounded-lg bg-primary flex items-center justify-center text-on-primary">
          <span class="material-symbols-outlined text-lg filled">kubernetes</span>
        </div>
        <div class="min-w-0">
          <h2 class="text-body-md font-bold text-primary leading-tight truncate">{{ store.cluster.name || 'Cluster' }}</h2>
          <p class="text-body-sm text-on-surface-variant">{{ store.cluster.version }}</p>
        </div>
      </div>
      <button v-else data-test="cluster-anchor" @click="router.push('/cluster')"
        class="flex items-center gap-sm w-full min-w-0 group cursor-pointer"
        :title="$t('nav.backToCluster')" :aria-label="$t('nav.backToCluster')">
        <span class="material-symbols-outlined text-lg text-primary">kubernetes</span>
        <span class="text-body-md font-semibold text-on-surface truncate">{{ store.cluster.name || 'Cluster' }}</span>
        <span class="ml-auto flex items-center gap-2xs text-body-sm text-on-surface-variant transition-colors group-hover:text-primary">
          <span class="material-symbols-outlined text-base">chevron_left</span>
          <span class="whitespace-nowrap">{{ $t('nav.backToCluster') }}</span>
        </span>
      </button>
    </div>

    <!-- Divider -->
    <div class="h-px bg-outline-variant/50 mx-md"></div>

    <!-- Namespace Selector -->
    <div class="px-md pt-md pb-sm shrink-0">
      <p class="text-label-caps text-on-surface-variant mb-xs px-sm">NAMESPACE</p>
      <div class="relative">
        <div
          class="w-full flex items-stretch rounded-lg border overflow-hidden transition-all"
          :class="currentNs ? 'border-primary bg-primary/5' : 'border-outline-variant bg-surface-container-low hover:border-primary/50'"
        >
          <button
            data-test="ns-home"
            @click="currentNs && router.push({ name: 'NamespaceOverview', params: { namespace: currentNs } })"
            class="flex-1 flex items-center gap-sm min-w-0 px-md py-sm"
            :class="currentNs ? 'text-primary' : 'text-on-surface-variant'"
          >
            <span class="material-symbols-outlined text-lg">folder_open</span>
            <span v-if="isClusterMode" data-test="ns-enter" aria-hidden="true" class="material-symbols-outlined text-base text-on-surface-variant">arrow_forward</span>
            <span class="text-body-md font-medium truncate">{{ currentNs || 'Select Namespace' }}</span>
          </button>
          <button
            @click="showNsDropdown = !showNsDropdown"
            class="px-md py-sm shrink-0 border-l border-current/10"
            :class="currentNs ? 'text-primary' : 'text-on-surface-variant'"
          >
            <span class="material-symbols-outlined text-lg transition-transform" :class="showNsDropdown ? 'rotate-180' : ''">expand_more</span>
          </button>
        </div>
        <!-- Dropdown -->
        <div
          v-if="showNsDropdown"
          class="absolute top-full left-0 right-0 mt-1 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-50 overflow-hidden"
        >
          <!-- Search -->
          <div class="p-sm border-b border-outline-variant">
            <div class="relative">
              <span class="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-on-surface-variant text-sm pointer-events-none">search</span>
              <input v-model="nsSearch" class="w-full bg-surface-container-low border border-outline-variant rounded-md pl-8 pr-sm py-1.5 text-body-sm focus:ring-1 focus:ring-primary focus:border-primary" placeholder="Filter namespaces..." />
            </div>
          </div>
          <!-- List -->
          <div class="max-h-56 overflow-y-auto p-sm">
            <div
              v-for="ns in filteredNamespaces"
              :key="ns.name"
              @click="selectNamespace(ns.name)"
              class="flex items-center justify-between px-md py-sm rounded-lg cursor-pointer transition-all hover:bg-surface-container"
              :class="currentNs === ns.name ? 'bg-primary-container/20 text-primary' : 'text-on-surface'"
            >
              <div class="flex items-center gap-sm">
                <span class="w-2 h-2 rounded-full shrink-0" :class="nsStatusColor(ns.status)"></span>
                <span class="text-body-md font-medium">{{ ns.name }}</span>
              </div>
              <span class="text-body-sm text-on-surface-variant">{{ ns.pods }} pods</span>
            </div>
            <p v-if="!filteredNamespaces.length" class="text-body-sm text-on-surface-variant text-center py-md">No matching namespaces</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Scrollable Navigation -->
    <nav class="relative flex-1 overflow-y-auto px-md pb-md">
      <Transition :name="drillDir === 'down' ? 'drill-down' : 'drill-up'">
        <div :key="navMode">
          <!-- 命名空间作用域导航：选中 ns 后为主，置顶 -->
          <div v-if="isNsMode" data-test="ns-nav-section" class="animate-fade-in mb-md">
            <p class="text-label-caps text-on-surface-variant px-sm mb-xs truncate">NAMESPACE: {{ currentNs }}</p>
            <div v-for="group in nsNavGroups" :key="group.label || group.labelKey" class="mb-xs">
              <div class="flex items-center gap-xs px-md pt-sm pb-xs">
                <span class="material-symbols-outlined text-xs text-on-surface-variant opacity-50">{{ group.icon }}</span>
                <p class="text-xs text-on-surface-variant font-medium opacity-60">{{ group.labelKey ? $t(group.labelKey) : group.label }}</p>
              </div>
              <a
                v-for="item in group.items"
                :key="item.routeKey"
                @click="goNsRoute(item.routeKey)"
                class="flex items-center gap-md px-md py-sm rounded-lg cursor-pointer transition-all duration-200 ml-sm"
                :class="isNsRouteActive(item.routeKey)
                  ? 'bg-primary-container text-on-primary-container font-semibold'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'"
              >
                <span class="material-symbols-outlined text-lg">{{ item.icon }}</span>
                <span class="text-body-sm">{{ item.labelKey ? $t(item.labelKey) : item.label }}</span>
              </a>
            </div>
          </div>

          <!-- 集群管理：可折叠板块（仅集群态渲染）；命名空间态整组隐藏 -->
          <div v-if="isClusterMode" data-test="cluster-nav-section" class="flex flex-col gap-xs">
            <button @click="clusterNavOpen = !clusterNavOpen"
              class="flex items-center gap-xs px-sm mb-xs text-on-surface-variant hover:text-on-surface transition-colors w-full">
              <span class="material-symbols-outlined text-base transition-transform" :class="clusterNavOpen ? 'rotate-90' : ''">chevron_right</span>
              <p class="text-label-caps">{{ $t('nav.clusterManagement') }}</p>
            </button>
            <div v-show="clusterNavOpen" class="flex flex-col gap-xs">
              <a v-for="item in clusterPrimaryNav" :key="item.route" @click="router.push(item.route)"
                class="flex items-center gap-md px-md py-sm rounded-lg cursor-pointer transition-all duration-200"
                :class="isGlobalActive(item.route) ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
                <span class="material-symbols-outlined text-lg">{{ item.icon }}</span>
                <span class="text-body-sm">{{ item.labelKey ? $t(item.labelKey) : item.label }}</span>
              </a>
              <p class="text-xs text-on-surface-variant opacity-50 px-md pt-sm pb-xs">{{ $t('nav.clusterResources') }}</p>
              <a v-for="item in clusterResourcesNav" :key="item.route" @click="router.push(item.route)"
                class="flex items-center gap-md px-md py-sm rounded-lg cursor-pointer transition-all duration-200"
                :class="isGlobalActive(item.route) ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
                <span class="material-symbols-outlined text-lg">{{ item.icon }}</span>
                <span class="text-body-sm">{{ item.labelKey ? $t(item.labelKey) : item.label }}</span>
              </a>
              <p class="text-xs text-on-surface-variant opacity-50 px-md pt-sm pb-xs">{{ $t('nav.multiCluster') }}</p>
              <a v-for="item in clusterOtherNav" :key="item.route" @click="router.push(item.route)"
                class="flex items-center gap-md px-md py-sm rounded-lg cursor-pointer transition-all duration-200"
                :class="isGlobalActive(item.route) ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
                <span class="material-symbols-outlined text-lg">{{ item.icon }}</span>
                <span class="text-body-sm">{{ item.labelKey ? $t(item.labelKey) : item.label }}</span>
              </a>
            </div>
          </div>
        </div>
      </Transition>

      <!-- 平台管理（admin only）-->
      <div v-if="authStore.isAdmin" class="px-md pt-sm">
        <p class="text-label-caps text-on-surface-variant/60 px-sm pb-xs">{{ $t('nav.platformAdmin') }}</p>
        <a v-for="item in platformAdminNav" :key="item.route" @click="router.push(item.route)"
          class="flex items-center gap-md px-md py-sm rounded-lg cursor-pointer transition-all duration-200"
          :class="route.path === item.route ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
          <span class="material-symbols-outlined text-lg">{{ item.icon }}</span>
          <span class="text-body-sm">{{ item.labelKey ? $t(item.labelKey) : item.label }}</span>
        </a>
      </div>
    </nav>

    <!-- Bottom Actions -->
    <div data-test="bottom-actions" class="shrink-0 px-md pb-md pt-sm">
      <!-- 部署大卡(Task 4 已就位,不动) -->
      <button
        v-if="isNsMode"
        data-test="deploy-card"
        @click="router.push({ name: 'NsDeploy', params: { namespace: currentNs } })"
        class="deploy-card relative w-full flex items-center gap-md px-md py-sm mb-2 rounded-[18px] text-on-primary overflow-hidden cursor-pointer"
      >
        <span class="deploy-card__chip flex items-center justify-center w-9 h-9 rounded-xl shrink-0">
          <span class="material-symbols-outlined text-lg">rocket_launch</span>
        </span>
        <span class="relative z-10 min-w-0 text-left">
          <span class="block text-[15px] font-bold tracking-[0.25em]">{{ $t('nav.deploy') }}</span>
          <span class="block text-[9.5px] tracking-[0.14em] opacity-85">DEPLOY · {{ currentNs }}</span>
        </span>
        <span class="deploy-card__go absolute right-md top-1/2 text-lg opacity-55">›</span>
      </button>
      <!-- ns 态:角板停靠坞 -->
      <div v-if="isNsMode" class="dock-band relative mt-sm mb-xs h-[100px]">
        <span class="slab-ring sr1" aria-hidden="true"></span>
        <span class="slab-ring sr2" aria-hidden="true"></span>
        <button data-test="cluster-slab" @click="router.push('/cluster')"
          class="cluster-slab absolute left-0 bottom-0 flex items-center gap-sm pl-md pr-lg text-left cursor-pointer"
          :title="$t('nav.backToCluster')" :aria-label="$t('nav.backToCluster')">
          <span class="slab-chip flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-base filled">kubernetes</span>
          </span>
          <span class="min-w-0">
            <span class="flex items-center gap-2xs">
              <span class="text-[12px] font-bold text-on-primary truncate">{{ store.cluster.name || 'Cluster' }}</span>
              <i class="slab-led" aria-hidden="true"></i>
            </span>
            <span class="block text-[9px] text-on-primary/80 whitespace-nowrap">↩ {{ $t('nav.backToCluster') }}</span>
          </span>
        </button>
        <!-- 3 图标:沿角板斜肩阶梯 -->
        <div class="absolute right-0 bottom-0 flex items-end gap-sm">
          <button data-test="bottom-events" @click="goNsRoute('events')" class="dock-ig dock-ig--high cursor-pointer"
            :class="isNsRouteActive('events') ? 'dock-ig--hot' : ''">
            <span class="dock-ig__sq"><span class="material-symbols-outlined text-lg">notifications_active</span></span>
            <span class="dock-ig__lb">{{ $t('nav.events') }}</span>
          </button>
          <button data-test="bottom-activity" @click="router.push('/audit-logs')" class="dock-ig cursor-pointer"
            :class="isGlobalActive('/audit-logs') ? 'dock-ig--hot' : ''">
            <span class="dock-ig__sq"><span class="material-symbols-outlined text-lg">history</span></span>
            <span class="dock-ig__lb">{{ $t('nav.activityLog') }}</span>
          </button>
          <button data-test="bottom-settings" @click="router.push('/settings')" class="dock-ig dock-ig--low cursor-pointer"
            :class="isGlobalActive('/settings') ? 'dock-ig--hot' : ''">
            <span class="dock-ig__sq"><span class="material-symbols-outlined text-lg">settings</span></span>
            <span class="dock-ig__lb">{{ $t('nav.settings') }}</span>
          </button>
        </div>
      </div>
      <!-- 集群态:活动+设置(维持现状布局) -->
      <div v-else class="flex items-stretch gap-xs">
        <a data-test="bottom-activity" @click="router.push('/audit-logs')"
          :title="$t('nav.activityLog')" :aria-label="$t('nav.activityLog')"
          class="flex-1 flex items-center justify-center py-sm rounded-lg transition-colors cursor-pointer"
          :class="isGlobalActive('/audit-logs') ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
          <span class="material-symbols-outlined text-lg">history</span>
        </a>
        <a data-test="bottom-settings" @click="router.push('/settings')"
          :title="$t('nav.settings')" :aria-label="$t('nav.settings')"
          class="flex-1 flex items-center justify-center py-sm rounded-lg transition-colors cursor-pointer"
          :class="isGlobalActive('/settings') ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
          <span class="material-symbols-outlined text-lg">settings</span>
        </a>
      </div>
    </div>
  </aside>
  <!-- Click-outside overlay -->
  <div v-if="showNsDropdown" class="fixed inset-0 z-30" @click="closeDropdown"></div>
</template>

<style scoped>
/* 方向感知钻入:进 ns = 新菜单自下方 24px 滑入、旧菜单向上滑出;返回集群反向 */
.drill-down-enter-from { opacity: 0; transform: translateY(24px); }
.drill-down-leave-to { opacity: 0; transform: translateY(-24px); }
.drill-up-enter-from { opacity: 0; transform: translateY(-24px); }
.drill-up-leave-to { opacity: 0; transform: translateY(24px); }
.drill-down-enter-active,
.drill-down-leave-active,
.drill-up-enter-active,
.drill-up-leave-active {
  transition: opacity .3s cubic-bezier(.2,.7,.3,1), transform .3s cubic-bezier(.2,.7,.3,1);
}
.drill-down-leave-active,
.drill-up-leave-active { position: absolute; left: 0; right: 0; top: 0; }
@media (prefers-reduced-motion: reduce) {
  .drill-down-enter-active, .drill-down-leave-active,
  .drill-up-enter-active, .drill-up-leave-active { transition: none; }
}

/* 部署大卡:三段渐变 + 高光圈 + 内嵌光泽(v6 定稿) */
.deploy-card {
  background: linear-gradient(133deg, #00a173 0%, #00835b 52%, #005c3f 100%);
  box-shadow: 0 8px 22px rgba(0, 92, 63, .34), inset 0 1px 0 rgba(255, 255, 255, .28), inset 0 -8px 18px rgba(0, 40, 27, .18);
  transition: transform .18s cubic-bezier(.2, .7, .3, 1), box-shadow .18s;
}
.deploy-card::after {
  content: ''; position: absolute; right: -24px; top: -28px;
  width: 88px; height: 88px; border-radius: 50%; background: rgba(255, 255, 255, .10);
}
.deploy-card__chip {
  background: rgba(255, 255, 255, .17); border: 1px solid rgba(255, 255, 255, .22);
}
.deploy-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 26px rgba(0, 92, 63, .40), inset 0 1px 0 rgba(255, 255, 255, .30), inset 0 -8px 18px rgba(0, 40, 27, .18);
}
.deploy-card:active { transform: translateY(0) scale(.985); }
/* __go 的 transform 统一由 CSS 管(模板不带 -translate-y-1/2,避免与 hover transform 冲突) */
.deploy-card__go { transform: translateY(-50%); transition: transform .18s, opacity .18s; }
.deploy-card:hover .deploy-card__go { transform: translateY(-50%) translateX(3px); opacity: .9; }

/* ===== 角板停靠坞(v6-B 定稿) ===== */
.dock-band { overflow: visible; }
.slab-ring {
  position: absolute; left: 0; bottom: 0; pointer-events: none;
  border-radius: 0 42px 16px 0; border: 1.5px solid rgba(0, 134, 90, .24);
}
.slab-ring.sr1 { width: 200px; height: 88px; }
.slab-ring.sr2 { width: 236px; height: 104px; border-color: rgba(0, 134, 90, .11); }
.cluster-slab {
  width: 170px; height: 76px; border-radius: 0 42px 16px 0;
  background: linear-gradient(120deg, #0ba874 0%, #00835b 55%, #006747 100%);
  box-shadow: 3px -5px 18px rgba(0, 108, 73, .34), inset 0 1px 0 rgba(255, 255, 255, .26), inset 0 -6px 14px rgba(0, 40, 27, .18);
  color: #fff; transition: filter .18s, box-shadow .18s;
}
.cluster-slab:hover { filter: brightness(1.07); box-shadow: 3px -7px 22px rgba(0, 108, 73, .44), inset 0 1px 0 rgba(255, 255, 255, .28), inset 0 -6px 14px rgba(0, 40, 27, .18); }
.slab-chip {
  width: 30px; height: 30px; border-radius: 10px;
  background: rgba(255, 255, 255, .16); border: 1px solid rgba(255, 255, 255, .25); color: #fff;
}
.slab-led {
  width: 5px; height: 5px; border-radius: 50%; background: #8bf5be;
  box-shadow: 0 0 5px #8bf5be; flex: none; animation: slab-led-pulse 2.4s ease-in-out infinite;
}
@keyframes slab-led-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }

/* ===== 3 图标:阶梯 + 微标签 ===== */
.dock-ig { display: flex; flex-direction: column; align-items: center; gap: 2px; }
/* 阶梯偏移用 margin 而非 transform:dock-pop 动画 both 填充会持续接管 transform,
   translateY 偏移会被终帧 scale(1) 吃掉(容器 items-end 下 margin-bottom 等效) */
.dock-ig--high { margin-bottom: 8px; }
.dock-ig--low { margin-bottom: -5px; }
.dock-ig__sq {
  width: 38px; height: 38px; border-radius: 12px;
  background: #ffffff; border: 1px solid #bbcabf; color: #3c4a42;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 12px rgba(0, 60, 35, .13), inset 0 1px 0 #fff;
  transition: transform .16s cubic-bezier(.2, .7, .3, 1), box-shadow .16s, color .16s, background .16s;
}
.dock-ig:hover .dock-ig__sq { transform: translateY(-3px); box-shadow: 0 8px 18px rgba(0, 60, 35, .20); color: #006c49; }
.dock-ig--hot .dock-ig__sq { background: #d7e8df; color: #006c49; border-color: #a9cfbd; }
.dock-ig__lb { font-size: 8.5px; color: #3c4a42; letter-spacing: .04em; line-height: 1; }

/* ===== 钻入 ns 入场编排(spec §6;返回集群走 drill-up 菜单体感) ===== */
/* 元素因 v-if 随 ns 态新插入,animation 自动播一次;返回集群 v-if 直接卸载无出场 */
.deploy-card { animation: dock-rise .5s cubic-bezier(.2, .7, .3, 1) .06s both; }
.cluster-slab { animation: dock-swell .55s cubic-bezier(.3, 1.25, .45, 1) .14s both; transform-origin: 0% 100%; }
.slab-ring.sr1 { animation: ring-grow .5s ease-out .26s both; transform-origin: 0% 100%; }
.slab-ring.sr2 { animation: ring-grow .5s ease-out .34s both; transform-origin: 0% 100%; }
.dock-ig:nth-child(1) { animation: dock-pop .42s cubic-bezier(.3, 1.4, .5, 1) .32s both; }
.dock-ig:nth-child(2) { animation: dock-pop .42s cubic-bezier(.3, 1.4, .5, 1) .41s both; }
.dock-ig:nth-child(3) { animation: dock-pop .42s cubic-bezier(.3, 1.4, .5, 1) .50s both; }

@keyframes dock-rise { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dock-swell { 0% { opacity: 0; transform: scale(.55); } 70% { opacity: 1; transform: scale(1.05); } 100% { transform: scale(1); } }
@keyframes ring-grow { from { opacity: 0; transform: scale(.78); } to { opacity: 1; transform: scale(1); } }
@keyframes dock-pop { 0% { opacity: 0; transform: scale(.3); } 75% { opacity: 1; transform: scale(1.12); } 100% { opacity: 1; transform: scale(1); } }

/* reduce:编排动画全禁(含 slab-led 呼吸);同时兑现 Task 4/5 遗留——hover transition 一并禁用 */
@media (prefers-reduced-motion: reduce) {
  .deploy-card, .cluster-slab, .slab-ring, .dock-ig, .slab-led { animation: none !important; }
  .deploy-card, .deploy-card__go, .cluster-slab, .dock-ig__sq { transition: none !important; }
}
</style>
