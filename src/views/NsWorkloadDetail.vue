<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { cronJobApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import { useResourceApply } from '@/composables/useResourceApply'
import { TIER_OPTIONS } from '@/composables/useLayering'
import { useMetricsHistory, toMilli, toMi } from '@/composables/useMetricsHistory'
import { readMeta } from '@/composables/useBusinessMeta'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import MiniChart from '@/components/common/MiniChart.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const workload = computed(() => store.getWorkloadByName(route.params.name, route.params.namespace))
// 业务元数据（aliangboard.io/* 标签体系：title/description/owner/version/tags 等）
const meta = computed(() => readMeta(workload.value))

// === 网络暴露关系：Deployment → Service → Ingress ===
const containerPorts = computed(() => {
  const out = []
  for (const c of (containers.value || [])) for (const p of (c.ports || [])) out.push({ container: c.name, port: p.containerPort, name: p.name, protocol: p.protocol || 'TCP' })
  return out
})
// Pod 标签 = Service selector 的匹配对象（优先 pod template labels，回退 metadata labels）
const podLabels = computed(() => workload.value?.raw?.spec?.template?.metadata?.labels || workload.value?.labels || {})
const relatedServices = computed(() => {
  const ns = route.params.namespace
  const sel = podLabels.value
  return (store.serviceList || []).filter(s => s.namespace === ns && s.selector && Object.keys(s.selector).length && Object.entries(s.selector).every(([k, v]) => sel[k] === v))
})
const relatedServiceNames = computed(() => new Set(relatedServices.value.map(s => s.name)))
const relatedIngresses = computed(() => {
  const ns = route.params.namespace
  return (store.ingressList || []).filter(ing => ing.namespace === ns && (ing.rules || []).some(r => (r.http?.paths || []).some(p => {
    const be = p.backend?.service || p.backend
    return relatedServiceNames.value.has(be?.name)
  })))
})
// 暴露 Service（selector 自动 = podLabels）
const showExposeModal = ref(false)
const exposeForm = ref({ name: '', type: 'ClusterIP', ports: [] })
function openExpose() {
  const base = workload.value?.name || 'app'
  exposeForm.value = { name: `${base}-svc`, type: 'ClusterIP', ports: containerPorts.value.length ? containerPorts.value.map(p => ({ port: p.port, targetPort: p.port, protocol: p.protocol })) : [{ port: 80, targetPort: 8080, protocol: 'TCP' }] }
  showExposeModal.value = true
}
async function saveExpose() {
  try {
    await store.addService({
      name: exposeForm.value.name, namespace: route.params.namespace, type: exposeForm.value.type, clusterIP: '',
      ports: exposeForm.value.ports.filter(p => p.port).map(p => `${p.port}:${p.targetPort}/${p.protocol}`).join(','),
      selector: { ...podLabels.value },
    })
    notify('success', `已创建 Service ${exposeForm.value.name}`); showExposeModal.value = false
  } catch (e) { notify('error', e.message || '创建 Service 失败') }
}
// 加 Ingress 映射（host/path → service:port）
const showIngressMapModal = ref(false)
const ingressMapForm = ref({ host: '', path: '/', pathType: 'Prefix', serviceName: '', servicePort: '' })
function openIngressMap() {
  const svc = relatedServices.value[0]
  const firstPort = svc?.ports?.split(',')[0]?.split(':')[0] || '80'
  ingressMapForm.value = { host: '', path: '/', pathType: 'Prefix', serviceName: svc?.name || '', servicePort: firstPort }
  showIngressMapModal.value = true
}
async function saveIngressMap() {
  const f = ingressMapForm.value
  if (!f.serviceName) { notify('error', '请选择目标 Service'); return }
  try {
    await store.addIngress({
      name: `${workload.value?.name || 'app'}-ingress`, namespace: route.params.namespace, className: '', tls: false, tlsSecret: '',
      rules: [{ host: f.host, path: f.path, pathType: f.pathType, serviceName: f.serviceName, servicePort: Number(f.servicePort) || 80 }],
    })
    notify('success', `已创建 Ingress ${f.host || '*'}${f.path} → ${f.serviceName}:${f.servicePort}`); showIngressMapModal.value = false
  } catch (e) { notify('error', e.message || '创建 Ingress 失败') }
}
const managedPods = computed(() => store.getWorkloadPods(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('deployment', workload.value))

// 该 Workload 引用的 ConfigMap / Secret（正向依赖）
const configRefs = computed(() => store.getWorkloadReferences(route.params.name, route.params.namespace))

const refTypeMeta = {
  envFrom: { label: 'EnvFrom', icon: 'code' },
  env: { label: 'Env', icon: 'terminal' },
  volume: { label: 'Volume', icon: 'folder' },
  imagePullSecrets: { label: 'Image Pull', icon: 'key' },
}
function refRoute(ref) {
  if (ref.kind === 'ConfigMap') return { name: 'NsConfigMapDetail', query: {} }
  return { name: 'NsSecretDetail', query: {} }
}

// 真实容器定义：从 live 对象的 pod template 取（Deploy/STS/DS/Job 用 .spec.template，
// CronJob 用 .spec.jobTemplate.spec.template）。不再硬编码端口/资源。
const containers = computed(() => {
  const raw = workload.value?.raw
  if (!raw) return []
  const spec = raw.spec || {}
  const tpl = spec.template || spec.jobTemplate?.spec?.template
  return tpl?.spec?.containers || []
})
function fmtPorts(c) {
  const ports = c?.ports || []
  if (!ports.length) return '—'
  return ports.map(p => `${p.containerPort}${p.name ? '/' + p.name : ''}/${p.protocol || 'TCP'}`).join(', ')
}
function fmtResources(resources) {
  const q = resources?.requests, l = resources?.limits
  const cpu = [q?.cpu, l?.cpu].filter(Boolean).join('-')
  const mem = [q?.memory, l?.memory].filter(Boolean).join('-')
  if (!cpu && !mem) return '—'
  return [cpu && `cpu ${cpu}`, mem && `mem ${mem}`].filter(Boolean).join('  ·  ')
}

// === 运行指标（实时 CPU/内存，metrics.k8s.io 每 5s 采样，滚动 ~2.5 分钟） ===
const nsRef = computed(() => route.params.namespace)
const managedPodNames = computed(() => (managedPods.value || []).map(p => p.name))
const { cpuSeries, memSeries, current: metricsNow, available: metricsAvailable, start: startMetrics } = useMetricsHistory(nsRef, managedPodNames)
onMounted(() => { if (store.remoteMode) startMetrics() })

// 容器 requests/limits 合计（作为曲线参考线）
function sumRes(field, kind) {
  const parse = kind === 'cpu' ? toMilli : toMi
  return (containers.value || []).reduce((t, c) => t + parse(c.resources?.[field]?.[kind]), 0)
}
const cpuReq = computed(() => sumRes('requests', 'cpu'))
const cpuLim = computed(() => sumRes('limits', 'cpu'))
const memReq = computed(() => sumRes('requests', 'memory'))
const memLim = computed(() => sumRes('limits', 'memory'))
const cpuRefLines = computed(() => {
  const r = []
  if (cpuReq.value) r.push({ label: 'requests', value: cpuReq.value, color: 'var(--md-sys-color-secondary)' })
  if (cpuLim.value) r.push({ label: 'limits', value: cpuLim.value, color: 'var(--md-sys-color-error)' })
  return r
})
const memRefLines = computed(() => {
  const r = []
  if (memReq.value) r.push({ label: 'requests', value: memReq.value, color: 'var(--md-sys-color-secondary)' })
  if (memLim.value) r.push({ label: 'limits', value: memLim.value, color: 'var(--md-sys-color-error)' })
  return r
})

const activeTab = ref('overview')
const showDeleteModal = ref(false)
const showScaleModal = ref(false)
const scaleReplicas = ref(1)
const showEditModal = ref(false)
const editForm = ref({})

// 仅 Deployment / StatefulSet 可按 replicas 扩缩容；DaemonSet 按节点调度，Job/CronJob 为批处理
const isScalable = computed(() => ['Deployment', 'StatefulSet'].includes(workload.value?.type))
const replicasLabel = computed(() => {
  const t = workload.value?.type
  if (t === 'DaemonSet') return 'SCHEDULED'
  if (t === 'Job') return 'COMPLETIONS'
  if (t === 'CronJob') return 'ACTIVE'
  return 'REPLICAS'
})
const isCronJob = computed(() => workload.value?.type === 'CronJob')
// 仅 Deployment/StatefulSet/DaemonSet 支持 rollout 历史与回滚
const isRolloutType = computed(() => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(workload.value?.type))
const revisions = computed(() => workload.value?.revisions || [])

const showRollbackModal = ref(false)
const rollbackTarget = ref(null)
function confirmRollback(rev) {
  rollbackTarget.value = rev
  showRollbackModal.value = true
}
async function handleRollback() {
  if (rollbackTarget.value == null) return
  try {
    await store.rollbackWorkload(route.params.name, route.params.namespace, rollbackTarget.value)
    showRollbackModal.value = false
    rollbackTarget.value = null
  } catch (e) {
    notify('error', e.message || '回滚失败')
  }
}

const tierOptions = TIER_OPTIONS

async function handleDelete() {
  await store.deleteWorkload(route.params.name, route.params.namespace)
  router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })
}

