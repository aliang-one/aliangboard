<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
	import { useI18n } from 'vue-i18n'
import { dump as yamlDump } from 'js-yaml'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import ResourceTopology from '@/components/common/ResourceTopology.vue'
import FileBrowserBody from '@/components/common/FileBrowserBody.vue'
import InteractiveTerminal from '@/components/common/InteractiveTerminal.vue'
import LogViewerBody from '@/components/common/LogViewerBody.vue'
import LabelChips from '@/components/common/LabelChips.vue'
import AnnotationList from '@/components/common/AnnotationList.vue'
import EventList from '@/components/common/EventList.vue'
import { podDebugApi, exportYaml } from '@/api/client'
import { notify } from '@/composables/useToast'
import { dumpResourceYaml } from '@/composables/useYaml'
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'

const { t } = useI18n()
	const route = useRoute()
const router = useRouter()
const store = useClusterStore()
if (route.params.namespace) store.setNamespace(route.params.namespace)

// 主资源走 Vue Query（单资源 + 15s 轮询）；pod = query 优先、store 兜底（首屏 query 未就绪时用 hydrate 值，避免闪空）。
const cid = computed(() => (store.currentCluster || 'cluster'))
const podDetail = useResourceDetail({
  key: ['cluster', cid, 'pods', route.params.name],
  fetcher: () => store.fetchPod(route.params.name, route.params.namespace),
  options: { refetchInterval: 15000 },
})
const pod = computed(() => podDetail.data.value)
const activeTab = ref('logs')

// 归属 workload 查询（Vue Query；用于 owning-workload 计算属性中 ReplicaSet → Deployment 的前缀匹配）
const workloadsQuery = useResourceList({
  key: ['cluster', cid, 'workloads'],
  fetcher: () => store.fetchWorkloads(),
  options: { refetchInterval: 30000 },
})
// 事件查询（Vue Query；podEvents 计算属性按 involvedObject 过滤该 Pod 的事件）
const eventsQuery = useResourceList({
  key: ['cluster', cid, 'events'],
  fetcher: () => store.fetchEvents(),
  options: { refetchInterval: 30000 },
})

// 支持 hash 直达 tab：PodCard 等快速入口跳转到 PodDetail 时带 #terminal/#files/#exec/#logs
const HASH_TAB = { '#logs': 'logs', '#log': 'logs', '#files': 'files', '#file': 'files', '#terminal': 'terminal', '#exec': 'terminal', '#term': 'terminal', '#yaml': 'yaml', '#events': 'events', '#event': 'events' }
watch(() => route.hash, h => { const t = HASH_TAB[(h || '').toLowerCase()]; if (t) activeTab.value = t }, { immediate: true })

// 多容器 Pod：可选择查看哪个容器的日志 / exec 进哪个容器（含本会话注入的调试容器）
const debugContainers = ref([])
const containers = computed(() => {
  const base = pod.value?.containers?.length ? pod.value.containers : ['main']
  return [...new Set([...base, ...debugContainers.value])]
})
const termMode = ref('exec')
const selectedContainer = ref('')
watch(pod, (p) => { if (p && !selectedContainer.value) selectedContainer.value = (p.containers?.[0] || 'main') }, { immediate: true })

const tabs = computed(() => [
  { key: 'logs', label: t('podDetail.tabLogs'), icon: 'terminal' },
  { key: 'files', label: t('podDetail.tabFiles'), icon: 'folder' },
  { key: 'yaml', label: 'YAML', icon: 'description' },
  { key: 'terminal', label: t('podDetail.tabTerminal'), icon: 'keyboard' },
  { key: 'events', label: t('podDetail.tabEvents'), icon: 'event_note' },
])

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
    notify('success', t('podDetail.exportSuccess'))
  } catch (e) { notify('error', e.message || t('podDetail.exportFailed')) }
}
async function doConfirmed() {
  const mode = confirmAction.value?.mode
  confirmAction.value = null
  if (!pod.value) return
  try {
    await store.deletePod(pod.value.name, pod.value.namespace)
    // 重启语义：删除该 Pod，由所属控制器重新拉起（独立 Pod 不会重建）
    notify('success', mode === 'restart' ? t('podDetail.restartSuccess') : t('podDetail.deleteSuccess'))
    router.push(`/ns/${route.params.namespace}/pods`)
  } catch (e) {
    notify('error', e.message || t('podDetail.deleteFailed'))
  }
}

