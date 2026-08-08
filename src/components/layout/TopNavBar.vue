<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useAuthStore } from '@/stores/auth'
import { usePageRefresh } from '@/composables/usePageRefresh'
import { useResourceList } from '@/composables/useK8sQuery'
import { api, clearSession } from '@/api/client'

const router = useRouter()
const store = useClusterStore()
const authStore = useAuthStore()
const { bump: bumpRefresh } = usePageRefresh()

// === 全局搜索：惰性 Query 消费者 ===
// TopNavBar 常驻挂载，7 个资源查询仅在搜索框打开时 enabled（避免无谓请求）。
// nodes/namespaces 已由 hydrateCriticalResources 预载入 store，直接读 store。
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const searchOpen = ref(false)
const searchEnabled = computed(() => searchOpen.value && store.remoteMode)
const podsQ = useResourceList({ key: ['cluster', cid.value, 'pods'], fetcher: () => store.fetchPods(), mock: store.podList, mockMode: !store.remoteMode, options: { refetchInterval: false, enabled: searchEnabled } })
const workloadsQ = useResourceList({ key: ['cluster', cid.value, 'workloads'], fetcher: () => store.fetchWorkloads(), mock: store.workloadList, mockMode: !store.remoteMode, options: { refetchInterval: false, enabled: searchEnabled } })
const servicesQ = useResourceList({ key: ['cluster', cid.value, 'services'], fetcher: () => store.fetchServices(), mock: store.serviceList, mockMode: !store.remoteMode, options: { refetchInterval: false, enabled: searchEnabled } })
const ingressesQ = useResourceList({ key: ['cluster', cid.value, 'ingresses'], fetcher: () => store.fetchIngresses(), mock: store.ingressList, mockMode: !store.remoteMode, options: { refetchInterval: false, enabled: searchEnabled } })
const configmapsQ = useResourceList({ key: ['cluster', cid.value, 'configmaps'], fetcher: () => store.fetchConfigMaps(), mock: store.configMapList, mockMode: !store.remoteMode, options: { refetchInterval: false, enabled: searchEnabled } })
const secretsQ = useResourceList({ key: ['cluster', cid.value, 'secrets'], fetcher: () => store.fetchSecrets(), mock: store.secretList, mockMode: !store.remoteMode, options: { refetchInterval: false, enabled: searchEnabled } })
const pvcsQ = useResourceList({ key: ['cluster', cid.value, 'pvcs'], fetcher: () => store.fetchPVCs(), mock: store.pvcList, mockMode: !store.remoteMode, options: { refetchInterval: false, enabled: searchEnabled } })
// namespaces 常驻 Query（选择器需要，非搜索惰性）— 替代 hydrateCriticalResources 的 namespaces 拉取
const nsQ = useResourceList({ key: ['cluster', cid.value, 'namespaces'], fetcher: () => store.fetchNamespaces(), mock: store.namespaceList, mockMode: !store.remoteMode, options: { refetchInterval: store.remoteMode ? 60000 : false } })
const allNamespaces = computed(() => nsQ.data.value ?? store.namespaceList)

// 刷新当前页：重拉集群核心资源（列表型页面）+ 重新挂载当前视图（详情页 onMounted 定点拉取）
const refreshing = ref(false)
let refreshTimer = null
function refreshPage() {
  if (refreshing.value) return
  refreshing.value = true
  bumpRefresh() // 触发 router-view 重新挂载（重跑当前页 onMounted）
  if (store.remoteMode) store.invalidateAllClusterQueries() // 后台重拉列表，静默不打断
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { refreshing.value = false }, 700)
}

const searchQuery = ref('')
const showClusterDropdown = ref(false)
const showNsDropdown = ref(false)
const nsSearch = ref('')

const currentClusterObj = computed(() => store.getCurrentCluster())
const currentNs = computed(() => store.currentNamespace)
const filteredNamespaces = computed(() => {
  if (!nsSearch.value) return allNamespaces.value
  const q = nsSearch.value.toLowerCase()
  return allNamespaces.value.filter(ns => ns.name.toLowerCase().includes(q))
})
function selectNs(ns) {
  showNsDropdown.value = false
  nsSearch.value = ''
  store.setNamespace(ns)
  router.push({ name: 'NamespaceOverview', params: { namespace: ns } })
}
function closeNsDropdown() {
  showNsDropdown.value = false
  nsSearch.value = ''
}

