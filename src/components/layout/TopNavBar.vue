<script setup>
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import UserMenu from './UserMenu.vue'
import WorkbenchEntryPill from './WorkbenchEntryPill.vue'
import AlertBell from './AlertBell.vue'
import SearchResults from './SearchResults.vue'
import { usePageRefresh } from '@/composables/usePageRefresh'
import { useResourceList } from '@/composables/useK8sQuery'
import { api, clearSession, getSession } from '@/api/client'
import { useBreakpoint, MQ_BELOW_LG, MQ_BELOW_SM } from '@/composables/useBreakpoint'
import { useShellStore } from '@/stores/shell'
import { Z } from '@/styles/zScale'
import { searchAll, collectResourceItems } from '@/logic/globalSearch'
import { routeForResource } from '@/logic/resourceNavigation'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const route = useRoute()
const store = useClusterStore()
const { tm } = useI18n()
// 页面搜索同义词表(nav.searchPageSynonyms,按语言取)——tm 返回对象/数组/AST 形态不定,防御式归一
const asText = v => (typeof v === 'string' ? v : (v && typeof v === 'object' ? (v.content ?? '') : ''))
const pageSynonyms = computed(() => {
  const raw = tm('nav.searchPageSynonyms')
  const map = {}
  const feed = (k, v) => { const text = asText(v); if (text) map[String(k).replace(/^\//, '')] = text }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (Array.isArray(item)) { const k = item[0]; const v = item[1]; if (typeof k === 'string') feed(k, v) }
      else if (item && typeof item === 'object') { for (const [k, v] of Object.entries(item)) feed(k, v) }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) feed(k, v)
  }
  return map
})
const { bump: bumpRefresh } = usePageRefresh()
// 身份舷板激活态:/workbench* 时整板着色(工作台段自带填充,板体描边/渐变换激活色)
const wbActive = computed(() => route.path.startsWith('/workbench'))

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
const searchInputRef = ref(null)
const searchEnabled = computed(() => searchOpen.value || searchModalOpen.value) // 弹层打开也启用惰性查询(与内联 focus 同语义)
function openSearchModal() {
  searchModalOpen.value = true
  nextTick(() => searchModalInput.value?.focus())
}
function closeSearchModal() { searchModalOpen.value = false; searchQuery.value = '' }
// ⌘K/Ctrl+K 全局快捷键:桌面聚焦内联框,<lg 打开弹层(Headlamp/Lens 同款入口语义)
function onGlobalKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
    // 焦点在其它可编辑元素时不抢(YAML 编辑器/工作台输入框内 ⌘K 不应悄悄灌进顶栏)
    const t = e.target
    const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    if (editable && t !== searchInputRef.value) return
    e.preventDefault()
    if (belowLg.value) openSearchModal()
    else searchInputRef.value?.focus()
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))
// 搜索惰性查询(2026-09-04 扩容 7→20 类):仅搜索打开时 enabled
const LAZY_KINDS = [
  ['pods', 'fetchPods'], ['workloads', 'fetchWorkloads'], ['services', 'fetchServices'],
  ['ingresses', 'fetchIngresses'], ['configmaps', 'fetchConfigMaps'], ['secrets', 'fetchSecrets'],
  ['pvcs', 'fetchPVCs'], ['hpas', 'fetchHPAs'], ['roles', 'fetchRoles'], ['rolebindings', 'fetchRoleBindings'],
  ['clusterrolebindings', 'fetchClusterRoleBindings'], ['serviceaccounts', 'fetchServiceAccounts'],
  ['networkpolicies', 'fetchNetworkPolicies'], ['resourcequotas', 'fetchResourceQuotas'],
  ['limitranges', 'fetchLimitRanges'], ['pdbs', 'fetchPDBs'], ['storageclasses', 'fetchStorageClasses'],
  ['pvs', 'fetchPVs'], ['crds', 'fetchCRDs'], ['events', 'fetchEvents'],
]
const lazyQ = Object.fromEntries(LAZY_KINDS.map(([kind, fn]) => [
  kind,
  useResourceList({ key: ['cluster', cid, kind], fetcher: () => store[fn](), options: { refetchInterval: false, enabled: searchEnabled } }),
]))
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