const podYaml = ref('')
const yamlLoading = ref(false)
async function loadYaml() {
  if (!pod.value) return
  yamlLoading.value = true
  try {
    // pod.raw 已是完整 server 对象（mapPod 携带），无需再 api.k8s 拉取第二遍
    podYaml.value = dumpResourceYaml(pod.value?.raw)
  } catch (e) {
    podYaml.value = `# ${t('podDetail.loadFailed')}: ${e.message || ''}`
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
    selectedContainer.value = debugForm.value.name   // t('podDetail.terminalContainerSwitchToDebug')
    showDebug.value = false
    activeTab.value = 'terminal'
    notify('success', t('podDetail.debugSuccess', { name: debugForm.value.name }))
  } catch (e) {
    notify('error', e.message || t('podDetail.debugFailed'))
  } finally {
    debugAttaching.value = false
  }
}
watch(() => pod.value?.name, () => { debugContainers.value = [] })   // t('podDetail.clearSessionDebugContainers') when switching Pod

// === 事件：按 involvedObject 过滤该 Pod 的事件（远端/演示均从 Vue Query 缓存取，统一数据源）===
const podEvents = computed(() => (eventsQuery.data.value || []).filter(e => e.relatedKind === 'Pod' && e.relatedName === pod.value?.name && e.relatedNamespace === pod.value?.namespace))

// === 所属工作负载：pod → ownerReferences（Deployment 通常经 ReplicaSet 间接拥有）===
const owningWorkload = computed(() => {
  const raw = pod.value?.raw
  const refs = raw?.metadata?.ownerReferences || []
  const ctrl = refs.find(r => r.controller) || refs[0]
  if (!ctrl) return null
  const ns = raw?.metadata?.namespace || route.params.namespace
  const WL = { Deployment: 'deployment', StatefulSet: 'statefulset', DaemonSet: 'daemonset', Job: 'job', CronJob: 'cronjob' }
  if (WL[ctrl.kind]) return { kind: ctrl.kind, type: WL[ctrl.kind], name: ctrl.name, ns }
  if (ctrl.kind === 'ReplicaSet') {
    // ReplicaSet 名 = <deployment>-<templatehash>；在已加载的工作负载里找最长前缀匹配的 Deployment
    const rs = ctrl.name
    const deps = (workloadsQuery.data.value || []).filter(w => w.namespace === ns && w.type === 'Deployment' && (rs === w.name || rs.startsWith(w.name + '-')))
    if (deps.length) {
      const best = deps.reduce((a, b) => (b.name.length > a.name.length ? b : a))
      return { kind: 'Deployment', type: 'deployment', name: best.name, ns }
    }
  }
  return null
})
function goToWorkload() {
  const o = owningWorkload.value
  if (!o) return
  router.push({ name: 'NsWorkloadDetail', params: { namespace: o.ns, type: o.type, name: o.name } })
}

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