function handleRestart() {
  store.restartWorkload(route.params.name, route.params.namespace)
}

// CronJob 手动触发（kubectl create job --from）
const triggering = ref(false)
async function triggerCron() {
  triggering.value = true
  try {
    const res = await cronJobApi.trigger({ namespace: route.params.namespace, name: route.params.name })
    notify('success', `已触发 Job：${res.job || route.params.name}`)
  } catch (e) {
    notify('error', e.message || '触发失败')
  } finally {
    triggering.value = false
  }
}

function openScale() {
  if (!workload.value) return
  scaleReplicas.value = parseInt(workload.value.replicas?.split('/')[1] || '1')
  showScaleModal.value = true
}

function handleScale() {
  store.scaleWorkload(route.params.name, route.params.namespace, scaleReplicas.value)
  showScaleModal.value = false
}

function openEdit() {
  if (!workload.value) return
  // 容器级参数从 pod template 的首个容器读取（env/resources/probes）
  const c0 = workload.value?.raw?.spec?.template?.spec?.containers?.[0]
    || workload.value?.raw?.spec?.jobTemplate?.spec?.template?.spec?.containers?.[0]
    || {}
  const probe = (p, d) => ({ enabled: !!p, path: p?.httpGet?.path ?? d, port: p?.httpGet?.port ?? d })
  editForm.value = {
    image: workload.value.image,
    replicas: workload.value.replicas?.split('/')[1] || '1',
    schedule: workload.value.schedule || '',
    labels: { ...workload.value.labels },
    tier: workload.value.tier || 'default',
    env: (c0.env || []).filter(e => e.value !== undefined && e.valueFrom === undefined).map(e => ({ key: e.name, value: e.value })),
    cpuReq: c0.resources?.requests?.cpu || '',
    cpuLim: c0.resources?.limits?.cpu || '',
    memReq: c0.resources?.requests?.memory || '',
    memLim: c0.resources?.limits?.memory || '',
    livenessEnabled: !!c0.livenessProbe,
    livenessPath: c0.livenessProbe?.httpGet?.path ?? '/health',
    livenessPort: c0.livenessProbe?.httpGet?.port ?? 8080,
    readinessEnabled: !!c0.readinessProbe,
    readinessPath: c0.readinessProbe?.httpGet?.path ?? '/ready',
    readinessPort: c0.readinessProbe?.httpGet?.port ?? 8080,
    ports: (c0.ports || []).map(p => ({ containerPort: p.containerPort, protocol: p.protocol || 'TCP' })),
  }
  showEditModal.value = true
}

