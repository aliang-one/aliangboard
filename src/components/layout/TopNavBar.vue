<script setup>
import { ref, computed, nextTick, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import UserMenu from './UserMenu.vue'
import WorkbenchEntryPill from './WorkbenchEntryPill.vue'
import { usePageRefresh } from '@/composables/usePageRefresh'
import { useResourceList } from '@/composables/useK8sQuery'
import { api, clearSession, getSession } from '@/api/client'
import { useBreakpoint, MQ_BELOW_LG, MQ_BELOW_SM } from '@/composables/useBreakpoint'
import { useShellStore } from '@/stores/shell'
import { Z } from '@/styles/zScale'

const router = useRouter()
const store = useClusterStore()
const { bump: bumpRefresh } = usePageRefresh()

// === 全局搜索：惰性 Query 消费者 ===
// TopNavBar 常驻挂载，7 个资源查询仅在搜索框打开时 enabled（避免无谓请求）。
// nodes/namespaces 已由 hydrateCriticalResources 预载入 store，直接读 store。
const cid = computed(() => (store.currentCluster || 'cluster'))
const searchOpen = ref(false)
// <lg(iPad 竖屏):搜索收成图标钮,点击弹 Teleport 弹层(2026-08-31 设计 §4)
const { matches: belowLg } = useBreakpoint(MQ_BELOW_LG)
const { matches: belowSm } = useBreakpoint(MQ_BELOW_SM)
const shell = useShellStore()
const searchModalOpen = ref(false)
const searchModalInput = ref(null)
const searchEnabled = computed(() => searchOpen.value || searchModalOpen.value) // 弹层打开也启用惰性查询(与内联 focus 同语义)
function openSearchModal() {
  searchModalOpen.value = true
  nextTick(() => searchModalInput.value?.focus())
}
function closeSearchModal() { searchModalOpen.value = false; searchQuery.value = '' }
const podsQ = useResourceList({ key: ['cluster', cid, 'pods'], fetcher: () => store.fetchPods(), options: { refetchInterval: false, enabled: searchEnabled } })
const workloadsQ = useResourceList({ key: ['cluster', cid, 'workloads'], fetcher: () => store.fetchWorkloads(), options: { refetchInterval: false, enabled: searchEnabled } })
const servicesQ = useResourceList({ key: ['cluster', cid, 'services'], fetcher: () => store.fetchServices(), options: { refetchInterval: false, enabled: searchEnabled } })
const ingressesQ = useResourceList({ key: ['cluster', cid, 'ingresses'], fetcher: () => store.fetchIngresses(), options: { refetchInterval: false, enabled: searchEnabled } })
const configmapsQ = useResourceList({ key: ['cluster', cid, 'configmaps'], fetcher: () => store.fetchConfigMaps(), options: { refetchInterval: false, enabled: searchEnabled } })
const secretsQ = useResourceList({ key: ['cluster', cid, 'secrets'], fetcher: () => store.fetchSecrets(), options: { refetchInterval: false, enabled: searchEnabled } })
const pvcsQ = useResourceList({ key: ['cluster', cid, 'pvcs'], fetcher: () => store.fetchPVCs(), options: { refetchInterval: false, enabled: searchEnabled } })
// namespaces 常驻 Query（选择器需要，非搜索惰性）— 替代 hydrateCriticalResources 的 namespaces 拉取
// 无 K8s session（首装 admin 在平台管理页）时不轮询——拉了必 401，纯属噪音
const nsEnabled = computed(() => !!getSession())
const nsQ = useResourceList({ key: ['cluster', cid, 'namespaces'], fetcher: () => store.fetchNamespaces(), options: { refetchInterval: 60000, enabled: nsEnabled } })
const allNamespaces = computed(() => nsQ.data.value ?? store.namespaceList)

// 刷新当前页：重拉集群核心资源（列表型页面）+ 重新挂载当前视图（详情页 onMounted 定点拉取）
const refreshing = ref(false)
let refreshTimer = null
function refreshPage() {
  if (refreshing.value) return
  refreshing.value = true
  bumpRefresh() // 触发 router-view 重新挂载（重跑当前页 onMounted）
  store.invalidateAllClusterQueries() // 后台重拉列表，静默不打断
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
  closeSearchModal()
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
  else if (e.key === 'Escape') { searchQuery.value = ''; if (searchModalOpen.value) closeSearchModal() }
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

// 下拉传送定位(issue #4 PortSelect 同款):面板 Teleport body + fixed 锚触发钮 rect,
// 脱离 sticky header 的 overflow 裁切;scroll capture 跟随,resize 关闭。
const clusterBtnRef = ref(null), clusterPanelRef = ref(null)
const nsBtnRef = ref(null), nsPanelRef = ref(null)
const clusterPanelStyle = ref(hiddenStyle()), nsPanelStyle = ref(hiddenStyle())
// 手机档底部面板(spec §13.1):fixed 贴底全宽,Z.popover(110) 盖过遮罩 z-30
const bottomSheetStyle = () => ({ position: 'fixed', left: '0px', right: '0px', bottom: '0px', zIndex: Z.popover })
function hiddenStyle() { return { position: 'fixed', top: '0px', left: '0px', visibility: 'hidden', zIndex: Z.popover } }
function placeDropdown(btn, panel, width) {
  if (!btn || !panel) return
  const r = btn.getBoundingClientRect()
  const ph = panel.offsetHeight
  let top = r.bottom + 4
  if (top + ph > window.innerHeight - 8 && r.top - ph - 4 >= 8) top = r.top - ph - 4
  let left = r.left
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8)
  return { position: 'fixed', top: `${top}px`, left: `${left}px`, visibility: 'visible', zIndex: Z.popover, width: `${width}px` }
}
async function placeAll() {
  await nextTick()
  if (showClusterDropdown.value && clusterPanelRef.value) clusterPanelStyle.value = belowSm.value ? bottomSheetStyle() : placeDropdown(clusterBtnRef.value, clusterPanelRef.value, 320)
  if (showNsDropdown.value && nsPanelRef.value) nsPanelStyle.value = belowSm.value ? bottomSheetStyle() : placeDropdown(nsBtnRef.value, nsPanelRef.value, 288)
}
function onDocScroll() { placeAll() } // sticky 顶栏场景跟随即可,不必关闭
function bindDropFollow() {
  window.addEventListener('scroll', onDocScroll, { capture: true, passive: true })
  window.addEventListener('resize', onDocScroll, { passive: true })
}
function unbindDropFollow() {
  window.removeEventListener('scroll', onDocScroll, { capture: true })
  window.removeEventListener('resize', onDocScroll)
}
watch([showClusterDropdown, showNsDropdown], v => {
  if (v.some(Boolean)) { placeAll(); bindDropFollow() } else { unbindDropFollow() }
})
// 抽屉集群切换通道(spec §13.1):SideNavBar drawer-mode 的 cluster-anchor 经 shell tick
// 请求打开集群选择器(面板锚点 clusterBtnRef 手机档不存在,placeDropdown 手机分支本就绕过)
watch(() => shell.clusterSelectTick, () => { if (belowSm.value) { showNsDropdown.value = false; showClusterDropdown.value = true } })
onBeforeUnmount(unbindDropFollow)

</script>

<template>
  <header class="flex justify-between items-center px-lg w-full sticky top-0 z-50 bg-surface h-16 border-b border-outline-variant shrink-0">
    <div class="flex items-center gap-sm lg:gap-md xl:gap-lg flex-1 min-w-0">
      <!-- 手机抽屉开关(仅 <640):桌面/iPad 不渲染(汉堡在手机档取代常驻侧栏的入口职能) -->
      <button v-if="belowSm" data-test="menu-trigger" @click="shell.toggleDrawer()"
        class="p-sm -ml-sm rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-primary transition-colors"
        :aria-label="$t('nav.openMenu')">
        <span class="material-symbols-outlined">menu</span>
      </button>
      <template v-if="!belowLg">
      <div class="relative max-w-xs xl:max-w-md w-full min-w-0">
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
      </template>

      <div v-if="belowLg" class="shrink-0">
        <button data-test="search-trigger" @click="openSearchModal"
          class="p-sm rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-primary transition-colors"
          :aria-label="$t('common.search')">
          <span class="material-symbols-outlined">search</span>
        </button>
      </div>

      <!-- 集群切换 -->
      <div v-if="!belowSm" class="relative shrink-0">
        <button
          ref="clusterBtnRef"
          data-test="cluster-trigger"
          @click="showClusterDropdown = !showClusterDropdown"
          class="flex items-center gap-sm px-md py-1.5 rounded-lg border transition-all"
          :class="showClusterDropdown
            ? 'border-primary bg-primary/5 text-primary'
            : 'border-outline-variant bg-surface-container-low text-on-surface hover:border-primary/50'"
        >
          <span class="material-symbols-outlined text-lg">hub</span>
          <div class="flex flex-col items-start leading-tight min-w-0 max-w-[80px] lg:max-w-[110px] xl:max-w-[180px]">
            <span class="text-xs text-on-surface-variant opacity-70 hidden xl:block">CLUSTER</span>
            <!-- w-full:items-start 列向子项按 fit-content 定宽,nowrap 长名(URL 形集群名)会穿透 UI;宽度钉到父内容宽椭圆才生效(overflow-guard V1) -->
            <span class="w-full text-body-sm font-semibold truncate" :title="currentClusterObj?.name">{{ currentClusterObj?.name || '—' }}</span>
          </div>
          <span class="material-symbols-outlined text-lg shrink-0 transition-transform" :class="showClusterDropdown ? 'rotate-180' : ''">expand_more</span>
        </button>

        <!-- 下拉列表已迁至底部 Teleport(fixed 锚定,issue#4 同款) -->
      </div>

      <!-- 手机单颗上下文胶囊(spec §13.1):ns 主/集群副,点击弹 ns 底部选择器;集群切换进抽屉 -->
      <button v-if="belowSm" data-test="context-capsule" @click="showNsDropdown = !showNsDropdown"
        class="flex items-center gap-xs min-w-0 flex-1 max-w-[240px] px-sm py-1.5 rounded-lg border transition-all"
        :class="showNsDropdown
          ? 'border-primary bg-primary/5 text-primary'
          : (currentNs
            ? 'border-primary/40 bg-primary/5 text-primary'
            : 'border-outline-variant bg-surface-container-low text-on-surface-variant')"
        :aria-label="$t('nav.switchNamespace')">
        <span class="material-symbols-outlined text-lg shrink-0">folder_open</span>
        <div class="flex flex-col items-start leading-tight min-w-0 flex-1">
          <span class="w-full text-body-sm font-semibold truncate">{{ currentNs || $t('nav.notSelected') }}</span>
          <span class="w-full text-[10px] text-on-surface-variant truncate">{{ currentClusterObj?.name || '—' }}</span>
        </div>
        <!-- 手机档不渲染 expand_more 尾图标(375px 主文本仅剩 ~10-25px,去 chevron 省 ~28px;Wave 4 终审 D) -->
      </button>

      <!-- 当前命名空间 + 快速切换（顶栏显式上下文） -->
      <div v-if="!belowSm" class="relative shrink-0">
        <button
          ref="nsBtnRef"
          data-test="ns-trigger"
          @click="showNsDropdown = !showNsDropdown"
          class="flex items-center gap-sm px-md py-1.5 rounded-lg border transition-all"
          :class="showNsDropdown
            ? 'border-primary bg-primary/5 text-primary'
            : (currentNs
              ? 'border-primary/40 bg-primary/5 text-primary'
              : 'border-outline-variant bg-surface-container-low text-on-surface-variant hover:border-primary/50')"
        >
          <span class="material-symbols-outlined text-lg">folder_open</span>
          <div class="flex flex-col items-start leading-tight min-w-0 max-w-[80px] lg:max-w-[110px] xl:max-w-[160px]">
            <span class="text-xs text-on-surface-variant opacity-70 hidden xl:block">NAMESPACE</span>
            <span class="w-full text-body-sm font-semibold truncate" :title="currentNs">{{ currentNs || $t('nav.notSelected') }}</span>
          </div>
          <span class="material-symbols-outlined text-lg shrink-0 transition-transform" :class="showNsDropdown ? 'rotate-180' : ''">expand_more</span>
        </button>

        <!-- ns 下拉列表已迁至底部 Teleport(fixed 锚定,issue#4 同款) -->
      </div>
    </div>
    <div class="flex items-center gap-md">
      <!-- 工作台入口:品牌胶囊 + 状态角标 + 悬停概览(2026-08-30 信息丰富化,规格 docs/superpowers/specs/2026-08-30-workbench-entry-pill-summary-design.md)
           ——导航级入口排工具按钮前;shrink-0 使溢出压力全部由左侧搜索收缩链吸收(issue #3 契约) -->
      <WorkbenchEntryPill />
      <button @click="refreshPage" :disabled="refreshing" :aria-label="$t('nav.refreshPage')" :title="$t('nav.refreshPageData')" class="p-sm text-on-surface-variant hover:bg-surface-container-low hover:text-primary rounded-full transition-colors disabled:opacity-50">
        <span class="material-symbols-outlined" :class="refreshing ? 'animate-spin' : ''">refresh</span>
      </button>
      <div class="h-8 w-px bg-outline-variant mx-2 max-lg:hidden"></div>
      <UserMenu />
    </div>
  </header>
  <!-- 集群/ns 下拉:Teleport body + fixed 锚定触发钮 rect(脱离 sticky header 裁切,issue#4 同款) -->
  <Teleport to="body">
    <div v-if="showClusterDropdown" ref="clusterPanelRef" data-testid="cluster-dropdown-panel"
      :data-bottom-sheet="String(belowSm)"
      class="bg-surface-container-lowest border border-outline-variant shadow-dropdown overflow-hidden"
      :class="belowSm ? 'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[70vh] overflow-y-auto max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+12px)]' : 'rounded-lg'"
      :style="clusterPanelStyle">
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
              <p class="text-xs text-on-surface-variant truncate">{{ c.version }} · {{ c.distribution }}</p>
            </div>
          </div>
          <div class="flex items-center gap-xs shrink-0">
            <span v-if="c.name === store.currentCluster" class="text-xs font-bold text-primary px-sm py-0.5 rounded-full bg-primary-container/30">CURRENT</span>
            <span class="material-symbols-outlined text-base text-on-surface-variant opacity-40">chevron_right</span>
          </div>
        </div>
      </div>
    </div>
    <div v-if="showNsDropdown" ref="nsPanelRef" data-testid="ns-dropdown-panel"
      :data-bottom-sheet="String(belowSm)"
      class="bg-surface-container-lowest border border-outline-variant shadow-dropdown overflow-hidden"
      :class="belowSm ? 'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[70vh] overflow-y-auto max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+12px)]' : 'rounded-lg'"
      :style="nsPanelStyle">
      <div class="p-sm border-b border-outline-variant">
            <div class="relative">
              <span class="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-on-surface-variant text-sm pointer-events-none">search</span>
              <!-- autofocus:手机档 bottom sheet 弹出即聚焦搜索(brief 裁决:始终 autofocus 可接受,桌面档打开亦是期望行为) -->
              <input v-model="nsSearch" autofocus class="w-full bg-surface-container-low border border-outline-variant rounded-md pl-8 pr-sm py-1.5 text-body-sm focus:ring-1 focus:ring-primary focus:border-primary" :placeholder="$t('nav.filterNamespaces')" />
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
  </Teleport>
  <!-- <lg 搜索弹层:Teleport body + fixed 顶部居中,复用内联搜索的索引与结果渲染 -->
  <Teleport to="body">
    <div v-if="searchModalOpen" data-test="search-modal" class="fixed inset-0" :style="{ zIndex: Z.popover }">
      <div class="absolute inset-0 bg-black/30" @click="closeSearchModal"></div>
      <div class="absolute left-1/2 -translate-x-1/2 top-16 w-[min(92vw,480px)]">
        <div class="relative">
          <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none z-10">search</span>
          <input
            ref="searchModalInput"
            v-model="searchQuery"
            @keydown="onSearchKeydown"
            class="w-full bg-surface-container-low border border-outline-variant rounded-full py-2.5 pl-10 pr-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary shadow-dropdown"
            :placeholder="$t('nav.searchPlaceholder')"
            :aria-label="$t('common.search')"
            type="text"
          />
          <div v-if="searchResults.length" class="absolute top-full left-0 mt-1 w-full bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown overflow-y-auto max-h-96">
            <button v-for="(it, i) in searchResults" :key="i" @click="goResult(it)" class="flex items-center gap-sm w-full px-md py-sm hover:bg-surface-container-low text-left transition-colors border-b border-outline-variant/30 last:border-0">
              <span class="material-symbols-outlined text-on-surface-variant text-lg shrink-0">{{ ICON_FOR[it.kind] || 'circle' }}</span>
              <span class="font-mono text-code-sm text-on-surface truncate">{{ it.name }}</span>
              <span class="ml-auto text-xs text-on-surface-variant shrink-0">{{ it.kind }}<span v-if="it.namespace"> · {{ it.namespace }}</span></span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
  <!-- 点击外部关闭下拉（集群 / 命名空间）——手机档 bottom sheet 用独立全屏遮罩,
       z 取 Z.popover-1(spec §13.2):盖过顶栏(50)/抽屉遮罩(54)/抽屉(55),面板(110)盖过遮罩 -->
  <div v-if="belowSm && (showClusterDropdown || showNsDropdown)" class="fixed inset-0" data-test="sheet-overlay"
    :style="{ zIndex: String(Z.popover - 1) }" @click="closeClusterDropdown(); closeNsDropdown()"></div>
  <div v-else-if="showClusterDropdown || showNsDropdown" class="fixed inset-0 z-30" @click="closeClusterDropdown(); closeNsDropdown()"></div>
</template>