// === 文件浏览器：内嵌到 Files 标签（复用 FileBrowserBody，不走弹窗） ===
const fbContainer = computed(() => selectedContainer.value || containers.value?.[0] || '')
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
          <h2 class="text-display-lg">{{ $t('podDetail.pod', { name: pod.name }) }}</h2>
          <StatusChip :status="pod.status" />
        </div>
      </div>
      <div class="flex gap-2">
        <button v-if="owningWorkload" @click="goToWorkload" :title="$t('podDetail.jumpToWorkload', { kind: owningWorkload.kind, name: owningWorkload.name })" class="flex items-center gap-2 px-md py-2 border border-primary/40 text-primary rounded-lg hover:bg-primary/10 transition-colors">
          <span class="material-symbols-outlined">workspaces</span>
          <span class="font-medium text-body-md">{{ owningWorkload.kind }}</span>
          <span class="material-symbols-outlined text-base">arrow_forward</span>
        </button>
        <button @click="exportPod" :title="$t('podDetail.exportRealYaml')" class="flex items-center gap-2 px-md py-2 border border-outline-variant rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">download</span>
          <span class="font-medium text-body-md">{{ $t('common.export') }}</span>
        </button>
        <button @click="askDelete" class="flex items-center gap-2 px-md py-2 border border-outline-variant rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-error">delete</span>
          <span class="font-medium text-body-md">{{ $t('common.delete') }}</span>
        </button>
        <button @click="askRestart" class="flex items-center gap-2 px-md py-2 bg-primary text-on-primary rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined">refresh</span>
          <span class="font-medium text-body-md">{{ $t('common.restart') }}</span>
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

        <!-- Logs View（共享 LogViewerBody：与 LogPopup 新标签页同源）-->
        <div v-if="activeTab === 'logs'" class="flex-1 flex flex-col min-h-0">
          <LogViewerBody :namespace="pod.namespace" :pod-name="pod.name" :containers="containers" v-model:container="selectedContainer" class="flex-1 min-h-0" />
        </div>

        <!-- YAML View（真实 Pod 对象只读 YAML）-->
        <div v-if="activeTab === 'yaml'" class="flex-1 p-md">
          <p v-if="yamlLoading" class="text-body-sm text-on-surface-variant">{{ $t('podDetail.loadingYaml') }}...</p>
          <YamlEditor v-else :model-value="podYaml" readonly height="600px" />
        </div>

        <!-- Terminal View（内嵌，auto-connect） -->
        <div v-if="activeTab === 'terminal'" class="flex-1 flex flex-col min-h-0">
          <div class="bg-surface-container-highest/50 px-md py-2 flex items-center gap-md border-b border-outline-variant shrink-0">
            <div class="flex items-center gap-xs">
              <span class="text-body-sm text-on-surface-variant font-medium">{{ $t('podDetail.container') }}</span>
              <select v-model="selectedContainer" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-sm font-mono focus:ring-2 focus:ring-primary">
                <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
              </select>
            </div>
            <span class="text-xs text-on-surface-variant">{{ termMode === 'attach' ? $t('podDetail.attachModeDesc') : $t('podDetail.execModeDesc') }}</span>
            <div class="flex items-center gap-xs">
              <button @click="termMode = 'exec'" :class="termMode === 'exec' ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface-variant border-outline-variant'" class="px-sm py-xs rounded-lg text-xs font-medium border transition-colors">Exec</button>
              <button @click="termMode = 'attach'" :class="termMode === 'attach' ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface-variant border-outline-variant'" class="px-sm py-xs rounded-lg text-xs font-medium border transition-colors" :title="$t('podDetail.attachModeTitle')">Attach</button>
            </div>
            <button @click="openDebug" :title="$t('podDetail.injectDebugContainer')" class="ml-auto flex items-center gap-xs px-sm py-xs border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-low transition-colors">
              <span class="material-symbols-outlined text-body-md">bug_report</span> kubectl debug
            </button>
          </div>
          <div class="flex-1 min-h-0">
            <InteractiveTerminal class="h-full" :pod-name="pod.name" :namespace="pod.namespace" :container="selectedContainer || 'main'" :attach="termMode === 'attach'" :auto-connect="true" />
          </div>
        </div>

        <!-- Files View（文件浏览器 / kubectl cp）-->
        <div v-if="activeTab === 'files'" class="flex-1 min-h-0 flex flex-col">
          <!-- 容器选择（多容器时可切换浏览哪个容器的文件系统） -->
          <div v-if="containers.length > 1" class="flex items-center gap-sm pb-sm shrink-0">
            <span class="text-body-xs text-on-surface-variant">{{ $t('podDetail.container') }}</span>
            <select v-model="selectedContainer" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-0.5 text-body-xs font-mono focus:ring-2 focus:ring-primary">
              <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
          <!-- 文件浏览（内嵌，不走弹窗） -->
          <div class="flex-1 min-h-0">
            <FileBrowserBody :namespace="pod.namespace" :pod="pod.name" :container="fbContainer" />
          </div>
        </div>

        <!-- Events View（可跳转关联资源）-->
        <div v-if="activeTab === 'events'" class="flex-1 p-lg overflow-y-auto max-h-[600px]">
          <EventList :events="podEvents" @navigate="goToRelated" />
        </div>
      </div>

      <!-- Sidebar -->
      <aside class="col-span-12 lg:col-span-3 flex flex-col gap-gutter">
        <!-- Resource Utilization -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">{{ $t('podDetail.resourceUtilization') }}</h3>
          <div class="space-y-md">
            <ProgressBar :value="cpuPct || 0" show-label :label="$t('podDetail.cpuUsage')" />
            <p class="font-mono text-code-sm text-on-surface-variant -mt-2">{{ pod.cpu || '—' }}</p>
            <ProgressBar :value="memPct || 0" show-label :label="$t('podDetail.memoryUsage')" />
            <p class="font-mono text-code-sm text-on-surface-variant -mt-2">{{ pod.memory || '—' }}</p>
          </div>
        </div>

        <!-- Metadata -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">{{ $t('podDetail.metadata') }}</h3>
          <div class="space-y-lg">
            <div>
              <h4 class="text-label-caps text-on-surface-variant mb-2">{{ $t('podDetail.labels') }}</h4>
              <LabelChips :labels="pod.labels || {}" />
            </div>
            <div>
              <h4 class="text-label-caps text-on-surface-variant mb-2">{{ $t('podDetail.annotations') }}</h4>
              <AnnotationList :annotations="pod.annotations || {}" />
            </div>
            <div>
              <h4 class="text-label-caps text-on-surface-variant mb-2">{{ $t('podDetail.ownerReferences') }}</h4>
              <ResourceTopology :namespace="pod.namespace" kind="Pod" :name="pod.name" api-version="v1" />
            </div>
          </div>
        </div>

        <!-- Node Info -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">{{ $t('podDetail.nodePlacement') }}</h3>
          <div class="flex items-center gap-3">
            <div class="p-2 bg-secondary/10 text-secondary rounded">
              <span class="material-symbols-outlined">dns</span>
            </div>
            <div>
              <p class="text-body-md font-semibold">{{ pod.node || $t('podDetail.unscheduled') }}</p>
              <p class="text-body-sm text-on-surface-variant">{{ pod.ip || $t('podDetail.noIpAssigned') }}</p>
            </div>
          </div>
        </div>
      </aside>
    </div>

    <!-- Delete / Restart 确认 -->
    <Modal v-model="confirmOpen" :title="confirmAction?.mode === 'restart' ? $t('podDetail.restartPod') : $t('podDetail.deletePod')" width="max-w-lg">
      <p v-if="confirmAction?.mode === 'restart'" class="text-body-md text-on-surface" v-html="$t('podDetail.restartConfirm')"></p>
      <p v-else class="text-body-md text-on-surface" v-html="$t('podDetail.deleteConfirm', { name: pod?.name })"></p>
      <template #actions>
        <button @click="confirmOpen = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
        <button @click="doConfirmed" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">
          {{ confirmAction?.mode === 'restart' ? $t('podDetail.restartButton') : $t('podDetail.deleteButton') }}
        </button>
      </template>
    </Modal>

    <!-- 注入调试容器（kubectl debug） -->
    <Modal v-model="showDebug" :title="$t('podDetail.injectDebugContainer')" width="max-w-xl">
      <p class="text-body-sm text-on-surface-variant mb-md" v-html="$t('podDetail.injectDebugDesc')"></p>
      <div class="grid grid-cols-2 gap-md">
        <div class="col-span-2">
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('podDetail.imageLabel') }}</label>
          <input v-model="debugForm.image" list="debug-images" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="nicolaka/netshoot:latest" />
          <datalist id="debug-images">
            <option v-for="img in debugImages" :key="img" :value="img" />
          </datalist>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('podDetail.containerNameLabel') }}</label>
          <input v-model="debugForm.name" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="debugger" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('podDetail.commandLabel') }}</label>
          <input v-model="debugForm.command" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="sh" />
        </div>
        <div class="col-span-2">
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('podDetail.targetContainerLabel') }}</label>
          <select v-model="debugForm.targetContainer" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary">
            <option value="">{{ $t('podDetail.targetContainerEmpty') }}</option>
            <option v-for="c in (pod?.containers || [])" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
      </div>
      <template #actions>
        <button @click="showDebug = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
        <button @click="doAttachDebug" :disabled="debugAttaching" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-50">
          {{ debugAttaching ? $t('podDetail.injecting') : $t('podDetail.injectAndDebug') }}
        </button>
      </template>
    </Modal>
  </div>
</template>