// === 全局搜索：聚合已同步资源，按名称跨命名空间匹配，点击跳转详情 ===
// 7 类资源读 Vue Query 缓存（搜索框打开时才补取）；nodes/namespaces 读 store（hydrateCritical 已预载）。
const WL_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']
const ICON_FOR = { Pod: 'deployed_code', Deployment: 'work', StatefulSet: 'work', DaemonSet: 'work', Job: 'work', CronJob: 'work', Service: 'share', Ingress: 'alt_route', ConfigMap: 'description', Secret: 'lock', PVC: 'storage', Node: 'dns', Namespace: 'folder' }
function buildSearchIndex() {
  const items = []
  const push = (kind, name, namespace) => name && items.push({ kind, name, namespace })
  for (const p of (podsQ.data.value || [])) push('Pod', p.name, p.namespace)
  for (const w of (workloadsQ.data.value || [])) push(w.type || 'Workload', w.name, w.namespace)
  for (const s of (servicesQ.data.value || [])) push('Service', s.name, s.namespace)
  for (const ing of (ingressesQ.data.value || [])) push('Ingress', ing.name, ing.namespace)
  for (const cm of (configmapsQ.data.value || [])) push('ConfigMap', cm.name, cm.namespace)
  for (const sec of (secretsQ.data.value || [])) push('Secret', sec.name, sec.namespace)
  for (const pvc of (pvcsQ.data.value || [])) push('PVC', pvc.name, pvc.namespace)
  for (const n of (store.nodeList || [])) push('Node', n.name, '')
  for (const ns of (allNamespaces.value || [])) push('Namespace', ns.name, '')
  return items
}
const searchResults = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return []
  return buildSearchIndex().filter(it => it.name.toLowerCase().includes(q)).slice(0, 12)
})
function goResult(it) {
  if (!it) return
  searchQuery.value = ''
  if (it.kind === 'Pod') router.push({ name: 'NsPodDetail', params: { namespace: it.namespace, name: it.name } })
  else if (WL_KINDS.includes(it.kind)) router.push({ name: 'NsWorkloadDetail', params: { namespace: it.namespace, type: it.kind.toLowerCase(), name: it.name } })
  else if (it.kind === 'Service') router.push({ name: 'NsServiceDetail', params: { namespace: it.namespace, name: it.name } })
  else if (it.kind === 'Ingress') router.push({ name: 'NsIngressDetail', params: { namespace: it.namespace, name: it.name } })
  else if (it.kind === 'ConfigMap') router.push({ name: 'NsConfigMapDetail', params: { namespace: it.namespace, name: it.name } })
  else if (it.kind === 'Secret') router.push({ name: 'NsSecretDetail', params: { namespace: it.namespace, name: it.name } })
  else if (it.kind === 'PVC') router.push({ name: 'NsPVCDetail', params: { namespace: it.namespace, name: it.name } })
  else if (it.kind === 'Node') router.push(`/nodes/${it.name}`)
  else if (it.kind === 'Namespace') router.push({ name: 'NamespaceDetail', params: { name: it.name } })
}
function onSearchKeydown(e) {
  if (e.key === 'Enter' && searchResults.value.length) { e.preventDefault(); goResult(searchResults.value[0]) }
  else if (e.key === 'Escape') searchQuery.value = ''
}

// 集群健康 → 圆点颜色（来自 store.clusterHealth，控制面优先分级）
function clusterStatusColor(severity) {
  if (severity === 'ok') return 'bg-primary'
  if (severity === 'warn') return 'bg-tertiary-container'
  if (severity === 'crit') return 'bg-error'
  return 'bg-on-surface-variant'
}
async function selectCluster(apiServer) {
  showClusterDropdown.value = false
  const c = store.clusterList.find(x => x.apiServer === apiServer)
  if (c && c.apiServer !== store.cluster?.apiServer) await store.switchCluster(apiServer)
}

function closeClusterDropdown() {
  showClusterDropdown.value = false
}

function goClusters() {
  showClusterDropdown.value = false
  router.push('/clusters')
}

async function logout() {
  try { store.stopPodWatch() } catch { /* 未启动时忽略 */ }
  try { store.stopEventWatch() } catch { /* 未启动时忽略 */ }
  authStore.logout()
  router.push('/login')
}
</script>

