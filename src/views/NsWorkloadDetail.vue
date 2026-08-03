<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { cronJobApi, api, execStream, podFileApi, registryApi } from '@/api/client'
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
import PortForwardPanel from '@/components/common/PortForwardPanel.vue'

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

// === RBAC：按 can-i(SSAR) 真值控制操作按钮（默认允许，SSAR 失败/不可用时不锁死）===
const RES_PLURAL = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets', Job: 'jobs', CronJob: 'cronjobs' }
const canMutate = ref(true)
const canDelete = ref(true)
let permsLoaded = false
async function loadPerms() {
  if (!store.remoteMode || !workload.value) return
  const resource = RES_PLURAL[workload.value.type]
  if (!resource) return
  const ns = route.params.namespace
  const [u, d] = await Promise.all([
    store.checkAccessServer({ verb: 'update', resource, namespace: ns }),
    store.checkAccessServer({ verb: 'delete', resource, namespace: ns }),
  ])
  if (u?.ok) canMutate.value = !!u.allowed
  if (d?.ok) canDelete.value = !!d.allowed
}
watch(workload, wl => { if (wl && !permsLoaded) { permsLoaded = true; loadPerms() } }, { immediate: true })

// === YAML 变更 diff 预览（LCS 行级 diff，Apply 前确认）===
function lineDiff(a, b) {
  const A = String(a || '').split('\n'), B = String(b || '').split('\n')
  const m = A.length, n = B.length
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ t: 'ctx', v: A[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', v: A[i] }); i++ }
    else { out.push({ t: 'add', v: B[j] }); j++ }
  }
  while (i < m) { out.push({ t: 'del', v: A[i] }); i++ }
  while (j < n) { out.push({ t: 'add', v: B[j] }); j++ }
  return out
}
const showDiffModal = ref(false)
const diffLines = ref([])
const pendingYaml = ref('')
const diffStat = computed(() => ({ add: diffLines.value.filter(l => l.t === 'add').length, del: diffLines.value.filter(l => l.t === 'del').length }))
function onYamlSave(edited) {
  if (edited === yaml.value) { notify('info', '内容未变更'); return }
  pendingYaml.value = edited
  diffLines.value = lineDiff(yaml.value, edited)
  showDiffModal.value = true
}
async function confirmApplyYaml() {
  try { await applyYaml(pendingYaml.value); showDiffModal.value = false }
  catch { /* applyYaml 内部已 notify */ }
}

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

// 副本/滚动状态：从 Deployment/StatefulSet/DaemonSet 的 status 推导健康等级 + 新旧版本进度
// level: healthy(绿) / updating(蓝) / warning(黄) / failed(红)，对应 status-* 设计令牌
const STATUS_META = {
  healthy: { dot: 'bg-status-running', text: 'text-status-running', label: '正常运行', icon: 'check_circle' },
  updating: { dot: 'bg-status-succeeded', text: 'text-status-succeeded', label: '滚动更新中', icon: 'sync' },
  warning: { dot: 'bg-status-pending', text: 'text-status-pending', label: '部分就绪', icon: 'warning' },
  failed: { dot: 'bg-status-failed', text: 'text-status-failed', label: '异常', icon: 'error' },
}
const rollout = computed(() => {
  const wl = workload.value
  if (!wl?.raw) return null
  const st = wl.raw.status || {}
  const spec = wl.raw.spec || {}
  const isDaemon = wl.type === 'DaemonSet'
  const desired = spec.replicas ?? (isDaemon ? st.desiredNumberScheduled : 1)
  const updated = st.updatedReplicas ?? (isDaemon ? st.updatedNumberScheduled : 0) ?? 0
  const ready = st.readyReplicas ?? st.numberReady ?? 0
  const total = st.replicas ?? (isDaemon ? st.currentNumberScheduled : ready)
  const conds = st.conditions || []
  const cond = t => conds.find(c => c.type === t)
  const progressing = cond('Progressing')
  const availableCond = cond('Available') || cond('DaemonSetAvailable')
  const replicaFailure = cond('ReplicaFailure')
  let level = 'healthy', reason = availableCond?.reason || (ready >= desired ? '所有副本就绪' : '')
  if (replicaFailure?.status === 'True') { level = 'failed'; reason = replicaFailure.reason || '副本创建失败，请查看事件' }
  else if (desired === 0) { level = 'warning'; reason = '期望副本数为 0（已缩容）' }
  else if (ready === 0 && total > 0) { level = 'failed'; reason = '副本均未就绪，检查事件/日志' }
  else if (updated < desired) { level = 'updating'; reason = progressing?.reason || `新版本 ${updated}/${desired} 就绪中` }
  else if (ready < desired) { level = 'warning'; reason = `${ready}/${desired} 副本就绪` }
  // 进度条以"当前 Pod 总数"为分母，展示新旧版本占比（滚动时 total 可能 > desired）
  const oldCount = Math.max(0, (total || ready) - updated)
  const denom = Math.max(total, updated, 1)
  return {
    desired, updated, ready, total, oldCount, level, reason,
    newW: Math.round((updated / denom) * 100),
    oldW: Math.round((oldCount / denom) * 100),
    meta: STATUS_META[level],
  }
})

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

// === 镜像解析：repo + tag 分离 ===
function imgBase(img) { if (!img) return ''; const d = img.split('@')[0]; const i = d.lastIndexOf(':'); return i > d.lastIndexOf('/') ? d.slice(0, i) : d }
function imgTag(img) { if (!img) return ''; const d = img.split('@')[0]; const i = d.lastIndexOf(':'); return i > d.lastIndexOf('/') ? d.slice(i + 1) : '' }

// === 快速改镜像版本（仅改 tag，不改 repo） ===
const showImageTagModal = ref(false)
const imageTagForm = ref({ repo: '', oldTag: '', newTag: '' })
const tagLoading = ref(false)
const tagError = ref('')
const availableTags = ref([])
const registryAuth = ref({ username: '', password: '' })
async function fetchTags() {
  const f = imageTagForm.value
  if (!f.repo) return
  tagLoading.value = true; tagError.value = ''
  try {
    const r = await registryApi.tags({ image: `${f.repo}:${f.oldTag || 'latest'}`, username: registryAuth.value.username, password: registryAuth.value.password })
    availableTags.value = r.tags || []
    if (!availableTags.value.length) tagError.value = '该仓库暂无可用 tag'
  } catch (e) {
    tagError.value = e.message || '拉取失败'
    availableTags.value = []
  } finally { tagLoading.value = false }
}
function pickTag(t) { imageTagForm.value.newTag = t }
function openImageTagEditor() {
  const img = workload.value?.image || ''
  imageTagForm.value = { repo: imgBase(img), oldTag: imgTag(img) || 'latest', newTag: imgTag(img) || 'latest' }
  availableTags.value = []
  tagError.value = ''
  registryAuth.value = { username: '', password: '' }
  showImageTagModal.value = true
}
async function saveImageTag() {
  const f = imageTagForm.value
  if (!f.newTag) { notify('error', '版本不能为空'); return }
  const newImage = f.newTag ? `${f.repo}:${f.newTag}` : f.repo
  try {
    // 走 updateWorkload image patch
    store.updateWorkload(route.params.name, route.params.namespace, { image: newImage })
    // 也走 applyWorkloadTemplate 确保 template image 更新
    if (isRolloutType.value && workload.value?.raw?.spec?.template) {
      const tpl = JSON.parse(JSON.stringify(workload.value.raw.spec.template))
      if (tpl.spec?.containers?.[0]) tpl.spec.containers[0].image = newImage
      await store.applyWorkloadTemplate(route.params.name, route.params.namespace, tpl)
    }
    notify('success', `镜像版本已更新为 ${newImage}`)
    showImageTagModal.value = false
  } catch (e) { notify('error', e.message || '更新失败') }
}

