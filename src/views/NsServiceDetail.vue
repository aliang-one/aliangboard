<script setup>
// Service 详情页（单页概览 + 统一 Edit 抽屉）：
// - 页面为单一可滚动只读视图，无内容 Tab；头部仅 Edit + ⋮ 操作菜单。
// - 所有 spec 编辑统一进一个 Edit 弹窗（Type · Ports · Selector · Affinity · Traffic Policy · ExternalName）。
// - Port Forward / Export YAML / 查看 YAML / Delete 收进头部 ⋮ 菜单；YAML 用独立弹窗。
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
	import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'
import { extractContainerPorts, extractContainerPortsGrouped } from '@/composables/usePorts'
import { useResourceApply } from '@/composables/useResourceApply'
import { dumpResourceYaml } from '@/composables/useYaml'
import { api, exportYaml } from '@/api/client'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import PodCard from '@/components/common/PodCard.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import DropdownMenu from '@/components/common/DropdownMenu.vue'
import PortSelect from '@/components/common/PortSelect.vue'
import PortForwardPanel from '@/components/common/PortForwardPanel.vue'

const { t } = useI18n()
	const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

// 详情走 Vue Query（单资源 + 15s 轮询）；store CRUD 已接 invalidateResource('services')，编辑后自动刷新。
const cid = computed(() => (store.currentCluster || 'cluster'))
const svcDetail = useResourceDetail({
  key: ['cluster', cid, 'services', route.params.name],
  fetcher: () => store.fetchService(route.params.name, route.params.namespace),
  options: { refetchInterval: 15000 },
})
const svc = computed(() => svcDetail.data.value)

// pods + workloads + events 走 Vue Query（store ref 在 remote 下孤立）
const podsQ = useResourceList({ key: ['cluster', cid, 'pods'], fetcher: () => store.fetchPods(), options: { refetchInterval: 30000 } })
const wlsQ = useResourceList({ key: ['cluster', cid, 'workloads'], fetcher: () => store.fetchWorkloads(), options: { refetchInterval: 30000 } })
const eventsQ = useResourceList({ key: ['cluster', cid, 'events'], fetcher: () => store.fetchEvents(), options: { refetchInterval: 30000 } })
const nsPods = computed(() => (podsQ.data.value || []).filter(p => p.namespace === route.params.namespace))
const nsWorkloads = computed(() => (wlsQ.data.value || []).filter(w => w.namespace === route.params.namespace))
// 容器端口（从 workloads 派生，替代 nsContainerPortGroups/nsContainerPorts）
const nsContainerPortGroups = computed(() => extractContainerPortsGrouped(nsWorkloads.value))
const nsContainerPorts = computed(() => extractContainerPorts(nsWorkloads.value))

const showEditModal = ref(false)
const showYamlModal = ref(false)
const showDeleteModal = ref(false)
const showPortForward = ref(false)

// === 端口：远端用结构化 portList（含 nodePort/名称），mock 回退解析扁平字符串 ===
function parsePortString(str) {
  return String(str || '').split(',').filter(Boolean).map(s => {
    const m = String(s).trim().match(/^(\d+)\s*:\s*([^/]+?)\s*\/?\s*(\w+)?$/)
    if (!m) return { name: '', port: s, targetPort: '', protocol: 'TCP', nodePort: null, appProtocol: '' }
    const tgt = m[2]
    return { name: '', port: Number(m[1]), targetPort: isNaN(tgt) ? tgt : Number(tgt), protocol: m[3] || 'TCP', nodePort: null, appProtocol: '' }
  })
}
const portRows = computed(() => svc.value?.portList?.length ? svc.value.portList : parsePortString(svc.value?.ports))
const hasNodePort = computed(() => svc.value?.type === 'NodePort' || svc.value?.type === 'LoadBalancer')
const forwardPorts = computed(() => portRows.value.map(p => Number(p.port)).filter(n => !isNaN(n)))

// === Endpoints：从 cluster-wide Endpoints 列表按 ns/name 过滤（store ref 在 remote 下孤立）===
const endpointsQ = useResourceList({ key: ['cluster', cid, 'endpoints'], fetcher: () => store.fetchEndpoints(), options: { refetchInterval: 30000 } })
const ep = computed(() => (endpointsQ.data.value || []).find(e => e.name === route.params.name && e.namespace === route.params.namespace))
const epTargets = computed(() => ep.value?.targets || {})
const podByIp = computed(() => {
  const m = {}
  for (const p of nsPods.value) if (p.ip) m[p.ip] = p
  return m
})
const podByName = computed(() => {
  const m = {}
  for (const p of nsPods.value) if (p.name) m[p.name] = p
  return m
})
// 解析端点对应的 backing pod：优先 targetRef 的 pod 名（K8s 权威关联），回退 IP 匹配
function resolvePod(ip) {
  const t = epTargets.value[ip]
  if (t?.podName && podByName.value[t.podName]) return podByName.value[t.podName]
  return podByIp.value[ip] || null
}
const readyAddrs = computed(() => ep.value?.addresses || [])
const notReadyAddrs = computed(() => ep.value?.notReadyAddresses || [])
const epPorts = computed(() => ep.value?.ports || [])
const hasEndpoints = computed(() => !!ep.value)
const selectorPods = computed(() => {
  if (!svc.value?.selector) return []
  const sel = svc.value.selector
  return nsPods.value.filter(p => Object.entries(sel).every(([k, v]) => p.labels?.[k] === v))
})
const readyCount = computed(() => hasEndpoints.value ? readyAddrs.value.length : selectorPods.value.filter(p => p.status === 'Running').length)
const totalCount = computed(() => hasEndpoints.value ? (readyAddrs.value.length + notReadyAddrs.value.length) : selectorPods.value.length)
const endpointsHealthy = computed(() => readyCount.value > 0)
const isExternalName = computed(() => svc.value?.type === 'ExternalName')

// 该 Service 绑定的【全部】工作负载：pod template labels 完全匹配 selector 的工作负载集合。
// Service 的 selector 是 label 查询，可同时匹配多个 workload——这里取全部，供展示与端口选择优先。
const boundWorkloads = computed(() => {
  const sel = svc.value?.selector
  if (!sel || !Object.keys(sel).length) return []
  return nsWorkloads.value.filter(w => {
    const tpl = w.raw?.spec?.template?.metadata?.labels || {}
    return Object.entries(sel).every(([k, v]) => tpl[k] === v)
  })
})
// 全部绑定工作负载名（PortSelect 高亮所有绑定项）
const boundWorkloadNames = computed(() => boundWorkloads.value.map(w => w.name))
// 首个绑定工作负载（PortSelect 自动选中/置顶——多绑定时取第一个作为默认）
const boundWorkload = computed(() => boundWorkloads.value[0]?.name || '')

// === 添加后端工作负载：把指定 workload 并入 selector ===
// K8s selector 是 label 的 AND 查询，无法「A 或 B」。要让 A、B 同时被选中，selector 必须是
// 它们共有的 label（同 key 同 value 的交集）。故新 selector = (当前绑定 ∪ 所选) 的 template label 交集。
const tplLabels = w => w?.raw?.spec?.template?.metadata?.labels || {}
const showAddBackendModal = ref(false)
const pickedBackend = ref('')
const unmatchedWorkloads = computed(() =>
  nsWorkloads.value.filter(w => !boundWorkloadNames.value.includes(w.name)))
