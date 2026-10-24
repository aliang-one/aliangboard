<script setup>
// 全局搜索宿主(2026-10-23 顶栏退役 Task 6):TopNavBar 搜索逻辑整体迁入,三态自适应——
//   desktop(≥lg):内联输入框 + Teleport 锚定下拉(useDropdownPanel,docked 结果内嵌);
//   rail(<lg 且 ≥sm):图标钮 + 顶部居中弹层(承 TopNavBar search-modal 逐字);
//   drawer(<sm):抽屉内内联框 + 贴底 sheet(承 TopNavBar ns bottom sheet 配方,Z.popover/-1)。
// 惰性查询门控/⌘K/页面同义词与 TopNavBar 同语义;admin 页面条目经 showAdmin: auth.isAdmin
// 门控(Task 2)。TopNavBar 本体仍在岗(Task 8 退役),勿动。
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useAuthStore } from '@/stores/auth'
import SearchResults from './SearchResults.vue'
import { useResourceList } from '@/composables/useK8sQuery'
import { useDropdownPanel } from '@/composables/useDropdownPanel'
import { getSession } from '@/api/client'
import { useBreakpoint, MQ_BELOW_LG, MQ_BELOW_SM } from '@/composables/useBreakpoint'
import { Z } from '@/styles/zScale'
import { searchAll, collectResourceItems } from '@/logic/globalSearch'
import { routeForResource } from '@/logic/resourceNavigation'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const route = useRoute()
const store = useClusterStore()
const auth = useAuthStore()
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

// === 全局搜索:惰性 Query 消费者(自 TopNavBar 迁) ===
// 惰性资源查询仅在搜索框/弹层打开时 enabled(避免无谓请求);nodes/namespaces 读 store 预载。
const cid = computed(() => (store.currentCluster || 'cluster'))
const searchOpen = ref(false)
const searchModalOpen = ref(false)
const searchModalInput = ref(null)
const searchQuery = ref('')
const inputRef = ref(null)
// 弹层打开也启用惰性查询(与内联 focus 同语义)
const searchEnabled = computed(() => searchOpen.value || searchModalOpen.value)
function openSearchModal() {
  searchModalOpen.value = true
  nextTick(() => searchModalInput.value?.focus())
}
function closeSearchModal() { searchModalOpen.value = false; searchQuery.value = '' }

// === 三态自适应:desktop / rail / drawer ===
const { matches: belowLg } = useBreakpoint(MQ_BELOW_LG)
const { matches: belowSm } = useBreakpoint(MQ_BELOW_SM)
const mode = computed(() => belowSm.value ? 'drawer' : (belowLg.value ? 'rail' : 'desktop'))
const isDesktop = computed(() => mode.value === 'desktop')

// ⌘K/Ctrl+K 全局快捷键:desktop 聚焦内联框,rail 打开弹层,drawer no-op(手机键盘场景
// 稀缺,入口由抽屉内联框承担,不劫持按键)
function onGlobalKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
    // 焦点在其它可编辑元素时不抢(YAML 编辑器/工作台输入框内 ⌘K 不应悄悄灌进搜索框)
    const t = e.target
    const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    if (editable && t !== inputRef.value) return
    if (mode.value === 'drawer') return
    e.preventDefault()
    if (mode.value === 'rail') openSearchModal()
    else inputRef.value?.focus()
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))

// 搜索惰性查询(20 类):仅搜索打开时 enabled
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
// namespaces 常驻 Query(选择器需要,非搜索惰性)——无 K8s session 时不轮询(拉了必 401,纯属噪音)
const nsEnabled = computed(() => !!getSession())
const nsQ = useResourceList({ key: ['cluster', cid, 'namespaces'], fetcher: () => store.fetchNamespaces(), options: { refetchInterval: 60000, enabled: nsEnabled } })
const allNamespaces = computed(() => nsQ.data.value ?? store.namespaceList)

// === 全局搜索:页面导航 + 20 类资源,聚合/排序/跳转映射在 logic 单源 ===
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
// admin 页面条目仅 admin 可搜(Task 2 门控:showAdmin 放行 PLATFORM_ADMIN_NAV 派生条目)
const searchResults = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return []
  const { pages, resources } = searchAll(q, buildItems(), { synonyms: pageSynonyms.value, showAdmin: auth.isAdmin })
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