// === Deployment 关联事件（最新 5 条，用于 overview 顶部） ===
const deployEvents = computed(() => {
  return (store.nsEvents || [])
    .filter(e => e.involvedObject?.name === route.params.name)
    .slice(0, 5)
})

// === Pod 详细信息：从 raw 提取 lifecycle + containerStatuses ===
function podConditions(p) {
  const raw = p?.raw
  if (!raw) return null
  const conds = raw.status?.conditions || []
  const get = t => conds.find(c => c.type === t)
  return {
    scheduled: get('PodScheduled'),
    initialized: get('Initialized'),
    containersReady: get('ContainersReady'),
    podReady: get('Ready'),
  }
}
function podContainers(p) {
  const raw = p?.raw
  if (!raw) return []
  const specs = raw.spec?.containers || []
  const statuses = raw.status?.containerStatuses || []
  return specs.map(s => {
    const st = statuses.find(x => x.name === s.name) || {}
    return {
      name: s.name,
      image: s.image,
      pullPolicy: s.imagePullPolicy || 'IfNotPresent',
      state: st.state || {},
      ready: st.ready,
      restartCount: st.restartCount || 0,
      started: st.started,
      startTime: st.state?.running?.startedAt || st.state?.terminated?.finishedAt || '',
      ports: (s.ports || []).map(p => `${p.containerPort}/${p.protocol || 'TCP'}`).join(', '),
    }
  })
}
function containerStateText(st) {
  if (!st || typeof st !== 'object') return 'Waiting'
  if (st.running) return { text: 'Running', color: 'text-primary', icon: 'play_circle' }
  if (st.terminated) return { text: st.terminated.reason || 'Terminated', color: st.terminated.exitCode === 0 ? 'text-on-surface-variant' : 'text-error', icon: 'stop_circle' }
  if (st.waiting) return { text: st.waiting.reason || 'Waiting', color: 'text-tertiary-container', icon: 'hourglass_top' }
  return { text: 'Unknown', color: 'text-on-surface-variant', icon: 'help' }
}
function podPhaseColor(phase) {
  return phase === 'Running' ? 'text-primary' : phase === 'Pending' ? 'text-tertiary-container' : phase === 'Failed' ? 'text-error' : 'text-on-surface-variant'
}
function condChip(c) {
  if (!c) return { text: '—', ok: false }
  return { text: c.status === 'True' ? '✓' : c.status === 'False' ? '✗' : '?', ok: c.status === 'True', reason: c.reason || '' }
}

// === 快速操作：日志 / exec / 文件浏览 ===
function viewLogs(p) {
  router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name }, hash: '#logs' })
}
function openExec(p) {
  router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name }, hash: '#exec' })
}
function viewFiles(p) {
  router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name }, hash: '#files' })
}

// === 运行指标 ===
const nsRef = computed(() => route.params.namespace)
const managedPodNames = computed(() => (managedPods.value || []).map(p => p.name))
const { cpuSeries, memSeries, current: metricsNow, available: metricsAvailable, start: startMetrics } = useMetricsHistory(nsRef, managedPodNames)
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

// ============================================================================
// 3 列布局：版本（左） → Pod（中） → Pod 详情（右）
// ============================================================================
// 版本：当前活跃版本默认选中且深色，其余置灰；点击切换 → 中列刷新该版本 Pod
const selectedRev = ref(null)
// 默认/兜底：当前活跃版本
watch(revisions, revs => {
  const cur = revs.find(r => r.current)
  if (!selectedRev.value || !revs.find(r => r.rev === selectedRev.value.rev)) {
    selectedRev.value = cur || revs[0] || null
  } else if (cur && selectedRev.value.rev !== cur.rev) {
    // 保持可被选中其它版本，但若当前选中失效则回到活跃版本
  }
}, { immediate: true })
function selectRev(rev) { selectedRev.value = rev }
// 版本卡片配色：当前活跃版本始终深色（filled），选中加 ring；非活跃未选中置灰
function revCardClass(rev) {
  const sel = selectedRev.value?.rev === rev.rev
  if (rev.current) return sel
    ? 'bg-primary text-on-primary border-primary ring-2 ring-primary/40 shadow-sm'
    : 'bg-primary text-on-primary border-primary'
  if (sel) return 'bg-primary/10 text-on-surface border-primary ring-2 ring-primary/50'
  return 'bg-surface-container-low/60 text-on-surface-variant border-outline-variant opacity-70 hover:opacity-100 hover:bg-surface-container'
}

// Pod → 版本：Pod 的 ownerReferences 指向所属 ReplicaSet，用 rsUid 关联到 revision
function podControllerUid(p) {
  const owners = p?.raw?.metadata?.ownerReferences || []
  const ctrl = owners.find(o => o.controller)
  return ctrl?.uid || ''
}
// 当前活跃版本及其 Pod：中列 Pod 列表始终基于活跃版本；点历史版本只看信息，不动 Pod 选择/右列
const currentRev = computed(() => revisions.value.find(r => r.current) || revisions.value[0] || null)
const currentRevPods = computed(() => {
  const rev = currentRev.value
  if (!rev || !rev.rsUid) return managedPods.value
  return managedPods.value.filter(p => podControllerUid(p) === rev.rsUid)
})

// selectedPod 仅随活跃版本 Pod 变化——切换历史版本时不重置右列详情
const selectedPod = ref(null)
watch(currentRevPods, pods => {
  if (!selectedPod.value || !pods.find(p => p.name === selectedPod.value.name)) {
    selectedPod.value = pods[0] || null
  }
}, { immediate: true })
function selectPod(p) { selectedPod.value = p }

// Pod 健康度：综合 phase + Ready condition + restarts → 颜色 + 标签
function podHealth(p) {
  if (!p) return { level: 'none', text: 'text-on-surface-variant', dot: 'bg-on-surface-variant/40', label: '—' }
  if (p.status === 'Failed') return { level: 'danger', text: 'text-error', dot: 'bg-error', label: '异常' }
  if (p.status === 'Pending' || p.status === 'Unknown') return { level: 'warn', text: 'text-tertiary-container', dot: 'bg-tertiary-container', label: '启动中' }
  const conds = p.raw?.status?.conditions || []
  const ready = conds.find(c => c.type === 'Ready')
  if (ready?.status === 'True' && p.restarts === 0) return { level: 'ok', text: 'text-primary', dot: 'bg-primary', label: '健康' }
  if (p.restarts > 3) return { level: 'warn', text: 'text-tertiary-container', dot: 'bg-tertiary-container', label: '重启多' }
  if (ready?.status !== 'True') return { level: 'warn', text: 'text-tertiary-container', dot: 'bg-tertiary-container', label: '未就绪' }
  return { level: 'ok', text: 'text-primary', dot: 'bg-primary', label: '健康' }
}
// Pod 卡片配色（边框 + 轻底色）
const podCardClass = p => {
  const map = {
    ok: 'border-primary/30 hover:border-primary/60 hover:bg-primary/5',
    warn: 'border-tertiary-container/40 hover:border-tertiary-container/70 hover:bg-tertiary-container/5',
    danger: 'border-error/40 hover:border-error/70 hover:bg-error/5',
    none: 'border-outline-variant hover:bg-surface-container-low/40',
  }
  return map[podHealth(p).level]
}