// 把指定 workload 并入后端后的新 selector = (当前绑定 ∪ 该 workload) 的 template label 交集
function mergedSelectorFor(name) {
  if (!name) return null
  const picked = nsWorkloads.value.find(w => w.name === name)
  if (!picked) return null
  const targets = [...boundWorkloads.value, picked]
  if (!targets.length) return {}
  const common = {}
  for (const [k, v] of Object.entries(tplLabels(targets[0]))) {
    if (targets.every(w => tplLabels(w)[k] === v)) common[k] = v
  }
  return common
}
// 副作用预警：给定新 selector + 目标集合，会顺带命中哪些其它工作负载
function alsoMatchFor(ms, desiredNames) {
  if (!ms || !Object.keys(ms).length) return []
  const desired = new Set(desiredNames)
  return nsWorkloads.value
    .filter(w => !desired.has(w.name) && Object.entries(ms).every(([k, v]) => tplLabels(w)[k] === v))
    .map(w => w.name)
}
// 「添加后端工作负载」弹窗用
const mergedSelector = computed(() => mergedSelectorFor(pickedBackend.value))
const wouldAlsoMatch = computed(() => alsoMatchFor(mergedSelector.value, [...boundWorkloadNames.value, pickedBackend.value]))
const canAddBackend = computed(() => {
  const ms = mergedSelector.value
  return !!pickedBackend.value && ms && Object.keys(ms).length > 0
})

// === 加端口时自动并入来源工作负载 ===
// PortSelect pick 事件携带来源 workload；手输端口则无来源
const addPortSource = ref(null)
function onPickTarget(detail) { addPortSource.value = detail || null }
// 仅当选中端口号与 pick 一致时来源有效（用户随后手改端口号则来源失效）
const sourceWorkload = computed(() => {
  const s = addPortSource.value
  return s && String(s.port) === String(addPortForm.value.targetPort) ? (s.workload || '') : ''
})
const sourceNonBound = computed(() => !!(sourceWorkload.value && !boundWorkloadNames.value.includes(sourceWorkload.value)))
const portMergeSelector = computed(() => sourceNonBound.value ? mergedSelectorFor(sourceWorkload.value) : null)
const canAutoMerge = computed(() => {
  const ms = portMergeSelector.value
  return !!ms && Object.keys(ms).length > 0
})
const portMergeAlsoMatch = computed(() => sourceNonBound.value ? alsoMatchFor(portMergeSelector.value, [...boundWorkloadNames.value, sourceWorkload.value]) : [])
const autoMergeEnabled = ref(true)
function openAddBackend() { pickedBackend.value = ''; showAddBackendModal.value = true }
async function confirmAddBackend() {
  if (!canAddBackend.value) return
  try {
    const r = await store.updateService(route.params.name, route.params.namespace, { selector: mergedSelector.value })
    if (!r?.ok) return // 失败:store 已 toast 错误;保留弹窗与用户选择
    notify('success', t('ns.svcDetail.backendAddedSuccess'))
    showAddBackendModal.value = false
    pickedBackend.value = ''
  } catch (e) {
    notify('error', e.message || t('ns.svcDetail.backendAddedFailed'))
  }
}

// === 后端 Pod 统一列表：真实 Endpoints 时按地址取 backing pod，否则回退 selector 命中 ===
const backendPods = computed(() => {
  if (isExternalName.value) return []
  if (hasEndpoints.value) {
    const rows = []
    for (const ip of readyAddrs.value) rows.push({ ip, ready: true, pod: resolvePod(ip) })
    for (const ip of notReadyAddrs.value) rows.push({ ip, ready: false, pod: resolvePod(ip) })
    return rows
  }
  return selectorPods.value.map(pod => ({ ip: pod.ip, ready: pod.status === 'Running', pod }))
})
function goPod(pod) {
  router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: pod.name } })
}

// === RBAC：can-i(SSAR) 控制 Edit/Delete（默认允许，SSAR 不可用时不锁死）===
const canMutate = ref(true)
const canDelete = ref(true)
let permsLoaded = false
async function loadPerms() {
  if (!svc.value) return
  const ns = route.params.namespace
  const [u, d] = await Promise.all([
    store.checkAccessServer({ verb: 'update', resource: 'services', namespace: ns }),
    store.checkAccessServer({ verb: 'delete', resource: 'services', namespace: ns }),
  ])
  if (u?.ok) canMutate.value = !!u.allowed
  if (d?.ok) canDelete.value = !!d.allowed
}
watch(svc, s => { if (s && !permsLoaded) { permsLoaded = true; loadPerms() } }, { immediate: true })

// === Events：按 involvedObject 过滤该 Service 的事件。eventsQ 自带 mock 回退(store.eventList)，双模式通用。===
const svcEvents = computed(() => {
  const name = svc.value?.name, ns = svc.value?.namespace
  return (eventsQ.data.value || []).filter(e => e.relatedKind === 'Service' && e.relatedName === name && (!ns || e.relatedNamespace === ns))
})
function goToRelated(event) {
  if (!event.relatedKind || !event.relatedName) return
  const ns = event.relatedNamespace || route.params.namespace
  const k = event.relatedKind, name = event.relatedName
  if (k === 'Pod') router.push({ name: 'NsPodDetail', params: { namespace: ns, name } })
  else if (k === 'Service') router.push({ name: 'NsServiceDetail', params: { namespace: ns, name } })
  else if (k === 'Ingress') router.push({ name: 'NsIngressDetail', params: { namespace: ns, name } })
  else if (k === 'Endpoints') router.push({ name: 'NsEndpoints', params: { namespace: ns } })
}

// === YAML：从缓存对象生成（去 managedFields/status），弹窗内可编辑 + apply ===
const svcYaml = ref('')
const yamlLoading = ref(false)
async function loadYaml() {
  if (!svc.value) return
  yamlLoading.value = true
  try {
    // 从缓存的完整 server 对象生成 YAML（去 managedFields/status）；不再二次 api.k8s 拉取。
    // 必须用完整对象而非 generateYAML 的精简 manifest：此 YAML 可编辑后经 SSA(force=true) apply，
    // 精简 manifest 会丢失 clusterIP/labels/annotations 等服务端字段。
    svcYaml.value = dumpResourceYaml(svc.value?.raw, { stripStatus: true })
  } catch (e) {
    svcYaml.value = `# ${t('ns.svcDetail.loadFailed')}: ${e.message || ''}`
  } finally {
    yamlLoading.value = false
  }
}
function openYaml() {
  showYamlModal.value = true
  if (!svcYaml.value) loadYaml()
}
watch(() => svc.value?.name, () => { svcYaml.value = '' })     // t('ns.svcDetail.serviceChangedReload')
async function onYamlSave(yamlStr) {
  const res = await applyYaml(yamlStr)
  if (res?.ok) { svcYaml.value = ''; loadYaml() }
}
async function exportSvc() {
  if (!svc.value) return
  try {
    await exportYaml(`/api/v1/namespaces/${encodeURIComponent(svc.value.namespace)}/services/${encodeURIComponent(svc.value.name)}`, `${svc.value.name}.yaml`)
    notify('success', t('ns.svcDetail.exportSuccess'))
  } catch (e) { notify('error', e.message || t('ns.svcDetail.exportFailed')) }
}

