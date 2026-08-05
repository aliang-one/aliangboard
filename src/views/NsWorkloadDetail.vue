<script setup>
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { cronJobApi, api, execStream, podFileApi, registryApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import { useResourceApply } from '@/composables/useResourceApply'
import { TIER_OPTIONS } from '@/composables/useLayering'
import { useMetricsHistory, toMilli, toMi } from '@/composables/useMetricsHistory'
import { readMeta, imageTag } from '@/composables/useBusinessMeta'
import { recordTagUsage } from '@/composables/useTagHistory'
import { podHealth, podConditions, condChip, podNameDisplay, podContainers } from '@/composables/usePod'
import { dump as yamlDump } from 'js-yaml'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import PodCard from '@/components/common/PodCard.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import MiniChart from '@/components/common/MiniChart.vue'
import PortForwardPanel from '@/components/common/PortForwardPanel.vue'
import FileBrowser from '@/components/common/FileBrowser.vue'
import EnvSourceField from '@/components/common/EnvSourceField.vue'
import VolumeMountCard from '@/components/common/VolumeMountCard.vue'
import TagInput from '@/components/common/TagInput.vue'
import { useTerminalStore } from '@/stores/terminals'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const termStore = useTerminalStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const workload = computed(() => store.getWorkloadByName(route.params.name, route.params.namespace))
const managedPods = computed(() => store.getWorkloadPods(route.params.name, route.params.namespace))

// Pods Tab：状态过滤 + 计数
const podFilter = ref('All')
const podStatusCounts = computed(() => {
  const c = { Running: 0, Pending: 0, Failed: 0, Other: 0 }
  for (const p of managedPods.value) {
    if (p.status === 'Running') c.Running++
    else if (p.status === 'Pending') c.Pending++
    else if (p.status === 'Failed') c.Failed++
    else c.Other++
  }
  return c
})
const filteredPods = computed(() => {
  const f = podFilter.value
  if (f === 'All') return managedPods.value
  if (f === 'Other') return managedPods.value.filter(p => !['Running', 'Pending', 'Failed'].includes(p.status))
  return managedPods.value.filter(p => p.status === f)
})
function goPodDetail(p) {
  router.push({ name: 'NsPodDetail', params: { namespace: p.namespace || route.params.namespace, name: p.name } })
}

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
  if (edited === workloadYaml.value) { notify('info', '内容未变更'); return }
  pendingYaml.value = edited
  diffLines.value = lineDiff(workloadYaml.value, edited)
  showDiffModal.value = true
}
async function confirmApplyYaml() {
  try {
    await applyYaml(pendingYaml.value)
    showDiffModal.value = false
    // workloadYaml 是 computed(workload.raw)，列表刷新后自动重算，无需手动 reload
  } catch { /* applyYaml 内部已 notify */ }
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
// === YAML：直接用列表已返回的完整对象（workload.raw）dump，无需再发请求；
//     mock 工作负载无 raw，回退 generateYAML 合成。raw 变化（Apply 后刷新列表）自动重算。===
const workloadYaml = computed(() => {
  const w = workload.value
  if (!w) return ''
  if (w.raw) {
    const clone = JSON.parse(JSON.stringify(w.raw))
    if (clone?.metadata) delete clone.metadata.managedFields
    if (clone?.status) delete clone.status
    return yamlDump(clone)
  }
  return store.generateYAML('deployment', w)
})
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
  if (!wl) return null
  // mock / 无 raw：从扁平 replicas 字段合成状态，避免概览卡缺失
  if (!wl.raw) {
    const desired = Number(wl.replicas?.split('/')[1]) || 1
    const ready = Number(wl.replicas?.split('/')[0]) || 0
    const level = ready >= desired && desired > 0 ? 'healthy' : ready === 0 ? 'failed' : 'warning'
    const reason = ready >= desired ? '所有副本就绪' : ready === 0 ? '副本均未就绪，检查事件/日志' : `${ready}/${desired} 副本就绪`
    return { desired, updated: ready, ready, total: ready, oldCount: 0, level, reason, newW: 100, oldW: 0, meta: STATUS_META[level] }
  }
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
    refreshSoon()
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
  return (store.nsEvents || []).filter(e => names.has(e.relatedName)).slice(0, 5)
}
const showRevYamlModal = ref(false)
const revYamlContent = ref('')
const revYamlTitle = ref('')
function viewRevYaml(rev) {
  revYamlTitle.value = `Rev ${rev.rev} · ${rev.rsName || ''}`
  if (rev._template) {
    revYamlContent.value = yamlDump(rev._template)
  } else {
    // mock / 无 template：按该版本镜像合成 Pod 模板，避免编辑器空白
    const desired = Number(workload.value?.replicas?.split('/')[1]) || 1
    revYamlContent.value = yamlDump({
      metadata: { labels: { app: workload.value?.name, 'pod-template-hash': String(rev.rev) } },
      spec: { replicas: desired, containers: [{ name: workload.value?.name, image: rev.image }] },
    })
  }
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
function handleRestart() { store.restartWorkload(route.params.name, route.params.namespace); refreshSoon() }

// 刷新：重新拉取工作负载/Pod/事件（部署中状态不会自动变，需手动或删除 Pod 触发）
const refreshing = ref(false)
async function refresh() {
  refreshing.value = true
  try { await store.hydrateCoreResources() } catch (e) { notify('error', e.message || '刷新失败') }
  finally { refreshing.value = false }
}
// 模板变更（镜像/回滚/重启/深编辑）后延时静默刷新：等控制器创建新 ReplicaSet，再重取 workloads + replicasets(历史版本) + pods，
// 否则 Overview 与 Revisions 仍停留在旧版本
function refreshSoon() { setTimeout(() => { store.hydrateCoreResources({ silent: true }).catch(() => {}) }, 1500) }

// 部署中自动刷新：rollout 非健康时每 5s 静默轻量刷新（不闪加载条），恢复健康后停止
let autoTimer = null
function stopAutoRefresh() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null } }
function startAutoRefresh() {
  if (autoTimer || !store.remoteMode) return
  autoTimer = setInterval(async () => {
    if (!rollout.value || rollout.value.level === 'healthy') { stopAutoRefresh(); return }
    try { await store.hydrateCoreResources({ silent: true, lite: true }) } catch { /* 忽略 */ }
  }, 5000)
}
watch(() => rollout.value?.level, lvl => { if (lvl && lvl !== 'healthy') startAutoRefresh(); else stopAutoRefresh() }, { immediate: true })
onUnmounted(stopAutoRefresh)

// 删除 Pod（Deployment 控制器会立即重建 → 触发重新拉镜像；用于镜像补传后卡在 PullImage 的 Pod）
const showDeletePodModal = ref(false)
const deletePodTarget = ref(null)
function confirmDeletePod(p) { deletePodTarget.value = p; showDeletePodModal.value = true }
async function handleDeletePod() {
  const p = deletePodTarget.value
  if (!p) return
  try {
    await store.deletePod(p.name, p.namespace || route.params.namespace)
    notify('success', `已删除 Pod ${p.name}，控制器将重建并重新拉镜像`)
    showDeletePodModal.value = false
    deletePodTarget.value = null
    setTimeout(() => refresh(), 1500) // 重建后刷新看到新 Pod
  } catch (e) { notify('error', e.message || '删除 Pod 失败') }
}

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
// 快速伸缩 ±1：直接 scaleWorkload（可缩到 0；非 scalable 类型不显示）
const scaling = ref(false)
async function quickScale(delta) {
  const cur = rollout.value?.desired ?? parseInt(String(workload.value?.replicas || '0').split('/')[1] || '1', 10)
  const next = Math.max(0, (cur || 0) + delta)
  if (next === cur) return
  scaling.value = true
  try { await store.scaleWorkload(route.params.name, route.params.namespace, next) }
  catch (e) { notify('error', e.message || '伸缩失败') }
  finally { scaling.value = false }
}

// === 容器 ===
const containers = computed(() => {
  const raw = workload.value?.raw
  if (!raw) {
    // mock / 无 raw：从扁平字段合成单容器，避免容器区空白
    const w = workload.value || {}
    return w.image ? [{ name: w.name, image: w.image }] : []
  }
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
    refreshSoon()
  } catch (e) { notify('error', e.message || '更新失败') }
}

// === Deployment 关联事件（最新 5 条） ===
const deployEvents = computed(() => workloadEvents.value.slice(0, 5))

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

