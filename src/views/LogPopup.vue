<script setup>
// 独立日志页（新浏览器标签页打开，TerminalPopup 同构）：全屏日志，无侧栏/顶栏。
// URL: /log-popup?ns=xxx&pod=xxx&container=xxx&token=xxx
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LogViewerBody from '@/components/common/LogViewerBody.vue'
import { api } from '@/api/client'
import { useClusterStore } from '@/stores/cluster'
import { codeTheme } from '@/styles/code-theme'

const { t } = useI18n()
const route = useRoute()
const store = useClusterStore()
const ns = computed(() => String(route.query.ns || ''))
const pod = computed(() => String(route.query.pod || ''))
const container = ref(String(route.query.container || ''))
// 容器列表：先以 URL 单容器兜底，挂载后拉 pod spec 补全（containers+initContainers+ephemeralContainers）
const containers = ref(container.value ? [container.value] : [])

// session token 已由 main.js 从 URL 写入 sessionStorage；缺失则整页提示会话过期
const hasToken = !!sessionStorage.getItem('aliangboard.session')
if (!hasToken) {
  document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:${codeTheme.surface};color:${codeTheme.onSurface};font-family:monospace;font-size:14px">${t('terminal.expired')}</div>`
} else if (ns.value) {
  store.setNamespace(ns.value)
}

document.title = t('logPopup.title', { pod: pod.value, container: container.value })

function containerNames(raw) {
  const spec = raw?.spec || {}
  return [...new Set([...(spec.containers || []), ...(spec.initContainers || []), ...(spec.ephemeralContainers || [])]
    .map(c => c?.name).filter(Boolean))]
}
onMounted(async () => {
  try {
    const raw = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns.value)}/pods/${encodeURIComponent(pod.value)}`)
    const names = containerNames(raw)
    if (names.length) containers.value = names
  } catch { /* 拉取失败保留 URL 单容器兜底 */ }
})
function close() { window.close() }
</script>

<template>
  <div class="h-screen w-screen flex flex-col bg-code-surface">
    <!-- 顶栏（pod 名 + 定位 + 关闭） -->
    <div class="flex items-center gap-sm px-md shrink-0 bg-surface-container-high border-b border-outline-variant" style="height: 36px">
      <span class="material-symbols-outlined text-base text-primary">subject</span>
      <span class="text-body-sm font-medium text-on-surface truncate flex-1">{{ pod }}</span>
      <span class="text-body-xs text-on-surface-variant/60 font-mono">{{ ns }}/{{ pod }}{{ container ? ':' + container : '' }}</span>
      <button @click="close" class="flex items-center gap-xs px-sm py-0.5 rounded-md bg-error/10 text-error hover:bg-error/20 text-body-xs font-medium transition-colors shrink-0">
        <span class="material-symbols-outlined text-sm">close</span>{{ t('logPopup.closeWindow') }}
      </button>
    </div>
    <!-- 全屏日志查看器 -->
    <div class="flex-1 min-h-0">
      <LogViewerBody :namespace="ns" :pod-name="pod" :containers="containers" v-model:container="container" />
    </div>
  </div>
</template>
