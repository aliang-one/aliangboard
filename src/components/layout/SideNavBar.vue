<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useAuthStore } from '@/stores/auth'
import { useNavMode } from '@/composables/useNavMode'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const authStore = useAuthStore()
const { isNsMode, isClusterMode } = useNavMode()
const _cid = computed(() => (store.currentCluster || 'cluster'))
const _nsQ = useResourceList({ key: ['cluster', _cid.value, 'namespaces'], fetcher: () => store.fetchNamespaces(), options: { refetchInterval: 60000 } })
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
    <!-- Cluster Header:命名空间态=返回集群管理入口;集群态=静态展示 -->
    <button
      v-if="isNsMode"
      data-test="cluster-home"
      @click="router.push('/cluster')"
      :title="$t('nav.backToCluster')"
      :aria-label="$t('nav.backToCluster')"
      class="w-full flex items-center gap-sm p-md px-lg shrink-0 hover:bg-surface-container transition-colors text-left"
    >
      <span class="material-symbols-outlined text-on-surface-variant">chevron_left</span>
      <div class="w-9 h-9 rounded-lg bg-primary flex items-center justify-center text-on-primary">
        <span class="material-symbols-outlined text-lg filled">kubernetes</span>
      </div>
      <div class="min-w-0">
        <h2 class="text-body-md font-bold text-primary leading-tight truncate">{{ store.cluster.name || 'Cluster' }}</h2>
        <p class="text-body-sm text-on-surface-variant">{{ $t('nav.backToCluster') }}</p>
      </div>
    </button>
    <div v-else class="flex items-center gap-md p-md px-lg shrink-0">
      <div class="w-9 h-9 rounded-lg bg-primary flex items-center justify-center text-on-primary">
        <span class="material-symbols-outlined text-lg filled">kubernetes</span>
      </div>
      <div class="min-w-0">
        <h2 class="text-body-md font-bold text-primary leading-tight truncate">{{ store.cluster.name || 'Cluster' }}</h2>
        <p class="text-body-sm text-on-surface-variant">{{ store.cluster.version }}</p>
      </div>
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
    <nav class="flex-1 overflow-y-auto px-md pb-md">
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
    <div class="shrink-0 px-md pb-md pt-sm border-t border-outline-variant/50">
      <button
        v-if="isNsMode"
        @click="router.push({ name: 'NsDeploy', params: { namespace: currentNs } })"
        class="w-full py-sm px-md bg-primary text-on-primary rounded-lg font-semibold shadow-sm hover:opacity-90 active:scale-95 transition-all flex items-center justify-center gap-sm mb-sm"
      >
        <span class="material-symbols-outlined text-lg">rocket_launch</span>
        {{ $t('nav.deploy') }}
      </button>
      <!-- 事件 / 活动记录 / 设置:横向 icon-only 行(icon-only,label 走 title/aria-label) -->
      <div class="flex items-stretch gap-xs">
        <button v-if="isNsMode" data-test="bottom-events"
          @click="goNsRoute('events')"
          :title="$t('nav.events')" :aria-label="$t('nav.events')"
          class="flex-1 flex items-center justify-center py-sm rounded-lg transition-colors"
          :class="isNsRouteActive('events') ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
          <span class="material-symbols-outlined text-lg">notifications_active</span>
        </button>
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
