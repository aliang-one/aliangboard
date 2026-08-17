<script setup>
// 全局悬浮 AI 对话入口(挂 AppLayout 浮层区,spec §3.2):
// 10s 轮询 /conversations/active → chatPresence 纯函数算显隐/徽标 → 单按钮(≥2 个活跃先微型列表)。
// readAt 唯一写入点:Modal 打开期间(选中对话)+ 停留 /workbench/:id 期间(该项目全部对话)——
// 「看着它跑完」不误报未读,「走后才跑完」正确报未读。
// 连续 3 次轮询失败(含 401)→ 隐藏按钮但继续轮询,成功自愈恢复。
import { ref, computed, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { workbenchApi } from '@/api/client'
import {
  visibleConversations, presenceState, markRead, pruneReadAt, loadReadAt, hasUpdate,
} from '@/logic/chatPresence'
import { relTime } from '@/logic/relTime'

const ChatModal = defineAsyncComponent(() => import('./ChatModal.vue'))

const POLL_MS = 10_000
const MAX_FAILS = 3

const { t } = useI18n()
const route = useRoute()

const conversations = ref([])
const failCount = ref(0)
const readAt = ref(loadReadAt())
const listOpen = ref(false)
const selected = ref(null) // Modal 正打开的对话

// 正在 /workbench/:id 看某项目 → 该项目对话视为「正在看」(排除 + 刷 readAt)
const currentProjectId = computed(() => (route?.name === 'WorkbenchProject' ? route.params.id : null))

const visible = computed(() => visibleConversations(conversations.value, {
  currentProjectId: currentProjectId.value,
  readAt: readAt.value,
}))
const presence = computed(() => presenceState(visible.value, readAt.value))

async function poll() {
  if (document.hidden) return // 页面隐藏不轮询;visibilitychange 回前台立即补一次
  try {
    const data = await workbenchApi.conversations.active()
    conversations.value = (data && data.conversations) || []
    failCount.value = 0
    // readAt 刷新:正在看的项目全部对话 + Modal 开着的选中对话
    const watching = conversations.value
      .filter(c => (currentProjectId.value && c.projectId === currentProjectId.value)
        || (selected.value && c.id === selected.value.id))
      .map(c => c.id)
    if (watching.length) readAt.value = markRead(readAt.value, watching)
    readAt.value = pruneReadAt(readAt.value, conversations.value.map(c => c.id)) // Map 防膨胀
  } catch { failCount.value++ }
}

function onVisibility() { if (!document.hidden) poll() }

function onFabClick() {
  if (presence.value.directOpen) openConv(visible.value[0])
  else listOpen.value = !listOpen.value
}
function openConv(c) {
  selected.value = c
  listOpen.value = false
  readAt.value = markRead(readAt.value, [c.id])
}

let timer = null
onMounted(() => {
  poll()
  timer = setInterval(poll, POLL_MS)
  document.addEventListener('visibilitychange', onVisibility)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div v-if="presence.show && failCount < MAX_FAILS" class="fixed right-6 bottom-20 z-[45] flex flex-col items-end gap-sm">
    <!-- 微型列表(≥2 个活跃先选择;缩为 1 个时自动收起) -->
    <div v-if="listOpen && !presence.directOpen" data-testid="presence-list"
      class="w-72 bg-surface-container-lowest border border-outline-variant rounded-xl shadow-dropdown p-xs flex flex-col gap-0.5">
      <button v-for="c in visible" :key="c.id" data-testid="presence-row" @click="openConv(c)"
        class="text-left px-sm py-sm rounded-lg hover:bg-surface-container flex items-start gap-sm">
        <span class="material-symbols-outlined text-base shrink-0 mt-0.5" :class="{
          'text-status-warning': c.status === 'paused',
          'text-error': c.status === 'failed',
          'animate-spin text-on-surface-variant': c.status === 'running',
        }">{{
          c.status === 'paused' ? 'pending_actions'
          : c.status === 'failed' ? 'error'
          : c.status === 'done' ? 'check_circle'
          : 'progress_activity'
        }}</span>
        <span v-if="hasUpdate(c, readAt)" data-testid="update-dot"
          class="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-2" :title="t('workbench.presence.updateDot')"></span>
        <span class="min-w-0 flex-1">
          <span class="block text-body-sm truncate">{{ c.title || c.projectName }}</span>
          <span class="block text-body-xs text-on-surface-variant">{{ c.projectName }} · {{ relTime(c.updatedAt, t) }}</span>
        </span>
      </button>
    </div>
    <!-- 悬浮按钮:paused=审批红点 / 未读终答=smart_toy / running=转圈;≥2 个带数字角标 -->
    <button data-testid="chat-presence-fab" @click="onFabClick"
      class="w-12 h-12 rounded-full bg-primary text-on-primary shadow-lg flex items-center justify-center relative hover:shadow-xl transition-shadow"
      :title="t('workbench.presence.title')">
      <span class="material-symbols-outlined" :class="{ 'animate-spin': presence.level === 'running' }">{{ presence.icon }}</span>
      <span v-if="presence.badgeCount > 1"
        class="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-error text-on-error text-body-xs font-bold flex items-center justify-center">{{ presence.badgeCount }}</span>
      <span v-else-if="presence.level === 'paused'"
        class="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-error border-2 border-surface-container-lowest"></span>
    </button>
  </div>
  <!-- 与按钮壳平级(评审修复 Critical-1):①布局——居中大弹层本就不该栖身按钮的 fixed 定位壳;
      ②行为——近期动态模型下条目常驻,但 Modal 仍只许由 selected 控制挂载/卸载,
      不得被按钮壳(空列表/failCount 隐藏)连带卸载。
      关闭即卸载(v-if selected)→ WorkbenchChat 的 SSE 随之断流;服务端 detached 继续跑 -->
  <ChatModal v-if="selected" :model-value="true" :conversation="selected"
    @update:model-value="v => { if (!v) selected = null }" />
</template>
