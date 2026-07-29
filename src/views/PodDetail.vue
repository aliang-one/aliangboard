<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { dump as yamlDump } from 'js-yaml'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import InteractiveTerminal from '@/components/common/InteractiveTerminal.vue'
import { api, k8sStream, podFileApi, podDebugApi, exportYaml } from '@/api/client'
import { notify } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
if (route.params.namespace) store.setNamespace(route.params.namespace)

const pod = computed(() => store.getPodByName(route.params.name, route.params.namespace))
const activeTab = ref('logs')

// 多容器 Pod：可选择查看哪个容器的日志 / exec 进哪个容器（含本会话注入的调试容器）
const debugContainers = ref([])
const containers = computed(() => {
  const base = pod.value?.containers?.length ? pod.value.containers : ['main']
  return [...new Set([...base, ...debugContainers.value])]
})
const selectedContainer = ref('')
watch(pod, (p) => { if (p && !selectedContainer.value) selectedContainer.value = (p.containers?.[0] || 'main') }, { immediate: true })

const tabs = [
  { key: 'logs', label: 'Logs', icon: 'terminal' },
  { key: 'files', label: 'Files', icon: 'folder' },
  { key: 'yaml', label: 'YAML', icon: 'description' },
  { key: 'terminal', label: 'Terminal', icon: 'keyboard' },
  { key: 'events', label: 'Events', icon: 'event_note' },
]

function levelColor(level) {
  const map = { INFO: 'text-primary-container', WARN: 'text-tertiary-fixed-dim', ERROR: 'text-error' }
  return map[level] || 'text-outline-variant'
}

// === 日志下载 / 复制 ===
function formatLogs() {
  return allLogs.value.map(l => `${l.timestamp} [${l.level}] ${l.message}`).join('\n')
}
function downloadLogs() {
  const blob = new Blob([formatLogs()], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${pod.value?.name || 'pod'}-logs.txt`
  a.click()
  URL.revokeObjectURL(url)
}
async function copyLogs() {
  try {
    await navigator.clipboard.writeText(formatLogs())
  } catch (e) { /* clipboard 不可用时静默 */ }
}

// === 日志实时流（Follow）===
const followLog = ref(true)
const liveLogs = ref([])
let logTimer = null
let logStream = null    // 真流式（log follow）的句柄，stopFollow 时 abort
// 日志查询选项（kubectl logs 语义：--tail / --since / --previous）
const logLines = ref(500)
const logSince = ref('')            // 空字符串 = 不限时间；否则为 sinceSeconds
const logPrevious = ref(false)      // --previous：上一容器（崩溃前）日志
const lineOptions = [100, 500, 1000, 5000]
const sinceOptions = [
  { label: '全部', value: '' },
  { label: '近 5 分钟', value: '300' },
  { label: '近 15 分钟', value: '900' },
  { label: '近 1 小时', value: '3600' },
  { label: '近 6 小时', value: '21600' },
]
const sampleLogMessages = [
  { level: 'INFO', message: 'GET /api/v1/health - 200 OK (8ms)' },
  { level: 'INFO', message: 'GET /api/v1/metrics - 200 OK (24ms)' },
  { level: 'INFO', message: 'POST /api/v1/orders - 201 Created (142ms)' },
  { level: 'INFO', message: 'Cache hit ratio: 95.3%' },
  { level: 'WARN', message: 'Slow query detected on /api/v1/search (210ms)' },
  { level: 'INFO', message: 'GET /api/v1/users - 200 OK (18ms)' },
  { level: 'INFO', message: 'Scheduled task completed: cleanup-sessions' },
  { level: 'INFO', message: 'WS heartbeat acknowledged: client-ok' },
  { level: 'INFO', message: 'DB connection pool: 8/10 active' },
]
function pushLog() {
  const sample = sampleLogMessages[Math.floor(Math.random() * sampleLogMessages.length)]
  liveLogs.value.push({ timestamp: new Date().toISOString().substr(11, 12), level: sample.level, message: sample.message })
  if (liveLogs.value.length > 80) liveLogs.value.shift()
}
function logQuery(follow = false) {
  const container = selectedContainer.value || pod.value.containers?.[0]
  const query = new URLSearchParams({ timestamps: 'true', tailLines: String(logLines.value) })
  if (container) query.set('container', container)
  if (logPrevious.value) query.set('previous', 'true')            // --previous
  if (logSince.value) query.set('sinceSeconds', String(logSince.value)) // --since
  if (follow) query.set('follow', 'true')
  return query
}
function parseLogLine(line) {
  const match = String(line).match(/^(\S+)\s(.*)$/)
  const timestamp = match?.[1] || ''
  const message = match?.[2] || line
  const level = /\berror\b/i.test(message) ? 'ERROR' : /\bwarn(?:ing)?\b/i.test(message) ? 'WARN' : 'INFO'
  return { timestamp, level, message }
}
function pushParsed(line) {
  liveLogs.value.push(parseLogLine(line))
  if (liveLogs.value.length > 300) liveLogs.value.splice(0, liveLogs.value.length - 300)
}
async function loadRemoteLogs() {
  if (!pod.value) return
  try {
    const text = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(pod.value.namespace)}/pods/${encodeURIComponent(pod.value.name)}/log?${logQuery()}`)
    liveLogs.value = String(text || '').split('\n').filter(Boolean).map(parseLogLine)
  } catch (error) {
    liveLogs.value = [{ timestamp: new Date().toISOString(), level: 'ERROR', message: error.message || '日志读取失败' }]
  }
}
function startFollow() {
  stopFollow()
  if (store.remoteMode) {
    // 真流式：log?follow=true，逐行增量追加（Gateway 已对 follow 请求 pipe 透传）
    const path = `/api/v1/namespaces/${encodeURIComponent(pod.value.namespace)}/pods/${encodeURIComponent(pod.value.name)}/log?${logQuery(true)}`
    liveLogs.value = []
    logStream = k8sStream(path, {
      onMessage: pushParsed,
      onError: e => { liveLogs.value.push({ timestamp: new Date().toISOString(), level: 'ERROR', message: e.message || '日志流中断' }) },
    })
  } else {
    logTimer = setInterval(pushLog, 1800)
  }
}
function stopFollow() {
  if (logTimer) { clearInterval(logTimer); logTimer = null }
  if (logStream) { logStream.abort(); logStream = null }
}
watch(followLog, (v) => { v ? startFollow() : stopFollow() })
// 切换容器时，远程模式重新拉取该容器日志（follow 开则重启流）
watch(selectedContainer, () => {
  if (!store.remoteMode) return
  if (followLog.value && !logPrevious.value) startFollow(); else loadRemoteLogs()
})
// 切换 tail / since / previous 时重启流或重拉；previous 为崩溃前静态日志，开启时关闭 follow
watch([logLines, logSince, logPrevious], () => {
  if (logPrevious.value) followLog.value = false
  if (!store.remoteMode) return
  if (followLog.value && !logPrevious.value) startFollow(); else loadRemoteLogs()
})
onMounted(() => { if (followLog.value) startFollow(); else if (store.remoteMode) loadRemoteLogs() })
onUnmounted(stopFollow)
const allLogs = computed(() => store.remoteMode ? liveLogs.value : [...store.logEntries, ...liveLogs.value])