async function saveEdit() {
  // tier 由 store 统一写成 layer.aliangboard.io label（权威），此处不重复注入 labels.tier
  const labels = { ...(editForm.value.labels || {}) }
  const updates = {
    image: editForm.value.image,
    tier: editForm.value.tier,
    labels,
  }
  // 仅可扩缩容的类型才回写 replicas，避免覆盖 DaemonSet/Job 的调度或完成状态
  if (isScalable.value) {
    updates.replicas = `${editForm.value.replicas}/${editForm.value.replicas}`
  }
  // CronJob 的 schedule 可编辑
  if (isCronJob.value) {
    updates.schedule = editForm.value.schedule
  }
  store.updateWorkload(route.params.name, route.params.namespace, updates)

  // 容器级结构化编辑（env/resources/probes）：取当前 template 全量克隆后改 containers[0]，经 applyWorkloadTemplate 全量回写
  // （全量替换 spec.template，故 sidecar/init/卷/调度均保留；删除项也生效）
  if (isRolloutType.value) {
    const rawTpl = workload.value?.raw?.spec?.template
    if (rawTpl) {
      const tpl = JSON.parse(JSON.stringify(rawTpl))
      const c0 = tpl.spec?.containers?.[0]
      if (c0) {
        c0.image = editForm.value.image
        c0.env = (editForm.value.env || []).filter(e => e.key).map(e => ({ name: e.key, value: String(e.value ?? '') }))
        c0.resources = {
          requests: { ...(editForm.value.cpuReq ? { cpu: editForm.value.cpuReq } : {}), ...(editForm.value.memReq ? { memory: editForm.value.memReq } : {}) },
          limits: { ...(editForm.value.cpuLim ? { cpu: editForm.value.cpuLim } : {}), ...(editForm.value.memLim ? { memory: editForm.value.memLim } : {}) },
        }
        c0.ports = (editForm.value.ports || []).filter(p => p.containerPort).map(p => ({ containerPort: Number(p.containerPort), protocol: p.protocol || 'TCP' }))
        c0.livenessProbe = editForm.value.livenessEnabled
          ? { httpGet: { path: editForm.value.livenessPath, port: Number(editForm.value.livenessPort) || 8080 } }
          : undefined
        c0.readinessProbe = editForm.value.readinessEnabled
          ? { httpGet: { path: editForm.value.readinessPath, port: Number(editForm.value.readinessPort) || 8080 } }
          : undefined
        ;['livenessProbe', 'readinessProbe'].forEach(k => { if (c0[k] === undefined) delete c0[k] })
        try {
          await store.applyWorkloadTemplate(route.params.name, route.params.namespace, tpl)
        } catch (e) {
          notify('error', e.message || '容器配置（env/resources/probes）保存失败')
        }
      }
    }
  }
  showEditModal.value = false
}

// === Pod 模板深度编辑（image/env/resources/probes/nodeSelector，远端 PATCH spec.template）===
const showTemplateModal = ref(false)
const editTpl = ref(null)                  // 深克隆的 pod template
const editEnv = ref([])                    // 简单 env（{name,value}），可编辑
const refEnv = ref([])                     // valueFrom 引用型 env（保留原样、只读展示）
const nodeSelectorEntries = ref([])        // [{key,value}]
const probeModel = ref({ liveness: mkProbe(), readiness: mkProbe() })
const origProbes = ref({})
const primary = computed(() => editTpl.value?.spec?.containers?.[0])

function mkProbe() { return { enabled: false, type: 'http', path: '/', port: '' } }
function probeFromSpec(probe) {
  if (!probe) return mkProbe()
  if (probe.httpGet) return { enabled: true, type: 'http', path: probe.httpGet.path || '/', port: probe.httpGet.port ?? '' }
  if (probe.tcpSocket) return { enabled: true, type: 'tcp', path: '/', port: probe.tcpSocket.port ?? '' }
  return { enabled: true, type: 'http', path: '/', port: '' }
}
function probeToSpec(m, original) {
  // 未勾选则保留原探针（不通过此编辑器删除，避免误丢高级字段）
  if (!m.enabled) return original
  const port = m.port === '' ? undefined : (isNaN(Number(m.port)) ? m.port : Number(m.port))
  const base = m.type === 'tcp' ? { tcpSocket: { port } } : { httpGet: { path: m.path || '/', port } }
  return { ...(original || {}), ...base }
}

function openTemplateEditor() {
  const wl = workload.value
  let tpl = wl?.raw?.spec?.template
  if (!tpl) {
    // mock 无 raw：从扁平字段合成最小模板
    tpl = { metadata: { labels: { app: wl?.name } }, spec: { nodeSelector: {}, containers: [{ name: wl?.name || 'main', image: wl?.image || '', env: [], resources: { requests: {}, limits: {} } }] } }
  }
  editTpl.value = JSON.parse(JSON.stringify(tpl))
  const spec = editTpl.value.spec
  spec.containers = spec.containers || []
  const c = spec.containers[0] || (spec.containers[0] = { name: wl?.name || 'main', image: wl?.image || '' })
  c.resources = c.resources || {}
  c.resources.requests = c.resources.requests || {}
  c.resources.limits = c.resources.limits || {}
  spec.nodeSelector = spec.nodeSelector || {}
  // env：拆分可编辑（value）与只读引用（valueFrom），避免编辑丢数据
  refEnv.value = (c.env || []).filter(e => e.valueFrom).map(e => JSON.parse(JSON.stringify(e)))
  editEnv.value = (c.env || []).filter(e => e.value !== undefined && !e.valueFrom).map(e => ({ name: e.name, value: e.value }))
  origProbes.value = { liveness: c.livenessProbe, readiness: c.readinessProbe }
  probeModel.value = { liveness: probeFromSpec(c.livenessProbe), readiness: probeFromSpec(c.readinessProbe) }
  nodeSelectorEntries.value = Object.entries(spec.nodeSelector).map(([k, v]) => ({ key: k, value: v }))
  showTemplateModal.value = true
}
function addEnv() { editEnv.value.push({ name: '', value: '' }) }
function removeEnv(i) { editEnv.value.splice(i, 1) }
function addNodeSelector() { nodeSelectorEntries.value.push({ key: '', value: '' }) }
function removeNodeSelector(i) { nodeSelectorEntries.value.splice(i, 1) }
async function saveTemplate() {
  const c = primary.value
  if (!c) return
  c.env = [...refEnv.value, ...editEnv.value.filter(e => e.name)]
  c.livenessProbe = probeToSpec(probeModel.value.liveness, origProbes.value.liveness)
  c.readinessProbe = probeToSpec(probeModel.value.readiness, origProbes.value.readiness)
  const ns = {}
  for (const e of nodeSelectorEntries.value) if (e.key) ns[e.key] = e.value
  editTpl.value.spec.nodeSelector = Object.keys(ns).length ? ns : undefined
  try {
    await store.applyWorkloadTemplate(route.params.name, route.params.namespace, JSON.parse(JSON.stringify(editTpl.value)))
    showTemplateModal.value = false
  } catch (e) {
    notify('error', e.message || '保存模板失败')
  }
}
</script>