// === 统一 Edit：Type · Ports · Selector · Session Affinity · Traffic Policy · ExternalName ===
const editForm = ref({ type: 'ClusterIP', ports: [], selector: [], externalName: '', sessionAffinity: 'None', sessionAffinityTimeout: 10800, externalTrafficPolicy: '', internalTrafficPolicy: 'Cluster' })
function openEdit() {
  if (!svc.value) return
  const rows = portRows.value.length
    ? portRows.value.map(p => ({ name: p.name || '', port: p.port, targetPort: p.targetPort ?? '', protocol: p.protocol || 'TCP', nodePort: p.nodePort || '' }))
    : [{ name: '', port: '', targetPort: '', protocol: 'TCP', nodePort: '' }]
  editForm.value = {
    type: svc.value.type,
    ports: rows,
    selector: Object.entries(svc.value.selector || {}).map(([key, value]) => ({ key, value })),
    externalName: svc.value.externalName || '',
    sessionAffinity: svc.value.sessionAffinity || 'None',
    sessionAffinityTimeout: svc.value.sessionAffinityTimeout ?? 10800,
    externalTrafficPolicy: svc.value.externalTrafficPolicy || '',
    internalTrafficPolicy: svc.value.internalTrafficPolicy || 'Cluster',
  }
  showEditModal.value = true
}
function addPortRow() { editForm.value.ports.push({ name: '', port: '', targetPort: '', protocol: 'TCP', nodePort: '' }) }
function removePortRow(idx) { editForm.value.ports.splice(idx, 1) }
function addSelectorRow() { editForm.value.selector.push({ key: '', value: '' }) }
function removeSelectorRow(idx) { editForm.value.selector.splice(idx, 1) }
function saveEdit() {
  const rows = editForm.value.ports.filter(p => p.port !== '' && p.port != null)
  const portList = rows.map(p => {
    const tgt = p.targetPort === '' ? p.port : p.targetPort
    return { name: p.name || '', port: Number(p.port), targetPort: isNaN(tgt) ? tgt : Number(tgt), protocol: p.protocol || 'TCP', nodePort: p.nodePort ? Number(p.nodePort) : null, appProtocol: '' }
  })
  const portsStr = portList.map(p => `${p.port}:${p.targetPort}/${p.protocol}`).join(',')
  const selector = {}
  editForm.value.selector.forEach(r => { if (r.key.trim()) selector[r.key.trim()] = r.value })
  const updates = {
    type: editForm.value.type,
    portList,
    ports: portsStr,
    selector,
    internalTrafficPolicy: editForm.value.internalTrafficPolicy,
  }
  if (editForm.value.type === 'ExternalName' && editForm.value.externalName) updates.externalName = editForm.value.externalName
  if (editForm.value.sessionAffinity === 'ClientIP') {
    updates.sessionAffinity = 'ClientIP'
    if (editForm.value.sessionAffinityTimeout !== '' && editForm.value.sessionAffinityTimeout != null) updates.sessionAffinityTimeout = Number(editForm.value.sessionAffinityTimeout)
  } else {
    updates.sessionAffinity = 'None'
  }
  if (editForm.value.externalTrafficPolicy) updates.externalTrafficPolicy = editForm.value.externalTrafficPolicy
  store.updateService(route.params.name, route.params.namespace, updates).then(r => {
    if (!r?.ok) return // 失败:store 已 toast 错误;保留编辑弹窗(编辑行的 name 由 generateYAML 多端口时自动补齐)
    showEditModal.value = false
  })
  notify('success', t('ns.svcDetail.serviceUpdated'))
}

// === 快速添加端口：为当前 Service 追加一个「同类型」端口（类型由 svc.type 决定，不可混类型）===
const showAddPortModal = ref(false)
const addPortForm = ref({ port: '', targetPort: '', protocol: 'TCP', nodePort: '' })
const addingPort = ref(false)
function openAddPort() {
  addPortForm.value = { port: '', targetPort: '', protocol: 'TCP', nodePort: '' }
  addPortSource.value = null
  autoMergeEnabled.value = true
  showAddPortModal.value = true
}
const addPortNeedsNodePort = computed(() => svc.value?.type === 'NodePort' || svc.value?.type === 'LoadBalancer')
const canAddPort = computed(() => {
  const p = addPortForm.value
  return p.port !== '' && p.port != null && /^\d+$/.test(String(p.port)) && Number(p.port) > 0 && Number(p.port) < 65536
})
async function saveAddPort() {
  if (!canAddPort.value || addingPort.value) return
  addingPort.value = true
  try {
    const f = addPortForm.value
    const tgt = f.targetPort === '' ? f.port : f.targetPort
    const newRow = {
      name: '', port: Number(f.port),
      targetPort: isNaN(tgt) ? tgt : Number(tgt),
      protocol: f.protocol || 'TCP',
      nodePort: addPortNeedsNodePort.value && f.nodePort ? Number(f.nodePort) : null,
      appProtocol: '',
    }
    // 重建完整 portList：现有端口（保留结构）+ 新端口
    const portList = [
      ...portRows.value.map(p => {
        const t = p.targetPort === '' || p.targetPort == null ? p.port : p.targetPort
        return { name: p.name || '', port: Number(p.port), targetPort: isNaN(t) ? t : Number(t), protocol: p.protocol || 'TCP', nodePort: p.nodePort ? Number(p.nodePort) : null, appProtocol: p.appProtocol || '' }
      }),
      newRow,
    ]
    const portsStr = portList.map(p => `${p.port}:${p.targetPort}/${p.protocol}`).join(',')
    // 若选了未绑定工作负载的端口且勾选自动并入 → 同时更新 selector（取共有 label 交集）
    const updates = { portList, ports: portsStr }
    let merged = false
    if (sourceNonBound.value && autoMergeEnabled.value && canAutoMerge.value) {
      updates.selector = portMergeSelector.value
      merged = true
    }
    const r = await store.updateService(route.params.name, route.params.namespace, updates)
    if (!r?.ok) return // 失败:store 已 toast 错误;保留弹窗与已填端口,不误报成功
    showAddPortModal.value = false
    notify('success', merged ? t('ns.svcDetail.addPortWithMerge', { workload: sourceWorkload.value }) : t('ns.svcDetail.addPortSuccess'))
  } catch (e) {
    notify('error', e.message || t('ns.svcDetail.addPortFailed'))
  } finally {
    addingPort.value = false
  }
}

