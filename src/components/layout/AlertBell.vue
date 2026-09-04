<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { getSession } from '@/api/client'
import { useDropdownPanel } from '@/composables/useDropdownPanel'
import { useAlertReadState, unreadWarnings, eventKey } from '@/composables/useAlertReadState'
import { routeForResource } from '@/logic/resourceNavigation'

// 全局告警铃铛(2026-09-04 顶栏改版):吃既有全局 events 查询(键与监控/ns 事件页共享,
// 打开监控页时由其自适应节奏接管),只取 warning 子集。未读语义承 Headlamp:
// 红点 + 面板内未读加粗,行点击/全部已读显式确认(不自动已读,未确认即持续提醒)。
const router = useRouter()
const store = useClusterStore()
const cid = computed(() => (store.currentCluster || 'cluster'))
// 无 K8s session(首装 admin 在平台管理页)不拉 events——拉了必 401(与顶栏 ns 选择器同门槛)
const enabled = computed(() => !!getSession())
const eventsQ = useResourceList({
  key: ['cluster', cid, 'events'],
  fetcher: () => store.fetchEvents(),
  options: { enabled, refetchInterval: 60000, refetchOnWindowFocus: false },
})

const warningEvents = computed(() => (eventsQ.data.value || []).filter(e => e.type === 'warning'))
const { readUids, markAllRead } = useAlertReadState(cid)
const unread = computed(() => unreadWarnings(warningEvents.value, readUids.value))
const unreadKeys = computed(() => new Set(unread.value.map(eventKey)))
const isUnread = e => unreadKeys.value.has(eventKey(e))
const panelRows = computed(() => warningEvents.value.slice(0, 30))

// 弹层:Teleport body + fixed 锚定(issue#4 配方);遮罩 z-30 在面板(110)之下
const open = ref(false)
const bellRef = ref(null)
const { panelRef, panelStyle } = useDropdownPanel(bellRef, open)

function onRowClick(e) {
  markAllRead([e])
  open.value = false
  const route = routeForResource(e.relatedKind, e.relatedName, e.relatedNamespace)
  if (route) router.push(route)
  else if (e.namespace) router.push({ name: 'NsEvents', params: { namespace: e.namespace } })
  else router.push('/monitoring') // 无 ns 无详情路由(如未知 kind 的系统事件)
}
function onMarkAllRead() { markAllRead(warningEvents.value) }
</script>

<template>
  <button
    ref="bellRef"
    data-test="alert-bell"
    class="relative p-sm text-on-surface-variant hover:bg-surface-container-low hover:text-primary rounded-full transition-colors"
    :aria-label="$t('nav.alerts')" :title="$t('nav.alerts')"
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
          <span class="material-symbols-outlined text-lg shrink-0 mt-0.5" :class="e.color">{{ e.icon }}</span>
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
  <!-- 点击外部关闭(遮罩 z-30 < 面板 110) -->
  <div v-if="open" data-test="alert-overlay" class="fixed inset-0 z-30" @click="open = false"></div>
</template>