// === 选中 Pod 的实时指标（独立实例，长窗口支持预设时间窗） ===
const METRIC_WINDOWS = [
  { key: '1m', label: '1m', samples: 12 },
  { key: '5m', label: '5m', samples: 60 },
  { key: '15m', label: '15m', samples: 180 },
]
const metricsWindow = ref('5m')
const podMetricsNames = computed(() => (selectedPod.value ? [selectedPod.value.name] : []))
const { cpuSeries: podCpuSeries, memSeries: podMemSeries, current: podMetricsNow, available: podMetricsAvailable, start: startPodMetrics } = useMetricsHistory(nsRef, podMetricsNames, { max: 180, interval: 5000 })
onMounted(() => { if (store.remoteMode) { startMetrics(); startPodMetrics() } })
// 注意：模板会把 ref 自动解包成数组再传入，所以参数是数组本身（不是 ref）
function windowed(series) {
  const w = METRIC_WINDOWS.find(x => x.key === metricsWindow.value) || METRIC_WINDOWS[1]
  return (series || []).slice(-w.samples)
}
// 选中 Pod 的容器 requests/limits（作为指标参考线）
const podRes = computed(() => {
  const specs = selectedPod.value?.raw?.spec?.containers || []
  const sum = (field, kind) => specs.reduce((t, c) => t + (kind === 'cpu' ? toMilli : toMi)(c.resources?.[field]?.[kind]), 0)
  return { cpuReq: sum('requests', 'cpu'), cpuLim: sum('limits', 'cpu'), memReq: sum('requests', 'memory'), memLim: sum('limits', 'memory') }
})
const podCpuRefLines = computed(() => {
  const r = []
  if (podRes.value.cpuReq) r.push({ label: 'requests', value: podRes.value.cpuReq, color: 'var(--md-sys-color-secondary)' })
  if (podRes.value.cpuLim) r.push({ label: 'limits', value: podRes.value.cpuLim, color: 'var(--md-sys-color-error)' })
  return r
})
const podMemRefLines = computed(() => {
  const r = []
  if (podRes.value.memReq) r.push({ label: 'requests', value: podRes.value.memReq, color: 'var(--md-sys-color-secondary)' })
  if (podRes.value.memLim) r.push({ label: 'limits', value: podRes.value.memLim, color: 'var(--md-sys-color-error)' })
  return r
})
// 选中 Pod 关联事件
const podEvents = computed(() => {
  const name = selectedPod.value?.name
  if (!name) return []
  return (store.nsEvents || []).filter(e => e.involvedObject?.name === name).slice(0, 8)
})