<template>
  <div class="animate-fade-in" v-if="workload">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Workloads', route: `/ns/${route.params.namespace}/workloads` },
      { label: route.params.type, route: `/ns/${route.params.namespace}/workloads` },
      { label: workload.name }
    ]" />

    <!-- Header -->
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">apps</span>
        </div>
        <div>
          <div class="flex items-baseline gap-md flex-wrap">
            <h1 class="text-display-lg text-on-surface">{{ meta.title || workload.name }}</h1>
            <span v-if="meta.title" class="font-mono text-code-sm text-on-surface-variant">{{ workload.name }}</span>
          </div>
          <p v-if="meta.description" class="text-body-sm text-on-surface-variant mt-xs max-w-2xl">{{ meta.description }}</p>
          <div class="flex items-center gap-xs mt-xs flex-wrap">
            <span class="px-2.5 py-0.5 bg-primary-container/10 text-primary text-label-caps rounded-full font-medium">{{ workload.type }}</span>
            <StatusChip :status="workload.status" />
            <span class="text-body-sm text-on-surface-variant">Namespace: <span class="text-primary font-medium">{{ workload.namespace }}</span></span>
            <span v-if="meta.owner" class="inline-flex items-center gap-0.5 px-2 py-0.5 bg-surface-container rounded-full text-body-xs text-on-surface-variant border border-outline-variant"><span class="material-symbols-outlined text-sm">group</span>{{ meta.owner }}</span>
            <span v-if="meta.version" class="inline-flex items-center gap-0.5 px-2 py-0.5 bg-surface-container rounded-full text-body-xs text-primary border border-outline-variant"><span class="material-symbols-outlined text-sm">sell</span>{{ meta.version }}</span>
            <span v-if="meta.tags" class="inline-flex items-center gap-0.5 px-2 py-0.5 bg-surface-container rounded-full text-body-xs text-on-surface-variant border border-outline-variant"><span class="material-symbols-outlined text-sm">label</span>{{ meta.tags }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
        <button v-if="isScalable" @click="openScale" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">height</span> Scale
        </button>
        <button @click="handleRestart" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">refresh</span> Restart
        </button>
        <button v-if="isCronJob && store.remoteMode" @click="triggerCron" :disabled="triggering" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors disabled:opacity-50" title="手动触发一次（kubectl create job --from）">
          <span class="material-symbols-outlined">{{ triggering ? 'progress_activity' : 'play_arrow' }}</span> Trigger
        </button>
        <button @click="openEdit" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors">
          <span class="material-symbols-outlined">edit</span> Edit
        </button>
        <button v-if="isRolloutType" @click="openTemplateEditor" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors" title="深度编辑容器模板（image/env/resources/probes/nodeSelector），写回集群">
          <span class="material-symbols-outlined">tune</span> Edit Template
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in (isRolloutType ? ['overview', 'network', 'pods', 'revisions', 'yaml', 'events'] : ['overview', 'network', 'pods', 'yaml', 'events'])" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Overview</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">TYPE</p>
              <p class="text-body-lg font-semibold">{{ workload.type }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">NAMESPACE</p>
              <p class="text-body-lg font-semibold text-primary">{{ workload.namespace }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">IMAGE</p>
              <p class="font-mono text-code-sm text-primary">{{ workload.image }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ replicasLabel }}</p>
              <p class="text-body-lg font-semibold">{{ workload.replicas }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">AGE</p>
              <p class="text-body-lg font-semibold">{{ workload.age }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">REVISION</p>
              <p class="font-mono text-code-sm">{{ workload.sha }}</p>
            </div>
            <div v-if="isCronJob" class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">SCHEDULE</p>
              <p class="font-mono text-code-sm text-primary">{{ workload.schedule }}</p>
            </div>
          </div>
        </div>

        <!-- Container Info（真实数据，来自 pod template；多容器全展开） -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <div class="flex items-center justify-between mb-lg">
            <h3 class="text-headline-sm">Containers</h3>
            <span class="text-body-sm text-on-surface-variant">{{ containers.length }} 个容器</span>
          </div>
          <div v-if="containers.length" class="flex flex-col gap-md">
            <div v-for="(c, i) in containers" :key="i" class="flex items-center gap-md p-md bg-surface-container-low rounded-lg">
              <div class="w-10 h-10 rounded-lg bg-secondary/10 flex items-center justify-center shrink-0">
                <span class="material-symbols-outlined text-secondary">inventory_2</span>
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-body-md font-semibold truncate">{{ c.name }}</p>
                <p class="font-mono text-code-sm text-primary truncate">{{ c.image }}</p>
              </div>
              <div class="text-right shrink-0">
                <p class="text-label-caps text-on-surface-variant">Ports</p>
                <p class="font-mono text-code-xs">{{ fmtPorts(c) }}</p>
              </div>
              <div class="text-right shrink-0">
                <p class="text-label-caps text-on-surface-variant">Resources</p>
                <p class="font-mono text-code-xs">{{ fmtResources(c.resources) }}</p>
              </div>
            </div>
          </div>
          <p v-else class="text-body-sm text-on-surface-variant">该工作负载未提供容器详情（可在「YAML」标签页查看完整定义）。</p>
        </div>

        <!-- 运行指标（实时 CPU/内存占用曲线） -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <div class="flex items-center justify-between mb-lg">
            <div>
              <h3 class="text-headline-sm">运行指标</h3>
              <p class="text-body-xs text-on-surface-variant mt-xs">实时占用（metrics.k8s.io，每 5s 采样，滚动约 2.5 分钟）· 管理 {{ managedPods.length }} 个 Pod</p>
            </div>
            <span v-if="!metricsAvailable" class="text-body-xs text-error">指标不可用</span>
          </div>
          <div v-if="metricsAvailable" class="grid grid-cols-1 md:grid-cols-2 gap-lg">
            <div>
              <MiniChart :series="cpuSeries" label="CPU 用量" unit="m" color="var(--md-sys-color-primary)" :ref-lines="cpuRefLines" :height="84" />
              <p class="font-mono text-code-xs text-on-surface-variant mt-xs">当前 {{ metricsNow.cpu }}m / 请求 {{ cpuReq || '—' }}m / 上限 {{ cpuLim || '—' }}m</p>
            </div>
            <div>
              <MiniChart :series="memSeries" label="内存用量" unit="Mi" color="var(--md-sys-color-secondary)" :ref-lines="memRefLines" :height="84" />
              <p class="font-mono text-code-xs text-on-surface-variant mt-xs">当前 {{ metricsNow.mem }}Mi / 请求 {{ memReq || '—' }}Mi / 上限 {{ memLim || '—' }}Mi</p>
            </div>
          </div>
          <p v-else class="text-body-sm text-on-surface-variant py-md text-center">metrics-server 未就绪，或当前用户无 metrics 读取权限。</p>
        </div>

        <!-- Configuration Dependencies -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <div class="flex items-center justify-between mb-md">
            <h3 class="text-headline-sm">配置依赖 (ConfigMaps &amp; Secrets)</h3>
            <span class="text-body-sm text-on-surface-variant">{{ configRefs.length }} 个引用</span>
          </div>
          <div v-if="configRefs.length" class="flex flex-col gap-sm">
            <div v-for="(ref, idx) in configRefs" :key="idx"
              class="flex items-center gap-md p-md bg-surface-container-low rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
              @click="router.push({ name: refRoute(ref).name, params: { namespace: route.params.namespace, name: ref.name } })">
              <div class="w-9 h-9 rounded-lg flex items-center justify-center"
                :class="ref.kind === 'ConfigMap' ? 'bg-secondary-container/20' : 'bg-tertiary-container/20'">
                <span class="material-symbols-outlined" :class="ref.kind === 'ConfigMap' ? 'text-secondary' : 'text-tertiary'">{{ ref.kind === 'ConfigMap' ? 'description' : 'key' }}</span>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-sm">
                  <span class="font-mono text-code-sm font-semibold text-on-surface">{{ ref.name }}</span>
                  <span class="px-1.5 py-0 rounded text-label-caps" :class="ref.kind === 'ConfigMap' ? 'bg-secondary-container/10 text-secondary' : 'bg-tertiary-container/10 text-tertiary'">{{ ref.kind }}</span>
                </div>
                <p class="text-body-sm text-on-surface-variant mt-xs">
                  <span class="inline-flex items-center gap-xs px-1.5 py-0 bg-surface-container rounded text-label-caps mr-xs">
                    <span class="material-symbols-outlined text-sm">{{ (refTypeMeta[ref.type] || { icon: 'link' }).icon }}</span>{{ (refTypeMeta[ref.type] || { label: ref.type }).label }}
                  </span>
                  <span v-if="ref.type === 'volume' && ref.mountPath" class="font-mono text-code-sm text-primary">挂载到 {{ ref.mountPath }}</span>
                  <span v-else-if="ref.type === 'env' && ref.envName" class="font-mono text-code-sm">{{ ref.envName }} ← {{ ref.kind }}.{{ ref.key }}</span>
                  <span v-else-if="ref.type === 'envFrom'">所有 Key 注入为环境变量</span>
                  <span v-else-if="ref.type === 'imagePullSecrets'">拉取镜像时认证</span>
                </p>
              </div>
              <span class="material-symbols-outlined text-on-surface-variant">chevron_right</span>
            </div>
          </div>
          <div v-else class="flex items-center gap-sm p-md text-on-surface-variant opacity-70">
            <span class="material-symbols-outlined">link_off</span>
            <span class="text-body-sm">此 Workload 未引用任何 ConfigMap / Secret</span>
          </div>
        </div>
      </div>

      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Labels</h3>
          <div class="flex flex-wrap gap-2">
            <span v-for="(val, key) in (workload.labels || {})" :key="key"
              class="px-md py-xs bg-primary-container/10 text-primary text-body-sm rounded-full border border-primary/20">
              <span class="font-semibold">{{ key }}</span>: {{ val }}
            </span>
          </div>
        </div>
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Summary</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Managed Pods</span>
              <span class="text-body-md font-semibold text-primary">{{ managedPods.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Running</span>
              <span class="text-body-md font-semibold text-primary">{{ managedPods.filter(p => p.status === 'Running').length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Pending</span>
              <span class="text-body-md font-semibold">{{ managedPods.filter(p => p.status === 'Pending').length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Failed</span>
              <span class="text-body-md font-semibold text-error">{{ managedPods.filter(p => p.status === 'Failed').length }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Pods Tab -->
    <div v-if="activeTab === 'pods'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Managed Pods ({{ managedPods.length }})</h3>
        </div>
        <table v-if="managedPods.length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Restarts</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Node</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">IP</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="p in managedPods" :key="p.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } })">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">layers</span>
                  <span class="font-mono text-code-sm font-semibold text-on-surface">{{ p.name }}</span>
                </div>
              </td>
              <td class="px-lg py-md"><StatusChip :status="p.status" size="sm" /></td>
              <td class="px-lg py-md text-body-sm">{{ p.restarts }}</td>
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ p.node || '-' }}</td>
              <td class="px-lg py-md font-mono text-code-sm text-primary">{{ p.ip || '-' }}</td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ p.age }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="p-xl text-center text-on-surface-variant">
          <span class="material-symbols-outlined text-3xl">search_off</span>
          <p class="mt-sm">No managed pods found</p>
        </div>
      </div>
    </div>

    <!-- Revisions Tab（滚动发布历史 + 一键回滚）-->
    <div v-if="activeTab === 'revisions'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Revision History ({{ revisions.length }})</h3>
          <span class="text-body-sm text-on-surface-variant">kubectl rollout undo</span>
        </div>
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant w-24">Revision</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Image</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">SHA</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Reason</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant w-32"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="r in revisions" :key="r.rev" class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md">
                <span class="font-mono text-code-sm font-semibold" :class="r.current ? 'text-primary' : 'text-on-surface'">rev-{{ r.rev }}</span>
                <span v-if="r.current" class="ml-xs px-1.5 py-0 bg-primary-container/10 text-primary text-label-caps rounded">CURRENT</span>
              </td>
              <td class="px-lg py-md font-mono text-code-sm text-primary">{{ r.image }}</td>
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ r.sha }}</td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ r.reason }}</td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ r.age }}</td>
              <td class="px-lg py-md text-right">
                <button v-if="!r.current" @click="confirmRollback(r.rev)" class="flex items-center gap-xs ml-auto px-md py-xs border border-outline-variant text-on-surface rounded-lg text-body-sm font-semibold hover:bg-surface-container-high transition-colors">
                  <span class="material-symbols-outlined text-sm">undo</span> Rollback
                </button>
                <span v-else class="text-body-sm text-on-surface-variant italic">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>

    <!-- Events Tab -->
    <!-- Network Tab：Deployment → Service → Ingress 关系链 -->
    <div v-if="activeTab === 'network'" class="flex flex-col gap-lg">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <h3 class="text-headline-sm mb-md">容器端口 (containerPort)</h3>
        <div v-if="containerPorts.length" class="flex flex-wrap gap-sm">
          <span v-for="(p, i) in containerPorts" :key="i" class="font-mono text-code-sm px-md py-xs bg-surface-container-low rounded-lg border border-outline-variant">{{ p.container }}: <span class="text-primary font-semibold">{{ p.port }}</span>/{{ p.protocol }}<span v-if="p.name" class="text-on-surface-variant"> · {{ p.name }}</span></span>
        </div>
        <p v-else class="text-body-sm text-on-surface-variant">未定义容器端口（在 Edit 里添加 ports，或用 Edit Template）</p>
      </div>

      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="flex items-center justify-between px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <h3 class="text-headline-sm">关联 Service（暴露端口）</h3>
          <button @click="openExpose" class="flex items-center gap-xs px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90"><span class="material-symbols-outlined text-sm">share</span> 暴露</button>
        </div>
        <div v-if="relatedServices.length" class="divide-y divide-outline-variant/30">
          <div v-for="s in relatedServices" :key="s.name" @click="router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: s.name } })" class="flex items-center gap-md px-lg py-md hover:bg-surface-container-low/50 cursor-pointer">
            <span class="material-symbols-outlined text-primary">hub</span>
            <div class="flex-1 min-w-0"><p class="font-semibold text-on-surface truncate">{{ s.name }}</p><p class="font-mono text-code-xs text-on-surface-variant truncate">{{ s.ports }} · {{ s.clusterIP }}</p></div>
            <span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant shrink-0">{{ s.type }}</span>
            <span class="material-symbols-outlined text-on-surface-variant">chevron_right</span>
          </div>
        </div>
        <div v-else class="px-lg py-xl text-center"><span class="material-symbols-outlined text-4xl text-surface-container-high">share</span><p class="text-on-surface-variant mt-sm text-body-sm">暂无关联 Service。点「暴露」创建（selector 自动匹配本 Deployment 的 Pod 标签）。</p></div>
      </div>

      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="flex items-center justify-between px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <h3 class="text-headline-sm">关联 Ingress（外部路由）</h3>
          <button @click="openIngressMap" :disabled="!relatedServices.length" class="flex items-center gap-xs px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 disabled:opacity-40" :title="relatedServices.length ? '创建 Ingress 映射' : '先创建 Service 再映射'"><span class="material-symbols-outlined text-sm">alt_route</span> 加 Ingress 映射</button>
        </div>
        <div v-if="relatedIngresses.length" class="divide-y divide-outline-variant/30">
          <template v-for="ing in relatedIngresses" :key="ing.name">
            <div v-for="(r, ri) in (ing.rules || [])" :key="ing.name + ri" @click="router.push({ name: 'NsIngressDetail', params: { namespace: route.params.namespace, name: ing.name } })" class="flex items-center gap-md px-lg py-md hover:bg-surface-container-low/50 cursor-pointer">
              <span class="material-symbols-outlined text-primary">alt_route</span>
              <div class="flex-1 min-w-0">
                <p class="font-mono text-code-sm text-on-surface truncate"><span class="text-primary font-semibold">{{ r.host || '*' }}</span>{{ (r.http?.paths?.[0]?.path) || '/' }} <span class="text-on-surface-variant">→</span> {{ r.http?.paths?.[0]?.backend?.service?.name || r.http?.paths?.[0]?.backend?.serviceName }}:{{ r.http?.paths?.[0]?.backend?.service?.port?.number || r.http?.paths?.[0]?.backend?.servicePort }}</p>
                <p class="text-body-xs text-on-surface-variant">via Ingress <span class="font-mono">{{ ing.name }}</span>{{ ing.className ? ' · ' + ing.className : '' }}{{ ing.tls ? ' · TLS' : '' }}</p>
              </div>
              <span class="material-symbols-outlined text-on-surface-variant">chevron_right</span>
            </div>
          </template>
        </div>
        <div v-else class="px-lg py-xl text-center"><span class="material-symbols-outlined text-4xl text-surface-container-high">alt_route</span><p class="text-on-surface-variant mt-sm text-body-sm">{{ relatedServices.length ? '暂无 Ingress 路由到本服务。点「加 Ingress 映射」创建。' : '先暴露 Service，再创建 Ingress 映射。' }}</p></div>
      </div>
      <p class="text-body-xs text-on-surface-variant px-sm">链路：外部请求 → Ingress(host/path) → Service(port→targetPort) → 本 Deployment 的 Pod(containerPort)。点任一项进入详情页编辑（Ingress 详情页可编辑 rules/TLS/Class/annotations）。</p>
    </div>

    <div v-if="activeTab === 'events'" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table v-if="store.nsEvents.length" class="w-full text-left">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-14">Type</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Reason</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Message</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Time</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr v-for="(event, idx) in store.nsEvents" :key="idx" class="hover:bg-surface-container-low/50 transition-colors">
            <td class="px-lg py-md">
              <div class="w-8 h-8 rounded-full flex items-center justify-center"
                :class="{
                  'bg-primary-container text-on-primary-container': event.color === 'primary',
                  'bg-tertiary-fixed-dim text-on-tertiary-fixed': event.color === 'tertiary',
                  'bg-error-container text-on-error-container': event.color === 'error',
                  'bg-surface-container text-on-surface-variant': event.color === 'surface',
                }">
                <span class="material-symbols-outlined text-lg">{{ event.icon }}</span>
              </div>
            </td>
            <td class="px-lg py-md">
              <span class="font-semibold text-on-surface text-body-md">{{ event.reason }}</span>
              <span class="ml-sm px-2 py-0.5 rounded text-label-caps" :class="event.type === 'warning' ? 'bg-tertiary-container/10 text-tertiary-container' : 'bg-primary-container/10 text-primary'">{{ event.type }}</span>
            </td>
            <td class="px-lg py-md text-body-sm text-on-surface-variant max-w-md">{{ event.message }}</td>
            <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant whitespace-nowrap">{{ event.time }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="p-xl text-center text-on-surface-variant">
        <p>No events found for this namespace</p>
      </div>
    </div>
  </div>

  <!-- Not Found -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">Workload Not Found</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">Workload "{{ route.params.name }}" not found in namespace "{{ route.params.namespace }}"</p>
    <button @click="router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Workloads</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete Workload" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This action cannot be undone. All managed pods will be terminated.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- Scale Modal -->
  <Modal v-model="showScaleModal" title="Scale Workload" width="max-w-md">
    <p class="text-body-md text-on-surface-variant mb-md">Adjust the number of replicas for <span class="text-on-surface font-semibold">{{ route.params.name }}</span></p>
    <div class="flex items-center gap-md">
      <label class="text-label-caps text-on-surface-variant">Replicas</label>
      <input v-model.number="scaleReplicas" type="number" min="0" max="100" class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono text-center" />
    </div>
    <template #actions>
      <button @click="showScaleModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleScale" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Scale</button>
    </template>
  </Modal>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" title="Edit Workload" width="max-w-2xl">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Container Image</label>
        <input v-model="editForm.image" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" />
      </div>
      <div v-if="isScalable">
        <label class="text-label-caps text-on-surface-variant block mb-xs">Replicas</label>
        <input v-model.number="editForm.replicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
      </div>
      <div v-if="isCronJob">
        <label class="text-label-caps text-on-surface-variant block mb-xs">Schedule (Cron)</label>
        <input v-model="editForm.schedule" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="*/5 * * * *" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">服务分层 (Tier)</label>
        <div class="flex flex-wrap gap-xs">
          <button v-for="t in tierOptions" :key="t.value" @click="editForm.tier = t.value"
            class="flex items-center gap-xs px-sm py-xs rounded-lg border text-body-sm font-medium transition-all"
            :class="editForm.tier === t.value ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'">
            <span class="material-symbols-outlined text-sm">{{ t.icon }}</span>{{ t.label }}
          </button>
        </div>
      </div>
      <!-- 容器配置：env / resources / probes（仅 Deployment/StatefulSet/DaemonSet） -->
      <div v-if="isRolloutType" class="mt-md pt-md border-t border-outline-variant/50 flex flex-col gap-md">
        <p class="text-label-caps text-on-surface-variant">容器配置（资源 / 环境变量 / 探针）</p>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-sm">
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">CPU 请求</label><input v-model="editForm.cpuReq" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="250m" /></div>
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">CPU 上限</label><input v-model="editForm.cpuLim" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="500m" /></div>
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">内存请求</label><input v-model="editForm.memReq" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="256Mi" /></div>
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">内存上限</label><input v-model="editForm.memLim" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="512Mi" /></div>
        </div>
        <div>
          <div class="flex items-center justify-between mb-xs">
            <label class="text-body-xs text-on-surface-variant">容器端口 (containerPort)</label>
            <button @click="editForm.ports.push({ containerPort: '', protocol: 'TCP' })" class="text-body-xs text-primary hover:underline">+ 添加</button>
          </div>
          <div v-for="(p, i) in editForm.ports" :key="i" class="flex items-center gap-xs mb-xs">
            <input v-model.number="p.containerPort" type="number" class="w-32 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="8080" />
            <input v-model="p.protocol" class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="TCP" />
            <button @click="editForm.ports.splice(i, 1)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
        </div>
        <div>
          <div class="flex items-center justify-between mb-xs">
            <label class="text-body-xs text-on-surface-variant">环境变量</label>
            <button @click="editForm.env.push({ key: '', value: '' })" class="text-body-xs text-primary hover:underline">+ 添加</button>
          </div>
          <div v-for="(e, i) in editForm.env" :key="i" class="flex items-center gap-xs mb-xs">
            <input v-model="e.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="KEY" />
            <input v-model="e.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="value" />
            <button @click="editForm.env.splice(i, 1)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
        </div>
        <div class="flex flex-col gap-xs">
          <label class="flex items-center gap-xs text-body-sm"><input type="checkbox" v-model="editForm.livenessEnabled" class="h-4 w-4 accent-primary" /> Liveness Probe</label>
          <div v-if="editForm.livenessEnabled" class="flex items-center gap-xs pl-md">
            <input v-model="editForm.livenessPath" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="/health" />
            <input v-model.number="editForm.livenessPort" type="number" class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="8080" />
          </div>
          <label class="flex items-center gap-xs text-body-sm"><input type="checkbox" v-model="editForm.readinessEnabled" class="h-4 w-4 accent-primary" /> Readiness Probe</label>
          <div v-if="editForm.readinessEnabled" class="flex items-center gap-xs pl-md">
            <input v-model="editForm.readinessPath" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="/ready" />
            <input v-model.number="editForm.readinessPort" type="number" class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="8080" />
          </div>
        </div>
        <p class="text-body-xs text-on-surface-variant">更复杂的配置（多容器 / 卷 / 调度 / 完整探针）可用「Edit Template」全量编辑 pod 模板。</p>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Save</button>
    </template>
  </Modal>

  <!-- Rollback Modal -->
  <Modal v-model="showRollbackModal" title="Rollback Workload" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">将 <span class="text-on-surface font-semibold">{{ route.params.name }}</span> 回滚到 <span class="font-mono text-primary font-semibold">rev-{{ rollbackTarget }}</span>？</p>
    <p class="text-body-sm text-on-surface-variant mt-sm">等同于 <code class="font-mono text-code-sm bg-surface-container-low px-1 rounded">kubectl rollout undo --to-revision={{ rollbackTarget }}</code>，将触发一次新的滚动发布。</p>
    <template #actions>
      <button @click="showRollbackModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleRollback" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Rollback</button>
    </template>
  </Modal>

  <!-- Edit Pod Template Modal（深度编辑：image/env/resources/probes/nodeSelector）-->
  <Modal v-model="showTemplateModal" title="Edit Pod Template" width="max-w-3xl">
    <div v-if="primary" class="flex flex-col gap-lg">
      <p class="text-body-sm text-on-surface-variant -mt-2">编辑容器模板并写回集群（等同 <code class="font-mono text-code-sm bg-surface-container-low px-1 rounded">kubectl edit</code> 的 spec.template）。引用型 env 与探针的高级字段会原样保留。</p>

      <!-- Image -->
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Container Image</label>
        <input v-model="primary.image" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
      </div>

      <!-- Environment -->
      <div>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-label-caps text-on-surface-variant">Environment Variables</label>
          <button @click="addEnv" class="flex items-center gap-xs px-sm py-xs border border-outline-variant rounded text-body-xs text-on-surface-variant hover:bg-surface-container-low"><span class="material-symbols-outlined text-sm">add</span> Add</button>
        </div>
        <div class="flex flex-col gap-xs">
          <div v-for="(e, i) in editEnv" :key="'e'+i" class="flex items-center gap-sm">
            <input v-model="e.name" class="w-40 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="KEY" />
            <span class="text-on-surface-variant">=</span>
            <input v-model="e.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="value" />
            <button @click="removeEnv(i)" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-lg">delete</span></button>
          </div>
          <div v-if="!editEnv.length" class="text-body-xs text-on-surface-variant italic">无显式 env</div>
        </div>
        <div v-if="refEnv.length" class="mt-sm">
          <p class="text-body-xs text-on-surface-variant mb-xs">引用型 env（只读，将原样保留）：</p>
          <div class="flex flex-wrap gap-xs">
            <span v-for="(e, i) in refEnv" :key="'r'+i" class="px-sm py-xs bg-surface-container rounded text-body-xs font-mono text-on-surface-variant border border-outline-variant">{{ e.name }}</span>
          </div>
        </div>
      </div>

      <!-- Resources -->
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Resources</label>
        <div class="grid grid-cols-2 gap-md">
          <div class="p-sm bg-surface-container-low rounded-lg">
            <p class="text-body-xs text-on-surface-variant mb-xs">Requests</p>
            <div class="flex gap-sm">
              <input v-model="primary.resources.requests.cpu" class="w-full bg-surface-container border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="cpu 250m" />
              <input v-model="primary.resources.requests.memory" class="w-full bg-surface-container border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="mem 256Mi" />
            </div>
          </div>
          <div class="p-sm bg-surface-container-low rounded-lg">
            <p class="text-body-xs text-on-surface-variant mb-xs">Limits</p>
            <div class="flex gap-sm">
              <input v-model="primary.resources.limits.cpu" class="w-full bg-surface-container border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="cpu 500m" />
              <input v-model="primary.resources.limits.memory" class="w-full bg-surface-container border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="mem 512Mi" />
            </div>
          </div>
        </div>
      </div>

      <!-- Probes -->
      <div class="grid grid-cols-2 gap-md">
        <div v-for="pkey in ['liveness','readiness']" :key="pkey" class="p-sm bg-surface-container-low rounded-lg">
          <label class="flex items-center gap-sm mb-xs capitalize">
            <input type="checkbox" v-model="probeModel[pkey].enabled" class="rounded text-primary h-4 w-4" />
            <span class="text-body-sm font-medium text-on-surface">{{ pkey }} Probe</span>
          </label>
          <div v-if="probeModel[pkey].enabled" class="flex flex-col gap-xs">
            <select v-model="probeModel[pkey].type" class="bg-surface-container border border-outline-variant rounded px-sm py-1 text-body-sm">
              <option value="http">HTTP GET</option>
              <option value="tcp">TCP Socket</option>
            </select>
            <input v-if="probeModel[pkey].type === 'http'" v-model="probeModel[pkey].path" class="bg-surface-container border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="/healthz" />
            <input v-model="probeModel[pkey].port" class="bg-surface-container border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="port 8080" />
          </div>
        </div>
      </div>

      <!-- Node Selector -->
      <div>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-label-caps text-on-surface-variant">Node Selector</label>
          <button @click="addNodeSelector" class="flex items-center gap-xs px-sm py-xs border border-outline-variant rounded text-body-xs text-on-surface-variant hover:bg-surface-container-low"><span class="material-symbols-outlined text-sm">add</span> Add</button>
        </div>
        <div class="flex flex-col gap-xs">
          <div v-for="(e, i) in nodeSelectorEntries" :key="'ns'+i" class="flex items-center gap-sm">
            <input v-model="e.key" class="w-44 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="disktype" />
            <span class="text-on-surface-variant">:</span>
            <input v-model="e.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="ssd" />
            <button @click="removeNodeSelector(i)" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-lg">delete</span></button>
          </div>
          <div v-if="!nodeSelectorEntries.length" class="text-body-xs text-on-surface-variant italic">无 nodeSelector（不限定节点）</div>
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showTemplateModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveTemplate" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Apply Template</button>
    </template>
  </Modal>

  <!-- 暴露为 Service -->
  <Modal v-model="showExposeModal" title="暴露为 Service" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div class="grid grid-cols-2 gap-md">
        <div><label class="text-label-caps text-on-surface-variant block mb-xs">Service 名称</label><input v-model="exposeForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" /></div>
        <div><label class="text-label-caps text-on-surface-variant block mb-xs">类型</label><select v-model="exposeForm.type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md"><option>ClusterIP</option><option>NodePort</option><option>LoadBalancer</option></select></div>
      </div>
      <p class="text-body-xs text-on-surface-variant">Selector 自动 = 本 Deployment 的 Pod 标签（{{ Object.keys(podLabels).length }} 个）。端口映射 port:targetPort：</p>
      <div v-for="(p, i) in exposeForm.ports" :key="i" class="flex items-center gap-xs">
        <input v-model.number="p.port" type="number" class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="port" />
        <span class="text-on-surface-variant">:</span>
        <input v-model.number="p.targetPort" type="number" class="w-28 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="targetPort" />
        <input v-model="p.protocol" class="w-20 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="TCP" />
        <button @click="exposeForm.ports.splice(i, 1)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-base">close</span></button>
      </div>
      <button @click="exposeForm.ports.push({ port: '', targetPort: '', protocol: 'TCP' })" class="self-start text-body-xs text-primary hover:underline">+ 添加端口</button>
    </div>
    <template #actions>
      <button @click="showExposeModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
      <button @click="saveExpose" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">创建</button>
    </template>
  </Modal>

  <!-- 加 Ingress 映射 -->
  <Modal v-model="showIngressMapModal" title="加 Ingress 映射" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div><label class="text-label-caps text-on-surface-variant block mb-xs">Host</label><input v-model="ingressMapForm.host" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="app.example.com（留空=任意）" /></div>
      <div class="grid grid-cols-2 gap-md">
        <div><label class="text-label-caps text-on-surface-variant block mb-xs">Path</label><input v-model="ingressMapForm.path" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="/" /></div>
        <div><label class="text-label-caps text-on-surface-variant block mb-xs">Path Type</label><select v-model="ingressMapForm.pathType" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md"><option>Prefix</option><option>Exact</option><option>ImplementationSpecific</option></select></div>
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div><label class="text-label-caps text-on-surface-variant block mb-xs">目标 Service</label><select v-model="ingressMapForm.serviceName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono"><option v-for="s in relatedServices" :key="s.name" :value="s.name">{{ s.name }}</option></select></div>
        <div><label class="text-label-caps text-on-surface-variant block mb-xs">Service Port</label><input v-model="ingressMapForm.servicePort" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="80" /></div>
      </div>
      <p class="text-body-xs text-on-surface-variant">创建新 Ingress <span class="font-mono">{{ (workload?.name || 'app') + '-ingress' }}</span>，路由 {{ ingressMapForm.host || '*' }}{{ ingressMapForm.path }} → {{ ingressMapForm.serviceName || '?' }}:{{ ingressMapForm.servicePort }}。</p>
    </div>
    <template #actions>
      <button @click="showIngressMapModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
      <button @click="saveIngressMap" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">创建</button>
    </template>
  </Modal>
</template>