// === 删除端口（重建 portList 去掉指定项；带确认，删除会影响流量）===
const showDeletePortModal = ref(false)
const deletePortIdx = ref(-1)
function askDeletePort(i) {
  if (!canMutate.value) return
  deletePortIdx.value = i
  showDeletePortModal.value = true
}
const deletePortTarget = computed(() => deletePortIdx.value >= 0 ? portRows.value[deletePortIdx.value] : null)
async function confirmDeletePort() {
  const idx = deletePortIdx.value
  if (idx < 0) return
  const rows = portRows.value.filter((_, i) => i !== idx)
  const portList = rows.map(p => {
    const t = p.targetPort === '' || p.targetPort == null ? p.port : p.targetPort
    return { name: p.name || '', port: Number(p.port), targetPort: isNaN(t) ? t : Number(t), protocol: p.protocol || 'TCP', nodePort: p.nodePort ? Number(p.nodePort) : null, appProtocol: p.appProtocol || '' }
  })
  const portsStr = portList.map(p => `${p.port}:${p.targetPort}/${p.protocol}`).join(',')
  try {
    const r = await store.updateService(route.params.name, route.params.namespace, { portList, ports: portsStr })
    if (!r?.ok) return // 失败:store 已 toast 错误;端口仍在列表,不误报删除成功
    notify('success', t('ns.svcDetail.deletePortSuccess'))
  } catch (e) {
    notify('error', e.message || t('ns.svcDetail.deletePortFailed'))
  }
  showDeletePortModal.value = false
  deletePortIdx.value = -1
}

// === 头部 ⋮ 操作菜单 ===
function actionItems() {
  const items = [
    { label: 'Port Forward', icon: 'cable', action: () => { showPortForward.value = true } },
    { label: t('ns.svcDetail.viewEditYaml'), icon: 'description', action: openYaml },
  ]
  items.push({ label: t('ns.svcDetail.exportYaml'), icon: 'download', action: exportSvc })
  items.push({ label: 'Delete Service', icon: 'delete', danger: true, disabled: !canDelete.value, action: () => { showDeleteModal.value = true } })
  return items
}

async function handleDelete() {
  const r = await store.deleteService(route.params.name, route.params.namespace)
  if (!r?.ok) return // 删除失败(如 SA 无权限 403):store 已 toast;留在原地,不跳列表——跳了就像删成功了
  router.push({ name: 'NsServices', params: { namespace: route.params.namespace } })
}

const typeIcon = { ClusterIP: 'lan', NodePort: 'cell_tower', LoadBalancer: 'cloud_sync', ExternalName: 'link' }
</script>