// 资源用量百分比：优先用远端数值字段，缺失时回退解析 "used/total" 字符串（兼容 mock）
function pctFromRatio(str) {
  if (!str || str === '0/0') return null
  const parts = String(str).split('/')
  if (parts.length !== 2) return null
  const used = parseFloat(parts[0])
  const total = parseFloat(parts[1])
  if (!total) return null
  return Math.min(100, Math.round((used / total) * 100))
}
const cpuPct = computed(() => {
  const p = pod.value
  if (p?.usedCpu != null && p?.reqCpu) return Math.min(100, Math.round((p.usedCpu / p.reqCpu) * 100))
  return pctFromRatio(p?.cpu)
})
const memPct = computed(() => {
  const p = pod.value
  if (p?.usedMem != null && p?.reqMem) return Math.min(100, Math.round((p.usedMem / p.reqMem) * 100))
  return pctFromRatio(p?.memory)
})

// === Pod 操作（Delete / Restart）+ 真实 YAML 视图 ===
const confirmAction = ref(null)   // null | { mode: 'delete' | 'restart' }
const confirmOpen = computed({ get: () => !!confirmAction.value, set: v => { if (!v) confirmAction.value = null } })
function askDelete() { confirmAction.value = { mode: 'delete' } }
function askRestart() { confirmAction.value = { mode: 'restart' } }
async function exportPod() {
  if (!pod.value) return
  try {
    await exportYaml(`/api/v1/namespaces/${encodeURIComponent(pod.value.namespace)}/pods/${encodeURIComponent(pod.value.name)}`, `${pod.value.name}.yaml`)
    notify('已导出 YAML', 'success')
  } catch (e) { notify(e.message || '导出失败', 'error') }
}
async function doConfirmed() {
  const mode = confirmAction.value?.mode
  confirmAction.value = null
  if (!pod.value) return
  try {
    await store.deletePod(pod.value.name, pod.value.namespace)
    // 重启语义：删除该 Pod，由所属控制器重新拉起（独立 Pod 不会重建）
    notify(mode === 'restart' ? '已删除该 Pod，由控制器重新拉起（独立 Pod 不会重建）' : 'Pod 已删除', 'success')
    router.push(`/ns/${route.params.namespace}/pods`)
  } catch (e) {
    notify(e.message || '操作失败', 'error')
  }
}