// === 快速操作：日志 / exec / 文件浏览 ===
function viewLogs(p) {
  router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name }, hash: '#logs' })
}
function openExec(p) {
  // 打开浮动终端窗口（不再跳转 PodDetail）
  termStore.openTerminal({
    namespace: route.params.namespace,
    podName: p.name,
    container: p.containers?.[0] || 'main',
  })
}
function viewFiles() {
  if (!selectedPod.value) return
  showFileBrowser.value = true
}
// 文件浏览器（Modal，复用 FileBrowser 组件）
const showFileBrowser = ref(false)
const fileBrowserContainer = computed(() => selectedPod.value?.containers?.[0] || selectedPod.value?.raw?.spec?.containers?.[0]?.name || '')

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
  if (sel) return 'bg-primary/10 text-on-surface border-primary ring-2 ring-primary/50 shadow-sm'
  return 'bg-surface-container-low text-on-surface-variant border-outline-variant hover:border-primary/50 hover:bg-surface-container'
}
// 历史版本「就绪」着色：满=绿、部分=琥珀、0=灰（历史缩容到 0 属正常，不报红）
function revReadyClass(rev) {
  if (rev.current) return 'text-on-primary'
  const desired = rev.desiredReplicas ?? 0
  const ready = rev.readyReplicas ?? 0
  if (desired > 0 && ready >= desired) return 'text-status-running'
  if (ready > 0) return 'text-tertiary-container'
  return 'text-on-surface-variant/50'
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

// === 选中 Pod 的实时指标（独立实例，长窗口支持预设时间窗） ===
const METRIC_WINDOWS = [
  { key: '1m', label: '1m', samples: 12 },
  { key: '5m', label: '5m', samples: 60 },
  { key: '15m', label: '15m', samples: 180 },
]
const metricsWindow = ref('5m')
const podMetricsNames = computed(() => (selectedPod.value ? [selectedPod.value.name] : []))
const { cpuSeries: podCpuSeries, memSeries: podMemSeries, current: podMetricsNow, available: podMetricsAvailable, start: startPodMetrics } = useMetricsHistory(nsRef, podMetricsNames, { max: 180, interval: 5000 })
// 按需装载：Job/CronJob 不在批量 hydrate 的 workloadList 里，直接进入详情页时拉取补齐
const KIND_FROM_TYPE = { deployment: 'Deployment', statefulset: 'StatefulSet', daemonset: 'DaemonSet', job: 'Job', cronjob: 'CronJob' }
async function ensureWorkload() {
  if (!store.remoteMode || workload.value) return
  const kind = KIND_FROM_TYPE[route.params.type]
  if (!kind) return
  try { await store.fetchWorkload(kind, route.params.name, route.params.namespace) }
  catch { /* 找不到则静默，页面 v-if=workload 自然显示空 */ }
}
watch(() => [route.params.type, route.params.name, route.params.namespace], () => ensureWorkload())
onMounted(() => { if (store.remoteMode) { startMetrics(); startPodMetrics(); ensureWorkload() } })
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
// 工作负载范围内的事件：Deployment + 其 ReplicaSet + 受管 Pod（按时间倒序）。
// 事件对象经 mapEvent 规范化后用 relatedName/relatedKind（无 involvedObject），按此过滤。
const workloadEvents = computed(() => {
  const wlName = route.params.name
  const rsNames = new Set((revisions.value || []).map(r => r.rsName).filter(Boolean))
  const podNames = new Set((managedPods.value || []).map(p => p.name))
  return (store.nsEvents || [])
    .filter(e => e.relatedName === wlName || rsNames.has(e.relatedName) || podNames.has(e.relatedName))
    .sort((a, b) => (b._ts || 0) - (a._ts || 0))
})
// 事件配色（mapEvent 给的 color：error/tertiary/primary/surface → 状态色）
const EVENT_BG = { error: 'bg-error', tertiary: 'bg-status-pending', primary: 'bg-status-running', surface: 'bg-on-surface-variant' }
const EVENT_TEXT = { error: 'text-error', tertiary: 'text-status-pending', primary: 'text-status-running', surface: 'text-on-surface-variant' }
const eventBg = e => EVENT_BG[e.color] || EVENT_BG.surface
const eventText = e => EVENT_TEXT[e.color] || EVENT_TEXT.surface

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
  // 默认名避重：支持连续多次「+」创建多个 Service（一个 workload 多 service）
  const existing = new Set(relatedServices.value.map(s => s.name))
  let name = `${base}-svc`, n = 2
  while (existing.has(name)) name = `${base}-svc-${n++}`
  exposeForm.value = { name, type: 'ClusterIP', ports: containerPorts.value.length ? containerPorts.value.map(p => ({ port: p.port, targetPort: p.port, protocol: p.protocol })) : [{ port: 80, targetPort: 8080, protocol: 'TCP' }] }
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

// === Edit（结构化深编辑：与创建 DeployApp 字段对齐）===
// 主容器探针 → 表单
function probeToForm(p, def) {
  const f = { enabled: !!p, type: 'http', httpPath: def.httpPath, port: def.port, execCommand: '', initialDelaySeconds: 30, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 }
  if (!p) return f
  if (p.httpGet) { f.type = 'http'; f.httpPath = p.httpGet.path ?? def.httpPath; f.port = p.httpGet.port ?? def.port }
  else if (p.tcpSocket) { f.type = 'tcp'; f.port = p.tcpSocket.port ?? def.port }
  else if (p.exec) { f.type = 'exec'; f.execCommand = (p.exec.command || []).join(' ') }
  f.initialDelaySeconds = p.initialDelaySeconds ?? 30; f.periodSeconds = p.periodSeconds ?? 10
  f.timeoutSeconds = p.timeoutSeconds ?? 1; f.failureThreshold = p.failureThreshold ?? 3; f.successThreshold = p.successThreshold ?? 1
  return f
}
// 容器安全上下文 → 表单
function scToForm(sc) {
  const f = { enabled: !!sc, privileged: false, runAsUser: '', runAsGroup: '', runAsNonRoot: false, readOnlyRootFilesystem: false, addCaps: '', dropCaps: '' }
  if (!sc) return f
  f.privileged = !!sc.privileged
  if (sc.runAsUser != null) f.runAsUser = String(sc.runAsUser)
  if (sc.runAsGroup != null) f.runAsGroup = String(sc.runAsGroup)
  f.runAsNonRoot = !!sc.runAsNonRoot
  f.readOnlyRootFilesystem = !!sc.readOnlyRootFilesystem
  if (sc.capabilities) { f.addCaps = (sc.capabilities.add || []).join(','); f.dropCaps = (sc.capabilities.drop || []).join(',') }
  return f
}
// init/sidecar 容器 → 表单
function containerToForm(c) {
  return { name: c.name || '', image: c.image || '', command: (c.command || []).join(' '), args: (c.args || []).join(' '),
    cpuReq: c.resources?.requests?.cpu || '', cpuLim: c.resources?.limits?.cpu || '', memReq: c.resources?.requests?.memory || '', memLim: c.resources?.limits?.memory || '' }
}
// 合并 volumes（pod spec）与各容器 volumeMounts → 表单条目（带 target/items，支持多容器挂载）
function mergeVolumes(tplSpec, c0) {
  const byKey = new Map()
  const volDefByName = new Map()
  ;(tplSpec.volumes || []).forEach(v => {
    const d = { type: 'emptyDir', pvcName: '', hostPath: '', cmName: '', secretName: '', items: (v.configMap?.items || v.secret?.items || []).map(it => ({ key: it.key || '', path: it.path || '' })) }
    if (v.persistentVolumeClaim) { d.type = 'pvc'; d.pvcName = v.persistentVolumeClaim.claimName }
    else if (v.hostPath) { d.type = 'hostPath'; d.hostPath = v.hostPath.path }
    else if (v.configMap) { d.type = 'configMap'; d.cmName = v.configMap.name }
    else if (v.secret) { d.type = 'secret'; d.secretName = v.secret.secretName }
    volDefByName.set(v.name, d)
  })
  const push = (target, m) => {
    const d = volDefByName.get(m.name) || { type: 'emptyDir', pvcName: '', hostPath: '', cmName: '', secretName: '', items: [] }
    byKey.set(`${target}|${m.name}|${m.mountPath || ''}`, {
      name: m.name, target, type: d.type, mountPath: m.mountPath || '', subPath: m.subPath || '', readOnly: !!m.readOnly,
      pvcName: d.pvcName, hostPath: d.hostPath, cmName: d.cmName, secretName: d.secretName, items: d.items.map(it => ({ ...it })),
    })
  }
  ;(c0.volumeMounts || []).forEach(m => push('main', m))
  ;(tplSpec.initContainers || []).forEach((c, i) => (c.volumeMounts || []).forEach(m => push(`init:${i}`, m)))
  ;((tplSpec.containers || []).slice(1)).forEach((c, i) => (c.volumeMounts || []).forEach(m => push(`sidecar:${i}`, m)))
  // 只定义未挂载的卷也保留（挂到主容器占位）
  volDefByName.forEach((d, name) => {
    if (![...byKey.values()].some(e => e.name === name)) byKey.set(`main|${name}|`, { name, target: 'main', type: d.type, mountPath: '', subPath: '', readOnly: false, pvcName: d.pvcName, hostPath: d.hostPath, cmName: d.cmName, secretName: d.secretName, items: d.items.map(it => ({ ...it })) })
  })
  return [...byKey.values()]
}
// 卷挂载目标 + PVC 候选
const containerTargets = computed(() => {
  const t = [{ value: 'main', label: '主容器' }]
  ;(editForm.value.initContainers || []).forEach((c, i) => { if (c.image) t.push({ value: `init:${i}`, label: `Init: ${c.name || '#' + i}` }) })
  ;(editForm.value.extraContainers || []).forEach((c, i) => { if (c.image) t.push({ value: `sidecar:${i}`, label: `Sidecar: ${c.name || '#' + i}` }) })
  return t
})
const availablePVCs = computed(() => (store.pvcList || []).filter(p => p.namespace === route.params.namespace).map(p => p.name))
function addVolumeMount() {
  editForm.value.volumeMounts.push({ name: genVolName(), target: 'main', type: 'emptyDir', mountPath: '', subPath: '', readOnly: false, pvcName: '', hostPath: '', cmName: '', secretName: '', items: [] })
}
// 卷名是 pod 卷↔容器挂载的关联键（必填），但用户不需要关心 → 添加时自动生成
function genVolName() { return 'vol-' + Math.random().toString(36).slice(2, 8) }
function openEdit() {
  if (!workload.value) return
  const raw = workload.value?.raw || {}
  const tplSpec = raw.spec?.template?.spec || raw.spec?.jobTemplate?.spec?.template?.spec || {}
  const c0 = tplSpec.containers?.[0] || {}
  editForm.value = {
    // 基本
    imageRepo: imgBase(workload.value.image),
    imageTag: imgTag(workload.value.image) || 'latest',
    replicas: workload.value.replicas?.split('/')[1] || '1',
    schedule: workload.value.schedule || '',
    labels: { ...workload.value.labels },
    tier: workload.value.tier || 'default',
    // 主容器
    imagePullPolicy: c0.imagePullPolicy || 'IfNotPresent',
    command: (c0.command || []).join(' '),
    args: (c0.args || []).join(' '),
    workingDir: c0.workingDir || '',
    cpuReq: c0.resources?.requests?.cpu || '', cpuLim: c0.resources?.limits?.cpu || '',
    memReq: c0.resources?.requests?.memory || '', memLim: c0.resources?.limits?.memory || '',
    ports: (c0.ports || []).map(p => ({ containerPort: p.containerPort, protocol: p.protocol || 'TCP' })),
    // 环境变量（普通 + ConfigMap/Secret 引用 + envFrom）
    env: (c0.env || []).filter(e => e.value !== undefined && e.valueFrom === undefined).map(e => ({ key: e.name, value: e.value })),
    envCMKeys: (c0.env || []).filter(e => e.valueFrom?.configMapKeyRef).map(e => ({ name: e.name, cmName: e.valueFrom.configMapKeyRef.name, key: e.valueFrom.configMapKeyRef.key })),
    envSecretKeys: (c0.env || []).filter(e => e.valueFrom?.secretKeyRef).map(e => ({ name: e.name, secretName: e.valueFrom.secretKeyRef.name, key: e.valueFrom.secretKeyRef.key })),
    envFromConfigMap: c0.envFrom?.find(e => e.configMapRef)?.configMapRef?.name || '',
    envFromSecret: c0.envFrom?.find(e => e.secretRef)?.secretRef?.name || '',
    // 探针（三种 × 全时序）
    liveness: probeToForm(c0.livenessProbe, { httpPath: '/health', port: 8080 }),
    readiness: probeToForm(c0.readinessProbe, { httpPath: '/ready', port: 8080 }),
    startup: probeToForm(c0.startupProbe, { httpPath: '/', port: 8080 }),
    // 卷与挂载
    volumeMounts: mergeVolumes(tplSpec, c0),
    // 安全上下文 + 生命周期
    securityContext: scToForm(c0.securityContext),
    lifecycle: { postStart: (c0.lifecycle?.postStart?.exec?.command || []).join(' '), preStop: (c0.lifecycle?.preStop?.exec?.command || []).join(' ') },
    // 多容器
    initContainers: (tplSpec.initContainers || []).map(containerToForm),
    extraContainers: (tplSpec.containers || []).slice(1).map(containerToForm),
    // 调度（pod spec）
    nodeSelectors: Object.entries(tplSpec.nodeSelector || {}).map(([key, value]) => ({ key, value: String(value) })),
    tolerations: (tplSpec.tolerations || []).map(t => ({ key: t.key || '', operator: t.operator || 'Equal', value: t.value || '', effect: t.effect || '' })),
    serviceAccountName: tplSpec.serviceAccountName || '',
    priorityClassName: tplSpec.priorityClassName || '',
    imagePullSecrets: tplSpec.imagePullSecrets?.[0]?.name || '',
    // 更新策略（Deployment spec）
    strategy: raw.spec?.strategy?.type || 'RollingUpdate',
    maxSurge: raw.spec?.strategy?.rollingUpdate?.maxSurge ?? '25%',
    maxUnavailable: raw.spec?.strategy?.rollingUpdate?.maxUnavailable ?? '25%',
    revisionHistoryLimit: raw.spec?.revisionHistoryLimit ?? 10,
  }
  showEditModal.value = true
}

// ---- 正向映射辅助（表单 → k8s 对象；空值置 null 以便 merge-patch 删除）----
function splitCsv(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean) }
function splitSpace(s) { return String(s || '').split(/\s+/).filter(Boolean) }
function buildResources(cpuReq, cpuLim, memReq, memLim) {
  const req = {}, lim = {}
  if (cpuReq) req.cpu = cpuReq; if (memReq) req.memory = memReq
  if (cpuLim) lim.cpu = cpuLim; if (memLim) lim.memory = memLim
  const r = {}
  if (Object.keys(req).length) r.requests = req
  if (Object.keys(lim).length) r.limits = lim
  return Object.keys(r).length ? r : null
}
function buildProbe(p) {
  if (!p || !p.enabled) return null
  const o = { initialDelaySeconds: Number(p.initialDelaySeconds) || 0, periodSeconds: Number(p.periodSeconds) || 10, timeoutSeconds: Number(p.timeoutSeconds) || 1, failureThreshold: Number(p.failureThreshold) || 3, successThreshold: Number(p.successThreshold) || 1 }
  if (p.type === 'http') o.httpGet = { path: p.httpPath || '/', port: Number(p.port) || 8080 }
  else if (p.type === 'tcp') o.tcpSocket = { port: Number(p.port) || 8080 }
  else if (p.type === 'exec') o.exec = { command: splitSpace(p.execCommand) }
  return o
}
function buildSc(s) {
  if (!s || !s.enabled) return null
  const o = {}
  if (s.privileged) o.privileged = true
  if (s.runAsUser !== '') o.runAsUser = Number(s.runAsUser)
  if (s.runAsGroup !== '') o.runAsGroup = Number(s.runAsGroup)
  if (s.runAsNonRoot) o.runAsNonRoot = true
  if (s.readOnlyRootFilesystem) o.readOnlyRootFilesystem = true
  const add = splitCsv(s.addCaps), drop = splitCsv(s.dropCaps)
  if (add.length || drop.length) o.capabilities = { ...(add.length ? { add } : {}), ...(drop.length ? { drop } : {}) }
  return Object.keys(o).length ? o : null
}
// 按 target 取该容器的 volumeMounts（含 subPath/readOnly）
function mountObjs(target, f) {
  const ms = (f.volumeMounts || []).filter(v => v.target === target && v.name && v.mountPath).map(m => { const o = { name: m.name, mountPath: m.mountPath }; if (m.subPath) o.subPath = m.subPath; if (m.readOnly) o.readOnly = true; return o })
  return ms.length ? ms : null
}
function buildSubContainer(c, target, f) {
  const o = { name: c.name || (c.image || '').split(':')[0] || 'container', image: c.image || '' }
  const cmd = splitSpace(c.command), args = splitSpace(c.args)
  if (cmd.length) o.command = cmd
  if (args.length) o.args = args
  o.resources = buildResources(c.cpuReq, c.cpuLim, c.memReq, c.memLim)
  const m = mountObjs(target, f)
  if (m) o.volumeMounts = m
  return o
}
async function saveEdit() {
  const f = editForm.value
  const labels = { ...(f.labels || {}) }
  const image = f.imageTag ? `${f.imageRepo}:${f.imageTag}` : f.imageRepo
  // Deployment 级（labels / replicas / 更新策略 / 历史上限）→ updateWorkload
  const updates = { tier: f.tier, labels }
  if (isScalable.value) updates.replicas = `${f.replicas}/${f.replicas}`
  if (isCronJob.value) updates.schedule = f.schedule
  updates.strategy = f.strategy || 'RollingUpdate'
  updates.maxSurge = f.maxSurge
  updates.maxUnavailable = f.maxUnavailable
  updates.revisionHistoryLimit = f.revisionHistoryLimit
  store.updateWorkload(route.params.name, route.params.namespace, updates)
  // Pod 模板（深：容器/卷/调度/多容器）→ applyWorkloadTemplate
  if (isRolloutType.value) {
    const rawTpl = workload.value?.raw?.spec?.template
    if (rawTpl) {
      const tpl = JSON.parse(JSON.stringify(rawTpl))
      const spec = tpl.spec || (tpl.spec = {})
      if (!spec.containers?.length) spec.containers = [{ name: route.params.name }]
      const c0 = spec.containers[0]
      c0.image = image
      c0.imagePullPolicy = f.imagePullPolicy || 'IfNotPresent'
      const cmd = splitSpace(f.command), args = splitSpace(f.args)
      c0.command = cmd.length ? cmd : null
      c0.args = args.length ? args : null
      c0.workingDir = f.workingDir || null
      c0.resources = buildResources(f.cpuReq, f.cpuLim, f.memReq, f.memLim)
      const ports = (f.ports || []).filter(p => p.containerPort).map(p => ({ containerPort: Number(p.containerPort), protocol: p.protocol || 'TCP' }))
      c0.ports = ports.length ? ports : null
      const env = []
      ;(f.env || []).filter(e => e.key).forEach(e => env.push({ name: e.key, value: String(e.value ?? '') }))
      ;(f.envCMKeys || []).filter(e => e.name && e.cmName && e.key).forEach(e => env.push({ name: e.name, valueFrom: { configMapKeyRef: { name: e.cmName, key: e.key } } }))
      ;(f.envSecretKeys || []).filter(e => e.name && e.secretName && e.key).forEach(e => env.push({ name: e.name, valueFrom: { secretKeyRef: { name: e.secretName, key: e.key } } }))
      c0.env = env.length ? env : null
      const envFrom = []
      if (f.envFromConfigMap) envFrom.push({ configMapRef: { name: f.envFromConfigMap } })
      if (f.envFromSecret) envFrom.push({ secretRef: { name: f.envFromSecret } })
      c0.envFrom = envFrom.length ? envFrom : null
      c0.livenessProbe = buildProbe(f.liveness)
      c0.readinessProbe = buildProbe(f.readiness)
      c0.startupProbe = buildProbe(f.startup)
      c0.volumeMounts = mountObjs('main', f)
      c0.securityContext = buildSc(f.securityContext) || null
      const lc = {}
      const ps = splitSpace(f.lifecycle?.postStart), pst = splitSpace(f.lifecycle?.preStop)
      if (ps.length) lc.postStart = { exec: { command: ps } }
      if (pst.length) lc.preStop = { exec: { command: pst } }
      c0.lifecycle = Object.keys(lc).length ? lc : null
      // 多容器：重建 containers = [主, ...sidecar]，initContainers（按原索引传 target，各自挂卷）
      spec.containers = [c0, ...(f.extraContainers || []).map((c, idx) => c.image ? buildSubContainer(c, `sidecar:${idx}`, f) : null).filter(Boolean)]
      const inits = (f.initContainers || []).map((c, idx) => c.image ? buildSubContainer(c, `init:${idx}`, f) : null).filter(Boolean)
      spec.initContainers = inits.length ? inits : null
      // 卷（按 name 去重；configMap/secret 带 items）
      const volDefs = new Map()
      ;(f.volumeMounts || []).filter(v => v.name).forEach(v => { if (!volDefs.has(v.name)) volDefs.set(v.name, v) })
      const vols = [...volDefs.values()].map(v => {
        const items = (v.items || []).filter(it => it.key).map(it => ({ key: it.key, path: it.path }))
        if (v.type === 'pvc' && v.pvcName) return { name: v.name, persistentVolumeClaim: { claimName: v.pvcName } }
        if (v.type === 'emptyDir') return { name: v.name, emptyDir: {} }
        if (v.type === 'hostPath' && v.hostPath) return { name: v.name, hostPath: { path: v.hostPath } }
        if (v.type === 'configMap' && v.cmName) { const o = { name: v.name, configMap: { name: v.cmName } }; if (items.length) o.configMap.items = items; return o }
        if (v.type === 'secret' && v.secretName) { const o = { name: v.name, secret: { secretName: v.secretName } }; if (items.length) o.secret.items = items; return o }
        return null
      }).filter(Boolean)
      spec.volumes = vols.length ? vols : null
      // 调度（pod spec）
      const nsMap = {}
      ;(f.nodeSelectors || []).filter(n => n.key).forEach(n => { nsMap[n.key] = n.value })
      spec.nodeSelector = Object.keys(nsMap).length ? nsMap : null
      const tols = (f.tolerations || []).filter(t => t.key).map(t => { const o = { key: t.key, operator: t.operator || 'Equal' }; if (o.operator === 'Equal') o.value = t.value; if (t.effect) o.effect = t.effect; return o })
      spec.tolerations = tols.length ? tols : null
      spec.serviceAccountName = f.serviceAccountName || null
      spec.priorityClassName = f.priorityClassName || null
      spec.imagePullSecrets = f.imagePullSecrets ? [{ name: f.imagePullSecrets }] : null
      try { await store.applyWorkloadTemplate(route.params.name, route.params.namespace, tpl) }
      catch (e) { notify('error', e.message || '容器配置保存失败') }
    }
  }
  refreshSoon()
  showEditModal.value = false
}

