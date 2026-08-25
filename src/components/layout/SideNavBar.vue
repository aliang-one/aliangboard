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
  { icon: 'tune', labelKey: 'nav.aiBehavior', route: '/admin/ai-behavior' },
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

// ns 主按钮:空态开下拉(不跳转);否则进/回 NamespaceOverview(集群态=进入,ns态=回总览)
function onNsHomeClick() {
  if (!currentNs.value) { showNsDropdown.value = true; return }
  router.push({ name: 'NamespaceOverview', params: { namespace: currentNs.value } })
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
    <div data-test="cluster-header" class="cluster-header shrink-0 px-lg flex items-center transition-all duration-300 ease-out overflow-hidden"
      :class="isClusterMode ? 'h-[68px]' : 'h-[44px]'">
      <div v-if="isClusterMode" data-test="cluster-brand" class="flex items-center gap-md w-full">
        <img src="/aliang-logo.svg" alt="AliangBoard" class="w-9 h-auto shrink-0" width="36" height="33" />
        <div class="min-w-0">
          <h2 class="text-body-md font-bold text-primary leading-tight truncate">{{ store.cluster.name || 'Cluster' }}</h2>
          <p class="text-body-sm text-on-surface-variant">{{ store.cluster.version }}</p>
        </div>
      </div>
      <button v-else data-test="cluster-anchor" @click="router.push('/cluster')"
        class="flex items-center gap-sm w-full min-w-0 group cursor-pointer"
        :title="$t('nav.backToCluster')" :aria-label="$t('nav.backToCluster')">
        <img src="/aliang-logo.svg" alt="" class="h-5 w-auto shrink-0" width="22" height="20" />
        <span class="text-body-md font-semibold text-on-surface truncate">{{ store.cluster.name || 'Cluster' }}</span>
        <span class="ml-auto flex items-center text-body-sm text-on-surface-variant transition-colors group-hover:text-primary">
          <span class="material-symbols-outlined text-base">chevron_left</span>
        </span>
      </button>
    </div>

    <!-- Divider -->
    <div class="h-px bg-outline-variant/50 mx-md"></div>

    <!-- Namespace Selector:浅坞 band(方案 B,docs/superpowers/specs/2026-08-18-ns-button-dock-style-design.md) -->
    <div class="px-md pt-md pb-sm shrink-0">
      <p class="text-label-caps text-on-surface-variant mb-xs px-sm">NAMESPACE</p>
      <div class="relative">
        <div class="ns-band" :class="isClusterMode ? 'ns-band--cluster' : 'ns-band--ns'">
          <button
            data-test="ns-home"
            class="ns-main"
            :title="!currentNs ? $t('nav.selectNamespace') : (isClusterMode ? $t('nav.enterNamespace') : $t('nav.backToNsOverview'))"
            :aria-label="!currentNs ? $t('nav.selectNamespace') : (isClusterMode ? $t('nav.enterNamespace') : $t('nav.backToNsOverview'))"
            @click="onNsHomeClick"
          >
            <span class="ns-chip">
              <span class="material-symbols-outlined ns-ci ns-ci--folder">folder_open</span>
              <span class="material-symbols-outlined ns-ci ns-ci--hub">hub</span>
            </span>
            <span class="ns-txt">
              <b class="ns-name" :class="{ 'ns-name--empty': !currentNs }">{{ currentNs || $t('nav.selectNamespace') }}</b>
              <span v-if="currentNs" class="ns-sub">
                <template v-if="isClusterMode">
                  <span class="ns-t ns-t--def">{{ $t('nav.nsNotEntered') }}</span>
                  <span class="ns-t ns-t--hov">{{ $t('nav.enterNamespace') }}</span>
                </template>
                <template v-else>
                  <span class="ns-t ns-t--def">{{ $t('nav.nsHere') }}</span>
                  <span class="ns-t ns-t--hov">{{ $t('nav.backToNsOverview') }}</span>
                </template>
              </span>
            </span>
            <span v-if="isClusterMode && currentNs" data-test="ns-enter" aria-hidden="true" class="ns-arr material-symbols-outlined">arrow_forward</span>
          </button>
          <button
            class="ns-tile"
            :title="$t('nav.switchNamespace')"
            :aria-label="$t('nav.switchNamespace')"
            :aria-expanded="showNsDropdown ? 'true' : 'false'"
            @click="showNsDropdown = !showNsDropdown"
          >
            <span class="material-symbols-outlined transition-transform" :class="showNsDropdown ? 'rotate-180' : ''">expand_more</span>
          </button>
        </div>
        <!-- Dropdown:坞语言化面板 -->
        <div v-if="showNsDropdown" class="ns-drop">
          <div class="p-1.5 border-b border-outline-variant">
            <div class="ns-search">
              <span class="material-symbols-outlined ns-search__ic">search</span>
              <input v-model="nsSearch" :placeholder="$t('nav.filterNamespaces')" />
            </div>
          </div>
          <div class="max-h-56 overflow-y-auto p-1.5">
            <div
              v-for="ns in filteredNamespaces"
              :key="ns.name"
              class="ns-row"
              :class="currentNs === ns.name ? 'ns-row--cur' : ''"
              @click="selectNamespace(ns.name)"
            >
              <span class="w-2 h-2 rounded-full shrink-0" :class="nsStatusColor(ns.status)"></span>
              <span class="ns-row__name">{{ ns.name }}</span>
              <span class="ns-row__pods">{{ ns.pods }} pods</span>
            </div>
            <p v-if="!filteredNamespaces.length" class="text-body-sm text-on-surface-variant text-center py-md">{{ $t('nav.noMatchingNamespaces') }}</p>
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
      <!-- ns 态:单一停靠坞板块——集群 hero + 部署 + 3 图标一行成组 -->
      <div v-if="isNsMode" class="dock-band relative mt-sm mb-xs">
        <div class="dock flex items-stretch gap-1.5 p-1.5">
          <button data-test="cluster-slab" @click="router.push('/cluster')"
            class="cluster-slab flex-1 min-w-0 flex items-center gap-sm px-sm text-left cursor-pointer"
            :title="$t('nav.clusterOverview')" :aria-label="$t('nav.clusterOverview')">
            <span class="slab-chip flex items-center justify-center shrink-0">
              <img src="/aliang-logo.svg" alt="" class="h-4 w-auto" width="18" height="16" />
            </span>
            <span class="min-w-0">
              <span class="flex items-center gap-2xs">
                <span class="text-[11px] font-bold text-on-primary truncate">{{ store.cluster.name || 'Cluster' }}</span>
                <i class="slab-led" aria-hidden="true"></i>
              </span>
              <span class="block text-[8px] text-on-primary/80 whitespace-nowrap">{{ $t('nav.clusterOverview') }}</span>
            </span>
          </button>
          <!-- 4 图标 3 列网格:设置/事件/活动,部署横跨底行(高频入口给最大点击面+文字) -->
          <div class="grid grid-cols-3 gap-1 content-center shrink-0">
            <button data-test="bottom-settings" @click="router.push('/settings')"
              :title="$t('nav.settings')" :aria-label="$t('nav.settings')"
              class="dock-ig dock-ig--lg cursor-pointer" :class="isGlobalActive('/settings') ? 'dock-ig--hot' : ''">
              <span class="dock-ig__sq"><span class="material-symbols-outlined text-base">settings</span></span>
            </button>
            <button data-test="bottom-events" @click="goNsRoute('events')"
              :title="$t('nav.events')" :aria-label="$t('nav.events')"
              class="dock-ig cursor-pointer" :class="isNsRouteActive('events') ? 'dock-ig--hot' : ''">
              <span class="dock-ig__sq"><span class="material-symbols-outlined text-base">notifications_active</span></span>
            </button>
            <button data-test="bottom-activity" @click="router.push('/audit-logs')"
              :title="$t('nav.activityLog')" :aria-label="$t('nav.activityLog')"
              class="dock-ig cursor-pointer" :class="isGlobalActive('/audit-logs') ? 'dock-ig--hot' : ''">
              <span class="dock-ig__sq"><span class="material-symbols-outlined text-sm">history</span></span>
            </button>
            <button data-test="deploy-card" @click="router.push({ name: 'NsDeploy', params: { namespace: currentNs } })"
              :title="$t('nav.deploy')" :aria-label="$t('nav.deploy')"
              class="dock-ig dock-ig--deploy dock-ig--wide col-span-3 cursor-pointer">
              <span class="dock-ig__sq">
                <span class="material-symbols-outlined text-sm">rocket_launch</span>
                <span class="text-[9px] font-bold tracking-[0.15em]">{{ $t('nav.deploy') }}</span>
              </span>
            </button>
          </div>
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

/* ===== Namespace band:浅坞 + 绿 chip(方案 B,docs/superpowers/specs/2026-08-18) ===== */
.ns-band{display:flex;align-items:center;gap:7px;padding:6px 7px;border-radius:18px 9px 9px 14px;
  background:linear-gradient(160deg,#f4f8f5,#e9efeb);border:1px solid #d9e3dc;
  box-shadow:0 5px 14px rgba(0,60,35,.10);
  transition:transform .18s cubic-bezier(.2,.7,.3,1),box-shadow .18s,border-color .18s;cursor:pointer}
.ns-band:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(0,60,35,.16);border-color:#b3d4c3}
.ns-band:active{transform:translateY(0) scale(.985)}
.ns-main{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:0;border:0;background:none;
  text-align:left;cursor:pointer;font:inherit;color:inherit}
.ns-chip{width:26px;height:26px;border-radius:9px;position:relative;flex:none;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(120deg,#0ba874,#00835b);color:#fff;
  box-shadow:0 3px 10px rgba(0,108,73,.30),inset 0 1px 0 rgba(255,255,255,.26);
  transition:background .3s,box-shadow .3s,border-color .3s}
.ns-band--cluster .ns-chip{background:#fff;border:1px solid #bbcabf;color:#006c49;
  box-shadow:0 3px 8px rgba(0,60,35,.12),inset 0 1px 0 #fff}
/* chip 图标:ns 态 hover folder↔hub(拓扑)交叉淡入;集群态不换 */
.ns-ci{position:absolute;font-size:15px;transition:opacity .18s,transform .18s}
.ns-ci--hub{opacity:0;transform:scale(.6)}
.ns-band--ns .ns-main:hover .ns-ci--folder{opacity:0;transform:scale(.6)}
.ns-band--ns .ns-main:hover .ns-ci--hub{opacity:1;transform:scale(1)}
.ns-txt{flex:1;min-width:0}
.ns-name{display:block;font-size:12px;font-weight:700;color:#0b1c30;line-height:1.25;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-name--empty{color:#6c7a71;font-weight:600}
/* 副标签:默认/hover 同一行盒(高13px/行高13px,左上对齐)交叉淡入——严格同位不叠印 */
.ns-sub{position:relative;display:block;height:13px;font-size:9px;white-space:nowrap}
.ns-t{position:absolute;left:0;top:0;line-height:13px;color:#6c7a71;transition:opacity .18s}
.ns-t--hov{color:#006c49;font-weight:700;opacity:0}
.ns-main:hover .ns-t--def{opacity:0}
.ns-main:hover .ns-t--hov{opacity:1}
/* 集群态箭头:入场滑入一次 + 2.4s 缓动轻推循环(坞 LED 同节奏);hover 停循环再滑 3px */
.ns-arr{flex:none;color:#006c49;font-size:15px;margin-left:2px;
  animation:ns-arr-in .25s cubic-bezier(.2,.7,.3,1) backwards,ns-arr-nudge 2.4s .4s ease-in-out infinite}
.ns-main:hover .ns-arr{animation:none;transform:translateX(3px)}
@keyframes ns-arr-in{from{opacity:0;transform:translateX(-5px)}to{opacity:1;transform:translateX(0)}}
@keyframes ns-arr-nudge{0%,55%,100%{transform:translateX(0)}65%{transform:translateX(2.5px)}78%{transform:translateX(0)}}
/* 下拉入口瓦片:dock-ig__sq 同款 */
.ns-tile{width:28px;height:28px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;cursor:pointer;
  background:#fff;border:1px solid #bbcabf;color:#3c4a42;
  box-shadow:0 3px 8px rgba(0,60,35,.12),inset 0 1px 0 #fff;
  transition:transform .16s cubic-bezier(.2,.7,.3,1),box-shadow .16s,color .16s}
.ns-tile:hover{transform:translateY(-2px);box-shadow:0 6px 14px rgba(0,60,35,.18);color:#006c49}
.ns-tile:active{transform:translateY(0) scale(.95)}
/* 下拉面板:白底 + 右下小角(呼应坞) + 加深投影;v-if 插入自动播一次入场 */
.ns-drop{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:50;overflow:hidden;
  background:#fff;border:1px solid #d9e3dc;border-radius:12px 12px 12px 5px;
  box-shadow:0 10px 24px rgba(0,60,35,.14);
  animation:ns-drop-in .22s cubic-bezier(.2,.7,.3,1)}
@keyframes ns-drop-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.ns-search{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:9px;background:#fff;
  border:1px solid #bbcabf;color:#6c7a71;transition:border-color .15s,box-shadow .15s}
.ns-search:focus-within{border-color:#006c49;box-shadow:0 0 0 2px rgba(0,108,73,.12)}
.ns-search input{flex:1;min-width:0;border:0;outline:0;font-size:12px;font-family:inherit;color:#0b1c30;background:none}
.ns-search input::placeholder{color:#6c7a71}
.ns-search__ic{font-size:14px}
.ns-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:9px;font-size:12.5px;color:#0b1c30;
  cursor:pointer;transition:background .15s}
.ns-row:hover{background:#eaf3ee}
.ns-row--cur{background:#d7e8df;color:#006c49;font-weight:700}
.ns-row__name{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-row__pods{margin-left:auto;font-size:10px;color:#6c7a71}

/* ===== 停靠坞:集群 hero + 部署 + 3 图标同块成组 ===== */
.dock {
  border-radius: 18px 9px 9px 14px; /* 不规则圆角:左上大,其余小,右下中 */
  background: linear-gradient(160deg, #f4f8f5, #e9efeb);
  border: 1px solid #d9e3dc;
  box-shadow: 0 6px 16px rgba(0, 60, 35, .10);
}
.cluster-slab {
  border-radius: 12px 20px 8px 16px; /* hero 级不规则圆角 */
  background: linear-gradient(120deg, #0ba874 0%, #00835b 55%, #006747 100%);
  box-shadow: 0 3px 10px rgba(0, 108, 73, .30), inset 0 1px 0 rgba(255, 255, 255, .26), inset 0 -5px 12px rgba(0, 40, 27, .18);
  color: #fff; transition: filter .18s, box-shadow .18s;
}
.cluster-slab:hover { filter: brightness(1.07); box-shadow: 0 4px 14px rgba(0, 108, 73, .40), inset 0 1px 0 rgba(255, 255, 255, .28), inset 0 -5px 12px rgba(0, 40, 27, .18); }
.slab-chip {
  width: 26px; height: 26px; border-radius: 9px;
  background: rgba(255, 255, 255, .16); border: 1px solid rgba(255, 255, 255, .25); color: #fff;
}
.slab-led {
  width: 4px; height: 4px; border-radius: 50%; background: #8bf5be;
  box-shadow: 0 0 5px #8bf5be; flex: none; animation: slab-led-pulse 2.4s ease-in-out infinite;
}
@keyframes slab-led-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }

/* ===== 4 图标:3 列网格(设置/事件/活动),部署横跨底行 ===== */
.dock-ig { display: flex; align-items: center; justify-content: center; }
.dock-ig__sq {
  width: 28px; height: 28px; border-radius: 10px;
  background: #ffffff; border: 1px solid #bbcabf; color: #3c4a42;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 3px 8px rgba(0, 60, 35, .12), inset 0 1px 0 #fff;
  transition: transform .16s cubic-bezier(.2, .7, .3, 1), box-shadow .16s, color .16s, background .16s;
}
.dock-ig--lg .dock-ig__sq { width: 32px; height: 32px; border-radius: 12px 8px 10px 8px; }
/* 部署:绿色渐变(承自原部署大卡);底行宽条形态,火箭+文字 */
.dock-ig--deploy .dock-ig__sq {
  background: linear-gradient(133deg, #00a173 0%, #00835b 52%, #005c3f 100%);
  border-color: transparent; color: #fff; gap: 4px;
  box-shadow: 0 4px 10px rgba(0, 92, 63, .35), inset 0 1px 0 rgba(255, 255, 255, .28);
}
.dock-ig--deploy.dock-ig--wide .dock-ig__sq { border-radius: 8px 12px 8px 12px; }
.dock-ig--deploy:hover .dock-ig__sq { filter: brightness(1.07); }
/* 横跨底行的宽条形态 */
.dock-ig--wide { width: 100%; }
.dock-ig--wide .dock-ig__sq { width: 100%; border-radius: 8px 12px 8px 12px; }
.dock-ig:hover .dock-ig__sq { transform: translateY(-2px); box-shadow: 0 6px 14px rgba(0, 60, 35, .18); color: #006c49; }
.dock-ig--hot .dock-ig__sq { background: #d7e8df; color: #006c49; border-color: #a9cfbd; }

/* ===== 钻入 ns 入场编排;返回集群走 drill-up 菜单体感 ===== */
/* 元素因 v-if 随 ns 态新插入,animation 自动播一次;返回集群 v-if 直接卸载无出场 */
/* fill 用 backwards:delay 期间 from 帧隐藏元素;结束后回归自然样式——动画的 to 帧
   与自然态完全相同,forwards 填充零收益却持续占用 transform,会压死 hover/:active 交互反馈 */
.dock { animation: dock-swell .55s cubic-bezier(.3, 1.25, .45, 1) .14s backwards; transform-origin: 0% 100%; }
.dock-ig:nth-child(1) { animation: dock-pop .42s cubic-bezier(.3, 1.4, .5, 1) .32s backwards; }
.dock-ig:nth-child(2) { animation: dock-pop .42s cubic-bezier(.3, 1.4, .5, 1) .41s backwards; }
.dock-ig:nth-child(3) { animation: dock-pop .42s cubic-bezier(.3, 1.4, .5, 1) .50s backwards; }
.dock-ig:nth-child(4) { animation: dock-pop .42s cubic-bezier(.3, 1.4, .5, 1) .59s backwards; }

@keyframes dock-swell { 0% { opacity: 0; transform: scale(.9); } 70% { opacity: 1; transform: scale(1.02); } 100% { transform: scale(1); } }
@keyframes dock-pop { 0% { opacity: 0; transform: scale(.3); } 75% { opacity: 1; transform: scale(1.12); } 100% { opacity: 1; transform: scale(1); } }

/* reduce:编排动画全禁(含 slab-led 呼吸);hover transition 一并禁用;
   集群头两态容器(transition-all)也纳入禁用,满足「所有动效须带禁用分支」 */
@media (prefers-reduced-motion: reduce) {
  .dock, .dock-ig, .slab-led { animation: none !important; }
  .cluster-slab, .dock-ig__sq, .cluster-header { transition: none !important; }
  .ns-band,.ns-chip,.ns-ci,.ns-t,.ns-tile,.ns-row,.ns-search{transition:none !important}
  .ns-arr,.ns-drop{animation:none !important}
}
</style>