<template>
  <div class="animate-fade-in" v-if="svc">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Services', route: `/ns/${route.params.namespace}/services` },
      { label: route.params.name }
    ]" />

    <!-- Header：身份 + 状态 + Edit + ⋮ -->
    <div class="flex items-center justify-between mt-sm mb-sm flex-wrap gap-sm">
      <div class="flex items-center gap-sm min-w-0">
        <div class="w-10 h-10 rounded-xl bg-primary-container/20 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-primary text-xl">{{ typeIcon[svc.type] || 'hub' }}</span>
        </div>
        <div class="min-w-0">
          <div class="flex items-baseline gap-xs flex-wrap">
            <h1 class="text-headline-md text-on-surface font-bold truncate">{{ svc.name }}</h1>
            <span v-if="isExternalName" class="font-mono text-xs text-on-surface-variant truncate">→ {{ svc.externalName || $t('ns.svcDetail.externalNamePlaceholder') }}</span>
          </div>
          <div class="flex items-center gap-xs mt-0.5 flex-wrap">
            <span class="px-1.5 py-0.5 bg-primary/10 text-primary text-xs rounded font-medium">{{ svc.type }}</span>
            <span v-if="!isExternalName" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium"
              :class="endpointsHealthy ? 'bg-primary-container/10 text-primary' : 'bg-error-container/10 text-error'">
              <span class="w-1.5 h-1.5 rounded-full" :class="endpointsHealthy ? 'bg-primary' : 'bg-error'"></span>
              {{ readyCount }}/{{ totalCount }} ready
            </span>
            <span class="text-xs text-on-surface-variant">Age {{ svc.age }}</span>
            <span class="text-xs text-on-surface-variant">ns: <span class="text-primary font-medium">{{ svc.namespace }}</span></span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-xs shrink-0">
        <button @click="openEdit" :disabled="!canMutate" :title="!canMutate ? t('ns.svcDetail.noUpdatePermission') : ''"
          class="flex items-center gap-xs px-2.5 py-1 bg-primary text-on-primary font-semibold rounded-lg text-xs hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">
          <span class="material-symbols-outlined text-sm">edit</span> Edit
        </button>
        <DropdownMenu :items="actionItems()" />
      </div>
    </div>

    <!-- 单页主体：左 8（连接/端口/端点）| 右 4（选择器/流量策略/元数据/事件）-->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-sm items-start">
      <!-- ===== 左列 ===== -->
      <div class="lg:col-span-8 flex flex-col gap-sm">
        <!-- Connection -->
        <div class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center gap-xs">
            <span class="material-symbols-outlined text-primary text-base">cable</span>
            <span class="text-body-sm font-semibold">Connection</span>
          </div>
          <div class="p-sm grid grid-cols-2 gap-xs">
            <div v-if="isExternalName" class="col-span-2 p-sm rounded-md bg-surface-container-low">
              <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">External Name (CNAME)</p>
              <p class="font-mono text-xs text-primary font-semibold break-all">{{ svc.externalName || '—' }}</p>
            </div>
            <template v-else>
              <div class="p-sm rounded-md bg-surface-container-low">
                <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">Cluster IP</p>
                <p class="font-mono text-xs text-primary font-semibold">{{ svc.clusterIP }}</p>
                <p v-if="svc.clusterIPs?.length > 1" class="font-mono text-[11px] text-on-surface-variant mt-0.5">{{ svc.clusterIPs.join(', ') }}</p>
              </div>
              <div class="p-sm rounded-md bg-surface-container-low">
                <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">External IP</p>
                <div v-if="svc.externalIP && svc.externalIP !== '-'" class="flex flex-wrap gap-1">
                  <span v-for="ip in svc.externalIP.split(',')" :key="ip" class="font-mono text-xs text-primary font-semibold">{{ ip }}</span>
                </div>
                <p v-else class="font-mono text-xs text-on-surface-variant">—</p>
              </div>
              <div v-if="svc.lbIngress?.length" class="col-span-2 p-sm rounded-md bg-surface-container-low">
                <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">LoadBalancer Ingress</p>
                <div class="flex flex-wrap gap-1">
                  <span v-for="(lb, i) in svc.lbIngress" :key="i" class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-primary-container/10 text-primary text-[11px] rounded-full border border-primary/20 font-mono">
                    <span class="material-symbols-outlined text-xs">cloud_done</span>{{ lb.ip || lb.hostname }}
                  </span>
                </div>
              </div>
              <div class="p-sm rounded-md bg-surface-container-low">
                <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">Session Affinity</p>
                <p class="text-xs font-semibold text-on-surface">{{ svc.sessionAffinity }}<span v-if="svc.sessionAffinityTimeout" class="text-on-surface-variant font-normal"> · {{ svc.sessionAffinityTimeout }}s</span></p>
              </div>
              <div class="p-sm rounded-md bg-surface-container-low">
                <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">IP Family</p>
                <p class="text-xs font-semibold text-on-surface">{{ svc.ipFamilyPolicy || (svc.ipFamilies?.length ? svc.ipFamilies.join('/') : 'IPv4') }}</p>
              </div>
            </template>
          </div>
        </div>

        <!-- Ports -->
        <div v-if="!isExternalName" class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-xs min-w-0">
              <span class="material-symbols-outlined text-primary text-base">swap_horiz</span>
              <span class="text-body-sm font-semibold">Service Ports</span>
              <span class="text-[11px] text-on-surface-variant/60 truncate" :title="$t('ns.svcDetail.backendPodsTitle', { ports: epPorts.map(p => p.port).join(' / ') || '—' })">{{ $t('ns.svcDetail.clientPort') }}<span v-if="hasNodePort"> · {{ $t('ns.svcDetail.nodePortExternal') }}</span></span>
            </div>
            <div class="flex items-center gap-xs shrink-0">
              <span class="text-xs text-on-surface-variant">{{ $t('ns.svcDetail.portsCountSuffix', { n: portRows.length }) }}</span>
              <button v-if="canMutate" @click="openAddPort" class="flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-semibold text-primary border border-primary/30 rounded hover:bg-primary/5 transition-colors" :title="$t('ns.svcDetail.quickAddPortHint')">
                <span class="material-symbols-outlined text-sm">add</span>{{ $t('ns.svcDetail.addPort') }}
              </button>
            </div>
          </div>
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-surface-container-low border-b border-outline-variant">
                <th class="px-sm py-1.5 text-xs font-medium text-on-surface-variant">Name</th>
                <th class="px-sm py-1.5 text-xs font-medium text-on-surface-variant">Port</th>
                <th class="px-sm py-1.5 text-xs font-medium text-on-surface-variant">Target</th>
                <th v-if="hasNodePort" class="px-sm py-1.5 text-xs font-medium text-on-surface-variant">Node Port</th>
                <th class="px-sm py-1.5 text-xs font-medium text-on-surface-variant">Protocol</th>
                <th v-if="canMutate && portRows.length" class="px-sm py-1.5 text-xs font-medium text-on-surface-variant w-8">{{ $t('ns.svcDetail.operations') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/15">
              <tr v-for="(p, i) in portRows" :key="i" class="hover:bg-surface-container-low/40 transition-colors group">
                <td class="px-sm py-1.5 text-xs text-on-surface-variant font-mono">{{ p.name || '—' }}</td>
                <td class="px-sm py-1.5 font-mono text-xs text-primary font-semibold">{{ p.port }}</td>
                <td class="px-sm py-1.5 font-mono text-xs text-on-surface">{{ p.targetPort }}</td>
                <td v-if="hasNodePort" class="px-sm py-1.5 font-mono text-xs" :class="p.nodePort ? 'text-tertiary-container font-semibold' : 'text-on-surface-variant'">{{ p.nodePort || '—' }}</td>
                <td class="px-sm py-1.5"><span class="px-1.5 py-0.5 bg-surface-container rounded text-xs font-mono text-on-surface-variant">{{ p.protocol }}</span></td>
                <td v-if="canMutate && portRows.length" class="px-sm py-1.5 text-center">
                  <button @click.stop="askDeletePort(i)" class="p-0.5 rounded text-on-surface-variant/50 hover:text-error hover:bg-error/10 transition-colors" :title="$t('ns.svcDetail.deletePortHint')"><span class="material-symbols-outlined text-base">delete</span></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Endpoints -->
        <div class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-xs">
              <span class="material-symbols-outlined text-primary text-base">hub</span>
              <span class="text-body-sm font-semibold">Endpoints</span>
            </div>
            <span v-if="!isExternalName" class="text-xs font-medium" :class="endpointsHealthy ? 'text-primary' : 'text-error'">{{ readyCount }}/{{ totalCount }} ready</span>
          </div>
          <!-- 提示：后端 Pod = 实际接收流量的进程；其端口对应 Service 的 targetPort，与 Service port 不同 -->
          <div v-if="!isExternalName" class="px-sm py-1 bg-surface-container-low/40 text-[11px] text-on-surface-variant/70 flex items-center gap-xs border-b border-outline-variant/30">
            <span class="material-symbols-outlined text-xs shrink-0">info</span>
            <span class="min-w-0">{{ $t('ns.svcDetail.backendPodsHint', { ports: epPorts.map(p => p.port).join(' / ') || '—' }) }}</span>
          </div>
          <!-- ExternalName -->
          <div v-if="isExternalName" class="p-sm flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-xl">link</span>
            <div>
              <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide">{{ $t('ns.svcDetail.externalNameTarget') }}</p>
              <p class="font-mono text-xs text-primary font-semibold break-all">{{ svc.externalName || '—' }}</p>
            </div>
          </div>
          <!-- 后端 Pod 列表（真实端点 / selector 回退 统一渲染）-->
          <div v-else-if="backendPods.length" class="p-sm max-h-96 overflow-y-auto flex flex-col gap-xs">
            <template v-for="(item, idx) in backendPods" :key="idx">
              <!-- 有 backing pod：统一 PodCard（与 Workload 详情同组件）-->
              <PodCard v-if="item.pod" :pod="item.pod" :ready="item.ready" :show-lifecycle="false" @click="goPod" />
              <!-- 无 backing pod：仅 IP（外部端点 / Pod 不在本命名空间）-->
              <div v-else class="rounded-lg border border-dashed border-outline-variant p-sm flex items-center gap-xs">
                <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="item.ready ? 'bg-primary' : 'bg-tertiary-fixed'"></span>
                <span class="font-mono text-xs text-on-surface-variant">{{ item.ip }}</span>
                <span class="text-[11px] text-on-surface-variant/50">{{ $t('ns.svcDetail.unboundPodHint') }}</span>
                <span class="ml-auto text-[11px] font-medium" :class="item.ready ? 'text-primary' : 'text-tertiary-container'">{{ item.ready ? 'Ready' : 'Not Ready' }}</span>
              </div>
            </template>
          </div>
          <!-- 空 -->
          <div v-else class="p-md text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-2xl text-surface-container-high">search_off</span>
            <p class="text-xs mt-xs">{{ $t('ns.svcDetail.noBackendPods') }}</p>
            <p class="text-[11px] text-on-surface-variant/70 mt-xs" v-if="svc.selector && Object.keys(svc.selector).length">{{ $t('ns.svcDetail.noBackendPodsHint') }}</p>
          </div>
        </div>
      </div>

      <!-- ===== 右列 ===== -->
      <div class="lg:col-span-4 flex flex-col gap-sm">
        <!-- Selector -->
        <div class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center gap-xs">
            <span class="material-symbols-outlined text-primary text-base">filter_alt</span>
            <span class="text-body-sm font-semibold">Selector</span>
            <button v-if="canMutate && !isExternalName" @click="openAddBackend" class="ml-auto flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-dashed border-primary/40 text-primary text-xs hover:bg-primary/5 transition-colors" :title="$t('ns.svcDetail.addBackendHint')">
              <span class="material-symbols-outlined text-sm">add</span>{{ $t('ns.svcDetail.addBackend') }}
            </button>
          </div>
          <div class="p-sm flex flex-wrap gap-xs">
            <template v-if="Object.keys(svc.selector || {}).length">
              <span v-for="(val, key) in svc.selector" :key="key" class="px-1.5 py-0.5 bg-primary-container/10 text-primary text-xs rounded border border-primary/20 font-mono">
                <span class="font-semibold">{{ key }}</span>={{ val }}
              </span>
            </template>
            <p v-else class="text-xs text-on-surface-variant italic">{{ $t('ns.svcDetail.noSelector') }}</p>
          </div>
          <!-- 匹配的工作负载（selector 可同时命中多个 workload）-->
          <div v-if="boundWorkloads.length" class="px-sm pb-sm pt-xs border-t border-outline-variant/30">
            <p class="text-[10px] text-on-surface-variant/60 uppercase tracking-wide mb-xs flex items-center gap-0.5">
              <span class="material-symbols-outlined text-xs">link</span>{{ $t('ns.svcDetail.matchedWorkloads', { n: boundWorkloads.length }) }}
            </p>
            <div class="flex flex-wrap gap-xs">
              <button v-for="w in boundWorkloads" :key="w.name" @click="router.push({ name: 'NsWorkloadDetail', params: { namespace: route.params.namespace, type: (w.type || 'Deployment').toLowerCase(), name: w.name } })" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-secondary/10 text-secondary text-xs border border-secondary/25 hover:bg-secondary/20 transition-colors" :title="$t('ns.svcDetail.viewWorkloadDetail', { name: w.name })">
                <span class="material-symbols-outlined text-sm">work</span>{{ w.name }}<span class="opacity-60">{{ w.type?.replace(/Set$/,'') || 'Deployment' }}</span>
              </button>
            </div>
          </div>
          <div v-else-if="svc.selector && Object.keys(svc.selector).length" class="px-sm pb-sm pt-xs border-t border-outline-variant/30">
            <p class="text-[10px] text-on-surface-variant/50">{{ $t('ns.svcDetail.noMatchedWorkloads') }}</p>
          </div>
        </div>

        <!-- Traffic Policy（只读）-->
        <div v-if="!isExternalName" class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center gap-xs">
            <span class="material-symbols-outlined text-primary text-base">alt_route</span>
            <span class="text-body-sm font-semibold">Traffic Policy</span>
          </div>
          <div class="px-sm py-xs">
            <div class="flex justify-between items-center py-1 border-b border-outline-variant/30">
              <span class="text-xs text-on-surface-variant">External</span>
              <span class="text-xs font-semibold text-on-surface">{{ svc.externalTrafficPolicy || $t('ns.svcDetail.defaultCluster') }}</span>
            </div>
            <div class="flex justify-between items-center py-1 border-b border-outline-variant/30">
              <span class="text-xs text-on-surface-variant">Internal</span>
              <span class="text-xs font-semibold text-on-surface">{{ svc.internalTrafficPolicy || 'Cluster' }}</span>
            </div>
            <div v-if="svc.healthCheckNodePort" class="flex justify-between items-center py-1 border-b border-outline-variant/30">
              <span class="text-xs text-on-surface-variant">Health Node Port</span>
              <span class="font-mono text-xs text-on-surface">{{ svc.healthCheckNodePort }}</span>
            </div>
            <div v-if="svc.publishNotReadyAddresses" class="flex justify-between items-center py-1">
              <span class="text-xs text-on-surface-variant">Publish Not Ready</span>
              <span class="text-xs text-tertiary-container font-semibold">true</span>
            </div>
          </div>
        </div>

        <!-- Metadata -->
        <div class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center gap-xs">
            <span class="material-symbols-outlined text-primary text-base">sell</span>
            <span class="text-body-sm font-semibold">Metadata</span>
          </div>
          <div class="px-sm py-xs flex flex-col gap-xs">
            <div>
              <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">Labels</p>
              <div v-if="Object.keys(svc.labels || {}).length" class="flex flex-wrap gap-1">
                <span v-for="(val, key) in svc.labels" :key="key" class="px-1.5 py-0.5 bg-surface-container rounded text-[11px] border border-outline-variant font-mono">{{ key }}: {{ val }}</span>
              </div>
              <p v-else class="text-xs text-on-surface-variant italic">—</p>
            </div>
            <div>
              <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">Annotations</p>
              <div v-if="Object.keys(svc.annotations || {}).length" class="bg-surface-container p-xs rounded border border-outline-variant font-mono text-[11px] text-on-surface-variant max-h-32 overflow-y-auto">
                <div v-for="(val, key) in svc.annotations" :key="key" class="truncate" :title="`${key}: ${val}`">{{ key }}</div>
              </div>
              <p v-else class="text-xs text-on-surface-variant italic">—</p>
            </div>
          </div>
        </div>

        <!-- Recent Events -->
        <div class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-xs">
              <span class="material-symbols-outlined text-primary text-base">event_note</span>
              <span class="text-body-sm font-semibold">Events</span>
            </div>
            <span class="text-xs text-on-surface-variant">{{ svcEvents.length }}</span>
          </div>
          <div class="p-sm max-h-72 overflow-y-auto flex flex-col gap-0">
            <div v-for="(event, idx) in svcEvents" :key="idx"
              class="flex gap-xs py-1 border-b border-outline-variant/20 last:border-0"
              :class="event.relatedKind ? 'cursor-pointer hover:bg-surface-container-low/50 rounded -mx-xs px-xs transition-colors' : ''"
              @click="goToRelated(event)">
              <span class="material-symbols-outlined text-sm shrink-0 mt-0.5"
                :class="event.color === 'primary' ? 'text-primary' : event.color === 'error' ? 'text-error' : event.color === 'tertiary' ? 'text-tertiary-container' : 'text-on-surface-variant'">{{ event.icon }}</span>
              <div class="flex-1 min-w-0">
                <div class="flex justify-between gap-xs">
                  <span class="text-xs font-semibold text-on-surface truncate">{{ event.reason }}</span>
                  <span class="font-mono text-[10px] text-on-surface-variant shrink-0">{{ event.time }}</span>
                </div>
                <p class="text-[11px] text-on-surface-variant truncate">{{ event.message }}</p>
              </div>
            </div>
            <p v-if="!svcEvents.length" class="text-xs text-on-surface-variant italic text-center py-sm">{{ $t('ns.svcDetail.noEvents') }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Not Found -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">Service Not Found</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">Service "{{ route.params.name }}" not found in namespace "{{ route.params.namespace }}"</p>
    <button @click="router.push({ name: 'NsServices', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Services</button>
  </div>

  <!-- 统一 Edit 弹窗 -->
  <Modal v-model="showEditModal" :title="$t('ns.svcDetail.editService')" width="max-w-2xl">
    <div class="flex flex-col gap-md max-h-[60vh] overflow-y-auto pr-sm -mt-xs">
      <!-- Service Type:ClusterIP/NodePort/LoadBalancer 三者可互转;ExternalName 与其他类型
           K8s 禁止互转(保存必 422)——按当前实际类型锁定不可达选项,提示走重建。 -->
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Service Type</label>
        <div class="flex flex-wrap gap-xs">
          <button v-for="st in ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName']" :key="st" type="button"
            :disabled="(st === 'ExternalName') !== (svc?.type === 'ExternalName')"
            @click="editForm.type = st"
            class="px-md py-sm rounded-lg border font-medium text-body-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            :class="editForm.type === st ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'">
            {{ st }}
          </button>
        </div>
        <p class="text-xs text-on-surface-variant/60 mt-xs flex items-center gap-xs"><span class="material-symbols-outlined text-sm">info</span>{{ t('ns.svcDetail.typeSwitchHint') }}</p>
      </div>

      <!-- ExternalName 目标 -->
      <div v-if="editForm.type === 'ExternalName'">
        <label class="text-label-caps text-on-surface-variant block mb-xs">External Name</label>
        <input v-model="editForm.externalName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" :placeholder="$t('ns.svcDetail.externalNamePlaceholder')" />
        <p class="text-xs text-on-surface-variant/60 mt-xs">{{ $t('ns.svcDetail.externalNameHint') }}</p>
      </div>

      <!-- Ports（结构化）-->
      <div v-else>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-label-caps text-on-surface-variant">Ports</label>
          <button @click="addPortRow" type="button" class="flex items-center gap-xs text-body-sm text-primary font-semibold hover:underline">
            <span class="material-symbols-outlined text-sm">add</span> Add Port
          </button>
        </div>
        <div class="flex flex-col gap-xs">
          <div v-for="(p, idx) in editForm.ports" :key="idx" class="flex gap-xs items-center flex-wrap">
            <input v-model="p.port" type="number" class="w-20 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="port" />
            <span class="text-on-surface-variant text-body-sm">→</span>
            <PortSelect v-model="p.targetPort" :groups="nsContainerPortGroups" :priority-group="boundWorkload" :priority-groups="boundWorkloadNames" :placeholder="$t('ns.svcDetail.target')" :empty-hint="$t('ns.svcDetail.emptyWorkloadHint')" input-class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" />
            <select v-model="p.protocol" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary">
              <option>TCP</option><option>UDP</option><option>SCTP</option>
            </select>
            <input v-if="editForm.type === 'NodePort' || editForm.type === 'LoadBalancer'" v-model="p.nodePort" type="number" class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="nodePort" />
            <button @click="removePortRow(idx)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded-lg">
              <span class="material-symbols-outlined text-lg">remove</span>
            </button>
          </div>
          <p v-if="!editForm.ports.length" class="text-body-sm text-on-surface-variant italic">{{ $t('ns.svcDetail.noPorts') }}</p>
        </div>
      </div>

      <!-- Selector -->
      <div>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-label-caps text-on-surface-variant">Selector</label>
          <button @click="addSelectorRow" type="button" class="flex items-center gap-xs text-body-sm text-primary font-semibold hover:underline">
            <span class="material-symbols-outlined text-sm">add</span> Add
          </button>
        </div>
        <div class="flex flex-col gap-xs">
          <div v-for="(row, idx) in editForm.selector" :key="idx" class="flex gap-xs items-center">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="app" />
            <span class="text-on-surface-variant text-body-sm">=</span>
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="my-app" />
            <button @click="removeSelectorRow(idx)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded-lg">
              <span class="material-symbols-outlined text-lg">remove</span>
            </button>
          </div>
          <p v-if="!editForm.selector.length" class="text-body-sm text-on-surface-variant italic">{{ $t('ns.svcDetail.noSelectorHint') }}</p>
        </div>
      </div>

      <!-- Session Affinity -->
      <div class="grid grid-cols-2 gap-md items-end">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Session Affinity</label>
          <select v-model="editForm.sessionAffinity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm focus:ring-2 focus:ring-primary">
            <option value="None">{{ $t('ns.svcDetail.sessionNoneOption') }}</option>
            <option value="ClientIP">{{ $t('ns.svcDetail.sessionClientIpOption') }}</option>
          </select>
        </div>
        <div v-if="editForm.sessionAffinity === 'ClientIP'">
          <label class="text-label-caps text-on-surface-variant block mb-xs">Timeout (s)</label>
          <input v-model.number="editForm.sessionAffinityTimeout" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>

      <!-- Traffic Policy -->
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">External Traffic</label>
          <select v-model="editForm.externalTrafficPolicy" :disabled="editForm.type !== 'NodePort' && editForm.type !== 'LoadBalancer'" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm focus:ring-2 focus:ring-primary disabled:opacity-50">
            <option value="">{{ $t('ns.svcDetail.defaultTrafficOption') }}</option>
            <option value="Cluster">Cluster</option>
            <option value="Local">Local</option>
          </select>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Internal Traffic</label>
          <select v-model="editForm.internalTrafficPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm focus:ring-2 focus:ring-primary">
            <option value="Cluster">Cluster</option>
            <option value="Local">Local</option>
          </select>
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Save</button>
    </template>
  </Modal>

  <!-- YAML 弹窗 -->
  <Modal v-model="showYamlModal" title="Service YAML" width="max-w-4xl">
    <p v-if="yamlLoading" class="text-body-sm text-on-surface-variant">{{ $t('ns.svcDetail.loadYaml') }}</p>
    <YamlEditor v-else :model-value="svcYaml" :readonly="false" height="60vh" @save="onYamlSave" />
    <template #actions>
      <button @click="showYamlModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Close</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete Service" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete service <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This will disrupt traffic to the backend pods. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- 删除端口确认 -->
  <Modal v-model="showDeletePortModal" :title="$t('ns.svcDetail.deletePortTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant" v-if="deletePortTarget">{{ $t('ns.svcDetail.deletePortQuestion') }} <span class="font-mono font-semibold text-on-surface">{{ deletePortTarget.port }}</span><span class="text-on-surface-variant"> → target {{ deletePortTarget.targetPort }} / {{ deletePortTarget.protocol }}</span>？</p>
    <p class="text-body-sm text-error mt-sm">{{ $t('ns.svcDetail.deletePortWarning') }}</p>
    <template #actions>
      <button @click="showDeletePortModal = false; deletePortIdx = -1" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="confirmDeletePort" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('ns.svcDetail.confirmDeletePort') }}</button>
    </template>
  </Modal>

  <!-- 添加后端工作负载（取共有 label 作新 selector）-->
  <Modal v-model="showAddBackendModal" :title="$t('ns.svcDetail.addBackendWorkloadTitle')" width="max-w-xl">
    <p class="text-body-sm text-on-surface-variant mb-md">
      {{ $t('ns.svcDetail.addBackendWorkloadHint') }}
    </p>
    <div class="mb-md">
      <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.svcDetail.selectWorkloadLabel') }}</label>
      <select v-model="pickedBackend" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
        <option value="">{{ $t('ns.svcDetail.selectWorkloadEmpty') }}</option>
        <option v-for="w in unmatchedWorkloads" :key="w.name" :value="w.name">{{ w.name }}{{ $t('ns.svcDetail.workloadTypeSuffix', { type: w.type }) }}</option>
      </select>
      <p v-if="!unmatchedWorkloads.length" class="text-xs text-on-surface-variant/60 mt-xs">{{ $t('ns.svcDetail.currentNsNoWorkloads') }}</p>
    </div>

    <div v-if="pickedBackend" class="space-y-sm">
      <!-- 当前 selector -->
      <div class="p-sm rounded-md bg-surface-container-low">
        <p class="text-[10px] text-on-surface-variant/60 uppercase tracking-wide mb-xs">{{ $t('ns.svcDetail.currentSelectorLabel') }}</p>
        <div class="flex flex-wrap gap-xs">
          <span v-for="(v, k) in (svc.selector || {})" :key="k" class="px-1.5 py-0.5 rounded bg-surface-container text-xs font-mono border border-outline-variant"><span class="text-secondary font-semibold">{{ k }}</span>={{ v }}</span>
          <span v-if="!Object.keys(svc.selector || {}).length" class="text-xs text-on-surface-variant italic">{{ $t('ns.svcDetail.emptySelectorHint') }}</span>
        </div>
      </div>
      <!-- 新 selector（共有 label 交集）-->
      <div class="p-sm rounded-md" :class="canAddBackend ? 'bg-primary-container/10 border border-primary/20' : 'bg-error-container/10 border border-error/20'">
        <p class="text-[10px] uppercase tracking-wide mb-xs" :class="canAddBackend ? 'text-primary/70' : 'text-error/70'">{{ $t('ns.svcDetail.newSelectorCommon') }}</p>
        <div v-if="canAddBackend" class="flex flex-wrap gap-xs">
          <span v-for="(v, k) in mergedSelector" :key="k" class="px-1.5 py-0.5 rounded bg-primary-container/20 text-primary text-xs font-mono border border-primary/30"><span class="font-semibold">{{ k }}</span>={{ v }}</span>
        </div>
        <p v-else class="text-xs text-error flex items-center gap-1"><span class="material-symbols-outlined text-sm">block</span>{{ $t('ns.svcDetail.warningNoSharedLabel') }}</p>
      </div>
      <!-- 副作用预警 -->
      <div v-if="wouldAlsoMatch.length" class="p-sm rounded-md bg-tertiary-container/10 border border-tertiary-container/30 flex items-start gap-xs">
        <span class="material-symbols-outlined text-tertiary-container text-base shrink-0">warning</span>
        <p class="text-xs text-on-surface-variant">{{ $t('ns.svcDetail.warningAlsoMatch', { workloads: wouldAlsoMatch.join('、') }) }}</p>
      </div>
      <p v-else-if="canAddBackend" class="text-xs text-status-running flex items-center gap-1"><span class="material-symbols-outlined text-sm">check_circle</span>{{ $t('ns.svcDetail.newSelectorExact') }}</p>
    </div>

    <template #actions>
      <button @click="showAddBackendModal = false; pickedBackend = ''" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="confirmAddBackend" :disabled="!canAddBackend" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">{{ $t('ns.svcDetail.updateSelectorButton') }}</button>
    </template>
  </Modal>

  <!-- 快速添加端口（同类型追加）-->
  <Modal v-model="showAddPortModal" :title="$t('ns.svcDetail.addPortModalTitle')" width="max-w-lg">
    <p class="text-body-sm text-on-surface-variant mb-md">
      {{ $t('ns.svcDetail.addPortModalDesc', { type: svc.type }) }}
    </p>
    <div class="grid grid-cols-2 gap-sm">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.svcDetail.portLabel') }}</label>
        <input v-model="addPortForm.port" type="number" min="1" max="65535" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="$t('ns.svcDetail.portPlaceholder')" />
        <p class="text-[10px] text-on-surface-variant/60 mt-xs">{{ $t('ns.svcDetail.portClientAccess') }}</p>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.svcDetail.targetPortLabel') }}</label>
        <PortSelect v-model="addPortForm.targetPort" :groups="nsContainerPortGroups" :priority-group="boundWorkload" :priority-groups="boundWorkloadNames" :placeholder="$t('ns.svcDetail.leaveEmptyForPort')" :empty-hint="$t('ns.svcDetail.emptyWorkloadHint')" input-class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" @pick="onPickTarget" />
        <p class="text-[10px] text-on-surface-variant/60 mt-xs">{{ $t('ns.svcDetail.portForwardToBackend') }}</p>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.svcDetail.protocolLabel') }}</label>
        <select v-model="addPortForm.protocol" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
          <option>TCP</option><option>UDP</option><option>SCTP</option>
        </select>
      </div>
      <div v-if="addPortNeedsNodePort">
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.svcDetail.nodePortLabel') }}</label>
        <input v-model="addPortForm.nodePort" type="number" min="30000" max="32767" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="$t('ns.svcDetail.nodePortPlaceholder')" />
        <p class="text-[10px] text-on-surface-variant/60 mt-xs">{{ $t('ns.svcDetail.nodePortTypeDesc', { type: svc.type }) }}</p>
      </div>
    </div>
    <!-- 选了未绑定工作负载的端口：自动并入后端（取共有 label 作新 selector）-->
    <div v-if="sourceNonBound" class="mt-md p-sm rounded-md" :class="canAutoMerge ? 'bg-primary-container/10 border border-primary/20' : 'bg-error-container/10 border border-error/20'">
      <label class="flex items-start gap-xs cursor-pointer" :class="{ 'cursor-not-allowed opacity-70': !canAutoMerge }">
        <input type="checkbox" v-model="autoMergeEnabled" :disabled="!canAutoMerge" class="mt-0.5 accent-primary" />
        <span class="text-body-sm">
          {{ $t('ns.svcDetail.sourceWorkloadNotBound', { workload: sourceWorkload }) }}
          <span v-if="canAutoMerge">{{ $t('ns.svcDetail.saveWillAddToBackend') }}</span>
          <span v-else>{{ $t('ns.svcDetail.cannotAutoMerge') }}</span>
        </span>
      </label>
      <div v-if="canAutoMerge" class="mt-xs">
        <p class="text-[10px] text-on-surface-variant/60 mb-0.5">{{ $t('ns.svcDetail.selectorWillMerge') }}</p>
        <div class="flex flex-wrap gap-xs">
          <span v-for="(v, k) in portMergeSelector" :key="k" class="px-1.5 py-0.5 rounded bg-primary-container/20 text-primary text-xs font-mono border border-primary/30"><span class="font-semibold">{{ k }}</span>={{ v }}</span>
        </div>
        <p v-if="portMergeAlsoMatch.length" class="text-[11px] text-tertiary-container mt-xs flex items-center gap-1"><span class="material-symbols-outlined text-sm">warning</span>{{ $t('ns.svcDetail.willAlsoMatch', { workloads: portMergeAlsoMatch.join('、') }) }}</p>
      </div>
      <p v-else class="text-[11px] text-error mt-xs flex items-center gap-1"><span class="material-symbols-outlined text-sm">block</span>{{ $t('ns.svcDetail.noSharedLabelMerge', { workload: sourceWorkload }) }}</p>
    </div>
    <template #actions>
      <button @click="showAddPortModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="saveAddPort" :disabled="!canAddPort || addingPort" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
        <span v-if="addingPort" class="material-symbols-outlined text-base align-middle animate-spin mr-xs">progress_activity</span>{{ $t('ns.svcDetail.addButton') }}
      </button>
    </template>
  </Modal>

  <!-- Port Forward Panel -->
  <PortForwardPanel v-model="showPortForward" kind="Service" :name="route.params.name" :namespace="route.params.namespace" :suggested-ports="forwardPorts" />
</template>
