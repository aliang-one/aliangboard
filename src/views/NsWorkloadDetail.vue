<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { cronJobApi, api } from '@/api/client'
import { notify } from '@/composables/useToast'
import { useResourceApply } from '@/composables/useResourceApply'
import { TIER_OPTIONS } from '@/composables/useLayering'
import { useMetricsHistory, toMilli, toMi } from '@/composables/useMetricsHistory'
import { readMeta, imageTag } from '@/composables/useBusinessMeta'
import { dump as yamlDump } from 'js-yaml'
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
const managedPods = computed(() => store.getWorkloadPods(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('deployment', workload.value))
const configRefs = computed(() => store.getWorkloadReferences(route.params.name, route.params.namespace))
const meta = computed(() => readMeta(workload.value))

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

const activeTab = ref('overview')
const showDeleteModal = ref(false)
const showScaleModal = ref(false)
const scaleReplicas = ref(1)
const showEditModal = ref(false)
const editForm = ref({})

const isScalable = computed(() => ['Deployment', 'StatefulSet'].includes(workload.value?.type))
const replicasLabel = computed(() => {
  const t = workload.value?.type
  if (t === 'DaemonSet') return 'SCHEDULED'
  if (t === 'Job') return 'COMPLETIONS'
  if (t === 'CronJob') return 'ACTIVE'
  return 'REPLICAS'
})
const isCronJob = computed(() => workload.value?.type === 'CronJob')
const isRolloutType = computed(() => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(workload.value?.type))
const revisions = computed(() => workload.value?.revisions || [])

const showRollbackModal = ref(false)
const rollbackTarget = ref(null)
function confirmRollback(rev) { rollbackTarget.value = rev; showRollbackModal.value = true }
async function handleRollback() {
  if (rollbackTarget.value == null) return
  try {
    await store.rollbackWorkload(route.params.name, route.params.namespace, rollbackTarget.value)
    showRollbackModal.value = false
    rollbackTarget.value = null
  } catch (e) { notify('error', e.message || '回滚失败') }
}

// === 版本历史增强 ===
const expandedRev = ref(null)
function toggleRevExpand(rev) { expandedRev.value = expandedRev.value === rev.rev ? null : rev.rev }
function revImgBase(img) {
  if (!img) return ''
  const noDigest = img.split('@')[0]
  const idx = noDigest.lastIndexOf(':')
  return idx > noDigest.lastIndexOf('/') ? noDigest.slice(0, idx) : noDigest
}
function revEvents(rev) {
  const names = new Set([rev.rsName, route.params.name].filter(Boolean))
  return (store.nsEvents || []).filter(e => names.has(e.involvedObject?.name)).slice(0, 5)
}
const showRevYamlModal = ref(false)
const revYamlContent = ref('')
const revYamlTitle = ref('')
function viewRevYaml(rev) {
  revYamlTitle.value = `Rev ${rev.rev} · ${rev.rsName || ''}`
  revYamlContent.value = rev._template ? yamlDump(rev._template) : '# 无 template 数据'
  showRevYamlModal.value = true
}
const showDeleteRevModal = ref(false)
const deleteRevTarget = ref(null)
function confirmDeleteRev(rev) { deleteRevTarget.value = rev; showDeleteRevModal.value = true }
async function handleDeleteRev() {
  const rev = deleteRevTarget.value
  if (!rev?.rsName) return
  try {
    await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(route.params.namespace)}/replicasets/${encodeURIComponent(rev.rsName)}`, { method: 'DELETE' })
    notify('success', `已删除旧版本 Rev ${rev.rev} (${rev.rsName})`)
    if (workload.value?.revisions) workload.value.revisions = workload.value.revisions.filter(r => r.rev !== rev.rev)
    if (expandedRev.value === rev.rev) expandedRev.value = null
  } catch (e) { notify('error', e.message || '删除失败') }
  showDeleteRevModal.value = false; deleteRevTarget.value = null
}

const tierOptions = TIER_OPTIONS

async function handleDelete() {
  await store.deleteWorkload(route.params.name, route.params.namespace)
  router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })
}
function handleRestart() { store.restartWorkload(route.params.name, route.params.namespace) }

const triggering = ref(false)
async function triggerCron() {
  triggering.value = true
  try {
    const res = await cronJobApi.trigger({ namespace: route.params.namespace, name: route.params.name })
    notify('success', `已触发 Job：${res.job || route.params.name}`)
  } catch (e) { notify('error', e.message || '触发失败') }
  finally { triggering.value = false }
}
function openScale() {
  if (!workload.value) return
  scaleReplicas.value = parseInt(workload.value.replicas?.split('/')[1] || '1')
  showScaleModal.value = true
}
function handleScale() { store.scaleWorkload(route.params.name, route.params.namespace, scaleReplicas.value); showScaleModal.value = false }

// === 容器 ===
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

// === 运行指标 ===
const nsRef = computed(() => route.params.namespace)
const managedPodNames = computed(() => (managedPods.value || []).map(p => p.name))
const { cpuSeries, memSeries, current: metricsNow, available: metricsAvailable, start: startMetrics } = useMetricsHistory(nsRef, managedPodNames)
onMounted(() => { if (store.remoteMode) startMetrics() })
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

// === 网络暴露 ===
const containerPorts = computed(() => {
  const out = []
  for (const c of (containers.value || [])) for (const p of (c.ports || [])) out.push({ container: c.name, port: p.containerPort, name: p.name, protocol: p.protocol || 'TCP' })
  return out
})
const podLabels = computed(() => workload.value?.raw?.spec?.template?.metadata?.labels || workload.value?.labels || {})
const relatedServices = computed(() => {
  const ns = route.params.namespace
  const sel = podLabels.value
  return (store.serviceList || []).filter(s => s.namespace === ns && s.selector && Object.keys(s.selector).length && Object.entries(s.selector).every(([k, v]) => sel[k] === v))
})
const relatedServiceNames = computed(() => new Set(relatedServices.value.map(s => s.name)))
const relatedIngresses = computed(() => {
  const ns = route.params.namespace
  return (store.ingressList || []).filter(ing => ing.namespace === ns && (ing.rules || []).some(r => (r.http?.paths || []).some(p => { const be = p.backend?.service || p.backend; return relatedServiceNames.value.has(be?.name) })))
})
const showExposeModal = ref(false)
const exposeForm = ref({ name: '', type: 'ClusterIP', ports: [] })
function openExpose() {
  const base = workload.value?.name || 'app'
  exposeForm.value = { name: `${base}-svc`, type: 'ClusterIP', ports: containerPorts.value.length ? containerPorts.value.map(p => ({ port: p.port, targetPort: p.port, protocol: p.protocol })) : [{ port: 80, targetPort: 8080, protocol: 'TCP' }] }
  showExposeModal.value = true
}
async function saveExpose() {
  try {
    await store.addService({ name: exposeForm.value.name, namespace: route.params.namespace, type: exposeForm.value.type, clusterIP: '', ports: exposeForm.value.ports.filter(p => p.port).map(p => `${p.port}:${p.targetPort}/${p.protocol}`).join(','), selector: { ...podLabels.value } })
    notify('success', `已创建 Service ${exposeForm.value.name}`); showExposeModal.value = false
  } catch (e) { notify('error', e.message || '创建 Service 失败') }
}
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
    await store.addIngress({ name: `${workload.value?.name || 'app'}-ingress`, namespace: route.params.namespace, className: '', tls: false, tlsSecret: '', rules: [{ host: f.host, path: f.path, pathType: f.pathType, serviceName: f.serviceName, servicePort: Number(f.servicePort) || 80 }] })
    notify('success', `已创建 Ingress ${f.host || '*'}${f.path} → ${f.serviceName}:${f.servicePort}`); showIngressMapModal.value = false
  } catch (e) { notify('error', e.message || '创建 Ingress 失败') }
}

// === Edit ===
function openEdit() {
  if (!workload.value) return
  const c0 = workload.value?.raw?.spec?.template?.spec?.containers?.[0] || workload.value?.raw?.spec?.jobTemplate?.spec?.template?.spec?.containers?.[0] || {}
  editForm.value = {
    image: workload.value.image,
    replicas: workload.value.replicas?.split('/')[1] || '1',
    schedule: workload.value.schedule || '',
    labels: { ...workload.value.labels },
    tier: workload.value.tier || 'default',
    env: (c0.env || []).filter(e => e.value !== undefined && e.valueFrom === undefined).map(e => ({ key: e.name, value: e.value })),
    cpuReq: c0.resources?.requests?.cpu || '', cpuLim: c0.resources?.limits?.cpu || '',
    memReq: c0.resources?.requests?.memory || '', memLim: c0.resources?.limits?.memory || '',
    livenessEnabled: !!c0.livenessProbe, livenessPath: c0.livenessProbe?.httpGet?.path ?? '/health', livenessPort: c0.livenessProbe?.httpGet?.port ?? 8080,
    readinessEnabled: !!c0.readinessProbe, readinessPath: c0.readinessProbe?.httpGet?.path ?? '/ready', readinessPort: c0.readinessProbe?.httpGet?.port ?? 8080,
    ports: (c0.ports || []).map(p => ({ containerPort: p.containerPort, protocol: p.protocol || 'TCP' })),
  }
  showEditModal.value = true
}
async function saveEdit() {
  const labels = { ...(editForm.value.labels || {}) }
  const updates = { image: editForm.value.image, tier: editForm.value.tier, labels }
  if (isScalable.value) updates.replicas = `${editForm.value.replicas}/${editForm.value.replicas}`
  if (isCronJob.value) updates.schedule = editForm.value.schedule
  store.updateWorkload(route.params.name, route.params.namespace, updates)
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
        c0.livenessProbe = editForm.value.livenessEnabled ? { httpGet: { path: editForm.value.livenessPath, port: Number(editForm.value.livenessPort) || 8080 } } : undefined
        c0.readinessProbe = editForm.value.readinessEnabled ? { httpGet: { path: editForm.value.readinessPath, port: Number(editForm.value.readinessPort) || 8080 } } : undefined
        ;['livenessProbe', 'readinessProbe'].forEach(k => { if (c0[k] === undefined) delete c0[k] })
        try { await store.applyWorkloadTemplate(route.params.name, route.params.namespace, tpl) }
        catch (e) { notify('error', e.message || '容器配置保存失败') }
      }
    }
  }
  showEditModal.value = false
}

// === Template Editor ===
const showTemplateModal = ref(false)
const templateYaml = ref('')
function openTemplateEditor() {
  const rawTpl = workload.value?.raw?.spec?.template
  templateYaml.value = rawTpl ? yamlDump(rawTpl) : ''
  showTemplateModal.value = true
}
async function saveTemplate(yamlStr) {
  try {
    const tpl = yamlDump ? null : null // placeholder
    const obj = JSON.parse(JSON.stringify(workload.value?.raw?.spec?.template || {}))
    // 简化：用 js-yaml load 解析
    const { load: yamlLoad } = await import('js-yaml')
    const parsed = yamlLoad(yamlStr)
    await store.applyWorkloadTemplate(route.params.name, route.params.namespace, parsed)
    notify('success', 'Pod 模板已更新')
    showTemplateModal.value = false
  } catch (e) { notify('error', e.message || '保存失败') }
}

// Pod status color helper
function podStatusColor(s) {
  return s === 'Running' ? 'text-primary' : s === 'Pending' ? 'text-tertiary-container' : s === 'Failed' ? 'text-error' : 'text-on-surface-variant'
}
function podStatusBg(s) {
  return s === 'Running' ? 'bg-primary' : s === 'Pending' ? 'bg-tertiary-container' : s === 'Failed' ? 'bg-error' : 'bg-on-surface-variant'
}
function podStatusBorder(s) {
  return s === 'Running' ? 'border-l-primary' : s === 'Pending' ? 'border-l-tertiary-container' : s === 'Failed' ? 'border-l-error' : 'border-l-on-surface-variant/30'
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

    <!-- ====== Header ====== -->
    <div class="flex items-start justify-between mt-sm mb-md">
      <div class="flex items-start gap-md">
        <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center shrink-0 ring-1 ring-primary/10">
          <span class="material-symbols-outlined text-primary text-2xl">apps</span>
        </div>
        <div>
          <div class="flex items-baseline gap-sm flex-wrap">
            <h1 class="text-headline-lg text-on-surface font-bold">{{ meta.title || workload.name }}</h1>
            <span v-if="meta.title" class="font-mono text-code-xs text-on-surface-variant">{{ workload.name }}</span>
          </div>
          <p v-if="meta.description" class="text-body-sm text-on-surface-variant mt-xs">{{ meta.description }}</p>
          <div class="flex items-center gap-xs mt-xs flex-wrap">
            <span class="px-2 py-0.5 bg-primary/8 text-primary text-body-xs rounded-md font-medium">{{ workload.type }}</span>
            <StatusChip :status="workload.status" size="sm" />
            <span class="text-body-xs text-on-surface-variant">{{ workload.namespace }}</span>
            <span v-if="meta.owner" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-surface-container rounded text-body-xs text-on-surface-variant"><span class="material-symbols-outlined text-xs">group</span>{{ meta.owner }}</span>
            <span v-if="meta.version" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-primary/8 rounded text-body-xs text-primary"><span class="material-symbols-outlined text-xs">sell</span>{{ meta.version }}</span>
            <span v-if="meta.managedBy === 'aliangboard'" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-primary/8 text-primary rounded text-body-xs font-medium"><span class="material-symbols-outlined text-xs">verified</span>AliangBoard</span>
          </div>
        </div>
      </div>
      <div class="flex gap-xs shrink-0">
        <button v-if="isScalable" @click="openScale" class="px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors">Scale</button>
        <button @click="handleRestart" class="px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors">Restart</button>
        <button @click="openEdit" class="px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">Edit</button>
        <button v-if="isRolloutType" @click="openTemplateEditor" class="px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors">Template</button>
        <button @click="showDeleteModal = true" class="px-3 py-1.5 text-body-sm font-medium border border-error/30 text-error rounded-lg hover:bg-error/5 transition-colors">Delete</button>
      </div>
    </div>

    <!-- ====== Tabs ====== -->
    <div class="flex items-center gap-xs border-b border-outline-variant mb-md">
      <button v-for="tab in (isRolloutType ? ['overview', 'network', 'pods', 'revisions', 'yaml', 'events'] : ['overview', 'network', 'pods', 'yaml', 'events'])" :key="tab" @click="activeTab = tab"
        class="px-lg py-2 text-body-sm font-medium transition-colors relative"
        :class="activeTab === tab ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'">
        {{ tab }}
        <span v-if="activeTab === tab" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"></span>
      </button>
    </div>

    <!-- ====== Overview Tab ====== -->
    <div v-if="activeTab === 'overview'" class="flex gap-md">
      <!-- ====== LEFT: Timeline + Labels ====== -->
      <div class="w-[260px] shrink-0 hidden lg:flex flex-col gap-sm">
        <!-- Timeline -->
        <div v-if="isRolloutType && revisions.length" class="rounded-xl overflow-hidden">
          <div class="px-sm py-2 flex items-center gap-xs">
            <span class="material-symbols-outlined text-base text-on-surface-variant">history</span>
            <span class="text-body-sm font-semibold text-on-surface">版本历史</span>
            <span class="text-body-xs text-on-surface-variant ml-auto">{{ revisions.length }}</span>
          </div>
          <div class="relative px-sm pb-sm">
            <div class="absolute left-[13px] top-0 bottom-0 w-px bg-outline-variant/30"></div>
            <div v-for="rev in revisions" :key="rev.rev" class="relative pl-md pb-xs">
              <div class="absolute left-[10px] top-1.5 w-[7px] h-[7px] rounded-full z-10 ring-2 ring-surface" :class="rev.current ? 'bg-primary' : 'bg-outline-variant'"></div>
              <div class="rounded-lg overflow-hidden transition-all"
                :class="rev.current ? 'bg-primary/5 ring-1 ring-primary/20' : expandedRev === rev.rev ? 'bg-surface-container ring-1 ring-primary/20' : 'hover:bg-surface-container/50'">
                <div class="px-sm py-1.5 cursor-pointer" @click="toggleRevExpand(rev)">
                  <div class="flex items-center justify-between">
                    <span class="text-body-xs font-bold" :class="rev.current ? 'text-primary' : 'text-on-surface'">Rev {{ rev.rev }}</span>
                    <div class="flex items-center gap-1">
                      <span v-if="rev.current" class="text-body-xs text-primary font-semibold">●</span>
                      <span class="text-body-xs text-on-surface-variant/50">{{ rev.age }}</span>
                      <span class="material-symbols-outlined text-xs text-on-surface-variant/40 transition-transform" :class="expandedRev === rev.rev ? 'rotate-180' : ''">expand_more</span>
                    </div>
                  </div>
                  <p class="font-mono text-xs text-on-surface-variant truncate leading-tight mt-0.5">{{ revImgBase(rev.image) }}<span class="text-primary font-semibold">:{{ imageTag(rev.image) || 'latest' }}</span></p>
                  <div class="flex items-center gap-1 mt-1">
                    <span class="text-xs text-on-surface-variant">期望<b class="text-on-surface ml-0.5">{{ rev.desiredReplicas ?? '—' }}</b></span>
                    <span class="text-xs" :class="(rev.replicas ?? 0) >= (rev.desiredReplicas ?? 0) ? 'text-primary' : 'text-tertiary-container'">·<b class="ml-0.5">{{ rev.replicas ?? 0 }}</b></span>
                    <span class="text-xs" :class="(rev.readyReplicas ?? 0) >= (rev.desiredReplicas ?? 0) ? 'text-primary' : 'text-error'">·<b class="ml-0.5">{{ rev.readyReplicas ?? 0 }}</b></span>
                    <div class="flex items-center gap-0.5 ml-auto">
                      <button @click.stop="viewRevYaml(rev)" class="p-0.5 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary" title="YAML"><span class="material-symbols-outlined text-xs">code</span></button>
                      <button v-if="!rev.current" @click.stop="confirmDeleteRev(rev)" class="p-0.5 rounded hover:bg-error/10 text-on-surface-variant hover:text-error" title="删除"><span class="material-symbols-outlined text-xs">delete</span></button>
                      <button v-if="!rev.current" @click.stop="confirmRollback(rev)" class="p-0.5 rounded hover:bg-primary/10 text-primary" title="回滚"><span class="material-symbols-outlined text-xs">undo</span></button>
                    </div>
                  </div>
                </div>
                <!-- Events -->
                <div v-if="expandedRev === rev.rev" class="px-sm pb-sm border-t border-outline-variant/20 animate-fade-in">
                  <div v-if="revEvents(rev).length" class="flex flex-col mt-1">
                    <div v-for="(e, ei) in revEvents(rev)" :key="ei" class="flex items-start gap-1 py-0.5">
                      <span class="w-1 h-1 rounded-full mt-1.5 shrink-0" :class="e.type === 'warning' ? 'bg-error' : 'bg-primary'"></span>
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-1">
                          <span class="text-xs font-medium" :class="e.type === 'warning' ? 'text-error' : 'text-on-surface'">{{ e.reason }}</span>
                          <span class="text-xs text-on-surface-variant/40">{{ e.age }}</span>
                          <span v-if="e.count > 1" class="text-xs text-on-surface-variant/40">×{{ e.count }}</span>
                        </div>
                        <p class="text-xs text-on-surface-variant/70 truncate">{{ e.message }}</p>
                      </div>
                    </div>
                  </div>
                  <p v-else class="text-xs text-on-surface-variant/40 py-1 text-center">暂无事件</p>
                  <button @click="activeTab = 'events'" class="w-full text-xs text-primary hover:underline pt-0.5">More →</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Labels -->
        <div class="rounded-xl overflow-hidden">
          <div class="px-sm py-2 flex items-center gap-xs">
            <span class="material-symbols-outlined text-base text-on-surface-variant">label</span>
            <span class="text-body-sm font-semibold text-on-surface">Labels</span>
          </div>
          <div class="px-sm pb-sm flex flex-wrap gap-1">
            <span v-for="(val, key) in (workload.labels || {})" :key="key" class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant">
              <span class="font-semibold">{{ key }}</span>={{ val }}
            </span>
          </div>
        </div>
      </div>

      <!-- ====== RIGHT: Metrics + Pods + Containers ====== -->
      <div class="flex-1 min-w-0 flex flex-col gap-sm">
        <!-- Metrics -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="flex items-center justify-between px-md py-2.5 border-b border-outline-variant/50">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">monitoring</span>
              <span class="text-body-sm font-semibold">运行指标</span>
            </div>
            <div class="flex items-center gap-sm">
              <span class="text-body-xs text-on-surface-variant">{{ managedPods.length }} Pods · {{ workload.replicas }}</span>
              <span v-if="managedPods.length && managedPods.every(p => p.status === 'Running')" class="text-body-xs text-primary font-medium flex items-center gap-0.5"><span class="material-symbols-outlined text-sm">check_circle</span>全部就绪</span>
              <span v-else-if="!metricsAvailable" class="text-body-xs text-error">不可用</span>
            </div>
          </div>
          <div v-if="metricsAvailable" class="grid grid-cols-2 gap-px bg-outline-variant/10">
            <div class="bg-surface-container-lowest p-md">
              <MiniChart :series="cpuSeries" label="CPU" unit="m" color="var(--md-sys-color-primary)" :ref-lines="cpuRefLines" :height="64" />
              <div class="flex items-center gap-sm mt-1 text-body-xs">
                <span class="text-on-surface-variant"><b class="text-primary font-mono">{{ metricsNow.cpu }}</b>m</span>
                <span class="text-on-surface-variant/40">req {{ cpuReq || '—' }}m</span>
                <span class="text-on-surface-variant/40">lim {{ cpuLim || '—' }}m</span>
              </div>
            </div>
            <div class="bg-surface-container-lowest p-md">
              <MiniChart :series="memSeries" label="Memory" unit="Mi" color="var(--md-sys-color-secondary)" :ref-lines="memRefLines" :height="64" />
              <div class="flex items-center gap-sm mt-1 text-body-xs">
                <span class="text-on-surface-variant"><b class="text-secondary font-mono">{{ metricsNow.mem }}</b>Mi</span>
                <span class="text-on-surface-variant/40">req {{ memReq || '—' }}Mi</span>
                <span class="text-on-surface-variant/40">lim {{ memLim || '—' }}Mi</span>
              </div>
            </div>
          </div>
          <div v-else class="py-md text-center">
            <span class="material-symbols-outlined text-2xl text-surface-container-high">monitoring</span>
            <p class="text-body-sm text-on-surface-variant mt-xs">metrics-server 未就绪</p>
          </div>
        </div>

        <!-- Pods -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="flex items-center justify-between px-md py-2.5 border-b border-outline-variant/50">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">view_in_ar</span>
              <span class="text-body-sm font-semibold">Pods</span>
              <span class="text-body-xs text-on-surface-variant">{{ managedPods.length }}</span>
            </div>
            <div class="flex items-center gap-sm">
              <span class="text-body-xs text-primary font-medium">{{ managedPods.filter(p => p.status === 'Running').length }} Running</span>
              <span v-if="managedPods.filter(p => p.status !== 'Running').length" class="text-body-xs text-tertiary-container">{{ managedPods.filter(p => p.status !== 'Running').length }} Other</span>
            </div>
          </div>
          <div class="divide-y divide-outline-variant/15">
            <div v-for="p in managedPods.slice(0, 20)" :key="p.name"
              @click="router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } })"
              class="flex items-center gap-sm px-md py-2 hover:bg-surface-container-low/40 cursor-pointer transition-colors border-l-2"
              :class="podStatusBorder(p.status)">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="[podStatusBg(p.status), p.status === 'Running' ? 'animate-pulse-status' : '']"></span>
              <span class="font-mono text-xs font-medium text-on-surface truncate flex-1 min-w-0">{{ p.name }}</span>
              <span class="text-xs shrink-0" :class="podStatusColor(p.status)">{{ p.status }}</span>
              <span v-if="p.restarts > 0" class="flex items-center gap-0.5 text-xs shrink-0" :class="p.restarts > 3 ? 'text-error' : 'text-tertiary-container'">
                <span class="material-symbols-outlined text-xs">restart_alt</span>{{ p.restarts }}
              </span>
              <span class="font-mono text-xs text-on-surface-variant/50 shrink-0 hidden md:inline">{{ p.node || '—' }}</span>
              <span class="text-xs text-on-surface-variant/50 shrink-0">{{ p.age }}</span>
              <span class="material-symbols-outlined text-sm text-on-surface-variant/30 shrink-0">chevron_right</span>
            </div>
          </div>
          <div v-if="managedPods.length > 20" class="px-md py-2 text-center border-t border-outline-variant/30">
            <button @click="activeTab = 'pods'" class="text-body-sm text-primary hover:underline">查看全部 {{ managedPods.length }} 个 →</button>
          </div>
          <div v-if="!managedPods.length" class="py-md text-center text-body-sm text-on-surface-variant">暂无管理 Pod</div>
        </div>

        <!-- Containers + Details (2-col) -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-sm">
          <!-- Containers -->
          <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
            <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">inventory_2</span>
              <span class="text-body-sm font-semibold">Containers</span>
              <span class="text-body-xs text-on-surface-variant ml-auto">{{ containers.length }}</span>
            </div>
            <div v-if="containers.length" class="flex flex-col">
              <div v-for="(c, i) in containers" :key="i" class="px-md py-2 border-b border-outline-variant/15 last:border-0">
                <p class="text-body-sm font-semibold">{{ c.name }}</p>
                <p class="font-mono text-xs text-primary truncate">{{ c.image }}</p>
                <div class="flex items-center gap-sm mt-1 text-xs text-on-surface-variant">
                  <span>{{ fmtPorts(c) }}</span>
                  <span class="text-on-surface-variant/40">·</span>
                  <span>{{ fmtResources(c.resources) }}</span>
                </div>
              </div>
            </div>
            <p v-else class="px-md py-sm text-body-sm text-on-surface-variant">无容器详情</p>
          </div>
          <!-- Details -->
          <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
            <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">info</span>
              <span class="text-body-sm font-semibold">详情</span>
            </div>
            <div class="px-md py-sm grid grid-cols-2 gap-xs">
              <div><p class="text-xs text-on-surface-variant/50 uppercase tracking-wider">Type</p><p class="text-body-sm font-medium">{{ workload.type }}</p></div>
              <div><p class="text-xs text-on-surface-variant/50 uppercase tracking-wider">{{ replicasLabel }}</p><p class="text-body-sm font-medium">{{ workload.replicas }}</p></div>
              <div><p class="text-xs text-on-surface-variant/50 uppercase tracking-wider">Revision</p><p class="font-mono text-xs">{{ workload.sha }}</p></div>
              <div><p class="text-xs text-on-surface-variant/50 uppercase tracking-wider">Age</p><p class="text-body-sm font-medium">{{ workload.age }}</p></div>
              <div v-if="isCronJob" class="col-span-2"><p class="text-xs text-on-surface-variant/50 uppercase tracking-wider">Schedule</p><p class="font-mono text-xs text-primary">{{ workload.schedule }}</p></div>
              <div class="col-span-2"><p class="text-xs text-on-surface-variant/50 uppercase tracking-wider">Image</p><p class="font-mono text-xs text-primary truncate">{{ workload.image }}</p></div>
            </div>
          </div>
        </div>

        <!-- Config Deps -->
        <div v-if="configRefs.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">link</span>
            <span class="text-body-sm font-semibold">配置依赖</span>
            <span class="text-body-xs text-on-surface-variant ml-auto">{{ configRefs.length }}</span>
          </div>
          <div class="flex flex-wrap gap-xs px-md py-sm">
            <span v-for="(ref, idx) in configRefs" :key="idx" @click="router.push({ name: refRoute(ref).name, params: { namespace: route.params.namespace, name: ref.name } })"
              class="inline-flex items-center gap-xs px-sm py-xs bg-surface-container-low rounded cursor-pointer hover:bg-surface-container transition-colors">
              <span class="material-symbols-outlined text-sm" :class="ref.kind === 'ConfigMap' ? 'text-secondary' : 'text-tertiary'">{{ ref.kind === 'ConfigMap' ? 'description' : 'key' }}</span>
              <span class="font-mono text-xs font-medium">{{ ref.name }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- ====== Network Tab ====== -->
    <div v-if="activeTab === 'network'" class="flex flex-col gap-md">
      <div class="rounded-xl bg-surface-container-lowest border border-outline-variant p-md">
        <h3 class="text-body-sm font-semibold mb-sm">容器端口</h3>
        <div v-if="containerPorts.length" class="flex flex-wrap gap-xs">
          <span v-for="(p, i) in containerPorts" :key="i" class="font-mono text-xs px-sm py-xs bg-surface-container-low rounded border border-outline-variant">{{ p.container }}: <b class="text-primary">{{ p.port }}</b>/{{ p.protocol }}</span>
        </div>
        <p v-else class="text-body-sm text-on-surface-variant">未定义</p>
      </div>
      <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
        <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center justify-between">
          <span class="text-body-sm font-semibold">关联 Service</span>
          <button @click="openExpose" class="text-body-xs text-primary hover:underline">+ 暴露</button>
        </div>
        <div v-if="relatedServices.length" class="divide-y divide-outline-variant/15">
          <div v-for="s in relatedServices" :key="s.name" @click="router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: s.name } })" class="flex items-center gap-sm px-md py-2 hover:bg-surface-container-low/40 cursor-pointer">
            <span class="material-symbols-outlined text-primary text-sm">hub</span>
            <span class="text-body-sm font-medium flex-1 truncate">{{ s.name }}</span>
            <span class="font-mono text-xs text-on-surface-variant">{{ s.ports }}</span>
            <span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant">{{ s.type }}</span>
          </div>
        </div>
        <p v-else class="px-md py-sm text-body-sm text-on-surface-variant">暂无关联 Service</p>
      </div>
      <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
        <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center justify-between">
          <span class="text-body-sm font-semibold">关联 Ingress</span>
          <button @click="openIngressMap" :disabled="!relatedServices.length" class="text-body-xs text-primary hover:underline disabled:opacity-40">+ 映射</button>
        </div>
        <div v-if="relatedIngresses.length" class="divide-y divide-outline-variant/15">
          <template v-for="ing in relatedIngresses" :key="ing.name">
            <div v-for="(r, ri) in (ing.rules || [])" :key="ri" @click="router.push({ name: 'NsIngressDetail', params: { namespace: route.params.namespace, name: ing.name } })" class="flex items-center gap-sm px-md py-2 hover:bg-surface-container-low/40 cursor-pointer">
              <span class="material-symbols-outlined text-primary text-sm">alt_route</span>
              <span class="font-mono text-xs flex-1 truncate"><b class="text-primary">{{ r.host || '*' }}</b>{{ r.http?.paths?.[0]?.path || '/' }} → {{ r.http?.paths?.[0]?.backend?.service?.name || r.http?.paths?.[0]?.backend?.serviceName }}:{{ r.http?.paths?.[0]?.backend?.service?.port?.number || r.http?.paths?.[0]?.backend?.servicePort }}</span>
            </div>
          </template>
        </div>
        <p v-else class="px-md py-sm text-body-sm text-on-surface-variant">暂无关联 Ingress</p>
      </div>
    </div>

    <!-- ====== Pods Tab ====== -->
    <div v-if="activeTab === 'pods'">
      <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
        <table class="w-full text-left">
          <thead><tr class="border-b border-outline-variant bg-surface-container-low/50">
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Name</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Status</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Restarts</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Node</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Age</th>
          </tr></thead>
          <tbody class="divide-y divide-outline-variant/15">
            <tr v-for="p in managedPods" :key="p.name" @click="router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } })" class="hover:bg-surface-container-low/40 cursor-pointer">
              <td class="px-md py-2 font-mono text-xs font-medium">{{ p.name }}</td>
              <td class="px-md py-2"><div class="flex items-center gap-xs"><span class="w-1.5 h-1.5 rounded-full" :class="podStatusBg(p.status)"></span><span class="text-xs" :class="podStatusColor(p.status)">{{ p.status }}</span></div></td>
              <td class="px-md py-2 text-xs" :class="p.restarts > 3 ? 'text-error font-medium' : 'text-on-surface-variant'">{{ p.restarts }}</td>
              <td class="px-md py-2 font-mono text-xs text-on-surface-variant">{{ p.node || '—' }}</td>
              <td class="px-md py-2 text-xs text-on-surface-variant">{{ p.age }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ====== Revisions Tab ====== -->
    <div v-if="activeTab === 'revisions'">
      <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
        <table class="w-full text-left">
          <thead><tr class="border-b border-outline-variant bg-surface-container-low/50">
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Rev</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Image</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Replicas</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Age</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant w-20">Actions</th>
          </tr></thead>
          <tbody class="divide-y divide-outline-variant/15">
            <tr v-for="rev in revisions" :key="rev.rev" class="hover:bg-surface-container-low/40">
              <td class="px-md py-2"><span class="text-body-sm font-bold" :class="rev.current ? 'text-primary' : ''">Rev {{ rev.rev }}</span><span v-if="rev.current" class="ml-xs text-body-xs text-primary">●</span></td>
              <td class="px-md py-2 font-mono text-xs truncate max-w-[200px]">{{ rev.image }}</td>
              <td class="px-md py-2 text-xs">{{ rev.readyReplicas }}/{{ rev.desiredReplicas }}</td>
              <td class="px-md py-2 text-xs text-on-surface-variant">{{ rev.age }}</td>
              <td class="px-md py-2"><button v-if="!rev.current" @click="confirmRollback(rev)" class="text-body-xs text-primary hover:underline">回滚</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ====== YAML Tab ====== -->
    <div v-if="activeTab === 'yaml'"><YamlEditor :model-value="yaml" :readonly="false" height="560px" @save="applyYaml" /></div>

    <!-- ====== Events Tab ====== -->
    <div v-if="activeTab === 'events'" class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
      <table class="w-full text-left">
        <thead><tr class="border-b border-outline-variant bg-surface-container-low/50">
          <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Reason</th>
          <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Type</th>
          <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Message</th>
          <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Age</th>
        </tr></thead>
        <tbody class="divide-y divide-outline-variant/15">
          <tr v-for="(e, i) in (store.nsEvents || []).filter(e => e.involvedObject?.name === route.params.name).slice(0, 50)" :key="i" class="hover:bg-surface-container-low/30">
            <td class="px-md py-2 text-xs font-medium" :class="e.type === 'warning' ? 'text-error' : 'text-on-surface'">{{ e.reason }}</td>
            <td class="px-md py-2"><span class="text-xs px-1.5 py-0.5 rounded" :class="e.type === 'warning' ? 'bg-error/10 text-error' : 'bg-primary/10 text-primary'">{{ e.type }}</span></td>
            <td class="px-md py-2 text-xs text-on-surface-variant truncate max-w-[400px]" :title="e.message">{{ e.message }}</td>
            <td class="px-md py-2 text-xs text-on-surface-variant">{{ e.age }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!(store.nsEvents || []).filter(e => e.involvedObject?.name === route.params.name).length" class="py-md text-center text-body-sm text-on-surface-variant">暂无事件</p>
    </div>
  </div>

  <!-- Not Found -->
  <div v-else class="text-center py-xl">
    <span class="material-symbols-outlined text-4xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">Workload Not Found</h2>
    <button @click="router.push({ name: 'NsWorkloads', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back</button>
  </div>

  <!-- ====== Modals ====== -->
  <Modal v-model="showDeleteModal" title="Delete Workload" width="max-w-md">
    <p class="text-body-md">Delete <b>{{ route.params.name }}</b>?</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg font-semibold">Delete</button>
    </template>
  </Modal>

  <Modal v-model="showScaleModal" title="Scale" width="max-w-sm">
    <input v-model.number="scaleReplicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm" />
    <template #actions>
      <button @click="showScaleModal = false" class="px-md py-sm border border-outline-variant rounded-lg">Cancel</button>
      <button @click="handleScale" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Scale</button>
    </template>
  </Modal>

  <Modal v-model="showRollbackModal" title="Rollback" width="max-w-md">
    <p>Rollback to <b>Rev {{ rollbackTarget?.rev }}</b>?</p>
    <template #actions>
      <button @click="showRollbackModal = false" class="px-md py-sm border border-outline-variant rounded-lg">Cancel</button>
      <button @click="handleRollback" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Rollback</button>
    </template>
  </Modal>

  <Modal v-model="showEditModal" title="Edit Workload" width="max-w-2xl">
    <div class="flex flex-col gap-md">
      <div class="grid grid-cols-2 gap-sm">
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">Image</label><input v-model="editForm.image" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" /></div>
        <div v-if="isScalable"><label class="text-body-xs text-on-surface-variant block mb-xs">Replicas</label><input v-model.number="editForm.replicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
      </div>
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">分层</label>
        <div class="flex flex-wrap gap-xs">
          <button v-for="t in tierOptions" :key="t.value" @click="editForm.tier = t.value" class="flex items-center gap-xs px-sm py-xs rounded-lg border text-body-sm" :class="editForm.tier === t.value ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant'">
            <span class="material-symbols-outlined text-sm">{{ t.icon }}</span>{{ t.label }}
          </button>
        </div>
      </div>
      <div v-if="isRolloutType" class="pt-md border-t border-outline-variant/40 flex flex-col gap-sm">
        <p class="text-body-xs font-semibold text-on-surface-variant">容器配置</p>
        <div class="grid grid-cols-4 gap-xs">
          <div><label class="text-body-xs text-on-surface-variant">CPU Req</label><input v-model="editForm.cpuReq" class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="250m" /></div>
          <div><label class="text-body-xs text-on-surface-variant">CPU Lim</label><input v-model="editForm.cpuLim" class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="500m" /></div>
          <div><label class="text-body-xs text-on-surface-variant">Mem Req</label><input v-model="editForm.memReq" class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="256Mi" /></div>
          <div><label class="text-body-xs text-on-surface-variant">Mem Lim</label><input v-model="editForm.memLim" class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="512Mi" /></div>
        </div>
        <div>
          <div class="flex items-center justify-between"><label class="text-body-xs text-on-surface-variant">端口</label><button @click="editForm.ports.push({ containerPort: '', protocol: 'TCP' })" class="text-body-xs text-primary">+</button></div>
          <div v-for="(p, i) in editForm.ports" :key="i" class="flex items-center gap-xs mt-xs">
            <input v-model.number="p.containerPort" type="number" class="w-24 bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="8080" />
            <input v-model="p.protocol" class="w-20 bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="TCP" />
            <button @click="editForm.ports.splice(i, 1)" class="text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">close</span></button>
          </div>
        </div>
        <div>
          <div class="flex items-center justify-between"><label class="text-body-xs text-on-surface-variant">环境变量</label><button @click="editForm.env.push({ key: '', value: '' })" class="text-body-xs text-primary">+</button></div>
          <div v-for="(e, i) in editForm.env" :key="i" class="flex items-center gap-xs mt-xs">
            <input v-model="e.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="KEY" />
            <input v-model="e.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="val" />
            <button @click="editForm.env.splice(i, 1)" class="text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">close</span></button>
          </div>
        </div>
        <div class="flex items-center gap-md">
          <label class="flex items-center gap-xs text-body-sm"><input type="checkbox" v-model="editForm.livenessEnabled" class="h-4 w-4 accent-primary" /> Liveness</label>
          <label class="flex items-center gap-xs text-body-sm"><input type="checkbox" v-model="editForm.readinessEnabled" class="h-4 w-4 accent-primary" /> Readiness</label>
        </div>
        <div v-if="editForm.livenessEnabled || editForm.readinessEnabled" class="grid grid-cols-2 gap-xs">
          <div><label class="text-body-xs text-on-surface-variant">HTTP Path</label><input v-model="editForm.livenessPath" class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="/health" /></div>
          <div><label class="text-body-xs text-on-surface-variant">Port</label><input v-model.number="editForm.livenessPort" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="8080" /></div>
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg">Cancel</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Save</button>
    </template>
  </Modal>

  <Modal v-model="showTemplateModal" title="Edit Pod Template" width="max-w-3xl">
    <YamlEditor v-model="templateYaml" :readonly="false" height="400px" @save="saveTemplate" />
    <template #actions>
      <button @click="showTemplateModal = false" class="px-md py-sm border border-outline-variant rounded-lg">Cancel</button>
      <button @click="saveTemplate(templateYaml)" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Apply</button>
    </template>
  </Modal>

  <Modal v-model="showExposeModal" title="暴露为 Service" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div class="grid grid-cols-2 gap-md">
        <div><label class="text-body-xs text-on-surface-variant">名称</label><input v-model="exposeForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" /></div>
        <div><label class="text-body-xs text-on-surface-variant">类型</label><select v-model="exposeForm.type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm"><option>ClusterIP</option><option>NodePort</option><option>LoadBalancer</option></select></div>
      </div>
      <div v-for="(p, i) in exposeForm.ports" :key="i" class="flex items-center gap-xs">
        <input v-model.number="p.port" type="number" class="w-24 bg-surface-container-low border border-outline-variant rounded px-md py-sm text-body-sm font-mono" placeholder="port" />
        <span class="text-on-surface-variant">:</span>
        <input v-model.number="p.targetPort" type="number" class="w-28 bg-surface-container-low border border-outline-variant rounded px-md py-sm text-body-sm font-mono" placeholder="target" />
        <button @click="exposeForm.ports.splice(i, 1)" class="text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">close</span></button>
      </div>
      <button @click="exposeForm.ports.push({ port: '', targetPort: '', protocol: 'TCP' })" class="self-start text-body-xs text-primary">+ 端口</button>
    </div>
    <template #actions>
      <button @click="showExposeModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
      <button @click="saveExpose" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">创建</button>
    </template>
  </Modal>

  <Modal v-model="showIngressMapModal" title="加 Ingress 映射" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div><label class="text-body-xs text-on-surface-variant">Host</label><input v-model="ingressMapForm.host" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="app.example.com" /></div>
      <div class="grid grid-cols-2 gap-md">
        <div><label class="text-body-xs text-on-surface-variant">Path</label><input v-model="ingressMapForm.path" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="/" /></div>
        <div><label class="text-body-xs text-on-surface-variant">Service</label><select v-model="ingressMapForm.serviceName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono"><option v-for="s in relatedServices" :key="s.name" :value="s.name">{{ s.name }}</option></select></div>
      </div>
      <div><label class="text-body-xs text-on-surface-variant">Port</label><input v-model="ingressMapForm.servicePort" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="80" /></div>
    </div>
    <template #actions>
      <button @click="showIngressMapModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
      <button @click="saveIngressMap" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">创建</button>
    </template>
  </Modal>

  <Modal v-model="showRevYamlModal" :title="revYamlTitle" width="max-w-2xl">
    <YamlEditor :model-value="revYamlContent" :readonly="true" height="400px" />
    <template #actions><button @click="showRevYamlModal = false" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">关闭</button></template>
  </Modal>

  <Modal v-model="showDeleteRevModal" title="删除旧版本" width="max-w-md">
    <p class="text-body-md">删除 <b>Rev {{ deleteRevTarget?.rev }}</b>（{{ deleteRevTarget?.rsName }}）？</p>
    <p class="text-body-sm text-error mt-sm">删除后无法回滚到该版本。</p>
    <template #actions>
      <button @click="showDeleteRevModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
      <button @click="handleDeleteRev" class="px-md py-sm bg-error text-on-error rounded-lg font-semibold">删除</button>
    </template>
  </Modal>
</template>