// === 全局搜索(2026-09-04 升级):页面导航 + 20 类资源,聚合/排序/跳转映射抽至 logic 单源 ===
// 资源读 Vue Query 缓存(搜索打开才补取);nodes/namespaces 读 store 预载。
function buildItems() {
  return collectResourceItems({
    pods: lazyQ.pods.data.value,
    workloads: lazyQ.workloads.data.value,
    services: lazyQ.services.data.value,
    ingresses: lazyQ.ingresses.data.value,
    configmaps: lazyQ.configmaps.data.value,
    secrets: lazyQ.secrets.data.value,
    pvcs: lazyQ.pvcs.data.value,
    hpas: lazyQ.hpas.data.value,
    roles: lazyQ.roles.data.value,
    rolebindings: lazyQ.rolebindings.data.value,
    clusterrolebindings: lazyQ.clusterrolebindings.data.value,
    serviceaccounts: lazyQ.serviceaccounts.data.value,
    networkpolicies: lazyQ.networkpolicies.data.value,
    resourcequotas: lazyQ.resourcequotas.data.value,
    limitranges: lazyQ.limitranges.data.value,
    pdbs: lazyQ.pdbs.data.value,
    storageclasses: lazyQ.storageclasses.data.value,
    pvs: lazyQ.pvs.data.value,
    crds: lazyQ.crds.data.value,
    events: lazyQ.events.data.value,
    nodes: store.nodeList,
    namespaces: allNamespaces.value,
  })
}
const searchResults = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return []
  const { pages, resources } = searchAll(q, buildItems(), { synonyms: pageSynonyms.value })
  return [...pages.map(p => ({ ...p, page: true })), ...resources]
})
function goResult(it) {
  if (!it) return
  closeSearchModal()
  searchQuery.value = ''
  if (it.page) { router.push(it.path); return }
  if (it.kind === 'Event') { // 事件无详情路由:有 ns 跳事件列表,否则落监控中心
    if (it.namespace) router.push({ name: 'NsEvents', params: { namespace: it.namespace } })
    else router.push('/monitoring')
    return
  }
  const route = routeForResource(it.kind, it.name, it.namespace)
  if (route) router.push(route)
}
function onSearchKeydown(e) {
  if (e.key === 'Enter' && searchResults.value.length) { e.preventDefault(); goResult(searchResults.value[0]) }
  else if (e.key === 'Escape') { searchQuery.value = ''; if (searchModalOpen.value) closeSearchModal() }
}