<template>
  <header class="flex justify-between items-center px-lg w-full sticky top-0 z-50 bg-surface h-16 border-b border-outline-variant shrink-0">
    <div class="flex items-center gap-lg flex-1">
      <div class="relative max-w-md w-full">
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none z-10">search</span>
        <input
          v-model="searchQuery"
          @keydown="onSearchKeydown"
          @focus="searchOpen = true"
          @blur="searchOpen = false"
          class="w-full bg-surface-container-low border border-outline-variant rounded-full py-1.5 pl-10 pr-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
          :placeholder="$t('nav.searchPlaceholder')"
          :aria-label="$t('common.search')"
          type="text"
        />
        <!-- 全局搜索结果 -->
        <div v-if="searchResults.length" class="absolute top-full left-0 mt-1 w-full bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-50 overflow-y-auto max-h-96">
          <button v-for="(it, i) in searchResults" :key="i" @click="goResult(it)" class="flex items-center gap-sm w-full px-md py-sm hover:bg-surface-container-low text-left transition-colors border-b border-outline-variant/30 last:border-0">
            <span class="material-symbols-outlined text-on-surface-variant text-lg shrink-0">{{ ICON_FOR[it.kind] || 'circle' }}</span>
            <span class="font-mono text-code-sm text-on-surface truncate">{{ it.name }}</span>
            <span class="ml-auto text-xs text-on-surface-variant shrink-0">{{ it.kind }}<span v-if="it.namespace"> · {{ it.namespace }}</span></span>
          </button>
        </div>
      </div>

      <!-- 集群切换 -->
      <div class="relative">
        <button
          @click="showClusterDropdown = !showClusterDropdown"
          class="flex items-center gap-sm px-md py-1.5 rounded-lg border transition-all"
          :class="showClusterDropdown
            ? 'border-primary bg-primary/5 text-primary'
            : 'border-outline-variant bg-surface-container-low text-on-surface hover:border-primary/50'"
        >
          <span class="material-symbols-outlined text-lg">hub</span>
          <div class="flex flex-col items-start leading-tight min-w-0 max-w-[180px]">
            <span class="text-xs text-on-surface-variant opacity-70">CLUSTER</span>
            <span class="text-body-sm font-semibold truncate">{{ currentClusterObj?.name || '—' }}</span>
          </div>
          <span class="material-symbols-outlined text-lg shrink-0 transition-transform" :class="showClusterDropdown ? 'rotate-180' : ''">expand_more</span>
        </button>

        <!-- 下拉列表 -->
        <div
          v-if="showClusterDropdown"
          class="absolute top-full left-0 mt-1 w-80 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-50 overflow-hidden"
        >
          <!-- 头部 -->
          <div class="flex items-center justify-between px-md py-sm border-b border-outline-variant">
            <p class="text-label-caps text-on-surface-variant">{{ $t('nav.switchCluster') }}</p>
            <button
              @click.stop="goClusters"
              class="flex items-center gap-1 text-body-sm text-primary hover:opacity-80 transition-opacity"
            >
              <span class="material-symbols-outlined text-base">view_module</span>
              {{ $t('nav.manageAll') }}
            </button>
          </div>

          <!-- 集群列表 -->
          <div class="max-h-80 overflow-y-auto p-sm">
            <div
              v-for="c in store.clusterList"
              :key="c.name"
              @click="selectCluster(c.apiServer)"
              class="flex items-center justify-between px-md py-sm rounded-lg cursor-pointer transition-all hover:bg-surface-container"
              :class="c.name === store.currentCluster ? 'bg-primary-container/20' : ''"
            >
              <div class="flex items-center gap-sm min-w-0">
                <span class="w-2 h-2 rounded-full shrink-0" :class="clusterStatusColor(c.name === store.currentCluster ? store.clusterHealth.severity : 'none')" :title="c.name === store.currentCluster ? (store.clusterHealth.reasons.map(r => $t(r)).join('；') || $t('clusterHealth.healthy')) : c.status"></span>
                <div class="min-w-0">
                  <p class="text-body-md font-medium truncate" :class="c.name === store.currentCluster ? 'text-primary' : 'text-on-surface'">{{ c.name }}</p>
                  <p class="text-xs text-on-surface-variant">{{ c.version }} · {{ c.distribution }}</p>
                </div>
              </div>
              <div class="flex items-center gap-xs shrink-0">
                <span v-if="c.name === store.currentCluster" class="text-xs font-bold text-primary px-sm py-0.5 rounded-full bg-primary-container/30">CURRENT</span>
                <span class="material-symbols-outlined text-base text-on-surface-variant opacity-40">chevron_right</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 当前命名空间 + 快速切换（顶栏显式上下文） -->
      <div class="relative">
        <button
          @click="showNsDropdown = !showNsDropdown"
          class="flex items-center gap-sm px-md py-1.5 rounded-lg border transition-all"
          :class="showNsDropdown
            ? 'border-primary bg-primary/5 text-primary'
            : (currentNs
              ? 'border-primary/40 bg-primary/5 text-primary'
              : 'border-outline-variant bg-surface-container-low text-on-surface-variant hover:border-primary/50')"
        >
          <span class="material-symbols-outlined text-lg">folder_open</span>
          <div class="flex flex-col items-start leading-tight min-w-0 max-w-[160px]">
            <span class="text-xs text-on-surface-variant opacity-70">NAMESPACE</span>
            <span class="text-body-sm font-semibold truncate">{{ currentNs || $t('nav.notSelected') }}</span>
          </div>
          <span class="material-symbols-outlined text-lg shrink-0 transition-transform" :class="showNsDropdown ? 'rotate-180' : ''">expand_more</span>
        </button>

        <div
          v-if="showNsDropdown"
          class="absolute top-full left-0 mt-1 w-72 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-50 overflow-hidden"
        >
          <div class="p-sm border-b border-outline-variant">
            <div class="relative">
              <span class="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-on-surface-variant text-sm pointer-events-none">search</span>
              <input v-model="nsSearch" class="w-full bg-surface-container-low border border-outline-variant rounded-md pl-8 pr-sm py-1.5 text-body-sm focus:ring-1 focus:ring-primary focus:border-primary" :placeholder="$t('nav.filterNamespaces')" />
            </div>
          </div>
          <div class="max-h-72 overflow-y-auto p-sm">
            <div
              v-for="ns in filteredNamespaces"
              :key="ns.name"
              @click="selectNs(ns.name)"
              class="flex items-center justify-between px-md py-sm rounded-lg cursor-pointer transition-all hover:bg-surface-container"
              :class="currentNs === ns.name ? 'bg-primary-container/20 text-primary' : 'text-on-surface'"
            >
              <span class="text-body-md font-medium truncate">{{ ns.name }}</span>
              <span class="text-xs text-on-surface-variant shrink-0">{{ ns.pods ?? '' }} pods</span>
            </div>
            <p v-if="!filteredNamespaces.length" class="text-body-sm text-on-surface-variant text-center py-md">{{ $t('nav.noMatchingNamespaces') }}</p>
          </div>
        </div>
      </div>
    </div>
    <div class="flex items-center gap-md">
      <button @click="refreshPage" :disabled="refreshing" :aria-label="$t('nav.refreshPage')" :title="$t('nav.refreshPageData')" class="p-sm text-on-surface-variant hover:bg-surface-container-low hover:text-primary rounded-full transition-colors disabled:opacity-50">
        <span class="material-symbols-outlined" :class="refreshing ? 'animate-spin' : ''">refresh</span>
      </button>
      <button @click="router.push('/audit-logs')" :aria-label="$t('nav.activityLog')" :title="$t('nav.activityLog')" class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors">
        <span class="material-symbols-outlined">notifications</span>
      </button>
      <button @click="router.push('/settings')" :aria-label="$t('nav.settings')" :title="$t('nav.settings')" class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors">
        <span class="material-symbols-outlined">settings</span>
      </button>
      <div class="h-8 w-px bg-outline-variant mx-2"></div>
      <button @click="logout" class="flex items-center gap-sm cursor-pointer hover:bg-surface-container-low p-1 rounded-lg transition-colors" :title="$t('nav.logout')">
        <div class="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-body-sm font-bold">{{ (authStore.user?.displayName || authStore.user?.username || 'U').charAt(0).toUpperCase() }}</div>
        <span class="text-body-sm font-semibold">{{ authStore.user?.displayName || authStore.user?.username || 'User' }}</span>
        <span v-if="authStore.isAdmin" class="px-1 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold">ADMIN</span>
        <span class="material-symbols-outlined text-on-surface-variant text-body-sm">logout</span>
      </button>
    </div>
  </header>
  <!-- 点击外部关闭下拉（集群 / 命名空间） -->
  <div v-if="showClusterDropdown || showNsDropdown" class="fixed inset-0 z-30" @click="closeClusterDropdown(); closeNsDropdown()"></div>
</template>