// desktop 下拉:Teleport body + 锚定内联框 rect(useDropdownPanel 共享配方),
// 有结果才开(面板随结果显隐,blur 不清查询)
const resultsOpen = computed(() => isDesktop.value && searchResults.value.length > 0)
const { panelRef, panelStyle } = useDropdownPanel(inputRef, resultsOpen, { matchTriggerWidth: true })

// 路由切换收起残留结果(TopNavBar 无此守卫;迁入侧栏后补:长驻组件不随页面卸载清场)
watch(() => route.fullPath, () => { searchQuery.value = ''; searchModalOpen.value = false })
</script>

<template>
  <div data-test="sidenav-search" class="px-md pt-md pb-sm shrink-0">
    <!-- desktop / drawer:内联框 -->
    <div v-if="mode !== 'rail'" class="relative">
      <span class="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-sm pointer-events-none z-10">search</span>
      <input ref="inputRef" data-test="search-input" v-model="searchQuery"
        @keydown="onSearchKeydown" @focus="searchOpen = true" @blur="searchOpen = false"
        class="w-full bg-surface-container-low border border-outline-variant rounded-full py-1.5 pl-8 pr-md text-body-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
        :placeholder="$t('nav.searchPlaceholder')" :aria-label="$t('common.search')" type="text" />
      <kbd v-if="isDesktop" data-test="search-kbd" aria-hidden="true" class="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] leading-none text-on-surface-variant border border-outline-variant rounded px-1.5 py-1 pointer-events-none">⌘K</kbd>
    </div>
    <!-- rail:图标钮开弹层 -->
    <button v-else data-test="search-trigger" @click="openSearchModal"
      class="w-full flex items-center justify-center p-sm rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-primary transition-colors"
      :aria-label="$t('common.search')">
      <span class="material-symbols-outlined">search</span>
    </button>

    <!-- desktop 结果:Teleport 锚定下拉(docked 列表内嵌) -->
    <Teleport to="body">
      <div v-if="resultsOpen" ref="panelRef" data-test="search-dropdown"
        class="bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown overflow-hidden" :style="panelStyle">
        <SearchResults :results="searchResults" :docked="true" @select="goResult" />
      </div>
    </Teleport>

    <!-- rail 弹层(承 TopNavBar search-modal 逐字:遮罩+顶部居中+nextTick autofocus) -->
    <Teleport to="body">
      <div v-if="searchModalOpen" data-test="search-modal" class="fixed inset-0" :style="{ zIndex: Z.popover }">
        <div class="absolute inset-0 bg-black/30" @click="closeSearchModal"></div>
        <div class="absolute left-1/2 -translate-x-1/2 top-16 w-[min(92vw,480px)]">
          <div class="relative">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none z-10">search</span>
            <input ref="searchModalInput" data-test="search-modal-input" v-model="searchQuery" @keydown="onSearchKeydown"
              class="w-full bg-surface-container-low border border-outline-variant rounded-full py-2.5 pl-10 pr-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary shadow-dropdown"
              :placeholder="$t('nav.searchPlaceholder')" :aria-label="$t('common.search')" type="text" />
            <SearchResults :results="searchResults" :docked="true" @select="goResult" />
          </div>
        </div>
      </div>
    </Teleport>

    <!-- drawer 贴底 sheet(手机;承 TopNavBar ns bottom sheet 配方:Z.popover 盖遮罩 Z.popover-1) -->
    <Teleport to="body">
      <div v-if="mode === 'drawer' && searchResults.length" data-test="search-sheet"
        class="fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[70vh] overflow-y-auto bg-surface-container-lowest border border-outline-variant max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+12px)]"
        :style="{ zIndex: Z.popover }">
        <SearchResults :results="searchResults" :docked="true" @select="goResult" />
      </div>
      <div v-if="mode === 'drawer' && searchResults.length" class="fixed inset-0"
        :style="{ zIndex: String(Z.popover - 1) }" @click="searchQuery = ''"></div>
    </Teleport>
  </div>
</template>
