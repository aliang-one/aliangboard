<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import InteractiveTerminal from '@/components/common/InteractiveTerminal.vue'
import { api } from '@/api/client'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
if (route.params.namespace) store.setNamespace(route.params.namespace)

const pod = computed(() => store.getPodByName(route.params.name, route.params.namespace))
const activeTab = ref('logs')

// 多容器 Pod：可选择查看哪个容器的日志 / exec 进哪个容器
const containers = computed(() => (pod.value?.containers?.length ? pod.value.containers : ['main']))
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
async function loadRemoteLogs() {
  if (!pod.value) return
  try {
    const container = selectedContainer.value || pod.value.containers?.[0]
    const query = new URLSearchParams({ timestamps: 'true', tailLines: '500' })
    if (container) query.set('container', container)
    const text = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(pod.value.namespace)}/pods/${encodeURIComponent(pod.value.name)}/log?${query}`)
    liveLogs.value = String(text || '').split('\n').filter(Boolean).map(line => {
      const match = line.match(/^(\S+)\s(.*)$/)
      const timestamp = match?.[1] || ''
      const message = match?.[2] || line
      const level = /\berror\b/i.test(message) ? 'ERROR' : /\bwarn(?:ing)?\b/i.test(message) ? 'WARN' : 'INFO'
      return { timestamp, level, message }
    })
  } catch (error) {
    liveLogs.value = [{ timestamp: new Date().toISOString(), level: 'ERROR', message: error.message || '日志读取失败' }]
  }
}
function startFollow() {
  stopFollow()
  if (store.remoteMode) {
    loadRemoteLogs()
    logTimer = setInterval(loadRemoteLogs, 5000)
  } else {
    logTimer = setInterval(pushLog, 1800)
  }
}
function stopFollow() {
  if (logTimer) { clearInterval(logTimer); logTimer = null }
}
watch(followLog, (v) => { v ? startFollow() : stopFollow() })
// 切换容器时，远程模式重新拉取该容器日志
watch(selectedContainer, () => { if (store.remoteMode) loadRemoteLogs() })
onMounted(() => { if (followLog.value) startFollow(); else if (store.remoteMode) loadRemoteLogs() })
onUnmounted(stopFollow)
const allLogs = computed(() => store.remoteMode ? liveLogs.value : [...store.logEntries, ...liveLogs.value])

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

// === 文件浏览器（模拟 kubectl cp）===
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

const currentEntries = computed(() => fakeFs[currentPath.value] || [])
const breadcrumbs_path = computed(() => {
  const parts = currentPath.value.split('/').filter(Boolean)
  return [{ n: '/', p: '/' }, ...parts.map((part, i) => ({ n: part, p: '/' + parts.slice(0, i + 1).join('/') }))]
})
function navigateTo(path) {
  currentPath.value = path
  selectedFile.value = null
}
function openEntry(entry) {
  if (entry.t === 'dir') {
    navigateTo(currentPath.value === '/' ? `/${entry.n}` : `${currentPath.value}/${entry.n}`)
  } else {
    const fp = currentPath.value === '/' ? `/${entry.n}` : `${currentPath.value}/${entry.n}`
    selectedFile.value = { name: entry.n, path: fp, content: fakeFileContent[fp] || `# ${entry.n}\n# (二进制文件或内容不可预览)`, size: entry.s }
  }
}
function goUp() {
  if (currentPath.value === '/') return
  const parts = currentPath.value.split('/').filter(Boolean)
  parts.pop()
  navigateTo(parts.length ? '/' + parts.join('/') : '/')
}
function downloadFile() {
  if (!selectedFile.value) return
  const blob = new Blob([selectedFile.value.content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = selectedFile.value.name
  a.click()
  URL.revokeObjectURL(url)
}
function triggerUpload() {
  uploadInfo.value = '已模拟上传文件到 ' + currentPath.value + '（演示环境，实际需后端支持）'
  setTimeout(() => { uploadInfo.value = '' }, 3000)
}
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
        <button class="flex items-center gap-2 px-md py-2 border border-outline-variant rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-error">delete</span>
          <span class="font-medium text-body-md">Delete</span>
        </button>
        <button class="flex items-center gap-2 px-md py-2 bg-primary text-on-primary rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
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
            <div class="flex items-center gap-md">
              <div class="flex items-center gap-xs">
                <span class="text-body-sm text-on-surface-variant font-medium">Container:</span>
                <select v-model="selectedContainer" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-sm font-mono focus:ring-2 focus:ring-primary">
                  <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
              <div class="flex items-center gap-2">
                <input v-model="followLog" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" />
                <span class="text-body-sm text-on-surface-variant">Follow</span>
                <span v-if="followLog" class="flex items-center gap-xs ml-xs px-sm py-0 bg-primary-container/10 text-primary text-body-xs rounded-full">
                  <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-status"></span>LIVE
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

        <!-- YAML View -->
        <div v-if="activeTab === 'yaml'" class="flex-1 grid grid-cols-2 h-full overflow-hidden">
          <div class="border-r border-outline-variant flex flex-col">
            <div class="p-2 bg-surface-container text-label-caps text-on-surface-variant text-center border-b border-outline-variant">LIVE CONFIGURATION</div>
            <div class="flex-1 bg-[#1a1c1e] p-md font-mono text-code-sm text-surface-variant overflow-auto">
              <pre>apiVersion: v1
kind: Pod
metadata:
  name: {{ pod.name }}
  namespace: {{ pod.namespace }}
  labels:
{{ Object.entries(pod.labels || {}).map(([k,v]) => `    ${k}: ${v}`).join('\n') }}
spec:
  containers:
  - name: {{ pod.containers?.[0] || 'main' }}
    image: {{ pod.image }}
    ports:
    - containerPort: 80
    resources:
      limits:
        cpu: "500m"
        memory: "512Mi"
      requests:
        cpu: "250m"
        memory: "256Mi"</pre>
            </div>
          </div>
          <div class="flex flex-col">
            <div class="p-2 bg-primary-container/10 text-label-caps text-primary text-center border-b border-outline-variant">DESIRED STATE (EDITABLE)</div>
            <div class="flex-1 bg-[#1a1c1e] p-md font-mono text-code-sm text-surface-variant overflow-auto">
              <pre>apiVersion: v1
kind: Pod
metadata:
  name: {{ pod.name }}
  namespace: {{ pod.namespace }}
  labels:
{{ Object.entries(pod.labels || {}).map(([k,v]) => `    ${k}: ${v}`).join('\n') }}
spec:
  containers:
  - name: {{ pod.containers?.[0] || 'main' }}
    image: {{ pod.image }}
    ports:
    - containerPort: 80
    resources:
      limits:
        cpu: "1000m"
        memory: "1Gi"
      requests:
        cpu: "500m"
        memory: "512Mi"</pre>
            </div>
          </div>
        </div>
        <div v-if="activeTab === 'yaml'" class="p-md bg-surface-container flex justify-end gap-md">
          <button class="px-md py-1.5 border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Discard</button>
          <button class="px-md py-1.5 bg-primary text-on-primary rounded-lg text-body-md font-semibold">Apply Changes</button>
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
          </div>
          <InteractiveTerminal :pod-name="pod.name" :namespace="pod.namespace" :container="selectedContainer || 'main'" />
        </div>

        <!-- Files View（文件浏览器 / kubectl cp）-->
        <div v-if="activeTab === 'files'" class="flex-1 flex flex-col">
          <div class="bg-surface-container-highest/50 px-md py-2 flex items-center justify-between border-b border-outline-variant">
            <div class="flex items-center gap-xs text-body-sm min-w-0">
              <button @click="goUp" :disabled="currentPath === '/'" class="p-xs hover:bg-surface-container-low rounded disabled:opacity-30"><span class="material-symbols-outlined text-lg">arrow_upward</span></button>
              <span class="font-mono text-code-sm text-on-surface-variant truncate">
                <span v-for="(c, i) in breadcrumbs_path" :key="i" class="cursor-pointer hover:text-primary" @click="navigateTo(c.p)">{{ c.n === '/' ? '/' : c.n + '/' }}</span>
              </span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button @click="triggerUpload" title="上传文件" class="p-1 hover:bg-surface-container-low rounded"><span class="material-symbols-outlined text-body-md">upload</span></button>
              <button @click="downloadFile" :disabled="!selectedFile" title="下载文件" class="p-1 hover:bg-surface-container-low rounded disabled:opacity-30"><span class="material-symbols-outlined text-body-md">download</span></button>
            </div>
          </div>
          <p v-if="uploadInfo" class="px-md py-xs bg-primary-container/10 text-primary text-body-sm">{{ uploadInfo }}</p>
          <div class="flex-1 grid grid-cols-12 overflow-hidden">
            <!-- 文件列表 -->
            <div class="col-span-7 border-r border-outline-variant overflow-y-auto max-h-[560px]">
              <div v-for="entry in currentEntries" :key="entry.n" @click="openEntry(entry)"
                class="flex items-center gap-sm px-lg py-sm hover:bg-surface-container-low cursor-pointer border-b border-outline-variant/30">
                <span class="material-symbols-outlined text-lg" :class="entry.t === 'dir' ? 'text-secondary' : 'text-on-surface-variant'">{{ entry.t === 'dir' ? 'folder' : 'description' }}</span>
                <span class="flex-1 text-body-sm font-medium text-on-surface truncate">{{ entry.n }}</span>
                <span v-if="entry.t === 'file'" class="text-body-xs text-on-surface-variant w-16 text-right">{{ entry.m }}</span>
                <span v-else class="text-body-xs text-on-surface-variant">目录</span>
              </div>
              <p v-if="!currentEntries.length" class="px-lg py-md text-body-sm text-on-surface-variant">空目录</p>
            </div>
            <!-- 文件预览 -->
            <div class="col-span-5 flex flex-col">
              <div v-if="selectedFile" class="flex-1 flex flex-col">
                <div class="px-md py-xs bg-surface-container-low border-b border-outline-variant flex items-center justify-between">
                  <span class="font-mono text-code-sm font-semibold text-primary truncate">{{ selectedFile.name }}</span>
                  <span class="text-body-xs text-on-surface-variant shrink-0">{{ selectedFile.size }}</span>
                </div>
                <pre class="flex-1 bg-[#1a1c1e] p-md font-mono text-code-sm text-surface-variant overflow-auto max-h-[520px] whitespace-pre">{{ selectedFile.content }}</pre>
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
            <div v-for="(event, idx) in store.eventList" :key="idx"
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
            <ProgressBar :value="25" show-label label="CPU Usage" />
            <p class="font-mono text-code-sm text-on-surface-variant -mt-2">{{ pod.cpu }}</p>
            <ProgressBar :value="35" show-label label="Memory Usage" />
            <p class="font-mono text-code-sm text-on-surface-variant -mt-2">{{ pod.memory }}</p>
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
  </div>
</template>