const podYaml = ref('')
const yamlLoading = ref(false)
async function loadYaml() {
  if (!pod.value) return
  if (!store.remoteMode) {
    podYaml.value = yamlDump({
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: pod.value.name, namespace: pod.value.namespace, labels: pod.value.labels || {} },
      spec: { containers: [{ name: pod.value.containers?.[0] || 'main', image: pod.value.image }] },
    })
    return
  }
  yamlLoading.value = true
  try {
    const obj = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(pod.value.namespace)}/pods/${encodeURIComponent(pod.value.name)}`)
    const clone = JSON.parse(JSON.stringify(obj))
    if (clone?.metadata) delete clone.metadata.managedFields   // 去掉冗长的 managedFields，便于阅读
    podYaml.value = yamlDump(clone)
  } catch (e) {
    podYaml.value = `# 加载失败：${e.message || ''}`
  } finally {
    yamlLoading.value = false
  }
}
watch(activeTab, t => { if (t === 'yaml' && !podYaml.value) loadYaml() })

// === 注入调试容器（kubectl debug，用于无 shell / distroless 镜像）===
const showDebug = ref(false)
const debugAttaching = ref(false)
const debugForm = ref({ image: 'nicolaka/netshoot:latest', name: 'debugger', command: 'sh', targetContainer: '' })
const debugImages = ['nicolaka/netshoot:latest', 'busybox:1.28', 'alpine:latest', 'ubuntu:22.04']
function openDebug() {
  const first = pod.value?.containers?.[0]
  debugForm.value = { image: 'nicolaka/netshoot:latest', name: 'debugger', command: 'sh', targetContainer: first && first !== 'main' ? first : '' }
  showDebug.value = true
}
async function doAttachDebug() {
  if (!pod.value) return
  debugAttaching.value = true
  try {
    await podDebugApi.attach({
      namespace: pod.value.namespace, pod: pod.value.name,
      image: debugForm.value.image, name: debugForm.value.name,
      command: debugForm.value.command, targetContainer: debugForm.value.targetContainer || '',
    })
    if (!debugContainers.value.includes(debugForm.value.name)) debugContainers.value.push(debugForm.value.name)
    selectedContainer.value = debugForm.value.name   // 终端容器选择切到调试容器
    showDebug.value = false
    activeTab.value = 'terminal'
    notify(`已注入调试容器 ${debugForm.value.name}（稍候片刻待其启动，再点 Connect 进入）`, 'success')
  } catch (e) {
    notify(e.message || '注入调试容器失败', 'error')
  } finally {
    debugAttaching.value = false
  }
}
watch(() => pod.value?.name, () => { debugContainers.value = [] })   // 切换 Pod 时清空本会话调试容器

// === 事件：远端按 involvedObject 过滤该 Pod 的事件；演示模式回退全量 nsEvents ===
const podEvents = computed(() => store.remoteMode ? store.eventsFor('Pod', pod.value?.name, pod.value?.namespace) : store.nsEvents)

// === 事件关联资源跳转 ===
function goToRelated(event) {
  if (!event.relatedKind || !event.relatedName) return
  const ns = event.namespace || route.params.namespace
  const k = event.relatedKind
  const name = event.relatedName
  const wl = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']
  if (k === 'Pod') router.push({ name: 'NsPodDetail', params: { namespace: ns, name } })
  else if (wl.includes(k)) router.push({ name: 'NsWorkloadDetail', params: { namespace: ns, type: k.toLowerCase(), name } })
  else if (k === 'Node') router.push(`/nodes/${name}`)
  else if (k === 'Service') router.push({ name: 'NsServiceDetail', params: { namespace: ns, name } })
  else if (k === 'Ingress') router.push({ name: 'NsIngressDetail', params: { namespace: ns, name } })
  else if (k === 'ConfigMap') router.push({ name: 'NsConfigMapDetail', params: { namespace: ns, name } })
  else if (k === 'Secret') router.push({ name: 'NsSecretDetail', params: { namespace: ns, name } })
}