// === Business Metadata Editor（业务元数据 + 自定义 labels/annotations）===
// 与创建（DeployApp）落点一致：业务 label 同时写 Deployment.metadata 与 Pod 模板；description 走 annotation。
const META_CANON = { title: 'aliangboard.io/title', owner: 'aliangboard.io/owner', version: 'aliangboard.io/version', tags: 'aliangboard.io/tags' }
const META_DESC_KEY = 'aliangboard.io/description'
const META_LAYER_KEYS = ['aliangboard.io/layer', 'layer.aliangboard.io', 'tier']
const META_MANAGED_KEY = 'aliangboard.io/managed-by'
// 系统保留：永不进自定义列表、永不被删（原值保留）
const META_SYS_LABELS = ['app', META_MANAGED_KEY, 'pod-template-hash', 'controller-revision-hash']
const META_SYS_ANN = ['deployment.kubernetes.io/revision', 'kubectl.kubernetes.io/restartedAt', 'kubectl.kubernetes.io/last-applied-configuration', 'aliangboard.io/last-edited', 'aliangboard.io/last-action']
// 业务/分层键：由表单字段管理，从自定义列表隐藏
// tags 现存 annotation（含逗号），但历史迁移可能残留 tags label——隐藏它，保存时一并清除（merge-patch null）
const META_HIDDEN_LABELS = [...META_SYS_LABELS, META_CANON.owner, META_CANON.version, META_CANON.tags, ...META_LAYER_KEYS]
const META_HIDDEN_ANN = [...META_SYS_ANN, META_DESC_KEY, META_CANON.title, META_CANON.tags] // title + tags 走 annotation

const showMetaModal = ref(false)
const metaForm = ref({ title: '', owner: '', version: '', tags: '', description: '', layer: '', labels: [], annotations: [] })
function openMetaEditor() {
  if (!workload.value) return
  const m = meta.value
  const curLabels = workload.value.labels || {}
  const curAnn = workload.value.annotations || {}
  metaForm.value = {
    title: m.title || '',
    owner: m.owner || '',
    version: m.version || '',
    tags: m.tags || '',
    description: m.description || '',
    layer: META_LAYER_KEYS.map(k => curLabels[k]).find(Boolean) || workload.value.tier || '',
    labels: Object.entries(curLabels)
      .filter(([k]) => !META_HIDDEN_LABELS.includes(k))
      .map(([key, value]) => ({ key, value: String(value ?? '') })),
    annotations: Object.entries(curAnn)
      .filter(([k]) => !META_HIDDEN_ANN.includes(k))
      .map(([key, value]) => ({ key, value: String(value ?? '') })),
  }
  showMetaModal.value = true
}
function addMetaLabel() { metaForm.value.labels.push({ key: '', value: '' }) }
function addMetaAnnotation() { metaForm.value.annotations.push({ key: '', value: '' }) }
async function saveMeta() {
  const wl = workload.value
  if (!wl) return
  const f = metaForm.value
  const curLabels = wl.labels || {}
  const curAnn = wl.annotations || {}
  // 业务 canonical labels（非空才写）；title + tags 走 annotation（支持中文/逗号）
  const business = {}
  if (f.owner) business[META_CANON.owner] = f.owner
  if (f.version) business[META_CANON.version] = f.version
  if (f.layer) { business['aliangboard.io/layer'] = f.layer; business['layer.aliangboard.io'] = f.layer }
  // 自定义键（去重，后出现为准）
  const customLabels = {}
  f.labels.filter(l => l.key && l.key.trim()).forEach(l => { customLabels[l.key.trim()] = l.value })
  const customAnns = {}
  f.annotations.filter(a => a.key && a.key.trim()).forEach(a => { customAnns[a.key.trim()] = a.value })
  // 期望 Deployment labels = 系统保留(原值) + 业务 + 自定义
  const labels = {}
  META_SYS_LABELS.forEach(k => { if (k in curLabels) labels[k] = curLabels[k] })
  Object.assign(labels, business, customLabels)
  // 期望 annotations = 系统保留 + description + 自定义
  const annotations = {}
  META_SYS_ANN.forEach(k => { if (k in curAnn) annotations[k] = curAnn[k] })
  if (f.description) annotations[META_DESC_KEY] = f.description
  if (f.title) annotations[META_CANON.title] = f.title // title 走 annotation 支持 UTF-8
  if (f.tags) annotations[META_CANON.tags] = f.tags // tags 含逗号，走 annotation
  Object.assign(annotations, customAnns)
  // 删除：原集合中既有、非系统保留、但不在期望中的键 → null（merge-patch 删除）
  const removedLabels = Object.keys(curLabels).filter(k => !META_SYS_LABELS.includes(k) && !(k in labels))
  const removedAnnotations = Object.keys(curAnn).filter(k => !META_SYS_ANN.includes(k) && !(k in annotations))
  // Pod 模板镜像：保留模板上非托管键（app 等）+ 业务/自定义（与创建落点一致）；仅在变化时下发，避免无谓滚动
  const rawTplLabels = wl.raw?.spec?.template?.metadata?.labels || {}
  const managedTpl = new Set([META_CANON.owner, META_CANON.version, META_CANON.tags, 'aliangboard.io/layer', 'layer.aliangboard.io', ...Object.keys(customLabels)])
  const desiredTplLabels = {}
  Object.entries(rawTplLabels).forEach(([k, v]) => { if (!managedTpl.has(k)) desiredTplLabels[k] = v })
  Object.assign(desiredTplLabels, business, customLabels)
  const allTplKeys = new Set([...Object.keys(desiredTplLabels), ...Object.keys(rawTplLabels)])
  const templateChanged = [...allTplKeys].some(k => (desiredTplLabels[k] ?? '') !== (rawTplLabels[k] ?? ''))
  const templateLabels = templateChanged
    ? { ...desiredTplLabels, ...Object.keys(rawTplLabels).filter(k => managedTpl.has(k) && !(k in desiredTplLabels)).reduce((o, k) => { o[k] = null; return o }, {}) }
    : null
  store.updateWorkloadMeta(route.params.name, route.params.namespace, { labels, annotations, removedLabels, removedAnnotations, templateLabels })
  if (f.tags) recordTagUsage(route.params.namespace, f.tags) // 编辑标签也即时入历史，供下次建议
  showMetaModal.value = false
}

