<script setup>
import { ref, computed, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { getSession } from '@/api/client'
import { useDropdownPanel } from '@/composables/useDropdownPanel'
import { useAlertReadState, unreadWarnings, eventKey } from '@/composables/useAlertReadState'
import { routeForResource } from '@/logic/resourceNavigation'
import { buildCertAlerts } from '@/logic/certExpiry'
import { Z } from '@/styles/zScale'

// 全局告警铃铛(2026-09-04 顶栏改版):吃既有全局 events 查询(键与监控/ns 事件页共享)。
// 自轮询只在 watch 流不活跃时兜底(watch live 期间 views 已切零轮询,观察者各自持
// interval,若这里仍 60s 会把整表 events 拉成常驻全局轮询——审查抓回)。
// 未读语义承 Headlamp:红点 + 面板内未读加粗,行点击/全部已读显式确认(不自动已读)。
const router = useRouter()
const route = useRoute()
const store = useClusterStore()
const { t } = useI18n()
const cid = computed(() => (store.currentCluster || 'cluster'))
// 无 K8s session(首装 admin 在平台管理页)不拉 events——拉了必 401(与顶栏 ns 选择器同门槛)
const enabled = computed(() => !!getSession())
const eventsQ = useResourceList({
  key: ['cluster', cid, 'events'],
  fetcher: () => store.fetchEvents(),
  options: { enabled, refetchInterval: computed(() => (store.eventWatchLive ? false : 60000)), refetchOnWindowFocus: false },
})

const warningEvents = computed(() => (eventsQ.data.value || []).filter(e => e.type === 'warning'))
// 证书到期告警(2026-09-06):与 /cluster/certs 页共用 ['cluster',cid,'certs'] 缓存,零额外请求;
// 证书变化慢 → 独立 5min 慢轮询,不与 events 的 60s/watch 互斥逻辑耦合。伪事件 uid=证书指纹。
const certsQ = useResourceList({
  key: ['cluster', cid, 'certs'],
  fetcher: () => store.fetchClusterCerts(),
  options: { enabled, refetchInterval: 300_000, refetchOnWindowFocus: false },
})
const certAlerts = computed(() => buildCertAlerts(certsQ.data.value, { t }))
const allWarnings = computed(() => [...warningEvents.value, ...certAlerts.value])
const { readUids, markAllRead } = useAlertReadState(cid)
const unread = computed(() => unreadWarnings(allWarnings.value, readUids.value))
const unreadKeys = computed(() => new Set(unread.value.map(eventKey)))
const isUnread = e => unreadKeys.value.has(eventKey(e))
const panelRows = computed(() => allWarnings.value.slice(0, 30))

// eventIconColor 返回裸 token(primary/tertiary/error/surface),非 tailwind 类,需显式映射
const COLOR_CLASS = { primary: 'text-primary', tertiary: 'text-tertiary', error: 'text-error', surface: 'text-on-surface-variant' }
const colorClass = e => COLOR_CLASS[e.color] || 'text-on-surface-variant'

// 弹层:Teleport body + fixed 锚定(issue#4 配方);遮罩 Z.popover-1 盖过侧栏(40)/顶栏(50)
const open = ref(false)
const bellRef = ref(null)
const { panelRef, panelStyle } = useDropdownPanel(bellRef, open)
// 路由变化即收面板(面板是 body 级 Teleport,跨路由不自动卸载)
watch(() => route.fullPath, () => { open.value = false })

function onRowClick(e) {
  markAllRead([e])
  open.value = false
  const target = routeForResource(e.relatedKind, e.relatedName, e.relatedNamespace)
  if (target) router.push(target)
  else if (e.namespace) router.push({ name: 'NsEvents', params: { namespace: e.namespace } })
  else router.push('/monitoring') // 无 ns 无详情路由(如未知 kind 的系统事件)
}
function onMarkAllRead() { markAllRead(allWarnings.value) }
</script>

<template>
  <button
    ref="bellRef"
    data-test="alert-bell"
    class="relative p-sm text-on-surface-variant hover:bg-surface-container-low hover:text-primary rounded-full transition-colors"
    :aria-label="$t('nav.alerts')" :title="$t('nav.alerts')"
    aria-haspopup="true" :aria-expanded="open ? 'true' : 'false'"
    @click="open = !open"
  >
    <span class="material-symbols-outlined">notifications</span>
    <span v-if="unread.length" data-test="alert-dot"
      class="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-error border-2 border-surface"></span>
  </button>
  <Teleport to="body">
    <div v-if="open" ref="panelRef" data-testid="alert-panel" data-test="alert-panel"
      class="w-96 max-w-[calc(100vw-16px)] bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown overflow-hidden"
      :style="panelStyle">
      <div class="flex items-center justify-between px-md py-sm border-b border-outline-variant">
        <p class="text-label-caps text-on-surface-variant">
          {{ $t('nav.alerts') }}
          <span v-if="unread.length" class="ml-2 text-xs font-semibold text-error">{{ $t('nav.alertUnread', { n: unread.length }) }}</span>
        </p>
        <button data-test="alert-mark-read" class="flex items-center gap-1 text-body-sm text-primary hover:opacity-80 transition-opacity" @click="onMarkAllRead">
          <span class="material-symbols-outlined text-base">done_all</span>
          {{ $t('nav.markAllRead') }}
        </button>
      </div>
      <div class="max-h-80 overflow-y-auto p-sm">
        <div
          v-for="e in panelRows"
          :key="eventKey(e)"
          data-test="alert-row"
          class="flex items-start gap-sm px-md py-sm rounded-lg cursor-pointer transition-all hover:bg-surface-container"
          :class="isUnread(e) ? 'alert-row--unread bg-error/5' : ''"
          @click="onRowClick(e)"
        >
          <span class="material-symbols-outlined text-lg shrink-0 mt-0.5" :class="colorClass(e)">{{ e.icon }}</span>
          <div class="min-w-0 flex-1">
            <p class="text-body-sm font-medium truncate">{{ e.reason }}</p>
            <p class="text-xs text-on-surface-variant truncate">{{ e.relatedKind }}/{{ e.relatedName }}<span v-if="e.namespace"> · {{ e.namespace }}</span></p>
          </div>
          <span class="text-xs text-on-surface-variant shrink-0 ml-auto pl-sm">{{ e.age }}</span>
        </div>
        <p v-if="!panelRows.length" data-test="alert-empty" class="text-body-sm text-on-surface-variant text-center py-md">{{ $t('nav.alertsEmpty') }}</p>
      </div>
    </div>
  </Teleport>
  <!-- 点击外部关闭(遮罩 Z.popover-1:盖过侧栏 40/顶栏 50,被面板 110 盖) -->
  <div v-if="open" data-test="alert-overlay" class="fixed inset-0" :style="{ zIndex: String(Z.popover - 1) }" @click="open = false"></div>
</template>