// === 文件浏览器（kubectl cp 语义，基于 exec 的 ls / cat / 写入）===
// 远端模式调用网关 exec 落地真实容器文件；演示数据模式回退到 fakeFs。
const fakeFs = {
  '/': [{ n: 'app', t: 'dir' }, { n: 'etc', t: 'dir' }, { n: 'var', t: 'dir' }, { n: 'tmp', t: 'dir' }],
  '/app': [{ n: 'src', t: 'dir' }, { n: 'config', t: 'dir' }, { n: 'node_modules', t: 'dir' }, { n: 'package.json', t: 'file', s: '1.2 KB', m: '12d ago' }, { n: 'Dockerfile', t: 'file', s: '420 B', m: '45d ago' }, { n: '.env', t: 'file', s: '128 B', m: '5d ago' }],
  '/app/src': [{ n: 'index.js', t: 'file', s: '3.4 KB', m: '2d ago' }, { n: 'router.js', t: 'file', s: '1.8 KB', m: '5d ago' }, { n: 'app.js', t: 'file', s: '2.1 KB', m: '3d ago' }],
  '/app/config': [{ n: 'default.json', t: 'file', s: '640 B', m: '12d ago' }, { n: 'production.json', t: 'file', s: '512 B', m: '8d ago' }],
  '/etc': [{ n: 'hosts', t: 'file', s: '180 B', m: '45d ago' }, { n: 'resolv.conf', t: 'file', s: '92 B', m: '45d ago' }, { n: 'hostname', t: 'file', s: '24 B', m: '45d ago' }],
}
const fakeFileContent = {
  '/app/package.json': '{\n  "name": "frontend-api",\n  "version": "2.4.1",\n  "main": "src/index.js",\n  "scripts": { "start": "node src/index.js" }\n}',
  '/app/.env': 'DB_HOST=postgres-main-svc\nDB_PORT=5432\nREDIS_URL=redis://redis-svc:6379\nLOG_LEVEL=info',
  '/app/Dockerfile': 'FROM node:18-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --production\nCOPY . .\nEXPOSE 8080\nCMD ["node", "src/index.js"]',
  '/etc/hostname': pod.value?.name || 'pod',
  '/etc/resolv.conf': 'nameserver 10.96.0.1\nsearch default.svc.cluster.local',
}
const currentPath = ref('/app')
const selectedFile = ref(null)
const uploadInfo = ref('')
const fileInput = ref(null)
const fileLoading = ref(false)
const fileError = ref('')
const entries = ref([])

