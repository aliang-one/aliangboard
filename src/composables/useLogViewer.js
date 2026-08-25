// src/composables/useLogViewer.js
// Pod 日志响应式编排：流式/静态拉取状态机（迁自 PodDetail.vue logs tab 并强化）+
// openLogTab（浏览器新标签页打开 /log-popup，TerminalPopup 同构）。
import { ref, watch, onMounted, onUnmounted, getCurrentInstance } from 'vue'
import { api, k8sStream, getSessionToken } from '@/api/client'
import { i18n } from '@/i18n'
import { parseLogLine, buildLogQuery, pushCapped } from '@/logic/podLogs'

export const MAX_LOG_BUFFER = 5000
export const LOG_LINE_OPTIONS = [100, 500, 1000, 5000]
export const LOG_SINCE_OPTIONS = [
  { value: '', seconds: 0 },
  { value: '300', seconds: 300 },
  { value: '900', seconds: 900 },
  { value: '3600', seconds: 3600 },
  { value: '21600', seconds: 21600 },
]

export function useLogViewer({ namespace, podName, container }) {
  const lines = ref([])          // [{timestamp, level, message}]，cap MAX_LOG_BUFFER
  const followLog = ref(true)    // follow 流式开关（previous 时强制 false）
  const logLines = ref(500)      // --tail
  const logSince = ref('')       // ''=不限；否则 sinceSeconds 字符串
  const logPrevious = ref(false) // --previous（崩溃前容器日志）
  const streamError = ref('')    // 流中断/拉取失败（横幅）
  let stream = null

  function logPath(follow) {
    const q = buildLogQuery({
      container: container.value,
      tailLines: logLines.value,
      sinceSeconds: Number(logSince.value) || 0,
      previous: logPrevious.value,
      follow,
    })
    return `/api/v1/namespaces/${encodeURIComponent(namespace.value)}/pods/${encodeURIComponent(podName.value)}/log?${q}`
  }

  async function loadRemoteLogs() {
    if (!podName.value) return
    streamError.value = ''
    try {
      const text = await api.k8s(logPath(false))
      lines.value = String(text || '').split('\n').filter(Boolean).map(parseLogLine)
    } catch (e) {
      lines.value = [{ timestamp: new Date().toISOString(), level: 'ERROR', message: e?.message || i18n.global.t('component.logViewer.loadFailed') }]
    }
  }

  function startFollow() {
    if (!podName.value) return
    stopFollow()
    lines.value = []
    streamError.value = ''
    stream = k8sStream(logPath(true), {
      onMessage: line => pushCapped(lines.value, parseLogLine(line), MAX_LOG_BUFFER),
      onError: e => {
        streamError.value = e?.message || i18n.global.t('component.logViewer.streamInterrupted')
        pushCapped(lines.value, { timestamp: new Date().toISOString(), level: 'ERROR', message: streamError.value }, MAX_LOG_BUFFER)
      },
    })
  }
  function stopFollow() {
    if (stream) { stream.abort(); stream = null }
  }
  // 按当前模式重启：follow 开（且非 previous）走流，否则静态拉取
  function restart() {
    if (followLog.value && !logPrevious.value) startFollow()
    else { stopFollow(); loadRemoteLogs() }
  }

  watch(followLog, v => (v ? startFollow() : stopFollow()))
  watch(container, restart)
  watch([logLines, logSince], restart)
  watch(logPrevious, v => { if (v) followLog.value = false; restart() })

  // 仅在组件 setup 内注册生命周期（测试可绕过宿主直接调用函数）
  if (getCurrentInstance()) {
    onMounted(() => (followLog.value && !logPrevious.value ? startFollow() : loadRemoteLogs()))
    onUnmounted(stopFollow)
  }
  return { lines, followLog, logLines, logSince, logPrevious, streamError, startFollow, stopFollow, loadRemoteLogs, restart }
}

// 在新浏览器标签页打开独立日志页：同 ns+pod+container 复用同一标签页（具名 target 聚焦），换容器另开。
export function openLogTab({ namespace, podName, container = '' }) {
  const params = new URLSearchParams({ ns: namespace, pod: podName, container, token: getSessionToken() })
  window.open(`${window.location.origin}/log-popup?${params}`, `log-${namespace}-${podName}-${container}`)
}