// === Template Editor ===
const showTemplateModal = ref(false)
const templateYaml = ref('')
function openTemplateEditor() {
  const rawTpl = workload.value?.raw?.spec?.template
  if (rawTpl) {
    templateYaml.value = yamlDump(rawTpl)
  } else {
    // 无 raw（mock / 数据未含原始对象）：从扁平字段合成 Pod 模板，避免编辑器空白
    const w = workload.value || {}
    const desired = Number(w.replicas?.split('/')[1]) || 1
    templateYaml.value = yamlDump({
      metadata: { labels: { app: w.name, ...(w.labels || {}) } },
      spec: {
        replicas: desired,
        containers: [{ name: w.name, image: w.image || 'nginx:latest' }],
      },
    })
  }
  showTemplateModal.value = true
}
async function saveTemplate(yamlStr) {
  try {
    const { load: yamlLoad } = await import('js-yaml')
    const parsed = yamlLoad(yamlStr)
    await store.applyWorkloadTemplate(route.params.name, route.params.namespace, parsed)
    notify('success', 'Pod 模板已更新')
    showTemplateModal.value = false
    refreshSoon()
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
            <h1 class="text-headline-md text-on-surface font-bold">{{ meta.title || workload.name }}</h1>
            <span v-if="meta.title" class="font-mono text-xs text-on-surface-variant">{{ workload.name }}</span>
          </div>
          <p v-if="meta.description" class="text-body-sm text-on-surface-variant mt-xs">{{ meta.description }}</p>
          <div class="flex items-center gap-xs mt-xs flex-wrap">
            <span class="px-2 py-0.5 bg-primary/8 text-primary text-xs rounded-md font-medium">{{ workload.type }}</span>
            <StatusChip :status="workload.status" size="sm" />
            <span class="text-xs text-on-surface-variant">{{ workload.namespace }}</span>
            <span v-if="meta.owner" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant"><span class="material-symbols-outlined text-xs">group</span>{{ meta.owner }}</span>
            <span v-if="meta.version" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-primary/8 rounded text-xs text-primary"><span class="material-symbols-outlined text-xs">sell</span>{{ meta.version }}</span>
            <span v-if="meta.managedBy === 'aliangboard'" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-primary/8 text-primary rounded text-xs font-medium"><span class="material-symbols-outlined text-xs">verified</span>AliangBoard</span>
          </div>
        </div>
      </div>
      <div class="flex gap-xs shrink-0">
        <button @click="refresh" :disabled="refreshing" :title="refreshing ? '刷新中…' : '刷新（重新拉取工作负载/Pod/事件）'" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-40">
          <span class="material-symbols-outlined text-base" :class="refreshing ? 'animate-spin' : ''">refresh</span><span class="hidden lg:inline">刷新</span>
        </button>
        <button v-if="isScalable" @click="openScale" :disabled="!canMutate" :title="!canMutate ? '无 update 权限' : ''" class="px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Scale</button>
        <button @click="handleRestart" :disabled="!canMutate" :title="!canMutate ? '无 update 权限' : ''" class="px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Restart</button>
        <button @click="openMetaEditor" :disabled="!canMutate" :title="!canMutate ? '无 update 权限' : ''" class="px-3 py-1.5 text-body-sm font-medium border border-primary/40 text-primary rounded-lg hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">元数据</button>
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
              <p class="text-xs text-on-surface-variant truncate" :title="rollout.reason">{{ rollout.reason }}</p>
            </div>
          </div>
          <!-- 副本大数字 + 快速伸缩 -->
          <div class="flex items-center gap-sm lg:px-md lg:border-x border-outline-variant shrink-0">
            <div class="flex items-baseline gap-xs">
              <span class="text-[32px] font-bold font-mono leading-none" :class="rollout.meta.text">{{ rollout.ready }}</span>
              <span class="text-headline-sm text-on-surface-variant/40 font-mono">/ {{ rollout.desired }}</span>
            </div>
            <span class="text-xs text-on-surface-variant">就绪副本</span>
            <!-- 快速伸缩 ±1（Deployment/StatefulSet） -->
            <div v-if="isScalable" class="flex items-center gap-0.5">
              <button @click="quickScale(-1)" :disabled="!canMutate || scaling || rollout.desired <= 0" class="w-6 h-6 rounded-md border border-outline-variant text-on-surface hover:bg-primary/10 hover:border-primary hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors" title="减少 1 个副本">
                <span class="material-symbols-outlined" style="font-size:16px">remove</span>
              </button>
              <button @click="quickScale(1)" :disabled="!canMutate || scaling" class="w-6 h-6 rounded-md border border-outline-variant text-on-surface hover:bg-primary/10 hover:border-primary hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors" title="增加 1 个副本">
                <span class="material-symbols-outlined" style="font-size:16px">{{ scaling ? 'progress_activity' : 'add' }}</span>
              </button>
            </div>
          </div>
          <!-- 滚动发布进度 -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-medium text-on-surface">滚动发布</span>
              <span class="text-xs text-on-surface-variant">
                <span class="font-mono font-semibold" :class="rollout.level === 'updating' ? 'text-status-succeeded' : 'text-status-running'">{{ rollout.updated }}</span> 新版本
                <template v-if="rollout.oldCount > 0"><span class="text-on-surface-variant/40 mx-0.5">·</span><span class="text-status-pending font-mono">{{ rollout.oldCount }}</span> 旧版本</template>
              </span>
            </div>
            <div class="h-2.5 rounded-full bg-surface-container overflow-hidden flex">
              <div class="h-full transition-all duration-500" :class="rollout.level === 'updating' ? 'bg-status-succeeded' : 'bg-status-running'" :style="{ width: rollout.newW + '%' }"></div>
              <div v-if="rollout.oldCount > 0" class="h-full bg-status-pending transition-all duration-500" :style="{ width: rollout.oldW + '%' }"></div>
            </div>
            <div class="flex items-center gap-md mt-1 text-xs text-on-surface-variant">
              <span class="flex items-center gap-0.5"><span class="w-2 h-2 rounded-full" :class="rollout.level === 'updating' ? 'bg-status-succeeded' : 'bg-status-running'"></span>新 {{ rollout.updated }}</span>
              <span v-if="rollout.oldCount > 0" class="flex items-center gap-0.5"><span class="w-2 h-2 rounded-full bg-status-pending"></span>旧 {{ rollout.oldCount }}</span>
              <span class="ml-auto text-on-surface-variant/60">期望 {{ rollout.desired }} · 已创建 {{ rollout.total }}</span>
            </div>
          </div>
          <!-- 改版本（镜像 tag） -->
          <button v-if="canMutate" @click="openImageTagEditor" class="shrink-0 flex items-center gap-xs px-md py-1.5 rounded-lg border border-outline-variant text-on-surface hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors" title="调整镜像版本">
            <span class="material-symbols-outlined text-base">swap_horiz</span><span class="text-body-sm font-medium">改版本</span>
          </button>
        </div>
      </div>

      <!-- 顶部摘要条 -->
      <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-sm">
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant px-md py-2.5">
          <p class="text-xs text-on-surface-variant">{{ replicasLabel }}</p>
          <p class="text-headline-sm font-bold text-on-surface font-mono mt-0.5">{{ workload.replicas }}</p>
        </div>
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant px-md py-2.5">
          <p class="text-xs text-on-surface-variant">就绪 Pod</p>
          <p class="text-headline-sm font-bold mt-0.5"><span class="text-primary font-mono">{{ managedPods.filter(p => p.status === 'Running').length }}</span><span class="text-on-surface-variant/40 text-body-md"> / {{ managedPods.length }}</span></p>
        </div>
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant px-md py-2.5">
          <p class="text-xs text-on-surface-variant">运行时长</p>
          <p class="text-headline-sm font-bold text-on-surface mt-0.5">{{ workload.age }}</p>
        </div>
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant px-md py-2.5 xl:col-span-2">
          <div class="flex items-center justify-between"><p class="text-xs text-on-surface-variant">镜像</p><button v-if="canMutate" @click="openImageTagEditor" class="text-xs text-primary hover:underline flex items-center gap-0.5"><span class="material-symbols-outlined text-sm">swap_horiz</span>改版本</button></div>
          <p class="font-mono text-code-sm truncate mt-0.5"><span class="text-on-surface-variant">{{ imgBase(workload.image) }}</span><span class="text-primary font-semibold">:{{ imgTag(workload.image) || 'latest' }}</span></p>
          <div v-if="metricsAvailable" class="flex items-center gap-md mt-1 text-xs text-on-surface-variant">
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
            <span class="text-xs text-on-surface-variant ml-auto">{{ revisions.length }}</span>
          </div>
          <div class="flex-1 overflow-y-auto p-sm flex flex-col gap-xs">
            <button v-for="rev in revisions" :key="rev.rev" @click="selectRev(rev)"
              class="text-left rounded-lg border transition-all px-sm py-1.5 hover:shadow-sm"
              :class="revCardClass(rev)">
              <!-- 头：Rev + 徽标 + 年龄 -->
              <div class="flex items-center gap-1 min-w-0">
                <span class="text-xs font-bold shrink-0" :class="rev.current ? 'text-on-primary' : 'text-on-surface'">Rev {{ rev.rev }}</span>
                <span v-if="rev.current" class="px-1 py-px rounded text-[10px] font-bold leading-none bg-on-primary/20 text-on-primary shrink-0">活跃</span>
                <span v-else class="px-1 py-px rounded text-[10px] leading-none shrink-0" :class="selectedRev?.rev === rev.rev ? 'bg-primary/15 text-primary' : 'bg-surface-container text-on-surface-variant/60'">历史</span>
                <span class="text-[11px] shrink-0 ml-auto" :class="rev.current ? 'text-on-primary/70' : 'text-on-surface-variant/50'">{{ rev.age }}</span>
              </div>
              <!-- 镜像 -->
              <p class="font-mono text-[11px] truncate mt-0.5" :class="rev.current ? 'text-on-primary/80' : 'text-on-surface-variant'">
                {{ revImgBase(rev.image) }}<span class="font-semibold" :class="rev.current ? 'text-on-primary' : 'text-primary'">:{{ imageTag(rev.image) || 'latest' }}</span>
              </p>
              <!-- 副本统计：期望 / 当前 / 就绪 -->
              <div class="grid grid-cols-3 gap-1 mt-1">
                <div class="rounded text-center py-0.5" :class="rev.current ? 'bg-on-primary/15' : 'bg-surface-container/80'">
                  <p class="text-[9px] leading-none" :class="rev.current ? 'text-on-primary/60' : 'text-on-surface-variant/50'">期望</p>
                  <p class="font-mono text-[11px] font-bold leading-none mt-0.5" :class="rev.current ? 'text-on-primary' : 'text-on-surface'">{{ rev.desiredReplicas ?? '—' }}</p>
                </div>
                <div class="rounded text-center py-0.5" :class="rev.current ? 'bg-on-primary/15' : 'bg-surface-container/80'">
                  <p class="text-[9px] leading-none" :class="rev.current ? 'text-on-primary/60' : 'text-on-surface-variant/50'">当前</p>
                  <p class="font-mono text-[11px] font-bold leading-none mt-0.5" :class="rev.current ? 'text-on-primary' : 'text-on-surface'">{{ rev.replicas ?? 0 }}</p>
                </div>
                <div class="rounded text-center py-0.5" :class="rev.current ? 'bg-on-primary/15' : 'bg-surface-container/80'">
                  <p class="text-[9px] leading-none" :class="rev.current ? 'text-on-primary/60' : 'text-on-surface-variant/50'">就绪</p>
                  <p class="font-mono text-[11px] font-bold leading-none mt-0.5" :class="revReadyClass(rev)">{{ rev.readyReplicas ?? 0 }}</p>
                </div>
              </div>
              <!-- 操作 -->
              <div class="flex items-center justify-end gap-0.5 mt-1 -mr-0.5">
                <button @click.stop="viewRevYaml(rev)" class="p-1 rounded hover:bg-black/10" :class="rev.current ? 'text-on-primary/90 hover:text-on-primary' : 'text-on-surface-variant hover:text-primary'" title="查看 YAML"><span class="material-symbols-outlined text-sm">code</span></button>
                <button v-if="!rev.current" @click.stop="confirmRollback(rev)" class="p-1 rounded hover:bg-primary/10 text-primary" title="回滚到此版本"><span class="material-symbols-outlined text-sm">undo</span></button>
                <button v-if="!rev.current" @click.stop="confirmDeleteRev(rev)" class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error" title="删除该版本"><span class="material-symbols-outlined text-sm">delete</span></button>
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
              <span class="text-xs text-on-surface-variant">Rev {{ selectedRev.rev }}</span>
              <div class="flex items-center gap-sm ml-auto">
                <span class="text-xs text-primary font-medium">{{ currentRevPods.filter(p => p.status === 'Running').length }} 运行</span>
                <span v-if="currentRevPods.filter(p => p.status !== 'Running').length" class="text-xs text-tertiary-container">{{ currentRevPods.filter(p => p.status !== 'Running').length }} 异常</span>
              </div>
            </div>
            <div v-if="currentRevPods.length" class="flex-1 overflow-y-auto p-sm flex flex-col gap-xs">
              <PodCard
                v-for="p in currentRevPods" :key="p.name"
                :pod="p" :name-base="workload?.name" :selected="selectedPod?.name === p.name"
                :show-terminal="false"
                show-delete
                @click="selectPod(p)" @delete="confirmDeletePod($event)"
              >
                <template #actions>
                  <button @click.stop="openExec(p)" class="p-0.5 rounded hover:bg-primary/10 text-on-surface-variant/50 hover:text-primary transition-colors shrink-0" title="打开终端（浮动窗口）">
                    <span class="material-symbols-outlined text-sm">terminal</span>
                  </button>
                </template>
              </PodCard>
            </div>
            <div v-else class="flex-1 py-md text-center text-body-sm text-on-surface-variant">
              <span class="material-symbols-outlined text-2xl text-surface-container-high">pod</span>
              <p class="mt-xs">该版本暂无 Pod</p>
            </div>
          </template>

          <!-- 历史版本：基础信息（扁平单卡，不嵌套盒子） -->
          <template v-else-if="selectedRev">
            <!-- 头 -->
            <div class="flex items-center gap-sm px-md py-2.5 border-b border-outline-variant/40">
              <span class="w-6 h-6 rounded-lg bg-primary/10 flex items-center justify-center"><span class="material-symbols-outlined text-primary text-sm">history</span></span>
              <span class="text-body-sm font-semibold text-on-surface">历史版本</span>
              <span class="ml-auto px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary">Rev {{ selectedRev.rev }}</span>
            </div>
            <div class="flex-1 overflow-y-auto flex flex-col">
              <!-- Hero：镜像（最显眼）+ ReplicaSet 副标题 -->
              <div class="px-md py-md">
                <p class="text-[10px] uppercase tracking-wide text-on-surface-variant/50 mb-1">镜像</p>
                <p class="font-mono text-body-sm font-semibold break-all leading-tight"><span class="text-on-surface-variant">{{ revImgBase(selectedRev.image) }}</span><span class="text-primary">:{{ imageTag(selectedRev.image) || 'latest' }}</span></p>
                <div class="flex items-center gap-1 mt-1.5 text-[11px] text-on-surface-variant/60">
                  <span class="material-symbols-outlined text-sm">group_work</span>
                  <span class="font-mono truncate" :title="selectedRev.rsName">{{ selectedRev.rsName || '—' }}</span>
                </div>
              </div>
              <!-- 副本统计：扁平 3 列（竖线分隔，无盒子） -->
              <div class="grid grid-cols-3 px-md py-sm border-y border-outline-variant/40">
                <div class="text-center">
                  <p class="text-[10px] text-on-surface-variant/50">期望</p>
                  <p class="font-mono text-body-sm font-bold text-on-surface mt-0.5">{{ selectedRev.desiredReplicas ?? '—' }}</p>
                </div>
                <div class="text-center border-x border-outline-variant/40">
                  <p class="text-[10px] text-on-surface-variant/50">当前</p>
                  <p class="font-mono text-body-sm font-bold mt-0.5" :class="(selectedRev.replicas ?? 0) > 0 ? 'text-primary' : 'text-on-surface-variant/50'">{{ selectedRev.replicas ?? 0 }}</p>
                </div>
                <div class="text-center">
                  <p class="text-[10px] text-on-surface-variant/50">就绪</p>
                  <p class="font-mono text-body-sm font-bold mt-0.5" :class="revReadyClass(selectedRev)">{{ selectedRev.readyReplicas ?? 0 }}</p>
                </div>
              </div>
              <!-- 元信息 -->
              <div class="px-md py-sm flex flex-col gap-1 text-xs">
                <div class="flex items-center justify-between">
                  <span class="text-on-surface-variant/60 flex items-center gap-1"><span class="material-symbols-outlined text-sm">schedule</span>创建于</span>
                  <span class="text-on-surface">{{ selectedRev.age }}</span>
                </div>
                <div v-if="selectedRev.reason && selectedRev.reason !== '—'" class="flex items-start gap-1">
                  <span class="material-symbols-outlined text-on-surface-variant/60 text-sm shrink-0">change_circle</span>
                  <span class="text-on-surface-variant break-all">{{ selectedRev.reason }}</span>
                </div>
              </div>
              <!-- 操作（吸底，无边框仅 hover 底色） -->
              <div class="mt-auto px-md py-md border-t border-outline-variant/40 grid grid-cols-3 gap-1">
                <button @click="viewRevYaml(selectedRev)" class="flex flex-col items-center gap-0.5 py-1.5 rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/5 transition-colors"><span class="material-symbols-outlined text-base">code</span><span class="text-[11px]">YAML</span></button>
                <button @click="confirmRollback(selectedRev)" class="flex flex-col items-center gap-0.5 py-1.5 rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/5 transition-colors"><span class="material-symbols-outlined text-base">undo</span><span class="text-[11px]">回滚</span></button>
                <button @click="confirmDeleteRev(selectedRev)" class="flex flex-col items-center gap-0.5 py-1.5 rounded-lg text-on-surface-variant hover:text-error hover:bg-error/5 transition-colors"><span class="material-symbols-outlined text-base">delete</span><span class="text-[11px]">删除</span></button>
              </div>
            </div>
          </template>
        </div>

        <!-- ============ 右列：Pod 详情（事件置顶 → 指标 → 状态[含基础信息]）============ -->
        <div class="flex flex-col gap-sm">
          <template v-if="selectedPod">
            <!-- 工作负载事件（置顶）：时间轴样式 -->
            <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
              <div class="flex items-center justify-between px-md py-2 border-b border-outline-variant/40">
                <div class="flex items-center gap-xs">
                  <span class="w-5 h-5 rounded-md bg-primary/10 flex items-center justify-center"><span class="material-symbols-outlined text-primary" style="font-size:14px">notifications_active</span></span>
                  <span class="text-xs font-semibold">事件</span>
                  <span class="px-1.5 py-0.5 rounded-full bg-surface-container text-[10px] text-on-surface-variant font-medium">{{ workloadEvents.length }}</span>
                </div>
                <button v-if="workloadEvents.length > 6" @click="activeTab = 'events'" class="text-[11px] text-primary hover:underline flex items-center gap-0.5">全部<span class="material-symbols-outlined" style="font-size:13px">arrow_forward</span></button>
              </div>
              <div v-if="workloadEvents.length" class="px-md py-sm">
                <div class="relative">
                  <div class="absolute left-[9px] top-2 bottom-2 w-px bg-outline-variant/40"></div>
                  <div v-for="(e, i) in workloadEvents.slice(0, 6)" :key="i" class="relative pl-[27px] pb-xs last:pb-0 flex items-center gap-1">
                    <span class="absolute left-0 top-1/2 -translate-y-1/2 w-[19px] h-[19px] rounded-full flex items-center justify-center ring-[3px] ring-surface-container-lowest shrink-0" :class="eventBg(e)">
                      <span class="material-symbols-outlined text-white" style="font-size:11px">{{ e.icon || 'info' }}</span>
                    </span>
                    <span class="text-[11px] font-semibold shrink-0" :class="eventText(e)">{{ e.reason || '—' }}</span>
                    <span class="text-[9px] px-1 rounded bg-surface-container text-on-surface-variant/60 shrink-0">{{ e.relatedKind || 'Event' }}</span>
                    <span class="text-[11px] text-on-surface-variant/70 truncate flex-1 min-w-0">{{ e.message }}</span>
                    <span v-if="e.count > 1" class="text-[9px] px-1 rounded font-mono font-semibold shrink-0" :class="[eventText(e), 'bg-current/10']">×{{ e.count }}</span>
                    <span class="text-[10px] text-on-surface-variant/40 shrink-0">{{ e.age }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="py-md text-center">
                <span class="material-symbols-outlined text-2xl text-surface-container-high">inbox</span>
                <p class="text-xs text-on-surface-variant/50 mt-xs">该工作负载暂无事件</p>
              </div>
            </div>

            <!-- 性能指标（预设时间窗） -->
            <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
              <div class="flex items-center justify-between px-md py-2.5 border-b border-outline-variant/40">
                <div class="flex items-center gap-sm">
                  <span class="w-6 h-6 rounded-lg bg-primary/10 flex items-center justify-center"><span class="material-symbols-outlined text-primary text-sm">monitoring</span></span>
                  <span class="text-body-sm font-semibold">性能指标</span>
                  <span class="text-xs text-on-surface-variant/60">{{ metricsWindow }} 窗口</span>
                </div>
                <div class="flex items-center gap-0.5 bg-surface-container-low rounded-lg p-0.5">
                  <button v-for="w in METRIC_WINDOWS" :key="w.key" @click="metricsWindow = w.key" class="px-2 py-0.5 text-xs rounded-md transition-colors" :class="metricsWindow === w.key ? 'bg-primary text-on-primary font-semibold' : 'text-on-surface-variant hover:text-on-surface'">{{ w.label }}</button>
                </div>
              </div>
              <div v-if="podMetricsAvailable" class="grid grid-cols-2 divide-x divide-outline-variant/30">
                <div class="p-md">
                  <div class="flex items-baseline justify-between mb-xs">
                    <span class="flex items-center gap-1 text-xs text-on-surface-variant"><span class="material-symbols-outlined text-primary text-sm">speed</span>CPU</span>
                    <span class="font-mono text-headline-sm font-bold text-primary leading-none">{{ podMetricsNow.cpu }}<span class="text-xs text-on-surface-variant/50 font-normal ml-0.5">m</span></span>
                  </div>
                  <MiniChart :series="windowed(podCpuSeries)" color="var(--md-sys-color-primary)" :ref-lines="podCpuRefLines" :height="72" />
                  <div class="flex items-center gap-xs mt-xs text-[10px] text-on-surface-variant/60">
                    <span>req {{ podRes.cpuReq || '—' }}m</span><span v-if="podRes.cpuLim">· lim {{ podRes.cpuLim }}m</span>
                  </div>
                </div>
                <div class="p-md">
                  <div class="flex items-baseline justify-between mb-xs">
                    <span class="flex items-center gap-1 text-xs text-on-surface-variant"><span class="material-symbols-outlined text-secondary text-sm">memory</span>内存</span>
                    <span class="font-mono text-headline-sm font-bold text-secondary leading-none">{{ podMetricsNow.mem }}<span class="text-xs text-on-surface-variant/50 font-normal ml-0.5">Mi</span></span>
                  </div>
                  <MiniChart :series="windowed(podMemSeries)" color="var(--md-sys-color-secondary)" :ref-lines="podMemRefLines" :height="72" />
                  <div class="flex items-center gap-xs mt-xs text-[10px] text-on-surface-variant/60">
                    <span>req {{ podRes.memReq || '—' }}Mi</span><span v-if="podRes.memLim">· lim {{ podRes.memLim }}Mi</span>
                  </div>
                </div>
              </div>
              <div v-else class="py-md text-center"><span class="material-symbols-outlined text-2xl text-surface-container-high">monitoring</span><p class="text-body-sm text-on-surface-variant mt-xs">metrics-server 未就绪</p></div>
            </div>

            <!-- 选中 Pod 的容器详情：以「容器(应用进程)」为主体，Pod 作为它的运行实例 -->
            <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
              <!-- 主体：容器（= 服务本身，你最关心的） -->
              <div class="p-md">
                <div class="flex items-center gap-xs mb-sm">
                  <span class="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold tracking-wider">容器 · CONTAINER</span>
                  <span class="text-xs text-on-surface-variant ml-auto">{{ podContainers(selectedPod).length }} 个</span>
                </div>
                <div v-if="podContainers(selectedPod).length" class="flex flex-col gap-xs">
                  <div v-for="c in podContainers(selectedPod)" :key="c.name" class="rounded-lg border-2 border-primary/30 bg-primary/5 px-sm py-1.5">
                    <div class="flex items-center gap-xs flex-wrap">
                      <span class="material-symbols-outlined text-base" :class="containerStateText(c.state).color">{{ containerStateText(c.state).icon }}</span>
                      <span class="font-mono text-body-sm font-semibold text-on-surface">{{ c.name }}</span>
                      <span class="text-xs" :class="containerStateText(c.state).color">{{ containerStateText(c.state).text }}</span>
                      <span v-if="c.restartCount > 0" class="text-xs text-tertiary-container flex items-center gap-0.5"><span class="material-symbols-outlined" style="font-size:12px">restart_alt</span>{{ c.restartCount }}</span>
                      <span v-if="c.startTime" class="text-xs text-on-surface-variant/40 ml-auto">{{ c.startTime.slice(0, 19) }}</span>
                    </div>
                    <p class="font-mono text-[11px] truncate mt-0.5"><span class="text-on-surface-variant">{{ imgBase(c.image) }}</span><span class="text-primary font-semibold">:{{ imgTag(c.image) || 'latest' }}</span><span class="text-on-surface-variant/40"> · {{ c.pullPolicy }}<span v-if="c.ports"> · {{ c.ports }}</span></span></p>
                  </div>
                </div>
                <p v-else class="text-xs text-on-surface-variant/50 py-sm">无容器</p>
                <!-- 操作 -->
                <div class="flex items-center gap-0.5 mt-sm">
                  <button @click="viewLogs(selectedPod)" class="flex items-center gap-0.5 px-sm py-1 rounded-md hover:bg-primary/10 text-on-surface-variant hover:text-primary transition-colors" title="日志"><span class="material-symbols-outlined text-base">terminal</span><span class="text-[11px]">日志</span></button>
                  <button @click="openExec(selectedPod)" class="flex items-center gap-0.5 px-sm py-1 rounded-md hover:bg-primary/10 text-on-surface-variant hover:text-primary transition-colors" title="终端"><span class="material-symbols-outlined text-base">code</span><span class="text-[11px]">终端</span></button>
                  <button @click="viewFiles()" class="flex items-center gap-0.5 px-sm py-1 rounded-md hover:bg-primary/10 text-on-surface-variant hover:text-primary transition-colors" title="文件"><span class="material-symbols-outlined text-base">folder_open</span><span class="text-[11px]">文件</span></button>
                  <button @click="openPortForward" class="flex items-center gap-0.5 px-sm py-1 rounded-md hover:bg-primary/10 text-on-surface-variant hover:text-primary transition-colors ml-auto" title="端口转发"><span class="material-symbols-outlined text-base">forward_media</span><span class="text-[11px]">转发</span></button>
                </div>
                <!-- 生命周期（Pod 就绪状态） -->
                <div v-if="podConditions(selectedPod)" class="grid grid-cols-2 gap-1 mt-sm">
                  <template v-for="ck in [{k:'scheduled',l:'已调度'},{k:'initialized',l:'已初始化'},{k:'containersReady',l:'容器就绪'},{k:'podReady',l:'Pod 就绪'}]" :key="ck.k">
                    <div class="flex items-center gap-1 px-1.5 py-1 rounded bg-surface-container-low">
                      <span class="material-symbols-outlined" style="font-size:14px" :class="condChip(podConditions(selectedPod)[ck.k]).ok ? 'text-primary' : 'text-on-surface-variant/40'">{{ condChip(podConditions(selectedPod)[ck.k]).ok ? 'check_circle' : 'radio_button_unchecked' }}</span>
                      <span class="text-[11px]" :class="condChip(podConditions(selectedPod)[ck.k]).ok ? 'text-on-surface' : 'text-on-surface-variant'">{{ ck.l }}</span>
                    </div>
                  </template>
                </div>
              </div>
              <!-- 运行实例：Pod（上述容器运行所在的实例） -->
              <div class="px-md py-2 border-t border-outline-variant/40 bg-surface-container-low/30">
                <div class="flex items-center gap-xs mb-1">
                  <span class="px-1.5 py-0.5 rounded bg-secondary/10 text-secondary text-[10px] font-bold tracking-wider">运行实例 · POD</span>
                  <span class="text-xs text-on-surface-variant/70 ml-auto">该容器运行于此 Pod 实例</span>
                </div>
                <div class="flex items-center gap-sm">
                  <span class="relative shrink-0" title="Pod 实例">
                    <span class="material-symbols-outlined text-on-surface-variant">view_in_ar</span>
                    <span class="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-surface-container-low" :class="podHealth(selectedPod).dot"></span>
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="font-mono text-body-sm font-semibold text-on-surface truncate" :title="selectedPod.name">{{ podNameDisplay(selectedPod, workload?.name).base }}<span class="text-on-surface-variant/45 font-normal">{{ podNameDisplay(selectedPod, workload?.name).suffix }}</span></p>
                    <p class="text-xs text-on-surface-variant truncate">{{ selectedPod.ip || '—' }} · {{ selectedPod.node || '—' }} · {{ selectedPod.age }}</p>
                  </div>
                  <span class="text-xs px-1.5 py-0.5 rounded font-medium bg-surface-container-lowest shrink-0" :class="podHealth(selectedPod).text">{{ podHealth(selectedPod).label }}</span>
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
          <div class="px-md py-2 border-b border-outline-variant/40 flex items-center gap-sm"><span class="material-symbols-outlined text-primary text-base">label</span><span class="text-body-sm font-semibold">Labels</span><span class="text-xs text-on-surface-variant ml-auto">{{ Object.keys(workload.labels || {}).length }}</span></div>
          <div class="px-md py-sm flex flex-wrap gap-1">
            <span v-for="(val, key) in (workload.labels || {})" :key="key" class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant"><span class="font-semibold">{{ key }}</span>={{ val }}</span>
            <span v-if="!Object.keys(workload.labels || {}).length" class="text-xs text-on-surface-variant/50">无</span>
          </div>
        </div>
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
          <div class="px-md py-2 border-b border-outline-variant/40 flex items-center gap-sm"><span class="material-symbols-outlined text-primary text-base">link</span><span class="text-body-sm font-semibold">配置依赖</span><span class="text-xs text-on-surface-variant ml-auto">{{ configRefs.length }}</span></div>
          <div class="px-md py-sm flex flex-wrap gap-xs">
            <span v-for="(ref, idx) in configRefs" :key="idx" @click="router.push({ name: refRoute(ref).name, params: { namespace: route.params.namespace, name: ref.name } })" class="inline-flex items-center gap-xs px-sm py-xs bg-surface-container-low rounded cursor-pointer hover:bg-surface-container transition-colors"><span class="material-symbols-outlined text-sm" :class="ref.kind === 'ConfigMap' ? 'text-secondary' : 'text-tertiary'">{{ ref.kind === 'ConfigMap' ? 'description' : 'key' }}</span><span class="font-mono text-xs font-medium">{{ ref.name }}</span></span>
            <span v-if="!configRefs.length" class="text-xs text-on-surface-variant/50">无</span>
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
            <span class="text-xs text-on-surface-variant ml-auto">{{ topoIngressRules.length }}</span>
          </div>
          <div class="p-sm flex flex-col gap-xs flex-1">
            <div v-for="(r, i) in topoIngressRules" :key="i" @click="router.push({ name: 'NsIngressDetail', params: { namespace: route.params.namespace, name: r.ingress } })" class="cursor-pointer rounded-lg border border-outline-variant/60 px-sm py-1.5 hover:border-primary hover:bg-primary/5 transition-colors">
              <p class="font-mono text-xs text-primary font-semibold truncate">{{ r.host }}<span class="text-on-surface-variant font-normal">{{ r.path }}</span></p>
              <p class="text-[11px] text-on-surface-variant truncate">→ {{ r.serviceName }}<span v-if="r.port">:{{ r.port }}</span></p>
            </div>
            <div v-if="!topoIngressRules.length" class="flex-1 flex flex-col items-center justify-center text-center text-xs text-on-surface-variant/50 py-md">
              <span class="material-symbols-outlined text-2xl text-surface-container-high">block</span>未配置 Ingress
            </div>
          </div>
        </div>

        <div class="flex items-center text-on-surface-variant/30 shrink-0"><span class="material-symbols-outlined">arrow_forward</span></div>

        <!-- Service -->
        <div class="flex-1 min-w-[200px] relative">
          <button @click="openIngressMap" :disabled="!canMutate || !relatedServices.length" :title="!relatedServices.length ? '无关联 Service，无法映射 Ingress' : !canMutate ? '无 update 权限' : '为 Service 新建 Ingress 路由'" class="absolute -left-3 top-1/2 -translate-y-1/2 z-20 w-6 h-6 rounded-full bg-primary text-on-primary shadow-lg ring-2 ring-surface-container-lowest flex items-center justify-center hover:scale-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100">
            <span class="material-symbols-outlined text-base">add</span>
          </button>
          <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden flex flex-col h-full">
            <div class="px-md py-2 border-b border-outline-variant/40 bg-surface-container-low/40 flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-base">hub</span>
              <span class="text-body-sm font-semibold">Service</span>
              <span class="text-xs text-on-surface-variant ml-auto">{{ relatedServices.length }}</span>
            </div>
            <div class="p-sm flex flex-col gap-xs flex-1">
              <div v-for="s in relatedServices" :key="s.name" @click="router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: s.name } })" class="cursor-pointer rounded-lg border border-outline-variant/60 px-sm py-1.5 hover:border-primary hover:bg-primary/5 transition-colors">
                <p class="font-mono text-xs text-on-surface font-semibold truncate">{{ s.name }}</p>
                <p class="text-[11px] text-on-surface-variant truncate"><span class="px-1 rounded bg-surface-container">{{ s.type }}</span> {{ s.ports }}</p>
              </div>
              <div v-if="!relatedServices.length" class="flex-1 flex flex-col items-center justify-center text-center text-xs text-on-surface-variant/50 py-md">
                <span class="material-symbols-outlined text-2xl text-surface-container-high">block</span>无关联 Service
              </div>
            </div>
          </div>
        </div>

        <div class="flex items-center text-on-surface-variant/30 shrink-0"><span class="material-symbols-outlined">arrow_forward</span></div>

        <!-- Deployment (self) -->
        <div class="flex-1 min-w-[200px] relative">
          <button @click="openExpose" :disabled="!canMutate" :title="!canMutate ? '无 update 权限' : '在已暴露端口上新建 Service'" class="absolute -left-3 top-1/2 -translate-y-1/2 z-20 w-6 h-6 rounded-full bg-primary text-on-primary shadow-lg ring-2 ring-surface-container-lowest flex items-center justify-center hover:scale-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100">
            <span class="material-symbols-outlined text-base">add</span>
          </button>
          <div class="rounded-xl bg-primary/5 border-2 border-primary/40 overflow-hidden flex flex-col h-full">
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
        </div>

        <div class="flex items-center text-on-surface-variant/30 shrink-0"><span class="material-symbols-outlined">arrow_forward</span></div>

        <!-- Pods -->
        <div class="flex-1 min-w-[220px] rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden flex flex-col">
          <div class="px-md py-2 border-b border-outline-variant/40 bg-surface-container-low/40 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">view_in_ar</span>
            <span class="text-body-sm font-semibold">Pods</span>
            <span class="text-xs text-on-surface-variant ml-auto">{{ managedPods.length }}</span>
          </div>
          <div class="p-sm flex flex-col gap-xs flex-1 max-h-[340px] overflow-y-auto">
            <div v-for="p in managedPods" :key="p.name" @click="router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } })" class="cursor-pointer flex items-center gap-xs rounded-lg border border-outline-variant/60 px-sm py-1 hover:border-primary hover:bg-primary/5 transition-colors">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="podHealth(p).dot"></span>
              <span class="font-mono text-[11px] text-on-surface truncate flex-1">{{ p.name }}</span>
              <span class="text-[11px] shrink-0" :class="podHealth(p).text">{{ podHealth(p).label }}</span>
            </div>
            <div v-if="!managedPods.length" class="flex-1 flex flex-col items-center justify-center text-center text-xs text-on-surface-variant/50 py-md">
              <span class="material-symbols-outlined text-2xl text-surface-container-high">pod</span>无运行实例
            </div>
          </div>
        </div>
      </div>

      <!-- 流量说明 -->
      <div class="rounded-xl bg-surface-container-low border border-outline-variant/60 p-md flex items-start gap-sm">
        <span class="material-symbols-outlined text-on-surface-variant text-base mt-0.5">info</span>
        <p class="text-xs text-on-surface-variant">
          流量路径：<b class="text-on-surface">外部请求</b> → <b class="text-on-surface">Ingress</b>（域名/路径）→ <b class="text-on-surface">Service</b>（经 selector）→ <b class="text-primary">{{ workload.type }}</b> 副本 <b class="text-on-surface">Pod</b>。
          <span v-if="!relatedServices.length" class="text-tertiary-container">当前无关联 Service，外部无法访问——点 <b class="text-primary">Deployment 卡片左侧 +</b> 在已暴露端口上创建。</span>
          <span v-else class="text-on-surface-variant/70">点 <b class="text-primary">卡片左侧 +</b> 可在任一层继续新增：Deployment→Service、Service→Ingress。</span>
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
          <button @click="openExpose" class="text-xs text-primary hover:underline">+ 暴露</button>
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
          <button @click="openIngressMap" :disabled="!relatedServices.length" class="text-xs text-primary hover:underline disabled:opacity-40">+ 映射</button>
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
    <div v-if="activeTab === 'pods'" class="flex flex-col gap-md">
      <!-- 头部：计数 + 状态过滤 -->
      <div class="flex items-center gap-sm flex-wrap">
        <div class="flex items-center gap-sm mr-sm">
          <span class="material-symbols-outlined text-primary text-base">view_in_ar</span>
          <span class="text-body-sm font-semibold text-on-surface">{{ managedPods.length }} 个 Pod</span>
        </div>
        <button v-for="f in [{ k: 'All', l: '全部' }, { k: 'Running', l: '运行' }, { k: 'Pending', l: '启动中' }, { k: 'Failed', l: '失败' }, { k: 'Other', l: '其它' }]" :key="f.k"
          @click="podFilter = podFilter === f.k ? 'All' : f.k"
          class="inline-flex items-center gap-1 px-sm py-1 rounded-full text-xs font-medium border transition-colors"
          :class="podFilter === f.k ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:bg-surface-container'">
          {{ f.l }}<span class="font-mono opacity-70">{{ f.k === 'All' ? managedPods.length : (podStatusCounts[f.k] || 0) }}</span>
        </button>
      </div>

      <!-- Pod 卡片网格（复用共享 PodCard，与 Overview/Service 同组件）-->
      <div v-if="filteredPods.length" class="grid grid-cols-1 xl:grid-cols-2 gap-sm">
        <PodCard v-for="p in filteredPods" :key="p.name"
          :pod="p" :name-base="workload?.name"
          :show-terminal="false" show-delete
          @click="goPodDetail" @delete="confirmDeletePod($event)">
          <template #actions>
            <button @click.stop="openExec(p)" class="p-0.5 rounded hover:bg-primary/10 text-on-surface-variant/50 hover:text-primary transition-colors shrink-0" title="打开终端（浮动窗口）">
              <span class="material-symbols-outlined text-sm">terminal</span>
            </button>
          </template>
        </PodCard>
      </div>

      <!-- 空状态 -->
      <div v-else class="rounded-xl bg-surface-container-lowest border border-dashed border-outline-variant/50 py-xl text-center">
        <span class="material-symbols-outlined text-3xl text-surface-container-high">pod</span>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ managedPods.length ? '该过滤条件下无 Pod' : '该工作负载暂无运行实例' }}</p>
      </div>
    </div>

    <!-- ====== Revisions Tab ====== -->
    <div v-if="activeTab === 'revisions'">
      <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
        <table class="w-full text-left">
          <thead><tr class="border-b border-outline-variant bg-surface-container-low/50">
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Rev</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Image</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Replicas</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Age</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant w-20">Actions</th>
          </tr></thead>
          <tbody class="divide-y divide-outline-variant/15">
            <tr v-for="rev in revisions" :key="rev.rev" class="hover:bg-surface-container-low/40">
              <td class="px-md py-2"><span class="text-body-sm font-bold" :class="rev.current ? 'text-primary' : ''">Rev {{ rev.rev }}</span><span v-if="rev.current" class="ml-xs text-xs text-primary">●</span></td>
              <td class="px-md py-2 font-mono text-xs truncate max-w-[200px]">{{ rev.image }}</td>
              <td class="px-md py-2 text-xs">{{ rev.readyReplicas }}/{{ rev.desiredReplicas }}</td>
              <td class="px-md py-2 text-xs text-on-surface-variant">{{ rev.age }}</td>
              <td class="px-md py-2"><button v-if="!rev.current" @click="confirmRollback(rev)" class="text-xs text-primary hover:underline">回滚</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ====== YAML Tab（直接由列表已返回的 workload.raw 生成，无额外请求）====== -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="workloadYaml" :readonly="false" height="560px" @save="onYamlSave" />
    </div>

    <!-- ====== Events Tab ====== -->
    <div v-if="activeTab === 'events'" class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
      <table class="w-full text-left">
        <thead><tr class="border-b border-outline-variant bg-surface-container-low/50">
          <th class="px-md py-2 text-xs font-medium text-on-surface-variant">对象</th>
          <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Reason</th>
          <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Type</th>
          <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Message</th>
          <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Age</th>
        </tr></thead>
        <tbody class="divide-y divide-outline-variant/15">
          <tr v-for="(e, i) in workloadEvents.slice(0, 100)" :key="i" class="hover:bg-surface-container-low/30">
            <td class="px-md py-2 text-xs"><span class="text-on-surface-variant/60">{{ e.relatedKind }}</span> <span class="font-mono text-on-surface">{{ e.relatedName }}</span></td>
            <td class="px-md py-2 text-xs font-medium" :class="e.type === 'warning' ? 'text-error' : 'text-on-surface'">{{ e.reason }}</td>
            <td class="px-md py-2"><span class="text-xs px-1.5 py-0.5 rounded" :class="e.type === 'warning' ? 'bg-error/10 text-error' : 'bg-primary/10 text-primary'">{{ e.type }}</span></td>
            <td class="px-md py-2 text-xs text-on-surface-variant truncate max-w-[400px]" :title="e.message">{{ e.message }}</td>
            <td class="px-md py-2 text-xs text-on-surface-variant">{{ e.age }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!workloadEvents.length" class="py-md text-center text-body-sm text-on-surface-variant">暂无事件</p>
    </div>
  </div>

  <!-- Not Found -->
  <div v-else class="text-center py-xl">
    <span class="material-symbols-outlined text-4xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">Workload Not Found</h2>
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

  <!-- 删除 Pod（控制器会重建并重新拉镜像） -->
  <Modal v-model="showDeletePodModal" title="删除 Pod" width="max-w-md">
    <p class="text-body-md">删除 Pod <b class="font-mono text-xs">{{ deletePodTarget?.name }}</b>？</p>
    <p class="text-body-sm text-on-surface-variant mt-sm">Deployment/ReplicaSet 控制器会立即拉起一个新 Pod（会重新触发镜像拉取）。适用于镜像补传后仍卡在 PullImage/ImagePullBackOff 的 Pod。</p>
    <template #actions>
      <button @click="showDeletePodModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
      <button @click="handleDeletePod" class="px-md py-sm bg-error text-on-error rounded-lg font-semibold">删除</button>
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

  <Modal v-model="showEditModal" title="Edit Workload" width="max-w-3xl">
    <div class="flex flex-col gap-md max-h-[70vh] overflow-y-auto pr-xs">
      <!-- 基本配置（镜像 / 副本 / 分层） -->
      <section class="rounded-xl border border-outline-variant p-md bg-surface-container-lowest">
        <div class="flex items-center gap-xs mb-md"><span class="material-symbols-outlined text-primary text-lg">info</span><h4 class="text-body-sm font-semibold text-on-surface">基本配置</h4></div>
        <div class="grid grid-cols-2 gap-sm">
          <div class="col-span-2 grid grid-cols-[1fr_180px] gap-sm">
            <div>
              <label class="text-xs font-medium text-on-surface-variant block mb-xs">镜像仓库（不可改）</label>
              <input :value="editForm.imageRepo" readonly class="w-full bg-surface-container-low border border-outline-variant rounded-md px-md py-sm text-body-sm font-mono opacity-60" />
            </div>
            <div>
              <label class="text-xs font-medium text-on-surface-variant block mb-xs">版本 Tag</label>
              <input v-model="editForm.imageTag" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="v1.0.0" />
            </div>
          </div>
          <div v-if="isScalable"><label class="text-xs font-medium text-on-surface-variant block mb-xs">Replicas</label><input v-model.number="editForm.replicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-md py-sm text-body-sm focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" /></div>
          <div v-if="isCronJob"><label class="text-xs font-medium text-on-surface-variant block mb-xs">Schedule</label><input v-model="editForm.schedule" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="*/5 * * * *" /></div>
          <div class="col-span-2"><p class="text-xs text-on-surface-variant/60">新镜像预览：<span class="font-mono text-primary">{{ editForm.imageRepo }}:{{ editForm.imageTag || '?' }}</span></p></div>
        </div>
        <div class="mt-md pt-md border-t border-outline-variant/40">
          <label class="text-xs font-medium text-on-surface-variant block mb-xs">分层</label>
          <div class="flex flex-wrap gap-xs">
            <button v-for="t in tierOptions" :key="t.value" @click="editForm.tier = t.value" class="flex items-center gap-xs px-sm py-xs rounded-lg border text-body-sm transition-colors" :class="editForm.tier === t.value ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:bg-surface-container'">
              <span class="material-symbols-outlined text-sm">{{ t.icon }}</span>{{ t.label }}
            </button>
          </div>
        </div>
      </section>

      <!-- ===== 容器 / Pod 模板（仅 Deployment/StatefulSet/DaemonSet）===== -->
      <div v-if="isRolloutType" class="flex flex-col gap-md">
        <!-- 容器（主 + Init + Sidecar）统一区 -->
        <section class="rounded-xl border border-outline-variant p-md bg-surface-container-lowest flex flex-col gap-sm">
          <div class="flex items-center gap-xs mb-sm"><span class="material-symbols-outlined text-primary text-lg">view_in_ar</span><h4 class="text-body-sm font-semibold text-on-surface">容器</h4></div>
          <div class="text-xs font-semibold text-on-surface-variant">主容器</div>
          <div class="grid grid-cols-3 gap-xs">
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">拉取策略</label><select v-model="editForm.imagePullPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"><option>IfNotPresent</option><option>Always</option><option>Never</option></select></div>
            <div class="col-span-2"><label class="text-xs font-medium text-on-surface-variant block mb-xs">Command</label><input v-model="editForm.command" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="/app/server (空格分隔)" /></div>
            <div class="col-span-2"><label class="text-xs font-medium text-on-surface-variant block mb-xs">Args</label><input v-model="editForm.args" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="--port 8080 (空格分隔)" /></div>
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">Working Dir</label><input v-model="editForm.workingDir" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="/app" /></div>
          </div>
          <div class="grid grid-cols-4 gap-xs">
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">CPU Req</label><input v-model="editForm.cpuReq" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="250m" /></div>
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">CPU Lim</label><input v-model="editForm.cpuLim" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="500m" /></div>
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">Mem Req</label><input v-model="editForm.memReq" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="256Mi" /></div>
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">Mem Lim</label><input v-model="editForm.memLim" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="512Mi" /></div>
          </div>
          <div class="flex items-center justify-between pt-sm border-t border-outline-variant/40"><span class="text-xs font-semibold text-on-surface-variant">Init 容器</span><button @click="editForm.initContainers.push({ name: '', image: '', command: '', args: '', cpuReq: '', cpuLim: '', memReq: '', memLim: '' })" class="flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>添加</button></div>
          <div v-for="(c, i) in editForm.initContainers" :key="'ic'+i" class="rounded-lg border border-outline-variant/60 p-sm bg-surface-container-low/30 grid grid-cols-3 gap-xs">
            <input v-model="c.name" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="名称" />
            <input v-model="c.image" class="col-span-2 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="镜像" />
            <input v-model="c.command" class="col-span-3 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="command (空格)" />
            <input v-model="c.cpuReq" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="cpuReq" />
            <input v-model="c.cpuLim" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="cpuLim" />
            <div class="flex gap-xs"><input v-model="c.memReq" class="flex-1 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="memReq" /><button @click="editForm.initContainers.splice(i, 1)" class="p-0.5 flex-shrink-0 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button></div>
          </div>
          <div class="flex items-center justify-between"><span class="text-xs font-semibold text-on-surface-variant">Sidecar 容器</span><button @click="editForm.extraContainers.push({ name: '', image: '', command: '', args: '', cpuReq: '', cpuLim: '', memReq: '', memLim: '' })" class="flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>添加</button></div>
          <div v-for="(c, i) in editForm.extraContainers" :key="'ec'+i" class="rounded-lg border border-outline-variant/60 p-sm bg-surface-container-low/30 grid grid-cols-3 gap-xs">
            <input v-model="c.name" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="名称" />
            <input v-model="c.image" class="col-span-2 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="镜像" />
            <input v-model="c.command" class="col-span-3 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="command (空格)" />
            <input v-model="c.cpuReq" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="cpuReq" />
            <input v-model="c.cpuLim" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="cpuLim" />
            <div class="flex gap-xs"><input v-model="c.memReq" class="flex-1 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="memReq" /><button @click="editForm.extraContainers.splice(i, 1)" class="p-0.5 flex-shrink-0 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button></div>
          </div>
        </section>

        <!-- 端口 -->
        <section class="rounded-xl border border-outline-variant p-md bg-surface-container-lowest">
          <div class="flex items-center gap-xs mb-md">
            <span class="material-symbols-outlined text-primary text-lg">lan</span>
            <h4 class="text-body-sm font-semibold text-on-surface">端口</h4>
            <button @click="editForm.ports.push({ containerPort: '', protocol: 'TCP' })" class="ml-auto flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>添加</button>
          </div>
          <div v-for="(p, i) in editForm.ports" :key="i" class="flex items-center gap-xs">
            <input v-model.number="p.containerPort" type="number" class="w-28 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="8080" />
            <input v-model="p.protocol" class="w-24 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="TCP" />
            <button @click="editForm.ports.splice(i, 1)" class="p-0.5 flex-shrink-0 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
        </section>

        <!-- 环境变量 -->
        <section class="rounded-xl border border-outline-variant p-md bg-surface-container-lowest flex flex-col gap-md">
          <div class="flex items-center gap-xs"><span class="material-symbols-outlined text-primary text-lg">key</span><h4 class="text-body-sm font-semibold text-on-surface">环境变量</h4></div>
          <div class="flex flex-col gap-xs">
            <div class="flex items-center justify-between"><span class="text-xs font-semibold text-on-surface-variant">普通</span><button @click="editForm.env.push({ key: '', value: '' })" class="flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>添加</button></div>
            <div v-for="(e, i) in editForm.env" :key="i" class="flex items-center gap-xs">
              <input v-model="e.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="KEY" />
              <input v-model="e.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="val" />
              <button @click="editForm.env.splice(i, 1)" class="p-0.5 flex-shrink-0 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button>
            </div>
          </div>
          <div class="flex flex-col gap-xs">
            <div class="flex items-center justify-between"><span class="text-xs font-semibold text-on-surface-variant">ConfigMap 键引用</span><button @click="editForm.envCMKeys.push({ name: '', cmName: '', key: '' })" class="flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>添加</button></div>
            <div v-for="(e, i) in editForm.envCMKeys" :key="'cm'+i" class="flex items-center gap-xs">
              <input v-model="e.name" class="w-28 flex-shrink-0 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="ENV 名" />
              <EnvSourceField kind="configmap" :namespace="route.params.namespace" class="flex-1" v-model:name="e.cmName" v-model:dataKey="e.key" />
              <button @click="editForm.envCMKeys.splice(i, 1)" class="p-0.5 flex-shrink-0 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button>
            </div>
          </div>
          <div class="flex flex-col gap-xs">
            <div class="flex items-center justify-between"><span class="text-xs font-semibold text-on-surface-variant">Secret 键引用</span><button @click="editForm.envSecretKeys.push({ name: '', secretName: '', key: '' })" class="flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>添加</button></div>
            <div v-for="(e, i) in editForm.envSecretKeys" :key="'sk'+i" class="flex items-center gap-xs">
              <input v-model="e.name" class="w-28 flex-shrink-0 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="ENV 名" />
              <EnvSourceField kind="secret" :namespace="route.params.namespace" class="flex-1" v-model:name="e.secretName" v-model:dataKey="e.key" />
              <button @click="editForm.envSecretKeys.splice(i, 1)" class="p-0.5 flex-shrink-0 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-xs">
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">envFrom ConfigMap</label><EnvSourceField kind="configmap" :namespace="route.params.namespace" :with-key="false" v-model:name="editForm.envFromConfigMap" /></div>
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">envFrom Secret</label><EnvSourceField kind="secret" :namespace="route.params.namespace" :with-key="false" v-model:name="editForm.envFromSecret" /></div>
          </div>
        </section>

        <!-- 探针（三种 × 全时序） -->
        <section class="rounded-xl border border-outline-variant p-md bg-surface-container-lowest flex flex-col gap-sm">
          <div class="flex items-center gap-xs mb-sm"><span class="material-symbols-outlined text-primary text-lg">monitor_heart</span><h4 class="text-body-sm font-semibold text-on-surface">健康探针</h4></div>
          <div v-for="probe in [{ k: 'liveness', label: 'Liveness' }, { k: 'readiness', label: 'Readiness' }, { k: 'startup', label: 'Startup' }]" :key="probe.k" class="rounded-lg border border-outline-variant/60 p-sm bg-surface-container-low/30">
            <div class="flex items-center gap-sm mb-xs">
              <label class="flex items-center gap-xs text-body-sm font-medium"><input type="checkbox" v-model="editForm[probe.k].enabled" class="h-4 w-4 accent-primary" /> {{ probe.label }}</label>
              <select v-if="editForm[probe.k].enabled" v-model="editForm[probe.k].type" class="ml-auto bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"><option value="http">HTTP</option><option value="tcp">TCP</option><option value="exec">Exec</option></select>
            </div>
            <div v-if="editForm[probe.k].enabled" class="grid grid-cols-3 gap-xs">
              <div v-if="editForm[probe.k].type === 'http'"><label class="text-xs font-medium text-on-surface-variant block mb-xs">HTTP Path</label><input v-model="editForm[probe.k].httpPath" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="/health" /></div>
              <div v-if="editForm[probe.k].type !== 'exec'"><label class="text-xs font-medium text-on-surface-variant block mb-xs">Port</label><input v-model.number="editForm[probe.k].port" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="8080" /></div>
              <div v-if="editForm[probe.k].type === 'exec'" class="col-span-2"><label class="text-xs font-medium text-on-surface-variant block mb-xs">Exec Command</label><input v-model="editForm[probe.k].execCommand" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="/bin/sh -c healthy" /></div>
              <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">Initial Delay</label><input v-model.number="editForm[probe.k].initialDelaySeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" /></div>
              <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">Period</label><input v-model.number="editForm[probe.k].periodSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" /></div>
              <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">Timeout</label><input v-model.number="editForm[probe.k].timeoutSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" /></div>
              <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">Failure</label><input v-model.number="editForm[probe.k].failureThreshold" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" /></div>
              <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">Success</label><input v-model.number="editForm[probe.k].successThreshold" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" /></div>
            </div>
          </div>
        </section>

        <!-- 卷与挂载 -->
        <section class="rounded-xl border border-outline-variant p-md bg-surface-container-lowest">
          <div class="flex items-center gap-xs mb-md">
            <span class="material-symbols-outlined text-primary text-lg">storage</span>
            <h4 class="text-body-sm font-semibold text-on-surface">卷与挂载</h4>
            <button @click="addVolumeMount" class="ml-auto flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>添加</button>
          </div>
          <div class="flex flex-col gap-sm">
            <VolumeMountCard v-for="(v, i) in editForm.volumeMounts" :key="'v'+i" v-model="editForm.volumeMounts[i]" :containers="containerTargets" :pvcs="availablePVCs" :namespace="route.params.namespace" @remove="editForm.volumeMounts.splice(i, 1)" />
          </div>
        </section>

        <!-- 安全上下文 + 生命周期 -->
        <section class="rounded-xl border border-outline-variant p-md bg-surface-container-lowest flex flex-col gap-sm">
          <div class="flex items-center gap-xs mb-sm"><span class="material-symbols-outlined text-primary text-lg">shield</span><h4 class="text-body-sm font-semibold text-on-surface">安全上下文 & 生命周期</h4></div>
          <label class="flex items-center gap-xs text-body-sm"><input type="checkbox" v-model="editForm.securityContext.enabled" class="h-4 w-4 accent-primary" /> 启用 securityContext</label>
          <div v-if="editForm.securityContext.enabled" class="grid grid-cols-3 gap-xs">
            <label class="flex items-center gap-xs text-xs text-on-surface-variant"><input type="checkbox" v-model="editForm.securityContext.privileged" class="h-4 w-4 accent-primary" /> privileged</label>
            <label class="flex items-center gap-xs text-xs text-on-surface-variant"><input type="checkbox" v-model="editForm.securityContext.runAsNonRoot" class="h-4 w-4 accent-primary" /> runAsNonRoot</label>
            <label class="flex items-center gap-xs text-xs text-on-surface-variant"><input type="checkbox" v-model="editForm.securityContext.readOnlyRootFilesystem" class="h-4 w-4 accent-primary" /> 只读根文件系统</label>
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">runAsUser</label><input v-model="editForm.securityContext.runAsUser" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="1000" /></div>
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">runAsGroup</label><input v-model="editForm.securityContext.runAsGroup" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="1000" /></div>
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">capabilities add</label><input v-model="editForm.securityContext.addCaps" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="NET_BIND_SERVICE (逗号)" /></div>
            <div class="col-span-3"><label class="text-xs font-medium text-on-surface-variant block mb-xs">capabilities drop</label><input v-model="editForm.securityContext.dropCaps" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="ALL (逗号)" /></div>
          </div>
          <div class="grid grid-cols-2 gap-xs">
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">Lifecycle postStart</label><input v-model="editForm.lifecycle.postStart" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="/bin/sh -c init (exec)" /></div>
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">Lifecycle preStop</label><input v-model="editForm.lifecycle.preStop" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="/bin/sh -c stop (exec)" /></div>
          </div>
        </section>

        <!-- 调度 -->
        <section class="rounded-xl border border-outline-variant p-md bg-surface-container-lowest flex flex-col gap-sm">
          <div class="flex items-center gap-xs mb-sm"><span class="material-symbols-outlined text-primary text-lg">device_hub</span><h4 class="text-body-sm font-semibold text-on-surface">调度（Pod 级）</h4></div>
          <div class="grid grid-cols-3 gap-xs">
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">ServiceAccount</label><input v-model="editForm.serviceAccountName" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="default" /></div>
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">PriorityClass</label><input v-model="editForm.priorityClassName" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="高优先级类名" /></div>
            <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">ImagePullSecret</label><input v-model="editForm.imagePullSecrets" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="regcred" /></div>
          </div>
          <div class="flex items-center justify-between"><span class="text-xs font-semibold text-on-surface-variant">nodeSelector</span><button @click="editForm.nodeSelectors.push({ key: '', value: '' })" class="flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>添加</button></div>
          <div v-for="(n, i) in editForm.nodeSelectors" :key="'ns'+i" class="flex items-center gap-xs">
            <input v-model="n.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="disktype" />
            <input v-model="n.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="ssd" />
            <button @click="editForm.nodeSelectors.splice(i, 1)" class="p-0.5 flex-shrink-0 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
          <div class="flex items-center justify-between"><span class="text-xs font-semibold text-on-surface-variant">tolerations</span><button @click="editForm.tolerations.push({ key: '', operator: 'Equal', value: '', effect: 'NoSchedule' })" class="flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>添加</button></div>
          <div v-for="(t, i) in editForm.tolerations" :key="'tol'+i" class="grid grid-cols-4 gap-xs">
            <input v-model="t.key" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="key" />
            <select v-model="t.operator" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"><option>Equal</option><option>Exists</option></select>
            <input v-model="t.value" :disabled="t.operator === 'Exists'" class="bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono disabled:opacity-40 focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="value" />
            <div class="flex gap-xs"><select v-model="t.effect" class="flex-1 bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"><option>NoSchedule</option><option>PreferNoSchedule</option><option>NoExecute</option></select><button @click="editForm.tolerations.splice(i, 1)" class="p-0.5 flex-shrink-0 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button></div>
          </div>
        </section>

      </div>

      <!-- 更新策略（Deployment 级） -->
      <section v-if="workload?.type === 'Deployment'" class="rounded-xl border border-outline-variant p-md bg-surface-container-lowest flex flex-col gap-sm">
        <div class="flex items-center gap-xs mb-sm"><span class="material-symbols-outlined text-primary text-lg">autorenew</span><h4 class="text-body-sm font-semibold text-on-surface">更新策略</h4></div>
        <div class="grid grid-cols-4 gap-xs">
          <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">类型</label><select v-model="editForm.strategy" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"><option>RollingUpdate</option><option>Recreate</option></select></div>
          <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">maxSurge</label><input v-model="editForm.maxSurge" :disabled="editForm.strategy !== 'RollingUpdate'" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono disabled:opacity-40 focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="25%" /></div>
          <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">maxUnavailable</label><input v-model="editForm.maxUnavailable" :disabled="editForm.strategy !== 'RollingUpdate'" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono disabled:opacity-40 focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="25%" /></div>
          <div><label class="text-xs font-medium text-on-surface-variant block mb-xs">revisionHistory</label><input v-model.number="editForm.revisionHistoryLimit" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors" placeholder="10" /></div>
        </div>
      </section>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg">Cancel</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">Save</button>
    </template>
  </Modal>

  <Modal v-model="showMetaModal" title="业务元数据" width="max-w-2xl">
    <div class="flex flex-col gap-md">
      <!-- 业务元数据（canonical aliangboard.io/* 键） -->
      <div class="flex flex-col gap-sm">
        <p class="text-xs font-semibold text-on-surface-variant">业务元数据 <span class="text-on-surface-variant/50 font-normal">写入 aliangboard.io/* 标签，用于卡片标题 / 负责人 / 版本展示</span></p>
        <div class="grid grid-cols-2 gap-sm">
          <div><label class="text-xs text-on-surface-variant block mb-xs">标题 title</label><input v-model="metaForm.title" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="展示用名称" /></div>
          <div><label class="text-xs text-on-surface-variant block mb-xs">负责人 owner</label><input v-model="metaForm.owner" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="团队 / 负责人" /></div>
          <div><label class="text-xs text-on-surface-variant block mb-xs">版本 version</label><input v-model="metaForm.version" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="v1.0.0" /></div>
          <div><label class="text-xs text-on-surface-variant block mb-xs">标签 tags</label><TagInput v-model="metaForm.tags" :namespace="route.params.namespace" :max="3" /></div>
          <div class="col-span-2"><label class="text-xs text-on-surface-variant block mb-xs">描述 description <span class="text-on-surface-variant/50">→ annotation</span></label><textarea v-model="metaForm.description" rows="2" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm resize-none" placeholder="一句话描述（写入注解，免 label 长度限制）" /></div>
          <div class="col-span-2">
            <label class="text-xs text-on-surface-variant block mb-xs">分层 layer</label>
            <div class="flex flex-wrap gap-xs">
              <button v-for="t in tierOptions" :key="t.value" @click="metaForm.layer = metaForm.layer === t.value ? '' : t.value" :title="t.desc" class="flex items-center gap-xs px-sm py-xs rounded-lg border text-body-sm" :class="metaForm.layer === t.value ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant'">
                <span class="material-symbols-outlined text-sm">{{ t.icon }}</span>{{ t.label }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 自定义 Labels -->
      <div class="pt-md border-t border-outline-variant/40 flex flex-col gap-sm">
        <div class="flex items-center justify-between"><p class="text-xs font-semibold text-on-surface-variant">自定义 Labels</p><button @click="addMetaLabel" class="text-xs text-primary hover:underline">+ 添加</button></div>
        <div v-for="(l, i) in metaForm.labels" :key="i" class="flex items-center gap-xs">
          <input v-model="l.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="key" />
          <input v-model="l.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="value" />
          <button @click="metaForm.labels.splice(i, 1)" class="text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">close</span></button>
        </div>
        <p v-if="!metaForm.labels.length" class="text-xs text-on-surface-variant/50">无自定义标签</p>
      </div>

      <!-- Annotations（注解） -->
      <div class="pt-md border-t border-outline-variant/40 flex flex-col gap-sm">
        <div class="flex items-center justify-between"><p class="text-xs font-semibold text-on-surface-variant">Annotations（注解）</p><button @click="addMetaAnnotation" class="text-xs text-primary hover:underline">+ 添加</button></div>
        <div v-for="(a, i) in metaForm.annotations" :key="i" class="flex items-start gap-xs">
          <input v-model="a.key" class="w-2/5 bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="key" />
          <input v-model="a.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono" placeholder="value" />
          <button @click="metaForm.annotations.splice(i, 1)" class="mt-1 text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">close</span></button>
        </div>
        <p v-if="!metaForm.annotations.length" class="text-xs text-on-surface-variant/50">无注解</p>
      </div>

      <p class="text-xs text-on-surface-variant/50 flex items-center gap-xs"><span class="material-symbols-outlined text-sm">info</span>业务标签会同步写入 Pod 模板；若与当前不一致将触发一次滚动更新（annotation 仅写工作负载，不触发滚动）。</p>
    </div>
    <template #actions>
      <button @click="showMetaModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
      <button @click="saveMeta" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">保存</button>
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
        <div><label class="text-xs text-on-surface-variant">名称</label><input v-model="exposeForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" /></div>
        <div><label class="text-xs text-on-surface-variant">类型</label><select v-model="exposeForm.type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm"><option>ClusterIP</option><option>NodePort</option><option>LoadBalancer</option></select></div>
      </div>
      <div v-for="(p, i) in exposeForm.ports" :key="i" class="flex items-center gap-xs">
        <input v-model.number="p.port" type="number" class="w-24 bg-surface-container-low border border-outline-variant rounded px-md py-sm text-body-sm font-mono" placeholder="port" />
        <span class="text-on-surface-variant">:</span>
        <input v-model.number="p.targetPort" type="number" class="w-28 bg-surface-container-low border border-outline-variant rounded px-md py-sm text-body-sm font-mono" placeholder="target" />
        <button @click="exposeForm.ports.splice(i, 1)" class="text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">close</span></button>
      </div>
      <button @click="exposeForm.ports.push({ port: '', targetPort: '', protocol: 'TCP' })" class="self-start text-xs text-primary">+ 端口</button>
    </div>
    <template #actions>
      <button @click="showExposeModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
      <button @click="saveExpose" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">创建</button>
    </template>
  </Modal>

  <Modal v-model="showIngressMapModal" title="加 Ingress 映射" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div><label class="text-xs text-on-surface-variant">Host</label><input v-model="ingressMapForm.host" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="app.example.com" /></div>
      <div class="grid grid-cols-2 gap-md">
        <div><label class="text-xs text-on-surface-variant">Path</label><input v-model="ingressMapForm.path" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="/" /></div>
        <div><label class="text-xs text-on-surface-variant">Service</label><select v-model="ingressMapForm.serviceName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono"><option v-for="s in relatedServices" :key="s.name" :value="s.name">{{ s.name }}</option></select></div>
      </div>
      <div><label class="text-xs text-on-surface-variant">Port</label><input v-model="ingressMapForm.servicePort" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="80" /></div>
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
        <label class="text-xs text-on-surface-variant block mb-xs">镜像仓库（不可改）</label>
        <input :value="imageTagForm.repo" readonly class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono opacity-60" />
      </div>
      <details class="rounded-lg border border-outline-variant/60">
        <summary class="cursor-pointer px-md py-sm text-xs text-on-surface-variant flex items-center gap-xs"><span class="material-symbols-outlined text-sm">lock</span>Registry 认证（私有仓库可选）</summary>
        <div class="grid grid-cols-2 gap-sm px-md pb-md">
          <input v-model="registryAuth.username" placeholder="用户名" class="bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-body-sm font-mono" />
          <input v-model="registryAuth.password" type="password" placeholder="密码" class="bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-body-sm font-mono" />
        </div>
      </details>
      <div>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-xs text-on-surface-variant">版本 Tag</label>
          <button @click="fetchTags" :disabled="tagLoading" class="text-xs text-primary hover:underline flex items-center gap-0.5 disabled:opacity-50">
            <span class="material-symbols-outlined text-sm" :class="tagLoading ? 'animate-spin' : ''">{{ tagLoading ? 'progress_activity' : 'cloud_download' }}</span>{{ tagLoading ? '拉取中' : '拉取可用版本' }}
          </button>
        </div>
        <input v-model="imageTagForm.newTag" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="v3.5.1" @keydown.enter="saveImageTag" />
        <div v-if="availableTags.length" class="flex flex-wrap gap-1 mt-sm max-h-32 overflow-y-auto p-xs bg-surface-container-low/40 rounded-lg">
          <button v-for="t in availableTags" :key="t" @click="pickTag(t)" class="px-1.5 py-0.5 rounded text-xs font-mono border transition-colors" :class="imageTagForm.newTag === t ? 'bg-primary text-on-primary border-primary font-semibold' : 'bg-surface-container-lowest text-on-surface border-outline-variant hover:border-primary'">{{ t }}</button>
        </div>
        <p v-if="tagError" class="text-xs text-error mt-xs flex items-center gap-0.5"><span class="material-symbols-outlined text-sm">error</span>{{ tagError }}</p>
      </div>
      <p class="text-xs text-on-surface-variant">新镜像：<span class="font-mono text-primary break-all">{{ imageTagForm.repo }}:{{ imageTagForm.newTag || '?' }}</span></p>
    </div>
    <template #actions>
      <button @click="showImageTagModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
      <button @click="saveImageTag" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">更新</button>
    </template>
  </Modal>

  <!-- 端口转发（选中 Pod） -->
  <PortForwardPanel v-model="showPortForward" kind="Pod" :name="selectedPod?.name || ''" :namespace="route.params.namespace" :suggested-ports="pfSuggestedPorts" />

  <!-- 文件浏览器（选中 Pod） -->
  <FileBrowser v-model="showFileBrowser" :namespace="route.params.namespace" :pod="selectedPod?.name || ''" :container="fileBrowserContainer" />

  <!-- YAML 变更 diff 预览 -->
  <Modal v-model="showDiffModal" title="变更预览 · Diff" width="max-w-3xl">
    <p v-if="!diffStat.add && !diffStat.del" class="text-body-sm text-on-surface-variant py-md text-center">无变更</p>
    <template v-else>
      <div class="flex items-center gap-md mb-sm text-xs">
        <span class="text-status-running font-mono">+{{ diffStat.add }}</span>
        <span class="text-error font-mono">-{{ diffStat.del }}</span>
        <span class="text-on-surface-variant">行变更，确认后 Apply 到集群</span>
      </div>
      <div class="rounded-lg overflow-hidden border border-outline-variant max-h-[55vh] overflow-y-auto bg-[#0b1c30] font-mono text-code-sm">
        <div v-for="(l, i) in diffLines" :key="i" class="flex items-start" :class="l.t === 'add' ? 'bg-status-running/15' : l.t === 'del' ? 'bg-error/15' : ''">
          <span class="w-6 text-center select-none shrink-0" :class="l.t === 'add' ? 'text-status-running' : l.t === 'del' ? 'text-error' : 'text-on-surface-variant/30'">{{ l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' ' }}</span>
          <span class="px-sm whitespace-pre" :class="l.t === 'add' ? 'text-status-running' : l.t === 'del' ? 'text-error' : 'text-[#cfe3ff]/70'">{{ l.v || ' ' }}</span>
        </div>
      </div>
    </template>
    <template #actions>
      <button @click="showDiffModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
      <button @click="confirmApplyYaml" :disabled="!diffStat.add && !diffStat.del" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">Apply</button>
    </template>
  </Modal>
</template>