// 端口转发（复用 PortForwardPanel）：以选中 Pod 为目标，候选端口取自其容器端口
const showPortForward = ref(false)
const pfSuggestedPorts = computed(() => {
  const specs = selectedPod.value?.raw?.spec?.containers || []
  const ports = new Set()
  for (const c of specs) for (const p of (c.ports || [])) ports.add(p.containerPort)
  return [...ports]
})
function openPortForward() { if (selectedPod.value) showPortForward.value = true }

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
// 拓扑用：把关联 Ingress 的规则拍平成 {ingress, host, path, serviceName, port}
const topoIngressRules = computed(() => {
  const out = []
  for (const ing of relatedIngresses.value) {
    for (const r of (ing.rules || [])) {
      for (const p of (r.http?.paths || [])) {
        const be = p.backend?.service || p.backend
        out.push({ ingress: ing.name, host: r.host || '*', path: p.path || '/', serviceName: be?.name, port: be?.port?.number || be?.port?.name || be?.servicePort || '' })
      }
    }
  }
  return out
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
        <button v-if="isScalable" @click="openScale" :disabled="!canMutate" :title="!canMutate ? '无 update 权限' : ''" class="px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Scale</button>
        <button @click="handleRestart" :disabled="!canMutate" :title="!canMutate ? '无 update 权限' : ''" class="px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Restart</button>
        <button @click="openEdit" :disabled="!canMutate" :title="!canMutate ? '无 update 权限' : ''" class="px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">Edit</button>
        <button v-if="isRolloutType" @click="openTemplateEditor" :disabled="!canMutate" :title="!canMutate ? '无 update 权限' : ''" class="px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Template</button>
        <button @click="showDeleteModal = true" :disabled="!canDelete" :title="!canDelete ? '无 delete 权限' : ''" class="px-3 py-1.5 text-body-sm font-medium border border-error/30 text-error rounded-lg hover:bg-error/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Delete</button>
      </div>
    </div>

    <!-- ====== Tabs ====== -->
    <div class="flex items-center gap-xs border-b border-outline-variant mb-md">
      <button v-for="tab in (isRolloutType ? ['overview', 'topology', 'network', 'pods', 'revisions', 'yaml', 'events'] : ['overview', 'topology', 'network', 'pods', 'yaml', 'events'])" :key="tab" @click="activeTab = tab"
        class="px-lg py-2 text-body-sm font-medium transition-colors relative"
        :class="activeTab === tab ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'">
        {{ tab }}
        <span v-if="activeTab === tab" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"></span>
      </button>
    </div>

    <!-- ====== Overview Tab（3 列：版本 → Pod → Pod 详情）====== -->
    <div v-if="activeTab === 'overview'" class="flex flex-col gap-md">
      <!-- 副本状态卡 + 滚动发布进度 -->
      <div v-if="rollout" class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
        <div class="flex flex-col lg:flex-row lg:items-center gap-md p-md">
          <!-- 状态徽标 -->
          <div class="flex items-center gap-sm lg:w-[200px] shrink-0">
            <div class="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-white" :class="rollout.meta.dot">
              <span class="material-symbols-outlined text-2xl" :class="rollout.level === 'updating' ? 'animate-spin' : ''">{{ rollout.meta.icon }}</span>
            </div>
            <div class="min-w-0">
              <p class="text-headline-sm font-bold leading-tight" :class="rollout.meta.text">{{ rollout.meta.label }}</p>
              <p class="text-body-xs text-on-surface-variant truncate" :title="rollout.reason">{{ rollout.reason }}</p>
            </div>
          </div>
          <!-- 副本大数字 -->
          <div class="flex items-baseline gap-xs lg:px-md lg:border-x border-outline-variant shrink-0">
            <span class="text-[32px] font-bold font-mono leading-none" :class="rollout.meta.text">{{ rollout.ready }}</span>
            <span class="text-headline-sm text-on-surface-variant/40 font-mono">/ {{ rollout.desired }}</span>
            <span class="text-body-xs text-on-surface-variant ml-1">就绪副本</span>
          </div>
          <!-- 滚动发布进度 -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between mb-1">
              <span class="text-body-xs font-medium text-on-surface">滚动发布</span>
              <span class="text-body-xs text-on-surface-variant">
                <span class="font-mono font-semibold" :class="rollout.level === 'updating' ? 'text-status-succeeded' : 'text-status-running'">{{ rollout.updated }}</span> 新版本
                <template v-if="rollout.oldCount > 0"><span class="text-on-surface-variant/40 mx-0.5">·</span><span class="text-status-pending font-mono">{{ rollout.oldCount }}</span> 旧版本</template>
              </span>
            </div>
            <div class="h-2.5 rounded-full bg-surface-container overflow-hidden flex">
              <div class="h-full transition-all duration-500" :class="rollout.level === 'updating' ? 'bg-status-succeeded' : 'bg-status-running'" :style="{ width: rollout.newW + '%' }"></div>
              <div v-if="rollout.oldCount > 0" class="h-full bg-status-pending transition-all duration-500" :style="{ width: rollout.oldW + '%' }"></div>
            </div>
            <div class="flex items-center gap-md mt-1 text-body-xs text-on-surface-variant">
              <span class="flex items-center gap-0.5"><span class="w-2 h-2 rounded-full" :class="rollout.level === 'updating' ? 'bg-status-succeeded' : 'bg-status-running'"></span>新 {{ rollout.updated }}</span>
              <span v-if="rollout.oldCount > 0" class="flex items-center gap-0.5"><span class="w-2 h-2 rounded-full bg-status-pending"></span>旧 {{ rollout.oldCount }}</span>
              <span class="ml-auto text-on-surface-variant/60">期望 {{ rollout.desired }} · 已创建 {{ rollout.total }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 顶部摘要条 -->
      <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-sm">
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant px-md py-2.5">
          <p class="text-body-xs text-on-surface-variant">{{ replicasLabel }}</p>
          <p class="text-headline-sm font-bold text-on-surface font-mono mt-0.5">{{ workload.replicas }}</p>
        </div>
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant px-md py-2.5">
          <p class="text-body-xs text-on-surface-variant">就绪 Pod</p>
          <p class="text-headline-sm font-bold mt-0.5"><span class="text-primary font-mono">{{ managedPods.filter(p => p.status === 'Running').length }}</span><span class="text-on-surface-variant/40 text-body-md"> / {{ managedPods.length }}</span></p>
        </div>
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant px-md py-2.5">
          <p class="text-body-xs text-on-surface-variant">运行时长</p>
          <p class="text-headline-sm font-bold text-on-surface mt-0.5">{{ workload.age }}</p>
        </div>
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant px-md py-2.5 xl:col-span-2">
          <div class="flex items-center justify-between"><p class="text-body-xs text-on-surface-variant">镜像</p><button v-if="canMutate" @click="openImageTagEditor" class="text-body-xs text-primary hover:underline flex items-center gap-0.5"><span class="material-symbols-outlined text-sm">swap_horiz</span>改版本</button></div>
          <p class="font-mono text-code-sm truncate mt-0.5"><span class="text-on-surface-variant">{{ imgBase(workload.image) }}</span><span class="text-primary font-semibold">:{{ imgTag(workload.image) || 'latest' }}</span></p>
          <div v-if="metricsAvailable" class="flex items-center gap-md mt-1 text-body-xs text-on-surface-variant">
            <span class="flex items-center gap-0.5"><span class="material-symbols-outlined text-sm text-primary">memory</span><b class="text-primary font-mono">{{ metricsNow.cpu }}</b>m</span>
            <span class="flex items-center gap-0.5"><span class="material-symbols-outlined text-sm text-secondary">storage</span><b class="text-secondary font-mono">{{ metricsNow.mem }}</b>Mi</span>
            <span class="text-on-surface-variant/40">实时聚合</span>
          </div>
        </div>
      </div>

      <!-- 3 列主体（非滚动发布类型无版本历史 → 2 列） -->
      <div class="grid grid-cols-1 gap-md items-start"
        :class="isRolloutType && revisions.length ? 'lg:grid-cols-[220px_300px_minmax(0,1fr)]' : 'lg:grid-cols-[300px_minmax(0,1fr)]'">
        <!-- ============ 左列：版本历史 ============ -->
        <div v-if="isRolloutType && revisions.length" class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden flex flex-col lg:max-h-[calc(100vh-210px)] lg:sticky lg:top-2">
          <div class="flex items-center gap-sm px-md py-2.5 border-b border-outline-variant/40">
            <span class="material-symbols-outlined text-primary text-base">history</span>
            <span class="text-body-sm font-semibold text-on-surface">版本历史</span>
            <span class="text-body-xs text-on-surface-variant ml-auto">{{ revisions.length }}</span>
          </div>
          <div class="flex-1 overflow-y-auto p-sm flex flex-col gap-xs">
            <button v-for="rev in revisions" :key="rev.rev" @click="selectRev(rev)"
              class="text-left rounded-lg border transition-all px-sm py-1.5"
              :class="revCardClass(rev)">
              <div class="flex items-center justify-between gap-1">
                <div class="flex items-center gap-1 min-w-0">
                  <span class="text-body-xs font-bold" :class="rev.current ? 'text-on-primary' : 'text-on-surface'">Rev {{ rev.rev }}</span>
                  <span v-if="rev.current" class="px-1 py-px rounded text-[10px] font-bold leading-none" :class="rev.current ? 'bg-on-primary/20 text-on-primary' : ''">活跃</span>
                </div>
                <span class="text-body-xs shrink-0" :class="rev.current ? 'text-on-primary/70' : 'text-on-surface-variant/50'">{{ rev.age }}</span>
              </div>
              <p class="font-mono text-xs truncate mt-0.5" :class="rev.current ? 'text-on-primary/80' : 'text-on-surface-variant'">
                {{ revImgBase(rev.image) }}<span class="font-semibold" :class="rev.current ? 'text-on-primary' : 'text-primary'">:{{ imageTag(rev.image) || 'latest' }}</span>
              </p>
              <div class="flex items-center gap-1.5 mt-1">
                <span class="text-[11px]" :class="rev.current ? 'text-on-primary/70' : 'text-on-surface-variant'">期望<b class="font-mono ml-0.5" :class="rev.current ? 'text-on-primary' : 'text-on-surface'">{{ rev.desiredReplicas ?? '—' }}</b></span>
                <span class="text-[11px]" :class="rev.current ? 'text-on-primary/70' : 'text-on-surface-variant'">当前<b class="font-mono ml-0.5" :class="(rev.replicas ?? 0) >= (rev.desiredReplicas ?? 0) ? (rev.current ? 'text-on-primary' : 'text-primary') : (rev.current ? 'text-on-primary/80' : 'text-tertiary-container')">{{ rev.replicas ?? 0 }}</b></span>
                <span class="text-[11px]" :class="rev.current ? 'text-on-primary/70' : 'text-on-surface-variant'">就绪<b class="font-mono ml-0.5" :class="(rev.readyReplicas ?? 0) >= (rev.desiredReplicas ?? 0) ? (rev.current ? 'text-on-primary' : 'text-primary') : (rev.current ? 'text-on-primary/80' : 'text-error')">{{ rev.readyReplicas ?? 0 }}</b></span>
                <div class="flex items-center gap-1 ml-auto">
                  <button @click.stop="viewRevYaml(rev)" class="p-1 rounded hover:bg-black/10" :class="rev.current ? 'text-on-primary/90 hover:text-on-primary' : 'text-on-surface-variant hover:text-primary'" title="查看 YAML"><span class="material-symbols-outlined text-base">code</span></button>
                  <button v-if="!rev.current" @click.stop="confirmDeleteRev(rev)" class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error" title="删除该版本"><span class="material-symbols-outlined text-base">delete</span></button>
                  <button v-if="!rev.current" @click.stop="confirmRollback(rev)" class="p-1 rounded hover:bg-primary/10 text-primary" title="回滚到此版本"><span class="material-symbols-outlined text-base">undo</span></button>
                </div>
              </div>
            </button>
          </div>
        </div>

        <!-- ============ 中列：活跃版本=Pod 列表 / 历史版本=基础信息 ============ -->
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden flex flex-col lg:max-h-[calc(100vh-210px)] lg:sticky lg:top-2">
          <!-- 活跃版本：Pod 列表 -->
          <template v-if="selectedRev?.current">
            <div class="flex items-center gap-sm px-md py-2.5 border-b border-outline-variant/40">
              <span class="material-symbols-outlined text-primary text-base">view_in_ar</span>
              <span class="text-body-sm font-semibold text-on-surface">Pods</span>
              <span class="text-body-xs text-on-surface-variant">Rev {{ selectedRev.rev }}</span>
              <div class="flex items-center gap-sm ml-auto">
                <span class="text-body-xs text-primary font-medium">{{ currentRevPods.filter(p => p.status === 'Running').length }} 运行</span>
                <span v-if="currentRevPods.filter(p => p.status !== 'Running').length" class="text-body-xs text-tertiary-container">{{ currentRevPods.filter(p => p.status !== 'Running').length }} 异常</span>
              </div>
            </div>
            <div v-if="currentRevPods.length" class="flex-1 overflow-y-auto p-sm flex flex-col gap-xs">
              <button v-for="p in currentRevPods" :key="p.name" @click="selectPod(p)"
                class="text-left rounded-lg border bg-surface-container-lowest px-sm py-2 transition-all"
                :class="[podCardClass(p), selectedPod?.name === p.name ? 'ring-2 ring-primary border-primary/50' : '']">
                <div class="flex items-center gap-sm">
                  <span class="w-2 h-2 rounded-full shrink-0" :class="[podHealth(p).dot, p.status === 'Running' ? 'animate-pulse-status' : '']"></span>
                  <span class="font-mono text-xs font-medium text-on-surface truncate flex-1 min-w-0">{{ p.name }}</span>
                  <span class="text-body-xs shrink-0" :class="podHealth(p).text">{{ podHealth(p).label }}</span>
                </div>
                <div class="flex items-center gap-1.5 mt-1 text-[11px] text-on-surface-variant/70 flex-wrap">
                  <span class="flex items-center gap-0.5" :class="podHealth(p).text"><span class="w-1 h-1 rounded-full" :class="podHealth(p).dot"></span>{{ p.status }}</span>
                  <span v-if="p.restarts > 0" class="flex items-center gap-0.5" :class="p.restarts > 3 ? 'text-error' : 'text-tertiary-container'"><span class="material-symbols-outlined" style="font-size:12px">restart_alt</span>{{ p.restarts }}</span>
                  <span v-if="p.cpu" class="flex items-center gap-0.5 text-primary"><span class="material-symbols-outlined" style="font-size:12px">speed</span>{{ p.cpu.split('/')[0] }}</span>
                  <span v-if="p.memory" class="flex items-center gap-0.5 text-secondary"><span class="material-symbols-outlined" style="font-size:12px">memory</span>{{ p.memory.split('/')[0] }}</span>
                  <span class="font-mono truncate max-w-[110px]" :title="p.node">{{ p.node || '—' }}</span>
                  <span class="ml-auto">{{ p.age }}</span>
                </div>
                <!-- 生命周期简报 -->
                <div v-if="podConditions(p)" class="flex items-center gap-1 mt-1">
                  <template v-for="ck in [{k:'scheduled',l:'调度'},{k:'initialized',l:'初始化'},{k:'containersReady',l:'容器'},{k:'podReady',l:'就绪'}]" :key="ck.k">
                    <span class="flex items-center gap-0.5 text-[10px]" :class="condChip(podConditions(p)[ck.k]).ok ? 'text-primary' : 'text-on-surface-variant/35'">
                      <span class="material-symbols-outlined" style="font-size:11px">{{ condChip(podConditions(p)[ck.k]).ok ? 'check_circle' : 'radio_button_unchecked' }}</span>{{ ck.l }}
                    </span>
                  </template>
                </div>
              </button>
            </div>
            <div v-else class="flex-1 py-md text-center text-body-sm text-on-surface-variant">
              <span class="material-symbols-outlined text-2xl text-surface-container-high">pod</span>
              <p class="mt-xs">该版本暂无 Pod</p>
            </div>
          </template>

          <!-- 历史版本：基础信息（不切换右列 Pod 详情） -->
          <template v-else-if="selectedRev">
            <div class="flex items-center gap-sm px-md py-2.5 border-b border-outline-variant/40">
              <span class="material-symbols-outlined text-on-surface-variant text-base">history</span>
              <span class="text-body-sm font-semibold text-on-surface">历史版本</span>
              <span class="text-body-xs text-on-surface-variant">Rev {{ selectedRev.rev }}</span>
            </div>
            <div class="flex-1 overflow-y-auto p-md flex flex-col gap-sm">
              <div class="rounded-lg bg-surface-container-low p-sm flex flex-col gap-xs">
                <div class="flex items-center justify-between gap-sm">
                  <span class="text-body-xs text-on-surface-variant shrink-0">ReplicaSet</span>
                  <span class="font-mono text-xs text-on-surface truncate" :title="selectedRev.rsName">{{ selectedRev.rsName || '—' }}</span>
                </div>
                <div>
                  <span class="text-body-xs text-on-surface-variant">镜像</span>
                  <p class="font-mono text-xs truncate"><span class="text-on-surface-variant">{{ revImgBase(selectedRev.image) }}</span><span class="text-primary font-semibold">:{{ imageTag(selectedRev.image) || 'latest' }}</span></p>
                </div>
                <div class="grid grid-cols-3 gap-xs text-center pt-xs">
                  <div><p class="text-[10px] text-on-surface-variant/60">期望</p><p class="font-mono text-sm font-bold text-on-surface">{{ selectedRev.desiredReplicas ?? '—' }}</p></div>
                  <div><p class="text-[10px] text-on-surface-variant/60">当前</p><p class="font-mono text-sm font-bold" :class="(selectedRev.replicas ?? 0) > 0 ? 'text-primary' : 'text-on-surface-variant/50'">{{ selectedRev.replicas ?? 0 }}</p></div>
                  <div><p class="text-[10px] text-on-surface-variant/60">就绪</p><p class="font-mono text-sm font-bold" :class="(selectedRev.readyReplicas ?? 0) > 0 ? 'text-status-running' : 'text-error'">{{ selectedRev.readyReplicas ?? 0 }}</p></div>
                </div>
                <div class="flex items-center justify-between text-body-xs pt-xs border-t border-outline-variant/30">
                  <span class="text-on-surface-variant">创建于</span>
                  <span class="text-on-surface">{{ selectedRev.age }}</span>
                </div>
                <div v-if="selectedRev.reason && selectedRev.reason !== '—'" class="flex items-start gap-xs text-body-xs">
                  <span class="material-symbols-outlined text-on-surface-variant shrink-0" style="font-size:14px">change_circle</span>
                  <span class="text-on-surface-variant break-all">{{ selectedRev.reason }}</span>
                </div>
              </div>
              <div class="grid grid-cols-3 gap-xs">
                <button @click="viewRevYaml(selectedRev)" class="flex flex-col items-center gap-0.5 py-1.5 rounded-lg border border-outline-variant text-on-surface-variant hover:text-primary hover:border-primary transition-colors"><span class="material-symbols-outlined text-base">code</span><span class="text-[11px]">YAML</span></button>
                <button @click="confirmRollback(selectedRev)" class="flex flex-col items-center gap-0.5 py-1.5 rounded-lg border border-outline-variant text-on-surface-variant hover:text-primary hover:border-primary transition-colors"><span class="material-symbols-outlined text-base">undo</span><span class="text-[11px]">回滚</span></button>
                <button @click="confirmDeleteRev(selectedRev)" class="flex flex-col items-center gap-0.5 py-1.5 rounded-lg border border-outline-variant text-on-surface-variant hover:text-error hover:border-error transition-colors"><span class="material-symbols-outlined text-base">delete</span><span class="text-[11px]">删除</span></button>
              </div>
              <p class="text-body-xs text-on-surface-variant/50 text-center mt-xs">非活跃版本 · 右侧 Pod 详情保持不变</p>
            </div>
          </template>
        </div>

        <!-- ============ 右列：Pod 详情（事件置顶 → 指标 → 状态[含基础信息]）============ -->
        <div class="flex flex-col gap-sm">
          <template v-if="selectedPod">
            <!-- Pod 事件（置顶） -->
            <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
              <div class="flex items-center justify-between px-md py-2 border-b border-outline-variant/40">
                <div class="flex items-center gap-sm"><span class="material-symbols-outlined text-primary text-base">notifications_active</span><span class="text-body-sm font-semibold">事件</span><span class="text-body-xs text-on-surface-variant">{{ podEvents.length }}</span></div>
              </div>
              <div v-if="podEvents.length" class="divide-y divide-outline-variant/10">
                <div v-for="(e, i) in podEvents" :key="i" class="flex items-start gap-xs px-md py-1.5">
                  <span class="w-1 h-1 rounded-full mt-1.5 shrink-0" :class="e.type === 'warning' ? 'bg-error' : 'bg-primary'"></span>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-xs"><span class="text-body-xs font-medium" :class="e.type === 'warning' ? 'text-error' : 'text-on-surface'">{{ e.reason }}</span><span class="text-body-xs text-on-surface-variant/40">{{ e.age }}</span><span v-if="e.count > 1" class="text-body-xs text-on-surface-variant/40">×{{ e.count }}</span></div>
                    <p class="text-body-xs text-on-surface-variant truncate">{{ e.message }}</p>
                  </div>
                </div>
              </div>
              <p v-else class="px-md py-sm text-body-xs text-on-surface-variant/50 text-center">该 Pod 暂无事件</p>
            </div>

            <!-- 性能指标（预设时间窗） -->
            <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
              <div class="flex items-center justify-between px-md py-2 border-b border-outline-variant/40">
                <div class="flex items-center gap-sm"><span class="material-symbols-outlined text-primary text-base">monitoring</span><span class="text-body-sm font-semibold">性能指标</span></div>
                <div class="flex items-center gap-0.5 bg-surface-container-low rounded-lg p-0.5">
                  <button v-for="w in METRIC_WINDOWS" :key="w.key" @click="metricsWindow = w.key" class="px-2 py-0.5 text-body-xs rounded-md transition-colors" :class="metricsWindow === w.key ? 'bg-primary text-on-primary font-semibold' : 'text-on-surface-variant hover:text-on-surface'">{{ w.label }}</button>
                </div>
              </div>
              <div v-if="podMetricsAvailable" class="grid grid-cols-2 gap-px bg-outline-variant/10">
                <div class="bg-surface-container-lowest p-md">
                  <MiniChart :series="windowed(podCpuSeries)" label="CPU" unit="m" color="var(--md-sys-color-primary)" :ref-lines="podCpuRefLines" :height="80" />
                  <div class="flex items-center gap-sm mt-1 text-body-xs"><span class="text-on-surface-variant"><b class="text-primary font-mono">{{ podMetricsNow.cpu }}</b>m</span><span class="text-on-surface-variant/40">req {{ podRes.cpuReq || '—' }}m</span></div>
                </div>
                <div class="bg-surface-container-lowest p-md">
                  <MiniChart :series="windowed(podMemSeries)" label="Memory" unit="Mi" color="var(--md-sys-color-secondary)" :ref-lines="podMemRefLines" :height="80" />
                  <div class="flex items-center gap-sm mt-1 text-body-xs"><span class="text-on-surface-variant"><b class="text-secondary font-mono">{{ podMetricsNow.mem }}</b>Mi</span><span class="text-on-surface-variant/40">req {{ podRes.memReq || '—' }}Mi</span></div>
                </div>
              </div>
              <div v-else class="py-md text-center"><span class="material-symbols-outlined text-2xl text-surface-container-high">monitoring</span><p class="text-body-sm text-on-surface-variant mt-xs">metrics-server 未就绪</p></div>
            </div>

            <!-- Pod 状态（基础信息集成进卡片头 + 生命周期 + 容器） -->
            <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
              <div class="px-md py-2 border-b border-outline-variant/40">
                <div class="flex items-center gap-sm">
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="podHealth(selectedPod).dot"></span>
                  <div class="min-w-0 flex-1">
                    <p class="font-mono text-body-sm font-semibold text-on-surface truncate">{{ selectedPod.name }}</p>
                    <p class="text-body-xs text-on-surface-variant truncate">{{ selectedPod.ip || '—' }} · {{ selectedPod.node || '—' }} · {{ selectedPod.age }}</p>
                  </div>
                  <span class="text-body-xs px-1.5 py-0.5 rounded font-medium bg-surface-container shrink-0" :class="podHealth(selectedPod).text">{{ podHealth(selectedPod).label }}</span>
                  <div class="flex items-center gap-0.5 shrink-0">
                    <button @click="viewLogs(selectedPod)" class="p-1 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary" title="日志"><span class="material-symbols-outlined text-base">terminal</span></button>
                    <button @click="openExec(selectedPod)" class="p-1 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary" title="终端"><span class="material-symbols-outlined text-base">code</span></button>
                    <button @click="viewFiles(selectedPod)" class="p-1 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary" title="文件"><span class="material-symbols-outlined text-base">folder_open</span></button>
                    <button @click="openPortForward" class="p-1 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary" title="端口转发"><span class="material-symbols-outlined text-base">forward_media</span></button>
                  </div>
                </div>
              </div>
              <div class="p-md flex flex-col gap-md">
                <!-- 生命周期条件 -->
                <div v-if="podConditions(selectedPod)" class="grid grid-cols-2 gap-xs">
                  <template v-for="ck in [{k:'scheduled',l:'已调度'},{k:'initialized',l:'已初始化'},{k:'containersReady',l:'容器就绪'},{k:'podReady',l:'Pod 就绪'}]" :key="ck.k">
                    <div class="flex items-center gap-xs px-sm py-1.5 rounded-lg bg-surface-container-low">
                      <span class="material-symbols-outlined" :class="condChip(podConditions(selectedPod)[ck.k]).ok ? 'text-primary' : 'text-on-surface-variant/40'">{{ condChip(podConditions(selectedPod)[ck.k]).ok ? 'check_circle' : 'radio_button_unchecked' }}</span>
                      <span class="text-body-xs" :class="condChip(podConditions(selectedPod)[ck.k]).ok ? 'text-on-surface' : 'text-on-surface-variant'">{{ ck.l }}</span>
                    </div>
                  </template>
                </div>
                <!-- 容器详情 -->
                <div v-if="podContainers(selectedPod).length" class="flex flex-col gap-xs">
                  <div v-for="c in podContainers(selectedPod)" :key="c.name" class="rounded-lg border border-outline-variant/60 px-sm py-1.5">
                    <div class="flex items-center gap-xs flex-wrap">
                      <span class="material-symbols-outlined text-sm" :class="containerStateText(c.state).color">{{ containerStateText(c.state).icon }}</span>
                      <span class="font-mono text-body-xs font-semibold text-on-surface">{{ c.name }}</span>
                      <span class="text-body-xs" :class="containerStateText(c.state).color">{{ containerStateText(c.state).text }}</span>
                      <span v-if="c.restartCount > 0" class="text-body-xs text-tertiary-container flex items-center gap-0.5"><span class="material-symbols-outlined" style="font-size:12px">restart_alt</span>{{ c.restartCount }}</span>
                      <span v-if="c.startTime" class="text-body-xs text-on-surface-variant/40 ml-auto">{{ c.startTime.slice(0, 19) }}</span>
                    </div>
                    <p class="font-mono text-[11px] truncate mt-0.5"><span class="text-on-surface-variant">{{ imgBase(c.image) }}</span><span class="text-primary font-semibold">:{{ imgTag(c.image) || 'latest' }}</span><span class="text-on-surface-variant/40"> · {{ c.pullPolicy }}<span v-if="c.ports"> · {{ c.ports }}</span></span></p>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- 未选中 Pod 空状态 -->
          <div v-else class="rounded-xl bg-surface-container-lowest border border-dashed border-outline-variant/50 py-xl text-center">
            <span class="material-symbols-outlined text-3xl text-surface-container-high">touch_app</span>
            <p class="text-body-sm text-on-surface-variant mt-xs">从左侧选择一个 Pod 查看详情</p>
          </div>
        </div>
      </div>

      <!-- 底部：Labels + 配置依赖 -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-sm">
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
          <div class="px-md py-2 border-b border-outline-variant/40 flex items-center gap-sm"><span class="material-symbols-outlined text-primary text-base">label</span><span class="text-body-sm font-semibold">Labels</span><span class="text-body-xs text-on-surface-variant ml-auto">{{ Object.keys(workload.labels || {}).length }}</span></div>
          <div class="px-md py-sm flex flex-wrap gap-1">
            <span v-for="(val, key) in (workload.labels || {})" :key="key" class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant"><span class="font-semibold">{{ key }}</span>={{ val }}</span>
            <span v-if="!Object.keys(workload.labels || {}).length" class="text-body-xs text-on-surface-variant/50">无</span>
          </div>
        </div>
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
          <div class="px-md py-2 border-b border-outline-variant/40 flex items-center gap-sm"><span class="material-symbols-outlined text-primary text-base">link</span><span class="text-body-sm font-semibold">配置依赖</span><span class="text-body-xs text-on-surface-variant ml-auto">{{ configRefs.length }}</span></div>
          <div class="px-md py-sm flex flex-wrap gap-xs">
            <span v-for="(ref, idx) in configRefs" :key="idx" @click="router.push({ name: refRoute(ref).name, params: { namespace: route.params.namespace, name: ref.name } })" class="inline-flex items-center gap-xs px-sm py-xs bg-surface-container-low rounded cursor-pointer hover:bg-surface-container transition-colors"><span class="material-symbols-outlined text-sm" :class="ref.kind === 'ConfigMap' ? 'text-secondary' : 'text-tertiary'">{{ ref.kind === 'ConfigMap' ? 'description' : 'key' }}</span><span class="font-mono text-xs font-medium">{{ ref.name }}</span></span>
            <span v-if="!configRefs.length" class="text-body-xs text-on-surface-variant/50">无</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ====== Topology Tab（Ingress → Service → Deployment → Pod）====== -->
    <div v-if="activeTab === 'topology'" class="flex flex-col gap-md">
      <div class="flex items-stretch gap-sm overflow-x-auto pb-sm">
        <!-- 应用路由 / Ingress -->
        <div class="flex-1 min-w-[200px] rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden flex flex-col">
          <div class="px-md py-2 border-b border-outline-variant/40 bg-surface-container-low/40 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">alt_route</span>
            <span class="text-body-sm font-semibold">应用路由</span>
            <span class="text-body-xs text-on-surface-variant ml-auto">{{ topoIngressRules.length }}</span>
          </div>
          <div class="p-sm flex flex-col gap-xs flex-1">
            <div v-for="(r, i) in topoIngressRules" :key="i" @click="router.push({ name: 'NsIngressDetail', params: { namespace: route.params.namespace, name: r.ingress } })" class="cursor-pointer rounded-lg border border-outline-variant/60 px-sm py-1.5 hover:border-primary hover:bg-primary/5 transition-colors">
              <p class="font-mono text-xs text-primary font-semibold truncate">{{ r.host }}<span class="text-on-surface-variant font-normal">{{ r.path }}</span></p>
              <p class="text-[11px] text-on-surface-variant truncate">→ {{ r.serviceName }}<span v-if="r.port">:{{ r.port }}</span></p>
            </div>
            <div v-if="!topoIngressRules.length" class="flex-1 flex flex-col items-center justify-center text-center text-body-xs text-on-surface-variant/50 py-md">
              <span class="material-symbols-outlined text-2xl text-surface-container-high">block</span>未配置 Ingress
            </div>
          </div>
        </div>

        <div class="flex items-center text-on-surface-variant/30 shrink-0"><span class="material-symbols-outlined">arrow_forward</span></div>

        <!-- Service -->
        <div class="flex-1 min-w-[200px] rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden flex flex-col">
          <div class="px-md py-2 border-b border-outline-variant/40 bg-surface-container-low/40 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">hub</span>
            <span class="text-body-sm font-semibold">Service</span>
            <span class="text-body-xs text-on-surface-variant ml-auto">{{ relatedServices.length }}</span>
          </div>
          <div class="p-sm flex flex-col gap-xs flex-1">
            <div v-for="s in relatedServices" :key="s.name" @click="router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: s.name } })" class="cursor-pointer rounded-lg border border-outline-variant/60 px-sm py-1.5 hover:border-primary hover:bg-primary/5 transition-colors">
              <p class="font-mono text-xs text-on-surface font-semibold truncate">{{ s.name }}</p>
              <p class="text-[11px] text-on-surface-variant truncate"><span class="px-1 rounded bg-surface-container">{{ s.type }}</span> {{ s.ports }}</p>
            </div>
            <div v-if="!relatedServices.length" class="flex-1 flex flex-col items-center justify-center text-center text-body-xs text-on-surface-variant/50 py-md">
              <span class="material-symbols-outlined text-2xl text-surface-container-high">block</span>无关联 Service
            </div>
          </div>
        </div>

        <div class="flex items-center text-on-surface-variant/30 shrink-0"><span class="material-symbols-outlined">arrow_forward</span></div>

        <!-- Deployment (self) -->
        <div class="flex-1 min-w-[200px] rounded-xl bg-primary/5 border-2 border-primary/40 overflow-hidden flex flex-col">
          <div class="px-md py-2 border-b border-primary/30 bg-primary/10 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">workspaces</span>
            <span class="text-body-sm font-semibold text-primary">{{ workload.type }}</span>
          </div>
          <div class="p-sm flex flex-col gap-xs">
            <div class="rounded-lg border border-primary/30 bg-surface-container-lowest px-sm py-1.5">
              <p class="font-mono text-xs text-on-surface font-semibold truncate">{{ workload.name }}</p>
              <p class="text-[11px] text-on-surface-variant">{{ workload.replicas }} 副本 · {{ workload.age }}</p>
              <p class="font-mono text-[11px] text-on-surface-variant truncate mt-0.5">{{ imgBase(workload.image) }}<span class="text-primary font-semibold">:{{ imgTag(workload.image) || 'latest' }}</span></p>
            </div>
            <div v-if="configRefs.length" class="mt-1">
              <p class="text-[10px] text-on-surface-variant/60 uppercase tracking-wider mb-0.5">挂载配置</p>
              <div class="flex flex-wrap gap-0.5">
                <span v-for="(ref, idx) in configRefs" :key="idx" @click="router.push({ name: refRoute(ref).name, params: { namespace: route.params.namespace, name: ref.name } })" class="cursor-pointer inline-flex items-center gap-0.5 px-1 py-0.5 bg-surface-container-low rounded text-[11px] hover:bg-surface-container">
                  <span class="material-symbols-outlined" style="font-size:11px">{{ ref.kind === 'ConfigMap' ? 'description' : 'key' }}</span>{{ ref.name }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="flex items-center text-on-surface-variant/30 shrink-0"><span class="material-symbols-outlined">arrow_forward</span></div>

        <!-- Pods -->
        <div class="flex-1 min-w-[220px] rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden flex flex-col">
          <div class="px-md py-2 border-b border-outline-variant/40 bg-surface-container-low/40 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">view_in_ar</span>
            <span class="text-body-sm font-semibold">Pods</span>
            <span class="text-body-xs text-on-surface-variant ml-auto">{{ managedPods.length }}</span>
          </div>
          <div class="p-sm flex flex-col gap-xs flex-1 max-h-[340px] overflow-y-auto">
            <div v-for="p in managedPods" :key="p.name" @click="router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } })" class="cursor-pointer flex items-center gap-xs rounded-lg border border-outline-variant/60 px-sm py-1 hover:border-primary hover:bg-primary/5 transition-colors">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="podHealth(p).dot"></span>
              <span class="font-mono text-[11px] text-on-surface truncate flex-1">{{ p.name }}</span>
              <span class="text-[11px] shrink-0" :class="podHealth(p).text">{{ podHealth(p).label }}</span>
            </div>
            <div v-if="!managedPods.length" class="flex-1 flex flex-col items-center justify-center text-center text-body-xs text-on-surface-variant/50 py-md">
              <span class="material-symbols-outlined text-2xl text-surface-container-high">pod</span>无运行实例
            </div>
          </div>
        </div>
      </div>

      <!-- 流量说明 -->
      <div class="rounded-xl bg-surface-container-low border border-outline-variant/60 p-md flex items-start gap-sm">
        <span class="material-symbols-outlined text-on-surface-variant text-base mt-0.5">info</span>
        <p class="text-body-xs text-on-surface-variant">
          流量路径：<b class="text-on-surface">外部请求</b> → <b class="text-on-surface">Ingress</b>（域名/路径）→ <b class="text-on-surface">Service</b>（经 selector）→ <b class="text-primary">{{ workload.type }}</b> 副本 <b class="text-on-surface">Pod</b>。
          <span v-if="!relatedServices.length" class="text-tertiary-container">当前无关联 Service，外部无法访问——可到「Network」Tab 暴露端口。</span>
        </p>
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
    <div v-if="activeTab === 'yaml'"><YamlEditor :model-value="yaml" :readonly="false" height="560px" @save="onYamlSave" /></div>

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

  <!-- 快速改镜像版本（支持从 registry 拉取可用 tag） -->
  <Modal v-model="showImageTagModal" title="修改镜像版本" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">镜像仓库（不可改）</label>
        <input :value="imageTagForm.repo" readonly class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono opacity-60" />
      </div>
      <details class="rounded-lg border border-outline-variant/60">
        <summary class="cursor-pointer px-md py-sm text-body-xs text-on-surface-variant flex items-center gap-xs"><span class="material-symbols-outlined text-sm">lock</span>Registry 认证（私有仓库可选）</summary>
        <div class="grid grid-cols-2 gap-sm px-md pb-md">
          <input v-model="registryAuth.username" placeholder="用户名" class="bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-body-sm font-mono" />
          <input v-model="registryAuth.password" type="password" placeholder="密码" class="bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-body-sm font-mono" />
        </div>
      </details>
      <div>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-body-xs text-on-surface-variant">版本 Tag</label>
          <button @click="fetchTags" :disabled="tagLoading" class="text-body-xs text-primary hover:underline flex items-center gap-0.5 disabled:opacity-50">
            <span class="material-symbols-outlined text-sm" :class="tagLoading ? 'animate-spin' : ''">{{ tagLoading ? 'progress_activity' : 'cloud_download' }}</span>{{ tagLoading ? '拉取中' : '拉取可用版本' }}
          </button>
        </div>
        <input v-model="imageTagForm.newTag" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="v3.5.1" @keydown.enter="saveImageTag" />
        <div v-if="availableTags.length" class="flex flex-wrap gap-1 mt-sm max-h-32 overflow-y-auto p-xs bg-surface-container-low/40 rounded-lg">
          <button v-for="t in availableTags" :key="t" @click="pickTag(t)" class="px-1.5 py-0.5 rounded text-xs font-mono border transition-colors" :class="imageTagForm.newTag === t ? 'bg-primary text-on-primary border-primary font-semibold' : 'bg-surface-container-lowest text-on-surface border-outline-variant hover:border-primary'">{{ t }}</button>
        </div>
        <p v-if="tagError" class="text-body-xs text-error mt-xs flex items-center gap-0.5"><span class="material-symbols-outlined text-sm">error</span>{{ tagError }}</p>
      </div>
      <p class="text-body-xs text-on-surface-variant">新镜像：<span class="font-mono text-primary break-all">{{ imageTagForm.repo }}:{{ imageTagForm.newTag || '?' }}</span></p>
    </div>
    <template #actions>
      <button @click="showImageTagModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
      <button @click="saveImageTag" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">更新</button>
    </template>
  </Modal>

  <!-- 端口转发（选中 Pod） -->
  <PortForwardPanel v-model="showPortForward" kind="Pod" :name="selectedPod?.name || ''" :namespace="route.params.namespace" :suggested-ports="pfSuggestedPorts" />

  <!-- YAML 变更 diff 预览 -->
  <Modal v-model="showDiffModal" title="变更预览 · Diff" width="max-w-3xl">
    <p v-if="!diffStat.add && !diffStat.del" class="text-body-sm text-on-surface-variant py-md text-center">无变更</p>
    <template v-else>
      <div class="flex items-center gap-md mb-sm text-body-xs">
        <span class="text-status-running font-mono">+{{ diffStat.add }}</span>
        <span class="text-error font-mono">-{{ diffStat.del }}</span>
        <span class="text-on-surface-variant">行变更，确认后 Apply 到集群</span>
      </div>
      <div class="rounded-lg overflow-hidden border border-outline-variant max-h-[55vh] overflow-y-auto bg-[#0b1c30] font-mono text-code-sm">
        <div v-for="(l, i) in diffLines" :key="i" class="flex items-start" :class="l.t === 'add' ? 'bg-status-running/15' : l.t === 'del' ? 'bg-error/15' : ''">
          <span class="w-6 text-center select-none shrink-0" :class="l.t === 'add' ? 'text-status-running' : l.t === 'del' ? 'text-error' : 'text-on-surface-variant/30'">{{ l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' ' }}</span>
          <span class="px-sm whitespace-pre" :class="l.t === 'add' ? 'text-status-running' : l.t === 'del' ? 'text-error' : 'text-surface-variant/80'">{{ l.v || ' ' }}</span>
        </div>
      </div>
    </template>
    <template #actions>
      <button @click="showDiffModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
      <button @click="confirmApplyYaml" :disabled="!diffStat.add && !diffStat.del" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">Apply</button>
    </template>
  </Modal>
</template>