// 下拉传送定位(issue #4 PortSelect 同款):面板 Teleport body + fixed 锚触发钮 rect,
// 脱离 sticky header 的 overflow 裁切;scroll capture 跟随,resize 关闭。
// 2026-09-04:仅剩手机档 ns bottom sheet 在用(桌面集群/ns chip 已剃,集群面板迁侧栏)
const nsBtnRef = ref(null), nsPanelRef = ref(null)
const nsPanelStyle = ref(hiddenStyle())
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
watch(showNsDropdown, v => {
  if (v) { placeAll(); bindDropFollow() } else { unbindDropFollow() }
})
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
          ref="searchInputRef"
          v-model="searchQuery"
          @keydown="onSearchKeydown"
          @focus="searchOpen = true"
          @blur="searchOpen = false"
          class="w-full bg-surface-container-low border border-outline-variant rounded-full py-1.5 pl-10 pr-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
          :placeholder="$t('nav.searchPlaceholder')"
          :aria-label="$t('common.search')"
          type="text"
        />
        <kbd data-test="search-kbd" aria-hidden="true" class="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] leading-none text-on-surface-variant border border-outline-variant rounded px-1.5 py-1 pointer-events-none">⌘K</kbd>
        <!-- 全局搜索结果(与 <lg 弹层共用 SearchResults) -->
        <SearchResults :results="searchResults" @select="goResult" />
      </div>
      </template>

      <div v-if="belowLg" class="shrink-0">
        <button data-test="search-trigger" @click="openSearchModal"
          class="p-sm rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-primary transition-colors"
          :aria-label="$t('common.search')">
          <span class="material-symbols-outlined">search</span>
        </button>
      </div>

      <!-- 2026-09-04 顶栏去重:集群/ns 切换 chip 已剃除——上下文归侧栏
           (集群=可点头部 ClusterSwitchPanel,ns=浅坞选择器),顶栏回归全局工具职责 -->

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
    </div>
    <div class="flex items-center gap-md self-stretch">
      <!-- 告警铃铛(2026-09-04):全局态势感知,warnings 未读红点;手机档压舱算术后保留 -->
      <AlertBell />
      <!-- 刷新:手机档让位铃铛(375px:汉堡40+搜索40+胶囊+铃铛40+舷板~100,不藏刷新胶囊 <80px);
           数据新鲜度手机由自适应轮询承担,刷新(重挂当前视图)为桌面高频行为 -->
      <button v-if="!belowSm" data-test="refresh-btn" @click="refreshPage" :disabled="refreshing" :aria-label="$t('nav.refreshPage')" :title="$t('nav.refreshPageData')" class="p-sm text-on-surface-variant hover:bg-surface-container-low hover:text-primary rounded-full transition-colors disabled:opacity-50">
        <span class="material-symbols-outlined" :class="refreshing ? 'animate-spin' : ''">refresh</span>
      </button>
      <!-- 语义分区线:左侧=页面工具(刷新),右侧=身份舷板(工作区+账户) -->
      <div class="h-8 w-px bg-outline-variant mx-2 max-lg:hidden"></div>
      <!-- 身份舷板(2026-09-04 v4 精修):占满顶栏右端的全高面板——self-stretch 撑满 h-16,
           -mr-lg 抵消头部右内边距贴边(右缘平直,像从屏幕边「长」出来)。轮廓加掠:
           非对称大圆角 左上 38 / 左下 16(侧倾弧形,呼应全站 M3 曲线语言)。
           三层光照:①贴顶 1px 发丝线(亮色暗线/暗色亮线——白线在亮底物理上不可见);
           ②idle 悬停浮起(亮 card-hover 黑影/暗 primary 弱辉光,黑影在暗底不显);
           ③激活 primary 外发光(rgb(var(--md-sys-color-primary)) 取色,随主题自动翻转)。
           idle 填充起笔 primary-container/10 品牌微染(暗色档换 primary/15——暗 primary-container
           叠暗底 ≈1.05:1 不可感知);透明度一律落 Tailwind 刻度(5 的倍数,/12 类幽灵类不生成 CSS)。
           入场一次性 panel-in 滑入。shrink-0 使溢出压力全部由左侧搜索收缩链吸收(issue #3 契约) -->
      <div
        data-test="identity-capsule"
        class="relative self-stretch -mr-lg shrink-0 rounded-tl-[38px] rounded-bl-[16px] border transition-all duration-300 animate-panel-in motion-reduce:animate-none"
        :class="wbActive
          ? 'border-primary/40 bg-gradient-to-r from-primary-container/35 to-primary-container/10 shadow-[0_0_22px_rgb(var(--md-sys-color-primary)/0.18)]'
          : 'border-outline-variant bg-gradient-to-r from-primary-container/10 via-surface-container-low to-surface-container-lowest/50 dark:from-primary/15 hover:border-primary/30 hover:shadow-card-hover dark:hover:shadow-[0_0_18px_rgb(var(--md-sys-color-primary)/0.10)]'"
      >
        <!-- 同心回声细线:radius 随 inset 收减(38-3 / 16-3),与外弧平行 -->
        <div data-test="identity-echo" aria-hidden="true"
          class="absolute inset-[3px] rounded-tl-[35px] rounded-bl-[13px] border pointer-events-none transition-colors duration-300"
          :class="wbActive ? 'border-primary/50' : 'border-outline-variant/40'"></div>
        <!-- 光照①:顶部发丝线(left-[42px] 让出 38px 左上弧段,防悬空断线;亮暗分档反向) -->
        <div data-test="identity-toplight" aria-hidden="true"
          class="absolute top-0 left-[42px] right-1 h-px bg-gradient-to-r from-transparent via-black/10 to-transparent pointer-events-none dark:via-white/20"></div>
        <div data-test="identity-content" class="relative h-full flex items-center pl-md pr-1">
          <WorkbenchEntryPill />
          <div data-test="identity-hairline" aria-hidden="true" class="w-px self-stretch my-4 bg-gradient-to-b from-transparent via-outline-variant to-transparent"></div>
          <UserMenu />
        </div>
      </div>
    </div>
  </header>
  <!-- 手机 ns bottom sheet(桌面切换面板已离场):Teleport body + fixed 贴底(issue#4 同款) -->
  <Teleport to="body">
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
          <SearchResults :results="searchResults" @select="goResult" />
        </div>
      </div>
    </div>
  </Teleport>
  <!-- 点击外部关闭 ns sheet(手机档专用独立全屏遮罩,z 取 Z.popover-1,spec §13.2:
       盖过顶栏(50)/抽屉遮罩(54)/抽屉(55),面板(110)盖过遮罩;桌面已无顶栏面板) -->
  <div v-if="showNsDropdown && belowSm" class="fixed inset-0" data-test="sheet-overlay"
    :style="{ zIndex: String(Z.popover - 1) }" @click="closeNsDropdown()"></div>
</template>