const currentEntries = computed(() => store.remoteMode ? entries.value.map(e => ({ n: e.name, t: e.type })) : (fakeFs[currentPath.value] || []))
const breadcrumbs_path = computed(() => {
  const parts = currentPath.value.split('/').filter(Boolean)
  return [{ n: '/', p: '/' }, ...parts.map((part, i) => ({ n: part, p: '/' + parts.slice(0, i + 1).join('/') }))]
})
function joinPath(dir, name) { return dir.endsWith('/') ? dir + name : dir + '/' + name }
async function loadDir(path) {
  currentPath.value = path
  selectedFile.value = null
  fileError.value = ''
  if (!store.remoteMode) return
  fileLoading.value = true
  try {
    const res = await podFileApi.list({ namespace: pod.value.namespace, pod: pod.value.name, container: selectedContainer.value, path })
    entries.value = (res.entries || []).slice().sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  } catch (e) {
    fileError.value = e.message || '读取目录失败'
    entries.value = []
  } finally {
    fileLoading.value = false
  }
}
function navigateTo(path) { loadDir(path) }
function goUp() {
  if (currentPath.value === '/') return
  const parts = currentPath.value.split('/').filter(Boolean)
  parts.pop()
  navigateTo(parts.length ? '/' + parts.join('/') : '/')
}
async function openEntry(entry) {
  const fp = joinPath(currentPath.value, entry.n)
  if (entry.t === 'dir') return navigateTo(fp)
  if (!store.remoteMode) {
    selectedFile.value = { name: entry.n, path: fp, content: fakeFileContent[fp] || `# ${entry.n}\n# (二进制文件或内容不可预览)`, size: entry.s }
    return
  }
  try {
    const res = await podFileApi.read({ namespace: pod.value.namespace, pod: pod.value.name, container: selectedContainer.value, path: fp })
    selectedFile.value = { name: entry.n, path: res.path, content: res.content, truncated: res.truncated, binary: res.binary }
  } catch (e) {
    notify(e.message || '读取文件失败', 'error')
  }
}
async function downloadFile() {
  if (!selectedFile.value) return
  if (!store.remoteMode) {
    const blob = new Blob([selectedFile.value.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = selectedFile.value.name; a.click(); URL.revokeObjectURL(url)
    return
  }
  try {
    const blob = await podFileApi.download({ namespace: pod.value.namespace, pod: pod.value.name, container: selectedContainer.value, path: selectedFile.value.path })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = selectedFile.value.name; a.click(); URL.revokeObjectURL(url)
  } catch (e) {
    notify(e.message || '下载失败', 'error')
  }
}
function triggerUpload() { fileInput.value?.click() }
async function onUploadPicked(e) {
  const file = e.target.files?.[0]
  if (!file) return
  const targetPath = joinPath(currentPath.value, file.name)
  if (!store.remoteMode) {
    uploadInfo.value = `已模拟上传 ${file.name} 到 ${currentPath.value}（演示环境）`
    setTimeout(() => { uploadInfo.value = '' }, 3000); e.target.value = ''; return
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    await podFileApi.write({ namespace: pod.value.namespace, pod: pod.value.name, container: selectedContainer.value, path: targetPath, data: btoa(binary) })
    uploadInfo.value = `已上传 ${file.name} → ${targetPath}（${file.size} 字节）`
    notify('上传成功', 'success')
    loadDir(currentPath.value)
  } catch (err) {
    notify(err.message || '上传失败', 'error')
  } finally {
    setTimeout(() => { uploadInfo.value = '' }, 3000); e.target.value = ''
  }
}
watch(activeTab, t => { if (t === 'files' && store.remoteMode && !entries.value.length) loadDir(currentPath.value) })
watch(selectedContainer, () => { if (activeTab.value === 'files' && store.remoteMode) loadDir(currentPath.value) })
</script>

<template>
  <div class="animate-fade-in" v-if="pod">
    <!-- Header -->
    <div class="mb-lg flex items-center justify-between">
      <div class="flex flex-col">
        <Breadcrumbs :items="[
          { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
          { label: 'Pods', route: `/ns/${route.params.namespace}/pods` },
          { label: pod.name }
        ]" />
        <div class="flex items-center gap-3 mt-2">
          <div class="w-3 h-3 rounded-full bg-primary-container animate-pulse-status"></div>
          <h2 class="text-display-lg">Pod: {{ pod.name }}</h2>
          <StatusChip :status="pod.status" />
        </div>
      </div>
      <div class="flex gap-2">
        <button v-if="store.remoteMode" @click="exportPod" title="导出真实 YAML（kubectl get -o yaml）" class="flex items-center gap-2 px-md py-2 border border-outline-variant rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">download</span>
          <span class="font-medium text-body-md">Export</span>
        </button>
        <button @click="askDelete" class="flex items-center gap-2 px-md py-2 border border-outline-variant rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-error">delete</span>
          <span class="font-medium text-body-md">Delete</span>
        </button>
        <button @click="askRestart" class="flex items-center gap-2 px-md py-2 bg-primary text-on-primary rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined">refresh</span>
          <span class="font-medium text-body-md">Restart</span>
        </button>
      </div>
    </div>

    <div class="flex-1 grid grid-cols-12 gap-gutter">
      <!-- Main Console Area -->
      <div class="col-span-12 lg:col-span-9 flex flex-col bg-surface-container-lowest rounded-xl border border-outline-variant shadow-card overflow-hidden">
        <!-- Tabs -->
        <div class="flex border-b border-outline-variant bg-surface-container-low">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            @click="activeTab = tab.key"
            class="px-xl py-4 flex items-center gap-2 border-b-2 font-medium transition-colors"
            :class="activeTab === tab.key
              ? 'border-primary text-primary font-bold'
              : 'border-transparent text-on-surface-variant hover:bg-surface-container'"
          >
            <span class="material-symbols-outlined">{{ tab.icon }}</span>
            {{ tab.label }}
          </button>
        </div>

        <!-- Logs View -->
        <div v-if="activeTab === 'logs'" class="flex-1 flex flex-col">
          <div class="bg-surface-container-highest/50 px-md py-2 flex items-center justify-between border-b border-outline-variant">
            <div class="flex flex-wrap items-center gap-md">
              <div class="flex items-center gap-xs">
                <span class="text-body-sm text-on-surface-variant font-medium">Container:</span>
                <select v-model="selectedContainer" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-sm font-mono focus:ring-2 focus:ring-primary">
                  <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
              <div class="flex items-center gap-xs">
                <span class="text-body-sm text-on-surface-variant font-medium">Lines:</span>
                <select v-model="logLines" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-sm font-mono focus:ring-2 focus:ring-primary">
                  <option v-for="n in lineOptions" :key="n" :value="n">{{ n }}</option>
                </select>
              </div>
              <div class="flex items-center gap-xs">
                <span class="text-body-sm text-on-surface-variant font-medium">Since:</span>
                <select v-model="logSince" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-sm font-mono focus:ring-2 focus:ring-primary">
                  <option v-for="o in sinceOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </div>
              <label class="flex items-center gap-1 cursor-pointer select-none" :class="logPrevious ? 'text-tertiary-container font-medium' : 'text-on-surface-variant'" title="显示上一（已终止）容器的日志，等同 --previous">
                <input v-model="logPrevious" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" />
                <span class="text-body-sm font-medium">Previous</span>
              </label>
              <div class="flex items-center gap-2">
                <input v-model="followLog" type="checkbox" :disabled="logPrevious" class="rounded text-primary focus:ring-primary h-4 w-4" />
                <span class="text-body-sm" :class="logPrevious ? 'text-on-surface-variant/50' : 'text-on-surface-variant'">Follow</span>
                <span v-if="followLog" class="flex items-center gap-xs ml-xs px-sm py-0 bg-primary-container/10 text-primary text-body-xs rounded-full" :title="store.remoteMode ? '实时流式（follow=true 经 Gateway pipe 透传）' : '模拟实时'">
                  <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-status"></span>{{ store.remoteMode ? 'LIVE · 流式' : 'LIVE' }}
                </span>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button @click="downloadLogs" title="下载日志" class="p-1 hover:bg-surface-container-low rounded"><span class="material-symbols-outlined text-body-md">download</span></button>
              <button @click="copyLogs" title="复制日志" class="p-1 hover:bg-surface-container-low rounded"><span class="material-symbols-outlined text-body-md">content_copy</span></button>
            </div>
          </div>
          <div class="flex-1 bg-[#0b1c30] p-md font-mono text-code-sm code-scroll overflow-y-auto max-h-[600px]">
            <div class="space-y-1">
              <p v-for="(log, idx) in allLogs" :key="idx" class="text-outline-variant">
                {{ log.timestamp }} <span :class="levelColor(log.level)">[{{ log.level }}]</span> {{ log.message }}
              </p>
              <div class="w-1.5 h-4 bg-primary inline-block animate-pulse ml-1 align-middle"></div>
            </div>
          </div>
        </div>

        <!-- YAML View（真实 Pod 对象只读 YAML）-->
        <div v-if="activeTab === 'yaml'" class="flex-1 p-md">
          <p v-if="yamlLoading" class="text-body-sm text-on-surface-variant">加载 YAML…</p>
          <YamlEditor v-else :model-value="podYaml" readonly height="600px" />
        </div>

        <!-- Terminal View -->
        <div v-if="activeTab === 'terminal'" class="flex-1">
          <div class="bg-surface-container-highest/50 px-md py-2 flex items-center gap-md border-b border-outline-variant">
            <div class="flex items-center gap-xs">
              <span class="text-body-sm text-on-surface-variant font-medium">Container:</span>
              <select v-model="selectedContainer" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-sm font-mono focus:ring-2 focus:ring-primary">
                <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
              </select>
            </div>
            <span class="text-body-xs text-on-surface-variant">exec 进入所选容器</span>
            <button v-if="store.remoteMode" @click="openDebug" title="注入临时调试容器（kubectl debug，用于无 shell / distroless 镜像）" class="ml-auto flex items-center gap-xs px-sm py-xs border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-low transition-colors">
              <span class="material-symbols-outlined text-body-md">bug_report</span> kubectl debug
            </button>
          </div>
          <InteractiveTerminal :pod-name="pod.name" :namespace="pod.namespace" :container="selectedContainer || 'main'" />
        </div>

        <!-- Files View（文件浏览器 / kubectl cp）-->
        <div v-if="activeTab === 'files'" class="flex-1 flex flex-col">
          <div class="bg-surface-container-highest/50 px-md py-2 flex items-center justify-between gap-md border-b border-outline-variant">
            <div class="flex items-center gap-xs text-body-sm min-w-0">
              <button @click="goUp" :disabled="currentPath === '/'" class="p-xs hover:bg-surface-container-low rounded disabled:opacity-30"><span class="material-symbols-outlined text-lg">arrow_upward</span></button>
              <span class="font-mono text-code-sm text-on-surface-variant truncate">
                <span v-for="(c, i) in breadcrumbs_path" :key="i" class="cursor-pointer hover:text-primary" @click="navigateTo(c.p)">{{ c.n === '/' ? '/' : c.n + '/' }}</span>
              </span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <div v-if="store.remoteMode" class="flex items-center gap-xs">
                <select v-model="selectedContainer" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-xs font-mono focus:ring-2 focus:ring-primary">
                  <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
                </select>
                <button @click="loadDir(currentPath)" title="刷新" class="p-1 hover:bg-surface-container-low rounded"><span class="material-symbols-outlined text-body-md">refresh</span></button>
              </div>
              <button @click="triggerUpload" title="上传文件" class="p-1 hover:bg-surface-container-low rounded"><span class="material-symbols-outlined text-body-md">upload</span></button>
              <button @click="downloadFile" :disabled="!selectedFile" title="下载文件" class="p-1 hover:bg-surface-container-low rounded disabled:opacity-30"><span class="material-symbols-outlined text-body-md">download</span></button>
            </div>
          </div>
          <input ref="fileInput" type="file" class="hidden" @change="onUploadPicked" />
          <p v-if="uploadInfo" class="px-md py-xs bg-primary-container/10 text-primary text-body-sm">{{ uploadInfo }}</p>
          <p v-if="fileError" class="px-md py-xs bg-error-container/20 text-error text-body-sm">{{ fileError }}</p>
          <div class="flex-1 grid grid-cols-12 overflow-hidden">
            <!-- 文件列表 -->
            <div class="col-span-7 border-r border-outline-variant overflow-y-auto max-h-[560px]">
              <div v-if="fileLoading" class="px-lg py-md text-body-sm text-on-surface-variant">读取中…</div>
              <div v-else>
                <div v-for="entry in currentEntries" :key="entry.n" @click="openEntry(entry)"
                  class="flex items-center gap-sm px-lg py-sm hover:bg-surface-container-low cursor-pointer border-b border-outline-variant/30">
                  <span class="material-symbols-outlined text-lg" :class="entry.t === 'dir' ? 'text-secondary' : 'text-on-surface-variant'">{{ entry.t === 'dir' ? 'folder' : 'description' }}</span>
                  <span class="flex-1 text-body-sm font-medium text-on-surface truncate">{{ entry.n }}</span>
                  <span v-if="entry.t === 'file'" class="text-body-xs text-on-surface-variant w-16 text-right">{{ entry.m }}</span>
                  <span v-else class="text-body-xs text-on-surface-variant">目录</span>
                </div>
                <p v-if="!currentEntries.length" class="px-lg py-md text-body-sm text-on-surface-variant">空目录</p>
              </div>
            </div>
            <!-- 文件预览 -->
            <div class="col-span-5 flex flex-col">
              <div v-if="selectedFile" class="flex-1 flex flex-col">
                <div class="px-md py-xs bg-surface-container-low border-b border-outline-variant flex items-center justify-between">
                  <span class="font-mono text-code-sm font-semibold text-primary truncate">{{ selectedFile.name }}</span>
                  <span class="text-body-xs text-on-surface-variant shrink-0">
                    <span v-if="selectedFile.binary">二进制</span>
                    <span v-else-if="selectedFile.truncated">已截断预览</span>
                    <span v-else>{{ selectedFile.size }}</span>
                  </span>
                </div>
                <pre class="flex-1 bg-[#1a1c1e] p-md font-mono text-code-sm text-surface-variant overflow-auto max-h-[520px] whitespace-pre">{{ selectedFile.binary ? '（二进制文件，内容不可预览，请下载查看）' : selectedFile.content }}</pre>
              </div>
              <div v-else class="flex-1 flex items-center justify-center text-on-surface-variant">
                <div class="text-center">
                  <span class="material-symbols-outlined text-4xl opacity-30">description</span>
                  <p class="text-body-sm mt-sm">选择文件查看内容</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Events View（可跳转关联资源）-->
        <div v-if="activeTab === 'events'" class="flex-1 p-lg overflow-y-auto max-h-[600px]">
          <div class="flex flex-col gap-md">
            <div v-for="(event, idx) in podEvents" :key="idx"
              class="flex gap-md border-b border-outline-variant pb-md"
              :class="event.relatedKind ? 'cursor-pointer hover:bg-surface-container-low/50 rounded-lg -mx-sm px-sm py-xs transition-colors' : ''"
              @click="goToRelated(event)">
              <div class="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                :class="event.color === 'primary' ? 'bg-primary-container text-on-primary-container' : event.color === 'error' ? 'bg-error-container text-on-error-container' : 'bg-surface-container text-on-surface-variant'">
                <span class="material-symbols-outlined text-lg">{{ event.icon }}</span>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex justify-between items-start gap-sm">
                  <h4 class="text-body-md font-semibold">{{ event.reason }}</h4>
                  <span class="font-mono text-code-sm text-on-surface-variant shrink-0">{{ event.time }}</span>
                </div>
                <p class="text-body-sm text-on-surface-variant mt-xs">{{ event.message }}</p>
                <div v-if="event.relatedKind" class="mt-xs inline-flex items-center gap-xs px-sm py-xs bg-primary-container/10 text-primary text-body-xs rounded-full">
                  <span class="material-symbols-outlined text-sm">link</span>
                  <span class="font-mono">{{ event.relatedKind }}/{{ event.relatedName }}</span>
                  <span class="material-symbols-outlined text-sm">chevron_right</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Sidebar -->
      <aside class="col-span-12 lg:col-span-3 flex flex-col gap-gutter">
        <!-- Resource Utilization -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Resource Utilization</h3>
          <div class="space-y-md">
            <ProgressBar :value="cpuPct || 0" show-label label="CPU Usage" />
            <p class="font-mono text-code-sm text-on-surface-variant -mt-2">{{ pod.cpu || '—' }}</p>
            <ProgressBar :value="memPct || 0" show-label label="Memory Usage" />
            <p class="font-mono text-code-sm text-on-surface-variant -mt-2">{{ pod.memory || '—' }}</p>
          </div>
        </div>

        <!-- Metadata -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Metadata</h3>
          <div class="space-y-lg">
            <div>
              <h4 class="text-label-caps text-on-surface-variant mb-2">LABELS</h4>
              <div class="flex flex-wrap gap-2">
                <span v-for="(val, key) in pod.labels" :key="key" class="px-2 py-1 bg-surface-container rounded text-body-sm border border-outline-variant">
                  {{ key }}: {{ val }}
                </span>
              </div>
            </div>
            <div>
              <h4 class="text-label-caps text-on-surface-variant mb-2">ANNOTATIONS</h4>
              <div class="text-body-sm bg-surface-container p-sm rounded border border-outline-variant font-mono text-code-sm text-on-surface-variant">
                <div v-for="(val, key) in pod.annotations" :key="key">{{ key }}: "{{ val }}"</div>
              </div>
            </div>
            <div>
              <h4 class="text-label-caps text-on-surface-variant mb-2">OWNER REFERENCES</h4>
              <div class="flex items-center gap-2 p-sm bg-surface-container-low rounded border border-outline-variant cursor-pointer hover:border-primary transition-colors">
                <span class="material-symbols-outlined text-primary">account_tree</span>
                <span class="text-body-sm font-medium">ReplicaSet/{{ pod.name }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Node Info -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Node Placement</h3>
          <div class="flex items-center gap-3">
            <div class="p-2 bg-secondary/10 text-secondary rounded">
              <span class="material-symbols-outlined">dns</span>
            </div>
            <div>
              <p class="text-body-md font-semibold">{{ pod.node || 'Unscheduled' }}</p>
              <p class="text-body-sm text-on-surface-variant">{{ pod.ip || 'No IP assigned' }}</p>
            </div>
          </div>
        </div>
      </aside>
    </div>

    <!-- Delete / Restart 确认 -->
    <Modal v-model="confirmOpen" :title="confirmAction?.mode === 'restart' ? '重启 Pod' : '删除 Pod'" width="max-w-lg">
      <p v-if="confirmAction?.mode === 'restart'" class="text-body-md text-on-surface">
        重启将<strong>删除该 Pod 并由所属控制器重新拉起</strong>（独立 Pod 将直接消失、不会重建）。等同 <code class="font-mono text-code-sm bg-surface-container-low px-1 rounded">kubectl delete pod</code>。
      </p>
      <p v-else class="text-body-md text-on-surface">
        确定删除 Pod <span class="font-mono text-primary">{{ pod?.name }}</span>？此操作不可撤销。
      </p>
      <template #actions>
        <button @click="confirmOpen = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
        <button @click="doConfirmed" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">
          {{ confirmAction?.mode === 'restart' ? '重启' : '删除' }}
        </button>
      </template>
    </Modal>

    <!-- 注入调试容器（kubectl debug） -->
    <Modal v-model="showDebug" title="注入调试容器 (kubectl debug)" width="max-w-xl">
      <p class="text-body-sm text-on-surface-variant mb-md">
        向该 Pod 注入一个临时容器（Ephemeral Container），用于调试 <strong>无 shell / distroless</strong> 镜像或排查网络问题。注入后可在终端选择该容器进入。需集群 K8s 1.25+。
      </p>
      <div class="grid grid-cols-2 gap-md">
        <div class="col-span-2">
          <label class="text-label-caps text-on-surface-variant block mb-xs">镜像</label>
          <input v-model="debugForm.image" list="debug-images" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="nicolaka/netshoot:latest" />
          <datalist id="debug-images">
            <option v-for="img in debugImages" :key="img" :value="img" />
          </datalist>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">容器名</label>
          <input v-model="debugForm.name" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="debugger" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">启动命令</label>
          <input v-model="debugForm.command" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="sh" />
        </div>
        <div class="col-span-2">
          <label class="text-label-caps text-on-surface-variant block mb-xs">目标容器（可选 · targetContainerName）</label>
          <select v-model="debugForm.targetContainer" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary">
            <option value="">（无）</option>
            <option v-for="c in (pod?.containers || [])" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
      </div>
      <template #actions>
        <button @click="showDebug = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
        <button @click="doAttachDebug" :disabled="debugAttaching" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-50">
          {{ debugAttaching ? '注入中…' : '注入并调试' }}
        </button>
      </template>
    </Modal>
  </div>
</template>
